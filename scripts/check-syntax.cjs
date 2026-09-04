"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const generatedDirectories = new Set([
  ".build",
  ".git",
  ".swiftpm",
  "dist",
  "node_modules",
  "release",
  "runtime",
]);

function checkDirectory(directoryPath) {
  for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
    const file = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      if (!generatedDirectories.has(entry.name)) checkDirectory(file);
      continue;
    }
    if (!entry.isFile() || !/\.(?:cjs|mjs)$/u.test(entry.name) || file === __filename) {
      continue;
    }
    execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
  }
}

for (const directory of [
  "core",
  "examples",
  "internal",
  "main",
  "native",
  "platform",
  "preload",
  "scripts",
]) {
  const directoryPath = path.join(root, directory);
  if (!fs.existsSync(directoryPath)) continue;
  checkDirectory(directoryPath);
}
