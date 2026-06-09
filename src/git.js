"use strict";

const cp = require("child_process");
const path = require("path");

function createGitApi({ getOutput, runToolCapture, vscode }) {
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
      getOutput().appendLine(`[warning] Could not verify remote branch '${revision}': ${message}`);
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

  return {
    ensureRemoteRevisionAvailable,
    getCurrentGitBranch,
    getGitRemoteUrl,
    requireCurrentRevision,
    requireGitRepositoryUrl
  };
}

function getGitRootSync(cwd) {
  const result = cp.spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8"
  });
  if (result.status !== 0) return "";
  return String(result.stdout || "").trim();
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

module.exports = {
  createGitApi,
  getGitRootSync
};
