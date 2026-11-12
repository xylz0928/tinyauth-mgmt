# Security model

Read this before exposing the console.

## Identity chain

```
browser
  │  (already logged into tinyauth — session cookie on your domain)
  ▼
reverse proxy
  │  auth_request / forward_auth ──► tinyauth
  │                                     │200 + Remote-User: <username>
  │  ◄──────────────────────────────────┘
  │  injects:  Remote-User / X-Tinyauth-User  (identity)
  │            X-Admin-Gateway                (optional shared secret)
  ▼
tinyauth-mgmt backend (:8080, no published port)
  └─ trusts ONLY these headers — never the request body or query string
```

Rules enforced by the backend:

1. **Empty identity → 401.** If `Remote-User`/`X-Tinyauth-User` is missing or
   empty the request is rejected. Identity is never taken from anything the
   client controls.
2. **Self-service routes force the username from the header.** A non-admin
   user posting `{ "username": "someone-else"}` gets their *own* username
   substituted — the body field is ignored, so horizontal privilege escalation
   is impossible.
3. **`ADMIN_USERS` is fail-closed.** Unset → no one gets admin routes (startup
   log prints a loud warning). Set → only those comma-separated usernames get
   full power.
4. **Role checks live on the server.** The frontend hides buttons for UX only;
   every admin API re-checks the role on every request.

## Gateway token (why you should set GATEWAY_TOKEN)

The console container is reachable by every other container on its docker
network. A compromised sibling container could connect to `tinyauth-mgmt:8080`
directly and forge `Remote-User: admin`.

`GATEWAY_TOKEN` closes this: your reverse proxy adds a static secret header
(`X-Admin-Gateway`) that only the proxy knows; the backend rejects requests
without it. It is a static value, so it can be set with any proxy's
"add request header" mechanism.

Alternative hardening (defense in depth): put the console on its own
`internal: true` docker network that only your reverse proxy joins.

## Privileges the console holds (know this)

| Access | Why | Risk |
|---|---|---|
| `tinyauth-data` volume (rw) | users file + session database + config live there | full control of tinyauth state |
| `docker.sock` | restart / inspect the tinyauth container | **root-equivalent on the host** — treat this container like Portainer |

Recommended: keep `ADMIN_USERS` minimal (one account), keep `GATEWAY_TOKEN`
set, and never publish the console's port.

## Break-glass

The console authenticates *through* tinyauth — if tinyauth is down, the console
is unreachable **by design**. Keep an independent administrative path
(console/SSH on the host, or the tinyauth container itself) for that case.

## Trust boundary notes

- The console adds no new login screen: it inherits tinyauth's session
  (same cookie, same domain scope, same expiry/sliding-renewal semantics).
- Sessions kicked from the console take effect on the next request of the
  affected client (tinyauth checks its SQLite session store per request).
- `PORTAINER_TOKEN`, if provided, should be a dedicated read-mostly key;
  it is only used to compare the compose-declared image with the running image.
