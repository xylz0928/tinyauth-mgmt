# Deployment guide

## Prerequisites

- a running **tinyauth** instance (any deployment method)
- a **reverse proxy** in front of your apps (every tinyauth setup has one —
  the console is reached through it, never through a published port)
- docker (of course)

## Choosing a mode

| | Mode A — merged compose | Mode B — standalone stack |
|---|---|---|
| For | new adopters, or adding the console to your existing tinyauth stack | people who don't want to touch their tinyauth stack |
| Volume wiring | automatic (same compose key) | explicit (`TINYAUTH_DATA_VOLUME` or `name:` field) |
| Network wiring | reuse your existing declaration | explicit (`PROXY_NETWORK` or `name:` field) |
| Config to set | `ADMIN_USERS` (+ `GATEWAY_TOKEN`) | `ADMIN_USERS` + `GATEWAY_TOKEN` + the two names |

## Mode A — merge into your tinyauth compose

1. Open your tinyauth compose (Portainer → your stack → *Update the stack*, or
   the file you manage it with).
2. Paste the `tinyauth-mgmt` service block from
   [`examples/compose-merged.yaml`](../examples/compose-merged.yaml) into
   `services:` — **do not change** your existing tinyauth service, volume keys
   or network names.
3. Set `ADMIN_USERS` to your tinyauth username (comma separate for several).
4. Generate a gateway token and set it:
   ```bash
   openssl rand -hex 32
   ```
5. Save/update. Compose only creates/updates the new service — your tinyauth
   container and data volume are untouched.

## Mode B — standalone stack

1. Discover the real names on your docker host:
   ```bash
   # tinyauth data volume (the dir mounted at /data inside tinyauth)
   docker volume ls --format '{{.Name}}' | grep tinyauth
   # the network tinyauth is attached to
   docker inspect tinyauth -f '{{range .NetworkSettings.Networks}}{{.Name}}{{end}}'
   ```
2. Copy [`examples/compose-standalone.yaml`](../examples/compose-standalone.yaml),
   then either create a `.env` next to it:
   ```ini
   TINYAUTH_DATA_VOLUME=the_name_from_step_1
   PROXY_NETWORK=the_network_from_step_2
   ```
   or edit the two `name:` fields directly.
3. Set `ADMIN_USERS` (and `GATEWAY_TOKEN`).
4. `docker compose up -d`

   `external: true` guarantees this stack can never create or delete the
   referenced volume/network — a typo fails loudly instead of silently giving
   the console an empty data directory.

## Environment variables

| Variable | Where | Required | Meaning |
|---|---|---|---|
| `ADMIN_USERS` | container env | **yes** (for admin features) | tinyauth username(s) with full power, comma separated. **Fail-closed: unset = nobody is admin.** |
| `GATEWAY_TOKEN` | container env | strongly recommended | shared secret injected by the reverse proxy; requests without it get 403 (anti-spoofing) |
| `TINYAUTH_DATA_VOLUME` | compose / `.env` (Mode B) | Mode B | real name of the tinyauth data volume |
| `PROXY_NETWORK` | compose / `.env` (Mode B) | Mode B | real name of the proxy docker network |
| `PORTAINER_URL` + `PORTAINER_TOKEN` | container env | no | enables the compose-image cross-check via the Portainer API |
| `TZ` | container env | no | timezone |

## Reverse proxy

Pick your proxy: [nginx](reverse-proxy/nginx.conf.example) ·
[traefik](reverse-proxy/traefik.md) · [caddy](reverse-proxy/caddy.md)

Non-negotiable requirement: the backend must receive tinyauth's **`Remote-User`**
header — that is the console's identity source.

## Verification checklist

Log in with tinyauth and confirm:

1. **Admin account** (`ADMIN_USERS`): sees all menus — users, sessions, restarts.
2. **Any other account**: sees only *change my password* / *my TOTP*; calling an
   admin API directly (e.g. `curl -X POST .../api/admin/users` with their cookie)
   must return **403**.
3. **Kick test**: log in as a second user on another browser, kick their session
   from the admin UI, refresh their page → back to the tinyauth login.
4. **Empty identity** (bypass the proxy if possible, or temporarily break the
   `Remote-User` line): must be rejected with **401**, never treated as admin.
5. **Gateway token**: a request without `X-Admin-Gateway` must get **403** (when
   `GATEWAY_TOKEN` is set).
6. Restart from the UI: tinyauth comes back healthy within a few seconds.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| compose error: *volume not found* (Mode B) | `TINYAUTH_DATA_VOLUME` wrong — re-run the discovery command; the name includes the project prefix |
| console says "no identity" / always 401 | proxy isn't forwarding `Remote-User` (see nginx template — reading `X-Tinyauth-User` gives an empty value) |
| every request 403 | `GATEWAY_TOKEN` set but the proxy doesn't inject `X-Admin-Gateway` (or mismatch) |
| nobody can use admin features | `ADMIN_USERS` unset (by design, fail-closed) or typo'd username |
| console unreachable when tinyauth is down | expected — see break-glass note in [security-model.md](security-model.md) |
