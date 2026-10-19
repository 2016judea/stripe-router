// The router never sees Stripe here: every event is a fixture signed with a dummy
// endpoint secret, and the product's /api/stripe-webhook is a stubbed fetch.
//   node --test test/*.test.js
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_dummy_endpoint_secret";
process.env.ROUTER_SECRET = "router_master_test_secret";

const lib = require("../api/_lib");
const handler = require("../api/stripe");
const ROUTES = require("../routes.json");

const SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const PRODUCT = "paperwork-sorter";

function session(extra = {}, metadata = { product: PRODUCT }) {
  return { id: "cs_test_fixture1", object: "checkout.session", payment_status: "paid", metadata, ...extra };
}
function event(s, type = "checkout.session.completed", id = "evt_test_1") {
  return JSON.stringify({ id, object: "event", type, livemode: false, data: { object: s } });
}
function drive(body, { header, method = "POST" } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = { "stripe-signature": header === undefined ? lib.sign(body, SECRET) : header };
  const res = { code: null, body: null, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } };
  const done = handler(req, res);
  process.nextTick(() => { if (body !== null) req.emit("data", Buffer.from(body)); req.emit("end"); });
  return done.then(() => res);
}

let calls;
beforeEach(() => {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const reply = globalThis.__reply || { status: 200, text: '{"sent":false,"why":"not ours or not paid"}' };
    if (reply.throw) throw new Error(reply.throw);
    return { status: reply.status, text: async () => reply.text };
  };
  globalThis.__reply = null;
});

// --- signature -------------------------------------------------------------

test("a body signed with the endpoint secret verifies; any other secret, a stale t, or no header does not", () => {
  const body = event(session());
  assert.equal(lib.verify(body, lib.sign(body, SECRET), [SECRET]), true);
  assert.equal(lib.verify(body, lib.sign(body, "whsec_other"), [SECRET]), false);
  assert.equal(lib.verify(body, lib.sign(body, SECRET, Math.floor(Date.now() / 1000) - 601), [SECRET]), false);
  assert.equal(lib.verify(body, "", [SECRET]), false);
  assert.equal(lib.verify(body, lib.sign(body, SECRET), []), false, "no configured secret must never verify");
  assert.equal(lib.verify(body + " ", lib.sign(body, SECRET), [SECRET]), false, "a changed body fails");
});

test("comma-separated secrets: the second one is enough (live + test endpoint)", () => {
  const body = event(session());
  assert.equal(lib.verify(body, lib.sign(body, "whsec_second"), [SECRET, "whsec_second"]), true);
});

test("a bad signature is a 400 and nothing is forwarded", async () => {
  const body = event(session());
  const res = await drive(body, { header: lib.sign(body, "whsec_wrong") });
  assert.equal(res.code, 400);
  assert.equal(calls.length, 0);
});

test("GET is a 405", async () => {
  const res = await drive(null, { method: "GET", header: "" });
  assert.equal(res.code, 405);
});

// --- routing ---------------------------------------------------------------

test("metadata.product picks the registered route", () => {
  assert.deepEqual(lib.identify(session()), { product: PRODUCT, why: "metadata.product" });
});

test("without metadata.product, the host of metadata.site / return_url / success_url selects the route, never a URL the router would post to", () => {
  const byUrl = lib.identify(session({ success_url: "https://salon-rates.vercel.app/?paid=cs_x" }, {}));
  assert.deepEqual(byUrl, { product: "salon-rates", why: "success_url host" });
  const bySite = lib.identify(session({}, { site: "https://run-sheet-yard.vercel.app" }));
  assert.equal(bySite.product, "run-sheet");
  const evil = lib.identify(session({ success_url: "https://attacker.example/api/stripe-webhook" }, {}));
  assert.equal(evil, null, "an unknown host must not become a destination");
});

test("every registered product's own host routes back to itself (no two routes share a host)", () => {
  for (const [name, r] of Object.entries(ROUTES)) {
    const hit = lib.identify(session({ return_url: r.url }, {}));
    assert.equal(hit && hit.product, name, `${name} should route by its host`);
  }
});

test("an unregistered session is acknowledged with 200 and not forwarded (Stripe must not retry it forever)", async () => {
  const res = await drive(event(session({}, { product: "not-a-product" })));
  assert.equal(res.code, 200);
  assert.equal(res.body.ignored, "no registered product");
  assert.equal(calls.length, 0);
});

test("events other than checkout.session.completed are ignored with 200", async () => {
  const res = await drive(event(session(), "payment_intent.succeeded"));
  assert.equal(res.code, 200);
  assert.equal(res.body.ignored, "payment_intent.succeeded");
  assert.equal(calls.length, 0);
});

// --- forwarding ------------------------------------------------------------

test("the body is forwarded byte-for-byte to the product's URL, re-signed with that product's own derived secret", async () => {
  const body = event(session());
  const res = await drive(body);
  assert.equal(res.code, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ROUTES[PRODUCT].url);
  assert.equal(calls[0].init.body, body);
  const sig = calls[0].init.headers["Stripe-Signature"];
  assert.equal(lib.verify(body, sig, [lib.productSecret(PRODUCT)]), true, "the product can verify with its router secret");
  assert.equal(lib.verify(body, sig, [lib.productSecret("salon-rates")]), false, "another product's secret cannot");
  assert.equal(lib.verify(body, sig, [SECRET]), false, "the Stripe endpoint secret is not reused downstream");
  assert.equal(calls[0].init.headers["X-Stripe-Router"], "1");
  assert.ok(calls[0].init.signal, "the forward carries a timeout");
});

test("the same event delivered twice is routed and forwarded identically (idempotent: the product dedupes, the router never mutates)", async () => {
  const body = event(session());
  const a = await drive(body);
  const b = await drive(body);
  assert.equal(a.code, 200); assert.equal(b.code, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, calls[1].url);
  assert.equal(calls[0].init.body, calls[1].init.body);
  assert.deepEqual(a.body.product, b.body.product);
});

test("a product answering non-2xx makes the router answer 502 so Stripe retries", async () => {
  globalThis.__reply = { status: 500, text: '{"error":"mailgun 401"}' };
  const res = await drive(event(session()));
  assert.equal(res.code, 502);
  assert.equal(res.body.product, PRODUCT);
  assert.equal(res.body.status, 500);
});

test("a product that cannot be reached (timeout, DNS) is also a 502", async () => {
  globalThis.__reply = { throw: "The operation was aborted due to timeout" };
  const res = await drive(event(session()));
  assert.equal(res.code, 502);
  assert.match(res.body.error, /timeout/);
});

test("a product answering 2xx with 'not ours or not paid' is still a 200 (the probe path)", async () => {
  const res = await drive(event(session({ payment_status: "unpaid" })));
  assert.equal(res.code, 200);
  assert.match(res.body.reply, /not ours or not paid/);
});

// --- python parity ---------------------------------------------------------

test("scripts/vc.py product_secret() derives the same secret as api/_lib.js productSecret()", () => {
  const py = execFileSync("python3", ["-c",
    "import sys; sys.path.insert(0, 'scripts'); import vc; print(vc.product_secret('paperwork-sorter'))"],
    { cwd: path.join(__dirname, ".."), env: { ...process.env, STRIPE_ROUTER_SECRET: process.env.ROUTER_SECRET }, encoding: "utf8" }).trim();
  assert.equal(py, lib.productSecret("paperwork-sorter"));
});

test("scripts/probe.py signs the way the router verifies", () => {
  const body = event(session({ payment_status: "unpaid" }));
  const sig = execFileSync("python3", ["-c", [
    "import hashlib, hmac, sys, time",
    "body = sys.stdin.read(); secret = sys.argv[1]; t = int(time.time())",
    "print(f't={t},v1=' + hmac.new(secret.encode(), f'{t}.{body}'.encode(), hashlib.sha256).hexdigest())",
  ].join("\n"), SECRET], { input: body, encoding: "utf8" }).trim();
  assert.equal(lib.verify(body, sig, [SECRET]), true);
});
