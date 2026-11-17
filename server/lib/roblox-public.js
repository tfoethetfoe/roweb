// lib/roblox-public.js — the public (unauthenticated) web APIs the landing
// page uses: game search, one place's metadata, and game icons. Every host
// derives from the configured upstream domain, so no upstream literal lives
// in the source tree. Nothing here needs or receives an account token.
const https = require('https');
const crypto = require('crypto');

const MAX_BODY = 4 << 20;      // search pages are small; refuse anything huge
const ICON_TTL = 6 * 3600e3;   // icon URLs are stable for hours

module.exports = function initPublicApi(ctx) {
const { UP_DOMAIN } = ctx;
const HOSTS = {
  apis: `apis.${UP_DOMAIN}`,
  games: `games.${UP_DOMAIN}`,
  thumbnails: `thumbnails.${UP_DOMAIN}`,
};
// one id per process — upstream groups a search session by this value
const SEARCH_SESSION = crypto.randomUUID();

function request(host, path, { timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const rq = https.request({
      host, path, method: 'GET', agent: ctx.UP_AGENT,
      headers: { 'user-agent': 'Roblox/WinInet', accept: 'application/json' },
    }, res => {
      const chunks = [];
      let len = 0;
      res.on('data', c => {
        len += c.length;
        if (len > MAX_BODY) return rq.destroy(new Error(`${host}: response too large`));
        chunks.push(c);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300)
          return reject(new Error(`${host} ${res.statusCode}`));
        try { resolve(JSON.parse(text)); } catch { reject(new Error(`${host}: non-JSON reply`)); }
      });
      res.on('error', reject);
    });
    rq.setTimeout(timeout, () => rq.destroy(new Error(`${host}: timeout`)));
    rq.on('error', reject);
    rq.end();
  });
}
// best-effort variant — decorations never take a page down
const getJson = (host, path) => request(host, path).catch(() => null);

// ---------- icons ------------------------------------------------------------
const iconCache = new Map();   // universeId -> { url, at }
async function icons(universeIds) {
  const out = new Map();
  const ids = [...new Set(universeIds.map(Number).filter(Boolean))];
  const missing = [];
  for (const id of ids) {
    const hit = iconCache.get(id);
    if (hit && Date.now() - hit.at < ICON_TTL) { if (hit.url) out.set(id, hit.url); }
    else missing.push(id);
  }
  for (let i = 0; i < missing.length; i += 50) {
    const chunk = missing.slice(i, i + 50);
    const j = await getJson(HOSTS.thumbnails,
      `/v1/games/icons?universeIds=${chunk.join(',')}&size=150x150&format=Png&isCircular=false`);
    const byId = new Map((j?.data || [])
      .filter(d => d && d.imageUrl)
      .map(d => [Number(d.targetId), d.imageUrl]));
    for (const id of chunk) {
      const url = byId.get(id) || '';
      iconCache.set(id, { url, at: Date.now() });
      if (url) out.set(id, url);
    }
    // keep the cache bounded without dropping everything on a full map
    while (iconCache.size > 4000) iconCache.delete(iconCache.keys().next().value);
  }
  return out;
}

// ---------- place -> universe -> metadata ------------------------------------
async function universeForPlace(placeId) {
  const j = await getJson(HOSTS.apis, `/universes/v1/places/${+placeId}/universe`);
  return +(j?.universeId || 0) || null;
}

function shapeGame(game, universeId, icon) {
  return {
    placeId: +(game?.rootPlaceId || 0) || null,
    universeId: universeId || null,
    name: String(game?.name || ''),
    description: String(game?.description || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    players: +(game?.playing || 0) || 0,
    visits: +(game?.visits || 0) || 0,
    creator: game?.creator?.name || '',
    tag: game?.genre || '',
    icon: icon || '',
  };
}

/** One place's public metadata — used to name/illustrate a bare place id. */
async function placeInfo(placeId) {
  const id = +placeId;
  if (!id) return null;
  const universeId = await universeForPlace(id);
  let game = null;
  if (universeId) {
    const j = await getJson(HOSTS.games, `/v1/games?universeIds=${universeId}`);
    game = j?.data?.[0] || null;
  }
  const icon = universeId ? (await icons([universeId])).get(universeId) || '' : '';
  if (!game) return { placeId: id, universeId, name: `Place ${id}`, icon, players: 0,
    description: '', creator: '', tag: '', visits: 0 };
  return { ...shapeGame({ ...game, rootPlaceId: game.rootPlaceId || id }, universeId, icon), placeId: id };
}

/** Game search — the same omni-search endpoint the site's search box hits. */
async function searchGames(query, cursor = '') {
  const q = String(query || '').trim().slice(0, 80);
  if (!q) return { results: [], nextCursor: '' };
  const qs = new URLSearchParams({ searchQuery: q, sessionId: SEARCH_SESSION, pageToken: cursor || '' });
  const j = await request(HOSTS.apis, `/search-api/omni-search?${qs}`);
  const raw = [];
  const seen = new Set();
  for (const group of j?.searchResults || []) {
    for (const item of group?.contents || []) {
      if (!item || item.contentType !== 'Game' || !item.rootPlaceId) continue;
      if (seen.has(item.rootPlaceId)) continue;   // sponsored slots repeat games
      seen.add(item.rootPlaceId);
      raw.push(item);
    }
  }
  const iconsById = await icons(raw.map(i => i.universeId));
  const results = raw.map(i => {
    const universeId = Number(i.universeId) || null;
    return {
      placeId: i.rootPlaceId,
      universeId,
      name: i.name,
      description: String(i.description || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      players: Number(i.playerCount) || 0,
      votes: Number(i.totalUpVotes) || 0,
      creator: i.creatorName || '',
      tag: i.genreL1 || '',
      icon: iconsById.get(universeId) || '',
    };
  });
  return { results, nextCursor: j?.nextPageToken || '' };
}

return { searchGames, placeInfo, icons, universeForPlace, hosts: HOSTS };
}
