"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
for (const directory of ["core", "internal", "main", "platform", "preload", "scripts"]) {
  const directoryPath = path.join(root, directory);
  if (!fs.existsSync(directoryPath)) continue;
  for (const entry of fs.readdirSync(directoryPath, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".cjs")) continue;
    const file = path.join(entry.parentPath, entry.name);
    if (file === __filename) continue;
    execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
  }
}
