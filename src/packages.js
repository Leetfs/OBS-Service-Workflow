"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const SERVICE_FILE = "_service";

function createPackagesApi({
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
}) {
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

    return promptRequired("Existing OBS subproject", `${homeProject}:`);
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

  function getServiceExtractPath(ctx) {
    const specDir = path.dirname(ctx.specPath);
    const root = getGitRootSync(specDir) || (getWorkspaceFolder() ? getWorkspaceFolder().uri.fsPath : "");
    const relative = root ? path.relative(root, specDir) : path.basename(specDir);
    const normalized = normalizePath(relative && relative !== "." ? relative : "");
    return normalized ? `${normalized}/*` : "*";
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

  return {
    askHomeProject,
    chooseCreateTarget,
    ensureProjectExists,
    getServiceExtractPath,
    remotePackageExists,
    remoteProjectExists,
    writeAndCommitServiceFile
  };
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

function xml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

module.exports = {
  createPackagesApi
};
