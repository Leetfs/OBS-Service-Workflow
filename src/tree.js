"use strict";

class ObsTreeProvider {
  constructor({ vscode, getLatestStatus, logTargetLabel, packageLabel, resolveContextSync, statusBelongsTo }) {
    this.vscode = vscode;
    this.getLatestStatus = getLatestStatus;
    this.logTargetLabel = logTargetLabel;
    this.packageLabel = packageLabel;
    this.resolveContextSync = resolveContextSync;
    this.statusBelongsTo = statusBelongsTo;
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

    const ctx = this.resolveContextSync();
    if (!ctx) {
      return [
        this.infoItem("Open a .spec file"),
        this.actionItem("Open Output", "OBS command output", "obsService.openOutput", "terminal")
      ];
    }

    const latestStatus = this.getLatestStatus();
    const statusDescription = this.statusBelongsTo(ctx) && latestStatus.summary
      ? latestStatus.summary
      : "not refreshed";
    const statusLines = this.statusBelongsTo(ctx) ? latestStatus.lines : [];
    const statusChildren = statusLines.length
      ? statusLines.map((line) => this.statusLineItem(line))
      : [this.infoItem("No build status yet")];

    return [
      this.actionItem("Create OBS Package", "create package from this spec", "obsService.createPackage", "add"),
      this.actionItem("Update _service", "regenerate and commit only _service", "obsService.updateServiceFile", "cloud-upload"),
      this.actionItem("Update RemoteAsset", "download Source URLs and refresh sha256 lines", "obsService.updateRemoteAssets", "key"),
      this.actionItem("Delete Package", "osc rdelete immediately", "obsService.deletePackage", "trash"),
      this.actionItem("Rebuild Package", "osc rebuildpac, then show default arch log", "obsService.rebuildPackage", "refresh"),
      this.actionItem("Trigger Services", "osc service remoterun", "obsService.triggerServices", "cloud"),
      this.actionItem("Log Target", this.logTargetLabel(ctx), "obsService.setLogArch", "symbol-namespace"),
      this.groupActionItem("Build Status", statusDescription, "obsService.refreshStatus", statusIcon(latestStatus.summary), statusChildren),
      this.actionItem("OBS Target", this.packageLabel(ctx), "obsService.configureCurrentSpec", "package"),
      this.actionItem("Open Output", "OBS command output", "obsService.openOutput", "terminal"),
      this.actionItem("Stop Running Command", "stop current osc process", "obsService.stop", "debug-stop")
    ];
  }

  actionItem(label, description, command, icon) {
    const item = new this.vscode.TreeItem(label, this.vscode.TreeItemCollapsibleState.None);
    item.description = description;
    item.tooltip = description || label;
    item.iconPath = new this.vscode.ThemeIcon(icon);
    item.command = { command, title: label };
    return item;
  }

  groupActionItem(label, description, command, icon, children) {
    const item = new this.vscode.TreeItem(label, this.vscode.TreeItemCollapsibleState.Expanded);
    item.description = description;
    item.tooltip = description || label;
    item.iconPath = new this.vscode.ThemeIcon(icon);
    item.command = { command, title: label };
    item.children = children;
    return item;
  }

  infoItem(text) {
    const item = new this.vscode.TreeItem(text, this.vscode.TreeItemCollapsibleState.None);
    item.tooltip = text;
    item.iconPath = new this.vscode.ThemeIcon("circle-small");
    return item;
  }

  statusLineItem(line) {
    const parsed = parseResultLine(line);
    if (!parsed) return this.infoItem(line);

    const item = new this.vscode.TreeItem(`${parsed.repository} / ${parsed.arch}`, this.vscode.TreeItemCollapsibleState.None);
    item.description = parsed.status;
    item.tooltip = `${line}\n\nClick to stream this build log.`;
    item.iconPath = new this.vscode.ThemeIcon(statusIcon(parsed.status));
    item.command = {
      command: "obsService.openStatusLog",
      title: "Open Build Log",
      arguments: [{ repository: parsed.repository, arch: parsed.arch }]
    };
    return item;
  }
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

function statusIcon(summary) {
  const value = (summary || "").toLowerCase();
  if (value.includes("not created")) return "add";
  if (value.includes("failed") || value.includes("unresolvable") || value.includes("broken")) return "error";
  if (value.includes("building") || value.includes("scheduled") || value.includes("dispatching")) return "sync";
  if (value.includes("succeeded")) return "pass";
  return "pulse";
}

module.exports = {
  ObsTreeProvider,
  parseResultLine,
  statusIcon
};
