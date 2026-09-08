"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const cliPath = path.join(root, "bin/ft-electron-native.mjs");
const cliModulePath = path.join(
  root,
  "native/darwin/scripts/lib/customer-cli.mjs",
);

async function cliModule() {
  return import(pathToFileURL(cliModulePath).href);
}

test("npm package exposes the customer Native CLI", () => {
  const packageJSON = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

  assert.equal(packageJSON.bin["ft-electron-native"], "bin/ft-electron-native.mjs");
  assert.ok(packageJSON.files.includes("bin"));
  if (process.platform !== "win32") assert.ok(fs.statSync(cliPath).mode & 0o111);
});

test("customer managed command defaults to universal and the fixed Native SDK", async () => {
  const { parseCustomerCLIArguments } = await cliModule();
  const parsed = parseCustomerCLIArguments(["managed"], {});

  assert.equal(parsed.architecture, "universal");
  assert.equal(parsed.buildOptions.configuration, "release");
  assert.equal(parsed.buildOptions.sdkRef, "1.6.8-alpha.3");
});

test("customer managed command accepts thin architectures and development overrides", async () => {
  const { managedArchitectureSelection, parseCustomerCLIArguments } = await cliModule();
  const parsed = parseCustomerCLIArguments([
    "managed",
    "--arch",
    "x64",
    "--debug",
    "--sdk-root",
    "/tmp/native-sdk",
  ], {});

  assert.equal(parsed.architecture, "x64");
  assert.equal(parsed.buildOptions.configuration, "debug");
  assert.equal(parsed.buildOptions.sdkRoot, "/tmp/native-sdk");
  assert.deepEqual(managedArchitectureSelection("x64"), {
    architecture: "x86_64",
    universal: false,
  });
  assert.deepEqual(managedArchitectureSelection("current"), { universal: false });
});

test("customer CLI rejects external and invalid architecture builds", async () => {
  const { parseCustomerCLIArguments } = await cliModule();

  assert.throws(
    () => parseCustomerCLIArguments(["external"], {}),
    /Native host SDK.*does not build/u,
  );
  assert.throws(
    () => parseCustomerCLIArguments(["managed", "--arch", "ia32"], {}),
    /Unsupported architecture/u,
  );
  assert.throws(
    () => parseCustomerCLIArguments(["managed", "--arch", "arm64", "--arch=x64"], {}),
    /only be specified once/u,
  );
});

test("customer CLI writes build state and runtime below the invoking application", async () => {
  const { runCustomerCLI } = await cliModule();
  const applicationRoot = path.join(os.tmpdir(), "orbitdesk-customer");
  const messages = [];
  let buildRequest;
  const result = runCustomerCLI({
    argv: ["managed"],
    build(request) {
      buildRequest = request;
      return request.output;
    },
    cwd: applicationRoot,
    environment: {},
    write(message) {
      messages.push(message);
    },
  });

  const expectedBuildRoot = path.join(
    applicationRoot,
    ".cloudcare/native/darwin",
  );
  assert.equal(buildRequest.buildRoot, expectedBuildRoot);
  assert.equal(buildRequest.output, path.join(expectedBuildRoot, "runtime"));
  assert.equal(buildRequest.universal, true);
  assert.equal(buildRequest.architecture, undefined);
  assert.equal(result.output, buildRequest.output);
  assert.match(messages[0], /universal macOS managed runtime/u);
  assert.equal(
    buildRequest.adapterRoot,
    path.join(root, "native/darwin"),
  );
});

test("customer executable prints help without starting a Native build", () => {
  const result = spawnSync(process.execPath, [cliPath, "--help"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /ft-electron-native managed/u);
  assert.match(result.stdout, /default: universal/u);
  assert.equal(result.stderr, "");
});
