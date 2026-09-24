/**
 * WasiPreview1 — a minimal `wasi_snapshot_preview1` implementation over an
 * in-memory filesystem. Its purpose here is to run a WebAssembly build of the
 * Zig compiler (a `wasm32-wasi` executable) inside the browser, translating its
 * WASI syscalls into operations on an in-memory tree of files.
 *
 * The compiled player scripts themselves are `wasm32-freestanding` and never
 * import WASI — they only import the `bb_*` functions from ZigBridge.
 *
 * Supported, which is the practical subset a self-hosted zig compiler needs:
 * args/env, clocks, random, proc_exit, fd lifecycle + read/write/seek/stat,
 * path_open/create/unlink/rename, readdir, preopens (cwd). Everything else
 * returns ENOSYS. Errors use the standard WASI errno values.
 */
export const wasiErrno = {
  ESUCCESS: 0,
  E2BIG: 1,
  EACCES: 2,
  EAGAIN: 6,
  EBADF: 8,
  EFAULT: 21,
  EEXIST: 20,
  EINVAL: 28,
  EIO: 29,
  EISDIR: 31,
  ELOOP: 32,
  ENAMETOOLONG: 37,
  ENFILE: 41,
  ENOBUFS: 42,
  ENODEV: 43,
  ENOENT: 44,
  ENOMEM: 48,
  ENOSPC: 51,
  ENOSYS: 52,
  ENOTDIR: 54,
  ENOTEMPTY: 55,
  ENOTSUP: 58,
  EOVERFLOW: 61,
  EPERM: 63,
  EPIPE: 64,
  ESPIPE: 70,
  EXDEV: 75,
  ENOTCAPABLE: 76,
} as const;

export const wasiRights = {
  FD_DATASYNC: 1n << 0n,
  FD_READ: 1n << 1n,
  FD_SEEK: 1n << 2n,
  FD_FDSTAT_SET_FLAGS: 1n << 3n,
  FD_SYNC: 1n << 4n,
  FD_TELL: 1n << 5n,
  FD_WRITE: 1n << 6n,
  FD_ADVISE: 1n << 7n,
  FD_ALLOCATE: 1n << 8n,
  PATH_CREATE_DIRECTORY: 1n << 9n,
  PATH_CREATE_FILE: 1n << 10n,
  PATH_LINK_SOURCE: 1n << 11n,
  PATH_LINK_TARGET: 1n << 12n,
  PATH_OPEN: 1n << 13n,
  FD_READDIR: 1n << 14n,
  PATH_READLINK: 1n << 15n,
  PATH_RENAME_SOURCE: 1n << 16n,
  PATH_RENAME_TARGET: 1n << 17n,
  PATH_FILESTAT_GET: 1n << 18n,
  PATH_FILESTAT_SET_SIZE: 1n << 19n,
  PATH_FILESTAT_SET_TIMES: 1n << 20n,
  FD_FILESTAT_GET: 1n << 21n,
  FD_FILESTAT_SET_SIZE: 1n << 22n,
  FD_FILESTAT_SET_TIMES: 1n << 23n,
  PATH_SYMLINK: 1n << 24n,
  PATH_REMOVE_DIRECTORY: 1n << 25n,
  PATH_UNLINK_FILE: 1n << 26n,
  POLL_FD_READWRITE: 1n << 27n,
  SOCK_SHUTDOWN: 1n << 28n,
} as const;

export interface FsNode {
  kind: "file" | "dir";
  data?: Uint8Array;
  /** Present on every node; empty for files. */
  children: Map<string, FsNode>;
}

/** Memory-like view of a WASI guest's linear memory (from the instance exports). */
export interface WasiMemory {
  buffer: ArrayBuffer;
}

interface FdEntry {
  fd: number;
  node: FsNode;
  /** Path used to open it (for diagnostics). */
  path: string;
  pos: number;
  dirFd: boolean;
  preopen: boolean;
  append: boolean;
  rights: bigint;
}

interface PreopenSpec {
  path: string; // mount path in the guest namespace
}

export class VirtualFileSystem {
  readonly root: FsNode = { kind: "dir", children: new Map() };

  constructor(initialFiles: Record<string, string | Uint8Array> = {}) {
    for (const [path, content] of Object.entries(initialFiles)) {
      this.writeFile(path, content);
    }
  }

  /** Split and normalize a guest path ("/a/./b/../c" -> ["a", "c"], "" for root). */
  private normalizePath(path: string): string[] {
    const parts = path.split("/").filter((p) => p.length > 0 && p !== ".");
    const out: string[] = [];
    for (const part of parts) {
      if (part === "..") {
        out.pop();
      } else {
        out.push(part);
      }
    }
    return out;
  }

  /** Navigate to a node; returns the parent of the last component plus the name. */
  private navigate(path: string): { parent: FsNode; name: string; existed: boolean } | null {
    const parts = this.normalizePath(path);
    if (parts.length === 0) return { parent: this.root, name: "", existed: true };
    let cur: FsNode = this.root;
    for (let i = 0; i < parts.length - 1; i++) {
      const next = cur.children.get(parts[i]);
      if (!next || next.kind !== "dir") return null;
      cur = next;
    }
    const name = parts[parts.length - 1];
    return { parent: cur, name, existed: cur.children.has(name) };
  }

  lookup(path: string): FsNode | null {
    const nav = this.navigate(path);
    if (!nav || nav.name === "") return nav ? nav.parent : null;
    return nav.parent.children.get(nav.name) ?? null;
  }

  mkdir(path: string): number {
    const nav = this.navigate(path);
    if (!nav) return wasiErrno.ENOTDIR;
    if (nav.name === "") return wasiErrno.EEXIST;
    if (nav.existed) return wasiErrno.EEXIST;
    nav.parent.children.set(nav.name, { kind: "dir", children: new Map() });
    return wasiErrno.ESUCCESS;
  }

  writeFile(path: string, content: string | Uint8Array): void {
    const data = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const nav = this.navigate(path);
    if (!nav) throw new Error(`VirtualFileSystem: parent of ${path} is not a directory`);
    if (nav.name === "") throw new Error(`VirtualFileSystem: refusing to write over root`);
    const existing = nav.parent.children.get(nav.name);
    if (existing && existing.kind === "file") {
      existing.data = data;
      return;
    }
    nav.parent.children.set(nav.name, { kind: "file", data, children: new Map() });
  }

  readFileBytes(path: string): Uint8Array | null {
    const node = this.lookup(path);
    if (!node || node.kind !== "file" || !node.data) return null;
    return node.data;
  }

  unlink(path: string, removeDir: boolean): number {
    const nav = this.navigate(path);
    if (!nav || nav.name === "") {
      return nav?.name === "" ? wasiErrno.EPERM : wasiErrno.ENOTDIR;
    }
    const node = nav.parent.children.get(nav.name);
    if (!node) return removeDir ? wasiErrno.ENOENT : wasiErrno.ENOENT;
    if (node.kind === "dir") {
      if (!removeDir) return wasiErrno.EISDIR;
      if (node.children.size > 0) return wasiErrno.ENOTEMPTY;
    } else if (removeDir) {
      return wasiErrno.ENOTDIR;
    }
    nav.parent.children.delete(nav.name);
    return wasiErrno.ESUCCESS;
  }

  /** Create (or truncate) a file at `path`, returning an errno on failure. */
  createFile(path: string): number {
    const nav = this.navigate(path);
    if (!nav || nav.name === "") return wasiErrno.ENOTDIR;
    const existing = nav.parent.children.get(nav.name);
    if (existing && existing.kind === "dir") return wasiErrno.EISDIR;
    nav.parent.children.set(nav.name, { kind: "file", data: new Uint8Array(0), children: new Map() });
    return wasiErrno.ESUCCESS;
  }

  rename(from: string, to: string): number {
    const src = this.navigate(from);
    const dst = this.navigate(to);
    if (!src || !dst || src.name === "" || dst.name === "") return wasiErrno.EPERM;
    const node = src.parent.children.get(src.name);
    if (!node) return wasiErrno.ENOENT;
    const dstExists = dst.parent.children.get(dst.name);
    if (dstExists && dstExists.kind === "dir" && dstExists.children.size > 0) {
      return wasiErrno.ENOTEMPTY;
    }
    src.parent.children.delete(src.name);
    dst.parent.children.set(dst.name, node);
    return wasiErrno.ESUCCESS;
  }
}

export interface WasiPreview1Options {
  args: string[];
  env?: Record<string, string>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

/** A WASI syscall implementation (arity varies per call). */
export type WasiImport = (...args: any[]) => unknown;

export class WasiPreview1 {
  exitCode = 0;
  exited = false;

  private fs: VirtualFileSystem;
  private options: WasiPreview1Options;
  private instance: WebAssembly.Instance | null = null;
  private fds = new Map<number, FdEntry>();
  private nextFd = 4; // attach() registers the cwd preopen as fd 3
  private preopens: PreopenSpec[] = [{ path: "/" }];
  private stdoutBuf = "";
  private stderrBuf = "";

  constructor(fs: VirtualFileSystem, options: WasiPreview1Options) {
    this.fs = fs;
    this.options = options;
    // Standard streams share the virtual file system root's view: they're managed
    // directly, not as fs nodes.
  }

  attach(instance: WebAssembly.Instance): void {
    this.instance = instance;
    // Register the preopen cwd as fd 3.
    const cwd: FsNode = this.fs.root;
    this.fds.set(3, {
      fd: 3,
      node: cwd,
      path: "/",
      pos: 0,
      dirFd: true,
      preopen: true,
      append: false,
      rights: wasiRights.PATH_OPEN | wasiRights.FD_READDIR | wasiRights.PATH_FILESTAT_GET,
    });
  }

  getFileSystem(): VirtualFileSystem {
    return this.fs;
  }

  /** Wipe all non-standard state so the next compilation starts clean. */
  resetFS(): void {
    for (const [fd, entry] of [...this.fds.entries()]) {
      if (entry.preopen) continue;
      this.fds.delete(fd);
    }
    this.stdoutBuf = "";
    this.stderrBuf = "";
    this.exitCode = 0;
    this.exited = false;
    // Fresh filesystem: drop everything except what callers re-create.
    this.fs.root.children.clear();
  }

  captureStdErr(): string {
    const s = this.stderrBuf;
    this.stderrBuf = "";
    return s;
  }

  private mem(): WasiMemory {
    if (!this.instance) throw new Error("WASIPreview1: instance not attached");
    const memory = this.instance.exports.memory as WebAssembly.Memory | undefined;
    if (!memory) throw new Error("WASIPreview1: guest has no exported memory");
    return memory;
  }

  private u8(): Uint8Array {
    return new Uint8Array(this.mem().buffer);
  }

  private view(): DataView {
    return new DataView(this.mem().buffer);
  }

  private readGuestStr(ptr: number, len: number): string {
    const bytes = this.u8().slice(ptr, ptr + len);
    return new TextDecoder().decode(bytes);
  }

  private writeGuestStr(ptr: number, str: string): void {
    const bytes = new TextEncoder().encode(str);
    this.u8().set(bytes, ptr);
  }

  private readIovec(ptr: number, count: number): Array<{ ptr: number; len: number }> {
    const view = this.view();
    const out: Array<{ ptr: number; len: number }> = [];
    for (let i = 0; i < count; i++) {
      const base = ptr + i * 8;
      out.push({ ptr: Number(view.getUint32(base, true)), len: Number(view.getUint32(base + 4, true)) });
    }
    return out;
  }

  private writeIoVecs(iovecs: Array<{ ptr: number; len: number }>, data: Uint8Array): number {
    const bytes = this.u8();
    let written = 0;
    for (const iovec of iovecs) {
      const n = Math.min(iovec.len, data.length - written);
      if (n <= 0) break;
      bytes.set(data.subarray(written, written + n), iovec.ptr);
      written += n;
    }
    return written;
  }

  private collectIoVecs(iovecs: Array<{ ptr: number; len: number }>): Uint8Array {
    const bytes = this.u8();
    let total = 0;
    for (const iovec of iovecs) total += iovec.len;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const iovec of iovecs) {
      out.set(bytes.slice(iovec.ptr, iovec.ptr + iovec.len), offset);
      offset += iovec.len;
    }
    return out;
  }

  /** 32-bit descriptor flags: append(1) | nonblocking(2) | sync(4) | dsync(8) | rsync(16) */
  private fdFlags(__fd: number): number {
    return 0;
  }

  private filestat(node: FsNode): {
    dev: bigint;
    ino: bigint;
    type: bigint;
    nlink: bigint;
    size: bigint;
    atim: bigint;
    mtim: bigint;
    ctim: bigint;
  } {
    if (node.kind === "dir") {
      return { dev: 1n, ino: 2n, type: 3n /* directory */, nlink: 1n, size: 0n, atim: 0n, mtim: 0n, ctim: 0n };
    }
    const size = BigInt(node.data?.length ?? 0);
    return { dev: 1n, ino: 1n, type: 2n /* regular file */, nlink: 1n, size, atim: 0n, mtim: 0n, ctim: 0n };
  }

  private writeFilestat(ptr: number, stat: ReturnType<WasiPreview1["filestat"]>): void {
    const view = this.view();
    let off = ptr;
    const put64 = (v: bigint): void => {
      view.setBigUint64(off, v, true);
      off += 8;
    };
    put64(stat.dev);
    put64(stat.ino);
    put64(stat.type);
    put64(stat.nlink);
    put64(stat.size);
    put64(stat.atim);
    put64(stat.mtim);
    put64(stat.ctim);
  }

  /** Full wasi_snapshot_preview1 import object for WebAssembly.instantiate. */
  imports(): Record<string, WasiImport> {
    const errno = wasiErrno;
    return {
      args_sizes_get: (outArgc: number, outArgvBufSize: number): number => {
        const args = this.options.args;
        let total = 0;
        for (const a of args) total += a.length + 1;
        const view = this.view();
        view.setUint32(outArgc, args.length, true);
        view.setUint32(outArgvBufSize, total, true);
        return errno.ESUCCESS;
      },
      args_get: (argvPtr: number, argvBufPtr: number): number => {
        const args = this.options.args;
        const view = this.view();
        let bufPtr = argvBufPtr;
        for (let i = 0; i < args.length; i++) {
          view.setUint32(argvPtr + i * 4, bufPtr, true);
          this.writeGuestStr(bufPtr, args[i]);
          bufPtr += args[i].length + 1;
        }
        return errno.ESUCCESS;
      },
      environ_sizes_get: (outCount: number, outBufSize: number): number => {
        const env = this.options.env ?? {};
        const entries = Object.entries(env).map(([k, v]) => `${k}=${v}`);
        let total = 0;
        for (const e of entries) total += e.length + 1;
        const view = this.view();
        view.setUint32(outCount, entries.length, true);
        view.setUint32(outBufSize, total, true);
        return errno.ESUCCESS;
      },
      environ_get: (envPtr: number, envBufPtr: number): number => {
        const env = this.options.env ?? {};
        const entries = Object.entries(env).map(([k, v]) => `${k}=${v}`);
        const view = this.view();
        let bufPtr = envBufPtr;
        for (let i = 0; i < entries.length; i++) {
          view.setUint32(envPtr + i * 4, bufPtr, true);
          this.writeGuestStr(bufPtr, entries[i]);
          bufPtr += entries[i].length + 1;
        }
        return errno.ESUCCESS;
      },
      clock_res_get: (_id: number, out: number): number => {
        this.view().setBigUint64(out, 1n, true);
        return errno.ESUCCESS;
      },
      clock_time_get: (_id: number, _precision: bigint, out: number): number => {
        this.view().setBigUint64(out, BigInt(Date.now()) * 1_000_000n, true);
        return errno.ESUCCESS;
      },
      random_get: (buf: number, len: number): number => {
        const bytes = this.u8();
        const arr = globalThis.crypto?.getRandomValues
          ? globalThis.crypto.getRandomValues(new Uint8Array(len))
          : fillRandomFallback(len);
        bytes.set(arr, buf);
        return errno.ESUCCESS;
      },
      proc_exit: (code: number): never => {
        this.exitCode = code;
        this.exited = true;
        throw new ProcExitCode(code);
      },
      sched_yield: (): number => errno.ESUCCESS,

      fd_close: (fd: number): number => {
        if (!this.fds.delete(fd)) return errno.EBADF;
        return errno.ESUCCESS;
      },
      fd_fdstat_get: (fd: number, out: number): number => {
        if (fd === 0 || fd === 1 || fd === 2) {
          // standard streams are character devices (type 1)
          const view = this.view();
          view.setUint8(out, 1);
          view.setUint8(out + 1, 0);
          view.setUint8(out + 2, 0);
          view.setBigUint64(out + 4, 0n, true);
          view.setBigUint64(out + 12, 0n, true);
          view.setUint16(out + 20, 0, true);
          return errno.ESUCCESS;
        }
        const entry = this.fds.get(fd);
        if (!entry) return errno.EBADF;
        const view = this.view();
        view.setUint8(out, entry.dirFd ? 3 : 2);
        view.setUint8(out + 1, 0);
        view.setUint8(out + 2, 0);
        view.setBigUint64(out + 4, entry.rights, true);
        view.setBigUint64(out + 12, entry.rights, true);
        view.setUint16(out + 20, this.fdFlags(fd), true);
        return errno.ESUCCESS;
      },
      fd_fdstat_set_flags: (__fd: number, __flags: number): number => errno.ESUCCESS,
      fd_fdstat_set_rights: (__fd: number, __rights: bigint, __base: bigint): number => errno.ESUCCESS,
      fd_sync: (__fd: number): number => errno.ESUCCESS,
      fd_datasync: (__fd: number): number => errno.ESUCCESS,
      fd_tell: (fd: number, outOffset: number): number => {
        const entry = this.fds.get(fd);
        if (!entry) return errno.EBADF;
        this.view().setBigUint64(outOffset, BigInt(entry.pos), true);
        return errno.ESUCCESS;
      },
      fd_seek: (fd: number, offset: bigint, whence: number, outNewOffset: number): number => {
        const entry = this.fds.get(fd);
        if (!entry) return errno.EBADF;
        if (entry.dirFd) return errno.EBADF;
        let base = 0;
        if (whence === 2) base = entry.node.data?.length ?? 0;
        if (whence === 1) base = entry.pos;
        let pos = base + Number(offset);
        if (pos < 0) pos = 0;
        entry.pos = pos;
        this.view().setBigUint64(outNewOffset, BigInt(pos), true);
        return errno.ESUCCESS;
      },
      fd_read: (fd: number, iovs: number, iovsLen: number, outNread: number): number => {
        const entry = this.fds.get(fd);
        if (!entry || entry.dirFd) return errno.EBADF;
        const iovecs = this.readIovec(iovs, iovsLen);
        const data = entry.node.data?.slice(entry.pos) ?? new Uint8Array(0);
        const written = this.writeIoVecs(iovecs, data);
        entry.pos += written;
        this.view().setUint32(outNread, written, true);
        return errno.ESUCCESS;
      },
      fd_pread: (fd: number, iovs: number, iovsLen: number, offset: bigint, outNread: number): number => {
        const entry = this.fds.get(fd);
        if (!entry || entry.dirFd) return errno.EBADF;
        const iovecs = this.readIovec(iovs, iovsLen);
        const data = entry.node.data?.slice(Number(offset)) ?? new Uint8Array(0);
        const written = this.writeIoVecs(iovecs, data);
        this.view().setUint32(outNread, written, true);
        return errno.ESUCCESS;
      },
      fd_write: (fd: number, iovs: number, iovsLen: number, outNwritten: number): number => {
        if (fd === 1 || fd === 2) {
          const iovecs = this.readIovec(iovs, iovsLen);
          const data = this.collectIoVecs(iovecs);
          const text = new TextDecoder().decode(data);
          if (fd === 2) this.stderrBuf += text;
          else this.stdoutBuf += text;
          this.options.stdout?.(text);
          this.view().setUint32(outNwritten, data.length, true);
          return errno.ESUCCESS;
        }
        const entry = this.fds.get(fd);
        if (!entry || entry.dirFd) return errno.EBADF;
        const iovecs = this.readIovec(iovs, iovsLen);
        const data = this.collectIoVecs(iovecs);
        const node = entry.node;
        if (!node.data) node.data = new Uint8Array(0);
        if (entry.append) {
          const merged = new Uint8Array(node.data.length + data.length);
          merged.set(node.data, 0);
          merged.set(data, node.data.length);
          node.data = merged;
        } else {
          const end = entry.pos + data.length;
          const merged = new Uint8Array(Math.max(end, node.data.length));
          merged.set(node.data, 0);
          merged.set(data, entry.pos);
          node.data = merged;
          entry.pos = end;
        }
        this.view().setUint32(outNwritten, data.length, true);
        return errno.ESUCCESS;
      },
      fd_pwrite: (fd: number, iovs: number, iovsLen: number, offset: bigint, outNwritten: number): number => {
        const entry = this.fds.get(fd);
        if (!entry || entry.dirFd) return errno.EBADF;
        const iovecs = this.readIovec(iovs, iovsLen);
        const data = this.collectIoVecs(iovecs);
        const node = entry.node;
        if (!node.data) node.data = new Uint8Array(0);
        const end = Number(offset) + data.length;
        const merged = new Uint8Array(Math.max(end, node.data.length));
        merged.set(node.data, 0);
        merged.set(data, Number(offset));
        node.data = merged;
        this.view().setUint32(outNwritten, data.length, true);
        return errno.ESUCCESS;
      },
      fd_filestat_get: (fd: number, out: number): number => {
        if (fd === 0 || fd === 1 || fd === 2) {
          this.writeFilestat(out, {
            dev: 0n,
            ino: BigInt(fd),
            type: 2n,
            nlink: 1n,
            size: 0n,
            atim: 0n,
            mtim: 0n,
            ctim: 0n,
          });
          return errno.ESUCCESS;
        }
        const entry = this.fds.get(fd);
        if (!entry) return errno.EBADF;
        this.writeFilestat(out, this.filestat(entry.node));
        return errno.ESUCCESS;
      },
      fd_filestat_set_size: (fd: number, size: bigint): number => {
        const entry = this.fds.get(fd);
        if (!entry || entry.dirFd) return errno.EBADF;
        const data = entry.node.data ?? new Uint8Array(0);
        if (size < BigInt(data.length)) {
          entry.node.data = data.slice(0, Number(size));
        } else {
          const bigger = new Uint8Array(Number(size));
          bigger.set(data, 0);
          entry.node.data = bigger;
        }
        return errno.ESUCCESS;
      },
      fd_filestat_set_times: (__fd: number, __atim: bigint, __mtim: bigint, __flags: number): number => errno.ESUCCESS,
      fd_readdir: (fd: number, buf: number, bufLen: number, cookie: bigint, outUsed: number): number => {
        const entry = this.fds.get(fd);
        if (!entry || !entry.dirFd) return errno.EBADF;
        const entries = [...entry.node.children.entries()];
        const start = Number(cookie);
        const bytes = this.u8();
        const view = this.view();
        let written = 0;
        // dirent: d_next(8) d_ino(8) d_namlen(4) d_type(1) + padding -> name
        for (let i = start; i < entries.length; i++) {
          const [name, node] = entries[i];
          const nameBytes = new TextEncoder().encode(name);
          const drec = 24;
          if (written + drec + nameBytes.length > bufLen) break;
          const base = buf + written;
          view.setBigUint64(base, BigInt(i + 1), true); // d_next
          view.setBigUint64(base + 8, 1n, true); // d_ino
          view.setUint32(base + 16, nameBytes.length, true); // d_namlen
          view.setUint8(base + 20, node.kind === "dir" ? 3 : 2); // d_type
          bytes.set(nameBytes, base + 24);
          written += drec + nameBytes.length;
        }
        view.setUint32(outUsed, written, true);
        return errno.ESUCCESS;
      },
      fd_renumber: (from: number, to: number): number => {
        const entry = this.fds.get(from);
        if (!entry) return errno.EBADF;
        this.fds.delete(to);
        entry.fd = to;
        this.fds.set(to, entry);
        this.fds.delete(from);
        return errno.ESUCCESS;
      },
      fd_prestat_get: (fd: number, out: number): number => {
        const entry = this.fds.get(fd);
        if (!entry || !entry.preopen) return errno.EBADF;
        const view = this.view();
        view.setUint8(out, 0); // tag: dir
        const name = this.preopens.find((p) => p.path === entry.path)?.path ?? entry.path;
        view.setUint32(out + 4, name.length, true);
        return errno.ESUCCESS;
      },
      fd_prestat_dir_name: (fd: number, pathBuf: number, pathLen: number): number => {
        const entry = this.fds.get(fd);
        if (!entry || !entry.preopen) return errno.EBADF;
        const name = this.preopens.find((p) => p.path === entry.path)?.path ?? entry.path;
        if (name.length > pathLen) return errno.ENAMETOOLONG;
        this.writeGuestStr(pathBuf, name);
        return errno.ESUCCESS;
      },
      path_create_directory: (fd: number, pathPtr: number, pathLen: number): number => {
        const entry = this.fds.get(fd);
        if (!entry) return errno.EBADF;
        const rel =
          entry.path === "/"
            ? this.readGuestStr(pathPtr, pathLen)
            : `${entry.path}/${this.readGuestStr(pathPtr, pathLen)}`;
        return this.fs.mkdir(rel);
      },
      path_unlink_file: (fd: number, pathPtr: number, pathLen: number): number => {
        const entry = this.fds.get(fd);
        if (!entry) return errno.EBADF;
        const rel =
          entry.path === "/"
            ? this.readGuestStr(pathPtr, pathLen)
            : `${entry.path}/${this.readGuestStr(pathPtr, pathLen)}`;
        return this.fs.unlink(rel, false);
      },
      path_remove_directory: (fd: number, pathPtr: number, pathLen: number): number => {
        const entry = this.fds.get(fd);
        if (!entry) return errno.EBADF;
        const rel =
          entry.path === "/"
            ? this.readGuestStr(pathPtr, pathLen)
            : `${entry.path}/${this.readGuestStr(pathPtr, pathLen)}`;
        return this.fs.unlink(rel, true);
      },
      path_rename: (
        oldFd: number,
        oldPtr: number,
        oldLen: number,
        newFd: number,
        newPtr: number,
        newLen: number,
      ): number => {
        const oldEntry = this.fds.get(oldFd);
        const newEntry = this.fds.get(newFd);
        if (!oldEntry || !newEntry) return errno.EBADF;
        const from =
          oldEntry.path === "/"
            ? this.readGuestStr(oldPtr, oldLen)
            : `${oldEntry.path}/${this.readGuestStr(oldPtr, oldLen)}`;
        const to =
          newEntry.path === "/"
            ? this.readGuestStr(newPtr, newLen)
            : `${newEntry.path}/${this.readGuestStr(newPtr, newLen)}`;
        return this.fs.rename(from, to);
      },
      path_filestat_get: (fd: number, _flags: number, pathPtr: number, pathLen: number, out: number): number => {
        const entry = this.fds.get(fd);
        if (!entry) return errno.EBADF;
        const rel =
          entry.path === "/"
            ? this.readGuestStr(pathPtr, pathLen)
            : `${entry.path}/${this.readGuestStr(pathPtr, pathLen)}`;
        const node = this.fs.lookup(rel);
        if (!node) return errno.ENOENT;
        this.writeFilestat(out, this.filestat(node));
        return errno.ESUCCESS;
      },
      path_open: (
        dirFd: number,
        dirFlags: number,
        pathPtr: number,
        pathLen: number,
        oflags: number,
        rightsBase: bigint,
        _rightsInheriting: bigint,
        fdFlags: number,
        outFd: number,
      ): number => {
        const entry = this.fds.get(dirFd);
        if (!entry || !entry.dirFd) return errno.EBADF;
        const rel =
          entry.path === "/"
            ? this.readGuestStr(pathPtr, pathLen)
            : `${entry.path}/${this.readGuestStr(pathPtr, pathLen)}`;
        let node = this.fs.lookup(rel);
        const oflagsCreate = oflags & 1;
        const oflagsDirectory = oflags & 2;
        const oflagsExcl = oflags & 4;
        if (oflagsDirectory === 0 && oflagsCreate !== 0) {
          if (!node) {
            const rc = this.fs.createFile(rel);
            if (rc !== errno.ESUCCESS) return rc;
            node = this.fs.lookup(rel);
          } else if (oflagsExcl) {
            return errno.EEXIST;
          }
        } else if (oflagsCreate !== 0 && !node) {
          const rc = this.fs.mkdir(rel);
          if (rc !== errno.ESUCCESS && rc !== errno.EEXIST) return rc;
          node = this.fs.lookup(rel);
        }
        if (!node) return errno.ENOENT;
        if (oflagsDirectory !== 0 && node.kind !== "dir") return errno.ENOTDIR;
        const fd = this.nextFd++;
        const isDir = node.kind === "dir";
        this.fds.set(fd, {
          fd,
          node,
          path: rel,
          pos: 0,
          dirFd: isDir,
          preopen: false,
          append: (fdFlags & 1) !== 0,
          rights: rightsBase,
        });
        this.view().setUint32(outFd, fd, true);
        return errno.ESUCCESS;
      },
      path_readlink: (
        __fd: number,
        __pathPtr: number,
        __pathLen: number,
        __buf: number,
        __bufLen: number,
        __outUsed: number,
      ): number => errno.ENOSYS,
      path_symlink: (__oldPtr: number, __oldLen: number, __fd: number, __newPtr: number, __newLen: number): number =>
        errno.ENOSYS,
      path_link: (): number => errno.ENOSYS,
      poll_oneoff: (inPtr: number, outPtr: number, nSubscriptions: number, outNevents: number): number => {
        // Only used in practice to block on timeouts; treat everything as ready.
        const view = this.view();
        for (let i = 0; i < nSubscriptions; i++) {
          const base = inPtr + i * 48;
          const userdata = view.getBigUint64(base, true);
          const type = view.getUint8(base + 8);
          const ret = outPtr + i * 32;
          view.setBigUint64(ret, userdata, true);
          view.setUint16(ret + 8, errno.ESUCCESS, true);
          view.setUint8(ret + 10, type);
          view.setUint16(ret + 11, 0, true);
          view.setUint32(ret + 16, 0, true);
          view.setUint32(ret + 20, 0, true);
        }
        view.setUint32(outNevents, nSubscriptions, true);
        return errno.ESUCCESS;
      },
      sock_accept: (): number => errno.ENOSYS,
      sock_recv: (): number => errno.ENOSYS,
      sock_send: (): number => errno.ENOSYS,
      sock_shutdown: (): number => errno.ENOSYS,
    };
  }
}

/** Thrown internally when the guest calls proc_exit. */
export class ProcExitCode extends Error {
  constructor(public readonly code: number) {
    super(`wasi proc_exit(${code})`);
  }
}

function fillRandomFallback(len: number): Uint8Array {
  const out = new Uint8Array(len);
  // Deterministic stand-in only used when crypto is unavailable (tests).
  let seed = 0x2f6e2b1;
  for (let i = 0; i < len; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = seed & 0xff;
  }
  return out;
}
