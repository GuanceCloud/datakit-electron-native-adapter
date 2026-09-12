"use strict";

function packWindows() {
  throw new Error("pack:windows is retired. Use pack:release for the JavaScript installer package; SDK repositories own native assets.");
}
if (require.main === module) { console.error("pack:windows is retired; use pack:release."); process.exitCode = 1; }
module.exports = { packWindows };
