"use strict";

const CONFIG_SECTION = "obsService";

function createConfigApi(vscode) {
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

  return {
    getConfig,
    saveSpecMapping,
    updateSetting
  };
}

module.exports = {
  CONFIG_SECTION,
  createConfigApi
};
