// Seedbox rTorrent over XML-RPC (RapidSeedbox exposes it at /plugins/rpc/rpc.php).
// No xmlrpc dependency: the tiny subset rTorrent speaks (scalar/array/struct values,
// base64 for raw .torrent bytes) is serialized and parsed here directly.
//
// Torrents are pushed as raw bytes (load.raw_start) rather than by URL: the grab URLs
// come from Prowlarr, which usually lives on a private LAN the seedbox can't reach.
// The info-hash is computed locally from the .torrent so a grab can be tracked in
// rTorrent from the moment it's sent, without waiting for it to appear in a listing.
const axios = require('axios');
const crypto = require('crypto');
const { CONFIG } = require('./config');

const rtorrentConfigured = () => !!CONFIG.RTORRENT_URL;

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function xmlUnescape(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function serializeXmlRpcValue(v) {
  if (Buffer.isBuffer(v)) return `<base64>${v.toString('base64')}</base64>`;
  if (typeof v === 'boolean') return `<boolean>${v ? 1 : 0}</boolean>`;
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) return `<double>${v}</double>`;
    return `<i8>${v}</i8>`;
  }
  if (Array.isArray(v)) return `<array><data>${v.map(x => `<value>${serializeXmlRpcValue(x)}</value>`).join('')}</data></array>`;
  return `<string>${xmlEscape(v)}</string>`;
}

function serializeXmlRpcCall(method, params = []) {
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + `<methodCall><methodName>${xmlEscape(method)}</methodName><params>`
    + params.map(p => `<param><value>${serializeXmlRpcValue(p)}</value></param>`).join('')
    + '</params></methodCall>';
}

// Parse the value starting just after a '<value>' tag; returns { value, next } where next
// is the index just past the matching '</value>'.
function parseXmlRpcValueAt(xml, start) {
  let i = start;
  while (i < xml.length && /\s/.test(xml[i])) i++;
  if (xml.startsWith('</value>', i)) return { value: '', next: i + '</value>'.length }; // empty untyped value
  if (xml[i] !== '<') {
    // Untyped <value>text</value> is a string per the spec.
    const end = xml.indexOf('</value>', i);
    return { value: xmlUnescape(xml.slice(start, end)), next: end + '</value>'.length };
  }
  const tagEnd = xml.indexOf('>', i);
  const tag = xml.slice(i + 1, tagEnd);
  if (tag === 'array') {
    const items = [];
    let j = xml.indexOf('<data>', tagEnd) + '<data>'.length;
    for (;;) {
      const nextValue = xml.indexOf('<value>', j);
      const dataClose = xml.indexOf('</data>', j);
      if (nextValue === -1 || (dataClose !== -1 && dataClose < nextValue)) { j = dataClose + '</data>'.length; break; }
      const r = parseXmlRpcValueAt(xml, nextValue + '<value>'.length);
      items.push(r.value);
      j = r.next;
    }
    const vClose = xml.indexOf('</value>', j);
    return { value: items, next: vClose + '</value>'.length };
  }
  if (tag === 'struct') {
    const obj = {};
    let j = tagEnd + 1;
    for (;;) {
      const member = xml.indexOf('<member>', j);
      const structClose = xml.indexOf('</struct>', j);
      if (member === -1 || (structClose !== -1 && structClose < member)) { j = structClose + '</struct>'.length; break; }
      const nameStart = xml.indexOf('<name>', member) + '<name>'.length;
      const nameEnd = xml.indexOf('</name>', nameStart);
      const r = parseXmlRpcValueAt(xml, xml.indexOf('<value>', nameEnd) + '<value>'.length);
      obj[xmlUnescape(xml.slice(nameStart, nameEnd))] = r.value;
      j = r.next;
    }
    const vClose = xml.indexOf('</value>', j);
    return { value: obj, next: vClose + '</value>'.length };
  }
  // Scalar types.
  const close = xml.indexOf(`</${tag}>`, tagEnd);
  const raw = xml.slice(tagEnd + 1, close);
  let value;
  if (['i4', 'i8', 'int'].includes(tag)) value = Number(raw);
  else if (tag === 'double') value = Number(raw);
  else if (tag === 'boolean') value = raw.trim() === '1';
  else if (tag === 'base64') value = Buffer.from(raw.trim(), 'base64');
  else value = xmlUnescape(raw);
  const vClose = xml.indexOf('</value>', close);
  return { value, next: vClose + '</value>'.length };
}

// Returns the response's single value, or throws on a <fault> (err.fault carries the
// faultCode/faultString struct so callers can tell "unknown hash" from a broken endpoint).
function parseXmlRpcResponse(xml) {
  const s = String(xml);
  const faultIdx = s.indexOf('<fault>');
  if (faultIdx !== -1) {
    const { value } = parseXmlRpcValueAt(s, s.indexOf('<value>', faultIdx) + '<value>'.length);
    const err = new Error(`rTorrent XML-RPC fault ${value.faultCode}: ${value.faultString}`);
    err.fault = value;
    throw err;
  }
  const idx = s.indexOf('<value>');
  if (idx === -1) return null;
  return parseXmlRpcValueAt(s, idx + '<value>'.length).value;
}

// ---- bencode info-hash ----
// Returns the index just past the bencoded element that starts at pos.
function bencodeElementEnd(buf, pos) {
  const c = buf[pos];
  if (c === 0x69) return buf.indexOf(0x65, pos) + 1; // i<digits>e
  if (c === 0x6c || c === 0x64) { // list / dict: elements until the closing 'e'
    let p = pos + 1;
    while (buf[p] !== 0x65) p = bencodeElementEnd(buf, p);
    return p + 1;
  }
  const colon = buf.indexOf(0x3a, pos); // <len>:<bytes>
  const len = Number(buf.slice(pos, colon).toString('latin1'));
  if (!Number.isInteger(len) || len < 0) throw new Error('invalid bencode string length');
  return colon + 1 + len;
}

// SHA-1 of the raw bencoded 'info' dict — the exact hash rTorrent reports (uppercase hex).
function computeInfoHash(torrent) {
  if (!Buffer.isBuffer(torrent) || torrent[0] !== 0x64) throw new Error('not a bencoded torrent file');
  let p = 1;
  while (torrent[p] !== 0x65) {
    const keyEnd = bencodeElementEnd(torrent, p);
    const key = torrent.slice(torrent.indexOf(0x3a, p) + 1, keyEnd).toString('latin1');
    const valEnd = bencodeElementEnd(torrent, keyEnd);
    if (key === 'info') {
      return crypto.createHash('sha1').update(torrent.slice(keyEnd, valEnd)).digest('hex').toUpperCase();
    }
    p = valEnd;
  }
  throw new Error('torrent file has no info dict');
}

// ---- RPC client ----
async function rtorrentCall(method, params = []) {
  const res = await axios.post(CONFIG.RTORRENT_URL, serializeXmlRpcCall(method, params), {
    headers: { 'Content-Type': 'text/xml' },
    timeout: 30000,
  });
  return parseXmlRpcResponse(res.data);
}

// Push raw .torrent bytes and start it, labeled (d.custom1 is the field ruTorrent and the
// *arrs read as the category — 'radarr'/'sonarr'). Returns the info-hash used for tracking.
async function addTorrentToRtorrent(torrent, label) {
  const infoHash = computeInfoHash(torrent);
  const commands = label ? [`d.custom1.set=${label}`] : [];
  await rtorrentCall('load.raw_start', ['', torrent, ...commands]);
  return infoHash;
}

// Status of one torrent by info-hash. An XML-RPC fault means rTorrent doesn't know the
// hash ({ found: false }); transport errors are rethrown — an unreachable seedbox proves
// nothing about the torrent and must not be mistaken for "removed".
async function getRtorrentStatus(infoHash) {
  try {
    const [name, complete, sizeBytes, doneBytes, downRate] = [
      await rtorrentCall('d.name', [infoHash]),
      await rtorrentCall('d.complete', [infoHash]),
      await rtorrentCall('d.size_bytes', [infoHash]),
      await rtorrentCall('d.completed_bytes', [infoHash]),
      await rtorrentCall('d.down.rate', [infoHash]),
    ];
    return { found: true, name, complete: Number(complete) === 1, sizeBytes: Number(sizeBytes) || 0, doneBytes: Number(doneBytes) || 0, downRate: Number(downRate) || 0 };
  } catch (err) {
    if (err.fault) return { found: false };
    throw err;
  }
}

// Cheap reachability probe for /avistaz status.
async function getRtorrentVersion() {
  return rtorrentCall('system.client_version', []);
}

module.exports = { rtorrentConfigured, serializeXmlRpcCall, parseXmlRpcResponse, computeInfoHash, rtorrentCall, addTorrentToRtorrent, getRtorrentStatus, getRtorrentVersion };
