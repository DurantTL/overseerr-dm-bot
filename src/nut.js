'use strict';

// Minimal NUT (Network UPS Tools) TCP client. Speaks just enough of the NUT
// protocol to read UPS variables: connect, LIST VAR <ups>, LOGOUT.
// Protocol ref: https://networkupstools.org/docs/developer-guide.chunked/

const net = require('net');

function nutConfigured(config) {
  return !!(config.NUT_HOST && config.NUT_UPS_NAME);
}

// Read all variables for one UPS. Returns { 'battery.charge': '100', ... }
// or throws on connection/protocol failure.
async function readUpsVars({ host, port = 3493, ups, username, password, timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    const vars = {};
    let buffer = '';
    let settled = false;
    const done = (err, result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(result);
    };
    const timer = setTimeout(() => done(new Error('NUT connection timed out')), timeoutMs);

    const socket = net.createConnection({ host, port }, () => {
      // Optional auth first, then list vars.
      const commands = [];
      if (username) commands.push(`USERNAME ${username}`);
      if (password) commands.push(`PASSWORD ${password}`);
      commands.push(`LIST VAR ${ups}`);
      socket.write(commands.join('\n') + '\n');
    });
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        if (line.startsWith('ERR ')) {
          clearTimeout(timer);
          done(new Error(`NUT error: ${line.slice(4)}`));
          return;
        }
        // VAR <ups> <name> "<value>"
        const m = /^VAR \S+ (\S+) "(.*)"$/.exec(line);
        if (m) vars[m[1]] = m[2];
        if (line === `END LIST VAR ${ups}`) {
          clearTimeout(timer);
          socket.write('LOGOUT\n');
          done(null, vars);
          return;
        }
      }
    });
    socket.on('error', err => {
      clearTimeout(timer);
      done(err);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      // If the server closed before END LIST, treat as failure unless we got vars.
      if (!settled) done(new Error('NUT connection closed unexpectedly'));
    });
  });
}

// Normalize raw NUT vars into the dashboard-friendly shape.
function describeUps(vars) {
  const num = (key, fallback = null) => {
    const v = Number(vars[key]);
    return Number.isFinite(v) ? v : fallback;
  };
  const status = String(vars['ups.status'] || '').trim(); // e.g. "OL", "OB DISCHRG"
  const onBattery = /\bOB\b/.test(status);
  const lowBattery = /\bLB\b/.test(status);
  return {
    status,
    onBattery,
    lowBattery,
    // NUT reports runtime in seconds.
    batteryPercent: num('battery.charge'),
    runtimeSeconds: num('battery.runtime'),
    loadPercent: num('ups.load'),
    inputVoltage: num('input.voltage'),
    batteryVoltage: num('battery.voltage'),
    model: vars['device.model'] || vars['ups.model'] || null,
  };
}

async function fetchUpsStatus(config) {
  if (!nutConfigured(config)) return null;
  const vars = await readUpsVars({
    host: config.NUT_HOST,
    port: Number(config.NUT_PORT) || 3493,
    ups: config.NUT_UPS_NAME,
    username: config.NUT_USERNAME || undefined,
    password: config.NUT_PASSWORD || undefined,
    timeoutMs: 5000,
  });
  return describeUps(vars);
}

module.exports = { nutConfigured, readUpsVars, describeUps, fetchUpsStatus };
