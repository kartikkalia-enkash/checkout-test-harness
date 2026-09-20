// temporary verification script — syntax-compiles the harness inline script
// and exercises the SDK's base-URL resolution against a stubbed DOM.
const fs = require('fs');
const vm = require('vm');

// ---- 1. inline <script> blocks in the harness compile ----
const html = fs.readFileSync('checkout-sdk-test.html', 'utf8');
const re = /<script(?:(?:[^>]*?))>([\s\S]*?)<\/script>/g;
let m, blocks = [];
while ((m = re.exec(html)) !== null) {
  if (m[1].trim()) blocks.push(m[1]);
}
console.log('inline script blocks found:', blocks.length);
blocks.forEach((b, i) => {
  new vm.Script(b, { filename: 'harness-block-' + i + '.js' });
  console.log('  block ' + i + ' compiles OK (' + b.split('\n').length + ' lines)');
});

// ---- 2. SDK base-URL resolution ----
const sdkSrc = fs.readFileSync('checkout-sdk.js', 'utf8');
const win = { URL, addEventListener() {}, removeEventListener() {}, location: { origin: 'https://harness.vercel.app' } };
const doc = { body: { style: {}, appendChild() {} }, createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {} }), addEventListener() {}, removeEventListener() {} };
const sandbox = { window: win, document: doc, URL, setTimeout, clearTimeout, console };
vm.createContext(sandbox);
vm.runInContext(sdkSrc, sandbox);

const EnkashCheckout = sandbox.window.EnkashCheckout;
const noop = function () {};
const mk = (extra) => new EnkashCheckout(Object.assign({ order_id: 'ORD_1', handler: noop }, extra));

const cases = [
  ['default (no env given)', {}, 'https://checkoutv3.enkash.com'],
  ['env: local', { env: 'local' }, 'http://localhost:4200'],
  ['env: uat', { env: 'uat' }, 'https://checkout-uat-v3.enkash.in'],
  ['env: prod', { env: 'prod' }, 'https://checkoutv3.enkash.com'],
  ['base_url with trailing slash', { base_url: 'https://checkout-uat-v3.enkash.in/' }, 'https://checkout-uat-v3.enkash.in'],
  ['base_url wins over env', { base_url: 'http://localhost:4300', env: 'prod' }, 'http://localhost:4300'],
];

let failures = 0;
for (const [name, opts, expected] of cases) {
  const c = mk(opts);
  const ok = c.baseUrl === expected;
  if (!ok) failures++;
  console.log((ok ? '  PASS ' : '  FAIL ') + name + ' -> ' + c.baseUrl + ' (origin ' + c.origin + ')');
}

// global config fallback
sandbox.window.EnkashCheckoutConfig = { env: 'uat' };
const g = mk({});
console.log((g.baseUrl === 'https://checkout-uat-v3.enkash.in' ? '  PASS ' : '  FAIL ') + 'window.EnkashCheckoutConfig.env -> ' + g.baseUrl);
if (g.baseUrl !== 'https://checkout-uat-v3.enkash.in') failures++;
delete sandbox.window.EnkashCheckoutConfig;

// bad inputs must throw
for (const [name, opts] of [['unknown env', { env: 'staging' }], ['malformed base_url', { base_url: 'localhost:4200' }]]) {
  let threw = false, msg = '';
  try { mk(opts); } catch (e) { threw = true; msg = e.message; }
  if (!threw) failures++;
  console.log((threw ? '  PASS ' : '  FAIL ') + name + ' throws: ' + msg);
}

// iframe src has exactly one slash before v1
const built = [];
doc.createElement = () => {
  const el = { style: {}, setAttribute() {}, appendChild() {}, addEventListener() {} };
  Object.defineProperty(el, 'src', { set(v) { built.push(v); }, get() { return built[built.length - 1]; } });
  return el;
};
win.matchMedia = () => ({ matches: false });
const c = mk({ env: 'uat' });
c._buildDom();
const srcOk = built.length === 1 && built[0] === 'https://checkout-uat-v3.enkash.in/v1/pay/ORD_1?embedded=true&parentOrigin=https%3A%2F%2Fharness.vercel.app';
if (!srcOk) failures++;
console.log((srcOk ? '  PASS ' : '  FAIL ') + 'iframe src: ' + built[0]);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
