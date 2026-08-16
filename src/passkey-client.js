(function exposePasskeyClient(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PasskeyClient = api;
})(typeof globalThis === 'object' ? globalThis : this, function createPasskeyClient() {
  var OPEN_BROWSER = 'Open this dashboard over HTTPS in Safari, Chrome, Edge, or another WebAuthn-capable browser.';

  function webAuthnAvailability(context) {
    var browser = context || {};
    if (browser.isSecureContext !== true) {
      return { supported: false, reason: 'Passkeys require a secure browser context. ' + OPEN_BROWSER };
    }
    if (typeof browser.PublicKeyCredential !== 'function' || !browser.navigator || !browser.navigator.credentials) {
      return { supported: false, reason: 'Passkeys are not available in this browser or embedded webview. ' + OPEN_BROWSER };
    }
    return { supported: true, reason: '' };
  }

  function preparePasskeyAction(button, note, context, suffix) {
    var availability = webAuthnAvailability(context);
    if (availability.supported || !button) return availability.supported;
    button.disabled = true;
    if (button.setAttribute) button.setAttribute('aria-disabled', 'true');
    if (note) {
      note.hidden = false;
      note.textContent = availability.reason + (suffix || '');
      note.className = note.className.indexOf('error') >= 0 ? note.className : 'save-note bad';
    }
    return false;
  }

  function passkeyErrorMessage(error, context) {
    var message = error && error.message ? error.message : String(error || 'Passkey request failed.');
    if (/webauthn is not supported|publickeycredential|secure context/i.test(message)) {
      var availability = webAuthnAvailability(context);
      return availability.supported
        ? 'Passkeys could not start in this browser or embedded webview. ' + OPEN_BROWSER
        : availability.reason;
    }
    return message;
  }

  return { webAuthnAvailability: webAuthnAvailability, preparePasskeyAction: preparePasskeyAction, passkeyErrorMessage: passkeyErrorMessage };
});
