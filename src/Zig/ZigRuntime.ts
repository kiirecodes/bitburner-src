/**
 * ZigScriptRuntime — runs a compiled Zig module as a WorkerScript.
 *
 * Pipeline: player `.zig` source -> compiled to a freestanding wasm module
 * (`ZigCompiler`) -> instantiated with the Netscript bridge imports (`ZigBridge`)
 * -> entry (`main`, exported) invoked. Async ns APIs suspend/resume the module
 * through WebAssembly Promise Integration when available; otherwise async APIs
 * fail loudly on use.
 */
import type { WorkerScript } from "../Netscript/WorkerScript";
import { compileZigScript } from "./ZigCompiler";
import { buildZigImports, hasJSPI, ProcExit } from "./ZigBridge";

/** Error raised when a compiled Zig module does not export the expected entry point. */
export class ZigMissingMainError extends Error {
  constructor(filename: string) {
    super(`Zig script ${filename} does not export a \`main\` function. Add \`pub fn main() void\` to the script.`);
  }
}

export interface ZigRunResult {
  /** Bytes of the compiled module (useful for caching/debugging). */
  wasmBytes: Uint8Array;
}

/**
 * Compiles and runs a `.zig` script to completion. Resolves when the script's
 * `main` returns or it calls `ns.exit()`. Rejects on compile errors, traps, or
 * unhandled ns errors (these are surfaced as script crashes by the caller).
 */
export async function runZigScript(workerScript: WorkerScript): Promise<ZigRunResult> {
  const script = workerScript.getScript();
  if (!script) throw new Error("Zig script had no associated script. This is a bug.");

  const wasmBytes = await compileZigScript(script.code, script.filename);
  if (workerScript.stopFlag) return { wasmBytes };

  const { instance } = await instantiateZigScript(wasmBytes, workerScript);

  const main = instance.exports.main as ((...args: unknown[]) => unknown) | undefined;
  if (typeof main !== "function") {
    throw new ZigMissingMainError(script.filename);
  }

  try {
    if (hasJSPI()) {
      // Wrap the exported function so JS gets a promise that settles when the
      // wasm computation fully completes (across suspends on async imports).
      await WebAssembly.promising(main)();
    } else {
      main();
    }
  } catch (error) {
    if (error instanceof ProcExit) {
      // ns.exit(): treated as a clean termination.
      return { wasmBytes };
    }
    throw error;
  }

  return { wasmBytes };
}

/**
 * Compiles+instantiates a Zig module bound to a WorkerScript and returns the
 * instance plus the instantiate function (used by tests to drive it manually).
 */
export async function instantiateZigScript(
  wasmBytes: Uint8Array,
  workerScript: WorkerScript,
): Promise<{ instance: WebAssembly.Instance; instantiate: typeof WebAssembly.instantiate }> {
  let instance: WebAssembly.Instance | undefined = undefined;
  const imports = buildZigImports(workerScript, () => instance?.exports.memory as WebAssembly.Memory | undefined);

  if (typeof WebAssembly.instantiate !== "function") {
    throw new Error("WebAssembly.instantiate is required to run Zig scripts.");
  }

  const result = await WebAssembly.instantiate(wasmBytes as BufferSource, imports as unknown as WebAssembly.Imports);
  instance = result.instance;
  return { instance, instantiate: WebAssembly.instantiate };
}
