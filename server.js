#!/usr/bin/env node
/* ===================================================================
   server.js — run the table on your own computer, no internet needed.

     node server.js --password SECRET            (port 8080)
     node server.js --password SECRET --port 3000 --data ./my-table

   Everyone opens http://<this computer's address>:8080 and types the
   password. Plain Node.js (16 or newer), no packages to install, so it
   works on a local network or on نت ملی without the outside internet.
   The table is saved in the data folder (default: ./table-data).
   =================================================================== */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

/* ------------------------------------------------------------ options */
const argv = process.argv.slice(2);
const opt = (name, d) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};
const PORT = parseInt(opt('port', process.env.PORT || '8080'), 10);
const PASSWORD = String(opt('password', process.env.TABLE_PASSWORD || ''));
const ROOT = __dirname;
const DATA_DIR = path.resolve(opt('data', path.join(ROOT, 'table-data')));
fs.mkdirSync(DATA_DIR, { recursive: true });

const MAX_DOC = 300 * 1024; // a map piece is ~190 KB
const MAX_BODY = 1024 * 1024;
const MAX_PRESENCE = 6 * 1024;
const MAX_PEERS = 40;

/* --------------------------------------------------------------- page */
// The built index.html is the page content; wrap it in a document and drop
// the Google Fonts links (unreachable during filtering; system fonts are used).
function buildPage() {
  const body = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
    .split('\n').filter((l) => !/fonts\.(googleapis|gstatic)\.com/.test(l)).join('\n');
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    '<style>:root{padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style></head><body>' +
    body + '</body></html>';
}
const PAGE = buildPage();
// compressed once at start: the page and rules data are about four times smaller on the wire
const zlib = require('zlib');
const PAGE_GZ = zlib.gzipSync(PAGE);
const PAGE_TAG = '"' + crypto.createHash('sha1').update(PAGE).digest('hex').slice(0, 16) + '"';
const dataGz = new Map();
const wantsGzip = (req) => /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
const DATA_FILES = new Set(['rules', 'spells', 'monsters', 'features']);

/* ---------------------------------------------------------- documents */
// paths look like "tokens/t123"; map pieces ("mapchunks/...") are kept as files
const PATH_RE = /^[a-z]{1,20}\/[A-Za-z0-9_~:@+-][A-Za-z0-9_.~:@+-]{0,119}$/;
const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
function deepMerge(a, b) {
  const out = isObj(a) ? Object.assign({}, a) : {};
  for (const k in b) {
    if (isObj(b[k]) && isObj(out[k])) out[k] = deepMerge(out[k], b[k]);
    else out[k] = b[k];
  }
  return out;
}
const isChunk = (p) => p.startsWith('mapchunks/');
// homebrew belongs to the whole game: it lives in the main table and every campaign sees it
const isGlobal = (p) => p.startsWith('homebrew/');

// One table per campaign: the default campaign ("main") lives in DATA_DIR itself,
// others in DATA_DIR/campaigns/<id>/. The list of campaigns is DATA_DIR/campaigns.json.
const CAMP_RE = /^[a-z0-9-]{1,40}$/;
const REG_FILE = path.join(DATA_DIR, 'campaigns.json');
let registry = [];
try {
  registry = JSON.parse(fs.readFileSync(REG_FILE, 'utf8')).filter((c) => c && CAMP_RE.test(c.id));
} catch (e) { /* none yet */ }
function saveRegistry() {
  const tmp = REG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(registry));
  fs.renameSync(tmp, REG_FILE);
}
const campaignExists = (cid) => cid === 'main' || registry.some((c) => c.id === cid);
const tables = new Map();
function table(cid) {
  if (tables.has(cid)) return tables.get(cid);
  const dir = cid === 'main' ? DATA_DIR : path.join(DATA_DIR, 'campaigns', cid);
  const t = { cid, dir, chunkDir: path.join(dir, 'chunks'), dbFile: path.join(dir, 'table.json'), docs: new Map(), clients: new Map(), saveTimer: null, peersTimer: null };
  fs.mkdirSync(t.chunkDir, { recursive: true });
  try {
    const saved = JSON.parse(fs.readFileSync(t.dbFile, 'utf8'));
    for (const p in saved) if (PATH_RE.test(p) && !isChunk(p)) t.docs.set(p, saved[p]);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error(`Could not read the saved table for "${cid}" (${e.message}). Starting it empty; the old file is kept as table.json.bad`);
      try { fs.copyFileSync(t.dbFile, t.dbFile + '.bad'); } catch (e2) { /* ignore */ }
    }
  }
  tables.set(cid, t);
  if (cid !== 'main') {
    // homebrew this campaign kept from before homebrew became game-wide moves to the main table
    const main = table('main');
    let moved = 0;
    [...t.docs.keys()].filter(isGlobal).forEach((p) => {
      if (!main.docs.has(p)) main.docs.set(p, t.docs.get(p));
      t.docs.delete(p);
      moved++;
    });
    if (moved) {
      save(t);
      save(main);
    }
  }
  return t;
}
table('main');

function save(t) {
  if (t.saveTimer) return;
  t.saveTimer = setTimeout(() => {
    t.saveTimer = null;
    const tmp = t.dbFile + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(t.docs)));
      fs.renameSync(tmp, t.dbFile);
    } catch (e) {
      console.error('Saving the table failed:', e.message);
    }
  }, 400);
}
const chunkFile = (t, p) => path.join(t.chunkDir, p.slice('mapchunks/'.length) + '.json');
function getDoc(t, p) {
  if (isGlobal(p)) t = table('main');
  if (!isChunk(p)) return t.docs.has(p) ? t.docs.get(p) : null;
  try {
    return JSON.parse(fs.readFileSync(chunkFile(t, p), 'utf8'));
  } catch (e) {
    return null;
  }
}
// apply one write; returns null or an error code
function applyWrite(t, op) {
  const p = op && op.p;
  if (typeof p !== 'string' || !PATH_RE.test(p)) return 'invalid_argument';
  if (isGlobal(p) && t.cid !== 'main') t = table('main');
  if (op.t === 'del') {
    if (isChunk(p)) fs.rm(chunkFile(t, p), { force: true }, () => {});
    else {
      t.docs.delete(p);
      save(t);
    }
    broadcast(t, 'doc', { p, d: null });
    return null;
  }
  if (!isObj(op.d)) return 'invalid_argument';
  let next;
  if (op.t === 'set') next = op.d;
  else if (op.t === 'upd') {
    const cur = getDoc(t, p);
    if (!cur) return 'invalid_argument'; // the page re-sends a set where that is meant
    next = deepMerge(cur, op.d);
  } else return 'invalid_argument';
  const text = JSON.stringify(next);
  if (text.length > MAX_DOC) return 'invalid_argument';
  if (isChunk(p)) {
    fs.writeFileSync(chunkFile(t, p), text);
    return null; // pieces are fetched when needed, not pushed to everyone
  }
  t.docs.set(p, next);
  save(t);
  broadcast(t, 'doc', { p, d: next });
  return null;
}

/* ------------------------------------------------- people + live push */
function send(res, event, data) {
  res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
}
function broadcast(t, event, data) {
  const msg = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  // a homebrew change reaches everyone, whatever campaign they're in
  const to = event === 'doc' && data && isGlobal(data.p) ? [...tables.values()] : [t];
  to.forEach((x) => x.clients.forEach((c) => c.res.write(msg)));
}
function peersSoon(t) {
  if (t.peersTimer) return;
  t.peersTimer = setTimeout(() => {
    t.peersTimer = null;
    broadcast(t, 'peers', { peers: [...t.clients].map(([peer, c]) => ({ peer, presence: c.presence, t: c.t })) });
  }, 40);
}
setInterval(() => tables.forEach((t) => t.clients.forEach((c) => c.res.write(': keep-alive\n\n'))), 20000);
const totalClients = () => [...tables.values()].reduce((n, t) => n + t.clients.size, 0);

/* ------------------------------------------------------------ helpers */
function authorized(url) {
  if (!PASSWORD) return true;
  const k = url.searchParams.get('key') || '';
  const a = crypto.createHash('sha256').update(k).digest();
  const b = crypto.createHash('sha256').update(PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}
const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
      } else parts.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'));
      } catch (e) {
        reject(Object.assign(new Error('bad json'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------- routes */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const route = url.pathname;
  try {
    if (req.method === 'GET' && (route === '/' || route === '/index.html')) {
      const head = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', etag: PAGE_TAG, vary: 'accept-encoding' };
      if (req.headers['if-none-match'] === PAGE_TAG) {
        res.writeHead(304, head);
        return res.end();
      }
      if (wantsGzip(req)) {
        res.writeHead(200, Object.assign(head, { 'content-encoding': 'gzip' }));
        return res.end(PAGE_GZ);
      }
      res.writeHead(200, head);
      return res.end(PAGE);
    }
    const dm = /^\/data\/([a-z]+)\.json$/.exec(route);
    if (req.method === 'GET' && dm && DATA_FILES.has(dm[1])) {
      const head = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'max-age=3600', vary: 'accept-encoding' };
      if (wantsGzip(req)) {
        if (!dataGz.has(dm[1])) dataGz.set(dm[1], zlib.gzipSync(fs.readFileSync(path.join(ROOT, 'data', dm[1] + '.json'))));
        res.writeHead(200, Object.assign(head, { 'content-encoding': 'gzip' }));
        return res.end(dataGz.get(dm[1]));
      }
      res.writeHead(200, head);
      return fs.createReadStream(path.join(ROOT, 'data', dm[1] + '.json')).pipe(res);
    }
    if (route === '/api/hello') return json(res, authorized(url) ? 200 : 401, { tavern: 1, locked: !!PASSWORD });
    if (!route.startsWith('/api/')) return json(res, 404, { code: 'not_found' });
    if (!authorized(url)) return json(res, 401, { code: 'revoked', message: 'wrong password' });

    if (route === '/api/campaigns') {
      if (req.method === 'GET') return json(res, 200, { campaigns: registry });
      if (req.method === 'POST') {
        const body = await readBody(req);
        const name = String(body.name || '').trim().slice(0, 60);
        if (!name) return json(res, 400, { code: 'invalid_argument', message: 'name needed' });
        if (body.id !== undefined) {
          // rename (the main campaign's name is kept in the list too)
          const id = String(body.id);
          if (!campaignExists(id)) return json(res, 404, { code: 'not_found' });
          const c = registry.find((x) => x.id === id);
          if (c) c.name = name;
          else registry.push({ id, name, created: Date.now() });
          saveRegistry();
          return json(res, 200, { id });
        }
        if (registry.length >= 50) return json(res, 400, { code: 'quota_exceeded', message: 'too many campaigns' });
        const id = 'c' + crypto.randomBytes(5).toString('hex');
        registry.push({ id, name, created: Date.now() });
        saveRegistry();
        table(id);
        return json(res, 200, { id });
      }
    }
    const cid = url.searchParams.get('c') || 'main';
    if (!CAMP_RE.test(cid) || !campaignExists(cid)) return json(res, 404, { code: 'not_found', message: 'no such campaign' });
    const t = table(cid);

    if (req.method === 'GET' && route === '/api/events') {
      if (totalClients() >= MAX_PEERS) return json(res, 503, { code: 'unavailable', message: 'table is full' });
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write('retry: 2000\n\n');
      const peer = 'p' + crypto.randomBytes(8).toString('hex');
      t.clients.set(peer, { res, presence: {}, t: Date.now(), owner: isLocal(req) });
      send(res, 'hello', { peer, owner: isLocal(req) });
      const snap = Object.fromEntries([...t.docs].filter(([p]) => !isGlobal(p)));
      table('main').docs.forEach((d, p) => isGlobal(p) && (snap[p] = d));
      send(res, 'snap', { docs: snap });
      peersSoon(t);
      req.on('close', () => {
        t.clients.delete(peer);
        peersSoon(t);
      });
      return;
    }
    if (req.method === 'GET' && route === '/api/doc') {
      const p = url.searchParams.get('p') || '';
      if (!PATH_RE.test(p)) return json(res, 400, { code: 'invalid_argument' });
      return json(res, 200, { d: getDoc(t, p) });
    }
    if (req.method === 'POST' && route === '/api/write') {
      const op = await readBody(req);
      const err = applyWrite(t, op);
      return err ? json(res, 400, { code: err }) : json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && route === '/api/presence') {
      const body = await readBody(req);
      const c = t.clients.get(body.peer);
      if (!c || !isObj(body.patch)) return json(res, 400, { code: 'invalid_argument' });
      const next = Object.assign({}, c.presence);
      for (const k in body.patch) {
        if (body.patch[k] === null) delete next[k];
        else next[k] = body.patch[k];
      }
      if (JSON.stringify(next).length > MAX_PRESENCE) return json(res, 400, { code: 'invalid_argument', message: 'presence too large' });
      c.presence = next;
      c.t = Date.now();
      peersSoon(t);
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { code: 'not_found' });
  } catch (e) {
    if (!res.headersSent) json(res, e.status || 500, { code: e.status === 413 ? 'quota_exceeded' : 'unavailable', message: e.message });
  }
});

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Try: node server.js --port 8081` : e.message);
  process.exit(1);
});
server.listen(PORT, '0.0.0.0', () => {
  const addrs = [];
  Object.values(os.networkInterfaces()).forEach((list) => (list || []).forEach((a) => {
    if (a.family === 'IPv4' || a.family === 4) addrs.push(a.address);
  }));
  console.log('\n  Tavern Table is running.\n');
  console.log(`  On this computer:   http://localhost:${PORT}`);
  addrs.filter((a) => a !== '127.0.0.1').forEach((a) => console.log(`  For friends:        http://${a}:${PORT}`));
  console.log(PASSWORD ? '\n  Password is set. Share it with your friends.' : '\n  WARNING: no password. Anyone who can reach this address can join. Start with --password SECRET');
  console.log(`  The table is saved in ${DATA_DIR}`);
  console.log('  Keep this window open while you play. Press Ctrl+C to stop.\n');
});
