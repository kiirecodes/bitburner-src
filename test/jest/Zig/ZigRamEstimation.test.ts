/**
 * Tests for the source-scan RAM estimator used for `.zig` scripts.
 *
 * The estimator mirrors the static RAM model of JS scripts: base cost + the
 * `RamCosts` table value for each `ns.<fn>(` call in the source.
 */
import { getRamCost, RamCostConstants } from "../../../src/Netscript/RamCostGenerator";
import { estimateZigRamUsage } from "../../../src/Zig/ZigRamEstimation";
import { roundToTwo } from "../../../src/utils/helpers/roundToTwo";

/** Mirrors the estimator's accumulation order so float rounding matches exactly. */
const expected = (...costs: number[]): number => {
  let total = RamCostConstants.Base;
  for (const c of costs) total += c;
  return roundToTwo(total);
};

describe("estimateZigRamUsage", () => {
  it("charges only the base cost for a trivial script", () => {
    const r = estimateZigRamUsage("pub fn main() void {}");
    expect(r.cost).toBe(RamCostConstants.Base);
    expect(r.entries).toEqual([{ type: "misc", name: "baseCost", cost: RamCostConstants.Base }]);
  });

  it("sums RAM costs for each ns call", () => {
    const r = estimateZigRamUsage(`
      const ns = @import("bitburner.zig").ns;
      pub fn main() void {
        _ = ns.hack("n00dles");
        ns.getHackingLevel();
      }`);
    expect(r.cost).toBe(expected(getRamCost(["hack"]), getRamCost(["getHackingLevel"])));
    expect(r.entries?.map((e) => e.name)).toEqual(["baseCost", "ns.hack", "ns.getHackingLevel"]);
  });

  it("charges repeated calls to the same function multiple times", () => {
    const hackCost = getRamCost(["hack"]);
    const r = estimateZigRamUsage(`pub fn main() void { _ = ns.hack("a"); _ = ns.hack("b"); _ = ns.hack("c"); }`);
    expect(r.cost).toBe(expected(hackCost, hackCost, hackCost));
    const hackEntry = r.entries?.find((e) => e.name === "ns.hack");
    expect(hackEntry?.cost).toBe(hackCost + hackCost + hackCost);
  });

  it("ignores calls inside comments and unknown functions", () => {
    const r = estimateZigRamUsage(`
      // ns.hack("line comment")
      /* ns.grow("block comment") */
      pub fn main() void { _ = ns.definitelyNotAFunction("x"); }`);
    expect(r.cost).toBe(RamCostConstants.Base);
  });

  it("matches the JS static model for a known function set", () => {
    const r = estimateZigRamUsage(`
      pub export fn main() void {
        _ = ns.hack("a");
        _ = ns.weaken("a");
        _ = ns.scan(null);
        _ = ns.run("x.js", 1.0, &.{"a"});
        ns.print("done");
      }`);
    expect(r.cost).toBe(
      expected(
        getRamCost(["hack"]),
        getRamCost(["weaken"]),
        getRamCost(["scan"]),
        getRamCost(["run"]),
        getRamCost(["print"]),
      ),
    );
  });
});
