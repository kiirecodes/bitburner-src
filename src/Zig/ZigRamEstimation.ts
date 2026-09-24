/**
 * Static RAM estimation for `.zig` scripts.
 *
 * JS/TS scripts get their RAM cost from an AST walk (`calculateRamUsage`). Zig
 * scripts can't be parsed by acorn, so we estimate by scanning the source for
 * `ns.<function>(` calls and summing the same `RamCosts` values the JS walker
 * charges, plus the base cost. This mirrors the static cost model closely enough:
 * the dynamic per-call accounting (done by the NS proxy) is always covered.
 */
import { getRamCost, RamCostConstants } from "../Netscript/RamCostGenerator";
import { roundToTwo } from "../utils/helpers/roundToTwo";
import type { RamCalculation, RamUsageEntry } from "../Script/RamCalculations";
import { zigApiDefs } from "./zigApiDefs";

const callRegex = /\bns\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

/**
 * Best-effort comment removal so `ns.*(` calls inside comments don't inflate RAM.
 * Strings containing `//` or `/*` are also affected, but under-counting in that
 * case is the safer failure mode (it never *adds* cost the player didn't write).
 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Map of zig function name -> its ns RamCosts path (defaults to the same name). */
const ramPathByName = new Map<string, string[]>(zigApiDefs.map((def) => [def.zigName, [...def.path]]));

/**
 * Estimates the static RAM usage of a Zig script's source.
 * Returns a `RamCalculation` in the same shape `calculateRamUsage` produces so
 * callers can treat Zig and JS scripts uniformly.
 */
export function estimateZigRamUsage(code: string): RamCalculation {
  let total = RamCostConstants.Base;
  const perFunction = new Map<string, number>();

  const scanned = stripComments(code);
  callRegex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = callRegex.exec(scanned)) !== null) {
    const name = match[1];
    const cost = getRamCost(ramPathByName.get(name) ?? [name]);
    total += cost;
    perFunction.set(name, (perFunction.get(name) ?? 0) + cost);
  }

  const entries: RamUsageEntry[] = [{ type: "misc", name: "baseCost", cost: RamCostConstants.Base }];
  for (const [name, cost] of perFunction) {
    if (cost > 0) entries.push({ type: "ns", name: `ns.${name}`, cost });
  }

  return { cost: roundToTwo(total), entries };
}
