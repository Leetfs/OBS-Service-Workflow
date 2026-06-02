"use strict";

const cp = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const checkOnly = process.argv.includes("--check-only");

function main() {
  validateManifest();
  checkJavaScript("src/extension.js");
  checkJavaScript("tools/package-vsix.js");
  checkJavaScript("tools/build.js");

  if (checkOnly) return;
  run(process.execPath, ["tools/package-vsix.js"], root);
}

function validateManifest() {
  const manifestPath = path.join(root, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const required = ["name", "displayName", "version", "publisher", "main"];
  for (const field of required) {
    if (!manifest[field]) throw new Error(`package.json is missing ${field}.`);
  }
}

function checkJavaScript(relativePath) {
  run(process.execPath, ["--check", relativePath], root);
}

function run(command, args, cwd) {
  const result = cp.spawnSync(command, args, {
    cwd,
    encoding: "utf8"
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
}

main();
