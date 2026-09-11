"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const root = path.resolve(__dirname, "..");
const cliPath = path.join(root, "bin/guance-electron-native.mjs");
const cliModule = () => import(pathToFileURL(path.join(root, "native/darwin/scripts/lib/customer-cli.mjs")).href);

test("customer CLI requires an explicit Native SDK version", async () => {
  const { parseCustomerCLIArguments } = await cliModule();
  assert.throws(() => parseCustomerCLIArguments([], {}), /--sdk-version is required/u);
  assert.throws(
    () => parseCustomerCLIArguments([], { GUANCE_NATIVE_SDK_VERSION: "1.6.8" }),
    /--sdk-version is required/u,
  );
});

test("customer CLI supports versions, mirrors, and local Universal archives", async () => {
  const { parseCustomerCLIArguments } = await cliModule();
  const parsed = parseCustomerCLIArguments([
    "--sdk-version", "1.6.8",
    "--download-base-url", "https://downloads.example.com/native",
    "--runtime-archive", "/tmp/runtime.tar.gz",
  ], {});
  assert.equal(parsed.installOptions.sdkVersion, "1.6.8");
  assert.equal(parsed.installOptions.runtimeArchive, "/tmp/runtime.tar.gz");
  assert.equal(parsed.installOptions.downloadBaseURL, "https://downloads.example.com/native");
});

test("customer CLI rejects mixed-mode installation and removed build or architecture options", async () => {
  const { parseCustomerCLIArguments } = await cliModule();
  assert.throws(() => parseCustomerCLIArguments(["external"], {}), /Native host SDK.*does not install/u);
  for (const option of ["managed", "--arch", "--sdk-root", "--sdk-repository", "--debug"]) {
    assert.throws(() => parseCustomerCLIArguments([option, "/tmp/sdk"], {}), /Unknown argument/u);
  }
});

test("CLI awaits installation into the customer application, without a build request", async () => {
  const { runCustomerCLI } = await cliModule();
  const applicationRoot = path.join(os.tmpdir(), "orbitdesk-customer");
  let request;
  const messages = [];
  const result = await runCustomerCLI({
    argv: ["--sdk-version", "1.6.8"], cwd: applicationRoot, environment: {},
    async install(value) {
      request = value;
      await Promise.resolve();
      return path.join(value.applicationRoot, ".cloudcare/native/darwin/runtime");
    },
    write(message) { messages.push(message); },
  });
  assert.equal(request.applicationRoot, applicationRoot);
  assert.equal(request.options.sdkVersion, "1.6.8");
  assert.equal("architecture" in request.options, false);
  assert.equal(result.output, path.join(applicationRoot, ".cloudcare/native/darwin/runtime"));
  assert.match(messages[0], /Installed the Universal/u);
});

test("mixed mode fails before calling the installer", async () => {
  const { runCustomerCLI } = await cliModule();
  let called = false;
  await assert.rejects(runCustomerCLI({
    argv: ["external"], install() { called = true; },
  }), /Native host SDK/u);
  assert.equal(called, false);
});

test("customer executable prints help without any compiler in PATH", () => {
  const result = spawnSync(process.execPath, [cliPath, "--help"], {
    encoding: "utf8", env: { ...process.env, PATH: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /precompiled/u);
  assert.match(result.stdout, /Universal/u);
});

test("npm package remains JavaScript-only with no automatic runtime installation", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.bin["guance-electron-native"], "bin/guance-electron-native.mjs");
  assert.equal(pkg.peerDependencies.electron, "^22.3.27 || 43.x");
  assert.equal(pkg.scripts.install, undefined);
  assert.equal(pkg.scripts.postinstall, undefined);
  assert.equal(pkg.files.some((file) => file.endsWith(".node") || file === "native/darwin/runtime"), false);
});
