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
