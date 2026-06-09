"use strict";

const vscode = require("vscode");
const cp = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");

const CONFIG_SECTION = "obsService";
const SPEC_EXT = ".spec";
const SERVICE_FILE = "_service";

let output;
let statusBar;
let treeProvider;
let activeProcess;
let statusTimer;
let pollingProcess;
let latestStatus = emptyStatus();

function activate(context) {
  output = vscode.window.createOutputChannel("OBS Service");
  treeProvider = new ObsTreeProvider();
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
    registerCommand("obsService.updateRemoteAssets", updateRemoteAssets),
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
  if (activeProcess) activeProcess.kill();
  if (pollingProcess) pollingProcess.kill();
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

async function updateRemoteAssets() {
  const ctx = await resolveContext({ promptSpec: true });
  if (!ctx) return;

  const document = await vscode.workspace.openTextDocument(ctx.specUri);
  const text = document.getText();
  const sources = collectRemoteAssetSources(text);
  if (!sources.length) {
    vscode.window.showWarningMessage("No Source URL lines found in this spec.");
    return;
  }

  const unresolved = sources.filter((source) => /^https?:\/\//i.test(source.rawUrl) && hasSpecMacroReference(source.url));
  if (unresolved.length) {
    throw new Error(`Cannot expand Source URL macros: ${unresolved.map((source) => source.tag).join(", ")}.`);
  }

  const remoteSources = sources.filter((source) => /^https?:\/\//i.test(source.url));
  if (!remoteSources.length) {
    vscode.window.showWarningMessage("No HTTP(S) Source URLs found in this spec.");
    return;
  }

  const skipped = sources.filter((source) => !/^https?:\/\//i.test(source.url));
  if (getConfig().autoRevealOutput) output.show(true);
  output.appendLine("");
  output.appendLine(`[remote-asset] Updating ${remoteSources.length} Source asset${remoteSources.length > 1 ? "s" : ""} for ${path.basename(ctx.specPath)}.`);
  for (const source of skipped) {
    output.appendLine(`[remote-asset] Skipping ${source.tag}: ${source.rawUrl}`);
  }

  setStatus("$(sync~spin) OBS: update RemoteAsset hashes");
  const updates = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "Updating RemoteAsset SHA256",
    cancellable: false
  }, async (progress) => {
    const results = [];
    for (let index = 0; index < remoteSources.length; index += 1) {
      const source = remoteSources[index];
      progress.report({ message: `${index + 1}/${remoteSources.length} ${source.tag}` });
      output.appendLine(`[remote-asset] ${source.tag}: ${source.url}`);
      const result = await downloadSha256(source.url);
      output.appendLine(`[remote-asset] ${source.tag}: sha256:${result.sha256} (${result.bytes} bytes)`);
      results.push({ source, sha256: result.sha256 });
    }
    return results;
  });

  const updatedText = applyRemoteAssetHashes(text, updates);
  if (updatedText === text) {
    vscode.window.showInformationMessage("RemoteAsset SHA256 lines are already up to date.");
    return;
  }

  const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(text.length));
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, fullRange, updatedText);
  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) throw new Error("Could not update RemoteAsset lines.");
  await document.save();
  await vscode.window.showTextDocument(document, { preview: false });
  vscode.window.showInformationMessage(`Updated RemoteAsset SHA256 for ${updates.length} Source asset${updates.length > 1 ? "s" : ""}.`);
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

function getLogArch(ctx) {
  const cfg = getConfig();
  return ctx.arch || cfg.logArch || cfg.defaultArch || "x86_64";
}

function inferRepositoryForArch(ctx, arch) {
  if (!ctx || !statusBelongsTo(ctx) || !arch) return "";
  const wanted = String(arch).toLowerCase();

  for (const line of latestStatus.lines || []) {
    const columns = String(line).trim().split(/\s+/).filter(Boolean);
    if (columns.length < 2) continue;
    if (columns[1].toLowerCase() === wanted) return columns[0];
  }

  return "";
}

async function inferRepositoryForArchFromObs(ctx, arch) {
  const targets = await listBuildTargets(ctx.project, ctx.packageDirectory);
  const match = targets.find((target) => target.arch.toLowerCase() === String(arch || "").toLowerCase());
  return match ? match.repository : "";
}

async function openStatusLog(target) {
  const ctx = await requireRemoteContext();
  if (!ctx || !target || !target.repository || !target.arch) return;

  await streamBuildLog(ctx, target.repository, target.arch, {
    title: `status log ${ctx.project}/${ctx.packageName} ${target.repository}/${target.arch}`
  });
}

async function setLogArch() {
  const ctx = await requireContext();
  if (!ctx) return;

  const picked = await chooseBuildTarget(ctx, {
    currentRepository: ctx.repository || inferRepositoryForArch(ctx, getLogArch(ctx)),
    currentArch: getLogArch(ctx)
  });
  if (!picked) return;

  await saveSpecMapping(ctx.specKey, {
    ...ctx,
    repository: picked.repository,
    arch: picked.arch
  });
  await updateSetting("logArch", picked.arch);
  vscode.window.showInformationMessage(`OBS build log target set to ${picked.repository}/${picked.arch}.`);
}

async function chooseBuildTarget(ctx, current = {}) {
  const targets = await getBuildTargetChoices(ctx, current);
  if (!targets.length) {
    vscode.window.showWarningMessage(`No OBS repositories/arches found for ${ctx.project}.`);
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(targets.map((target) => {
    const selected = target.repository === current.currentRepository && target.arch === current.currentArch;
    return {
      label: `${target.repository} / ${target.arch}${selected ? " (current)" : ""}`,
      description: target.source,
      repository: target.repository,
      arch: target.arch
    };
  }), {
    placeHolder: "Choose OBS repository / architecture",
    ignoreFocusOut: true
  });
  return picked ? { repository: picked.repository, arch: picked.arch } : undefined;
}

async function getBuildTargetChoices(ctx, current = {}) {
  let targets = [];
  try {
    targets = await listBuildTargets(ctx.project, ctx.packageDirectory);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    output.appendLine(`[warning] Could not read OBS repositories for ${ctx.project}: ${message}`);
  }

  return uniqueTargets([
    ...targets.map((target) => ({ ...target, source: "from OBS project metadata" })),
    ...getStatusBuildTargets().map((target) => ({ ...target, source: "from latest build status" })),
    current.currentRepository && current.currentArch
      ? { repository: current.currentRepository, arch: current.currentArch, source: "current selection" }
      : undefined,
    getConfig().defaultRepository
      ? { repository: getConfig().defaultRepository, arch: current.currentArch || getConfig().defaultArch || "x86_64", source: "workspace default" }
      : undefined
  ]);
}

async function listBuildTargets(project, cwd) {
  if (!project) return [];
  const result = await runToolCapture("osc", oscArgs(["meta", "prj", project]), commandCwd(cwd), 15000);
  return parseBuildTargets(result.stdout || "");
}

function parseBuildTargets(xmlText) {
  const targets = [];
  const repositoryBlocks = String(xmlText || "").matchAll(/<repository\b[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/repository>/g);
  for (const match of repositoryBlocks) {
    const repository = unescapeXml(match[1]);
    const archMatches = match[2].matchAll(/<arch>([^<]+)<\/arch>/g);
    for (const archMatch of archMatches) {
      targets.push({ repository, arch: unescapeXml(archMatch[1]).trim() });
    }
  }
  return uniqueTargets(targets);
}

function getStatusBuildTargets() {
  return (latestStatus.lines || []).map((line) => {
    const columns = String(line).trim().split(/\s+/).filter(Boolean);
    return columns.length >= 2 ? { repository: columns[0], arch: columns[1] } : undefined;
  }).filter(Boolean);
}

function uniqueTargets(targets) {
  const seen = new Set();
  return targets
    .filter(Boolean)
    .map((target) => ({
      repository: String(target.repository || "").trim(),
      arch: String(target.arch || "").trim(),
      source: target.source
    }))
    .filter((target) => {
      if (!target.repository || !target.arch) return false;
      const key = `${target.repository}\0${target.arch}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function stopRunningCommand() {
  if (!activeProcess) {
    vscode.window.showInformationMessage("No OBS command is running.");
    return;
  }

  activeProcess.kill();
  activeProcess = undefined;
  output.appendLine("");
  output.appendLine("[stopped] Active OBS command stopped.");
}

async function chooseCreateTarget(homeProject, packageName) {
  const direct = {
    label: `Create in ${homeProject}`,
    description: `${homeProject}/${packageName}`,
    value: homeProject
  };
  const packageSubproject = {
    label: `Create package subproject ${homeProject}:${packageName}`,
    description: `${homeProject}:${packageName}/${packageName}`,
    value: `${homeProject}:${packageName}`
  };
  const existing = {
    label: "Create in existing home subproject...",
    description: `Pick a project under ${homeProject}:*`,
    value: "__existing__"
  };

  const picked = await vscode.window.showQuickPick([direct, packageSubproject, existing], {
    placeHolder: "Where should the OBS package be created?",
    ignoreFocusOut: true
  });
  if (!picked) return undefined;
  if (picked.value !== "__existing__") return picked.value;

  const subprojects = await listHomeSubprojects(homeProject);
  const choices = [
    ...subprojects.map((project) => ({ label: project, value: project })),
    { label: "Enter manually...", value: "__manual__" }
  ];
  const sub = await vscode.window.showQuickPick(choices, {
    placeHolder: `Choose an existing subproject under ${homeProject}`,
    ignoreFocusOut: true
  });
  if (!sub) return undefined;
  if (sub.value !== "__manual__") return sub.value;

  const manual = await promptRequired("Existing OBS subproject", `${homeProject}:`);
  return manual;
}

async function askHomeProject() {
  const cfg = getConfig();
  if (cfg.homeProject) return cfg.homeProject;

  let guessed = "";
  try {
    const result = await runCapture("osc", oscArgs(["user"]), getWorkspaceCwd(), 10000);
    guessed = parseOscUser(result.stdout || result.stderr);
  } catch {
    guessed = "";
  }

  const homeProject = await promptRequired("Your OBS home project", guessed ? `home:${guessed}` : "home:");
  if (!homeProject) return undefined;
  await updateSetting("homeProject", homeProject);
  return homeProject;
}

async function requireGitRepositoryUrl(specPath) {
  const url = normalizeGitRemoteUrl(await getGitRemoteUrl(specPath));
  if (url) return url;
  vscode.window.showErrorMessage("Cannot find Git remote.origin.url for this spec. Set the repository URL with `git remote add origin <url>` first.");
  return undefined;
}

async function ensureRemoteRevisionAvailable(specPath, gitRepositoryUrl, revision) {
  try {
    const result = await runToolCapture("git", ["ls-remote", "--heads", gitRepositoryUrl, revision], path.dirname(specPath), 15000);
    if (String(result.stdout || "").trim()) return true;
    vscode.window.showErrorMessage(`Current branch '${revision}' was not found on the remote repository. Push it before triggering OBS services.`);
    return false;
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    output.appendLine(`[warning] Could not verify remote branch '${revision}': ${message}`);
    return true;
  }
}

async function requireCurrentRevision(specPath) {
  const revision = await getCurrentGitBranch(specPath);
  if (revision) return revision;
  vscode.window.showErrorMessage("Cannot determine the current Git branch for _service revision. Check that this spec is inside a normal Git branch.");
  return undefined;
}

async function getCurrentGitBranch(specPath) {
  try {
    const result = await runToolCapture("git", ["rev-parse", "--abbrev-ref", "HEAD"], path.dirname(specPath), 10000);
    const branch = String(result.stdout || "").trim();
    return branch && branch !== "HEAD" ? branch : "";
  } catch {
    return "";
  }
}

async function getGitRemoteUrl(specPath) {
  try {
    const result = await runToolCapture("git", ["config", "--get", "remote.origin.url"], path.dirname(specPath), 10000);
    return String(result.stdout || "").trim();
  } catch {
    return "";
  }
}

function normalizeGitRemoteUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;

  const scpLike = raw.match(/^([^@/\s]+)@([^:/\s]+):(.+)$/);
  if (scpLike) {
    return `https://${scpLike[2]}/${scpLike[3].replace(/^\/+/, "")}`;
  }

  const sshUrl = raw.match(/^ssh:\/\/(?:[^@/\s]+@)?([^/\s]+)\/(.+)$/i);
  if (sshUrl) {
    return `https://${sshUrl[1]}/${sshUrl[2].replace(/^\/+/, "")}`;
  }

  const gitUrl = raw.match(/^git:\/\/([^/\s]+)\/(.+)$/i);
  if (gitUrl) {
    return `https://${gitUrl[1]}/${gitUrl[2].replace(/^\/+/, "")}`;
  }

  return raw;
}

function getServiceExtractPath(ctx) {
  const specDir = path.dirname(ctx.specPath);
  const root = getGitRootSync(specDir) || (getWorkspaceFolder() ? getWorkspaceFolder().uri.fsPath : "");
  const relative = root ? path.relative(root, specDir) : path.basename(specDir);
  const normalized = normalizePath(relative && relative !== "." ? relative : "");
  return normalized ? `${normalized}/*` : "*";
}

function getGitRootSync(cwd) {
  const result = cp.spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8"
  });
  if (result.status !== 0) return "";
  return String(result.stdout || "").trim();
}

async function writeAndCommitServiceFile(ctx, revision, extract, message) {
  await ensureObsWorkingCopy(ctx);

  const serviceXml = buildServiceXml(ctx.gitRepositoryUrl, revision, extract);
  fs.writeFileSync(path.join(ctx.packageDirectory, SERVICE_FILE), serviceXml);

  await runOsc(["addremove"], {
    cwd: ctx.packageDirectory,
    title: `add _service ${ctx.packageName}`
  });
  await runOsc(["commit", "-m", message, SERVICE_FILE], {
    cwd: ctx.packageDirectory,
    title: `commit _service ${ctx.packageName}`
  });
}

async function ensureObsWorkingCopy(ctx) {
  fs.mkdirSync(ctx.packageDirectory, { recursive: true });
  if (!fs.existsSync(path.join(ctx.packageDirectory, ".osc"))) {
    await runOsc(["init", ctx.project, ctx.packageName], {
      cwd: ctx.packageDirectory,
      title: `init working copy ${ctx.project}/${ctx.packageName}`
    });
  }

  await runOsc(["update"], {
    cwd: ctx.packageDirectory,
    title: `update working copy ${ctx.project}/${ctx.packageName}`
  });
}

function buildServiceXml(url, revision, extract) {
  return [
    "<services>",
    '  <service name="obs_scm">',
    "    <param name=\"scm\">git</param>",
    `    <param name="url">${xml(url)}</param>`,
    `    <param name="revision">${xml(revision)}</param>`,
    `    <param name="extract">${xml(extract)}</param>`,
    "  </service>",
    '  <service name="download_files"/>',
    "</services>",
    ""
  ].join("\n");
}

async function ensureProjectExists(project, parentProject, user, packageName) {
  if (await remoteProjectExists(project, getWorkspaceCwd())) return;

  let repositories = "";
  try {
    const parent = await runCapture("osc", oscArgs(["meta", "prj", parentProject]), getWorkspaceCwd(), 15000);
    repositories = extractRepositoryBlocks(parent.stdout || "");
  } catch {
    repositories = "";
  }

  const meta = [
    `<project name="${xml(project)}">`,
    `  <title>${xml(packageName)}</title>`,
    `  <description>Packaging workspace for ${xml(packageName)}</description>`,
    user ? `  <person userid="${xml(user)}" role="maintainer" />` : "",
    repositories,
    "</project>",
    ""
  ].filter(Boolean).join("\n");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-service-"));
  const metaFile = path.join(dir, "project.xml");
  fs.writeFileSync(metaFile, meta);

  await runOsc(["meta", "prj", project, "-F", metaFile], {
    cwd: getWorkspaceCwd(),
    title: `create project ${project}`
  });
}

async function remoteProjectExists(project, cwd) {
  try {
    await runCapture("osc", oscArgs(["meta", "prj", project]), commandCwd(cwd), 10000);
    return true;
  } catch {
    return false;
  }
}

async function remotePackageExists(project, packageName, cwd) {
  try {
    await runCapture("osc", oscArgs(["list", project, packageName]), commandCwd(cwd), 10000);
    return true;
  } catch {
    return false;
  }
}

async function listHomeSubprojects(homeProject) {
  try {
    const query = `/search/project?match=starts-with(@name,'${homeProject}:')`;
    const result = await runCapture("osc", oscArgs(["api", query]), getWorkspaceCwd(), 15000);
    return Array.from(new Set(
      Array.from(String(result.stdout || "").matchAll(/<project\b[^>]*\bname="([^"]+)"/g))
        .map((match) => match[1])
        .filter((name) => name.startsWith(`${homeProject}:`))
    )).sort();
  } catch {
    return [];
  }
}

async function refreshPackageStatus(revealError) {
  const ctx = resolveContextSync();
  if (!ctx || !ctx.project || !ctx.packageName) {
    latestStatus = emptyStatus();
    refreshUi();
    return;
  }
  if (pollingProcess) return;

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

async function runOsc(args, options = {}) {
  if (activeProcess) {
    if (!stopActiveLogStream(false)) {
      const choice = await vscode.window.showWarningMessage(
        "Another OBS command is still running.",
        "Stop it and run this",
        "Cancel"
      );
      if (choice !== "Stop it and run this") return;
      activeProcess.kill();
      activeProcess = undefined;
    }
  }

  const cwd = options.cwd || getWorkspaceCwd();
  ensureDirectory(cwd);
  const fullArgs = oscArgs(args);
  const commandLine = ["osc", ...fullArgs.map(quoteArg)].join(" ");

  if (getConfig().autoRevealOutput) output.show(true);
  output.appendLine("");
  output.appendLine(`$ ${commandLine}`);
  output.appendLine(`[cwd] ${cwd}`);
  setStatus(`$(sync~spin) OBS: ${options.title || args.join(" ")}`);

  return new Promise((resolve, reject) => {
    let settled = false;
    const child = cp.spawn("osc", fullArgs, { cwd, env: childEnv() });
    child.kind = "command";
    activeProcess = child;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data) => output.append(data));
    child.stderr.on("data", (data) => output.append(data));

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (activeProcess === child) activeProcess = undefined;
      renderStatusBar();
      reject(normalizeOscError(error));
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (activeProcess === child) activeProcess = undefined;
      if (signal) {
        output.appendLine(`[signal] ${signal}`);
        renderStatusBar();
        resolve();
        return;
      }
      output.appendLine(`[exit] ${code}`);
      renderStatusBar();
      code === 0 ? resolve() : reject(new Error(`osc exited with code ${code}. Check OBS Service output.`));
    });
  });
}

async function streamBuildLog(ctx, repository, arch, options = {}) {
  if (activeProcess) {
    if (!stopActiveLogStream(true)) {
      const choice = await vscode.window.showWarningMessage(
        "Another OBS command is still running.",
        "Stop it and run this",
        "Cancel"
      );
      if (choice !== "Stop it and run this") return;
      activeProcess.kill();
      activeProcess = undefined;
    }
  }

  const cwd = commandCwd(ctx.packageDirectory);
  const control = {
    kind: "buildLog",
    cancelled: false,
    currentChild: undefined,
    silentStop: false,
    kill() {
      this.cancelled = true;
      if (this.currentChild) this.currentChild.kill();
    }
  };
  activeProcess = control;

  if (getConfig().autoRevealOutput) output.show(true);
  output.appendLine("");
  output.appendLine(`[log] Streaming ${ctx.project}/${ctx.packageName} ${repository}/${arch}`);
  output.appendLine(`[cwd] ${cwd}`);
  setStatus(`$(sync~spin) OBS: ${options.title || `log ${repository}/${arch}`}`);

  try {
    if (options.waitForActive) {
      await waitForBuildToStart(ctx, repository, arch, control, options.waitForActiveMs || 60000);
    }

    let offset = 0;
    let sawActive = false;
    let sawData = false;
    let emptyTerminalPolls = 0;

    while (!control.cancelled) {
      const before = offset;
      const result = await pollBuildLogChunk(ctx, repository, arch, offset, cwd, control);
      offset += result.bytes;
      const gotData = offset > before;
      sawData = sawData || gotData;

      const summary = await refreshBuildLogStatus(ctx, repository, arch);
      const active = isBuildActive(summary);
      const terminal = isBuildTerminal(summary);
      sawActive = sawActive || active;

      if (terminal && !active && !gotData) {
        emptyTerminalPolls += 1;
      } else {
        emptyTerminalPolls = 0;
      }

      if ((sawActive || sawData) && emptyTerminalPolls >= 2) break;
      if (!sawActive && !sawData && terminal && emptyTerminalPolls >= 6) break;

      await sleep(gotData ? 500 : 1500);
    }

    if (control.cancelled) {
      if (!control.silentStop) output.appendLine("[log] stream stopped.");
    } else {
      output.appendLine("[log] stream finished.");
    }
  } finally {
    if (activeProcess === control) activeProcess = undefined;
    renderStatusBar();
  }
}

function stopActiveLogStream(silent) {
  if (!activeProcess || activeProcess.kind !== "buildLog") return false;
  activeProcess.silentStop = Boolean(silent);
  activeProcess.kill();
  activeProcess = undefined;
  return true;
}

async function waitForBuildToStart(ctx, repository, arch, control, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  output.appendLine("[log] waiting for OBS to start this build target...");

  while (!control.cancelled && Date.now() < deadline) {
    const summary = await refreshBuildLogStatus(ctx, repository, arch);
    if (isBuildActive(summary)) return;
    await sleep(1500);
  }

  if (!control.cancelled) {
    output.appendLine("[log] build has not reported active yet; opening the current remote log anyway.");
  }
}

function pollBuildLogChunk(ctx, repository, arch, offset, cwd, control) {
  const apiPath = buildLogApiPath(ctx, repository, arch, offset);

  return new Promise((resolve, reject) => {
    let stderr = "";
    let bytes = 0;
    let settled = false;
    const child = cp.spawn("osc", oscArgs(["api", apiPath]), { cwd, env: childEnv() });
    control.currentChild = child;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      control.currentChild = undefined;
      reject(new Error("Timed out while reading OBS build log."));
    }, 15000);

    child.stdout.on("data", (data) => {
      bytes += data.length;
      output.append(data.toString("utf8"));
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data) => { stderr += data; });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      control.currentChild = undefined;
      reject(normalizeOscError(error));
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      control.currentChild = undefined;
      if (control.cancelled || signal) {
        resolve({ bytes });
        return;
      }
      if (code === 0) {
        resolve({ bytes });
        return;
      }
      if (isLogNotReady(stderr)) {
        resolve({ bytes: 0 });
        return;
      }
      reject(new Error((stderr || `osc api exited with code ${code}`).trim()));
    });
  });
}

async function refreshBuildLogStatus(ctx, repository, arch) {
  try {
    const args = ["results"];
    if (repository) args.push("-r", repository);
    if (arch) args.push("-a", arch);
    args.push(ctx.project, ctx.packageName);

    const result = await runToolCapture("osc", oscArgs(args), commandCwd(ctx.packageDirectory), getConfig().statusPollTimeoutSeconds * 1000);
    const parsed = summarizeResults(result.stdout || result.stderr);
    return parsed.summary;
  } catch {
    return statusBelongsTo(ctx) ? latestStatus.summary : "";
  }
}

function buildLogApiPath(ctx, repository, arch, offset) {
  const segments = ["build", ctx.project, repository, arch, ctx.packageName, "_log"].map(urlPathSegment);
  return `/${segments.join("/")}?nostream=1&start=${offset}`;
}

function urlPathSegment(value) {
  return encodeURIComponent(String(value || ""));
}

function isLogNotReady(text) {
  const value = String(text || "").toLowerCase();
  return value.includes("404") || value.includes("not found") || value.includes("no such file");
}

function isBuildActive(summary) {
  const value = String(summary || "").toLowerCase();
  return ["building", "scheduled", "dispatching", "blocked"].some((state) => value.includes(state));
}

function isBuildTerminal(summary) {
  const value = String(summary || "").toLowerCase();
  return ["succeeded", "failed", "unresolvable", "broken", "finished", "disabled", "excluded"].some((state) => value.includes(state));
}

function runCapture(command, args, cwd, timeoutMs) {
  ensureDirectory(cwd);
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = cp.spawn(command, args, { cwd, env: childEnv() });
    pollingProcess = child;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (pollingProcess === child) pollingProcess = undefined;
      child.kill();
      reject(new Error("Timed out while refreshing OBS status."));
    }, timeoutMs || 15000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pollingProcess === child) pollingProcess = undefined;
      reject(normalizeOscError(error));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pollingProcess === child) pollingProcess = undefined;
      code === 0 ? resolve({ stdout, stderr }) : reject(new Error((stderr || stdout || `osc exited with code ${code}`).trim()));
    });
  });
}

function runToolCapture(command, args, cwd, timeoutMs) {
  ensureDirectory(cwd);
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = cp.spawn(command, args, { cwd, env: childEnv() });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`${command} timed out.`));
    }, timeoutMs || 10000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      code === 0 ? resolve({ stdout, stderr }) : reject(new Error((stderr || stdout || `${command} exited with code ${code}`).trim()));
    });
  });
}

function downloadSha256(url, redirectCount = 0) {
  if (redirectCount > 10) {
    return Promise.reject(new Error(`Too many redirects while downloading ${url}.`));
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return Promise.reject(new Error(`Invalid Source URL: ${url}`));
  }

  const transport = parsed.protocol === "http:" ? http : https;
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return Promise.reject(new Error(`Unsupported Source URL protocol: ${parsed.protocol}`));
  }

  return new Promise((resolve, reject) => {
    const request = transport.get(parsed, {
      headers: {
        "User-Agent": "OBS-Service-Workflow",
        "Accept": "*/*"
      }
    }, (response) => {
      const statusCode = response.statusCode || 0;
      const location = response.headers.location;
      if ([301, 302, 303, 307, 308].includes(statusCode) && location) {
        response.resume();
        const nextUrl = new URL(location, parsed).toString();
        resolve(downloadSha256(nextUrl, redirectCount + 1));
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        reject(new Error(`Failed to download ${url}: HTTP ${statusCode}.`));
        return;
      }

      const hash = crypto.createHash("sha256");
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        hash.update(chunk);
      });
      response.on("end", () => {
        resolve({ sha256: hash.digest("hex"), bytes });
      });
      response.on("error", reject);
    });

    request.setTimeout(120000, () => {
      request.destroy(new Error(`Timed out downloading ${url}.`));
    });
    request.on("error", reject);
  });
}

class ObsTreeProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(item) {
    return item;
  }

  getChildren(item) {
    if (item && item.children) return item.children;

    const ctx = resolveContextSync();
    if (!ctx) {
      return [
        infoItem("Open a .spec file"),
        actionItem("Open Output", "OBS command output", "obsService.openOutput", "terminal")
      ];
    }

    const statusDescription = statusBelongsTo(ctx) && latestStatus.summary
      ? latestStatus.summary
      : "not refreshed";
    const statusLines = statusBelongsTo(ctx) ? latestStatus.lines : [];
    const statusChildren = statusLines.length
      ? statusLines.map((line) => statusLineItem(line))
      : [infoItem("No build status yet")];

    return [
      actionItem("Create OBS Package", "create package from this spec", "obsService.createPackage", "add"),
      actionItem("Update _service", "regenerate and commit only _service", "obsService.updateServiceFile", "cloud-upload"),
      actionItem("Update RemoteAsset", "download Source URLs and refresh sha256 lines", "obsService.updateRemoteAssets", "key"),
      actionItem("Delete Package", "osc rdelete immediately", "obsService.deletePackage", "trash"),
      actionItem("Rebuild Package", "osc rebuildpac, then show default arch log", "obsService.rebuildPackage", "refresh"),
      actionItem("Trigger Services", "osc service remoterun", "obsService.triggerServices", "cloud"),
      actionItem("Log Target", logTargetLabel(ctx), "obsService.setLogArch", "symbol-namespace"),
      groupActionItem("Build Status", statusDescription, "obsService.refreshStatus", statusIcon(latestStatus.summary), statusChildren),
      actionItem("OBS Target", packageLabel(ctx), "obsService.configureCurrentSpec", "package"),
      actionItem("Open Output", "OBS command output", "obsService.openOutput", "terminal"),
      actionItem("Stop Running Command", "stop current osc process", "obsService.stop", "debug-stop")
    ];
  }
}

function actionItem(label, description, command, icon) {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.description = description;
  item.tooltip = description || label;
  item.iconPath = new vscode.ThemeIcon(icon);
  item.command = { command, title: label };
  return item;
}

function groupActionItem(label, description, command, icon, children) {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
  item.description = description;
  item.tooltip = description || label;
  item.iconPath = new vscode.ThemeIcon(icon);
  item.command = { command, title: label };
  item.children = children;
  return item;
}

function infoItem(text) {
  const item = new vscode.TreeItem(text, vscode.TreeItemCollapsibleState.None);
  item.tooltip = text;
  item.iconPath = new vscode.ThemeIcon("circle-small");
  return item;
}

function statusLineItem(line) {
  const parsed = parseResultLine(line);
  if (!parsed) return infoItem(line);

  const item = new vscode.TreeItem(`${parsed.repository} / ${parsed.arch}`, vscode.TreeItemCollapsibleState.None);
  item.description = parsed.status;
  item.tooltip = `${line}\n\nClick to stream this build log.`;
  item.iconPath = new vscode.ThemeIcon(statusIcon(parsed.status));
  item.command = {
    command: "obsService.openStatusLog",
    title: "Open Build Log",
    arguments: [{ repository: parsed.repository, arch: parsed.arch }]
  };
  return item;
}

function parseResultLine(line) {
  const columns = String(line || "").trim().split(/\s+/).filter(Boolean);
  if (columns.length < 4) return undefined;
  return {
    repository: columns[0],
    arch: columns[1],
    packageName: columns[2],
    status: columns.slice(3).join(" ")
  };
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

function isSpecUri(uri) {
  return uri && uri.scheme === "file" && path.extname(uri.fsPath).toLowerCase() === SPEC_EXT;
}

function getSpecKey(uri) {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  return folder ? path.relative(folder.uri.fsPath, uri.fsPath) : uri.fsPath;
}

function collectRemoteAssetSources(text) {
  const lines = splitTextLines(text);
  const macros = parseSpecMacros(text);
  const sources = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].text.match(/^\s*(Source\d*):\s*(\S+)/i);
    if (!match) continue;

    const tag = match[1];
    const rawUrl = stripSpecInlineComment(match[2]).trim();
    if (!rawUrl) continue;

    const previousIndex = index > 0 && isRemoteAssetLine(lines[index - 1].text)
      ? index - 1
      : undefined;
    sources.push({
      tag,
      rawUrl,
      url: expandSpecMacros(rawUrl, macros),
      lineIndex: index,
      remoteAssetLineIndex: previousIndex
    });
  }

  return sources;
}

function applyRemoteAssetHashes(text, updates) {
  const lines = splitTextLines(text);
  const defaultEol = getDefaultEol(text);

  for (const update of [...updates].sort((left, right) => right.source.lineIndex - left.source.lineIndex)) {
    const lineText = remoteAssetLineText(lines[update.source.lineIndex].text, update.sha256);
    if (update.source.remoteAssetLineIndex !== undefined) {
      lines[update.source.remoteAssetLineIndex].text = lineText;
      continue;
    }

    const sourceLine = lines[update.source.lineIndex];
    lines.splice(update.source.lineIndex, 0, {
      text: lineText,
      eol: sourceLine.eol || defaultEol
    });
  }

  return lines.map((line) => `${line.text}${line.eol}`).join("");
}

function remoteAssetLineText(sourceLine, sha256) {
  const indent = String(sourceLine || "").match(/^\s*/)[0];
  return `${indent}#!RemoteAsset:  sha256:${sha256}`;
}

function isRemoteAssetLine(line) {
  return /^\s*#!RemoteAsset:\s*/i.test(String(line || ""));
}

function splitTextLines(text) {
  const lines = [];
  const value = String(text || "");
  const pattern = /(.*?)(\r\n|\n|\r|$)/g;
  let match;
  while ((match = pattern.exec(value))) {
    if (match[0] === "" && pattern.lastIndex === value.length) break;
    lines.push({ text: match[1], eol: match[2] });
    if (!match[2]) break;
  }
  return lines;
}

function getDefaultEol(text) {
  const match = String(text || "").match(/\r\n|\n|\r/);
  return match ? match[0] : "\n";
}

function getPackageGuess(specPath) {
  try {
    const text = fs.readFileSync(specPath, "utf8");
    const packageName = getSpecPackageName(text);
    if (packageName) return packageName;
  } catch {
    // Fall back to file name.
  }
  return path.basename(specPath, SPEC_EXT);
}

function getSpecPackageName(text) {
  const rawName = getSpecTagToken(text, "Name");
  if (!rawName) return "";

  const expanded = expandSpecMacros(rawName, parseSpecMacros(text));
  return cleanPackageName(expanded) || cleanPackageName(rawName);
}

function getSpecTagToken(text, tag) {
  const tagPattern = new RegExp(`^\\s*${tag}:\\s*(.+)$`, "i");
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(tagPattern);
    if (!match) continue;
    const value = stripSpecInlineComment(match[1]).trim();
    return (value.split(/\s+/)[0] || "").trim();
  }
  return "";
}

function parseSpecMacros(text) {
  const macros = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(/^%(?:global|define)\s+([A-Za-z0-9_]+)(?:\([^)]*\))?(?:\s+(.*))?$/);
    if (!match) continue;

    const name = match[1];
    const value = stripSpecInlineComment(match[2] || "").trim();
    if (!name || value.includes("%{*}")) continue;
    macros[name] = expandSpecMacros(value, macros);
  }

  for (const tag of ["Name", "Version", "Release", "Epoch"]) {
    const value = getSpecTagToken(text, tag);
    if (!value) continue;
    const expanded = expandSpecMacros(value, macros);
    macros[tag.toLowerCase()] = expanded;
    macros[tag] = expanded;
  }

  return macros;
}

function expandSpecMacros(value, macros, depth = 0) {
  if (depth > 20) return String(value || "");
  const source = String(value || "");

  const expanded = source.replace(/%\{(!?\??)([A-Za-z0-9_]+)(?::([^{}]*))?\}/g, (match, flag, name, body) => {
    const hasMacro = Object.prototype.hasOwnProperty.call(macros, name);
    if (flag === "?") {
      return hasMacro ? expandSpecMacros(body === undefined ? macros[name] : body, macros, depth + 1) : "";
    }
    if (flag === "!?") {
      return hasMacro ? "" : expandSpecMacros(body || "", macros, depth + 1);
    }
    if (!hasMacro) return match;
    return expandSpecMacros(macros[name], macros, depth + 1);
  }).replace(/(^|[^%])%([A-Za-z_][A-Za-z0-9_]*)/g, (match, prefix, name) => {
    if (!Object.prototype.hasOwnProperty.call(macros, name)) return match;
    return `${prefix}${expandSpecMacros(macros[name], macros, depth + 1)}`;
  });

  return expanded === source ? expanded : expandSpecMacros(expanded, macros, depth + 1);
}

function cleanPackageName(value) {
  const token = stripSpecInlineComment(value).trim().split(/\s+/)[0] || "";
  return token && !hasSpecMacroReference(token) ? token : "";
}

function stripSpecInlineComment(value) {
  return String(value || "").replace(/\s+#.*$/, "");
}

function resolveConfiguredPackageName(configuredName, packageGuess) {
  const configured = String(configuredName || "").trim();
  if (!configured || hasSpecMacroReference(configured)) return packageGuess || "";
  return configured;
}

function hasSpecMacroReference(value) {
  return /%\{[^}]+\}|%[A-Za-z_][A-Za-z0-9_]*/.test(String(value || ""));
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

function sanitizePathPart(value) {
  return String(value || "").replace(/[^A-Za-z0-9_.-]+/g, "_") || "unknown";
}

function normalizePath(value) {
  return String(value || "").split(path.sep).join("/");
}

function statusBelongsTo(ctx) {
  return latestStatus.key && latestStatus.key === ctx.specKey;
}

function statusIcon(summary) {
  const value = (summary || "").toLowerCase();
  if (value.includes("not created")) return "add";
  if (value.includes("failed") || value.includes("unresolvable") || value.includes("broken")) return "error";
  if (value.includes("building") || value.includes("scheduled") || value.includes("dispatching")) return "sync";
  if (value.includes("succeeded")) return "pass";
  return "pulse";
}

function summarizeResults(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return { summary: "no result output", lines: [] };

  const keys = ["failed", "unresolvable", "broken", "blocked", "building", "scheduled", "dispatching", "finished", "succeeded", "disabled", "excluded"];
  const counts = new Map();
  for (const line of lines) {
    const lower = line.toLowerCase();
    for (const key of keys) if (lower.includes(key)) counts.set(key, (counts.get(key) || 0) + 1);
  }

  const summary = keys
    .filter((key) => counts.has(key))
    .map((key) => `${key} ${counts.get(key)}`)
    .join(", ") || `${lines.length} result line${lines.length > 1 ? "s" : ""}`;
  return { summary, lines };
}

async function saveSpecMapping(specKey, values) {
  const mappings = { ...getConfig().specMappings };
  mappings[specKey] = {
    project: values.project,
    package: values.packageName,
    repository: values.repository,
    arch: values.arch,
    packageDirectory: values.packageDirectory,
    homeProject: values.homeProject
  };
  await updateSetting("specMappings", mappings);
  if (values.homeProject) await updateSetting("homeProject", values.homeProject);
}

function getConfig() {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    apiUrl: cfg.get("apiUrl", "").trim(),
    homeProject: cfg.get("homeProject", "").trim(),
    defaultProject: cfg.get("defaultProject", "").trim(),
    defaultPackage: cfg.get("defaultPackage", "").trim(),
    defaultRepository: cfg.get("defaultRepository", "").trim(),
    defaultArch: cfg.get("defaultArch", "").trim(),
    logArch: cfg.get("logArch", "x86_64").trim(),
    packageDirectory: cfg.get("packageDirectory", "").trim(),
    specMappings: cfg.get("specMappings", {}),
    autoRevealOutput: cfg.get("autoRevealOutput", true),
    statusPollingEnabled: cfg.get("statusPollingEnabled", true),
    statusRefreshIntervalSeconds: cfg.get("statusRefreshIntervalSeconds", 3),
    statusPollTimeoutSeconds: cfg.get("statusPollTimeoutSeconds", 8)
  };
}

async function updateSetting(key, value) {
  await vscode.workspace.getConfiguration(CONFIG_SECTION).update(key, value, vscode.ConfigurationTarget.Workspace);
}

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

function oscArgs(args) {
  const cfg = getConfig();
  return cfg.apiUrl ? ["-A", cfg.apiUrl, ...args] : args;
}

function childEnv() {
  return {
    ...process.env,
    PYTHONUNBUFFERED: "1",
    PYTHONIOENCODING: "utf-8"
  };
}

function ensureDirectory(dir) {
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`Directory does not exist: ${dir || "(empty)"}`);
  }
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

function parseOscUser(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const labelled = line.match(/^(?:user|username|login|registered user)\s*[:=]\s*([A-Za-z0-9_.-]+)/i);
    if (labelled) return labelled[1];
  }
  for (const line of lines) {
    const simple = line.match(/^([A-Za-z0-9_.-]+)$/);
    if (simple && !["realname", "email"].includes(simple[1].toLowerCase())) return simple[1];
  }
  return "";
}

function extractRepositoryBlocks(xmlText) {
  return Array.from(String(xmlText || "").matchAll(/<repository\b[\s\S]*?<\/repository>/g))
    .map((match) => match[0])
    .join("\n");
}

function normalizeOscError(error) {
  if (error && error.code === "ENOENT") {
    return new Error("Cannot find `osc`. Install and configure the Open Build Service osc CLI first.");
  }
  return error;
}

function quoteArg(arg) {
  if (!arg) return "''";
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(arg)) return arg;
  return `'${String(arg).replace(/'/g, "'\\''")}'`;
}

function xml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function unescapeXml(value) {
  return String(value)
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
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
