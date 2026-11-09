/* ===================================================================
   map.js — the battle map: pan/zoom, grid, live tokens, area
   templates, ruler, pings, and the floating table controls.
   =================================================================== */
const Board = (() => {
  'use strict';
  const S = Store.S;
  let root, world, mapImg, blank, svg, gGrid, gTpl, gFx, tokLayer, fxLayer, ghost, distTag;
  let rail, initStrip, bottom, msg, zoomTag, fab, fogCanvas;
  let fog = null; // current fog state for this scene (null when fog is off)
  let fogSaveT = 0;
  let wallDraft = null;
  const V = { z: 1, tx: 0, ty: 0 };
  let scene = null;
  let sceneId = null;
  let W = 2100;
  let H = 1400;
  let grid = { size: 70, ox: 0, oy: 0, show: true, color: '#e9e2cf', alpha: 0.16 };
  let gridPreview = null;
  let tool = 'select';
  let sel = null;
  let aim = null;
  let fitted = false;
  let dismissedMsg = false;
  const tokEls = new Map();
  const pendingMoves = new Map();
  const remoteDrag = new Map();
  const peerDragId = new Map();
  let myRuler = null;
  let rulerTimer = 0;
  const pointers = new Map();
  let G = null;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeColor = (c) => (/^#[0-9a-f]{3,8}$/i.test(c || '') ? c : null);
  const safeImg = (u) => (typeof u === 'string' && /^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(u) ? u : null);
  const initials = (n) => {
    const w = String(n || '?').trim().split(/\s+/).filter(Boolean);
    if (!w.length) return '?';
    if (w.length === 1) return w[0].slice(0, 2);
    const last = w[w.length - 1];
    return (w[0][0] + (/^\d+$/.test(last) ? w[1] ? w[1][0] : '' : last[0])).toUpperCase();
  };
  const icon = (id) => `<svg class="ic" aria-hidden="true"><use href="#i-${id}"/></svg>`;

  /* -------------------------------------------------------- coords */
  const rect = () => root.getBoundingClientRect();
  function toWorld(cx, cy) {
    const r = rect();
    return [(cx - r.left - V.tx) / V.z, (cy - r.top - V.ty) / V.z];
  }
  const g = () => grid.size;
  const cellOf = (x, y) => [Math.floor((x - grid.ox) / grid.size), Math.floor((y - grid.oy) / grid.size)];
  const cellCenter = (c, r) => [grid.ox + (c + 0.5) * grid.size, grid.oy + (r + 0.5) * grid.size];
  const snapPoint = (x, y, step) => {
    const s = step || grid.size;
    return [grid.ox + Math.round((x - grid.ox) / s) * s, grid.oy + Math.round((y - grid.oy) / s) * s];
  };
  const diagRule = () => (S.game && S.game.diag) || '5';

  /* ---------------------------------------------------------- init */
  function init(el) {
    root = el;
    root.innerHTML = `
      <div class="world" id="world">
        <div class="blankmap" hidden></div>
        <img class="mapimg" alt="" hidden draggable="false">
        <svg class="layer-grid" xmlns="http://www.w3.org/2000/svg"><path class="grid-path" fill="none"/></svg>
        <svg class="layer-tpl" xmlns="http://www.w3.org/2000/svg"><g class="tpls"></g></svg>
        <canvas class="fog-layer" aria-hidden="true"></canvas>
        <div class="tokens"></div>
        <svg class="layer-fx" xmlns="http://www.w3.org/2000/svg"><g class="fx"></g></svg>
        <div class="fxdom"><div class="ghost" hidden></div><div class="dist-tag" hidden></div></div>
      </div>
      <div class="initstrip" data-hud hidden></div>
      <div class="rail" data-hud role="toolbar" aria-label="Table tools"></div>
      <div class="board-msg" data-hud hidden></div>
      <div class="zoom-tag num" data-hud></div>
      <button class="fab-dice" data-hud data-act="dice" aria-label="Roll dice">${icon('d20')}</button>
      <div class="board-bottom" data-hud></div>`;
    world = root.querySelector('.world');
    blank = root.querySelector('.blankmap');
    mapImg = root.querySelector('.mapimg');
    svg = [...root.querySelectorAll('.world svg')];
    gGrid = root.querySelector('.grid-path');
    gTpl = root.querySelector('.tpls');
    gFx = root.querySelector('.fx');
    tokLayer = root.querySelector('.tokens');
    fogCanvas = root.querySelector('.fog-layer');
    fxLayer = root.querySelector('.fxdom');
    ghost = root.querySelector('.ghost');
    distTag = root.querySelector('.dist-tag');
    rail = root.querySelector('.rail');
    initStrip = root.querySelector('.initstrip');
    bottom = root.querySelector('.board-bottom');
    msg = root.querySelector('.board-msg');
    zoomTag = root.querySelector('.zoom-tag');
    fab = root.querySelector('.fab-dice');
    mapImg.addEventListener('load', () => renderHud());

    root.addEventListener('pointerdown', onDown);
    root.addEventListener('pointermove', onMove);
    root.addEventListener('pointerup', onUp);
    root.addEventListener('pointercancel', onUp);
    root.addEventListener('lostpointercapture', (e) => {
      if (pointers.has(e.pointerId)) onUp(e);
    });
    root.addEventListener('wheel', onWheel, { passive: false });
    root.addEventListener('contextmenu', (e) => {
      if (!e.target.closest('[data-hud]')) e.preventDefault();
    });
    root.addEventListener('click', onHudClick);
    root.addEventListener('keydown', onHudKey);
    document.addEventListener('keydown', onKey);
    if ('ResizeObserver' in window) new ResizeObserver(onResize).observe(root);
    else addEventListener('resize', onResize);

    Store.on('scenes', applyScene);
    Store.on('game', () => {
      applyScene();
    });
    Store.on('maps', applyScene);
    Store.on('tokens', () => {
      if (sel && !S.tokens.has(sel)) sel = null;
      renderTokens();
      renderTemplates();
      renderHud();
    });
    Store.on('chars', () => {
      renderTokens();
      renderHud();
    });
    Store.on('tpls', renderTemplates);
    Store.on('init', () => {
      renderTokens();
      renderHud();
    });
    Store.on('me', () => {
      renderTokens();
      renderHud();
    });
    Store.on('data', () => {
      renderTokens();
      renderHud();
    });
    let peersRaf = 0;
    Store.on('peers', () => {
      if (peersRaf) return;
      peersRaf = requestAnimationFrame(() => {
        peersRaf = 0;
        onPeers();
      });
    });
    Store.on('ping', onPing);
    Store.on('relay', renderHud);
    applyScene();
  }

  let lastSize = null;
  function onResize() {
    const r = rect();
    if (r.width < 10 || r.height < 10) return;
    if (!fitted) fit();
    else if (lastSize) {
      // keep the same point in the middle
      V.tx += (r.width - lastSize[0]) / 2;
      V.ty += (r.height - lastSize[1]) / 2;
      applyView();
    }
    lastSize = [r.width, r.height];
  }

  /* --------------------------------------------------------- scene */
  function sceneDims(sc, gr) {
    if (sc.mapId) return [sc.w || 2000, sc.h || 1400];
    return [(sc.cols || 30) * gr.size, (sc.rows || 20) * gr.size];
  }
  function applyScene() {
    const sc = Store.activeScene();
    const changed = sc.id !== sceneId;
    if (changed) {
      sel = null;
      aim = null;
      fitted = false;
      gridPreview = null;
      dismissedMsg = false;
    }
    scene = sc;
    sceneId = sc.id;
    grid = Object.assign({ size: 70, ox: 0, oy: 0, show: true, color: '#e9e2cf', alpha: 0.16 }, sc.grid || {}, gridPreview || {});
    grid.size = Core.clamp(Number(grid.size) || 70, 4, 1000);
    grid.ox = Number(grid.ox) || 0;
    grid.oy = Number(grid.oy) || 0;
    grid.size = Math.max(8, Number(grid.size) || 70);
    [W, H] = sceneDims(sc, grid);
    world.style.width = W + 'px';
    world.style.height = H + 'px';
    world.style.setProperty('--g', grid.size);
    svg.forEach((s) => {
      s.setAttribute('width', W);
      s.setAttribute('height', H);
      s.setAttribute('viewBox', `0 0 ${W} ${H}`);
    });
    if (sc.mapId) {
      blank.hidden = true;
      let m = S.maps.get(sc.mapId);
      if (!m || m.status === 'error' && !m.retried) {
        if (m) m.retried = true;
        Store.fetchMap(sc);
        m = S.maps.get(sc.mapId);
      }
      mapImg.style.width = W + 'px';
      mapImg.style.height = H + 'px';
      if (m && m.status === 'ready') {
        if (mapImg.getAttribute('src') !== m.url) mapImg.setAttribute('src', m.url);
        mapImg.hidden = false;
      } else mapImg.hidden = true;
    } else {
      mapImg.hidden = true;
      blank.hidden = false;
      blank.style.width = W + 'px';
      blank.style.height = H + 'px';
    }
    renderGrid();
    fog = null;
    if (!fitted) fit();
    renderAll();
  }
  function previewGrid(gp) {
    gridPreview = gp;
    applyScene();
  }

  /* ---------------------------------------------------------- view */
  const clampZoom = (z) => Math.max(0.04, Math.min(6, z));
  function applyView() {
    world.style.transform = `translate(${V.tx}px, ${V.ty}px) scale(${V.z})`;
    gGrid.setAttribute('stroke-width', String(Math.max(0.6, 1.1 / V.z)));
    world.style.setProperty('--sw', String(1 / V.z));
    zoomTag.textContent = Math.round(V.z * 100) + '%';
    if (myRuler || S.peers.some((p) => p.presence && p.presence.ru)) renderFx();
    if (V.z !== lastLabelZoom) {
      clearTimeout(labelTimer);
      labelTimer = setTimeout(() => {
        lastLabelZoom = V.z;
        renderTemplates();
      }, 140);
    }
  }
  let lastLabelZoom = 0;
  let labelTimer = 0;
  function fit() {
    const r = rect();
    if (r.width < 10 || r.height < 10) return;
    const pad = r.width < 700 ? 0.96 : 0.9;
    const z = clampZoom(Math.min(r.width / W, r.height / H) * pad);
    V.z = z;
    V.tx = (r.width - W * z) / 2;
    V.ty = (r.height - H * z) / 2;
    fitted = true;
    lastSize = [r.width, r.height];
    applyView();
  }
  function zoomAt(sx, sy, z) {
    z = clampZoom(z);
    const wx = (sx - V.tx) / V.z;
    const wy = (sy - V.ty) / V.z;
    V.z = z;
    V.tx = sx - wx * z;
    V.ty = sy - wy * z;
    applyView();
  }
  function centerOn(x, y) {
    const r = rect();
    V.tx = r.width / 2 - x * V.z;
    V.ty = r.height / 2 - y * V.z;
    applyView();
  }
  function viewCenterCell() {
    const r = rect();
    const w = r.width > 10 ? toWorld(r.left + r.width / 2, r.top + r.height / 2) : [W / 2, H / 2];
    const [c, rr] = cellOf(Math.min(Math.max(w[0], 0), W - 1), Math.min(Math.max(w[1], 0), H - 1));
    return [c, rr];
  }

  /* ---------------------------------------------------------- grid */
  function renderGrid() {
    if (!grid.show) {
      gGrid.setAttribute('d', '');
      return;
    }
    const s = grid.size;
    const x0 = ((grid.ox % s) + s) % s;
    const y0 = ((grid.oy % s) + s) % s;
    let d = '';
    for (let x = x0; x <= W + 0.5; x += s) d += `M${x.toFixed(2)} 0V${H}`;
    for (let y = y0; y <= H + 0.5; y += s) d += `M0 ${y.toFixed(2)}H${W}`;
    gGrid.setAttribute('d', d);
    gGrid.setAttribute('stroke', safeColor(grid.color) || '#000000');
    gGrid.setAttribute('stroke-opacity', String(Math.max(0.05, Math.min(1, Number(grid.alpha) || 0.3))));
  }

  /* -------------------------------------------------------- tokens */
  /* ---------------------------------------------------- fog of war */
  // walls are [x1,y1,x2,y2] in map pixels on the scene; fog settings in scene.fog
  const sceneWalls = () => (Array.isArray(scene && scene.walls) ? scene.walls : []).filter((w) => Array.isArray(w) && w.length === 4 && w.every((v) => Number.isFinite(Number(v)))).map((w) => w.map(Number));
  const fogOn = () => !!(scene && !scene.virtual && scene.fog && scene.fog.enabled) || !!(scene && scene.virtual && scene.fog && scene.fog.enabled);
  function updateFog() {
    if (!fogOn()) {
      fog = null;
      drawFog();
      return;
    }
    const f = scene.fog || {};
    const pcs = [];
    S.tokens.forEach((t) => t.scene === sceneId && t.kind === 'pc' && pcs.push(t));
    // nothing that fog depends on changed (heroes' squares, vision, walls, settings): keep the last result
    const key = [S.dm ? 1 : 0, grid.size, grid.ox, grid.oy, W, H, diagRule(), pcs.map((t) => [t.id, t.c, t.r, t.size, t.vision].join(':')).join('|')].join(';');
    if (fog && fog.sceneRef === scene && fog.key === key) return;
    const prevExplored = fog && fog.sceneId === sceneId ? fog.explored : {};
    const st = Core.createFogState({ explored: Object.assign({}, f.explored || {}, prevExplored), ManualReveal: f.reveal || {}, ManualHide: f.hide || {} });
    Core.stepFog(st, pcs, grid, sceneWalls(), { rule: diagRule(), defaultVisionFt: Number(f.vision) > 0 ? Number(f.vision) : 60 });
    st.sceneId = sceneId;
    st.sceneRef = scene;
    st.key = key;
    fog = st;
    // the DM's device keeps the explored area with the scene
    if (S.dm && !S.readOnly) {
      const saved = f.explored || {};
      const add = {};
      Object.keys(st.explored).forEach((k) => !saved[k] && (add[k] = 1));
      if (Object.keys(add).length) {
        clearTimeout(fogSaveT);
        const id = sceneId;
        fogSaveT = setTimeout(() => Store.Act.patchScene(id, { fog: { explored: add } }), 800);
      }
    }
    drawFog();
  }
  function drawFog() {
    if (!fogCanvas) return;
    if (!fog) {
      fogCanvas.hidden = true;
      return;
    }
    fogCanvas.hidden = false;
    if (fogCanvas.width !== Math.round(W) || fogCanvas.height !== Math.round(H)) {
      fogCanvas.width = Math.round(W);
      fogCanvas.height = Math.round(H);
    }
    fogCanvas.style.width = W + 'px';
    fogCanvas.style.height = H + 'px';
    const cx = fogCanvas.getContext('2d');
    cx.clearRect(0, 0, W, H);
    const g = grid.size;
    const c0 = Math.floor(-grid.ox / g) - 1;
    const r0 = Math.floor(-grid.oy / g) - 1;
    const c1 = Math.ceil((W - grid.ox) / g);
    const r1 = Math.ceil((H - grid.oy) / g);
    // players: black where unexplored, dim where explored; the DM: a light shade where players can't see
    const unseen = S.dm ? 'rgba(10,14,20,0.35)' : 'rgb(8,10,12)';
    const remembered = S.dm ? 'rgba(10,14,20,0.18)' : 'rgba(8,10,12,0.6)';
    for (let c = c0; c <= c1; c++) {
      for (let r = r0; r <= r1; r++) {
        const k = c + ',' + r;
        if (fog.visible[k]) continue;
        cx.fillStyle = fog.explored[k] ? remembered : unseen;
        cx.fillRect(grid.ox + c * g - 0.5, grid.oy + r * g - 0.5, g + 1, g + 1);
      }
    }
  }
  function sceneTokens() {
    const out = [];
    S.tokens.forEach((t) => {
      if (t.scene === sceneId && (!t.hidden || S.dm) && (S.dm || t.kind === 'pc' || ownsToken(t) || Core.tokenVisibleToPlayers(t, fog))) out.push(t);
    });
    return out;
  }
  function tokInfo(t) {
    if (t.kind === 'pc') {
      const ch = S.chars.get(t.char);
      const hp = ch ? Store.heroHp(ch) : { hp: null, max: null };
      const d = ch ? Store.derived(ch) : null;
      return {
        name: ch ? ch.name || 'Hero' : 'Missing hero', color: safeColor(ch && ch.color) || '#8fb0a5', img: safeImg(ch && ch.portrait),
        hp: hp.hp, max: hp.max, tmp: hp.tmp, ac: d ? d.ac : null, conds: (ch && ch.conds) || [], showHp: true, ch, d,
      };
    }
    const mon = t.mon && Store.Data.monstersById ? Store.Data.monstersById.get(t.mon) : null;
    return {
      name: t.name || (mon && mon.n) || 'Token', color: safeColor(t.color) || (t.kind === 'monster' ? '#e2654f' : '#c9b48a'), img: null,
      hp: t.hp, max: t.max, ac: t.ac, conds: t.conds || [], showHp: S.dm || t.kind !== 'monster', mon,
    };
  }
  function ownsToken(t) {
    if (!t) return false;
    if (t.owner && t.owner === S.me.pk) return true;
    if (t.kind === 'pc') {
      const ch = S.chars.get(t.char);
      return !!ch && ch.owner === S.me.pk;
    }
    return false;
  }
  const canMove = (t) => !!t && !S.readOnly && (S.dm || ownsToken(t));
  function turnTokenId() {
    if (!S.game.combat || !S.game.turn) return null;
    const e = S.init.get(S.game.turn);
    if (!e) return null;
    if (e.tok && S.tokens.has(e.tok)) return e.tok;
    if (e.char) {
      for (const t of S.tokens.values()) if (t.char === e.char && t.scene === sceneId) return t.id;
    }
    return null;
  }
  function hpClass(hp, max) {
    if (!max) return '';
    const r = hp / max;
    return r <= 0.25 ? 'low' : r <= 0.5 ? 'mid' : '';
  }
  function renderTokens() {
    if (!tokLayer) return;
    updateFog();
    const list = sceneTokens();
    const seen = new Set();
    const turn = turnTokenId();
    const now = Date.now();
    for (const t of list) {
      seen.add(t.id);
      let el = tokEls.get(t.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'tok';
        el.dataset.id = t.id;
        el.innerHTML = '<div class="tok-disc"></div><div class="tok-name"></div>';
        tokLayer.appendChild(el);
        tokEls.set(t.id, el);
      }
      const info = tokInfo(t);
      const size = Number(t.size) || 1;
      const s = size < 1 ? 1 : size;
      let c = t.c || 0;
      let r = t.r || 0;
      const pm = pendingMoves.get(t.id);
      if (pm) {
        if ((pm.c === t.c && pm.r === t.r) || now - pm.t > 6000) pendingMoves.delete(t.id);
        else {
          c = pm.c;
          r = pm.r;
        }
      }
      let x = grid.ox + c * grid.size;
      let y = grid.oy + r * grid.size;
      let remote = false;
      const rd = remoteDrag.get(t.id);
      if (rd) {
        if (rd.active || (now < rd.until && rd.c0 === t.c && rd.r0 === t.r)) {
          x = rd.x;
          y = rd.y;
          remote = true;
        } else remoteDrag.delete(t.id);
      }
      const dragging = G && G.mode === 'tok' && G.id === t.id;
      if (!dragging) el.style.transform = `translate(${x}px, ${y}px)`;
      el.style.width = el.style.height = s * grid.size + 'px';
      el.style.setProperty('--s', String(s));
      const down = info.max && info.hp != null && info.hp <= 0;
      el.className = 'tok kind-' + (t.kind || 'npc') + (sel === t.id ? ' is-sel' : '') + (turn === t.id ? ' is-turn' : '') + (t.hidden ? ' is-hidden' : '') +
        (down ? ' is-down' : '') + (size < 1 ? ' small-disc' : '') + (canMove(t) ? '' : ' no-move') + (remote ? ' remote' : '') + (dragging ? ' dragging' : '');
      const disc = el.firstChild;
      disc.style.setProperty('--tc', info.color);
      const key = info.img ? 'i' + info.img.length + info.img.slice(-24) : 't' + initials(info.name);
      if (disc.dataset.k !== key) {
        disc.dataset.k = key;
        disc.textContent = '';
        if (info.img) {
          const im = new Image();
          im.alt = '';
          im.draggable = false;
          im.src = info.img;
          disc.appendChild(im);
        } else disc.textContent = initials(info.name);
      }
      el.children[1].textContent = info.name;
      // number badge for monsters
      setPart(el, 'tok-num', t.num ? String(t.num) : null);
      setPart(el, 'tok-cond', info.conds.length ? String(info.conds.length) : null);
      let bar = el.querySelector('.tok-bar');
      if (info.showHp && info.max) {
        if (!bar) {
          bar = document.createElement('div');
          bar.className = 'tok-bar';
          bar.innerHTML = '<i></i>';
          el.appendChild(bar);
        }
        const ratio = Math.max(0, Math.min(1, (info.hp == null ? info.max : info.hp) / info.max));
        bar.firstChild.style.width = Math.round(ratio * 100) + '%';
        bar.firstChild.className = hpClass(info.hp, info.max);
      } else if (bar) bar.remove();
      el.setAttribute('aria-label', info.name);
    }
    tokEls.forEach((el, id) => {
      if (!seen.has(id)) {
        el.remove();
        tokEls.delete(id);
      }
    });
  }
  function setPart(el, cls, text) {
    let p = el.querySelector('.' + cls);
    if (text == null) {
      if (p) p.remove();
      return;
    }
    if (!p) {
      p = document.createElement('div');
      p.className = cls;
      el.appendChild(p);
    }
    p.textContent = text;
  }
  function tokenRectPx(t) {
    const s = Math.max(1, Number(t.size) || 1);
    return { x: grid.ox + (t.c || 0) * grid.size, y: grid.oy + (t.r || 0) * grid.size, s: s * grid.size };
  }
  function focusToken(id, select = true) {
    const t = S.tokens.get(id);
    if (!t) return false;
    if (t.scene !== sceneId) {
      Store.Act.setGame({ scene: t.scene });
    }
    const rr = tokenRectPx(t);
    centerOn(rr.x + rr.s / 2, rr.y + rr.s / 2);
    if (select) selectTok(id);
    return true;
  }
  function selectTok(id) {
    sel = id;
    renderTokens();
    renderHud();
  }

  // a free spot near the middle of the view, for new tokens
  function freeSpot(size, taken) {
    const s = Math.max(1, Math.round(size || 1));
    const occ = new Set(taken || []);
    S.tokens.forEach((t) => {
      if (t.scene !== sceneId) return;
      Core.tokenCells(t).forEach(([c, r]) => occ.add(c + ',' + r));
    });
    const cols = Math.floor((W - grid.ox) / grid.size);
    const rows = Math.floor((H - grid.oy) / grid.size);
    const [c0, r0] = viewCenterCell();
    const fits = (c, r) => {
      if (c < 0 || r < 0 || c + s > cols || r + s > rows) return false;
      for (let i = 0; i < s; i++) for (let j = 0; j < s; j++) if (occ.has(c + i + ',' + (r + j))) return false;
      return true;
    };
    for (let rad = 0; rad < 40; rad++) {
      for (let dc = -rad; dc <= rad; dc++) {
        for (let dr = -rad; dr <= rad; dr++) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== rad) continue;
          const c = c0 + dc;
          const r = r0 + dr;
          if (fits(c, r)) {
            for (let i = 0; i < s; i++) for (let j = 0; j < s; j++) occ.add(c + i + ',' + (r + j));
            return { c, r, cells: [...occ] };
          }
        }
      }
    }
    return { c: Math.max(0, c0), r: Math.max(0, r0), cells: [...occ] };
  }

  /* ----------------------------------------------------- templates */
  function aimOrigin(a) {
    if (a.anchor && S.tokens.has(a.anchor)) {
      const rr = tokenRectPx(S.tokens.get(a.anchor));
      const cx = rr.x + rr.s / 2;
      const cy = rr.y + rr.s / 2;
      if (a.shape === 'cone' || a.shape === 'line') return Core.edgePoint(cx, cy, rr.s, a.angle || 0);
      return [cx, cy];
    }
    return [a.x, a.y];
  }
  function aimGeom() {
    if (!aim) return null;
    const [x, y] = aimOrigin(aim);
    return { shape: aim.shape, size: aim.size, width: aim.width || 5, x, y, angle: aim.angle || 0, color: aim.color, label: aim.label || '' };
  }
  function tplLabel(t) {
    const kind = t.shape === 'circle' ? 'radius' : t.shape === 'cube' ? 'cube' : t.shape === 'cone' ? 'cone' : 'line';
    return `${t.label ? t.label + ' · ' : ''}${t.size}-ft ${kind}`;
  }
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  function tplSvg(t0, opts) {
    // shared docs and other people's presence: numbers only, since they go into markup
    const t = Object.assign({}, t0, { x: num(t0.x, 0), y: num(t0.y, 0), size: Core.clamp(num(t0.size, 5), 0, 2000), width: num(t0.width, 5), angle: num(t0.angle, 0) });
    const s = grid.size;
    const col = safeColor(t.color) || '#d9a647';
    const cells = Core.templateCells(t, grid);
    let cd = '';
    for (const [c, r] of cells) cd += `M${(grid.ox + c * s).toFixed(1)} ${(grid.oy + r * s).toFixed(1)}h${s}v${s}h${-s}z`;
    const L = (t.size / 5) * s;
    let shape = '';
    if (t.shape === 'circle') shape = `<circle cx="${t.x}" cy="${t.y}" r="${L}"/>`;
    else if (t.shape === 'cube') shape = `<rect x="${t.x}" y="${t.y}" width="${L}" height="${L}"/>`;
    else shape = `<polygon points="${Core.templateCorners(t, s).map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ')}"/>`;
    const dash = opts.preview ? ' stroke-dasharray="8 6"' : '';
    // labels stay readable when zoomed out
    const fs = Math.max(11, s * 0.24, 13 / V.z);
    const [lx, ly] = t.shape === 'cube' ? [t.x + L / 2, t.y + L / 2] : t.shape === 'circle' ? [t.x, t.y - L - fs * 0.4] : [t.x, t.y - s * 0.4];
    let out = `<g class="tpl">`;
    out += `<path d="${cd}" fill="${col}" fill-opacity="${opts.preview ? 0.26 : 0.32}"/>`;
    out += `<g fill="${col}" fill-opacity="0.12" stroke="${col}" stroke-width="${Math.max(1.5, 2.2 / V.z)}"${dash}>${shape}</g>`;
    if (opts.label !== false) {
      out += `<text x="${lx}" y="${ly}" text-anchor="middle" font-size="${fs}" font-weight="700" fill="#fff" stroke="#0a1512" stroke-width="${fs * 0.22}" paint-order="stroke">${esc(tplLabel(t))}</text>`;
    }
    if (opts.handle) {
      const [hx, hy] = t.shape === 'cube' ? [t.x + L / 2, t.y + L / 2] : [t.x, t.y];
      out += `<circle data-tpl="${esc(opts.handle)}" cx="${hx}" cy="${hy}" r="${s * 0.3}" fill="${col}" fill-opacity="0.9" stroke="#0a1512" stroke-width="${s * 0.06}"/>`;
    }
    if (opts.origin) out += `<circle cx="${t.x}" cy="${t.y}" r="${s * 0.16}" fill="#fff" stroke="${col}" stroke-width="${s * 0.06}"/>`;
    return out + '</g>';
  }
  function renderTemplates() {
    if (!gTpl) return;
    let html = '';
    S.tpls.forEach((t) => {
      if (t.scene !== sceneId) return;
      if (aim && aim.id === t.id) return;
      html += tplSvg(t, { handle: t.id });
    });
    S.peers.forEach((p) => {
      const a = p.presence && p.presence.aim;
      if (!p.sameTab && a && a.sc === sceneId && typeof a.x === 'number') {
        html += tplSvg({ shape: a.shape, size: Math.min(400, a.size || 5), width: a.width, x: a.x, y: a.y, angle: a.angle, color: p.presence.col, label: a.label }, { preview: true });
      }
    });
    if (aim) html += tplSvg(aimGeom(), { preview: true, origin: aim.shape === 'cone' || aim.shape === 'line' });
    gTpl.innerHTML = html;
  }
  function tokensInTemplate(t) {
    const cells = Core.templateCells(t, grid);
    const out = [];
    sceneTokens().forEach((tok) => {
      if (Core.cellsHit(cells, tok)) out.push(tok);
    });
    return { cells, tokens: out };
  }

  // spec: {shape, size, width, color, label, self, caster (token id), id (existing)}
  function startAim(spec) {
    const s = grid.size;
    const a = {
      shape: spec.shape, size: Math.max(5, Math.min(400, Number(spec.size) || 5)), width: Number(spec.width) || 5,
      color: safeColor(spec.color) || S.me.color, label: spec.label || '', angle: spec.angle || 0, snap: true, id: spec.id || null, anchor: null,
      spell: spec.spell || null,
    };
    const L = (a.size / 5) * s;
    const caster = spec.caster && S.tokens.get(spec.caster);
    if (spec.x !== undefined) {
      a.x = spec.x;
      a.y = spec.y;
    } else if (caster && caster.scene === sceneId) {
      const rr = tokenRectPx(caster);
      const cx = rr.x + rr.s / 2;
      const cy = rr.y + rr.s / 2;
      if (a.shape === 'cone' || a.shape === 'line') a.anchor = caster.id;
      else if (a.shape === 'circle') {
        a.x = cx;
        a.y = cy;
      } else {
        a.x = rr.x + rr.s;
        a.y = snapPoint(rr.x, cy - L / 2)[1];
      }
      if (a.anchor) {
        a.x = cx;
        a.y = cy;
      }
    } else {
      const [c, r] = viewCenterCell();
      let [x, y] = [grid.ox + c * s, grid.oy + r * s];
      if (a.shape === 'cube') [x, y] = snapPoint(x - L / 2, y - L / 2);
      a.x = x;
      a.y = y;
    }
    aim = a;
    sel = null;
    setTool('template', true);
    renderTemplates();
    renderTokens();
    renderHud();
    Store.pushPresence({ aim: aimPresence() });
  }
  function aimPresence() {
    const a = aimGeom();
    if (!a) return null;
    return { shape: a.shape, size: a.size, width: a.width, x: Math.round(a.x), y: Math.round(a.y), angle: Math.round(a.angle * 1000) / 1000, label: String(a.label || '').slice(0, 40), sc: sceneId };
  }
  function editTemplate(id) {
    const t = S.tpls.get(id);
    if (!t) return;
    startAim({ shape: t.shape, size: t.size, width: t.width, color: t.color, label: t.label, angle: t.angle, x: t.x, y: t.y, id });
  }
  function aimPointer(wx, wy, isDown) {
    const s = grid.size;
    if (aim.shape === 'circle') {
      [aim.x, aim.y] = aim.snap ? snapPoint(wx, wy) : [wx, wy];
      aim.anchor = null;
    } else if (aim.shape === 'cube') {
      const L = (aim.size / 5) * s;
      let x = wx - L / 2;
      let y = wy - L / 2;
      if (aim.snap) [x, y] = snapPoint(x, y);
      aim.x = x;
      aim.y = y;
      aim.anchor = null;
    } else {
      const [ox, oy] = aimOrigin(aim);
      if (isDown) G.aimMode = !aim.anchor && Math.hypot(wx - ox, wy - oy) < s * 0.6 ? 'move' : 'dir';
      if (G.aimMode === 'move') {
        [aim.x, aim.y] = aim.snap ? snapPoint(wx, wy, s / 2) : [wx, wy];
      } else if (Math.hypot(wx - ox, wy - oy) > s * 0.2) {
        aim.angle = Math.atan2(wy - oy, wx - ox);
      }
    }
    renderTemplates();
    renderHud();
    Store.pushPresence({ aim: aimPresence() });
  }
  function placeAim() {
    if (!aim) return;
    const geo = aimGeom();
    const doc = { scene: sceneId, shape: geo.shape, size: geo.size, width: geo.width, x: Math.round(geo.x * 10) / 10, y: Math.round(geo.y * 10) / 10, angle: geo.angle, color: geo.color, label: String(geo.label || '').slice(0, 60), owner: S.me.pk, ts: Date.now() };
    // a spell or breath weapon remembers its damage and save for the area sheet
    const sp = aim.spell;
    if (sp) {
      if (sp.roll && Core.parseDice(sp.roll)) doc.roll = String(sp.roll).slice(0, 40);
      if (sp.dc) doc.dc = Number(sp.dc);
      if (sp.save) doc.save = sp.save;
      if (sp.half) doc.half = 1;
    }
    const editId = aim.id;
    aim = null;
    Store.pushPresence({ aim: null });
    setTool('select');
    renderTemplates();
    renderHud();
    Store.Act.ensureScene().then((sid) => {
      if (editId && S.tpls.has(editId)) Store.Act.patchTemplate(editId, { x: doc.x, y: doc.y, angle: doc.angle, size: doc.size, width: doc.width });
      else Store.Act.addTemplate(Object.assign({}, doc, { scene: sid }));
      const hit = tokensInTemplate(doc);
      if (hit.tokens.length && window.UI) UI.toast(`${tplLabel(doc)} covers ${hit.tokens.length === 1 ? '1 token' : hit.tokens.length + ' tokens'}. Tap its dot to apply damage.`);
    });
  }
  function cancelAim() {
    aim = null;
    Store.pushPresence({ aim: null });
    setTool('select');
    renderTemplates();
    renderHud();
  }

  /* ---------------------------------------------------- fx + ruler */
  function rulerSvg(a, b, col, label) {
    const [x1, y1] = cellCenter(a[0], a[1]);
    const [x2, y2] = cellCenter(b[0], b[1]);
    const w = Math.max(2, 3 / V.z);
    const fs = 15 / V.z;
    return `<g><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#0a1512" stroke-width="${w * 2.2}" stroke-linecap="round"/>
      <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${col}" stroke-width="${w}" stroke-linecap="round" stroke-dasharray="${w * 3} ${w * 2}"/>
      <circle cx="${x1}" cy="${y1}" r="${w * 2}" fill="${col}"/><circle cx="${x2}" cy="${y2}" r="${w * 2.4}" fill="${col}"/>
      <text x="${x2}" y="${y2 - w * 5}" text-anchor="middle" font-size="${fs}" font-weight="700" fill="#fff" stroke="#0a1512" stroke-width="${fs * 0.25}" paint-order="stroke">${esc(label)}</text></g>`;
  }
  function renderFx() {
    if (!gFx) return;
    let html = '';
    const rule = diagRule();
    if (myRuler) {
      const ft = Core.distanceFt(myRuler.b[0] - myRuler.a[0], myRuler.b[1] - myRuler.a[1], rule);
      html += rulerSvg(myRuler.a, myRuler.b, S.me.color, ft + ' ft');
    }
    S.peers.forEach((p) => {
      const ru = p.presence && p.presence.ru;
      if (p.sameTab || !ru || ru.sc !== sceneId || !Array.isArray(ru.a) || !Array.isArray(ru.b)) return;
      const ft = Core.distanceFt(ru.b[0] - ru.a[0], ru.b[1] - ru.a[1], rule);
      html += rulerSvg(ru.a, ru.b, safeColor(p.presence.col) || '#d9a647', ft + ' ft');
    });
    if (S.dm && (fogOn() || tool === 'walls')) {
      const w = Math.max(2, 3 / V.z);
      sceneWalls().forEach(([x1, y1, x2, y2]) => (html += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#93bbff" stroke-width="${w}" stroke-linecap="round"/>`));
      if (wallDraft) html += `<line x1="${wallDraft[0]}" y1="${wallDraft[1]}" x2="${wallDraft[2]}" y2="${wallDraft[3]}" stroke="#f3cf78" stroke-width="${w}" stroke-dasharray="${w * 3} ${w * 2}" stroke-linecap="round"/>`;
    }
    gFx.innerHTML = html;
  }
  function onPing(p) {
    if (!p || p.sc !== sceneId || typeof p.x !== 'number') return;
    const el = document.createElement('div');
    el.className = 'ping';
    el.style.left = p.x + 'px';
    el.style.top = p.y + 'px';
    const sz = grid.size * 1.1;
    el.style.width = el.style.height = sz + 'px';
    el.style.margin = `${-sz / 2}px 0 0 ${-sz / 2}px`;
    el.style.setProperty('--c', safeColor(p.col) || '#f3cf78');
    fxLayer.appendChild(el);
    setTimeout(() => el.remove(), 3200);
    if (!p.mine) {
      const r = rect();
      const sx = p.x * V.z + V.tx;
      const sy = p.y * V.z + V.ty;
      if (sx < 0 || sy < 0 || sx > r.width || sy > r.height) centerOn(p.x, p.y);
    }
  }
  function onPeers() {
    const now = Date.now();
    const activeIds = new Set();
    S.peers.forEach((p) => {
      if (p.sameTab || !p.presence) return;
      const dr = p.presence.dr;
      const prevId = peerDragId.get(p.peer);
      if (dr && dr.sc === sceneId && S.tokens.has(dr.id) && typeof dr.x === 'number') {
        const t = S.tokens.get(dr.id);
        const cur = remoteDrag.get(dr.id);
        remoteDrag.set(dr.id, { x: dr.x, y: dr.y, active: true, c0: cur && cur.active ? cur.c0 : t.c, r0: cur && cur.active ? cur.r0 : t.r, until: 0 });
        activeIds.add(dr.id);
        peerDragId.set(p.peer, dr.id);
      } else if (prevId) {
        const cur = remoteDrag.get(prevId);
        if (cur) {
          cur.active = false;
          cur.until = now + 2500;
        }
        peerDragId.delete(p.peer);
      }
    });
    remoteDrag.forEach((v, id) => {
      if (v.active && !activeIds.has(id)) {
        v.active = false;
        v.until = now + 2500;
      }
    });
    renderTokens();
    renderTemplates();
    renderFx();
  }

  /* ----------------------------------------------------- gestures */
  function onDown(e) {
    if (e.target.closest('[data-hud]')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) {
      if (e.button === 1 || e.button === 2) {
        try {
          root.setPointerCapture(e.pointerId);
        } catch (er) { /* ignore */ }
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        G = { mode: 'pan', id0: e.pointerId, sx: e.clientX, sy: e.clientY, vx: V.tx, vy: V.ty, moved: true };
        root.classList.add('panning');
      }
      return;
    }
    try {
      root.setPointerCapture(e.pointerId);
    } catch (er) { /* ignore */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      cancelGesture();
      startPinch();
      return;
    }
    if (pointers.size > 2) return;
    const [wx, wy] = toWorld(e.clientX, e.clientY);
    const tokEl = e.target.closest('.tok');
    const tplEl = e.target.closest('[data-tpl]');
    G = { id0: e.pointerId, sx: e.clientX, sy: e.clientY, wx, wy, moved: false, vx: V.tx, vy: V.ty };
    if (aim) {
      G.mode = 'aim';
      aimPointer(wx, wy, true);
      return;
    }
    if (tool === 'walls' && S.dm) {
      G.mode = 'wall';
      const [sx, sy] = snapPoint(wx, wy);
      wallDraft = [sx, sy, sx, sy];
      renderFx();
      return;
    }
    if (tool === 'measure') {
      clearTimeout(rulerTimer);
      G.mode = 'ruler';
      const c = cellOf(wx, wy);
      myRuler = { a: c, b: c };
      renderFx();
      return;
    }
    if (tool === 'ping') {
      G.mode = 'none';
      Store.Act.ping(wx, wy);
      return;
    }
    if (tokEl && S.tokens.has(tokEl.dataset.id)) {
      const t = S.tokens.get(tokEl.dataset.id);
      const rr = tokenRectPx(t);
      Object.assign(G, { mode: 'press-tok', id: t.id, canMove: canMove(t), offX: wx - rr.x, offY: wy - rr.y, c0: t.c, r0: t.r });
      return;
    }
    if (tplEl) {
      G.mode = 'press-tpl';
      G.tpl = tplEl.dataset.tpl;
      return;
    }
    G.mode = 'press-empty';
    G.lp = setTimeout(() => {
      if (G && G.mode === 'press-empty' && !G.moved) {
        Store.Act.ping(wx, wy);
        G.mode = 'none';
      }
    }, 600);
  }
  function onMove(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (G && G.mode === 'pinch') {
      pinchMove();
      return;
    }
    if (!G || e.pointerId !== G.id0) return;
    const dx = e.clientX - G.sx;
    const dy = e.clientY - G.sy;
    if (!G.moved && Math.hypot(dx, dy) > 7) G.moved = true;
    const [wx, wy] = toWorld(e.clientX, e.clientY);
    switch (G.mode) {
      case 'press-tok':
        if (G.moved) {
          if (G.canMove) beginTokDrag(wx, wy);
          else startPanFromPress();
        }
        break;
      case 'tok':
        moveTokDrag(wx, wy);
        break;
      case 'press-empty':
      case 'press-tpl':
        if (G.moved) startPanFromPress();
        break;
      case 'pan':
        V.tx = G.vx + dx;
        V.ty = G.vy + dy;
        applyView();
        break;
      case 'wall': {
        const [ex, ey] = snapPoint(wx, wy);
        wallDraft = [wallDraft[0], wallDraft[1], ex, ey];
        renderFx();
        break;
      }
      case 'ruler': {
        const c = cellOf(wx, wy);
        if (c[0] !== myRuler.b[0] || c[1] !== myRuler.b[1]) {
          myRuler.b = c;
          renderFx();
          Store.pushPresence({ ru: { a: myRuler.a, b: myRuler.b, sc: sceneId } });
        }
        break;
      }
      case 'aim':
        aimPointer(wx, wy, false);
        break;
    }
  }
  function startPanFromPress() {
    clearTimeout(G.lp);
    G.mode = 'pan';
    root.classList.add('panning');
  }
  function onUp(e) {
    const wasPinch = G && G.mode === 'pinch';
    pointers.delete(e.pointerId);
    if (wasPinch) {
      if (pointers.size < 2) G = { mode: 'none', id0: -1 };
      return;
    }
    if (!G || e.pointerId !== G.id0) return;
    clearTimeout(G.lp);
    root.classList.remove('panning');
    const mode = G.mode;
    if (mode === 'press-tok') {
      selectTok(sel === G.id ? null : G.id);
    } else if (mode === 'tok') {
      endTokDrag(e.type === 'pointercancel');
    } else if (mode === 'press-tpl') {
      if (window.UI) UI.openTemplateSheet(G.tpl);
    } else if (mode === 'press-empty') {
      if (sel) selectTok(null);
    } else if (mode === 'wall') {
      const walls = sceneWalls();
      const [x1, y1, x2, y2] = wallDraft;
      if (Math.hypot(x2 - x1, y2 - y1) < 2) {
        // a tap removes the nearest wall under it
        const [px, py] = toWorld(e.clientX, e.clientY);
        const near = 10 / V.z;
        const i = walls.findIndex(([a, b, c, d]) => {
          const L = (c - a) ** 2 + (d - b) ** 2 || 1;
          const t = Math.max(0, Math.min(1, ((px - a) * (c - a) + (py - b) * (d - b)) / L));
          return Math.hypot(px - (a + t * (c - a)), py - (b + t * (d - b))) < near;
        });
        if (i >= 0) {
          walls.splice(i, 1);
          Store.Act.patchScene(sceneId, { walls });
        }
      } else if (walls.length < 600) Store.Act.patchScene(sceneId, { walls: walls.concat([[x1, y1, x2, y2].map((v) => Math.round(v * 10) / 10)]) });
      wallDraft = null;
      renderFx();
    } else if (mode === 'ruler') {
      rulerTimer = setTimeout(() => {
        myRuler = null;
        renderFx();
        Store.pushPresence({ ru: null });
      }, 2600);
    }
    G = null;
  }
  function cancelGesture() {
    if (!G) return;
    clearTimeout(G.lp);
    if (G.mode === 'tok') endTokDrag(true);
    root.classList.remove('panning');
    G = null;
  }
  function startPinch() {
    const [p1, p2] = [...pointers.values()];
    G = { mode: 'pinch', id0: -1, d0: Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1, m0: [(p1.x + p2.x) / 2, (p1.y + p2.y) / 2], z0: V.z, tx0: V.tx, ty0: V.ty };
  }
  function pinchMove() {
    const pts = [...pointers.values()];
    if (pts.length < 2) return;
    const [p1, p2] = pts;
    const d = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
    const m = [(p1.x + p2.x) / 2, (p1.y + p2.y) / 2];
    const r = rect();
    const z = clampZoom((G.z0 * d) / G.d0);
    const wx = (G.m0[0] - r.left - G.tx0) / G.z0;
    const wy = (G.m0[1] - r.top - G.ty0) / G.z0;
    V.z = z;
    V.tx = m[0] - r.left - wx * z;
    V.ty = m[1] - r.top - wy * z;
    applyView();
  }
  function onWheel(e) {
    if (e.target.closest('[data-hud]')) return;
    e.preventDefault();
    const r = rect();
    const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0016));
    zoomAt(e.clientX - r.left, e.clientY - r.top, V.z * k);
  }

  /* ------------------------------------------------------ token drag */
  function beginTokDrag(wx, wy) {
    G.mode = 'tok';
    if (sel !== G.id) {
      sel = G.id;
      renderHud();
    }
    const el = tokEls.get(G.id);
    if (el) el.classList.add('dragging', 'is-sel');
    ghost.hidden = false;
    distTag.hidden = false;
    moveTokDrag(wx, wy);
  }
  function moveTokDrag(wx, wy) {
    const t = S.tokens.get(G.id);
    if (!t) return;
    const s = Math.max(1, Number(t.size) || 1) * grid.size;
    const x = wx - G.offX;
    const y = wy - G.offY;
    const el = tokEls.get(G.id);
    if (el) el.style.transform = `translate(${x}px, ${y}px)`;
    const c = Math.round((x - grid.ox) / grid.size);
    const r = Math.round((y - grid.oy) / grid.size);
    G.c = c;
    G.r = r;
    const gx = grid.ox + c * grid.size;
    const gy = grid.oy + r * grid.size;
    ghost.style.transform = `translate(${gx}px, ${gy}px)`;
    ghost.style.width = ghost.style.height = s + 'px';
    const ft = Core.distanceFt(c - G.c0, r - G.r0, diagRule());
    distTag.textContent = ft + ' ft';
    distTag.style.transform = `translate(${gx + s / 2}px, ${gy}px) translate(-50%, -125%) scale(${1 / V.z})`;
    distTag.style.transformOrigin = '50% 100%';
    Store.pushPresence({ dr: { id: t.id, x: Math.round(x), y: Math.round(y), sc: sceneId } });
  }
  function endTokDrag(cancel) {
    const id = G.id;
    const el = tokEls.get(id);
    if (el) el.classList.remove('dragging');
    ghost.hidden = true;
    distTag.hidden = true;
    Store.pushPresence({ dr: null });
    const t = S.tokens.get(id);
    G.mode = 'none';
    if (!cancel && t && G.c !== undefined && (G.c !== t.c || G.r !== t.r)) {
      pendingMoves.set(id, { c: G.c, r: G.r, t: Date.now() });
      Store.Act.patchToken(id, { c: G.c, r: G.r });
    }
    renderTokens();
  }

  /* -------------------------------------------------------- keyboard */
  function onKey(e) {
    if (e.target.closest('input, textarea, select, [contenteditable]')) return;
    if (document.querySelector('.sheet')) return;
    if (e.key === 'Escape') {
      if (aim) cancelAim();
      else if (sel) selectTok(null);
      else if (tool !== 'select') setTool('select');
      return;
    }
    if (!sel) return;
    const t = S.tokens.get(sel);
    if (!t || !canMove(t)) return;
    const d = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.key];
    if (d) {
      e.preventDefault();
      const c = (pendingMoves.get(sel) || t).c + d[0];
      const r = (pendingMoves.get(sel) || t).r + d[1];
      pendingMoves.set(sel, { c, r, t: Date.now() });
      Store.Act.patchToken(sel, { c, r });
      renderTokens();
    }
  }

  /* ------------------------------------------------------------- HUD */
  function setTool(t, keepAim) {
    tool = t;
    if (!keepAim && aim && t !== 'template') cancelAim();
    root.classList.toggle('tool-measure', t === 'measure');
    root.classList.toggle('tool-ping', t === 'ping');
    renderHud();
  }
  function onHudClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b || !root.contains(b)) return;
    const act = b.dataset.act;
    const UIx = window.UI;
    switch (act) {
      case 'tool': {
        const t = b.dataset.tool;
        if (t === 'template') {
          if (UIx) UIx.openTemplatePicker();
          return;
        }
        setTool(tool === t ? 'select' : t);
        if (t === 'measure' && tool === 'measure' && UIx) UIx.toast('Drag across the map to measure.');
        if (t === 'ping' && tool === 'ping' && UIx) UIx.toast('Tap the map to ping. Long-press works with any tool.');
        break;
      }
      case 'fog-toggle':
        if (!S.dm || !scene) break;
        Store.Act.patchScene(scene.id, { fog: { enabled: !fogOn() } });
        if (UIx) UIx.toast(fogOn() ? 'Fog of war off.' : 'Fog of war on. Players see only what their heroes can see. Draw walls with the pencil tool.');
        break;
      case 'fit':
        fit();
        break;
      case 'scenes':
        if (UIx) UIx.openScenes();
        break;
      case 'dice':
        if (UIx) UIx.openDice();
        break;
      case 'aim-cancel':
        cancelAim();
        break;
      case 'aim-place':
        placeAim();
        break;
      case 'aim-snap':
        if (aim) {
          aim.snap = !aim.snap;
          renderHud();
        }
        break;
      case 'aim-size': {
        if (!aim) return;
        aim.size = Math.max(5, Math.min(400, aim.size + Number(b.dataset.d)));
        renderTemplates();
        renderHud();
        Store.pushPresence({ aim: aimPresence() });
        break;
      }
      case 'init-focus':
        if (b.dataset.tok) focusToken(b.dataset.tok, true);
        break;
      case 'msg-dismiss':
        dismissedMsg = true;
        renderHud();
        break;
      case 'map-retry': {
        const m = scene && scene.mapId && S.maps.get(scene.mapId);
        if (m) S.maps.delete(scene.mapId);
        applyScene();
        break;
      }
      default:
        if (UIx && UIx.boardAct) UIx.boardAct(act, b, sel);
    }
  }
  function onHudKey(e) {
    if (e.key === 'Enter' && e.target.id === 'selHp') {
      e.preventDefault();
      if (window.UI) UI.boardAct('sel-dmg', e.target, sel);
    }
  }
  function renderHud() {
    if (!rail) return;
    const r = (t, ic, label) => `<button type="button" data-act="tool" data-tool="${t}" aria-pressed="${tool === t}" aria-label="${label}" title="${label}">${icon(ic)}</button>`;
    rail.innerHTML = r('select', 'move', 'Move and select') + r('measure', 'ruler', 'Measure distance') +
      `<button type="button" data-act="tool" data-tool="template" aria-pressed="${!!aim}" aria-label="Spell area" title="Spell area">${icon('area')}</button>` +
      r('ping', 'ping', 'Ping a spot') + (S.dm ? `<button type="button" data-act="fog-toggle" aria-pressed="${fogOn()}" aria-label="Fog of war ${fogOn() ? 'on' : 'off'}" title="Fog of war: ${fogOn() ? 'on' : 'off'}">${icon('eye-off')}</button>` + r('walls', 'edit', 'Draw walls (for fog of war): drag to draw, tap a wall to remove it') : '') + '<div class="rsep"></div>' +
      `<button type="button" data-act="fit" aria-label="Fit map to screen" title="Fit map to screen">${icon('fit')}</button>` +
      (S.dm ? `<button type="button" data-act="scenes" aria-label="Scenes and maps" title="Scenes and maps">${icon('map')}</button>` : '');
    renderInitStrip();
    renderBottom();
    renderMsg();
  }
  function renderInitStrip() {
    const UIx = window.UI;
    if (!S.game.combat || !UIx) {
      initStrip.hidden = true;
      return;
    }
    const list = UIx.initOrder(true);
    if (!list.length) {
      initStrip.hidden = true;
      return;
    }
    initStrip.hidden = false;
    let html = `<span class="round-chip">Round ${esc(S.game.round || 1)}</span>`;
    for (const e of list) {
      const tokId = e.tok || (e.char ? ([...S.tokens.values()].find((t) => t.char === e.char) || {}).id : null);
      const v = UIx.initVisual(e);
      html += `<button type="button" class="init-chip${S.game.turn === e.id ? ' now' : ''}" data-act="init-focus" data-tok="${esc(tokId || '')}">
        <span class="disc sm${v.monster ? ' monster' : ''}" style="--c:${v.color}">${esc(initials(v.name))}</span><span>${esc(v.name)}</span><b>${esc(e.val)}</b></button>`;
    }
    initStrip.innerHTML = html;
    const now = initStrip.querySelector('.now');
    if (now && now.scrollIntoView) now.scrollIntoView({ block: 'nearest', inline: 'center' });
  }
  let bottomHtml = '';
  function setBottom(h) {
    if (h === bottomHtml) return;
    bottomHtml = h;
    // keep a half-typed amount and focus through a refresh
    const a = document.activeElement;
    const keep = a && bottom.contains(a) && a.id ? { id: a.id, v: a.value } : null;
    bottom.innerHTML = h;
    if (keep) {
      const n = document.getElementById(keep.id);
      if (n) {
        n.value = keep.v;
        n.focus({ preventScroll: true });
      }
    }
  }
  function renderBottom() {
    const UIx = window.UI;
    if (aim) {
      const geo = aimGeom();
      const hit = tokensInTemplate(geo);
      const names = hit.tokens.map((t) => tokInfo(t).name);
      const how = aim.shape === 'cone' || aim.shape === 'line' ? (aim.anchor ? 'Drag to aim from the caster.' : 'Drag to aim. Drag the white dot to move it.') : 'Drag to place it.';
      setBottom(`<div class="aimbar">
        <div class="main"><div class="title">${esc(tplLabel(geo))}</div>
        <div class="small muted">${how} ${hit.cells.length} squares${names.length ? ' · ' + esc(names.slice(0, 4).join(', ')) + (names.length > 4 ? ' +' + (names.length - 4) : '') : ''}</div></div>
        <div class="btn-row"><button type="button" class="btn btn-sm btn-icon" data-act="aim-size" data-d="-5" aria-label="Smaller">${icon('minus')}</button>
        <button type="button" class="btn btn-sm btn-icon" data-act="aim-size" data-d="5" aria-label="Larger">${icon('plus')}</button>
        <button type="button" class="btn btn-ghost btn-sm" data-act="aim-snap" aria-pressed="${aim.snap}">${aim.snap ? 'Snap on' : 'Snap off'}</button>
        <button type="button" class="btn btn-ghost btn-sm" data-act="aim-cancel">Cancel</button>
        <button type="button" class="btn btn-primary btn-sm" data-act="aim-place">${aim.id ? 'Move here' : 'Place'}</button></div></div>`);
      return;
    }
    if (sel && S.tokens.has(sel) && UIx) {
      setBottom(UIx.selCardHtml(S.tokens.get(sel), tokInfo(S.tokens.get(sel))));
      return;
    }
    const pending = Store.relayPending();
    if (S.relay && (pending || !S.executorPresent)) {
      setBottom(`<div class="aimbar" style="border-color:var(--line-2)"><div class="main small">${S.executorPresent ? 'Sending your moves through the DM’s table…' : 'Your moves will appear once someone with edit access opens the table.'}</div></div>`);
      return;
    }
    setBottom('');
  }
  function renderMsg() {
    if (!msg) return;
    let html = '';
    const m = scene && scene.mapId ? S.maps.get(scene.mapId) : null;
    if (scene && scene.mapId && m && m.status === 'loading') {
      html = `<h3>Unrolling the map</h3><div class="progress"><i style="width:${Math.round((m.progress || 0) * 100)}%"></i></div><p class="hint">Large maps take a moment the first time.</p>`;
    } else if (scene && scene.mapId && m && m.status === 'error') {
      html = `<h3>This map didn’t load</h3><p class="hint">Part of the image is missing or the connection dropped.</p><div class="btn-row"><button class="btn btn-primary" data-act="map-retry">Try again</button></div>`;
    } else if (scene && scene.virtual && !dismissedMsg && S.loaded !== false && !sceneTokens().length) {
      if (S.dm) {
        html = `<h3>Set up the table</h3><p class="hint">Upload a battle map, or start on this blank grid. You can calibrate the grid to match your map’s squares.</p>
          <div class="btn-row"><button class="btn btn-primary" data-act="scene-upload">${icon('upload')} Upload a map</button>
          <button class="btn" data-act="scene-sample">${icon('sparkle')} Sample dungeon</button>
          <button class="btn btn-ghost" data-act="msg-dismiss">Use blank grid</button></div>`;
      } else {
        html = `<h3>Waiting for a map</h3><p class="hint">The DM hasn’t added one yet. You can still make your hero and put a token on this grid.</p>
          <div class="btn-row"><button class="btn btn-primary" data-act="go-heroes">Make a hero</button><button class="btn btn-ghost" data-act="msg-dismiss">Close</button></div>`;
      }
    }
    msg.hidden = !html;
    if (html) msg.innerHTML = html;
  }

  function renderAll() {
    renderTokens();
    renderTemplates();
    renderFx();
    renderHud();
  }

  return {
    init, refresh: () => applyScene(), setTool, startAim, editTemplate, cancelAim, focusToken, selectTok, freeSpot,
    viewCenterCell, previewGrid, tokInfo, canMove, ownsToken, tokensInTemplate, tplLabel, fit,
    selected: () => sel,
    sceneId: () => sceneId,
    grid: () => grid,
    dims: () => [W, H],
    getView: () => ({ z: V.z, tx: V.tx, ty: V.ty, sc: sceneId }),
    setView(v) {
      if (v && v.sc === sceneId && v.z) {
        V.z = v.z;
        V.tx = v.tx;
        V.ty = v.ty;
        fitted = true;
        applyView();
      }
    },
    initials, safeColor, safeImg,
  };
})();
