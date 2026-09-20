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
 * Environment: defaults to production. Override per instance with
 * `env: 'local' | 'uat' | 'prod'` or `base_url: 'https://…'`, or page-wide
 * by setting `window.EnkashCheckoutConfig = { env: 'uat' }` before opening.
 *
 * `handler` is the single channel for every outcome: the gateway RESULT
 * payload, unchanged, for any real transaction outcome — or the generic
 * { status: "FAILED", reason: "checkout_unavailable" } if checkout never
 * came up at all. `modal.ondismiss` fires only on a voluntary close
 * (escape key, backdrop click).
 */
(function (window, document) {
  'use strict';

  // Known checkout deployments. Stored without a trailing slash so path
  // joining below never produces a double slash.
  var ENVIRONMENTS = {
    local: 'http://localhost:4200',
    uat: 'https://checkout-uat-v3.enkash.in',
    prod: 'https://checkoutv3.enkash.com'
  };

  var DEFAULT_ENV = 'prod';

  /**
   * Where checkout is loaded from, in precedence order:
   *   1. options.base_url        — explicit URL, per instance
   *   2. options.env             — 'local' | 'uat' | 'prod', per instance
   *   3. window.EnkashCheckoutConfig.base_url  — page-wide explicit URL
   *   4. window.EnkashCheckoutConfig.env       — page-wide named env
   *   5. DEFAULT_ENV
   * Nothing is read at load time, so a page can flip envs between opens
   * without reloading the SDK.
   */
  function resolveBaseUrl(options) {
    var globalConfig = window.EnkashCheckoutConfig || {};

    if (options.base_url) return normalizeBaseUrl(options.base_url);
    if (options.env) return normalizeBaseUrl(baseUrlForEnv(options.env));
    if (globalConfig.base_url) return normalizeBaseUrl(globalConfig.base_url);
    if (globalConfig.env) return normalizeBaseUrl(baseUrlForEnv(globalConfig.env));
    return ENVIRONMENTS[DEFAULT_ENV];
  }

  function baseUrlForEnv(env) {
    if (!ENVIRONMENTS[env]) {
      throw new Error(
        'EnkashCheckout: unknown `env` "' + env + '". Expected one of: ' +
        Object.keys(ENVIRONMENTS).join(', ') + ' — or pass `base_url` directly.'
      );
    }
    return ENVIRONMENTS[env];
  }

  // Fails loudly here rather than producing an iframe pointed at nowhere.
  // The http/https check matters: `new URL('localhost:4200')` parses fine
  // (scheme "localhost:") but yields origin "null", which would silently
  // break every postMessage origin comparison.
  function normalizeBaseUrl(url) {
    var trimmed = String(url).trim().replace(/\/+$/, '');
    var parsed;
    try {
      parsed = new URL(trimmed);
    } catch (e) {
      throw new Error('EnkashCheckout: `base_url` is not a valid URL: "' + url + '"');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(
        'EnkashCheckout: `base_url` must be an absolute http(s) URL, got "' + url + '"'
      );
    }
    return trimmed;
  }

  var MESSAGE_TYPES = {
    READY: 'enkash:ready',
    CONTENT_READY: 'enkash:content-ready', // fired once the checkout UI has actually painted (post-loader), used to expand the mobile sheet
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

  // Final mobile sheet height once checkout content has painted. One line
  // to change — not merchant-configurable by design.
  var MOBILE_HEIGHT_PERCENT = 70;

  // Initial mobile sheet height shown while the checkout app is still
  // loading (skeleton/spinner), before MESSAGE_TYPES.CONTENT_READY arrives.
  // Set equal to MOBILE_HEIGHT_PERCENT to disable the two-stage effect.
  var MOBILE_COLLAPSED_HEIGHT_PERCENT = 50;

  // Safety net: if the iframe never sends CONTENT_READY (older checkout
  // build without the signal yet, or the message gets lost), expand to the
  // full mobile height anyway after this delay so the sheet doesn't stay
  // stuck collapsed forever.
  var CONTENT_READY_FALLBACK_MS = 2000;

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

    // Resolved once per instance: the iframe src and the origin every
    // postMessage is checked against must come from the same value, or the
    // handshake silently never lands.
    this.baseUrl = resolveBaseUrl(options);
    this.origin = new URL(this.baseUrl).origin;

    this.overlayEl = null;
    this.iframeEl = null;
    this._messageListener = null;
    this._keydownListener = null;
    this._resizeListener = null;
    this._readyTimeoutTimer = null;
    this._contentReadyFallbackTimer = null;
    this._isOpen = false;
    this._isMobileLayout = null; // tracked so we only touch DOM on actual changes
    this._mobileExpanded = false; // tracked so we only expand once, and only on mobile
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
   * Mobile layout is a bottom sheet, not a full-screen takeover. It opens
   * collapsed (MOBILE_COLLAPSED_HEIGHT_PERCENT) while the checkout app is
   * still loading, then expands to MOBILE_HEIGHT_PERCENT once the iframe
   * signals its content has actually painted (see _expandMobileSheet).
   * Leaving the remaining top strip transparent keeps the merchant's page
   * (and backdrop) visible/tappable there — matching how the web version
   * presents checkout as an overlay rather than a page.
   *
   * The iframe does NOT use height:NN vh — vh is unreliable on mobile
   * Safari/Chrome because the dynamic address-bar/toolbar changes the
   * *visual* viewport without vh updating consistently, which is exactly
   * what produced the earlier "iframe doesn't cover as expected" gaps.
   *
   * Instead the iframe is position:fixed and pinned to the real viewport by
   * the browser via top/left/right/bottom offsets — the sheet's box is
   * defined purely by those edge offsets, not by computed vh math.
   */
  EnkashCheckout.prototype._applyLayoutForViewport = function () {
    var mobile = this._isMobileViewport();
    if (mobile === this._isMobileLayout) return; // no change, skip DOM writes
    this._isMobileLayout = mobile;

    if (!this.iframeEl || !this.overlayEl) return;

    if (mobile) {
      this.overlayEl.style.alignItems = 'stretch';
      this.overlayEl.style.justifyContent = 'stretch';
      this._setMobileSheetHeight(MOBILE_COLLAPSED_HEIGHT_PERCENT);
    } else {
      this.overlayEl.style.alignItems = 'center';
      this.overlayEl.style.justifyContent = 'center';

      this.iframeEl.style.transition = '';
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

  // Applies a given sheet height (as a percent of viewport height) via
  // fixed-position edge offsets. Used both for the initial collapsed state
  // and the later expand step — same mechanism, just a different number.
  EnkashCheckout.prototype._setMobileSheetHeight = function (heightPercent) {
    var topPercent = 100 - heightPercent;

    this.iframeEl.style.transition = 'top 0.25s ease, height 0.25s ease';
    this.iframeEl.style.position = 'fixed';
    this.iframeEl.style.top = topPercent + '%';
    this.iframeEl.style.right = '0';
    // paddingBottom via env() keeps the sheet content clear of the home
    // indicator/gesture bar on notched phones; bottom stays 0 so the sheet
    // itself still reads as flush against the true screen edge.
    this.iframeEl.style.bottom = '0';
    this.iframeEl.style.left = '0';
    // iframes are replaced elements — unlike a <div>, an iframe with
    // width/height left as `auto` falls back to its intrinsic default
    // size (~300x150), it does NOT stretch to fill the inset box the way
    // a div would. Percentage sizing is required alongside the edge
    // offsets for this to actually fill the fixed-position box.
    this.iframeEl.style.width = '100%';
    this.iframeEl.style.height = heightPercent + '%';
    this.iframeEl.style.maxWidth = 'none';
    this.iframeEl.style.maxHeight = 'none';
    // Rounded top corners only — it sits flush against the bottom edge,
    // reading as a sheet sliding up rather than a full-screen page.
    this.iframeEl.style.borderRadius = '12px 12px 0 0';
  };

  // Expands the mobile sheet from its collapsed loading height to the full
  // MOBILE_HEIGHT_PERCENT. Idempotent and mobile-only: safe to call from
  // both the real CONTENT_READY message and the fallback timer without
  // double-firing or affecting desktop layout.
  EnkashCheckout.prototype._expandMobileSheet = function () {
    if (this._contentReadyFallbackTimer) {
      clearTimeout(this._contentReadyFallbackTimer);
      this._contentReadyFallbackTimer = null;
    }
    if (this._mobileExpanded || !this._isMobileLayout || !this.iframeEl) return;
    this._mobileExpanded = true;
    this._setMobileSheetHeight(MOBILE_HEIGHT_PERCENT);
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

    var src = this.baseUrl + '/v1/pay/' + encodeURIComponent(this.options.order_id) +
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

    // Mobile-only: if content-ready never arrives, expand anyway so the
    // sheet doesn't stay collapsed forever.
    if (this._isMobileLayout) {
      var self2 = this;
      this._contentReadyFallbackTimer = setTimeout(function () {
        self2._contentReadyFallbackTimer = null;
        self2._expandMobileSheet();
      }, CONTENT_READY_FALLBACK_MS);
    }
  };

  EnkashCheckout.prototype._attachListeners = function () {
    var self = this;

    this._messageListener = function (event) {
      if (event.origin !== self.origin) return; // ignore anything not from our checkout
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

        case MESSAGE_TYPES.CONTENT_READY:
          // Checkout app finished its loader/skeleton and painted real
          // content — expand the mobile sheet from collapsed to full height.
          self._expandMobileSheet();
          break;

        case MESSAGE_TYPES.RESIZE:
          // Only meaningful in the non-mobile (card) layout — the mobile
          // bottom-sheet's height is driven by collapsed/expanded state,
          // not content height hints.
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
      this.origin
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
    if (this._contentReadyFallbackTimer) {
      clearTimeout(this._contentReadyFallbackTimer);
      this._contentReadyFallbackTimer = null;
    }
    if (this.overlayEl && this.overlayEl.parentNode) {
      this.overlayEl.parentNode.removeChild(this.overlayEl);
    }
    this.overlayEl = null;
    this.iframeEl = null;
    this._isMobileLayout = null;
    this._mobileExpanded = false;
    document.body.style.overflow = '';
    this._isOpen = false;
  };

  // Exposed so tooling (test harnesses, internal dashboards) can list the
  // known deployments instead of re-declaring the URLs somewhere else.
  EnkashCheckout.ENVIRONMENTS = ENVIRONMENTS;
  EnkashCheckout.DEFAULT_ENV = DEFAULT_ENV;

  window.EnkashCheckout = EnkashCheckout;
})(window, document);