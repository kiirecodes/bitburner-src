/**
 * Tests for the in-memory filesystem and the `wasi_snapshot_preview1` shim used
 * to run a wasm build of the Zig compiler in the browser.
 *
 * Filesystem behaviour is unit-tested directly. Two integration tests compile a
 * real `wasm32-wasi` module with the system Zig (skipped when unavailable) and
 * run it through `WasiPreview1`, validating path_open/fd_read/fd_write and
 * proc_exit propagation.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wasiErrno, ProcExitCode, VirtualFileSystem, WasiPreview1 } from "../../../src/Zig/WasiPreview1";

/** Read a VFS file as text, asserting it exists (avoids non-null assertions). */
const readText = (fs: VirtualFileSystem, path: string): string => {
  const bytes = fs.readFileBytes(path);
  expect(bytes).not.toBeNull();
  return new TextDecoder().decode(bytes as Uint8Array);
};

describe("VirtualFileSystem", () => {
  it("writes, reads and overwrites files", () => {
    const fs = new VirtualFileSystem();
    fs.writeFile("b.txt", "hello");
    expect(readText(fs, "b.txt")).toBe("hello");
    fs.writeFile("b.txt", "world");
    expect(readText(fs, "b.txt")).toBe("world");
  });

  it("normalizes dot and parent segments", () => {
    const fs = new VirtualFileSystem();
    fs.mkdir("x");
    fs.writeFile("x/y/../z.txt", "deep"); // resolves to x/z.txt
    expect(readText(fs, "x/z.txt")).toBe("deep");
    expect(fs.readFileBytes("/x/./z.txt")).not.toBeNull();
  });

  it("mkdir / createFile / rename / unlink honor errno semantics", () => {
    const fs = new VirtualFileSystem();
    expect(fs.mkdir("d")).toBe(wasiErrno.ESUCCESS);
    expect(fs.mkdir("d")).toBe(wasiErrno.EEXIST);
    expect(fs.createFile("d/f.txt")).toBe(wasiErrno.ESUCCESS);
    expect(fs.rename("d/f.txt", "d/g.txt")).toBe(wasiErrno.ESUCCESS);
    expect(fs.lookup("d/g.txt")).not.toBeNull();
    expect(fs.lookup("d/f.txt")).toBeNull();
    expect(fs.unlink("d/g.txt", false)).toBe(wasiErrno.ESUCCESS);
    expect(fs.lookup("d/g.txt")).toBeNull();
    expect(fs.unlink("d", false)).toBe(wasiErrno.EISDIR);
  });

  it("refuses writes under a missing parent", () => {
    const fs = new VirtualFileSystem();
    expect(() => fs.writeFile("no/such/dir/f.txt", "x")).toThrow();
  });
});

describe("WasiPreview1 imports", () => {
  it("provides the syscalls a typical zig wasi module needs", () => {
    const wasi = new WasiPreview1(new VirtualFileSystem(), { args: ["app"] });
    const imports = wasi.imports();
    for (const name of [
      "args_sizes_get",
      "args_get",
      "clock_time_get",
      "random_get",
      "proc_exit",
      "fd_prestat_get",
      "fd_prestat_dir_name",
      "path_open",
      "path_filestat_get",
      "fd_read",
      "fd_write",
      "fd_close",
      "poll_oneoff",
    ]) {
      expect(typeof imports[name]).toBe("function");
    }
  });
});

const HAS_ZIG = (() => {
  try {
    execFileSync("zig", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const describeWithZig = HAS_ZIG ? describe : describe.skip;

describeWithZig("WasiPreview1 with a real wasm32-wasi module", () => {
  function compileWasm(fixtureName: string): Uint8Array {
    const dir = mkdtempSync(join(tmpdir(), "wasi-test-"));
    try {
      writeFileSync(join(dir, "app.zig"), readFileSync(join(__dirname, "fixtures", fixtureName), "utf8"));
      execFileSync("zig", ["build-exe", "app.zig", "-target", "wasm32-wasi", "-O", "ReleaseSmall", "-fstrip"], {
        cwd: dir,
        stdio: "pipe",
      });
      return readFileSync(join(dir, "app.wasm"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("runs a module that creates, writes and reads files", async () => {
    const bytes = compileWasm("wasiFixture.zig");
    const fs = new VirtualFileSystem();
    const wasi = new WasiPreview1(fs, { args: ["app"] });
    fs.writeFile("input.txt", "from input");
    const imports = { wasi_snapshot_preview1: wasi.imports(), env: {} } as unknown as WebAssembly.Imports;
    const { instance } = await WebAssembly.instantiate(bytes as BufferSource, imports);
    wasi.attach(instance);

    // Zig's wasi _start ends by calling proc_exit(exit code); accept the throw.
    expect(() => {
      try {
        (instance.exports._start as () => void)();
      } catch (e) {
        if (e instanceof ProcExitCode) return;
        throw e;
      }
    }).not.toThrow();
    expect(wasi.exitCode).toBe(0);
    expect(readText(fs, "output.txt")).toBe("hello from input");
  }, 60_000);

  it("propagates proc_exit codes and sets exitCode", async () => {
    const bytes = compileWasm("wasiExit.zig");
    const fs = new VirtualFileSystem();
    const wasi = new WasiPreview1(fs, { args: ["app"] });
    const imports = { wasi_snapshot_preview1: wasi.imports(), env: {} } as unknown as WebAssembly.Imports;
    const { instance } = await WebAssembly.instantiate(bytes as BufferSource, imports);
    wasi.attach(instance);

    const start = instance.exports._start as () => void;
    expect(() => start()).toThrow(ProcExitCode);
    expect(wasi.exitCode).toBe(7);
    expect(wasi.exited).toBe(true);
  }, 60_000);
});
