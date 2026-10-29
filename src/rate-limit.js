// express-rate-limit store that keeps a SQLite-backed rolling window, so counts survive restarts.
// Used by the download route and by the dashboard's login and header-auth failure counters.
// Blocked requests are not inserted, so repeatedly retrying a blocked link does not extend the
// lockout; the oldest accepted hit still determines when one slot becomes available.

class SqliteRollingWindowStore {
  constructor({ db, scope, limit, windowMs, now = () => Date.now() }) {
    this.db = db;
    this.scope = String(scope);
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  init(options) {
    if (options.windowMs !== this.windowMs) {
      throw new Error(`SQLite rate-limit window mismatch: expected ${this.windowMs}, got ${options.windowMs}`);
    }
  }

  increment(key) {
    const now = this.now();
    return this.db.transaction(() => {
      this.db.prepare('DELETE FROM rate_limit_hits WHERE expires_at <= ?').run(now);
      const bucket = this.db.prepare(`
        SELECT COUNT(*) AS hits, MIN(expires_at) AS reset_at
          FROM rate_limit_hits
         WHERE scope = ? AND identity = ? AND expires_at > ?
      `).get(this.scope, String(key), now);
      const acceptedHits = Number(bucket.hits || 0);
      if (acceptedHits >= this.limit) {
        return { totalHits: acceptedHits + 1, resetTime: new Date(bucket.reset_at ?? now + this.windowMs) };
      }

      const expiresAt = now + this.windowMs;
      this.db.prepare('INSERT INTO rate_limit_hits (scope, identity, hit_at, expires_at) VALUES (?, ?, ?, ?)')
        .run(this.scope, String(key), now, expiresAt);
      return {
        totalHits: acceptedHits + 1,
        resetTime: new Date(bucket.reset_at == null ? expiresAt : Math.min(bucket.reset_at, expiresAt)),
      };
    })();
  }

  // Read-only count of accepted hits still inside the window (express-rate-limit's optional
  // Store#get). Used by the dashboard's header-failure throttle to check a client before counting.
  get(key) {
    const now = this.now();
    const bucket = this.db.prepare(`
      SELECT COUNT(*) AS hits, MIN(expires_at) AS reset_at
        FROM rate_limit_hits
       WHERE scope = ? AND identity = ? AND expires_at > ?
    `).get(this.scope, String(key), now);
    const hits = Number(bucket.hits || 0);
    return { totalHits: hits, resetTime: hits ? new Date(bucket.reset_at) : undefined };
  }

  decrement(key) {
    this.db.prepare(`
      DELETE FROM rate_limit_hits
       WHERE rowid = (
         SELECT rowid FROM rate_limit_hits
          WHERE scope = ? AND identity = ?
          ORDER BY hit_at DESC, rowid DESC LIMIT 1
       )
    `).run(this.scope, String(key));
  }

  resetKey(key) {
    this.db.prepare('DELETE FROM rate_limit_hits WHERE scope = ? AND identity = ?')
      .run(this.scope, String(key));
  }
}

module.exports = { SqliteRollingWindowStore };
