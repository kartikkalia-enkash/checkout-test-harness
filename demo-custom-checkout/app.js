/**
 * Dacia storefront — EnKash Custom Checkout integration.
 *
 * Everything the customer sees is Dacia's own markup. This file only ever
 * touches window.EnkashCustomCheckout's public surface:
 *
 *   init()                  order detail → which methods to render, real amounts
 *   submitContactDetails()  contact step, when the order requires it
 *   selectMethod()          on every method-rail change
 *   getAmountForMethod()    summary totals, re-fetched per sub-option
 *   getUpiQr()              QR bytes + deadline; starts polling
 *   getUpiIntentLinks()     app list; pure fetch, no side effects
 *   checkBin()              card acceptance at 10 digits
 *   createPayment()         the one call made straight from a click
 *   handler()               the single outcome channel
 *
 * The one hard rule: createPayment() is called synchronously inside the click
 * handler, with no await before it. The bank popup is opened while the click's
 * user activation is still live; any await first and the browser blocks it.
 */
(function () {
  'use strict';

  /* ======================================================================
   * Demo wiring — order id / env / key / cosmetic price come from the URL
   * ==================================================================== */

  var DEFAULT_ENV = 'prod';

  var params = new URLSearchParams(window.location.search);
  seedUrlParams(params);

  var ORDER_ID = (params.get('order_id') || params.get('orderId') || '').trim();
  var ENV = (params.get('env') || DEFAULT_ENV).trim().toLowerCase();
  var MERCHANT_KEY = (params.get('merchantAccessKey') || params.get('key') || 'DEMO_MERCHANT_KEY').trim();
  var parsedAmount = Number(params.get('amount'));
  var UNIT_PRICE = parsedAmount > 0 ? parsedAmount : 100;

  /**
   * Opening the page bare rewrites the address bar to `?order_id=&env=prod`, so
   * the knobs this demo needs are sitting there to be filled in rather than
   * typed from memory. replaceState keeps it out of the back-history, and the
   * rewrite is cosmetic: `params` above is already the seeded copy, so nothing
   * downstream depends on the reload.
   */
  function seedUrlParams(current) {
    var changed = false;

    if (!current.has('order_id') && !current.has('orderId')) {
      current.set('order_id', '');
      changed = true;
    }
    if (!current.has('env')) {
      current.set('env', DEFAULT_ENV);
      changed = true;
    }
    if (!changed) return;

    try {
      window.history.replaceState(
        null, '', window.location.pathname + '?' + current.toString() + window.location.hash
      );
    } catch (e) {
      // Some browsers refuse replaceState on file:// URLs. Harmless — the demo
      // bar still says which params to add.
    }
  }

  // Only used for the UPI mark on the method rail. Every other logo URL in this
  // file is handed to us by the SDK.
  var ASSET_BASES = {
    prod: 'https://checkoutv3.enkash.com/assets',
    uat: 'https://checkout-uat-v3.enkash.in/assets',
    local: 'http://localhost:4200/assets',
    dev: 'https://checkout-dev.enkash.in/assets'
  };
  var ASSET_BASE = ASSET_BASES[ENV] || ASSET_BASES.prod;

  var PRODUCT = { name: 'Classic T-Shirt' };
  var MIN_QTY = 1;
  var MAX_QTY = 10;
  var TITLES = {
    product: 'Classic T-Shirt | Dacia',
    cart: 'Your cart | Dacia',
    checkout: 'Checkout | Dacia',
    confirmation: 'Order status | Dacia'
  };

  var METHOD_META = {
    UPI: {
      name: 'UPI',
      hint: 'QR or any UPI app',
      iconUrl: ASSET_BASE + '/upi/other-upi.svg',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/></svg>'
    },
    CARD: {
      name: 'Card',
      hint: 'Credit, debit or prepaid',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18M7 14.5h3"/></svg>'
    },
    NETBANKING: {
      name: 'Netbanking',
      hint: 'All major banks',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 9.5L12 4l8.5 5.5"/><path d="M6 10v7.5M10 10v7.5M14 10v7.5M18 10v7.5M3.5 20h17"/></svg>'
    },
    WALLET: {
      name: 'Wallet',
      hint: 'Mobile wallets',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7.5h15a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 18V7.5z"/><path d="M4 7.5L15 4.5v3"/><circle cx="16" cy="13.5" r="1" fill="currentColor" stroke="none"/></svg>'
    }
  };

  var METHOD_ORDER = ['UPI', 'CARD', 'NETBANKING', 'WALLET'];

  var BIN_REASONS = {
    MODE_DISABLED: 'This card type isn\u2019t accepted for this order. Try another card or method.',
    SCHEME_NOT_ALLOWED: 'This card network isn\u2019t accepted for this order. Try another card or method.'
  };

  /* ======================================================================
   * State
   * ==================================================================== */

  var state = {
    image: 0,
    pdpQty: 1,
    cartQty: 0,
    paying: false,       // a committed payment is in flight — block navigation
    result: null,

    checkout: null,
    config: null,
    initialising: false,
    method: null,
    upiMode: 'qr',
    qrLoaded: false,
    qrTimer: null,
    bank: null,
    wallet: null,
    bin: null,
    binPending: false,
    cardDebounce: null,
    contactDone: false,
    payLabel: 'Pay now'
  };

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var money = new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', minimumFractionDigits: 2
  });
  function inr(n) { return '\u20B9' + Number(n).toLocaleString('en-IN'); }
  function itemsLabel(n) { return n + (n === 1 ? ' item' : ' items'); }
  function clamp(n) { return Math.min(MAX_QTY, Math.max(MIN_QTY, n)); }
  function cartTotal() { return state.cartQty * UNIT_PRICE; }
  function digits(value) { return String(value == null ? '' : value).replace(/\D/g, ''); }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function announce(msg) {
    var el = $('#announcer');
    el.textContent = '';
    window.setTimeout(function () { el.textContent = msg; }, 60);
  }

  function errorText(err) {
    if (!err) return 'Unknown error.';
    if (err.code === 'NETWORK') {
      return 'Couldn\u2019t reach the payment gateway. If this keeps happening, this domain may not be allow-listed yet.';
    }
    return err.message || String(err);
  }

  /* ======================================================================
   * Demo config strip
   * ==================================================================== */

  function renderDemoBar() {
    var bar = $('#demobar');
    if (!ORDER_ID) {
      bar.innerHTML =
        '<span class="demobar__warn">No order id.</span>' +
        '<span>Fill in <code>order_id=</code> in the address bar and reload. ' +
        'Also accepts <code>key=</code> and <code>amount=</code>.</span>';
      return;
    }
    bar.innerHTML =
      '<span>EnKash custom checkout demo</span>' +
      '<span>order <code>' + escapeHtml(ORDER_ID) + '</code></span>' +
      '<span>env <code>' + escapeHtml(ENV) + '</code></span>';
  }

  /* ======================================================================
   * Product images (inline duotone SVG)
   * ==================================================================== */

  var BACKDROP = '#f0ce6e', BODY = '#4b5a20', RIB = '#5d6e2a', INSIDE = '#323c14', SEAM = '#39451a';

  function svg(inner) {
    return '<svg viewBox="0 0 400 400" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">' +
      '<rect width="400" height="400" fill="' + BACKDROP + '"/>' + inner + '</svg>';
  }
  var SHADOW = '<ellipse cx="200" cy="346" rx="112" ry="8" fill="#353f15" fill-opacity=".18"/>';
  var DETAILS =
    '<path d="M108 164 Q112 128 100 95" fill="none" stroke="' + SEAM + '" stroke-width="2"/>' +
    '<path d="M292 164 Q288 128 300 95" fill="none" stroke="' + SEAM + '" stroke-width="2"/>' +
    '<path d="M55 145 L84 178" stroke="' + SEAM + '" stroke-width="2" stroke-dasharray="4 4"/>' +
    '<path d="M345 145 L316 178" stroke="' + SEAM + '" stroke-width="2" stroke-dasharray="4 4"/>' +
    '<path d="M112 320 H288" stroke="' + SEAM + '" stroke-width="2" stroke-dasharray="4 4"/>' +
    '<path d="M150 200 C156 240 152 270 158 300" fill="none" stroke="' + SEAM + '" stroke-opacity=".7" stroke-width="1.5"/>' +
    '<path d="M252 214 C246 250 252 276 246 304" fill="none" stroke="' + SEAM + '" stroke-opacity=".7" stroke-width="1.5"/>';
  var SILHOUETTE = 'M150 78 L98 94 L48 150 L78 184 L108 164 L108 332 L292 332 L292 164 L322 184 L352 150 L302 94 L250 78';

  var IMAGES = [
    {
      label: 'front view',
      svg: svg(SHADOW +
        '<path d="' + SILHOUETTE + ' C232 104 168 104 150 78 Z" fill="' + BODY + '"/>' +
        '<path d="M150 78 C170 90 230 90 250 78 C232 104 168 104 150 78 Z" fill="' + INSIDE + '"/>' +
        '<path d="M150 78 C170 90 230 90 250 78" fill="none" stroke="' + RIB + '" stroke-width="4"/>' +
        '<path d="M150 78 C168 104 232 104 250 78" fill="none" stroke="' + RIB + '" stroke-width="7" stroke-linecap="round"/>' +
        DETAILS)
    },
    {
      label: 'back view',
      svg: svg(SHADOW +
        '<path d="' + SILHOUETTE + ' C230 90 170 90 150 78 Z" fill="' + BODY + '"/>' +
        '<path d="M150 78 C170 90 230 90 250 78" fill="none" stroke="' + RIB + '" stroke-width="7" stroke-linecap="round"/>' +
        DETAILS)
    },
    {
      label: 'folded',
      svg: svg(
        '<ellipse cx="200" cy="322" rx="118" ry="9" fill="#353f15" fill-opacity=".18"/>' +
        '<rect x="100" y="128" width="200" height="184" rx="10" fill="' + BODY + '"/>' +
        '<path d="M146 150 V306 M254 150 V306 M104 262 H296" stroke="' + SEAM + '" stroke-width="2"/>' +
        '<path d="M112 298 H288" stroke="' + SEAM + '" stroke-width="2" stroke-dasharray="4 4"/>' +
        '<path d="M168 128 H232 C226 166 174 166 168 128 Z" fill="' + INSIDE + '"/>' +
        '<path d="M169 130 H231" stroke="' + RIB + '" stroke-width="4"/>' +
        '<path d="M168 128 C174 166 226 166 232 128" fill="none" stroke="' + RIB + '" stroke-width="7" stroke-linecap="round"/>')
    }
  ];

  function renderGallery() {
    var img = IMAGES[state.image];
    var main = $('#main-image');
    main.innerHTML = img.svg;
    main.setAttribute('aria-label', PRODUCT.name + ', ' + img.label);
    $$('.thumb').forEach(function (t, i) { t.setAttribute('aria-pressed', String(i === state.image)); });
  }

  /* ======================================================================
   * Quantity steppers / cart
   * ==================================================================== */

  function syncStepper(root, value) {
    var input = $('.stepper__input', root);
    if (input.value !== String(value)) input.value = value;
    $('[data-step="-1"]', root).setAttribute('aria-disabled', String(value <= MIN_QTY));
    $('[data-step="1"]', root).setAttribute('aria-disabled', String(value >= MAX_QTY));
  }

  function bindStepper(root, get, set) {
    var input = $('.stepper__input', root);
    root.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-step]');
      if (!btn || btn.getAttribute('aria-disabled') === 'true') return;
      set(clamp(get() + Number(btn.getAttribute('data-step'))));
    });
    input.addEventListener('input', function () {
      var n = parseInt(input.value, 10);
      if (n >= MIN_QTY && n <= MAX_QTY && n !== get()) set(n);
    });
    input.addEventListener('change', function () {
      var n = clamp(parseInt(input.value, 10) || MIN_QTY);
      if (n !== get()) set(n); else syncStepper(root, n);
    });
  }

  function setPdpQty(n) {
    state.pdpQty = n;
    syncStepper($('#pdp-stepper'), n);
  }

  function setCartQty(n) {
    state.cartQty = n;
    renderCart();
    renderCartCount(false);
    announce('Quantity ' + n + '. Total ' + inr(cartTotal()) + '.');
  }

  function renderCartCount(bump) {
    var count = $('#cart-count');
    count.textContent = state.cartQty;
    count.hidden = state.cartQty === 0;
    $('#cart-btn').setAttribute('aria-label', 'Cart, ' + itemsLabel(state.cartQty));
    if (bump && state.cartQty > 0) {
      count.classList.remove('is-bumped');
      void count.offsetWidth;
      count.classList.add('is-bumped');
    }
  }

  function renderCart() {
    var empty = state.cartQty === 0;
    $('#cart-empty').hidden = !empty;
    $('#cart-filled').hidden = empty;
    if (empty) return;
    syncStepper($('#cart-stepper'), state.cartQty);
    $('#line-total').textContent = inr(cartTotal());
    $('#cart-items').textContent = itemsLabel(state.cartQty);
    $('#cart-subtotal').textContent = inr(cartTotal());
    $('#cart-total').textContent = inr(cartTotal());
  }

  /* ======================================================================
   * Navigation
   * ==================================================================== */

  function go(view) {
    if (state.paying) return;
    if (view === 'checkout' && state.cartQty === 0) view = 'cart';
    if (view === 'confirmation' && !state.result) view = 'product';

    $$('.view').forEach(function (v) { v.hidden = v.getAttribute('data-view') !== view; });
    if (view === 'product') $('#added').hidden = true;
    if (view === 'cart') renderCart();
    if (view === 'checkout') enterCheckout();
    if (view !== 'checkout') teardownCheckout();

    document.title = TITLES[view];
    window.scrollTo(0, 0);
    var heading = $('#view-' + view + ' h1');
    if (heading) heading.focus({ preventScroll: true });
  }

  document.addEventListener('click', function (e) {
    var target = e.target.closest('[data-nav]');
    if (!target) return;
    e.preventDefault();
    go(target.getAttribute('data-nav'));
  });

  $('#add-to-cart').addEventListener('click', function () {
    var before = state.cartQty;
    state.cartQty = Math.min(MAX_QTY, state.cartQty + state.pdpQty);
    var added = state.cartQty - before;
    renderCartCount(true);

    var meta;
    if (added === 0) {
      meta = 'Your cart already has the maximum of ' + MAX_QTY + '.';
    } else {
      meta = PRODUCT.name + ' \u00D7 ' + added + '. Your cart has ' + itemsLabel(state.cartQty) + '.';
      if (added < state.pdpQty) meta += ' The limit is ' + MAX_QTY + ' per order.';
    }
    $('#added-meta').textContent = meta;
    $('#added-title').textContent = added === 0 ? 'Cart is full' : 'Added to cart';

    var box = $('#added');
    box.hidden = false;
    box.classList.remove('is-new');
    void box.offsetWidth;
    box.classList.add('is-new');
    announce((added === 0 ? 'Cart is full. ' : 'Added to cart. ') + meta);
  });

  $('#remove-item').addEventListener('click', function () {
    state.cartQty = 0;
    renderCart();
    renderCartCount(false);
    $('#cart-title').focus();
    announce(PRODUCT.name + ' removed. Your cart is empty.');
  });

  /* ======================================================================
   * Checkout: lifecycle
   * ==================================================================== */

  function enterCheckout() {
    $('#co-qty').textContent = 'Qty ' + state.cartQty;
    $('#co-line').textContent = inr(cartTotal());

    if (state.checkout || state.initialising) return;

    if (!ORDER_ID) {
      showPayError(
        'Demo not configured',
        'The order_id param is empty. Fill it in in the address bar \u2014 it\u2019s already there, ' +
        'as ?order_id=&env=' + ENV + ' \u2014 then reload.',
        false
      );
      return;
    }

    showPayLoading();
    state.initialising = true;

    var checkout;
    try {
      checkout = new window.EnkashCustomCheckout({
        merchantAccessKey: MERCHANT_KEY,
        order_id: ORDER_ID,
        environment: ENV,

        // The single outcome channel. Fires exactly once, for every method,
        // success and failure alike.
        handler: function (result) {
          state.paying = false;
          setPayingUi(false);
          stopQrTimer();
          hidePayStatus();
          state.result = result || {};
          renderOutcome(state.result);
          go('confirmation');
        },

        // UI cue only — says nothing about the outcome. Polling continues.
        onPopupClosed: function () {
          showPayStatus(
            'Confirming your payment',
            'The payment tab closed. We\u2019re still checking with the bank \u2014 keep this page open.'
          );
        }
      });
    } catch (err) {
      state.initialising = false;
      showPayError('Payment options unavailable', errorText(err), false);
      return;
    }

    state.checkout = checkout;

    checkout.init().then(function (config) {
      state.initialising = false;
      if (state.checkout !== checkout) return; // navigated away and torn down
      state.config = config;
      renderConfig(config);
    }, function (err) {
      state.initialising = false;
      if (state.checkout !== checkout) return;
      state.checkout = null;
      try { checkout.destroy(); } catch (e) { /* already gone */ }
      showPayError('Payment options unavailable', errorText(err), true);
    });
  }

  /**
   * Leaving the checkout page abandons the attempt. destroy() stops all polling
   * and deliberately does not fire handler(), so nothing resolves behind the
   * customer's back.
   */
  function teardownCheckout() {
    if (!state.checkout) return;
    try { state.checkout.destroy(); } catch (e) { /* already gone */ }
    state.checkout = null;
    state.config = null;
    state.method = null;
    state.upiMode = 'qr';
    state.qrLoaded = false;
    state.bank = null;
    state.wallet = null;
    state.bin = null;
    state.contactDone = false;
    stopQrTimer();
    resetCheckoutUi();
  }

  function resetCheckoutUi() {
    $('#methods').innerHTML = '';
    $('#nb-select').innerHTML = '<option value="">Select your bank\u2026</option>';
    $('#nb-top-banks').innerHTML = '';
    $('#nb-top-wrap').hidden = true;
    $('#wallet-list').innerHTML = '';
    $('#upi-apps').innerHTML = '';
    $('#card-marks').innerHTML = '';
    $('#qr-image').hidden = true;
    $('#qr-image').removeAttribute('src');
    $('#qr-placeholder').hidden = false;
    $('#summary-merchant').hidden = true;
    $('#merchant-logo').hidden = true;
    ['card-number', 'card-expiry', 'card-cvv', 'card-name', 'contact-mobile', 'contact-email'].forEach(function (id) {
      var el = $('#' + id);
      el.value = '';
      el.disabled = false;
      el.removeAttribute('aria-invalid');
    });
    $$('.field__error').forEach(function (el) { el.textContent = ''; });
    ['bin-ok', 'bin-error', 'qr-alert', 'intent-alert', 'contact-alert'].forEach(function (id) {
      $('#' + id).hidden = true;
    });
    $('#card-network-mark').hidden = true;
    $('#pay-btn').hidden = true;
    hidePayStatus();
    renderTotals(null);
  }

  /* ---------- Pay-card states ---------- */

  function showPayLoading() {
    $('#pay-loading').hidden = false;
    $('#pay-error').hidden = true;
    $('#contact-step').hidden = true;
    $('#pay-grid').hidden = true;
  }

  function showPayError(title, text, retryable) {
    $('#pay-loading').hidden = true;
    $('#pay-error').hidden = false;
    $('#contact-step').hidden = true;
    $('#pay-grid').hidden = true;
    $('#pay-error-title').textContent = title;
    $('#pay-error-text').textContent = text;
    $('#pay-retry-init').hidden = !retryable;
    $('#pay-btn').hidden = true;
    announce(title);
  }

  function showContactStep() {
    $('#pay-loading').hidden = true;
    $('#pay-error').hidden = true;
    $('#contact-step').hidden = false;
    $('#pay-grid').hidden = true;
    $('#pay-btn').hidden = true;
    $('#contact-mobile').focus();
  }

  function showMethods() {
    $('#pay-loading').hidden = true;
    $('#pay-error').hidden = true;
    $('#contact-step').hidden = true;
    $('#pay-grid').hidden = false;
  }

  $('#pay-retry-init').addEventListener('click', function () {
    resetCheckoutUi();
    enterCheckout();
  });

  /* ======================================================================
   * Checkout: config → UI
   * ==================================================================== */

  function renderConfig(config) {
    if (config.merchant.name || config.merchant.logoUrl) {
      $('#summary-merchant').hidden = false;
      $('#merchant-name').textContent = config.merchant.name
        ? 'Paid to ' + config.merchant.name + ' via EnKash'
        : 'Payments by EnKash';
      if (config.merchant.logoUrl) {
        var logo = $('#merchant-logo');
        logo.src = config.merchant.logoUrl;
        logo.hidden = false;
        logo.addEventListener('error', function () { logo.hidden = true; });
      }
    }

    renderTotals({ amount: config.amount, surcharge: 0, convenienceFee: 0, gst: 0, total: config.totalAmount });
    $('#summary-note').textContent = 'Order ' + config.orderId + '. Amounts confirmed by EnKash.';

    var available = METHOD_ORDER.filter(function (key) {
      return !!config.methods[methodConfigKey(key)];
    });

    if (!available.length) {
      showPayError('No payment methods available', 'This order has no payment method enabled.', false);
      return;
    }
    if (config.attemptsLeft === false) {
      showPayError(
        'No payment attempts left',
        'This order has used up its payment attempts. Start a new order to try again.',
        false
      );
      return;
    }

    buildMethodRail(available);
    if (config.methods.netbanking) renderBanks(config.methods.netbanking);
    if (config.methods.wallet) renderWallets(config.methods.wallet.wallets);
    if (config.methods.card) renderCardMarks(config.methods.card.schemes);
    if (config.methods.upi) configureUpiSegment(config.methods.upi);

    if (config.contact.required) {
      if (config.customer.phone) {
        $('#contact-mobile').value = digits(config.customer.phone).slice(-10);
      }
      showContactStep();
    } else {
      state.contactDone = true;
      showMethods();
      selectMethod(available[0]);
    }
  }

  // config.methods keys are lowercase; selectMethod() takes the uppercase name.
  function methodConfigKey(method) {
    return method === 'NETBANKING' ? 'netbanking' : method.toLowerCase();
  }

  function buildMethodRail(available) {
    var host = $('#methods');
    host.innerHTML = '<legend class="sr-only">Choose a payment method</legend>';

    available.forEach(function (key) {
      var meta = METHOD_META[key];
      var label = document.createElement('label');
      label.className = 'method';

      var input = document.createElement('input');
      input.className = 'sr-only';
      input.type = 'radio';
      input.name = 'method';
      input.value = key;
      input.addEventListener('change', function () {
        if (input.checked) selectMethod(key);
      });

      var icon = document.createElement('span');
      icon.className = 'method__icon';
      icon.setAttribute('aria-hidden', 'true');
      if (meta.iconUrl) {
        var img = document.createElement('img');
        img.alt = '';
        img.src = meta.iconUrl;
        img.addEventListener('error', function () { icon.innerHTML = meta.icon; });
        icon.appendChild(img);
      } else {
        icon.innerHTML = meta.icon;
      }

      var text = document.createElement('span');
      text.className = 'method__text';
      text.innerHTML =
        '<span class="method__name">' + escapeHtml(meta.name) + '</span>' +
        '<span class="method__hint">' + escapeHtml(meta.hint) + '</span>';

      label.appendChild(input);
      label.appendChild(icon);
      label.appendChild(text);
      host.appendChild(label);
    });
  }

  /* ======================================================================
   * Contact step
   * ==================================================================== */

  function validateContact() {
    var checkout = state.checkout;
    if (!checkout) return false;

    var mobile = $('#contact-mobile').value.trim();
    var email = $('#contact-email').value.trim();
    var mobileOk = checkout.validateMobile(mobile);
    var emailOk = checkout.validateEmail(email);

    $('#contact-mobile-error').textContent = !mobile || mobileOk ? '' : 'Enter a 10-digit mobile number starting 6\u20139.';
    $('#contact-email-error').textContent = emailOk ? '' : 'Enter a valid email address.';
    return mobileOk && emailOk;
  }

  $('#contact-mobile').addEventListener('input', function () {
    this.value = digits(this.value).slice(0, 10);
    if ($('#contact-mobile-error').textContent) validateContact();
  });
  $('#contact-email').addEventListener('input', function () {
    if ($('#contact-email-error').textContent) validateContact();
  });

  $('#contact-continue').addEventListener('click', function () {
    var checkout = state.checkout;
    if (!checkout) return;

    $('#contact-alert').hidden = true;
    var mobile = $('#contact-mobile').value.trim();
    if (!mobile) {
      $('#contact-mobile-error').textContent = 'Enter your mobile number.';
      $('#contact-mobile').focus();
      return;
    }
    if (!validateContact()) {
      $('#contact-mobile').focus();
      return;
    }

    var payload = { mobile: mobile };
    var email = $('#contact-email').value.trim();
    if (email) payload.email = email;

    setContactBusy(true);
    checkout.submitContactDetails(payload).then(function () {
      setContactBusy(false);
      state.contactDone = true;
      showMethods();
      var first = METHOD_ORDER.filter(function (key) {
        return !!state.config.methods[methodConfigKey(key)];
      })[0];
      selectMethod(first);
    }, function (err) {
      setContactBusy(false);
      $('#contact-alert-text').textContent = errorText(err);
      $('#contact-alert').hidden = false;
    });
  });

  function setContactBusy(busy) {
    $('#contact-continue').setAttribute('aria-disabled', String(busy));
    $('#contact-spinner').hidden = !busy;
    $('#contact-continue-label').textContent = busy ? 'Saving\u2026' : 'Continue to payment';
    $('#contact-mobile').disabled = busy;
    $('#contact-email').disabled = busy;
  }

  /* ======================================================================
   * Method selection
   * ==================================================================== */

  function selectMethod(method) {
    var checkout = state.checkout;
    if (!checkout || !method) return;

    try {
      checkout.selectMethod(method);
    } catch (err) {
      // Thrown while a committed payment is still in flight.
      showPayStatus('Payment in progress', errorText(err));
      return;
    }

    state.method = method;
    stopQrTimer();
    hidePayStatus();

    $$('.panel', $('#panels')).forEach(function (panel) {
      panel.hidden = panel.getAttribute('data-panel') !== method;
    });
    var radio = $('#methods input[value="' + method + '"]');
    if (radio) radio.checked = true;

    if (method === 'UPI') {
      state.qrLoaded = false;
      applyUpiMode(state.upiMode);
      refreshAmount('UPI');
    } else if (method === 'CARD') {
      // selectMethod() has already kicked off the 3DS script prefetch. Card
      // fees are unknowable until checkBin() identifies the card, so the
      // summary shows the bare order amount until then.
      if (state.bin && state.bin.supported) refreshAmount('CARD');
      else renderTotals({ amount: state.config.amount, surcharge: 0, convenienceFee: 0, gst: 0, total: state.config.amount });
      updatePayButton();
    } else if (method === 'NETBANKING') {
      if (state.bank) refreshAmount('NETBANKING', state.bank);
      updatePayButton();
    } else if (method === 'WALLET') {
      if (state.wallet) refreshAmount('WALLET', state.wallet);
      updatePayButton();
    }
  }

  /* ======================================================================
   * Amounts
   * ==================================================================== */

  function refreshAmount(method, subCode) {
    var checkout = state.checkout;
    if (!checkout) return Promise.resolve();
    return checkout.getAmountForMethod(method, subCode).then(function (breakdown) {
      if (state.method !== method) return; // customer moved on
      renderTotals(breakdown);
      if (method === 'UPI') {
        $('#qr-amount').textContent = money.format(breakdown.total);
        $('#qr-amount-inline').textContent = money.format(breakdown.total);
      }
    }, function () { /* leave the last known figures on screen */ });
  }

  function renderTotals(breakdown) {
    var host = $('#co-totals');
    if (!breakdown) {
      state.payLabel = 'Pay now';
      $('#pay-label').textContent = state.payLabel;
      host.innerHTML =
        '<div><dt>Order amount</dt><dd>\u2014</dd></div>' +
        '<div class="totals__grand"><dt>Total payable</dt><dd>\u2014</dd></div>';
      return;
    }

    var rows = [['Order amount', breakdown.amount]];
    if (breakdown.surcharge) rows.push(['Surcharge', breakdown.surcharge]);
    if (breakdown.convenienceFee) rows.push(['Convenience fee', breakdown.convenienceFee]);
    if (breakdown.gst) rows.push(['GST', breakdown.gst]);

    var html = rows.map(function (row) {
      return '<div><dt>' + escapeHtml(row[0]) + '</dt><dd>' + money.format(row[1]) + '</dd></div>';
    }).join('');
    html += '<div class="totals__grand"><dt>Total payable</dt><dd>' + money.format(breakdown.total) + '</dd></div>';
    host.innerHTML = html;

    state.payLabel = 'Pay ' + money.format(breakdown.total);
    if (!state.paying) $('#pay-label').textContent = state.payLabel;
  }

  /* ======================================================================
   * UPI
   * ==================================================================== */

  function configureUpiSegment(upi) {
    var qrOpt = $('#upi-mode-qr-opt');
    var intentOpt = $('#upi-mode-intent-opt');
    qrOpt.hidden = !upi.qr;
    intentOpt.hidden = !upi.intent;
    $('#upi-segment').classList.toggle('segment--single', !(upi.qr && upi.intent));

    state.upiMode = upi.qr ? 'qr' : 'intent';
    $('#upi-segment input[value="' + state.upiMode + '"]').checked = true;
  }

  $$('#upi-segment input[name="upiMode"]').forEach(function (input) {
    input.addEventListener('change', function () {
      if (!input.checked) return;
      state.upiMode = input.value;
      applyUpiMode(input.value);
    });
  });

  function applyUpiMode(mode) {
    $$('[data-upi]').forEach(function (el) { el.hidden = el.getAttribute('data-upi') !== mode; });
    // Neither UPI mode uses the summary Pay button: the QR starts polling the
    // moment it is rendered, and for intent the app tile *is* the pay action.
    $('#pay-btn').hidden = true;
    hidePayStatus();

    if (mode === 'qr') {
      loadQr();
      showPayStatus('Waiting for payment', 'Scan the QR with any UPI app. We confirm it automatically.');
    } else {
      loadIntentApps();
    }
  }

  function loadQr() {
    var checkout = state.checkout;
    if (!checkout || state.qrLoaded) return;
    state.qrLoaded = true;

    $('#qr-alert').hidden = true;
    $('#qr-placeholder').hidden = false;
    $('#qr-placeholder').textContent = 'Loading QR\u2026';
    $('#qr-image').hidden = true;

    checkout.getUpiQr().then(function (qr) {
      if (state.method !== 'UPI' || state.upiMode !== 'qr') return;
      var img = $('#qr-image');
      img.src = qr.qrImageUrl;
      img.hidden = false;
      $('#qr-placeholder').hidden = true;
      startQrTimer(qr.expiresInSeconds);
    }, function (err) {
      state.qrLoaded = false;
      $('#qr-placeholder').textContent = 'QR unavailable';
      $('#qr-alert-text').textContent = errorText(err);
      $('#qr-alert').hidden = false;
      hidePayStatus();
    });
  }

  function startQrTimer(seconds) {
    stopQrTimer();
    var left = seconds;
    var paint = function () {
      var m = Math.floor(left / 60), s = left % 60;
      $('#qr-timer').textContent = 'Expires in ' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    };
    paint();
    state.qrTimer = setInterval(function () {
      left -= 1;
      if (left <= 0) {
        stopQrTimer();
        $('#qr-timer').textContent = 'QR expired';
        return;
      }
      paint();
    }, 1000);
  }

  function stopQrTimer() {
    if (state.qrTimer) clearInterval(state.qrTimer);
    state.qrTimer = null;
    $('#qr-timer').innerHTML = '&nbsp;';
  }

  function loadIntentApps() {
    var checkout = state.checkout;
    if (!checkout) return;
    var host = $('#upi-apps');
    if (host.children.length) return;

    $('#intent-alert').hidden = true;
    checkout.getUpiIntentLinks().then(function (intent) {
      if (state.method !== 'UPI') return;
      host.innerHTML = '';
      if (!intent.apps.length) {
        host.innerHTML = '<p class="field__hint">No UPI apps available for this order.</p>';
        return;
      }
      intent.apps.forEach(function (app) {
        var tile = document.createElement('button');
        tile.className = 'tile';
        tile.type = 'button';

        var logo = document.createElement('img');
        logo.className = 'tile__logo';
        logo.alt = '';
        logo.src = app.iconUrl;
        logo.addEventListener('error', function () { logo.remove(); });

        var name = document.createElement('span');
        name.className = 'tile__name';
        name.textContent = app.label;

        tile.appendChild(logo);
        tile.appendChild(name);

        // This click IS the pay action: createPayment is called synchronously
        // so the app link opens under live user activation.
        tile.addEventListener('click', function () { payWithUpiApp(app); });
        host.appendChild(tile);
      });
    }, function (err) {
      $('#intent-alert-text').textContent = errorText(err);
      $('#intent-alert').hidden = false;
    });
  }

  function payWithUpiApp(app) {
    var checkout = state.checkout;
    if (!checkout || state.paying) return;

    state.paying = true;
    showPayStatus('Opening ' + app.label, 'Approve the payment in the app, then come back to this page.');

    checkout.createPayment({ method: 'UPI', upi: { flow: 'intent', app: app.app } }).then(function (ack) {
      if (ack.state === 'launch' && ack.link) {
        window.location.href = ack.link;
      }
      showPayStatus(
        'Waiting for your approval',
        'Approve the payment in ' + app.label + '. We confirm the outcome here automatically.'
      );
    }, function (err) {
      state.paying = false;
      showPayError2(errorText(err));
    });
  }

  /* ======================================================================
   * Card
   * ==================================================================== */

  $('#card-number').addEventListener('input', function () {
    var raw = digits(this.value).slice(0, 19);
    this.value = raw.replace(/(.{4})/g, '$1 ').trim();

    var checkout = state.checkout;
    if (!checkout) return;

    // Local, zero-latency: which brand mark to draw, from 6 digits.
    var network = checkout.getCardNetwork(raw);
    var mark = $('#card-network-mark');
    var logoUrl = checkout.getCardNetworkLogoUrl(network);
    if (logoUrl) {
      mark.src = logoUrl;
      mark.alt = network;
      mark.hidden = false;
    } else {
      mark.hidden = true;
    }

    var cvvLen = checkout.getExpectedCvvLength(raw);
    $('#card-cvv').maxLength = cvvLen;
    $('#card-cvv').placeholder = cvvLen === 4 ? '1234' : '123';

    $('#card-number-error').textContent = '';
    this.removeAttribute('aria-invalid');

    if (raw.length < 10) {
      state.bin = null;
      $('#bin-ok').hidden = true;
      $('#bin-error').hidden = true;
      updatePayButton();
      return;
    }

    // Network call, at 10 digits: is this specific card accepted for this order.
    if (state.cardDebounce) clearTimeout(state.cardDebounce);
    state.cardDebounce = setTimeout(function () { runBinCheck(raw); }, 200);
  });

  function runBinCheck(raw) {
    var checkout = state.checkout;
    if (!checkout) return;

    state.binPending = true;
    updatePayButton();

    checkout.checkBin(raw).then(function (bin) {
      state.binPending = false;
      if (digits($('#card-number').value).slice(0, 10) !== raw.slice(0, 10)) return;
      state.bin = bin;

      if (bin.supported) {
        $('#bin-error').hidden = true;
        $('#bin-ok-text').textContent =
          [bin.issuer && bin.issuer.name, bin.network, bin.cardType].filter(Boolean).join(' \u00B7 ');
        $('#bin-ok').hidden = false;
        refreshAmount('CARD');
      } else {
        $('#bin-ok').hidden = true;
        $('#bin-error-text').textContent = BIN_REASONS[bin.unsupportedReason] ||
          'This card isn\u2019t accepted for this order.';
        $('#bin-error').hidden = false;
      }
      updatePayButton();
    }, function (err) {
      state.binPending = false;
      state.bin = null;
      $('#bin-ok').hidden = true;
      $('#bin-error-text').textContent = errorText(err);
      $('#bin-error').hidden = false;
      updatePayButton();
    });
  }

  $('#card-expiry').addEventListener('input', function () {
    var raw = digits(this.value).slice(0, 4);
    this.value = raw.length > 2 ? raw.slice(0, 2) + '/' + raw.slice(2) : raw;
    $('#card-expiry-error').textContent = '';
    this.removeAttribute('aria-invalid');
  });

  $('#card-cvv').addEventListener('input', function () {
    this.value = digits(this.value).slice(0, this.maxLength);
    $('#card-cvv-error').textContent = '';
    this.removeAttribute('aria-invalid');
  });

  $('#card-name').addEventListener('input', function () {
    $('#card-name-error').textContent = '';
    this.removeAttribute('aria-invalid');
  });

  /** Local checks only, so the click stays synchronous. */
  function validateCardForm() {
    var checkout = state.checkout;
    var errors = [];

    var number = digits($('#card-number').value);
    if (!number) errors.push(['card-number', 'Enter your card number.']);
    else if (!checkout.validateCardNumber(number)) errors.push(['card-number', 'Check the card number.']);

    var expiry = $('#card-expiry').value.trim();
    if (!expiry) errors.push(['card-expiry', 'Enter the expiry.']);
    else if (!/^\d{2}\/\d{2}$/.test(expiry)) errors.push(['card-expiry', 'Use MM/YY.']);

    var cvv = digits($('#card-cvv').value);
    var cvvLen = checkout.getExpectedCvvLength(number);
    if (!cvv) errors.push(['card-cvv', 'Enter the CVV.']);
    else if (cvv.length !== cvvLen) errors.push(['card-cvv', 'CVV is ' + cvvLen + ' digits.']);

    if ($('#card-name').value.trim().length < 2) errors.push(['card-name', 'Enter the name on the card.']);

    $$('#panels [data-panel="CARD"] .field__error').forEach(function (el) { el.textContent = ''; });
    errors.forEach(function (pair) {
      $('#' + pair[0] + '-error').textContent = pair[1];
      $('#' + pair[0]).setAttribute('aria-invalid', 'true');
    });
    if (errors.length) $('#' + errors[0][0]).focus();
    return errors.length === 0;
  }

  /* ======================================================================
   * Netbanking / Wallet
   * ==================================================================== */

  function renderBanks(nb) {
    var select = $('#nb-select');
    nb.banks.forEach(function (bank) {
      var option = document.createElement('option');
      option.value = bank.code;
      option.textContent = bank.name;
      select.appendChild(option);
    });

    if (nb.topBanks.length) {
      var host = $('#nb-top-banks');
      nb.topBanks.forEach(function (bank) {
        var tile = document.createElement('button');
        tile.className = 'tile';
        tile.type = 'button';
        tile.setAttribute('data-code', bank.code);

        var logo = document.createElement('img');
        logo.className = 'tile__logo';
        logo.alt = '';
        logo.src = bank.logoUrl;
        logo.addEventListener('error', function () { logo.remove(); });

        var name = document.createElement('span');
        name.className = 'tile__name';
        name.textContent = bank.name;

        tile.appendChild(logo);
        tile.appendChild(name);
        tile.addEventListener('click', function () {
          select.value = bank.code;
          select.dispatchEvent(new Event('change'));
        });
        host.appendChild(tile);
      });
      $('#nb-top-wrap').hidden = false;
    }
  }

  $('#nb-select').addEventListener('change', function () {
    state.bank = this.value || null;
    $$('#nb-top-banks .tile').forEach(function (tile) {
      tile.classList.toggle('is-active', tile.getAttribute('data-code') === state.bank);
    });
    $('#nb-error').textContent = '';
    if (state.bank) refreshAmount('NETBANKING', state.bank);
    updatePayButton();
  });

  function renderWallets(wallets) {
    var host = $('#wallet-list');
    if (!wallets.length) {
      host.innerHTML = '<p class="field__hint">No wallets available for this order.</p>';
      return;
    }
    wallets.forEach(function (wallet) {
      var tile = document.createElement('button');
      tile.className = 'tile';
      tile.type = 'button';
      tile.setAttribute('data-code', wallet.code);

      var logo = document.createElement('img');
      logo.className = 'tile__logo';
      logo.alt = '';
      logo.src = wallet.logoUrl;
      logo.addEventListener('error', function () { logo.remove(); });

      var name = document.createElement('span');
      name.className = 'tile__name';
      name.textContent = wallet.name;

      tile.appendChild(logo);
      tile.appendChild(name);
      tile.addEventListener('click', function () {
        state.wallet = wallet.code;
        $$('#wallet-list .tile').forEach(function (t) { t.classList.toggle('is-active', t === tile); });
        $('#wallet-error').textContent = '';
        refreshAmount('WALLET', wallet.code);
        updatePayButton();
      });
      host.appendChild(tile);
    });
  }

  function renderCardMarks(schemes) {
    var checkout = state.checkout;
    var host = $('#card-marks');
    host.innerHTML = '';
    (schemes || []).forEach(function (scheme) {
      var url = checkout.getCardNetworkLogoUrl(scheme);
      if (!url) return;
      var img = document.createElement('img');
      img.alt = scheme;
      img.src = url;
      img.addEventListener('error', function () { img.remove(); });
      host.appendChild(img);
    });
  }

  /* ======================================================================
   * Pay
   * ==================================================================== */

  function updatePayButton() {
    var btn = $('#pay-btn');
    var method = state.method;

    if (!method || method === 'UPI') {
      btn.hidden = true;
      return;
    }
    btn.hidden = false;

    var ready = false;
    if (method === 'CARD') ready = !state.binPending && !!(state.bin && state.bin.supported);
    else if (method === 'NETBANKING') ready = !!state.bank;
    else if (method === 'WALLET') ready = !!state.wallet;

    btn.disabled = !ready || state.paying;
  }

  $('#pay-btn').addEventListener('click', function () {
    var checkout = state.checkout;
    if (!checkout || state.paying) return;

    var method = state.method;
    var request;

    if (method === 'CARD') {
      if (!validateCardForm()) return;
      request = {
        method: 'CARD',
        card: {
          number: digits($('#card-number').value),
          expiry: $('#card-expiry').value.trim(),
          cvv: digits($('#card-cvv').value),
          holderName: $('#card-name').value.trim()
        }
      };
    } else if (method === 'NETBANKING') {
      if (!state.bank) { $('#nb-error').textContent = 'Choose a bank to continue.'; return; }
      request = { method: 'NETBANKING', bankCode: state.bank };
    } else if (method === 'WALLET') {
      if (!state.wallet) { $('#wallet-error').textContent = 'Choose a wallet to continue.'; return; }
      request = { method: 'WALLET', walletCode: state.wallet };
    } else {
      return;
    }

    state.paying = true;
    setPayingUi(true);

    // Synchronous, straight from the click — the bank popup is opened inside
    // createPayment while user activation is still live.
    checkout.createPayment(request).then(function (ack) {
      handleAck(ack);
    }, function (err) {
      state.paying = false;
      setPayingUi(false);
      showPayError2(errorText(err));
    });
  });

  function setPayingUi(paying) {
    $('#pay-btn').setAttribute('aria-disabled', String(paying));
    $('#pay-btn').disabled = paying;
    $('#pay-spinner').hidden = !paying;
    $('#pay-label').textContent = paying ? 'Processing\u2026' : (state.payLabel || 'Pay now');
    if (!paying) updatePayButton();
  }

  /**
   * createPayment's ack says which UI to show next. It is never a result — the
   * outcome only ever arrives through handler().
   */
  function handleAck(ack) {
    if (ack.state === 'popup') {
      showPayStatus('Complete the payment in the new tab',
        'Keep this page open \u2014 we confirm the outcome here.');
    } else if (ack.state === 'polling') {
      showPayStatus('Waiting for payment', 'We\u2019re confirming with the bank.');
    } else if (ack.state === 'launch') {
      // The browser refused the popup. The link is live and polling is already
      // running, so hand the customer the link rather than re-attempting a
      // window.open that will be blocked again.
      showPayStatus(
        'Open the payment page to continue',
        'Your browser blocked the payment window.',
        ack.link ? ' <a href="' + escapeHtml(ack.link) + '" target="_blank" rel="noopener">Open it in a new tab</a>' +
          ' \u2014 keep this page open.' : ''
      );
    } else if (ack.state === 'challenge') {
      showPayStatus('Verifying with your bank', 'Complete the 3-D Secure check to finish.');
    }
    // 'settled' needs nothing: handler() has already fired.
  }

  // `extraHtml` is the only place markup is injected, and its only current
  // caller builds it from an escaped gateway URL.
  function showPayStatus(title, text, extraHtml) {
    $('#pay-status-title').textContent = title;
    $('#pay-status-text').textContent = text;
    if (extraHtml) $('#pay-status-text').insertAdjacentHTML('beforeend', extraHtml);
    $('#pay-status').className = 'alert alert--info';
    $('#pay-status').hidden = false;
    announce(title);
  }

  function showPayError2(text) {
    $('#pay-status-title').textContent = 'Payment couldn\u2019t be started';
    $('#pay-status-text').textContent = text;
    $('#pay-status').className = 'alert alert--error';
    $('#pay-status').hidden = false;
    announce('Payment could not be started.');
  }

  function hidePayStatus() {
    $('#pay-status').hidden = true;
  }

  /* ======================================================================
   * Outcome
   * ==================================================================== */

  var STATUS_COPY = {
    success: {
      title: 'Payment successful',
      text: 'Thanks \u2014 your order is confirmed. A receipt is on its way to your email.',
      fail: false
    },
    cancelled: {
      title: 'Payment cancelled',
      text: 'The payment was cancelled and nothing was charged. Your cart is still here.',
      fail: true
    },
    failed: {
      title: 'Payment failed',
      text: 'The payment did not go through. Nothing was charged \u2014 you can try again with another method.',
      fail: true
    }
  };

  var RECEIPT_FIELDS = [
    ['order_id', 'Order ID'],
    ['payment_id', 'Payment ID'],
    ['payment_mode', 'Paid with'],
    ['amount', 'Amount'],
    ['currency', 'Currency'],
    ['signature', 'Signature']
  ];

  function renderOutcome(payload) {
    var status = String(payload.payment_status || 'failed').toLowerCase();
    var copy = STATUS_COPY[status] || STATUS_COPY.failed;

    $('#confirm-title').textContent = copy.title;
    $('#confirm-text').textContent = copy.text;
    $('#confirm-icon').innerHTML = copy.fail
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7l10 10M17 7L7 17"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
    $('#confirm-icon').classList.toggle('confirm__icon--fail', copy.fail);
    $('#retry-btn').hidden = !copy.fail;

    var rows = [];
    RECEIPT_FIELDS.forEach(function (field) {
      var value = payload[field[0]];
      if (value == null || value === '') return;
      var display = field[0] === 'amount' ? money.format(Number(value))
        : field[0] === 'signature' ? shorten(String(value))
        : String(value);
      rows.push('<div><dt>' + escapeHtml(field[1]) + '</dt><dd>' + escapeHtml(display) + '</dd></div>');
    });
    rows.push('<div><dt>Status</dt><dd>' + escapeHtml(status) + '</dd></div>');

    $('#receipt').innerHTML = rows.join('');
    announce(copy.title);
  }

  function shorten(value) {
    return value.length > 28 ? value.slice(0, 28) + '\u2026' : value;
  }

  /**
   * One SDK instance delivers exactly one outcome, so a retry needs a fresh
   * instance. teardownCheckout() on leaving the page already destroyed the old
   * one; enterCheckout() builds the next.
   */
  $('#retry-btn').addEventListener('click', function () {
    state.result = null;
    go('checkout');
  });

  /* ======================================================================
   * Init
   * ==================================================================== */

  $$('.thumb').forEach(function (thumb, i) {
    thumb.innerHTML = IMAGES[i].svg;
    thumb.addEventListener('click', function () { state.image = i; renderGallery(); });
  });
  $('#cart-thumb').innerHTML = IMAGES[0].svg;
  $('#checkout-thumb').innerHTML = IMAGES[0].svg;

  bindStepper($('#pdp-stepper'), function () { return state.pdpQty; }, setPdpQty);
  bindStepper($('#cart-stepper'), function () { return state.cartQty; }, setCartQty);

  $('#pdp-price').textContent = inr(UNIT_PRICE);
  $('#cart-unit').textContent = inr(UNIT_PRICE) + ' each';

  renderGallery();
  renderDemoBar();
  setPdpQty(1);
  renderCartCount(false);
})();
