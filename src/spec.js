"use strict";

const fs = require("fs");
const path = require("path");

const SPEC_EXT = ".spec";

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

function resolveConfiguredPackageName(configuredName, packageGuess) {
  const configured = String(configuredName || "").trim();
  if (!configured || hasSpecMacroReference(configured)) return packageGuess || "";
  return configured;
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

    sources.push({
      tag,
      rawUrl,
      url: expandSpecMacros(rawUrl, macros),
      lineIndex: index,
      remoteAssetLineIndex: index > 0 && isRemoteAssetLine(lines[index - 1].text) ? index - 1 : undefined
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

function getSpecPackageName(text) {
  const rawName = getSpecTagToken(text, "Name");
  if (!rawName) return "";

  const expanded = expandSpecMacros(rawName, parseSpecMacros(text));
  return cleanPackageName(expanded) || cleanPackageName(rawName);
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

function cleanPackageName(value) {
  const token = stripSpecInlineComment(value).trim().split(/\s+/)[0] || "";
  return token && !hasSpecMacroReference(token) ? token : "";
}

function stripSpecInlineComment(value) {
  return String(value || "").replace(/\s+#.*$/, "");
}

function hasSpecMacroReference(value) {
  return /%\{[^}]+\}|%[A-Za-z_][A-Za-z0-9_]*/.test(String(value || ""));
}

module.exports = {
  applyRemoteAssetHashes,
  collectRemoteAssetSources,
  expandSpecMacros,
  getPackageGuess,
  getSpecPackageName,
  hasSpecMacroReference,
  parseSpecMacros,
  resolveConfiguredPackageName
};
