// Returns the *actual* content of src/Zig/bitburner.zig for `?raw` imports.
// The generic ".*?raw$" -> fileMock.js mapping would return "test-file-stub",
// which is useless for tests that feed the Zig API layer to a compiler.
// This is a CommonJS mock; eslint's no-var-requires / no-undef rules are not
// useful here since jest requires module mocks through Node's require().
/* eslint-disable @typescript-eslint/no-var-requires, no-undef */
const fs = require("fs");
const path = require("path");

module.exports = fs.readFileSync(path.join(process.cwd(), "src/Zig/bitburner.zig"), "utf8");
