# tinyauth-mgmt

A self-hosted **web admin console for [tinyauth](https://github.com/tinyauthapp/tinyauth)**.

tinyauth gives your apps a beautiful login screen — but managing it means editing files
or remembering CLI incantations. `tinyauth-mgmt` turns that into a browser UI:

- **Manage users**: add, change password, enable / rebind / remove TOTP, delete
- **Session control**: list every session (uuid, start & end time, status, flags), kick one user or everyone
- **Stack operations**: restart tinyauth, view image information
- **Role based**: one designated admin gets everything; every other tinyauth account can
  only change **their own** password and **their own** TOTP
- **No second login**: identity comes from tinyauth itself through your reverse proxy
  (forward-auth), so the console knows exactly who you are

> 🚧 **Status: under construction.**
> Compose examples, reverse-proxy templates, the security model and the deployment
> guide are final. Backend & frontend code are being built next.

## Permission model

| Action | Admin (`ADMIN_USERS`) | Everyone else |
|---|---|---|
| View users / sessions / image info | ✅ | ❌ |
| Kick sessions (single / all) | ✅ | ❌ |
| Add / delete users | ✅ | ❌ |
| Restart tinyauth | ✅ | ❌ |
| Change **own** password | ✅ | ✅ |
| Enable / rebind / remove **own** TOTP | ✅ | ✅ |
| Change **someone else's** password or TOTP | ✅ | ❌ |

Authorization is enforced **on the server** — hidden buttons are only UX.

## Deployment

Two ways to run it, same image:

### Mode A — merge into your tinyauth compose (recommended)

Add one service block to the compose file you already run tinyauth from.
Because both services live in the same compose project, they **share the data
volume automatically** — no volume-name guessing:

```yaml
  tinyauth-mgmt:
    image: ghcr.io/xylz0928/tinyauth-mgmt:latest   # or a local build tag
    container_name: tinyauth-mgmt
    restart: unless-stopped
    environment:
      - ADMIN_USERS=admin                            # ← your tinyauth username (required!)
      - GATEWAY_TOKEN=change-me-to-a-long-random     # ← recommended, see docs
    volumes:
      - tinyauth-data:/data                          # same key = same volume as tinyauth
      - /var/run/docker.sock:/var/run/docker.sock
    networks:
      - webs                                         # reuse your existing network
    # no ports: it is reached only through your reverse proxy
```

Full file: [`examples/compose-merged.yaml`](examples/compose-merged.yaml)

### Mode B — standalone stack (don't want to touch your tinyauth stack)

Uses environment variables to locate the existing data volume and proxy network:
[`examples/compose-standalone.yaml`](examples/compose-standalone.yaml)
(details in [`docs/deployment.md`](docs/deployment.md)).

## Reverse proxy (required)

The console is **not** exposed on any host port; it lives only on your docker
network and is reached through the same forward-auth proxy you already use for
tinyauth.

Templates: [nginx](docs/reverse-proxy/nginx.conf.example) ·
[traefik](docs/reverse-proxy/traefik.md) · [caddy](docs/reverse-proxy/caddy.md)

The one thing every proxy must do: **forward the `Remote-User` header** that
tinyauth returns on successful authentication — that is how the console learns
who is logged in.

## Security

Read [`docs/security-model.md`](docs/security-model.md) before exposing the console.
Highlights:

- identity is taken only from the trusted forward-auth header, never from the request body
- `ADMIN_USERS` is fail-closed: if unset, no one gets admin routes
- optional `GATEWAY_TOKEN` defeats header spoofing from other containers on the same network
- if tinyauth itself is down, this console is unreachable by design — keep your
  console/SSH access as the break-glass path

## License

[MIT](LICENSE)
