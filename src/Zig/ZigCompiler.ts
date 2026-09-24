/**
 * ZigCompiler — turns player `.zig` source into a freestanding wasm module.
 *
 * Compile target (validated with Zig 0.17 locally):
 *   zig build-exe main.zig -target wasm32-freestanding -fno-entry --export=main \
 *       -O ReleaseSmall -fstrip
 *
 * This deliberately uses `wasm32-freestanding` (NOT `wasm32-wasi`): the Zig std
 * pulls in ~50 WASI imports when built with the wasi target, while a freestanding
 * module imports ONLY the `bb_*` functions our bridge implements.
 *
 * Two implementations:
 *  - `BrowserZigCompiler` (default): lazy-loads a WebAssembly build of the Zig
 *    compiler from `ZIG_COMPILER_URL` and executes it inside an in-memory WASI
 *    runtime (`WasiPreview1`). Set `ZIG_COMPILER_URL` to a self-contained
 *    wasm32-wasi Zig compiler binary (e.g. the artifacts produced by zigtools'
 *    playground pipeline or `zigc-wasm`).
 *  - `NativeZigCompiler`: shells out to a `zig` binary. Used by tests and dev
 *    tooling where a system Zig exists.
 *
 * The player's script is the root module of the compilation and receives the
 * Bitburner prelude through `bitburner.zig` (imported as `ns`).
 */
import apiLayerSource from "./bitburner.zig?raw";
import { WasiPreview1, VirtualFileSystem } from "./WasiPreview1";

export interface ZigCompileOptions {
  /** Optimization level passed to the compiler. */
  mode: "ReleaseSmall" | "ReleaseFast" | "ReleaseSafe" | "Debug";
}

const DEFAULT_OPTIONS: ZigCompileOptions = { mode: "ReleaseSmall" };

/** URL of the wasm-compiled Zig compiler used by the browser build. */
export const ZIG_COMPILER_URL = "";

/**
 * A Zig compiler producing wasm bytes from source. Returns the compiled module's
 * bytes, or throws a descriptive error on failure.
 */
export interface ZigCompiler {
  compile(source: string, filename: string, options?: ZigCompileOptions): Promise<Uint8Array>;
}

let compiler: ZigCompiler | undefined;

/** Override the compiler (tests inject a mock / fixture-based one here). */
export function setZigCompiler(c: ZigCompiler | undefined): void {
  compiler = c;
}

export function getZigCompiler(): ZigCompiler {
  compiler ??= createDefaultCompiler();
  return compiler;
}

export function createDefaultCompiler(): ZigCompiler {
  if (typeof process !== "undefined" && process.versions?.node && typeof process.env.ZIG === "string") {
    return new NativeZigCompiler();
  }
  return new BrowserZigCompiler();
}

/**
 * Prepend the canonical Bitburner import to a player script if they didn't write
 * one themselves, so `ns` is available just like in JS scripts.
 * Skips injection when the source already imports bitburner.
 */
export function withZigPreamble(source: string): string {
  if (source.includes('@import("bitburner')) return source;
  return `const ns = @import("bitburner.zig").ns;\n${source}`;
}

/** Compiles a `.zig` script to wasm bytes. */
export async function compileZigScript(
  code: string,
  filename: string,
  options?: ZigCompileOptions,
): Promise<Uint8Array> {
  if (!code.trim()) {
    throw new Error(`Zig script ${filename} is empty.`);
  }
  return getZigCompiler().compile(withZigPreamble(code), filename, options ?? DEFAULT_OPTIONS);
}

// ─────────────────────────── Native (test/dev) ───────────────────────────

export class NativeZigCompiler implements ZigCompiler {
  async compile(source: string, filename: string, options: ZigCompileOptions = DEFAULT_OPTIONS): Promise<Uint8Array> {
    const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const pathNode = await import("node:path");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    const dir = mkdtempSync(pathNode.join(tmpdir(), "bitburner-zig-"));
    try {
      writeFileSync(pathNode.join(dir, "main.zig"), source);
      writeFileSync(pathNode.join(dir, "bitburner.zig"), apiLayerSource);
      const args = [
        "build-exe",
        "main.zig",
        "-target",
        "wasm32-freestanding",
        "-fno-entry",
        "--export=main",
        "-O",
        options.mode,
        "-fstrip",
      ];
      try {
        await execFileAsync("zig", args, { cwd: dir, maxBuffer: 16 * 1024 * 1024 });
      } catch (error) {
        const e = error as Error & { stderr?: string; stdout?: string };
        throw new Error(`Zig compilation of ${filename} failed: ${e.stderr ?? e.stdout ?? e.message}`);
      }
      return readFileSync(pathNode.join(dir, "main.wasm"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

// ─────────────────────────── Browser (lazy-load) ─────────────────────────

export class BrowserZigCompiler implements ZigCompiler {
  private runtimePromise: Promise<{ wasi: WasiPreview1; exports: WebAssembly.Exports }> | undefined;

  private async getRuntime(): Promise<{ wasi: WasiPreview1; exports: WebAssembly.Exports }> {
    this.runtimePromise ??= this.load();
    return this.runtimePromise;
  }

  private async load(): Promise<{ wasi: WasiPreview1; exports: WebAssembly.Exports }> {
    if (!ZIG_COMPILER_URL) {
      throw new Error(
        "Zig support is not fully configured: set ZIG_COMPILER_URL in src/Zig/ZigCompiler.ts to a " +
          "WebAssembly build of the Zig compiler (a self-contained wasm32-wasi `zig` binary).",
      );
    }
    let response: Response;
    try {
      response = await fetch(ZIG_COMPILER_URL, { mode: "cors" });
    } catch (error) {
      throw new Error(`Zig compiler download failed (${ZIG_COMPILER_URL}): ${error}`);
    }
    if (!response.ok) {
      throw new Error(`Zig compiler download failed: HTTP ${response.status} from ${ZIG_COMPILER_URL}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const fs = new VirtualFileSystem();
    const wasi = new WasiPreview1(fs, {
      args: [
        "zig",
        "build-exe",
        "main.zig",
        "-target",
        "wasm32-freestanding",
        "-fno-entry",
        "--export=main",
        "-O",
        "ReleaseSmall",
        "-fstrip",
      ],
    });
    const imports = { wasi_snapshot_preview1: wasi.imports(), env: {} } as unknown as WebAssembly.Imports;
    const { instance } = await WebAssembly.instantiate(bytes as BufferSource, imports);
    wasi.attach(instance);
    return { wasi, exports: instance.exports };
  }

  async compile(source: string, _filename: string, options: ZigCompileOptions = DEFAULT_OPTIONS): Promise<Uint8Array> {
    if (options.mode !== "ReleaseSmall") {
      // The browser pipeline hard-codes its argv; allow only the default.
      throw new Error(`BrowserZigCompiler only supports mode "ReleaseSmall" (got ${options.mode}).`);
    }
    const { wasi, exports } = await this.getRuntime();
    const fs = wasi.getFileSystem();
    // Fresh in-memory FS per compilation so outputs don't leak between scripts.
    wasi.resetFS();
    fs.writeFile("main.zig", source);
    fs.writeFile("bitburner.zig", apiLayerSource);
    const start = exports._start as (() => unknown) | undefined;
    if (typeof start !== "function") {
      throw new Error("The configured Zig compiler has no exported `_start`. Is it a wasm32-wasi executable?");
    }
    start();
    if (wasi.exitCode !== 0) {
      const stderr = wasi.captureStdErr();
      throw new Error(`Zig compilation failed (exit ${wasi.exitCode})${stderr ? `:\n${stderr}` : "."}`);
    }
    const wasmBytes = fs.readFileBytes("main.wasm");
    if (!wasmBytes) {
      throw new Error("Zig compiler finished without producing main.wasm.");
    }
    return wasmBytes;
  }
}
