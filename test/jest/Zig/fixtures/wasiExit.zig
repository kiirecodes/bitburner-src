// wasm32-wasi fixture exercised by WasiPreview1.test.ts to verify proc_exit
// and `wasi.exitCode` propagation.
const std = @import("std");

pub fn main() void {
    std.process.exit(7);
}