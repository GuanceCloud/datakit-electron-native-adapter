"use strict";

async function verify() {
  throw new Error("verify:windows:tarballs is retired. Use verify:release -- --directory <pack-output> on Windows and macOS.");
}
if (require.main === module) { console.error("Use npm run verify:release -- --directory <pack-output>."); process.exitCode = 1; }
module.exports = { verify };
