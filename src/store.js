/* ===================================================================
   store.js — shared table state. Talks to the artifact's db + room
   capabilities when they exist, or to a local stand-in (this device
   only, synced across tabs) when they don't. Every write goes through
   one queue: one write at a time per document, coalesced, and relayed
   through a writer's open page when this viewer can only read.
   =================================================================== */
const Store = (() => {
  'use strict';

  /* ------------------------------------------------------------ state */
  const S = {
    mode: 'loading', // 'remote' | 'local'
    loaded: false,
    stale: false,
    backend: null,
    room: null,
    user: null,
    me: { pk: '', uid: null, nick: '', color: '#d8a54a', isOwner: false, canEdit: false, profileName: '' },
    dm: false,
    canWrite: null, // true | false | null (unknown)
    server: false, // served by tools/server.js (self-hosted)
    offline: false, // self-hosted: lost the connection, reconnecting
    p2p: null, // online play: { role: 'host' | 'guest', code, status }
    camp: 'main', // current campaign id
    campName: '',
    conn: null, // self-hosted server connection
    accountsMode: false, // self-hosted server with --accounts: the server signs people in and checks every write
    authUser: null,
    relay: false, // sending writes through a writer's page
    readOnly: false,
    executorPresent: false,
    myPeer: null,
    game: {},
    scenes: new Map(),
    tokens: new Map(),
    tpls: new Map(),
    chars: new Map(),
    init: new Map(),
    encs: new Map(),
    hb: new Map(), // homebrew feats, shared by the table
    party: new Map(), // party inventory items
    accounts: new Map(), // name + PIN accounts
    art: new Map(), // pictures for monsters, by monster id
    log: [],
    peers: [],
    maps: new Map(),
    myChar: null,
  };

  /* -------------------------------------------------------------- bus */
  const listeners = new Map();
  function on(evt, fn) {
    if (!listeners.has(evt)) listeners.set(evt, new Set());
    listeners.get(evt).add(fn);
    return () => listeners.get(evt).delete(fn);
  }
  function emit(evt, data) {
    const set = listeners.get(evt);
    if (set) set.forEach((fn) => {
      try { fn(data); } catch (e) { console.error(evt, e); }
    });
    const all = listeners.get('*');
    if (all) all.forEach((fn) => {
      try { fn(evt, data); } catch (e) { console.error(e); }
    });
  }

  /* ---------------------------------------------------------- helpers */
  const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
  function uid(prefix) {
    const b = new Uint8Array(10);
    crypto.getRandomValues(b);
    let s = '';
    b.forEach((x) => (s += ID_CHARS[x % 36]));
    return (prefix || '') + Date.now().toString(36) + s;
  }
  const LS = {
    get(k, d) {
      try {
        const v = localStorage.getItem(k);
        return v == null ? d : JSON.parse(v);
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try {
        if (v === undefined || v === null) localStorage.removeItem(k);
        else localStorage.setItem(k, JSON.stringify(v));
      } catch (e) { /* storage blocked */ }
    },
  };
  const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
  const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
  function deepMerge(a, b) {
    const out = isObj(a) ? Object.assign({}, a) : {};
    for (const k in b) {
      if (isObj(b[k]) && isObj(out[k])) out[k] = deepMerge(out[k], b[k]);
      else out[k] = clone(b[k]);
    }
    return out;
  }
  const sizeOf = (o) => {
    try {
      return JSON.stringify(o).length;
    } catch (e) {
      return 1e9;
    }
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const PALETTE = ['#e0a43a', '#5fb2d9', '#d9675f', '#7cc576', '#b98ee0', '#e88fb8', '#62c7b5', '#d9c25f', '#8c9de8', '#e08a4f'];
  function colorFor(key) {
    let h = 0;
    for (const ch of String(key)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }

  /* ------------------------------------------------------- campaigns */
  // Each campaign is its own table. "main" is the original one and keeps the old storage names.
  const CAMP_RE = /^[a-z0-9-]{1,40}$/;
  function pickCampaign() {
    const q = new URLSearchParams(location.search).get('c');
    if (q && CAMP_RE.test(q)) return q;
    const l = LS.get('tt.campaign', 'main');
    return CAMP_RE.test(l) ? l : 'main';
  }
  const campSuffix = (cid) => (cid === 'main' ? '' : ':' + cid);
  // Homebrew belongs to the whole game, not one campaign: it always lives with the main campaign.
  // homebrew, accounts and monster pictures belong to the whole game, not one campaign
  const GLOBAL_COLS = ['homebrew', 'accounts', 'art'];
  const isGlobalPath = (p) => GLOBAL_COLS.some((c) => p === c || String(p).startsWith(c + '/'));

  /* ------------------------------------------- in-memory doc mirror */
  // Documents plus collection/doc watchers; shared by the solo and self-hosted backends
  function mirror() {
    const docs = new Map();
    const watchers = new Set();
    const colOf = (p) => p.slice(0, p.lastIndexOf('/'));
    function notify(path) {
      const col = colOf(path);
      watchers.forEach((w) => {
        if ((w.type === 'doc' && w.path === path) || (w.type === 'col' && w.path === col)) w.fire();
      });
    }
    const notifyAll = () => watchers.forEach((w) => w.fire());
    function list(col, opts) {
      let arr = [];
      docs.forEach((d, p) => {
        if (colOf(p) === col) arr.push({ id: p.slice(col.length + 1), raw: d });
      });
      if (opts && opts.orderBy) {
        const f = opts.orderBy;
        const dir = opts.dir === 'desc' ? -1 : 1;
        arr.sort((a, b) => ((a.raw[f] > b.raw[f]) - (a.raw[f] < b.raw[f])) * dir);
      } else arr.sort((a, b) => (a.id < b.id ? -1 : 1));
      if (opts && opts.limit) arr = arr.slice(0, opts.limit);
      return arr;
    }
    function watcher(type, path, fire) {
      const w = { type, path, dead: false, pending: false };
      w.fire = () => {
        if (w.pending) return;
        w.pending = true;
        queueMicrotask(() => {
          w.pending = false;
          if (!w.dead) fire();
        });
      };
      watchers.add(w);
      w.fire();
      return () => {
        w.dead = true;
        watchers.delete(w);
      };
    }
    return { docs, notify, notifyAll, list, watcher };
  }

  /* -------------------------------------------- local stand-in backend */
  function localBackend(cid) {
    const KEY = 'tt.local.v1' + campSuffix(cid || 'main');
    const M = mirror();
    const docs = M.docs;
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) Object.entries(JSON.parse(raw)).forEach(([p, d]) => docs.set(p, Object.freeze(d)));
    } catch (e) { /* ignore */ }
    let bc = null;
    try {
      bc = new BroadcastChannel('tt.local.db' + campSuffix(cid || 'main'));
    } catch (e) { /* no channel */ }
    let saveT = 0;
    // save right after the current batch of changes. Not on a timer: browsers slow timers down in
    // background tabs, and a DM's hosting tab often is one, so a reload could lose the last changes.
    function persist() {
      if (saveT) return;
      saveT = 1;
      queueMicrotask(() => {
        saveT = 0;
        try {
          const o = {};
          docs.forEach((d, p) => {
            if (!p.startsWith('mapchunks/')) o[p] = d;
          });
          localStorage.setItem(KEY, JSON.stringify(o));
        } catch (e) {
          console.warn('saving the table on this device failed', e);
        }
      });
    }
    // Map pieces are too big for localStorage, so they live in IndexedDB (best effort)
    const idb = (() => {
      let dbp = null;
      const open = () => dbp || (dbp = new Promise((res, rej) => {
        const rq = indexedDB.open('tt.local.maps' + campSuffix(cid || 'main'), 1);
        rq.onupgradeneeded = () => rq.result.createObjectStore('chunks');
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => rej(rq.error);
      }));
      const run = (mode, fn) => open().then((db) => new Promise((res, rej) => {
        const tx = db.transaction('chunks', mode);
        const rq = fn(tx.objectStore('chunks'));
        tx.oncomplete = () => res(rq.result);
        tx.onerror = tx.onabort = () => rej(tx.error);
      }));
      return {
        get: (k) => run('readonly', (s) => s.get(k)).catch(() => undefined),
        put: (k, v) => run('readwrite', (s) => s.put(v, k)).catch(() => {}),
        del: (k) => run('readwrite', (s) => s.delete(k)).catch(() => {}),
      };
    })();
    function put(path, data) {
      if (data === null) docs.delete(path);
      else docs.set(path, Object.freeze(clone(data)));
      if (!path.startsWith('mapchunks/')) persist();
      else if (data === null) idb.del(path);
      else idb.put(path, docs.get(path));
      M.notify(path);
    }
    if (bc) bc.onmessage = (ev) => {
      const m = ev.data;
      if (!m || m.t !== 'w') return;
      if (m.d === null) docs.delete(m.p);
      else docs.set(m.p, Object.freeze(m.d));
      M.notify(m.p);
    };
    function write(path, data) {
      put(path, data);
      try {
        if (bc) bc.postMessage({ t: 'w', p: path, d: data === null ? null : docs.get(path) });
      } catch (e) { /* ignore */ }
    }
    return {
      kind: 'local',
      all() {
        const o = {};
        docs.forEach((d, p) => {
          if (!p.startsWith('mapchunks/')) o[p] = d;
        });
        return o;
      },
      peek: (p) => (docs.has(p) ? docs.get(p) : null),
      watchCol(col, opts, cb) {
        return M.watcher('col', col, () => cb(M.list(col, opts), { fromCache: false }));
      },
      watchDoc(path, cb) {
        return M.watcher('doc', path, () => cb(docs.has(path) ? docs.get(path) : null, { fromCache: false }));
      },
      async set(path, data) {
        write(path, data);
      },
      async upd(path, patch) {
        const cur = docs.get(path);
        if (!cur) throw { code: 'invalid_argument', message: 'document does not exist' };
        write(path, deepMerge(cur, patch));
      },
      async del(path) {
        write(path, null);
      },
      async get(path) {
        if (docs.has(path)) return docs.get(path);
        if (!path.startsWith('mapchunks/')) return null;
        const d = await idb.get(path);
        if (!d) return null;
        docs.set(path, Object.freeze(d));
        return docs.get(path);
      },
    };
  }

  function splitBackend(own, shared) {
    // homebrew a campaign kept before homebrew became game-wide moves to the shared place
    Object.keys(own.all()).filter(isGlobalPath).forEach((p) => {
      if (!shared.peek(p)) shared.set(p, own.peek(p));
      own.del(p);
    });
    const pick = (p) => (isGlobalPath(p) ? shared : own);
    return {
      kind: 'local',
      all() {
        const o = own.all();
        const sh = shared.all();
        for (const p in sh) if (isGlobalPath(p)) o[p] = sh[p];
        return o;
      },
      peek: (p) => pick(p).peek(p),
      watchCol: (col, opts, cb, onErr) => pick(col).watchCol(col, opts, cb, onErr),
      watchDoc: (p, cb, onErr) => pick(p).watchDoc(p, cb, onErr),
      set: (p, d) => pick(p).set(p, d),
      upd: (p, d) => pick(p).upd(p, d),
      del: (p) => pick(p).del(p),
      get: (p) => pick(p).get(p),
    };
  }
  const campBackend = (cid) => (!cid || cid === 'main' ? localBackend('main') : splitBackend(localBackend(cid), localBackend('main')));

  /* ------------------------------------ self-hosted server (server.js) */
  // One computer runs tools/server.js; everyone opens its address. Live updates
  // arrive over server-sent events, writes and presence go up as small POSTs.
  async function findServer() {
    const get = async (q) => {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 4000);
      try {
        const r = await fetch('api/hello' + q, { cache: 'no-store', signal: ctl.signal });
        const j = await r.json().catch(() => null);
        return j && j.tavern ? { status: r.status, j } : null;
      } catch (e) {
        return null;
      } finally {
        clearTimeout(t);
      }
    };
    if (!/^https?:$/.test(location.protocol)) return null;
    if (/\.github\.io$/.test(location.hostname)) return null; // GitHub Pages can't run the table server: skip the check
    let key = LS.get('tt.key', '') || '';
    let r = await get('?key=' + encodeURIComponent(key));
    if (!r) return null;
    // a public server with accounts: everyone signs in with their own name and password
    if (r.j.accounts) return { key: '', accounts: true, user: r.j.user || (await signInScreen(r.j)) };
    while (r && r.status === 401) {
      const typed = window.prompt(key ? 'That password didn’t work. Table password:' : 'Table password:');
      if (typed == null) return { refused: true };
      key = typed.trim();
      r = await get('?key=' + encodeURIComponent(key));
    }
    if (!r) return null;
    LS.set('tt.key', key);
    return { key };
  }
  // the sign-in / create-account screen, shown before the table loads (accounts mode only)
  function signInScreen(hello) {
    return new Promise((resolve) => {
      let mode = hello.fresh ? 'create' : 'signin';
      let busy = false;
      const box = document.createElement('div');
      box.id = 'signin';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.setAttribute('aria-labelledby', 'siTitle');
      box.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;overflow:auto;background:var(--bg,#16130f);color:var(--ink,#eee)';
      box.innerHTML = `<form class="card" id="siForm" style="width:100%;max-width:380px;margin:auto" novalidate>
        <div class="card-title"><h3 id="siTitle">Tavern Table</h3></div>
        <div class="seg full" style="margin-bottom:12px"><button type="button" data-m="signin">Sign in</button><button type="button" data-m="create">Create account</button></div>
        <p class="hint" id="siHint" style="margin-top:0"></p>
        <label class="field"><span>Name</span><input type="text" id="siName" maxlength="40" autocomplete="username" autocapitalize="off" spellcheck="false" required></label>
        <label class="field"><span>Password</span><input type="password" id="siPass" autocomplete="current-password" required></label>
        <label class="field" id="siPass2Row"><span>Password again</span><input type="password" id="siPass2" autocomplete="new-password"></label>
        <p class="err" id="siErr" role="alert" style="min-height:1.2em;margin:4px 0"></p>
        <div class="btn-row end"><button type="submit" class="btn btn-primary" id="siGo"></button></div>
      </form>`;
      document.body.appendChild(box);
      const $ = (id) => box.querySelector('#' + id);
      const draw = () => {
        const create = mode === 'create';
        box.querySelectorAll('[data-m]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.m === mode)));
        $('siPass2Row').hidden = !create;
        $('siPass').setAttribute('autocomplete', create ? 'new-password' : 'current-password');
        $('siGo').textContent = busy ? 'One moment…' : create ? 'Create account' : 'Sign in';
        $('siGo').disabled = busy;
        $('siHint').textContent = create
          ? hello.fresh ? 'You’re the first one here: your account owns this table and is the DM.' : 'Pick a name your friends will recognise and a password of at least 8 characters.'
          : 'Sign in with your name and password. You stay signed in on this device.';
      };
      const err = (m) => ($('siErr').textContent = m || '');
      box.addEventListener('click', (e) => {
        const b = e.target.closest('[data-m]');
        if (!b || busy) return;
        mode = b.dataset.m;
        err('');
        draw();
      });
      $('siForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        if (busy) return;
        const name = $('siName').value.trim();
        const password = $('siPass').value;
        if (name.length < 2) return err('Type your name (at least 2 characters).');
        if (mode === 'create' && password.length < 8) return err('The password needs at least 8 characters.');
        if (mode === 'create' && password !== $('siPass2').value) return err('The two passwords aren’t the same.');
        if (!password) return err('Type your password.');
        busy = true;
        err('');
        draw();
        let r = null;
        let j = {};
        try {
          r = await fetch(mode === 'create' ? 'api/register' : 'api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, password }), credentials: 'same-origin' });
          j = await r.json().catch(() => ({}));
        } catch (er) { /* offline */ }
        busy = false;
        if (r && r.ok && j.user) {
          box.remove();
          return resolve(j.user);
        }
        draw();
        err(!r ? 'The table can’t be reached. Check your connection and try again.' : j.message || 'That didn’t work. Try again.');
      });
      draw();
      setTimeout(() => $('siName').focus(), 30);
    });
  }
  // the session ended (signed out elsewhere, or the password was reset): back to the sign-in screen
  let signedOutOnce = false;
  function signedOut() {
    if (signedOutOnce) return;
    signedOutOnce = true;
    location.reload();
  }
  function serverConn(key, cid) {
    const q = '?key=' + encodeURIComponent(key || '') + '&c=' + encodeURIComponent(cid || 'main');
    const conn = { peer: null, owner: false, ready: false, live: false, onSnap: null, onDoc: null, onPeers: null, onHello: null, onState: null };
    let first = null;
    conn.firstHello = new Promise((res) => (first = res));
    const es = new EventSource('api/events' + q);
    const on = (ev, fn) => es.addEventListener(ev, (e) => {
      let m = null;
      try {
        m = JSON.parse(e.data);
      } catch (er) {
        return;
      }
      fn(m);
    });
    on('hello', (m) => {
      conn.peer = m.peer;
      conn.owner = !!m.owner;
      conn.live = true;
      first(m);
      if (conn.onHello) conn.onHello(m);
      if (conn.onState) conn.onState(true);
    });
    on('snap', (m) => {
      conn.ready = true;
      if (conn.onSnap) conn.onSnap(m.docs || {});
    });
    on('doc', (m) => conn.onDoc && conn.onDoc(m));
    on('peers', (m) => conn.onPeers && conn.onPeers(m.peers || []));
    let lastCheck = 0;
    es.onerror = () => {
      // with accounts, a stream that fails may mean the session ended
      if (conn.accounts && Date.now() - lastCheck > 3000) {
        lastCheck = Date.now();
        fetch('api/me', { cache: 'no-store' }).then((r) => r.status === 401 && signedOut()).catch(() => {});
      }
      if (!conn.live) return;
      conn.live = false;
      if (conn.onState) conn.onState(false);
    };
    conn.post = async (url, body) => {
      let r;
      try {
        r = await fetch(url + q, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      } catch (e) {
        throw { code: 'unavailable', message: 'server unreachable' };
      }
      const j = await r.json().catch(() => ({}));
      if (r.status === 401 && conn.accounts) signedOut();
      if (!r.ok) throw { code: j.code || (r.status === 401 ? 'revoked' : r.status === 403 ? 'permission_denied' : r.status === 413 ? 'quota_exceeded' : 'unavailable'), message: j.message || 'HTTP ' + r.status };
      return j;
    };
    conn.getJson = async (url) => {
      let r;
      try {
        r = await fetch(url + (url.includes('?') ? '&' : '?') + q.slice(1), { cache: 'no-store' });
      } catch (e) {
        throw { code: 'unavailable' };
      }
      if (r.status === 401 && conn.accounts) signedOut();
      if (!r.ok) throw { code: r.status === 403 ? 'permission_denied' : 'unavailable', message: r.status === 403 ? 'You don’t have permission to do that.' : 'HTTP ' + r.status };
      return r.json();
    };
    return conn;
  }
  function serverBackend(conn) {
    const M = mirror();
    const docs = M.docs;
    conn.onSnap = (all) => {
      docs.clear();
      for (const p in all) docs.set(p, Object.freeze(all[p]));
      M.notifyAll();
    };
    conn.onDoc = (m) => {
      if (!m || typeof m.p !== 'string') return;
      if (m.d === null || m.d === undefined) docs.delete(m.p);
      else docs.set(m.p, Object.freeze(m.d));
      M.notify(m.p);
    };
    // until the first snapshot arrives, listeners hear nothing (so nothing counts as loaded)
    const when = (fn) => () => conn.ready && fn();
    return {
      kind: 'server',
      watchCol(col, opts, cb) {
        return M.watcher('col', col, when(() => cb(M.list(col, opts), { fromCache: false })));
      },
      watchDoc(path, cb) {
        return M.watcher('doc', path, when(() => cb(docs.has(path) ? docs.get(path) : null, { fromCache: false })));
      },
      set: (path, data) => conn.post('api/write', { t: 'set', p: path, d: data }),
      upd: (path, patch) => conn.post('api/write', { t: 'upd', p: path, d: patch }),
      del: (path) => conn.post('api/write', { t: 'del', p: path }),
      async get(path) {
        if (docs.has(path)) return docs.get(path);
        const j = await conn.getJson('api/doc?p=' + encodeURIComponent(path));
        return j && j.d ? j.d : null;
      },
    };
  }
  function serverRoom(conn) {
    const mine = {};
    let peers = Object.freeze([]);
    const fns = new Set();
    conn.onPeers = (list) => {
      peers = Object.freeze(list.map((x) => {
        const me = x.peer === conn.peer;
        return Object.freeze({ peer: x.peer, by: null, isMe: me, sameTab: me, kind: 'viewer', guest: false, presence: Object.freeze(x.presence || {}), updatedAt: x.t || 0 });
      }));
      fns.forEach((fn) => fn({ peers, joined: [], left: [], updated: [] }));
    };
    // drags send many updates: batch them, at most one request per 60 ms
    let pending = null;
    let timer = 0;
    function flush() {
      timer = 0;
      if (!pending || !conn.peer) return;
      const patch = pending;
      pending = null;
      conn.post('api/presence', { peer: conn.peer, patch }).catch(() => {});
    }
    conn.onHello = () => {
      // a reconnect gives a new peer id: send everything again
      pending = Object.assign({}, mine);
      flush();
    };
    return {
      local: false,
      async presence(patch) {
        for (const k in patch) {
          if (patch[k] === null) delete mine[k];
          else mine[k] = patch[k];
        }
        pending = Object.assign(pending || {}, patch);
        if (!timer) timer = setTimeout(flush, 60);
      },
      peers: () => peers,
      onPeers(fn) {
        fns.add(fn);
        queueMicrotask(() => fn({ peers, joined: [], left: [], updated: [] }));
        return () => fns.delete(fn);
      },
      async emit() { /* the table uses presence only */ },
      on: () => () => {},
      connected: () => conn.live,
    };
  }

  /* ----------------------------- online play: the DM's browser is the host */
  // The host runs a hub over its own saved table (the same storage as solo mode).
  // Friends connect peer-to-peer (PeerJS) with the room code from the join link.
  // Both sides reuse serverBackend/serverRoom through a "conn" with the same shape.
  const HUB_PATH = /^[a-z]{1,20}\/[A-Za-z0-9_~:@+-][A-Za-z0-9_.~:@+-]{0,119}$/;
  function makeHub(B) {
    const clients = new Map(); // id -> { send, presence, t }
    let peersT = 0;
    const peersSoon = () => {
      if (peersT) return;
      peersT = setTimeout(() => {
        peersT = 0;
        const peers = [...clients].map(([peer, c]) => ({ peer, presence: c.presence, t: c.t }));
        clients.forEach((c) => c.send({ t: 'peers', peers }));
      }, 40);
    };
    const broadcast = (m) => clients.forEach((c) => c.send(m));
    return {
      size: () => clients.size,
      join(id, send, owner) {
        if (clients.size >= 30 && !owner) return false;
        clients.set(id, { send, presence: {}, t: Date.now() });
        send({ t: 'hello', peer: id, owner: !!owner });
        send({ t: 'snap', docs: B.all() });
        peersSoon();
        return true;
      },
      leave(id) {
        if (clients.delete(id)) peersSoon();
      },
      // everything here comes from other people's browsers: check it all
      async request(id, m) {
        const c = clients.get(id);
        if (!c || !m || typeof m !== 'object') return { code: 'invalid_argument' };
        if (m.op === 'write') {
          const p = m.p;
          if (typeof p !== 'string' || !HUB_PATH.test(p) || !['set', 'upd', 'del'].includes(m.t)) return { code: 'invalid_argument' };
          if (m.t !== 'del' && (!isObj(m.d) || sizeOf(m.d) > 300000)) return { code: 'invalid_argument' };
          try {
            if (m.t === 'set') await B.set(p, m.d);
            else if (m.t === 'upd') await B.upd(p, m.d);
            else await B.del(p);
          } catch (e) {
            return { code: (e && e.code) || 'unavailable' };
          }
          if (!p.startsWith('mapchunks/')) broadcast({ t: 'doc', p, d: m.t === 'del' ? null : B.peek(p) });
          return { ok: true };
        }
        if (m.op === 'presence') {
          if (!isObj(m.patch)) return { code: 'invalid_argument' };
          const next = Object.assign({}, c.presence);
          for (const k in m.patch) {
            if (m.patch[k] === null) delete next[k];
            else next[k] = m.patch[k];
          }
          if (sizeOf(next) > 6000) return { code: 'invalid_argument' };
          c.presence = next;
          c.t = Date.now();
          peersSoon();
          return { ok: true };
        }
        if (m.op === 'get') {
          if (typeof m.p !== 'string' || !HUB_PATH.test(m.p)) return { code: 'invalid_argument' };
          return { ok: true, d: await B.get(m.p) };
        }
        return { code: 'invalid_argument' };
      },
    };
  }
  // messages from the hub, the same for the host's own screen and a friend's
  function connDispatch(conn, m, first) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'hello') {
      conn.peer = m.peer;
      conn.owner = !!m.owner;
      conn.live = true;
      first();
      if (conn.onHello) conn.onHello(m);
      if (conn.onState) conn.onState(true);
    } else if (m.t === 'snap') {
      conn.ready = true;
      if (conn.onSnap) conn.onSnap(m.docs || {});
    } else if (m.t === 'doc') {
      if (conn.onDoc) conn.onDoc(m);
    } else if (m.t === 'peers') {
      if (conn.onPeers) conn.onPeers(Array.isArray(m.peers) ? m.peers : []);
    }
  }
  function newConn() {
    const conn = { peer: null, owner: false, ready: false, live: false, onSnap: null, onDoc: null, onPeers: null, onHello: null, onState: null };
    let first = null;
    conn.firstHello = new Promise((res) => (first = res));
    return [conn, () => first()];
  }
  const asHubRequest = (url, body) => (url === 'api/write' ? Object.assign({ op: 'write' }, body) : url === 'api/presence' ? { op: 'presence', patch: body && body.patch } : { op: 'none' });
  const docParam = (url) => new URLSearchParams(String(url).split('?')[1] || '').get('p');
  // the host's own screen talks to the hub directly
  function loopbackConn(hub) {
    const [conn, first] = newConn();
    hub.join('host', (m) => queueMicrotask(() => connDispatch(conn, m, first)), true);
    const ask = async (m) => {
      const r = await hub.request('host', m);
      if (r.code) throw { code: r.code };
      return r;
    };
    conn.post = (url, body) => ask(asHubRequest(url, body));
    conn.getJson = async (url) => ({ d: (await ask({ op: 'get', p: docParam(url) })).d });
    return conn;
  }
  // PeerJS ships with the app (vendor/); a custom broker can be named in the address (?broker=host:port/path)
  let peerLib = null;
  function loadPeerJs() {
    if (!peerLib) peerLib = new Promise((res, rej) => {
      if (window.Peer) return res(window.Peer);
      const s = document.createElement('script');
      s.src = 'vendor/peerjs.min.js';
      s.onload = () => (window.Peer ? res(window.Peer) : rej(new Error('PeerJS did not load')));
      s.onerror = () => rej(new Error('PeerJS did not load'));
      document.head.appendChild(s);
    });
    return peerLib;
  }
  function peerConfig() {
    const q = new URLSearchParams(location.search);
    const cfg = { debug: 0 };
    const m = /^([A-Za-z0-9.-]+)(?::(\d+))?(\/[A-Za-z0-9_\/-]*)?$/.exec(q.get('broker') || '');
    if (m) {
      cfg.host = m[1];
      cfg.port = Number(m[2] || 443);
      cfg.path = m[3] || '/';
      cfg.secure = q.get('broker_secure') !== '0';
    }
    if (q.get('ice') === 'none') cfg.config = { iceServers: [] };
    return cfg;
  }
  const ROOM_RE = /^tt-[a-z0-9]{8,40}$/;
  function joinCodeFromUrl() {
    const m = /(?:^|[#&])join=([a-z0-9-]{8,48})/.exec(location.hash || '');
    return m && ROOM_RE.test(m[1]) ? m[1] : null;
  }
  async function peerGuestConn(code, onTrouble) {
    const [conn, first] = newConn();
    const Peer = await loadPeerJs();
    const peer = new Peer(undefined, peerConfig());
    let dc = null;
    let seq = 0;
    let retry = 0;
    const waiting = new Map();
    const lost = () => {
      waiting.forEach((w) => w.reject({ code: 'unavailable' }));
      waiting.clear();
      if (conn.live) {
        conn.live = false;
        if (conn.onState) conn.onState(false);
      }
      clearTimeout(retry);
      retry = setTimeout(connect, 3000);
    };
    function connect() {
      if (peer.destroyed) return;
      if (peer.disconnected) {
        peer.reconnect();
        return;
      }
      if (dc && dc.open) return;
      dc = peer.connect(code, { reliable: true });
      dc.on('data', (m) => {
        if (m && m.t === 'res' && waiting.has(m.id)) {
          const w = waiting.get(m.id);
          waiting.delete(m.id);
          if (m.code) w.reject({ code: m.code });
          else w.resolve(m);
        } else connDispatch(conn, m, first);
      });
      dc.on('close', lost);
      dc.on('error', lost);
    }
    peer.on('open', connect);
    peer.on('disconnected', () => setTimeout(() => !peer.destroyed && peer.reconnect(), 2000));
    peer.on('error', (e) => {
      if (onTrouble) onTrouble(e && e.type);
      if (e && (e.type === 'peer-unavailable' || e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error')) lost();
    });
    const ask = (m) => new Promise((resolve, reject) => {
      if (!dc || !dc.open) return reject({ code: 'unavailable' });
      const id = ++seq;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject({ code: 'unavailable' });
      }, 20000);
      waiting.set(id, { resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (v) => (clearTimeout(timer), reject(v)) });
      try {
        dc.send({ t: 'req', id, q: m }); // the request rides in q: a write has its own t (set/upd/del)
      } catch (e) {
        waiting.delete(id);
        clearTimeout(timer);
        reject({ code: 'unavailable' });
      }
    });
    conn.post = (url, body) => ask(asHubRequest(url, body));
    conn.getJson = async (url) => ({ d: (await ask({ op: 'get', p: docParam(url) })).d });
    return conn;
  }
  // the host listens for friends; the room code stays the same across reloads
  async function peerHost(hub, code, onStatus) {
    const Peer = await loadPeerJs();
    let peer = null;
    let tries = 0;
    const open = () => {
      peer = new Peer(code, peerConfig());
      peer.on('open', () => {
        tries = 0;
        onStatus('online');
      });
      peer.on('connection', (dc) => {
        const cid = 'g' + uid('').slice(-10);
        const send = (m) => {
          try {
            if (dc.open) dc.send(m);
          } catch (e) { /* gone */ }
        };
        dc.on('open', () => {
          if (!hub.join(cid, send, false)) dc.close();
        });
        dc.on('data', async (m) => {
          if (!m || m.t !== 'req' || !m.q) return;
          const r = await hub.request(cid, m.q);
          send(Object.assign({ t: 'res', id: m.id }, r));
        });
        dc.on('close', () => hub.leave(cid));
        dc.on('error', () => hub.leave(cid));
      });
      peer.on('disconnected', () => {
        onStatus('reconnecting');
        setTimeout(() => !peer.destroyed && peer.reconnect(), 2000);
      });
      peer.on('error', (e) => {
        const t = e && e.type;
        if (t === 'unavailable-id') {
          // after a reload the broker can hold the old code for a few seconds
          peer.destroy();
          onStatus(tries > 6 ? 'taken' : 'starting');
          if (tries++ <= 6) setTimeout(open, 2500);
          else setTimeout(open, 15000);
        } else if (t === 'network' || t === 'server-error' || t === 'socket-error' || t === 'browser-incompatible') onStatus(t === 'browser-incompatible' ? 'unsupported' : 'offline');
      });
    };
    open();
  }

  /* ------------------------------------------------- db-backed backend */
  function remoteBackend(db, cid) {
    // other campaigns live under camp/<id>/… in the same shared database
    const P = (p) => (!cid || cid === 'main' || isGlobalPath(p) ? p : 'camp/' + cid + '/' + p);
    const wrap = (snapDocs) => snapDocs.filter((d) => d.exists !== false).map((d) => ({ id: d.id, raw: d.data() }));
    return {
      kind: 'remote',
      watchCol(col, opts, cb, onErr) {
        let q = db.collection(P(col));
        if (opts && opts.orderBy) q = q.orderBy(opts.orderBy, opts.dir || 'asc');
        if (opts && opts.limit) q = q.limit(opts.limit);
        return q.onSnapshot((snap) => cb(wrap(snap.docs), snap.metadata || {}), (e) => onErr && onErr(e));
      },
      watchDoc(path, cb, onErr) {
        return db.doc(P(path)).onSnapshot((snap) => cb(snap.exists ? snap.data() : null, snap.metadata || {}), (e) => onErr && onErr(e));
      },
      set: (path, data) => db.doc(P(path)).set(data),
      upd: (path, patch) => db.doc(P(path)).update(patch),
      del: (path) => db.doc(P(path)).delete(),
      col: (col) => db.collection(P(col)),
      async get(path) {
        const s = await db.doc(P(path)).get();
        return s.exists ? s.data() : null;
      },
    };
  }

  /* --------------------------------------------- local stand-in room */
  function localRoom() {
    let bc;
    try {
      bc = new BroadcastChannel('tt.local.room' + campSuffix(S.camp));
    } catch (e) {
      return null;
    }
    const peer = uid('l');
    let mine = {};
    const others = new Map();
    const peerFns = new Set();
    const topicFns = new Map();
    let frozen = [];
    function rebuild() {
      const list = [{ peer, by: null, isMe: true, sameTab: true, kind: 'viewer', guest: false, presence: Object.freeze(Object.assign({}, mine)), updatedAt: Date.now() }];
      others.forEach((o, p) => list.push({ peer: p, by: null, isMe: false, sameTab: false, kind: 'viewer', guest: false, presence: o.presence, updatedAt: o.t }));
      frozen = Object.freeze(list);
      peerFns.forEach((fn) => fn({ peers: frozen, joined: [], left: [], updated: [] }));
    }
    function post(m) {
      try {
        bc.postMessage(m);
      } catch (e) { /* ignore */ }
    }
    bc.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.t === 'p') {
        others.set(m.peer, { presence: Object.freeze(m.presence || {}), t: Date.now() });
        rebuild();
      } else if (m.t === 'hello') {
        post({ t: 'p', peer, presence: mine });
      } else if (m.t === 'bye') {
        others.delete(m.peer);
        rebuild();
      } else if (m.t === 'e') {
        const fns = topicFns.get(m.topic);
        if (fns) fns.forEach((fn) => fn({ topic: m.topic, data: m.data, peer: m.peer, by: null, isMe: false, sameTab: false, kind: 'viewer', guest: false }));
      }
    };
    setInterval(() => {
      post({ t: 'p', peer, presence: mine });
      const now = Date.now();
      let changed = false;
      others.forEach((o, p) => {
        if (now - o.t > 7000) {
          others.delete(p);
          changed = true;
        }
      });
      if (changed) rebuild();
    }, 2500);
    addEventListener('pagehide', () => post({ t: 'bye', peer }));
    post({ t: 'hello' });
    return {
      local: true,
      async presence(patch) {
        for (const k in patch) {
          if (patch[k] === null) delete mine[k];
          else mine[k] = patch[k];
        }
        post({ t: 'p', peer, presence: mine });
        rebuild();
      },
      peers: () => frozen,
      onPeers(fn) {
        peerFns.add(fn);
        queueMicrotask(rebuild);
        return () => peerFns.delete(fn);
      },
      async emit(topic, data) {
        post({ t: 'e', topic, data, peer });
        const fns = topicFns.get(topic);
        if (fns) fns.forEach((fn) => fn({ topic, data, peer, by: null, isMe: true, sameTab: true, kind: 'viewer', guest: false }));
      },
      on(topic, fn) {
        if (!topicFns.has(topic)) topicFns.set(topic, new Set());
        topicFns.get(topic).add(fn);
        return () => topicFns.get(topic).delete(fn);
      },
      connected: () => true,
    };
  }

  /* ------------------------------------------------------ write queue */
  const Q = new Map();
  function mergeOp(prev, next) {
    if (!prev || next.t === 'del' || next.t === 'set') return next;
    if (prev.t === 'set') return { t: 'set', d: deepMerge(prev.d, next.d) };
    if (prev.t === 'upd') return { t: 'upd', d: deepMerge(prev.d, next.d) };
    return prev; // a patch after a delete must not bring back a half-empty document
  }
  // Only these documents may be created by a patch (game/state starts out missing)
  const UPSERT_PATH = /^game\//;
  function enqueue(path, op) {
    if (S.readOnly) {
      toastWarn('This view is read-only.');
      return Promise.resolve(false);
    }
    if (S.relay) return Promise.resolve(relaySend(path, op));
    let q = Q.get(path);
    if (!q) Q.set(path, (q = { busy: false, next: null, waiters: [] }));
    q.next = mergeOp(q.next, op);
    const p = new Promise((res) => q.waiters.push(res));
    if (!q.busy) pump(path, q);
    return p;
  }
  async function pump(path, q) {
    q.busy = true;
    while (q.next) {
      const op = q.next;
      const waiters = q.waiters;
      q.next = null;
      q.waiters = [];
      let ok = false;
      if (S.relay) ok = relaySend(path, op);
      else ok = await execWithRecovery(path, op);
      waiters.forEach((w) => w(ok));
    }
    q.busy = false;
  }
  function exec(path, op) {
    const B = S.backend;
    if (op.t === 'set') return B.set(path, op.d);
    if (op.t === 'upd') return B.upd(path, op.d);
    return B.del(path);
  }
  async function execWithRecovery(path, op) {
    try {
      await exec(path, op);
      writeOk();
      return true;
    } catch (e) {
      const code = (e && e.code) || 'unavailable';
      if (code === 'unavailable' || code === 'resource_exhausted') {
        await sleep(400 + Math.random() * 700);
        try {
          await exec(path, op);
          writeOk();
          return true;
        } catch (e2) {
          return writeFailed(e2, path, op);
        }
      }
      if (code === 'invalid_argument' && op.t === 'upd') {
        let exists = null;
        try {
          exists = !!(await S.backend.get(path));
        } catch (e3) { /* unknown */ }
        if (exists === false && !UPSERT_PATH.test(path)) {
          // patching something that was deleted (a drop landing after someone removed the token): nothing to do
          return false;
        }
        if (exists === false) {
          try {
            await exec(path, { t: 'set', d: op.d });
            writeOk();
            return true;
          } catch (e4) {
            return writeFailed(e4, path, { t: 'set', d: op.d });
          }
        }
      }
      return writeFailed(e, path, op);
    }
  }
  function writeOk() {
    if (S.canWrite !== true) {
      S.canWrite = true;
      pushPresence({ w: 1 });
      emit('me');
    }
  }
  function writeFailed(e, path, op) {
    const code = e && e.code;
    console.warn('write failed', path, e);
    if (code === 'permission_denied') {
      // the server said no (accounts mode): never relay this, just tell them and undo any local preview
      toastWarn('You don’t have permission to do that.');
      emit('denied', path);
      return false;
    }
    if (code === 'signed_out') return false;
    if ((code === 'invalid_argument' || code === 'not_granted') && S.canWrite !== true && sizeOf(op) < 200000) {
      enterRelay();
      return relaySend(path, op);
    }
    if (code === 'quota_exceeded') toastWarn('The table’s storage is full. Delete an old scene or clear the log, then try again.');
    else if (code === 'revoked') {
      S.readOnly = true;
      emit('me');
    } else toastWarn('That change didn’t save. Check your connection and try again.');
    return false;
  }
  let toastFn = (m) => console.warn(m);
  const toastWarn = (m) => toastFn(m, 'warn');

  // JSON round-trip drops undefined values before anything reaches the store
  const W = {
    set: (path, data) => enqueue(path, { t: 'set', d: clone(data) }),
    upd: (path, patch) => enqueue(path, { t: 'upd', d: clone(patch) }),
    del: (path) => enqueue(path, { t: 'del' }),
  };

  /* ------------------------------------------------------------ relay */
  const RELAY_PATH = /^(tokens|templates|log|init|chars|game|homebrew|party|accounts|art)\/[A-Za-z0-9_.~:@+-]{1,80}$/;
  const RELAY_MAX = 2300;
  const relay = { seq: 0, ops: [] };
  const execState = { applied: new Map(), lastAck: '' };
  let myPresence = {};

  function enterRelay() {
    if (S.relay) return;
    S.relay = true;
    S.canWrite = false;
    emit('me');
  }
  function splitOp(op) {
    if (op.t === 'del' || sizeOf(op) <= RELAY_MAX) return [op];
    const parts = [];
    let cur = {};
    let first = op.t === 'set';
    let dropped = false;
    const flush = () => {
      if (!Object.keys(cur).length) return;
      parts.push({ t: first ? 'set' : 'upd', d: cur });
      first = false;
      cur = {};
    };
    for (const k in op.d) {
      const one = { [k]: op.d[k] };
      if (sizeOf(one) > RELAY_MAX - 60) {
        dropped = true;
        continue;
      }
      if (sizeOf(Object.assign({}, cur, one)) > RELAY_MAX - 60) flush();
      cur[k] = op.d[k];
    }
    flush();
    if (dropped) toastWarn('Some details were too large to send from this view (like a portrait photo).');
    return parts;
  }
  function relaySend(path, op) {
    if (!S.room) {
      toastWarn('This view is read-only.');
      return false;
    }
    if (!RELAY_PATH.test(path) || (path.startsWith('game/') && op.t !== 'upd')) {
      toastWarn('Only someone with edit access can do that.');
      return false;
    }
    for (const part of splitOp(op)) {
      const prev = relay.ops.length ? relay.ops[relay.ops.length - 1] : null;
      if (prev && prev.p === path && prev.t !== 'del' && part.t === 'upd' && sizeOf(deepMerge(prev.d, part.d)) <= RELAY_MAX) {
        prev.d = deepMerge(prev.d, part.d);
        prev.s = ++relay.seq;
      } else relay.ops.push({ s: ++relay.seq, p: path, t: part.t, d: part.d });
    }
    while (relay.ops.length > 1 && sizeOf(relay.ops) > 3000) relay.ops.shift();
    pushPresence({ ops: relay.ops });
    emit('relay');
    return true;
  }
  function validRelayOp(o) {
    if (!o || typeof o.p !== 'string' || !RELAY_PATH.test(o.p)) return false;
    if (!['set', 'upd', 'del'].includes(o.t)) return false;
    if (o.p.startsWith('game/') && (o.t !== 'upd' || o.p !== 'game/state')) return false;
    if (o.t !== 'del' && !isObj(o.d)) return false;
    return true;
  }
  function relayTick(peers) {
    const me = peers.find((p) => p.sameTab);
    S.myPeer = me ? me.peer : null;
    const writers = peers.filter((p) => p.kind === 'viewer' && p.presence && p.presence.w === 1).sort((a, b) => (a.peer < b.peer ? -1 : 1));
    const ex = writers[0] || null;
    const hadExec = S.executorPresent;
    S.executorPresent = !!ex;
    if (S.relay && me) {
      const ack = ex && ex.presence.ack && ex.presence.ack[me.peer];
      if (ack) {
        const n = relay.ops.length;
        relay.ops = relay.ops.filter((o) => o.s > ack);
        if (relay.ops.length !== n) {
          pushPresence({ ops: relay.ops.length ? relay.ops : null });
          emit('relay');
        }
      }
    }
    if (hadExec !== S.executorPresent) emit('relay');
    if (!ex || !me || ex.peer !== me.peer || S.relay) return;
    const acks = {};
    for (const p of peers) {
      if (p.sameTab) continue;
      const ops = p.presence && Array.isArray(p.presence.ops) ? p.presence.ops : null;
      if (!ops || !ops.length) continue;
      let last = execState.applied.get(p.peer) || 0;
      ops.slice().sort((a, b) => a.s - b.s).forEach((o) => {
        if (!(o.s > last)) return;
        if (validRelayOp(o)) {
          if (o.t === 'set') W.set(o.p, o.d);
          else if (o.t === 'upd') W.upd(o.p, o.d);
          else W.del(o.p);
        }
        last = o.s;
      });
      execState.applied.set(p.peer, last);
      acks[p.peer] = last;
    }
    const sig = JSON.stringify(acks);
    if (sig !== execState.lastAck) {
      execState.lastAck = sig;
      pushPresence({ ack: Object.keys(acks).length ? acks : null });
    }
  }

  /* --------------------------------------------------------- presence */
  function pushPresence(patch) {
    for (const k in patch) {
      if (patch[k] === null) delete myPresence[k];
      else myPresence[k] = patch[k];
    }
    if (S.room) {
      try {
        const p = S.room.presence(patch);
        if (p && p.catch) p.catch((e) => console.warn('presence', e && e.code));
      } catch (e) { /* ignore */ }
    }
  }
  function basePresence() {
    pushPresence({ pk: S.me.pk, nm: (S.me.nick || '').slice(0, 40), col: S.me.color, ch: S.myChar || null, dm: S.dm ? 1 : 0, w: S.canWrite === true ? 1 : 0, sc: S.game.scene || null, cp: S.camp });
  }

  /* ---------------------------------------------------- subscriptions */
  const loadedSet = new Set();
  const NEEDED = ['game', 'scenes', 'tokens', 'tpls', 'chars', 'init', 'encs', 'hb', 'party', 'accounts', 'art', 'log'];
  let loadTimer = 0;
  function markLoaded(name, meta) {
    if (meta && meta.fromCache) return;
    loadedSet.add(name);
    if (!S.loaded && NEEDED.every((n) => loadedSet.has(n))) {
      S.loaded = true;
      S.stale = false;
      clearTimeout(loadTimer);
      emit('loaded');
    }
  }
  function mapFrom(rows, prev) {
    const m = new Map();
    rows.forEach((r) => {
      const old = prev && prev.get(r.id);
      if (old && old.__raw === r.raw) m.set(r.id, old);
      else {
        const o = Object.assign({}, r.raw, { id: r.id });
        Object.defineProperty(o, '__raw', { value: r.raw, enumerable: false });
        m.set(r.id, o);
      }
    });
    return m;
  }
  let logSeen = null;
  function subscribeAll() {
    const B = S.backend;
    const err = (name) => (e) => {
      console.warn('listener ended', name, e);
      if (e && e.code === 'revoked') {
        S.readOnly = true;
        emit('me');
      }
    };
    loadTimer = setTimeout(() => {
      if (!S.loaded) {
        S.stale = true;
        emit('loaded');
      }
    }, 10000);
    B.watchDoc('game/state', (d, meta) => {
      S.game = d ? Object.assign({}, d) : {};
      markLoaded('game', meta);
      emit('game');
      if (myPresence.sc !== (S.game.scene || null)) pushPresence({ sc: S.game.scene || null });
    }, err('game'));
    const col = (path, key, evt, opts) => B.watchCol(path, opts || null, (rows, meta) => {
      S[key] = mapFrom(rows, S[key]);
      markLoaded(key, meta);
      emit(evt);
    }, err(path));
    col('scenes', 'scenes', 'scenes');
    col('tokens', 'tokens', 'tokens');
    col('templates', 'tpls', 'tpls');
    col('chars', 'chars', 'chars');
    col('init', 'init', 'init');
    col('encounters', 'encs', 'encs');
    col('homebrew', 'hb', 'homebrew');
    col('party', 'party', 'party');
    col('accounts', 'accounts', 'accounts');
    col('art', 'art', 'art');
    B.watchCol('log', { orderBy: 'ts', dir: 'desc', limit: 80 }, (rows, meta) => {
      const list = rows.map((r) => Object.assign({}, r.raw, { id: r.id })).reverse();
      const fresh = [];
      if (logSeen) list.forEach((e) => !logSeen.has(e.id) && fresh.push(e));
      logSeen = new Set(list.map((e) => e.id));
      S.log = list;
      markLoaded('log', meta);
      emit('log', fresh);
    }, err('log'));
  }

  /* ----------------------------------------------------- room wiring */
  const lastPing = new Map();
  function wireRoom() {
    const room = S.room;
    if (!room) return;
    room.onPeers((ch) => {
      S.peers = (ch.peers || room.peers()).filter((p) => p.sameTab || ((p.presence && p.presence.cp) || 'main') === S.camp);
      try {
        relayTick(S.peers);
      } catch (e) {
        console.error(e);
      }
      // pings from other people: a new pg value in their presence
      S.peers.forEach((p) => {
        if (p.sameTab || !p.presence) return;
        const pg = p.presence.pg;
        const key = p.peer;
        const seen = lastPing.get(key);
        const t = pg && pg.t;
        if (seen === undefined) {
          lastPing.set(key, t || 0);
          return;
        }
        if (pg && t && t !== seen) {
          lastPing.set(key, t);
          emit('ping', { x: pg.x, y: pg.y, sc: pg.sc, col: p.presence.col || '#d8a54a' });
        }
      });
      emit('peers', ch);
    }, (e) => console.warn('room', e && e.code));
    basePresence();
  }

  /* ------------------------------------------------------------- data */
  const DATA = {};
  function loadData(name) {
    if (!DATA[name]) {
      DATA[name] = fetch('data/' + name + '.json').then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then((d) => {
        Data.srd[name] = d;
        mergeHomebrew();
        emit('data', name);
        return d;
      });
      DATA[name].catch(() => {
        delete DATA[name];
      });
    }
    return DATA[name];
  }
  const Data = { rules: null, spells: null, monsters: null, features: null, spellsById: null, monstersById: null, srd: {} };
  // The rules, spell list, bestiary and feature texts everyone sees: the SRD plus this table's homebrew.
  function mergeHomebrew() {
    const hb = [...S.hb.values()];
    const srd = Data.srd;
    const of = (k) => hb.filter((f) => f && f.kind === k && f.id);
    if (srd.rules) {
      const R = Object.assign({}, srd.rules, { classes: {} });
      for (const k in srd.rules.classes) R.classes[k] = Object.assign({}, srd.rules.classes[k], { subs: srd.rules.classes[k].subs.slice() });
      of('class').forEach((f) => {
        const C = Core.homebrewClass(f, srd.rules);
        if (C) R.classes['hb-' + f.id] = C;
      });
      of('subclass').forEach((f) => {
        const C = R.classes[f.cls];
        if (!C) return;
        const start = C.hb ? C.subStart : (C.subs[0] && C.subs[0].start) || 3;
        C.subs.push({ i: 'hb-' + f.id, n: String(f.name || 'Homebrew subclass').slice(0, 60), flavor: C.hb ? C.subFlavor : (C.subs[0] && C.subs[0].flavor) || 'Subclass', start, levels: Core.featureLevels(f.features, 'hb-' + f.id), d: String(f.desc || '').slice(0, 3000), hb: true });
      });
      Data.rules = R;
    }
    if (srd.features || S.hb.size) {
      const F = Object.assign({}, srd.features || {});
      [...of('class'), ...of('subclass')].forEach((f) => (Array.isArray(f.features) ? f.features : []).slice(0, 40).forEach((ft, k) => {
        F['hb-' + f.id + '-' + k] = { n: String((ft && ft.name) || 'Feature').slice(0, 60), lvl: Core.clamp(Number(ft && ft.lvl) || 1, 1, 20), d: String((ft && ft.desc) || '').slice(0, 3000) };
      }));
      Data.features = F;
    }
    for (const [name, k, conv] of [['spells', 'spell', Core.spellFromHomebrew], ['monsters', 'monster', Core.monsterFromHomebrew]]) {
      if (!srd[name]) continue;
      const list = srd[name].concat(of(k).map(conv));
      const idx = new Map();
      list.forEach((x) => idx.set(x.i, x));
      Data[name] = list;
      Data[name + 'ById'] = idx;
    }
  }
  on('homebrew', () => {
    mergeHomebrew();
    derivedCache = new WeakMap(); // before anything redraws with the new rules
    emit('data', 'homebrew');
  });

  /* ------------------------------------------------------- map images */
  const CHUNK = 190000;
  async function fetchMap(scene) {
    if (!scene || !scene.mapId) return null;
    const have = S.maps.get(scene.mapId);
    if (have && have.status !== 'error') return have;
    // carry the retry flag over, or the board's one automatic retry repeats forever
    const entry = { status: 'loading', url: null, progress: 0, retried: !!(have && have.retried) };
    S.maps.set(scene.mapId, entry);
    emit('maps');
    try {
      const n = scene.chunks || 0;
      const parts = new Array(n);
      let next = 0;
      let done = 0;
      const worker = async () => {
        while (next < n) {
          const i = next++;
          let d = null;
          for (let attempt = 0; attempt < 3 && !d; attempt++) {
            try {
              d = await S.backend.get('mapchunks/' + scene.mapId + '_' + i);
            } catch (e) {
              await sleep(500 * (attempt + 1));
            }
          }
          if (!d || typeof d.d !== 'string') throw new Error('missing map piece ' + i);
          parts[i] = d.d;
          done++;
          entry.progress = done / n;
          emit('maps');
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      const b64 = parts.join('');
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      entry.url = URL.createObjectURL(new Blob([bytes], { type: scene.mime || 'image/jpeg' }));
      entry.status = 'ready';
    } catch (e) {
      console.warn('map load failed', e);
      entry.status = 'error';
    }
    emit('maps');
    return entry;
  }

  function blobToBase64(blob) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result).replace(/^data:[^,]*,/, ''));
      fr.onerror = () => rej(fr.error);
      fr.readAsDataURL(blob);
    });
  }
  function canvasBlob(canvas, type, q) {
    return new Promise((res) => canvas.toBlob((b) => res(b), type, q));
  }
  async function loadImage(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = 'async';
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = () => rej(new Error('That file isn’t an image this browser can open.'));
        img.src = url;
      });
      return img;
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
  // Shrink to fit the table's storage: ≤ 3000 px on the long side, ≤ 2.6 MB
  async function prepareMapImage(file) {
    const img = await loadImage(file);
    const w0 = img.naturalWidth;
    const h0 = img.naturalHeight;
    if (!w0 || !h0) throw new Error('That image has no size.');
    const LIMIT = 2.6 * 1024 * 1024;
    if (file.type === 'image/jpeg' && file.size <= LIMIT && Math.max(w0, h0) <= 3000) return { blob: file, w: w0, h: h0, mime: 'image/jpeg' };
    const tries = [[3000, 0.86], [3000, 0.74], [2400, 0.78], [2000, 0.72], [1600, 0.7]];
    for (const [maxSide, q] of tries) {
      const s = Math.min(1, maxSide / Math.max(w0, h0));
      const w = Math.round(w0 * s);
      const h = Math.round(h0 * s);
      const cv = document.createElement('canvas');
      cv.width = w;
      cv.height = h;
      const cx = cv.getContext('2d');
      cx.fillStyle = '#1b1a17';
      cx.fillRect(0, 0, w, h);
      cx.drawImage(img, 0, 0, w, h);
      const blob = await canvasBlob(cv, 'image/jpeg', q);
      if (blob && blob.size <= LIMIT) return { blob, w, h, mime: 'image/jpeg' };
    }
    throw new Error('That map is too large even after shrinking it. Try a smaller file.');
  }
  function guessGrid(name, w, h) {
    const m = /(\d{1,3})\s*[x×]\s*(\d{1,3})/i.exec(name || '');
    if (m) {
      const a = parseInt(m[1], 10);
      const b = parseInt(m[2], 10);
      // pick the pairing that makes square cells
      const s1 = w / a;
      const s2 = w / b;
      const sq1 = Math.abs(s1 - h / b);
      const sq2 = Math.abs(s2 - h / a);
      const size = sq1 <= sq2 ? s1 : s2;
      if (size >= 12 && size <= 400) return Math.round(size * 100) / 100;
    }
    if (w / 70 >= 8 && w / 70 <= 60) return 70;
    return Math.max(20, Math.round(w / 25));
  }
  async function storeMapImage(prepared, onProgress) {
    const b64 = await blobToBase64(prepared.blob);
    const mapId = uid('m');
    const n = Math.ceil(b64.length / CHUNK);
    for (let i = 0; i < n; i++) {
      const ok = await W.set('mapchunks/' + mapId + '_' + i, { m: mapId, i, n, d: b64.slice(i * CHUNK, (i + 1) * CHUNK) });
      if (!ok) throw new Error('The map didn’t finish saving.');
      if (onProgress) onProgress((i + 1) / n);
    }
    S.maps.set(mapId, { status: 'ready', url: URL.createObjectURL(prepared.blob), progress: 1 });
    return { mapId, chunks: n };
  }

  /* --------------------------------------------------------- actions */
  const VIRTUAL_SCENE = { id: 'main', name: 'Blank grid', cols: 30, rows: 20, grid: { size: 70, ox: 0, oy: 0, show: true, color: '#e9e2cf', alpha: 0.16 }, virtual: true };
  function activeScene() {
    const id = S.game.scene;
    if (id && S.scenes.has(id)) return S.scenes.get(id);
    if (S.scenes.size) {
      return [...S.scenes.values()].sort((a, b) => (a.created || 0) - (b.created || 0))[0];
    }
    return VIRTUAL_SCENE;
  }
  async function ensureScene() {
    const sc = activeScene();
    if (sc.virtual) {
      const doc = Object.assign({}, VIRTUAL_SCENE, { created: Date.now() });
      delete doc.virtual;
      delete doc.id;
      await W.set('scenes/main', doc);
      if (S.game.scene !== 'main') await setGame({ scene: 'main' });
      return 'main';
    }
    if (!S.game.scene) setGame({ scene: sc.id });
    return sc.id;
  }
  function setGame(patch) {
    S.game = Object.assign({}, S.game, patch);
    emit('game');
    return W.upd('game/state', patch);
  }
  const Act = {
    ensureScene,
    setGame,
    async uploadMap(file, onProgress) {
      const prepared = await prepareMapImage(file);
      const { mapId, chunks } = await storeMapImage(prepared, onProgress);
      const id = uid('s');
      const name = (file.name || 'Map').replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim().slice(0, 60) || 'Map';
      const size = guessGrid(file.name, prepared.w, prepared.h);
      await W.set('scenes/' + id, { name, mapId, chunks, mime: prepared.mime, w: prepared.w, h: prepared.h, grid: { size, ox: 0, oy: 0, show: true, color: '#000000', alpha: 0.3 }, created: Date.now() });
      await setGame({ scene: id });
      return id;
    },
    async storeGeneratedMap(blob, w, h, name, gridSize) {
      const { mapId, chunks } = await storeMapImage({ blob, w, h, mime: 'image/jpeg' });
      const id = uid('s');
      await W.set('scenes/' + id, { name, mapId, chunks, mime: 'image/jpeg', w, h, grid: { size: gridSize, ox: 0, oy: 0, show: true, color: '#000000', alpha: 0.22 }, created: Date.now() });
      await setGame({ scene: id });
      return id;
    },
    async newBlankScene(cols, rows, name) {
      const id = uid('s');
      await W.set('scenes/' + id, { name: name || 'Blank grid', cols, rows, grid: { size: 70, ox: 0, oy: 0, show: true, color: '#e9e2cf', alpha: 0.16 }, created: Date.now() });
      await setGame({ scene: id });
      return id;
    },
    patchScene(id, patch) {
      if (id === 'main' && !S.scenes.has('main')) {
        const doc = deepMerge(Object.assign({}, VIRTUAL_SCENE, { created: Date.now() }), patch);
        delete doc.virtual;
        delete doc.id;
        return W.set('scenes/main', doc);
      }
      return W.upd('scenes/' + id, patch);
    },
    async deleteScene(id) {
      const sc = S.scenes.get(id);
      if (!sc) return;
      for (const t of S.tokens.values()) if (t.scene === id) Act.removeToken(t.id); // also drops their initiative entries
      for (const t of S.tpls.values()) if (t.scene === id) W.del('templates/' + t.id);
      if (sc.mapId) for (let i = 0; i < (sc.chunks || 0); i++) W.del('mapchunks/' + sc.mapId + '_' + i);
      await W.del('scenes/' + id);
      if (S.game.scene === id) {
        const rest = [...S.scenes.values()].filter((s) => s.id !== id);
        setGame({ scene: rest.length ? rest[0].id : null });
      }
    },
    addToken(doc) {
      const id = doc.id || uid('t');
      const d = Object.assign({}, doc);
      delete d.id;
      W.set('tokens/' + id, d);
      return id;
    },
    patchToken: (id, patch) => W.upd('tokens/' + id, patch),
    removeToken(id) {
      W.del('tokens/' + id);
      for (const e of S.init.values()) if (e.tok === id) W.del('init/' + e.id);
    },
    addTemplate(doc) {
      const id = uid('a');
      W.set('templates/' + id, doc);
      return id;
    },
    patchTemplate: (id, patch) => W.upd('templates/' + id, patch),
    removeTemplate: (id) => W.del('templates/' + id),
    saveChar(id, doc) {
      const cid = id || uid('c');
      W.set('chars/' + cid, Object.assign({}, doc, { updated: Date.now() }));
      return cid;
    },
    patchChar: (id, patch) => W.upd('chars/' + id, patch),
    deleteChar(id) {
      W.del('chars/' + id);
      for (const t of S.tokens.values()) if (t.char === id) Act.removeToken(t.id);
      if (S.myChar === id) Store.setMyChar(null);
    },
    log(entry) {
      const id = uid('l');
      const doc = Object.assign({ ts: Date.now(), by: S.me.pk, col: S.me.color }, entry);
      // show it right away; the store echo replaces it
      W.set('log/' + id, doc);
      return id;
    },
    initSet(id, doc) {
      const iid = id || uid('i');
      W.set('init/' + iid, doc);
      return iid;
    },
    initPatch: (id, patch) => W.upd('init/' + id, patch),
    initRemove: (id) => W.del('init/' + id),
    saveEncounter(id, doc) {
      const eid = id || uid('e');
      W.set('encounters/' + eid, Object.assign({}, doc, { updated: Date.now() }));
      return eid;
    },
    deleteEncounter: (id) => W.del('encounters/' + id),
    saveHomebrew(id, doc) {
      const hid = id || uid('h');
      W.set('homebrew/' + hid, Object.assign({}, doc, { updated: Date.now() }));
      return hid;
    },
    deleteHomebrew: (id) => W.del('homebrew/' + id),
    partyAdd(doc) {
      const id = uid('i');
      W.set('party/' + id, Object.assign({ ts: Date.now() }, doc));
      return id;
    },
    partyPatch: (id, patch) => W.upd('party/' + id, patch),
    partyDel: (id) => W.del('party/' + id),
    async clearLog() {
      for (const e of S.log) W.del('log/' + e.id);
    },
    async pruneLog() {
      // keep the log from growing without bound: drop entries older than 10 days
      if (S.mode !== 'remote' || !S.dm || !Store.db) return;
      try {
        const cutoff = Date.now() - 10 * 864e5;
        const snap = await S.backend.col('log').where('ts', '<', cutoff).limit(100).get();
        snap.docs.forEach((d) => W.del('log/' + d.id));
      } catch (e) { /* not important */ }
    },
    // Pings ride on presence so every viewer can send them, edit access or not
    ping(x, y) {
      const pg = { x: Math.round(x), y: Math.round(y), t: Date.now(), sc: activeScene().id };
      emit('ping', { x: pg.x, y: pg.y, col: S.me.color, sc: pg.sc, mine: true });
      if (S.room) pushPresence({ pg });
    },
  };

  /* ------------------------------------------------------------- boot */
  async function boot(opts) {
    toastFn = opts.toast || toastFn;
    S.camp = pickCampaign();
    const cl = window.claude && typeof window.claude.use === 'function' ? window.claude : null;
    let db = null;
    let room = null;
    let user = null;
    if (cl && !opts.forceLocal) {
      [db, room, user] = await Promise.all([
        cl.use('db').catch(() => null),
        cl.use('room').catch(() => null),
        cl.use('user').catch(() => null),
      ]);
    }
    S.user = user;
    Store.db = db;
    let me = null;
    try {
      me = user ? await user.me() : null;
    } catch (e) { /* none */ }
    // outside claude.ai: is this page served by a Tavern Table server (tools/server.js)?
    const found = !cl && !opts.forceLocal ? await findServer() : null;
    if (found && found.refused) toastWarn('No password, so this is solo mode on this device only. Reload to try again.');
    if (found && !found.refused) {
      // a campaign that no longer exists on this server: back to the main one
      try {
        const r = await fetch('api/campaigns?key=' + encodeURIComponent(found.key)).then((x) => x.json());
        if (S.camp !== 'main' && !(r.campaigns || []).some((c) => c.id === S.camp)) S.camp = 'main';
      } catch (e) { /* keep the choice */ }
      const conn = serverConn(found.key, S.camp);
      conn.accounts = !!found.accounts;
      S.conn = conn;
      await Promise.race([conn.firstHello, sleep(6000)]);
      conn.onState = (live) => {
        S.offline = !live;
        emit('me');
      };
      S.mode = 'remote';
      S.server = true;
      S.backend = serverBackend(conn);
      S.room = serverRoom(conn);
      // the computer running the server is the table's owner (DM by default)
      me = { id: null, isOwner: conn.owner, canEdit: true, name: '' };
      if (found.accounts) {
        // accounts mode: the server knows who this is, what they may do, and who owns the table
        S.accountsMode = true;
        S.authUser = found.user;
        me = { id: found.user.id, isOwner: !!found.user.admin, canEdit: true, name: found.user.name };
      }
    } else if (!cl && !opts.forceLocal && joinCodeFromUrl()) {
      // a friend opened a join link: play at the host's table
      const code = joinCodeFromUrl();
      S.p2p = { role: 'guest', code, trouble: null };
      let conn = null;
      try {
        conn = await peerGuestConn(code, (t) => {
          S.p2p.trouble = t;
          emit('me');
        });
      } catch (e) {
        toastWarn('Online play couldn’t start in this browser. Try another browser, or reload.');
      }
      if (conn) {
        S.mode = 'remote';
        S.backend = serverBackend(conn);
        S.room = serverRoom(conn);
        conn.onState = (live) => {
          S.offline = !live;
          emit('me');
        };
        await Promise.race([conn.firstHello, sleep(12000)]);
        S.offline = !conn.live;
        me = { id: null, isOwner: false, canEdit: true, name: '' };
      } else {
        S.p2p = null;
        S.mode = 'local';
        S.backend = campBackend(S.camp);
        S.room = localRoom();
      }
    } else if (!cl && !opts.forceLocal && LS.get('tt.hosting', false)) {
      // this browser hosts the table online: its saved table is the one everyone plays on
      const hub = makeHub(campBackend(S.camp));
      const conn = loopbackConn(hub);
      S.mode = 'remote';
      S.backend = serverBackend(conn);
      S.room = serverRoom(conn);
      let code = LS.get('tt.room' + campSuffix(S.camp), null);
      if (!code || !ROOM_RE.test(code)) {
        code = 'tt-' + uid('').toLowerCase();
        LS.set('tt.room' + campSuffix(S.camp), code);
      }
      S.p2p = { role: 'host', code, status: 'starting' };
      peerHost(hub, code, (st) => {
        S.p2p.status = st;
        emit('me');
      }).catch(() => {
        S.p2p.status = 'unsupported';
        emit('me');
      });
      await conn.firstHello;
      me = { id: null, isOwner: true, canEdit: true, name: '' };
    } else if (db) {
      S.mode = 'remote';
      S.backend = remoteBackend(db, S.camp);
      S.room = room;
    } else {
      S.mode = 'local';
      S.backend = campBackend(S.camp);
      S.room = localRoom();
    }
    let pk = me && me.id;
    if (!pk) {
      pk = LS.get('tt.pk', null);
      if (!pk) {
        pk = uid('p');
        LS.set('tt.pk', pk);
      }
    }
    // signed in: the account id is who this person is, on every device
    const acct = S.accountsMode ? pk : LS.get('tt.acct', null);
    if (typeof acct === 'string' && /^[A-Za-z0-9_.:@+-]{1,80}$/.test(acct)) pk = acct;
    S.me = {
      acct: typeof acct === 'string' ? acct : null,
      pk,
      uid: (me && me.id) || null,
      isOwner: !!(me && me.isOwner),
      canEdit: !!(me && me.canEdit),
      profileName: (me && me.name) || '',
      color: LS.get('tt.color', null) || colorFor(pk),
      nick: LS.get('tt.nick', null) || (me && me.name) || '',
    };
    const role = LS.get('tt.role', null);
    S.dm = role ? role === 'dm' : S.me.isOwner || S.mode === 'local';
    S.myChar = LS.get('tt.char', null);
    if (S.accountsMode) {
      // nothing from whoever used this device before: the account decides (its profile follows once loaded)
      S.me.nick = S.authUser.name;
      S.me.color = colorFor(pk);
      S.dm = !!S.authUser.dm;
      S.myChar = null;
    }
    if (S.server || S.p2p) S.canWrite = true; // everyone at a self-hosted or online table can play
    else if (S.mode === 'remote') {
      let cw = null;
      try {
        cw = user ? await user.can('data.write') : null;
      } catch (e) { /* unknown */ }
      S.canWrite = cw === true || S.me.isOwner ? true : cw === false ? false : null;
      if (S.canWrite === false) S.relay = true;
    } else S.canWrite = true;
    subscribeAll();
    wireRoom();
    emit('me');
    if (S.dm) setTimeout(() => Act.pruneLog(), 8000);
    if (S.mode === 'remote' && Store.db && S.camp !== 'main' && !S.server && !S.p2p) setTimeout(migrateCampaignHomebrew, 3000);
  }

  async function migrateCampaignHomebrew() {
    if (S.canWrite !== true) return;
    try {
      const snap = await Store.db.collection('camp/' + S.camp + '/homebrew').get();
      for (const d of snap.docs) {
        if (d.exists === false) continue;
        if (!S.hb.has(d.id)) await Store.db.doc('homebrew/' + d.id).set(d.data());
        await Store.db.doc('camp/' + S.camp + '/homebrew/' + d.id).delete();
      }
    } catch (e) { /* try again next time */ }
  }

  /* ------------------------------------------------------- accounts */
  // SHA-256 in plain JS: crypto.subtle is missing on plain-http LAN servers (our own server during filtering)
  function sha256(str) {
    const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    const bytes = new TextEncoder().encode(str);
    const len = bytes.length;
    const words = new Uint32Array(((len + 9 + 63) >> 6) << 4);
    for (let i = 0; i < len; i++) words[i >> 2] |= bytes[i] << (24 - (i % 4) * 8);
    words[len >> 2] |= 0x80 << (24 - (len % 4) * 8);
    words[words.length - 1] = len * 8;
    const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const w = new Uint32Array(64);
    const rot = (x, n) => (x >>> n) | (x << (32 - n));
    for (let o = 0; o < words.length; o += 16) {
      for (let i = 0; i < 16; i++) w[i] = words[o + i];
      for (let i = 16; i < 64; i++) w[i] = (w[i - 16] + (rot(w[i - 15], 7) ^ rot(w[i - 15], 18) ^ (w[i - 15] >>> 3)) + w[i - 7] + (rot(w[i - 2], 17) ^ rot(w[i - 2], 19) ^ (w[i - 2] >>> 10))) | 0;
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
        const t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    return H.map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
  }
  // salted, stretched hash of a PIN (the PIN itself is never stored)
  function hashPin(pin, salt) {
    let h = salt + ':' + pin;
    for (let i = 0; i < 2000; i++) h = sha256(h + salt);
    return h;
  }
  const PIN_RE = /^\d{4,6}$/;
  async function createAccount(name, pin) {
    name = String(name || '').trim().slice(0, 40);
    if (!name) throw new Error('Pick a name.');
    if (!PIN_RE.test(String(pin))) throw new Error('The PIN must be 4 to 6 digits.');
    if ([...S.accounts.values()].some((a) => String(a.name).toLowerCase() === name.toLowerCase())) throw new Error('That name is taken. Sign in instead, or pick another name.');
    // the first account on this device takes over its heroes: it gets the id they already belong to
    const id = !S.accounts.has(S.me.pk) && !S.me.acct ? S.me.pk : uid('u');
    const salt = uid('s');
    const ok = await W.set('accounts/' + id, { name, salt, hash: hashPin(pin, salt), color: S.me.color, dm: S.dm ? 1 : 0, playing: S.myChar ? { [S.camp]: S.myChar } : {}, created: Date.now() });
    if (ok === false) throw new Error('The account couldn’t be saved. Check your connection.');
    LS.set('tt.acct', id);
    LS.set('tt.nick', name);
    return id;
  }
  function signIn(id, pin) {
    const a = S.accounts.get(id);
    if (!a || a.hash !== hashPin(String(pin), a.salt)) return false;
    LS.set('tt.acct', id);
    // the account's own settings win over whatever this device had
    LS.set('tt.nick', a.name || '');
    if (a.color) LS.set('tt.color', a.color);
    LS.set('tt.role', a.dm ? 'dm' : 'player');
    LS.set('tt.char', (a.playing && a.playing[S.camp]) || null);
    return true;
  }
  function signOut() {
    if (S.accountsMode && S.conn) {
      ['tt.nick', 'tt.char', 'tt.role', 'tt.color'].forEach((k) => LS.set(k, null));
      return S.conn.post('api/logout', {}).catch(() => {});
    }
    LS.set('tt.acct', null);
    LS.set('tt.pk', uid('p')); // signed out: not the owner of anyone's heroes
    ['tt.nick', 'tt.char', 'tt.role'].forEach((k) => LS.set(k, null));
  }
  function resetPin(id, pin) {
    if (!PIN_RE.test(String(pin))) return Promise.reject(new Error('The PIN must be 4 to 6 digits.'));
    const salt = uid('s');
    return W.upd('accounts/' + id, { salt, hash: hashPin(String(pin), salt) });
  }
  // accounts mode: the table owner resets passwords and decides who is a DM (the server checks)
  function adminResetPassword(id, password) {
    if (String(password || '').length < 8) return Promise.reject(new Error('The password needs at least 8 characters.'));
    return S.conn.post('api/admin/reset-password', { userId: id, password: String(password) }).catch((e) => {
      throw new Error(e.message || 'That didn’t work.');
    });
  }
  function adminSetDm(id, dm) {
    return S.conn.post('api/admin/set-dm', { userId: id, dm: !!dm }).catch((e) => {
      throw new Error(e.message || 'That didn’t work.');
    });
  }
  function saveToAccount(patch) {
    if (!S.me.acct || !S.accounts.has(S.me.acct) || S.readOnly) return;
    const clean = {};
    for (const k in patch) if (patch[k] !== undefined) clean[k] = patch[k];
    if (Object.keys(clean).length) W.upd('accounts/' + S.me.acct, clean);
  }
  // after loading (and whenever the account changes elsewhere): this device follows the account
  function applyAccount() {
    const a = S.me.acct && S.accounts.get(S.me.acct);
    if (!a) return;
    let changed = false;
    if (a.name && a.name !== S.me.nick) {
      S.me.nick = a.name;
      LS.set('tt.nick', a.name);
      changed = true;
    }
    if (a.color && a.color !== S.me.color) {
      S.me.color = a.color;
      LS.set('tt.color', a.color);
      changed = true;
    }
    if (a.dm != null && !!a.dm !== S.dm) {
      S.dm = !!a.dm;
      LS.set('tt.role', S.dm ? 'dm' : 'player');
      changed = true;
    }
    const pl = a.playing && a.playing[S.camp];
    if (pl && pl !== S.myChar && S.chars.has(pl)) {
      S.myChar = pl;
      LS.set('tt.char', pl);
      changed = true;
    }
    if (changed) {
      basePresence();
      emit('me');
    }
  }
  on('accounts', applyAccount);
  on('loaded', applyAccount);

  /* ------------------------------------------------- backup / restore */
  // One file with the whole table: every campaign's documents (map pieces too) plus accounts and homebrew.
  const CAMP_COLS = ['game', 'scenes', 'tokens', 'templates', 'chars', 'init', 'encounters', 'log', 'party', 'mapchunks'];
  function idbAll(name, write) {
    return new Promise((res) => {
      let rq;
      try {
        rq = indexedDB.open(name, 1);
      } catch (e) {
        return res({});
      }
      rq.onupgradeneeded = () => rq.result.createObjectStore('chunks');
      rq.onerror = () => res({});
      rq.onsuccess = () => {
        const db = rq.result;
        const tx = db.transaction('chunks', write ? 'readwrite' : 'readonly');
        const st = tx.objectStore('chunks');
        const out = {};
        if (write) {
          Object.keys(write).forEach((k) => st.put(write[k], k));
          tx.oncomplete = () => res(true);
          tx.onerror = () => res(false);
          return;
        }
        const keys = st.getAllKeys();
        const vals = st.getAll();
        tx.oncomplete = () => {
          (keys.result || []).forEach((k, i) => (out[k] = vals.result[i]));
          res(out);
        };
        tx.onerror = () => res({});
      };
    });
  }
  async function campaignList() {
    try {
      return (await Store.campaigns()).map((c) => ({ id: c.id, name: c.name }));
    } catch (e) {
      return [{ id: 'main', name: 'Main campaign' }];
    }
  }
  async function backup() {
    if (S.p2p && S.p2p.role === 'guest') throw new Error('Only the person hosting the table can back it up.');
    const out = { type: 'tavern-table-backup', v: 1, created: Date.now(), campaigns: await campaignList(), tables: {} };
    if (S.server && S.conn) {
      const r = await S.conn.getJson('api/backup');
      out.campaigns = r.campaigns || out.campaigns;
      out.tables = r.tables || {};
      return out;
    }
    if (S.mode === 'remote' && Store.db && !S.p2p) {
      const read = async (col) => (await Store.db.collection(col).get()).docs.filter((d) => d.exists !== false).map((d) => [d.id, d.data()]);
      for (const c of out.campaigns) {
        const t = (out.tables[c.id] = {});
        const pre = c.id === 'main' ? '' : 'camp/' + c.id + '/';
        for (const col of CAMP_COLS) (await read(pre + col)).forEach(([id, d]) => (t[col + '/' + id] = d));
      }
      const t = (out.tables.main = out.tables.main || {});
      for (const col of GLOBAL_COLS.concat(['campaigns'])) (await read(col)).forEach(([id, d]) => (t[col + '/' + id] = d));
      return out;
    }
    // this device's storage (solo, or hosting from the GitHub link)
    for (const c of out.campaigns) {
      const sfx = campSuffix(c.id);
      out.tables[c.id] = Object.assign({}, LS.get('tt.local.v1' + sfx, {}) || {}, await idbAll('tt.local.maps' + sfx));
    }
    return out;
  }
  async function restore(b) {
    if (!b || b.type !== 'tavern-table-backup' || !b.tables || typeof b.tables !== 'object') throw new Error('That file isn’t a Tavern Table backup.');
    if (S.p2p && S.p2p.role === 'guest') throw new Error('Only the person hosting the table can restore it.');
    const camps = (Array.isArray(b.campaigns) ? b.campaigns : []).filter((c) => c && CAMP_RE.test(c.id));
    const okPath = (p) => /^[a-z]{1,20}\/[A-Za-z0-9_~:@+-][A-Za-z0-9_.~:@+-]{0,119}$/.test(p);
    if (S.server && S.conn) return S.conn.post('api/restore', { campaigns: camps, tables: b.tables });
    if (S.mode === 'remote' && Store.db && !S.p2p) {
      for (const cid of Object.keys(b.tables)) {
        if (!CAMP_RE.test(cid)) continue;
        const pre = cid === 'main' ? '' : 'camp/' + cid + '/';
        const docs = Object.entries(b.tables[cid] || {}).filter(([p, d]) => okPath(p) && isObj(d));
        for (let i = 0; i < docs.length; i += 20) await Promise.all(docs.slice(i, i + 20).map(([p, d]) => Store.db.doc((isGlobalPath(p) || p.startsWith('campaigns/') ? '' : pre) + p).set(d)));
      }
      for (const c of camps) if (c.id !== 'main') await Store.db.doc('campaigns/' + c.id).set({ name: String(c.name || 'Campaign').slice(0, 60), created: Date.now() });
      return true;
    }
    const reg = LS.get('tt.campaigns', []) || [];
    camps.forEach((c) => c.id !== 'main' && !reg.some((x) => x.id === c.id) && reg.push({ id: c.id, name: String(c.name || 'Campaign').slice(0, 60), created: Date.now() }));
    LS.set('tt.campaigns', reg);
    for (const cid of Object.keys(b.tables)) {
      if (!CAMP_RE.test(cid)) continue;
      const sfx = campSuffix(cid);
      const docs = Object.entries(b.tables[cid] || {}).filter(([p, d]) => okPath(p) && isObj(d));
      // global things (accounts, homebrew, pictures) always go with the main campaign
      const main = LS.get('tt.local.v1', {}) || {};
      const here = cid === 'main' ? main : LS.get('tt.local.v1' + sfx, {}) || {};
      const chunks = {};
      docs.forEach(([p, d]) => {
        if (p.startsWith('mapchunks/')) chunks[p] = d;
        else if (isGlobalPath(p)) main[p] = d;
        else here[p] = d;
      });
      try {
        localStorage.setItem('tt.local.v1', JSON.stringify(main));
        if (cid !== 'main') localStorage.setItem('tt.local.v1' + sfx, JSON.stringify(here));
      } catch (e) {
        throw new Error('This browser’s storage is full; the backup couldn’t be restored.');
      }
      if (Object.keys(chunks).length) await idbAll('tt.local.maps' + sfx, chunks);
    }
    return true;
  }

  /* --------------------------------------------- derived hero stats */
  // cached per hero object; a change to any homebrew feat starts a new cache
  let derivedCache = new WeakMap();
  function featsFor(ch) {
    if (!ch) return [];
    const out = [];
    const seen = new Set();
    const add = (f) => {
      if (f && !seen.has(f.id)) {
        seen.add(f.id);
        out.push(f);
      }
    };
    (Array.isArray(ch.feats) ? ch.feats : []).forEach((id) => {
      const f = S.hb.get(id);
      if (f && (f.kind || 'feat') === 'feat') add(f);
    });
    // a magic item counts while it's equipped, and attuned if it needs attunement
    (Array.isArray(ch.inv) ? ch.inv : []).forEach((it) => {
      const f = it && it.hb && S.hb.get(it.hb);
      if (f && f.kind === 'item' && it.eq && (!f.attune || it.at)) add(f);
    });
    const level = Core.clamp(parseInt(ch.level, 10) || 1, 1, 20);
    const fromSource = (f, kind) => {
      if (!f || f.kind !== kind) return;
      (Array.isArray(f.features) ? f.features : []).slice(0, 40).forEach((ft, k) => {
        // a feature counts when it does something: effects, or a way to use it (action, cost, roll)
        if (ft && Core.clamp(Number(ft.lvl) || 1, 1, 20) <= level && ((Array.isArray(ft.effects) && ft.effects.length) || ft.act)) {
          add({ id: f.id + 'f' + k, kind: 'feature', name: ft.name || 'Feature', desc: ft.desc || '', act: ft.act, costRes: ft.costRes, costN: ft.costN, roll: ft.roll, note: ft.note, effects: Array.isArray(ft.effects) ? ft.effects : [] });
        }
      });
    };
    if (/^hb-/.test(ch.cls || '')) fromSource(S.hb.get(ch.cls.slice(3)), 'class');
    if (/^hb-/.test(ch.subclass || '')) fromSource(S.hb.get(ch.subclass.slice(3)), 'subclass');
    return out;
  }
  function derived(ch) {
    if (!ch || !Data.rules) return null;
    let d = derivedCache.get(ch);
    if (!d) {
      try {
        d = Core.derive(ch, Data.rules, featsFor(ch));
      } catch (e) {
        console.error('derive', e);
        return null;
      }
      derivedCache.set(ch, d);
    }
    return d;
  }
  function heroHp(ch) {
    const d = derived(ch);
    if (!d) return { hp: null, max: null, tmp: 0 };
    const hp = ch.hp == null ? d.hpMax : Math.min(ch.hp, d.hpMax);
    return { hp, max: d.hpMax, tmp: ch.tmp || 0 };
  }

  return {
    S, on, emit, uid, LS, W, Act, Data, loadData, fetchMap, activeScene, boot, clone, deepMerge, colorFor, PALETTE,
    derived, heroHp, featsFor,
    pushPresence,
    presence: () => myPresence,
    relayPending: () => relay.ops.length,
    setNick(n) {
      S.me.nick = n;
      LS.set('tt.nick', n);
      saveToAccount({ name: n.slice(0, 40) || undefined });
      pushPresence({ nm: n.slice(0, 40) });
      emit('me');
    },
    setColor(c) {
      S.me.color = c;
      LS.set('tt.color', c);
      saveToAccount({ color: c });
      pushPresence({ col: c });
      emit('me');
    },
    // campaigns: kept on this device (solo / hosting), on the self-hosted server, or in the shared claude.ai db
    async campaigns() {
      let list = [];
      try {
        if (S.p2p && S.p2p.role === 'guest') list = [];
        else if (S.server && S.conn) list = (await S.conn.getJson('api/campaigns')).campaigns || [];
        else if (S.mode === 'remote' && Store.db) {
          const snap = await Store.db.collection('campaigns').get();
          list = snap.docs.filter((d) => d.exists !== false).map((d) => Object.assign({ id: d.id }, d.data()));
        } else list = LS.get('tt.campaigns', []);
      } catch (e) {
        list = [];
      }
      list = (Array.isArray(list) ? list : []).filter((c) => c && CAMP_RE.test(c.id)).map((c) => ({ id: c.id, name: String(c.name || 'Untitled campaign').slice(0, 60), created: c.created || 0 }));
      if (!list.some((c) => c.id === 'main')) list.unshift({ id: 'main', name: 'Main campaign', created: 0 });
      const cur = list.find((c) => c.id === S.camp);
      if (cur) S.campName = cur.name;
      return list;
    },
    async createCampaign(name) {
      name = String(name || '').trim().slice(0, 60);
      if (!name) return null;
      if (S.server && S.conn) return (await S.conn.post('api/campaigns', { name })).id;
      const id = 'c' + uid('').slice(-10).toLowerCase();
      if (S.mode === 'remote' && Store.db) {
        await Store.db.doc('campaigns/' + id).set({ name, created: Date.now() });
        return id;
      }
      const list = LS.get('tt.campaigns', []);
      list.push({ id, name, created: Date.now() });
      LS.set('tt.campaigns', list);
      return id;
    },
    async renameCampaign(id, name) {
      name = String(name || '').trim().slice(0, 60);
      if (!name) return;
      if (S.server && S.conn) await S.conn.post('api/campaigns', { id, name });
      else if (S.mode === 'remote' && Store.db) await Store.db.doc('campaigns/' + id).set({ name, created: Date.now() });
      else {
        const list = LS.get('tt.campaigns', []).filter((c) => c.id !== id);
        list.push({ id, name, created: Date.now() });
        LS.set('tt.campaigns', list);
      }
      if (id === S.camp) {
        S.campName = name;
        if (S.canWrite) setGame({ cname: name }); // so everyone at the table sees it
        emit('me');
      }
    },
    switchCampaign(id) {
      if (!CAMP_RE.test(id)) return;
      LS.set('tt.campaign', id);
      const u = new URL(location.href);
      u.searchParams.delete('c');
      u.hash = '';
      location.href = u.toString();
      setTimeout(() => location.reload(), 50);
    },
    campaignName: () => S.game.cname || S.campName || (S.camp === 'main' ? 'Main campaign' : 'Campaign'),
    // online play (GitHub Pages and other plain hosting): start or stop hosting this table
    startHosting() {
      LS.set('tt.hosting', true);
      location.reload();
    },
    stopHosting() {
      LS.set('tt.hosting', false);
      location.reload();
    },
    // accounts
    createAccount, signIn, signOut, resetPin, adminResetPassword, adminSetDm, accountName: (id) => ((S.accounts.get(id) || {}).name || ''),
    monImg: (id) => {
      const a = id && S.art.get(id);
      if (a && a.img) return a.img;
      const m = id && Data.monstersById && Data.monstersById.get(id);
      return (m && m.img) || null;
    },
    backup, restore,
    leaveOnline() {
      location.hash = '';
      location.reload();
    },
    // keeps ?broker=… so friends use the same lobby as the host
    inviteLink: () => (S.p2p ? location.origin + location.pathname + location.search + '#join=' + S.p2p.code : ''),
    setRole(dm) {
      if (S.accountsMode) return; // the table owner decides who is a DM
      S.dm = !!dm;
      LS.set('tt.role', dm ? 'dm' : 'player');
      saveToAccount({ dm: dm ? 1 : 0 });
      pushPresence({ dm: dm ? 1 : 0 });
      emit('me');
    },
    setMyChar(id) {
      S.myChar = id;
      LS.set('tt.char', id);
      saveToAccount({ playing: { [S.camp]: id || '' } });
      pushPresence({ ch: id });
      emit('me');
    },
    db: null,
  };
})();
