'use strict';

// Single-flight + TTL cache for the dashboard's read-heavy integration fan-out (#189). Every
// GET /admin render used to call gatherHealth/Tautulli/Arr queues/disk space/edge diagnostics/
// guild members fresh on every request. With the page's 60s auto-refresh and any number of open
// admin tabs, that multiplied real upstream traffic by however many viewers happened to be
// watching at once, and a slow upstream delayed every render. This coalesces concurrent identical
// reads into one in-flight call, remembers the result for a bounded TTL, and — if a refresh
// attempt fails — keeps serving the last good value marked stale rather than taking the whole
// panel down over one transient failure.
function createTtlCache(now = Date.now) {
  const entries = new Map(); // key -> { value, fetchedAt, pending }

  async function get(key, ttlMs, loader) {
    const entry = entries.get(key);
    if (entry && entry.pending) {
      const value = await entry.pending;
      const settled = entries.get(key);
      return { value, fetchedAt: settled ? settled.fetchedAt : now(), stale: false, fromCache: true };
    }
    if (entry && now() - entry.fetchedAt < ttlMs) {
      return { value: entry.value, fetchedAt: entry.fetchedAt, stale: false, fromCache: true };
    }
    const pending = Promise.resolve().then(loader);
    entries.set(key, { value: entry && entry.value, fetchedAt: entry ? entry.fetchedAt : 0, pending });
    try {
      const value = await pending;
      const fetchedAt = now();
      entries.set(key, { value, fetchedAt, pending: null });
      return { value, fetchedAt, stale: false, fromCache: false };
    } catch (err) {
      if (entry && entry.value !== undefined) {
        entries.set(key, { value: entry.value, fetchedAt: entry.fetchedAt, pending: null });
        return { value: entry.value, fetchedAt: entry.fetchedAt, stale: true, fromCache: true };
      }
      entries.delete(key);
      throw err;
    }
  }

  // No key: drop everything. A mutation can affect several panels' worth of upstream state
  // (approving a request changes quota, pending counts, and Arr queues alike), so invalidating
  // precisely which keys would need updating after every action is more bookkeeping than this
  // cache is worth avoiding — clearing it all just means the next render pays for one fresh
  // fetch, same as it always would have before this cache existed.
  function invalidate(key) {
    if (key === undefined) entries.clear();
    else entries.delete(key);
  }

  return { get, invalidate };
}

module.exports = { createTtlCache };
