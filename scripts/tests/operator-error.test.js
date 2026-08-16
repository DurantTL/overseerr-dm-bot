#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');

const fixtures = require('./fixtures/transfer-errors.json');
const { OPERATOR_DIAGNOSTIC_LIMITS, OPERATOR_EMBED_LIMITS, boundOperatorLabel, formatOperatorError } = require('../../src/operator-error');
const { loadSandbox } = require('./extract');

test('operator error: repeated retry output collapses to one safe cause', () => {
  const result = formatOperatorError(new Error(fixtures.repeatedPermission));
  assert.strictEqual(result.cause, 'Permission denied opening the destination path.');
  assert.strictEqual(result.attempts, '3/3 attempts failed');
  assert.strictEqual(result.diagnostic.split('\n').length, 1);
  assert.match(result.diagnostic, /…\/file\.mkv/);
  assert.doesNotMatch(result.diagnostic, /\/mnt\/private|2026\/08\/16|Attempt [123]\/3/);
});

test('operator error: mixed retries retain distinct causes within documented bounds', () => {
  const result = formatOperatorError(fixtures.mixedRetry);
  assert.strictEqual(result.attempts, '3/3 attempts failed');
  assert.deepStrictEqual(result.diagnostic.split('\n'), ['connection refused', 'context deadline exceeded']);
  assert.ok(result.diagnostic.length <= OPERATOR_DIAGNOSTIC_LIMITS.maxChars);
  assert.ok(result.diagnostic.split('\n').length <= OPERATOR_DIAGNOSTIC_LIMITS.maxLines);
});

test('operator error: credentials, tokens, and absolute host paths are redacted', () => {
  const result = formatOperatorError(fixtures.sensitive);
  assert.doesNotMatch(result.diagnostic, /fixture-password|fixture-token|fixture-bearer|fixture-key|\/mnt\/private/);
  assert.match(result.diagnostic, /sftp:\/\/\[redacted\]/);
  assert.match(result.diagnostic, /token=\[redacted\]/);
  assert.match(result.diagnostic, /…\/file\.mkv/);
});

test('operator error: unknown and non-Error values produce a useful fallback', () => {
  assert.match(formatOperatorError(null).cause, /Unknown/i);
  assert.match(formatOperatorError({ status: 503, reason: 'remote unavailable' }).cause, /remote unavailable/);
  const long = formatOperatorError('x'.repeat(OPERATOR_DIAGNOSTIC_LIMITS.maxChars + 50));
  assert.match(long.cause, /unrecognized error/i);
  assert.strictEqual(long.diagnostic, 'Additional diagnostic omitted; see server logs.');
});

test('operator error: primary causes are stable across common transfer failures', () => {
  const cases = [
    ['mkdir /srv/private/release: operation not permitted', 'Permission denied opening the destination path.'],
    ['write failed: no space left on device', 'The transfer destination is out of disk space.'],
    ['dial tcp: connection refused', 'The remote connection was refused.'],
    ['sftp authentication failed', 'Authentication to the remote service failed.'],
    ['copy context deadline exceeded', 'The transfer timed out.'],
    ['source directory not found', 'A required transfer path was not found.'],
  ];
  for (const [input, expected] of cases) {
    assert.strictEqual(formatOperatorError(input).cause, expected, input);
  }
});

test('operator error: retry-count syntaxes are summarized consistently', () => {
  const cases = [
    ['Attempt 2/4 failed with 1 errors and: timeout', '2/4 attempts failed'],
    ['4/4 attempts failed: timeout', '4/4 attempts failed'],
    ['attempt 1 failed\nattempt 3 failed', '3 attempts failed'],
    ['plain command failure', '1 attempt failed'],
  ];
  for (const [input, expected] of cases) {
    assert.strictEqual(formatOperatorError(input).attempts, expected, input);
  }
});

test('operator error: redaction handles credential, path, and Discord-markup variants', () => {
  const cases = [
    ['C:\\Private\\Incoming\\release.mkv: access is denied', /C:\\Private|Incoming/, /…\/release\.mkv/],
    ['copy "/srv/private/Media Library/Example/file.mkv": disk full', /\/srv\/private|Media Library/, /"…\/file\.mkv"/],
    ['password=fixture-pass sessionId="fixture-session"', /fixture-pass|fixture-session/, /\[redacted\]/],
    ['eyJabcdefghijk.abcdefghijklmnop.qrstuvwxyz12345', /eyJabcdefghijk/, /\[redacted token\]/],
    ['``` @everyone', /```|@everyone/, /''' @\u200beveryone/],
  ];
  for (const [input, forbidden, expected] of cases) {
    const diagnostic = formatOperatorError(input).diagnostic;
    assert.doesNotMatch(diagnostic, forbidden, input);
    assert.match(diagnostic, expected, input);
  }
});

test('operator error: diagnostic bounds keep only complete, deduplicated lines', () => {
  const duplicate = formatOperatorError('ERROR: first failure\nerror: FIRST FAILURE\nsecond failure');
  assert.deepStrictEqual(duplicate.diagnostic.split('\n'), ['first failure', 'second failure']);

  const lineBounded = formatOperatorError('one\ntwo\nthree\nfour');
  assert.deepStrictEqual(lineBounded.diagnostic.split('\n'), ['one', 'two', 'three']);

  const longLine = 'x'.repeat(100);
  const charBounded = formatOperatorError(`first complete line\n${longLine}\nlast complete line`, { maxLines: 3, maxChars: 80 });
  assert.deepStrictEqual(charBounded.diagnostic.split('\n'), ['first complete line', 'last complete line']);
  assert.doesNotMatch(charBounded.diagnostic, /x{1,99}/, 'an oversized line is omitted, never sliced');

  for (const result of [duplicate, lineBounded, charBounded]) {
    assert.ok(result.diagnostic.length <= OPERATOR_DIAGNOSTIC_LIMITS.maxChars);
    assert.ok(result.diagnostic.split('\n').length <= OPERATOR_DIAGNOSTIC_LIMITS.maxLines);
  }
});

test('operator error: labels are single-line and bounded without splitting the limit', () => {
  assert.strictEqual(boundOperatorLabel(' first\nsecond ', 20), 'first second');
  assert.strictEqual(boundOperatorLabel('x'.repeat(20), 20), 'x'.repeat(20));
  assert.strictEqual(boundOperatorLabel('x'.repeat(21), 20), `${'x'.repeat(19)}…`);
});

async function renderTransferFailure(job, error) {
  const notices = [];
  const logged = [];
  let next = job;
  class FakeButton {
    setCustomId() { return this; }
    setLabel() { return this; }
    setStyle() { return this; }
  }
  class FakeRow {
    addComponents() { return this; }
  }
  const sandbox = loadSandbox(['pumpGrabTransfers'], {
    nextTransferableGrabJob: () => { const value = next; next = null; return value; },
    runGrabTransfer: async () => { throw error; },
    setGrabJobState: () => {},
    audit: () => {},
    notifyChannel: (_channel, message) => notices.push(message),
    brandedEmbed: () => ({
      setTitle(value) { this.title = value; return this; },
      setDescription(value) { this.description = value; return this; },
    }),
    COLORS: { DANGER: 1 },
    ActionRowBuilder: FakeRow,
    ButtonBuilder: FakeButton,
    ButtonStyle: { Primary: 1 },
    OPERATOR_EMBED_LIMITS,
    boundOperatorLabel,
    formatOperatorError,
    log: { error: (...args) => logged.push(args) },
  });
  sandbox.run('var grabTransferActive = false');
  await sandbox.pumpGrabTransfers();
  return { embed: notices[0].embeds[0], logged };
}

test('seedbox transfer embed uses the operator summary and logs full diagnostics with job ID', async () => {
  const job = { id: 42, title: 'Example', release_title: 'Example.Release.1080p' };
  const { embed, logged } = await renderTransferFailure(job, new Error(fixtures.repeatedPermission));
  const description = embed.description;
  assert.match(description, /Permission denied opening the destination path\./);
  assert.match(description, /3\/3 attempts failed/);
  assert.strictEqual(description.match(/Example\.Release\.1080p/g).length, 1, 'release title appears once');
  assert.doesNotMatch(description, /\/mnt\/private|Attempt [123]\/3/);
  assert.ok(description.length < 4096, 'embed description stays within Discord limits');
  assert.match(logged[0][0], /job #42/);
  assert.ok(logged[0][1] instanceof Error);
  assert.match(logged[0][1].message, /\/mnt\/private/, 'the complete error remains in server logs');
});

test('seedbox transfer embed stays inside Discord limits for worst-case bounded input', async () => {
  const job = { id: 99, title: 'T'.repeat(1000), release_title: 'R'.repeat(5000) };
  const rawLines = Array.from({ length: 20 }, (_value, index) => `failure ${index}: ${'x'.repeat(100)}`).join('\n');
  const { embed } = await renderTransferFailure(job, new Error(rawLines));

  assert.ok(embed.title.length <= OPERATOR_EMBED_LIMITS.title);
  assert.ok(embed.description.length <= OPERATOR_EMBED_LIMITS.description);
  assert.match(embed.title, /…$/, 'an oversized title ends with an explicit ellipsis');
  assert.match(embed.description, new RegExp(`\\*\\*Release:\\*\\* R{${OPERATOR_EMBED_LIMITS.label - 1}}…`));

  const diagnostic = embed.description.match(/```text\n([\s\S]*?)\n```/)[1];
  assert.ok(diagnostic.length <= OPERATOR_DIAGNOSTIC_LIMITS.maxChars);
  assert.ok(diagnostic.split('\n').length <= OPERATOR_DIAGNOSTIC_LIMITS.maxLines);
  for (const line of diagnostic.split('\n')) {
    assert.ok(rawLines.includes(line), 'every diagnostic line is complete source output');
  }
});

test('PH staging failure uses the same safe retry summary without changing the requester DM', async () => {
  const notices = [];
  const directMessages = [];
  const audits = [];
  const finished = [];
  const job = { id: 77, media_id: 'tmdb:77', media_type: 'movie', title: 'Example', requested_by_discord_id: '123' };
  class FakeButton {
    setCustomId() { return this; }
    setLabel() { return this; }
    setStyle() { return this; }
  }
  class FakeRow {
    addComponents() { return this; }
  }
  const sandbox = loadSandbox(['runStageJob'], {
    resolveStageSource: async () => ({ found: true, srcPath: '/source/Example', destSubPath: 'Movies/Example', sizeBytes: 1024 }),
    getStagedItem: () => null,
    markStageJobCopying: () => {},
    listStagedItems: () => [],
    getCacheStatus: async () => ({ freeBytes: 10000 }),
    planCacheSpace: () => ({ ok: true, evict: [] }),
    stageCopy: async () => ({ ok: false, error: fixtures.repeatedPermission }),
    finishStageJob: (...args) => finished.push(args),
    audit: (action, detail) => audits.push({ action, detail }),
    notifyChannel: (channel, message) => notices.push({ channel, message }),
    dmUser: (discordId, message) => { directMessages.push({ discordId, message }); },
    CONFIG: { STAGE_MIN_FREE_GB: 1, STAGE_JOB_TIMEOUT_MINUTES: 30 },
    fmtSpace: String,
    brandedEmbed: () => ({
      setTitle(value) { this.title = value; return this; },
      setDescription(value) { this.description = value; return this; },
    }),
    COLORS: { DANGER: 1 },
    ActionRowBuilder: FakeRow,
    ButtonBuilder: FakeButton,
    ButtonStyle: { Primary: 1 },
    OPERATOR_EMBED_LIMITS,
    boundOperatorLabel,
    formatOperatorError,
  });

  await sandbox.runStageJob(job);

  const alert = notices[0].message.embeds[0];
  assert.strictEqual(notices[0].channel, 'system');
  assert.match(alert.description, /Permission denied opening the destination path\./);
  assert.match(alert.description, /3\/3 attempts failed/);
  assert.doesNotMatch(alert.description, /\/mnt\/private|Attempt [123]\/3/);
  assert.ok(alert.title.length <= OPERATOR_EMBED_LIMITS.title);
  assert.ok(alert.description.length <= OPERATOR_EMBED_LIMITS.description);
  assert.deepStrictEqual(finished[0], [job.id, 'failed', fixtures.repeatedPermission]);
  assert.strictEqual(audits[0].detail.jobId, job.id, 'the audit record carries the stage-job correlation ID');
  assert.match(directMessages[0].message.embeds[0].description, /admin has been notified/i);
  assert.doesNotMatch(directMessages[0].message.embeds[0].description, /permission denied/i);
});
