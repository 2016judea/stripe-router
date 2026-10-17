// POST /api/stripe  — the one Stripe webhook endpoint for every Brick and Mortar paywall.
//
// Stripe caps an account at 16 live webhook endpoints, and the B&M account hit it on
// 2026-10-17. So every product registers here (routes.json) instead of creating one.
// The router verifies Stripe's signature, works out which product the Checkout Session
// is for, and forwards the UNCHANGED event body to that product's own
// /api/stripe-webhook, re-signed in Stripe's format with that product's router secret.
// The product's handler needs no code change: it accepts the router secret as one more
// entry in its comma-separated STRIPE_WEBHOOK_SECRET.
//
// Status codes carry Stripe's retry: a product that answers non-2xx makes the router
// answer 502, so Stripe redelivers for up to three days, exactly as before.
const { verify, sign, productSecret, identify, ROUTES } = require("./_lib");

const raw = (req) => new Promise((ok, no) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => ok(Buffer.concat(c))); req.on("error", no); });

async function forward(product, body) {
  const r = await fetch(ROUTES[product].url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Stripe-Signature": sign(body, productSecret(product)), "X-Stripe-Router": "1" },
    body,
    signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  return { status: r.status, reply: text.slice(0, 300) };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const body = (await raw(req)).toString("utf8");
  const secrets = String(process.env.STRIPE_WEBHOOK_SECRET || "").split(",").filter(Boolean);
  if (!verify(body, req.headers["stripe-signature"], secrets)) return res.status(400).json({ error: "bad signature" });
  const ev = JSON.parse(body);
  if (ev.type !== "checkout.session.completed") return res.status(200).json({ ignored: ev.type });
  const s = ev.data?.object;
  const hit = identify(s);
  if (!hit) {
    console.log("[router] unrouted", s?.id, s?.metadata?.product || "", s?.return_url || s?.success_url || "");
    return res.status(200).json({ ignored: "no registered product", session: s?.id });
  }
  try {
    const out = await forward(hit.product, body);
    console.log("[router]", s.id, "->", hit.product, `(${hit.why})`, out.status, out.reply);
    const ok = out.status >= 200 && out.status < 300;
    res.status(ok ? 200 : 502).json({ product: hit.product, why: hit.why, ...out });
  } catch (e) {
    console.error("[router]", s.id, "->", hit.product, "failed:", e.message);
    res.status(502).json({ product: hit.product, error: e.message });
  }
};

module.exports.config = { api: { bodyParser: false } };
