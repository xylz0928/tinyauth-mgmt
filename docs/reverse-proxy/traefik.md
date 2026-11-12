# tinyauth-mgmt behind Traefik

tinyauth ships native forward-auth support for Traefik — set up the middleware
exactly as described in the **official tinyauth documentation** for Traefik
(forward-auth pointing at tinyauth's auth endpoint). This page only covers the
two things that are specific to the management console.

## 1. Identity must reach the backend

tinyauth answers a successful authorization with a **`Remote-User`** header
(plus `Remote-Name` / `Remote-Email`). Traefik's forwardAuth middleware passes
the authorization response headers through to the upstream service — the same
mechanism Authelia/Authentik use for `Remote-User`.

Verify after setup (replace with your host):

```bash
curl -sI https://admin.example.com/ -H 'Cookie: <your-tinyauth-session>' | grep -i remote-user
# expect: Remote-User: <your-username>
```

If the header is missing, the console will (correctly) answer *401 no identity*
— fix the forward-auth wiring before anything else.

## 2. Gateway token (anti-spoofing, recommended)

The console is reachable by any container on its docker network. Add a static
header so only your proxy can present a valid identity:

```yaml
# labels on the tinyauth-mgmt service (or a Traefik middleware)
- "traefik.http.middlewares.mgmt-gw.headers.customRequestHeaders.X-Admin-Gateway=change-me-to-a-long-random-string"
```

and set the same value as `GATEWAY_TOKEN` in the container environment.

## 3. No published port

Point the Traefik service at `tinyauth-mgmt:8080` on the shared network;
do not publish any host port.
