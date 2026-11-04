/**
 * EnKash Checkout SDK
 *
 *   var checkout = new EnkashCheckout({
 *     order_id: 'ORD_FROM_YOUR_SERVER',
 *     merchantAccessKey: 'MERCHANT_ACCESS_KEY',
 *     env: 'prod',
 *     handler: function (response) { ... },
 *     modal: { ondismiss: function () {}, escape: true, backdropclose: false }
 *   });
 *   checkout.open();
 *
 * `env` is `uat` or `prod` (default). `environment` is accepted as an alias.
 * `base_url` overrides the named host. `window.EnkashCheckoutConfig` is the
 * page-wide fallback, read at construction time.
 *
 * `handler` receives every checkout outcome. `modal.ondismiss` is only a
 * voluntary close.
 */
(function (window, document) {
  'use strict';

  var ENVIRONMENTS = {
    prod: 'https://checkoutv3.enkash.com',
    uat: 'https://checkout-uat-v3.enkash.in',
    local: 'http://localhost:4200'
  };

  var DEFAULT_ENV = 'prod';

  function namedEnv(source) {
    return (source && (source.env || source.environment)) || '';
  }

  function resolveBaseUrl(options) {
    var globalConfig = window.EnkashCheckoutConfig || {};
    var instanceEnv = namedEnv(options);
    var globalEnv = namedEnv(globalConfig);

    if (options.base_url) return normalizeBaseUrl(options.base_url);
    if (instanceEnv) return normalizeBaseUrl(baseUrlForEnv(instanceEnv));
    if (globalConfig.base_url) return normalizeBaseUrl(globalConfig.base_url);
    if (globalEnv) return normalizeBaseUrl(baseUrlForEnv(globalEnv));
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
    CONTENT_READY: 'enkash:content-ready',
    RESIZE: 'enkash:resize',
    RESULT: 'enkash:result',
    DISMISS: 'enkash:dismiss',
    ACK: 'enkash:ack'
  };

  var DEFAULT_WIDTH = 1115;
  var DEFAULT_HEIGHT = 646;
  var MOBILE_BREAKPOINT_PX = 640;
  var MOBILE_HEIGHT_PERCENT = 70;
  var MOBILE_COLLAPSED_HEIGHT_PERCENT = 50;
  var CONTENT_READY_FALLBACK_MS = 2000;
  var READY_TIMEOUT_MS = 15000;

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

    var merchantAccessKey = String(
      (options && (options.merchantAccessKey || options.merchant_access_key)) || ''
    ).trim();
    if (!merchantAccessKey) {
      throw new Error('EnkashCheckout: `merchantAccessKey` is required');
    }

    this.options = options;
    this.modalOptions = options.modal || {};
    this.merchantAccessKey = merchantAccessKey;

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
    this._isMobileLayout = null;
    this._mobileExpanded = false;
  }

  EnkashCheckout.prototype.open = function () {
    if (this._isOpen) return;
    this._isOpen = true;

    try {
      this._buildDom();
      this._attachListeners();
    } catch (err) {
      this._failUnavailable();
      return;
    }

    document.body.style.overflow = 'hidden';

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

  EnkashCheckout.prototype._applyLayoutForViewport = function () {
    var mobile = this._isMobileViewport();
    if (mobile === this._isMobileLayout) return;
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

  EnkashCheckout.prototype._setMobileSheetHeight = function (heightPercent) {
    var topPercent = 100 - heightPercent;

    this.iframeEl.style.transition = 'top 0.25s ease, height 0.25s ease';
    this.iframeEl.style.position = 'fixed';
    this.iframeEl.style.top = topPercent + '%';
    this.iframeEl.style.right = '0';
    this.iframeEl.style.bottom = '0';
    this.iframeEl.style.left = '0';
    this.iframeEl.style.width = '100%';
    this.iframeEl.style.height = heightPercent + '%';
    this.iframeEl.style.maxWidth = 'none';
    this.iframeEl.style.maxHeight = 'none';
    this.iframeEl.style.borderRadius = '12px 12px 0 0';
  };

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
      'height:' + DEFAULT_HEIGHT + 'px',
      'max-width:100vw',
      'max-height:100vh',
      'background:transparent',
      'border-radius:12px',
      'touch-action:manipulation'
    ].join(';');

    var src = this.baseUrl + '/v1/pay/' + encodeURIComponent(this.options.order_id) +
      '?embedded=true&parentOrigin=' + encodeURIComponent(window.location.origin);
    if (this.merchantAccessKey) {
      src += '&merchantAccessKey=' + encodeURIComponent(this.merchantAccessKey);
    }
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

    this._applyLayoutForViewport();

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
      if (event.origin !== self.origin) return;
      if (!self.iframeEl || event.source !== self.iframeEl.contentWindow) return;

      var data = event.data || {};
      switch (data.type) {
        case MESSAGE_TYPES.READY:
          if (self._readyTimeoutTimer) {
            clearTimeout(self._readyTimeoutTimer);
            self._readyTimeoutTimer = null;
          }
          break;

        case MESSAGE_TYPES.CONTENT_READY:
          self._expandMobileSheet();
          break;

        case MESSAGE_TYPES.RESIZE:
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

  EnkashCheckout.prototype._userDismiss = function () {
    this._teardown();
    if (typeof this.modalOptions.ondismiss === 'function') {
      this.modalOptions.ondismiss();
    }
  };

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

  EnkashCheckout.ENVIRONMENTS = ENVIRONMENTS;
  EnkashCheckout.DEFAULT_ENV = DEFAULT_ENV;

  window.EnkashCheckout = EnkashCheckout;
})(window, document);