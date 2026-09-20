// temporary verification: exercises checkout-quick.js env resolution against
// a stubbed DOM, for each way the script tag can be written.
const fs = require('fs');
const vm = require('vm');

const sdkSrc = fs.readFileSync('checkout-sdk.js', 'utf8');
const quickSrc = fs.readFileSync('checkout-quick.js', 'utf8');

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log((ok ? '  PASS ' : '  FAIL ') + name + '\n        got: ' + actual + (ok ? '' : '\n        want: ' + expected));
}

// Runs quick.js with a script tag carrying `attrs`, clicks the injected
// button, and returns the iframe src the SDK produced.
function run(attrs, pageOrigin, scriptSrc, globalConfig) {
  const listeners = {};
  const iframeSrcs = [];

  function el(tag) {
    const node = {
      tagName: tag, style: {}, children: [], attrs: {}, _clicks: [], disabled: false,
      setAttribute(k, v) { this.attrs[k] = v; },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      appendChild(c) { this.children.push(c); return c; },
      addEventListener(type, fn) { if (type === 'click') this._clicks.push(fn); },
      removeEventListener() {}
    };
    if (tag === 'iframe') {
      Object.defineProperty(node, 'src', { set(v) { iframeSrcs.push(v); }, get() { return iframeSrcs[iframeSrcs.length - 1]; } });
    }
    return node;
  }

  const container = el('div');
  container.attrs['data-order_id'] = 'ORD_QUICK_1';

  const scriptTag = el('script');
  scriptTag.src = scriptSrc;
  Object.keys(attrs).forEach(k => { scriptTag.attrs[k] = attrs[k]; });

  const win = {
    URL,
    location: { origin: pageOrigin, href: pageOrigin + '/test-quick-checkout.html' },
    matchMedia: () => ({ matches: false }),
    addEventListener() {}, removeEventListener() {}
  };
  if (globalConfig) win.EnkashCheckoutConfig = globalConfig;

  const doc = {
    readyState: 'complete',
    currentScript: scriptTag,
    body: { style: {}, appendChild() {} },
    head: { appendChild() {} },
    createElement: el,
    querySelectorAll: () => [container],
    addEventListener() {}, removeEventListener() {}
  };

  const sandbox = { window: win, document: doc, URL, setTimeout, clearTimeout, console, URLSearchParams };
  vm.createContext(sandbox);
  vm.runInContext(sdkSrc, sandbox);   // SDK already on the page
  vm.runInContext(quickSrc, sandbox); // quick.js self-starts

  const button = container.children[0];
  if (!button) throw new Error('quick.js did not inject a button');
  button._clicks.forEach(fn => fn());
  return iframeSrcs[0];
}

const PAGE = 'https://harness.vercel.app';
const SUFFIX = '/v1/pay/ORD_QUICK_1?embedded=true&parentOrigin=https%3A%2F%2Fharness.vercel.app';

console.log('checkout-quick.js environment resolution:');
check('data-env="uat" (what test-quick-checkout.html now uses)',
  run({ 'data-env': 'uat' }, PAGE, PAGE + '/checkout-quick.js'),
  'https://checkout-uat-v3.enkash.in' + SUFFIX);

check('data-env="local"',
  run({ 'data-env': 'local' }, PAGE, PAGE + '/checkout-quick.js'),
  'http://localhost:4200' + SUFFIX);

check('data-base-url overrides data-env',
  run({ 'data-env': 'prod', 'data-base-url': 'https://branch-preview.example.com/' }, PAGE, PAGE + '/checkout-quick.js'),
  'https://branch-preview.example.com' + SUFFIX);

check('no attrs, served from UAT checkout host -> inferred',
  run({}, PAGE, 'https://checkout-uat-v3.enkash.in/checkout-quick.js'),
  'https://checkout-uat-v3.enkash.in' + SUFFIX);

check('no attrs, served from prod checkout host -> inferred',
  run({}, PAGE, 'https://checkoutv3.enkash.com/checkout-quick.js'),
  'https://checkoutv3.enkash.com' + SUFFIX);

check('no attrs, unknown host, no config -> SDK default (prod)',
  run({}, PAGE, PAGE + '/checkout-quick.js'),
  'https://checkoutv3.enkash.com' + SUFFIX);

check('no attrs, unknown host, window.EnkashCheckoutConfig honoured',
  run({}, PAGE, PAGE + '/checkout-quick.js', { env: 'uat' }),
  'https://checkout-uat-v3.enkash.in' + SUFFIX);

// The test page's actual script tag must carry the env.
const testHtml = fs.readFileSync('test-quick-checkout.html', 'utf8');
const tagMatch = testHtml.match(/<script[^>]*checkout-quick\.js[^>]*>/);
console.log('\ntest-quick-checkout.html script tag:\n  ' + (tagMatch ? tagMatch[0] : 'NOT FOUND'));
const tagOk = !!tagMatch && /data-env\s*=\s*"uat"/.test(tagMatch[0]);
if (!tagOk) failures++;
console.log((tagOk ? '  PASS ' : '  FAIL ') + 'pinned to uat');

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
