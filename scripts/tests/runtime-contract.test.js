#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('app, agent image, package, CI, and installer agree on Node 24', () => {
  assert.equal(require('../../package.json').engines.node, '>=24 <25');
  assert.match(read('Dockerfile'), /^FROM node:24-/m);
  assert.match(read('agent/Dockerfile'), /^FROM node:24-/m);
  assert.match(read('.github/workflows/test.yml'), /node-version: 24/);
  assert.match(read('.github/workflows/build-image.yml'), /node-version: 24/);
  assert.match(read('agent/install.sh.tmpl'), /setup_24\.x/);
  assert.doesNotMatch(read('agent/install.sh.tmpl'), /setup_(18|20|22)\.x/);
});

test('agent source is text-safe and covered by normal syntax and lint gates', () => {
  const agent = fs.readFileSync(path.join(root, 'agent/agent.js'));
  assert.equal(agent.includes(0), false, 'agent source must not contain literal NUL bytes');
  assert.match(read('package.json'), /node --check agent\/agent\.js/);
  assert.doesNotMatch(read('eslint.config.js'), /agent\/\*\*/);
  assert.match(read('.github/workflows/test.yml'), /context: agent/);
});
