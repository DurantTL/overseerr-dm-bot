// Bounds the number of authenticated requests that may hold body-parser/multer work at once.
// Apply this after cheap authentication/rate admission and before the parser. The slot remains
// held until the response finishes (or the connection closes), covering both body consumption
// and the route work triggered by that body without buffering requests in application memory.
function createBodyConcurrencyLimiter({ limit, scope = 'request body' }) {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError(`${scope} concurrency limit must be a positive integer`);
  }

  let active = 0;
  return (_req, res, next) => {
    if (active >= limit) {
      res.set('Retry-After', '1');
      return res.status(503).json({ error: `Too many concurrent ${scope} requests` });
    }

    active += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active -= 1;
    };
    res.once('finish', release);
    res.once('close', release);
    next();
  };
}

module.exports = { createBodyConcurrencyLimiter };
