#!/usr/bin/env python3
"""Prove a product is reachable THROUGH the router, without a charge or an email.

    python3 scripts/probe.py <product> [<product> ...]      # or --all

Signs a fake checkout.session.completed (payment_status "unpaid", metadata.product set)
with the router's Stripe endpoint secret and posts it to the live router. The router
forwards it; the product's own handler verifies the router's signature and answers
200 {"sent":false,"why":"not ours or not paid"} without touching Stripe or Mailgun.
A product that has not accepted the router secret answers 400 "bad signature".
"""
import hashlib
import hmac
import json
import sys
import time
import urllib.error
import urllib.request

from vc import ROOT, env

ROUTER = "https://stripe-router-lake.vercel.app/api/stripe"
names = sys.argv[1:]
if names == ["--all"]:
    names = list(json.loads((ROOT / "routes.json").read_text()))
secret = env("STRIPE_ROUTER_WEBHOOK_SECRET").split(",")[0]
bad = 0
for product in names:
    body = json.dumps({"id": "evt_router_probe", "object": "event", "type": "checkout.session.completed", "livemode": True,
                       "data": {"object": {"id": "cs_router_probe", "object": "checkout.session", "payment_status": "unpaid",
                                           "metadata": {"product": product}}}})
    t = int(time.time())
    sig = hmac.new(secret.encode(), f"{t}.{body}".encode(), hashlib.sha256).hexdigest()
    req = urllib.request.Request(ROUTER, data=body.encode(), headers={"Content-Type": "application/json", "Stripe-Signature": f"t={t},v1={sig}"})
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            code, out = r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        code, out = e.code, json.loads(e.read() or b"{}")
    ok = code == 200 and out.get("product") == product and "not ours or not paid" in out.get("reply", "")
    bad += not ok
    print(("OK  " if ok else "FAIL"), product, code, json.dumps(out)[:240])
sys.exit(1 if bad else 0)
