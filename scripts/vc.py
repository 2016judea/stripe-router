"""Tiny Vercel + keyring helpers shared by the scripts. Needs ~/Desktop/bricks/.env."""
import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

TEAM = "team_XnhPzBEcaSfEmZFo9M2isLFY"
ROOT = Path(__file__).resolve().parent.parent
KEYRING = Path.home() / "Desktop/bricks/.env"


def env(name):
    if os.environ.get(name):
        return os.environ[name]
    for line in KEYRING.read_text().splitlines():
        if line.startswith(name + "="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit(f"{name} is not in the environment or {KEYRING}")


def api(path, data=None, method=None, raw=None, headers=None):
    head = {"Authorization": f"Bearer {env('VERCEL_TOKEN')}"}
    body = raw
    if data is not None:
        body, head["Content-Type"] = json.dumps(data).encode(), "application/json"
    head.update(headers or {})
    sep = "&" if "?" in path else "?"
    req = urllib.request.Request(f"https://api.vercel.com{path}{sep}teamId={TEAM}", data=body, headers=head, method=method)
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def product_secret(product):
    """Must match productSecret() in api/_lib.js."""
    return "whsec_rt_" + hmac.new(env("STRIPE_ROUTER_SECRET").encode(), ("product:" + product).encode(), hashlib.sha256).hexdigest()


def wait_ready(url):
    for _ in range(100):
        time.sleep(3)
        _, d = api(f"/v13/deployments/{url}")
        if d.get("readyState") in ("READY", "ERROR", "BLOCKED", "CANCELED"):
            return d.get("readyState")
    return "TIMEOUT"


def redeploy(project):
    """Rebuild the project's current production deployment so new env vars apply."""
    _, d = api(f"/v6/deployments?projectId={project}&target=production&state=READY&limit=1")
    if not d.get("deployments"):
        raise SystemExit(f"{project}: no READY production deployment to redeploy")
    dep = d["deployments"][0]
    code, out = api("/v13/deployments?forceNew=1", {"name": project, "deploymentId": dep["uid"], "target": "production"})
    if code >= 400:
        raise SystemExit(f"{project}: redeploy failed {code} {out.get('error')}")
    return wait_ready(out["url"])
