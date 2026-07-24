// ../cfg-shared/dist/code-editor/json-document.js
function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const offset = extractOffset(message, text);
    const { line, column } = offsetToLineColumn(text, offset);
    return { ok: false, error: { message, offset, line, column } };
  }
}
function extractOffset(message, text) {
  const byPosition = /at position (\d+)/.exec(message);
  if (byPosition)
    return clamp(Number(byPosition[1]), 0, text.length);
  const byLineCol = /at line (\d+) column (\d+)/.exec(message);
  if (byLineCol)
    return lineColumnToOffset(text, Number(byLineCol[1]), Number(byLineCol[2]));
  return text.length;
}
function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
function offsetToLineColumn(text, offset) {
  const capped = clamp(offset, 0, text.length);
  let line = 1;
  let lastBreak = -1;
  for (let i = 0; i < capped; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lastBreak = i;
    }
  }
  return { line, column: capped - lastBreak };
}
function lineColumnToOffset(text, line, column) {
  let offset = 0;
  let seen = 1;
  while (seen < line) {
    const next = text.indexOf("\n", offset);
    if (next === -1)
      return text.length;
    offset = next + 1;
    seen++;
  }
  return clamp(offset + column - 1, 0, text.length);
}
function formatJson(value, indent = 2) {
  return JSON.stringify(value, null, indent);
}
function formatJsonText(text, indent = 2) {
  const parsed = parseJson(text);
  if (!parsed.ok)
    return { ok: false, text };
  return { ok: true, text: formatJson(parsed.value, indent) };
}
function checkFoundryDoc(value, rules = {}) {
  const issues = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [{ severity: "error", message: "Document must be a JSON object." }];
  }
  const doc = value;
  if (rules.expectedId !== void 0) {
    const id = doc._id;
    if (id === void 0) {
      issues.push({ severity: "warning", message: "`_id` is missing; the existing id will be kept." });
    } else if (id !== rules.expectedId) {
      issues.push({
        severity: "error",
        message: `\`_id\` must stay "${rules.expectedId}" \u2014 changing it would orphan this document.`
      });
    }
  }
  for (const key of rules.requiredKeys ?? []) {
    if (!(key in doc)) {
      issues.push({ severity: "error", message: `Required key \`${key}\` is missing.` });
    }
  }
  return issues;
}
function canSaveDocument(text, rules = {}) {
  const parsed = parseJson(text);
  if (!parsed.ok)
    return false;
  return !checkFoundryDoc(parsed.value, rules).some((i) => i.severity === "error");
}

// ../cfg-shared/dist/code-editor/system-schema.js
var DEFAULT_IGNORED = [];
function checkAgainstSystemSchema(value, descriptor, opts = {}) {
  if (!descriptor)
    return [];
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return [];
  const doc = value;
  const type = typeof doc.type === "string" ? doc.type : null;
  if (!type)
    return [];
  const schema = descriptor.types[type];
  if (!schema)
    return [];
  const system = doc.system;
  if (system === null || typeof system !== "object" || Array.isArray(system))
    return [];
  const allowed = new Set(schema.fields);
  const ignored = new Set(opts.ignoreKeys ?? DEFAULT_IGNORED);
  const present = Object.keys(system);
  const issues = [];
  const dropped = present.filter((k) => !allowed.has(k) && !ignored.has(k));
  if (dropped.length > 0) {
    issues.push({
      severity: "warning",
      message: `${dropped.length === 1 ? "Field" : "Fields"} not valid on a "${type}" and will be DISCARDED when saved to the world: ${dropped.map((k) => `\`${k}\``).join(", ")}. Foundry drops these without an error \u2014 move anything worth keeping under \`flags\` first.`
    });
  }
  const missing = (schema.required ?? []).filter((k) => !(k in system));
  if (missing.length > 0) {
    issues.push({
      severity: "error",
      message: `A "${type}" requires ${missing.map((k) => `\`system.${k}\``).join(", ")}, ${missing.length === 1 ? "which is" : "which are"} missing.`
    });
  }
  const sys = system;
  const blank = (schema.requiredNonEmpty ?? []).filter((k) => isBlank(sys[k]));
  if (blank.length > 0) {
    issues.push({
      severity: "error",
      message: `${blank.map((k) => `\`system.${k}\``).join(", ")} ${blank.length === 1 ? "is" : "are"} empty on this "${type}". The document will load, but anything relying on ${blank.length === 1 ? "that value" : "those values"} \u2014 attaching a subclass to its class, for instance \u2014 will not work until ${blank.length === 1 ? "it is" : "they are"} set.`
    });
  }
  return issues;
}
function isBlank(value) {
  if (value === void 0 || value === null)
    return true;
  return typeof value === "string" && value.trim() === "";
}
export {
  canSaveDocument,
  checkAgainstSystemSchema,
  checkFoundryDoc,
  formatJson,
  formatJsonText,
  lineColumnToOffset,
  offsetToLineColumn,
  parseJson
};
