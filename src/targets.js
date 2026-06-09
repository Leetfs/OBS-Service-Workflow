"use strict";

function createTargetsApi({
  commandCwd,
  getConfig,
  getLatestStatus,
  getOutput,
  oscArgs,
  requireContext,
  runToolCapture,
  saveSpecMapping,
  statusBelongsTo,
  updateSetting,
  vscode
}) {
  function getLogArch(ctx) {
    const cfg = getConfig();
    return ctx.arch || cfg.logArch || cfg.defaultArch || "x86_64";
  }

  function inferRepositoryForArch(ctx, arch) {
    if (!ctx || !statusBelongsTo(ctx) || !arch) return "";
    const wanted = String(arch).toLowerCase();

    for (const line of getLatestStatus().lines || []) {
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
      getOutput().appendLine(`[warning] Could not read OBS repositories for ${ctx.project}: ${message}`);
    }

    const cfg = getConfig();
    return uniqueTargets([
      ...targets.map((target) => ({ ...target, source: "from OBS project metadata" })),
      ...getStatusBuildTargets().map((target) => ({ ...target, source: "from latest build status" })),
      current.currentRepository && current.currentArch
        ? { repository: current.currentRepository, arch: current.currentArch, source: "current selection" }
        : undefined,
      cfg.defaultRepository
        ? { repository: cfg.defaultRepository, arch: current.currentArch || cfg.defaultArch || "x86_64", source: "workspace default" }
        : undefined
    ]);
  }

  async function listBuildTargets(project, cwd) {
    if (!project) return [];
    const result = await runToolCapture("osc", oscArgs(["meta", "prj", project]), commandCwd(cwd), 15000);
    return parseBuildTargets(result.stdout || "");
  }

  function getStatusBuildTargets() {
    return (getLatestStatus().lines || []).map((line) => {
      const columns = String(line).trim().split(/\s+/).filter(Boolean);
      return columns.length >= 2 ? { repository: columns[0], arch: columns[1] } : undefined;
    }).filter(Boolean);
  }

  return {
    getLogArch,
    inferRepositoryForArch,
    inferRepositoryForArchFromObs,
    setLogArch
  };
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

function unescapeXml(value) {
  return String(value)
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

module.exports = {
  createTargetsApi
};
