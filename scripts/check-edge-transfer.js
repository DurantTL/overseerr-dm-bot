#!/usr/bin/env node
const { runEdgeDiagnostics } = require('../src/edge-diagnostics');

const json = process.argv.includes('--json');
const live = !process.argv.includes('--config-only');
runEdgeDiagnostics({ live }).then(checks => {
  if (json) process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
  else for (const c of checks) process.stdout.write(`${c.status === 'ok' ? 'OK  ' : c.status === 'warn' ? 'WARN' : 'FAIL'}  ${c.name}: ${c.detail}\n`);
  if (checks.some(c => c.status === 'fail')) process.exitCode = 1;
}).catch(err => {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
});
