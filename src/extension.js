"use strict";

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

const { CONFIG_SECTION, createConfigApi } = require("./config");
const { createGitApi, getGitRootSync } = require("./git");
const { createOscApi, summarizeResults } = require("./osc");
const { createPackagesApi } = require("./packages");
const { updateRemoteAssets } = require("./remote-assets");
const { ObsTreeProvider } = require("./tree");
const { createTargetsApi } = require("./targets");
const { createWorkspaceApi } = require("./workspace");

const configApi = createConfigApi(vscode);
const {
  getConfig,
  saveSpecMapping,
  updateSetting
} = configApi;
const workspaceApi = createWorkspaceApi(vscode, getConfig);
const {
  commandCwd,
  defaultPackageDirectory,
  getWorkspaceCwd,
  getWorkspaceFolder,
  isSpecUri,
  normalizePath,
  resolveContext,
  resolveContextSync,
  servicePackageDirectory
} = workspaceApi;
const oscApi = createOscApi({
  commandCwd,
  getConfig,
  getLatestStatus: () => latestStatus,
  getOutput: () => output,
  getWorkspaceCwd,
  renderStatusBar,
  setStatus,
  statusBelongsTo,
  vscode
});
const {
  dispose: disposeOsc,
  isPolling,
  oscArgs,
  runCapture,
  runOsc,
  runToolCapture,
  stopRunningCommand,
  streamBuildLog
} = oscApi;
const gitApi = createGitApi({ getOutput: () => output, runToolCapture, vscode });
const {
  ensureRemoteRevisionAvailable,
  requireCurrentRevision,
  requireGitRepositoryUrl
} = gitApi;
const targetApi = createTargetsApi({
  commandCwd,
  getConfig,
  getLatestStatus: () => latestStatus,
  getOutput: () => output,
  oscArgs,
  requireContext,
  runToolCapture,
  saveSpecMapping,
  statusBelongsTo,
  updateSetting,
  vscode
});
const {
  getLogArch,
  inferRepositoryForArch,
  inferRepositoryForArchFromObs,
  setLogArch
} = targetApi;
const packagesApi = createPackagesApi({
  commandCwd,
  defaultPackageDirectory,
  getConfig,
  getGitRootSync,
  getWorkspaceCwd,
  getWorkspaceFolder,
  normalizePath,
  oscArgs,
  promptRequired,
  runCapture,
  runOsc,
  updateSetting,
  vscode
});
const {
  askHomeProject,
  chooseCreateTarget,
  ensureProjectExists,
  getServiceExtractPath,
  remotePackageExists,
  writeAndCommitServiceFile
} = packagesApi;

let output;
let statusBar;
let treeProvider;
let statusTimer;
let latestStatus = emptyStatus();

function activate(context) {
  output = vscode.window.createOutputChannel("OBS Service");
  treeProvider = new ObsTreeProvider({
    vscode,
    getLatestStatus: () => latestStatus,
    logTargetLabel,
    packageLabel,
    resolveContextSync,
    statusBelongsTo
  });
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = "obsService.refreshStatus";

  context.subscriptions.push(
    output,
    statusBar,
    vscode.window.registerTreeDataProvider("obsService.workflow", treeProvider),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_SECTION)) {
        refreshUi();
        restartStatusPolling();
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      latestStatus = emptyStatus();
      refreshUi();
      refreshStatusSoon();
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (isSpecUri(document.uri)) refreshStatusSoon();
    }),
    registerCommand("obsService.configureCurrentSpec", configureCurrentSpec),
    registerCommand("obsService.createPackage", createPackage),
    registerCommand("obsService.updateServiceFile", updateServiceFile),
    registerCommand("obsService.updateRemoteAssets", () => updateRemoteAssets({ getConfig, output, resolveContext, setStatus, vscode })),
    registerCommand("obsService.deletePackage", deletePackage),
    registerCommand("obsService.rebuildPackage", rebuildPackage),
    registerCommand("obsService.triggerServices", triggerServices),
    registerCommand("obsService.openStatusLog", openStatusLog),
    registerCommand("obsService.setLogArch", setLogArch),
    registerCommand("obsService.refreshStatus", () => refreshPackageStatus(true)),
    registerCommand("obsService.openOutput", () => output.show(true)),
    registerCommand("obsService.stop", stopRunningCommand)
  );

  refreshUi();
  restartStatusPolling();
  refreshStatusSoon();
}

function deactivate() {
  disposeOsc();
  if (statusTimer) clearInterval(statusTimer);
}

function registerCommand(command, handler) {
  return vscode.commands.registerCommand(command, async (...args) => {
    try {
      await handler(...args);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      output.appendLine("");
      output.appendLine(`[error] ${message}`);
      vscode.window.showErrorMessage(message);
    } finally {
      refreshUi();
    }
  });
}

async function configureCurrentSpec() {
  const ctx = await resolveContext({ promptSpec: true });
  if (!ctx) return;

  const homeProject = await askHomeProject();
  if (!homeProject) return;

  const project = await promptRequired("OBS project", ctx.project || homeProject);
  if (!project) return;

  const packageName = ctx.packageName;
  const repository = ctx.repository || getConfig().defaultRepository;
  const arch = ctx.arch || getConfig().defaultArch || "x86_64";
  const packageDirectory = defaultPackageDirectory(project, packageName, ctx.specPath);

  await saveSpecMapping(ctx.specKey, {
    project,
    packageName,
    repository,
    arch,
    packageDirectory,
    homeProject
  });
  latestStatus = emptyStatus();
  vscode.window.showInformationMessage(`OBS mapping saved for ${path.basename(ctx.specPath)}.`);
  await refreshPackageStatus(false);
}

async function createPackage() {
  const ctx = await resolveContext({ promptSpec: true });
  if (!ctx) return;

  const gitRepositoryUrl = await requireGitRepositoryUrl(ctx.specPath);
  if (!gitRepositoryUrl) return;

  const homeProject = await askHomeProject();
  if (!homeProject) return;

  const packageName = ctx.packageName;

  const targetProject = await chooseCreateTarget(homeProject, packageName);
  if (!targetProject) return;

  const repository = ctx.repository || getConfig().defaultRepository;
  const arch = ctx.arch || getConfig().defaultArch || "x86_64";
  const packageDirectory = defaultPackageDirectory(targetProject, packageName, ctx.specPath);
  fs.mkdirSync(packageDirectory, { recursive: true });

  const user = homeProject.replace(/^home:/, "");
  if (targetProject !== homeProject) {
    await ensureProjectExists(targetProject, homeProject, user, packageName);
  }

  const exists = await remotePackageExists(targetProject, packageName, packageDirectory);
  if (!exists) {
    await runOsc(["rmkpac", targetProject, packageName], {
      cwd: packageDirectory,
      title: `create ${targetProject}/${packageName}`
    });
  }

  const revision = await requireCurrentRevision(ctx.specPath);
  if (!revision) return;
  if (!(await ensureRemoteRevisionAvailable(ctx.specPath, gitRepositoryUrl, revision))) return;

  const extract = getServiceExtractPath(ctx);

  await saveSpecMapping(ctx.specKey, {
    project: targetProject,
    packageName,
    repository,
    arch,
    packageDirectory,
    homeProject
  });

  await writeAndCommitServiceFile(
    { ...ctx, project: targetProject, packageName, repository, arch, packageDirectory, gitRepositoryUrl },
    revision,
    extract,
    `add _service for ${packageName}`
  );
  await refreshPackageStatus(false);
  await openDefaultBuildLog({ ...ctx, project: targetProject, packageName, repository, arch, packageDirectory });
}

async function updateServiceFile() {
  const ctx = await requireContext();
  if (!ctx) return false;

  const gitRepositoryUrl = await requireGitRepositoryUrl(ctx.specPath);
  if (!gitRepositoryUrl) return false;

  const revision = await requireCurrentRevision(ctx.specPath);
  if (!revision) return false;
  if (!(await ensureRemoteRevisionAvailable(ctx.specPath, gitRepositoryUrl, revision))) return false;

  const extract = getServiceExtractPath(ctx);
  const packageDirectory = servicePackageDirectory(ctx);

  await saveSpecMapping(ctx.specKey, {
    ...ctx,
    packageDirectory
  });

  await writeAndCommitServiceFile(
    { ...ctx, packageDirectory, gitRepositoryUrl },
    revision,
    extract,
    `update _service for ${ctx.packageName}`
  );
  await refreshPackageStatus(false);
  return true;
}

async function deletePackage() {
  const ctx = await requireRemoteContext();
  if (!ctx) return;

  await runOsc(["rdelete", "-m", `delete ${ctx.packageName}`, ctx.project, ctx.packageName], {
    cwd: commandCwd(ctx.packageDirectory),
    title: `delete ${ctx.project}/${ctx.packageName}`
  });
  latestStatus = emptyStatus();
}

async function rebuildPackage() {
  const ctx = await requireRemoteContext();
  if (!ctx) return;

  const args = ["rebuildpac", ctx.project, ctx.packageName];
  if (ctx.repository) {
    args.push(ctx.repository);
    const arch = getLogArch(ctx);
    if (arch) args.push(arch);
  }

  await runOsc(args, {
    cwd: commandCwd(ctx.packageDirectory),
    title: `rebuild ${ctx.project}/${ctx.packageName}`
  });
  await refreshPackageStatus(false);
  await openDefaultBuildLog(ctx);
}

async function triggerServices() {
  const ctx = await requireRemoteContext();
  if (!ctx) return;

  await runOsc(["service", "remoterun", ctx.project, ctx.packageName], {
    cwd: commandCwd(ctx.packageDirectory),
    title: `trigger services ${ctx.project}/${ctx.packageName}`
  });
  await refreshPackageStatus(false);
  await openDefaultBuildLog(ctx);
}

async function openDefaultBuildLog(ctx) {
  const arch = getLogArch(ctx);
  let repository = ctx.repository || getConfig().defaultRepository || inferRepositoryForArch(ctx, arch);
  if (!repository) {
    await sleep(1500);
    await refreshPackageStatus(false);
    repository = ctx.repository || getConfig().defaultRepository || inferRepositoryForArch(ctx, arch);
    if (!repository) repository = await inferRepositoryForArchFromObs(ctx, arch);
  }
  if (!repository) {
    output.show(true);
    output.appendLine("");
    output.appendLine(`[info] Could not infer a build target for ${arch}, so automatic build log was skipped.`);
    output.appendLine("[info] Wait for Build Status to show a matching arch, or set Log Target manually.");
    return;
  }

  await streamBuildLog(ctx, repository, arch, {
    title: `auto log ${ctx.project}/${ctx.packageName} ${repository}/${arch}`,
    waitForActive: true,
    waitForActiveMs: 90000
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openStatusLog(target) {
  const ctx = await requireRemoteContext();
  if (!ctx || !target || !target.repository || !target.arch) return;

  await streamBuildLog(ctx, target.repository, target.arch, {
    title: `status log ${ctx.project}/${ctx.packageName} ${target.repository}/${target.arch}`
  });
}

async function refreshPackageStatus(revealError) {
  const ctx = resolveContextSync();
  if (!ctx || !ctx.project || !ctx.packageName) {
    latestStatus = emptyStatus();
    refreshUi();
    return;
  }
  if (isPolling()) return;

  const previousStatus = latestStatus;

  try {
    const shouldVerifyPackage = previousStatus.key !== ctx.specKey || previousStatus.exists !== true;
    if (shouldVerifyPackage) {
      const exists = await remotePackageExists(ctx.project, ctx.packageName, ctx.packageDirectory);
      if (!exists) {
        latestStatus = {
          key: ctx.specKey,
          exists: false,
          summary: "not created on OBS",
          lines: [`${ctx.project}/${ctx.packageName} does not exist yet.`],
          loading: false,
          updatedAt: new Date()
        };
        return;
      }
    }

    const args = ["results", ctx.project, ctx.packageName];

    const result = await runCapture("osc", oscArgs(args), commandCwd(ctx.packageDirectory), getConfig().statusPollTimeoutSeconds * 1000);
    const parsed = summarizeResults(result.stdout || result.stderr);
    latestStatus = {
      key: ctx.specKey,
      exists: true,
      summary: parsed.summary,
      lines: parsed.lines,
      loading: false,
      updatedAt: new Date()
    };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    latestStatus = {
      key: ctx.specKey,
      exists: undefined,
      summary: "status unavailable",
      lines: [message],
      loading: false,
      updatedAt: new Date()
    };
    if (revealError) vscode.window.showErrorMessage(message);
  } finally {
    refreshUi();
  }
}

function refreshUi() {
  renderStatusBar();
  if (treeProvider) treeProvider.refresh();
}

function renderStatusBar() {
  const ctx = resolveContextSync();
  if (!ctx) {
    setStatus("$(package) OBS: open .spec");
    return;
  }
  const bits = [`$(package) OBS: ${ctx.packageName || path.basename(ctx.specPath)}`];
  if (statusBelongsTo(ctx) && latestStatus.summary) bits.push(latestStatus.summary);
  setStatus(bits.join(" | "));
}

function setStatus(text) {
  statusBar.text = text;
  statusBar.tooltip = "OBS Service Workflow";
  statusBar.show();
}

function restartStatusPolling() {
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = undefined;
  const cfg = getConfig();
  if (!cfg.statusPollingEnabled) return;
  const seconds = Math.max(2, cfg.statusRefreshIntervalSeconds || 3);
  statusTimer = setInterval(() => refreshPackageStatus(false), seconds * 1000);
}

function refreshStatusSoon() {
  setTimeout(() => refreshPackageStatus(false), 250);
}

async function requireContext() {
  const ctx = await resolveContext({ promptSpec: true });
  if (!ctx) return undefined;
  if (!ctx.project || !ctx.packageName) {
    vscode.window.showWarningMessage("Configure the OBS target for this spec first.");
    await configureCurrentSpec();
    return resolveContext({ promptSpec: true });
  }
  return ctx;
}

async function requireRemoteContext() {
  const ctx = await requireContext();
  if (!ctx) return undefined;
  if (!(await remotePackageExists(ctx.project, ctx.packageName, ctx.packageDirectory))) {
    const choice = await vscode.window.showWarningMessage(
      `${ctx.project}/${ctx.packageName} is not created on OBS yet.`,
      "Create Package",
      "Cancel"
    );
    if (choice === "Create Package") await createPackage();
    return undefined;
  }
  return ctx;
}

function packageLabel(ctx) {
  if (!ctx.project && !ctx.packageName) return "not configured";
  if (!ctx.project) return ctx.packageName;
  if (!ctx.packageName) return ctx.project;
  return `${ctx.project}/${ctx.packageName}`;
}

function logTargetLabel(ctx) {
  const arch = getLogArch(ctx);
  const repository = ctx.repository || inferRepositoryForArch(ctx, arch);
  return repository ? `${repository}/${arch}` : arch;
}

function statusBelongsTo(ctx) {
  return latestStatus.key && latestStatus.key === ctx.specKey;
}

async function promptRequired(placeHolder, value) {
  const result = await vscode.window.showInputBox({ placeHolder, value, ignoreFocusOut: true });
  if (result === undefined) return undefined;
  if (!result.trim()) {
    vscode.window.showWarningMessage(`${placeHolder} is required.`);
    return undefined;
  }
  return result.trim();
}

function emptyStatus() {
  return {
    key: "",
    exists: undefined,
    summary: "",
    lines: [],
    loading: false,
    updatedAt: undefined
  };
}

module.exports = {
  activate,
  deactivate
};
