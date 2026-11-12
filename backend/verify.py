#!/usr/bin/env python3
"""tinyauth-mgmt verification suite (milestones1 +2).

Runs several gunicorn instances against synthetic fixtures and asserts the
identity chain / role model / read-only APIs / mutation APIs / backend
selection over real HTTP:
    python3 verify.py        (uses a python with flask+gunicorn installed)
"""
import base64
import hashlib
import hmac
import json
import os
import re
import shutil
import sqlite3
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BACKEND = os.path.join(REPO, "backend")
BASE = "/tmp/tm-verify"
GW = {"X-Admin-Gateway": "s3cret"}
PORT1, PORT2 = "18099", "18100"
PORT_MUT, PORT_CFG, PORT_CK = "18101", "18102", "18103"
MOCK_PORT = "18098"
MOCK_LOGIN = "http://tinyauth.test/login"

failures = []


def t(name, cond, detail=""):
    if cond:
        print(f"PASS  {name}")
    else:
        print(f"FAIL  {name}  {detail}")
        failures.append(name)


def req(port, path, headers=None, method="GET", data=None, origin=None):
    url = f"http://127.0.0.1:{port}{path}"
    body = None
    hdrs = dict(headers or {})
    if origin:
        hdrs["Origin"] = origin
    # gateway-mode instances validate identity via the session cookie (the mock
    # auth echoes tm_user=<name> as Remote-User), so synthesize that cookie from
    # the identity header the test intended — unless the test already sends one.
    if "X-Admin-Gateway" in hdrs and "Cookie" not in hdrs:
        intended = hdrs.get("Remote-User") or hdrs.get("X-Tinyauth-User") or ""
        if re.fullmatch(r"\w+", intended):
            hdrs["Cookie"] = "tm_user=" + intended
    if data is not None:
        body = json.dumps(data).encode()
        hdrs["Content-Type"] = "application/json"
    r = urllib.request.Request(url, data=body, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(r, timeout=5) as resp:
            raw = resp.read().decode()
            try:
                return resp.status, json.loads(raw) if raw else {}
            except Exception:
                return resp.status, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, (json.loads(raw) if raw else {})
        except Exception:
            return e.code, {"raw": raw[:200]}
    except Exception as e:  # noqa: BLE001
        return 0, {"error": str(e)}


def wait_health(port, tries=40):
    for _ in range(tries):
        st, body = req(port, "/api/health")
        if st == 200 and body.get("status") == "ok":
            return True
        time.sleep(0.25)
    return False


class MockAuth(BaseHTTPRequestHandler):
    """Stand-in for tinyauth's /api/auth/nginx.
    Cookie tm_user=<name> ->200 + Remote-User header; otherwise401 + login URL."""
    def do_GET(self):
        m = re.search(r"tm_user=(\w+)", self.headers.get("Cookie", ""))
        if m:
            self.send_response(200)
            self.send_header("Remote-User", m.group(1))
            self.end_headers()
        else:
            self.send_response(401)
            self.send_header("X-Tinyauth-Location", MOCK_LOGIN)
            self.end_headers()

    def log_message(self, *args):
        pass


def start_mock_auth():
    httpd = HTTPServer(("127.0.0.1", int(MOCK_PORT)), MockAuth)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def write_fixtures():
    shutil.rmtree(BASE, ignore_errors=True)
    os.makedirs(BASE)
    with open(os.path.join(BASE, "tinyauth-config.yaml"), "w") as f:
        f.write(
            "auth:\n"
            "    sessionExpiry: 14400\n"
            "    sessionMaxLifetime: 28800\n"
            f"    usersFile: {BASE}/tinyauth-users\n"
        )
    with open(os.path.join(BASE, "tinyauth-users"), "w") as f:
        f.write(
            "admin:$2a$10$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUV123456\n"
            "other:$2a$10$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUV123456:JBSWY3DPEHPK3PXP\n"
            "doubled:$2a$10$aa$$bb\n"          # $$ unescape must not break parsing
            "# comment line\n"
        )
    db = os.path.join(BASE, "tinyauth.db")
    conn = sqlite3.connect(db)
    conn.execute(
        "CREATE TABLE sessions ("
        "uuid TEXT NOT NULL PRIMARY KEY UNIQUE, username TEXT NOT NULL, "
        "email TEXT NOT NULL, name TEXT NOT NULL, provider TEXT NOT NULL, "
        "totp_pending BOOLEAN NOT NULL, oauth_groups TEXT NULL, "
        "expiry INTEGER NOT NULL, oauth_name TEXT, oauth_sub TEXT, "
        "created_at INTEGER NOT NULL DEFAULT 0)")
    now = int(time.time())
    rows = [
        # active
        ("u-admin-1", "admin", "admin@example.com", "Admin", "local", 0, None,
         now + 3000, None, None, now - 1000),
        # expired
        ("u-admin-2", "admin", "admin@example.com", "Admin", "local", 0, None,
         now - 100, None, None, now - 4000),
        # active + mfa pending + slid (renewed flag)
        ("u-admin-3", "admin", "admin@example.com", "Admin", "local", 1, None,
         now + 2000, None, None, now - 16000),
        # beyond sessionMaxLifetime -> max-lifetime + groups flag
        ("u-admin-4", "admin", "admin@example.com", "Admin", "local", 0, "admin,users",
         now + 5000, None, None, now - 30000),
        # other user, active
        ("u-other-1", "other", "other@example.com", "Other", "local", 0, None,
         now + 1800, None, None, now - 200),
    ]
    conn.executemany("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?)", rows)
    conn.commit()
    conn.close()


def start_server(port, admin_users, extra_env=None):
    env = dict(os.environ)
    env.update({
        "TINYAUTH_DATA_DIR": BASE,
        "ADMIN_USERS": admin_users,
        "GATEWAY_TOKEN": "s3cret",
        "LOG_LEVEL": "WARNING",
        "TINYAUTH_AUTH_URL": f"http://127.0.0.1:{MOCK_PORT}/api/auth/nginx",
        "APP_VERSION": "0.0-test",
    })
    if extra_env:
        env.update(extra_env)
    p = subprocess.Popen(
        [sys.executable, "-m", "gunicorn", "-b", f"127.0.0.1:{port}",
         "--workers", "1", "--access-logfile", os.devnull, "app:app"],
        cwd=BACKEND, env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if not wait_health(port):
        p.terminate()
        raise SystemExit(f"server on {port} did not come up")
    return p


def main():
    write_fixtures()
    # s1 also exercises the FULL portainer backend path (inspect + stacks +
    # /file) when a local Portainer key is available (the DHost test host)
    pt = ""
    try:
        for line in open("/root/.portainer_key"):
            if line.startswith("ptr_"):
                pt = line.strip()
                break
    except OSError:
        pass
    mock = start_mock_auth()
    s1 = start_server(PORT1, "admin",
                      {"PORTAINER_URL": "http://127.0.0.1:9000",
                       "PORTAINER_TOKEN": pt} if pt else None)
    s2 = None
    s_mut = None
    s_cfg = None
    s_ck = None
    try:
        id_admin = {"Remote-User": "admin", **GW}
        id_other = {"X-Tinyauth-User": "other", **GW}

        # --- health & static ---
        st, b = req(PORT1, "/api/health")
        t("health open (no auth)", st == 200 and b.get("status") == "ok"
          and b.get("version") == "0.0-test", f"{st} {b}")
        st, b = req(PORT1, "/")
        t("index html served", st == 200 and "tinyauth-mgmt" in b if isinstance(b, str) else False)
        st, b = req(PORT1, "/css/tokens.css")
        t("static css served", st == 200 and "--primary-color-high" in b if isinstance(b, str) else False)

        # --- identity chain ---
        st, b = req(PORT1, "/api/me", GW)
        t("gateway ok but no identity -> 401", st == 401, f"{st} {b}")
        st, b = req(PORT1, "/api/me", {**GW, "Cookie": "tm_user=admin"})
        t("mode C: gateway ok + empty identity header -> cookie fallback -> admin",
          st == 200 and b.get("role") == "admin" and b.get("username") == "admin",
          f"{st} {b}")
        st, b = req(PORT1, "/api/me", {"Remote-User": "admin"})          # no gateway
        t("missing gateway token -> 403", st == 403, f"{st} {b}")
        st, b = req(PORT1, "/api/me", {"Remote-User": "admin", "X-Admin-Gateway": "wrong"})
        t("wrong gateway token -> 403", st == 403, f"{st} {b}")
        st, b = req(PORT1, "/api/me", id_admin)
        t("admin identity -> role admin", st == 200 and b.get("role") == "admin"
          and b.get("username") == "admin" and "has_totp" in b, f"{st} {b}")
        st, b = req(PORT1, "/api/me", id_other)
        t("other identity -> role self", st == 200 and b.get("role") == "self"
          and b.get("username") == "other", f"{st} {b}")
        st, b = req(PORT1, "/api/me", {"Remote-User": "admin\tInjected", **GW})
        t("control char in identity -> 401 (sanitized)", st == 401, f"{st} {b}")
        st, b = req(PORT1, "/api/me", id_admin, method="POST",
                    origin="http://evil.example")
        t("cross-origin POST -> 403", st == 403 and "origin" in str(b), f"{st} {b}")

        # --- role gating ---
        st, b = req(PORT1, "/api/admin/users", id_other)
        t("self cannot call admin api -> 403", st == 403, f"{st} {b}")
        st, b = req(PORT1, "/api/admin/nope", id_admin)
        t("unknown api -> 404 json (admin)", st == 404 and "error" in b, f"{st} {b}")

        # --- read: users ---
        st, b = req(PORT1, "/api/admin/users", id_admin)
        t("admin users -> 200", st == 200, f"{st} {b}")
        users = {u["username"]: u for u in b.get("users", [])}
        t("users parsed (admin/other/doubled, comment skipped)",
          set(users) == {"admin", "other", "doubled"}, f"{list(users)}")
        t("admin counts: total=4 active=2",
          users.get("admin", {}).get("total_sessions") == 4
          and users.get("admin", {}).get("active_sessions") == 2,
          f"{users.get('admin')}")
        t("other has_totp=true, total=1 active=1",
          users.get("other", {}).get("has_totp") is True
          and users.get("other", {}).get("total_sessions") == 1
          and users.get("other", {}).get("active_sessions") == 1,
          f"{users.get('other')}")

        # --- read: sessions ---
        st, b = req(PORT1, "/api/admin/sessions", id_admin)
        t("admin sessions -> 200", st == 200, f"{st} {b}")
        by_id = {s["uuid"]: s for s in b.get("sessions", [])}
        t("all5 sessions returned", len(by_id) == 5, f"{len(by_id)}")
        t("u-admin-1 active", by_id.get("u-admin-1", {}).get("status") == "active")
        t("u-admin-2 expired", by_id.get("u-admin-2", {}).get("status") == "expired")
        s3 = by_id.get("u-admin-3", {})
        t("u-admin-3 active + mfa-pending + renewed flag",
          s3.get("status") == "active" and "mfa-pending" in s3.get("flags", [])
          and any(f.startswith("renewed") for f in s3.get("flags", [])), f"{s3}")
        s4 = by_id.get("u-admin-4", {})
        t("u-admin-4 max-lifetime + groups flag",
          s4.get("status") == "max-lifetime" and "groups:admin,users" in s4.get("flags", []),
          f"{s4}")
        t("other user's session present",
          by_id.get("u-other-1", {}).get("username") == "other")
        t("session_expiry meta =14400", b.get("session_expiry") == 14400, f"{b.get('session_expiry')}")

        # --- read: image (real docker socket on a docker host, or graceful 502) ---
        st, b = req(PORT1, "/api/admin/image", id_admin)
        if st == 200:
            t("image endpoint returns real container info",
              "tinyauth" in str(b.get("container_image")) and b.get("state") == "running",
              f"{st} {b}")
            t("compose image parsed via portainer /file endpoint",
              isinstance(b.get("compose_image"), str)
              and "tinyauth" in b.get("compose_image", ""), f"{st} {b}")
            t("created is an epoch int (frontend fmtTime input)",
              isinstance(b.get("created"), int) and b.get("created") > 10**9, f"{st} {b}")
        else:
            t("image endpoint graceful 502 without socket",
              st == 502 and "error" in b, f"{st} {b}")

        # --- compose parser unit tests (pure function, no server needed) ---
        sys.path.insert(0, BACKEND)
        import app as appmod
        sample = ('version: "3.8"\n\nservices:\n  tinyauth:\n'
                  "    image: ghcr.io/tinyauthapp/tinyauth:v5.2.0\n"
                  "    restart: unless-stopped\n"
                  "  other:\n    image: nginx:1.27\n")
        t("parser: standard compose block",
          appmod.parse_service_image(sample, "tinyauth")
          == "ghcr.io/tinyauthapp/tinyauth:v5.2.0")
        t("parser: quoted image value",
          appmod.parse_service_image('services:\n  a:\n    image: "repo/app:1.0"\n', "a")
          == "repo/app:1.0")
        t("parser: missing service -> None",
          appmod.parse_service_image(sample, "ghost") is None)
        t("parser: trailing comment ignored",
          appmod.parse_service_image("services:\n  a:\n    image: app:1 # pin\n", "a")
          == "app:1")

        # ============ milestone 2: mutations ============
        # TINYAUTH_CONTAINER points at a non-existent container so restarts
        # can NEVER touch the real tinyauth running on this host.
        s_mut = start_server(PORT_MUT, "admin", {
            "DOCKER_BACKEND": "socket",
            "TINYAUTH_CONTAINER": "tm-no-such-container",
        })
        id_m = {"Remote-User": "admin", **GW}
        id_mo = {"X-Tinyauth-User": "other", **GW}
        users_path = os.path.join(BASE, "tinyauth-users")

        def read_users_text():
            with open(users_path, encoding="utf-8") as f:
                return f.read()

        def user_line(prefix):
            for line in read_users_text().splitlines():
                if line.startswith(prefix + ":"):
                    return line
            return None

        def db_count():
            conn = sqlite3.connect(os.path.join(BASE, "tinyauth.db"))
            try:
                return conn.execute("SELECT count(*) FROM sessions").fetchone()[0]
            finally:
                conn.close()

        def totp_code(secret, offset=0):
            key = base64.b32decode(secret + "=" * ((8 - len(secret) % 8) % 8))
            counter = int(time.time()) // 30 - offset
            d = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
            o = d[19] & 0xF
            return "%06d" % ((struct.unpack(">I", d[o:o+4])[0] & 0x7FFFFFFF) % 1000000)

        # --- self-service: anti-escalation (body username must be ignored) ---
        admin_before = user_line("admin")
        other_before = user_line("other")
        st, b = req(PORT_MUT, "/api/me/password", id_mo, method="POST",
                    data={"username": "admin", "password": "pwned-hacked-1"})
        t("self password ignores body username (anti-escalation)",
          st == 200 and user_line("admin") == admin_before
          and user_line("other").split(":")[1] != other_before.split(":")[1],
          f"{st} {b}")

        # --- self totp: enable-when-present guard + rebind + remove ---
        st, b = req(PORT_MUT, "/api/me/totp", id_mo, method="POST",
                    data={"action": "enable"})
        t("self totp enable when already present -> 400 rebind hint",
          st == 400 and "rebind" in str(b), f"{st} {b}")
        st, b = req(PORT_MUT, "/api/me/totp", id_mo, method="POST",
                    data={"action": "rebind"})
        t("self totp rebind returns verify phase",
          st == 200 and b.get("phase") == "verify" and b.get("secret"),
          f"{st} {b}")
        other_secret = b.get("secret", "")
        st, b = req(PORT_MUT, "/api/me/totp", id_mo, method="POST",
                    data={"action": "rebind", "secret": other_secret,
                          "code": totp_code(other_secret)})
        t("self totp rebind commit saves new secret",
          st == 200 and b.get("phase") == "saved"
          and user_line("other").split(":")[2] == other_secret, f"{st} {b}")
        st, b = req(PORT_MUT, "/api/me/totp", id_mo, method="POST",
                    data={"action": "remove"})
        t("self totp remove -> two fields",
          st == 200 and len(user_line("other").split(":")) == 2, f"{st} {b}")

        # --- admin: add user (+ validations) ---
        st, b = req(PORT_MUT, "/api/admin/users", id_m, method="POST",
                    data={"username": "newbie", "password": "Secret123!"})
        t("add user ok + restart fails gracefully (fake container)",
          st == 200 and b.get("ok") and b.get("restart_ok") is False
          and bool(b.get("restart_error")), f"{st} {b}")
        nb = user_line("newbie")
        t("newbie written with $2b$ bcrypt hash",
          bool(nb) and nb.split(":")[1].startswith("$2b$"), str(nb))
        st, b = req(PORT_MUT, "/api/admin/users", id_m, method="POST",
                    data={"username": "newbie", "password": "Another999"})
        t("duplicate add -> 400", st == 400, f"{st} {b}")
        st, b = req(PORT_MUT, "/api/admin/users", id_m, method="POST",
                    data={"username": "bad:name", "password": "Another999"})
        t("colon username -> 400", st == 400, f"{st} {b}")
        st, b = req(PORT_MUT, "/api/admin/users", id_m, method="POST",
                    data={"username": "weaky", "password": "short"})
        t("weak password -> 400", st == 400, f"{st} {b}")

        # --- admin: totp enable (generate -> wrong code -> good code) ---
        st, b = req(PORT_MUT, "/api/admin/users/newbie/totp", id_m, method="POST",
                    data={"action": "enable"})
        t("totp enable -> verify phase with secret+otpauth",
          st == 200 and b.get("phase") == "verify" and b.get("secret")
          and "otpauth://" in str(b.get("otpauth")), f"{st} {b}")
        nb_secret = b.get("secret", "")
        wrong = "000000" if totp_code(nb_secret) != "000000" else "111111"
        st, b = req(PORT_MUT, "/api/admin/users/newbie/totp", id_m, method="POST",
                    data={"action": "enable", "secret": nb_secret, "code": wrong})
        t("totp wrong code -> 400, nothing saved",
          st == 400 and len(user_line("newbie").split(":")) == 2, f"{st} {b}")
        st, b = req(PORT_MUT, "/api/admin/users/newbie/totp", id_m, method="POST",
                    data={"action": "enable", "secret": nb_secret,
                          "code": totp_code(nb_secret)})
        t("totp good code -> saved (3rd field)",
          st == 200 and b.get("phase") == "saved"
          and user_line("newbie").split(":")[2] == nb_secret, f"{st} {b}")

        # --- admin: password change keeps totp field ---
        st, b = req(PORT_MUT, "/api/admin/users/newbie/password", id_m, method="POST",
                    data={"password": "NewPass9999"})
        nb_parts = user_line("newbie").split(":")
        t("password change keeps totp field",
          st == 200 and len(nb_parts) == 3 and nb_parts[2] == nb_secret
          and nb_parts[1].startswith("$2b$"), f"{st} {b} {nb_parts}")

        # --- admin: totp guards + rebind + remove ---
        st, b = req(PORT_MUT, "/api/admin/users/newbie/totp", id_m, method="POST",
                    data={"action": "enable"})
        t("enable on existing totp -> 400 with rebind hint",
          st == 400 and "rebind" in str(b), f"{st} {b}")
        st, b = req(PORT_MUT, "/api/admin/users/newbie/totp", id_m, method="POST",
                    data={"action": "rebind"})
        nb_secret2 = b.get("secret", "")
        st, b = req(PORT_MUT, "/api/admin/users/newbie/totp", id_m, method="POST",
                    data={"action": "rebind", "secret": nb_secret2,
                          "code": totp_code(nb_secret2)})
        t("rebind replaces the secret",
          st == 200 and nb_secret2 and nb_secret2 != nb_secret
          and user_line("newbie").split(":")[2] == nb_secret2, f"{st} {b}")
        st, b = req(PORT_MUT, "/api/admin/users/newbie/totp", id_m, method="POST",
                    data={"action": "remove"})
        t("totp remove -> back to two fields",
          st == 200 and len(user_line("newbie").split(":")) == 2, f"{st} {b}")

        # --- flush ---
        st, b = req(PORT_MUT, "/api/admin/flush", id_m, method="POST",
                    data={"username": "admin"})
        t("flush one user -> removed4, db has other's1 left",
          st == 200 and b.get("removed") == 4 and db_count() == 1,
          f"{st} {b} count={db_count()}")
        st, b = req(PORT_MUT, "/api/admin/flush", id_m, method="POST",
                    data={"all": True})
        t("flush all -> removed1, db empty",
          st == 200 and b.get("removed") == 1 and db_count() == 0, f"{st} {b}")
        st, b = req(PORT_MUT, "/api/admin/flush", id_m, method="POST", data={})
        t("flush without target -> 400", st == 400, f"{st} {b}")

        # --- delete users + last-user guard ---
        st, b = req(PORT_MUT, "/api/admin/users/newbie", id_m, method="DELETE")
        t("delete user ok (file gone, restart fails gracefully)",
          st == 200 and b.get("ok") and user_line("newbie") is None
          and b.get("restart_ok") is False, f"{st} {b}")
        st, b = req(PORT_MUT, "/api/admin/users/doubled", id_m, method="DELETE")
        t("delete $$-user ok", st == 200 and user_line("doubled") is None, f"{st} {b}")
        st, b = req(PORT_MUT, "/api/admin/users/other", id_m, method="DELETE")
        t("delete other ok", st == 200 and user_line("other") is None, f"{st} {b}")
        st, b = req(PORT_MUT, "/api/admin/users/admin", id_m, method="DELETE")
        t("last-user guard -> 400, admin kept",
          st == 400 and "last user" in str(b) and user_line("admin") is not None,
          f"{st} {b}")
        st, b = req(PORT_MUT, "/api/admin/users/ghost", id_m, method="DELETE")
        t("delete unknown -> 404", st == 404, f"{st} {b}")

        # --- restart endpoint (socket backend, fake container ->502) ---
        st, b = req(PORT_MUT, "/api/admin/restart", id_m, method="POST", data={})
        t("restart via socket backend fails safe on missing container",
          st == 502 and "restart failed" in str(b) and b.get("backend") == "socket",
          f"{st} {b}")

        # --- backend selection: portainer without config ->400 ---
        s_cfg = start_server(PORT_CFG, "admin", {"DOCKER_BACKEND": "portainer"})
        st, b = req(PORT_CFG, "/api/admin/restart", id_m, method="POST", data={})
        t("DOCKER_BACKEND=portainer without config -> 400",
          st == 400 and "PORTAINER_URL" in str(b), f"{st} {b}")
        st, b = req(PORT_CFG, "/api/admin/image", id_m)
        t("image on misconfigured portainer -> 400",
          st == 400 and "PORTAINER_URL" in str(b), f"{st} {b}")

        # --- cookie mode (GATEWAY_TOKEN unset): identity headers never trusted ---
        s_ck = start_server(PORT_CK, "admin", {"GATEWAY_TOKEN": ""})
        st, b = req(PORT_CK, "/api/me", {"Cookie": "tm_user=admin"})
        t("cookie mode: valid session -> admin",
          st == 200 and b.get("role") == "admin" and b.get("username") == "admin",
          f"{st} {b}")
        st, b = req(PORT_CK, "/api/me", {})
        t("cookie mode: no cookie -> 401 with login_url",
          st == 401 and b.get("login_url") == MOCK_LOGIN, f"{st} {b}")
        st, b = req(PORT_CK, "/api/me", {"Remote-User": "admin"})
        t("cookie mode: forged identity header ignored (anti-spoof)",
          st == 401, f"{st} {b}")
        st, b = req(PORT_CK, "/api/admin/users", {"Cookie": "tm_user=other"})
        t("cookie mode: non-admin session -> admin api 403",
          st == 403, f"{st} {b}")

        # --- static UI guard: base/suffix consistency (the405 bug class) ---
        appjs = open(os.path.join(REPO, "frontend/js/app.js")).read()
        m = re.search(r"function adminTotpBase\(user\)\s*\{[^}]*\}", appjs)
        t("adminTotpBase must not pre-append the suffix (UI405 guard)",
          bool(m) and '+ "/totp"' not in m.group(0),
          (m.group(0) if m else "adminTotpBase not found")[:160])

        # --- fail-closed: ADMIN_USERS unset ---
        s2 = start_server(PORT2, "")
        st, b = req(PORT2, "/api/me", {"Remote-User": "admin", **GW})
        t("no ADMIN_USERS configured -> role self (fail-closed)",
          st == 200 and b.get("role") == "self", f"{st} {b}")
        st, b = req(PORT2, "/api/admin/users", {"Remote-User": "admin", **GW})
        t("no ADMIN_USERS configured -> admin api 403", st == 403, f"{st} {b}")
    finally:
        for proc in (s1, s_mut, s_cfg, s_ck, s2):
            if proc:
                proc.terminate()
        mock.shutdown()
        time.sleep(0.3)

    print()
    if failures:
        print(f"{len(failures)} FAILURE(S): {failures}")
        return 1
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
