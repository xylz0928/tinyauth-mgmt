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
import base64
import hashlib
import hmac
import http.client
import json
import logging
import os
import re
import secrets
import shutil
import socket
import sqlite3
import stat
import struct
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone

import bcrypt
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
# docker backend choice — the user decides:
#   auto     (default) -> Portainer API when PORTAINER_URL+TOKEN are set, else socket
#   socket              -> /var/run/docker.sock directly
#   portainer           -> Portainer API (requires PORTAINER_URL + PORTAINER_TOKEN)
DOCKER_BACKEND = os.environ.get("DOCKER_BACKEND", "auto").lower()
TINYAUTH_HEALTH_URL = os.environ.get("TINYAUTH_HEALTH_URL", "http://tinyauth:3002/api/healthz")
# cookie mode: where to validate session cookies (see _verify_session_with_tinyauth)
TINYAUTH_AUTH_URL = os.environ.get("TINYAUTH_AUTH_URL", "http://tinyauth:3002/api/auth/nginx")
# baked into the image at build time (--build-arg APP_VERSION=vX.Y)
APP_VERSION = os.environ.get("APP_VERSION", "")
# trusted NTP servers for the Stack "Time" card (SNTP/UDP123, tried in order)
NTP_SERVERS = [s.strip() for s in os.environ.get(
    "NTP_SERVERS", "time.windows.com,ntp.aliyun.com,pool.ntp.org").split(",") if s.strip()]

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


def _iso_epoch(value):
    """Docker API Created (ISO8601 / epoch) -> unix epoch seconds (int|None).

    The frontend formats all timestamps from epoch seconds (fmtTime), so the
    stack view's `created` must be an int — an ISO string rendered as an
    epoch produced NaN-NaN-NaN.
    """
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return int(value)
    try:
        s = str(value)
        if s.isdigit():
            return int(s)
        return int(datetime.fromisoformat(s[:19]).replace(tzinfo=timezone.utc).timestamp())
    except (ValueError, TypeError, OSError):
        return None


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


def docker_request(method, path):
    conn = _UnixHTTPConnection(DOCKER_SOCK)
    try:
        conn.request(method, path, headers={"Host": "localhost"})
        resp = conn.getresponse()
        body = resp.read()
    finally:
        conn.close()
    return resp.status, body


def docker_get(path):
    status, body = docker_request("GET", path)
    if status != 200:
        raise RuntimeError(f"docker api {path} -> {status}: {body[:200]!r}")
    return json.loads(body)


_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


def demux_docker_log(raw):
    """docker 非 tty 容器日志 =8字节帧流；tty 容器 = 裸文本。两种都兼容。"""
    if not raw:
        return b""
    if (len(raw) >=8 and raw[0] in (0, 1, 2)
            and raw[1:4] == b"\x00\x00\x00"):
        out = bytearray()
        i =0
        while i +8 <= len(raw):
            size = int.from_bytes(raw[i +4:i +8], "big")
            out += raw[i +8:i +8 + size]
            i +=8 + size
        return bytes(out)
    return raw


def parse_login_events(raw):
    """从 tinyauth 审计日志提取成功登录 -> [{ts, username, ip}]。

    审计流默认关闭，需要 tinyauth config: log.streams.audit.enabled=true。
    关联口径: username 相同且事件时间与 session.created_at 差 <=10s。
    """
    events = []
    text = _ANSI_RE.sub("", demux_docker_log(raw).decode("utf-8", "replace"))
    for line in text.splitlines():
        if "event=login" not in line or "result=success" not in line:
            continue
        m_ts = re.match(r"(\S+)", line)
        m_user = re.search(r"\busername=(\S+)", line)
        m_ip = re.search(r"\bip=(\S+)", line)
        if not (m_ts and m_user and m_ip):
            continue
        try:
            ts = int(datetime.fromisoformat(m_ts.group(1)).timestamp())
        except ValueError:
            continue
        events.append({"ts": ts, "username": m_user.group(1),
                       "ip": m_ip.group(1)})
    return events


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


def portainer_compose_image(api, project, service):
    """Cross-check the compose-declared image through the Portainer API."""
    try:
        stacks = api("/api/stacks")
        stack = next((s for s in stacks if s.get("Name") == project), None)
        if not stack:
            return None, f"no portainer stack named {project!r}"
        # Portainer2.45 no longer returns composeFile in the stack detail —
        # the file lives behind GET /api/stacks/{id}/file (StackFileContent)
        file_resp = api(f"/api/stacks/{stack['Id']}/file")
        text = file_resp.get("StackFileContent") or ""
        if not text:
            return None, "stack file empty/unavailable via portainer api"
        img = parse_service_image(text, service or "")
        if not img:
            return None, "image entry not found in compose file"
        return img, None
    except Exception as exc:  # noqa: BLE001
        return None, f"portainer api error: {exc}"


# --------------------------------------------------------------------------
# docker backend abstraction — the user picks one of two transports:
#   DOCKER_BACKEND=socket    -> /var/run/docker.sock directly
#   DOCKER_BACKEND=portainer -> Portainer API
# --------------------------------------------------------------------------
class BackendConfigError(RuntimeError):
    """Selected backend is not usable -> HTTP400."""


class SocketBackend:
    name = "socket"

    def inspect(self, container):
        return docker_get(f"/containers/{container}/json")

    def restart(self, container):
        status, body = docker_request("POST", f"/containers/{container}/restart?t=10")
        if status not in (200, 204):
            raise RuntimeError(f"docker restart -> {status}: {body[:200]!r}")

    def container_logs(self, container, since):
        status, body = docker_request(
            "GET",
            f"/containers/{container}/logs?since={since}"
            "&stdout=true&stderr=true")
        if status !=200:
            raise RuntimeError(f"docker logs -> {status}: {body[:200]!r}")
        return body

    def compose_image(self, project, service):
        return None, ("compose cross-check requires DOCKER_BACKEND=portainer "
                      "(a raw socket cannot read host compose files)")


class PortainerBackend:
    name = "portainer"

    def __init__(self):
        if not (PORTAINER_URL or PORTAINER_TOKEN):
            raise BackendConfigError(
                "DOCKER_BACKEND=portainer requires PORTAINER_URL and PORTAINER_TOKEN")
        if not (PORTAINER_URL and PORTAINER_TOKEN):
            raise BackendConfigError(
                "DOCKER_BACKEND=portainer needs both PORTAINER_URL and PORTAINER_TOKEN")
        self._ep = None

    def _api(self, path, method="GET", data=None):
        req = urllib.request.Request(
            PORTAINER_URL + path,
            data=(json.dumps(data).encode() if data is not None else None),
            headers={"X-API-Key": PORTAINER_TOKEN,
                     "Content-Type": "application/json"},
            method=method)
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else {}

    def _raw(self, path):
        """Raw (non-JSON) GET — docker logs is a byte stream."""
        req = urllib.request.Request(
            PORTAINER_URL + path,
            headers={"X-API-Key": PORTAINER_TOKEN})
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.read()

    def endpoint_id(self):
        if self._ep is not None:
            return self._ep
        endpoints = self._api("/api/endpoints")
        docker_eps = [e for e in endpoints if str(e.get("Type")) == "1"]
        want = os.environ.get("PORTAINER_ENDPOINT", "").strip()
        if want:
            match = next((e for e in docker_eps
                          if str(e.get("Id")) == want or e.get("Name") == want), None)
            if not match:
                raise BackendConfigError(f"portainer endpoint {want!r} not found")
        elif len(docker_eps) == 1:
            match = docker_eps[0]
        elif not docker_eps:
            raise BackendConfigError("no docker endpoint found in portainer")
        else:
            raise BackendConfigError(
                "multiple docker endpoints — set PORTAINER_ENDPOINT=<name-or-id>")
        self._ep = match["Id"]
        return self._ep

    def _docker(self, path, method="GET", data=None):
        return self._api(f"/api/endpoints/{self.endpoint_id()}/docker{path}",
                         method=method, data=data)

    def inspect(self, container):
        return self._docker(f"/containers/{container}/json")

    def container_logs(self, container, since):
        return self._raw(
            f"/api/endpoints/{self.endpoint_id()}/docker"
            f"/containers/{container}/logs"
            f"?since={since}&stdout=true&stderr=true")

    def restart(self, container):
        self._docker(f"/containers/{container}/restart?t=10", method="POST", data={})

    def compose_image(self, project, service):
        return portainer_compose_image(self._api, project, service)


def get_backend():
    mode = DOCKER_BACKEND
    if mode == "auto":
        mode = "portainer" if (PORTAINER_URL and PORTAINER_TOKEN) else "socket"
    if mode == "portainer":
        return PortainerBackend()
    if mode == "socket":
        if not os.path.exists(DOCKER_SOCK):
            raise BackendConfigError(
                f"docker socket {DOCKER_SOCK} not found — configure "
                "DOCKER_BACKEND=portainer or fix DOCKER_SOCK")
        return SocketBackend()
    raise BackendConfigError(
        f"unknown DOCKER_BACKEND={DOCKER_BACKEND!r} (use auto, socket or portainer)")


def poll_tinyauth_health(timeout=30):
    """Wait until tinyauth answers its health endpoint (used after restarts)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(TINYAUTH_HEALTH_URL, timeout=3) as resp:
                if resp.status == 200:
                    return True
        except Exception:  # noqa: BLE001
            pass
        time.sleep(1)
    return False


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


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never follow redirects — a login redirect must surface as its status."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_AUTH_OPENER = urllib.request.build_opener(_NoRedirect)


def _verify_session_with_tinyauth():
    """Validate THIS request's session cookie against tinyauth itself.

    Identity always comes from tinyauth's own answer (Remote-User), so forged
    identity headers are worthless. Returns (username, login_url, error).
    """
    proto = request.headers.get("X-Forwarded-Proto") or (
        "https" if request.is_secure else "http")
    host = request.headers.get("X-Forwarded-Host") or request.host
    original = f"{proto}://{host}{request.path}"
    if request.query_string:
        original += "?" + request.query_string.decode(errors="replace")
    req = urllib.request.Request(
        TINYAUTH_AUTH_URL,
        headers={
            "Cookie": request.headers.get("Cookie", ""),
            "X-Original-URL": original,
            "X-Original-Method": request.method,
            "X-Forwarded-Proto": proto,
        })
    try:
        with _AUTH_OPENER.open(req, timeout=5) as resp:
            status, hdrs = resp.status, resp.headers
    except urllib.error.HTTPError as exc:
        status, hdrs = exc.code, exc.headers
    except Exception as exc:  # noqa: BLE001
        return None, None, f"tinyauth auth endpoint unreachable: {exc}"
    if status == 200:
        user = sanitize_identity(hdrs.get("Remote-User"))
        if user:
            return user, None, None
        return None, None, "tinyauth accepted the session but sent no Remote-User"
    login = hdrs.get("X-Tinyauth-Location") or hdrs.get("Location")
    return None, login, None


@app.before_request
def _identity_chain():
    # only the API surface is gated; static shell assets (/, /css, /js) carry
    # no data — the frontend still needs them to render error states.
    if request.path == "/api/health" or not request.path.startswith("/api/"):
        return None

    # 1) same-origin enforcement for state-changing requests
    if request.method in MUTATING:
        origin = request.headers.get("Origin")
        if origin:
            if urllib.parse.urlparse(origin).netloc != request.host:
                return jsonify(error="origin mismatch"),403

    # 2) identity — two modes (see docs/security-model.md):
    #    GATEWAY_TOKEN set   -> gateway mode: the request MUST carry the shared
    #        secret (proves it came through our reverse proxy). Identity comes
    #        from the forwarded header when present; when the proxy does not
    #        forward it (e.g. it reads the wrong upstream header and the value
    #        arrives empty), fall back to validating the session cookie with
    #        tinyauth — a leaked token alone is then never enough to impersonate.
    #    GATEWAY_TOKEN unset -> cookie mode: identity headers are NEVER trusted;
    #        the session cookie is validated with tinyauth directly.
    if GATEWAY_TOKEN:
        if request.headers.get("X-Admin-Gateway", "") != GATEWAY_TOKEN:
            return jsonify(error="missing or invalid gateway token"),403

    # identity ALWAYS comes from a cookie validated with tinyauth — identity
    # headers are never trusted, so BOTH factors are required: a leaked
    # gateway token alone can not impersonate anyone, and a stolen identity
    # header without a real session is worthless.
    ident, login_url, err = _verify_session_with_tinyauth()
    if err:
        return jsonify(error=err),502
    if not ident:
        return jsonify(error="not authenticated", login_url=login_url),401

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
    return jsonify(status="ok", version=APP_VERSION)


@app.get("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.get("/api/me")
def me():
    has_totp = False
    try:
        for _, u, parts in _iter_entries(_read_text(users_file_path()).split("\n")):
            if u == g.user:
                has_totp = len(parts) >= 3 and bool(parts[2])
                break
    except OSError:
        pass  # degrade gracefully: account view shows "enable TOTP"
    return jsonify(username=g.user, role=g.role, has_totp=has_totp,
                   admin_configured=bool(ADMIN_USERS), version=APP_VERSION)


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
    # 每个 session 的登录来源 IP: 关联 tinyauth 审计流（登录成功事件）
    try:
        backend = get_backend()
        since = (min(s["created_at"] for s in sessions) -60
                 if sessions else int(time.time()) -60)
        events = parse_login_events(
            backend.container_logs(TINYAUTH_CONTAINER, since))
    except Exception:
        events = []
    for s in sessions:
        best = None
        for ev in events:
            if ev["username"] != s["username"]:
                continue
            delta = abs(ev["ts"] - s["created_at"])
            if delta <=10 and (best is None or delta < best[0]):
                best = (delta, ev)
        s["login_ip"] = best[1]["ip"] if best else None
    return jsonify(now=now,
                   session_expiry=params["session_expiry"],
                   session_max_lifetime=params["session_max_lifetime"],
                   sessions=sessions)


@admin_bp.get("/image")
def admin_image():
    try:
        backend = get_backend()
    except BackendConfigError as exc:
        return jsonify(error=str(exc)), 400
    try:
        info = backend.inspect(TINYAUTH_CONTAINER)
    except Exception as exc:  # noqa: BLE001
        return jsonify(error=f"container inspect failed: {exc}"), 502

    labels = (info.get("Config") or {}).get("Labels") or {}
    project = labels.get("com.docker.compose.project", "")
    service = labels.get("com.docker.compose.service", "")
    compose_image, compose_err = backend.compose_image(project, service)

    return jsonify(
        backend=backend.name,
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
        created=_iso_epoch(info.get("Created")),
    )


# --------------------------------------------------------------------------
# users-file operations — faithful port of the CLI's battle-tested semantics
# (atomic replace, .bak backup, post-check, $$ unescape, TOTP field handling)
# --------------------------------------------------------------------------
def users_file_path():
    configured = session_params()["users_file"]
    if os.path.exists(configured):
        return configured
    # Container layout safety net: the config may reference a path that only
    # exists inside the tinyauth container; we mount the same volume at
    # TINYAUTH_DATA_DIR, so fall back to the file's basename there
    # (same semantics as the CLI's TINYAUTH_DATA_DIR override).
    alt = os.path.join(DATA_DIR, os.path.basename(configured))
    if os.path.exists(alt):
        return alt
    return configured


def _read_text(path):
    with open(path, encoding="utf-8", errors="replace") as f:
        return f.read()


def _split_user_line(line):
    """-> (username, parts) with tinyauth's $$ unescape, or (None, None)."""
    s = line.replace("$$", "$") if "$$" in line else line
    parts = s.split(":", 2)
    if len(parts) < 2 or not parts[0].strip() or not parts[1].strip():
        return None, None
    return parts[0].strip(), [p.strip() for p in parts]


def _iter_entries(lines):
    """yield (index, username, parts) for real user lines (keeps raw others)."""
    for i, line in enumerate(lines):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        u, parts = _split_user_line(line)
        if u:
            yield i, u, parts


def _backup(path):
    shutil.copy2(path, path + ".bak")


def _atomic_write(path, text):
    mode = stat.S_IMODE(os.stat(path).st_mode)
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def validate_username(username):
    username = (username or "").strip()
    if not username:
        raise ValueError("username is empty")
    if len(username) > 64:
        raise ValueError("username too long (max 64)")
    if ":" in username:
        raise ValueError("username cannot contain ':'")
    if any(c.isspace() for c in username):
        raise ValueError("username cannot contain whitespace")
    return username


def hash_password(password):
    if not password or len(password) < 8:
        raise ValueError("password must be at least 8 characters")
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def add_user(username, password):
    username = validate_username(username)
    path = users_file_path()
    text = _read_text(path)
    if username in [u for _, u, _ in _iter_entries(text.split("\n"))]:
        raise ValueError(f"user {username!r} already exists")
    if text and not text.endswith("\n"):
        text += "\n"
    text += f"{username}:{hash_password(password)}\n"
    _backup(path)
    _atomic_write(path, text)
    if username not in [u for _, u, _ in _iter_entries(_read_text(path).split("\n"))]:
        raise RuntimeError("post-check failed: user not in file after append")
    return username


def set_password(username, password):
    path = users_file_path()
    lines = _read_text(path).split("\n")
    entries = list(_iter_entries(lines))
    if username not in [u for _, u, _ in entries]:
        raise KeyError(f"user {username!r} not found")
    new_hash = hash_password(password)
    for i, u, parts in entries:
        if u == username:
            rebuilt = f"{username}:{new_hash}"
            if len(parts) >= 3 and parts[2]:
                rebuilt += ":" + parts[2]     # preserve the TOTP field
            lines[i] = rebuilt
            break
    _backup(path)
    _atomic_write(path, "\n".join(lines))
    if new_hash not in _read_text(path):
        raise RuntimeError("post-check failed: password not updated")
    return username


def flush_sessions(username=None, uuid=None):
    if not os.path.exists(DB_PATH):
        raise FileNotFoundError(f"session db not found: {DB_PATH}")
    conn = sqlite3.connect(DB_PATH, timeout=5)
    try:
        if uuid is not None:
            cur = conn.execute("DELETE FROM sessions WHERE uuid = ?", (uuid,))
        elif username is None:
            cur = conn.execute("DELETE FROM sessions")
        else:
            cur = conn.execute("DELETE FROM sessions WHERE username = ?", (username,))
        conn.commit()
        return cur.rowcount
    finally:
        conn.close()


def delete_user(username):
    path = users_file_path()
    lines = _read_text(path).split("\n")
    entries = list(_iter_entries(lines))
    if username not in [u for _, u, _ in entries]:
        raise KeyError(f"user {username!r} not found")
    if len(entries) <= 1:
        raise ValueError("refusing to delete the last user (would lock everyone out)")
    target = next(i for i, u, _ in entries if u == username)
    del lines[target]
    _backup(path)
    _atomic_write(path, "\n".join(lines))
    if username in [u for _, u, _ in _iter_entries(_read_text(path).split("\n"))]:
        raise RuntimeError("post-check failed: user still in file")
    return flush_sessions(username)


# --------------------------------------------------------------------------
# TOTP — secrets are plain base32, verification is RFC6238 ±1 window
# (same behavior as tinyauth's totp.Validate)
# --------------------------------------------------------------------------
def totp_generate_secret():
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def totp_url(username, secret):
    return (f"otpauth://totp/Tinyauth:{username}?secret={secret}"
            f"&issuer=Tinyauth&algorithm=SHA1&digits=6&period=30")


def totp_verify(secret, code):
    code = (code or "").strip()
    if not secret or not code.isdigit():
        return False
    try:
        key = base64.b32decode(secret.upper() + "=" * ((8 - len(secret) % 8) % 8))
    except Exception:  # noqa: BLE001
        return False
    counter_now = int(time.time()) // 30
    for counter in (counter_now - 1, counter_now, counter_now + 1):
        if counter < 0:
            continue
        digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
        offset = digest[19] & 0xF
        value = (struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF) % 1000000
        if f"{value:06d}" == code:
            return True
    return False


def set_totp(username, action, secret=None, code=None):
    path = users_file_path()
    lines = _read_text(path).split("\n")
    entries = list(_iter_entries(lines))
    entry = next(((i, p) for i, u, p in entries if u == username), None)
    if entry is None:
        raise KeyError(f"user {username!r} not found")
    idx, parts = entry
    has_totp = len(parts) >= 3 and bool(parts[2])

    if action == "remove":
        if not has_totp:
            raise ValueError(f"user {username!r} has no TOTP to remove")
        lines[idx] = f"{username}:{parts[1]}"
    elif action in ("enable", "rebind"):
        if action == "enable" and has_totp:
            raise ValueError(f"user {username!r} already has TOTP — use rebind")
        if action == "rebind" and not has_totp:
            raise ValueError(f"user {username!r} has no TOTP — use enable first")
        if secret is None:
            return {"phase": "verify", "action": action}   # generate phase, no write
        if not totp_verify(secret, code):
            raise ValueError("TOTP code incorrect — nothing saved")
        lines[idx] = f"{username}:{parts[1]}:{secret}"
    else:
        raise ValueError("action must be enable, rebind or remove")

    _backup(path)
    _atomic_write(path, "\n".join(lines))

    after = list(_iter_entries(_read_text(path).split("\n")))
    aparts = next((p for _, u, p in after if u == username), None)
    if aparts is None:
        raise RuntimeError("post-check failed: user vanished from file")
    if action == "remove" and len(aparts) >= 3 and aparts[2]:
        raise RuntimeError("post-check failed: TOTP still present")
    if action in ("enable", "rebind") and not (len(aparts) >= 3 and aparts[2]):
        raise RuntimeError("post-check failed: TOTP not saved")
    return {"saved": True, "action": action}


# --------------------------------------------------------------------------
# restart-after-change (tinyauth loads the users file only at startup)
# --------------------------------------------------------------------------
def after_user_change():
    try:
        backend = get_backend()
        backend.restart(TINYAUTH_CONTAINER)
    except Exception as exc:  # noqa: BLE001 - file change stays, report honestly
        return False, str(exc)
    if poll_tinyauth_health():
        return True, None
    return False, "restarted but health endpoint did not answer in time"


def handle_totp(username, body):
    """Shared TOTP flow for admin and self-service routes."""
    action = body.get("action")
    if action not in ("enable", "rebind", "remove"):
        return jsonify(error="action must be enable, rebind or remove"), 400
    secret = body.get("secret")
    code = body.get("code")
    try:
        if action == "remove":
            set_totp(username, "remove")
        elif secret:
            set_totp(username, action, secret=secret, code=code)
        else:
            set_totp(username, action)          # precondition check only
            new_secret = totp_generate_secret()
            return jsonify(ok=True, phase="verify", action=action,
                           username=username, secret=new_secret,
                           otpauth=totp_url(username, new_secret))
    except KeyError as exc:
        return jsonify(error=str(exc.args[0])), 404
    except (ValueError, RuntimeError) as exc:
        return jsonify(error=str(exc)), 400

    restart_ok, restart_err = after_user_change()
    return jsonify(ok=True, phase="saved", action=action, username=username,
                   restart_ok=restart_ok, restart_error=restart_err)


# ---- admin mutations ----

@admin_bp.post("/users")
def create_user():
    body = request.get_json(silent=True) or {}
    try:
        username = add_user(body.get("username", ""), body.get("password", ""))
    except (ValueError, RuntimeError) as exc:
        return jsonify(error=str(exc)), 400
    restart_ok, restart_err = after_user_change()
    return jsonify(ok=True, username=username,
                   restart_ok=restart_ok, restart_error=restart_err)


@admin_bp.post("/users/<username>/password")
def change_password(username):
    body = request.get_json(silent=True) or {}
    try:
        set_password(username, body.get("password", ""))
    except KeyError as exc:
        return jsonify(error=str(exc.args[0])), 404
    except (ValueError, RuntimeError) as exc:
        return jsonify(error=str(exc)), 400
    restart_ok, restart_err = after_user_change()
    return jsonify(ok=True, username=username,
                   restart_ok=restart_ok, restart_error=restart_err)


@admin_bp.post("/users/<username>/totp")
def admin_user_totp(username):
    return handle_totp(username, request.get_json(silent=True) or {})


@admin_bp.delete("/users/<username>")
def remove_user(username):
    try:
        flushed = delete_user(username)
    except KeyError as exc:
        return jsonify(error=str(exc.args[0])), 404
    except (ValueError, RuntimeError) as exc:
        return jsonify(error=str(exc)), 400
    restart_ok, restart_err = after_user_change()
    return jsonify(ok=True, username=username, sessions_flushed=flushed,
                   restart_ok=restart_ok, restart_error=restart_err)


@admin_bp.post("/flush")
def flush_sessions_route():
    body = request.get_json(silent=True) or {}
    try:
        if body.get("all") is True:
            removed = flush_sessions(None)
            scope = "all"
        else:
            target_uuid = (body.get("uuid") or "").strip()
            if target_uuid:
                removed = flush_sessions(uuid=target_uuid)
                scope = target_uuid
            else:
                target = (body.get("username") or "").strip()
                if not target:
                    return jsonify(error="provide username or all=true"), 400
                removed = flush_sessions(target)
                scope = target
    except FileNotFoundError as exc:
        return jsonify(error=str(exc)), 500
    return jsonify(ok=True, scope=scope, removed=removed)


@admin_bp.post("/restart")
def restart_container():
    body = request.get_json(silent=True) or {}
    if body.get("scope", "container") != "container":
        return jsonify(error="only scope=container is supported"), 400
    try:
        backend = get_backend()
    except BackendConfigError as exc:
        return jsonify(error=str(exc)), 400
    started = time.time()
    try:
        backend.restart(TINYAUTH_CONTAINER)
    except Exception as exc:  # noqa: BLE001
        return jsonify(error=f"restart failed: {exc}", backend=backend.name), 502
    healthy = poll_tinyauth_health()
    return jsonify(ok=True, backend=backend.name, healthy=healthy,
                   waited_s=round(time.time() - started, 1),
                   warning=(None if healthy else
                            "container restarted but health check has not passed yet"))


# ---- time sources (Stack "Time" card): browser | NTP | tinyauth | self ----
_NTP_CACHE = {"at": 0.0, "payload": None}


def _sntp_query(server, timeout=2.0):
    """Minimal SNTP client (RFC5905 client mode, no dependencies)."""
    addr = socket.getaddrinfo(server, 123, socket.AF_INET, socket.SOCK_DGRAM)[0][4]
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.settimeout(timeout)
        t0 = time.time()
        sock.sendto(b"\x1b" + b"\x00" * 47, addr)   # LI=0 VN=4 Mode=3 (client)
        data, _ = sock.recvfrom(48)
        t1 = time.time()
    finally:
        sock.close()
    if len(data) < 48:
        raise RuntimeError("short SNTP reply")
    secs = struct.unpack("!I", data[40:44])[0]
    frac = struct.unpack("!I", data[44:48])[0]
    unix = secs + frac / 2**32 -2208988800
    if abs(unix - (t0 + t1) / 2) > 86400:
        raise RuntimeError("implausible server time")
    return unix


def _ntp_time():
    now = time.time()
    cached = _NTP_CACHE["payload"]
    if cached:
        ttl = 60 if cached.get("epoch") is not None else 30
        age = now - _NTP_CACHE["at"]
        if age < ttl:
            out = dict(cached)
            out["age"] = round(age,1)
            if out.get("epoch") is not None:
                # project the cached reading forward so callers always see
                # "NTP time NOW", never a stale snapshot (otherwise every
                # refresh would show a fake drift up to the cache TTL)
                out["epoch"] = round(out["epoch"] + age,3)
            return out
    last_err = "no NTP servers configured"
    for srv in NTP_SERVERS:
        try:
            payload = {"epoch": round(_sntp_query(srv),3), "server": srv,
                       "error": None, "age":0}
            _NTP_CACHE.update(at=now, payload=payload)
            return dict(payload)
        except Exception as exc:  # noqa: BLE001
            last_err = f"{srv}: {exc}"
    payload = {"epoch": None, "server": None, "error": last_err, "age": 0}
    _NTP_CACHE.update(at=now, payload=payload)
    return dict(payload)


def _tinyauth_time():
    """tinyauth's own clock = the Date header of any of its HTTP responses."""
    try:
        with urllib.request.urlopen(TINYAUTH_HEALTH_URL, timeout=4) as resp:
            date_hdr = resp.headers.get("Date")
        from email.utils import parsedate_to_datetime
        epoch = parsedate_to_datetime(date_hdr).timestamp()
        return {"epoch": round(epoch,3), "source": TINYAUTH_HEALTH_URL, "error": None}
    except Exception as exc:  # noqa: BLE001
        return {"epoch": None, "source": TINYAUTH_HEALTH_URL, "error": str(exc)}


def _backend_time():
    return {"epoch": round(time.time(),3),
            "tz": (time.tzname[0] if time.tzname else ""),
            "local": datetime.now().strftime("%F %T"),
            "error": None}


def _display_tz_info():
    """(IANA timezone, source) the Time card must render everything in.

    Priority: TZ env (what the operator configured in compose) -> the
    /etc/localtime symlink (read-only host mount) -> raw TZ -> UTC.
    Never hardcoded — other deployments set their own TZ.
    """
    tz = os.environ.get("TZ", "").lstrip(":")
    if tz and "/" in tz:
        return tz, "TZ env"
    try:
        target = os.readlink("/etc/localtime")
        marker = "/usr/share/zoneinfo/"
        if marker in target:
            return target.split(marker,1)[1], "/etc/localtime"
    except OSError:
        pass
    return (tz or "UTC"), ("TZ env" if tz else "default")


@admin_bp.get("/time")
def admin_time():
    tz, tz_source = _display_tz_info()
    return jsonify(backend=_backend_time(), tinyauth=_tinyauth_time(),
                   ntp=_ntp_time(), display_tz=tz, display_tz_source=tz_source,
                   generated_at=round(time.time(),3))


# ---- self-service (username is ALWAYS taken from the identity chain) ----
self_bp = Blueprint("self", __name__, url_prefix="/api/me")


@self_bp.post("/password")
def self_password():
    body = request.get_json(silent=True) or {}
    try:
        set_password(g.user, body.get("password", ""))
    except (ValueError, RuntimeError) as exc:
        return jsonify(error=str(exc)), 400
    restart_ok, restart_err = after_user_change()
    return jsonify(ok=True, username=g.user,
                   restart_ok=restart_ok, restart_error=restart_err)


@self_bp.post("/totp")
def self_totp():
    return handle_totp(g.user, request.get_json(silent=True) or {})


# register AFTER all admin routes are defined (blueprints snapshot their
# deferred routes at registration time)
app.register_blueprint(admin_bp)
app.register_blueprint(self_bp)


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
