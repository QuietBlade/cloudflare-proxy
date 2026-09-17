# AGENTS.md

## Project overview

Pure static site for a Cloudflare Pages-based GitHub/Docker acceleration proxy landing page + Worker. Zero build step, zero dependencies — HTML + Tailwind CDN + vanilla JS.

## File structure

```
_worker.js            Worker: proxy + Docker registry mirror (root, auto-detected)
wrangler.toml         main = _worker.js, [assets] directory = ./public
public/index.html     Landing page (hero, features, tabs, FAQ, CTA)
public/gh.html        GitHub acceleration page (URL generator, usage examples)
public/docker.html    Docker acceleration page (OS-specific config tabs)
public/docs.html      Deployment guide (5-step Cloudflare Pages setup)
public/assets/css/style.css  Shared styles (animations, keyframes, reduced-motion)
public/assets/js/config.js   Domain config (window.CF_PROXY.DOMAIN)
public/assets/js/main.js     Shared JS (tabs, copy buttons, domain substitution)
public/assets/js/gh.js       GitHub page URL generator logic
public/assets/js/docker.js   Docker page OS tab switcher
tests/auth.mjs        Zero-dependency auth tests: `node tests/auth.mjs`
```

`.gitignore` covers `.dev.vars` (local secrets), `.wrangler/`, `node_modules/`.

## Architecture notes

- **No build tooling.** Open any `.html` directly in a browser. No `package.json`, no `npm`.
- **Tailwind via CDN.** Every page loads `https://cdn.tailwindcss.com` and configures a custom `brand` color palette inline (`tailwind.config` block). Do not add Tailwind CLI or PostCSS unless the project switches away from CDN.
- **Fonts from Google Fonts CDN.** IBM Plex Sans (display) + JetBrains Mono (code). Linked via `<link>` in each `<head>`.
- **All icons are inline SVGs** (Lucide-style) — no icon library dependency.
- **Vanilla JS only.** No framework.
- **CSS/JS are now external.** Shared styles in `assets/css/style.css`, shared JS in `assets/js/main.js`. Each page also loads its own page-specific JS. When making changes to nav/footer/styling, update all four HTML files (content is still duplicated per page; only the shared wiring was extracted).

### _worker.js routing

Cloudflare Pages auto-detects `_worker.js` in the repo root. Routing logic:

| Request path | Behavior |
|---|---|
| `OPTIONS *` | Return 204 CORS preflight |
| `/v2/...` | Proxy to Docker Hub Registry API (`registry-1.docker.io`) |
| `/<image>` or `/<user>/<img>` | Docker pull path → parse & proxy to registry |
| `/<registry>/<path>` | If first segment is known registry (ghcr.io, quay.io, etc), proxy |
| `/https://...` or `/http://...` | Strip leading `/`, proxy to target URL |
| Everything else | `env.ASSETS.fetch(request)` — serve static file |

Key features:
- **Docker auth**: 401 → parse WWW-Authenticate → fetch token → retry with Bearer. Credential precedence is **client → env → anonymous**:
  1. client `Authorization: Basic …` → used to mint the token (client's `Bearer …` is passed straight through and never re-minted);
  2. else `env.DOCKER_USER` / `env.DOCKER_PASS` (a Docker Hub username + password/PAT);
  3. else anonymous.
  If the client's credential is rejected the worker falls back to the env credential; if every tier fails it returns 401 with `WWW-Authenticate` stripped (so clients are never pushed to a possibly blocked auth host).
- **S3 redirect re-proxy**: intercepts 302/307 from AWS S3/CDN, re-proxies through Worker (critical for China access)
- **S3 header patching**: auto-adds `x-amz-content-sha256` + `x-amz-date` for S3 requests
- **Allowed hosts**: `ALLOWED_HOSTS` array controls which upstreams can be proxied |

Auth conventions (easy to get wrong):
- **Never build `Authorization` values with template literals.** Use string concatenation (`'Basic ' + base64Utf8(user + ':' + pass)`). A past edit turned `${user}` into the literal `\({user}` inside a template literal, which silently produced the garbage Basic value `({user}:){pass}` and a broken registry URL on the ghcr path. `tests/auth.mjs` guards against a recurrence.
- Credentials are base64'd as UTF-8 via `base64Utf8()` (`btoa` alone throws on non-Latin-1 passwords).
- Client credentials are only sent to registry hosts; on redirect to S3/CDN (`!DOCKER_REGISTRIES.has(host)`) the `Authorization` header is deleted, because presigned URLs reject a second auth mechanism.
- `env.DEBUG_AUTH=1` adds an `X-Proxy-Auth-Source: client|env|anonymous|none` response header (never any credential material), plus one `console.log` line per Docker request. Leave it unset in production.

### JS class contracts

Shared JS (`main.js`) uses CSS class contracts:

- **Tabs**: Container must have class `tab-group`. Buttons must have `data-tab="<panel-id>"`. Panels must have `class="tab-panel"` and matching `id`.
- **Copy buttons**: Button must have class `copy-btn`. Its parent must have class `code-block` which contains a `<code>` child.

The `docker.js` tab switcher uses `docker-tab` / `docker-panel` classes (separate from generic tabs to avoid conflicts on the docker page).

### Design tokens

Custom Tailwind colors (set in `tailwind.config` block on every page):

| Token | Value | Tailwind class |
|-------|-------|---------------|
| Page background | `#0F172A` | `bg-brand-bg` |
| Card background | `#1E293B` | `bg-brand-card` |
| Hover / border | `#334155` | `bg-brand-hover` `border-brand-border` |
| Primary text | `#F8FAFC` | `text-brand-text` |
| Muted text | `#94A3B8` | `text-brand-muted` |
| Accent (green) | `#22C55E` | `text-brand-accent` `bg-brand-accent` |
| Accent hover | `#16A34A` | `bg-brand-accent-hover` |

## Site configuration

Edit `public/assets/js/config.js` to set the domain:

```js
window.CF_PROXY = {
  DOMAIN: 'cloudflare-proxy-6rw.pages.dev',
};
```

`main.js` reads this at page load and auto-replaces all instances of `cloudflare-proxy-6rw.pages.dev` in text nodes across the page. No manual find-and-replace needed. `gh.js` also reads from config (falls back to `location.hostname`).

## Pre-delivery checks

- Dark mode only (no light mode support).
- `prefers-reduced-motion` is respected via CSS override in `assets/css/style.css`.
- Responsive breakpoints: default (mobile) → `sm:` (640px) → `md:` (768px) → `lg:` (1024px).
- Copy buttons show a green checkmark SVG for 2 seconds after copying.
- When deploying: Cloudflare Pages build command = empty, output directory = `/`.
- After touching anything under 「凭据处理」 / `proxyWithAuth` / `parseDockerPath` in `_worker.js`: run `node tests/auth.mjs` (33 checks, zero dependencies) and confirm `node --check` passes on a `.mjs` copy of the worker.
- Pages env vars (`DOCKER_USER`, `DOCKER_PASS`, optional `DEBUG_AUTH`) are bound at **deploy time** — adding or changing them requires a new deployment, otherwise the running build still sees the old (or no) values.
