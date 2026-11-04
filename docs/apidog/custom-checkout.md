# Custom Checkout

`EnkashCustomCheckout` is the browser SDK for a checkout UI you render yourself. The SDK calls EnKash, opens the bank window when a method needs one, and delivers one terminal outcome to `handler`.

Use it when your page draws the method list, QR, card form, banks, and wallets. It does not embed hosted checkout. The outcome is `handler`. The SDK does not redirect the browser to a callback URL.

Your server creates the order. Construct the SDK with that `order_id`.

Supported methods: UPI QR, UPI intent, new cards, netbanking, wallets.

Not supported: UPI VPA, saved or tokenised cards, PPI, and RuPay native OTP. `methods.upi.vpa` is always `false` when UPI is present. Do not render a VPA field. A RuPay native OTP response is cancelled by the SDK and then delivered as a failed `handler` payload. Do not build that OTP screen.

Currency is always `INR`.

## Prerequisites

Load `enkash-custom-checkout.js` so `window.EnkashCustomCheckout` exists.

`merchantAccessKey` is the key issued to your merchant account. It is required when you construct the SDK. Pass it at init. The SDK handles it after that.

`environment` is `prod` (default) or `uat`. The SDK calls one gateway for that environment:

| `environment` | Gateway |
| --- | --- |
| `prod` | `https://olympus-pg.enkash.in` |
| `uat` | `https://olympus-pg-uat.enkash.in` |

You do not call those hosts yourself.

EnKash allow-lists your site origin per merchant. Production and UAT origins are registered during onboarding. If every call fails in the browser with an opaque network error, the origin is not registered yet.

`EnkashCustomCheckout.version` is `1.0.0`.

## Integrate

<Steps>
  <Step title="Construct and init">
    `init()` is required before every other method. It resolves the public config. Render only the methods present on `config.methods`. A missing key means that method is disabled.

```html
<script src="enkash-custom-checkout.js"></script>
<script>
  var checkout = new EnkashCustomCheckout({
    merchantAccessKey: 'MERCHANT_ACCESS_KEY',
    order_id: 'ORD_FROM_YOUR_SERVER',
    environment: 'uat',
    handler: function (result) {
      if (result.payment_status === 'success') {
        confirmOnServer(result);
        return;
      }
      if (result.payment_status === 'cancelled') {
        showCancelled(result);
        return;
      }
      showFailure(result);
    },
    onPopupClosed: function () {
      // The bank tab closed. This is not success and not failure.
    }
  });

  checkout.init().then(function (config) {
    renderCheckout(config);
  });
</script>
```

  </Step>
  <Step title="Collect contact when the order requires it">
    Read `config.contact.required`. When it is `true`, save contact with `submitContactDetails` before pay, or pass `contact` on `createPayment`. Email is optional. Mobile is a 10-digit Indian number starting with 6–9. `validateMobile` and `validateEmail` are local checks. An empty email is valid.

```javascript
if (config.contact.required) {
  if (!checkout.validateMobile(mobile)) return showFieldError('mobile');
  if (!checkout.validateEmail(email)) return showFieldError('email');
  await checkout.submitContactDetails({ mobile: mobile, email: email });
}
```

    You can skip that `await` and pass `contact: { mobile: mobile, email: email }` inside `createPayment`. The SDK saves it before charging. Do not `await` anything between the Pay click and the `createPayment(...)` call.
  </Step>
  <Step title="Submit from the Pay click">
    Call `createPayment` synchronously inside the click listener. The promise tells you what to show next. The payment outcome still arrives only on `handler`.

```javascript
payButton.addEventListener('click', function () {
  checkout.createPayment(request).then(function (ack) {
    if (ack.state === 'launch' && ack.link) window.location.href = ack.link;
  }).catch(function (err) {
    if (err.code === 'VALIDATION') showFieldError(err.message);
  });
});
```

  </Step>
  <Step title="Confirm the payment on your server">
    `handler` is the signal that this checkout attempt finished. It is not authorisation to fulfil the order. Your server must confirm the transaction with EnKash, server to server, before you deliver anything. Details are under Confirm on your server.
  </Step>
</Steps>

`handler` runs at most once for the lifetime of the instance. After it runs, polling stops. `destroy()` does not call `handler`. Create a new instance for another order.

## Inputs

### Constructor

| Field | Required | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `order_id` | yes | string | | Server order id. |
| `merchantAccessKey` | yes | string | | Merchant access key. Required at init. |
| `handler` | yes | function | | Terminal outcome. One argument. At most once. |
| `environment` | no | `'prod' \| 'uat'` | `'prod'` | Gateway environment. `env` is accepted as the same field. |
| `onPopupClosed` | no | function | | Called with no arguments when the bank tab closes. Not an outcome. |

The constructor throws `EnkashCheckoutError` (`err.name === 'EnkashCheckoutError'`, `err.code`, `err.message`, optional `err.detail`) when `order_id`, `handler`, or `merchantAccessKey` is missing, or when `environment` is not recognised. `err.code` is `INVALID_OPTIONS`.

### `init()` config

`init()` returns a promise of this object. It is the only order data the SDK exposes.

| Field | Type | Meaning |
| --- | --- | --- |
| `orderId` | string | Order id. |
| `amount` | number | Order amount in INR. |
| `totalAmount` | number | Order total. |
| `currency` | string | Always `'INR'`. |
| `merchant.name` | string or `null` | Display name. |
| `merchant.logoUrl` | string or `null` | Absolute image URL, or `null`. |
| `merchant.themeColor` | string or `null` | Colour from the merchant profile, or `null`. |
| `customer.name` | string or `null` | |
| `customer.phone` | string or `null` | |
| `contact.required` | boolean | `true` unless this order skips contact. |
| `attemptsLeft` | boolean | `true` when another charge is allowed. |
| `methods.upi` | object, only if UPI is enabled | `{ qr: boolean, intent: boolean, vpa: false }`. |
| `methods.card` | object, only if any card mode is enabled | `{ modes: string[], schemes: string[] }`. |
| `methods.netbanking` | object, only if netbanking is enabled | `{ banks: Bank[], topBanks: Bank[] }`. |
| `methods.wallet` | object, only if wallets are enabled | `{ wallets: Wallet[] }`. |

`modes` contains any of `CREDIT_CARD`, `DEBIT_CARD`, `PREPAID_CARD`, `CORPORATE_CARD` that are enabled. `schemes` is a display list. Whether a typed card is accepted comes from `checkBin()`, not from this list.

`Bank` is `{ code, name, logoUrl, accountType }`. `Wallet` is `{ code, name, logoUrl }`. `logoUrl` is an absolute URL. Use it as an image `src`.

### Methods

| Method | Arguments | Returns |
| --- | --- | --- |
| `selectMethod(method)` | `'UPI'`, `'CARD'`, `'NETBANKING'`, or `'WALLET'` | `undefined`. Throws if the name is unknown or a blocking payment is in progress. Calling it again with the same method does nothing. Selecting `CARD` prepares 3-D Secure inside the SDK. |
| `getAmountForMethod(method, subCode)` | Method name. `subCode` is the bank code or wallet code. Ignored for cards. | Promise of `{ amount, surcharge, convenienceFee, gst, total, currency }`. |
| `validateCardNumber(cardNumber)` | PAN, spaces allowed | `true` or `false`. Luhn plus a network length check. Fewer than 12 digits is `false`. |
| `getCardNetwork(cardNumber)` | PAN | `'VISA'`, `'MASTERCARD'`, `'MAESTRO'`, `'RUPAY'`, `'AMEX'`, `'DINERS'`, `'DISCOVER'`, or `'UNKNOWN'`. From the first 6 digits, on the device. Below 6 digits returns `'UNKNOWN'`. |
| `getCardNetworkLogoUrl(network)` | Network string | Absolute URL, or `null` when this SDK has no mark (`DISCOVER`, `UNKNOWN`, or any other name). Maestro uses the Mastercard mark. |
| `getExpectedCvvLength(cardNumber)` | PAN | `4` for Amex, otherwise `3`. |
| `checkBin(cardNumber)` | At least 10 digits. The full typed value is sent | Promise of the BIN object below. |
| `getUpiQr()` | none | Promise of `{ qrImageUrl, qrString, expiresInSeconds, referenceId }`. Starts polling. |
| `getUpiIntentLinks()` | none | Promise of `{ referenceId, apps }`. Does not start polling and does not create the payment. |
| `validateMobile(mobile)` | string | `true` when the digits match `^[6-9]\d{9}$`. |
| `validateEmail(email)` | string | `true` when empty, or when the trimmed value matches `^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,4}$`. |
| `submitContactDetails(contact)` | `{ mobile: string, email?: string }` | Promise of `{ mobile, email, name, address, required }`. |
| `createPayment(request)` | See the method sections | Promise of `{ state }`, plus `link` when `state` is `'launch'`. |
| `cancel(reason)` | string, optional | Promise. `reason` defaults to `'customer_cancelled'`. Ends in `handler` with a cancelled status even if the cancel request fails. |
| `destroy()` | none | `undefined`. Stops polling and closes a popup. Does not call `handler`. |

`submitContactDetails` may be called more than once before a payment is in progress. A later call overwrites contact. It rejects while a blocking payment is in progress.

`address` on the contact result is `null` or `{ streetName, city, state, country, zipcode }`. Each value is a string or `null`. `name` is a string or `null`. `email` is a string or `null`. `required` matches `contact.required`.

`checkBin` result:

| Field | Meaning |
| --- | --- |
| `bin` | First 6 digits. |
| `network` | Scheme from EnKash, uppercased, or `'UNKNOWN'`. |
| `cardType` | Card type from EnKash. |
| `paymentMode` | `'CREDIT_CARD'`, `'DEBIT_CARD'`, `'PREPAID_CARD'`, `'CORPORATE_CARD'`, or `null`. |
| `issuer.name` | Bank name, or `null`. |
| `issuer.entityName` | Bank entity name, or `null`. |
| `supported` | `true` only when the mode is enabled and the scheme is allowed for that mode. |
| `unsupportedReason` | `null`, `'MODE_DISABLED'`, or `'SCHEME_NOT_ALLOWED'`. |

The lookup is cached on the first 10 digits. Call it when the customer has typed 10 digits, not at 6. `getCardNetwork` is only the logo helper. Do not use one call in place of the other.

Until `checkBin` has resolved, `getAmountForMethod('CARD')` returns surcharge `0`, convenience fee `0`, and `total === amount`. After it resolves, call `getAmountForMethod('CARD')` again and display `total`. For netbanking and wallets, pass the selected code as `subCode`. Fees are rupee amounts. `gst` is `(surcharge + convenienceFee) * gstRate / 100`. The SDK does not round. Format for display yourself. Do not send these numbers back on `createPayment`. EnKash computes them again.

`getUpiIntentLinks().apps[]` is `{ app, label, link, iconUrl }` for each of `phonepe`, `gpay`, `paytm`, and `upi` that was returned. Labels are PhonePe, Google Pay, Paytm, and Other UPI.

`qrImageUrl` is a `data:image/png;base64,` URL. `qrString` is the UPI intent string, or `null`. `expiresInSeconds` is the order UPI timeout in seconds, or 300 when the order does not set one.

## Payment methods

Call `selectMethod` before the method-specific calls below. `createPayment` must be the synchronous call from the customer's click. Any `await` in your code before that call drops the browser user activation, and the bank window is blocked.

<Tabs>
  <Tab title="UPI QR">
    `getUpiQr` creates the QR transaction and starts polling immediately. The outcome is `handler`, including expiry. `createPayment` on the Pay click does not create a second transaction.

```javascript
checkout.selectMethod('UPI');
var qr = await checkout.getUpiQr();
showImage(qr.qrImageUrl);
startCountdown(qr.expiresInSeconds);

payButton.addEventListener('click', function () {
  checkout.createPayment({ method: 'UPI', upi: { flow: 'qr' } }).then(function (ack) {
    // ack.state === 'polling'
  });
});
```

    `createPayment` resolves `{ state: 'polling' }`. If `getUpiQr` was not called first, it rejects with `VALIDATION` and the message `No active UPI QR. Call getUpiQr() before createPayment().`
  </Tab>
  <Tab title="UPI Intent">
    `getUpiIntentLinks` only fetches links. Polling starts inside `createPayment` after the customer picks an app. Navigate to `ack.link` after the promise resolves. That wait is after `createPayment`, which is allowed. Do not `await` before the `createPayment` call.

```javascript
checkout.selectMethod('UPI');
var intent = await checkout.getUpiIntentLinks();

function onAppClick(app) {
  checkout.createPayment({
    method: 'UPI',
    upi: { flow: 'intent', app: app },
    contact: { mobile: mobile }
  }).then(function (ack) {
    if (ack.state === 'launch' && ack.link) window.location.href = ack.link;
  });
}
```

    `app` is `phonepe`, `gpay`, `paytm`, or `upi`. Any other value rejects with `VALIDATION`. If `getUpiIntentLinks` was not called first, `createPayment` rejects with `VALIDATION` and `No UPI intent reference. Call getUpiIntentLinks() before createPayment().`

    Resolved value: `{ state: 'launch', link }`. `link` is that app's URL from the last `getUpiIntentLinks()` result, or `null` when that app had no URL.
  </Tab>
  <Tab title="Card">
    Draw the logo with `getCardNetwork` while the customer types. At 10 digits, call `checkBin` and then `getAmountForMethod('CARD')`. If `supported` is `false`, do not call `createPayment`.

    On the Pay click, pass the card and call `createPayment` immediately. Expiry is `MM/YY` or `MMYY`, and must not be in the past. Holder name is required. CVV length must match `getExpectedCvvLength`. The number must pass `validateCardNumber`. `checkBin` must already have resolved, or `createPayment` rejects with `VALIDATION` and `Call checkBin() and wait for it to resolve before submitting a card`.

```javascript
checkout.selectMethod('CARD');

numberInput.addEventListener('input', function () {
  showLogo(checkout.getCardNetworkLogoUrl(checkout.getCardNetwork(numberInput.value)));
  if (digits(numberInput.value).length === 10) {
    checkout.checkBin(numberInput.value).then(function (bin) {
      if (!bin.supported) {
        showFieldError(bin.unsupportedReason);
        return null;
      }
      return checkout.getAmountForMethod('CARD');
    }).then(function (fees) {
      if (fees) showTotal(fees.total);
    });
  }
});

payButton.addEventListener('click', function () {
  checkout.createPayment({
    method: 'CARD',
    card: {
      number: numberInput.value,
      expiry: expiryInput.value,
      cvv: cvvInput.value,
      holderName: nameInput.value
    },
    contact: { mobile: mobileInput.value }
  }).then(function (ack) {
    if (ack.state === 'launch' && ack.link) window.location.href = ack.link;
  }).catch(function (err) {
    if (err.code === 'VALIDATION') showFieldError(err.message);
  });
});
```

    Do not load a 3-D Secure script. The SDK does that when the charge needs it. `state: 'challenge'` means the challenge is on the page. `state: 'popup'` means the SDK opened the bank tab. `state: 'settled'` means `handler` is already being called. `state: 'launch'` means the window was blocked or never opened. Send the customer to `ack.link`.
  </Tab>
  <Tab title="Netbanking">
    Render `config.methods.netbanking.banks` and `topBanks`. Show the amount for the selected bank, then pay with that bank's `code`.

```javascript
checkout.selectMethod('NETBANKING');
var fees = await checkout.getAmountForMethod('NETBANKING', bankCode);
showTotal(fees.total);

payButton.addEventListener('click', function () {
  checkout.createPayment({
    method: 'NETBANKING',
    bankCode: bankCode,
    contact: { mobile: mobile }
  }).then(function (ack) {
    if (ack.state === 'launch' && ack.link) window.location.href = ack.link;
  });
});
```

    A missing `bankCode` rejects with `VALIDATION`.
  </Tab>
  <Tab title="Wallet">
    Render `config.methods.wallet.wallets`. The field on `createPayment` is `walletCode`.

```javascript
checkout.selectMethod('WALLET');
var fees = await checkout.getAmountForMethod('WALLET', walletCode);
showTotal(fees.total);

payButton.addEventListener('click', function () {
  checkout.createPayment({
    method: 'WALLET',
    walletCode: walletCode,
    contact: { mobile: mobile }
  }).then(function (ack) {
    if (ack.state === 'launch' && ack.link) window.location.href = ack.link;
  });
});
```

    A missing `walletCode` rejects with `VALIDATION`.
  </Tab>
</Tabs>

### `createPayment` state

| `state` | When | What you do |
| --- | --- | --- |
| `'polling'` | UPI QR Pay click, after `getUpiQr` | Keep showing the QR. Wait for `handler`. |
| `'launch'` | UPI intent, or a bank redirect whose window was blocked or never opened | Navigate to `link`. Wait for `handler`. |
| `'popup'` | The SDK opened the bank tab | Leave the tab to the SDK. Wait for `handler`. |
| `'challenge'` | In-page 3-D Secure | Leave the challenge to the SDK. Wait for `handler`. |
| `'settled'` | Authorised with no redirect, an error object from EnKash, missing redirect data, or unsupported RuPay OTP | Wait for `handler`. It is already in progress. |

UPI `flow` must be `'qr'` or `'intent'`. Any other `method` rejects with `VALIDATION` and `Unsupported method "…"`.

Result codes `156` and `158` reject the promise with `VALIDATION`, set `err.detail.resultCode`, and do not call `handler`. The customer can correct the form and press Pay again.

A bank window that has not reached a terminal status after 5 minutes is cancelled by the SDK. `handler` then runs with the status EnKash reports after that cancel. UPI QR and UPI intent use their own countdown (`expiresInSeconds`, default 300). When it finishes, the SDK expires that UPI transaction and `handler` runs with the status EnKash reports. An in-page 3-D Secure poll that is still unfinished after 5 minutes also ends in `handler`.

## Outputs

`handler(payload)` is the only terminal outcome. `onPopupClosed()` has no arguments and can run before `handler`. A closed bank tab is not success. EnKash closes that tab on the successful path too. Do not decide the payment from it.

Do not redirect the browser to a callback URL. `ack.link` is the bank or UPI step, not your site. If `returnUrl` or `return_url` is on the handler payload, it was copied from the status response. It is not required, and a payload without it is valid.

After a confirmed status fetch, `handler` receives:

- Every scalar field from the status object, copied as strings. Nested objects are omitted.
- Then these fields, also strings, overwriting the same names if they were already copied:

| Field | Source |
| --- | --- |
| `order_id` | Order id |
| `payment_id` | Transaction id |
| `signature` | Checksum, or `''` |
| `payment_status` | `success`, `cancelled`, or `failed` |
| `amount` | Final amount, otherwise amount |
| `currency` | `'INR'` unless the status object has another currency |
| `payment_mode` | Present only when the status object has a payment mode |

`payment_status`:

| Status from EnKash | `payment_status` |
| --- | --- |
| `SUCCESS`, `PAID`, `CAPTURED`, `AUTHORIZED` | `success` |
| `CANCELLED` | `cancelled` |
| Anything else, including pending and expired | `failed` |

`cancel()` sets `payment_status` to `cancelled` even when the cancel request itself fails.

When the status fetch fails, `handler` receives this object instead:

| Field | Value |
| --- | --- |
| `order_id` | Order id, or `''` |
| `payment_id` | Transaction id, or `''` |
| `signature` | `''` |
| `payment_status` | `failed`, or `cancelled` when this came from `cancel()` |
| `amount` | Order amount, as a string |
| `currency` | `'INR'` |
| `fetchFailed` | `'true'` |
| `transactionMessage` | The failure text, or `Unable to confirm payment status` |

```javascript
handler: function (result) {
  if (result.fetchFailed === 'true') {
    showFailure(result.transactionMessage);
    return;
  }
  if (result.payment_status === 'success') {
    confirmOnServer(result);
    return;
  }
  showFailure(result.payment_status, result.transactionMessage);
}
```

Success on the page is `payment_status === 'success'`. A customer cancel from `cancel()` is `payment_status === 'cancelled'`. A declined, expired, or unconfirmed payment is `payment_status === 'failed'`.

A rejected promise is not a second outcome. It means the attempt did not start, or the form was rejected (`156` or `158`). `handler` has not run for that rejection, except where `state: 'settled'` already started delivery.

## Confirm on your server

Do not fulfil an order because `handler` reported `success`, and do not treat `signature` on the browser payload as the confirmation.

Send `order_id`, `payment_id`, and `amount` to your server. Your server confirms that transaction with EnKash using a server-to-server call, and checks that the order id and amount match the order you created. Ship, credit, or mark the order paid only after that call succeeds.

`onPopupClosed`, a rejected `createPayment`, and `destroy()` are not transactions to confirm.

## Constraints

Call `createPayment` directly inside the Pay click handler. Do not `await` a fee refresh, a contact save, or `checkBin` between the click and `createPayment(...)`. The bank window is opened at the start of `createPayment`. The browser drops that permission at the first `await`. UPI intent may set `window.location.href = ack.link` in the `.then` after `createPayment` returns. That navigation is not the bank window.

Do not treat `onPopupClosed`, the window closing, or the bank page unloading as the payment result. Status polling inside the SDK is the source of truth. The tab closes both when the customer gives up and when the bank page closes itself after success.

`getCardNetwork` (6 digits, for a logo) and `checkBin` (10 digits, for acceptance and fees) are different calls. Keep both. Do not charge a card before `checkBin` resolves. Do not charge a card when `supported` is `false`.

`handler` runs at most once per instance. `destroy()` does not call it. Do not wait for a second callback. UPI VPA, saved cards, tokenised cards, PPI, and RuPay native OTP are not supported.

## Errors

Thrown errors use `err.code` from `EnkashCustomCheckout.ErrorCode`.

| `code` | When it is thrown | What you should do |
| --- | --- | --- |
| `INVALID_OPTIONS` | Constructor: missing `order_id`, `handler`, or `merchantAccessKey`, or an unknown `environment` | Fix the constructor arguments. |
| `NOT_INITIALISED` | A method other than `init` ran before `init` resolved | Await `checkout.init()` first. |
| `ALREADY_DESTROYED` | Any call after `destroy()` | Construct a new instance. |
| `NETWORK` | The browser request failed | Show a retry. If every request fails, this origin is not allow-listed yet. |
| `GATEWAY` | A response the SDK cannot use, such as a QR payload missing `qrCode` or `ekPayId` | Show the error message. Do not invent a result locally. |
| `ORDER_NOT_PAYABLE` | No attempts left, or the order status is `EXPIRED`, `CANCELLED`, or `PAID`. `err.detail` has `orderStatus` and `paymentAttemptLeft` | Stop the form. `handler` is not called for this rejection. |
| `METHOD_NOT_ENABLED` | UPI, card, netbanking, or wallet is not enabled on this order | Hide that method. It was absent from `config.methods`. |
| `ATTEMPT_IN_PROGRESS` | `selectMethod`, a contact update, or a second `createPayment` while a committed payment is in progress | Wait for `handler`. A QR on screen does not block switching methods until the customer presses Pay. |
| `VALIDATION` | Bad contact, card, bank, wallet, UPI flow, or result code `156` / `158` | Show `err.message` on the form. For `156` and `158`, `handler` does not run and the customer may submit again. |
| `LYRA_UNAVAILABLE` | Used inside the 3-D Secure loader. `createPayment` does not reject with this code | If the 3-D Secure module cannot be loaded during a challenge, `handler` runs with `payment_status` `failed` and `transactionMessage` `Unable to load the 3-D Secure module. Please try again.` |

`METHOD_NOT_SELECTED`, `UNSUPPORTED`, and `MISSING_REDIRECT_URL` exist on `EnkashCustomCheckout.ErrorCode`. Current methods do not throw them.

`selectMethod` with a name outside `UPI`, `CARD`, `NETBANKING`, and `WALLET` throws `VALIDATION`.
