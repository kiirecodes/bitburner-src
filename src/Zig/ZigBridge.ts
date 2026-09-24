/**
 * ZigBridge — translates a compiled Zig module's `bb_*` imports into calls on the
 * same Netscript proxy (`workerScript.vars`) that JS scripts use.
 *
 * Every `bb_*` import reads/writes strings through the module's exported linear
 * memory, so the implementations below must always re-resolve
 * `instance.exports.memory.buffer` at call time (it can be detached/replaced when
 * the module grows its memory, including across JSPI suspends).
 *
 * Async ns functions (hack/grow/weaken/sleep/asleep) return Promises; under
 * WebAssembly Promise Integration (JSPI) they are wrapped with
 * `new WebAssembly.Suspending(...)` so a wasm call to them suspends the module
 * until the promise settles — the Zig layer therefore sees them as plain,
 * synchronous-looking calls.
 */
import type { WorkerScript } from "../Netscript/WorkerScript";
import type { NSFull } from "../NetscriptFunctions";
import type { ZigApiSpec } from "./zigApiDefs";
import { zigApiDefByName } from "./zigApiDefs";

/** Thrown when a Zig script calls ns.exit(). Represents a clean termination. */
export class ProcExit extends Error {
  constructor() {
    super("Script exited");
  }
}

/** True if the runtime supports WebAssembly Promise Integration (stack switching). */
export function hasJSPI(): boolean {
  return typeof WebAssembly.Suspending === "function" && typeof WebAssembly.promising === "function";
}

export interface ZigWasmImports {
  env: Record<string, (...args: unknown[]) => unknown>;
}

/** A raw marshalling implementation: all params are numbers (wasm ABI values). */
export type ZigImportImpl = (...args: any[]) => unknown;

/** The set of raw `bb_*` implementations for a WorkerScript, keyed by import name. */
export type ZigImportMap = Record<string, ZigImportImpl>;

/**
 * Builds the raw `bb_*` marshalling implementations for a compiled Zig module
 * bound to a WorkerScript. These are plain functions and JS-callable, so tests
 * can exercise every ABI path directly; `buildZigImports` wraps them for wasm.
 * `getMemory` must return the instance's exported memory (called lazily, once
 * the instance exists, because the buffer can be replaced when memory grows).
 */
export function buildZigImpls(ws: WorkerScript, getMemory: () => WebAssembly.Memory | undefined): ZigImportMap {
  const ns = ws.vars;
  if (!ns) throw new Error("Zig script cannot run because the NS object hasn't been constructed properly.");

  const impls: ZigImportMap = {};
  for (const [importName, spec] of zigApiDefByName) {
    impls[importName] = makeImport(importName, spec, ns, getMemory);
  }
  return impls;
}

/**
 * Builds the `env` import object for a compiled Zig module bound to a WorkerScript.
 * The returned object is passed to `WebAssembly.instantiate`. `getMemory` must
 * return the instance's exported memory (called lazily, once the instance exists).
 *
 * Async APIs (hack/grow/weaken/sleep/asleep) and `exit` are wrapped with
 * `new WebAssembly.Suspending(...)` so wasm calls suspend/resume through JSPI
 * and a clean `ns.exit()` reaches the runtime as a rejected promise. Those
 * wrappers are only invokable *from wasm* (deliberately, per the JSPI spec), so
 * `buildZigImpls` exposes the raw implementations for JS-side testing.
 */
export function buildZigImports(ws: WorkerScript, getMemory: () => WebAssembly.Memory | undefined): ZigWasmImports {
  const impls = buildZigImpls(ws, getMemory);
  const env: Record<string, (...args: unknown[]) => unknown> = {};

  for (const [importName, spec] of zigApiDefByName) {
    const impl = impls[importName];
    const needsSuspension = spec.async || spec.kind === "exit";
    if (needsSuspension && hasJSPI()) {
      env[importName] = new WebAssembly.Suspending(impl);
    } else if (spec.async && !hasJSPI()) {
      // No stack switching support: calling an async API must fail loudly instead
      // of silently treating a Promise as a wasm value.
      env[importName] = () => {
        throw new Error(
          `Zig: ns.${spec.zigName}() is an asynchronous API and this browser does not support ` +
            `WebAssembly stack switching (WebAssembly.Suspending / WebAssembly.promising), so it cannot be used.`,
        );
      };
    } else {
      env[importName] = impl;
    }
  }

  return { env };
}

function readString(memory: WebAssembly.Memory, ptr: number, len: number): string | undefined {
  if (ptr === 0 || len === 0) return undefined;
  const bytes = new Uint8Array(memory.buffer, ptr, len);
  return new TextDecoder().decode(bytes);
}

/** Writes `str` into the module's memory at [out, out+cap). Returns bytes written.
 *  If cap is too small, nothing is written and the required size is returned. */
function writeString(memory: WebAssembly.Memory, out: number, cap: number, str: string): number {
  const bytes = new TextEncoder().encode(str);
  if (bytes.length > cap) return bytes.length;
  new Uint8Array(memory.buffer, out, bytes.length).set(bytes);
  return bytes.length;
}

/** Length-prefixed string array wire format used by `scan`:
 *  [u32 count][ u32 len, bytes ... ]*  (all little-endian).
 *  Returns bytes written, or the required size when cap is too small. */
function writeStringArray(memory: WebAssembly.Memory, out: number, cap: number, strings: readonly string[]): number {
  const enc = new TextEncoder();
  let total = 4; // count
  const encoded = strings.map((s) => enc.encode(s));
  for (const e of encoded) total += 4 + e.length;
  if (total > cap) return total;
  const view = new DataView(memory.buffer);
  let offset = 0;
  view.setUint32(out, encoded.length, true);
  offset += 4;
  for (const e of encoded) {
    view.setUint32(out + offset, e.length, true);
    offset += 4;
    // Note: absolute addressing via a fresh view (a view rooted at `out` would
    // need a relative offset here, which is easy to confuse — keep it absolute).
    new Uint8Array(memory.buffer, out + offset, e.length).set(e);
    offset += e.length;
  }
  return total;
}

function callNs<F extends (...args: any[]) => unknown>(
  ns: NSFull,
  path: readonly string[],
  args: unknown[],
): ReturnType<F> {
  let cur: unknown = ns;
  for (const key of path) {
    cur = (cur as Record<string, unknown>)[key];
  }
  if (typeof cur !== "function") {
    throw new Error(`Zig bridge: ns.${path.join(".")} is not a function`);
  }
  return (cur as F)(...args) as ReturnType<F>;
}

function makeImport(
  importName: string,
  spec: ZigApiSpec,
  ns: NSFull,
  getMemory: () => WebAssembly.Memory | undefined,
): (...args: unknown[]) => unknown {
  const path = spec.path;
  const mem = (): WebAssembly.Memory => {
    const m = getMemory();
    if (!m) throw new Error(`Zig bridge: wasm memory not available for ${importName}`);
    return m;
  };

  const impl: (...args: any[]) => unknown = (() => {
    switch (spec.kind) {
      case "void": // () -> void
        return () => {
          callNs(ns, path, []);
        };

      case "void-f64": // () -> f64
        return () => {
          return callNs(ns, path, []);
        };

      case "void-bool": // () -> bool
        return () => {
          const r = callNs(ns, path, []);
          return r ? 1 : 0;
        };

      case "str-bool": // (str|undefined) -> bool
        return (ptr?: number, len?: number) => {
          const host = readString(mem(), Number(ptr), Number(len));
          const r = callNs(ns, path, [host]);
          return r ? 1 : 0;
        };

      case "f64-void": // (f64) -> void
        return (ms: number) => {
          return callNs(ns, path, [Number(ms)]);
        };

      case "str-f64": // (str|undefined) -> f64
        return (ptr: number, len: number) => {
          const host = readString(mem(), Number(ptr), Number(len));
          return callNs(ns, path, [host]);
        };

      case "str-void": // (str) -> void
        return (ptr: number, len: number) => {
          const s = readString(mem(), Number(ptr), Number(len));
          callNs(ns, path, [s]);
        };

      case "void-str": // () -> string via out buffer
        return (out: number, cap: number) => {
          const r = callNs(ns, path, []) as string;
          return writeString(mem(), Number(out), Number(cap), String(r));
        };

      case "str-str": // (str|undefined) -> string via out buffer
        return (ptr: number, len: number, out: number, cap: number) => {
          const arg = readString(mem(), Number(ptr), Number(len));
          const r = callNs(ns, path, [arg]) as string;
          return writeString(mem(), Number(out), Number(cap), String(r));
        };

      case "f64str-f64": // (f64, str|undefined) -> f64
        return (threads: number, ptr: number, len: number) => {
          const host = readString(mem(), Number(ptr), Number(len));
          return callNs(ns, path, [Number(threads), host]);
        };

      case "strf64-f64": // (str|undefined, f64) -> f64
        return (ptr: number, len: number, value: number) => {
          const host = readString(mem(), Number(ptr), Number(len));
          return callNs(ns, path, [host, Number(value)]);
        };

      case "strstr-f64": // (str, str|undefined) -> f64
        return (p1: number, l1: number, p2: number, l2: number) => {
          const a = readString(mem(), Number(p1), Number(l1));
          const b = readString(mem(), Number(p2), Number(l2));
          return callNs(ns, path, [a, b]);
        };

      case "strstr-bool": // (str, str|undefined) -> bool
        return (p1: number, l1: number, p2: number, l2: number) => {
          const a = readString(mem(), Number(p1), Number(l1));
          const b = readString(mem(), Number(p2), Number(l2));
          const r = callNs(ns, path, [a, b]);
          return r ? 1 : 0;
        };

      case "str-array": {
        // (str|undefined) -> length-prefixed string array
        return (ptr: number, len: number, out: number, cap: number) => {
          const host = readString(mem(), Number(ptr), Number(len));
          const r = callNs(ns, path, [host]) as readonly string[];
          return writeStringArray(mem(), Number(out), Number(cap), r);
        };
      }

      case "run-args-json": // (str script, f64 threads, str argsJson) -> f64 pid
        return (pScript: number, lScript: number, threads: number, pArgs: number, lArgs: number) => {
          const script = readString(mem(), Number(pScript), Number(lScript));
          const args = JSON.parse(readString(mem(), Number(pArgs), Number(lArgs)) ?? "[]") as unknown[];
          return callNs(ns, path, [script, Number(threads), ...args]);
        };

      case "exec-args-json": // (str script, str host, f64 threads, str argsJson) -> f64 pid
        return (
          pScript: number,
          lScript: number,
          pHost: number,
          lHost: number,
          threads: number,
          pArgs: number,
          lArgs: number,
        ) => {
          const script = readString(mem(), Number(pScript), Number(lScript));
          const host = readString(mem(), Number(pHost), Number(lHost));
          const args = JSON.parse(readString(mem(), Number(pArgs), Number(lArgs)) ?? "[]") as unknown[];
          return callNs(ns, path, [script, host, Number(threads), ...args]);
        };

      case "json-args-bool": {
        // (str argsJson) -> bool — args are spread into the ns fn
        return (pArgs: number, lArgs: number) => {
          const json = readString(mem(), Number(pArgs), Number(lArgs)) ?? "[]";
          const args = JSON.parse(json) as unknown[];
          const r = callNs(ns, path, args);
          return r ? 1 : 0;
        };
      }

      case "exit": // () -> noreturn
        return () => {
          throw new ProcExit();
        };

      default: {
        const exhaustive: never = spec.kind;
        throw new Error(`Zig bridge: unimplemented kind ${exhaustive} for ${importName}`);
      }
    }
  })();

  return impl;
}
