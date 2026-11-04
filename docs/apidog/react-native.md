# React Native Checkout

`@enkash/react-native-checkout` opens EnKash hosted checkout inside a React Native WebView. The merchant app supplies an `order_id`. The package renders the overlay. Use it for a React Native screen that should show EnKash checkout and then resume the app with a result or a dismiss.

This package does not create orders. It does not redirect a website. Android back is not the web Escape key: it is delivered into checkout so checkout can show its own cancel step.

## Prerequisites

The app already has an `order_id` from your server.

Install the package and its WebView peer:

```sh
npm install @enkash/react-native-checkout react-native-webview
```

In Expo, install WebView with Expo so it matches Expo Go:

```sh
npx expo install react-native-webview
```

Peers are `react`, `react-native`, and `react-native-webview`.

Mount `EnKashCheckoutProvider` once around the screens that open checkout. `EnKashCheckout.open` rejects with `EnKashCheckoutProvider is not mounted` when the provider is absent. `useEnKashCheckout()` throws `useEnKashCheckout must be used within EnKashCheckoutProvider` if it is called outside the provider. It returns the same `EnKashCheckout` object.

Checkout is loaded from:

| `env` | Base URL |
| --- | --- |
| `local` | `http://localhost:4200` |
| `uat` | `https://checkout-uat-v3.enkash.in` |
| `prod` (default) | `https://checkoutv3.enkash.com` |

The WebView URL the package builds is:

`{base}/v1/pay/{order_id}?embedded=true&host=rn`

`parentOrigin` is not sent. You do not build this URL.

On Android 11 and newer, a bare React Native app must declare the `upi` scheme or `Linking.openURL('upi://…')` cannot see UPI apps. Add this inside `android/app/src/main/AndroidManifest.xml`:

```xml
<queries>
  <intent>
    <action android:name="android.intent.action.VIEW" />
    <data android:scheme="upi" />
  </intent>
</queries>
```

Expo Go does not include that entry. Confirm UPI intent behavior in a build that has the `queries` element before relying on it.

## Integrate

<Steps>
  <Step title="Mount the provider">
    Put the provider at the root. It owns the one open checkout session.

```tsx
import { EnKashCheckoutProvider } from '@enkash/react-native-checkout';

export default function App() {
  return (
    <EnKashCheckoutProvider>
      {/* screens */}
    </EnKashCheckoutProvider>
  );
}
```
  </Step>
  <Step title="Open checkout and await one result">
    `open` resolves once. A second `open()` while that promise is in flight returns the same promise.

```tsx
import { EnKashCheckout } from '@enkash/react-native-checkout';

const result = await EnKashCheckout.open({
  order_id: 'ORD_FROM_YOUR_SERVER',
  env: 'uat',
  handler: (payload) => {
    // Same object as result.payload when result.kind === 'result'.
    // Also called for { status: 'FAILED', reason: 'checkout_unavailable' }.
  },
  modal: {
    backdropclose: false,
    ondismiss: () => {
      // Backdrop tap when backdropclose is true, close(), or provider unmount.
    },
  },
});

if (result.kind === 'result') {
  applyPaymentResult(result.payload);
} else {
  // kind === 'dismiss'. The customer left without a checkout result.
}
```
  </Step>
  <Step title="Branch a checkout result, including cancel and load failure">
    A cancel inside checkout is `kind: 'result'`. Load failure uses the same kind.

```tsx
function applyPaymentResult(payload: any) {
  if (payload && payload.status === 'FAILED' && payload.reason === 'checkout_unavailable') {
    showMessage('Checkout could not be opened. Try again.');
    return;
  }
  const status = String(payload?.payment_status || payload?.status || '').toLowerCase();
  if (status === 'cancelled') {
    showMessage('Payment cancelled.');
    return;
  }
  showReceipt(payload);
}
```
  </Step>
</Steps>

`useEnKashCheckout()` is optional. Call it under the provider when you want the API from a hook. `EnKashCheckout.open` from the module is the same function.

## Inputs

`EnKashCheckout.configure(config)` replaces the app-wide default. It does not merge into the previous config. A later `configure` drops keys you omit.

`EnKashCheckout.open(options)` throws synchronously when `options` are invalid. It returns a rejected promise only when the provider is not mounted.

| Field | Required | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `order_id` | yes | string | | Non-empty order id. Trimmed. |
| `handler` | no | `(payload: unknown) => void` | | Called only for `kind: 'result'`, with that payload. |
| `env` | no | `'local' \| 'uat' \| 'prod'` | falls through | Named checkout deployment. |
| `base_url` | no | string | falls through | Absolute `http:` or `https:` URL. Trailing slashes are removed. |
| `baseUrl` | no | string | | Alias of `base_url`. Ignored when `base_url` is a non-empty string. |
| `modal.ondismiss` | no | `() => void` | | Called only for `kind: 'dismiss'`. |
| `modal.backdropclose` | no | boolean | `false` | Backdrop tap dismisses only when this is `true`. |
| `modal.escape` | no | boolean | | Accepted and ignored. |
| `debug` | no | boolean | `false` | When `true`, each bridge message is logged as `[enkash] {direction} {type}`. |
| `onBridgeEvent` | no | function | | Diagnostics. Not a payment result. |

`onBridgeEvent` receives `{ direction, type, payload, timestamp }`. `direction` is `'checkout_to_sdk'` or `'sdk_to_checkout'`. `timestamp` is `Date.now()`. Do not complete an order from this callback.

`configure` accepts `env`, `base_url`, and `baseUrl` with the same alias rule.

Base URL precedence for one `open`:

1. `options.base_url`, else `options.baseUrl`
2. `options.env`
3. configured `base_url`, else configured `baseUrl`
4. configured `env`
5. `prod`

| Method | Behavior |
| --- | --- |
| `EnKashCheckout.configure(config)` | Sets the default used when an `open` omits `env` and both URL fields. |
| `EnKashCheckout.open(options)` | Starts checkout. Returns the in-flight promise if one is already running. |
| `EnKashCheckout.close()` | Resolves the open session as `{ kind: 'dismiss' }` and calls `modal.ondismiss`. |
| `useEnKashCheckout()` | Returns `EnKashCheckout` when the provider is mounted. |

The phone sheet opens at 50% of the screen height and expands to 80% after checkout content is ready. If that signal never arrives, it still expands after 2 seconds. Those heights are not options.

Android hardware back, while checkout is open and no in-app popup is showing, is sent to checkout. It does not resolve `open()`. The package ignores `modal.escape`.

## Outputs

`open()` resolves exactly once, then the overlay is gone.

| `kind` | When | `handler` | `modal.ondismiss` |
| --- | --- | --- | --- |
| `'result'` | Checkout result, a checkout status URL on the checkout origin, or checkout never ready within 15 seconds | called with `payload` | not called |
| `'dismiss'` | Backdrop tap when `backdropclose` is `true`, `EnKashCheckout.close()`, or the provider unmounts during an open session | not called | called |

```ts
type CheckoutResult =
  | { kind: 'result'; payload: unknown }
  | { kind: 'dismiss' };
```

Result payloads:

| Case | `payload` |
| --- | --- |
| Checkout never becomes ready within 15 seconds | `{ status: 'FAILED', reason: 'checkout_unavailable' }` |
| Checkout posts a result | That object, unchanged. A second result message is ignored |
| WebView navigates to `{checkout origin}/v1/status` or `{checkout origin}/v1/payment-status` | Query parameters, excluding `embedded`, `parentOrigin`, and `host`. If `payment_status` is absent, it is set from `orderStatus` or `status`: `SUCCESS`, `PAID`, and `CAPTURED` become `success`; `CANCELLED` and `CANCELED` become `cancelled`; every other value becomes `failed` |

A cancel inside checkout is `{ kind: 'result' }`. It is not `{ kind: 'dismiss' }`. When checkout sends that cancel as a result message, read `payment_status` or `status` on the payload. The value used for that cancel is `cancelled`.

Do not navigate to a callback URL. `returnUrl` or `return_url` may be on the payload when checkout included them. They are not required.

`handler` runs after the promise resolves, and only for `kind: 'result'`. You can use either the promise or `handler`. They receive the same payload.

```tsx
const result = await EnKashCheckout.open({
  order_id: orderId,
  env: 'uat',
});

if (result.kind === 'dismiss') {
  return;
}

if (
  result.payload &&
  (result.payload as { reason?: string }).reason === 'checkout_unavailable'
) {
  showMessage('Checkout could not be opened.');
  return;
}

showReceipt(result.payload);
```

Dismiss path:

```tsx
await EnKashCheckout.open({
  order_id: orderId,
  env: 'uat',
  modal: {
    backdropclose: true,
    ondismiss: () => {
      // Not a payment result.
    },
  },
});
```

Calling `close()` from your UI uses the dismiss path, including `ondismiss`. That is different from web `EnkashCheckout.close()`, which notifies nobody.

## Confirm on your server

Do not fulfil an order from `{ kind: 'result' }` alone. Send the payload to your server. Your server confirms the transaction with EnKash, server to server, and checks that the order id and amount match the order you created. Deliver only after that confirmation succeeds.

`{ kind: 'dismiss' }` and `{ status: 'FAILED', reason: 'checkout_unavailable' }` are not transactions to confirm.

## Constraints

:::danger
Do not treat `{ kind: 'dismiss' }` as a failed or cancelled payment. Dismiss means the overlay was closed by the backdrop (only when `modal.backdropclose` is `true`), by `EnKashCheckout.close()`, or because the provider unmounted. A cancel inside checkout resolves `{ kind: 'result' }`.
:::

:::warning
`modal.escape` does not close the sheet. Android back is forwarded to checkout. Handle a cancelled payment from the result payload, not from the hardware back press.
:::

:::info
Invalid `order_id`, `handler`, `onBridgeEvent`, `modal`, `env`, or `base_url` throw before a promise is returned. A missing provider rejects the promise. A second `open()` does not start a second checkout; it returns the current promise.
:::

## Errors

| Condition | What happens | What your app should do |
| --- | --- | --- |
| `order_id` missing, not a string, or blank | Throws `EnKashCheckout: order_id is required` | Pass the server order id. |
| `handler` set and not a function | Throws `EnKashCheckout: handler must be a function` | Omit it or pass a function. |
| `onBridgeEvent` set and not a function | Throws `EnKashCheckout: onBridgeEvent must be a function` | Omit it or pass a function. |
| `modal` set and not a non-null object | Throws `EnKashCheckout: modal must be an object` | Omit it or pass an object. |
| Unknown `env` | Throws `EnKashCheckout: unknown env "…"`. Expected `local`, `uat`, `prod` | Pass a known `env` or `base_url`. |
| `base_url` / `baseUrl` not absolute `http(s)` | Throws `EnKashCheckout: base_url is not a valid URL` or `base_url must be an absolute http(s) URL` | Pass a full URL or omit it. |
| Provider not mounted | Promise rejects `EnKashCheckoutProvider is not mounted` | Render `EnKashCheckoutProvider` above the screen. |
| `useEnKashCheckout()` outside the provider | Throws `useEnKashCheckout must be used within EnKashCheckoutProvider` | Call the hook under the provider, or import `EnKashCheckout` directly. |
| Checkout not ready within 15 seconds | Resolves `{ kind: 'result', payload: { status: 'FAILED', reason: 'checkout_unavailable' } }` and calls `handler` with that object | Offer another attempt. Do not capture a payment. |

## Verify

- Mount the provider, open a UAT `order_id` with `env: 'uat'`, and confirm the WebView host is `checkout-uat-v3.enkash.in` and the path is `/v1/pay/{order_id}` with `embedded=true` and `host=rn`.
- Finish a payment and confirm the promise resolves once with `kind: 'result'`, and `ondismiss` does not run.
- Cancel inside checkout and confirm `kind` is still `'result'`, with `payment_status` or `status` of `cancelled`.
- Call `EnKashCheckout.close()` and confirm `{ kind: 'dismiss' }` and that `ondismiss` runs.
- Set `modal.backdropclose: false`, tap the backdrop, and confirm the session stays open.
- Call `open()` twice without awaiting and confirm both callers receive the same outcome.
- Omit the provider and confirm `open()` rejects.
- On an Android build, confirm the manifest contains the `upi` queries intent before testing a UPI app handoff.
