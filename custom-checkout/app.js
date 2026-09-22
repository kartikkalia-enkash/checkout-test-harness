/**
 * Test merchant integration for the EnKash Custom Checkout SDK.
 *
 * This file is written the way a real merchant would write it: it only ever
 * touches window.EnkashCustomCheckout's public surface. Nothing here reaches
 * into SDK internals, so if something can't be done from this file, the SDK is
 * missing it.
 *
 * Every SDK call and every callback is mirrored into the on-page log, which is
 * the actual point of this harness.
 */
(function () {
  'use strict';

  var checkout = null;
  var config = null;
  var qrTimer = null;
  var selectedBank = null;
  var selectedWallet = null;
  var cardDebounce = null;
  var binResult = null;

  var $ = function (id) { return document.getElementById(id); };
  var money = new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', minimumFractionDigits: 2,
  });

  document.getElementById('sdkVersion').textContent =
    'SDK v' + (window.EnkashCustomCheckout ? window.EnkashCustomCheckout.version : 'not loaded');
  $('originNote').textContent = window.location.origin;

  /* ======================================================================
   * Logging
   * ==================================================================== */

  function log(kind, message, data) {
    var row = document.createElement('div');
    row.className = 'log-row log-' + kind;

    var ts = new Date();
    var stamp =
      String(ts.getHours()).padStart(2, '0') + ':' +
      String(ts.getMinutes()).padStart(2, '0') + ':' +
      String(ts.getSeconds()).padStart(2, '0') + '.' +
      String(ts.getMilliseconds()).padStart(3, '0');

    var tags = { call: 'CALL', ok: 'OK', err: 'ERROR', event: 'EVENT', result: 'RESULT' };

    row.innerHTML =
      '<span class="ts">' + stamp + '</span>' +
      '<span class="tag">' + (tags[kind] || kind) + '</span>' +
      '<span></span>';
    row.children[2].textContent = message;

    if (data !== undefined) {
      var pre = document.createElement('pre');
      try {
        pre.textContent = JSON.stringify(data, null, 2);
      } catch (e) {
        pre.textContent = String(data);
      }
      row.appendChild(pre);
    }

    var box = $('log');
    box.appendChild(row);
    if ($('autoscroll').checked) box.scrollTop = box.scrollHeight;
  }

  /** Wraps an SDK promise so the log shows the call and its resolution. */
  function call(label, fn) {
    log('call', label);
    var promise;
    try {
      promise = fn(); // invoked synchronously: preserves click user activation
    } catch (e) {
      log('err', label + ' threw ' + (e.code || '') + ': ' + e.message, e.detail);
      return Promise.reject(e);
    }
    return promise.then(
      function (value) {
        log('ok', label + ' resolved', value);
        return value;
      },
      function (error) {
        log('err', label + ' rejected [' + (error.code || 'UNKNOWN') + '] ' + error.message, error.detail);
        throw error;
      }
    );
  }

  $('clearLogBtn').addEventListener('click', function () { $('log').innerHTML = ''; });

  /* ======================================================================
   * Status / result panels
   * ==================================================================== */

  function showStatus(kind, html) {
    var box = $('statusBox');
    box.className = 'alert alert-' + kind;
    box.innerHTML = html;
  }

  function hideStatus() { $('statusBox').className = 'alert d-none'; }

  function renderResult(payload) {
    var variants = { success: 'text-bg-success', cancelled: 'text-bg-secondary', failed: 'text-bg-danger' };
    var badge = $('resultStatus');
    badge.className = 'badge fs-6 ' + (variants[payload.payment_status] || 'text-bg-danger');
    badge.textContent = payload.payment_status;

    $('resOrderId').textContent = payload.order_id || '(empty)';
    $('resPaymentId').textContent = payload.payment_id || '(empty)';
    $('resSignature').textContent = payload.signature
      ? payload.signature.slice(0, 24) + (payload.signature.length > 24 ? '…' : '')
      : '(EMPTY — treat as unverified)';

    $('resultJson').textContent = JSON.stringify(payload, null, 2);
    $('resultCard').classList.remove('d-none');
    $('resultCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function renderAmount(breakdown) {
    var rows = [
      ['Order amount', breakdown.amount],
      ['Surcharge', breakdown.surcharge],
      ['Convenience fee', breakdown.convenienceFee],
      ['GST', breakdown.gst],
    ];
    var html = '';
    rows.forEach(function (row) {
      if (row[0] !== 'Order amount' && !row[1]) return;
      html += '<tr><td class="text-secondary">' + row[0] + '</td>' +
              '<td class="text-end">' + money.format(row[1]) + '</td></tr>';
    });
    html += '<tr class="fw-semibold border-top"><td>Total payable</td>' +
            '<td class="text-end">' + money.format(breakdown.total) + '</td></tr>';
    $('amountTable').querySelector('tbody').innerHTML = html;
    $('amountCard').classList.remove('d-none');
  }

  /* ======================================================================
   * 1 — init
   * ==================================================================== */

  $('initBtn').addEventListener('click', function () {
    var orderId = $('orderIdInput').value.trim();
    $('initError').classList.add('d-none');

    if (!orderId) {
      $('initError').textContent = 'Enter an order id first.';
      $('initError').classList.remove('d-none');
      return;
    }

    teardown();

    try {
      checkout = new window.EnkashCustomCheckout({
        key: $('keyInput').value.trim(),
        order_id: orderId,
        environment: $('envSelect').value,

        // The single result channel. Fires exactly once, for every method, for
        // success and failure alike.
        handler: function (result) {
          log('result', 'handler() fired — payment_status=' + result.payment_status, result);
          hideStatus();
          renderResult(result);
          disablePayButtons(true);
          stopQrTimer();
        },

        // UI cue only. Deliberately says nothing about the outcome.
        onPopupClosed: function () {
          log('event', 'onPopupClosed() — tab gone. Still polling; this is not a result.');
          showStatus('warning',
            '<strong>Payment tab closed.</strong> Still confirming with the bank&hellip;');
        },
      });
      log('call', 'new EnkashCustomCheckout({ env: ' + $('envSelect').value + ', order_id: ' + orderId + ' })');
    } catch (e) {
      log('err', 'constructor threw [' + e.code + '] ' + e.message);
      $('initError').textContent = e.message;
      $('initError').classList.remove('d-none');
      return;
    }

    $('initBtn').disabled = true;

    call('init()', function () { return checkout.init(); })
      .then(function (cfg) {
        config = cfg;
        renderConfig(cfg);
        $('resetBtn').disabled = false;
        $('cancelBtn').disabled = false;
      })
      .catch(function (e) {
        $('initBtn').disabled = false;
        $('initError').innerHTML =
          '<strong>[' + (e.code || 'ERROR') + ']</strong> ' + e.message +
          (e.code === 'NETWORK'
            ? '<div class="mt-1">Most likely this origin is not CORS-allow-listed for the merchant yet.</div>'
            : '');
        $('initError').classList.remove('d-none');
      });
  });

  function renderConfig(cfg) {
    $('merchantName').textContent = cfg.merchant.name || '(no merchant name)';
    $('cfgOrderId').textContent = cfg.orderId;
    $('cfgAmount').textContent = money.format(cfg.amount);

    if (cfg.merchant.logoUrl) {
      $('merchantLogo').src = cfg.merchant.logoUrl;
      $('merchantLogo').classList.remove('d-none');
    }

    var badges = [];
    badges.push(badge(cfg.attemptsLeft ? 'success' : 'danger',
      cfg.attemptsLeft ? 'attempts left' : 'no attempts left'));
    badges.push(badge('light', 'pre-selection total ' + money.format(cfg.totalAmount)));
    if (cfg.methods.upi) {
      badges.push(badge('info', 'UPI qr=' + cfg.methods.upi.qr + ' intent=' + cfg.methods.upi.intent));
    }
    if (cfg.methods.card) {
      badges.push(badge('info', 'Card ' + cfg.methods.card.modes.join(', ')));
      badges.push(badge('light', 'schemes ' + (cfg.methods.card.schemes.join(', ') || 'any')));
    }
    if (cfg.methods.netbanking) {
      badges.push(badge('info', 'Netbanking ' + cfg.methods.netbanking.banks.length + ' banks'));
    }
    if (cfg.methods.wallet) {
      badges.push(badge('info', 'Wallet ' + cfg.methods.wallet.wallets.length));
    }
    $('methodBadges').innerHTML = badges.join(' ');
    $('summaryCard').classList.remove('d-none');

    renderContactCard(cfg);

    if (cfg.methods.upi) $('upiItem').classList.remove('d-none');
    if (cfg.methods.card) $('cardItem').classList.remove('d-none');
    if (cfg.methods.netbanking) {
      $('nbItem').classList.remove('d-none');
      renderBanks(cfg.methods.netbanking);
    }
    if (cfg.methods.wallet) {
      $('walletItem').classList.remove('d-none');
      renderWallets(cfg.methods.wallet.wallets);
    }
    $('methodsCard').classList.remove('d-none');
  }

  function badge(variant, text) {
    return '<span class="badge text-bg-' + variant + '">' + text + '</span>';
  }

  /* ======================================================================
   * 2b — Contact
   * ==================================================================== */

  function renderContactCard(cfg) {
    // Always shown, even when optional: the merchant may still want to collect
    // it, and the tester needs to see which mode the order is in.
    $('contactCard').classList.remove('d-none');

    var required = cfg.contact.required;
    var badgeEl = $('contactRequiredBadge');
    badgeEl.className = 'badge ms-2 ' + (required ? 'text-bg-warning' : 'text-bg-secondary');
    badgeEl.textContent = required ? 'required' : 'optional (skipContactInfo)';
    $('contactSkippableNote').classList.toggle('d-none', required);

    // The order can carry a phone to prefill with.
    if (cfg.customer.phone) {
      $('mobileInput').value = String(cfg.customer.phone).replace(/\D/g, '').slice(-10);
      log('event', 'prefilled mobile from config.customer.phone');
    }

    // Optional orders default to the inline route so the tester can go straight
    // to paying without touching this card.
    $('inlineContactSwitch').checked = !required;

    validateContactInputs();
  }

  function validateContactInputs() {
    if (!checkout) return false;

    var mobile = $('mobileInput').value.trim();
    var email = $('emailInput').value.trim();

    var mobileOk = checkout.validateMobile(mobile);
    var emailOk = checkout.validateEmail(email);

    $('mobileHint').innerHTML = !mobile
      ? '10 digits, starting 6&ndash;9.'
      : mobileOk
        ? '<span class="text-success">validateMobile() → true</span>'
        : '<span class="text-danger">validateMobile() → false</span>';

    $('emailHint').innerHTML = !email
      ? '&nbsp;'
      : emailOk
        ? '<span class="text-success">validateEmail() → true</span>'
        : '<span class="text-danger">validateEmail() → false</span>';

    var valid = mobileOk && emailOk;
    $('saveContactBtn').disabled = !valid;
    return valid;
  }

  $('mobileInput').addEventListener('input', function () {
    this.value = this.value.replace(/\D/g, '').slice(0, 10);
    validateContactInputs();
  });
  $('emailInput').addEventListener('input', validateContactInputs);

  $('saveContactBtn').addEventListener('click', function () {
    var payload = { mobile: $('mobileInput').value.trim() };
    var email = $('emailInput').value.trim();
    if (email) payload.email = email;

    call('submitContactDetails(' + JSON.stringify(payload) + ')', function () {
      return checkout.submitContactDetails(payload);
    }).then(function (saved) {
      $('contactSavedBadge').classList.remove('d-none');
      $('editContactBtn').classList.remove('d-none');
      $('contactResultBox').classList.remove('d-none');
      $('contactResultBox').innerHTML =
        '<div class="fw-semibold mb-1">Saved against the order</div>' +
        '<div>mobile <code>' + saved.mobile + '</code>' +
        ' · email <code>' + (saved.email || 'none') + '</code>' +
        ' · name <code>' + (saved.name || 'none') + '</code></div>' +
        (saved.address
          ? '<div>address ' + [saved.address.city, saved.address.state, saved.address.zipcode]
              .filter(Boolean).join(', ') + '</div>'
          : '');

      // Explicit route succeeded, so Pay must not resend it.
      $('inlineContactSwitch').checked = false;
      setContactFieldsDisabled(true);
    }).catch(function (e) {
      $('contactResultBox').className = 'alert alert-danger py-2 small mt-3 mb-0';
      $('contactResultBox').textContent = '[' + (e.code || 'ERROR') + '] ' + e.message;
      $('contactResultBox').classList.remove('d-none');
    });
  });

  $('editContactBtn').addEventListener('click', function () {
    // Re-submitting overwrites, which is how the hosted checkout's edit works.
    setContactFieldsDisabled(false);
    $('contactSavedBadge').classList.add('d-none');
    $('contactResultBox').classList.add('d-none');
    $('contactResultBox').className = 'alert alert-success py-2 small mt-3 mb-0 d-none';
    $('editContactBtn').classList.add('d-none');
    log('event', 'editing contact — submitContactDetails() again to overwrite');
    validateContactInputs();
  });

  function setContactFieldsDisabled(disabled) {
    $('mobileInput').disabled = disabled;
    $('emailInput').disabled = disabled;
    $('saveContactBtn').disabled = disabled;
  }

  /* ======================================================================
   * 2 — method selection (accordion)
   * ==================================================================== */

  Array.prototype.forEach.call(document.querySelectorAll('[data-method]'), function (button) {
    button.addEventListener('click', function () {
      // Only announce on open, not on collapse.
      if (button.getAttribute('aria-expanded') === 'true') return;
      var method = button.getAttribute('data-method');
      try {
        log('call', "selectMethod('" + method + "')");
        checkout.selectMethod(method);
        hideStatus();
        $('amountCard').classList.add('d-none');
        stopQrTimer();
        if (method === 'UPI') {
          log('event', 'CARD not selected — nothing prefetched');
        } else if (method === 'CARD') {
          log('event', 'Lyra 3DS script prefetch kicked off by selectMethod');
        }
        // UPI has no sub-option, so its amount is known immediately.
        if (method === 'UPI') refreshAmount('UPI');
      } catch (e) {
        log('err', "selectMethod threw [" + e.code + '] ' + e.message);
        showStatus('danger', e.message);
      }
    });
  });

  function refreshAmount(method, subCode) {
    return call('getAmountForMethod(' + method + (subCode ? ", '" + subCode + "'" : '') + ')',
      function () { return checkout.getAmountForMethod(method, subCode); })
      .then(renderAmount)
      .catch(function () {});
  }

  /* ======================================================================
   * 3 — UPI
   * ==================================================================== */

  Array.prototype.forEach.call(document.querySelectorAll('[data-upi-tab]'), function (tab) {
    tab.addEventListener('click', function () {
      document.querySelectorAll('[data-upi-tab]').forEach(function (t) { t.classList.remove('active'); });
      tab.classList.add('active');
      var which = tab.getAttribute('data-upi-tab');
      $('upiQrPane').classList.toggle('d-none', which !== 'qr');
      $('upiIntentPane').classList.toggle('d-none', which !== 'intent');
    });
  });

  $('loadQrBtn').addEventListener('click', function () {
    call('getUpiQr()', function () { return checkout.getUpiQr(); }).then(function (qr) {
      $('qrImage').src = qr.qrImageUrl;
      $('qrRef').textContent = qr.referenceId;
      $('qrString').textContent = qr.qrString || '(none returned)';
      $('qrWrap').classList.remove('d-none');
      startQrTimer(qr.expiresInSeconds);
      showStatus('info', '<strong>QR displayed.</strong> SDK is polling in the background.');
    }).catch(function () {});
  });

  function startQrTimer(seconds) {
    stopQrTimer();
    var left = seconds;
    var paint = function () {
      var m = Math.floor(left / 60), s = left % 60;
      $('qrCountdown').textContent = String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    };
    paint();
    qrTimer = setInterval(function () {
      left -= 1;
      if (left <= 0) {
        stopQrTimer();
        $('qrCountdown').textContent = 'expired';
        log('event', 'merchant-side QR countdown hit zero (SDK runs its own deadline too)');
        return;
      }
      paint();
    }, 1000);
  }

  function stopQrTimer() {
    if (qrTimer) clearInterval(qrTimer);
    qrTimer = null;
  }

  // "Pay" for QR. A documented no-op: polling already started at getUpiQr().
  $('payUpiQrBtn').addEventListener('click', function () {
    call("createPayment({method:'UPI', upi:{flow:'qr'}})", function () {
      return checkout.createPayment({ method: 'UPI', upi: { flow: 'qr' } });
    }).then(function (ack) {
      handleAck(ack);
    }).catch(function () {});
  });

  $('loadIntentBtn').addEventListener('click', function () {
    call('getUpiIntentLinks()', function () { return checkout.getUpiIntentLinks(); })
      .then(function (intent) {
        var host = $('intentApps');
        host.innerHTML = '';
        intent.apps.forEach(function (app) {
          var tile = document.createElement('button');
          tile.className = 'tile';
          tile.innerHTML = '<img alt="" src="' + app.iconUrl + '"><span>' + app.label + '</span>';
          tile.addEventListener('click', function () { payWithUpiApp(app); });
          host.appendChild(tile);
        });
        $('intentWrap').classList.remove('d-none');
        if (!intent.apps.length) {
          host.innerHTML = '<span class="text-secondary small">No intent apps returned.</span>';
        }
      }).catch(function () {});
  });

  function payWithUpiApp(app) {
    call("createPayment({method:'UPI', upi:{flow:'intent', app:'" + app.app + "'}})", function () {
      return checkout.createPayment({
        method: 'UPI',
        upi: { flow: 'intent', app: app.app },
        contact: readContact(),
      });
    }).then(function (ack) {
      handleAck(ack);
      if (ack.state === 'launch' && ack.link) {
        $('intentLink').href = ack.link;
        $('intentLink').textContent = ack.link;
        $('intentLinkBox').classList.remove('d-none');
      }
    }).catch(function () {});
  }

  /* ======================================================================
   * 4 — Card
   * ==================================================================== */

  function digits(value) { return String(value || '').replace(/\D/g, ''); }

  $('cardNumber').addEventListener('input', function () {
    var raw = digits(this.value);
    // Group in 4s for readability; the SDK strips separators itself.
    this.value = raw.replace(/(.{4})/g, '$1 ').trim();

    var network = checkout ? checkout.getCardNetwork(raw) : 'UNKNOWN';
    $('cardNetworkText').textContent = network;
    var logoUrl = checkout ? checkout.getCardNetworkLogoUrl(network) : null;
    if (logoUrl) {
      $('cardNetworkLogo').src = logoUrl;
      $('cardNetworkLogo').classList.remove('d-none');
    } else {
      $('cardNetworkLogo').classList.add('d-none');
    }

    var cvvLen = checkout ? checkout.getExpectedCvvLength(raw) : 3;
    $('cardCvv').maxLength = cvvLen;
    $('cardCvv').placeholder = cvvLen === 4 ? '1234' : '123';

    var luhn = checkout && raw.length >= 12 ? checkout.validateCardNumber(raw) : null;
    $('cardNumberHint').innerHTML = raw.length < 6
      ? 'Local network detection at 6 digits. <code>checkBin()</code> fires at 10.'
      : 'network=<code>' + network + '</code> · luhn=' +
        (luhn === null ? '<span class="text-secondary">n/a</span>'
          : luhn ? '<span class="text-success">valid</span>'
                 : '<span class="text-danger">invalid</span>');

    if (raw.length < 10) {
      binResult = null;
      $('binBox').classList.add('d-none');
      return;
    }

    if (cardDebounce) clearTimeout(cardDebounce);
    cardDebounce = setTimeout(function () { runBinCheck(raw); }, 150);
  });

  function runBinCheck(raw) {
    call('checkBin(' + raw.slice(0, 6) + '…)', function () { return checkout.checkBin(raw); })
      .then(function (bin) {
        binResult = bin;
        var box = $('binBox');
        box.className = 'alert py-2 small mt-3 mb-0 alert-' + (bin.supported ? 'success' : 'danger');
        box.innerHTML =
          '<div class="fw-semibold">' + (bin.supported ? 'Card accepted' : 'Card not accepted — ' + bin.unsupportedReason) + '</div>' +
          '<div>' + (bin.issuer.name || 'unknown issuer') + ' · ' + bin.network + ' · ' + bin.cardType +
          ' · mode <code>' + bin.paymentMode + '</code></div>';
        return refreshAmount('CARD');
      })
      .catch(function () {
        binResult = null;
        var box = $('binBox');
        box.className = 'alert py-2 small mt-3 mb-0 alert-warning';
        box.textContent = 'BIN lookup failed. Cards cannot be submitted without it.';
      });
  }

  $('cardExpiry').addEventListener('input', function () {
    var raw = digits(this.value).slice(0, 4);
    this.value = raw.length > 2 ? raw.slice(0, 2) + '/' + raw.slice(2) : raw;
  });

  $('payCardBtn').addEventListener('click', function () {
    // createPayment first, synchronously — the popup allowance dies on any await.
    call('createPayment({method:\'CARD\', …})', function () {
      return checkout.createPayment({
        method: 'CARD',
        card: {
          number: digits($('cardNumber').value),
          expiry: $('cardExpiry').value,
          cvv: $('cardCvv').value,
          holderName: $('cardName').value,
        },
        contact: readContact(),
      });
    }).then(handleAck).catch(function (e) {
      if (e.code === 'VALIDATION') showStatus('danger', '<strong>Validation:</strong> ' + e.message);
    });
  });

  /* ======================================================================
   * 5 — Netbanking
   * ==================================================================== */

  function renderBanks(nb) {
    var select = $('nbSelect');
    nb.banks.forEach(function (bank) {
      var option = document.createElement('option');
      option.value = bank.code;
      option.textContent = bank.name + '  (' + bank.code + ', ' + bank.accountType + ')';
      select.appendChild(option);
    });

    if (nb.topBanks.length) {
      var host = $('nbTopBanks');
      nb.topBanks.forEach(function (bank) {
        var tile = document.createElement('button');
        tile.className = 'tile';
        tile.setAttribute('data-code', bank.code);
        tile.innerHTML = '<img alt="" src="' + bank.logoUrl + '"><span>' + bank.name + '</span>';
        tile.addEventListener('click', function () {
          select.value = bank.code;
          select.dispatchEvent(new Event('change'));
        });
        host.appendChild(tile);
      });
      $('nbTopWrap').classList.remove('d-none');
    }
  }

  // Bound once, not inside renderBanks: re-initialising would otherwise stack
  // duplicate listeners on the same <select>.
  $('nbSelect').addEventListener('change', function () {
    selectedBank = this.value || null;
    document.querySelectorAll('#nbTopBanks .tile').forEach(function (t) {
      t.classList.toggle('active', t.getAttribute('data-code') === selectedBank);
    });
    $('payNbBtn').disabled = !selectedBank;
    if (selectedBank) refreshAmount('NETBANKING', selectedBank);
  });

  $('payNbBtn').addEventListener('click', function () {
    call("createPayment({method:'NETBANKING', bankCode:'" + selectedBank + "'})", function () {
      return checkout.createPayment({
        method: 'NETBANKING',
        bankCode: selectedBank,
        contact: readContact(),
      });
    }).then(handleAck).catch(function () {});
  });

  /* ======================================================================
   * 6 — Wallet
   * ==================================================================== */

  function renderWallets(wallets) {
    var host = $('walletList');
    wallets.forEach(function (wallet) {
      var tile = document.createElement('button');
      tile.className = 'tile';
      tile.setAttribute('data-code', wallet.code);
      tile.innerHTML = '<img alt="" src="' + wallet.logoUrl + '"><span>' + wallet.name + '</span>';
      tile.addEventListener('click', function () {
        selectedWallet = wallet.code;
        host.querySelectorAll('.tile').forEach(function (t) {
          t.classList.toggle('active', t === tile);
        });
        $('payWalletBtn').disabled = false;
        refreshAmount('WALLET', wallet.code);
      });
      host.appendChild(tile);
    });
    if (!wallets.length) {
      host.innerHTML = '<span class="text-secondary small">No wallets returned.</span>';
    }
  }

  $('payWalletBtn').addEventListener('click', function () {
    call("createPayment({method:'WALLET', walletCode:'" + selectedWallet + "'})", function () {
      return checkout.createPayment({
        method: 'WALLET',
        walletCode: selectedWallet,
        contact: readContact(),
      });
    }).then(handleAck).catch(function () {});
  });

  /* ======================================================================
   * Shared
   * ==================================================================== */

  /**
   * Contact is attached to createPayment() only when the tester has opted into
   * the inline route. Otherwise it has already been saved by
   * submitContactDetails() and must not be resent.
   */
  function readContact() {
    if (!$('inlineContactSwitch').checked) return undefined;
    var mobile = $('mobileInput').value.trim();
    if (!mobile) return undefined;
    var contact = { mobile: mobile };
    var email = $('emailInput').value.trim();
    if (email) contact.email = email;
    return contact;
  }

  /**
   * createPayment's ack says what UI to show. It is never a result — the
   * outcome only ever arrives via handler().
   */
  function handleAck(ack) {
    log('event', "createPayment ack state='" + ack.state + "'");

    if (ack.state === 'popup') {
      showStatus('info',
        '<strong>Bank tab opened.</strong> Polling every 5s for up to 5 minutes. ' +
        'Keep this tab open — it owns the outcome.');
    } else if (ack.state === 'polling') {
      showStatus('info', '<strong>Waiting for payment.</strong> SDK is polling.');
    } else if (ack.state === 'launch') {
      showStatus('warning',
        '<strong>Popup unavailable, link returned instead.</strong> ' +
        'Open it manually; polling is already running.');
    } else if (ack.state === 'challenge') {
      showStatus('info', '<strong>3-D Secure challenge running.</strong>');
    } else if (ack.state === 'settled') {
      log('event', 'settled — handler() has already fired');
    }
    return ack;
  }

  function disablePayButtons(disabled) {
    ['payCardBtn', 'payNbBtn', 'payWalletBtn', 'payUpiQrBtn'].forEach(function (id) {
      $(id).disabled = disabled;
    });
    document.querySelectorAll('#intentApps .tile').forEach(function (t) { t.disabled = disabled; });
  }

  $('cancelBtn').addEventListener('click', function () {
    call('cancel()', function () { return checkout.cancel('tester_cancelled'); }).catch(function () {});
  });

  $('resetBtn').addEventListener('click', function () {
    log('call', 'destroy()');
    teardown();
    log('event', 'reset — enter an order id and initialise again');
  });

  function teardown() {
    if (checkout) {
      try { checkout.destroy(); } catch (e) { /* already gone */ }
    }
    checkout = null;
    config = null;
    binResult = null;
    selectedBank = null;
    selectedWallet = null;
    stopQrTimer();

    ['summaryCard', 'contactCard', 'methodsCard', 'amountCard', 'resultCard',
     'upiItem', 'cardItem', 'nbItem', 'walletItem', 'qrWrap', 'intentWrap',
     'intentLinkBox', 'binBox', 'contactResultBox'].forEach(function (id) {
      $(id).classList.add('d-none');
    });
    hideStatus();

    $('nbSelect').innerHTML = '<option value="">Select a bank…</option>';
    $('nbTopBanks').innerHTML = '';
    $('walletList').innerHTML = '';
    $('intentApps').innerHTML = '';
    $('methodBadges').innerHTML = '';
    $('merchantLogo').classList.add('d-none');

    // Contact card back to a clean slate.
    setContactFieldsDisabled(false);
    $('mobileInput').value = '';
    $('emailInput').value = '';
    $('contactSavedBadge').classList.add('d-none');
    $('editContactBtn').classList.add('d-none');
    $('contactSkippableNote').classList.add('d-none');
    $('contactResultBox').className = 'alert alert-success py-2 small mt-3 mb-0 d-none';
    $('inlineContactSwitch').checked = false;
    $('saveContactBtn').disabled = true;
    $('initBtn').disabled = false;
    $('resetBtn').disabled = true;
    $('cancelBtn').disabled = true;
    disablePayButtons(false);
    $('payNbBtn').disabled = true;
    $('payWalletBtn').disabled = true;
  }

  log('event', 'harness ready — origin ' + window.location.origin);
})();
