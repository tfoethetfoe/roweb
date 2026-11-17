// lib/vault.js — private GitHub repo store.
//
// Two things live in a *private* repo and are read here, server-side only:
//   secret/roblox-token.txt   the .ROBLOSECURITY value
//   catalog/*.json            landing-page game sections (name/icon/placeId/…)
//
// The browser never receives the token, the PAT, or the repo's raw files —
// only normalized game metadata. A read failure is never fatal: the server
// falls back to cnfg.json's token and the local server/catalog/ files.
//
// config (cnfg.json, all optional):
//   "github": {
//     "repo": "you/roweb-private",   // owner/name of the private repo
//     "token": "<fine-grained PAT, contents: read>",  // or GH_VAULT_TOKEN
//     "branch": "",                  // default branch when empty
//     "tokenPath": "secret/roblox-token.txt",
//     "catalogPath": "catalog",
//     "cacheMs": 60000
//   }
const https = require('https');
const fs = require('fs');
const path = require('path');

const GH_HOST = 'api.github.com';
const SECTION_ORDER = ['recommended', 'popular'];

module.exports = function initVault(ctx) {
const { CFG, SERVER_DIR } = ctx;
const G = CFG.github || {};
const REPO = process.env.GH_VAULT_REPO || G.repo || '';
// the PAT is a server-side secret: env wins, cnfg.json is gitignored
const PAT = process.env.GH_VAULT_TOKEN || process.env.GITHUB_TOKEN || G.token || '';
const BRANCH = process.env.GH_VAULT_BRANCH || G.branch || '';
const TOKEN_FILE = process.env.GH_VAULT_TOKEN_PATH || G.tokenPath || 'secret/roblox-token.txt';
const CATALOG_DIR = String(process.env.GH_CATALOG_PATH || G.catalogPath || 'catalog')
  .replace(/^\/+|\/+$/g, '');
const TTL = Math.max(15e3, +(process.env.GH_VAULT_TTL || G.cacheMs || 60e3));
const LOCAL_DIR = path.join(SERVER_DIR, 'catalog');
const configured = !!(REPO && PAT);

// ---------- GitHub reads -----------------------------------------------------
function encPath(p) { return String(p).split('/').filter(Boolean).map(encodeURIComponent).join('/'); }
const ref = BRANCH ? `?ref=${encodeURIComponent(BRANCH)}` : '';

function ghRequest(apiPath, accept) {
  return new Promise((resolve, reject) => {
    if (!configured) return reject(new Error('github vault not configured'));
    const rq = https.request({
      host: GH_HOST, path: apiPath, method: 'GET', timeout: 9000,
      headers: {
        'user-agent': 'roblox-webport',
        accept,
        authorization: `Bearer ${PAT}`,
        'x-github-api-version': '2022-11-28',
      },
    }, res => {
      const chunks = [];
      let len = 0;
      res.on('data', c => {
        len += c.length;
        if (len > 8 << 20) return rq.destroy(new Error('github: response too large'));
        chunks.push(c);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300)
          return reject(new Error(`github ${res.statusCode} for ${apiPath.split('?')[0]}`));
        resolve(text);
      });
      res.on('error', reject);
    });
    rq.on('timeout', () => rq.destroy(new Error('github: timeout')));
    rq.on('error', reject);
    rq.end();
  });
}

const ghRaw = file =>
  ghRequest(`/repos/${REPO}/contents/${encPath(file)}${ref}`, 'application/vnd.github.raw');
const ghList = async dir =>
  JSON.parse(await ghRequest(`/repos/${REPO}/contents/${encPath(dir)}${ref}`,
    'application/vnd.github+json'));

// ---------- the account token ------------------------------------------------
function normalizeToken(text) {
  const line = String(text || '').split(/\r?\n/).map(s => s.trim()).find(Boolean) || '';
  return line.replace(/^ROBLOSECURITY\s*=\s*/i, '').replace(/^["']|["']$/g, '').trim();
}

let tokenState = { value: '', at: 0 };

async function refreshToken() {
  const value = normalizeToken(await ghRaw(TOKEN_FILE));
  if (!value) return '';
  tokenState = { value, at: Date.now() };
  if (ctx.TOKEN !== value) {
    ctx.TOKEN = value;
    CFG.robloxAuthToken = value;
    console.log('[vault] .ROBLOSECURITY loaded from the private repo');
  }
  return value;
}

/**
 * Pull the token before sessions are wired up, so every minted session and
 * every upstream call uses it. An explicit env token (--token / RH_TOKEN)
 * still wins: embedders pass credentials directly.
 */
async function loadToken() {
  if (!configured) {
    if (REPO && !PAT) console.log('[vault] repo set but no PAT (GH_VAULT_TOKEN) — using local token');
    return false;
  }
  if (process.env.RH_TOKEN || process.env.ROBLOSECURITY) {
    console.log('[vault] explicit token from the environment wins over the vault');
    return false;
  }
  try {
    return !!(await refreshToken());
  } catch (e) {
    console.log(`[vault] token read failed (${e.message}) — falling back to cnfg.json`);
    return false;
  }
}

/** Keep a long-running server in sync when the token is rotated in the repo. */
function startRefresh() {
  if (!configured || process.env.RH_TOKEN || process.env.ROBLOSECURITY) return;
  const timer = setInterval(() => {
    if (Date.now() - tokenState.at >= TTL) refreshToken().catch(() => {});
  }, TTL);
  timer.unref();
}

// ---------- the catalog ------------------------------------------------------
function gameFrom(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const placeId = +(raw.placeId ?? raw.place_id ?? raw.place ?? raw.id ?? 0);
  if (!placeId) return null;
  return {
    name: String(raw.name || raw.title || `Place ${placeId}`),
    placeId,
    universeId: +(raw.universeId || 0) || null,
    icon: String(raw.icon || raw.image || raw.thumbnail || ''),
    description: String(raw.description || raw.desc || '').slice(0, 240),
    tag: String(raw.tag || raw.genre || ''),
    players: +(raw.players ?? raw.playerCount ?? 0) || 0,
    creator: String(raw.creator || raw.creatorName || ''),
  };
}

function sectionFrom(id, raw, file) {
  const isArray = Array.isArray(raw);
  const titleFallback = file.replace(/\.json$/i, '').replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
  const games = (isArray ? raw : Array.isArray(raw?.games) ? raw.games : [])
    .map(gameFrom).filter(Boolean);
  return {
    id: String((!isArray && raw?.id) || file.replace(/\.json$/i, '') || id),
    title: String((!isArray && (raw?.title || raw?.name)) || titleFallback),
    subtitle: String((!isArray && (raw?.subtitle || '') || '')),
    games,
  };
}

function orderSections(sections) {
  const rank = s => {
    const i = SECTION_ORDER.indexOf(s.id.toLowerCase());
    return i < 0 ? SECTION_ORDER.length : i;
  };
  return sections.sort((a, b) => rank(a) - rank(b)
    || a.title.localeCompare(b.title));
}

function localSections() {
  let files = [];
  try { files = fs.readdirSync(LOCAL_DIR).filter(f => /\.json$/i.test(f)); } catch {}
  const sections = [];
  for (const file of files) {
    try {
      sections.push(sectionFrom(file.replace(/\.json$/i, ''), JSON.parse(fs.readFileSync(path.join(LOCAL_DIR, file), 'utf8')), file));
    } catch { /* a malformed local file is skipped, not fatal */ }
  }
  return orderSections(sections);
}

async function remoteSections() {
  const entries = await ghList(CATALOG_DIR);
  const files = (Array.isArray(entries) ? entries : [])
    .filter(f => f && f.type === 'file' && /\.json$/i.test(f.name))
    .map(f => f.name)
    .sort();
  if (!files.length) throw new Error(`no JSON files in ${CATALOG_DIR}/`);
  const texts = await Promise.all(files.map(f => ghRaw(`${CATALOG_DIR}/${f}`).catch(() => null)));
  const sections = [];
  for (let i = 0; i < files.length; i++) {
    if (!texts[i]) continue;
    try { sections.push(sectionFrom(files[i].replace(/\.json$/i, ''), JSON.parse(texts[i]), files[i])); }
    catch { console.log(`[vault] ${CATALOG_DIR}/${files[i]} is not valid JSON — skipped`); }
  }
  return orderSections(sections);
}

// fill in missing icons from the public thumbnails API (place -> universe)
async function withIcons(sections) {
  const games = sections.flatMap(s => s.games);
  const need = games.filter(g => !g.icon);
  if (!need.length) return sections;
  const universeIds = new Map();
  await Promise.all(need.map(async g => {
    if (g.universeId) return universeIds.set(g.placeId, g.universeId);
    const u = await ctx.public.universeForPlace(g.placeId);
    if (u) { universeIds.set(g.placeId, u); g.universeId = u; }
  }));
  if (!universeIds.size) return sections;
  const icons = await ctx.public.icons([...universeIds.values()]);
  for (const g of need) {
    const u = universeIds.get(g.placeId);
    if (u && icons.get(u)) g.icon = icons.get(u);
  }
  return sections;
}

let catalogCache = { at: 0, data: null };

/** Normalized catalog for the landing page: [{id,title,subtitle,games:[…]}]. */
async function getCatalog() {
  if (catalogCache.data && Date.now() - catalogCache.at < TTL) return catalogCache.data;
  let sections = null, source = 'local', error = '';
  if (configured) {
    try { sections = await remoteSections(); source = 'github'; }
    catch (e) { error = e.message; console.log(`[vault] catalog read failed (${e.message}) — serving server/catalog/`); }
  }
  if (!sections) sections = localSections();
  sections = await withIcons(sections);
  const data = {
    configured, repo: REPO || null, source, error,
    fetchedAt: Date.now(), sections,
  };
  catalogCache = { at: Date.now(), data };
  return data;
}

return {
  configured, repo: REPO || null,
  loadToken, startRefresh, refreshToken, getCatalog,
  tokenLoaded: () => !!tokenState.value,
};
}
