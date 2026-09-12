"use strict";

async function publishWindows() {
  throw new Error("publish:windows is retired. Use publish:release with GitHub Release Assets.");
}
if (require.main === module) { console.error("publish:windows is retired; use publish:release."); process.exitCode = 1; }
module.exports = { publishWindows };
