"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  getPackageGuess,
  resolveConfiguredPackageName
} = require("./spec");

const SPEC_EXT = ".spec";

function createWorkspaceApi(vscode, getConfig) {
  function getWorkspaceFolder() {
    return vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length
      ? vscode.workspace.workspaceFolders[0]
      : undefined;
  }

  function getWorkspaceCwd() {
    const folder = getWorkspaceFolder();
    return folder ? folder.uri.fsPath : os.tmpdir();
  }

  function commandCwd(preferred) {
    return preferred && fs.existsSync(preferred) && fs.statSync(preferred).isDirectory()
      ? preferred
      : getWorkspaceCwd();
  }

  function defaultPackageDirectory(project, packageName, specPath) {
    const folder = getWorkspaceFolder();
    const base = folder ? folder.uri.fsPath : path.dirname(specPath);
    const safeProject = sanitizePathPart(project || "unconfigured-project");
    const safePackage = sanitizePathPart(packageName || path.basename(specPath, SPEC_EXT));
    return path.join(base, ".obs-packages", safeProject, safePackage);
  }

  function servicePackageDirectory(ctx) {
    const normalized = normalizePath(ctx.packageDirectory || "");
    if (normalized.includes("/.obs-packages/")) return ctx.packageDirectory;
    return defaultPackageDirectory(ctx.project, ctx.packageName, ctx.specPath);
  }

  async function resolveContext(options = {}) {
    const uri = getActiveSpecUri() || (options.promptSpec ? await pickSpecUri() : undefined);
    return uri ? buildContext(uri) : undefined;
  }

  function resolveContextSync() {
    const uri = getActiveSpecUri();
    return uri ? buildContext(uri) : undefined;
  }

  function buildContext(uri) {
    const cfg = getConfig();
    const specPath = uri.fsPath;
    const specKey = getSpecKey(uri);
    const mapping = cfg.specMappings[specKey] || {};
    const packageGuess = getPackageGuess(specPath);
    const projectGuess = mapping.project || cfg.defaultProject || cfg.homeProject || "";
    const packageName = resolveConfiguredPackageName(mapping.package, packageGuess) || cfg.defaultPackage || "";
    const packageDirectory = mapping.packageDirectory
      || cfg.packageDirectory
      || defaultPackageDirectory(projectGuess, packageName, specPath);

    return {
      specUri: uri,
      specPath,
      specKey,
      project: projectGuess,
      packageName,
      repository: mapping.repository || cfg.defaultRepository || "",
      arch: mapping.arch || cfg.defaultArch || "x86_64",
      packageDirectory,
      homeProject: mapping.homeProject || cfg.homeProject || ""
    };
  }

  function getActiveSpecUri() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isSpecUri(editor.document.uri)) return undefined;
    return editor.document.uri;
  }

  async function pickSpecUri() {
    const files = await vscode.workspace.findFiles("**/*.spec", "**/{.git,node_modules,work,outputs}/**", 100);
    if (!files.length) {
      vscode.window.showWarningMessage("Open a .spec file first.");
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      files.map((uri) => ({ label: path.basename(uri.fsPath), description: getSpecKey(uri), uri })),
      { placeHolder: "Choose a .spec file", ignoreFocusOut: true }
    );
    if (!picked) return undefined;
    const doc = await vscode.workspace.openTextDocument(picked.uri);
    await vscode.window.showTextDocument(doc, { preview: false });
    return picked.uri;
  }

  function getSpecKey(uri) {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    return folder ? path.relative(folder.uri.fsPath, uri.fsPath) : uri.fsPath;
  }

  return {
    commandCwd,
    defaultPackageDirectory,
    getSpecKey,
    getWorkspaceCwd,
    getWorkspaceFolder,
    isSpecUri,
    normalizePath,
    resolveContext,
    resolveContextSync,
    servicePackageDirectory
  };
}

function isSpecUri(uri) {
  return uri && uri.scheme === "file" && path.extname(uri.fsPath).toLowerCase() === SPEC_EXT;
}

function sanitizePathPart(value) {
  return String(value || "").replace(/[^A-Za-z0-9_.-]+/g, "_") || "unknown";
}

function normalizePath(value) {
  return String(value || "").split(path.sep).join("/");
}

module.exports = {
  createWorkspaceApi,
  isSpecUri,
  normalizePath,
  sanitizePathPart
};
