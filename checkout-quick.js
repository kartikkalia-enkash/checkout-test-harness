/**
 * EnKash Quick Checkout
 *
 *   <div id="enkash-quick-checkout"
 *        data-order_id="ORD_FROM_YOUR_SERVER"
 *        data-merchant-access-key="MERCHANT_ACCESS_KEY"></div>
 *   <script src="https://checkoutv3.enkash.com/checkout-quick.js"></script>
 *
 * No merchant JavaScript. Injects a Pay button, opens hosted checkout, and on
 * a terminal state redirects the browser to the order's return URL with the
 * payment result appended as query params (same as standalone checkout).
 *
 * Loads EnkashCheckout from `{origin}/assets/sdk/enkash-checkout-sdk.js` when
 * this file is served from a checkout host.
 */
(function (window, document) {
  'use strict';

  var CONTAINER_SELECTOR = '#enkash-quick-checkout, .enkash-quick-checkout';
  var BUTTON_LABEL = 'Pay with EnKash';
  var HOSTED_SDK_PATH = '/assets/sdk/enkash-checkout-sdk.js';
  var HOSTED_ORIGINS = {
    'https://checkoutv3.enkash.com': true,
    'https://checkout-uat-v3.enkash.in': true
  };

  // Never forwarded onto the merchant's return URL (mirrors buildStatusRedirectUri).
  var EXCLUDED_REDIRECT_PARAMS = {
    return_url: true,
    returnUrl: true,
    embedded: true,
    parentOrigin: true
  };

  var MSG_UNAVAILABLE = 'Checkout could not be loaded. Please try again.';
  var MSG_REDIRECT_FAILED = 'Payment completed, but we could not return you to the merchant. Please contact the merchant with your order ID.';

  var THIS_SCRIPT = document.currentScript;

  // ---- SDK + environment resolution ----

  function getSdkUrl() {
    if (THIS_SCRIPT && THIS_SCRIPT.getAttribute('data-sdk-src')) {
      return THIS_SCRIPT.getAttribute('data-sdk-src');
    }
    if (THIS_SCRIPT && THIS_SCRIPT.src) {
      try {
        var origin = new URL(THIS_SCRIPT.src, window.location.href).origin;
        if (HOSTED_ORIGINS[origin]) return origin + HOSTED_SDK_PATH;
      } catch (e) {}
      return THIS_SCRIPT.src.replace(/checkout-quick\.js(\?.*)?$/, 'checkout-sdk.js');
    }
    return 'checkout-sdk.js';
  }

  function getEnvOptions() {
    if (THIS_SCRIPT) {
      var baseAttr = THIS_SCRIPT.getAttribute('data-base-url');
      if (baseAttr) return { base_url: baseAttr };

      var envAttr = THIS_SCRIPT.getAttribute('data-env');
      if (envAttr) return { env: envAttr };
    }

    var inferred = inferBaseUrlFromScriptOrigin();
    return inferred ? { base_url: inferred } : {};
  }

  function withEnv(options) {
    var envOptions = getEnvOptions();
    if (envOptions.base_url) options.base_url = envOptions.base_url;
    if (envOptions.env) options.env = envOptions.env;
    return options;
  }

  function inferBaseUrlFromScriptOrigin() {
    if (!THIS_SCRIPT || !THIS_SCRIPT.src) return null;

    var environments = window.EnkashCheckout && window.EnkashCheckout.ENVIRONMENTS;
    if (!environments) return null;

    var scriptOrigin;
    try {
      scriptOrigin = new URL(THIS_SCRIPT.src, window.location.href).origin;
    } catch (e) {
      return null;
    }

    var names = Object.keys(environments);
    for (var i = 0; i < names.length; i++) {
      if (new URL(environments[names[i]]).origin === scriptOrigin) {
        return environments[names[i]];
      }
    }
    return null;
  }

  function loadSdk(onLoad, onError) {
    if (window.EnkashCheckout) {
      onLoad();
      return;
    }
    var script = document.createElement('script');
    script.src = getSdkUrl();
    script.async = true;
    script.onload = function () {
      if (window.EnkashCheckout) {
        onLoad();
      } else {
        console.error('[EnKash Quick Checkout] SDK loaded but EnkashCheckout is not defined.');
        onError();
      }
    };
    script.onerror = function () {
      console.error('[EnKash Quick Checkout] Failed to load SDK from ' + script.src);
      onError();
    };
    document.head.appendChild(script);
  }

  // ---- redirect ----

  function buildRedirectUrl(payload) {
    if (!payload) return null;
    var returnUrl = payload.returnUrl || payload.return_url;
    if (!returnUrl) return null;

    var url;
    try {
      url = new URL(String(returnUrl), window.location.href);
    } catch (e) {
      return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

    Object.keys(payload).forEach(function (key) {
      if (EXCLUDED_REDIRECT_PARAMS[key]) return;
      var value = payload[key];
      if (value === null || value === undefined) return;
      if (typeof value === 'object') return;
      // Empty strings (e.g. checksum) are forwarded as-is, never dropped.
      url.searchParams.set(key, String(value));
    });

    return url.toString();
  }

  // ---- UI ----

  function buildButton() {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = BUTTON_LABEL;
    btn.setAttribute('aria-label', BUTTON_LABEL);
    btn.style.cssText = [
      'display:inline-flex',
      'align-items:center',
      'justify-content:center',
      'gap:8px',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif',
      'font-size:15px',
      'font-weight:600',
      'color:#ffffff',
      'background-color:#1a73e8',
      'border:0',
      'border-radius:8px',
      'padding:12px 24px',
      'cursor:pointer',
      'line-height:1.2',
      'transition:opacity 0.15s ease'
    ].join(';');

    btn.addEventListener('mouseenter', function () { if (!btn.disabled) btn.style.opacity = '0.9'; });
    btn.addEventListener('mouseleave', function () { if (!btn.disabled) btn.style.opacity = '1'; });

    return btn;
  }

  function setButtonState(btn, state) {
    var busy = state !== 'idle';
    btn.disabled = busy;
    btn.style.opacity = busy ? '0.6' : '1';
    btn.style.cursor = busy ? 'default' : 'pointer';
    btn.textContent =
      state === 'opening' ? 'Opening checkout…' :
      state === 'redirecting' ? 'Redirecting…' :
      BUTTON_LABEL;
  }

  function showError(container, message) {
    var el = container.querySelector('[data-enkash-error]');
    if (!el) {
      el = document.createElement('div');
      el.setAttribute('data-enkash-error', '');
      el.setAttribute('role', 'alert');
      el.style.cssText = [
        'margin-top:8px',
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif',
        'font-size:13px',
        'color:#d93025'
      ].join(';');
      container.appendChild(el);
    }
    el.textContent = message;
  }

  function clearError(container) {
    var el = container.querySelector('[data-enkash-error]');
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  // ---- wiring ----

  function readContainerConfig(container) {
    var orderId = container.getAttribute('data-order_id');
    if (!orderId) {
      console.error('[EnKash Quick Checkout] Element is missing required data-order_id.', container);
      return null;
    }

    var merchantAccessKey = String(
      container.getAttribute('data-merchant-access-key') ||
      (THIS_SCRIPT && THIS_SCRIPT.getAttribute('data-merchant-access-key')) ||
      ''
    ).trim();
    if (!merchantAccessKey) {
      console.error('[EnKash Quick Checkout] Element is missing required data-merchant-access-key.', container);
      return null;
    }

    return { orderId: orderId, merchantAccessKey: merchantAccessKey };
  }

  function handleResult(container, button, payload) {
    var redirectUrl = buildRedirectUrl(payload);

    if (redirectUrl) {
      setButtonState(button, 'redirecting');
      window.location.assign(redirectUrl);
      return;
    }

    setButtonState(button, 'idle');

    if (payload && payload.reason === 'checkout_unavailable') {
      showError(container, MSG_UNAVAILABLE);
      return;
    }

    console.error('[EnKash Quick Checkout] Result has no valid returnUrl; cannot redirect.', payload);
    showError(container, MSG_REDIRECT_FAILED);
  }

  function initContainer(container) {
    if (container.getAttribute('data-enkash-initialized') === 'true') return;

    var config = readContainerConfig(container);
    if (!config) return;

    container.setAttribute('data-enkash-initialized', 'true');

    var button = buildButton();
    container.appendChild(button);

    button.addEventListener('click', function () {
      clearError(container);
      setButtonState(button, 'opening');

      var checkout;
      try {
        checkout = new window.EnkashCheckout(withEnv({
          order_id: config.orderId,
          merchantAccessKey: config.merchantAccessKey,
          handler: function (payload) {
            handleResult(container, button, payload);
          },
          modal: {
            escape: true,
            backdropclose: false,
            ondismiss: function () {
              setButtonState(button, 'idle');
            }
          }
        }));
      } catch (err) {
        console.error('[EnKash Quick Checkout] Failed to initialize checkout.', err);
        setButtonState(button, 'idle');
        showError(container, MSG_UNAVAILABLE);
        return;
      }

      checkout.open();
    });
  }

  function forEachContainer(fn) {
    var containers = document.querySelectorAll(CONTAINER_SELECTOR);
    for (var i = 0; i < containers.length; i++) fn(containers[i]);
  }

  function start() {
    loadSdk(
      function () { forEachContainer(initContainer); },
      function () {
        forEachContainer(function (container) {
          if (readContainerConfig(container)) showError(container, MSG_UNAVAILABLE);
        });
      }
    );
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})(window, document);