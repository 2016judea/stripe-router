// GET /api/health — which products the router forwards to. No secrets.
const { ROUTES } = require("./_lib");

module.exports = (req, res) => {
  res.status(200).json({
    ok: Boolean(process.env.ROUTER_SECRET && process.env.STRIPE_WEBHOOK_SECRET),
    products: Object.fromEntries(Object.entries(ROUTES).map(([k, v]) => [k, v.url])),
  });
};
