/**
 * Monaco language support for `.zig` scripts.
 *
 * Registers the "zig" language (contribution style, via a `loader` — the same
 * mechanism the repo's `@types/global.d.ts` augmentation expects) and provides a
 * Monarch tokenizer. Highlights `ns` (the Bitburner prelude injected at compile
 * time) plus every API function defined in `zigApiDefs`, reusing the existing
 * theme token names (`ns`, `netscriptfunction`, `keyword`, ...) so colors match
 * the JS editor, mirroring how the JS editor unshifts `ns` / api-key regexes
 * into its tokenizer.
 *
 * This module must only be imported from the script editor (it pulls in
 * `monaco-editor`).
 */
import * as monaco from "monaco-editor";
import { zigApiDefs } from "./zigApiDefs";

let registered = false;

/** Build the Monarch language definition for Zig. */
function buildZigMonarchLanguage(): monaco.languages.IMonarchLanguage {
  const keywords = [
    "addrspace",
    "align",
    "allowzero",
    "and",
    "anyframe",
    "anytype",
    "asm",
    "async",
    "await",
    "break",
    "callconv",
    "catch",
    "comptime",
    "const",
    "continue",
    "defer",
    "else",
    "enum",
    "errdefer",
    "error",
    "export",
    "extern",
    "fn",
    "for",
    "if",
    "inline",
    "linksection",
    "noalias",
    "noinline",
    "nosuspend",
    "opaque",
    "or",
    "orelse",
    "packed",
    "pub",
    "resume",
    "return",
    "struct",
    "suspend",
    "switch",
    "test",
    "threadlocal",
    "try",
    "union",
    "unreachable",
    "usingnamespace",
    "var",
    "volatile",
    "while",
  ];
  const typeKeywords = [
    "bool",
    "void",
    "noreturn",
    "type",
    "anyerror",
    "comptime_int",
    "comptime_float",
    "f16",
    "f32",
    "f64",
    "f80",
    "f128",
    "i8",
    "i16",
    "i32",
    "i64",
    "i128",
    "isize",
    "u8",
    "u16",
    "u32",
    "u64",
    "u128",
    "usize",
    "c_char",
    "c_short",
    "c_int",
    "c_long",
    "c_longlong",
    "c_uint",
    "c_ulong",
    "c_ulonglong",
    "c_longdouble",
  ];
  const builtins = [
    "as",
    "addWithOverflow",
    "alignCast",
    "alignOf",
    "alignOfExtended",
    "asyncCall",
    "bitCast",
    "bitOffsetOf",
    "bitSizeOf",
    "branchHint",
    "breakpoint",
    "byteSwap",
    "call",
    "cDefine",
    "cImport",
    "cInclude",
    "cUndef",
    "compileError",
    "compileLog",
    "constCast",
    "errorName",
    "errorReturnTrace",
    "errorToInt",
    "errSetCast",
    "exportDecl",
    "exportSymbol",
    "externDecl",
    "field",
    "fieldOffset",
    "fieldParentPtr",
    "fieldType",
    "floatCast",
    "floatFromInt",
    "frame",
    "frameAddress",
    "frameSize",
    "hasDecl",
    "hasField",
    "hasPointerAuth",
    "import",
    "inComptime",
    "intCast",
    "intFromBool",
    "intFromEnum",
    "intFromError",
    "intFromFloat",
    "intFromPtr",
    "intToEnum",
    "intToError",
    "intToFloat",
    "intToPtr",
    "intType",
    "max",
    "memcpy",
    "memset",
    "min",
    "mulAdd",
    "mulWithOverflow",
    "offsetOf",
    "panic",
    "prefetch",
    "ptrCast",
    "ptrFromInt",
    "reflect",
    "remap",
    "returnAddress",
    "select",
    "setAlignStack",
    "setCold",
    "setEvalBranchQuota",
    "setFloatMode",
    "setIntMode",
    "setRuntimeSafety",
    "setVectorLength",
    "shlExact",
    "shlWithOverflow",
    "shrExact",
    "shuffle",
    "sizeOf",
    "splat",
    "subWithOverflow",
    "tagName",
    "This",
    "trap",
    "truncate",
    "Type",
    "typeInfo",
    "typeName",
    "TypeOf",
    "unionInit",
    "Vector",
    "volatileCast",
    "wasmMemoryGrow",
    "wasmMemorySize",
    "wasmMemoryType",
    "workItemId",
    "workGroupSize",
    "workGroupUniformArrayCopy",
  ];

  const apiFunctionNames = Array.from(new Set(zigApiDefs.map((def) => def.zigName)));
  // Escape regex-special characters (names are plain identifiers, but be safe).
  const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const apiFunctionRegex = `\\b(${apiFunctionNames.map(escapeRe).join("|")})\\b`;
  const keywordRegex = `\\b(${keywords.join("|")})\\b`;
  const typeRegex = `\\b(${typeKeywords.join("|")})\\b`;
  const builtinRegex = `\\b@(${builtins.join("|")})\\b`;

  return {
    defaultToken: "",
    tokenPostfix: ".zig",
    ignoreCase: false,

    tokenizer: {
      root: [
        // ── ns prelude + API calls: `ns.hack(host)` ──────────────────────
        [/\bns\b/, "ns"],
        [apiFunctionRegex, "netscriptfunction"],

        // ── comments ─────────────────────────────────────────────────────
        [/\/\/![^\n]*/, "comment"],
        [/\/\/\/[^\n]*/, "comment"],
        [/\/\/[^\n]*/, "comment"],
        // Zig block comments nest; best-effort support.
        [/\/\*/, { token: "comment.quote", next: "@comment" }],

        // ── strings & chars ──────────────────────────────────────────────
        [/'"([^'"\\]|\\.)*'"/, "string"],
        [/'([^'\\]|\\.)*'/, "string"],
        [/"/, { token: "string.quote", bracket: "@open", next: "@string" }],

        // ── numbers (incl. hex/binary/octal, underscores, floats) ────────
        [/0[xX][0-9a-fA-F_]+/, "number"],
        [/0[bB][01_]+/, "number"],
        [/0[oO][0-7_]+/, "number"],
        [/[0-9][0-9_]*(\.[0-9_]+)?([eE][+-]?[0-9_]+)?/, "number"],

        // ── builtins & types & keywords ──────────────────────────────────
        [builtinRegex, "type.identifier"],
        [/@[a-zA-Z_][a-zA-Z0-9_]*\b/, "type.identifier"],
        [keywordRegex, "keyword"],
        [typeRegex, "type"],

        [/[{}()[\]]/, "delimiter"],
        [/[<>=!~%&|^+\-*?.,;:@]+/, "delimiter"],
        [/[a-zA-Z_][a-zA-Z0-9_]*/, "identifier"],

        [/[ \t\r\n]+/, "white"],
      ],

      comment: [
        [/[^/*]+/, "comment"],
        [/\/\*/, { token: "comment.quote", next: "@comment" }],
        [/\*\//, { token: "comment.quote", next: "@pop" }],
        [/[/*]/, "comment"],
      ],

      string: [
        [/[^\\"]+/, "string"],
        [/\\./, "string.escape"],
        [/"/, { token: "string.quote", bracket: "@close", next: "@pop" }],
      ],
    },
  };
}

export function registerZigLanguage(): void {
  if (registered) return;
  registered = true;

  const monarch = buildZigMonarchLanguage();
  monaco.languages.register({
    id: "zig",
    extensions: [".zig"],
    aliases: ["zig"],
    // The loader's return type (see @types/global.d.ts) only requires
    // `language.tokenizer.root`; IMonarchLanguage types the tokenizer as a
    // generic rule map, so a cast is needed to satisfy that structural shape.
    loader: () => Promise.resolve({ language: monarch as unknown as { tokenizer: { root: any[] } } }),
  });

  monaco.languages.setLanguageConfiguration("zig", {
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
  });
}
