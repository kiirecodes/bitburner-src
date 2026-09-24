// wasm32-wasi fixture exercised by WasiPreview1.test.ts. Exercises the raw
// wasi_snapshot_preview1 syscalls a zig binary uses for file I/O: path_open
// (create + read), fd_write and fd_read, all against the preopened cwd (fd 3).
//
// Written against `std.os.wasi` externs directly (std.fs's cwd()/createFile
// were folded into the std.Io rewrite in 0.16+).
const std = @import("std");
const wasi = std.os.wasi;

const cwd: wasi.fd_t = 3; // first preopen is the current working directory

pub fn main() void {
    // 1) Write a line to stdout (fd 1).
    {
        const msg = "hello from wasi\n";
        const iovs = [_]wasi.ciovec_t{.{ .base = msg.ptr, .len = msg.len }};
        var nwritten: usize = 0;
        if (wasi.fd_write(1, &iovs, iovs.len, &nwritten) != .SUCCESS) wasi.proc_exit(10);
    }

    // 2) Create "output.txt" and write "hello ".
    var out_fd: wasi.fd_t = undefined;
    {
        const path = "output.txt";
        const flags = wasi.oflags_t{ .CREAT = true };
        const rights = wasi.rights_t{ .FD_WRITE = true };
        if (wasi.path_open(cwd, .{}, path.ptr, path.len, flags, rights, .{}, .{}, &out_fd) != .SUCCESS)
            wasi.proc_exit(11);
        const data = "hello ";
        const iovs = [_]wasi.ciovec_t{.{ .base = data.ptr, .len = data.len }};
        var nwritten: usize = 0;
        if (wasi.fd_write(out_fd, &iovs, iovs.len, &nwritten) != .SUCCESS) wasi.proc_exit(12);
    }

    // 3) Read "input.txt" and append its contents to "output.txt".
    {
        const path = "input.txt";
        const rights = wasi.rights_t{ .FD_READ = true };
        var in_fd: wasi.fd_t = undefined;
        if (wasi.path_open(cwd, .{}, path.ptr, path.len, .{}, rights, .{}, .{}, &in_fd) != .SUCCESS)
            wasi.proc_exit(13);
        var buf: [64]u8 = undefined;
        const iovs = [_]wasi.iovec_t{.{ .base = &buf, .len = buf.len }};
        var nread: usize = 0;
        if (wasi.fd_read(in_fd, &iovs, iovs.len, &nread) != .SUCCESS) wasi.proc_exit(14);
        const iovs2 = [_]wasi.ciovec_t{.{ .base = buf[0..nread].ptr, .len = nread }};
        var nwritten: usize = 0;
        if (wasi.fd_write(out_fd, &iovs2, iovs2.len, &nwritten) != .SUCCESS) wasi.proc_exit(15);
        if (wasi.fd_close(in_fd) != .SUCCESS) wasi.proc_exit(16);
    }
}