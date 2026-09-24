//! Bitburner Zig API layer — the `ns` prelude for `.zig` scripts.
//!
//! Import with:
//!   const ns = @import("bitburner.zig").ns;
//!
//! The game compiles player scripts with:
//!   zig build-exe main.zig -target wasm32-freestanding -fno-entry --export=main -O ReleaseSmall -fstrip
//! and hosts this module (plus the `bb_*` externs below) through
//! `src/Zig/ZigBridge.ts`. Every extern crosses the ABI with only f64/i32/pointer
//! values — NEVER i64/u64 (they arrive in JS as BigInt).
//!
//! Keep the exported function list (`pub const ns`) in sync with
//! `src/Zig/zigApiDefs.ts`.

const std = @import("std");

// ══════════════════════════════ Externs ══════════════════════════════
// Each maps to `bb_<name>` in src/Zig/ZigBridge.ts. Strings are (ptr, len)
// into our linear memory; omitted optional strings are encoded as (0, 0).
// Out-buffers follow a two-phase protocol: pass capacity, get required size,
// retry with a bigger buffer if required > capacity.

// async (suspended by the host via JSPI)
extern fn bb_sleep(ms: f64) void;
extern fn bb_asleep(ms: f64) void;
extern fn bb_hack(ptr: [*]const u8, len: usize) f64;
extern fn bb_grow(ptr: [*]const u8, len: usize) f64;
extern fn bb_weaken(ptr: [*]const u8, len: usize) f64;

// analysis / timing
extern fn bb_hackAnalyze(ptr: [*]const u8, len: usize) f64;
extern fn bb_hackAnalyzeChance(ptr: [*]const u8, len: usize) f64;
extern fn bb_hackAnalyzeSecurity(threads: f64, ptr: [*]const u8, len: usize) f64;
extern fn bb_hackAnalyzeThreads(ptr: [*]const u8, len: usize, value: f64) f64;
extern fn bb_getHackTime(ptr: [*]const u8, len: usize) f64;
extern fn bb_getGrowTime(ptr: [*]const u8, len: usize) f64;
extern fn bb_getWeakenTime(ptr: [*]const u8, len: usize) f64;

// player / script info
extern fn bb_getHackingLevel() f64;
extern fn bb_getHostname(out: [*]u8, out_cap: usize) usize;
extern fn bb_getScriptName(out: [*]u8, out_cap: usize) usize;
extern fn bb_getMoney() f64;

// server getters
extern fn bb_getServerMoneyAvailable(ptr: [*]const u8, len: usize) f64;
extern fn bb_getServerMaxMoney(ptr: [*]const u8, len: usize) f64;
extern fn bb_getServerMinSecurityLevel(ptr: [*]const u8, len: usize) f64;
extern fn bb_getServerSecurityLevel(ptr: [*]const u8, len: usize) f64;
extern fn bb_getServerBaseSecurityLevel(ptr: [*]const u8, len: usize) f64;
extern fn bb_getServerRequiredHackingLevel(ptr: [*]const u8, len: usize) f64;
extern fn bb_getServerMaxRam(ptr: [*]const u8, len: usize) f64;
extern fn bb_getServerUsedRam(ptr: [*]const u8, len: usize) f64;

// port-opening programs
extern fn bb_hasRootAccess(ptr: [*]const u8, len: usize) u32;
extern fn bb_nuke(ptr: [*]const u8, len: usize) u32;
extern fn bb_brutessh(ptr: [*]const u8, len: usize) u32;
extern fn bb_ftpcrack(ptr: [*]const u8, len: usize) u32;
extern fn bb_relaysmtp(ptr: [*]const u8, len: usize) u32;
extern fn bb_httpworm(ptr: [*]const u8, len: usize) u32;
extern fn bb_sqlinject(ptr: [*]const u8, len: usize) u32;

// logging
extern fn bb_print(ptr: [*]const u8, len: usize) void;
extern fn bb_tprint(ptr: [*]const u8, len: usize) void;
extern fn bb_disableLog(ptr: [*]const u8, len: usize) void;
extern fn bb_enableLog(ptr: [*]const u8, len: usize) void;
extern fn bb_isLogEnabled(ptr: [*]const u8, len: usize) u32;
extern fn bb_clearLog() void;

// script control
extern fn bb_run(script_ptr: [*]const u8, script_len: usize, threads: f64, args_ptr: [*]const u8, args_len: usize) f64;
extern fn bb_exec(script_ptr: [*]const u8, script_len: usize, host_ptr: [*]const u8, host_len: usize, threads: f64, args_ptr: [*]const u8, args_len: usize) f64;
extern fn bb_kill(args_ptr: [*]const u8, args_len: usize) u32;
extern fn bb_isRunning(args_ptr: [*]const u8, args_len: usize) u32;
extern fn bb_fileExists(file_ptr: [*]const u8, file_len: usize, host_ptr: [*]const u8, host_len: usize) u32;
extern fn bb_getScriptRam(script_ptr: [*]const u8, script_len: usize, host_ptr: [*]const u8, host_len: usize) f64;
extern fn bb_scan(ptr: [*]const u8, len: usize, out: [*]u8, out_cap: usize) usize;

// exit
extern fn bb_exit() noreturn;

// ══════════════════════════════ Memory ══════════════════════════════
// Bump allocator over a static buffer. Nothing is ever freed: that is fine for
// short-lived game scripts. Kept tiny so the default wasm memory stays small.

const HEAP_BYTES: usize = 512 * 1024;
var heap: [HEAP_BYTES]u8 = undefined;
var heap_used: usize = 0;

fn bumpAlloc(len: usize) []u8 {
    const alignment: usize = 8;
    const aligned = (len + (alignment - 1)) & ~(alignment - 1);
    if (heap_used + aligned > heap.len) return heap[0..0];
    const start = heap_used;
    heap_used += aligned;
    return heap[start .. start + len];
}

fn dupBytes(s: []const u8) []const u8 {
    const out = bumpAlloc(s.len);
    @memcpy(out, s);
    return out;
}

/// Copy a string returned by the host (host has written `len` bytes at `ptr`).
fn takeString(ptr: [*]u8, len: usize) []const u8 {
    return dupBytes(ptr[0..len]);
}

// ══════════════════════════════ Helpers ══════════════════════════════

/// Wire format for arrays of strings (used by `scan`): [u32 count][ (u32 len, bytes) ]* (LE).
fn parseStringArray(bytes: []const u8) []const []const u8 {
    var list: [128][]const u8 = undefined;
    var count: usize = 0;
    if (bytes.len >= 4) {
        const n = std.mem.readVarInt(u32, bytes[0..4], .little);
        var off: usize = 4;
        var i: usize = 0;
        while (i < n and off + 4 <= bytes.len and count < list.len) : (i += 1) {
            const len: usize = std.mem.readVarInt(u32, bytes[off .. off + 4], .little);
            off += 4;
            if (off + len > bytes.len) break;
            list[count] = dupBytes(bytes[off .. off + len]);
            count += 1;
            off += len;
        }
    }
    return list[0..count];
}

/// Minimal JSON array writer: strings and numbers. Used to package args for
/// `run`/`exec`/`kill`/`isRunning` (the host JSON.parses the arg array and
/// spreads it into the ns function). Escapes `"`, `\`, and control chars.
const JsonWriter = struct {
    buf: []u8,
    len: usize = 0,

    fn addChar(self: *JsonWriter, c: u8) void {
        if (self.len < self.buf.len) {
            self.buf[self.len] = c;
            self.len += 1;
        }
    }

    fn addSlice(self: *JsonWriter, s: []const u8) void {
        const end = @min(self.len + s.len, self.buf.len);
        const n = end - self.len;
        if (n > 0) @memcpy(self.buf[self.len .. end], s[0..n]);
        self.len = end;
    }

    fn addHex(self: *JsonWriter, v: u8) void {
        const hex = "0123456789abcdef";
        self.addChar(hex[v >> 4]);
        self.addChar(hex[v & 0x0f]);
    }

    fn writeEscaped(self: *JsonWriter, s: []const u8) void {
        for (s) |c| {
            switch (c) {
                '"' => self.addSlice("\\\""),
                '\\' => self.addSlice("\\\\"),
                0x08 => self.addSlice("\\b"),
                0x09 => self.addSlice("\\t"),
                0x0a => self.addSlice("\\n"),
                0x0c => self.addSlice("\\f"),
                0x0d => self.addSlice("\\r"),
                else => {
                    if (c < 0x20) {
                        self.addSlice("\\u00");
                        self.addHex(c);
                    } else {
                        self.addChar(c);
                    }
                },
            }
        }
    }

    fn writeString(self: *JsonWriter, s: []const u8) void {
        self.addChar('"');
        self.writeEscaped(s);
        self.addChar('"');
    }

    fn writeNumber(self: *JsonWriter, n: f64) void {
        var fmt_buf: [32]u8 = undefined;
        const s = std.fmt.bufPrint(&fmt_buf, "{d}", .{n}) catch return;
        self.addSlice(s);
    }

    /// Starts a JSON array on `out`, returning the running length.
    fn arrayBegin(out: []u8) usize {
        var w = JsonWriter{ .buf = out };
        w.addChar('[');
        return w.len;
    }

    /// Appends `,` then a JSON string item. Returns the new running length.
    fn addStrItem(prev_end: usize, out: []u8, s: []const u8) usize {
        var w = JsonWriter{ .buf = out, .len = prev_end };
        if (w.len != 1) w.addChar(',');
        w.writeString(s);
        return w.len;
    }

    /// Appends `,` then a JSON number item. Returns the new running length.
    fn addNumItem(prev_end: usize, out: []u8, n: f64) usize {
        var w = JsonWriter{ .buf = out, .len = prev_end };
        if (w.len != 1) w.addChar(',');
        w.writeNumber(n);
        return w.len;
    }

    /// Closes the JSON array. Returns the new running length.
    fn arrayEnd(prev_end: usize, out: []u8) usize {
        var w = JsonWriter{ .buf = out, .len = prev_end };
        w.addChar(']');
        return w.len;
    }
};

const JSON_CAP: usize = 4096;

// ══════════════════════════════ API layer ══════════════════════════════

pub const ns = struct {
    // ── async core loop ──────────────────────────────────────────────────
    pub fn sleep(ms: f64) void {
        bb_sleep(ms);
    }
    pub fn asleep(ms: f64) void {
        bb_asleep(ms);
    }
    pub fn hack(host: []const u8) f64 {
        return bb_hack(host.ptr, host.len);
    }
    pub fn grow(host: []const u8) f64 {
        return bb_grow(host.ptr, host.len);
    }
    pub fn weaken(host: []const u8) f64 {
        return bb_weaken(host.ptr, host.len);
    }

    // ── analysis ─────────────────────────────────────────────────────────
    pub fn hackAnalyze(host: []const u8) f64 {
        return bb_hackAnalyze(host.ptr, host.len);
    }
    pub fn hackAnalyzeChance(host: []const u8) f64 {
        return bb_hackAnalyzeChance(host.ptr, host.len);
    }
    pub fn hackAnalyzeSecurity(threads: f64, host: ?[]const u8) f64 {
        return bb_hackAnalyzeSecurity(threads, optPtr(host), optLen(host));
    }
    pub fn hackAnalyzeThreads(host: []const u8, hack_amount: f64) f64 {
        return bb_hackAnalyzeThreads(host.ptr, host.len, hack_amount);
    }

    // ── timing ───────────────────────────────────────────────────────────
    pub fn getHackTime(host: []const u8) f64 {
        return bb_getHackTime(host.ptr, host.len);
    }
    pub fn getGrowTime(host: []const u8) f64 {
        return bb_getGrowTime(host.ptr, host.len);
    }
    pub fn getWeakenTime(host: []const u8) f64 {
        return bb_getWeakenTime(host.ptr, host.len);
    }

    // ── player / script info ─────────────────────────────────────────────
    pub fn getHackingLevel() f64 {
        return bb_getHackingLevel();
    }
    pub fn getMoney() f64 {
        return bb_getMoney();
    }
    pub fn getHostname() []const u8 {
        var buf: [1024]u8 = undefined;
        var cap: usize = buf.len;
        while (true) {
            const needed = bb_getHostname(&buf, cap);
            if (needed <= cap) return takeString(&buf, needed);
            cap = needed;
        }
    }
    pub fn getScriptName() []const u8 {
        var buf: [1024]u8 = undefined;
        var cap: usize = buf.len;
        while (true) {
            const needed = bb_getScriptName(&buf, cap);
            if (needed <= cap) return takeString(&buf, needed);
            cap = needed;
        }
    }

    // ── server getters ───────────────────────────────────────────────────
    pub fn getServerMoneyAvailable(host: []const u8) f64 {
        return bb_getServerMoneyAvailable(host.ptr, host.len);
    }
    pub fn getServerMaxMoney(host: []const u8) f64 {
        return bb_getServerMaxMoney(host.ptr, host.len);
    }
    pub fn getServerMinSecurityLevel(host: []const u8) f64 {
        return bb_getServerMinSecurityLevel(host.ptr, host.len);
    }
    pub fn getServerSecurityLevel(host: []const u8) f64 {
        return bb_getServerSecurityLevel(host.ptr, host.len);
    }
    pub fn getServerBaseSecurityLevel(host: []const u8) f64 {
        return bb_getServerBaseSecurityLevel(host.ptr, host.len);
    }
    pub fn getServerRequiredHackingLevel(host: []const u8) f64 {
        return bb_getServerRequiredHackingLevel(host.ptr, host.len);
    }
    pub fn getServerMaxRam(host: []const u8) f64 {
        return bb_getServerMaxRam(host.ptr, host.len);
    }
    pub fn getServerUsedRam(host: []const u8) f64 {
        return bb_getServerUsedRam(host.ptr, host.len);
    }

    // ── port-opening programs ────────────────────────────────────────────
    pub fn hasRootAccess(host: []const u8) bool {
        return bb_hasRootAccess(host.ptr, host.len) != 0;
    }
    pub fn nuke(host: []const u8) bool {
        return bb_nuke(host.ptr, host.len) != 0;
    }
    pub fn brutessh(host: []const u8) bool {
        return bb_brutessh(host.ptr, host.len) != 0;
    }
    pub fn ftpcrack(host: []const u8) bool {
        return bb_ftpcrack(host.ptr, host.len) != 0;
    }
    pub fn relaysmtp(host: []const u8) bool {
        return bb_relaysmtp(host.ptr, host.len) != 0;
    }
    pub fn httpworm(host: []const u8) bool {
        return bb_httpworm(host.ptr, host.len) != 0;
    }
    pub fn sqlinject(host: []const u8) bool {
        return bb_sqlinject(host.ptr, host.len) != 0;
    }

    // ── logging ──────────────────────────────────────────────────────────
    pub fn print(msg: []const u8) void {
        bb_print(msg.ptr, msg.len);
    }
    pub fn tprint(msg: []const u8) void {
        bb_tprint(msg.ptr, msg.len);
    }
    pub fn disableLog(fn_name: []const u8) void {
        bb_disableLog(fn_name.ptr, fn_name.len);
    }
    pub fn enableLog(fn_name: []const u8) void {
        bb_enableLog(fn_name.ptr, fn_name.len);
    }
    pub fn isLogEnabled(fn_name: []const u8) bool {
        return bb_isLogEnabled(fn_name.ptr, fn_name.len) != 0;
    }
    pub fn clearLog() void {
        bb_clearLog();
    }

    // ── script control ───────────────────────────────────────────────────
    pub fn run(script: []const u8, threads: f64, args: []const []const u8) f64 {
        var args_json: [JSON_CAP]u8 = undefined;
        var e = JsonWriter.arrayBegin(&args_json);
        for (args) |a| e = JsonWriter.addStrItem(e, &args_json, a);
        e = JsonWriter.arrayEnd(e, &args_json);
        return bb_run(script.ptr, script.len, threads, &args_json, e);
    }

    pub fn exec(script: []const u8, host: []const u8, threads: f64, args: []const []const u8) f64 {
        var args_json: [JSON_CAP]u8 = undefined;
        var e = JsonWriter.arrayBegin(&args_json);
        for (args) |a| e = JsonWriter.addStrItem(e, &args_json, a);
        e = JsonWriter.arrayEnd(e, &args_json);
        return bb_exec(script.ptr, script.len, host.ptr, host.len, threads, &args_json, e);
    }

    pub const KillTarget = union(enum) {
        pid: f64,
        name: []const u8,
    };

    pub fn kill(target: KillTarget, host: ?[]const u8) bool {
        var args_json: [JSON_CAP]u8 = undefined;
        var e = JsonWriter.arrayBegin(&args_json);
        switch (target) {
            .pid => |p| e = JsonWriter.addNumItem(e, &args_json, p),
            .name => |n| e = JsonWriter.addStrItem(e, &args_json, n),
        }
        if (host) |h| {
            e = JsonWriter.addStrItem(e, &args_json, h);
        }
        e = JsonWriter.arrayEnd(e, &args_json);
        return bb_kill(&args_json, e) != 0;
    }

    pub fn isRunning(script: []const u8, host: ?[]const u8) bool {
        var args_json: [JSON_CAP]u8 = undefined;
        var e = JsonWriter.arrayBegin(&args_json);
        e = JsonWriter.addStrItem(e, &args_json, script);
        if (host) |h| {
            e = JsonWriter.addStrItem(e, &args_json, h);
        }
        e = JsonWriter.arrayEnd(e, &args_json);
        return bb_isRunning(&args_json, e) != 0;
    }

    pub fn fileExists(filename: []const u8, host: ?[]const u8) bool {
        return bb_fileExists(filename.ptr, filename.len, optPtr(host), optLen(host)) != 0;
    }

    pub fn getScriptRam(script: []const u8, host: ?[]const u8) f64 {
        return bb_getScriptRam(script.ptr, script.len, optPtr(host), optLen(host));
    }

    pub fn scan(host: ?[]const u8) []const []const u8 {
        var buf: [4096]u8 = undefined;
        var cap: usize = buf.len;
        while (true) {
            const needed = bb_scan(optPtr(host), optLen(host), &buf, cap);
            if (needed <= cap) {
                return parseStringArray(buf[0..needed]);
            }
            cap = needed;
        }
    }

    // ── misc ─────────────────────────────────────────────────────────────
    pub fn exit() noreturn {
        bb_exit();
    }
};

fn optPtr(s: ?[]const u8) [*]const u8 {
    if (s) |x| return x.ptr;
    // A zero-length slice: len == 0 signals "undefined" to the host.
    return empty_slice.ptr;
}

fn optLen(s: ?[]const u8) usize {
    return if (s) |x| x.len else 0;
}

const empty_slice: []const u8 = "";