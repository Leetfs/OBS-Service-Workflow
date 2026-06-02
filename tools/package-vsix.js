"use strict";

const cp = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const outDir = path.join(root, "outputs");
const workDir = path.join(root, "work", "vsix");
const vsixRoot = path.join(workDir, "root");
const extensionDir = path.join(vsixRoot, "extension");
const outFile = path.join(outDir, `${pkg.name}-${pkg.version}.vsix`);

function main() {
  clean(workDir);
  fs.mkdirSync(extensionDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  copyFile("package.json");
  copyFile("README.md");
  copyDir("src");
  if (fs.existsSync(path.join(root, "media"))) {
    copyDir("media");
  }

  writeFile(path.join(vsixRoot, "[Content_Types].xml"), contentTypesXml());
  writeFile(path.join(vsixRoot, "extension.vsixmanifest"), vsixManifestXml());

  if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
  run("zip", ["-r", "-X", outFile, "."], vsixRoot);

  console.log(outFile);
}

function copyFile(relativePath) {
  const source = path.join(root, relativePath);
  const target = path.join(extensionDir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function copyDir(relativePath) {
  const sourceDir = path.join(root, relativePath);
  const targetDir = path.join(extensionDir, relativePath);
  fs.mkdirSync(targetDir, { recursive: true });

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const source = path.join(sourceDir, entry.name);
    const target = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDir(path.join(relativePath, entry.name));
    } else if (entry.isFile()) {
      fs.copyFileSync(source, target);
    }
  }
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function clean(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function run(command, args, cwd) {
  const result = cp.spawnSync(command, args, {
    cwd,
    encoding: "utf8"
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status}`);
  }
}

function contentTypesXml() {
  return `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="svg" ContentType="image/svg+xml" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
  <Default Extension="xml" ContentType="text/xml" />
</Types>
`;
}

function vsixManifestXml() {
  const categories = Array.isArray(pkg.categories) && pkg.categories.length
    ? pkg.categories.join(",")
    : "Other";
  const engine = pkg.engines && pkg.engines.vscode ? pkg.engines.vscode : "*";
  const extensionKind = Array.isArray(pkg.extensionKind) ? pkg.extensionKind.join(",") : "";

  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${xml(pkg.name)}" Version="${xml(pkg.version)}" Publisher="${xml(pkg.publisher || "local")}" />
    <DisplayName>${xml(pkg.displayName || pkg.name)}</DisplayName>
    <Description xml:space="preserve">${xml(pkg.description || "")}</Description>
    <Categories>${xml(categories)}</Categories>
    <Tags>obs,open-build-service,osc,service,packaging</Tags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xml(engine)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="${xml(extensionKind)}" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Code.Content" Path="extension" Addressable="true" />
  </Assets>
</PackageManifest>
`;
}

function xml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

main();
