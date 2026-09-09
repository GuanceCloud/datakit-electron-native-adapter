"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

function npm(args, cwd) {
  // Avoid cmd.exe argument interpolation on Windows, including paths containing spaces.
  const cli = process.env.npm_execpath || path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  if (!fs.existsSync(cli)) throw new Error("Cannot locate npm-cli.js. Run this command through npm run.");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd, windowsHide: true, env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { errors = (errors + chunk).slice(-16000); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(output) : reject(new Error(`npm ${args[0]} failed (${code}): ${errors}\n${output.slice(-4000)}`)));
  });
}
module.exports = { npm };
