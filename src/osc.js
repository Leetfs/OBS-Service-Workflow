"use strict";

const cp = require("child_process");
const fs = require("fs");

function createOscApi({
  commandCwd,
  getConfig,
  getLatestStatus,
  getOutput,
  getWorkspaceCwd,
  renderStatusBar,
  setStatus,
  statusBelongsTo,
  vscode
}) {
  let activeProcess;
  let pollingProcess;

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
    const output = getOutput();

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
    const output = getOutput();
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

  async function waitForBuildToStart(ctx, repository, arch, control, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    const output = getOutput();
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
        getOutput().append(data.toString("utf8"));
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
      return statusBelongsTo(ctx) ? getLatestStatus().summary : "";
    }
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

  function stopRunningCommand() {
    if (!activeProcess) {
      vscode.window.showInformationMessage("No OBS command is running.");
      return;
    }

    activeProcess.kill();
    activeProcess = undefined;
    getOutput().appendLine("");
    getOutput().appendLine("[stopped] Active OBS command stopped.");
  }

  function stopActiveLogStream(silent) {
    if (!activeProcess || activeProcess.kind !== "buildLog") return false;
    activeProcess.silentStop = Boolean(silent);
    activeProcess.kill();
    activeProcess = undefined;
    return true;
  }

  function isPolling() {
    return Boolean(pollingProcess);
  }

  function dispose() {
    if (activeProcess) activeProcess.kill();
    if (pollingProcess) pollingProcess.kill();
  }

  function oscArgs(args) {
    const cfg = getConfig();
    return cfg.apiUrl ? ["-A", cfg.apiUrl, ...args] : args;
  }

  return {
    dispose,
    isPolling,
    oscArgs,
    runCapture,
    runOsc,
    runToolCapture,
    stopRunningCommand,
    streamBuildLog
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

module.exports = {
  createOscApi,
  summarizeResults
};
