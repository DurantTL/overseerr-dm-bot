// Shared helper for the test suite: pulls real function source out of index.js and evaluates it
// in a vm sandbox with stubbed dependencies. This tests the shipped code (not a copy) without
// booting Discord/Express or opening the SQLite database.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const INDEX_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'index.js'), 'utf8');

// Extract a top-level `function name(...) {...}` by scanning past the parameter list (which may
// contain destructuring braces) and then brace-matching the body.
function extractFn(name) {
  const m = INDEX_SRC.match(new RegExp(`(?:async )?function ${name}\\(`));
  if (!m) throw new Error(`function ${name} not found in index.js`);
  let i = INDEX_SRC.indexOf('(', m.index), parens = 0;
  for (; i < INDEX_SRC.length; i++) {
    if (INDEX_SRC[i] === '(') parens++;
    else if (INDEX_SRC[i] === ')') { parens--; if (parens === 0) break; }
  }
  let depth = 0;
  for (i = INDEX_SRC.indexOf('{', i); i < INDEX_SRC.length; i++) {
    if (INDEX_SRC[i] === '{') depth++;
    else if (INDEX_SRC[i] === '}') { depth--; if (depth === 0) return INDEX_SRC.slice(m.index, i + 1); }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

// Build a vm context preloaded with the named index.js functions plus caller-provided stubs.
function loadSandbox(fnNames, stubs = {}) {
  const sandbox = {
    console, Set, Array, String, Number, Promise, JSON, Object, Date, Math, RegExp, Buffer,
    setTimeout, clearTimeout,
    ...stubs,
  };
  vm.createContext(sandbox);
  for (const name of fnNames) vm.runInContext(extractFn(name), sandbox);
  sandbox.run = code => vm.runInContext(code, sandbox);
  return sandbox;
}

module.exports = { extractFn, loadSandbox };
