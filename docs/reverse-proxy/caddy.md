# tinyauth-mgmt behind Caddy

tinyauth ships native forward-auth support for Caddy — use the forward_auth
directive exactly as described in the **official tinyauth documentation** for
Caddy. This page only covers the two things specific to the management console.

## 1. Identity must reach the backend

tinyauth answers a successful authorization with a **`Remote-User`** header
(plus `Remote-Name` / `Remote-Email`). Caddy's `forward_auth` copies the
authorization response headers onto the proxied request.

Example (adjust to your file layout):

```caddyfile
admin.example.com {
    forward_auth localhost:3002 {
        uri /api/auth/caddy
        copy_headers Remote-User Remote-Email X-Tinyauth-Location
    }

    # recommended: anti-spoofing token, must match GATEWAY_TOKEN
    header_up X-Admin-Gateway "change-me-to-a-long-random-string"

    reverse_proxy tinyauth-mgmt:8080
}
```

Verify:

```bash
curl -sI https://admin.example.com/ -H 'Cookie: <your-tinyauth-session>' | grep -i remote-user
# expect: Remote-User: <your-username>
```

If the header is missing, the console will (correctly) answer *401 no identity*.

## 2. No published port

`reverse_proxy tinyauth-mgmt:8080` on the shared docker network; no host port.
