#!/usr/bin/env node
// Test runner: executes every *.test.js in this directory plus the security helper script.
// Each file is a standalone node script that exits non-zero on failure.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort()
  .map(f => path.join(__dirname, f));
files.push(path.join(__dirname, '..', 'test-security.js'));

let failed = 0;
for (const file of files) {
  const res = spawnSync(process.execPath, [file], { stdio: 'inherit' });
  if (res.status !== 0) failed++;
}
if (failed) {
  console.error(`\n${failed} test file(s) failed`);
  process.exit(1);
}
console.log(`\nAll ${files.length} test file(s) passed`);
