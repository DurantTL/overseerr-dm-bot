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

  // A WebAuthn RP ID/expected origin is bound to one exact HTTPS origin (#190) — a browser
  // rejects navigator.credentials.create()/.get() with a SecurityError when the page's current
  // origin does not match, but its own error message ("not a valid domain") is meaningless to an
  // operator who doesn't know what WebAuthn compares. Checking location.origin against the
  // server-configured expected origin BEFORE making that call turns an opaque browser failure into
  // an actionable "open the dashboard at this URL instead" message, with a working link.
  function originMismatch(expectedOrigin, context) {
    var browser = context || {};
    if (!expectedOrigin || !browser.location || browser.location.origin === expectedOrigin) return null;
    return 'This page is open at ' + browser.location.origin + ', but passkeys are configured for '
      + expectedOrigin + '. Open the dashboard at ' + expectedOrigin + '/admin instead.';
  }

  function preparePasskeyAction(button, note, context, suffix, expectedOrigin) {
    var availability = webAuthnAvailability(context);
    var mismatch = availability.supported ? originMismatch(expectedOrigin, context) : null;
    if (availability.supported && !mismatch) return true;
    if (!button) return false;
    button.disabled = true;
    if (button.setAttribute) button.setAttribute('aria-disabled', 'true');
    if (note) {
      note.hidden = false;
      note.textContent = (mismatch || availability.reason) + (suffix || '');
      note.className = note.className.indexOf('error') >= 0 ? note.className : 'save-note bad';
    }
    return false;
  }

  function passkeyErrorMessage(error, context, expectedOrigin) {
    var message = error && error.message ? error.message : String(error || 'Passkey request failed.');
    var mismatch = originMismatch(expectedOrigin, context);
    // A SecurityError (Chrome/Safari/Firefox all use this DOMException name for an RP ID/origin
    // that doesn't match the page) means the preflight check above either didn't run or the
    // origin changed between preflight and the actual call — same actionable message either way.
    if (mismatch && (error && error.name === 'SecurityError' || /securityerror|is not a valid domain|invalid domain/i.test(message))) {
      return mismatch;
    }
    if (/webauthn is not supported|publickeycredential|secure context/i.test(message)) {
      var availability = webAuthnAvailability(context);
      return availability.supported
        ? 'Passkeys could not start in this browser or embedded webview. ' + OPEN_BROWSER
        : availability.reason;
    }
    return message;
  }

  return {
    webAuthnAvailability: webAuthnAvailability,
    preparePasskeyAction: preparePasskeyAction,
    passkeyErrorMessage: passkeyErrorMessage,
  };
});
