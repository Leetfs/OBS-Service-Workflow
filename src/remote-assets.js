"use strict";

const crypto = require("crypto");
const http = require("http");
const https = require("https");
const path = require("path");

const {
  applyRemoteAssetHashes,
  collectRemoteAssetSources,
  hasSpecMacroReference
} = require("./spec");

async function updateRemoteAssets({ getConfig, output, resolveContext, setStatus, vscode }) {
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

  const cfg = getConfig();
  if (cfg.autoRevealOutput) output.show(true);
  output.appendLine("");
  output.appendLine(`[remote-asset] Updating ${remoteSources.length} Source asset${remoteSources.length > 1 ? "s" : ""} for ${path.basename(ctx.specPath)}.`);

  for (const source of sources.filter((source) => !/^https?:\/\//i.test(source.url))) {
    output.appendLine(`[remote-asset] Skipping ${source.tag}: ${source.rawUrl}`);
  }

  setStatus("$(sync~spin) OBS: update RemoteAsset hashes");
  const updates = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "Updating RemoteAsset SHA256",
    cancellable: false
  }, (progress) => downloadSourceHashes(remoteSources, progress, output));

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

async function downloadSourceHashes(sources, progress, output) {
  const results = [];
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    progress.report({ message: `${index + 1}/${sources.length} ${source.tag}` });
    output.appendLine(`[remote-asset] ${source.tag}: ${source.url}`);
    const result = await downloadSha256(source.url);
    output.appendLine(`[remote-asset] ${source.tag}: sha256:${result.sha256} (${result.bytes} bytes)`);
    results.push({ source, sha256: result.sha256 });
  }
  return results;
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

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return Promise.reject(new Error(`Unsupported Source URL protocol: ${parsed.protocol}`));
  }

  return new Promise((resolve, reject) => {
    const request = requestUrl(parsed, (response) => {
      const statusCode = response.statusCode || 0;
      const location = response.headers.location;
      if ([301, 302, 303, 307, 308].includes(statusCode) && location) {
        response.resume();
        resolve(downloadSha256(new URL(location, parsed).toString(), redirectCount + 1));
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        reject(new Error(`Failed to download ${url}: HTTP ${statusCode}.`));
        return;
      }

      hashResponse(response).then(resolve, reject);
    });

    request.setTimeout(120000, () => {
      request.destroy(new Error(`Timed out downloading ${url}.`));
    });
    request.on("error", reject);
  });
}

function requestUrl(url, onResponse) {
  const transport = url.protocol === "http:" ? http : https;
  return transport.get(url, {
    headers: {
      "User-Agent": "OBS-Service-Workflow",
      "Accept": "*/*"
    }
  }, onResponse);
}

function hashResponse(response) {
  return new Promise((resolve, reject) => {
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
}

module.exports = {
  downloadSha256,
  updateRemoteAssets
};
