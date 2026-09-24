/**
 * End-to-end Zig test: compiles a real fixture with the native Zig compiler,
 * instantiates it through `runZigScript` (bridge + JSPI runtime) and asserts the
 * recorded ns calls — including async (hack/sleep) and a clean `ns.exit()`.
 *
 * Skipped when no `zig` binary is available on PATH.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { WorkerScript } from "../../../src/Netscript/WorkerScript";
import { NativeZigCompiler, setZigCompiler } from "../../../src/Zig/ZigCompiler";
import { runZigScript } from "../../../src/Zig/ZigRuntime";

const HAS_ZIG = (() => {
  try {
    execFileSync("zig", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const describeWithZig = HAS_ZIG ? describe : describe.skip;

const SOURCE = readFileSync(path.join(__dirname, "fixtures", "integration.zig"), "utf8");

describeWithZig("Zig integration (native compile + JSPI)", () => {
  beforeEach(() => setZigCompiler(new NativeZigCompiler()));
  afterEach(() => setZigCompiler(undefined));

  it("compiles and runs a script exercising sync, async and exit", async () => {
    const printed: string[] = [];
    const scanHosts: unknown[] = [];
    const runCalls: unknown[][] = [];
    const killCalls: unknown[][] = [];
    const fakeNs: Record<string, unknown> = {
      getHostname: () => "home",
      print: (msg: unknown) => printed.push(String(msg)),
      scan: (host: unknown) => {
        scanHosts.push(host);
        return ["home", "n00dles"];
      },
      getMoney: () => 1_000_000,
      run: (...args: unknown[]) => {
        runCalls.push(args);
        return 7;
      },
      kill: (...args: unknown[]) => {
        killCalls.push(args);
        return true;
      },
      hack: () => Promise.resolve(50),
      sleep: () => Promise.resolve(),
    };
    const fakeWs = {
      vars: fakeNs,
      stopFlag: false,
      getScript: () => ({ code: SOURCE, filename: "integration.zig" }),
    } as unknown as WorkerScript;

    const result = await runZigScript(fakeWs);

    // Wasm bytes produced and the script ran to a clean exit (ns.exit()).
    expect(result.wasmBytes.length).toBeGreaterThan(0);

    expect(printed).toContain("home");
    expect(printed).not.toContain("scan failed");
    expect(printed).not.toContain("unreachable");

    expect(scanHosts).toEqual([undefined]);

    expect(runCalls).toEqual([["helper.js", 3, "--flag", "n00dles"]]);
    expect(killCalls).toEqual([["helper.js"]]);
  }, 60_000);
});
