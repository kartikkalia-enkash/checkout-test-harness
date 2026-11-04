# Standard Checkout

`EnkashCheckout` opens EnKash hosted checkout as an overlay on your page. EnKash renders the payment UI. Your page receives the result in `handler`.

This SDK does not create orders, render a Pay button, or redirect the browser. Your server creates the order and keeps its `order_id`.

A cancel made inside checkout is delivered to `handler`. `modal.ondismiss` is not a payment result.

## Prerequisites

Load the script for the same environment as the order. Production is the default when you omit `env`.

| Environment | Checkout host | Script |
| --- | --- | --- |
| `prod` (default) | `https://checkoutv3.enkash.com` | `https://checkoutv3.enkash.com/assets/sdk/enkash-checkout-sdk.js` |
| `uat` | `https://checkout-uat-v3.enkash.in` | `https://checkout-uat-v3.enkash.in/assets/sdk/enkash-checkout-sdk.js` |

You do not build the checkout URL. The SDK opens it.

## Integrate

<Steps>
  <Step title="Load the script">

```html
<script src="https://checkout-uat-v3.enkash.in/assets/sdk/enkash-checkout-sdk.js"></script>
```

  </Step>
  <Step title="Open checkout from your Pay button">
    Pass `order_id`, `merchantAccessKey`, and `handler`, then call `open()`. `merchantAccessKey` is the key issued to your merchant account. It is required at init. The SDK handles it after that.

```html
<button id="pay" type="button">Pay</button>
<script src="https://checkout-uat-v3.enkash.in/assets/sdk/enkash-checkout-sdk.js"></script>
<script>
  document.getElementById('pay').addEventListener('click', function () {
    var checkout = new EnkashCheckout({
      order_id: 'ORD_FROM_YOUR_SERVER',
      merchantAccessKey: 'MERCHANT_ACCESS_KEY',
      env: 'uat',
      handler: function (response) {
        if (response && response.status === 'FAILED' && response.reason === 'checkout_unavailable') {
          enablePayButton();
          return;
        }
        enablePayButton();
        confirmOnServer(response);
      },
      modal: {
        ondismiss: function () {
          enablePayButton();
        },
        escape: true,
        backdropclose: false
      }
    });
    checkout.open();
  });
</script>
```

  </Step>
  <Step title="Confirm the payment on your server">
    `handler` tells your page that checkout finished. It is not authorisation to fulfil the order. Before you ship, credit a wallet, or mark the order paid, your server must confirm that transaction with EnKash using a server-to-server call. Match the confirmed amount and order id to the order you created. The next section describes the objects `handler` can receive. Fulfilment waits on your server confirmation, not on the browser callback.
  </Step>
</Steps>

`open()` and `close()` return `undefined`. They are not promises.

## Inputs

`new EnkashCheckout(options)` reads `options` once. If you set `window.EnkashCheckoutConfig`, set it before `new EnkashCheckout`. It is read at construction, not when the script loads.

| Field | Required | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `order_id` | yes | string | | Order id from your server. |
| `merchantAccessKey` | yes | string | | Merchant access key. Required when you create the checkout. |
| `handler` | yes | function | | Called with one argument, the outcome object. |
| `env` | no | `'uat' \| 'prod'` | `'prod'` | Checkout environment. `environment` is accepted as the same field. |
| `base_url` | no | string | | Absolute `http:` or `https:` checkout origin. Trailing slashes are removed. Overrides `env`. |
| `modal.ondismiss` | no | function | | Called with no arguments when the customer closes the overlay. |
| `modal.escape` | no | boolean | `true` | Escape closes the overlay when this is not `false`. |
| `modal.backdropclose` | no | boolean | `false` | A backdrop click closes the overlay only when this is `true`. |

`window.EnkashCheckoutConfig` accepts `base_url`, `env`, and `environment`.

Checkout host, in order:

1. `options.base_url`
2. `options.env` or `options.environment`
3. `window.EnkashCheckoutConfig.base_url`
4. `window.EnkashCheckoutConfig.env` or `environment`
5. `prod` (`https://checkoutv3.enkash.com`)

| Method | Behavior |
| --- | --- |
| `open()` | Opens the overlay. A second `open()` while this instance is open does nothing. |
| `close()` | Removes the overlay. Does not call `handler` or `modal.ondismiss`. |

The SDK owns checkout messages. Do not add your own `message` listener to detect success, failure, or cancel.

## Outputs

Only `handler` is a payment outcome.

| Channel | When it runs | Argument |
| --- | --- | --- |
| `handler(payload)` | Checkout returns a result, or checkout never becomes ready | One object |
| `modal.ondismiss()` | Escape (unless `modal.escape === false`), a backdrop click when `modal.backdropclose` is `true`, or checkout asks to close | none |

`handler` receives one of these:

| Case | Object |
| --- | --- |
| Checkout did not become ready within 15 seconds, or opening the overlay threw | `{ status: 'FAILED', reason: 'checkout_unavailable' }` |
| Any checkout result, including a cancel inside checkout | The checkout result, unchanged. No fields are added or renamed. |

Do not redirect the browser to a callback URL. If the result includes `returnUrl` or `return_url`, that field came from checkout. It is not required, and a result without it is valid.

```javascript
handler: function (response) {
  if (response && response.status === 'FAILED' && response.reason === 'checkout_unavailable') {
    enablePayButton();
    showMessage('Checkout could not be opened. Try again.');
    return;
  }
  enablePayButton();
  confirmOnServer(response);
}
```

`checkout_unavailable` means no payment was attempted. Do not record it as a captured or failed charge.

A cancel inside checkout arrives on `handler`, not on `ondismiss`. Read the status on that object. `ondismiss` means the customer left the overlay without a checkout result.

```javascript
modal: {
  ondismiss: function () {
    enablePayButton();
  }
}
```

`close()` removes the overlay and runs neither callback.

## Confirm on your server

Do not fulfil an order from `handler` alone. The page can be left open, and the payload can be altered on the client.

Send the result to your server. Your server confirms the transaction with EnKash, server to server, and checks that the order id and amount match the order you created. Deliver the goods or service only after that confirmation succeeds.

`ondismiss` and `checkout_unavailable` are not transactions to confirm.

## Errors

| Condition | What happens | What your page should do |
| --- | --- | --- |
| Missing `order_id` | Throws `EnkashCheckout: order_id is required` | Do not call `open()`. |
| Missing `merchantAccessKey` | Throws `EnkashCheckout: merchantAccessKey is required` | Pass the key issued to your account. |
| `handler` missing or not a function | Throws `EnkashCheckout: handler function is required` | Pass a function. |
| Unknown `env` | Throws `EnkashCheckout: unknown env "…"`. Expected `prod`, `uat`, or `local` | Pass `uat` or `prod`, or a `base_url`. |
| `base_url` is not an absolute `http(s)` URL | Throws `EnkashCheckout: base_url is not a valid URL` or `base_url must be an absolute http(s) URL` | Pass a full URL, or omit it and use `env`. |
| Checkout never becomes ready, or the overlay cannot be built | `handler` receives `{ status: 'FAILED', reason: 'checkout_unavailable' }`. The overlay is removed first | Let the customer start again. |

`local` is an internal environment. Integrations use `uat` or `prod`.

A second `open()` on an instance that is already open is ignored. Create a new `EnkashCheckout` for another attempt, or call `close()` first.
