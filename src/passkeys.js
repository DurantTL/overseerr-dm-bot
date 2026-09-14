'use strict';

const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const { sha256 } = require('./util');

const CHALLENGE_TTL_MS = 5 * 60000;

// Derives the WebAuthn relying-party ID and expected origin from the exact HTTPS URL the
// dashboard is reached at (DASHBOARD_PUBLIC_URL, defaulting to https://TUNNEL_DOMAIN — see
// src/config.js). Deliberately strict: only an exact HTTPS origin with no path, query, fragment,
// credentials, or explicit port is accepted, since the relying-party ID and expected origin are
// the whole trust boundary WebAuthn verification relies on (#190). Never derive either from a
// request's Host or forwarded-proto headers — those are attacker-controlled.
function passkeyRp(publicUrl) {
  const raw = String(publicUrl || '').trim();
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error('DASHBOARD_PUBLIC_URL must be a valid absolute URL, e.g. https://admin.example.com'); }
  if (parsed.protocol !== 'https:') throw new Error('DASHBOARD_PUBLIC_URL must use the https:// scheme');
  if (parsed.username || parsed.password) throw new Error('DASHBOARD_PUBLIC_URL must not include credentials');
  if (parsed.search) throw new Error('DASHBOARD_PUBLIC_URL must not include a query string');
  if (parsed.hash) throw new Error('DASHBOARD_PUBLIC_URL must not include a fragment');
  if (parsed.port) throw new Error('DASHBOARD_PUBLIC_URL must not include a port');
  if (parsed.pathname !== '/' && parsed.pathname !== '') throw new Error('DASHBOARD_PUBLIC_URL must not include a path');
  // Hostnames are case-insensitive and a trailing dot denotes the DNS root but is not part of the
  // name a browser/WebAuthn implementation compares against — normalize both away so
  // "Example.com" and "example.com." are treated identically to "example.com".
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname.includes('.') || /^[0-9.]+$/.test(hostname) || hostname.includes(':')) {
    throw new Error('DASHBOARD_PUBLIC_URL must be a real hostname, not an IP address or single label');
  }
  return { rpID: hostname, origin: `https://${hostname}` };
}

function createPasskeyService({ store, rpID, origin, now = Date.now }) {
  const challenges = new Map();
  const keyFor = (kind, binding) => `${kind}:${sha256(binding)}`;

  function remember(kind, binding, challenge, extra = {}) {
    if (!binding) throw new Error('Passkey ceremony binding is missing');
    for (const [key, entry] of challenges) {
      if (entry.expiresAt < now()) challenges.delete(key);
    }
    challenges.set(keyFor(kind, binding), { challenge, expiresAt: now() + CHALLENGE_TTL_MS, ...extra });
  }

  function consume(kind, binding) {
    const key = keyFor(kind, binding || '');
    const entry = challenges.get(key);
    challenges.delete(key);
    if (!entry || entry.expiresAt < now()) throw new Error('Passkey challenge is missing or expired');
    return entry;
  }

  async function registrationOptions(binding, label) {
    const cleanLabel = String(label || '').trim();
    if (!cleanLabel || cleanLabel.length > 64) throw new Error('Passkey label must be between 1 and 64 characters');
    const credentials = store.listPasskeys();
    const options = await generateRegistrationOptions({
      rpName: 'Durant Media Server',
      rpID,
      userName: 'dashboard-admin',
      userDisplayName: 'Dashboard administrator',
      userID: Buffer.from(sha256('dashboard-admin'), 'hex'),
      attestationType: 'none',
      excludeCredentials: credentials.map(credential => ({ id: credential.credential_id, transports: credential.transports })),
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'required',
        userVerification: 'required',
      },
    });
    remember('registration', binding, options.challenge, { label: cleanLabel });
    return options;
  }

  async function finishRegistration(binding, response) {
    const pending = consume('registration', binding);
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
    if (!verification.verified || !verification.registrationInfo) throw new Error('Passkey registration could not be verified');
    const credential = verification.registrationInfo.credential;
    store.savePasskey({
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey),
      counter: credential.counter,
      transports: response.response?.transports || [],
      label: pending.label,
      createdAt: now(),
    });
    return store.getPasskey(credential.id);
  }

  async function authenticationOptions(binding) {
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' });
    remember('authentication', binding, options.challenge);
    return options;
  }

  async function finishAuthentication(binding, response) {
    const pending = consume('authentication', binding);
    const credential = store.getPasskey(response?.id);
    if (!credential) throw new Error('Passkey is not enrolled');
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: credential.credential_id,
        publicKey: new Uint8Array(credential.public_key),
        counter: credential.counter,
        transports: credential.transports,
      },
      requireUserVerification: true,
    });
    if (!verification.verified) throw new Error('Passkey authentication could not be verified');
    store.updatePasskeyUse(credential.credential_id, verification.authenticationInfo.newCounter, now());
    return store.getPasskey(credential.credential_id);
  }

  return { registrationOptions, finishRegistration, authenticationOptions, finishAuthentication };
}

module.exports = { CHALLENGE_TTL_MS, passkeyRp, createPasskeyService };
