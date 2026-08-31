const test = require('node:test');
const assert = require('node:assert/strict');

const { grabTransferPreflight, rcloneConfigPath, planSeriesGrab } = require('../../src/grab');

const baseCfg = {
  PROWLARR_URL: 'http://prowlarr:9696',
  RTORRENT_URL: 'https://seedbox.example/rpc',
  GRAB_RCLONE_REMOTE: 'rapidseedbox:',
  GRAB_STAGING_PATH: '/seedbox-staging',
  GRAB_RCLONE_FLAGS: ['--config', '/app/data/rclone.conf'],
};

test('rcloneConfigPath accepts both --config forms', () => {
  assert.equal(rcloneConfigPath(['--config', '/tmp/rclone.conf']), '/tmp/rclone.conf');
  assert.equal(rcloneConfigPath(['--config=/tmp/rclone.conf']), '/tmp/rclone.conf');
  assert.equal(rcloneConfigPath(['--transfers', '2']), null);
});

test('grab preflight blocks a missing named rclone remote before tracker download', () => {
  const result = grabTransferPreflight(baseCfg, () => '[other]\ntype = sftp\n');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'rclone_remote_missing');
  assert.match(result.message, /\[rapidseedbox\]/);
});

test('grab preflight blocks an unreadable explicit config', () => {
  const result = grabTransferPreflight(baseCfg, () => { throw new Error('ENOENT'); });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'rclone_config_unreadable');
});

test('grab preflight passes when the configured remote exists', () => {
  const result = grabTransferPreflight(baseCfg, () => '[rapidseedbox]\ntype = sftp\nhost = example\n');
  assert.equal(result.ok, true);
  assert.equal(result.checked, true);
});

test('grab preflight is case-sensitive, matching rclone\'s own section lookup', () => {
  // rclone treats [RapidSeedbox] and [rapidseedbox] as different sections — a case-insensitive
  // preflight would report the pipeline healthy while every real transfer still fails at runtime
  // with "didn't find section in config file".
  const result = grabTransferPreflight(baseCfg, () => '[RapidSeedbox]\ntype = sftp\nhost = example\n');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'rclone_remote_missing');
});

test('episode-only whole-series results are not truncated by the pack/release cap', () => {
  const candidates = Array.from({ length: 12 }, (_, i) => ({
    releaseTitle: `The Road to Splendor S01E${String(i + 1).padStart(2, '0')} 1080p WEB-DL-GRP`,
    confidence: 90 - i,
  }));
  const plan = planSeriesGrab(candidates, { minConfidence: 70, max: 2, aliases: ['the road to splendor'] });
  assert.equal(plan.picks.length, 12);
  assert.equal(plan.trimmed, 0);
});

test('pack-based whole-series plans still honor the configured cap', () => {
  const candidates = [1, 2, 3].map(season => ({
    releaseTitle: `Example Show S${String(season).padStart(2, '0')} 1080p WEB-DL-GRP`,
    confidence: 90 - season,
  }));
  const plan = planSeriesGrab(candidates, { minConfidence: 70, max: 2, aliases: ['example show'] });
  assert.equal(plan.picks.length, 2);
  assert.equal(plan.trimmed, 1);
});

test('preflight names a case-mismatched remote instead of leaving it to be spotted', () => {
  // rclone's own error ("didn't find section in config file") is identical for a missing file, a
  // renamed remote, and a case mismatch. The last is the likeliest and the least visible, so it
  // is called out by name rather than left in a list for the operator to scan.
  const result = grabTransferPreflight(baseCfg, () => '[RapidSeedbox]\ntype = sftp\nhost = example\n[backup]\n');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'rclone_remote_missing');
  assert.equal(result.caseMatch, 'RapidSeedbox');
  assert.match(result.message, /case-sensitive/);
  assert.deepEqual(result.availableRemotes, ['RapidSeedbox', 'backup']);
});

test('preflight lists the remotes a config actually defines, and never their values', () => {
  const conf = '[seedbox-sftp]\ntype = sftp\nhost = example.com\npass = SUPERSECRET\n\n[other]\ntype = s3\n';
  const result = grabTransferPreflight(baseCfg, () => conf);
  assert.equal(result.reason, 'rclone_remote_missing');
  assert.deepEqual(result.availableRemotes, ['seedbox-sftp', 'other']);
  assert.equal(result.caseMatch, null, 'a genuinely different name is not reported as a case problem');
  // This list is rendered into Discord: section names only, never credentials.
  assert.ok(!JSON.stringify(result).includes('SUPERSECRET'));

  const healthy = grabTransferPreflight(baseCfg, () => '[rapidseedbox]\ntype = sftp\npass = SECRET\n');
  assert.equal(healthy.ok, true);
  assert.deepEqual(healthy.availableRemotes, ['rapidseedbox']);
  assert.ok(!JSON.stringify(healthy).includes('SECRET'));
});
