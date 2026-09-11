"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { npm } = require("./npm-command.cjs");
const { sourceRevision, argumentsFor, writeJSON, emptyOutput } = require("./release-common.cjs");
const { validatePackageMetadata, validVersion } = require("./github-release-artifact.cjs");
const { validateDefaults } = require("../runtime/config.cjs");

async function packRelease({ version, output, allowDirty = false, pipelineOnly = false, macosSdkVersion, windowsSdkVersion, windowsAssetName, root = path.resolve(__dirname, "..") }) {
  if (!validVersion(version)) throw new Error("Provide an explicit valid --version.");
  const adapterSource = sourceRevision(root);
  if (adapterSource.dirty && !allowDirty) throw new Error("Dirty adapter sources require --allow-dirty for local validation only.");
  const destination = emptyOutput(output);
  const metadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  metadata.version = version;
  delete metadata.private;
  metadata.scripts = { postinstall: "node runtime/postinstall.cjs" };
  const targets = { ...(metadata.nativeRuntime?.targets || {}) };
  if (macosSdkVersion) targets["darwin-universal"] = { sdkVersion: macosSdkVersion };
  if (windowsSdkVersion || windowsAssetName) targets["win32-x64"] = { sdkVersion: windowsSdkVersion, assetName: windowsAssetName };
  metadata.nativeRuntime = validateDefaults({ schemaVersion: 1, pipelineOnly, targets }, version);
  validatePackageMetadata(metadata, version);
  const main = path.join(destination, "main");
  fs.mkdirSync(main, { recursive: true });
  for (const name of [...metadata.files, "LICENSE"]) {
    fs.cpSync(path.join(root, name), path.join(main, name), {
      recursive: true, filter: (file) => !["node_modules", ".build", ".DS_Store"].includes(path.basename(file)),
    });
  }
  writeJSON(path.join(main, "package.json"), metadata);
  const packed = JSON.parse(await npm(["pack", "--json", "--ignore-scripts", "--pack-destination", destination], main))[0];
  if (packed.files.some((file) => /\.(?:exe|dll|node|pdb|tar\.gz|tgz)$/i.test(file.path))) {
    throw new Error("Native binaries or archives must not enter the npm tarball.");
  }
  const report = { schemaVersion: 5, distribution: "sdk-release-installers", version, adapterSource, package: packed };
  writeJSON(path.join(destination, "pack-report.json"), report);
  console.log(JSON.stringify({ version, tarball: path.join(destination, packed.filename) }, null, 2));
  return report;
}
if (require.main === module) {
  try {
    const args = argumentsFor(process.argv.slice(2), ["version", "output", "macos-sdk-version", "windows-sdk-version", "windows-asset-name"], ["allow-dirty", "pipeline-only"]);
    packRelease({ ...args, allowDirty: args["allow-dirty"], pipelineOnly: args["pipeline-only"], macosSdkVersion: args["macos-sdk-version"], windowsSdkVersion: args["windows-sdk-version"], windowsAssetName: args["windows-asset-name"] }).catch((error) => { console.error(error.message); process.exitCode = 1; });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { packRelease };
