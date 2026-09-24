/**
 * Tests for Zig compilation: preamble injection, default compiler selection and
 * (when a system `zig` exists) the native compiler producing freestanding wasm.
 */
import { execFileSync } from "node:child_process";
import {
  BrowserZigCompiler,
  compileZigScript,
  createDefaultCompiler,
  NativeZigCompiler,
  setZigCompiler,
  withZigPreamble,
  type ZigCompiler,
} from "../../../src/Zig/ZigCompiler";

const HAS_ZIG = (() => {
  try {
    execFileSync("zig", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const describeWithZig = HAS_ZIG ? describe : describe.skip;

describe("withZigPreamble", () => {
  it("prepends the canonical ns import when the source has none", () => {
    const out = withZigPreamble("pub export fn main() void {}");
    expect(out).toBe('const ns = @import("bitburner.zig").ns;\npub export fn main() void {}');
  });

  it("does not duplicate an existing import", () => {
    const src = 'const ns = @import("bitburner.zig").ns;\npub export fn main() void {}';
    expect(withZigPreamble(src)).toBe(src);
  });
});

describe("compileZigScript", () => {
  afterEach(() => setZigCompiler(undefined));

  it("rejects empty scripts", async () => {
    await expect(compileZigScript("   \n\t ", "empty.zig")).rejects.toThrow(/empty/);
  });

  it("delegates to the injected compiler with the preamble applied", async () => {
    const compile = jest.fn().mockResolvedValue(new Uint8Array([0x00, 0x61, 0x73, 0x6d]));
    const fake: ZigCompiler = { compile };
    setZigCompiler(fake);
    const bytes = await compileZigScript("pub export fn main() void {}", "a.zig");
    expect(bytes[0]).toBe(0x00);
    expect(compile).toHaveBeenCalledWith(
      expect.stringContaining('const ns = @import("bitburner.zig").ns;'),
      "a.zig",
      expect.objectContaining({ mode: "ReleaseSmall" }),
    );
  });
});

describe("createDefaultCompiler", () => {
  const originalEnv = process.env.ZIG;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ZIG;
    } else {
      process.env.ZIG = originalEnv;
    }
    setZigCompiler(undefined);
  });

  it("selects the browser compiler when no system zig is configured", () => {
    delete process.env.ZIG;
    expect(createDefaultCompiler()).toBeInstanceOf(BrowserZigCompiler);
  });

  it("selects the native compiler when ZIG env is set", () => {
    process.env.ZIG = "/usr/local/bin/zig";
    expect(createDefaultCompiler()).toBeInstanceOf(NativeZigCompiler);
  });
});

describe("BrowserZigCompiler", () => {
  it("throws a configuration error while ZIG_COMPILER_URL is unset", async () => {
    const compiler = new BrowserZigCompiler();
    await expect(compiler.compile("pub export fn main() void {}", "x.zig")).rejects.toThrow(/not fully configured/);
  });

  it("rejects non-default optimization modes", async () => {
    const compiler = new BrowserZigCompiler();
    await expect(compiler.compile("pub export fn main() void {}", "x.zig", { mode: "Debug" })).rejects.toThrow(
      /only supports mode "ReleaseSmall"/,
    );
  });
});

describeWithZig("NativeZigCompiler (system zig)", () => {
  it("compiles a freestanding module exporting main and memory", async () => {
    const compiler = new NativeZigCompiler();
    const bytes = await compiler.compile("pub export fn main() void {}", "tiny.zig");
    // wasm magic: \0asm
    expect(bytes[0]).toBe(0x00);
    expect(bytes[1]).toBe(0x61);
    expect(bytes[2]).toBe(0x73);
    expect(bytes[3]).toBe(0x6d);
    const module = await WebAssembly.compile(bytes as BufferSource);
    const exports = WebAssembly.Module.exports(module).map((e) => e.name);
    expect(exports).toEqual(expect.arrayContaining(["main", "memory"]));
    // Freestanding build: the module must not import anything (no bb_* in this
    // fixture, and crucially no WASI).
    expect(WebAssembly.Module.imports(module)).toHaveLength(0);
  }, 60_000);

  it("surfaces compile errors and names the failing script", async () => {
    const compiler = new NativeZigCompiler();
    await expect(compiler.compile("pub export fn broken() {", "bad.zig")).rejects.toThrow(/bad\.zig/);
  }, 60_000);
});
