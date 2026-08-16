#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const { webAuthnAvailability, preparePasskeyAction, passkeyErrorMessage } = require('../../src/passkey-client');

const supportedContext = () => ({
  isSecureContext: true,
  PublicKeyCredential: function PublicKeyCredential() {},
  navigator: { credentials: {} },
});

function controls() {
  const listeners = {};
  const button = {
    disabled: false,
    attributes: {},
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(name, handler) { listeners[name] = handler; },
  };
  const note = { hidden: true, textContent: '', className: 'save-note' };
  return { button, note, listeners };
}

test('passkey client: supported secure browsers keep the action available', () => {
  const { button, note } = controls();
  assert.deepStrictEqual(webAuthnAvailability(supportedContext()), { supported: true, reason: '' });
  assert.strictEqual(preparePasskeyAction(button, note, supportedContext()), true);
  assert.strictEqual(button.disabled, false);
  assert.strictEqual(note.hidden, true);
});

test('passkey client: insecure contexts disable the action with an HTTPS browser remedy', () => {
  const { button, note } = controls();
  const context = { ...supportedContext(), isSecureContext: false };
  assert.strictEqual(preparePasskeyAction(button, note, context), false);
  assert.strictEqual(button.disabled, true);
  assert.strictEqual(button.attributes['aria-disabled'], 'true');
  assert.strictEqual(note.hidden, false);
  assert.match(note.textContent, /secure browser context/);
  assert.match(note.textContent, /over HTTPS in Safari, Chrome, Edge/);
});

test('passkey client: unsupported browsers and embedded webviews get an actionable explanation', () => {
  const { button, note } = controls();
  const context = { isSecureContext: true, navigator: {} };
  assert.strictEqual(preparePasskeyAction(button, note, context), false);
  assert.strictEqual(button.disabled, true);
  assert.match(note.textContent, /not available in this browser or embedded webview/);
  assert.match(note.textContent, /WebAuthn-capable browser/);
});

test('passkey client: unsupported contexts never attach the handler that requests options', () => {
  let optionRequests = 0;
  const wire = context => {
    const control = controls();
    const ready = preparePasskeyAction(control.button, control.note, context);
    if (ready) control.button.addEventListener('click', () => { optionRequests++; });
    return control;
  };

  let control = wire({ isSecureContext: true, navigator: {} });
  control.listeners.click?.();
  assert.strictEqual(optionRequests, 0, 'unsupported clients cannot reach the options request handler');

  control = wire(supportedContext());
  control.listeners.click();
  assert.strictEqual(optionRequests, 1, 'supported clients retain the existing options flow');
});

test('passkey client: raw library support errors become the same actionable browser guidance', () => {
  const message = passkeyErrorMessage(new Error('WebAuthn is not supported in this browser.'), { isSecureContext: true, navigator: {} });
  assert.doesNotMatch(message, /WebAuthn is not supported in this browser/);
  assert.match(message, /embedded webview/);
  assert.match(message, /Open this dashboard over HTTPS/);
  assert.strictEqual(passkeyErrorMessage(new Error('Passkey was cancelled.'), supportedContext()), 'Passkey was cancelled.');
});
