/**
 * EnKash Quick Checkout
 * A zero-JS wrapper over EnkashCheckout (checkout-sdk.js).
 *
 * Merchant usage — this is the ENTIRE integration, no other JS required:
 *
 *   <div id="enkash-quick-checkout" data-order_id="order_xxx"></div>
 *   <script src="https://checkout-uat-v3.enkash.in/checkout-quick.js"></script>
 *
 * Multiple buttons on one page are supported too — just repeat the marker:
 *
 *   <div class="enkash-quick-checkout" data-order_id="order_aaa"></div>
 *   <div class="enkash-quick-checkout" data-order_id="order_bbb"></div>
 *   <script src="https://checkout-uat-v3.enkash.in/checkout-quick.js"></script>
 *
 * What this file does, in order:
 *   1. Loads checkout-sdk.js (EnkashCheckout) from the same host, if not
 *      already present on the page.
 *   2. Finds every element marked as a Quick Checkout container and injects
 *      our own branded "Pay with EnKash" button into it. Merchant does not
 *      style this button.
 *   3. On click, opens the existing EnkashCheckout iframe with the given
 *      order_id — identical to Standard Checkout under the hood.
 *   4. Supplies its OWN internal `handler` (the merchant never writes one).
 *      When the iframe returns a result (success or failure — the iframe
 *      already renders the failure state itself before returning), this
 *      handler redirects the top-level page to the merchant's returnUrl,
 *      exactly the way the status page's buildStatusRedirectUri() does:
 *      strip internal-only fields, append the rest as a query string, and
 *      navigate. No merchant JS is ever invoked. Failures that happen before
 *      a transaction exists (SDK file unreachable, checkout never loading)
 *      travel the same route as { status: "FAILED",
 *      reason: "checkout_unavailable" }.
 */
(function (window, document) {
  'use strict';

  var CONTAINER_SELECTOR = '#enkash-quick-checkout, .enkash-quick-checkout';

  // Fields that describe how/where to deliver the result, not payment data
  // itself — never forwarded onto the merchant's returnUrl as extra params.
  var STRIP_KEYS = ['return_url', 'returnUrl', 'notifyUrl', 'embedded', 'parentOrigin'];

  var BUTTON_LABEL = 'Pay with EnKash';

  // Same generic pre-transaction failure shape checkout-sdk.js passes to
  // `handler`. Duplicated here on purpose: the path that needs it most is
  // the one where checkout-sdk.js never loaded, so nothing from it exists.
  function checkoutUnavailableResult() {
    return { status: 'FAILED', reason: 'checkout_unavailable' };
  }

  // ---- bootstrapping: make sure EnkashCheckout is available ----

  function getSdkUrl() {
    var thisScript = document.currentScript;
    // data-sdk-src lets a specific deployment override the default sibling
    // path, e.g. if checkout-sdk.js is hosted elsewhere.
    if (thisScript && thisScript.getAttribute('data-sdk-src')) {
      return thisScript.getAttribute('data-sdk-src');
    }
    if (thisScript && thisScript.src) {
      return thisScript.src.replace(/checkout-quick\.js(\?.*)?$/, 'checkout-sdk.js');
    }
    // Fallback: shouldn't normally happen (document.currentScript is null
    // only if this file was injected asynchronously by other code).
    return 'checkout-sdk.js';
  }

  function loadSdk(callback) {
    if (window.EnkashCheckout) {
      callback();
      return;
    }
    var script = document.createElement('script');
    script.src = getSdkUrl();
    script.async = true;
    script.onload = function () {
      if (window.EnkashCheckout) {
        callback();
      } else {
        console.error('[EnKash Quick Checkout] checkout-sdk.js loaded but EnkashCheckout is not defined.');
      }
    };
    script.onerror = function () {
      console.error('[EnKash Quick Checkout] Failed to load checkout-sdk.js from ' + script.src);
      // EnkashCheckout will never exist, so no checkout can be opened at
      // all. Same terminal outcome as the SDK's own pre-transaction
      // failures, delivered down the same path.
      deliverResult(checkoutUnavailableResult());
    };
    document.head.appendChild(script);
  }

  // ---- button rendering ----

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

    btn.addEventListener('mouseenter', function () { btn.style.opacity = '0.9'; });
    btn.addEventListener('mouseleave', function () { btn.style.opacity = '1'; });

    return btn;
  }

  function setButtonLoading(btn, isLoading) {
    btn.disabled = isLoading;
    btn.style.opacity = isLoading ? '0.6' : '1';
    btn.style.cursor = isLoading ? 'default' : 'pointer';
    btn.textContent = isLoading ? 'Opening checkout…' : BUTTON_LABEL;
  }

  // ---- result delivery (the redirect-yourself piece) ----

  function buildRedirectUrl(payload) {
    var returnUrl = payload.returnUrl || payload.return_url;
    if (!returnUrl) {
      return null;
    }

    var params = new URLSearchParams();
    Object.keys(payload).forEach(function (key) {
      if (STRIP_KEYS.indexOf(key) === -1 && payload[key] !== undefined && payload[key] !== null) {
        params.set(key, payload[key]);
      }
    });

    // Mirror buildStatusRedirectUri(): normalize the message field name.
    if (!params.has('transactionMessage')) {
      var msg = payload.txnMsg || payload.txnMessage;
      if (msg) {
        params.set('transactionMessage', msg);
      }
    }

    var separator = returnUrl.indexOf('?') === -1 ? '?' : '&';
    return returnUrl + separator + params.toString();
  }

  function deliverResult(payload) {
    var url = buildRedirectUrl(payload);
    if (!url) {
      // No returnUrl on the payload — nothing we can redirect to. This is
      // a configuration problem (order/merchant missing a return URL), not
      // a payment failure, so it's logged rather than silently swallowed.
      console.error('[EnKash Quick Checkout] No returnUrl present in result payload; cannot redirect.', payload);
      return;
    }
    window.location.href = url;
  }

  // ---- wiring a single container up ----

  function initContainer(container) {
    var orderId = container.getAttribute('data-order_id');
    if (!orderId) {
      console.error('[EnKash Quick Checkout] Element is missing required data-order_id.', container);
      return;
    }

    // Avoid double-init if this script is somehow evaluated twice.
    if (container.getAttribute('data-enkash-initialized') === 'true') {
      return;
    }
    container.setAttribute('data-enkash-initialized', 'true');

    var button = buildButton();
    container.appendChild(button);

    button.addEventListener('click', function () {
      setButtonLoading(button, true);

      var checkout;
      try {
        checkout = new window.EnkashCheckout({
          order_id: orderId,
          handler: function (payload) {
            // Every non-voluntary outcome lands here: the gateway RESULT
            // payload (the iframe has already shown the failure state to
            // the user if applicable), or the SDK's generic
            // { status: "FAILED", reason: "checkout_unavailable" } when
            // checkout never came up. Both are delivered to returnUrl.
            // NOTE: PENDING_WITH_BANK is forwarded as-is like any other status today; may need dedicated handling later.
            deliverResult(payload);
          },
          modal: {
            escape: true,
            backdropclose: false,
            ondismiss: function () {
              // Voluntary close only (escape / backdrop) — user chose not to
              // pay, so re-enable the button. Failures do not reach here;
              // they arrive via `handler` and redirect to returnUrl.
              setButtonLoading(button, false);
            }
          }
        });
      } catch (err) {
        // Construction threw, so the SDK never got the chance to call our
        // handler. No transaction exists — same generic failure, same path.
        console.error('[EnKash Quick Checkout] Failed to initialize checkout.', err);
        deliverResult(checkoutUnavailableResult());
        return;
      }

      checkout.open();
    });
  }

  function initAll() {
    var containers = document.querySelectorAll(CONTAINER_SELECTOR);
    for (var i = 0; i < containers.length; i++) {
      initContainer(containers[i]);
    }
  }

  function start() {
    loadSdk(initAll);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})(window, document);
