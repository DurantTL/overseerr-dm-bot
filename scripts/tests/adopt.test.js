#!/usr/bin/env node
// rTorrent adoption: name matching, label→target mapping, remote-path derivation, and the
// adoption verdict (src/adopt.js), plus the d.multicall2 listing (src/rtorrent.js) against
// a mock XML-RPC server.
// CONFIG.RTORRENT_URL is pointed at the mock XML-RPC server before the listing test below.
const assert = require('assert');
const express = require('express');

(async () => {
  const { matchTorrentsByName, adoptTargetForLabel, remoteSubpathFor, decideAdoption } = require('../../src/adopt');
  const { CONFIG } = require('../../src/config');

  // --- Name matching ---
  const torrents = [
    { name: 'Blood.Vs.Duty.S01.1080p.WEB-DL.H264-GROUP' },
    { name: 'Blood Vs Duty S02 COMPLETE 720p' },
    { name: 'Some.Other.Show.S01.1080p' },
  ];
  assert.strictEqual(matchTorrentsByName(torrents, 'Blood Vs Duty').length, 2, 'all tokens must appear, punctuation-insensitive');
  assert.strictEqual(matchTorrentsByName(torrents, 'blood duty s02').length, 1, 'case-insensitive, order-independent');
  assert.strictEqual(matchTorrentsByName(torrents, 'Blood Missing').length, 0, 'a missing token rejects the match');
  assert.deepStrictEqual(matchTorrentsByName(torrents, '   '), [], 'blank search matches nothing, not everything');

  // --- Label → target ---
  const cfg = { RTORRENT_ADOPT_LABELS: ['sonarr', 'radarr', 'tv'], SONARR_URL: 'http://s', RADARR_URL: 'http://r' };
  assert.strictEqual(adoptTargetForLabel('sonarr', cfg), 'sonarr', 'sonarr label maps to sonarr');
  assert.strictEqual(adoptTargetForLabel('  Radarr ', cfg), 'radarr', 'label is trimmed and lowercased');
  assert.strictEqual(adoptTargetForLabel('', cfg), null, 'blank label needs an admin choice');
  assert.strictEqual(adoptTargetForLabel('music', cfg), null, 'label outside RTORRENT_ADOPT_LABELS is unknown');
  assert.strictEqual(adoptTargetForLabel('tv', cfg), null, 'adoptable label that names no arr still needs a choice');
  assert.strictEqual(adoptTargetForLabel('sonarr', { ...cfg, SONARR_URL: '' }), null, 'label pointing at an unconfigured arr resolves to nothing');

  // --- Remote subpath derivation ---
  const root = '/home/localclient/Downloads';
  assert.strictEqual(remoteSubpathFor(`${root}/Blood.Vs.Duty.S01`, root), 'Blood.Vs.Duty.S01', 'folder directly under the root');
  assert.strictEqual(remoteSubpathFor(`${root}/sonarr/Blood.Vs.Duty.S01`, root), 'sonarr/Blood.Vs.Duty.S01', 'per-label subfolder is preserved');
  assert.strictEqual(remoteSubpathFor(`${root}/Single.File.mkv`, `${root}/`), 'Single.File.mkv', 'trailing slash on the root is tolerated');
  assert.strictEqual(remoteSubpathFor('/somewhere/else/Name', root), null, 'path outside the root cannot be mapped');
  assert.strictEqual(remoteSubpathFor(`${root}/../etc/passwd`, root), null, 'traversal is rejected');
  assert.strictEqual(remoteSubpathFor(`${root}/a/../b`, root), null, 'embedded traversal is rejected');
  assert.strictEqual(remoteSubpathFor(`${root}/Name`, ''), null, 'no root configured means no mapping');

  // --- Adoption verdict ---
  const t = (over = {}) => ({ hash: 'ABC123', name: 'Blood.Vs.Duty.S01', complete: true, ...over });
  let v = decideAdoption({ torrent: t(), existingJob: { id: 7, state: 'downloading' }, target: 'sonarr' });
  assert.deepStrictEqual({ ok: v.ok, dup: v.dup }, { ok: false, dup: true }, 'an info-hash already in grab_jobs is refused');
  assert.ok(/#7/.test(v.why), 'duplicate verdict names the existing job');
  v = decideAdoption({ torrent: t(), existingJob: null, target: null });
  assert.deepStrictEqual({ ok: v.ok, needsTarget: v.needsTarget }, { ok: false, needsTarget: true }, 'no target means admin approval, never a guess');
  v = decideAdoption({ torrent: t({ name: '../evil' }), existingJob: null, target: 'sonarr' });
  assert.strictEqual(v.ok, false, 'unsafe names are refused');
  v = decideAdoption({ torrent: t(), existingJob: null, target: 'sonarr' });
  assert.deepStrictEqual(v, { ok: true, state: 'complete', mediaType: 'tv' }, 'complete torrent starts at complete, sonarr means tv');
  v = decideAdoption({ torrent: t({ complete: false }), existingJob: null, target: 'radarr' });
  assert.deepStrictEqual(v, { ok: true, state: 'downloading', mediaType: 'movie' }, 'incomplete torrent starts at downloading, radarr means movie');

  // --- d.multicall2 listing against a mock XML-RPC endpoint ---
  const xmlValue = v2 => typeof v2 === 'number' ? `<i8>${v2}</i8>` : `<string>${v2}</string>`;
  const xmlRow = row => `<value><array><data>${row.map(c => `<value>${xmlValue(c)}</value>`).join('')}</data></array></value>`;
  const rows = [
    ['abcdef0123456789', 'Blood.Vs.Duty.S01', 1, 'sonarr', '/home/localclient/Downloads/Blood.Vs.Duty.S01', 5000, 5000, 0],
    ['fedcba9876543210', 'Half.Done.Movie.2020', 0, '', '/home/localclient/Downloads/Half.Done.Movie.2020.mkv', 9000, 4500, 123],
  ];
  const app = express();
  app.use(express.text({ type: '*/*' }));
  let lastBody = '';
  app.post('/rpc', (req, res) => {
    lastBody = req.body;
    res.type('text/xml').send(`<?xml version="1.0"?><methodResponse><params><param><value><array><data>${rows.map(xmlRow).join('')}</data></array></value></param></params></methodResponse>`);
  });
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  CONFIG.RTORRENT_URL = `http://127.0.0.1:${server.address().port}/rpc`;
  const { listRtorrentTorrents } = require('../../src/rtorrent');

  const listed = await listRtorrentTorrents();
  assert.ok(lastBody.includes('<methodName>d.multicall2</methodName>') && lastBody.includes('<string>d.custom1=</string>'), 'multicall requests the label field');
  assert.strictEqual(listed.length, 2, 'every row becomes a torrent');
  assert.deepStrictEqual(listed[0], {
    hash: 'ABCDEF0123456789', name: 'Blood.Vs.Duty.S01', complete: true, label: 'sonarr',
    basePath: '/home/localclient/Downloads/Blood.Vs.Duty.S01', sizeBytes: 5000, doneBytes: 5000, downRate: 0,
  }, 'fields map by position, hash uppercased');
  assert.strictEqual(listed[1].complete, false, 'd.complete=0 maps to false');
  assert.strictEqual(listed[1].label, '', 'blank label survives as an empty string');

  server.close();
  console.log('ok - adopt');
})().catch(err => { console.error('FAILED adopt:', err.message); process.exit(1); });
