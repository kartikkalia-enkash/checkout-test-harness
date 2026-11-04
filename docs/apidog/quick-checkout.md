# Quick Checkout

Quick Checkout places a Pay with EnKash button on your page. You do not style the button. Your server creates the order. The payment result is delivered to `handler`. The SDK does not redirect the browser to a callback URL.

## Prerequisites

Put the order id and your merchant access key on the marker, then load `checkout-quick.js` from the checkout host that matches the order.

| Environment | Script |
| --- | --- |
| `prod` | `https://checkoutv3.enkash.com/checkout-quick.js` |
| `uat` | `https://checkout-uat-v3.enkash.in/checkout-quick.js` |

When the script is loaded from `https://checkoutv3.enkash.com` or `https://checkout-uat-v3.enkash.in`, the environment follows that host. `data-env` and `data-base-url` are for serving the file from somewhere else.

## Integrate

<Steps>
  <Step title="Add one marker per order">
    The marker is `id="enkash-quick-checkout"` or `class="enkash-quick-checkout"`. The script appends the button. It does not replace anything you put inside the element.

```html
<div id="enkash-quick-checkout"
     data-order_id="ORD_FROM_YOUR_SERVER"
     data-merchant-access-key="MERCHANT_ACCESS_KEY"></div>
```

    `data-merchant-access-key` is the key issued to your merchant account. It is required on the marker, or on the script tag. The marker value wins. The SDK handles the key after that.
  </Step>
  <Step title="Load the script">
    One script tag covers every marker. Place it after the markers, or anywhere on the page. If the document is still loading, setup waits for `DOMContentLoaded`.

```html
<div id="enkash-quick-checkout"
     data-order_id="ORD_FROM_YOUR_SERVER"
     data-merchant-access-key="MERCHANT_ACCESS_KEY"></div>
<script src="https://checkout-uat-v3.enkash.in/checkout-quick.js"></script>
```

  </Step>
  <Step title="Handle the result">
    Set `window.EnkashQuickCheckout.handler` before the customer pays. It is called with the checkout result. Do not redirect the browser to a callback URL. See Outputs.

```html
<script>
  window.EnkashQuickCheckout = {
    handler: function (response) {
      if (response && response.status === 'FAILED' && response.reason === 'checkout_unavailable') {
        showMessage('Checkout could not be opened. Try again.');
        return;
      }
      confirmOnServer(response);
    }
  };
</script>
<div id="enkash-quick-checkout"
     data-order_id="ORD_FROM_YOUR_SERVER"
     data-merchant-access-key="MERCHANT_ACCESS_KEY"></div>
<script src="https://checkout-uat-v3.enkash.in/checkout-quick.js"></script>
```

  </Step>
</Steps>

Several orders on one page use the class, not the id:

```html
<div class="enkash-quick-checkout" data-order_id="ORD_ONE" data-merchant-access-key="MERCHANT_ACCESS_KEY"></div>
<div class="enkash-quick-checkout" data-order_id="ORD_TWO" data-merchant-access-key="MERCHANT_ACCESS_KEY"></div>
<script src="https://checkoutv3.enkash.com/checkout-quick.js"></script>
```

A marker is set up once. A later run of the script skips an element whose `data-enkash-initialized` is already `"true"`. Do not set that attribute yourself.

## Inputs

| Input | Where | Required | Meaning |
| --- | --- | --- | --- |
| `id="enkash-quick-checkout"` | element | one marker form | A single button. |
| `class="enkash-quick-checkout"` | element | one marker form | One element per order when the page has more than one. |
| `data-order_id` | element | yes | Order id from your server. |
| `data-merchant-access-key` | element, or the script tag | yes | Merchant access key. Required at init. |
| `data-base-url` | script tag | no | Absolute checkout URL. Wins over `data-env`. |
| `data-env` | script tag | no | `uat` or `prod`. |
| `data-sdk-src` | script tag | no | Full URL of the checkout script when it is not loaded from the checkout host. |

Environment, in order:

1. `data-base-url`
2. `data-env`
3. The script origin, when it is `https://checkout-uat-v3.enkash.in` or `https://checkoutv3.enkash.com`
4. Otherwise production, or `window.EnkashCheckoutConfig` if that object is already set

The button always allows Escape and does not close when the backdrop is clicked. Those are not options. The label is `Pay with EnKash`. While checkout is opening, the button is disabled and reads `Opening checkout…`.

## Outputs

`handler` is the only payment outcome. It receives the checkout result unchanged.

| What happened | What your page receives |
| --- | --- |
| Checkout returns a result, including a cancel inside checkout | `handler(payload)` with that result |
| Checkout never becomes ready, the checkout script fails to load, or checkout cannot be constructed | `handler({ status: 'FAILED', reason: 'checkout_unavailable' })` when a handler is set |
| The customer presses Escape | `handler` is not called. The button is enabled again |

`checkout_unavailable` means no payment was attempted.

`returnUrl` or `return_url` may be present on the result when checkout included them. They are not required. Do not redirect the browser to them. A result without either field is valid.

After `handler` runs, the button is enabled again.

## Confirm on your server

Do not fulfil an order from `handler` alone. Send the result to your server. Your server confirms the transaction with EnKash, server to server, and checks that the order id and amount match the order you created. Fulfil the order only after that confirmation succeeds.

Escape and `checkout_unavailable` are not transactions to confirm.

## Errors

| Condition | What you see | What to do |
| --- | --- | --- |
| Marker without `data-order_id` | `[EnKash Quick Checkout] Element is missing required data-order_id.` No button | Set `data-order_id`. |
| Marker without `data-merchant-access-key` | `[EnKash Quick Checkout] Element is missing required data-merchant-access-key.` No button | Set the key on the marker or the script tag. |
| Checkout script failed to load | `[EnKash Quick Checkout] Failed to load checkout-sdk.js from …` | Load `checkout-quick.js` from the checkout host, or set `data-sdk-src`. |
| Script loaded but checkout is missing | `[EnKash Quick Checkout] checkout-sdk.js loaded but EnkashCheckout is not defined.` | Point `data-sdk-src` at the EnKash checkout script. |
| Unknown `data-env` or a bad `data-base-url` | `[EnKash Quick Checkout] Failed to initialize checkout.` then `handler` receives `checkout_unavailable` | Use `uat` or `prod`, or an absolute `http(s)` `data-base-url`. |
| `handler` is missing | `[EnKash Quick Checkout] handler is required. Set window.EnkashQuickCheckout = { handler: function (response) {} }.` | Set `window.EnkashQuickCheckout.handler` before the customer pays. |

A failed script load calls `handler` with `checkout_unavailable` when the handler is already set. It does not redirect.
