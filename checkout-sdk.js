/**
 * EnKash Checkout SDK
 * Embeds EnKash's hosted checkout as an iframe overlay on the merchant's page.
 *
 * Usage:
 *   var checkout = new EnkashCheckout({
 *     order_id: "order_xxx",
 *     handler: function (response) { ... },
 *     modal: { ondismiss: function () {}, escape: true, backdropclose: false }
 *   });
 *   checkout.open();
 *
 * `handler` is the single channel for every outcome: the gateway RESULT
 * payload, unchanged, for any real transaction outcome — or the generic
 * { status: "FAILED", reason: "checkout_unavailable" } if checkout never
 * came up at all. `modal.ondismiss` fires only on a voluntary close
 * (escape key, backdrop click).
 */
(function (window, document) {
  'use strict';

  var CHECKOUT_BASE_URL = 'https://checkoutv3.enkash.com/'; // TODO: swap per env (dev/uat/prod)
  // Derived, not hand-typed — avoids origin-mismatch bugs (event.origin never has a trailing slash).
  var CHECKOUT_ORIGIN = new URL(CHECKOUT_BASE_URL).origin;

  var MESSAGE_TYPES = {
    READY: 'enkash:ready',
    RESIZE: 'enkash:resize',
    RESULT: 'enkash:result',
    DISMISS: 'enkash:dismiss',
    ACK: 'enkash:ack'
  };

  // Matches the actual desktop shell (~1115x646). Capped to viewport so it
  // never overflows on smaller merchant pages; LayoutModeService's own
  // matchMedia inside the iframe then picks compact vs desktop correctly
  // based on the *iframe's* real width — no forcing needed on our side.
  var DEFAULT_WIDTH = 1115;
  var DEFAULT_HEIGHT = 646;

  // Below this width, go full-screen edge-to-edge instead of a centered
  // rounded card — matches Razorpay/Stripe mobile presentation.
  var MOBILE_BREAKPOINT_PX = 640;

  // If the iframe never sends enkash:ready within this window (checkout
  // down, network failure, bad order_id before the app even boots), the
  // merchant would otherwise be stuck with a permanently blank overlay and
  // no callback ever firing. Report it through `handler` as a generic
  // pre-transaction failure so their integration code can recover.
  var READY_TIMEOUT_MS = 15000;

  // The one shape used for every failure that happens BEFORE a transaction
  // exists (load timeout, throw while opening the overlay). Deliberately
  // generic: no code enum, no source/step taxonomy. Anything that reached
  // the gateway comes back as the RESULT payload instead, untouched.
  // Built fresh per call so a merchant handler can't mutate a shared object.
  function checkoutUnavailableResult() {
    return { status: 'FAILED', reason: 'checkout_unavailable' };
  }

  function EnkashCheckout(options) {
    if (!options || !options.order_id) {
      throw new Error('EnkashCheckout: `order_id` is required');
    }
    if (typeof options.handler !== 'function') {
      throw new Error('EnkashCheckout: `handler` function is required');
    }

    this.options = options;
    this.modalOptions = options.modal || {};
    this.overlayEl = null;
    this.iframeEl = null;
    this._messageListener = null;
    this._keydownListener = null;
    this._resizeListener = null;
    this._readyTimeoutTimer = null;
    this._isOpen = false;
    this._isMobileLayout = null; // tracked so we only touch DOM on actual changes
  }

  EnkashCheckout.prototype.open = function () {
    if (this._isOpen) return;
    this._isOpen = true;

    try {
      this._buildDom();
      this._attachListeners();
    } catch (err) {
      // Overlay/iframe construction threw. No transaction was ever created,
      // so this is the same class of failure as a load timeout and goes
      // down the same single channel.
      this._failUnavailable();
      return;
    }

    document.body.style.overflow = 'hidden'; // prevent background scroll

    var self = this;
    this._readyTimeoutTimer = setTimeout(function () {
      self._readyTimeoutTimer = null;
      self._failUnavailable();
    }, READY_TIMEOUT_MS);
  };

  EnkashCheckout.prototype.close = function () {
    if (!this._isOpen) return;
    this._teardown();
  };

  // ---- internal ----

  EnkashCheckout.prototype._isMobileViewport = function () {
    return window.matchMedia('(max-width: ' + MOBILE_BREAKPOINT_PX + 'px)').matches;
  };

  /**
   * Mobile layout does NOT use width:100vw/height:100vh — those units are
   * unreliable on mobile Safari/Chrome because the dynamic address-bar/toolbar
   * changes the *visual* viewport without vh/vw updating consistently, which
   * is exactly what produced the "iframe doesn't cover the full screen" gaps.
   *
   * Instead, on mobile the iframe itself becomes position:fixed;inset:0,
   * exactly like the overlay already is — pinned directly to the real
   * viewport by the browser, not computed via vw/vh math.
   */
  EnkashCheckout.prototype._applyLayoutForViewport = function () {
    var mobile = this._isMobileViewport();
    if (mobile === this._isMobileLayout) return; // no change, skip DOM writes
    this._isMobileLayout = mobile;

    if (!this.iframeEl || !this.overlayEl) return;

    if (mobile) {
      this.overlayEl.style.alignItems = 'stretch';
      this.overlayEl.style.justifyContent = 'stretch';

      this.iframeEl.style.position = 'fixed';
      this.iframeEl.style.top = '0';
      this.iframeEl.style.right = '0';
      this.iframeEl.style.bottom = '0';
      this.iframeEl.style.left = '0';
      // iframes are replaced elements — unlike a <div>, an iframe with
      // width/height left as `auto` falls back to its intrinsic default
      // size (~300x150), it does NOT stretch to fill `inset:0` the way a
      // div would. Percentage sizing is required alongside inset for this
      // to actually fill the fixed-position box.
      this.iframeEl.style.width = '100%';
      this.iframeEl.style.height = '100%';
      this.iframeEl.style.maxWidth = 'none';
      this.iframeEl.style.maxHeight = 'none';
      this.iframeEl.style.borderRadius = '0';
    } else {
      this.overlayEl.style.alignItems = 'center';
      this.overlayEl.style.justifyContent = 'center';

      this.iframeEl.style.position = 'static';
      this.iframeEl.style.top = '';
      this.iframeEl.style.right = '';
      this.iframeEl.style.bottom = '';
      this.iframeEl.style.left = '';
      this.iframeEl.style.width = DEFAULT_WIDTH + 'px';
      this.iframeEl.style.height = DEFAULT_HEIGHT + 'px';
      this.iframeEl.style.maxWidth = '100vw';
      this.iframeEl.style.maxHeight = '100vh';
      this.iframeEl.style.borderRadius = '12px';
    }
  };

  EnkashCheckout.prototype._buildDom = function () {
    var overlay = document.createElement('div');
    overlay.setAttribute('id', 'enkash-checkout-overlay');
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483000',
      'background:rgba(0,0,0,0.5)',
      'display:flex',
      'align-items:center',
      'justify-content:center'
    ].join(';');

    var iframe = document.createElement('iframe');
    iframe.setAttribute('id', 'enkash-checkout-iframe');
    iframe.setAttribute('title', 'EnKash Checkout');
    iframe.setAttribute(
      'sandbox',
      'allow-scripts allow-same-origin allow-forms allow-popups allow-top-navigation-by-user-activation allow-popups-to-escape-sandbox allow-modals'
    );
    iframe.style.cssText = [
      'border:0',
      'width:' + DEFAULT_WIDTH + 'px',
      'height:' + DEFAULT_HEIGHT + 'px', // corrected immediately below via viewport check
      'max-width:100vw',
      'max-height:100vh',
      'background:transparent',
      'border-radius:12px',
      'touch-action:manipulation'
    ].join(';');

    var src = CHECKOUT_BASE_URL + '/v1/pay/' + encodeURIComponent(this.options.order_id) +
      '?embedded=true&parentOrigin=' + encodeURIComponent(window.location.origin);
    iframe.src = src;

    overlay.appendChild(iframe);

    if (this.modalOptions.backdropclose === true) {
      var self = this;
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) {
          self._userDismiss();
        }
      });
    }

    document.body.appendChild(overlay);
    this.overlayEl = overlay;
    this.iframeEl = iframe;

    // Apply correct layout immediately (handles the case where the page is
    // already narrow on open, e.g. loaded directly on a phone).
    this._applyLayoutForViewport();
  };

  EnkashCheckout.prototype._attachListeners = function () {
    var self = this;

    this._messageListener = function (event) {
      if (event.origin !== CHECKOUT_ORIGIN) return; // ignore anything not from our checkout
      if (!self.iframeEl || event.source !== self.iframeEl.contentWindow) return;

      var data = event.data || {};
      switch (data.type) {
        case MESSAGE_TYPES.READY:
          // Handshake complete — checkout is confirmed alive. Clear the
          // load-timeout so a slow-but-successful load doesn't get
          // wrongly treated as a failure.
          if (self._readyTimeoutTimer) {
            clearTimeout(self._readyTimeoutTimer);
            self._readyTimeoutTimer = null;
          }
          break;

        case MESSAGE_TYPES.RESIZE:
          // Only meaningful in the non-mobile (card) layout — full-screen
          // mobile layout is pinned via inset:0 and ignores height hints.
          if (!self._isMobileLayout && data.payload && typeof data.payload.height === 'number') {
            self.iframeEl.style.height = data.payload.height + 'px';
          }
          break;

        case MESSAGE_TYPES.RESULT:
          self._ack(data.messageId);
          self._teardown();
          self.options.handler(data.payload);
          break;

        case MESSAGE_TYPES.DISMISS:
          self._ack(data.messageId);
          self._userDismiss();
          break;
      }
    };

    window.addEventListener('message', this._messageListener);

    if (this.modalOptions.escape !== false) {
      this._keydownListener = function (e) {
        if (e.key === 'Escape') {
          self._userDismiss();
        }
      };
      document.addEventListener('keydown', this._keydownListener);
    }

    // Re-evaluate mobile/desktop layout on resize (window resize, or a phone
    // rotating between portrait/landscape).
    this._resizeListener = function () {
      self._applyLayoutForViewport();
    };
    window.addEventListener('resize', this._resizeListener);
  };

  EnkashCheckout.prototype._ack = function (messageId) {
    if (!this.iframeEl || !messageId) return;
    this.iframeEl.contentWindow.postMessage(
      { type: MESSAGE_TYPES.ACK, payload: { messageId: messageId } },
      CHECKOUT_ORIGIN
    );
  };

  // Voluntary close only — escape key, backdrop click, or the iframe asking
  // to be dismissed. Failures never come through here; they go to `handler`
  // via _failUnavailable() so there is exactly one failure channel.
  EnkashCheckout.prototype._userDismiss = function () {
    this._teardown();
    if (typeof this.modalOptions.ondismiss === 'function') {
      this.modalOptions.ondismiss();
    }
  };

  // Single failure channel for everything that dies before a transaction
  // exists. Same order as the RESULT path: tear the overlay down first, then
  // hand off, so the merchant's handler runs against a clean page.
  EnkashCheckout.prototype._failUnavailable = function () {
    this._teardown();
    this.options.handler(checkoutUnavailableResult());
  };

  EnkashCheckout.prototype._teardown = function () {
    if (this._messageListener) {
      window.removeEventListener('message', this._messageListener);
      this._messageListener = null;
    }
    if (this._keydownListener) {
      document.removeEventListener('keydown', this._keydownListener);
      this._keydownListener = null;
    }
    if (this._resizeListener) {
      window.removeEventListener('resize', this._resizeListener);
      this._resizeListener = null;
    }
    if (this._readyTimeoutTimer) {
      clearTimeout(this._readyTimeoutTimer);
      this._readyTimeoutTimer = null;
    }
    if (this.overlayEl && this.overlayEl.parentNode) {
      this.overlayEl.parentNode.removeChild(this.overlayEl);
    }
    this.overlayEl = null;
    this.iframeEl = null;
    this._isMobileLayout = null;
    document.body.style.overflow = '';
    this._isOpen = false;
  };

  window.EnkashCheckout = EnkashCheckout;
})(window, document);