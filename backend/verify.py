#!/usr/bin/env python3
"""Milestone-1 verification for tinyauth-mgmt.

Runs two gunicorn instances against synthetic fixtures and asserts the whole
identity chain / role model / read-only APIs over real HTTP:
    python3 verify.py        (uses the repo venv's python)
"""
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BACKEND = os.path.join(REPO, "backend")
BASE = "/tmp/tm-verify"
GW = {"X-Admin-Gateway": "s3cret"}
PORT1, PORT2 = "18099", "18100"

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


def start_server(port, admin_users):
    env = dict(os.environ)
    env.update({
        "TINYAUTH_DATA_DIR": BASE,
        "ADMIN_USERS": admin_users,
        "GATEWAY_TOKEN": "s3cret",
        "LOG_LEVEL": "WARNING",
    })
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
    s1 = start_server(PORT1, "admin")
    s2 = None
    try:
        id_admin = {"Remote-User": "admin", **GW}
        id_other = {"X-Tinyauth-User": "other", **GW}

        # --- health & static ---
        st, b = req(PORT1, "/api/health")
        t("health open (no auth)", st == 200 and b.get("status") == "ok", f"{st} {b}")
        st, b = req(PORT1, "/")
        t("index html served", st == 200 and "tinyauth-mgmt" in b if isinstance(b, str) else False)
        st, b = req(PORT1, "/css/tokens.css")
        t("static css served", st == 200 and "--primary-color-high" in b if isinstance(b, str) else False)

        # --- identity chain ---
        st, b = req(PORT1, "/api/me", GW)
        t("gateway ok but no identity -> 401", st == 401, f"{st} {b}")
        st, b = req(PORT1, "/api/me", {"Remote-User": "admin"})          # no gateway
        t("missing gateway token -> 403", st == 403, f"{st} {b}")
        st, b = req(PORT1, "/api/me", {"Remote-User": "admin", "X-Admin-Gateway": "wrong"})
        t("wrong gateway token -> 403", st == 403, f"{st} {b}")
        st, b = req(PORT1, "/api/me", id_admin)
        t("admin identity -> role admin", st == 200 and b.get("role") == "admin"
          and b.get("username") == "admin", f"{st} {b}")
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
              "tinyauth" in str(b.get("container_image")) and b.get("state") == "running"
              and b.get("compose_image") is None and b.get("compose_note"),
              f"{st} {b}")
        else:
            t("image endpoint graceful 502 without socket",
              st == 502 and "error" in b, f"{st} {b}")

        # --- fail-closed: ADMIN_USERS unset ---
        s2 = start_server(PORT2, "")
        st, b = req(PORT2, "/api/me", {"Remote-User": "admin", **GW})
        t("no ADMIN_USERS configured -> role self (fail-closed)",
          st == 200 and b.get("role") == "self", f"{st} {b}")
        st, b = req(PORT2, "/api/admin/users", {"Remote-User": "admin", **GW})
        t("no ADMIN_USERS configured -> admin api 403", st == 403, f"{st} {b}")
    finally:
        s1.terminate()
        if s2:
            s2.terminate()
        time.sleep(0.3)

    print()
    if failures:
        print(f"{len(failures)} FAILURE(S): {failures}")
        return 1
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
