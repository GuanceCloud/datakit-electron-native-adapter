"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { npm } = require("./npm-command.cjs");
const { RUNTIME_FILES, RUNTIME_SUBDIRECTORY, validateRuntime } = require("../platform/win32/runtime.cjs");
const { validatePackageMetadata } = require("./release-artifact.cjs");

function adapterSource(root) {
  const git = (args) => execFileSync("git", ["-c", "safe.directory=" + root, "-C", root, ...args],
    { encoding: "utf8", windowsHide: true, maxBuffer: 2 * 1024 * 1024 }).trim();
  const commit = git(["rev-parse", "HEAD"]);
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Cannot establish adapter source revision.");
  const changes = git(["status", "--porcelain", "--untracked-files=all"]).split(/\r?\n/).filter(Boolean);
  return { repository: "ft-sdk-electron-native-adapter", commit, dirty: changes.length > 0, changes };
}

async function packWindows({ runtime, version, output, allowDirty = false }) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version || "")) {
    throw new Error("Provide an explicit npm --version (for example 0.0.0-local.2). No release version is selected automatically.");
  }
  if (!runtime || !output) throw new Error("--runtime and --output are required.");
  const root = path.resolve(__dirname, "..");
  const source = path.resolve(runtime);
  const manifest = validateRuntime(source);
  const adapter = adapterSource(root);
  if ((manifest.source.dirty || adapter.dirty) && !allowDirty) {
    throw new Error("Dirty native or adapter source requires --allow-dirty for local packs.");
  }
  const destination = path.resolve(output);
  if (fs.existsSync(destination) && fs.readdirSync(destination).length) throw new Error("Pack output must be empty.");
  const mainDirectory = path.join(destination, "main");
  const nativeDirectory = path.join(mainDirectory, RUNTIME_SUBDIRECTORY);
  const main = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  main.version = version;
  delete main.private;
  delete main.scripts;
  // The declared GitHub mirror is not a verified publication source.
  delete main.repository;
  validatePackageMetadata(main, version);
  fs.mkdirSync(nativeDirectory, { recursive: true });
  for (const name of [...main.files, "LICENSE"]) {
    if (name === RUNTIME_SUBDIRECTORY) continue; // Always use the audited export, never a stale checkout binary.
    fs.cpSync(path.join(root, name), path.join(mainDirectory, name), {
      recursive: true, filter: (file) => !["node_modules", ".build", "runtime", ".DS_Store"].includes(path.basename(file)),
    });
  }
  for (const name of [...RUNTIME_FILES, "LICENSE"]) {
    fs.copyFileSync(path.join(source, name), path.join(nativeDirectory, name));
  }
  manifest.npmPackageVersion = version;
  fs.writeFileSync(path.join(nativeDirectory, "runtime-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  fs.writeFileSync(path.join(mainDirectory, "package.json"), JSON.stringify(main, null, 2) + "\n");
  validateRuntime(nativeDirectory, { version });
  const packed = JSON.parse(await npm(["pack", "--json", "--ignore-scripts", "--pack-destination", destination], mainDirectory))[0];
  const allowedNative = [...RUNTIME_FILES, "LICENSE", "runtime-manifest.json"].map((name) => RUNTIME_SUBDIRECTORY + "/" + name).sort();
  const actualNative = packed.files.map((file) => file.path).filter((name) => name.startsWith(RUNTIME_SUBDIRECTORY + "/")).sort();
  if (JSON.stringify(actualNative) !== JSON.stringify(allowedNative)) throw new Error("Unexpected bundled runtime tarball contents.");
  if (packed.files.some((file) => /\.pdb$/i.test(file.path) || file.path.startsWith("packages/"))) {
    throw new Error("Unexpected native build or former platform package files in tarball.");
  }
  const report = { schemaVersion: 2, distribution: "single-package", version, adapterSource: adapter, nativeSource: manifest.source, package: packed };
  fs.writeFileSync(path.join(destination, "pack-report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ version, tarball: path.join(destination, packed.filename) }, null, 2));
  return report;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const value = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  packWindows({ runtime: value("--runtime"), version: value("--version"), output: value("--output"), allowDirty: args.includes("--allow-dirty") })
    .catch((error) => { console.error(error); process.exitCode = 1; });
}
module.exports = { packWindows };
