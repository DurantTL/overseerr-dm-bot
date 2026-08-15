#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { isoCBOR } = require('@simplewebauthn/server/helpers');
const { createPasskeyService, passkeyRp } = require('../../src/passkeys');

const b64 = value => Buffer.from(value).toString('base64url');

function credentialFixture() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credentialId = crypto.randomBytes(32);
  const cosePublicKey = isoCBOR.encode(new Map([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, Buffer.from(jwk.x, 'base64url')],
    [-3, Buffer.from(jwk.y, 'base64url')],
  ]));

  function clientData(type, challenge, origin) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  function authenticatorData(rpID, counter, attested = false) {
    const head = Buffer.alloc(37);
    crypto.createHash('sha256').update(rpID).digest().copy(head, 0);
    head[32] = attested ? 0x45 : 0x05;
    head.writeUInt32BE(counter, 33);
    if (!attested) return head;
    const length = Buffer.alloc(2);
    length.writeUInt16BE(credentialId.length);
    return Buffer.concat([head, Buffer.alloc(16), length, credentialId, Buffer.from(cosePublicKey)]);
  }

  function registration(challenge, origin, rpID) {
    const client = clientData('webauthn.create', challenge, origin);
    const attestationObject = isoCBOR.encode(new Map([
      ['fmt', 'none'],
      ['attStmt', new Map()],
      ['authData', authenticatorData(rpID, 0, true)],
    ]));
    return {
      id: b64(credentialId), rawId: b64(credentialId), type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {},
      response: { clientDataJSON: b64(client), attestationObject: b64(attestationObject), transports: ['internal'] },
    };
  }

  function authentication(challenge, origin, rpID, counter) {
    const client = clientData('webauthn.get', challenge, origin);
    const authData = authenticatorData(rpID, counter);
    const signatureBase = Buffer.concat([authData, crypto.createHash('sha256').update(client).digest()]);
    const signature = crypto.sign('sha256', signatureBase, privateKey);
    return {
      id: b64(credentialId), rawId: b64(credentialId), type: 'public-key', clientExtensionResults: {}, authenticatorAttachment: 'platform',
      response: { authenticatorData: b64(authData), clientDataJSON: b64(client), signature: b64(signature), userHandle: b64(Buffer.from('dashboard-admin')) },
    };
  }

  return { id: b64(credentialId), registration, authentication };
}

function memoryStore() {
  const records = new Map();
  return {
    records,
    listPasskeys: () => [...records.values()],
    getPasskey: id => records.get(id) || null,
    savePasskey: row => records.set(row.credentialId, {
      credential_id: row.credentialId,
      public_key: Buffer.from(row.publicKey),
      counter: row.counter,
      transports: row.transports,
      label: row.label,
      created_at: row.createdAt,
      last_used_at: null,
    }),
    updatePasskeyUse: (id, counter, lastUsedAt) => Object.assign(records.get(id), { counter, last_used_at: lastUsedAt }),
  };
}

test('passkeys: RP is exactly the tunnel hostname and HTTPS origin', () => {
  assert.deepStrictEqual(passkeyRp('Admin.Example.com'), { rpID: 'admin.example.com', origin: 'https://admin.example.com' });
  assert.throws(() => passkeyRp('https://admin.example.com'), /hostname/);
  assert.throws(() => passkeyRp('localhost'), /hostname/);
});

test('passkeys: registration verifies challenge, origin, and RP ID', async () => {
  const store = memoryStore();
  const service = createPasskeyService({ store, rpID: 'admin.example.com', origin: 'https://admin.example.com' });
  const fixture = credentialFixture();
  const options = await service.registrationOptions('session-good', 'Phone');
  const registered = await service.finishRegistration('session-good', fixture.registration(options.challenge, 'https://admin.example.com', 'admin.example.com'));
  assert.strictEqual(registered.label, 'Phone');
  assert.strictEqual(registered.transports[0], 'internal');
  await assert.rejects(() => service.finishRegistration('session-good', fixture.registration(options.challenge, 'https://admin.example.com', 'admin.example.com')), /missing or expired/);

  for (const [name, challenge, origin, rpID] of [
    ['challenge', 'wrong-challenge', 'https://admin.example.com', 'admin.example.com'],
    ['origin', null, 'https://evil.example.com', 'admin.example.com'],
    ['RP ID', null, 'https://admin.example.com', 'evil.example.com'],
  ]) {
    const binding = `session-${name}`;
    const next = await service.registrationOptions(binding, name);
    await assert.rejects(() => service.finishRegistration(binding, fixture.registration(challenge || next.challenge, origin, rpID)));
  }
});

test('passkeys: authentication is single-use, strict, counter checked, and revocable', async () => {
  const store = memoryStore();
  let now = 1000;
  const service = createPasskeyService({ store, rpID: 'admin.example.com', origin: 'https://admin.example.com', now: () => now });
  const fixture = credentialFixture();
  const registration = await service.registrationOptions('registration', 'Phone');
  await service.finishRegistration('registration', fixture.registration(registration.challenge, 'https://admin.example.com', 'admin.example.com'));

  const first = await service.authenticationOptions('login-1');
  await service.finishAuthentication('login-1', fixture.authentication(first.challenge, 'https://admin.example.com', 'admin.example.com', 1));
  assert.strictEqual(store.records.get(fixture.id).counter, 1);
  await assert.rejects(() => service.finishAuthentication('login-1', fixture.authentication(first.challenge, 'https://admin.example.com', 'admin.example.com', 2)), /missing or expired/);

  for (const [name, challenge, origin, rpID] of [
    ['challenge', 'wrong-challenge', 'https://admin.example.com', 'admin.example.com'],
    ['origin', null, 'https://evil.example.com', 'admin.example.com'],
    ['RP ID', null, 'https://admin.example.com', 'evil.example.com'],
  ]) {
    const options = await service.authenticationOptions(`login-${name}`);
    await assert.rejects(() => service.finishAuthentication(`login-${name}`, fixture.authentication(challenge || options.challenge, origin, rpID, 2)));
  }

  const counter = await service.authenticationOptions('login-counter');
  await assert.rejects(() => service.finishAuthentication('login-counter', fixture.authentication(counter.challenge, 'https://admin.example.com', 'admin.example.com', 1)), /counter value/);

  store.records.delete(fixture.id);
  const revoked = await service.authenticationOptions('login-revoked');
  await assert.rejects(() => service.finishAuthentication('login-revoked', fixture.authentication(revoked.challenge, 'https://admin.example.com', 'admin.example.com', 2)), /not enrolled/);
  now += 6 * 60000;
  const expired = await service.authenticationOptions('login-expired');
  now += 6 * 60000;
  await assert.rejects(() => service.finishAuthentication('login-expired', fixture.authentication(expired.challenge, 'https://admin.example.com', 'admin.example.com', 2)), /missing or expired/);
});
