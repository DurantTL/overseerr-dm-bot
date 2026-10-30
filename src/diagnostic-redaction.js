'use strict';

// For HTTP output of the edge diagnostics (GET /admin/doctor/edge): the checks whose detail can
// carry raw rclone stderr, which is untrusted free text. Their detail is cut to its first
// non-empty line, with URLs and anything shaped like user@host replaced. The Discord /doctor
// command shows the same checks unredacted (admin-only, ephemeral), so nothing changes there.
const RCLONE_DETAIL_CHECKS = new Set(['rclone binary', 'Philippines free space', 'Philippines cache read']);

function redactRcloneDetail(detail) {
  const first = String(detail ?? '').split(/\r?\n/).find(line => line.trim());
  if (!first) return '';
  return first.trim()
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/gi, '<url>')
    .replace(/[^\s@'"<>]+@[^\s@'"<>:/]+/g, '<user@host>');
}

function redactEdgeChecksForHttp(checks) {
  return (checks || []).map(c => (RCLONE_DETAIL_CHECKS.has(c.name) ? { ...c, detail: redactRcloneDetail(c.detail) } : c));
}

module.exports = { RCLONE_DETAIL_CHECKS, redactRcloneDetail, redactEdgeChecksForHttp };
