#!/usr/bin/env python3
"""tinyauth-mgmt backend.

Identity chain (see docs/security-model.md):
    reverse proxy --forward-auth--> tinyauth --200 + Remote-User--> proxy
    proxy injects Remote-User / X-Tinyauth-User (+ X-Admin-Gateway)
    -> this backend trusts ONLY those headers, never the request body.

Roles:
    admin  -> full API access, membership comes from env ADMIN_USERS (fail-closed)
    self   -> identity-only routes (self-service mutations arrive next milestone)
"""
import http.client
import json
import logging
import os
import re
import socket
import sqlite3
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime

import yaml
from flask import Blueprint, Flask, g, jsonify, request, send_from_directory

# --------------------------------------------------------------------------
# configuration (environment)
# --------------------------------------------------------------------------
DATA_DIR = os.environ.get("TINYAUTH_DATA_DIR", "/data")
CONFIG_PATH = os.path.join(DATA_DIR, "tinyauth-config.yaml")
DB_PATH = os.path.join(DATA_DIR, "tinyauth.db")

ADMIN_USERS = {u.strip() for u in os.environ.get("ADMIN_USERS", "").split(",") if u.strip()}
GATEWAY_TOKEN = os.environ.get("GATEWAY_TOKEN", "")
DOCKER_SOCK = os.environ.get("DOCKER_SOCK", "/var/run/docker.sock")
TINYAUTH_CONTAINER = os.environ.get("TINYAUTH_CONTAINER", "tinyauth")
PORTAINER_URL = os.environ.get("PORTAINER_URL", "").rstrip("/")
PORTAINER_TOKEN = os.environ.get("PORTAINER_TOKEN", "")

_HERE = os.path.dirname(os.path.abspath(__file__))
# works in both layouts: flat container (/app/frontend) and repo (../frontend)
FRONTEND_DIR = os.path.join(_HERE, "frontend")
if not os.path.isdir(FRONTEND_DIR):
    FRONTEND_DIR = os.path.abspath(os.path.join(_HERE, "..", "frontend"))
if not os.path.isdir(FRONTEND_DIR):
    raise SystemExit(f"frontend directory not found relative to {_HERE}")

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"),
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("tinyauth-mgmt")

if not ADMIN_USERS:
    log.warning("ADMIN_USERS is not set — admin routes are DISABLED (fail-closed). "
                "Set ADMIN_USERS=<tinyauth-username> in the container environment.")
if not GATEWAY_TOKEN:
    log.warning("GATEWAY_TOKEN is not set — header-spoofing protection is OFF. "
                "Set it and inject X-Admin-Gateway from your reverse proxy.")

app = Flask(__name__, static_folder=FRONTEND_DIR, static_url_path="")
app.json.ensure_ascii = False

MUTATING = ("POST", "PUT", "PATCH", "DELETE")

# --------------------------------------------------------------------------
# tinyauth config / users file / sessions store
# --------------------------------------------------------------------------
_cfg_cache = {"mtime": None, "data": None}


def load_tinyauth_config():
    try:
        mtime = os.path.getmtime(CONFIG_PATH)
    except OSError:
        return {}
    if _cfg_cache["mtime"] != mtime:
        try:
            with open(CONFIG_PATH, encoding="utf-8") as f:
                _cfg_cache["data"] = yaml.safe_load(f) or {}
            _cfg_cache["mtime"] = mtime
        except Exception as exc:  # noqa: BLE001 - report and keep old data
            log.warning("cannot read %s: %s", CONFIG_PATH, exc)
            return _cfg_cache["data"] or {}
    return _cfg_cache["data"] or {}


def session_params():
    auth = load_tinyauth_config().get("auth") or {}
    def _int(key, default=0):
        try:
            return int(auth.get(key, default))
        except (TypeError, ValueError):
            return default
    users_file = auth.get("usersFile") or os.path.join(DATA_DIR, "tinyauth-users")
    return {
        "users_file": users_file,
        "session_expiry": _int("sessionExpiry"),
        "session_max_lifetime": _int("sessionMaxLifetime"),
    }


def read_users_file(path):
    """Parse tinyauth users file: user:hash[:totp], with $$ unescaping
    (mirrors tinyauth's ParseUser)."""
    users = []
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            raw = f.read()
    except OSError as exc:
        log.warning("cannot read users file %s: %s", path, exc)
        return users
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        s = line.replace("$$", "$") if "$$" in line else line
        parts = s.split(":", 2)
        if len(parts) < 2 or not parts[0].strip() or not parts[1].strip():
            continue
        users.append({
            "username": parts[0].strip(),
            "has_totp": len(parts) >= 3 and bool(parts[2].strip()),
        })
    return users


def db_ro():
    if not os.path.exists(DB_PATH):
        raise FileNotFoundError(f"session db not found: {DB_PATH}")
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, timeout=5)
    conn.row_factory = sqlite3.Row
    return conn


def fmt_ts(epoch):
    return datetime.fromtimestamp(int(epoch)).strftime("%F %T")


def compute_session(row, now, expiry, maxlife):
    created = int(row["created_at"] or 0)
    exp = int(row["expiry"] or 0)
    if exp <= now:
        status, remaining = "expired", 0
    elif maxlife and created and (now - created) > maxlife:
        status, remaining = "max-lifetime", 0
    else:
        status, remaining = "active", max(exp - now, 0)

    flags = []
    if row["totp_pending"]:
        flags.append("mfa-pending")
    if expiry and created and (exp - created) > expiry + 60:
        # sliding renewal pushed expiry; last renewal happened in [exp-7200, exp-3600]
        w0 = datetime.fromtimestamp(exp - 7200).strftime("%m-%d %H:%M")
        w1 = datetime.fromtimestamp(exp - 3600).strftime("%H:%M")
        flags.append(f"renewed≈{w0}~{w1}")
    if row["oauth_name"]:
        flags.append(f"oauth:{row['oauth_name']}")
    if row["oauth_groups"]:
        flags.append(f"groups:{row['oauth_groups']}")

    return {
        "uuid": row["uuid"],
        "username": row["username"],
        "provider": row["provider"],
        "totp_pending": bool(row["totp_pending"]),
        "name": row["name"],
        "email": row["email"],
        "oauth_groups": [g for g in (row["oauth_groups"] or "").split(",") if g],
        "created_at": created,
        "expires_at": exp,
        "remaining": remaining,
        "status": status,
        "flags": flags,
    }


# --------------------------------------------------------------------------
# docker / portainer (read-only in this milestone)
# --------------------------------------------------------------------------
class _UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, sock_path, timeout=10):
        super().__init__("localhost", timeout=timeout)
        self._sock_path = sock_path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self._sock_path)


def docker_get(path):
    conn = _UnixHTTPConnection(DOCKER_SOCK)
    try:
        conn.request("GET", path, headers={"Host": "localhost"})
        resp = conn.getresponse()
        body = resp.read()
    finally:
        conn.close()
    if resp.status != 200:
        raise RuntimeError(f"docker api {path} -> {resp.status}: {body[:200]!r}")
    return json.loads(body)


def parse_service_image(compose_text, service):
    lines = compose_text.splitlines()
    i = 0
    while i < len(lines):
        m = re.match(r"^(\s*)%s:\s*$" % re.escape(service), lines[i])
        if m:
            indent = len(m.group(1))
            for ln in lines[i + 1:]:
                if ln.strip() and (len(ln) - len(ln.lstrip())) <= indent:
                    break
                im = re.match(r"^\s+image:\s*(\S+)", ln)
                if im:
                    return im.group(1).strip("\"'")
            return None
        i += 1
    return None


def portainer_compose_image(project, service):
    """Optional cross-check via the Portainer API (PORTAINER_URL/TOKEN)."""
    if not (PORTAINER_URL and PORTAINER_TOKEN):
        return None, "portainer api not configured (set PORTAINER_URL + PORTAINER_TOKEN)"
    def _api(path):
        req = urllib.request.Request(
            PORTAINER_URL + path,
            headers={"X-API-Key": PORTAINER_TOKEN, "Accept": "application/vnd.github+json"})
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read() or b"{}")
    try:
        stacks = _api("/api/stacks")
        stack = next((s for s in stacks if s.get("Name") == project), None)
        if not stack:
            return None, f"no portainer stack named {project!r}"
        detail = _api(f"/api/stacks/{stack['Id']}")
        text = detail.get("composeFile") or ""
        img = parse_service_image(text, service or "")
        if not img:
            return None, "image entry not found in compose file"
        return img, None
    except Exception as exc:  # noqa: BLE001
        return None, f"portainer api error: {exc}"


# --------------------------------------------------------------------------
# identity / role middleware
# --------------------------------------------------------------------------
def sanitize_identity(value):
    if not value:
        return None
    value = value.strip()
    if not value or len(value) > 128:
        return None
    if any(ord(c) < 32 or ord(c) == 127 for c in value):
        return None
    return value


@app.before_request
def _identity_chain():
    # only the API surface is gated; static shell assets (/, /css, /js) carry
    # no data — the frontend still needs them to render error states.
    if request.path == "/api/health" or not request.path.startswith("/api/"):
        return None

    # 1) gateway token: only requests coming through the reverse proxy
    if GATEWAY_TOKEN and request.headers.get("X-Admin-Gateway", "") != GATEWAY_TOKEN:
        return jsonify(error="missing or invalid gateway token"), 403

    # 2) same-origin enforcement for state-changing requests
    if request.method in MUTATING:
        origin = request.headers.get("Origin")
        if origin:
            if urllib.parse.urlparse(origin).netloc != request.host:
                return jsonify(error="origin mismatch"), 403

    # 3) identity comes only from the forward-auth header chain
    ident = sanitize_identity(
        request.headers.get("X-Tinyauth-User") or request.headers.get("Remote-User"))
    if not ident:
        return jsonify(error="no identity: proxy did not forward Remote-User"), 401

    g.user = ident
    g.role = "admin" if ident in ADMIN_USERS else "self"
    return None


def require_admin():
    if getattr(g, "role", None) != "admin":
        return jsonify(error="admin role required", username=getattr(g, "user", None)), 403
    return None


# --------------------------------------------------------------------------
# routes
# --------------------------------------------------------------------------
@app.get("/api/health")
def health():
    return jsonify(status="ok")


@app.get("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.get("/api/me")
def me():
    return jsonify(username=g.user, role=g.role,
                   admin_configured=bool(ADMIN_USERS))


admin_bp = Blueprint("admin", __name__, url_prefix="/api/admin")
admin_bp.before_request(require_admin)


@admin_bp.get("/users")
def admin_users():
    params = session_params()
    users = read_users_file(params["users_file"])
    totals, actives = defaultdict(int), defaultdict(int)
    now = int(time.time())
    maxlife = params["session_max_lifetime"]
    with db_ro() as conn:
        for row in conn.execute("SELECT username, created_at, expiry FROM sessions"):
            exp = int(row["expiry"] or 0)
            created = int(row["created_at"] or 0)
            expired = exp <= now or (maxlife and created and (now - created) > maxlife)
            totals[row["username"]] += 1
            if not expired:
                actives[row["username"]] += 1
    for u in users:
        u["total_sessions"] = totals.get(u["username"], 0)
        u["active_sessions"] = actives.get(u["username"], 0)
    return jsonify(users=users)


@admin_bp.get("/sessions")
def admin_sessions():
    params = session_params()
    now = int(time.time())
    with db_ro() as conn:
        rows = conn.execute(
            "SELECT uuid, username, provider, totp_pending, name, email, "
            "oauth_name, oauth_groups, created_at, expiry "
            "FROM sessions ORDER BY username, created_at"
        ).fetchall()
    sessions = [dict(compute_session(r, now, params["session_expiry"],
                                     params["session_max_lifetime"])) for r in rows]
    return jsonify(now=now,
                   session_expiry=params["session_expiry"],
                   session_max_lifetime=params["session_max_lifetime"],
                   sessions=sessions)


@admin_bp.get("/image")
def admin_image():
    try:
        info = docker_get(f"/containers/{TINYAUTH_CONTAINER}/json")
    except Exception as exc:  # noqa: BLE001
        return jsonify(error=f"docker socket unavailable: {exc}"), 502

    labels = (info.get("Config") or {}).get("Labels") or {}
    project = labels.get("com.docker.compose.project", "")
    service = labels.get("com.docker.compose.service", "")
    compose_image, compose_err = portainer_compose_image(project, service)

    return jsonify(
        container_name=TINYAUTH_CONTAINER,
        container_image=(info.get("Config") or {}).get("Image"),
        compose_image=compose_image,
        compose_note=compose_err,
        match=(None if compose_image is None
               else compose_image == (info.get("Config") or {}).get("Image")),
        project=project,
        service=service,
        state=(info.get("State") or {}).get("Status"),
        health=((info.get("State") or {}).get("Health") or {}).get("Status"),
        created=(info.get("Created") or "")[:19].replace("T", " "),
    )


# register AFTER all admin routes are defined (blueprints snapshot their
# deferred routes at registration time)
app.register_blueprint(admin_bp)


@app.errorhandler(404)
def not_found(err):
    if request.path.startswith("/api/"):
        return jsonify(error="not found"), 404
    return err


@app.errorhandler(500)
def internal(err):
    return jsonify(error="internal server error"), 500


def main():
    port = int(os.environ.get("PORT", "8080"))
    app.run(host="0.0.0.0", port=port)


if __name__ == "__main__":
    main()
