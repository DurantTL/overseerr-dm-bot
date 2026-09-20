const express = require('express');
const bodyParser = require('body-parser');

// Shared app-factory seam for the HTTP server. Dependency-injected route modules register on the
// returned app while index.js supplies production integrations. This owns the plumbing common to
// all of them, so tests can assemble and tear down an ephemeral server without Discord or any
// other external service.
function createApp({ trustProxy = false, jsonLimit = '1mb', skipJsonPaths = [] } = {}) {
  const app = express();
  app.disable('x-powered-by');
  // Trust exactly one reverse-proxy hop only when the operator opts in. Rate-limit identities use
  // req.ip, and directly trusting arbitrary X-Forwarded-For lets clients rotate spoofed IPs.
  app.set('trust proxy', trustProxy ? 1 : false);
  // L3: baseline security headers. HSTS only matters behind TLS (the tunnel); the rest are
  // cheap defense-in-depth on every response.
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    if ((req.headers['x-forwarded-proto'] || '').includes('https') || req.secure) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });
  app.use((req, res, next) => {
    if (req.is('multipart/form-data')) return next();
    if (skipJsonPaths.some(prefix => req.path.startsWith(prefix))) return next();
    bodyParser.json({ limit: jsonLimit })(req, res, next);
  });
  return app;
}

// Starts the app listening and resolves once the OS has actually bound a socket, so callers
// (tests especially) can read back the real ephemeral port from server.address().port before
// making requests.
function listen(app, port) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port);
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close(err => (err ? reject(err) : resolve()));
  });
}

module.exports = { createApp, listen, close };
