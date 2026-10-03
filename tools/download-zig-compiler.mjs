#!/usr/bin/env node
/**
 * Downloads a self-contained wasm32-wasi Zig compiler binary for the in-browser
 * compile pipeline and prints the build-time configuration to use.
 *
 * Usage:
 *   node tools/download-zig-compiler.mjs <url> [--out dist/zig/zig.wasm]
 *   ZIG_COMPILER_WASM_URL=<url> node tools/download-zig-compiler.mjs
 *
 * The downloaded file is a plain wasm binary (a wasm32-wasi `zig` executable)
 * that the game instantiates inside its WASI preview1 shim
 * (src/Zig/WasiPreview1.ts) and drives via `_start` to compile player scripts.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const url = process.argv[2] ?? process.env.ZIG_COMPILER_WASM_URL;
if (!url) {
  console.error("usage: node tools/download-zig-compiler.mjs <url> [--out dist/zig/zig.wasm]");
  process.exit(1);
}

const outArgIndex = process.argv.indexOf("--out");
const outPath = resolve(outArgIndex !== -1 ? process.argv[outArgIndex + 1] : "dist/zig/zig.wasm");

const response = await fetch(url);
if (!response.ok) {
  console.error(`download failed: HTTP ${response.status} from ${url}`);
  process.exit(1);
}
const bytes = new Uint8Array(await response.arrayBuffer());

// Wasm binaries start with the 0x00 0x61 0x73 0x6D magic ("\0asm").
if (bytes.length < 4 || bytes[0] !== 0 || bytes[1] !== 97 || bytes[2] !== 115 || bytes[3] !== 109) {
  console.error(`downloaded file is not a WebAssembly module (${bytes.length} bytes)`);
  process.exit(1);
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, bytes);

console.log(`saved ${bytes.length} bytes to ${outPath}`);
console.log("");
console.log("Build the game with the in-browser compiler enabled:");
console.log("  ZIG_COMPILER_URL=/zig/zig.wasm npm run build");
console.log("and serve dist/zig/zig.wasm at that path (e.g. copy dist into .app).");
