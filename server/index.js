// index.js — bootstrap: config -> db -> transport libs -> middleware -> routes
// -> https + ws relay + native WebTransport front.
//
// Layout:
//   config.js            cnfg.json + env + upstream host map
//   db/                  persistence (sqlite default, postgres via DATABASE_URL)
//   lib/proxy.js         upstream forward, cache, egress agents, DNS pinning
//   lib/sessions.js      per-sid browser sessions (rh_sid cookie)
//   lib/join.js          joinScript transform + web-shape join
//   lib/router.js        micro router
//   middleware/          cors, session attach, static out/ serving
//   routes/pages.js      landing, /pg, /session, /stats, diagnostics
//   routes/api.js        /api/<domainId>/ upstream gateway + domain specials
//   relay.js             ws -> UDP/TCP relay (legacy transport path)
//   wt_server.py         native WebTransport/QUIC front (python/aioquic)
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const child_process = require('child_process');

(async () => {

const ctx = require('./config');
const { PORT, UP_DOMAIN, UP_CDN, UP_QDMUX, UP_PLAY, SERVER_DIR, MAP } = ctx;
ctx.session = require('./lib/session');
ctx.relay = require('./relay');
const relay = ctx.relay;
ctx.db = await require('./db').open(ctx);
console.log(`[db] ${ctx.db.kind}`);
ctx.manifestSeed = await ctx.db.loadManifest();

Object.assign(ctx, require('./lib/proxy')(ctx));
// landing-page helpers + the private-repo vault. The vault resolves the
// .ROBLOSECURITY token before sessions are created, so every session and
// every upstream call uses it — the token never reaches the browser.
ctx.public = require('./lib/roblox-public')(ctx);
ctx.vault = require('./lib/vault')(ctx);
await ctx.vault.loadToken();
ctx.vault.startRefresh();
Object.assign(ctx, require('./lib/sessions')(ctx));
Object.assign(ctx, require('./lib/join')(ctx));
ctx.serveStatic = require('./middleware/static')(ctx);

// native WebTransport front — the browser engine dials a real WebTransport
// here instead of the ws shim; wt_server.py relays each session into a
// quic_bridge.py subprocess via the existing shim frames.
const WT_PORT = +(process.env.WT_PORT || PORT);
// default on (WT_FRONT=0 opts out) — hash pinning works: Chrome's
// serverCertificateHashes verifier requires a self-signed ECDSA P-256 leaf
// with <=14d validity; the ws fail-latch covers any handshake failure anyway.
ctx.WT_META = { port: WT_PORT, hash: null, enabled: process.env.WT_FRONT !== '0' };
const WT_META = ctx.WT_META;

const app = require('./lib/router')();
app.use(require('./middleware/cors')(ctx));
app.use(require('./middleware/session')(ctx));
require('./routes')(app, ctx);
// everything unrouted lands on static out/ (+ landing/play routing)
app.add(null, /^/, (req, res, u) => ctx.serveStatic(u, res, req));

// ---------- server -----------------------------------------------------------
// main TLS cert self-generates when absent — localhost-only, so a throwaway
// self-signed ECDSA cert is fine (browser prompts once, then cached).
if (!fs.existsSync(path.join(__dirname, 'cert.pem')) || !fs.existsSync(path.join(__dirname, 'key.pem'))) {
  try {
    child_process.execFileSync('openssl', ['req', '-x509', '-newkey', 'ec',
      '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '30',
      '-subj', '/CN=localhost', '-keyout', 'key.pem', '-out', 'cert.pem',
      '-addext', 'subjectAltName=DNS:localhost,DNS:*.localhost,IP:127.0.0.1,IP:::1'],
      { cwd: __dirname });
    console.log('[server] generated self-signed localhost cert (cert.pem/key.pem)');
  } catch (e) { console.log('[server] cert gen failed — provide server/cert.pem + key.pem:', e.message); }
}
const srv = https.createServer({
  cert: fs.readFileSync(path.join(__dirname, 'cert.pem')),
  key: fs.readFileSync(path.join(__dirname, 'key.pem')),
}, (req, res) => app.handle(req, res));

// serverCertificateHashes pins the LEAF the WT endpoint presents (wt-cert.pem
// via wt-chain.pem), not the main TLS cert.pem — a mismatch fails the WT
// connect outright. Chrome also caps hash-pinned cert lifetimes at ~14 days,
// so the leaf is a 13-day cert regenerated on boot when it has <5 days left.
function wtLeafOk() {
  try {
    const pem = fs.readFileSync(path.join(__dirname, 'wt-cert.pem'), 'utf8');
    const txt = child_process.execFileSync('openssl',
      ['x509', '-text', '-noout'], { input: pem }).toString();
    // RSA leaves are rejected outright on the hash-pin path — force regen
    if (!txt.includes('id-ecPublicKey')) return false;
    const end = new Date(txt.match(/Not After\s*:\s*(.+)/)[1].trim());
    return end.getTime() - Date.now() > 5 * 864e5;
  } catch { return false; }
}
if (!wtLeafOk()) {
  try {
    const d = __dirname;
    // ECDSA P-256 — the only key type every engine accepts for hash pinning
    child_process.execFileSync('openssl', ['ecparam', '-genkey', '-name',
      'prime256v1', '-out', 'wt-key.pem'], { cwd: d });
    child_process.execFileSync('openssl', ['req', '-new', '-key', 'wt-key.pem',
      '-out', 'wt-csr.pem', '-subj', '/CN=localhost'], { cwd: d });
    // self-signed — Chrome's serverCertificateHashes path requires it;
    // a CA-issued leaf is rejected as QUIC_TLS_CERTIFICATE_UNKNOWN
    child_process.execFileSync('openssl', ['x509', '-req', '-in', 'wt-csr.pem',
      '-signkey', 'wt-key.pem', '-out', 'wt-cert.pem', '-days', '13',
      '-extfile', 'wt-ext.cnf', '-extensions', 'wt_ext'], { cwd: d });
    fs.writeFileSync(path.join(d, 'wt-chain.pem'),
      fs.readFileSync(path.join(d, 'wt-cert.pem')));
    console.log('[wt-front] regenerated 13-day self-signed ECDSA leaf');
  } catch (e) { console.log('[wt-front] cert regen failed:', e.message); }
}
try {
  const der = fs.readFileSync(path.join(__dirname, 'wt-cert.pem')).toString()
    .match(/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/)[1];
  WT_META.hash = crypto.createHash('sha256').update(Buffer.from(der, 'base64')).digest('base64');
} catch (e) { console.log('[wt-front] cert hash failed:', e.message); }
if (WT_META.enabled) {
  const _wtPy = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const _wtSrv = child_process.spawn(_wtPy, [path.join(__dirname, 'wt_server.py')],
    { env: { ...process.env, WT_PORT: String(WT_PORT), UP_DOMAIN, UP_CDN, UP_QDMUX, UP_WT_ORIGIN: `https://${UP_PLAY}` }, stdio: ['ignore', 'inherit', 'inherit'] });
  _wtSrv.on('error', e => console.log('[wt-front] spawn failed:', e.message));
  _wtSrv.on('exit', c => console.log(`[wt-front] exited (${c})`));
}

// client socket/TLS errors are forwarded here — without a listener they can
// take the whole process down (one bad connection = every session dropped)
srv.on('clientError', (e, socket) => { try { socket.destroy(); } catch {} });

// relay self-registers the /udp-relay upgrade handler
relay.attach(srv);

srv.listen(PORT, () => console.log(`[server] :${PORT} — /api map(${Object.keys(MAP).length}) + /udmux /session /join + ws:/udp-relay`));

})().catch(e => { console.error(e); process.exit(1); });
