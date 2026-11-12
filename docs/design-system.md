# Design system — tinyauth-mgmt

Source of truth: the author's own design language, distilled from
**luci-theme-liquid** (foundation: palette, glass, controls) and
**luci-app-pushbot** (structure: cards, field boxes, chips, toasts).

Scope decision: **single accent palette (liquid blue) only** — the theme's
`data-accent` multi-palette system (magenta/amber/purple/…) is intentionally
NOT implemented. Light + dark modes are kept (`data-darkmode`), matching both
source projects.

---

## 1. Mode mechanism (manual + auto both kept)

```html
<html data-darkmode="true|false">   <!-- driven by a tiny JS -->
```
Three states, user-selectable via a header toggle, persisted in `localStorage`:

- **auto** (default) — resolves `prefers-color-scheme` and follows live changes
- **light** — forced light
- **dark** — forced dark

## 2. Palette

### Light (default)

| Token | Value |
|---|---|
| `--background-color-high/medium/low` | `#f4f6fa` / `#e9edf4` / `#dfe5ef` |
| `--text-color-highest/high/medium/low` | `#10151d` / `#1d2633` / `#4c5868` / `#8a95a6` |
| `--border-color-high/medium/low` | `rgba(23,34,52,.20 / .13 / .07)` |
| `--primary-color-high/medium/low` | `#2f7fe0` / `#1f6fc8` / `#0f56a8` |
| `--on-primary-color` | `#ffffff` |
| `--error-high/medium/low` | `#e03a3a` / `#d23c3c` / `#b52a2a` (rgb `224,58,58`) |
| `--success-high/medium/low` | `#10a660` / `#0d9a58` / `#0a8048` (rgb `16,166,96`) |
| `--warn-high/medium/low` | `#e0a013` / `#d99414` / `#c98716`, on-warn `#3a2c00` |
| `--disabled-opacity` | `.65` |
| `--table-stripe` | `#f4f6f9` |
| **body background** | **flat `#f4f6fa`** (no gradient wallpaper — keep it plain) |

### Dark (`data-darkmode="true"`)

| Token | Value |
|---|---|
| on-primary / error / success / warn | `#0b1220` / `rgb(226,98,98)` med `#cf5f5f` / `rgb(46,185,118)` med `#38a86f` / `#d9a33a` med `#c99430`, on-warn `#221a05` |
| `--disabled-opacity` | `.45` |
| `--table-stripe` | `#1b2330` |
| **body background** | **flat `#0a0f18`** (same plain treatment for dark) |

## 3. Liquid glass layer

| Token | Light | Dark |
|---|---|---|
| `--glass-blur` / `--glass-sat` | `26px` / `1.6` | same |
| `--glass-radius` / `-lg` | `18px` / `24px` | same |
| `--glass-bg` | `rgba(255,255,255,.42)` | `rgba(24,32,48,.40)` |
| `--glass-bg-strong` (header/toolbar) | `rgba(255,255,255,.66)` | `rgba(22,29,44,.74)` |
| `--field-bg` (inputs) | `rgba(255,255,255,.56)` | `rgba(255,255,255,.07)` |
| `--glass-border` / `--glass-inset` | `rgba(255,255,255,.8)` / `rgba(255,255,255,.95)` | `rgba(255,255,255,.16)` / `rgba(255,255,255,.10)` |
| `--glass-shadow` | `0 22px 54px rgba(31,45,70,.16), 0 2px 8px rgba(31,45,70,.06)` | `0 26px 64px rgba(0,0,0,.6), 0 2px 10px rgba(0,0,0,.32)` |
| `--glass-shadow-soft` | `0 8px 24px rgba(31,45,70,.10)` | `0 10px 30px rgba(0,0,0,.5)` |
| `--accent-grad` (primary action) | `linear-gradient(135deg,#5aa8f7 0%,#2f7fe0 48%,#1a63c4 100%)` | `linear-gradient(135deg,#7cbcff 0%,#5da3f0 48%,#2f74cc 100%)` |
| `--accent-glow` | `rgba(47,127,224,.38)` | `rgba(93,163,240,.40)` |

## 4. Signature card (pushbot 立体投影) — content sections

```css
/* the author's four-directional card shadow — keep verbatim */
.card {
  padding: 16px 18px 18px;
  border: 1px solid rgba(148,163,184,.22);
  border-radius: 16px;
  background: var(--card-bg);            /* light #fff, dark: glass-strong */
  box-shadow:
    0 10px 28px rgba(15,23,42,.14),     /* bottom (heaviest) */
    0 -3px 8px  rgba(15,23,42,.05),     /* top    */
    3px 0 8px   rgba(15,23,42,.05),     /* right  */
    -3px 0 8px  rgba(15,23,42,.05);     /* left   */
}
```
Dark variant: same geometry, heavier base (use `--glass-shadow`-class values,
e.g. bottom `0 10px 28px rgba(0,0,0,.45)` + three-way `rgba(0,0,0,.25)` — tune
against pushbot's dark handling).

**Inline field box** (form rows inside a card):
```css
.field { padding:10px 12px; border-radius:12px; background:#f8fafc;
         border:1px solid rgba(148,163,184,.3);
         box-shadow: inset 0 1px 2px rgba(0,0,0,.03); }
.field-label { font-size:12px; font-weight:700; letter-spacing:.02em;
               color:#475569; text-transform:uppercase; }   /* pushbot 标签风格 */
```

## 5. Controls (liquid rules, verbatim semantics)

### Button
```css
.btn { padding:10px 19px; font-size:12.5px; font-weight:600; line-height:1.4;
       color:var(--text-color-high); background:var(--glass-bg);
       border:none; border-radius:10px; cursor:pointer; appearance:none;
       box-shadow: var(--glass-shadow-soft),
                   inset 0 0 0 1px var(--glass-border),
                   inset 0 1px 0 var(--glass-inset);
       transition: transform .12s ease, box-shadow .15s ease,
                   background .15s ease, color .15s ease, opacity .15s ease; }
.btn:hover  { background: var(--glass-bg-hover); }
.btn:active { transform: translateY(1px); }
.btn:disabled { opacity: var(--disabled-opacity); cursor: not-allowed; }
.btn.primary { color:var(--on-primary-color); background:var(--accent-grad);
               box-shadow: 0 6px 16px var(--accent-glow),
                           inset 0 1px 0 rgba(255,255,255,.35); }
.btn.primary:hover { filter: brightness(1.1); }
.btn.danger { color:#fff; background: linear-gradient(135deg,#f06767,#e03a3a);
              box-shadow: 0 6px 16px rgba(224,58,58,.35); }
.btn.danger:hover { filter: brightness(1.08); }
```
> No `border` on buttons (theme rationale: border layer detaches from
> border-radius on some engines — use inset shadow rim).

### Input / select
```css
input, select, textarea { width:100%; padding:8px 12px; font-size:13px;
  color:var(--text-color-high); background:var(--field-bg);
  border:1px solid var(--border-color-medium); border-radius:10px;
  backdrop-filter: blur(6px);
  transition: border-color .15s, box-shadow .15s, background .15s; }
input:focus { outline:none; border-color:var(--primary-color-high);
  background:var(--glass-bg-hover);
  box-shadow: 0 0 0 3px var(--accent-glow); }
select { border-radius:12px; appearance:none; }
```

### Typography
- sans: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, ui-sans-serif, system-ui, sans-serif`
- mono (uuid / bcrypt / secrets): `ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace`
- scale (dense console UI): body `13px`, button `12.5px`, tag `12px`, small `11.5px`, subhead `14px`, title `17px`

### Badges & chips
```css
.badge { display:inline-flex; align-items:center; gap:6px;
  padding:2px 8px; border-radius:999px; font-size:10px; font-weight:700;
  background:var(--glass-bg); border:1px solid var(--glass-border); }
/* state colors: active=success, expired=error, max-lifetime=warn, mfa=primary tint */
.tag   { padding:4px 10px; border-radius:8px; font-size:12px;
  background:rgba(59,130,246,.12); border:1px solid rgba(59,130,246,.25); }
.chip  { padding:4px 10px; border-radius:6px; font-family:var(--font-mono);
  font-size:12px; background:rgba(148,163,184,.08); }   /* uuid / hash 段 */
```

### Table
- `table-layout:auto`, cells `vertical-align:middle`
- header: reuse `.field-label` treatment (12px/700/uppercase/`.02em`)
- stripe: `--table-stripe` on odd rows; hover: `--glass-bg-hover`
- radius: wrap in card, `border-radius:16px; overflow:hidden`

### Toast (pushbot)
- `padding:12-16px; border-radius:10-12px; font-size:13px; font-weight:600`,
  enter `scale(.85)→1` + fade, auto-dismiss, top-center; success=green gradient,
  error=red gradient (pushbot uses `#ef4444→#dc2626`), warn=amber `#f59e0b→#ea580c`

## 6. Layout skeleton (console)

```
┌─ header (glass-bg-strong, sticky) ────────────────┐
│ logo/title   [who: admin · role badge]  theme toggle │
├─ nav tabs (admin: Users/Sessions/Stack | self: My account) ─┤
├─ content: .card sections ─────────────────────────┤
│  .card → .field rows / data tables / action bars  │
└─ toast layer ─────────────────────────────────────┘
```
- Admin role sees all nav tabs; self-service role sees only *My account*
  (server enforces; nav is UX only).
- Responsive: cards stack, table → horizontal scroll below ~768px
  (pushbot's flex-wrap field rows as reference).

## 7. Explicitly out of scope

- ❌ `data-accent` multi-palette themes (magenta/amber/purple/…)
- ❌ 复杂壁纸：liquid 的 `body-grad` 多层径向光斑渐变**不用**，背景只用纯色
  （亮 `#f4f6fa` / 暗 `#0a0f18`）
- ❌ LuCI-specific classes (`.cbi-*`) — we borrow the *values*, not the framework
- ❌ Any build toolchain (no npm/webpack — matches the author's vanilla style;
  plain CSS + vanilla JS served by Flask)
