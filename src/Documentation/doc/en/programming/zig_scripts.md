# Zig Scripts

**Work in progress.** Bitburner can run scripts written in [Zig](https://ziglang.org/) — files ending in `.zig`. A Zig script is compiled to WebAssembly when you run it, then executed with the same `ns` API surface JavaScript scripts use. Everything that applies to JS scripts (RAM costs, `ns.run()`/`ns.exec()`, killing, terminal `run`) applies to Zig scripts too.

Like JS/TS scripts, Zig scripts require [RAM](../basic/ram.md) and are identified by filename, hostname and arguments.

## Writing a Zig script

A Zig script is a normal Zig program with a `main` function. The game compiles it as a freestanding wasm module and calls `main`:

```zig
const ns = @import("bitburner.zig").ns;

pub fn main() void {
    ns.print("hello from Zig!");
}
```

If you do not write the `ns` import yourself, the game adds it automatically, so the shortest valid script is:

```zig
pub fn main() void {
    ns.print("hello from Zig!");
}
```

### Types and the ABI

The Zig API layer keeps the wasm calling convention small, which has a few consequences:

- **Numbers are `f64`.** Every `ns` function that returns a number returns `f64`; there are no `i32`/`u64` returns. When a game value is inherently integral (like a PID), trailing decimals are truncated by the game.
- **Strings are `[]const u8`.** `ns.print("x")` -style slices work directly. String values (like `getHostname()`) are returned as slices that stay valid until the next bridge call.
- **Optional strings are `?[]const u8`.** Pass `null` (or omit, for Zig optional parameters) where the JS API treats an argument as optional — e.g. `ns.hack(null)` targets the current server, and `ns.fileExists("foo.zig", null)` checks the current server.
- **Booleans** are returned as `bool`.
- Do not use `i64`/`u64` or `usize` <-> number conversions with bridge return values; stick to `f64`.

## Calling convention for async functions

`hack`, `grow`, `weaken`, `sleep`, and `asleep` are **asynchronous**: when your script calls one, the module is suspended until the operation completes, then resumes. You write them like ordinary void/returning functions:

```zig
pub fn main() void {
    ns.hack("n00dles");
    ns.sleep(1000);
    ns.grow("n00dles");
}
```

This relies on WebAssembly Promise Integration (JSPI), which is available in current Chrome/Edge and Node-based Electron builds. On runtimes without JSPI support, calling an async function fails with a clear error.

## Available functions

The v1 surface covers the core top-level `ns` functions:

### Async hacking loop

| Function                          | Description                                                          |
| --------------------------------- | -------------------------------------------------------------------- |
| `ns.hack(host: []const u8) f64`   | Hack a server, returns the money stolen.                             |
| `ns.grow(host: []const u8) f64`   | Grow a server's money.                                               |
| `ns.weaken(host: []const u8) f64` | Lower a server's security level.                                     |
| `ns.sleep(ms: f64) void`          | Wait `ms` milliseconds.                                              |
| `ns.asleep(ms: f64) void`         | Wait regardless of player "awakeness" (same as `sleep` for scripts). |

### Analysis and timing

| Function                                                        | Description                                         |
| --------------------------------------------------------------- | --------------------------------------------------- |
| `ns.hackAnalyze(host: []const u8) f64`                          | Percent of money that one hack would steal.         |
| `ns.hackAnalyzeChance(host: []const u8) f64`                    | Chance a hack succeeds.                             |
| `ns.hackAnalyzeSecurity(threads: f64, host: ?[]const u8) f64`   | Security increase of a hack with `threads` threads. |
| `ns.hackAnalyzeThreads(host: []const u8, hack_amount: f64) f64` | Threads needed to steal `hack_amount`.              |
| `ns.getHackTime(host: []const u8) f64`                          | Milliseconds a hack takes.                          |
| `ns.getGrowTime(host: []const u8) f64`                          | Milliseconds a grow takes.                          |
| `ns.getWeakenTime(host: []const u8) f64`                        | Milliseconds a weaken takes.                        |

### Player and script info

| Function                        | Description                                 |
| ------------------------------- | ------------------------------------------- |
| `ns.getHackingLevel() f64`      | Your hacking level.                         |
| `ns.getMoney() f64`             | Your money.                                 |
| `ns.getHostname() []const u8`   | Hostname of the server this script runs on. |
| `ns.getScriptName() []const u8` | Filename of this script.                    |

### Server getters

| Function                                                 | Description                          |
| -------------------------------------------------------- | ------------------------------------ |
| `ns.getServerMoneyAvailable(host: []const u8) f64`       | Available money on `host`.           |
| `ns.getServerMaxMoney(host: []const u8) f64`             | Maximum money on `host`.             |
| `ns.getServerMinSecurityLevel(host: []const u8) f64`     | Minimum security on `host`.          |
| `ns.getServerSecurityLevel(host: []const u8) f64`        | Current security on `host`.          |
| `ns.getServerBaseSecurityLevel(host: []const u8) f64`    | Base security of `host`.             |
| `ns.getServerRequiredHackingLevel(host: []const u8) f64` | Hacking level needed to hack `host`. |
| `ns.getServerMaxRam(host: []const u8) f64`               | Total RAM on `host`.                 |
| `ns.getServerUsedRam(host: []const u8) f64`              | Used RAM on `host`.                  |
| `ns.hasRootAccess(host: []const u8) bool`                | Whether you have root access.        |

### Port-opening programs

| Function                              | Description                     |
| ------------------------------------- | ------------------------------- |
| `ns.nuke(host: []const u8) bool`      | Run NUKE.exe, gain root access. |
| `ns.brutessh(host: []const u8) bool`  | Run BruteSSH.exe.               |
| `ns.ftpcrack(host: []const u8) bool`  | Run FTPCrack.exe.               |
| `ns.relaysmtp(host: []const u8) bool` | Run relaySMTP.exe.              |
| `ns.httpworm(host: []const u8) bool`  | Run HTTPWorm.exe.               |
| `ns.sqlinject(host: []const u8) bool` | Run SQLInject.exe.              |

### Logging

| Function                               | Description                         |
| -------------------------------------- | ----------------------------------- |
| `ns.print(msg: []const u8) void`       | Print to the script's log.          |
| `ns.tprint(msg: []const u8) void`      | Print to the terminal.              |
| `ns.disableLog(fn: []const u8) void`   | Disable logging for an ns function. |
| `ns.enableLog(fn: []const u8) void`    | Re-enable logging.                  |
| `ns.isLogEnabled(fn: []const u8) bool` | Whether logging is enabled.         |
| `ns.clearLog() void`                   | Clear the script's log.             |

### Script control

| Function                                                                                    | Description                                        |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `ns.run(script: []const u8, threads: f64, args: []const []const u8) f64`                    | Run a script on the current server; returns a PID. |
| `ns.exec(script: []const u8, host: []const u8, threads: f64, args: []const []const u8) f64` | Run a script on another server; returns a PID.     |
| `ns.kill(target: KillTarget, host: ?[]const u8) bool`                                       | Kill by PID (`.pid`) or filename (`.name`).        |
| `ns.isRunning(script: []const u8, host: ?[]const u8) bool`                                  | Whether a script is running.                       |
| `ns.fileExists(filename: []const u8, host: ?[]const u8) bool`                               | Whether a file exists.                             |
| `ns.getScriptRam(script: []const u8, host: ?[]const u8) f64`                                | RAM a script costs.                                |
| `ns.scan(host: ?[]const u8) []const []const u8`                                             | Servers adjacent to `host` (default: current).     |
| `ns.exit() noreturn`                                                                        | Terminate this script and free its RAM.            |

### Example: hack-and-weaken loop

```zig
const ns = @import("bitburner.zig").ns;

pub fn main() void {
    const target = ns.scan(null)[0];
    ns.print(target);
    while (true) {
        ns.hack(target);
        ns.weaken(target);
        ns.sleep(1000);
    }
}
```

## Running Zig scripts

- From the terminal: `run attack.zig`
- From another script: `ns.run("attack.zig", 1, &.{});` or `ns.exec("attack.zig", "n00dles", 1, &.{});`
- RAM is estimated from the script's source (your `ns.*` calls) and accounted per call at runtime, exactly like JS scripts.

## Not yet supported

Zig scripting is a work in progress. Currently missing:

- Reading the script's own command-line arguments (`ns.args`).
- Namespaced APIs (e.g. `ns.corporation.*`), `ns.getPlayer()`, ports, and most other non-core functions.
- In-game compilation requires a Zig compiler: normal game builds require a wasm32-wasi `zig` binary configured at build time, and dev/test builds can use a native `zig` binary. If your build has neither, running a `.zig` script reports that the in-browser compiler is not configured.
