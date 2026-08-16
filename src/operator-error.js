'use strict';

// Discord diagnostics must stay readable on a phone. Only complete, deduplicated lines are
// included; a line that does not fit is omitted instead of being cut in the middle.
const OPERATOR_DIAGNOSTIC_LIMITS = Object.freeze({ maxLines: 3, maxChars: 360 });
const OPERATOR_EMBED_LIMITS = Object.freeze({ title: 256, description: 4096, label: 300 });
const MAX_OPERATOR_INPUT_CHARS = 12000;
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');

function errorText(error) {
  if (error instanceof Error) return error.message || error.name || 'Unknown error';
  if (typeof error === 'string') return error;
  if (error && typeof error.message === 'string') return error.message;
  if (error === null || error === undefined) return 'Unknown error';
  try {
    const encoded = JSON.stringify(error);
    return encoded && encoded !== '{}' ? encoded : String(error);
  } catch (_err) {
    return String(error);
  }
}

function safePathTail(value) {
  const normalized = value.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts.length ? `…/${parts.at(-1)}` : '[path]';
}

function boundOperatorLabel(value, maxChars = OPERATOR_EMBED_LIMITS.label) {
  const text = String(value ?? '').replace(/\r?\n/g, ' ').trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function redactOperatorText(value) {
  let text = String(value || '').slice(0, MAX_OPERATOR_INPUT_CHARS);
  text = text.replace(ANSI_ESCAPE, '');
  text = text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@[^\s/]+/gi, '$1[redacted]');
  text = text.replace(/\b(authorization\s*[:=]\s*)(?:bearer|basic)\s+[^\s,;]+/gi, '$1[redacted]');
  text = text.replace(/((?:api[_-]?key|access[_-]?key|token|secret|password|passwd|pwd|session(?:id|_id)?)["']?\s*[:=]\s*["']?)([^&\s,;"']+)/gi, '$1[redacted]');
  // Input is explicitly bounded above; these expressions preserve complete credential/path
  // tokens so sensitive fragments cannot survive in the operator-facing diagnostic.
  // eslint-disable-next-line security/detect-unsafe-regex
  text = text.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?\b/g, '[redacted token]');
  // eslint-disable-next-line security/detect-unsafe-regex
  text = text.replace(/(["'`])(\/(?:[^\r\n/]+\/)+[^\r\n]+?)\1/g, (_match, quote, pathValue) => `${quote}${safePathTail(pathValue)}${quote}`);
  // eslint-disable-next-line security/detect-unsafe-regex
  text = text.replace(/(^|[\s("'=\]])(\/(?:[^/\s:"'`,]+\/)+[^/\s:"'`,)\]}]+)/gm,
    (_match, prefix, pathValue) => `${prefix}${safePathTail(pathValue)}`);
  // eslint-disable-next-line security/detect-unsafe-regex
  text = text.replace(/\b[A-Za-z]:\\(?:[^\\\s:"'`,]+\\)+[^\\\s:"'`,)\]}]+/g, pathValue => safePathTail(pathValue));
  return text.replace(/```/g, "'''").replace(/@/g, '@\u200b');
}

function normalizeDiagnosticLine(line) {
  let normalized = String(line || '').slice(0, MAX_OPERATOR_INPUT_CHARS).replace(ANSI_ESCAPE, '').trim();
  // eslint-disable-next-line security/detect-unsafe-regex
  normalized = normalized.replace(/^\d{4}[/-]\d{2}[/-]\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:\s+[+-]\d{4})?\s*/, '');
  normalized = normalized.replace(/^(?:ERROR|WARN(?:ING)?|INFO|DEBUG|NOTICE)\s*:?\s*/i, '');
  // eslint-disable-next-line security/detect-unsafe-regex
  normalized = normalized.replace(/^Attempt\s+\d+\s*\/\s*\d+\s+failed(?:\s+with\s+\d+\s+errors?)?(?:\s+and:)?\s*/i, '');
  return redactOperatorText(normalized).trim();
}

function attemptSummary(raw) {
  let completed = 0;
  let total = 0;
  for (const match of raw.matchAll(/\battempt\s+(\d+)\s*\/\s*(\d+)\s+failed\b/gi)) {
    completed = Math.max(completed, Number(match[1]));
    total = Math.max(total, Number(match[2]));
  }
  for (const match of raw.matchAll(/\b(\d+)\s*\/\s*(\d+)\s+attempts?\s+failed\b/gi)) {
    completed = Math.max(completed, Number(match[1]));
    total = Math.max(total, Number(match[2]));
  }
  if (total > 0) return `${completed}/${total} attempts failed`;

  for (const match of raw.matchAll(/\battempt\s+(\d+)\s+failed\b/gi)) {
    completed = Math.max(completed, Number(match[1]));
  }
  return completed > 1 ? `${completed} attempts failed` : '1 attempt failed';
}

function primaryCause(lines) {
  const joined = lines.join(' ');
  if (/permission denied|access is denied|operation not permitted/i.test(joined)) {
    return 'Permission denied opening the destination path.';
  }
  if (/no space left|disk (?:is )?full|insufficient (?:disk )?space/i.test(joined)) {
    return 'The transfer destination is out of disk space.';
  }
  if (/connection refused/i.test(joined)) return 'The remote connection was refused.';
  if (/authentication failed|invalid credentials|unauthorized/i.test(joined)) {
    return 'Authentication to the remote service failed.';
  }
  if (/timed? out|deadline exceeded/i.test(joined)) return 'The transfer timed out.';
  if (/no such file|path not found|directory not found/i.test(joined)) {
    return 'A required transfer path was not found.';
  }

  const candidate = lines.find(line => line.length <= 180);
  return candidate || 'Transfer failed with an unrecognized error. See server logs for full details.';
}

function boundedDiagnostic(lines, limits) {
  const selected = [];
  let chars = 0;
  let omitted = false;
  for (const line of lines) {
    if (selected.length >= limits.maxLines) { omitted = true; break; }
    const nextChars = chars + (selected.length ? 1 : 0) + line.length;
    if (line.length > limits.maxChars || nextChars > limits.maxChars) { omitted = true; continue; }
    selected.push(line);
    chars = nextChars;
  }
  if (!selected.length && omitted) return 'Additional diagnostic omitted; see server logs.';
  return selected.join('\n');
}

function formatOperatorError(error, limits = OPERATOR_DIAGNOSTIC_LIMITS) {
  const raw = errorText(error).slice(0, MAX_OPERATOR_INPUT_CHARS).replace(/\r\n?/g, '\n');
  const unique = [];
  const seen = new Set();
  for (const rawLine of raw.split('\n')) {
    const line = normalizeDiagnosticLine(rawLine);
    if (!line) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(line);
  }
  if (!unique.length) unique.push('Unknown transfer error.');

  const safeLimits = {
    maxLines: Math.max(1, Number(limits.maxLines) || OPERATOR_DIAGNOSTIC_LIMITS.maxLines),
    maxChars: Math.max(80, Number(limits.maxChars) || OPERATOR_DIAGNOSTIC_LIMITS.maxChars),
  };
  return {
    cause: primaryCause(unique),
    attempts: attemptSummary(raw),
    diagnostic: boundedDiagnostic(unique, safeLimits),
  };
}

module.exports = { OPERATOR_DIAGNOSTIC_LIMITS, OPERATOR_EMBED_LIMITS, boundOperatorLabel, formatOperatorError, redactOperatorText };
