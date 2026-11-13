# tinyauth-mgmt

[English](#english) · 中文

---

## 中文

**tinyauth-mgmt** 是 [tinyauth](https://github.com/tinyauthapp/tinyauth) 的网页管理控制台：
以独立容器运行，通过反向代理接入 tinyauth 的认证链，提供用户、会话、TOTP、
容器栈与时间源的可视化管理——**不修改 tinyauth 本身**，两者共享同一个数据卷。

### 特性

- **用户管理**：新建 / 改密 / 删除（删前需输入用户名确认），删除时自动踢出该用户全部会话，拒绝删除最后一个用户
- **TOTP 管理**：启用 / 改绑 / 移除，两阶段流程（先展示密钥与 otpauth 链接，输入验证码验证通过才落盘）
- **会话管理**：全量列表（状态 / 过期 / 滑动续期标记 / MFA 标记），按用户或全部踢出
- **栈信息**：运行镜像 vs compose 声明比对（match/mismatch）、一键重启 tinyauth（走 Portainer API 或 docker socket，由你选择）
- **时间面板**：浏览器 / NTP（SNTP 直查）/ tinyauth / 本容器四源对照，统一时区显示，30秒一拍、离开即停
- **身份双因子**：`X-Admin-Gateway` 网关令牌 + **cookie 回调 tinyauth 自验**——伪造身份头无效
- **界面**：中 / EN / 自动（跟随浏览器）语言切换，亮 / 暗 / 自动主题，移动端响应式布局

### 快速开始（与 tinyauth 同一个 compose，推荐）

把 `tinyauth-mgmt` 服务追加进你现有的 tinyauth compose（同一数据卷、同一 `webs` 网络）：

```yaml
services:
  tinyauth:
    image: ghcr.io/tinyauthapp/tinyauth:v5.2.0
    container_name: tinyauth
    restart: unless-stopped
    environment:
      - TINYAUTH_SERVER_PORT=3002
      - TINYAUTH_AUTH_SECURECOOKIE=true
      - TINYAUTH_DATABASE_PATH=/data/tinyauth.db
      - TINYAUTH_CONFIGFILE=/data/tinyauth-config.yaml
      - DOMAIN=.example.com
    volumes:
      - tinyauth-data:/data
      - /etc/localtime:/etc/localtime:ro      # 时区跟随宿主（只读）
    networks:
      - webs

  # ---------------- tinyauth-mgmt：管理控制台 ----------------
  tinyauth-mgmt:
    image: ghcr.io/xylz0928/tinyauth-mgmt:v2.6   # 或 ...:latest 跟随最新
    container_name: tinyauth-mgmt
    restart: unless-stopped
    environment:
      - "ADMIN_USERS=admin"            # ★ tinyauth 用户名，逗号分隔；不设则管理接口全部禁用（fail-closed）
      - "GATEWAY_TOKEN=change-me-to-a-long-random-string"  # ★ 与反代注入的 X-Admin-Gateway 一致；配合 cookie 自验=双因子
      - "DOCKER_BACKEND=portainer"     # auto | socket | portainer —— 重启/比对走哪条通道
      - "PORTAINER_URL=http://portainer:9000"   # portainer 模式必填（此时可去掉 docker.sock 挂载）
      - "PORTAINER_TOKEN=change-me-portainer-api-key"
      - "TZ=Asia/Shanghai"             # 时间面板的基准时区（IANA 名，按你的时区改）
      # - "NTP_SERVERS=time.windows.com,ntp.aliyun.com,pool.ntp.org"  # 可选：NTP 服务器列表（逐个回退）
      # - "TINYAUTH_AUTH_URL=http://tinyauth:3002/api/auth/nginx"      # 可选：cookie 自验端点（默认即此）
    volumes:
      - tinyauth-data:/data            # ★ 与 tinyauth 同一个卷（同 compose 同 key）
      - /etc/localtime:/etc/localtime:ro   # 时区跟随宿主（只读）
      # - /var/run/docker.sock:/var/run/docker.sock  # socket 模式才需要
    networks:
      - webs
    # 不发布任何端口：只经反向代理暴露

volumes:
  tinyauth-data:            # tinyauth 的卷，按你的项目名自动加前缀

networks:
  webs:
    external:
      name: webs            # 你的反代所在网络
```

部署：`Portainer → Stacks → Update`（或粘贴新建）。**注意**：compose 变更会重建容器，
tinyauth 会有数秒认证中断，会话存储在数据库中不受影响。

### 反向代理（三要素）

1. 站点 `proxy_pass` 指向容器 **80 端口**（如 `http://tinyauth-mgmt:80/`）
2. 沿用你现有的 tinyauth `auth_request` 认证块（登录态即通行）
3. 如启用 `GATEWAY_TOKEN`：加一行 `proxy_set_header X-Admin-Gateway "<与 env 一致>";`

> 即使不注入网关令牌、不转发身份头，后端也会拿浏览器的 cookie 直接向 tinyauth 求证——
> 同网段容器伪造 `X-Tinyauth-User` 无效。详见 `docs/security-model.md` 与
> `docs/reverse-proxy/`（nginx / traefik / caddy 模板）。

### 配置项一览

| 环境变量 | 必需 | 说明 |
|---|---|---|
| `ADMIN_USERS` | 管理功能必需 | 拥有管理权限的 tinyauth 用户名（逗号分隔）。**不设置 = 谁都不是管理员** |
| `GATEWAY_TOKEN` | 强烈建议 | 反代注入 `X-Admin-Gateway` 的共享密钥；与 cookie 自验叠加为双因子 |
| `DOCKER_BACKEND` | 否（`auto`） | `auto`（有 Portainer 凭证则走 Portainer，否则 socket）/ `socket` / `portainer` |
| `PORTAINER_URL` / `PORTAINER_TOKEN` | portainer 模式必需 | 走 Portainer API（此时可移除 docker.sock 挂载，攻击面更小），并解锁 compose 镜像比对 |
| `PORTAINER_ENDPOINT` | 多 docker 端点时 | 指定 endpoint 名称或 ID |
| `NTP_SERVERS` | 否 | 时间面板的 NTP 列表，默认 `time.windows.com,ntp.aliyun.com,pool.ntp.org` |
| `TINYAUTH_AUTH_URL` / `TINYAUTH_HEALTH_URL` | 否 | cookie 自验 / 健康检查端点（默认指向同网络的 tinyauth） |
| `TZ` | 否 | 时间面板基准时区（IANA 名，如 `Asia/Shanghai`） |

镜像构建参数：`--build-arg APP_VERSION=vX.Y`（显示在页面左上角版本徽章）。

### 备用部署：独立栈

不想合并 compose 也可用独立栈（同样共享数据卷与网络），
见 [`examples/compose-standalone.yaml`](examples/compose-standalone.yaml)。

### 开发与验证

```bash
python3 backend/verify.py    #60+ 项断言：身份链/角色/TOTP/会话/双后端/i18n/移动端守卫
```

License: MIT

---

## English

**tinyauth-mgmt** is a web administration console for
[tinyauth](https://github.com/tinyauthapp/tinyauth). It runs as a standalone
container behind your existing forward-auth proxy and provides visual
management of users, sessions, TOTP, the container stack and time sources —
**without modifying tinyauth itself**; both share the same data volume.

### Features

- **Users**: create / change password / delete (type-to-confirm), kicks all of
  the account's sessions on delete, refuses to delete the last user
- **TOTP**: enable / rebind / remove with a two-phase flow (secret + otpauth
  link first, persisted only after a valid code)
- **Sessions**: full list with status / expiry / sliding-renewal and MFA
  flags; kick one user or everyone
- **Stack**: running image vs compose declaration (match/mismatch), one-click
  tinyauth restart via **Portainer API or docker socket — your choice**
- **Time panel**: browser / NTP (raw SNTP) / tinyauth / this container in one
  view, rendered in a single timezone; one snapshot every 30s, polling stops
  when you leave
- **Double-factor identity**: `X-Admin-Gateway` token **plus** a session
  cookie validated directly with tinyauth — forged identity headers are
  worthless
- **UI**: zh / EN / auto language toggle, light / dark / auto theme,
  responsive down to phones

### Quick start (same compose as tinyauth — recommended)

Append the service to your existing tinyauth compose (shared volume, shared
`webs` network):

```yaml
services:
  tinyauth:
    image: ghcr.io/tinyauthapp/tinyauth:v5.2.0
    container_name: tinyauth
    restart: unless-stopped
    environment:
      - TINYAUTH_SERVER_PORT=3002
      - TINYAUTH_AUTH_SECURECOOKIE=true
      - TINYAUTH_DATABASE_PATH=/data/tinyauth.db
      - TINYAUTH_CONFIGFILE=/data/tinyauth-config.yaml
      - DOMAIN=.example.com
    volumes:
      - tinyauth-data:/data
      - /etc/localtime:/etc/localtime:ro      # host timezone (read-only)
    networks:
      - webs

  # ---------------- tinyauth-mgmt: the console ----------------
  tinyauth-mgmt:
    image: ghcr.io/xylz0928/tinyauth-mgmt:v2.6   # or ...:latest
    container_name: tinyauth-mgmt
    restart: unless-stopped
    environment:
      - "ADMIN_USERS=admin"            # ★ tinyauth username(s), comma separated; unset = fail-closed
      - "GATEWAY_TOKEN=change-me-to-a-long-random-string"  # ★ must match X-Admin-Gateway from the proxy
      - "DOCKER_BACKEND=portainer"     # auto | socket | portainer
      - "PORTAINER_URL=http://portainer:9000"   # required in portainer mode (socket mount can be dropped)
      - "PORTAINER_TOKEN=change-me-portainer-api-key"
      - "TZ=Asia/Shanghai"             # base timezone of the Time card (IANA name)
      # - "NTP_SERVERS=time.windows.com,ntp.aliyun.com,pool.ntp.org"
      # - "TINYAUTH_AUTH_URL=http://tinyauth:3002/api/auth/nginx"
    volumes:
      - tinyauth-data:/data            # ★ same volume as tinyauth (same compose, same key)
      - /etc/localtime:/etc/localtime:ro
      # - /var/run/docker.sock:/var/run/docker.sock  # only for socket mode
    networks:
      - webs
    # no published ports: reverse proxy only

volumes:
  tinyauth-data:

networks:
  webs:
    external:
      name: webs
```

Deploy via `Portainer → Stacks → Update`. **Note**: compose changes recreate
containers — tinyauth has a few seconds of auth downtime; sessions live in the
database and survive.

### Reverse proxy (three things)

1. `proxy_pass` to the container's **port 80** (e.g. `http://tinyauth-mgmt:80/`)
2. keep your existing tinyauth `auth_request` block
3. if `GATEWAY_TOKEN` is set: add `proxy_set_header X-Admin-Gateway "<same as env>";`

> Even without the gateway header the backend validates the browser's session
> cookie directly against tinyauth — sibling containers cannot spoof
> `X-Tinyauth-User`. See `docs/security-model.md` and templates under
> `docs/reverse-proxy/` (nginx / traefik / caddy).

### Configuration

| Variable | Required | Meaning |
|---|---|---|
| `ADMIN_USERS` | for admin features | tinyauth username(s) with admin power, comma separated. **Unset = nobody is admin (fail-closed)** |
| `GATEWAY_TOKEN` | strongly recommended | shared secret injected as `X-Admin-Gateway`; combined with cookie verification = double factor |
| `DOCKER_BACKEND` | no (`auto`) | `auto` (Portainer when configured, else socket) / `socket` / `portainer` |
| `PORTAINER_URL` / `PORTAINER_TOKEN` | portainer mode | use the Portainer API (drops the docker.sock mount, smaller attack surface) and enables the compose image cross-check |
| `PORTAINER_ENDPOINT` | multiple docker endpoints | endpoint name or id |
| `NTP_SERVERS` | no | NTP list for the Time card (tried in order) |
| `TINYAUTH_AUTH_URL` / `TINYAUTH_HEALTH_URL` | no | cookie-verification / health endpoints (default: tinyauth on the same network) |
| `TZ` | no | base timezone of the Time card (IANA name) |

Build arg: `--build-arg APP_VERSION=vX.Y` (shown as the version badge).

### Alternative: standalone stack

See [`examples/compose-standalone.yaml`](examples/compose-standalone.yaml).

### Development

```bash
python3 backend/verify.py    # 60+ assertions: identity chain, roles, TOTP,
                             # sessions, dual docker backend, i18n, mobile guards
```

License: MIT
