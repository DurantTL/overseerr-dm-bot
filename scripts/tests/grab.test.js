#!/usr/bin/env node
// AvistaZ direct grab: release parsing/scoring, allowance math, and the grab-job state
// machine (src/grab.js), plus the XML-RPC codec and bencode info-hash (src/rtorrent.js).
// Both modules are db-free, so they're imported directly; the Prowlarr calls run against a
// mock express server via the injectable cfg parameter.
const assert = require('assert');
const crypto = require('crypto');
const express = require('express');

(async () => {
  const { parseReleaseName, scoreAvistazResult, rankAvistazResults, grabAllowance, decideGrabJobAction, grabImportTarget, findAvistazIndexer, searchAvistaz } = require('../../src/grab');
  const { serializeXmlRpcCall, parseXmlRpcResponse, computeInfoHash } = require('../../src/rtorrent');

  // --- Release-name parsing ---
  let p = parseReleaseName('My.Father.is.Strange.S01.1080p.WEB-DL.H264.AAC-AGK');
  assert.deepStrictEqual({ season: p.season, episode: p.episode, pack: p.seasonPack, res: p.resolution, src: p.source },
    { season: 1, episode: null, pack: true, res: '1080p', src: 'webdl' }, 'season pack parses');
  p = parseReleaseName('Some.Show.S02E05.720p.HDTV.x264');
  assert.deepStrictEqual({ season: p.season, episode: p.episode, pack: p.seasonPack, res: p.resolution, src: p.source },
    { season: 2, episode: 5, pack: false, res: '720p', src: 'hdtv' }, 'single episode parses');
  p = parseReleaseName('Great.Movie.2019.2160p.BluRay.REMUX');
  assert.deepStrictEqual({ year: p.year, res: p.resolution, src: p.source }, { year: 2019, res: '2160p', src: 'bluray' }, 'movie year/quality parses');
  p = parseReleaseName('Old.Drama.Complete.Series.1080p.WEBRip');
  assert.strictEqual(p.seasonPack, true, '"complete" without SxxExx counts as a pack');

  // --- Scoring ---
  const tvCtx = { title: 'My Father Is Strange', mediaType: 'tv', season: 1 };
  const mk = (title, over = {}) => ({ title, size: 38 * 1024 ** 3, seeders: 12, downloadUrl: 'http://x/dl', ...over });
  const pack1080 = scoreAvistazResult(mk('My.Father.is.Strange.S01.1080p.WEB-DL.H264.AAC-AGK'), tvCtx);
  const pack720 = scoreAvistazResult(mk('My.Father.is.Strange.S01.720p.WEB-DL', { size: 19 * 1024 ** 3 }), tvCtx);
  const episode = scoreAvistazResult(mk('My.Father.is.Strange.S01E03.1080p.WEB-DL', { size: 1 * 1024 ** 3 }), tvCtx);
  const dead = scoreAvistazResult(mk('My.Father.is.Strange.S01.1080p.WEB-DL', { seeders: 0 }), tvCtx);
  const wrongSeason = scoreAvistazResult(mk('My.Father.is.Strange.S03.1080p.WEB-DL'), tvCtx);
  assert.ok(pack1080.confidence > pack720.confidence, '1080p pack outranks 720p pack');
  assert.ok(pack720.confidence > episode.confidence, 'season pack outranks single episode');
  assert.ok(pack1080.confidence >= 90, `well-matched pack scores high (got ${pack1080.confidence})`);
  assert.ok(dead.confidence <= 40, `zero seeders caps confidence (got ${dead.confidence})`);
  assert.ok(dead.notes.includes('no seeders'), 'dead torrent is flagged');
  assert.ok(wrongSeason.confidence < pack1080.confidence - 10, 'wrong season is penalized');

  const movieCtx = { title: 'Great Movie', mediaType: 'movie', year: 2019 };
  const rightYear = scoreAvistazResult(mk('Great.Movie.2019.1080p.WEB-DL', { size: 8 * 1024 ** 3 }), movieCtx);
  const wrongYear = scoreAvistazResult(mk('Great.Movie.2007.1080p.WEB-DL', { size: 8 * 1024 ** 3 }), movieCtx);
  assert.ok(rightYear.confidence > wrongYear.confidence, 'year match beats year mismatch');
  const freeleech = scoreAvistazResult(mk('Great.Movie.2019.1080p.WEB-DL', { size: 8 * 1024 ** 3, indexerFlags: ['FreeLeech'] }), movieCtx);
  assert.ok(freeleech.confidence > rightYear.confidence, 'freeleech adds points');
  assert.strictEqual(freeleech.freeleech, true, 'freeleech flag detected case-insensitively');

  // Ranking: sorted by confidence, capped, and undownloadable results dropped.
  const ranked = rankAvistazResults([
    mk('My.Father.is.Strange.S01.720p.WEB-DL'),
    mk('My.Father.is.Strange.S01.1080p.WEB-DL.H264.AAC-AGK'),
    mk('My.Father.is.Strange.S01.1080p.NoUrl', { downloadUrl: null }),
    mk('Unrelated.Show.S05.480p.HDTV', { seeders: 0 }),
  ], tvCtx);
  assert.strictEqual(ranked.length, 3, 'result with no downloadUrl is dropped');
  assert.ok(ranked[0].releaseTitle.includes('1080p'), 'best candidate first');
  assert.ok(ranked[0].confidence >= ranked[1].confidence && ranked[1].confidence >= ranked[2].confidence, 'sorted by confidence');

  // Prowlarr-reported info-hashes ride along (uppercased) for the pre-download dup check.
  const withHash = rankAvistazResults([mk('My.Father.is.Strange.S01.1080p.WEB-DL', { infoHash: 'abc123def' })], tvCtx);
  assert.strictEqual(withHash[0].infoHash, 'ABC123DEF', 'infoHash preserved and uppercased');
  assert.strictEqual(ranked[0].infoHash, null, 'missing infoHash is null, not undefined');

  // --- Import target: don't download what can never be imported ---
  assert.strictEqual(grabImportTarget('movie', { RADARR_URL: 'http://r', SONARR_URL: '' }), 'radarr', 'movie imports via radarr');
  assert.strictEqual(grabImportTarget('movie', { RADARR_URL: '', SONARR_URL: 'http://s' }), null, 'movie without radarr refused');
  assert.strictEqual(grabImportTarget('tv', { RADARR_URL: '', SONARR_URL: 'http://s' }), 'sonarr', 'tv imports via sonarr');
  assert.strictEqual(grabImportTarget('tv', { RADARR_URL: 'http://r', SONARR_URL: '' }), null, 'tv without sonarr refused');

  // --- Allowance ---
  assert.deepStrictEqual(grabAllowance(0, 4), { limited: true, remaining: 4, exhausted: false }, 'fresh day');
  assert.deepStrictEqual(grabAllowance(4, 4), { limited: true, remaining: 0, exhausted: true }, 'limit reached');
  assert.deepStrictEqual(grabAllowance(9, 4), { limited: true, remaining: 0, exhausted: true }, 'over the limit clamps to 0');
  assert.deepStrictEqual(grabAllowance(99, 0), { limited: false, remaining: null, exhausted: false }, '0 = unlimited');

  // --- Grab-job state machine ---
  const MIN = 60000;
  const cfg = { missingAfterMinutes: 10, downloadTimeoutHours: 72 };
  const row = (over = {}) => ({ state: 'sent', sent_at: 0, ...over });
  assert.strictEqual(decideGrabJobAction(row(), { reachable: false }, 5 * MIN, cfg), 'wait', 'unreachable seedbox never fails a job');
  assert.strictEqual(decideGrabJobAction(row(), { reachable: true, found: false }, 5 * MIN, cfg), 'wait', 'missing inside grace period waits');
  assert.strictEqual(decideGrabJobAction(row(), { reachable: true, found: false }, 11 * MIN, cfg), 'fail_missing', 'missing past grace period fails');
  assert.strictEqual(decideGrabJobAction(row(), { reachable: true, found: true, complete: false }, 5 * MIN, cfg), 'mark_downloading', 'sent → downloading once seen');
  assert.strictEqual(decideGrabJobAction(row({ state: 'downloading' }), { reachable: true, found: true, complete: false }, 5 * MIN, cfg), 'wait', 'downloading keeps waiting');
  assert.strictEqual(decideGrabJobAction(row({ state: 'downloading' }), { reachable: true, found: true, complete: true }, 5 * MIN, cfg), 'transfer', 'complete triggers the transfer');
  assert.strictEqual(decideGrabJobAction(row({ state: 'downloading' }), { reachable: true, found: true, complete: false }, 73 * 60 * MIN, cfg), 'fail_timeout', 'stuck forever times out');
  assert.strictEqual(decideGrabJobAction(row({ state: 'downloading' }), { reachable: true, found: true, complete: true }, 73 * 60 * MIN, cfg), 'transfer', 'a late completion still transfers');

  // --- XML-RPC codec ---
  const call = serializeXmlRpcCall('load.raw_start', ['', Buffer.from('torrentbytes'), 'd.custom1.set=sonarr']);
  assert.ok(call.includes('<methodName>load.raw_start</methodName>'), 'method name serialized');
  assert.ok(call.includes(`<base64>${Buffer.from('torrentbytes').toString('base64')}</base64>`), 'buffers become base64');
  assert.ok(call.includes('<string>d.custom1.set=sonarr</string>'), 'label command serialized');
  assert.strictEqual(parseXmlRpcResponse('<methodResponse><params><param><value><string>0.9.8</string></value></param></params></methodResponse>'), '0.9.8', 'string response parses');
  assert.strictEqual(parseXmlRpcResponse('<methodResponse><params><param><value><i8>1</i8></value></param></params></methodResponse>'), 1, 'i8 response parses');
  assert.deepStrictEqual(
    parseXmlRpcResponse('<methodResponse><params><param><value><array><data><value><i8>7</i8></value><value><string>a&amp;b</string></value></data></array></value></param></params></methodResponse>'),
    [7, 'a&b'], 'array response parses with entity unescape');
  assert.throws(
    () => parseXmlRpcResponse('<methodResponse><fault><value><struct><member><name>faultCode</name><value><i8>-501</i8></value></member><member><name>faultString</name><value><string>Could not find info-hash.</string></value></member></struct></value></fault></methodResponse>'),
    err => err.fault && err.fault.faultCode === -501 && /info-hash/.test(err.fault.faultString),
    'faults throw with the parsed struct attached');

  // --- bencode info-hash ---
  // info dict placed mid-file to prove the walker skips keys before and after it.
  const infoDict = 'd6:lengthi123e4:name9:test0.mkve';
  const torrent = Buffer.from(`d8:announce13:http://a/anno4:info${infoDict}5:extra3:abce`, 'latin1');
  const expected = crypto.createHash('sha1').update(Buffer.from(infoDict, 'latin1')).digest('hex').toUpperCase();
  assert.strictEqual(computeInfoHash(torrent), expected, 'info-hash is sha1 of the raw info dict');
  assert.throws(() => computeInfoHash(Buffer.from('d3:foo3:bare')), /no info dict/, 'missing info dict throws');
  assert.throws(() => computeInfoHash(Buffer.from('<html>not a torrent</html>')), /not a bencoded/, 'HTML error pages are rejected');

  // --- Prowlarr calls against a mock server ---
  const app = express();
  const seen = { searches: [] };
  app.get('/api/v1/indexer', (req, res) => res.json([{ id: 3, name: 'Nyaa' }, { id: 7, name: 'AvistaZ (API)' }]));
  app.get('/api/v1/search', (req, res) => { seen.searches.push(req.query); res.json([{ title: 'Result.S01.1080p', size: 1024, seeders: 3, downloadUrl: 'http://x' }]); });
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const cfgMock = { PROWLARR_URL: `http://127.0.0.1:${server.address().port}`, PROWLARR_API_KEY: 'pk', AVISTAZ_INDEXER_NAME: 'avistaz' };

  const indexer = await findAvistazIndexer(cfgMock);
  assert.strictEqual(indexer.id, 7, 'AvistaZ indexer found by case-insensitive substring');
  const results = await searchAvistaz({ query: 'My Father Is Strange', mediaType: 'tv', indexerId: indexer.id }, cfgMock);
  assert.strictEqual(results.length, 1, 'search returns results');
  assert.strictEqual(seen.searches[0].indexerIds, '7', 'search scoped to the AvistaZ indexer');
  assert.strictEqual(seen.searches[0].categories, '5000', 'tv searches use the TV category');

  server.close();
  console.log('ok - grab');
})().catch(err => { console.error('FAILED grab:', err.message); process.exit(1); });
