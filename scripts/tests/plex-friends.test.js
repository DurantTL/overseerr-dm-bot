#!/usr/bin/env node
// plex.tv deprecated /api/v2/friends (now HTTP 410 Gone); fetchPlexFriends switched to the
// legacy /api/users endpoint, which wraps its list in a MediaContainer instead of returning a
// bare array. normalizePlexFriendsResponse has to handle every shape Plex has used for this
// list so callers never have to know which one came back. Extracted via loadSandbox (like every
// other src/*.js test here) rather than required directly, since requiring src/plex.js pulls in
// src/db.js and opens the real SQLite database.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadSandbox } = require('./extract');

test('normalizePlexFriendsResponse: handles every response shape plex.tv has used for this list', () => {
  // Called directly (not via sandbox.run(code)) so the input literals are host-realm objects —
  // vm.runInContext evaluates literals in the sandbox's own realm, which would otherwise make a
  // structurally-identical array fail deepStrictEqual against a host-realm expected value.
  const { normalizePlexFriendsResponse } = loadSandbox(['normalizePlexFriendsResponse']);
  // Array.from(...) re-materializes the result as a host-realm array — normalizePlexFriendsResponse
  // runs inside the vm sandbox, so a freshly-built (rather than passed-through) array it returns
  // belongs to the sandbox's own realm and fails deepStrictEqual's prototype check against a
  // host-realm literal otherwise, even when structurally identical.
  const norm = raw => Array.from(normalizePlexFriendsResponse(raw));
  assert.deepStrictEqual(norm([{ id: 1 }]), [{ id: 1 }], 'a bare array (the old /api/v2/friends shape) passes through');
  assert.deepStrictEqual(norm({ data: [{ id: 2 }] }), [{ id: 2 }], 'a { data: [...] } wrapper unwraps');
  assert.deepStrictEqual(norm({ MediaContainer: { User: [{ id: 3 }, { id: 4 }] } }), [{ id: 3 }, { id: 4 }], 'a MediaContainer.User array unwraps');
  assert.deepStrictEqual(norm({ MediaContainer: { User: { id: 5 } } }), [{ id: 5 }], 'a single MediaContainer.User object is wrapped into an array');
  assert.deepStrictEqual(norm({ MediaContainer: { Friend: [{ id: 6 }] } }), [{ id: 6 }], 'a MediaContainer.Friend array unwraps too');
  assert.deepStrictEqual(norm({ MediaContainer: { size: 0 } }), [], 'an empty MediaContainer with no User/Friend key is an empty list, not a throw');
  assert.deepStrictEqual(norm(null), [], 'null is an empty list');
  assert.deepStrictEqual(norm(undefined), [], 'undefined is an empty list');
  assert.deepStrictEqual(norm({}), [], 'an unrecognized object shape is an empty list, not a throw');
});

test('fetchPlexFriends: calls plexApiGet against /api/users, not the deprecated /api/v2/friends', async () => {
  const calls = [];
  const { fetchPlexFriends } = loadSandbox(['fetchPlexFriends', 'normalizePlexFriendsResponse'], {
    plexApiGet: async path => { calls.push(path); return { MediaContainer: { size: 1, User: [{ id: 42, email: 'friend@example.com' }] } }; },
  });
  const friends = Array.from(await fetchPlexFriends('tok'));
  assert.deepStrictEqual(friends, [{ id: 42, email: 'friend@example.com' }]);
  assert.deepStrictEqual(calls, ['/api/users']);
});
