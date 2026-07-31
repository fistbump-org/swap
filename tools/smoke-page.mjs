/**
 * Import a browser module under a minimal DOM and report anything it throws.
 *
 * `node --check` only parses. A file can be syntactically perfect and dead on
 * arrival — which happened: a patch anchored on a comment that had since been
 * reworded matched nothing, silently, so a function was never defined and every
 * call to it threw ReferenceError on the first keystroke. The amount fields and
 * the quote path both stopped working, and every check that ran was green.
 *
 * This is not a browser. It answers the two questions these files actually fail
 * on: does the module survive being loaded, and are the elements it reaches for
 * present in the HTML.
 *
 *   node tools/smoke-page.mjs web/app/auto/index.html web/app/auto/app.js
 *
 * Lives in tools/ rather than web/app/ so it is never served — it was, briefly.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [htmlPath, jsPath] = process.argv.slice(2);
const html = readFileSync(htmlPath, "utf8");
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

const missing = new Set();
const listeners = [];

// Cached by id so the module and this harness see the same object — otherwise
// a value set here is invisible to the handler being tested.
const elCache = new Map();

function makeEl(id = "") {
  if (id && elCache.has(id)) return elCache.get(id);
  const el = {
    id,
    value: "",
    textContent: "",
    innerHTML: "",
    hidden: false,
    disabled: false,
    checked: false,
    style: {},
    dataset: {},
    selectionStart: 0,
    selectionEnd: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener: (t, fn) => listeners.push({ id, t, fn }),
    removeEventListener() {},
    setAttribute() {},
    getAttribute: () => null,
    removeAttribute() {},
    appendChild() {},
    removeChild() {},
    insertBefore() {},
    remove() {},
    setSelectionRange() {},
    focus() {},
    blur() {},
    click() {},
    scrollIntoView() {},
    closest: () => null,
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    dispatchEvent() {},
    replaceChildren() {},
    append() {},
    prepend() {},
    insertAdjacentElement() {},
    insertAdjacentHTML() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
  };
  if (id) elCache.set(id, el);
  return el;
}

globalThis.document = {
  getElementById(id) {
    if (!ids.has(id)) {
      missing.add(id);
      return null;
    }
    return makeEl(id);
  },
  querySelector: () => makeEl(),
  querySelectorAll: () => [],
  createElement: () => makeEl(),
  createTextNode: () => ({}),
  addEventListener() {},
  body: makeEl(),
  documentElement: makeEl(),
  hidden: false,
  visibilityState: "visible",
};
globalThis.window = globalThis;
// globalThis has no DOM event API in Node, and pages bind to window directly.
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.dispatchEvent = () => true;
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.scrollTo = () => {};
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) {
    return this._m.has(k) ? this._m.get(k) : null;
  },
  setItem(k, v) {
    this._m.set(k, String(v));
  },
  removeItem(k) {
    this._m.delete(k);
  },
  key: () => null,
  get length() {
    return this._m.size;
  },
};
globalThis.sessionStorage = globalThis.localStorage;
globalThis.location = new URL("https://swap.fistbump.org/auto/");
globalThis.history = { replaceState() {}, pushState() {} };
// Node defines navigator as a getter-only property, so it has to be replaced
// rather than assigned.
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { clipboard: { writeText: async () => {} }, userAgent: "smoke" },
});
globalThis.Notification = {
  permission: "default",
  requestPermission: async () => "denied",
};
// The module's init runs a quote cycle on load. Failing that is expected here;
// what is being tested is that it fails at the network rather than at a
// missing symbol.
globalThis.fetch = async () => {
  throw new Error("network disabled in smoke test");
};

let thrown = null;
process.on("unhandledRejection", () => {});
try {
  await import(pathToFileURL(jsPath).href);
} catch (err) {
  thrown = err;
}

// The module starts pollers, so the event loop never drains on its own. Give
// its async init a moment to reach any throw, then stop.
await new Promise((r) => setTimeout(r, 400));

if (thrown) {
  const where = thrown.stack?.split("\n").slice(0, 4).join("\n  ") ?? thrown.message;
  console.error(`FAIL ${jsPath} threw on load:\n  ${where}`);
  process.exit(1);
}
if (missing.size) {
  console.error(
    `FAIL ${jsPath} asks for ids absent from ${htmlPath}:\n  ${[...missing].join(", ")}`,
  );
  process.exit(1);
}

/*
 * Loading cleanly is not the same as working. The bug that motivated this file
 * lived in an input handler: the module imported fine and threw ReferenceError
 * on the first keystroke. So every bound listener is fired here, with the
 * inputs carrying a plausible value, and anything that throws is a failure.
 *
 * Handlers that need the network fail on the stubbed fetch, which is a
 * rejection rather than a throw and is ignored — what is being tested is that
 * they reach the network instead of dying on a missing symbol.
 */
const SAMPLE = { "amount-in": "0.0123456789", "amount-out": "639.1234567" };
const failures = [];
for (const { id, t, fn } of listeners) {
  const el = id ? elCache.get(id) : null;
  if (el && SAMPLE[id] !== undefined) {
    el.value = SAMPLE[id];
    el.selectionStart = SAMPLE[id].length;
  }
  try {
    const out = fn.call(el ?? globalThis, { type: t, target: el, preventDefault() {}, stopPropagation() {} });
    if (out && typeof out.catch === "function") out.catch(() => {});
  } catch (err) {
    failures.push(`${id || "(document)"}:${t} -> ${err.message}`);
  }
}
await new Promise((r) => setTimeout(r, 200));

if (failures.length) {
  console.error(`FAIL ${jsPath} handlers threw when fired:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}

// The sanitiser is the point of the sample values: confirm it actually ran.
for (const [id, limit] of [["amount-in", 8], ["amount-out", 6]]) {
  const v = elCache.get(id)?.value ?? "";
  const frac = v.includes(".") ? v.split(".")[1].length : 0;
  if (frac > limit) {
    console.error(`FAIL ${id} kept ${frac} decimals; ${limit} is the limit (value ${v})`);
    process.exit(1);
  }
}
console.log(
  `ok ${jsPath} — loads, ${listeners.length} listeners fire without throwing, decimals clamped, every id resolves`,
);
process.exit(0);
