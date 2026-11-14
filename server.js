#!/usr/bin/env node
/* ===================================================================
   server.js — run the table on your own computer, no internet needed.

     node server.js --password SECRET            (port 8080)
     node server.js --password SECRET --port 3000 --data ./my-table
     node server.js --accounts --trust-proxy      (public server behind HTTPS)

   With --accounts everyone makes their own account (name + password);
   the first account is the table owner and a DM. Add --trust-proxy only
   when a reverse proxy (nginx, Caddy) in front sets X-Forwarded-For/-Proto.

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
const ACCOUNTS = argv.includes('--accounts');
const TRUST_PROXY = argv.includes('--trust-proxy');
// behind a reverse proxy, --host 127.0.0.1 keeps the plain-http port off the internet
const HOST = String(opt('host', '0.0.0.0'));
// with accounts, people sign in with their own name and password instead of the table password
const PASSWORD = ACCOUNTS ? '' : String(opt('password', process.env.TABLE_PASSWORD || ''));
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
const isGlobal = (p) => /^(homebrew|accounts|art)\//.test(p);

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
// apply one write; returns null or an error code. `user` is the signed-in
// person in accounts mode (their permissions are checked); null means trusted.
function applyWrite(t, op, user) {
  const p = op && op.p;
  if (typeof p !== 'string' || !PATH_RE.test(p)) return 'invalid_argument';
  if (isGlobal(p) && t.cid !== 'main') t = table('main');
  if (user && op.t === 'del' && !allowed(t, p, op, isChunk(p) ? null : getDoc(t, p), null, user)) return 'permission_denied';
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
  if (user && !allowed(t, p, op, isChunk(p) ? null : getDoc(t, p), next, user)) return 'permission_denied';
  const text = JSON.stringify(next);
  if (text.length > MAX_DOC) return 'invalid_argument';
  if (isChunk(p)) {
    fs.writeFileSync(chunkFile(t, p), text);
    return null; // pieces are fetched when needed, not pushed to everyone
  }
  t.docs.set(p, next);
  save(t);
  broadcast(t, 'doc', { p, d: pubDoc(p, next) });
  return null;
}

/* ------------------------------------------------ permissions (accounts) */
// cur: the document now (null if missing), next: after the write (null for a delete)
const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
const PROFILE_KEYS = new Set(['name', 'color', 'playing']);
function allowed(t, p, op, cur, next, user) {
  const col = p.slice(0, p.indexOf('/'));
  const id = p.slice(p.indexOf('/') + 1);
  const dm = !!user.dm;
  const me = user.id;
  if (col === 'accounts') {
    // only your own public profile, only these fields; the DM flag goes through the admin endpoint
    if (id !== me || op.t !== 'upd' || !cur || !isObj(op.d)) return false;
    for (const k in op.d) if (!PROFILE_KEYS.has(k)) return false;
    if ('name' in op.d && (typeof op.d.name !== 'string' || !op.d.name.trim() || op.d.name.length > 40)) return false;
    if ('color' in op.d && (typeof op.d.color !== 'string' || op.d.color.length > 32)) return false;
    if ('playing' in op.d && !isObj(op.d.playing)) return false;
    return true;
  }
  if (col === 'party' || col === 'init') return true;
  if (col === 'game') {
    if (dm) return true;
    // players end their turn and share party coins; the scene, combat and campaign name are the DM's
    if (p !== 'game/state' || !next) return false;
    return ['scene', 'combat', 'cname'].every((k) => same(cur ? cur[k] : undefined, next[k]));
  }
  if (dm) return true;
  const ownsHero = (cid) => {
    if (typeof cid !== 'string' || !cid) return false;
    const ch = getDoc(t, 'chars/' + cid);
    return !!ch && ch.owner === me;
  };
  if (col === 'chars') return (!cur || cur.owner === me) && (!next || next.owner === me);
  if (col === 'tokens') {
    const mine = (d) => d.owner === me || ownsHero(d.char);
    return (!cur || mine(cur)) && (!next || mine(next));
  }
  if (col === 'templates') return (!cur || cur.owner === me) && (!next || next.owner === me);
  if (col === 'log') {
    if (!next) return false; // only the DM clears the log
    return (!cur || cur.by === me) && next.by === me;
  }
  if (col === 'homebrew') return (!cur || cur.by === me) && (!next || next.by === me);
  // scenes, mapchunks, encounters, art and anything else: the DM's
  return false;
}
// account profiles never carry a password hash out of the server (old PIN accounts did)
function pubDoc(p, d) {
  if (!ACCOUNTS || !d || !p.startsWith('accounts/') || !('hash' in d || 'salt' in d)) return d;
  const o = Object.assign({}, d);
  delete o.hash;
  delete o.salt;
  return o;
}

/* ----------------------------------------------------------- accounts */
// DATA_DIR/users.json: { users: [...], sessions: { sha256(token): {uid, exp} } }.
// Never sent to anyone; the public part of each account is the accounts/<id> document.
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSION_DAYS = 60;
const SESSION_MS = SESSION_DAYS * 24 * 3600 * 1000;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const COLORS = ['#e0a43a', '#5fb2d9', '#d9675f', '#7cc576', '#b98ee0', '#e88fb8', '#62c7b5', '#d9c25f', '#8c9de8', '#e08a4f'];
let auth = { users: [], sessions: {} };
if (ACCOUNTS) {
  try {
    const saved = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    auth.users = Array.isArray(saved.users) ? saved.users : [];
    auth.sessions = isObj(saved.sessions) ? saved.sessions : {};
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error(`Could not read ${USERS_FILE} (${e.message}). Fix or remove it, then start again.`);
      process.exit(1);
    }
  }
  const now = Date.now();
  for (const k in auth.sessions) if (!(auth.sessions[k].exp > now)) delete auth.sessions[k];
}
function saveUsers() {
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(auth), { mode: 0o600 });
  fs.renameSync(tmp, USERS_FILE);
}
const nameKey = (n) => String(n).normalize('NFKC').trim().toLowerCase();
const userById = (id) => auth.users.find((u) => u.id === id) || null;
const userByName = (n) => auth.users.find((u) => u.key === nameKey(n)) || null;
const publicUser = (u) => (u ? { id: u.id, name: u.name, dm: !!u.dm, admin: !!u.admin } : null);
function scrypt(password, salt) {
  return new Promise((res, rej) => crypto.scrypt(String(password).normalize('NFKC'), salt, 64, SCRYPT, (e, k) => (e ? rej(e) : res(k))));
}
const DUMMY_SALT = crypto.randomBytes(16).toString('hex');
async function checkPassword(u, password) {
  // an unknown name costs the same time as a wrong password
  const key = await scrypt(password, u ? u.salt : DUMMY_SALT);
  const want = u ? Buffer.from(u.hash, 'hex') : Buffer.alloc(64);
  return !!u && want.length === key.length && crypto.timingSafeEqual(want, key);
}
async function setPassword(u, password) {
  u.salt = crypto.randomBytes(16).toString('hex');
  u.hash = (await scrypt(password, u.salt)).toString('hex');
}
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
function cookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  });
  return out;
}
function sessionOf(req) {
  const tok = cookies(req).tt_session;
  if (!tok || !/^[A-Za-z0-9_-]{20,100}$/.test(tok)) return null;
  const h = sha(tok);
  const s = auth.sessions[h];
  if (!s) return null;
  if (!(s.exp > Date.now())) {
    delete auth.sessions[h];
    return null;
  }
  const u = userById(s.uid);
  return u ? { h, user: u } : null;
}
const isHttps = (req) => !!req.socket.encrypted || (TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https');
function sessionCookie(req, value, maxAge) {
  return `tt_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` + (isHttps(req) ? '; Secure' : '');
}
function startSession(req, res, u) {
  const tok = crypto.randomBytes(32).toString('base64url');
  auth.sessions[sha(tok)] = { uid: u.id, exp: Date.now() + SESSION_MS, created: Date.now() };
  saveUsers();
  res.setHeader('set-cookie', sessionCookie(req, tok, SESSION_DAYS * 24 * 3600));
}
// close the live connections that belong to ended sessions
function dropSessions(pred) {
  for (const k in auth.sessions) if (pred(k, auth.sessions[k])) delete auth.sessions[k];
  tables.forEach((t) => t.clients.forEach((c) => {
    if (c.sess && !auth.sessions[c.sess]) c.res.end();
  }));
}
// the public profile everyone at the table sees (main table, like every account)
function writeProfile(u, extra) {
  const main = table('main');
  const p = 'accounts/' + u.id;
  const cur = main.docs.get(p);
  const doc = Object.assign({ name: u.name, color: COLORS[auth.users.indexOf(u) % COLORS.length], playing: {}, created: u.created }, pubDoc(p, cur) || {}, extra || {}, { dm: u.dm ? 1 : 0 });
  applyWrite(main, { t: 'set', p, d: doc }, null);
}
// login and register attempts per address: at most 10 in 5 minutes
const ATTEMPTS = new Map();
const ATTEMPT_MAX = 10;
const ATTEMPT_MS = 5 * 60 * 1000;
function clientIp(req) {
  if (TRUST_PROXY) {
    // the right-most address was added by our own proxy; earlier ones can be made up by the client
    const list = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (list.length) return list[list.length - 1];
  }
  return req.socket.remoteAddress || '?';
}
function tooMany(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const list = (ATTEMPTS.get(ip) || []).filter((x) => now - x < ATTEMPT_MS);
  list.push(now);
  ATTEMPTS.set(ip, list);
  return list.length > ATTEMPT_MAX;
}
setInterval(() => {
  const now = Date.now();
  ATTEMPTS.forEach((list, ip) => {
    if (!list.some((x) => now - x < ATTEMPT_MS)) ATTEMPTS.delete(ip);
  });
}, 60000).unref();

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
function readBody(req, limit) {
  const max = limit || MAX_BODY;
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
      } else parts.push(c);
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
        resolve(isObj(v) ? v : {});
      } catch (e) {
        reject(Object.assign(new Error('bad json'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------- routes */
const NAME_RE = /^[^\u0000-\u001f\u007f<>]{2,40}$/;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const route = url.pathname;
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'same-origin');
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
    if (route === '/api/hello') {
      if (ACCOUNTS) {
        const s = sessionOf(req);
        return json(res, 200, { tavern: 1, accounts: true, user: publicUser(s && s.user), fresh: !auth.users.length });
      }
      return json(res, authorized(url) ? 200 : 401, { tavern: 1, locked: !!PASSWORD });
    }
    if (!route.startsWith('/api/')) return json(res, 404, { code: 'not_found' });
    // everything posted is JSON (a plain cross-site form can't send that)
    if (req.method === 'POST' && !/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] || ''))) return json(res, 415, { code: 'invalid_argument', message: 'send JSON' });
    let user = null;
    let sess = null;
    if (ACCOUNTS) {
      if (req.method === 'POST' && (route === '/api/register' || route === '/api/login')) {
        if (tooMany(req)) return json(res, 429, { code: 'resource_exhausted', message: 'Too many tries. Wait a few minutes and try again.' });
        const body = await readBody(req, 4096);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const password = typeof body.password === 'string' ? body.password : '';
        if (route === '/api/login') {
          const u = userByName(name);
          const ok = password.length <= 1024 && (await checkPassword(u, password.slice(0, 1024)));
          if (!ok) return json(res, 401, { code: 'wrong_login', message: 'Wrong name or password.' });
          startSession(req, res, u);
          return json(res, 200, { user: publicUser(u) });
        }
        if (!NAME_RE.test(name)) return json(res, 400, { code: 'invalid_argument', message: 'Pick a name of 2 to 40 characters.' });
        if (password.length < 8) return json(res, 400, { code: 'invalid_argument', message: 'The password needs at least 8 characters.' });
        if (password.length > 1024) return json(res, 400, { code: 'invalid_argument', message: 'That password is too long.' });
        if (userByName(name)) return json(res, 409, { code: 'already_exists', message: 'That name is taken. Sign in, or pick another name.' });
        const first = !auth.users.length;
        const u = { id: 'u' + crypto.randomBytes(8).toString('hex'), name, key: nameKey(name), admin: first, dm: first, created: Date.now() };
        await setPassword(u, password);
        if (userByName(name)) return json(res, 409, { code: 'already_exists', message: 'That name is taken. Sign in, or pick another name.' });
        auth.users.push(u);
        saveUsers();
        writeProfile(u);
        startSession(req, res, u);
        return json(res, 200, { user: publicUser(u) });
      }
      sess = sessionOf(req);
      if (!sess) return json(res, 401, { code: 'signed_out', message: 'Sign in again.' });
      user = sess.user;
      if (route === '/api/me') return json(res, 200, { user: publicUser(user) });
      if (req.method === 'POST' && route === '/api/logout') {
        dropSessions((k) => k === sess.h);
        saveUsers();
        res.setHeader('set-cookie', sessionCookie(req, '', 0));
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && route.startsWith('/api/admin/')) {
        if (!user.admin) return json(res, 403, { code: 'permission_denied' });
        const body = await readBody(req, 4096);
        const target = userById(String(body.userId || ''));
        if (!target) return json(res, 404, { code: 'not_found' });
        if (route === '/api/admin/reset-password') {
          const pw = typeof body.password === 'string' ? body.password : '';
          if (pw.length < 8 || pw.length > 1024) return json(res, 400, { code: 'invalid_argument', message: 'The password needs at least 8 characters.' });
          await setPassword(target, pw);
          // signed out everywhere: whoever had the old password is out
          dropSessions((k, s) => s.uid === target.id && !(target === user && k === sess.h));
          saveUsers();
          return json(res, 200, { ok: true });
        }
        if (route === '/api/admin/set-dm') {
          target.dm = !!body.dm;
          saveUsers();
          writeProfile(target);
          return json(res, 200, { ok: true });
        }
        return json(res, 404, { code: 'not_found' });
      }
    } else if (!authorized(url)) return json(res, 401, { code: 'revoked', message: 'wrong password' });
    const denied = () => json(res, 403, { code: 'permission_denied', message: 'You don’t have permission to do that.' });

    // whole-table backup and restore (all campaigns, map pieces, accounts, homebrew)
    if (user && !user.admin && (route === '/api/backup' || route === '/api/restore')) return denied();
    if (req.method === 'GET' && route === '/api/backup') {
      const tables = {};
      ['main', ...registry.map((c) => c.id)].forEach((cid) => {
        const t = table(cid);
        const docs = Object.fromEntries(t.docs);
        try {
          fs.readdirSync(t.chunkDir).forEach((f) => {
            if (f.endsWith('.json')) docs['mapchunks/' + f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(t.chunkDir, f), 'utf8'));
          });
        } catch (e) { /* no pieces */ }
        for (const p in docs) docs[p] = pubDoc(p, docs[p]);
        tables[cid] = docs;
      });
      return json(res, 200, { campaigns: [{ id: 'main', name: 'Main campaign' }].concat(registry), tables });
    }
    if (req.method === 'POST' && route === '/api/restore') {
      const body = await readBody(req, 300 * 1024 * 1024);
      if (!isObj(body.tables)) return json(res, 400, { code: 'invalid_argument' });
      (Array.isArray(body.campaigns) ? body.campaigns : []).forEach((c) => {
        if (c && CAMP_RE.test(c.id) && c.id !== 'main' && !campaignExists(c.id)) registry.push({ id: c.id, name: String(c.name || 'Campaign').slice(0, 60), created: Date.now() });
      });
      saveRegistry();
      for (const cid of Object.keys(body.tables)) {
        if (!CAMP_RE.test(cid) || !campaignExists(cid)) continue;
        for (const [p, d] of Object.entries(body.tables[cid] || {})) {
          if (!PATH_RE.test(p) || !isObj(d)) continue;
          applyWrite(table(isGlobal(p) ? 'main' : cid), { t: 'set', p, d });
        }
      }
      return json(res, 200, { ok: true });
    }
    if (route === '/api/campaigns') {
      if (req.method === 'GET') return json(res, 200, { campaigns: registry });
      if (req.method === 'POST') {
        if (user && !user.dm) return denied();
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
      const owner = user ? !!user.admin : isLocal(req);
      t.clients.set(peer, { res, presence: {}, t: Date.now(), owner, uid: user && user.id, sess: sess && sess.h });
      send(res, 'hello', { peer, owner });
      const snap = Object.fromEntries([...t.docs].filter(([p]) => !isGlobal(p)));
      table('main').docs.forEach((d, p) => isGlobal(p) && (snap[p] = pubDoc(p, d)));
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
      return json(res, 200, { d: pubDoc(p, getDoc(t, p)) });
    }
    if (req.method === 'POST' && route === '/api/write') {
      const op = await readBody(req);
      const err = applyWrite(t, op, user);
      if (err === 'permission_denied') return denied();
      return err ? json(res, 400, { code: err }) : json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && route === '/api/presence') {
      const body = await readBody(req);
      const c = t.clients.get(body.peer);
      if (!c || !isObj(body.patch) || (user && c.uid !== user.id)) return json(res, 400, { code: 'invalid_argument' });
      const next = Object.assign({}, c.presence);
      for (const k in body.patch) {
        if (body.patch[k] === null) delete next[k];
        else next[k] = body.patch[k];
      }
      if (user && next.pk !== undefined) next.pk = user.id; // nobody speaks as someone else
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
server.listen(PORT, HOST, () => {
  const addrs = [];
  Object.values(os.networkInterfaces()).forEach((list) => (list || []).forEach((a) => {
    if (a.family === 'IPv4' || a.family === 4) addrs.push(a.address);
  }));
  console.log('\n  Tavern Table is running.\n');
  console.log(`  On this computer:   http://localhost:${PORT}`);
  addrs.filter((a) => a !== '127.0.0.1').forEach((a) => console.log(`  For friends:        http://${a}:${PORT}`));
  if (ACCOUNTS) console.log(auth.users.length ? `\n  Accounts: ${auth.users.length}. Everyone signs in with their own name and password.` : '\n  Accounts are on. The first account made becomes the table owner and DM: make yours now.');
  else console.log(PASSWORD ? '\n  Password is set. Share it with your friends.' : '\n  WARNING: no password. Anyone who can reach this address can join. Start with --password SECRET');
  console.log(`  The table is saved in ${DATA_DIR}`);
  console.log('  Keep this window open while you play. Press Ctrl+C to stop.\n');
});
