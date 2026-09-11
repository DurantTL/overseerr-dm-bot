#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const entrypoints = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'DEPLOYMENT.md', 'agent/README.md'];

function markdownFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(full);
    return entry.isFile() && entry.name.endsWith('.md') ? [full] : [];
  });
}

function localDestination(raw) {
  const destination = raw.trim().replace(/^<|>$/g, '').split(/\s+['"]/)[0];
  if (!destination || destination.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(destination)) return null;
  return decodeURIComponent(destination.split('#')[0]);
}

const files = [...entrypoints.map(file => path.join(root, file)), ...markdownFiles(path.join(root, 'docs'))];
const failures = [];

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  for (const match of source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const destination = localDestination(match[1]);
    if (!destination) continue;
    const target = path.resolve(path.dirname(file), destination);
    if (!target.startsWith(`${root}${path.sep}`) && target !== root) {
      failures.push(`${path.relative(root, file)}: local link escapes the repository: ${match[1]}`);
    } else if (!fs.existsSync(target)) {
      failures.push(`${path.relative(root, file)}: missing local link target: ${match[1]}`);
    }
  }
}

for (const required of ['LICENSE', 'SECURITY.md', 'CONTRIBUTING.md']) {
  if (!fs.existsSync(path.join(root, required))) failures.push(`missing required public-repository file: ${required}`);
}

if (failures.length) {
  console.error(`Documentation drift check failed:\n- ${failures.join('\n- ')}`);
  process.exitCode = 1;
} else {
  console.log(`Documentation drift check passed (${files.length} Markdown files).`);
}
