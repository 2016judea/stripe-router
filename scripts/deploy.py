#!/usr/bin/env python3
"""Deploy the router to Vercel production over the REST API (no CLI on this Mac)."""
import hashlib
import sys

from vc import ROOT, TEAM, api, wait_ready

FILES = ["api/_lib.js", "api/stripe.js", "api/health.js", "routes.json", "vercel.json"]
# Only public/ is static. Until 2026-10-19 outputDirectory "." served api/_lib.js and
# api/stripe.js as plain text (curl, 200). The router has no page, so public/ carries one
# robots.txt; the functions and routes.json stay at the root, where only they read them.
PUBLIC = {"public/robots.txt": b"User-agent: *\nDisallow: /\n"}
files = []
for rel in FILES + list(PUBLIC):
    body = PUBLIC[rel] if rel in PUBLIC else (ROOT / rel).read_bytes()
    sha = hashlib.sha1(body).hexdigest()
    code, out = api("/v2/files", raw=body, headers={"Content-Type": "application/octet-stream", "x-vercel-digest": sha})
    if code >= 400:
        sys.exit(f"upload {rel}: {code} {out}")
    files.append({"file": rel, "sha": sha, "size": len(body)})
code, out = api("/v13/deployments?skipAutoDetectionConfirmation=1", {
    "name": "stripe-router", "project": "stripe-router", "target": "production", "files": files,
    "projectSettings": {"framework": None, "buildCommand": "echo build", "outputDirectory": "public", "installCommand": "echo skip"}})
if code >= 400:
    sys.exit(f"create: {code} {out.get('error')}")
state = wait_ready(out["url"])
print(f"  {state} https://{out['url']}")
sys.exit(0 if state == "READY" else 1)
