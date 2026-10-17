// Shared by the router's functions. Files starting with "_" are not routes on Vercel.
const crypto = require("crypto");
const ROUTES = require("../routes.json");

// Stripe's signature scheme: header "t=<unix>,v1=<hex hmac of `${t}.${body}`>".
function sign(body, secret, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

function verify(body, header, secrets) {
  const kv = String(header || "").split(",").map((p) => p.split("="));
  const t = (kv.find((p) => p[0] === "t") || [])[1];
  const sigs = kv.filter((p) => p[0] === "v1").map((p) => p[1]);
  if (!t || Math.abs(Date.now() / 1000 - Number(t)) > 600) return false;
  return secrets.some((sec) => {
    const want = crypto.createHmac("sha256", sec).update(`${t}.${body}`).digest("hex");
    return sigs.some((s) => s.length === want.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(want)));
  });
}

// The secret a product's handler must accept from the router. Derived, never stored:
// HMAC(ROUTER_SECRET, product). Each product gets its own, so one leak opens one door.
function productSecret(product) {
  const master = process.env.ROUTER_SECRET;
  if (!master) throw new Error("ROUTER_SECRET is not set");
  return "whsec_rt_" + crypto.createHmac("sha256", master).update("product:" + product).digest("hex");
}

const host = (u) => { try { return new URL(u).host; } catch { return ""; } };

// Which product a Checkout Session belongs to. metadata.product is the house convention
// (every paywall mints it at checkout); the rest catch a session made some other way.
function identify(s) {
  const by = (why, name) => (ROUTES[name] ? { product: name, why } : null);
  if (s?.metadata?.product && ROUTES[s.metadata.product]) return by("metadata.product", s.metadata.product);
  // A URL in the session only ever SELECTS a registered route; the router never posts to a
  // URL it read out of an event.
  const m = s?.metadata || {};
  const hosts = [["metadata.handler_url", m.handler_url], ["metadata.pw_handler", m.pw_handler], ["metadata.site", m.site],
    ["return_url", s?.return_url], ["success_url", s?.success_url]].map(([k, u]) => [k, host(u)]).filter(([, h]) => h);
  for (const [name, r] of Object.entries(ROUTES)) {
    const hit = hosts.find(([, h]) => h === host(r.url));
    if (hit) return by(hit[0] + " host", name);
    if (s?.payment_link && (r.payment_links || []).includes(s.payment_link)) return by("payment link", name);
  }
  return null;
}

module.exports = { ROUTES, sign, verify, productSecret, identify };
