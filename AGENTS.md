### Filing GitHub Issues

You MUST follow these rules when filing a GitHub issue. These requirements are mandatory. Do not file the issue until all of them are satisfied.

#### Core Requirements

- **Follow the template:** Match the issue template exactly. Include all sections. Do not omit anything.
- **Keep it concise:** Be concise in both the issue title and description.
- **Focus on symptoms:** Describe only the symptoms of the bug. Do not put technical explanations in the "Describe the bug" section.
- **Separate debugging details from the bug description:** Place all root cause analysis and investigation details inside a collapsible `<details>` block under the "Additional Information" section as detailed below.

#### Handling In-Depth Investigations

If you find the root cause or a potential explanation during your debugging process:

- Do not include it in the "Describe the bug" section.
- Navigate to the "Additional Information" section.
- Nest your entire technical breakdown inside the <details> block format shown below.

Use this format:

```html
<details>
  <summary>In-depth investigation</summary>
  <p>Your explanation goes here.</p>
</details>
```

---

# Project Memory (architecture notes — keep updated when architecture changes)

## What this is

Bitburner v3.x — a programming-based incremental game (TypeScript + React 17 + MUI, webpack browser build + Electron desktop app). The core loop: the player writes scripts in JS/TS (in-game "Netscript") that run inside a browser-based sandbox and interact with game state.

## Where things live (high-level map)

- `src/` — all game code. Subsystems are folders: Server, Hacking, Company, Faction, Corporation, Gang, Bladeburner, Hacknet, Go, StockMarket, CotMG (Stanek's Gift), DarkNet, BitNode, SourceFile, Augmentation, Crime, Infiltration, Casino, CodingContract, Work, PersonObjects (Player/Sleeve/Grafting), Script, Netscript, Terminal, ScriptEditor, Documention, Locations, Programs, Message, Milestones, Achievements, Exploits, Themes, Settings, ui/.
- `test/jest/` — Jest unit tests (jest.config.js roots `src/` + `test/`). `tools/` — build scripts, electron packaging, docs generation. `electron/` — desktop main/preload/game windows, disk + Steam Cloud saves. `src/Documentation/doc/en` — in-game docs; `markdown/bitburner.md` — generated NS API docs.

## Key architecture facts

- **Boot**: `src/index.tsx` (ReactDOM.render LoadingScreen) → `src/ui/LoadingScreen.tsx` (initSwc WASM compiler + `load()` from IndexedDB `src/db.ts`) → `Engine.load(saveData)` → `<GameRoot/>` (`src/ui/GameRoot.tsx` owns the global `Router`, `src/ui/Router.ts` Page enum → page roots).
- **Game loop**: `src/engine.tsx`. `Engine.start()` self-reschedules `setTimeout` at `CONSTANTS.MilliPerCycle` (200 ms = 5 ticks/s). `Engine.updateGame(numCycles)` processes per-cycle subsystems: Player work → stock prices → gang → Stanek's gift → corporation → bladeburner → sleeves → DarkNet → script runtimes → Hacknet earnings → counters (autosave, faction invites, passive rep, messages, coding contracts, achievements). Counter-based autosave must stay LAST (save ordering guarantee). `Engine.load()` replays offline progress from `Player.lastUpdate` (offline cycles = floor(diff/200ms)).
- **State**: mutable singleton objects (NOT Redux): `Player` (`src/Player.ts` exports `let Player`; `setPlayer`/`loadPlayer`), `AllServers` (`src/Server/AllServers.ts`, Map keyed by hostname+IP), `Factions`, `Companies`, `Terminal` singleton, `workerScripts` (`src/Netscript/WorkerScripts.ts` Map pid→WorkerScript). UI reacts via `EventEmitter`s (`src/utils/EventEmitter.ts`) and `GameCycleEvents`.
- **Module aliases** (webpack + jest): `@player` → `src/Player`, `@enums` → `src/Enums`, `@nsdefs` → `src/ScriptEditor/NetscriptDefinitions.d.ts`.
- **Netscript run flow** (JS/TS scripts): Terminal `run` (`src/Terminal/commands/run.ts` → `runScript.ts`) or `ns.run/exec/spawn` → `NetscriptWorker.startWorkerScript` → `createAndAddWorkerScript` (RAM check, PID via `src/Netscript/Pid.ts`, `new WorkerScript(rs, pid, NetscriptFunctions)` — this builds the internal `ns` object `NSFull` from `src/NetscriptFunctions.ts`, registers in workerScripts) → `startNetscript2Script` → `compile(script, scripts)` (`src/NetscriptJSEvaluator.ts`: SWC/Babel transform via `src/utils/ScriptTransformer.ts`, acorn AST walk to rewrite in-game imports to blob URLs, `LoadedModule` + moduleCache) → `await mainFunc(ns)`.
- **The ns Proxy**: `src/Netscript/APIWrapper.ts` `NSProxy` wraps `NetscriptFunctions(ws)` output. Each access memoizes a wrapper that: builds `NetscriptContext {workerScript, function, functionPath}` (`src/Netscript/APIWrapper.ts` line 20) → `helpers.checkEnvFlags(ctx)` → `helpers.updateDynamicRam(ctx, getRamCost(arrayPath))` (dynamic RAM, `src/Netscript/RamCostGenerator.ts`) → calls internal fn `field(ctx, ...args)`. Internal fns validate args via `helpers.*` assertions (`src/Netscript/NetscriptHelpers.tsx` exports `helpers` incl. `updateDynamicRam`, `log`, `errorMessage`, `hack`, `netscriptDelay`). JSPI note: internal fns are typed `(ctx, ...args)` where ctx is the first param — this is the seam the Zig bridge reuses.
- **RAM**: static estimation at run time via `Script.getRamUsage`/`updateRamUsage` (`src/Script/Script.ts` → `calculateRamUsage` in `src/Script/RamCalculations.ts`, acorn AST walk costing `ns.*` calls from `RamCosts` tree) + dynamic per-call accounting (`helpers.updateDynamicRam` vs `RamCostConstants.Base` initial). `createRunningScriptInstance` (in `NetscriptWorker.ts`) is the single entry for run/exec RAM checks (also honors `--ram-override`).
- **Save/load**: `src/SaveObject.ts` `BitburnerSaveObject` (per-subsystem strings), `saveGame`/`loadGame`, `exportGame`/`importGame`, gzip via `CompressionStream` (`src/utils/SaveDataUtils.ts`); class instances tagged via `makeSerializable` (`src/utils/GenericReviver.ts`) with `Generic_toJSON/fromJSON`. Electron mirrors to disk + Steam Cloud (`electron/storage.js`, `electron/main.js`).
- **Types**: script files are `ScriptFilePath` (`src/Paths/ScriptFilePath.ts`, `validScriptExtensions = [".js",".jsx",".ts",".tsx",".script"]` — legacy `.script` rejected at run). `FileType` enum in `src/utils/ScriptTransformer.ts` (PLAINTEXT, JSON, JS, JSX, TS, TSX, NS1, CSS).

## Zig support (work in progress — Zig scripts)

Goal: allow `.zig` scripts to be written in-game and compiled+run. Design decisions already validated:

- **Compile target**: Zig (`-target wasm32-freestanding -fno-entry --export=main -O ReleaseSmall -fstrip`). This produces a module whose ONLY imports are our `bb_*` externs (exported `memory` + `main`), avoiding ~50 WASI imports the std pulls when using `wasm32-wasi` (std debug/start requires WASI). The std lib `std.debug.print` etc. are unavailable in freestanding — use of `std` is fine only for comptime/math/type manipulation; I/O + allocation go through the `bb_*` bridge.
- **Async = WebAssembly Promise Integration (JSPI)**: verified working on Node 26 (`WebAssembly.Suspending` class + `WebAssembly.promising`). WASM imports that call JS async functions (hack/grow/weaken/sleep) must be wrapped `new WebAssembly.Suspending(fn)`; the top-level entry must be invoked as `await WebAssembly.promising(inst.exports.main)()`. Zig 0.17 native `suspend`/`resume` is regressed (async rework since 0.11) so DO NOT rely on it. ABI rule: only f64/i32/pointer params (u64 arrives in JS as BigInt and breaks arithmetic — avoid).
- **Where the Zig bridge hooks in**: `ZigBridge.ts` exports `buildZigImpls` (the raw `bb_*` implementations: plain JS-callable functions bound to `ws.vars`) + `buildZigImports` (wraps those impls into the wasm `env` import object). Impls reuse the `NetscriptFunctions(ws)` internal API (functions are `(ctx, ...args)`) — the bridge builds a ctx per call, calls `helpers.updateDynamicRam` + the internal fn, marshalling strings through wasm memory (`TextDecoder`/`TextEncoder`). RAM base for zig scripts estimated by static source scan (see `src/Zig/ZigRamEstimation.ts`).
- **JSPI quirks (validated)**: `new WebAssembly.Suspending(fn)` yields an object callable ONLY from wasm, never from JS — tests therefore exercise the impls directly, not the wrapped env. Async impls must return the raw ns result (the Promise): the wasm signature is f64, so any `Number()` coercion produces NaN before JSPI can await. `bb_exit` is ALSO Suspending-wrapped so `ProcExit` survives JSPI as a clean rejection.
- **WASI shim**: `WasiPreview1` + `VirtualFileSystem` (`src/Zig/WasiPreview1.ts`) host the in-browser compiler binary (`BrowserZigCompiler` — a self-contained wasm32-wasi `zig` build, referenced by `ZIG_COMPILER_URL`, currently unset). The cwd preopen is fd 3, so `nextFd` starts at 4; `proc_exit` throws `ProcExitCode`. The script _runtime_ does NOT use WASI — player Zig modules are freestanding and link only against the `bb_*` bridge.
- **Entry points to extend when adding Zig APIs**: `src/Zig/zigApiDefs.ts` (table: zig fn name → internal ns path + signature), `src/Zig/bitburner.zig` (the Zig-side API layer, `@import("bitburner")`), `src/Zig/ZigBridge.ts` (JS import side), then regenerate docs.
