#!/usr/bin/env python3
"""Register a paywall with the router, instead of creating a Stripe webhook endpoint.

    python3 scripts/register.py <product> [--url https://<site>/api/stripe-webhook] [--project <vercel project>]

<product> is the metadata.product its checkout mints (offer.json "product"). It:
  1. adds the route to routes.json,
  2. appends this product's router secret to its Vercel STRIPE_WEBHOOK_SECRET
     (comma-separated; existing secrets are kept) and redeploys the product,
  3. redeploys the router and sends a signed probe through it (scripts/probe.py).
Then commit routes.json and push.
"""
import argparse
import json
import subprocess
import sys

from vc import ROOT, api, product_secret, redeploy

p = argparse.ArgumentParser()
p.add_argument("product")
p.add_argument("--url")
p.add_argument("--project")
a = p.parse_args()
project = a.project or a.product
url = a.url or f"https://{a.product}.vercel.app/api/stripe-webhook"

routes_path = ROOT / "routes.json"
routes = json.loads(routes_path.read_text())
routes[a.product] = {**routes.get(a.product, {}), "url": url}
routes_path.write_text(json.dumps(dict(sorted(routes.items())), indent=2) + "\n")
print(f"routes.json: {a.product} -> {url}")

secret = product_secret(a.product)
code, envs = api(f"/v9/projects/{project}/env?decrypt=true")
if code >= 400:
    sys.exit(f"vercel project {project}: {code} {envs.get('error')}")
rows = [e for e in envs["envs"] if e["key"] == "STRIPE_WEBHOOK_SECRET"]
if not rows:
    code, out = api(f"/v10/projects/{project}/env", {"key": "STRIPE_WEBHOOK_SECRET", "value": secret, "type": "encrypted",
                                                     "target": ["production", "preview", "development"]})
    print("STRIPE_WEBHOOK_SECRET created", code)
else:
    for row in rows:
        _, full = api(f"/v1/projects/{project}/env/{row['id']}")  # list values can come back truncated
        cur = [s for s in str(full.get("value", "")).split(",") if s]
        if not cur:
            sys.exit(f"{project}: could not read STRIPE_WEBHOOK_SECRET (sensitive?) — add {a.product}'s secret by hand")
        if secret in cur:
            print("STRIPE_WEBHOOK_SECRET already holds the router secret")
            continue
        code, out = api(f"/v9/projects/{project}/env/{row['id']}", {"value": ",".join(cur + [secret])}, method="PATCH")
        print(f"STRIPE_WEBHOOK_SECRET appended ({len(cur)} -> {len(cur) + 1})", code)
print(f"{project}: redeploy", redeploy(project))

print("router: deploy")
subprocess.run([sys.executable, str(ROOT / "scripts/deploy.py")], check=True)
sys.exit(subprocess.run([sys.executable, str(ROOT / "scripts/probe.py"), a.product]).returncode)
