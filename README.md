# stripe-router

**Live:** https://stripe-router-lake.vercel.app

The one Stripe webhook endpoint for every Brick and Mortar paywall. Stripe caps an
account at 16 live webhook endpoints; the B&M account hit it on 2026-10-17, so new
products could not get one, and a buyer who closed the tab before the return page
loaded never got their password emailed. Now every product registers here instead.

## How it works

1. Stripe sends `checkout.session.completed` to `/api/stripe` (endpoint `we_1UPaaz…`).
   The router checks Stripe's signature (`STRIPE_WEBHOOK_SECRET`).
2. It finds the product: `metadata.product` first, then the host of
   `metadata.handler_url` / `metadata.pw_handler` / `metadata.site` / `return_url` /
   `success_url`, then a payment link id, matched against `routes.json`. A URL read out
   of an event only ever *selects* a registered route; the router never posts to it.
3. It forwards the **unchanged** body to that product's `/api/stripe-webhook`, re-signed
   in Stripe's format with that product's own secret, `HMAC(ROUTER_SECRET, product)`.
   The product needs no code change: the secret is one more entry in its
   comma-separated `STRIPE_WEBHOOK_SECRET`.
4. A product that answers non-2xx makes the router answer 502, so Stripe retries for
   three days, as it did before. Unregistered sessions get 200 and are logged.

`GET /` lists the registered products.

## Register a new product (never create a Stripe endpoint)

    python3 scripts/register.py <metadata.product> [--project <vercel project>] [--url https://<site>/api/stripe-webhook]
    git add routes.json && git commit -m "route <product>" && git push

It adds the route, appends the product's router secret to its Vercel env, redeploys
the product and the router, and runs the probe. Keys come from `~/Desktop/bricks/.env`
(`VERCEL_TOKEN`, `STRIPE_ROUTER_SECRET`, `STRIPE_ROUTER_WEBHOOK_SECRET`).

## Check it

    python3 scripts/probe.py --all

Posts a signed fake, unpaid session through the live router for every product. Each
product's own handler answers `not ours or not paid`: signature and product name
verified, no Stripe call, no email. A `bad signature` means the product never got
its router secret.

End-to-end on 2026-10-17: a $0 comp checkout on new-dentists
(`scripts/fulfil.py --comp`, return page blocked) was emailed its password by the
webhook through the router; `pw_emailed` read "by webhook" and the email arrived.

The 15 per-product endpoints this replaced are listed in `retired_endpoints.json`.

## Deploy

    python3 scripts/deploy.py

`stripe-router.vercel.app` belongs to a stranger; the alias is `stripe-router-lake`.
