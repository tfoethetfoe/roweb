// routes/games.js — the landing page's JSON surface: the game catalog from
// the private repo (or server/catalog/), live game search, and place info.
// These sit in front of the /api/<domainId>/ upstream gateway on purpose.
module.exports = function initGames(r, ctx) {
const { CFG } = ctx;

const json = (res, code, body, cache = 'no-store') => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': cache });
  res.end(JSON.stringify(body));
};
const wrap = fn => (req, res, u) => {
  fn(req, res, u).catch(e => {
    console.log(`[games] ${u.pathname} failed: ${e.message}`);
    if (!res.headersSent) json(res, 502, { error: e.message || 'upstream failed' });
    else res.end();
  });
};

// GET /api/catalog -> { sections:[{id,title,subtitle,games:[…]}], source, repo }
r.get('/api/catalog', wrap(async (req, res) => {
  const data = await ctx.vault.getCatalog();
  json(res, 200, {
    source: data.source,
    repo: data.repo,
    configured: data.configured,
    error: data.error || undefined,
    fetchedAt: data.fetchedAt,
    sections: data.sections,
  }, 'public, max-age=30');
}));

// GET /api/search?q=&cursor= -> live game search (public upstream search)
r.get('/api/search', wrap(async (req, res, u) => {
  const q = (u.searchParams.get('q') || '').trim();
  if (q.length < 2) return json(res, 200, { results: [], nextCursor: '', query: q });
  const { results, nextCursor } = await ctx.public.searchGames(q, u.searchParams.get('cursor') || '');
  json(res, 200, { query: q, results, nextCursor }, 'public, max-age=15');
}));

// GET /api/place?id= -> one place's name/icon/etc (history entries, bare ids)
r.get('/api/place', wrap(async (req, res, u) => {
  const id = +(u.searchParams.get('id') || u.searchParams.get('placeId') || 0);
  if (!id) return json(res, 400, { error: 'id required' });
  const info = await ctx.public.placeInfo(id);
  json(res, 200, info, 'public, max-age=60');
}));

// GET /api/status -> what the landing page needs to know about the server
r.get('/api/status', wrap(async (req, res) => {
  const sess = req.sess || {};
  json(res, 200, {
    // a token loaded from the private repo makes the token field unnecessary
    defaultToken: !!ctx.TOKEN,
    vault: {
      configured: ctx.vault.configured,
      repo: ctx.vault.repo,
      tokenLoaded: ctx.vault.tokenLoaded(),
      catalog: (CFG.github && CFG.github.catalogPath) || 'catalog',
    },
    resume: sess.sid
      ? { sid: sess.sid, url: `/pg/${sess.sid}/${sess.placeId ? `?gid=${sess.placeId}` : ''}`, placeId: sess.placeId || null }
      : null,
  });
}));
}
