#!/usr/bin/env node
// index.mjs — starts the webport server. No args needed:
//
//   node index.mjs          -> open https://localhost:9989 in Chrome,
//                              enter a place id + .ROBLOSECURITY, play
//
// As a library it also does headless session management — launch() returns a
// handle whose session() mints a /pg/<sid>/ URL with its own token, CSRF,
// join state, and WARP egress (see warpProxies / WARP_SOCKS):
//
//   import { launch } from './index.mjs';
//   const s = await launch();
//   const { playUrl } = await s.session({ token, placeId: 1818 });
//   await s.stop();
//
// Optional CLI flags (all have cnfg.json / env fallbacks):
//   --token <.ROBLOSECURITY> --place <id> --port 9989 --method auto|web|desktop
//   --warp 127.0.0.1:40000 --python <exe> --quiet

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(ROOT, 'server', 'index.js');

function postJson(port, p, body) {
  return new Promise((resolve, reject) => {
    const r = https.request({
      host: '127.0.0.1', port, path: p, method: 'POST',
      rejectUnauthorized: false,
      headers: { 'content-type': 'application/json' },
    }, res => {
      const c = [];
      res.on('data', d => c.push(d));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(c).toString())); } catch (e) { reject(e); } });
    });
    r.on('error', reject);
    r.end(JSON.stringify(body || {}));
  });
}

/**
 * Start the webport server (one port — TCP HTTPS + UDP WebTransport share it).
 * @param {object}  opts
 * @param {string}  opts.token       .ROBLOSECURITY cookie value — mints the
 *                                  first session when set
 * @param {number}  [opts.placeId]   place for the first session's playUrl
 * @param {number}  [opts.port=9989] the single exposed port
 * @param {string}  [opts.joinMethod] 'auto' | 'web' | 'desktop'
 * @param {object}  [opts.upstream]  {domain, cdn, infra?, labs?, extra?[]}
 * @param {string}  [opts.webUserAgent]
 * @param {string}  [opts.python]    python executable for the WT front
 * @param {string}  [opts.warp]      SOCKS5 host:port for upstream egress
 *                                  (WARP local proxy); pool of proxies via
 *                                  cnfg warpProxies for per-sid IPs
 * @param {boolean} [opts.quiet]     suppress child stdout/stderr
 * @param {number}  [opts.timeoutMs=30000]
 */
export async function launch(opts = {}) {
  const {
    token = process.env.ROBLOSECURITY || '',
    placeId,
    port = 9989,
    joinMethod,
    upstream,
    webUserAgent,
    python,
    warp,
    quiet = false,
    timeoutMs = 30000,
  } = opts;

  const env = { ...process.env, RH_PORT: String(port), WT_PORT: String(port) };
  if (token) env.RH_TOKEN = token;
  if (joinMethod) env.RH_JOIN_METHOD = joinMethod;
  if (upstream) env.RH_UPSTREAM = JSON.stringify(upstream);
  if (webUserAgent) env.RH_WEB_UA = webUserAgent;
  if (python) env.PYTHON = python;
  if (warp) env.WARP_SOCKS = warp;

  const proc = spawn(process.execPath, [SERVER], {
    env, cwd: ROOT,
    stdio: ['ignore', quiet ? 'ignore' : 'inherit', quiet ? 'ignore' : 'inherit'],
  });

  // wait until the HTTPS listener answers (or the child dies)
  const ping = () => new Promise(res => {
    const r = https.get(`https://127.0.0.1:${port}/`, { rejectUnauthorized: false }, x => { x.resume(); res(true); });
    r.on('error', () => res(false));
    r.setTimeout(1500, () => { r.destroy(); res(false); });
  });
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (proc.exitCode !== null) throw new Error(`server exited (${proc.exitCode}) before listening`);
    if (await ping()) break;
    await new Promise(r => setTimeout(r, 300));
    if (Date.now() - t0 >= timeoutMs)
      throw new Error(`server did not listen on :${port} within ${timeoutMs}ms`);
  }

  const base = `https://localhost:${port}`;
  const h = {
    port,
    url: base + '/',
    proc,
    /** Mint a /pg/<sid>/ session — its own token, join state, WARP egress. */
    session: async (s = {}) => {
      const r = await postJson(port, '/pg', { token: s.token, placeId: s.placeId, joinMethod: s.joinMethod });
      const url = `${base}/pg/${r.sid}/`;
      return { sid: r.sid, url, playUrl: s.placeId ? `${url}?gid=${s.placeId}` : url };
    },
    stop: () => new Promise(resolve => {
      proc.once('exit', () => resolve());
      if (process.platform === 'win32')
        spawn('taskkill', ['/T', '/F', '/PID', String(proc.pid)], { stdio: 'ignore' });
      else proc.kill('SIGTERM');
      setTimeout(resolve, 3000).unref();
    }),
  };

  if (token || placeId) {
    const s = await h.session({ token, placeId, joinMethod });
    h.sid = s.sid;
    h.playUrl = s.playUrl;
  } else {
    h.playUrl = h.url;
  }
  return h;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const a = process.argv.slice(2);
  const val = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const s = await launch({
    token: val('--token'),
    placeId: val('--place', val('--id')) ? +val('--place', val('--id')) : undefined,
    port: +val('--port', 9989),
    joinMethod: val('--method'),
    python: val('--python'),
    warp: val('--warp'),
    quiet: a.includes('--quiet'),
  });
  console.log(`\nwebport up — ${s.url}`);
  if (s.sid) console.log(`play:     ${s.playUrl}`);
  console.log('ctrl-c to stop');
  const bye = () => s.stop().then(() => process.exit(0));
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}
