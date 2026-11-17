// routes/index.js — route registration. Order matters: specific local
// routes first (pages, landing-page JSON), the /api gateway second,
// anything unmatched falls through to the static middleware.
module.exports = function initRoutes(r, ctx) {
  require('./pages')(r, ctx);
  require('./games')(r, ctx);
  require('./api')(r, ctx);
};
