#!/usr/bin/env node
// §182 BLOCKER fix: the tier agent's persistent manual ignore overlay must be pin-aware, or an
// active play-promotion pin can never make an overlaid legacy title (Boku, Lizzie, ...) download.
// Covers: default behaviour is BYTE-FOR-BYTE unchanged when TIER_AGENT_LEGACY_IGNORE_DIR is unset,
// the legacy file is merged in when configured, an active pin overrides both the planner's own
// drop and the legacy overlay, and the override reverts once the pin is no longer sent.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildCtx, resolveFolderPlans, readLegacyIgnoreLines, mergeLegacyIgnores,
} = require('../../agent/agent');

function ctxWith(env) {
  return buildCtx({
    TIER_BOT_URL: 'http://bot.local', TIER_NODE: 'california', TIER_AGENT_TOKEN: 't',
    TIER_FOLDER_ROOT: '/data/Movies', SYNCTHING_FOLDER_ID: 'mov',
    ...env,
  });
}

test('tier-agent-legacy-ignore: mergeLegacyIgnores — planner∪legacy−pins, matches src/edge-promotion.js', () => {
  const plannerLines = ['/Cold Title'];
  const legacyLines = ['/Boku', '/Lizzie'];
  assert.deepStrictEqual(mergeLegacyIgnores({ plannerLines, legacyLines, pinnedRelPaths: [] }), ['/Boku', '/Cold Title', '/Lizzie']);
  assert.deepStrictEqual(mergeLegacyIgnores({ plannerLines, legacyLines, pinnedRelPaths: ['Boku'] }), ['/Cold Title', '/Lizzie'], 'an active pin removes a LEGACY-only ignore even though the planner never dropped it');
  assert.deepStrictEqual(mergeLegacyIgnores({ plannerLines, legacyLines, pinnedRelPaths: ['Cold Title', 'Boku', 'Lizzie'] }), [], 'a pin can also override the planner\'s own drop');
});

test('tier-agent-legacy-ignore: readLegacyIgnoreLines skips comments/blanks and tolerates a missing file', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-legacy-'));
  fs.writeFileSync(path.join(tmp, 'mov.txt'), '// header comment\n# also a comment\n\n/Boku\n/Lizzie\n');
  assert.deepStrictEqual(readLegacyIgnoreLines(tmp, 'mov'), ['/Boku', '/Lizzie']);
  assert.deepStrictEqual(readLegacyIgnoreLines(tmp, 'nonexistent-folder'), [], 'no file for this folder → no legacy lines, not an error');
  assert.deepStrictEqual(readLegacyIgnoreLines('', 'mov'), [], 'unset dir → no legacy lines');
});

test('tier-agent-legacy-ignore: resolveFolderPlans is a byte-for-byte no-op when TIER_AGENT_LEGACY_IGNORE_DIR is unset (default)', () => {
  const ctx = ctxWith({});
  assert.strictEqual(ctx.legacyIgnoreDir, '', 'default is the empty/off state');
  const manifest = { drop: [{ mediaId: 'tmdb:1', relPath: 'Cold Title', sizeBytes: 100 }], pinnedRelPaths: ['Cold Title'] };
  const [fp] = resolveFolderPlans(ctx, manifest);
  // Even though the manifest carries a pin, an unconfigured agent must render EXACTLY what the
  // bot sent — no new behaviour is introduced just by upgrading this file.
  assert.ok(fp.stignore.includes('/Cold Title'), 'unset legacy dir never subtracts anything — today\'s behaviour, unchanged');
});

test('tier-agent-legacy-ignore: resolveFolderPlans merges the overlay and an active pin overrides it', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-legacy-'));
  fs.writeFileSync(path.join(tmp, 'mov.txt'), '/Boku\n/Lizzie\n');
  const ctx = ctxWith({ TIER_AGENT_LEGACY_IGNORE_DIR: tmp });

  // No pin yet: both the planner drop and the full legacy overlay apply.
  const manifestNoPin = { drop: [{ mediaId: 'tmdb:1', relPath: 'Cold Title', sizeBytes: 100 }], pinnedRelPaths: [] };
  const [fpNoPin] = resolveFolderPlans(ctx, manifestNoPin);
  assert.ok(fpNoPin.stignore.includes('/Boku'));
  assert.ok(fpNoPin.stignore.includes('/Lizzie'));
  assert.ok(fpNoPin.stignore.includes('/Cold Title'));

  // Boku gets a play-promotion pin: the manifest now carries it in pinnedRelPaths (the planner
  // also keeps it, so it's no longer in `drop` either — both happen together via floorIds).
  const manifestPinned = { drop: [{ mediaId: 'tmdb:1', relPath: 'Cold Title', sizeBytes: 100 }], pinnedRelPaths: ['Boku'] };
  const [fpPinned] = resolveFolderPlans(ctx, manifestPinned);
  assert.ok(!fpPinned.stignore.includes('/Boku\n') && !fpPinned.stignore.split('\n').includes('/Boku'), 'Boku is no longer ignored while its pin is active');
  assert.ok(fpPinned.stignore.split('\n').includes('/Lizzie'), 'Lizzie (unpinned) is still ignored');
  assert.ok(fpPinned.stignore.split('\n').includes('/Cold Title'), 'the planner\'s own drop is unaffected by an unrelated pin');

  // Pin expires: the bot stops sending Boku in pinnedRelPaths, and the legacy rule reappears with
  // no extra step.
  const [fpExpired] = resolveFolderPlans(ctx, manifestNoPin);
  assert.ok(fpExpired.stignore.split('\n').includes('/Boku'), 'expiry restores the legacy ignore automatically');
});
