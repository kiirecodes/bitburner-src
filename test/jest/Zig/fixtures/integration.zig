// End-to-end fixture exercised by ZigIntegration.test.ts.
// Covers sync string/slice getters, out-buffer (getHostname), length-prefixed
// arrays (scan), JSON args (run/kill), async calls (hack/sleep under JSPI) and
// ns.exit().
const ns = @import("bitburner.zig").ns;

pub export fn main() void {
    const host = ns.getHostname();
    ns.print(host);

    const neighbors = ns.scan(null);
    var found_home = false;
    for (neighbors) |n| {
        if (n.len == 4 and n[0] == 'h' and n[1] == 'o' and n[2] == 'm' and n[3] == 'e') {
            found_home = true;
        }
    }
    if (!found_home) {
        ns.print("scan failed");
    }

    const money = ns.getMoney();
    _ = money;

    const pid = ns.run("helper.js", 3.0, &.{"--flag", "n00dles"});
    _ = pid;

    const killed = ns.kill(.{ .name = "helper.js" }, null);
    _ = killed;

    const gained = ns.hack("n00dles");
    ns.sleep(5.0);
    if (gained > 0.0) {
        ns.exit();
    }
    ns.print("unreachable");
}