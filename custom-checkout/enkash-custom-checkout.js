/**
 * EnKash Custom Checkout SDK
 * ==========================
 *
 * A standalone, framework-free JavaScript SDK that lets a merchant build their
 * own checkout UI while this SDK owns every call to the EnKash payment gateway.
 * The merchant renders 100% of the UI; nothing here draws anything on screen
 * except the bank/ACS popup tab, which has to be a real browser tab.
 *
 * Order creation stays on the merchant's server and is out of scope. This SDK is
 * initialised with an already-created order id.
 *
 *   var checkout = new EnkashCustomCheckout({
 *     key: 'MERCHANT_PUBLIC_KEY',
 *     order_id: 'ORD1784195236818VZuxB',
 *     environment: 'prod',                 // or 'uat' / 'dev'
 *     handler: function (result) { ... },  // every terminal outcome lands here
 *   });
 *
 *   var config = await checkout.init();
 *
 * Supported: UPI (QR + Intent), Cards (new cards only), Netbanking, Wallets.
 * Explicitly not supported: UPI VPA/collect, saved or tokenised cards, PPI.
 * RuPay native OTP is detected and stubbed, never implemented.
 *
 * ---------------------------------------------------------------------------
 * Two constraints that are easy to break and expensive to debug
 * ---------------------------------------------------------------------------
 *
 * 1. createPayment() MUST be called directly from the customer's click handler,
 *    with no `await` between the click and the call. The bank popup is opened
 *    synchronously at the top of createPayment while the click's transient user
 *    activation is still live. Activation ends at the first await, so opening
 *    the tab after the charge response resolves is guaranteed to be blocked by
 *    the browser. This is a hard browser rule, not a tunable.
 *
 * 2. Status polling is the ONLY source of truth for an outcome. Never the popup
 *    tab's lifecycle, never window.opener, never postMessage. The backend serves
 *    a self-closing page to the popup on the happy path, which means a closed
 *    tab is indistinguishable from a customer who gave up.
 *
 * ---------------------------------------------------------------------------
 * CORS
 * ---------------------------------------------------------------------------
 * The gateway allow-lists merchant origins per-merchant; it does not send a
 * wildcard. A merchant's production and staging domains are registered during
 * the compliance onboarding review that gates access to custom checkout. If you
 * see opaque network failures on every call, the origin is almost certainly not
 * registered yet. Do not "fix" this by relaxing anything client-side.
 *
 * ---------------------------------------------------------------------------
 * Flow per method
 * ---------------------------------------------------------------------------
 *
 *   // once, up front
 *   var config = await checkout.init();
 *
 *   // --- Contact (skip entirely when config.contact.required is false) ---
 *   if (config.contact.required) {
 *     if (!checkout.validateMobile(mobile)) return showError();
 *     await checkout.submitContactDetails({ mobile: mobile, email: email });
 *   }
 *   // Alternatively, skip this call and pass contact:{mobile,email} to
 *   // createPayment() instead — the SDK saves it before charging.
 *
 *   // --- UPI QR ---
 *   checkout.selectMethod('UPI');
 *   var qr = await checkout.getUpiQr();      // polling starts here
 *   render(qr.qrImageUrl, qr.expiresInSeconds);
 *   onPayClick(function () { checkout.createPayment({ method: 'UPI', upi: { flow: 'qr' } }); });
 *
 *   // --- UPI Intent ---
 *   checkout.selectMethod('UPI');
 *   var intent = await checkout.getUpiIntentLinks();   // pure fetch, no polling
 *   renderAppButtons(intent.apps);
 *   onAppClick(async function (app) {                  // this is the Pay click
 *     var ack = await checkout.createPayment({ method: 'UPI', upi: { flow: 'intent', app: app } });
 *     window.location.href = ack.link;                 // polling started inside
 *   });
 *
 *   // --- Card ---
 *   checkout.selectMethod('CARD');                     // prefetches the 3DS script
 *   onCardNumberInput(function (value) {
 *     showLogo(checkout.getCardNetwork(value));        // local, from 6 digits
 *     if (digits(value).length === 10) {
 *       checkout.checkBin(value).then(function (bin) { // network, at 10 digits
 *         if (!bin.supported) showError(bin.unsupportedReason);
 *         return checkout.getAmountForMethod('CARD');
 *       }).then(showTotal);
 *     }
 *   });
 *   onPayClick(function () {                           // no await before this call
 *     checkout.createPayment({
 *       method: 'CARD',
 *       card: { number: n, expiry: 'MM/YY', cvv: c, holderName: h },
 *       contact: { mobile: m },
 *     });
 *   });
 *
 *   // --- Netbanking / Wallet ---
 *   checkout.selectMethod('NETBANKING');
 *   await checkout.getAmountForMethod('NETBANKING', bankCode);
 *   onPayClick(function () {
 *     checkout.createPayment({ method: 'NETBANKING', bankCode: bankCode });
 *   });
 */
(function (window, document) {
  'use strict';

  /* =========================================================================
   * MODULE 1 — Env
   * ========================================================================= */

  /**
   * One gateway host per environment. Every endpoint this SDK touches lives on
   * this single base; there is deliberately no second host to reason about.
   */
  var GATEWAY_BASES = {
    prod: 'https://olympus-pg.enkash.in',
    uat: 'https://olympus-pg-uat.enkash.in',
    dev: 'https://olympus-dev.enkash.in',
  };

  /**
   * Static asset host, used to turn the bank/wallet/app codes the gateway
   * returns into URLs the merchant can put in an <img src>.
   *
   * TODO(assets): exact per-asset-type paths still to be confirmed. Current
   * mapping is lifted from the hosted checkout app:
   *   netbanking  {base}/netbanking/{bankCode}.png    (fallback default-bank.svg)
   *   wallets     {base}/wallets/{walletCode}.svg     (fallback WA001.svg)
   *   upi apps    {base}/upi/{phonepe|gpay|paytm}-symbol.svg, other-upi.svg
   *   cards       {base}/cards/{visa|mastercard|rupay|amex|diners}.svg
   */
  var ASSET_BASES = {
    prod: 'https://checkoutv3.enkash.com/assets',
    uat: 'https://checkout-uat-v3.enkash.in/assets',
    dev: 'https://checkout-dev.enkash.in/assets',
  };

  /**
   * Lyra 3DS MPI script, prefetched as soon as the card method is selected so
   * the challenge is not waiting on a cold script fetch at authorise time.
   *
   * TODO(lyra-url): replace with the public hosted URL once supplied. This
   * currently guesses a sibling of the asset base, mirroring the local build
   * asset `src/assets/js/lyrampi-1.0.1.js` registered in angular.json. If the
   * real URL differs, only this function changes.
   */
  function lyraScriptUrl(environment) {
    return ASSET_BASES[environment] + '/js/lyrampi-1.0.1.js';
  }

  /* =========================================================================
   * MODULE 2 — Constants
   * ========================================================================= */

  var CURRENCY = 'INR'; // INR only. Not sourced from the API by design.

  /** Order states that can never accept another charge attempt. */
  var NON_PAYABLE_ORDER_STATUSES = ['EXPIRED', 'CANCELLED', 'PAID'];

  /**
   * Payment modes that get a popup tab. All four card modes are included
   * because LYRA-vs-redirect is only knowable from the charge response, long
   * after the tab has to be opened; an unused tab is simply closed again.
   */
  var POPUP_ELIGIBLE_PAYMENT_MODES = [
    'NET_BANKING',
    'WALLET',
    'CREDIT_CARD',
    'DEBIT_CARD',
    'PREPAID_CARD',
    'CORPORATE_CARD',
  ];

  var POPUP_POLL_INTERVAL_MS = 5000;
  var POPUP_POLL_BUDGET_MS = 300000; // 5 min, then the attempt is abandoned
  var POPUP_CLOSED_WATCH_INTERVAL_MS = 1000;
  var UPI_POLL_INTERVAL_MS = 5000;
  var LYRA_POLL_INTERVAL_MS = 5000;
  var DEFAULT_UPI_TIMEOUT_MINUTES = 5;

  var CARD_MODE_BY_CARD_TYPE = {
    CREDIT: 'CREDIT_CARD',
    DEBIT: 'DEBIT_CARD',
    PREPAID: 'PREPAID_CARD',
    CORPORATE: 'CORPORATE_CARD',
  };

  /** Two-letter surcharge-key segment per card type. */
  var SURCHARGE_CODE_BY_CARD_TYPE = {
    CREDIT: 'CC',
    DEBIT: 'DC',
    PREPAID: 'PC',
    CORPORATE: 'BC',
  };

  var UPI_APPS = ['phonepe', 'gpay', 'paytm', 'upi'];

  var UPI_APP_META = {
    phonepe: { label: 'PhonePe', icon: 'upi/phonepe-symbol.svg' },
    gpay: { label: 'Google Pay', icon: 'upi/gpay-symbol.svg' },
    paytm: { label: 'Paytm', icon: 'upi/paytm-symbol.svg' },
    upi: { label: 'Other UPI', icon: 'upi/other-upi.svg' },
  };

  /* =========================================================================
   * MODULE 3 — Errors
   * ========================================================================= */

  var ErrorCode = {
    INVALID_OPTIONS: 'INVALID_OPTIONS',
    NOT_INITIALISED: 'NOT_INITIALISED',
    ALREADY_DESTROYED: 'ALREADY_DESTROYED',
    NETWORK: 'NETWORK',
    GATEWAY: 'GATEWAY',
    ORDER_NOT_PAYABLE: 'ORDER_NOT_PAYABLE',
    METHOD_NOT_ENABLED: 'METHOD_NOT_ENABLED',
    METHOD_NOT_SELECTED: 'METHOD_NOT_SELECTED',
    ATTEMPT_IN_PROGRESS: 'ATTEMPT_IN_PROGRESS',
    VALIDATION: 'VALIDATION',
    UNSUPPORTED: 'UNSUPPORTED',
    MISSING_REDIRECT_URL: 'MISSING_REDIRECT_URL',
    LYRA_UNAVAILABLE: 'LYRA_UNAVAILABLE',
  };

  function SdkError(code, message, detail) {
    var err = new Error(message);
    err.name = 'EnkashCheckoutError';
    err.code = code;
    if (detail) err.detail = detail;
    return err;
  }

  /* =========================================================================
   * MODULE 4 — Http
   * ========================================================================= */

  /**
   * Thin fetch wrapper that normalises the two response conventions in use:
   *
   *   {response_code, response_message, payload}  — /pay/checkout/*, /api/v0/*
   *   bare body                                   — /pay/charge/* sometimes
   *
   * A non-zero response_code becomes a rejection so callers only handle one
   * failure path.
   */
  function Http(baseUrl) {
    this._base = baseUrl;
  }

  Http.prototype.request = function (method, path, options) {
    var opts = options || {};
    var url = this._base + (path.charAt(0) === '/' ? path : '/' + path);

    if (opts.params) {
      var search = [];
      for (var key in opts.params) {
        if (!Object.prototype.hasOwnProperty.call(opts.params, key)) continue;
        var value = opts.params[key];
        if (value == null) continue;
        search.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
      }
      if (search.length) url += (url.indexOf('?') === -1 ? '?' : '&') + search.join('&');
    }

    var init = { method: method, credentials: 'omit', headers: {} };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    if (opts.signal) init.signal = opts.signal;

    return window
      .fetch(url, init)
      .then(
        function (response) {
          return response.text().then(function (text) {
            var parsed = null;
            if (text) {
              try {
                parsed = JSON.parse(text);
              } catch (e) {
                parsed = null;
              }
            }
            if (!response.ok) {
              throw SdkError(
                ErrorCode.GATEWAY,
                pickGatewayMessage(parsed) || 'Request failed with status ' + response.status,
                { httpStatus: response.status, path: path, body: parsed }
              );
            }
            return unwrapEnvelope(parsed, path);
          });
        },
        function (networkError) {
          // Also the shape a CORS rejection takes: the browser gives us an
          // opaque TypeError with no status. See the CORS note in the header.
          throw SdkError(ErrorCode.NETWORK, 'Unable to reach the payment gateway', {
            path: path,
            cause: String(networkError && networkError.message ? networkError.message : networkError),
          });
        }
      );
  };

  Http.prototype.get = function (path, options) {
    return this.request('GET', path, options);
  };
  Http.prototype.post = function (path, body) {
    return this.request('POST', path, { body: body });
  };
  Http.prototype.patch = function (path, body) {
    return this.request('PATCH', path, { body: body });
  };

  function unwrapEnvelope(parsed, path) {
    if (parsed && typeof parsed === 'object' && 'response_code' in parsed) {
      if (Number(parsed.response_code) !== 0) {
        throw SdkError(
          ErrorCode.GATEWAY,
          parsed.response_message || 'Gateway rejected the request',
          { responseCode: Number(parsed.response_code), path: path }
        );
      }
      return parsed.payload;
    }
    return parsed;
  }

  function pickGatewayMessage(parsed) {
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed.response_message || parsed.resultMessage || parsed.message || null;
  }

  /* =========================================================================
   * MODULE 5 — Cards (pure, synchronous, no network)
   * ========================================================================= */

  /**
   * Network detection from the first 6 digits. Shipped as a prefix table rather
   * than a lookup call, so the merchant can render the right brand mark while
   * the customer is still typing.
   *
   * INTENTIONAL: this is independent of checkBin() and must stay that way. They
   * answer different questions — this one is "which logo do I draw", checkBin is
   * "is this specific card accepted for this order". Do not reconcile them into
   * a single call; the local one must stay zero-latency and the remote one must
   * stay explicit.
   */
  var NETWORK_PREFIX_TESTS = [
    { network: 'VISA', re: /^4[0-9]{5}$/ },
    {
      network: 'RUPAY',
      re: /^(508[5-9][0-9]{2})|(6069[8-9][0-9])|(607[0-8][0-9]{2})|(6079[0-8][0-9])|(608[0-5][0-9]{2})|(6521[5-9][0-9])|(652[2-9][0-9]{2})|(6530[0-9]{2})|(6531[0-4][0-9])$/,
    },
    { network: 'MAESTRO', re: /^(5018|5020|5038|5893|6304|6759|6761|6762|6763)[0-9]{2}$/ },
    {
      network: 'MASTERCARD',
      re: /^(5[1-5][0-9]{4}|2(?:2(?:2[1-9]|[3-9][0-9])|[3-6][0-9][0-9]|7(?:[01][0-9]|20))[0-9]{2})$/,
    },
    { network: 'AMEX', re: /^3[47][0-9]{4}$/ },
    { network: 'DINERS', re: /^(30|36|38)[0-9]{4}$/ },
    {
      network: 'DISCOVER',
      re: /^(65[4-9][0-9]{3}|64[4-9][0-9]{3}|6011[0-9]{2}|622(?:12[6-9]|1[3-9][0-9]|[2-8][0-9][0-9]|9[01][0-9]|92[0-5]))$/,
    },
  ];

  /** Digit counts a valid PAN may have, per network. */
  var NETWORK_LENGTHS = {
    VISA: [16],
    MASTERCARD: [16],
    MAESTRO: [16],
    RUPAY: [16],
    DISCOVER: [16],
    AMEX: [15],
    DINERS: [14],
  };

  var NETWORK_LOGO_FILE = {
    VISA: 'cards/visa.svg',
    MASTERCARD: 'cards/mastercard.svg',
    MAESTRO: 'cards/mastercard.svg', // no dedicated Maestro asset ships today
    RUPAY: 'cards/rupay.svg',
    AMEX: 'cards/amex.svg',
    DINERS: 'cards/diners.svg',
  };

  function digitsOnly(value) {
    return String(value == null ? '' : value).replace(/\D/g, '');
  }

  function detectCardNetwork(cardNumber) {
    var digits = digitsOnly(cardNumber);
    if (digits.length < 6) return 'UNKNOWN';
    var bin = digits.slice(0, 6);
    for (var i = 0; i < NETWORK_PREFIX_TESTS.length; i++) {
      if (NETWORK_PREFIX_TESTS[i].re.test(bin)) return NETWORK_PREFIX_TESTS[i].network;
    }
    return 'UNKNOWN';
  }

  /**
   * Luhn / mod-10 plus a network length check.
   *
   * Note this deliberately diverges from the hosted checkout app, whose Luhn
   * validator only reports failure when the input is exactly 16 characters —
   * meaning AMEX (15) and Diners (14) are never actually checked there. That is
   * a bug, not a contract, so it is not reproduced.
   */
  function isLuhnValid(cardNumber) {
    var digits = digitsOnly(cardNumber);
    if (digits.length < 12) return false;

    var sum = 0;
    var shouldDouble = false;
    for (var i = digits.length - 1; i >= 0; i--) {
      var digit = digits.charCodeAt(i) - 48;
      if (shouldDouble) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
      shouldDouble = !shouldDouble;
    }
    if (sum % 10 !== 0) return false;

    var network = detectCardNetwork(digits);
    var allowed = NETWORK_LENGTHS[network];
    if (!allowed) return true; // unknown network: checksum alone is all we have
    return allowed.indexOf(digits.length) !== -1;
  }

  function expectedCvvLength(cardNumber) {
    return detectCardNetwork(cardNumber) === 'AMEX' ? 4 : 3;
  }

  /** Accepts `MM/YY` or `MMYY`; returns a normalised `MM/YY` or null. */
  function normaliseExpiry(expiry) {
    var digits = digitsOnly(expiry);
    if (digits.length !== 4) return null;

    var month = parseInt(digits.slice(0, 2), 10);
    var year = parseInt(digits.slice(2), 10);
    if (isNaN(month) || isNaN(year) || month < 1 || month > 12) return null;

    var fullYear = 2000 + year;
    var now = new Date();
    var currentYear = now.getFullYear();
    var currentMonth = now.getMonth() + 1;
    if (fullYear < currentYear) return null;
    if (fullYear === currentYear && month < currentMonth) return null;

    return digits.slice(0, 2) + '/' + digits.slice(2);
  }

  /* =========================================================================
   * MODULE 6 — Fees
   * ========================================================================= */

  /**
   * Surcharge engine, ported to match the hosted checkout exactly.
   *
   * Keys are PREFIX_METHOD_QUALIFIER:
   *   prefix     SC_ surcharge (charged) | CF_ convenience fee (charged)
   *              PF_ platform fee (resolved, never charged, never exposed)
   *   method     UP upi | WA wallet | NB netbanking
   *              CC credit | DC debit | PC prepaid | BC corporate card
   *   qualifier  DEFAULT | bankCode | walletCode | cardScheme | pgCode
   *
   * Every resolved value is an absolute rupee amount, never a percentage. The
   * only rate is order.surchargeGst.
   *
   * Resolution uses nullish fallbacks, not falsy: an explicit 0 on a specific
   * key wins and stops the chain. `firstNumber` below preserves that.
   */
  function firstNumber() {
    for (var i = 0; i < arguments.length; i++) {
      var value = arguments[i];
      if (value !== null && value !== undefined) return Number(value);
    }
    return 0;
  }

  /**
   * @param {object} order   raw order-detail payload
   * @param {string} method  'UPI' | 'CARD' | 'NETBANKING' | 'WALLET'
   * @param {object} ctx     { bankCode?, walletCode?, cardScheme?, cardType?, pgCode? }
   */
  function computeFees(order, method, ctx) {
    var surcharges = (order && order.surcharges) || {};
    var context = ctx || {};
    var surcharge = 0;
    var convenienceFee = 0;

    if (method === 'UPI') {
      // UPI has no sub-option: QR, intent and collect all share *_UP_DEFAULT.
      surcharge = firstNumber(surcharges['SC_UP_DEFAULT']);
      convenienceFee = firstNumber(surcharges['CF_UP_DEFAULT']);
    } else if (method === 'WALLET') {
      var walletCode = context.walletCode;
      surcharge = firstNumber(surcharges['SC_WA_' + walletCode], surcharges['SC_WA_DEFAULT']);
      convenienceFee = firstNumber(surcharges['CF_WA_' + walletCode], surcharges['CF_WA_DEFAULT']);
    } else if (method === 'NETBANKING') {
      var bankCode = context.bankCode;
      surcharge = firstNumber(surcharges['SC_NB_' + bankCode], surcharges['SC_NB_DEFAULT']);
      convenienceFee = firstNumber(surcharges['CF_NB_' + bankCode], surcharges['CF_NB_DEFAULT']);
    } else if (method === 'CARD') {
      var cardScheme = context.cardScheme;
      var pgCode = context.pgCode;

      // No BIN result yet: fees stay zero until the card is identified. Same
      // early-exit the hosted checkout uses.
      if (!cardScheme && !pgCode) {
        return feeResult(order, 0, 0);
      }

      if (pgCode === 'ENKASH_D2I') {
        // Special-cased ahead of the generic path, gated on presence of the
        // prepaid key alone. cardType is ignored in this branch.
        if (surcharges['SC_PC_ENKASH_D2I'] !== null && surcharges['SC_PC_ENKASH_D2I'] !== undefined) {
          surcharge = firstNumber(surcharges['SC_PC_ENKASH_D2I']);
          convenienceFee = firstNumber(surcharges['CF_PC_ENKASH_D2I']);
        } else {
          surcharge = firstNumber(surcharges['SC_CC_ENKASH_D2I']);
          convenienceFee = firstNumber(surcharges['CF_CC_ENKASH_D2I']);
        }
        return feeResult(order, surcharge, convenienceFee);
      }

      // An absent or unmapped cardType yields an empty segment, producing keys
      // like SC__VISA that miss and leave fees at zero. Preserved on purpose.
      var typeCode = context.cardType ? SURCHARGE_CODE_BY_CARD_TYPE[context.cardType] || '' : '';
      surcharge = firstNumber(
        surcharges['SC_' + typeCode + '_' + cardScheme],
        surcharges['SC_' + typeCode + '_' + pgCode],
        surcharges['SC_' + typeCode + '_DEFAULT']
      );
      convenienceFee = firstNumber(
        surcharges['CF_' + typeCode + '_' + cardScheme],
        surcharges['CF_' + typeCode + '_' + pgCode],
        surcharges['CF_' + typeCode + '_DEFAULT']
      );
    }

    return feeResult(order, surcharge, convenienceFee);
  }

  function feeResult(order, surcharge, convenienceFee) {
    var base = Number(order.amount);
    var gstRate = Number(order.surchargeGst) || 0;
    var additional = surcharge + convenienceFee;
    var gst = (additional * gstRate) / 100;

    // No internal rounding. The merchant formats for display; the gateway
    // recomputes authoritatively from the two fields we send on the charge.
    return {
      amount: base,
      surcharge: surcharge,
      convenienceFee: convenienceFee,
      gst: gst,
      total: base + additional + gst,
      currency: CURRENCY,
    };
  }

  /* =========================================================================
   * MODULE 7 — StatusMap
   * ========================================================================= */

  /**
   * Two mapping tables, kept separate on purpose. Do not merge them.
   *
   * For a bank redirect, PENDING_WITH_BANK is the *initial* handed-off state:
   * charge-process returns it before the customer has even seen the bank page.
   * For UPI and LYRA the same value only appears after the customer approved in
   * their app. So it is non-terminal for popups and terminal-success for the
   * other two. Merging these would conclude every popup as instant success.
   */
  var POPUP_TERMINAL = ['SUCCESS', 'FAILED', 'CANCELLED', 'EXPIRED'];

  function mapMinimalToPopupStatus(minimal) {
    if (!minimal) return 'PROCESS'; // a failed poll must not end the flow

    var orderStatus = String(minimal.orderStatus || '').toUpperCase();
    switch (orderStatus) {
      case 'PAID':
      case 'SUCCESS':
      case 'CAPTURED':
        return 'SUCCESS';
      case 'FAILED':
        return 'FAILED';
      case 'CANCELLED':
        return 'CANCELLED';
      case 'EXPIRED':
      case 'TIMEOUT':
        return 'EXPIRED';
      case 'CREATED':
      case 'PENDING':
      case 'PROCESSING':
        return 'PROCESS';
      case 'ATTEMPTED':
        break; // outcome lives on the transaction, fall through
      default:
        return 'UNKNOWN';
    }

    var txnStatus = String(minimal.status || minimal.transactionStatus || '').toUpperCase();
    switch (txnStatus) {
      case 'SUCCESS':
      case 'AUTHORIZED':
        return 'SUCCESS';
      case 'PENDING_WITH_BANK':
      case 'PENDING':
        return 'PROCESS';
      case 'FAILED':
        return 'FAILED';
      case 'CANCELLED':
        return 'CANCELLED';
      case 'EXPIRED':
      case 'TIMEOUT':
        return 'EXPIRED';
      case 'PROCESS':
      case '':
        return 'PROCESS';
      default:
        return 'UNKNOWN'; // non-terminal: keep polling rather than guess
    }
  }

  function isPopupTerminal(status) {
    return POPUP_TERMINAL.indexOf(status) !== -1;
  }

  /** UPI and LYRA share this classification of the UPI status endpoint. */
  var UPI_TERMINAL_SUCCESS = ['SUCCESS', 'PENDING_WITH_BANK', 'AUTHORIZED'];
  var UPI_TERMINAL_FAILED = ['FAILED'];

  function classifyUpiStatus(status) {
    var value = String(status || '').toUpperCase();
    if (value === 'PROCESS' || value === '') return 'PENDING';
    if (UPI_TERMINAL_SUCCESS.indexOf(value) !== -1) return 'SUCCESS';
    if (UPI_TERMINAL_FAILED.indexOf(value) !== -1) return 'FAILED';
    return 'UNRECOGNISED';
  }

  /** Terminal payment_status for the merchant, derived from a minimal payload. */
  function resolvePaymentStatus(minimal) {
    if (!minimal) return 'failed';

    var orderStatus = String(minimal.orderStatus || '').toUpperCase();
    var txnStatus = String(minimal.status || minimal.transactionStatus || '').toUpperCase();
    var key = (orderStatus === 'ATTEMPTED' ? txnStatus || orderStatus : orderStatus || txnStatus).toUpperCase();

    if (key === 'SUCCESS' || key === 'PAID' || key === 'CAPTURED' || key === 'AUTHORIZED') {
      return 'success';
    }
    if (key === 'CANCELLED') return 'cancelled';

    // Everything else, pending and expired included, collapses to failed. This
    // matches what merchants receive from the hosted checkout redirect today.
    return 'failed';
  }

  /* =========================================================================
   * MODULE 8 — Poller
   * ========================================================================= */

  /**
   * Keyed polling. One live channel per id ('upi' | 'popup' | 'lyra').
   *
   * Uses a setTimeout chain rather than setInterval so a slow response can never
   * stack requests, and swallows per-request errors so a transient failure does
   * not end a payment. Only the budget ends a channel that never resolves.
   */
  function Poller() {
    this._channels = Object.create(null);
  }

  Poller.prototype.start = function (id, options) {
    this.stop(id);

    var self = this;
    var channel = { stopped: false, timer: null, startedAt: Date.now() };
    this._channels[id] = channel;

    function finish() {
      channel.stopped = true;
      if (channel.timer) clearTimeout(channel.timer);
      if (self._channels[id] === channel) delete self._channels[id];
    }

    function schedule() {
      if (channel.stopped) return;
      channel.timer = setTimeout(tick, options.intervalMs);
    }

    function tick() {
      if (channel.stopped) return;

      if (options.budgetMs && Date.now() - channel.startedAt >= options.budgetMs) {
        finish();
        if (options.onBudgetExpired) options.onBudgetExpired();
        return;
      }

      options.fetch().then(
        function (payload) {
          if (channel.stopped) return;
          var verdict;
          try {
            verdict = options.onTick(payload);
          } catch (e) {
            verdict = 'continue';
          }
          if (verdict === 'stop') {
            finish();
            return;
          }
          schedule();
        },
        function () {
          // Transient failure. Keep going; the budget is the only deadline.
          if (channel.stopped) return;
          schedule();
        }
      );
    }

    tick(); // fire immediately, then on the interval
  };

  Poller.prototype.stop = function (id) {
    var channel = this._channels[id];
    if (!channel) return;
    channel.stopped = true;
    if (channel.timer) clearTimeout(channel.timer);
    delete this._channels[id];
  };

  Poller.prototype.stopAll = function () {
    for (var id in this._channels) {
      if (Object.prototype.hasOwnProperty.call(this._channels, id)) this.stop(id);
    }
  };

  /* =========================================================================
   * MODULE 9 — Countdown (visibility aware)
   * ========================================================================= */

  /**
   * A UPI deadline has to survive the customer switching to their UPI app,
   * which both backgrounds this tab and throttles its timers. On return to
   * visibility the whole hidden span is subtracted, so the window cannot drift.
   */
  function Countdown(seconds, onExpire) {
    this._remaining = seconds;
    this._onExpire = onExpire;
    this._interval = null;
    this._hiddenAt = null;
    this._stopped = false;

    var self = this;
    this._onVisibility = function () {
      if (document.visibilityState === 'hidden') {
        self._hiddenAt = Date.now();
        return;
      }
      if (self._hiddenAt != null) {
        var hiddenSeconds = Math.floor((Date.now() - self._hiddenAt) / 1000);
        self._hiddenAt = null;
        self._tick(hiddenSeconds);
      }
    };
  }

  Countdown.prototype.start = function () {
    var self = this;
    document.addEventListener('visibilitychange', this._onVisibility);
    this._interval = setInterval(function () {
      self._tick(1);
    }, 1000);
  };

  Countdown.prototype._tick = function (by) {
    if (this._stopped) return;
    this._remaining -= by;
    if (this._remaining > 0) return;
    this._remaining = 0;
    var onExpire = this._onExpire;
    this.stop();
    if (onExpire) onExpire();
  };

  Countdown.prototype.remainingSeconds = function () {
    return Math.max(0, this._remaining);
  };

  Countdown.prototype.stop = function () {
    this._stopped = true;
    if (this._interval) clearInterval(this._interval);
    this._interval = null;
    document.removeEventListener('visibilitychange', this._onVisibility);
  };

  /* =========================================================================
   * MODULE 10 — Popup
   * ========================================================================= */

  /**
   * Owns the single bank/ACS tab. At most one handle exists at a time.
   *
   * `window.open('', '_blank')` is called with no feature string on purpose:
   * omitting it gets a real tab with a visible address bar, which matters on a
   * bank or 3DS page where customers are told to check the padlock. Adding
   * width=/height= would turn this into a chrome-less popup and lose that.
   */
  function Popup() {
    this._handle = null;
    this._closedWatcher = null;
  }

  /** MUST run synchronously inside the click, before any await. */
  Popup.prototype.openBlank = function () {
    if (this.hasHandle()) return true;
    var handle = null;
    try {
      handle = window.open('', '_blank');
    } catch (e) {
      handle = null;
    }
    this._handle = handle;
    if (!handle) return false; // blocked. Not an error; callers fall back.
    writePlaceholder(handle);
    return true;
  };

  Popup.prototype.hasHandle = function () {
    return this._handle != null && !this._handle.closed;
  };

  Popup.prototype.navigate = function (url) {
    if (!this.hasHandle()) return false;
    try {
      this._handle.location.href = url;
      return true;
    } catch (e) {
      this.discard();
      return false;
    }
  };

  /** UI cue only. Never used to decide an outcome. */
  Popup.prototype.watchClosed = function (onClosed) {
    this.stopWatching();
    var self = this;
    this._closedWatcher = setInterval(function () {
      if (!self._handle || self._handle.closed !== true) return;
      self.stopWatching();
      if (onClosed) onClosed();
    }, POPUP_CLOSED_WATCH_INTERVAL_MS);
  };

  Popup.prototype.stopWatching = function () {
    if (this._closedWatcher) clearInterval(this._closedWatcher);
    this._closedWatcher = null;
  };

  Popup.prototype.discard = function () {
    var handle = this._handle;
    this._handle = null;
    this.stopWatching();
    if (!handle) return;
    try {
      if (!handle.closed) handle.close();
    } catch (e) {
      // An un-closable tab is harmless; the backend page self-closes anyway.
    }
  };

  /**
   * about:blank inherits the opener's origin, so this write is same-origin.
   * Purely cosmetic: it stops the customer staring at a blank tab during the
   * charge round trip, and is replaced the moment location.href is set.
   */
  function writePlaceholder(handle) {
    try {
      handle.document.write(
        '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
          '<title>Redirecting to your bank</title></head>' +
          '<body style="margin:0;display:flex;align-items:center;justify-content:center;' +
          'min-height:100vh;font-family:system-ui,sans-serif">' +
          '<p role="status">Connecting to your bank&hellip;</p></body></html>'
      );
      handle.document.close();
    } catch (e) {
      // Cosmetic only.
    }
  }

  /* =========================================================================
   * MODULE 11 — Lyra 3DS
   * ========================================================================= */

  /**
   * Loads the Lyra MPI script once and exposes window.threeds.authenticate.
   * Prefetched when the card method is selected so the challenge is not waiting
   * on a cold fetch at authorise time.
   */
  function LyraLoader(scriptUrl) {
    this._url = scriptUrl;
    this._promise = null;
  }

  LyraLoader.prototype.load = function () {
    if (this._promise) return this._promise;

    var self = this;
    this._promise = new Promise(function (resolve, reject) {
      if (window.threeds && typeof window.threeds.authenticate === 'function') {
        resolve(window.threeds);
        return;
      }

      var existing = document.querySelector('script[data-enkash-lyra="1"]');
      if (existing) {
        existing.addEventListener('load', function () {
          resolve(window.threeds);
        });
        existing.addEventListener('error', function () {
          reject(SdkError(ErrorCode.LYRA_UNAVAILABLE, 'Lyra 3DS script failed to load'));
        });
        return;
      }

      var script = document.createElement('script');
      script.src = self._url;
      script.async = true;
      script.setAttribute('data-enkash-lyra', '1');
      script.onload = function () {
        if (window.threeds && typeof window.threeds.authenticate === 'function') {
          resolve(window.threeds);
        } else {
          reject(
            SdkError(ErrorCode.LYRA_UNAVAILABLE, 'Lyra 3DS script loaded but window.threeds is missing')
          );
        }
      };
      script.onerror = function () {
        self._promise = null; // allow a retry on the next attempt
        reject(SdkError(ErrorCode.LYRA_UNAVAILABLE, 'Lyra 3DS script failed to load'));
      };
      document.head.appendChild(script);
    });

    return this._promise;
  };

  /* =========================================================================
   * MODULE 12 — Public projection of order detail
   * ========================================================================= */

  /**
   * Projects the raw order-detail payload into the documented public config.
   *
   * Everything not listed here is withheld deliberately: transactionId,
   * publicIdentifierKey, surcharges, surchargeGst, checkoutProcessURL,
   * checkoutCancelURL, returnURL, savedCards, points, payLater,
   * connectedBanking, upiCollectTimeout, cardSchemesSupported, the per-mode
   * scheme arrays, multiplePaymentOption, anyPaymentModeActive, error.
   */
  function projectConfig(order, assetBase) {
    var merchantInfo = order.merchantInfo || {};
    var methods = {};

    if (order.upi === true) {
      methods.upi = {
        qr: order.upiQrCodeEnabled !== false,
        intent: merchantInfo.hideAppIntentLinks !== true,
        // Pinned false, not read from merchantInfo.upiVpaEnabled: this SDK has
        // no collect support, so a merchant must not be able to build a VPA
        // field against a capability that does not exist here.
        vpa: false,
      };
    }

    var cardModes = [];
    if (order.creditCard === true) cardModes.push('CREDIT_CARD');
    if (order.debitCard === true) cardModes.push('DEBIT_CARD');
    if (order.prepaidCard === true) cardModes.push('PREPAID_CARD');
    if (order.corporateCard === true) cardModes.push('CORPORATE_CARD');
    if (cardModes.length) {
      methods.card = {
        modes: cardModes,
        schemes: unionCardSchemes(order, cardModes),
      };
    }

    if (order.netBanking === true) {
      methods.netbanking = {
        banks: (order.netBankingList || []).map(function (bank) {
          return toBankOption(bank, assetBase);
        }),
        topBanks: (order.topNetBankingList || []).map(function (bank) {
          return toBankOption(bank, assetBase);
        }),
      };
    }

    if (order.wallet === true) {
      methods.wallet = {
        wallets: (order.walletList || []).map(function (wallet) {
          return {
            code: wallet.code,
            name: wallet.name,
            logoUrl: assetBase + '/wallets/' + wallet.code + '.svg',
          };
        }),
      };
    }

    return {
      orderId: order.uniqueTransactionId,
      amount: Number(order.amount),
      totalAmount: Number(order.totalAmount),
      currency: CURRENCY,
      merchant: {
        name: merchantInfo.merchantName || null,
        logoUrl: merchantInfo.checkoutLogo || null,
        themeColor: merchantInfo.checkoutColorScheme || null,
      },
      customer: {
        name: order.name || null,
        phone: order.phone || null,
      },
      contact: { required: order.skipContactInfo !== true },
      methods: methods,
      attemptsLeft: order.paymentAttemptLeft === true,
    };
  }

  function toBankOption(bank, assetBase) {
    return {
      code: bank.code,
      name: bank.name,
      // Keyed on code, not on bank.image, matching the hosted checkout.
      logoUrl: assetBase + '/netbanking/' + bank.code + '.png',
      accountType: bank.netBankingAccountType,
    };
  }

  /**
   * Union of the per-mode scheme allow-lists, for display only. The per-mode
   * lists are what the gateway actually enforces, so checkBin() gates on the
   * list matching the detected card's mode, never on this union.
   */
  function unionCardSchemes(order, cardModes) {
    var listByMode = {
      CREDIT_CARD: order.creditCardSchemes,
      DEBIT_CARD: order.debitCardSchemes,
      PREPAID_CARD: order.prepaidCardSchemes,
      CORPORATE_CARD: order.corporateCardSchemes,
    };

    var seen = Object.create(null);
    var result = [];
    var anyUnrestricted = false;

    for (var i = 0; i < cardModes.length; i++) {
      var list = listByMode[cardModes[i]];
      if (!list || !list.length) {
        anyUnrestricted = true; // absent or empty means "no restriction"
        continue;
      }
      for (var j = 0; j < list.length; j++) {
        var scheme = String(list[j]).toUpperCase();
        if (seen[scheme]) continue;
        seen[scheme] = true;
        result.push(scheme);
      }
    }

    if (anyUnrestricted) {
      var fallback = (order.cardSchemesSupported || []).map(function (s) {
        return String(s).toUpperCase();
      });
      for (var k = 0; k < fallback.length; k++) {
        if (seen[fallback[k]]) continue;
        seen[fallback[k]] = true;
        result.push(fallback[k]);
      }
    }

    return result;
  }

  /* =========================================================================
   * MODULE 13 — Public facade
   * ========================================================================= */

  function EnkashCustomCheckout(options) {
    var opts = options || {};

    if (!opts.order_id || typeof opts.order_id !== 'string') {
      throw SdkError(ErrorCode.INVALID_OPTIONS, 'EnkashCustomCheckout: `order_id` is required');
    }
    if (typeof opts.handler !== 'function') {
      throw SdkError(ErrorCode.INVALID_OPTIONS, 'EnkashCustomCheckout: `handler` function is required');
    }
    if (!opts.key || typeof opts.key !== 'string') {
      throw SdkError(ErrorCode.INVALID_OPTIONS, 'EnkashCustomCheckout: `key` is required');
    }

    var environment = opts.environment || 'prod';
    if (!GATEWAY_BASES[environment]) {
      throw SdkError(
        ErrorCode.INVALID_OPTIONS,
        'EnkashCustomCheckout: unknown environment "' + environment + '". Expected prod, uat or dev.'
      );
    }

    // Held but intentionally unused for now.
    // TODO(key): may later be matched against publicIdentifierKey or used as an
    // auth credential — not yet decided. Could also be removed.
    this._key = opts.key;

    this._environment = environment;
    this._orderId = opts.order_id;
    this._handler = opts.handler;
    this._onPopupClosed = typeof opts.onPopupClosed === 'function' ? opts.onPopupClosed : null;

    this._assetBase = ASSET_BASES[environment];
    this._http = new Http(GATEWAY_BASES[environment]);
    this._poller = new Poller();
    this._popup = new Popup();
    this._lyra = new LyraLoader(lyraScriptUrl(environment));

    this._order = null; // raw order-detail payload, never exposed
    this._destroyed = false;
    this._delivered = false;

    // Contact state survives method switches: once saved for this order, it does
    // not need resending on a later attempt.
    this._contact = { submitted: false, mobile: null, email: null, customer: null };

    this._method = null;
    this._feeContext = {};
    this._binCache = Object.create(null);
    this._binInFlight = Object.create(null);

    this._attempt = null;
    this._attemptSeq = 0;

    this._upi = null; // active QR/intent session: { referenceId, flow, countdown }
    this._upiIntentRef = null; // transactionId from /upi-detail
    this._upiIntentLinks = null; // { gpay, phonepe, paytm, upi }
  }

  /* ---------------------------------------------------------------- init --- */

  EnkashCustomCheckout.prototype.init = function () {
    var self = this;
    this._assertUsable();

    return this._http.get('/pay/checkout/' + encodeURIComponent(this._orderId)).then(function (order) {
      if (!order || !order.transactionId) {
        throw SdkError(ErrorCode.GATEWAY, 'Order detail response was missing transactionId');
      }
      self._order = order;
      return projectConfig(order, self._assetBase);
    });
  };

  /* ------------------------------------------------------- selectMethod --- */

  /**
   * Declares which method the customer is now looking at. Single teardown point
   * for the previous method: stops every poll channel, drops any UPI reference,
   * clears BIN and fee context, and prefetches the 3DS script for cards.
   *
   * Rejected while an attempt is live, so a mid-flight payment cannot have the
   * rug pulled from under it.
   */
  EnkashCustomCheckout.prototype.selectMethod = function (method) {
    this._assertReady();

    var normalised = String(method || '').toUpperCase();
    if (['UPI', 'CARD', 'NETBANKING', 'WALLET'].indexOf(normalised) === -1) {
      throw SdkError(ErrorCode.VALIDATION, 'Unknown payment method "' + method + '"');
    }
    if (this._hasBlockingAttempt()) {
      throw SdkError(ErrorCode.ATTEMPT_IN_PROGRESS, 'Cannot switch method while a payment is in progress');
    }
    if (normalised === this._method) return;

    this._teardownMethodState();
    this._method = normalised;

    if (normalised === 'CARD') {
      // Fire and forget. A prefetch failure must not break method selection;
      // the LYRA branch surfaces it later if a card actually needs 3DS.
      this._lyra.load().catch(function () {});
    }
  };

  EnkashCustomCheckout.prototype._teardownMethodState = function () {
    this._poller.stopAll();

    if (this._upi) {
      // No PATCH /pay/charge/expire here, by design. Switching methods drops the
      // local reference only; the backend expires the transaction on its own.
      if (this._upi.countdown) this._upi.countdown.stop();
      this._upi = null;
    }

    this._upiIntentRef = null;
    this._upiIntentLinks = null;
    this._feeContext = {};
  };

  /* ---------------------------------------------------------- amounts ----- */

  EnkashCustomCheckout.prototype.getAmountForMethod = function (method, subCode) {
    var self = this;
    return new Promise(function (resolve) {
      self._assertReady();

      var normalised = String(method || '').toUpperCase();
      var context = {};

      if (normalised === 'NETBANKING') {
        context.bankCode = subCode;
      } else if (normalised === 'WALLET') {
        context.walletCode = subCode;
      } else if (normalised === 'CARD') {
        // subCode is ignored for cards: the key needs cardScheme + cardType +
        // pgCode together, all three of which only exist after checkBin(). Until
        // then fees are zero and total === amount.
        context.cardScheme = self._feeContext.cardScheme;
        context.cardType = self._feeContext.cardType;
        context.pgCode = self._feeContext.pgCode;
      }

      resolve(computeFees(self._order, normalised, context));
    });
  };

  /* -------------------------------------------------------- card utils ---- */

  EnkashCustomCheckout.prototype.validateCardNumber = function (cardNumber) {
    return isLuhnValid(cardNumber);
  };

  EnkashCustomCheckout.prototype.getCardNetwork = function (cardNumber) {
    return detectCardNetwork(cardNumber);
  };

  /** Convenience for drawing the brand mark; same table the hosted app uses. */
  EnkashCustomCheckout.prototype.getCardNetworkLogoUrl = function (network) {
    var file = NETWORK_LOGO_FILE[String(network || '').toUpperCase()];
    return file ? this._assetBase + '/' + file : null;
  };

  EnkashCustomCheckout.prototype.getExpectedCvvLength = function (cardNumber) {
    return expectedCvvLength(cardNumber);
  };

  /* ----------------------------------------------------------- checkBin --- */

  /**
   * The one network call among the card helpers, and deliberately explicit.
   *
   * INTENTIONAL: triggered at 10 digits, not 6, and the full typed value is
   * sent. This does not contradict getCardNetwork()'s 6-digit local detection —
   * they answer different questions and are meant to coexist. Do not "fix" them
   * into agreement.
   */
  EnkashCustomCheckout.prototype.checkBin = function (cardNumber) {
    var self = this;
    this._assertReady();

    var digits = digitsOnly(cardNumber);
    if (digits.length < 10) {
      return Promise.reject(
        SdkError(ErrorCode.VALIDATION, 'checkBin needs at least 10 digits of the card number')
      );
    }

    var cacheKey = digits.slice(0, 10);
    if (this._binCache[cacheKey]) return Promise.resolve(this._binCache[cacheKey]);
    if (this._binInFlight[cacheKey]) return this._binInFlight[cacheKey];

    var request = this._http
      .get('/api/v0/bin/details', { params: { bin: digits, transactionId: this._order.transactionId } })
      .then(function (payload) {
        delete self._binInFlight[cacheKey];
        if (!payload) throw SdkError(ErrorCode.GATEWAY, 'BIN lookup returned no data');

        var info = self._buildBinInfo(digits, payload);
        self._binCache[cacheKey] = info;

        // Feeds the fee engine. pgCode is kept internal: it is PG routing
        // detail, not something a merchant should branch on.
        self._feeContext.cardScheme = payload.cardSchemeType;
        self._feeContext.cardType = payload.cardType;
        self._feeContext.pgCode = payload.pgCode || null;
        self._feeContext.paymentMode = info.paymentMode;

        return info;
      })
      .catch(function (error) {
        delete self._binInFlight[cacheKey];
        throw error;
      });

    this._binInFlight[cacheKey] = request;
    return request;
  };

  EnkashCustomCheckout.prototype._buildBinInfo = function (digits, payload) {
    var order = this._order;
    var network = String(payload.cardSchemeType || '').toUpperCase();
    var paymentMode = CARD_MODE_BY_CARD_TYPE[payload.cardType] || null;

    var supported = false;
    var reason = null;

    if (!network || !paymentMode) {
      reason = 'MODE_DISABLED';
    } else if (!isCardModeEnabled(order, paymentMode)) {
      reason = 'MODE_DISABLED';
    } else if (!isSchemeAllowedForMode(order, paymentMode, network)) {
      reason = 'SCHEME_NOT_ALLOWED';
    } else {
      supported = true;
    }

    return {
      bin: digits.slice(0, 6),
      network: network || 'UNKNOWN',
      cardType: payload.cardType,
      paymentMode: paymentMode,
      issuer: {
        name: payload.bankName || null,
        entityName: payload.bankEntityName || null,
      },
      supported: supported,
      unsupportedReason: reason,
    };
  };

  function isCardModeEnabled(order, paymentMode) {
    switch (paymentMode) {
      case 'CREDIT_CARD':
        return order.creditCard === true;
      case 'DEBIT_CARD':
        return order.debitCard === true;
      case 'PREPAID_CARD':
        return order.prepaidCard === true;
      case 'CORPORATE_CARD':
        return order.corporateCard === true;
      default:
        return false;
    }
  }

  /**
   * Gates on the allow-list belonging to the detected card's mode, which is what
   * the gateway enforces on charge. Gating on the coarse cardSchemesSupported
   * instead lets AMEX/DINERS reach charge only to be rejected there with
   * "Card scheme type is invalid". An absent or empty list means no restriction.
   */
  function isSchemeAllowedForMode(order, paymentMode, network) {
    var listByMode = {
      CREDIT_CARD: order.creditCardSchemes,
      DEBIT_CARD: order.debitCardSchemes,
      PREPAID_CARD: order.prepaidCardSchemes,
      CORPORATE_CARD: order.corporateCardSchemes,
    };
    var list = listByMode[paymentMode];
    if (!list || !list.length) return true;
    for (var i = 0; i < list.length; i++) {
      if (String(list[i]).toUpperCase() === network) return true;
    }
    return false;
  }

  /* ---------------------------------------------------------------- UPI --- */

  /**
   * Fetches a QR for this order and starts background polling against the
   * reference id the gateway mints. Resolves as soon as the QR is displayable;
   * the outcome arrives via handler().
   */
  EnkashCustomCheckout.prototype.getUpiQr = function () {
    var self = this;
    this._assertReady();
    this._assertMethodEnabled('upi');

    return this._http
      .get('/pay/checkout/qrcode/' + encodeURIComponent(this._order.transactionId))
      .then(function (payload) {
        if (!payload || !payload.qrCode || !payload.ekPayId) {
          throw SdkError(ErrorCode.GATEWAY, 'QR response was missing qrCode or ekPayId');
        }

        self._poller.stop('upi');
        if (self._upi && self._upi.countdown) self._upi.countdown.stop();

        var expiresInSeconds = self._upiTimeoutSeconds();
        // Non-blocking: a QR on screen must not stop the customer choosing a
        // different method. It is promoted to blocking if they hit Pay.
        var attempt = self._beginAttempt('UPI', false);

        self._upi = { referenceId: payload.ekPayId, flow: 'qr', countdown: null };
        self._startUpiPolling(payload.ekPayId, attempt);
        self._startUpiCountdown(expiresInSeconds, payload.ekPayId, attempt);

        return {
          // The gateway returns a pre-rendered PNG; qrString is the raw UPI
          // intent string, exposed so a merchant can draw their own QR or offer
          // copy-to-clipboard.
          qrImageUrl: 'data:image/png;base64,' + payload.qrCode,
          qrString: payload.qrUrl || null,
          expiresInSeconds: expiresInSeconds,
          referenceId: payload.ekPayId,
        };
      });
  };

  /**
   * Pure fetch. No side effects, no transaction created, no polling started.
   * The intent transaction is only created once the customer picks an app, which
   * is createPayment({method:'UPI', upi:{flow:'intent', app}}).
   */
  EnkashCustomCheckout.prototype.getUpiIntentLinks = function () {
    var self = this;
    this._assertReady();
    this._assertMethodEnabled('upi');

    return this._http
      .get('/pay/checkout/upi-detail/' + encodeURIComponent(this._order.transactionId))
      .then(function (payload) {
        if (!payload || !payload.transactionId) {
          throw SdkError(ErrorCode.GATEWAY, 'UPI intent response was missing transactionId');
        }

        var apps = [];
        for (var i = 0; i < UPI_APPS.length; i++) {
          var app = UPI_APPS[i];
          var link = payload[app];
          if (!link) continue;
          apps.push({
            app: app,
            label: UPI_APP_META[app].label,
            link: link,
            iconUrl: self._assetBase + '/' + UPI_APP_META[app].icon,
          });
        }

        // Stashed so createPayment can reuse the id and the chosen app's link
        // without a second fetch.
        self._upiIntentRef = payload.transactionId;
        self._upiIntentLinks = {
          gpay: payload.gpay || null,
          phonepe: payload.phonepe || null,
          paytm: payload.paytm || null,
          upi: payload.upi || null,
        };

        return { referenceId: payload.transactionId, apps: apps };
      });
  };

  EnkashCustomCheckout.prototype._upiTimeoutSeconds = function () {
    var minutes = this._order.upiCollectTimeout;
    if (minutes == null) minutes = DEFAULT_UPI_TIMEOUT_MINUTES;
    return Math.max(1, Math.round(Number(minutes) * 60));
  };

  EnkashCustomCheckout.prototype._startUpiPolling = function (referenceId, attempt) {
    var self = this;
    this._poller.start('upi', {
      intervalMs: UPI_POLL_INTERVAL_MS,
      fetch: function () {
        return self._http.get('/pay/checkout/status/upi/' + encodeURIComponent(referenceId));
      },
      onTick: function (payload) {
        if (!self._isCurrent(attempt)) return 'stop';
        if (!payload || !payload.status) return 'continue';

        var verdict = classifyUpiStatus(payload.status);
        if (verdict === 'PENDING') return 'continue';

        // UNRECOGNISED is treated as a failure here rather than polled forever,
        // matching the hosted checkout's unknown-status branch.
        self._settleFromStatus(attempt, referenceId);
        return 'stop';
      },
    });
  };

  EnkashCustomCheckout.prototype._startUpiCountdown = function (seconds, referenceId, attempt) {
    var self = this;
    var countdown = new Countdown(seconds, function () {
      if (!self._isCurrent(attempt)) return;
      self._poller.stop('upi');
      // Expiry is a real terminal event for the customer: tell the backend, then
      // report whatever it says the transaction actually ended as.
      self._http.patch('/pay/charge/expire', { transactionId: referenceId, remark: 'timeout' }).then(
        function () {
          self._settleFromStatus(attempt, referenceId);
        },
        function () {
          self._settleFromStatus(attempt, referenceId);
        }
      );
    });
    countdown.start();
    if (this._upi) this._upi.countdown = countdown;
  };

  /* -------------------------------------------------------- createPayment - */

  /**
   * Single submission entry point for every method.
   *
   * MUST be called directly from the customer's click handler. The popup tab is
   * opened in the synchronous prologue below, while the click's user activation
   * is still live; any `await` on the merchant's side before this call will get
   * the popup blocked.
   */
  EnkashCustomCheckout.prototype.createPayment = function (request) {
    var self = this;
    var req = request || {};
    var method = String(req.method || '').toUpperCase();

    // ---- synchronous prologue: popup pre-open must happen before any await ---
    var popupOpened = false;
    var prologueError = null;

    try {
      this._assertReady();
      if (this._hasBlockingAttempt()) {
        throw SdkError(ErrorCode.ATTEMPT_IN_PROGRESS, 'A payment attempt is already in progress');
      }
      var paymentMode = resolvePaymentModeForRequest(method, req, this._feeContext);
      if (paymentMode && POPUP_ELIGIBLE_PAYMENT_MODES.indexOf(paymentMode) !== -1) {
        popupOpened = this._popup.openBlank();
      }
    } catch (e) {
      prologueError = e;
    }

    if (prologueError) {
      this._popup.discard();
      return Promise.reject(prologueError);
    }
    // ---- end synchronous prologue ------------------------------------------

    if (method === 'UPI') {
      return this._createUpiPayment(req).catch(function (error) {
        self._popup.discard();
        throw error;
      });
    }

    return this._createChargePayment(method, req, popupOpened).catch(function (error) {
      // One place to close an unused tab, covering every rejection path: not
      // payable, validation, gateway error, network error. Attempt settling is
      // handled inside _createChargePayment, which has the right attempt in
      // scope; doing it here could settle a newer attempt by mistake.
      self._popup.discard();
      throw error;
    });
  };

  /**
   * Resolves the paymentMode we are about to send, synchronously, so popup
   * eligibility can be decided before the first await. Cards read the mode from
   * the cached BIN result, exactly as the charge body will.
   */
  function resolvePaymentModeForRequest(method, req, feeContext) {
    if (method === 'NETBANKING') return 'NET_BANKING';
    if (method === 'WALLET') return 'WALLET';
    if (method === 'CARD') return feeContext.paymentMode || null;
    return null; // UPI is never a popup
  }

  /* -------------------------------------------------------------- UPI pay - */

  EnkashCustomCheckout.prototype._createUpiPayment = function (req) {
    var self = this;
    var upi = req.upi || {};
    this._assertMethodEnabled('upi');

    if (upi.flow === 'qr') {
      // Intentional no-op. The QR transaction was created by getUpiQr() and is
      // already being polled; there is nothing to submit. This branch exists so
      // the merchant's "customer hit Pay" handler stays one code path for every
      // method instead of special-casing QR out of createPayment.
      if (!this._upi || this._upi.flow !== 'qr') {
        return Promise.reject(
          SdkError(ErrorCode.VALIDATION, 'No active UPI QR. Call getUpiQr() before createPayment().')
        );
      }
      // The customer has now committed, so lock the method in. Polling is
      // already running and untouched.
      if (this._attempt && !this._attempt.settled) this._attempt.blocking = true;
      return Promise.resolve({ state: 'polling' });
    }

    if (upi.flow !== 'intent') {
      return Promise.reject(
        SdkError(ErrorCode.VALIDATION, 'upi.flow must be "qr" or "intent"')
      );
    }
    if (UPI_APPS.indexOf(upi.app) === -1) {
      return Promise.reject(
        SdkError(ErrorCode.VALIDATION, 'upi.app must be one of: ' + UPI_APPS.join(', '))
      );
    }

    var referenceId = this._upiIntentRef;
    if (!referenceId) {
      return Promise.reject(
        SdkError(
          ErrorCode.VALIDATION,
          'No UPI intent reference. Call getUpiIntentLinks() before createPayment().'
        )
      );
    }

    return this._patchContactIfNeeded(req.contact)
      .then(function () {
        // Creates the intent transaction and binds it to the chosen app. Only
        // after this does polling make sense.
        return self._http.post('/pay/charge/intent-transaction', {
          transactionId: referenceId,
          paymentMode: 'UPI',
          bankCode: upi.app,
        });
      })
      .then(function (payload) {
        // The gateway always echoes the same transactionId that /upi-detail
        // returned, so there is no re-targeting to do here.
        var ekPayId = (payload && payload.transactionId) || referenceId;
        var attempt = self._beginAttempt('UPI');

        self._poller.stop('upi');
        if (self._upi && self._upi.countdown) self._upi.countdown.stop();
        self._upi = { referenceId: ekPayId, flow: 'intent', countdown: null };

        self._startUpiPolling(ekPayId, attempt);
        self._startUpiCountdown(self._upiTimeoutSeconds(), ekPayId, attempt);

        var link = self._upiIntentLinkFor(upi.app);
        return { state: 'launch', link: link };
      });
  };

  EnkashCustomCheckout.prototype._upiIntentLinkFor = function (app) {
    return this._upiIntentLinks ? this._upiIntentLinks[app] : null;
  };

  /* ----------------------------------------------------------- charge pay - */

  EnkashCustomCheckout.prototype._createChargePayment = function (method, req, popupOpened) {
    var self = this;
    var paymentDetail;

    try {
      paymentDetail = this._buildPaymentDetail(method, req);
    } catch (e) {
      return Promise.reject(e);
    }

    var attempt = this._beginAttempt(method);
    var orderTxnId = this._order.transactionId;

    return this._patchContactIfNeeded(req.contact)
      .then(function () {
        // Pre-flight: fresh server truth on attempts-left and order state, so we
        // do not burn an attempt on an order that can never be charged.
        return self._http.get('/api/v0/transactions/' + encodeURIComponent(orderTxnId) + '/minimal');
      })
      .then(function (minimal) {
        if (!self._isCurrent(attempt)) throw SdkError(ErrorCode.ATTEMPT_IN_PROGRESS, 'Attempt superseded');

        if (
          minimal.paymentAttemptLeft !== true ||
          NON_PAYABLE_ORDER_STATUSES.indexOf(String(minimal.orderStatus || '').toUpperCase()) !== -1
        ) {
          throw SdkError(ErrorCode.ORDER_NOT_PAYABLE, 'This order can no longer be paid', {
            orderStatus: minimal.orderStatus,
            paymentAttemptLeft: minimal.paymentAttemptLeft,
          });
        }

        var fees = computeFees(self._order, method, self._feeContextForRequest(method, req));

        return self._http.post('/pay/charge/process', {
          uniqueTransactionId: self._order.uniqueTransactionId,
          publicIdentifierKey: self._order.publicIdentifierKey,
          transactionId: orderTxnId,
          paymentDetail: paymentDetail,
          // One merged field, string, 2dp: surcharge plus convenience fee.
          surcharge: (fees.surcharge + fees.convenienceFee).toFixed(2),
          // The flat GST rate (e.g. 18), not a computed amount.
          surchargeGst: Number(self._order.surchargeGst) || 0,
          // Owned by the SDK, never taken from the merchant. Tells the gateway to
          // serve a self-closing page to the popup instead of redirecting it to
          // a checkout UI that has no parent context here.
          //
          // TODO(callback-url): this is also the hook a future server-to-server
          // callback_url delivery mode would key off. Extension point only.
          popupMode: true,
        });
      })
      .then(function (result) {
        if (!self._isCurrent(attempt)) throw SdkError(ErrorCode.ATTEMPT_IN_PROGRESS, 'Attempt superseded');
        return self._handleChargeResponse(attempt, result, orderTxnId, popupOpened);
      })
      .catch(function (error) {
        // Close out exactly this attempt so its late continuations bail, without
        // touching whatever may have replaced it.
        attempt.settled = true;
        throw error;
      });
  };

  EnkashCustomCheckout.prototype._feeContextForRequest = function (method, req) {
    if (method === 'NETBANKING') return { bankCode: req.bankCode };
    if (method === 'WALLET') return { walletCode: req.walletCode };
    if (method === 'CARD') {
      return {
        cardScheme: this._feeContext.cardScheme,
        cardType: this._feeContext.cardType,
        pgCode: this._feeContext.pgCode,
      };
    }
    return {};
  };

  EnkashCustomCheckout.prototype._buildPaymentDetail = function (method, req) {
    if (method === 'NETBANKING') {
      this._assertMethodEnabled('netbanking');
      if (!req.bankCode) throw SdkError(ErrorCode.VALIDATION, 'bankCode is required for netbanking');
      return { paymentMode: 'NET_BANKING', bankCode: req.bankCode };
    }

    if (method === 'WALLET') {
      this._assertMethodEnabled('wallet');
      if (!req.walletCode) throw SdkError(ErrorCode.VALIDATION, 'walletCode is required for wallet');
      // The gateway carries the wallet code in bankCode for this mode.
      return { paymentMode: 'WALLET', bankCode: req.walletCode };
    }

    if (method === 'CARD') {
      this._assertMethodEnabled('card');
      var card = req.card || {};
      var number = digitsOnly(card.number);

      if (!isLuhnValid(number)) {
        throw SdkError(ErrorCode.VALIDATION, 'Card number failed validation');
      }
      var expiry = normaliseExpiry(card.expiry);
      if (!expiry) {
        throw SdkError(ErrorCode.VALIDATION, 'Card expiry is missing, malformed or in the past');
      }
      var cvv = digitsOnly(card.cvv);
      if (cvv.length !== expectedCvvLength(number)) {
        throw SdkError(ErrorCode.VALIDATION, 'CVV length does not match the card network');
      }
      if (!card.holderName || !String(card.holderName).trim()) {
        throw SdkError(ErrorCode.VALIDATION, 'Card holder name is required');
      }

      var paymentMode = this._feeContext.paymentMode;
      if (!paymentMode) {
        // The mode comes from the BIN lookup and the gateway requires it, so a
        // card cannot be charged before checkBin() has resolved.
        throw SdkError(
          ErrorCode.VALIDATION,
          'Call checkBin() and wait for it to resolve before submitting a card'
        );
      }

      return {
        // base64 only, matching the existing contract. This is obfuscation in
        // transit, not encryption; confidentiality comes from TLS.
        cardNumber: window.btoa(number),
        cvv: window.btoa(cvv),
        expiry: window.btoa(expiry),
        paymentMode: paymentMode,
        cardHolderName: String(card.holderName).trim(),
        saveCard: false,
        paymentToken: null,
        paymentType: 'NEW_CARD',
      };
    }

    throw SdkError(ErrorCode.VALIDATION, 'Unsupported method "' + method + '"');
  };

  /**
   * Branch ladder over the charge response, in the same order the hosted
   * checkout evaluates it. Order matters: dauth success and `error` are checked
   * before any redirect handling.
   */
  EnkashCustomCheckout.prototype._handleChargeResponse = function (attempt, result, orderTxnId, popupOpened) {
    var self = this;
    var settleId = result.transactionId || orderTxnId;

    // 1. Authorised with no redirect (frictionless / device auth).
    if (String(result.transactionStatus || '').toUpperCase() === 'SUCCESS' && result.dauth) {
      this._popup.discard();
      this._settleFromStatus(attempt, settleId);
      return { state: 'settled' };
    }

    // 2. Gateway-declared failure.
    if (result.error) {
      this._popup.discard();
      this._settleFromStatus(attempt, settleId, result.resultMessage);
      return { state: 'settled' };
    }

    // 3. Lyra 3DS. Not a redirect: the challenge runs in-page via their MPI
    //    script, then we poll for the outcome like any other method.
    if (result.iframe === 'LYRA') {
      this._popup.discard();
      if (!result.transactionUuid || !result.transactionId) {
        this._settleFailure(attempt, settleId, result.resultMessage || 'Missing 3DS authentication details');
        return { state: 'settled' };
      }
      this._runLyraChallenge(attempt, result.transactionUuid, result.transactionId);
      return { state: 'challenge' };
    }

    // 4. RuPay native OTP. Deliberately not implemented.
    if (result.rupay) {
      this._popup.discard();
      // TODO(rupay-otp): RuPay native OTP is out of scope for this SDK. Decision
      // still pending on whether to cancel the transaction here or leave it for
      // backend expiry. Currently we cancel so nothing is left open, which is the
      // conservative option. Revisit before this branch ships.
      this._http.patch('/pay/charge/cancel', {
        transactionId: result.transactionId || orderTxnId,
        remark: 'rupay_otp_unsupported',
      }).catch(function () {});
      this._settleFailure(
        attempt,
        settleId,
        'This card requires a RuPay OTP flow that is not supported by custom checkout yet. Please use a different card.'
      );
      return { state: 'settled' };
    }

    // 5. renderOtpPage without rupay is an ordinary bank redirect.
    // 6. Input validation rejected by the gateway: keep the attempt open so the
    //    merchant can fix the form and resubmit. No handler fire.
    if (result.resultCode === 158 || result.resultCode === 156) {
      this._popup.discard();
      attempt.settled = true;
      throw SdkError(ErrorCode.VALIDATION, result.resultMessage || 'Payment validation failed', {
        resultCode: result.resultCode,
      });
    }

    if (!result.redirectionUrl) {
      this._popup.discard();
      this._settleFailure(attempt, settleId, result.resultMessage || 'Missing payment redirect URL');
      return { state: 'settled' };
    }

    // 7. Netbanking, wallet, non-LYRA cards: hand the tab to the bank.
    var pollId = result.transactionId || orderTxnId;

    if (!popupOpened || !this._popup.hasHandle()) {
      // Blocked or never eligible. Polling still owns the outcome, so hand the
      // URL back and let the merchant decide how to navigate.
      this._startPopupPolling(pollId, attempt);
      return { state: 'launch', link: result.redirectionUrl };
    }

    if (!this._popup.navigate(result.redirectionUrl)) {
      this._startPopupPolling(pollId, attempt);
      return { state: 'launch', link: result.redirectionUrl };
    }

    var onClosed = this._onPopupClosed;
    this._popup.watchClosed(function () {
      // UI cue only, and explicitly not an outcome: the gateway's self-closing
      // page closes this tab on the happy path, so a closed tab says nothing.
      // Fires independently of, and usually before, handler().
      if (onClosed) {
        try {
          onClosed();
        } catch (e) {
          /* merchant callback must not break the flow */
        }
      }
    });

    this._startPopupPolling(pollId, attempt);
    return { state: 'popup' };
  };

  EnkashCustomCheckout.prototype._startPopupPolling = function (transactionId, attempt) {
    var self = this;
    this._poller.start('popup', {
      intervalMs: POPUP_POLL_INTERVAL_MS,
      budgetMs: POPUP_POLL_BUDGET_MS,
      fetch: function () {
        return self._http.get('/api/v0/transactions/' + encodeURIComponent(transactionId) + '/minimal');
      },
      onTick: function (minimal) {
        if (!self._isCurrent(attempt)) return 'stop';
        var status = mapMinimalToPopupStatus(minimal);
        if (!isPopupTerminal(status)) return 'continue';
        self._popup.discard();
        self._deliverFromMinimal(attempt, minimal);
        return 'stop';
      },
      onBudgetExpired: function () {
        if (!self._isCurrent(attempt)) return;
        self._popup.discard();
        // Nothing terminal within the budget. Cancel so the order is not left
        // hanging, then report whatever the backend settles on.
        self._http
          .patch('/pay/charge/order/cancel', {
            transactionId: self._order.transactionId,
            reason: 'popup_timeout',
          })
          .then(
            function () {
              self._settleFromStatus(attempt, transactionId);
            },
            function () {
              self._settleFromStatus(attempt, transactionId);
            }
          );
      },
    });
  };

  /* ---------------------------------------------------------------- Lyra --- */

  EnkashCustomCheckout.prototype._runLyraChallenge = function (attempt, transactionUuid, transactionId) {
    var self = this;

    this._lyra.load().then(
      function (threeds) {
        if (!self._isCurrent(attempt)) return;

        threeds.authenticate({
          uuid: transactionUuid,
          callback: function (err) {
            if (!self._isCurrent(attempt)) return;

            if (err) {
              // Challenge abandoned or failed client-side. Cancel, then report.
              self._http
                .patch('/pay/charge/cancel', { transactionId: transactionId, remark: '3ds_abandoned' })
                .then(
                  function () {
                    self._settleFromStatus(attempt, transactionId);
                  },
                  function () {
                    self._settleFromStatus(attempt, transactionId);
                  }
                );
              return;
            }

            // Challenge completed. The authorisation result is still the
            // gateway's to declare, so poll like every other method. LYRA's
            // outcome reaches the merchant through handler(), not specially.
            self._startLyraPolling(transactionId, attempt);
          },
        });
      },
      function () {
        if (!self._isCurrent(attempt)) return;
        self._settleFailure(
          attempt,
          transactionId,
          'Unable to load the 3-D Secure module. Please try again.'
        );
      }
    );
  };

  EnkashCustomCheckout.prototype._startLyraPolling = function (transactionId, attempt) {
    var self = this;
    this._poller.start('lyra', {
      intervalMs: LYRA_POLL_INTERVAL_MS,
      budgetMs: POPUP_POLL_BUDGET_MS,
      fetch: function () {
        return self._http.get('/pay/checkout/status/upi/' + encodeURIComponent(transactionId));
      },
      onTick: function (payload) {
        if (!self._isCurrent(attempt)) return 'stop';
        if (!payload || !payload.status) return 'continue';
        if (classifyUpiStatus(payload.status) === 'PENDING') return 'continue';
        self._settleFromStatus(attempt, transactionId);
        return 'stop';
      },
      onBudgetExpired: function () {
        if (!self._isCurrent(attempt)) return;
        self._settleFromStatus(attempt, transactionId);
      },
    });
  };

  /* ------------------------------------------------------------- contact -- */

  /**
   * Indian mobile number: ten digits starting 6-9. Same rule the hosted
   * checkout's mobileValidator enforces.
   */
  var MOBILE_RE = /^[6-9]\d{9}$/;
  var EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,4}$/;

  EnkashCustomCheckout.prototype.validateMobile = function (mobile) {
    return MOBILE_RE.test(digitsOnly(mobile));
  };

  /** Empty is valid: email is optional everywhere contact is collected. */
  EnkashCustomCheckout.prototype.validateEmail = function (email) {
    var value = String(email == null ? '' : email).trim();
    if (!value) return true;
    return EMAIL_RE.test(value);
  };

  /**
   * Saves the customer's contact details against the order.
   *
   * Optional when `config.contact.required` is false (the order carries
   * skipContactInfo), in which case the merchant can go straight to
   * createPayment(). Calling it anyway is allowed and still saves the details.
   *
   * Safe to call more than once: a later call overwrites, which is how the
   * hosted checkout's "edit contact" works. Rejected while a payment is in
   * flight, so details cannot change under an attempt.
   *
   * @param {{mobile: string, email?: string}} contact
   * @returns {Promise<{mobile: string, email: string|null, name: string|null,
   *                    address: object|null, required: boolean}>}
   */
  EnkashCustomCheckout.prototype.submitContactDetails = function (contact) {
    var self = this;

    try {
      this._assertReady();
      if (this._hasBlockingAttempt()) {
        throw SdkError(
          ErrorCode.ATTEMPT_IN_PROGRESS,
          'Cannot change contact details while a payment is in progress'
        );
      }
      assertContactShape(contact);
    } catch (e) {
      return Promise.reject(e);
    }

    return this._patchContact(contact).then(function () {
      return self._contactResult();
    });
  };

  function assertContactShape(contact) {
    if (!contact || !contact.mobile) {
      throw SdkError(ErrorCode.VALIDATION, 'contact.mobile is required');
    }
    if (!MOBILE_RE.test(digitsOnly(contact.mobile))) {
      throw SdkError(ErrorCode.VALIDATION, 'Enter a valid 10-digit mobile number');
    }
    if (contact.email && !EMAIL_RE.test(String(contact.email).trim())) {
      throw SdkError(ErrorCode.VALIDATION, 'Enter a valid email address');
    }
  }

  /** The PATCH itself. No validation, no guards: callers do that. */
  EnkashCustomCheckout.prototype._patchContact = function (contact) {
    var self = this;
    var mobile = digitsOnly(contact.mobile);
    var email = contact.email ? String(contact.email).trim() : null;

    return this._http
      .patch('/pay/checkout/customer-info/' + encodeURIComponent(this._order.transactionId), {
        customerEmail: email,
        customerMobile: mobile,
        merchantAccessKey: this._order.publicIdentifierKey,
      })
      .then(function (customer) {
        self._contact = {
          submitted: true,
          mobile: mobile,
          // The API echoes no email back, so keep what we sent.
          email: email,
          customer: customer || null,
        };
      });
  };

  /**
   * Projection of the customer-info response. companyId and
   * authenticatorEnabled are withheld: internal account plumbing, not the
   * merchant's business.
   */
  EnkashCustomCheckout.prototype._contactResult = function () {
    var customer = this._contact.customer || {};
    var address = customer.address || null;

    return {
      mobile: customer.customerMobile || customer.phoneNumber || this._contact.mobile,
      email: this._contact.email,
      name: customer.firstName || null,
      address: address
        ? {
            streetName: address.streetName || null,
            city: address.city || null,
            state: address.state || null,
            country: address.country || null,
            zipcode: address.zipcode || null,
          }
        : null,
      required: this._order.skipContactInfo !== true,
    };
  };

  /**
   * Called at the top of every charge. Three outcomes:
   *
   *   already submitted        nothing to do
   *   contact passed inline    save it now, so a merchant with a single-screen
   *                            checkout never has to call submitContactDetails
   *   nothing, and required    reject, pointing at both ways to supply it
   */
  EnkashCustomCheckout.prototype._patchContactIfNeeded = function (contact) {
    if (this._contact.submitted && !contact) return Promise.resolve();

    if (contact) {
      try {
        assertContactShape(contact);
      } catch (e) {
        return Promise.reject(e);
      }
      return this._patchContact(contact);
    }

    if (this._order.skipContactInfo === true) return Promise.resolve();

    return Promise.reject(
      SdkError(
        ErrorCode.VALIDATION,
        'This order requires contact details. Call submitContactDetails({ mobile, email? }) ' +
          'first, or pass contact: { mobile, email? } to createPayment().'
      )
    );
  };

  /* -------------------------------------------------------------- cancel -- */

  EnkashCustomCheckout.prototype.cancel = function (reason) {
    var self = this;
    this._assertReady();

    // Always a fresh attempt: this supersedes anything in flight, whose own
    // continuations then bail on the _isCurrent check.
    var attempt = this._beginAttempt(this._method || 'UPI', true);
    this._poller.stopAll();
    this._popup.discard();
    if (this._upi && this._upi.countdown) this._upi.countdown.stop();

    return this._http
      .patch('/pay/charge/order/cancel', {
        transactionId: this._order.transactionId,
        reason: reason || 'customer_cancelled',
      })
      .then(
        function () {
          self._settleFromStatus(attempt, self._order.transactionId, null, 'cancelled');
        },
        function () {
          self._settleFromStatus(attempt, self._order.transactionId, null, 'cancelled');
        }
      );
  };

  /* ------------------------------------------------------------- destroy -- */

  /** Full teardown. Deliberately does not fire handler(). */
  EnkashCustomCheckout.prototype.destroy = function () {
    this._destroyed = true;
    this._poller.stopAll();
    this._popup.discard();
    if (this._upi && this._upi.countdown) this._upi.countdown.stop();
    this._upi = null;
    this._attempt = null;
  };

  /* =========================================================================
   * MODULE 14 — Attempt lifecycle
   * ========================================================================= */

  /**
   * One live attempt at a time. Every async continuation captures the attempt on
   * entry and checks _isCurrent before touching state or delivering a result, so
   * a late response from an abandoned attempt cannot resurrect it or fire the
   * merchant's handler twice.
   *
   * `blocking` separates "the customer has committed" from "we are just watching
   * something on screen". A displayed QR polls under a non-blocking attempt, so
   * the customer can still switch to Cards; a submitted payment is blocking, so
   * nothing can be changed under it mid-flight. Mirrors the hosted checkout,
   * which gates method switching on an active OTP / collect / popup session only.
   */
  EnkashCustomCheckout.prototype._beginAttempt = function (method, blocking) {
    this._attemptSeq += 1;
    this._attempt = {
      id: this._attemptSeq,
      method: method,
      settled: false,
      blocking: blocking !== false,
    };
    return this._attempt;
  };

  EnkashCustomCheckout.prototype._isCurrent = function (attempt) {
    return !this._destroyed && this._attempt === attempt && !attempt.settled;
  };

  /** True only while a committed payment is in flight. */
  EnkashCustomCheckout.prototype._hasBlockingAttempt = function () {
    return this._attempt != null && !this._attempt.settled && this._attempt.blocking === true;
  };

  /* =========================================================================
   * MODULE 15 — Result delivery
   * ========================================================================= */

  /**
   * Fetches the authoritative minimal payload and delivers it. Used by every
   * terminal path so the merchant's payload is identical regardless of method.
   */
  EnkashCustomCheckout.prototype._settleFromStatus = function (attempt, transactionId, fallbackMessage, forcedStatus) {
    var self = this;
    if (!this._isCurrent(attempt)) return;

    this._http.get('/api/v0/transactions/' + encodeURIComponent(transactionId) + '/minimal').then(
      function (minimal) {
        self._deliverFromMinimal(attempt, minimal, forcedStatus);
      },
      function () {
        // Could not confirm. Report a failure rather than silently stranding the
        // merchant, and flag that the status fetch itself failed.
        self._deliver(attempt, {
          order_id: self._order.uniqueTransactionId || '',
          payment_id: transactionId || '',
          signature: '',
          payment_status: forcedStatus || 'failed',
          amount: String(self._order.amount),
          currency: CURRENCY,
          fetchFailed: 'true',
          transactionMessage: fallbackMessage || 'Unable to confirm payment status',
        });
      }
    );
  };

  EnkashCustomCheckout.prototype._settleFailure = function (attempt, transactionId, message) {
    if (!this._isCurrent(attempt)) return;
    this._deliver(attempt, {
      order_id: this._order.uniqueTransactionId || '',
      payment_id: transactionId || '',
      signature: '',
      payment_status: 'failed',
      amount: String(this._order.amount),
      currency: CURRENCY,
      transactionMessage: message || 'Payment failed',
    });
  };

  EnkashCustomCheckout.prototype._deliverFromMinimal = function (attempt, minimal, forcedStatus) {
    if (!this._isCurrent(attempt)) return;

    var payload = {};

    // Pass through every field from the minimal response, stringified. This is
    // the same key set the hosted checkout puts on its redirect back to the
    // merchant, so an existing integration sees the fields it already knows.
    for (var key in minimal) {
      if (!Object.prototype.hasOwnProperty.call(minimal, key)) continue;
      var value = minimal[key];
      if (value == null) continue;
      if (typeof value === 'object') continue; // e.g. customParameters
      payload[key] = String(value);
    }

    // Canonical keys, aliased on top.
    payload.order_id = String(minimal.uniqueTransactionId || this._order.uniqueTransactionId || '');
    payload.payment_id = String(minimal.transactionId || '');
    payload.signature = String(minimal.checksum || '');
    payload.payment_status = forcedStatus || resolvePaymentStatus(minimal);
    payload.amount = String(minimal.finalAmount || minimal.amount || this._order.amount);
    payload.currency = String(minimal.currency || CURRENCY);
    if (minimal.paymentMode) payload.payment_mode = String(minimal.paymentMode);

    this._deliver(attempt, payload);
  };

  /**
   * The single delivery choke point. At most once per SDK instance.
   *
   * TODO(callback-url): this is the marked extension point for an alternative
   * server-to-server callback_url delivery mode. Only this function would need a
   * second branch; nothing upstream should learn about delivery modes.
   */
  EnkashCustomCheckout.prototype._deliver = function (attempt, payload) {
    if (this._destroyed) return;
    if (attempt) {
      if (this._attempt !== attempt || attempt.settled) return;
      attempt.settled = true;
    }
    if (this._delivered) return;
    this._delivered = true;

    this._poller.stopAll();
    this._popup.discard();
    if (this._upi && this._upi.countdown) this._upi.countdown.stop();

    try {
      this._handler(payload);
    } catch (e) {
      // A throwing merchant handler is their problem, not ours, but it must not
      // leave the SDK mid-teardown.
    }
  };

  /* =========================================================================
   * MODULE 16 — Guards
   * ========================================================================= */

  EnkashCustomCheckout.prototype._assertUsable = function () {
    if (this._destroyed) {
      throw SdkError(ErrorCode.ALREADY_DESTROYED, 'This checkout instance has been destroyed');
    }
  };

  EnkashCustomCheckout.prototype._assertReady = function () {
    this._assertUsable();
    if (!this._order) {
      throw SdkError(ErrorCode.NOT_INITIALISED, 'Call init() and await it before using this method');
    }
  };

  EnkashCustomCheckout.prototype._assertMethodEnabled = function (methodKey) {
    var order = this._order;
    var enabled;
    switch (methodKey) {
      case 'upi':
        enabled = order.upi === true;
        break;
      case 'netbanking':
        enabled = order.netBanking === true;
        break;
      case 'wallet':
        enabled = order.wallet === true;
        break;
      case 'card':
        enabled =
          order.creditCard === true ||
          order.debitCard === true ||
          order.prepaidCard === true ||
          order.corporateCard === true;
        break;
      default:
        enabled = false;
    }
    if (!enabled) {
      throw SdkError(ErrorCode.METHOD_NOT_ENABLED, methodKey + ' is not enabled for this order');
    }
  };

  /* ========================================================================= */

  EnkashCustomCheckout.ErrorCode = ErrorCode;
  EnkashCustomCheckout.version = '1.0.0-alpha.1';

  window.EnkashCustomCheckout = EnkashCustomCheckout;
})(window, document);
