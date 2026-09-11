"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function sourceRevision(root) {
  const git = (args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true, maxBuffer: 2 * 1024 * 1024 }).trim();
  const commit = git(["rev-parse", "HEAD"]);
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Cannot establish adapter source revision.");
  const changes = git(["status", "--porcelain", "--untracked-files=all"]).split(/\r?\n/).filter(Boolean);
  return { commit, dirty: changes.length > 0, changes };
}

function argumentsFor(argv, names, flags = []) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "");
    if (!argv[i].startsWith("--") || Object.hasOwn(result, key)) throw new Error("Unknown or duplicate argument: " + argv[i]);
    if (flags.includes(key)) result[key] = true;
    else if (names.includes(key) && argv[i + 1] && !argv[i + 1].startsWith("--")) result[key] = argv[++i];
    else throw new Error("Unknown argument or missing value: " + argv[i]);
  }
  return result;
}

function writeJSON(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}

function emptyOutput(value) {
  if (!value) throw new Error("An explicit --output directory is required.");
  const output = path.resolve(value);
  if (fs.existsSync(output) && fs.readdirSync(output).length) throw new Error("Release output must be empty.");
  return output;
}

module.exports = { sourceRevision, argumentsFor, writeJSON, emptyOutput };
