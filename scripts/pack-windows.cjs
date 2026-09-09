"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { npm } = require("./npm-command.cjs");
const { PACKAGE_NAME, RUNTIME_FILES, validateRuntime } = require("../platform/win32/runtime.cjs");

async function packWindows({ runtime, version, output, allowDirty = false }) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version || "")) {
    throw new Error("Provide an explicit npm --version (for example 0.0.0-local.1). No release version is selected automatically.");
  }
  if (!runtime || !output) throw new Error("--runtime and --output are required.");
  const root = path.resolve(__dirname, "..");
  const source = path.resolve(runtime);
  const manifest = validateRuntime(source);
  if (manifest.source.dirty && !allowDirty) throw new Error("Dirty native source requires --allow-dirty for local packs.");
  const destination = path.resolve(output);
  if (fs.existsSync(destination) && fs.readdirSync(destination).length) throw new Error("Pack output must be empty.");
  const mainDirectory = path.join(destination, "main");
  const platformDirectory = path.join(destination, "win32-x64");
  fs.mkdirSync(mainDirectory, { recursive: true });
  fs.mkdirSync(path.join(platformDirectory, "runtime"), { recursive: true });
  const main = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  main.version = version;
  delete main.private;
  delete main.scripts;
  // The declared GitHub mirror is not a verified publication source.
  delete main.repository;
  main.optionalDependencies = { [PACKAGE_NAME]: version };
  for (const group of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const spec of Object.values(main[group] || {})) {
      if (/^(?:file:|link:|[A-Za-z]:|[\\/]|\.{1,2}[\\/])/.test(spec)) throw new Error("Local dependency in publish manifest.");
    }
  }
  for (const name of [...main.files, "LICENSE"]) {
    fs.cpSync(path.join(root, name), path.join(mainDirectory, name), {
      recursive: true, filter: (file) => !["node_modules", ".build", "runtime", ".DS_Store"].includes(path.basename(file)),
    });
  }
  fs.writeFileSync(path.join(mainDirectory, "package.json"), JSON.stringify(main, null, 2) + "\n");
  const platform = JSON.parse(fs.readFileSync(path.join(root, "packages/win32-x64/package.json"), "utf8"));
  platform.version = version;
  delete platform.private;
  for (const name of RUNTIME_FILES) fs.copyFileSync(path.join(source, name), path.join(platformDirectory, "runtime", name));
  manifest.npmPackageVersion = version;
  fs.writeFileSync(path.join(platformDirectory, "runtime/runtime-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  fs.copyFileSync(path.join(source, "LICENSE"), path.join(platformDirectory, "LICENSE"));
  fs.copyFileSync(path.join(root, "packages/win32-x64/README.md"), path.join(platformDirectory, "README.md"));
  fs.writeFileSync(path.join(platformDirectory, "package.json"), JSON.stringify(platform, null, 2) + "\n");
  validateRuntime(path.join(platformDirectory, "runtime"), { version });
  const platformPack = JSON.parse(await npm(["pack", "--json", "--ignore-scripts", "--pack-destination", destination], platformDirectory))[0];
  const allowed = ["package.json", "README.md", "LICENSE", ...RUNTIME_FILES.map((name) => `runtime/${name}`), "runtime/runtime-manifest.json"].sort();
  if (JSON.stringify(platformPack.files.map((file) => file.path).sort()) !== JSON.stringify(allowed)) throw new Error("Unexpected platform tarball contents.");
  const mainPack = JSON.parse(await npm(["pack", "--json", "--ignore-scripts", "--pack-destination", destination], mainDirectory))[0];
  const result = { version, nativeSource: manifest.source, platform: platformPack, main: mainPack };
  fs.writeFileSync(path.join(destination, "pack-report.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ version, platform: path.join(destination, platformPack.filename), main: path.join(destination, mainPack.filename) }, null, 2));
  return result;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const value = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  packWindows({ runtime: value("--runtime"), version: value("--version"), output: value("--output"), allowDirty: args.includes("--allow-dirty") })
    .catch((error) => { console.error(error); process.exitCode = 1; });
}
module.exports = { packWindows };
