#!/usr/bin/env node
// AvistaZ direct grab: release parsing/scoring, allowance math, and the grab-job state
// machine (src/grab.js), plus the XML-RPC codec and bencode info-hash (src/rtorrent.js).
// Both modules are db-free, so they're imported directly; the Prowlarr calls run against a
// mock express server via the injectable cfg parameter.
const assert = require('assert');
const crypto = require('crypto');
const express = require('express');

(async () => {
  const { parseReleaseName, scoreAvistazResult, rankAvistazResults, grabAllowance, decideGrabJobAction, grabImportTarget, findAvistazIndexer, searchAvistaz, releaseContentClaim, contentClaimsOverlap, describeContentClaim, claimCoversSeason, planSeriesGrab, describeGrabPlan } = require('../../src/grab');
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
  assert.strictEqual(p.multiSeason, true, '"complete series" with no season marker is multi-season');
  p = parseReleaseName('Old.Show.1983.S01-S05.480p.DVDRip.Complete');
  assert.deepStrictEqual({ season: p.season, end: p.seasonEnd, multi: p.multiSeason, pack: p.seasonPack },
    { season: 1, end: 5, multi: true, pack: true }, 'S01-S05 parses as a multi-season range, not season 1');
  p = parseReleaseName('Old.Show.Seasons.1-3.1080p.WEB-DL');
  assert.deepStrictEqual({ season: p.season, end: p.seasonEnd, multi: p.multiSeason, pack: p.seasonPack },
    { season: 1, end: 3, multi: true, pack: true }, 'dotted "Seasons.1-3" parses as a range');
  p = parseReleaseName('Some.Show.S02.COMPLETE.1080p.WEB-DL');
  assert.deepStrictEqual({ season: p.season, multi: p.multiSeason, pack: p.seasonPack },
    { season: 2, multi: false, pack: true }, 'a complete SINGLE season is a pack but not multi-season');

  // Old/Asian shows are routinely uploaded as a season-less episode run. Without this the
  // release parses as nothing at all and the whole-series planner never sees the only pack
  // on offer; a single-season show is the one that omits the marker, hence season 1.
  p = parseReleaseName('They.Kiss.Again.2007.E01-E30.1080p.WEB-DL.AAC.H264');
  assert.deepStrictEqual({ season: p.season, pack: p.seasonPack, ep: p.episode },
    { season: 1, pack: true, ep: null }, 'a season-less "E01-E30" run is a season-1 pack');
  assert.deepStrictEqual([...releaseContentClaim('They.Kiss.Again.2007.E01-E30.1080p.WEB-DL').seasons], [1],
    'the episode-run pack claims the whole season');
  assert.strictEqual(releaseContentClaim('They.Kiss.Again.2007.E01-E30.1080p').series, 'they kiss again',
    'the series token stops at the episode run, not at the quality tags');
  p = parseReleaseName('Some.Drama.1x05.720p.HDTV');
  assert.deepStrictEqual({ season: p.season, ep: p.episode, pack: p.seasonPack },
    { season: 1, ep: 5, pack: false }, 'the 1x05 form parses as season 1 episode 5');
  // A multi-episode file claims its whole run, so a second release of E02-E10 is a duplicate.
  p = parseReleaseName('Show.Name.S01E01-E10.1080p');
  assert.strictEqual(p.episodeEnd, 10, 'the end of a multi-episode range parses');
  assert.strictEqual(releaseContentClaim('Show.Name.S01E01-E10.1080p').episodes.size, 10, 'a multi-episode file claims every episode in it');
  assert.ok(contentClaimsOverlap(releaseContentClaim('Show.Name.S01E01-E10.1080p'), releaseContentClaim('Show.Name.S01E07.720p')),
    'an episode inside a multi-episode file is recognized as already covered');
  assert.strictEqual(parseReleaseName('Show.Name.S01E01.1080p.WEB-DL').episodeEnd, null,
    'a resolution after a single episode is not read as an episode range');

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

  // Multi-season packs: a range covering the wanted season scores as a full pack (an old show
  // may only exist as one complete-series torrent); a range that misses it is a wrong season.
  const ctxS3 = { title: 'Old Show', mediaType: 'tv', season: 3 };
  const coveringRange = scoreAvistazResult(mk('Old.Show.S01-S05.1080p.WEB-DL', { size: 60 * 1024 ** 3 }), ctxS3);
  const completeRun = scoreAvistazResult(mk('Old.Show.Complete.Series.1080p.WEB-DL', { size: 60 * 1024 ** 3 }), ctxS3);
  const missingRange = scoreAvistazResult(mk('Old.Show.S04-S05.1080p.WEB-DL', { size: 30 * 1024 ** 3 }), ctxS3);
  assert.ok(coveringRange.confidence >= 90, `range covering the wanted season scores like a pack (got ${coveringRange.confidence})`);
  assert.ok(completeRun.confidence >= 90, `complete series covers any requested season (got ${completeRun.confidence})`);
  assert.ok(missingRange.confidence <= coveringRange.confidence - 10, 'range that misses the wanted season is penalized');
  assert.ok(missingRange.notes.some(note => note.includes('wrong season')), 'missed range is flagged');
  const rankedMulti = rankAvistazResults([mk('Old.Show.S01-S05.1080p.WEB-DL')], { title: 'Old Show', mediaType: 'tv' });
  assert.deepStrictEqual({ multi: rankedMulti[0].multiSeason, s: rankedMulti[0].season, e: rankedMulti[0].seasonEnd },
    { multi: true, s: 1, e: 5 }, 'multi-season fields ride along for the candidate embeds');

  const movieCtx = { title: 'Great Movie', mediaType: 'movie', year: 2019 };
  const rightYear = scoreAvistazResult(mk('Great.Movie.2019.1080p.WEB-DL', { size: 8 * 1024 ** 3 }), movieCtx);
  const wrongYear = scoreAvistazResult(mk('Great.Movie.2007.1080p.WEB-DL', { size: 8 * 1024 ** 3 }), movieCtx);
  assert.ok(rightYear.confidence > wrongYear.confidence, 'year match beats year mismatch');
  const freeleech = scoreAvistazResult(mk('Great.Movie.2019.1080p.WEB-DL', { size: 8 * 1024 ** 3, indexerFlags: ['FreeLeech'] }), movieCtx);
  assert.ok(freeleech.confidence > rightYear.confidence, 'freeleech adds points');
  assert.strictEqual(freeleech.freeleech, true, 'freeleech flag detected case-insensitively');

  // Same-titled shows: "Full House" is a 1987 US sitcom AND a 2004 Korean drama. The TV branches
  // never looked at the year, so both scored identically and the wrong show could win a plan.
  const fhCtx = { title: 'Full House', year: 2004, mediaType: 'tv' };
  const fh = t => scoreAvistazResult(mk(t, { size: 20 * 1024 ** 3, seeders: 8 }), fhCtx);
  const wanted = fh('Full House S01 2004 1080p KOCOWA WEB-DL AAC H.264');
  const otherShow = fh('Full.House.S01.1987.1080p.BluRay.x264');
  assert.ok(wanted.confidence - otherShow.confidence >= 20, `the right show clearly outranks the same-titled one (${wanted.confidence} vs ${otherShow.confidence})`);
  assert.match(otherShow.notes.join(' '), /different show/, 'the mismatch is explained in the candidate embed');
  assert.deepStrictEqual(wanted.notes, [], 'the wanted release is flagged for nothing');
  // A TV release's year is the SEASON's air year, so a later season legitimately carries a later
  // year and must not be penalized — only a release predating the series proves a mismatch.
  assert.strictEqual(fh('Full.House.S02.2012.1080p.WEB-DL').confidence, wanted.confidence, 'a later season with a later year is not penalized');
  assert.strictEqual(fh('Full.House.S01.1080p.WEB-DL').confidence, wanted.confidence, 'a release with no year is not penalized');
  assert.strictEqual(
    scoreAvistazResult(mk('Full.House.S01.1987.1080p.BluRay.x264', { size: 20 * 1024 ** 3, seeders: 8 }), { title: 'Full House', mediaType: 'tv' }).confidence,
    wanted.confidence, 'with no year in the request nothing is penalized');

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

  // --- Content-identity dedupe (same episode/pack, different release/encoding) ---
  const overlap = (a, b) => contentClaimsOverlap(releaseContentClaim(a), releaseContentClaim(b));

  // Same season pack, different encoding/group/size → duplicate.
  assert.ok(overlap('Blood.vs.Duty.S01.1080p.WEB-DL.H264-GROUP1', 'Blood vs Duty S01 720p HDTV x264-GROUP2'),
    'same season pack under different encodings is a duplicate');
  // Same single episode, different release → duplicate.
  assert.ok(overlap('Some.Show.S02E05.720p.HDTV.x264', 'Some Show - S02E05 - 1080p WEB-DL'),
    'same episode under different releases is a duplicate');
  // A season pack overlaps a single episode of that season.
  assert.ok(overlap('My.Father.is.Strange.S01.1080p.WEB-DL', 'My Father is Strange S01E14 720p'),
    'season pack overlaps a single episode of that season');
  // Complete series overlaps anything of that series.
  assert.ok(overlap('Old.Drama.Complete.Series.1080p.WEBRip', 'Old Drama S03E02 720p'),
    'complete-series pack overlaps a single episode');

  // NOT duplicates: different episodes, different seasons, different shows.
  assert.ok(!overlap('Some.Show.S02E05.720p', 'Some.Show.S02E06.720p'), 'different episodes are not duplicates');
  assert.ok(!overlap('Some.Show.S01.1080p', 'Some.Show.S02.1080p'), 'different season packs are not duplicates');
  assert.ok(!overlap('Blood.vs.Duty.S01E01', 'Other.Drama.S01E01'), 'same slot on different shows is not a duplicate');
  // Unparseable / movie-shaped names never claim → never block a different release.
  assert.strictEqual(releaseContentClaim('Great.Movie.2019.2160p.BluRay.REMUX'), null, 'a movie name yields no TV claim');
  assert.strictEqual(releaseContentClaim(''), null, 'empty name yields no claim');
  assert.strictEqual(contentClaimsOverlap(null, releaseContentClaim('Some.Show.S01E01')), false, 'a null claim never overlaps');

  // describeContentClaim renders a readable label for the "already grabbing …" message.
  assert.strictEqual(describeContentClaim(releaseContentClaim('Some.Show.S02E05.720p')), 'S02E05', 'episode label');
  assert.strictEqual(describeContentClaim(releaseContentClaim('Some.Show.S01.1080p')), 'S01', 'season label');
  assert.strictEqual(describeContentClaim(releaseContentClaim('Old.Drama.Complete.Series.1080p')), 'the complete series', 'complete-series label');

  // --- Whole-series planning (planSeriesGrab / describeGrabPlan) ---
  // The point of the feature: one search, one click, every episode AvistaZ actually has.
  const plan = (titles, opts) => planSeriesGrab(
    titles.map(([releaseTitle, confidence]) => ({ releaseTitle, confidence })), opts);
  const titlesOf = p => p.picks.map(x => x.releaseTitle);

  let sp = plan([
    ['Blood.vs.Duty.S01.1080p.WEB-DL', 95],
    ['Blood.vs.Duty.S02.1080p.WEB-DL', 93],
    ['Blood.vs.Duty.S03.1080p.WEB-DL', 91],
  ]);
  assert.deepStrictEqual(titlesOf(sp), ['Blood.vs.Duty.S01.1080p.WEB-DL', 'Blood.vs.Duty.S02.1080p.WEB-DL', 'Blood.vs.Duty.S03.1080p.WEB-DL'],
    'one pack per season is grabbed as a set');
  assert.strictEqual(describeGrabPlan(sp.picks), 'S01, S02, S03', 'the plan label lists every season covered');

  // Overlapping releases of the same season collapse to the highest-confidence one — the plan
  // can never spend two download slots on the same episodes.
  sp = plan([
    ['Blood.vs.Duty.S01.1080p.WEB-DL', 95],
    ['Blood vs Duty S01 720p HDTV x264-OTHER', 88],
    ['Blood.vs.Duty.S01E04.1080p.WEB-DL', 80],
    ['Blood.vs.Duty.S02.1080p.WEB-DL', 93],
  ]);
  assert.deepStrictEqual(titlesOf(sp), ['Blood.vs.Duty.S01.1080p.WEB-DL', 'Blood.vs.Duty.S02.1080p.WEB-DL'], 'duplicate coverage of a season is dropped');
  assert.strictEqual(sp.covered, 2, 'both redundant S01 releases are counted as covered');

  // A complete-series pack that outranks everything absorbs the whole show in one grab.
  sp = plan([
    ['Old.Drama.Complete.Series.1080p.WEBRip', 96],
    ['Old.Drama.S02.1080p.WEB-DL', 90],
  ]);
  assert.deepStrictEqual(titlesOf(sp), ['Old.Drama.Complete.Series.1080p.WEBRip'], 'a winning complete-series pack covers the rest');
  assert.strictEqual(describeGrabPlan(sp.picks), 'the complete series', 'complete-series plan label');

  // Season packs plus the stray episodes that fill the gaps — the case that used to need one
  // prompt per episode and only ever got one.
  sp = plan([
    ['Some.Show.S01.1080p.WEB-DL', 94],
    ['Some.Show.S02E01.1080p.WEB-DL', 82],
    ['Some.Show.S02E02.1080p.WEB-DL', 81],
  ]);
  assert.deepStrictEqual(titlesOf(sp), ['Some.Show.S01.1080p.WEB-DL', 'Some.Show.S02E01.1080p.WEB-DL', 'Some.Show.S02E02.1080p.WEB-DL'],
    'a pack and the loose episodes of another season are all planned');
  assert.strictEqual(describeGrabPlan(sp.picks), 'S01, S02E01, S02E02', 'mixed plan label');

  // The old-show case the planner exists for: on a finished show the complete pack is a
  // poorly-seeded 720p rip while a re-encoded single episode is a well-seeded 1080p WEB-DL, so
  // the episode scores HIGHER. Sorted by confidence it would anchor the plan and the pack that
  // holds every episode would be discarded as redundant — two slots for two episodes.
  sp = plan([
    ['Winter.Sonata.S01E01.1080p.WEB-DL', 90],
    ['Winter.Sonata.S01E02.1080p.WEB-DL', 89],
    ['Winter.Sonata.S01.COMPLETE.720p.HDTV', 78],
  ], { minConfidence: 70 });
  assert.deepStrictEqual(titlesOf(sp), ['Winter.Sonata.S01.COMPLETE.720p.HDTV'],
    'a season pack wins over higher-confidence single episodes of the same season');
  assert.strictEqual(sp.covered, 2, 'the episodes the pack contains are absorbed, not grabbed separately');

  // Breadth only orders releases that are already eligible — a pack below minConfidence (dead,
  // wrong show, mislabelled) can't ride breadth past the quality bar.
  sp = plan([
    ['Winter.Sonata.S01E01.1080p.WEB-DL', 90],
    ['Winter.Sonata.S01.COMPLETE.CAM.XviD', 41],
  ], { minConfidence: 70 });
  assert.deepStrictEqual(titlesOf(sp), ['Winter.Sonata.S01E01.1080p.WEB-DL'], 'a junk pack never outranks a usable episode');

  // Complete series beats a single-season pack beats an episode, regardless of confidence order.
  sp = plan([
    ['Old.Drama.S01.1080p.WEB-DL', 94],
    ['Old.Drama.Complete.Series.720p.HDTV', 80],
  ], { minConfidence: 70 });
  assert.deepStrictEqual(titlesOf(sp), ['Old.Drama.Complete.Series.720p.HDTV'], 'the widest release wins the plan');

  // Other shows in the same result set are never swept in — the top result anchors the series.
  sp = plan([
    ['Blood.vs.Duty.S01.1080p.WEB-DL', 95],
    ['Completely.Other.Drama.S01.1080p.WEB-DL', 94],
  ]);
  assert.deepStrictEqual(titlesOf(sp), ['Blood.vs.Duty.S01.1080p.WEB-DL'], 'a different series in the results is not planned');
  assert.strictEqual(sp.series, 'blood vs duty', 'the plan reports the anchored series token');

  // `max` is how the daily allowance caps a plan; the shortfall is reported, not silently lost.
  sp = plan([
    ['Blood.vs.Duty.S01.1080p.WEB-DL', 95],
    ['Blood.vs.Duty.S02.1080p.WEB-DL', 93],
    ['Blood.vs.Duty.S03.1080p.WEB-DL', 91],
  ], { max: 2 });
  assert.strictEqual(sp.picks.length, 2, 'max caps the number of releases');
  assert.strictEqual(sp.trimmed, 1, 'releases beyond the cap are reported as trimmed');

  // minConfidence keeps junk out of an unattended (auto-mode) bulk grab.
  sp = plan([['Blood.vs.Duty.S01.1080p.WEB-DL', 95], ['Blood.vs.Duty.S02.CAM.XviD', 41]], { minConfidence: 70 });
  assert.deepStrictEqual(titlesOf(sp), ['Blood.vs.Duty.S01.1080p.WEB-DL'], 'low-confidence releases are excluded');

  // `exclude` = releases already in flight, so re-running a search only plans the gaps.
  sp = plan([
    ['Blood.vs.Duty.S01.1080p.WEB-DL', 95],
    ['Blood.vs.Duty.S02.1080p.WEB-DL', 93],
  ], { exclude: ['Blood vs Duty S01 720p HDTV x264-OTHER'] });
  assert.deepStrictEqual(titlesOf(sp), ['Blood.vs.Duty.S02.1080p.WEB-DL'], 'an already-active season is not re-grabbed');

  // A season-scoped search plans only that season.
  sp = plan([
    ['Some.Show.S01.1080p.WEB-DL', 94],
    ['Some.Show.S02.1080p.WEB-DL', 93],
    ['Some.Show.S02E05.720p.HDTV', 80],
  ], { season: 2 });
  assert.deepStrictEqual(titlesOf(sp), ['Some.Show.S02.1080p.WEB-DL'], 'season scope keeps other seasons out of the plan');
  assert.ok(claimCoversSeason(releaseContentClaim('Old.Drama.Complete.Series.1080p'), 7), 'a complete-series pack covers any season');
  assert.ok(!claimCoversSeason(releaseContentClaim('Some.Show.S01.1080p'), 2), 'a single-season pack does not cover another season');

  // Movie-shaped and unparseable names claim nothing, so a movie search never plans a bulk grab.
  assert.strictEqual(plan([['Great.Movie.2019.2160p.BluRay.REMUX', 96]]).picks.length, 0, 'movies yield no series plan');
  assert.strictEqual(planSeriesGrab([]).picks.length, 0, 'an empty result set plans nothing');
  assert.strictEqual(describeGrabPlan([]), 'this title', 'an empty plan degrades to a generic label');

  console.log('ok - grab');
})().catch(err => { console.error('FAILED grab:', err.message); process.exit(1); });
