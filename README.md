# roblox-webport

Self-hosted Roblox web engine client. Joins real sessions — real auth, real
joinScript, native WebTransport/QUIC game transport (RUPP), world streaming,
avatar spawn + movement, and live remote-player replication.

You supply two things: an account token (`.ROBLOSECURITY` cookie) and the
engine binary (~96MB wasm, not distributed here).

## Quickstart

```bash
node index.mjs
# open https://localhost:9989 in Chrome — enter a place id, play
```

One process, one port — HTTPS and the UDP WebTransport front share `:9989`.
The landing page mints a session (`/pg/<sid>/?gid=<place>`) with its own
token, join state, and egress. `.ROBLOSECURITY` goes in the form — or in
`server/cnfg.json` once so the field can be left blank.

First run pulls everything it needs itself — no config file required:

- TLS certs self-generate on boot (accept the browser warning once).
- Upstream hosts fall back to `server/cnfg.example.json` → `upstream`.
- Engine payload: start the server, then `npm run sync` — it streams the wasm
  + ~120MB content tree through the local gateway into `core/staging/`.
  Rebuild once (`npm run build`) so the payload lands in `out/`.

## As a library

```js
import { launch } from 'roblox-webport';

const s = await launch({ port: 9989 });

// each session gets its own sid — own token, join state, WARP egress IP
const a = await s.session({ token: tokenA, placeId: 1818 });
const b = await s.session({ token: tokenB, placeId: 1818 });
// a.playUrl -> https://localhost:9989/pg/<sidA>/?gid=1818

console.log(a.playUrl);              // open in Chrome
await s.stop();                      // tears down server + WT front
```

`launch({ token, placeId })` is sugar for the common one-session case —
it mints the first sid and sets `s.playUrl` itself.

Every option also works as a `cnfg.json` key or CLI flag
(`--token --place --port --method --warp`). Order: launch opts > env >
`server/cnfg.json` > `server/cnfg.example.json`.

## Configuration

| key | cnfg.json | env | default |
|---|---|---|---|
| account token | `robloxAuthToken` | `RH_TOKEN` | — |
| port | `port` | `RH_PORT` | 9989 |
| join shape | `joinMethod` | `RH_JOIN_METHOD` | `auto` |
| web-join UA | `webUserAgent` | `RH_WEB_UA` | `Roblox/Web Windows` |
| upstream hosts | `upstream` | `RH_UPSTREAM` (JSON) | example file |
| egress proxies | `warpProxies` | `WARP_SOCKS` (single) | direct |

`warpProxies` is a pool of local SOCKS5 endpoints (e.g. Cloudflare WARP's
`127.0.0.1:40000`, several instances for several IPs). Each sid pins one by
hash, so concurrent sessions reach the upstream on different IPs.

`joinMethod`: `web` sends the honest web-play shape; `desktop` sends the
desktop shape (`Roblox/WinInet` + browserTrackerId, survives `status:12`
gates); `auto` tries web then falls back. See `docs/METHOD.md`.

| persistence | `database` | `DATABASE_URL` | sqlite |

`database` empty = sqlite at `server/data/webport.db` (zero deps, fine for
personal use). A `postgres://` URL switches to postgres for bigger
deployments (`npm i pg`). Stores cache-manifest + session metadata only —
never tokens.

### Private vault (token + catalog)

Keep the account token and the landing-page game catalog in a **private**
GitHub repo instead of `cnfg.json` and the local files:

```json
"github": {
  "repo": "you/roweb-private",
  "token": "<fine-grained PAT — Contents: read>",
  "tokenPath": "secret/roblox-token.txt",
  "catalogPath": "catalog"
}
```

`secret/roblox-token.txt` holds the `.ROBLOSECURITY` value. The server reads
it at boot — and re-reads it every `cacheMs` (default 60s) so a rotated token
is picked up without a restart — and only ever uses it server-side: once it is
loaded the landing page shows no token field, and nothing about the token or
the PAT is sent to the browser. A read failure is not fatal; the server falls
back to `robloxAuthToken` and `server/catalog/`.

Every `catalog/*.json` file in that repo becomes a row on the landing page:

```json
{
  "title": "Recommended",
  "subtitle": "Hand-picked classics",
  "games": [
    { "name": "Crossroads", "placeId": 1818, "icon": "https://…",
      "description": "…", "tag": "Fighting", "creator": "Roblox" }
  ]
}
```

`name` and `placeId` are required; `icon`, `description`, `tag`, `creator`,
`players` and `universeId` are optional (a missing icon is resolved from the
public thumbnails API). File name = row id, so `recommended.json` and
`popular.json` sort first. Env equivalents: `GH_VAULT_REPO`,
`GH_VAULT_TOKEN`, `GH_VAULT_BRANCH`, `GH_VAULT_TOKEN_PATH`,
`GH_CATALOG_PATH`, `GH_VAULT_TTL`.

### Vercel

`vercel.json` serves the landing UI as static output and proxies `/pg`,
`/api/*` and the engine asset paths to a running webport host — put that
host in the rewrite destinations. The game server itself (UDP WebTransport,
Python front, long-lived sessions) needs a real host; Vercel is only the
front door.

## Layout

```
index.mjs        launch() API + CLI
server/
  index.js       bootstrap: ctx -> middleware -> routes -> https + ws + WT
  config.js      cnfg.json + env + upstream host map
  db/            sqlite (default) / postgres / memory drivers
  lib/           proxy (forward+cache+agents), sessions, join, router, session state, ws
  middleware/    cors, session attach, static out/ serving
  routes/        pages (landing, /pg, stats, diagnostics) + api gateway
  wt_server.py   aioquic WebTransport front (UDP :9989)
  quic_bridge.py WT -> RUPP-wrapped QUIC -> UDMux edge
  cnfg.json      your config (gitignored)
core/
  js/            client source -> bundled by build.mjs
  staging/       engine payload (gitignored; manifests only)
  build.mjs      -> out/
tools/           playwright verify + datagram test harnesses
docs/            protocol, join flow, services, decomp notes
scripts/         fetch-engine.mjs (direct-CDN acquisition)
```

## Engine payload

Nothing upstream is redistributed. Three ways to get it:

1. `npm run sync` (recommended) — pulls every file in
   `WebClient.metadata.json` plus the wasm through the running gateway.
2. `npm run fetch-engine` — hits the versioned CDN package directly.
3. Dump the files a real web session downloads into `core/staging/`.

## Status

End-to-end live: auth (`status:2`, real joinScript), WT accept, world
streaming, avatar spawn, local movement replicating upstream, remote players
animating (~100 physics datagrams/s each way), sessions past the previous
~40s failure window.

## Docs

`docs/` — wire protocol (`protocol.md`), join flow (`join-flow.md`), the
join-shape method (`METHOD.md`), every outbound service (`services.md`,
`apis.md`), transport internals (`shim-relay.md`, `socket-ring.md`), the wasm
decomp pipeline (`decomp.md`, `audit.md`), and how it all got figured out
(`journey.md`).

## Legal

License is `LICENSE` — free to use/copy/modify/redistribute with two rules
for public builds: don't add scripting/exploit capability to the client,
and don't capture or log credentials, tokens, or cert material. Private
use is unrestricted; you're responsible for following the ToS of whatever
service you connect to (Roblox's included). If you ship something built on
this, a RubiksHead shout-out is appreciated — not required.

Contains no upstream binaries or content. Bring your own engine dump and
your own account.
