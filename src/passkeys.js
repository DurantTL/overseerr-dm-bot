'use strict';

const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const { sha256 } = require('./util');

const CHALLENGE_TTL_MS = 5 * 60000;

function passkeyRp(tunnelDomain) {
  const value = String(tunnelDomain || '').trim().toLowerCase();
  if (!URL.canParse(`https://${value}`)) throw new Error('TUNNEL_DOMAIN must be a hostname before passkeys can be used');
  const parsed = new URL(`https://${value}`);
  if (!value.includes('.') || parsed.hostname !== value || parsed.port || parsed.pathname !== '/') {
    throw new Error('TUNNEL_DOMAIN must be a hostname before passkeys can be used');
  }
  return { rpID: value, origin: `https://${value}` };
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
