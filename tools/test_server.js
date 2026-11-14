#!/usr/bin/env node
/* Tests for server.js accounts mode (and a quick look at password mode).
   Run: node tools/test_server.js
   Spawns server.js on free ports with temporary data folders. */
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, '..', 'server.js');
let passed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) passed++;
  else failures.push(name + (extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 300) : ''));
}
const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => res(p));
  });
});
const procs = [];
const dirs = [];
async function start(args, seed) {
  const port = await freePort();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-srv-'));
  dirs.push(data);
  if (seed) fs.writeFileSync(path.join(data, 'table.json'), JSON.stringify(seed));
  const proc = spawn(process.execPath, [SERVER, '--port', String(port), '--data', data].concat(args), { stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(proc);
  proc.stderr.on('data', (d) => process.stderr.write('server: ' + d));
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('server did not start')), 10000);
    proc.stdout.on('data', (d) => String(d).includes('running') && (clearTimeout(t), res()));
  });
  return { port, data, proc };
}
function request(port, method, url, opts = {}) {
  return new Promise((res, rej) => {
    const headers = Object.assign({}, opts.headers || {});
    let body = null;
    if (opts.body !== undefined) {
      body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
      if (!('content-type' in headers)) headers['content-type'] = 'application/json';
    } else if (method === 'POST') {
      body = '{}';
      if (!('content-type' in headers)) headers['content-type'] = 'application/json';
    }
    if (opts.cookie) headers.cookie = opts.cookie;
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers }, (resp) => {
      const parts = [];
      resp.on('data', (c) => parts.push(c));
      resp.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        let j = null;
        try {
          j = JSON.parse(text);
        } catch (e) { /* not json */ }
        res({ status: resp.statusCode, headers: resp.headers, j, text });
      });
    });
    r.on('error', rej);
    if (body !== null) r.write(body);
    r.end();
  });
}
const cookieOf = (r) => {
  const sc = [].concat(r.headers['set-cookie'] || [])[0] || '';
  return sc.split(';')[0];
};
// open the live stream and read until the snapshot (or give up)
function sse(port, cookie) {
  return new Promise((res) => {
    const out = { status: 0, events: {}, req: null, closed: false };
    const r = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: cookie ? { cookie } : {} }, (resp) => {
      out.status = resp.statusCode;
      let buf = '';
      resp.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(block);
          const data = /^data: (.*)$/m.exec(block);
          if (ev && data) out.events[ev[1]] = JSON.parse(data[1]);
          if (ev && ev[1] === 'snap') res(out);
        }
      });
      resp.on('end', () => {
        out.closed = true;
        res(out);
      });
    });
    out.req = r;
    r.on('error', () => res(out));
    setTimeout(() => res(out), 4000);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function accountsSuite() {
  const seed = { 'accounts/old': { name: 'Old PIN account', salt: 'sss', hash: 'hhh', dm: 0 } };
  const { port, data } = await start(['--accounts', '--trust-proxy'], seed);
  let ipN = 0;
  const ip = () => ({ 'x-forwarded-for': '203.0.113.7, 10.1.0.' + ++ipN });
  const go = (method, url, opts = {}) => request(port, method, url, Object.assign({}, opts, { headers: Object.assign(ip(), opts.headers || {}) }));

  // hello before anyone exists
  let r = await go('GET', '/api/hello');
  check('hello says accounts', r.status === 200 && r.j.accounts === true && r.j.user === null && r.j.fresh === true, r.j);
  check('security header nosniff', r.headers['x-content-type-options'] === 'nosniff');
  check('security header frame', r.headers['x-frame-options'] === 'DENY');
  check('security header referrer', r.headers['referrer-policy'] === 'same-origin');
  r = await go('GET', '/');
  check('page has security headers', r.headers['x-frame-options'] === 'DENY' && r.status === 200);

  // without a session, everything else is closed
  for (const [m, u] of [['GET', '/api/me'], ['GET', '/api/doc?p=chars/x'], ['GET', '/api/campaigns'], ['GET', '/api/backup'], ['POST', '/api/write'], ['POST', '/api/presence'], ['POST', '/api/logout'], ['POST', '/api/admin/set-dm']]) {
    r = await go(m, u, m === 'POST' ? { body: { t: 'set', p: 'chars/x', d: { owner: 'x' } } } : {});
    check('401 without a session: ' + m + ' ' + u, r.status === 401 && r.j.code === 'signed_out', [r.status, r.j]);
  }
  const ev0 = await sse(port, '');
  check('401 on the live stream without a session', ev0.status === 401, ev0.status);

  // register: rules
  r = await go('POST', '/api/register', { body: { name: 'D', password: 'longenough1' } });
  check('name too short', r.status === 400, r.j);
  r = await go('POST', '/api/register', { body: { name: 'Dana', password: 'short' } });
  check('password too short', r.status === 400, r.j);
  r = await go('POST', '/api/register', { body: 'name=Dana&password=longenough1', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  check('form posts are refused (415)', r.status === 415, r.status);
  r = await go('POST', '/api/register', { body: { name: 'Dana', password: 'longenough1' }, headers: { 'content-type': 'text/plain' } });
  check('text/plain posts are refused', r.status === 415, r.status);

  r = await go('POST', '/api/register', { body: { name: 'Dana', password: 'dragonfire1' } });
  check('first account registers', r.status === 200 && r.j.user.name === 'Dana', r.j);
  check('first account is admin and DM', r.j.user.admin === true && r.j.user.dm === true, r.j.user);
  const dana = r.j.user.id;
  const sc = [].concat(r.headers['set-cookie'] || [])[0] || '';
  check('cookie is HttpOnly', /;\s*HttpOnly/i.test(sc), sc);
  check('cookie is SameSite=Lax', /;\s*SameSite=Lax/i.test(sc), sc);
  check('cookie Path=/', /;\s*Path=\//.test(sc), sc);
  check('cookie lasts 60 days', /Max-Age=5184000/.test(sc), sc);
  check('cookie not Secure over plain http', !/Secure/i.test(sc), sc);
  check('cookie token is long', /^tt_session=[A-Za-z0-9_-]{40,}$/.test(cookieOf(r)), cookieOf(r));
  let D = cookieOf(r);

  r = await go('POST', '/api/register', { body: { name: ' dANA ', password: 'otherpass99' } });
  check('names are unique, case-insensitive', r.status === 409, r.j);

  r = await go('POST', '/api/register', { body: { name: 'Pip', password: 'halfling-pw' }, headers: { 'x-forwarded-proto': 'https' } });
  check('second account registers as a player', r.status === 200 && r.j.user.dm === false && r.j.user.admin === false, r.j);
  const pip = r.j.user.id;
  check('cookie is Secure behind an https proxy', /;\s*Secure/i.test([].concat(r.headers['set-cookie'])[0]), r.headers['set-cookie']);
  let P = cookieOf(r);

  r = await go('GET', '/api/hello', { cookie: D });
  check('hello knows who is signed in', r.j.user && r.j.user.id === dana && r.j.user.admin === true && r.j.fresh === false, r.j);
  r = await go('GET', '/api/me', { cookie: P });
  check('me', r.status === 200 && r.j.user.id === pip && r.j.user.name === 'Pip', r.j);
  r = await go('GET', '/api/me', { cookie: 'tt_session=' + 'A'.repeat(43) });
  check('made-up session is refused', r.status === 401);

  // users.json: private
  const users = JSON.parse(fs.readFileSync(path.join(data, 'users.json'), 'utf8'));
  check('users.json keeps scrypt hashes', users.users.length === 2 && users.users.every((u) => /^[0-9a-f]{128}$/.test(u.hash) && /^[0-9a-f]{32}$/.test(u.salt)));
  check('users.json keeps no raw session token', Object.keys(users.sessions).every((k) => /^[0-9a-f]{64}$/.test(k)) && !JSON.stringify(users).includes(D.split('=')[1]));
  check('users.json is not readable by others', (fs.statSync(path.join(data, 'users.json')).mode & 0o077) === 0, (fs.statSync(path.join(data, 'users.json')).mode & 0o777).toString(8));
  r = await go('GET', '/users.json', { cookie: D });
  check('users.json is not served', r.status === 404);

  // public profiles
  r = await go('GET', '/api/doc?p=accounts/' + pip, { cookie: D });
  check('profile doc written on register', r.j.d && r.j.d.name === 'Pip' && r.j.d.dm === 0 && r.j.d.color && r.j.d.created, r.j);
  check('profile doc has no hash or salt', r.j.d && !('hash' in r.j.d) && !('salt' in r.j.d), r.j);
  r = await go('GET', '/api/doc?p=accounts/old', { cookie: P });
  check('old PIN account loses hash/salt on the way out', r.j.d && r.j.d.name === 'Old PIN account' && !('hash' in r.j.d) && !('salt' in r.j.d), r.j);
  const ev = await sse(port, P);
  check('live stream works with the cookie', ev.status === 200 && ev.events.hello && ev.events.snap, ev.status);
  check('live hello: player is not owner', ev.events.hello && ev.events.hello.owner === false, ev.events.hello);
  const snapAcc = ev.events.snap ? Object.entries(ev.events.snap.docs).filter(([p]) => p.startsWith('accounts/')) : [];
  check('snapshot has the profiles, no hashes', snapAcc.length === 3 && snapAcc.every(([, d]) => !('hash' in d) && !('salt' in d)), snapAcc);
  ev.req.destroy();
  const evD = await sse(port, D);
  check('live hello: admin is owner', evD.events.hello && evD.events.hello.owner === true, evD.events.hello);
  evD.req.destroy();

  // login / logout
  r = await go('POST', '/api/login', { body: { name: 'Pip', password: 'wrong-password' } });
  check('wrong password: 401 generic', r.status === 401 && r.j.message === 'Wrong name or password.', r.j);
  r = await go('POST', '/api/login', { body: { name: 'Nobody', password: 'wrong-password' } });
  check('unknown name: same message', r.status === 401 && r.j.message === 'Wrong name or password.', r.j);
  r = await go('POST', '/api/login', { body: { name: 'pip', password: 'halfling-pw' } });
  check('login (any letter case)', r.status === 200 && r.j.user.id === pip && cookieOf(r).startsWith('tt_session='), r.j);
  const P2 = cookieOf(r);
  const evP2 = sse(port, P2);
  await wait(300);
  r = await go('POST', '/api/logout', { cookie: P2 });
  check('logout', r.status === 200 && /Max-Age=0/.test([].concat(r.headers['set-cookie'])[0]), r.headers['set-cookie']);
  r = await go('GET', '/api/me', { cookie: P2 });
  check('logged-out session no longer works', r.status === 401);
  const evDone = await evP2;
  check('logout closes that live stream', evDone.closed === true);
  r = await go('GET', '/api/me', { cookie: P });
  check('other sessions of the same person stay', r.status === 200);

  // rate limit per address
  const fixed = { 'x-forwarded-for': '198.51.100.9' };
  let codes = [];
  for (let i = 0; i < 11; i++) codes.push((await request(port, 'POST', '/api/login', { body: { name: 'Pip', password: 'nope-nope' }, headers: fixed })).status);
  check('10 tries allowed, the 11th is 429', codes.slice(0, 10).every((c) => c === 401) && codes[10] === 429, codes);
  r = await request(port, 'POST', '/api/login', { body: { name: 'Pip', password: 'halfling-pw' }, headers: fixed });
  check('even the right password waits', r.status === 429);
  r = await request(port, 'POST', '/api/register', { body: { name: 'Spammer', password: 'spammer-pw' }, headers: fixed });
  check('register is limited too', r.status === 429);
  r = await go('POST', '/api/login', { body: { name: 'Pip', password: 'halfling-pw' } });
  check('another address is not limited', r.status === 200);

  // ------------------------------------------------ permissions
  const w = (cookie, t, p, d) => go('POST', '/api/write', { cookie, body: d === undefined ? { t, p } : { t, p, d } });
  const ok = async (name, pr) => {
    const x = await pr;
    check('allowed: ' + name, x.status === 200, [x.status, x.j]);
  };
  const no = async (name, pr) => {
    const x = await pr;
    check('denied: ' + name, x.status === 403 && x.j.code === 'permission_denied', [x.status, x.j]);
  };
  // chars
  await ok('player creates own hero', w(P, 'set', 'chars/cp', { name: 'Pip hero', owner: pip }));
  await no('player creates hero for someone else', w(P, 'set', 'chars/cx', { name: 'X', owner: dana }));
  await no('player creates hero with no owner', w(P, 'set', 'chars/cy', { name: 'Y' }));
  await ok('DM creates own hero', w(D, 'set', 'chars/cd', { name: 'Dana hero', owner: dana }));
  await ok('DM creates hero for a player', w(D, 'set', 'chars/cq', { name: 'Gift', owner: pip }));
  await no('player edits the DM’s hero', w(P, 'upd', 'chars/cd', { hp: 1 }));
  await no('player replaces the DM’s hero', w(P, 'set', 'chars/cd', { name: 'mine now', owner: pip }));
  await ok('player edits own hero', w(P, 'upd', 'chars/cp', { hp: 7 }));
  await no('player gives own hero away', w(P, 'upd', 'chars/cp', { owner: dana }));
  await ok('DM edits a player’s hero', w(D, 'upd', 'chars/cp', { hp: 9 }));
  await no('player deletes the DM’s hero', w(P, 'del', 'chars/cd'));
  // tokens
  await ok('DM places a monster', w(D, 'set', 'tokens/m1', { kind: 'monster', mon: 'goblin', c: 1, r: 1, owner: dana }));
  await ok('DM places an unowned monster', w(D, 'set', 'tokens/m2', { kind: 'monster', mon: 'orc', c: 2, r: 2 }));
  await no('player moves the DM’s monster', w(P, 'upd', 'tokens/m1', { c: 5 }));
  await no('player moves an unowned monster', w(P, 'upd', 'tokens/m2', { c: 5 }));
  await no('player claims the DM’s monster', w(P, 'upd', 'tokens/m1', { owner: pip }));
  await no('player deletes the DM’s monster', w(P, 'del', 'tokens/m1'));
  await ok('player creates own token', w(P, 'set', 'tokens/tp', { kind: 'npc', c: 3, r: 3, owner: pip }));
  await ok('player moves own token', w(P, 'upd', 'tokens/tp', { c: 4 }));
  await ok('player places own hero (char)', w(P, 'set', 'tokens/th', { kind: 'pc', char: 'cp', c: 0, r: 0 }));
  await ok('player moves own hero token', w(P, 'upd', 'tokens/th', { c: 6 }));
  await no('player places the DM’s hero', w(P, 'set', 'tokens/tx', { kind: 'pc', char: 'cd', c: 0, r: 0 }));
  await no('player creates a token owned by someone else', w(P, 'set', 'tokens/ty', { kind: 'npc', owner: dana }));
  await ok('DM moves a player’s token', w(D, 'upd', 'tokens/tp', { c: 8 }));
  await ok('player deletes own token', w(P, 'del', 'tokens/tp'));
  // templates
  await ok('player draws a template', w(P, 'set', 'templates/a', { shape: 'circle', owner: pip }));
  await ok('DM draws a template', w(D, 'set', 'templates/b', { shape: 'cone', owner: dana }));
  await no('player moves the DM’s template', w(P, 'upd', 'templates/b', { x: 3 }));
  await no('player deletes the DM’s template', w(P, 'del', 'templates/b'));
  await ok('DM deletes a player’s template', w(D, 'del', 'templates/a'));
  // log
  await ok('player rolls (log by self)', w(P, 'set', 'log/l1', { by: pip, kind: 'roll', ts: 1 }));
  await no('player logs as someone else', w(P, 'set', 'log/l2', { by: dana, kind: 'chat' }));
  await no('player deletes a log entry', w(P, 'del', 'log/l1'));
  await ok('DM deletes a log entry', w(D, 'del', 'log/l1'));
  // homebrew
  await ok('player makes homebrew', w(P, 'set', 'homebrew/h1', { kind: 'feat', name: 'Lucky-ish', by: pip }));
  await no('player makes homebrew as someone else', w(P, 'set', 'homebrew/h9', { kind: 'feat', name: 'X', by: dana }));
  await ok('DM makes homebrew', w(D, 'set', 'homebrew/h2', { kind: 'item', name: 'Wand', by: dana }));
  await no('player edits the DM’s homebrew', w(P, 'upd', 'homebrew/h2', { name: 'Mine' }));
  await no('player deletes the DM’s homebrew', w(P, 'del', 'homebrew/h2'));
  await ok('player edits own homebrew', w(P, 'upd', 'homebrew/h1', { name: 'Luckier' }));
  await ok('DM deletes a player’s homebrew', w(D, 'del', 'homebrew/h1'));
  // party, init
  await ok('player adds a party item', w(P, 'set', 'party/i1', { n: 'Rope', q: 1, by: pip }));
  await ok('player edits a party item', w(P, 'upd', 'party/i1', { q: 2 }));
  await ok('player rolls initiative', w(P, 'set', 'init/e1', { tok: 'th', v: 12 }));
  await ok('player changes initiative', w(P, 'upd', 'init/e1', { v: 13 }));
  // game/state
  await ok('DM sets the scene and combat', w(D, 'set', 'game/state', { scene: 's1', combat: 1, cname: 'Main', turn: 'th', round: 1 }));
  await ok('player ends their turn', w(P, 'upd', 'game/state', { turn: 'm1', round: 2 }));
  await ok('player edits party coins', w(P, 'upd', 'game/state', { coins: { gp: 3 } }));
  await ok('player writes the same scene (no change)', w(P, 'upd', 'game/state', { scene: 's1' }));
  await no('player changes the scene', w(P, 'upd', 'game/state', { scene: 's2' }));
  await no('player ends combat', w(P, 'upd', 'game/state', { combat: 0 }));
  await no('player renames the campaign', w(P, 'upd', 'game/state', { cname: 'Pipland' }));
  await no('player replaces the whole state', w(P, 'set', 'game/state', { turn: 'x' }));
  await no('player deletes the state', w(P, 'del', 'game/state'));
  await no('player writes another game doc', w(P, 'set', 'game/other', { a: 1 }));
  // DM-only collections
  for (const col of ['scenes', 'mapchunks', 'encounters', 'art']) {
    await no('player writes ' + col, w(P, 'set', col + '/z1', { name: 'x', by: pip }));
    await ok('DM writes ' + col, w(D, 'set', col + '/z1', { name: 'x' }));
    await no('player deletes ' + col, w(P, 'del', col + '/z1'));
  }
  r = await go('POST', '/api/campaigns', { cookie: P, body: { name: 'Pip campaign' } });
  check('denied: player makes a campaign', r.status === 403, r.j);
  r = await go('POST', '/api/campaigns', { cookie: D, body: { name: 'Second' } });
  check('allowed: DM makes a campaign', r.status === 200 && r.j.id, r.j);
  const camp2 = r.j.id;
  r = await go('POST', '/api/write?c=' + camp2, { cookie: P, body: { t: 'set', p: 'scenes/q', d: { name: 'x' } } });
  check('denied: player writes scenes in another campaign', r.status === 403);
  // accounts
  await ok('player changes own color', w(P, 'upd', 'accounts/' + pip, { color: '#7cc576' }));
  await ok('player changes own name and hero', w(P, 'upd', 'accounts/' + pip, { name: 'Pip the Bold', playing: { main: 'cp' } }));
  await no('player makes themselves DM', w(P, 'upd', 'accounts/' + pip, { dm: 1 }));
  await no('player writes a hash into their profile', w(P, 'upd', 'accounts/' + pip, { hash: 'x' }));
  await no('player replaces their profile', w(P, 'set', 'accounts/' + pip, { name: 'Pip', dm: 1 }));
  await no('player edits someone else’s profile', w(P, 'upd', 'accounts/' + dana, { color: '#000000' }));
  await no('player deletes a profile', w(P, 'del', 'accounts/' + dana));
  await no('DM sets dm through the doc', w(D, 'upd', 'accounts/' + pip, { dm: 1 }));
  // backup / restore: the owner only
  r = await go('GET', '/api/backup', { cookie: P });
  check('denied: player backup', r.status === 403 && r.j.code === 'permission_denied', r.status);
  r = await go('POST', '/api/restore', { cookie: P, body: { tables: { main: { 'scenes/evil': { name: 'x' } } } } });
  check('denied: player restore', r.status === 403);
  r = await go('GET', '/api/backup', { cookie: D });
  const bAcc = r.j && r.j.tables && Object.entries(r.j.tables.main).filter(([p]) => p.startsWith('accounts/'));
  check('owner backup works, profiles without hashes', r.status === 200 && bAcc.length === 3 && bAcc.every(([, d]) => !('hash' in d) && !('salt' in d)), bAcc);
  check('backup holds no users.json data', !JSON.stringify(r.j).includes(users.users[0].hash));

  // admin endpoints
  r = await go('POST', '/api/admin/set-dm', { cookie: P, body: { userId: pip, dm: true } });
  check('denied: player uses set-dm', r.status === 403);
  r = await go('POST', '/api/admin/reset-password', { cookie: P, body: { userId: dana, password: 'takeover-pw' } });
  check('denied: player resets a password', r.status === 403);
  r = await go('POST', '/api/admin/set-dm', { cookie: D, body: { userId: pip, dm: true } });
  check('admin makes Pip a DM', r.status === 200, r.j);
  r = await go('GET', '/api/me', { cookie: P });
  check('Pip is a DM now', r.j.user.dm === true && r.j.user.admin === false, r.j);
  r = await go('GET', '/api/doc?p=accounts/' + pip, { cookie: P });
  check('profile shows dm, keeps the chosen name', r.j.d.dm === 1 && r.j.d.name === 'Pip the Bold', r.j.d);
  await ok('new DM may edit scenes', w(P, 'set', 'scenes/pz', { name: 'Pip map' }));
  await ok('new DM may move monsters', w(P, 'upd', 'tokens/m1', { c: 9 }));
  r = await go('GET', '/api/backup', { cookie: P });
  check('a DM who is not the owner still can’t back up', r.status === 403);
  r = await go('POST', '/api/admin/set-dm', { cookie: D, body: { userId: pip, dm: false } });
  await no('back to player: monsters are off limits again', w(P, 'upd', 'tokens/m1', { c: 1 }));
  r = await go('POST', '/api/admin/reset-password', { cookie: D, body: { userId: pip, password: 'short' } });
  check('reset needs 8 characters', r.status === 400);
  r = await go('POST', '/api/admin/reset-password', { cookie: D, body: { userId: pip, password: 'brand-new-pw' } });
  check('admin resets Pip’s password', r.status === 200);
  r = await go('GET', '/api/me', { cookie: P });
  check('reset signs Pip out everywhere', r.status === 401);
  r = await go('POST', '/api/login', { body: { name: 'Pip', password: 'halfling-pw' } });
  check('old password is gone', r.status === 401);
  r = await go('POST', '/api/login', { body: { name: 'Pip', password: 'brand-new-pw' } });
  check('new password works', r.status === 200);
  r = await go('GET', '/api/me', { cookie: D });
  check('admin stays signed in', r.status === 200);

  // saved table: no secrets there
  await wait(700);
  const tableText = fs.readFileSync(path.join(data, 'table.json'), 'utf8');
  check('table.json has no account hashes of real users', !users.users.some((u) => tableText.includes(u.hash) || tableText.includes(u.salt)));

  // a restart keeps accounts and sessions
  const proc = procs[procs.length - 1];
  proc.kill();
  await wait(300);
  const again = spawn(process.execPath, [SERVER, '--port', String(port), '--data', data, '--accounts', '--trust-proxy'], { stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(again);
  await new Promise((res) => again.stdout.on('data', (d) => String(d).includes('running') && res()));
  r = await go('GET', '/api/me', { cookie: D });
  check('sessions survive a restart', r.status === 200 && r.j.user.id === dana);
}

async function otherModes() {
  // accounts without --trust-proxy: forwarded headers mean nothing
  const a = await start(['--accounts']);
  let codes = [];
  for (let i = 0; i < 11; i++) codes.push((await request(a.port, 'POST', '/api/login', { body: { name: 'x', password: 'nope-nope' }, headers: { 'x-forwarded-for': '10.0.0.' + i } })).status);
  check('without --trust-proxy, X-Forwarded-For can’t dodge the limit', codes[10] === 429, codes);
  const b = await start(['--accounts']);
  const r0 = await request(b.port, 'POST', '/api/register', { body: { name: 'Ann', password: 'password-1' }, headers: { 'x-forwarded-proto': 'https' } });
  check('without --trust-proxy, X-Forwarded-Proto doesn’t set Secure', r0.status === 200 && !/Secure/i.test([].concat(r0.headers['set-cookie'])[0]), r0.headers['set-cookie']);

  // password mode is unchanged
  const c = await start(['--password', 'dragon42']);
  let r = await request(c.port, 'GET', '/api/hello');
  check('password mode: hello without key is 401', r.status === 401 && r.j.locked === true && !r.j.accounts, r.j);
  r = await request(c.port, 'GET', '/api/hello?key=dragon42');
  check('password mode: right key', r.status === 200);
  r = await request(c.port, 'POST', '/api/write?key=dragon42', { body: { t: 'set', p: 'scenes/s1', d: { name: 'x' } } });
  check('password mode: anyone with the key writes anything', r.status === 200, r.j);
  r = await request(c.port, 'POST', '/api/register', { body: { name: 'Ann', password: 'password-1' } });
  check('password mode: no accounts endpoints', r.status === 401);
  r = await request(c.port, 'GET', '/api/hello?key=dragon42');
  check('password mode: security headers', r.headers['x-content-type-options'] === 'nosniff');
}

(async () => {
  try {
    await accountsSuite();
    await otherModes();
  } catch (e) {
    failures.push('crashed: ' + (e.stack || e));
  }
  procs.forEach((p) => p.kill());
  await wait(200);
  dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  failures.forEach((f) => console.log('FAIL ' + f));
  console.log(`server tests: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
