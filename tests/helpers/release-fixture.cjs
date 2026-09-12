"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { collectFiles, createArchive } = require("../../runtime/archive.cjs");
const VERSION = "0.1.0-alpha.1";
const ROOT = path.resolve(__dirname, "../..");
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-package-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const main = path.join(root, "main");
  fs.mkdirSync(main);
  const metadata = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  delete metadata.private;
  metadata.scripts = { postinstall: "node runtime/postinstall.cjs" };
  metadata.nativeRuntime = { schemaVersion: 1, pipelineOnly: true, targets: {} };
  metadata.version = VERSION;
  for (const name of [...metadata.files, "LICENSE"]) {
    fs.cpSync(path.join(ROOT, name), path.join(main, name), { recursive: true });
  }
  json(path.join(main, "package.json"), metadata);
  const tarball = path.join(root, "synthetic-adapter.tgz");
  const report = { schemaVersion: 5, distribution: "sdk-release-installers", version: VERSION,
    adapterSource: { commit: "b".repeat(40), dirty: false },
    package: { name: metadata.name, version: VERSION, filename: path.basename(tarball) } };
  function repack() {
    const bytes = createArchive(collectFiles(main).map((file) => ({ ...file, name: "package/" + file.name })));
    fs.writeFileSync(tarball, bytes);
    report.package.integrity = "sha512-" + crypto.createHash("sha512").update(bytes).digest("base64");
    json(path.join(root, "pack-report.json"), report);
  }
  repack();
  return { root, main, metadata, report, tarball, repack };
}
module.exports = { fixture, VERSION, ROOT, json };
