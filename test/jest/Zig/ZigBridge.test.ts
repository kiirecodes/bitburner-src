/**
 * Unit tests for the Zig↔Netscript bridge marshalling.
 *
 * Every `bb_*` import is exercised against a real `WebAssembly.Memory` and a mock
 * `ns` object, so string read/write, out-buffer two-phase, length-prefixed
 * arrays, JSON args and the exit/async wrapping are all verified on the JS side
 * of the ABI.
 *
 * Note on JSPI: `new WebAssembly.Suspending(fn)` yields an object that is only
 * invokable *from wasm* (per the JSPI spec), so the async import wrappers cannot
 * be called from plain JS. The raw implementations (`buildZigImpls`) are plain
 * functions and therefore the unit-test surface; the wasm-facing wrappers are
 * validated structurally here and end-to-end through a real compiled module in
 * ZigIntegration.test.ts.
 */
import type { WorkerScript } from "../../../src/Netscript/WorkerScript";
import { buildZigImpls, buildZigImports, hasJSPI, ProcExit } from "../../../src/Zig/ZigBridge";

function makeMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: 1 }); // 64 KiB
}

function writeStr(memory: WebAssembly.Memory, ptr: number, s: string): void {
  const bytes = new TextEncoder().encode(s);
  new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
}

function readStr(memory: WebAssembly.Memory, ptr: number, len: number): string {
  return new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len));
}

/** Builds raw impls for a fake WorkerScript exposing `ns`. */
function makeImpls(memory: WebAssembly.Memory, ns: Record<string, unknown>) {
  const ws = { vars: ns } as unknown as WorkerScript;
  return buildZigImpls(ws, () => memory);
}

// Non-zero base offset so the "ptr === 0 means undefined" convention is never
// accidentally exercised in the regular-string tests.
const STR = 16;

describe("ZigBridge marshalling", () => {
  it("str-f64 async: hack(host) returns the promise's value", async () => {
    const memory = makeMemory();
    const hack = jest.fn().mockResolvedValue(42);
    const impls = makeImpls(memory, { hack });
    writeStr(memory, STR, "n00dles");
    const r = await Promise.resolve(impls.bb_hack(STR, 7));
    expect(hack).toHaveBeenCalledWith("n00dles");
    expect(r).toBe(42);
  });

  it("f64-void async: sleep(ms)", async () => {
    const memory = makeMemory();
    const sleep = jest.fn().mockResolvedValue(undefined);
    const impls = makeImpls(memory, { sleep });
    await Promise.resolve(impls.bb_sleep(15.5));
    expect(sleep).toHaveBeenCalledWith(15.5);
  });

  it("decodes an omitted optional string as undefined (0,0)", async () => {
    const memory = makeMemory();
    const weaken = jest.fn().mockResolvedValue(9);
    const impls = makeImpls(memory, { weaken });
    const r = await Promise.resolve(impls.bb_weaken(0, 0));
    expect(weaken).toHaveBeenCalledWith(undefined);
    expect(r).toBe(9);
  });

  it("str-bool: hasRootAccess returns 0/1", () => {
    const memory = makeMemory();
    const hasRootAccess = jest.fn().mockReturnValue(true);
    const impls = makeImpls(memory, { hasRootAccess });
    writeStr(memory, STR, "foodnstuff");
    expect(impls.bb_hasRootAccess(STR, 10)).toBe(1);
    expect(impls.bb_hasRootAccess(0, 0)).toBe(1);
    expect(hasRootAccess).toHaveBeenLastCalledWith(undefined);
    hasRootAccess.mockReturnValue(false);
    expect(impls.bb_hasRootAccess(STR, 10)).toBe(0);
  });

  it("void-str: getHostname uses the two-phase out-buffer protocol", () => {
    const memory = makeMemory();
    const impls = makeImpls(memory, { getHostname: () => "home" });
    // Phase 1: undersized buffer asks for the required size.
    const needed = impls.bb_getHostname(0, 0);
    expect(needed).toBe(4);
    // Phase 2: real buffer gets the bytes.
    const written = impls.bb_getHostname(STR, 64);
    expect(written).toBe(4);
    expect(readStr(memory, STR, 4)).toBe("home");
  });

  it("str-str: getScriptRam passes (script, host|undefined)", () => {
    const memory = makeMemory();
    const getScriptRam = jest.fn().mockReturnValue(1.9);
    const impls = makeImpls(memory, { getScriptRam });
    writeStr(memory, STR, "helper.js");
    writeStr(memory, STR + 64, "n00dles");
    expect(impls.bb_getScriptRam(STR, 9, STR + 64, 7)).toBe(1.9);
    expect(getScriptRam).toHaveBeenCalledWith("helper.js", "n00dles");
    expect(impls.bb_getScriptRam(STR, 9, 0, 0)).toBe(1.9);
    expect(getScriptRam).toHaveBeenLastCalledWith("helper.js", undefined);
  });

  it("strstr-bool: fileExists(filename, host|undefined)", () => {
    const memory = makeMemory();
    const fileExists = jest.fn().mockReturnValue(true);
    const impls = makeImpls(memory, { fileExists });
    writeStr(memory, STR, "a.txt");
    writeStr(memory, STR + 64, "home");
    expect(impls.bb_fileExists(STR, 5, STR + 64, 4)).toBe(1);
    expect(fileExists).toHaveBeenCalledWith("a.txt", "home");
    expect(impls.bb_fileExists(STR, 5, 0, 0)).toBe(1);
    expect(fileExists).toHaveBeenLastCalledWith("a.txt", undefined);
  });

  it("f64str-f64: hackAnalyzeSecurity(threads, host?)", () => {
    const memory = makeMemory();
    const hackAnalyzeSecurity = jest.fn().mockReturnValue(0.023);
    const impls = makeImpls(memory, { hackAnalyzeSecurity });
    writeStr(memory, STR, "n00dles");
    expect(impls.bb_hackAnalyzeSecurity(1.5, STR, 7)).toBe(0.023);
    expect(hackAnalyzeSecurity).toHaveBeenCalledWith(1.5, "n00dles");
  });

  it("strf64-f64: hackAnalyzeThreads(host, hackAmount)", () => {
    const memory = makeMemory();
    const hackAnalyzeThreads = jest.fn().mockReturnValue(3);
    const impls = makeImpls(memory, { hackAnalyzeThreads });
    writeStr(memory, STR, "n00dles");
    expect(impls.bb_hackAnalyzeThreads(STR, 7, 0.5)).toBe(3);
    expect(hackAnalyzeThreads).toHaveBeenCalledWith("n00dles", 0.5);
  });

  it("str-array: scan writes a length-prefixed array, two-phase", () => {
    const memory = makeMemory();
    const impls = makeImpls(memory, { scan: () => ["home", "n00dles"] });
    const required = impls.bb_scan(0, 0, 0, 4);
    expect(required).toBe(4 + (4 + 4) + (4 + 7)); // count + len+bytes + len+bytes
    const written = impls.bb_scan(0, 0, STR, required);
    expect(written).toBe(required);
    const view = new DataView(memory.buffer);
    expect(view.getUint32(STR, true)).toBe(2);
    // Wire format: [u32 count][u32 len1][home bytes][u32 len2][n00dles bytes].
    expect(view.getUint32(STR + 4, true)).toBe(4); // len1
    expect(view.getUint32(STR + 12, true)).toBe(7); // len2
    expect(readStr(memory, STR + 8, 4)).toBe("home");
    expect(readStr(memory, STR + 16, 7)).toBe("n00dles");
  });

  it("run-args-json: run(script, threads, ...spreadArgs) with JSON args", () => {
    const memory = makeMemory();
    const run = jest.fn().mockReturnValue(7);
    const impls = makeImpls(memory, { run });
    const json = '["--flag","n00dles"]';
    writeStr(memory, STR, "helper.js");
    writeStr(memory, STR + 64, json);
    const r = impls.bb_run(STR, 9, 3.0, STR + 64, json.length);
    expect(run).toHaveBeenCalledWith("helper.js", 3, "--flag", "n00dles");
    expect(r).toBe(7);
  });

  it("exec-args-json: exec(script, host, threads, ...spreadArgs)", () => {
    const memory = makeMemory();
    const exec = jest.fn().mockReturnValue(11);
    const impls = makeImpls(memory, { exec });
    writeStr(memory, STR, "helper.js");
    writeStr(memory, STR + 64, "n00dles");
    writeStr(memory, STR + 128, "[42]");
    const r = impls.bb_exec(STR, 9, STR + 64, 7, 2.0, STR + 128, 4);
    expect(exec).toHaveBeenCalledWith("helper.js", "n00dles", 2, 42);
    expect(r).toBe(11);
  });

  it("json-args-bool: kill(...args) with numbers and strings", () => {
    const memory = makeMemory();
    const kill = jest.fn().mockReturnValue(true);
    const impls = makeImpls(memory, { kill });
    writeStr(memory, STR, "[42]");
    expect(impls.bb_kill(STR, 4)).toBe(1);
    expect(kill).toHaveBeenCalledWith(42);
    writeStr(memory, STR, '["helper.js","home"]');
    expect(impls.bb_kill(STR, 20)).toBe(1);
    expect(kill).toHaveBeenLastCalledWith("helper.js", "home");
  });

  it("str-void: print(msg)", () => {
    const memory = makeMemory();
    const print = jest.fn();
    const impls = makeImpls(memory, { print });
    writeStr(memory, STR, "hello");
    impls.bb_print(STR, 5);
    expect(print).toHaveBeenCalledWith("hello");
  });

  it("exit: ns.exit() surfaces as a ProcExit", () => {
    const memory = makeMemory();
    const impls = makeImpls(memory, {});
    expect(() => impls.bb_exit()).toThrow(ProcExit);
  });
});

describe("ZigBridge import wrapping", () => {
  it("wraps async and exit imports in Suspending (JSPI present)", () => {
    expect(hasJSPI()).toBe(true);
    const memory = makeMemory();
    const ws = { vars: { hack: jest.fn() } } as unknown as WorkerScript;
    const { env } = buildZigImports(ws, () => memory);
    expect(typeof env.bb_hack).toBe("object"); // Suspending wrapper is not JS-callable
    expect(typeof env.bb_sleep).toBe("object");
    expect(typeof env.bb_exit).toBe("object");
    // Sync imports stay plain functions.
    expect(typeof env.bb_print).toBe("function");
    expect(typeof env.bb_scan).toBe("function");
  });

  it("keeps async imports as failing closures without JSPI", () => {
    const desc = Object.getOwnPropertyDescriptor(WebAssembly, "Suspending");
    if (!desc) {
      // No JSPI in this runtime at all: `hasJSPI()` is already false, so the
      // fallback is active by default and this test is redundant.
      return;
    }
    Object.defineProperty(WebAssembly, "Suspending", { value: undefined, configurable: true });
    try {
      const memory = makeMemory();
      const ws = { vars: { hack: jest.fn() } } as unknown as WorkerScript;
      const { env } = buildZigImports(ws, () => memory);
      expect(typeof env.bb_hack).toBe("function");
      let thrown: unknown;
      try {
        env.bb_hack(STR, 7);
      } catch (e) {
        thrown = e;
      }
      expect(String(thrown)).toMatch(/stack switching/);
      // Exit stays a plain impl without JSPI (it does not need suspension).
      expect(() => env.bb_exit()).toThrow(ProcExit);
    } finally {
      Object.defineProperty(WebAssembly, "Suspending", desc);
    }
  });
});
