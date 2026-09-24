/**
 * Zig API definitions — single source of truth for the Zig↔Netscript bridge.
 *
 * Every entry here describes one function of the Zig API layer (`@import("bitburner.zig")`
 * in player-script land, JS side in `ZigBridge.ts`). To add a new Zig API:
 *   1. Add a `ZigApiSpec` entry here,
 *   2. add the matching `bb_*` extern + wrapper in `src/Zig/bitburner.zig`,
 *   3. implement the marshalling for its `kind` in `src/Zig/ZigBridge.ts`,
 *   4. it will automatically be picked up by the RAM estimator (`ZigRamEstimation.ts`).
 *
 * ABI rules (validated against a real Zig 0.17 wasm module):
 *   - Only f64 / i32 / pointer params cross the ABI. NEVER i64/u64 (they arrive in JS as
 *     BigInt and break arithmetic).
 *   - Strings are passed as (ptr: i32, len: i32) into the module's exported `memory`.
 *   - An omitted optional string arg is encoded as (0, 0) — the bridge maps it to `undefined`.
 *   - Out-buffers are written back into wasm memory; if the provided capacity is too small
 *     the function returns the required size (two-phase protocol) — Zig retries with a bigger
 *     buffer.
 */

/** How a Zig API call is marshalled between wasm and the Netscript proxy. */
export type ZigApiKind =
  /** () -> void */
  | "void"
  /** () -> f64 */
  | "void-f64"
  /** () -> bool (i32) */
  | "void-bool"
  /** (f64 ms) -> void. Async (sleep / asleep). */
  | "f64-void"
  /** (str) -> f64. One string arg (0,0) == undefined (defaults to current server / script). */
  | "str-f64"
  /** (str) -> bool (i32) */
  | "str-bool"
  /** (str) -> void */
  | "str-void"
  /** () -> string via out buffer (two-phase). e.g. getHostname, getScriptName. */
  | "void-str"
  /** (str, out, outCap) -> usize in bytes written (two-phase). String result. */
  | "str-str"
  /** (f64, str) -> f64. e.g. hackAnalyzeSecurity(threads, host?) */
  | "f64str-f64"
  /** (str, f64) -> f64. e.g. hackAnalyzeThreads(host, hackAmount) */
  | "strf64-f64"
  /** (str, str) -> f64. Two string args, second optional. e.g. getScriptRam(script, host?) */
  | "strstr-f64"
  /** (str, str) -> bool. Two string args, second optional. e.g. fileExists(filename, host?) */
  | "strstr-bool"
  /** (str, out, outCap) -> usize. Returns a length-prefixed string array (scan). */
  | "str-array"
  /** (str script, f64 threads, str argsJson) -> f64 pid. e.g. run. */
  | "run-args-json"
  /** (str script, str host, f64 threads, str argsJson) -> f64 pid. e.g. exec. */
  | "exec-args-json"
  /** (str argsJson) -> bool. e.g. kill / isRunning (args: [scriptID, host?]) */
  | "json-args-bool"
  /** () -> noreturn. Exits the script. */
  | "exit";

export interface ZigApiSpec {
  /** Name used in the Zig layer (`extern fn bb_<zigName>` / `ns.<zigName>`) and the bridge. */
  zigName: string;
  /** Path into the (proxied) ns object this call is routed to. */
  path: readonly string[];
  kind: ZigApiKind;
  /** True if the underlying ns function is async (returns a Promise). These imports need Suspending. */
  async: boolean;
}

/**
 * The Zig API surface implemented for v1. Only top-level (non-namespaced) ns functions.
 * Everything is routed through the same NS proxy the JS scripts use, so validation, dynamic
 * RAM accounting and logging behave identically to JS scripts.
 */
export const zigApiDefs: readonly ZigApiSpec[] = [
  // ── Async core hacking loop ─────────────────────────────────────────────
  { zigName: "sleep", path: ["sleep"], kind: "f64-void", async: true },
  { zigName: "asleep", path: ["asleep"], kind: "f64-void", async: true },
  { zigName: "hack", path: ["hack"], kind: "str-f64", async: true },
  { zigName: "grow", path: ["grow"], kind: "str-f64", async: true },
  { zigName: "weaken", path: ["weaken"], kind: "str-f64", async: true },

  // ── Hack analysis (sync) ────────────────────────────────────────────────
  { zigName: "hackAnalyze", path: ["hackAnalyze"], kind: "str-f64", async: false },
  { zigName: "hackAnalyzeChance", path: ["hackAnalyzeChance"], kind: "str-f64", async: false },
  { zigName: "hackAnalyzeSecurity", path: ["hackAnalyzeSecurity"], kind: "f64str-f64", async: false },
  { zigName: "hackAnalyzeThreads", path: ["hackAnalyzeThreads"], kind: "strf64-f64", async: false },

  // ── Timing getters ──────────────────────────────────────────────────────
  { zigName: "getHackTime", path: ["getHackTime"], kind: "str-f64", async: false },
  { zigName: "getGrowTime", path: ["getGrowTime"], kind: "str-f64", async: false },
  { zigName: "getWeakenTime", path: ["getWeakenTime"], kind: "str-f64", async: false },

  // ── Player / script info ────────────────────────────────────────────────
  { zigName: "getHackingLevel", path: ["getHackingLevel"], kind: "void-f64", async: false },
  { zigName: "getHostname", path: ["getHostname"], kind: "void-str", async: false },
  { zigName: "getScriptName", path: ["getScriptName"], kind: "void-str", async: false },
  { zigName: "getMoney", path: ["getMoney"], kind: "void-f64", async: false },

  // ── Server getters ──────────────────────────────────────────────────────
  { zigName: "getServerMoneyAvailable", path: ["getServerMoneyAvailable"], kind: "str-f64", async: false },
  { zigName: "getServerMaxMoney", path: ["getServerMaxMoney"], kind: "str-f64", async: false },
  { zigName: "getServerMinSecurityLevel", path: ["getServerMinSecurityLevel"], kind: "str-f64", async: false },
  { zigName: "getServerSecurityLevel", path: ["getServerSecurityLevel"], kind: "str-f64", async: false },
  { zigName: "getServerBaseSecurityLevel", path: ["getServerBaseSecurityLevel"], kind: "str-f64", async: false },
  { zigName: "getServerRequiredHackingLevel", path: ["getServerRequiredHackingLevel"], kind: "str-f64", async: false },
  { zigName: "getServerMaxRam", path: ["getServerMaxRam"], kind: "str-f64", async: false },
  { zigName: "getServerUsedRam", path: ["getServerUsedRam"], kind: "str-f64", async: false },
  { zigName: "hasRootAccess", path: ["hasRootAccess"], kind: "str-bool", async: false },

  // ── Port opening programs ───────────────────────────────────────────────
  { zigName: "nuke", path: ["nuke"], kind: "str-bool", async: false },
  { zigName: "brutessh", path: ["brutessh"], kind: "str-bool", async: false },
  { zigName: "ftpcrack", path: ["ftpcrack"], kind: "str-bool", async: false },
  { zigName: "relaysmtp", path: ["relaysmtp"], kind: "str-bool", async: false },
  { zigName: "httpworm", path: ["httpworm"], kind: "str-bool", async: false },
  { zigName: "sqlinject", path: ["sqlinject"], kind: "str-bool", async: false },

  // ── Logging ─────────────────────────────────────────────────────────────
  { zigName: "print", path: ["print"], kind: "str-void", async: false },
  { zigName: "tprint", path: ["tprint"], kind: "str-void", async: false },
  { zigName: "disableLog", path: ["disableLog"], kind: "str-void", async: false },
  { zigName: "enableLog", path: ["enableLog"], kind: "str-void", async: false },
  { zigName: "isLogEnabled", path: ["isLogEnabled"], kind: "str-bool", async: false },
  { zigName: "clearLog", path: ["clearLog"], kind: "void", async: false },

  // ── Script control ──────────────────────────────────────────────────────
  { zigName: "run", path: ["run"], kind: "run-args-json", async: false },
  { zigName: "exec", path: ["exec"], kind: "exec-args-json", async: false },
  { zigName: "kill", path: ["kill"], kind: "json-args-bool", async: false },
  { zigName: "isRunning", path: ["isRunning"], kind: "json-args-bool", async: false },
  { zigName: "fileExists", path: ["fileExists"], kind: "strstr-bool", async: false },
  { zigName: "getScriptRam", path: ["getScriptRam"], kind: "strstr-f64", async: false },
  { zigName: "scan", path: ["scan"], kind: "str-array", async: false },

  // ── Misc ────────────────────────────────────────────────────────────────
  { zigName: "exit", path: ["exit"], kind: "exit", async: false },
];

/** Map from `bb_<zigName>` import name to its spec. */
export const zigApiDefByName: ReadonlyMap<string, ZigApiSpec> = new Map(
  zigApiDefs.map((spec) => [`bb_${spec.zigName}`, spec]),
);
