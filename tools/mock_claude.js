// Test-only stand-in for window.claude (db, room, user), shared across tabs of one browser context.
(() => {
  const q = new URLSearchParams(location.search);
  if (!q.get('mock')) return;
  const cfg = { uid: q.get('uid'), name: q.get('name') || '', owner: q.get('owner') === '1', role: q.get('role') || 'editor' };
  // keep each simulated person's browser storage apart
  const pre = 'u:' + cfg.uid + ':';
  const gi = Storage.prototype.getItem, si = Storage.prototype.setItem, ri = Storage.prototype.removeItem;
  Storage.prototype.getItem = function (k) { return gi.call(this, pre + k); };
  Storage.prototype.setItem = function (k, v) { return si.call(this, pre + k, v); };
  Storage.prototype.removeItem = function (k) { return ri.call(this, pre + k); };
  const me = 'pg' + Math.random().toString(36).slice(2, 10);
  const docs = new Map();
  const bc = new BroadcastChannel('mock.db');
  const watchers = new Set();
  const colOf = (p) => p.slice(0, p.lastIndexOf('/'));
  const tick = () => new Promise((r) => setTimeout(r, 15));
  const notify = (p) => watchers.forEach((w) => { if ((w.t === 'doc' && w.p === p) || (w.t === 'col' && w.p === colOf(p))) w.fire(); });
  bc.onmessage = (e) => {
    const m = e.data;
    if (m.t === 'w') { if (m.d === null) docs.delete(m.p); else docs.set(m.p, Object.freeze(m.d)); notify(m.p); }
    else if (m.t === 'hello') bc.postMessage({ t: 'dump', to: m.from, docs: [...docs] });
    else if (m.t === 'dump' && m.to === me) m.docs.forEach(([p, d]) => { if (!docs.has(p)) { docs.set(p, Object.freeze(d)); notify(p); } });
  };
  bc.postMessage({ t: 'hello', from: me });
  const canWrite = cfg.role !== 'viewer';
  const deny = () => Promise.reject({ code: 'invalid_argument', message: 'write not permitted for this viewer' });
  const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
  const merge = (a, b) => { const o = Object.assign({}, a); for (const k in b) o[k] = isObj(b[k]) && isObj(o[k]) ? merge(o[k], b[k]) : b[k]; return o; };
  const write = (p, d) => {
    if (d !== null && JSON.stringify(d).length > 262144) throw { code: 'invalid_argument', message: 'too large' };
    if (d === null) docs.delete(p); else docs.set(p, Object.freeze(JSON.parse(JSON.stringify(d))));
    notify(p);
    bc.postMessage({ t: 'w', p, d: d === null ? null : docs.get(p) });
  };
  const deb = (fn) => { let s = false; return () => { if (s) return; s = true; setTimeout(() => { s = false; fn(); }, 5); }; };
  const snap = (p) => { const has = docs.has(p); return { id: p.split('/').pop(), exists: has, data: () => (has ? docs.get(p) : undefined), metadata: { fromCache: false, hasPendingWrites: false } }; };
  function docRef(p) {
    if (p.split('/').length % 2) throw new TypeError('doc path needs an even number of segments: ' + p);
    return {
      id: p.split('/').pop(), path: p,
      get: async () => { await tick(); return snap(p); },
      set: async (d) => { if (!canWrite) return deny(); await tick(); write(p, d); },
      update: async (d) => { if (!canWrite) return deny(); await tick(); if (!docs.has(p)) throw { code: 'invalid_argument', message: 'missing' }; write(p, merge(docs.get(p), d)); },
      delete: async () => { if (!canWrite) return deny(); await tick(); write(p, null); },
      onSnapshot(next) { const w = { t: 'doc', p, fire: deb(() => next(snap(p))) }; watchers.add(w); setTimeout(w.fire, 30); return () => watchers.delete(w); },
      collection: (c) => colRef(p + '/' + c),
    };
  }
  function qsnap(col, o) {
    let arr = [...docs].filter(([p]) => colOf(p) === col).map(([p, d]) => ({ id: p.slice(col.length + 1), exists: true, data: () => d, metadata: {} }));
    (o.where || []).forEach(([f, op, v]) => { arr = arr.filter((x) => { const a = x.data()[f]; return op === '<' ? a < v : op === '==' ? a === v : op === '>' ? a > v : true; }); });
    if (o.orderBy) arr.sort((a, b) => ((a.data()[o.orderBy] > b.data()[o.orderBy]) - (a.data()[o.orderBy] < b.data()[o.orderBy])) * (o.dir === 'desc' ? -1 : 1));
    else arr.sort((a, b) => (a.id < b.id ? -1 : 1));
    if (o.limit) arr = arr.slice(0, o.limit);
    return { docs: arr, size: arr.length, empty: !arr.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } };
  }
  function query(col, o) {
    return {
      where: (f, op, v) => query(col, Object.assign({}, o, { where: (o.where || []).concat([[f, op, v]]) })),
      orderBy: (f, dir) => query(col, Object.assign({}, o, { orderBy: f, dir })),
      limit: (n) => query(col, Object.assign({}, o, { limit: n })),
      get: async () => { await tick(); return qsnap(col, o); },
      onSnapshot(next) { const w = { t: 'col', p: col, fire: deb(() => next(qsnap(col, o))) }; watchers.add(w); setTimeout(w.fire, 30); return () => watchers.delete(w); },
    };
  }
  function colRef(c) {
    if (c.split('/').length % 2 === 0) throw new TypeError('collection path needs an odd number of segments: ' + c);
    return Object.assign(query(c, {}), { path: c, doc: (id) => docRef(c + '/' + (id || Math.random().toString(36).slice(2))), add: async (d) => { const r = docRef(c + '/' + Math.random().toString(36).slice(2)); await r.set(d); return r; } });
  }
  const db = Object.freeze({ doc: docRef, collection: colRef });

  // room: presence shared over a channel
  const rc = new BroadcastChannel('mock.room');
  let mine = {};
  const others = new Map();
  const peerFns = new Set();
  let frozen = Object.freeze([]);
  const mkPeer = (peer, by, presence, isMe) => Object.freeze({ peer, by, isMe, sameTab: isMe, kind: 'viewer', guest: !cfg.owner && false, presence: Object.freeze(presence), updatedAt: Date.now() });
  function rebuild() {
    const list = [mkPeer(me, cfg.uid, Object.assign({}, mine), true)];
    others.forEach((o, p) => list.push(mkPeer(p, o.by, o.presence, false)));
    frozen = Object.freeze(list);
    const ch = { peers: frozen, joined: [], left: [], updated: [] };
    peerFns.forEach((fn) => fn(ch));
  }
  let pending = false;
  const post = () => { if (pending) return; pending = true; setTimeout(() => { pending = false; rc.postMessage({ t: 'p', peer: me, by: cfg.uid, presence: mine }); }, 30); };
  rc.onmessage = (e) => {
    const m = e.data;
    if (m.t === 'p') { others.set(m.peer, { by: m.by, presence: m.presence }); rebuild(); }
    else if (m.t === 'hello') rc.postMessage({ t: 'p', peer: me, by: cfg.uid, presence: mine });
    else if (m.t === 'bye') { others.delete(m.peer); rebuild(); }
  };
  rc.postMessage({ t: 'hello' });
  addEventListener('pagehide', () => rc.postMessage({ t: 'bye', peer: me }));
  const room = Object.freeze({
    presence: async (patch) => {
      const next = Object.assign({}, mine);
      for (const k in patch) { if (patch[k] === null) delete next[k]; else next[k] = patch[k]; }
      if (JSON.stringify(next).length > 4096) throw { code: 'invalid_argument', message: 'presence over 4 KiB' };
      mine = next; post(); rebuild();
    },
    peers: () => frozen,
    onPeers: (fn) => { peerFns.add(fn); setTimeout(rebuild, 0); return () => peerFns.delete(fn); },
    emit: async () => { if (!canWrite) throw { code: 'not_permitted', message: 'no' }; },
    on: () => () => {},
    connected: () => true,
    onConnection: (fn) => { setTimeout(() => fn(true), 0); return () => {}; },
  });
  const user = Object.freeze({
    me: async () => ({ id: cfg.uid, name: cfg.name, isOwner: cfg.owner, canEdit: canWrite, color: '#888', avatarUrl: '', email: null }),
    can: async () => (cfg.role === 'viewer' ? null : true),
    isOwner: async () => cfg.owner, canEdit: async () => canWrite, id: async () => cfg.uid,
    profiles: async (ids) => Object.fromEntries([].concat(ids).map((i) => [i, { id: i, name: '', avatarUrl: '', color: '#888', email: null, isMe: i === cfg.uid, guest: false }])),
  });
  const caps = { db, room, user };
  window.claude = Object.freeze({ use: (n) => new Promise((r) => setTimeout(() => r(caps[n] || null), 40)) });
})();
