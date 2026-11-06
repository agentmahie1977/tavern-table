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

  /* -------------------------------------------- local stand-in backend */
  function localBackend() {
    const KEY = 'tt.local.v1';
    const docs = new Map();
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) Object.entries(JSON.parse(raw)).forEach(([p, d]) => docs.set(p, Object.freeze(d)));
    } catch (e) { /* ignore */ }
    const watchers = new Set();
    let bc = null;
    try {
      bc = new BroadcastChannel('tt.local.db');
    } catch (e) { /* no channel */ }
    let saveT = 0;
    function persist() {
      clearTimeout(saveT);
      saveT = setTimeout(() => {
        try {
          const o = {};
          docs.forEach((d, p) => {
            if (!p.startsWith('mapchunks/')) o[p] = d;
          });
          localStorage.setItem(KEY, JSON.stringify(o));
        } catch (e) { /* quota */ }
      }, 250);
    }
    // Map pieces are too big for localStorage, so they live in IndexedDB (best effort)
    const idb = (() => {
      let dbp = null;
      const open = () => dbp || (dbp = new Promise((res, rej) => {
        const rq = indexedDB.open('tt.local.maps', 1);
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
    const colOf = (p) => p.slice(0, p.lastIndexOf('/'));
    function notify(path) {
      const col = colOf(path);
      watchers.forEach((w) => {
        if ((w.type === 'doc' && w.path === path) || (w.type === 'col' && w.path === col)) w.fire();
      });
    }
    function put(path, data) {
      if (data === null) docs.delete(path);
      else docs.set(path, Object.freeze(clone(data)));
      if (!path.startsWith('mapchunks/')) persist();
      else if (data === null) idb.del(path);
      else idb.put(path, docs.get(path));
      notify(path);
    }
    if (bc) bc.onmessage = (ev) => {
      const m = ev.data;
      if (!m || m.t !== 'w') return;
      if (m.d === null) docs.delete(m.p);
      else docs.set(m.p, Object.freeze(m.d));
      notify(m.p);
    };
    function write(path, data) {
      put(path, data);
      try {
        if (bc) bc.postMessage({ t: 'w', p: path, d: data === null ? null : docs.get(path) });
      } catch (e) { /* ignore */ }
    }
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
    return {
      kind: 'local',
      watchCol(col, opts, cb) {
        return watcher('col', col, () => cb(list(col, opts), { fromCache: false }));
      },
      watchDoc(path, cb) {
        return watcher('doc', path, () => cb(docs.has(path) ? docs.get(path) : null, { fromCache: false }));
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

  /* ------------------------------------------------- db-backed backend */
  function remoteBackend(db) {
    const wrap = (snapDocs) => snapDocs.filter((d) => d.exists !== false).map((d) => ({ id: d.id, raw: d.data() }));
    return {
      kind: 'remote',
      watchCol(col, opts, cb, onErr) {
        let q = db.collection(col);
        if (opts && opts.orderBy) q = q.orderBy(opts.orderBy, opts.dir || 'asc');
        if (opts && opts.limit) q = q.limit(opts.limit);
        return q.onSnapshot((snap) => cb(wrap(snap.docs), snap.metadata || {}), (e) => onErr && onErr(e));
      },
      watchDoc(path, cb, onErr) {
        return db.doc(path).onSnapshot((snap) => cb(snap.exists ? snap.data() : null, snap.metadata || {}), (e) => onErr && onErr(e));
      },
      set: (path, data) => db.doc(path).set(data),
      upd: (path, patch) => db.doc(path).update(patch),
      del: (path) => db.doc(path).delete(),
      async get(path) {
        const s = await db.doc(path).get();
        return s.exists ? s.data() : null;
      },
    };
  }

  /* --------------------------------------------- local stand-in room */
  function localRoom() {
    let bc;
    try {
      bc = new BroadcastChannel('tt.local.room');
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
  const RELAY_PATH = /^(tokens|templates|log|init|chars|game)\/[A-Za-z0-9_.~:@+-]{1,80}$/;
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
    pushPresence({ pk: S.me.pk, nm: (S.me.nick || '').slice(0, 40), col: S.me.color, ch: S.myChar || null, dm: S.dm ? 1 : 0, w: S.canWrite === true ? 1 : 0, sc: S.game.scene || null });
  }

  /* ---------------------------------------------------- subscriptions */
  const loadedSet = new Set();
  const NEEDED = ['game', 'scenes', 'tokens', 'tpls', 'chars', 'init', 'encs', 'log'];
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
      S.peers = ch.peers || room.peers();
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
        if (name === 'monsters' || name === 'spells') {
          const idx = new Map();
          d.forEach((x) => idx.set(x.i, x));
          Data[name + 'ById'] = idx;
        }
        Data[name] = d;
        emit('data', name);
        return d;
      });
      DATA[name].catch(() => {
        delete DATA[name];
      });
    }
    return DATA[name];
  }
  const Data = { rules: null, spells: null, monsters: null, features: null, spellsById: null, monstersById: null };

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
    async clearLog() {
      for (const e of S.log) W.del('log/' + e.id);
    },
    async pruneLog() {
      // keep the log from growing without bound: drop entries older than 10 days
      if (S.mode !== 'remote' || !S.dm || !Store.db) return;
      try {
        const cutoff = Date.now() - 10 * 864e5;
        const snap = await Store.db.collection('log').where('ts', '<', cutoff).limit(100).get();
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
    if (db) {
      S.mode = 'remote';
      S.backend = remoteBackend(db);
      S.room = room;
    } else {
      S.mode = 'local';
      S.backend = localBackend();
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
    S.me = {
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
    if (S.mode === 'remote') {
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
  }

  /* --------------------------------------------- derived hero stats */
  const derivedCache = new WeakMap();
  function derived(ch) {
    if (!ch || !Data.rules) return null;
    let d = derivedCache.get(ch);
    if (!d) {
      try {
        d = Core.derive(ch, Data.rules);
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
    derived, heroHp,
    pushPresence,
    presence: () => myPresence,
    relayPending: () => relay.ops.length,
    setNick(n) {
      S.me.nick = n;
      LS.set('tt.nick', n);
      pushPresence({ nm: n.slice(0, 40) });
      emit('me');
    },
    setColor(c) {
      S.me.color = c;
      LS.set('tt.color', c);
      pushPresence({ col: c });
      emit('me');
    },
    setRole(dm) {
      S.dm = !!dm;
      LS.set('tt.role', dm ? 'dm' : 'player');
      pushPresence({ dm: dm ? 1 : 0 });
      emit('me');
    },
    setMyChar(id) {
      S.myChar = id;
      LS.set('tt.char', id);
      pushPresence({ ch: id });
      emit('me');
    },
    db: null,
  };
})();
