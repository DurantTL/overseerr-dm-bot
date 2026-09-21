#!/usr/bin/env node
// POST /api/v1/seedbox/import-force takes a caller-supplied absolute `destination`, creates it,
// and copies over whatever is already there. These tests pin the containment guard that keeps an
// agent token from writing outside the configured media roots — /app/data (the SQLite database
// and its backups) being the case that matters most — and the path-only Sonarr series match.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');
const { createApp, listen, close } = require('../../src/app');
const {
  registerAgentApiRoutes,
  importDestinationRoots,
  resolveSafeImportDestination,
} = require('../../src/routes/agent-api');
const { sha256, safeEqual } = require('../../src/util');

function post(port, path, token, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function get(port, path, token, query = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'GET',
      path: path + query,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

// import-force answers 202 before the copy runs, so every outcome assertion polls the job to a
// terminal state first. Bounded so a hung worker fails the test instead of hanging the suite.
async function waitForJob(port, token, jobId) {
  for (let i = 0; i < 200; i++) {
    const res = await get(port, '/api/v1/seedbox/import-status', token, `?jobId=${encodeURIComponent(jobId)}`);
    assert.strictEqual(res.statusCode, 200, 'the job stays readable while it runs');
    const job = JSON.parse(res.body);
    if (job.status !== 'running') return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`import job ${jobId} never left "running"`);
}

// A staging dir holding one file to copy, a media root that is the only legal destination, and a
// sibling dir outside it. Sonarr's series list is injected after setup (the fixture paths aren't
// known until the temp dirs exist), same shape as setManualImportPreview in agent-api-routes.
function setup({ configOverrides = {} } = {}) {
  const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'import-force-'));
  const staging = nodePath.join(tmp, 'staging');
  const mediaRoot = nodePath.join(tmp, 'media');
  const outside = nodePath.join(tmp, 'outside');
  fs.mkdirSync(nodePath.join(staging, 'Season 4'), { recursive: true });
  fs.mkdirSync(mediaRoot, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(nodePath.join(staging, 'Season 4', 'ep01.mkv'), 'payload');
  const tokenHash = sha256('valid-agent-token');
  const auditCalls = [];
  const sonarrPosts = [];
  let sonarrSeries = [];
  const app = createApp();
  registerAgentApiRoutes(app, {
    config: {
      AGENT_API_READ_MAX_PER_MINUTE: 1000,
      AGENT_API_WRITE_MAX_PER_MINUTE: 1000,
      GRAB_STAGING_PATH: staging,
      RAID_PATH: mediaRoot,
      SONARR_URL: 'http://sonarr:8989',
      SONARR_API_KEY: 'sonarr-key',
      ...configOverrides,
    },
    getAgentApiTokenHashes: () => [tokenHash],
    getAgentApiTokenLabel: hash => (hash === tokenHash ? 'test-client' : null),
    touchAgentApiTokenUse: () => {},
    sha256,
    safeEqual,
    audit: (action, details) => auditCalls.push({ action, details }),
    gatherHealth: async () => ({ overall: 'ok' }),
    fetchArrQueues: async () => [],
    fetchSeerrRequests: async () => [],
    getPlexToken: async () => 'plex-token',
    getPlexServers: async () => [],
    httpRateLimitKey: () => 'test',
    httpClient: {
      get: async url => {
        if (String(url).includes('/api/v3/series')) return { data: sonarrSeries };
        return { data: {} };
      },
      post: async (url, body) => { sonarrPosts.push({ url, body }); return { data: { id: 1 } }; },
    },
  });
  return {
    app,
    auditCalls,
    sonarrPosts,
    tmp,
    staging,
    mediaRoot,
    outside,
    setSonarrSeries: series => { sonarrSeries = series; },
  };
}

// Drives one import-force request against a fresh fixture and cleans the temp tree up after.
async function withServer(fixture, fn) {
  const server = await listen(fixture.app, 0);
  try {
    return await fn(server.address().port);
  } finally {
    await close(server);
    fs.rmSync(fixture.tmp, { recursive: true, force: true });
  }
}

test('import-force destination guard: the resolver contains paths and resolves symlinks', t => {
  const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'import-force-unit-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = nodePath.join(tmp, 'media');
  const outside = nodePath.join(tmp, 'outside');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });

  const inside = resolveSafeImportDestination(nodePath.join(root, 'Show', 'Season 4'), [root]);
  assert.strictEqual(inside.ok, true, 'a path under the root is allowed even before it exists');
  assert.strictEqual(inside.path, nodePath.join(root, 'Show', 'Season 4'));

  assert.strictEqual(resolveSafeImportDestination(root, [root]).ok, true, 'the root itself is allowed');

  assert.strictEqual(resolveSafeImportDestination(outside, [root]).reason, 'outside_roots');
  assert.strictEqual(resolveSafeImportDestination('/app/data', [root]).reason, 'outside_roots',
    'the bot data dir is never a destination');
  assert.strictEqual(resolveSafeImportDestination(`${root}/../outside`, [root]).reason, 'outside_roots',
    'traversal out of the root is rejected after normalization');
  assert.strictEqual(resolveSafeImportDestination(`${root}mediaish`, [root]).reason, 'outside_roots',
    'a sibling sharing the root as a string prefix is not inside it');
  assert.strictEqual(resolveSafeImportDestination('relative/path', [root]).reason, 'not_absolute');
  assert.strictEqual(resolveSafeImportDestination('', [root]).reason, 'not_absolute');
  assert.strictEqual(resolveSafeImportDestination(`${root}/x\0y`, [root]).reason, 'not_absolute',
    'a NUL byte is rejected rather than truncated');
  assert.strictEqual(resolveSafeImportDestination(root, []).reason, 'no_roots',
    'with nothing configured the endpoint refuses rather than allowing everything');

  // A symlink inside the root pointing out of it must not launder the destination.
  fs.symlinkSync(outside, nodePath.join(root, 'escape'));
  const viaSymlink = resolveSafeImportDestination(nodePath.join(root, 'escape', 'Season 4'), [root]);
  assert.strictEqual(viaSymlink.reason, 'outside_roots', 'a symlinked parent cannot escape the root');
});

test('import-force destination guard: roots come from the configured media and import paths', () => {
  assert.deepStrictEqual(
    importDestinationRoots({ RAID_PATH: '/mnt/raid', GRAB_IMPORT_PATH: '/arr/imports' }),
    ['/mnt/raid', '/arr/imports'],
  );
  assert.deepStrictEqual(
    importDestinationRoots({ IMPORT_FORCE_DEST_ROOTS: ['/share/media'], RAID_PATH: '/mnt/raid' }),
    ['/share/media', '/mnt/raid'],
    'the explicit override is honoured alongside the derived roots',
  );
  assert.deepStrictEqual(
    importDestinationRoots({ IMPORT_FORCE_DEST_ROOTS: '/a, /b' }),
    ['/a', '/b'],
    'a comma-separated string works too, for a raw env value',
  );
  assert.deepStrictEqual(importDestinationRoots({}), [], 'nothing configured means no roots');
  assert.deepStrictEqual(importDestinationRoots(), [], 'a missing config object does not throw');
});

test('import-force refuses a destination outside the media roots and copies nothing', async () => {
  const fixture = setup();
  await withServer(fixture, async port => {
    const res = await post(port, '/api/v1/seedbox/import-force', 'valid-agent-token', {
      folder: 'Season 4',
      destination: fixture.outside,
      target: 'sonarr',
    });
    assert.strictEqual(res.statusCode, 400, 'an out-of-root destination is refused');
    assert.match(JSON.parse(res.body).error, /outside every allowed media root/);
    assert.deepStrictEqual(fs.readdirSync(fixture.outside), [], 'nothing was copied to the refused path');
    const refusal = fixture.auditCalls.find(
      c => c.action === 'agent_api_seedbox_import_force' && c.details.ok === false,
    );
    assert.ok(refusal, 'the refusal is audited');
    assert.strictEqual(refusal.details.reason, 'destination_outside_roots');
    assert.strictEqual(refusal.details.actor, 'agent:test-client');
  });
});

// GRAB_STAGING_PATH is required for the endpoint to run at all and is itself a root, so the
// roots list is never empty here — with RAID_PATH cleared, staging is the only legal destination.
// (The empty-roots refusal is covered on the resolver directly, above.)
test('import-force falls back to the staging root when no media root is configured', async () => {
  const fixture = setup({ configOverrides: { RAID_PATH: '' } });
  await withServer(fixture, async port => {
    const refused = await post(port, '/api/v1/seedbox/import-force', 'valid-agent-token', {
      folder: 'Season 4',
      destination: nodePath.join(fixture.mediaRoot, 'Show'),
      target: 'sonarr',
    });
    assert.strictEqual(refused.statusCode, 400, 'the media root is no longer allowed once unset');
    assert.match(JSON.parse(refused.body).error, /outside every allowed media root/);

    const allowed = await post(port, '/api/v1/seedbox/import-force', 'valid-agent-token', {
      folder: 'Season 4',
      destination: nodePath.join(fixture.staging, 'imported'),
      target: 'sonarr',
    });
    assert.strictEqual(allowed.statusCode, 202, 'the staging root itself stays a legal destination');
  });
});

test('import-force copies into an allowed destination and rescans the matching series', async () => {
  const fixture = setup();
  const seriesPath = nodePath.join(fixture.mediaRoot, 'Some Show');
  fixture.setSonarrSeries([
    { id: 7, title: 'Some Show', path: seriesPath },
    { id: 42, title: 'Bleach', path: nodePath.join(fixture.mediaRoot, 'Bleach') },
  ]);
  await withServer(fixture, async port => {
    const destination = nodePath.join(seriesPath, 'Season 4');
    const res = await post(port, '/api/v1/seedbox/import-force', 'valid-agent-token', {
      folder: 'Season 4',
      destination,
      target: 'sonarr',
    });
    assert.strictEqual(res.statusCode, 202, 'an in-root destination is accepted for background work');
    const accepted = JSON.parse(res.body);
    assert.ok(accepted.jobId, 'the caller gets a job id to poll');
    assert.strictEqual(accepted.status, 'running');
    const job = await waitForJob(port, 'valid-agent-token', accepted.jobId);
    assert.strictEqual(job.status, 'done');
    assert.strictEqual(job.copied, 1);
    assert.strictEqual(job.error, null, 'a clean run carries no error');
    assert.strictEqual(
      fs.readFileSync(nodePath.join(destination, 'ep01.mkv'), 'utf8'),
      'payload',
      'the file landed in the allowed destination',
    );
    assert.strictEqual(fixture.sonarrPosts.length, 1, 'one rescan fires');
    assert.strictEqual(fixture.sonarrPosts[0].body.name, 'RescanSeries');
    assert.strictEqual(fixture.sonarrPosts[0].body.seriesId, 7, 'the series containing the destination');
  });
});

test('import-force never falls back to a hardcoded series when no path matches', async () => {
  const fixture = setup();
  // The old code fell back to `title === 'bleach'`, so any unmatched destination rescanned Bleach.
  fixture.setSonarrSeries([
    { id: 42, title: 'Bleach', path: '/some/other/library/Bleach' },
    // Shares a string prefix with the destination's parent but is a different folder.
    { id: 43, title: 'Unrelated', path: nodePath.join(fixture.mediaRoot, 'Unrelated') },
  ]);
  await withServer(fixture, async port => {
    const res = await post(port, '/api/v1/seedbox/import-force', 'valid-agent-token', {
      folder: 'Season 4',
      destination: nodePath.join(fixture.mediaRoot, 'Unrelated Show', 'Season 4'),
      target: 'sonarr',
    });
    assert.strictEqual(res.statusCode, 202);
    const job = await waitForJob(port, 'valid-agent-token', JSON.parse(res.body).jobId);
    assert.strictEqual(job.status, 'done');
    assert.deepStrictEqual(
      fixture.sonarrPosts,
      [],
      'a destination outside every series path must not rescan an unrelated series',
    );
    assert.match(job.message, /Could not find matching series/);
  });
});

test('import-status: unknown job ids are 404, and the recent list is newest-first', async () => {
  const fixture = setup();
  await withServer(fixture, async port => {
    const missing = await get(port, '/api/v1/seedbox/import-status', 'valid-agent-token', '?jobId=import-nope');
    assert.strictEqual(missing.statusCode, 404, 'an unknown job id is a 404, not an empty 200');
    assert.match(JSON.parse(missing.body).error, /No import job with that id/);

    const empty = await get(port, '/api/v1/seedbox/import-status', 'valid-agent-token');
    assert.deepStrictEqual(JSON.parse(empty.body).jobs, [], 'no jobs yet lists nothing');

    const first = JSON.parse((await post(port, '/api/v1/seedbox/import-force', 'valid-agent-token', {
      folder: 'Season 4', destination: nodePath.join(fixture.mediaRoot, 'A'), target: 'sonarr',
    })).body);
    await waitForJob(port, 'valid-agent-token', first.jobId);
    const second = JSON.parse((await post(port, '/api/v1/seedbox/import-force', 'valid-agent-token', {
      folder: 'Season 4', destination: nodePath.join(fixture.mediaRoot, 'B'), target: 'sonarr',
    })).body);
    await waitForJob(port, 'valid-agent-token', second.jobId);

    const listed = JSON.parse((await get(port, '/api/v1/seedbox/import-status', 'valid-agent-token')).body);
    assert.strictEqual(listed.jobs.length, 2);
    assert.strictEqual(listed.jobs[0].jobId, second.jobId, 'newest first');
    assert.strictEqual(listed.jobs[1].jobId, first.jobId);
  });
});

test('import-status is behind the read limiter like every other GET here', async () => {
  const fixture = setup({ configOverrides: { AGENT_API_READ_MAX_PER_MINUTE: 1 } });
  await withServer(fixture, async port => {
    const first = await get(port, '/api/v1/seedbox/import-status', 'valid-agent-token', '?jobId=import-nope');
    assert.strictEqual(first.statusCode, 404, 'the first read is admitted (and finds no such job)');
    const second = await get(port, '/api/v1/seedbox/import-status', 'valid-agent-token', '?jobId=import-nope');
    assert.strictEqual(second.statusCode, 429, 'polling shares the read budget rather than being unbounded');
  });
});

test('a failed import reports an errno, never the raw error text or paths', async () => {
  const fixture = setup();
  // A plain file where the destination directory would go: mkdir -p fails with ENOTDIR. The
  // path is still inside the media root, so the containment check passes and the worker runs.
  const blocker = nodePath.join(fixture.mediaRoot, 'blocker');
  fs.writeFileSync(blocker, 'not a directory');
  await withServer(fixture, async port => {
    const res = await post(port, '/api/v1/seedbox/import-force', 'valid-agent-token', {
      folder: 'Season 4',
      destination: nodePath.join(blocker, 'Season 4'),
      target: 'sonarr',
    });
    assert.strictEqual(res.statusCode, 202);
    const job = await waitForJob(port, 'valid-agent-token', JSON.parse(res.body).jobId);
    assert.strictEqual(job.status, 'failed');
    assert.strictEqual(job.errorCode, 'ENOTDIR', 'the errno is exposed so a caller can branch on it');
    assert.strictEqual(job.error, 'Import failed (ENOTDIR)', 'the message is fixed, not the raw fs error');
    assert.ok(!/not a directory/i.test(job.error), 'no raw fs error text');
    assert.strictEqual(job.copied, 0);
    // The real message stays in the audit log, where only operators read it.
    const failure = fixture.auditCalls.find(
      c => c.action === 'agent_api_seedbox_import_force' && c.details.ok === false && c.details.jobId,
    );
    assert.ok(failure, 'the failure is audited');
    assert.strictEqual(failure.details.code, 'ENOTDIR');
    assert.match(String(failure.details.error), /ENOTDIR/, 'the audit keeps the full error');
    assert.strictEqual(failure.details.actor, 'agent:test-client');
  });
});

test('the destination guard still runs before a background job is created', async () => {
  const fixture = setup();
  await withServer(fixture, async port => {
    const res = await post(port, '/api/v1/seedbox/import-force', 'valid-agent-token', {
      folder: 'Season 4',
      destination: '/app/data',
      target: 'sonarr',
    });
    assert.strictEqual(res.statusCode, 400, 'refused synchronously, not accepted as a job');
    assert.strictEqual(JSON.parse(res.body).jobId, undefined, 'no job id is handed out for a refused path');
    const listed = JSON.parse((await get(port, '/api/v1/seedbox/import-status', 'valid-agent-token')).body);
    assert.deepStrictEqual(listed.jobs, [], 'a refused request creates no job at all');
  });
});
