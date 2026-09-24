/**
 * Type declarations for the WebAssembly Promise Integration (JSPI) proposal
 * (Node 22+ / V8 experimental-stack-switching). Not yet part of the standard
 * TS WebAssembly types, so we declare the two members we use.
 *
 * - `new WebAssembly.Suspending(fn)`: callable from wasm; suspends the calling
 *   wasm function while `fn`'s returned Promise is pending.
 * - `WebAssembly.promising(fn)`: wraps a wasm export so JS `await`s it; the
 *   promise settles when the wasm computation finishes (across suspends).
 */
declare namespace WebAssembly {
  /**
   * `new WebAssembly.Suspending(fn)` produces an import function callable from
   * wasm that suspends the calling function while `fn`'s promise is pending.
   */
  const Suspending: new <T extends (...args: any[]) => unknown>(fn: T) => T;
  /**
   * `WebAssembly.promising(fn)` wraps a wasm export so JS can `await` the full
   * wasm computation (across suspends on async imports).
   */
  function promising<T extends (...args: any[]) => unknown>(fn: T): (...args: Parameters<T>) => Promise<unknown>;
}
