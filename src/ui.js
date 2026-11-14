/* ===================================================================
   ui.js — panels, sheets and rolls: heroes (builder + sheet), the
   encounter builder, combat tracker, dice log, scenes, settings.
   =================================================================== */
const UI = (() => {
  'use strict';
  const S = Store.S;
  const D = Store.Data;
  const $ = (q, el) => (el || document).querySelector(q);

  /* ------------------------------------------------------ html utils */
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const raw = (s) => ({ __html: String(s) });
  const val = (v) => (v == null || v === false ? '' : Array.isArray(v) ? v.map(val).join('') : v.__html !== undefined ? v.__html : esc(v));
  function html(strings, ...vals) {
    let out = strings[0];
    for (let i = 0; i < vals.length; i++) out += val(vals[i]) + strings[i + 1];
    return raw(out);
  }
  // only touches the page when the markup really changed (tabs and the people dots are redrawn very often)
  const setHTML = (el, h) => {
    const str = typeof h === 'string' ? h : val(h);
    if (el._html === str) return;
    el._html = str;
    el.innerHTML = str;
  };
  const setText = (el, t) => {
    if (el && el.textContent !== t) el.textContent = t;
  };
  const icon = (id) => raw(`<svg class="ic" aria-hidden="true"><use href="#i-${id}"/></svg>`);
  const initials = Board.initials;
  const safeColor = Board.safeColor;
  const safeImg = Board.safeImg;
  const fmtMod = Core.fmtMod;
  const ord = (n) => n + (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th');
  const plural = (n, a, b) => n + ' ' + (n === 1 ? a : b || a + 's');
  const isWide = () => window.matchMedia('(min-width: 960px)').matches;
  const titleCase = (s) => String(s || '').replace(/\b[a-z]/g, (c) => c.toUpperCase());

  function disc(name, color, img, cls) {
    const im = safeImg(img);
    return html`<span class="disc ${cls || ''}" style="--c:${safeColor(color) || '#8fb0a5'}">${im ? raw(`<img alt="" src="${esc(im)}">`) : initials(name)}</span>`;
  }
  function hpBar(hp, max) {
    if (!max) return '';
    const r = Math.max(0, Math.min(1, hp / max));
    return html`<div class="hpbar"><i class="${r <= 0.25 ? 'low' : r <= 0.5 ? 'mid' : ''}" style="width:${Math.round(r * 100)}%"></i></div>`;
  }
  function healthWord(hp, max) {
    if (!max) return '';
    if (hp <= 0) return 'Down';
    const r = hp / max;
    return r >= 1 ? 'Unhurt' : r > 0.5 ? 'Hurt' : 'Bloodied';
  }

  /* ------------------------------------------------------ file helpers */
  // claude.ai pages save through the downloads capability; elsewhere a normal download link
  async function saveFile(filename, text) {
    try {
      const dl = window.claude && window.claude.use ? await window.claude.use('downloads') : null;
      if (dl) {
        await dl.save({ filename, data: new Blob([text], { type: 'application/json' }) });
        return;
      }
    } catch (e) { /* fall back to a link */ }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }
  function pickFile(accept) {
    return new Promise((res) => {
      const i = document.createElement('input');
      i.type = 'file';
      i.accept = accept;
      i.onchange = () => res(i.files && i.files[0]);
      i.click();
    });
  }
  const stamp = () => new Date().toISOString().slice(0, 10);

  /* ---------------------------------------------------------- toasts */
  function toast(text, kind, opts) {
    const box = $('#toasts');
    if (!box) return;
    const el = document.createElement('div');
    el.className = 'toast' + (kind === 'warn' ? ' warn' : '');
    if (opts && opts.color) el.style.setProperty('--c', opts.color);
    if (opts && opts.node) el.appendChild(opts.node);
    else {
      const m = document.createElement('div');
      m.className = 't-main';
      m.textContent = text;
      el.appendChild(m);
    }
    box.appendChild(el);
    while (box.children.length > (isWide() ? 3 : 2)) box.firstChild.remove();
    setTimeout(() => el.remove(), (opts && opts.ms) || 4200);
  }
  function rollToast(entry) {
    const node = document.createElement('div');
    node.style.display = 'contents';
    const main = document.createElement('div');
    main.className = 't-main';
    const who = document.createElement('div');
    who.className = 't-who';
    who.textContent = (entry.who || 'Someone') + (entry.priv ? ' · hidden roll' : '');
    const lbl = document.createElement('div');
    lbl.textContent = entry.label || 'Roll';
    main.append(who, lbl);
    const tot = document.createElement('div');
    tot.className = 't-total';
    tot.textContent = (entry.rolls || []).map((r) => r.t).join(' · ');
    node.append(main, tot);
    toast('', null, { node, color: safeColor(entry.col) || undefined });
  }

  /* ---------------------------------------------------------- sheets */
  function restoreFocus(container, focusId, caret) {
    if (!focusId) return;
    const f = document.getElementById(focusId);
    if (!f || !container.contains(f) || f.tagName === 'BUTTON') return;
    f.focus({ preventScroll: true });
    if (caret != null && typeof f.setSelectionRange === 'function' && /^(text|search)$/.test(f.type)) {
      try {
        f.setSelectionRange(caret, caret);
      } catch (e) { /* ignore */ }
    }
  }
  function focusInfo(container) {
    const a = document.activeElement;
    if (!a || !container.contains(a) || !a.id) return [null, null];
    let caret = null;
    try {
      caret = typeof a.selectionStart === 'number' ? a.selectionStart : null;
    } catch (e) { /* number inputs throw */ }
    return [a.id, caret];
  }
  const Sheet = {
    cur: null,
    open(o) {
      Sheet.close(true);
      const host = $('#sheetRoot');
      const wrap = document.createElement('div');
      wrap.innerHTML = `<div class="scrim" data-close></div><div class="sheet${o.wide ? ' wide' : ''}" role="dialog" aria-modal="true" tabindex="-1">
        <div class="sheet-head"><h2></h2><button type="button" class="btn btn-ghost btn-icon btn-sm" data-close aria-label="Close">${icon('x').__html}</button></div>
        <div class="sheet-body"></div></div>`;
      host.appendChild(wrap);
      wrap.querySelector('h2').textContent = o.title;
      wrap.querySelector('.sheet').setAttribute('aria-label', o.title);
      const body = wrap.querySelector('.sheet-body');
      const cur = { wrap, body, o, unsubs: [], last: '' };
      Sheet.cur = cur;
      const draw = () => {
        if (Sheet.cur !== cur) return;
        const h = o.render();
        const s = h && h.__html !== undefined ? h.__html : String(h || '');
        if (s === cur.last) return;
        cur.last = s;
        const [fid, caret] = focusInfo(body);
        const st = body.scrollTop;
        body.innerHTML = s;
        body.scrollTop = st;
        restoreFocus(body, fid, caret);
      };
      cur.draw = draw;
      draw();
      (o.live || []).forEach((ev) => cur.unsubs.push(Store.on(ev, () => {
        if (cur.typing) return;
        draw();
      })));
      wrap.addEventListener('click', (e) => {
        if (e.target.closest('[data-close]')) {
          Sheet.close();
          return;
        }
        const b = e.target.closest('[data-act]');
        if (b && body.contains(b) && o.act) o.act(b.dataset.act, b, e, draw);
      });
      wrap.addEventListener('submit', (e) => {
        e.preventDefault();
        if (o.submit) o.submit(e.target, draw, e);
      });
      body.addEventListener('input', (e) => {
        if (o.input) o.input(e.target, draw, e);
      });
      body.addEventListener('change', (e) => {
        if (o.change) o.change(e.target, draw, e);
      });
      body.addEventListener('focusin', (e) => {
        if (e.target.matches('input[type=text], input[type=search], input[type=number], textarea')) cur.typing = true;
      });
      body.addEventListener('focusout', () => {
        cur.typing = false;
      });
      wrap.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') Sheet.close();
      });
      setTimeout(() => {
        const s = wrap.querySelector('.sheet');
        if (s && !s.contains(document.activeElement)) s.focus({ preventScroll: true });
      }, 30);
      return cur;
    },
    close(silent) {
      const c = Sheet.cur;
      if (!c) return;
      Sheet.cur = null;
      c.unsubs.forEach((u) => u());
      c.wrap.remove();
      if (!silent && c.o.onClose) c.o.onClose();
    },
  };

  // An in-sheet confirmation, since the viewer has no confirm()
  function confirmSheet(title, text, okLabel, onOk, danger) {
    Sheet.open({
      title,
      render: () => html`<p class="prose">${text}</p><div class="btn-row end"><button type="button" class="btn btn-ghost" data-close>Keep it</button><button type="button" class="btn ${danger === false ? 'btn-primary' : 'btn-danger'}" data-act="ok">${okLabel}</button></div>`,
      act: (a) => {
        if (a === 'ok') {
          Sheet.close(true);
          onOk();
        }
      },
    });
  }

  /* ----------------------------------------------------------- rolls */
  const ROLL_MODE = { normal: '', adv: ' (advantage)', dis: ' (disadvantage)' };
  const mk = (r, l, ty) => (r ? Object.assign({ l, e: r.e, t: r.t, p: r.p }, r.nat != null ? { nat: r.nat } : {}, ty ? { ty } : {}) : null);
  let dmPrivate = Store.LS.get('tt.dmPrivate', false);
  function postRoll(entry) {
    const e = Object.assign({ kind: 'roll' }, entry);
    e.rolls = (e.rolls || []).filter(Boolean);
    if (!e.rolls.length) return;
    if (e.priv === undefined) e.priv = S.dm && dmPrivate ? 1 : 0;
    if (!e.who) e.who = S.me.nick || 'Someone';
    Store.Act.log(e);
    rollToast(Object.assign({ col: S.me.color }, e));
  }
  function rollD20(who, label, bonus, mode) {
    const m = mode || 'normal';
    const r = Core.roll(Core.d20Expr(bonus, m));
    postRoll({ who, label: label + ROLL_MODE[m], rolls: [mk(r, '')] });
    return r;
  }
  // opts: { gwf: reroll 1s and 2s on the weapon's damage, brutal: extra dice on a crit }
  function rollAttack(who, name, hit, dmg, ty, mode, extra, critMin, opts) {
    const o = opts || {};
    const m = mode && mode !== 'normal' ? mode : o.adv ? 'adv' : 'normal';
    const a = Core.roll(Core.d20Expr(hit, m));
    const crit = a && a.nat >= (critMin || 20);
    const rolls = [mk(a, 'To hit')];
    (Array.isArray(dmg) ? dmg : [[dmg, ty]]).forEach(([e, t], i) => {
      if (!e) return;
      let ex = crit ? Core.critExpr(e) : e;
      if (crit && i === 0 && o.brutal) ex += '+' + o.brutal;
      const d = Core.roll(ex, i === 0 && o.gwf ? { reroll: 2 } : null);
      rolls.push(mk(d, crit ? 'Crit damage' : 'Damage', t));
    });
    postRoll(Object.assign({ who, label: name + ROLL_MODE[m], rolls }, extra || {}));
  }
  function rollExpr(who, label, expr, ty, extra) {
    const r = Core.roll(expr);
    if (!r) {
      toast('That isn’t a dice expression I can read. Try something like 2d6+3.', 'warn');
      return null;
    }
    postRoll(Object.assign({ who, label, rolls: [mk(r, '', ty)] }, extra || {}));
    return r;
  }

  /* ---------------------------------------------------------- layout */
  const TABS = [
    { id: 'table', label: 'Table', icon: 'grid' },
    { id: 'heroes', label: 'Heroes', icon: 'helm' },
    { id: 'encounter', label: 'Encounter', icon: 'swords', dm: true },
    { id: 'combat', label: 'Combat', icon: 'hourglass' },
    { id: 'log', label: 'Dice', icon: 'scroll' },
    { id: 'homebrew', label: 'Homebrew', icon: 'sparkle' },
  ];
  let tab = 'table';
  let sideTab = 'heroes';
  const panels = {};
  const dirty = new Set();
  let unseenLog = false;

  function currentPanel() {
    if (isWide()) return sideTab;
    return tab === 'table' ? null : tab;
  }
  function renderTabs() {
    const tabs = TABS.filter((t) => !t.dm || S.dm);
    const nav = $('#tabs');
    setHTML(nav, tabs.map((t) => html`<button type="button" class="tab" data-tab="${t.id}" aria-selected="${tab === t.id}"><span class="${t.id === 'log' && unseenLog && tab !== 'log' ? 'tab-badge' : ''}">${icon(t.icon)}</span><span>${t.label}</span></button>`));
    setHTML($('#sideTabs'), tabs.filter((t) => t.id !== 'table').map((t) => html`<button type="button" class="side-tab" data-tab="${t.id}" aria-selected="${sideTab === t.id}">${icon(t.icon)}<span>${t.label}</span></button>`));
  }
  function show(id) {
    if (id === 'encounter' && !S.dm) id = 'heroes';
    if (isWide()) {
      if (id !== 'table') sideTab = id;
      tab = id;
    } else tab = id;
    if (id === 'log') unseenLog = false;
    applyPanels();
    renderTabs();
  }
  function applyPanels() {
    const p = currentPanel();
    $('#side').hidden = !p;
    for (const k in panels) panels[k].el.hidden = k !== p;
    if (p) renderPanel(p, true);
    Board.refresh();
  }
  function renderPanel(id, force) {
    const p = panels[id];
    if (!p) return;
    if (currentPanel() !== id) {
      dirty.add(id);
      return;
    }
    if (p.typing && !force) {
      dirty.add(id);
      return;
    }
    dirty.delete(id);
    const s = html`<div class="panel-in">${p.render()}</div>`.__html;
    if (s === p.last && p.el.firstChild) return;
    p.last = s;
    const st = p.el.scrollTop;
    const [fid, caret] = focusInfo(p.el);
    p.el.innerHTML = s;
    p.el.scrollTop = st;
    restoreFocus(p.el, fid, caret);
    if (p.after) p.after();
  }
  const pending = new Set();
  let raf = 0;
  function schedule(...ids) {
    ids.forEach((i) => pending.add(i));
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const list = [...pending];
      pending.clear();
      list.forEach((i) => renderPanel(i));
    });
  }
  function panel(id, def) {
    const el = document.getElementById('p-' + id);
    panels[id] = Object.assign({ el, typing: false }, def);
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (b && el.contains(b) && def.act) def.act(b.dataset.act, b, e);
    });
    // Enter in an add-item box acts like its Add button
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing || !e.target.matches || !e.target.matches('.inv-add input')) return;
      const b = e.target.closest('.inv-add').querySelector('[data-act$="-add"]');
      if (!b || !def.act) return;
      e.preventDefault();
      def.act(b.dataset.act, b, e);
      panels[id].typing = false;
      renderPanel(id, true);
    });
    el.addEventListener('input', (e) => def.input && def.input(e.target, e));
    el.addEventListener('change', (e) => def.change && def.change(e.target, e));
    el.addEventListener('focusin', (e) => {
      if (e.target.matches('input[type=text], input[type=search], input[type=number], textarea')) panels[id].typing = true;
    });
    el.addEventListener('focusout', () => {
      panels[id].typing = false;
      // wait so a tap that moved focus still lands on its button
      if (dirty.has(id)) setTimeout(() => {
        if (!panels[id].typing && dirty.has(id)) renderPanel(id);
      }, 350);
    });
  }

  /* ------------------------------------------------------- top bar */
  function renderTop() {
    const sc = Store.activeScene();
    setText($('#sceneName'), sc.name || 'Blank grid');
    setText(document.querySelector('.brand-name'), Store.campaignName());
    const conn = $('#conn');
    const hostDown = S.p2p && S.p2p.role === 'host' && S.p2p.status !== 'online';
    const connCls = 'conn ' + (S.mode === 'local' ? 'solo' : S.loaded && !S.offline && !hostDown ? 'live' : '');
    if (conn.className !== connCls) conn.className = connCls;
    const connTitle = S.mode === 'local' ? 'Solo mode: this device only' : S.offline ? 'Reconnecting…' : S.loaded ? 'Live' : 'Connecting…';
    if (conn.title !== connTitle) conn.title = connTitle;
    const pill = $('#statusPill');
    let st = '';
    if (S.mode === 'local') st = 'Solo · this device';
    else if (S.p2p && S.p2p.role === 'host') st = { online: 'Hosting online', starting: 'Going online…', reconnecting: 'Reconnecting…' }[S.p2p.status] || 'Not online';
    else if (S.offline) st = 'Reconnecting…';
    else if (S.readOnly) st = 'View only';
    else if (S.stale && !S.loaded) st = 'Can’t reach the table';
    else if (S.relay) st = 'Limited access';
    if (pill.hidden !== !st) pill.hidden = !st;
    setText(pill, st);
    const peers = [];
    const seen = new Set();
    S.peers.forEach((p) => {
      const key = (p.presence && p.presence.pk) || p.peer;
      if (seen.has(key) || p.kind !== 'viewer') return;
      seen.add(key);
      peers.push(p);
    });
    const shown = peers.slice(0, 5);
    setHTML($('#peers'), [shown.map((p) => {
      const pr = p.presence || {};
      const nm = pr.nm || (p.isMe ? S.me.nick || 'You' : 'Guest');
      return html`<span class="peer-dot" style="--c:${safeColor(pr.col) || '#888'}" title="${nm}${pr.dm ? ' (DM)' : ''}${p.isMe ? ' · you' : ''}">${initials(nm)}</span>`;
    }), peers.length > 5 ? html`<span class="peer-dot peer-more">+${peers.length - 5}</span>` : '']);
  }

  /* ================================================= HEROES PANEL */
  const H = { view: 'list', id: null, draft: null, editId: null, mode: 'normal', spellQ: '', spellLvl: 0, wq: '' };
  const DRAFT_KEY = 'tt.draft';

  function rulesReady() {
    return !!D.rules;
  }
  function myChars() {
    return [...S.chars.values()].filter((c) => c.owner === S.me.pk);
  }
  function canEditChar(ch) {
    return !!ch && !S.readOnly && (S.dm || ch.owner === S.me.pk);
  }
  function heroLine(ch) {
    const R = D.rules;
    if (!R) return '';
    const race = ch.subrace && R.subraces[ch.subrace] ? R.subraces[ch.subrace].n : R.races[ch.race] ? R.races[ch.race].n : '';
    const cls = R.classes[ch.cls] ? R.classes[ch.cls].n : '';
    return `Level ${ch.level || 1} ${race} ${cls}`.replace(/\s+/g, ' ').trim();
  }
  function tokenForChar(id) {
    const sid = Board.sceneId();
    for (const t of S.tokens.values()) if (t.char === id && t.scene === sid) return t;
    return null;
  }

  function heroesRender() {
    if (!rulesReady()) return html`<div class="empty"><h3>Opening the rulebook…</h3><p class="hint">Loading classes, races and gear.</p></div>`;
    if (H.view === 'build') return builderHtml();
    if (H.view === 'sheet') {
      if (S.chars.has(H.id)) return sheetHtml(S.chars.get(H.id));
      // a brand-new hero can take a moment to come back from the store
      return html`<div class="panel-head"><button type="button" class="btn btn-ghost btn-sm" data-act="hero-back">${icon('back')} Heroes</button></div>
        <div class="empty"><h3>${S.loaded ? 'Opening this hero…' : 'Loading heroes…'}</h3><p class="hint">If it doesn’t appear, it may have been deleted. Go back to the list.</p></div>`;
    }
    return heroListHtml();
  }
  function heroListHtml() {
    const all = [...S.chars.values()].sort((a, b) => (b.owner === S.me.pk) - (a.owner === S.me.pk) || String(a.name).localeCompare(String(b.name)));
    const rows = all.map((ch) => {
      const hp = Store.heroHp(ch);
      const d = Store.derived(ch);
      const mine = ch.owner === S.me.pk;
      return html`<button type="button" class="row tap" data-act="open-hero" data-id="${ch.id}">
        ${disc(ch.name, ch.color, ch.portrait)}
        <span class="main"><span class="title" style="display:block">${ch.name || 'Unnamed hero'}${S.myChar === ch.id ? html` <span class="badge brass">Playing</span>` : ''}</span>
        <span class="sub" style="display:block">${heroLine(ch)}${mine ? ' · yours' : ''}</span>
        <span style="display:block;margin-top:5px">${hpBar(hp.hp, hp.max)}</span></span>
        <span class="num small" style="text-align:right">${hp.hp != null ? `${hp.hp}/${hp.max}` : ''}<br><span class="muted">AC ${d ? d.ac : '—'}</span></span></button>`;
    });
    return html`<div class="panel-head"><h2>Heroes</h2><button type="button" class="btn btn-primary" data-act="new-hero">${icon('plus')} New hero</button></div>
      ${all.length ? html`<div class="list">${rows}</div>` : html`<div class="empty"><h3>No heroes at this table yet</h3>
        <p class="hint">Build a 5e character from the SRD races and classes. Their token, hit points and spells come with them to the map.</p>
        <button type="button" class="btn btn-primary" data-act="new-hero">${icon('plus')} Create a hero</button></div>`}
      <p class="hint">Rolls from a hero’s sheet show up for everyone in the dice log.</p>
      ${partyCardHtml()}`;
  }

  /* ---------------------------------------------------- inventory */
  // Hero items live in the hero (ch.inv, ch.coins); party items are party/* docs, party coins in game/state.
  const COINS = [['pp', 'Platinum'], ['gp', 'Gold'], ['ep', 'Electrum'], ['sp', 'Silver'], ['cp', 'Copper']];
  const cleanQty = (v) => Math.max(0, Math.min(9999, Math.floor(Number(v) || 0)));
  function coinsHtml(coins, prefix, edit) {
    const c = coins || {};
    return html`<div class="coins">${COINS.map(([k, n]) => html`<label class="coin"><span>${k}</span><input type="number" id="${prefix}-${k}" data-coin="${k}" value="${cleanQty(c[k])}" min="0" max="9999" inputmode="numeric" aria-label="${n} pieces" ${edit ? '' : 'readonly'}></label>`)}</div>`;
  }
  // Common adventuring gear from the SRD 5.1 equipment chapter (names only). Suggestions, not limits: any text can be added.
  const GEAR_NAMES = ["Abacus", "Acid (vial)", "Alchemist's fire (flask)", "Antitoxin (vial)", "Arrows (20)", "Backpack", "Ball bearings (bag of 1,000)", "Barrel", "Basket", "Bedroll", "Bell", "Blanket", "Block and tackle", "Blowgun needles (50)", "Book", "Bottle (glass)", "Bucket", "Caltrops (bag of 20)", "Candle", "Case (crossbow bolt)", "Case (map or scroll)", "Chain (10 feet)", "Chalk (1 piece)", "Chest", "Climber's kit", "Clothes (common)", "Clothes (costume)", "Clothes (fine)", "Clothes (traveler's)", "Component pouch", "Crossbow bolts (20)", "Crowbar", "Dice set", "Disguise kit", "Dragonchess set", "Druidic focus", "Fishing tackle", "Flask", "Forgery kit", "Grappling hook", "Hammer", "Hammer (sledge)", "Healer's kit", "Herbalism kit", "Holy symbol", "Holy water (flask)", "Hourglass", "Hunting trap", "Ink (1 ounce bottle)", "Ink pen", "Jug", "Ladder (10-foot)", "Lamp", "Lantern (bullseye)", "Lantern (hooded)", "Lock", "Magnifying glass", "Manacles", "Mess kit", "Mirror (steel)", "Navigator's tools", "Oil (flask)", "Paper (one sheet)", "Parchment (one sheet)", "Perfume (vial)", "Pick (miner's)", "Piton", "Playing card set", "Poison (basic vial)", "Poisoner's kit", "Pole (10-foot)", "Pot (iron)", "Potion of healing", "Potion of greater healing", "Potion of superior healing", "Potion of supreme healing", "Pouch", "Quiver", "Ram (portable)", "Rations (1 day)", "Robes", "Rope (hempen", "50 feet)", "Rope (silk", "50 feet)", "Sack", "Scale (merchant's)", "Sealing wax", "Shovel", "Signal whistle", "Signet ring", "Sling bullets (20)", "Soap", "Spellbook", "Spike (iron)", "Spyglass", "Tent (two-person)", "Thieves' tools", "Tinderbox", "Torch", "Vial", "Waterskin", "Whetstone", "Alchemist's supplies", "Brewer's supplies", "Calligrapher's supplies", "Carpenter's tools", "Cartographer's tools", "Cobbler's tools", "Cook's utensils", "Glassblower's tools", "Jeweler's tools", "Leatherworker's tools", "Mason's tools", "Painter's supplies", "Potter's tools", "Smith's tools", "Tinker's tools", "Weaver's tools", "Woodcarver's tools", "Bagpipes", "Drum", "Dulcimer", "Flute", "Lute", "Lyre", "Horn", "Pan flute", "Shawm", "Viol", "Burglar's pack", "Diplomat's pack", "Dungeoneer's pack", "Entertainer's pack", "Explorer's pack", "Priest's pack", "Scholar's pack", "Camel", "Donkey", "Mule", "Draft horse", "Riding horse", "Warhorse", "Pony", "Mastiff", "Elephant", "Saddle (riding)", "Saddle (pack)", "Saddlebags", "Barding", "Carriage", "Cart", "Chariot", "Sled", "Wagon", "Rowboat", "Keelboat", "Sailing ship", "Galley", "Longship", "Warship", "Flour (1 pound)", "Wheat (1 pound)", "Salt (1 pound)", "Iron (1 pound)", "Copper (1 pound)", "Silver (1 pound)", "Gold (1 pound)", "Platinum (1 pound)", "Ginger (1 pound)", "Cinnamon (1 pound)", "Pepper (1 pound)", "Cloves (1 pound)", "Chicken", "Goat", "Pig", "Sheep", "Cow", "Ox", "Linen (1 square yard)", "Cotton cloth (1 square yard)", "Silk (1 square yard)", "Ale (gallon)", "Wine (common", "pitcher)", "Wine (fine", "bottle)", "Meat (chunk)", "Bread (loaf)", "Cheese (hunk)"];
  function itemSuggestions() {
    const R = D.rules;
    const names = new Set(GEAR_NAMES);
    if (R) {
      Object.values(R.weapons).forEach((w) => names.add(w.n));
      Object.values(R.armor).forEach((a) => names.add(a.n));
    }
    S.hb.forEach((f) => f.kind === 'item' && f.name && names.add(f.name));
    return html`<datalist id="itemNames">${[...names].sort().map((n) => html`<option value="${n}"></option>`)}</datalist>`;
  }
  function itemRow(it, i, edit, scope, attunedCount) {
    const magic = it.hb && S.hb.get(it.hb);
    const isMagic = magic && magic.kind === 'item';
    const nameBit = isMagic ? html`<button type="button" class="linkish" data-act="hb-read" data-id="${magic.id}">${it.n || magic.name}</button>` : it.n || 'Item';
    const toggles = isMagic && scope === 'inv' ? html`<div class="chips" style="flex-basis:100%">${html`<button type="button" class="chip" data-act="inv-eq" data-i="${i}" aria-pressed="${!!it.eq}" ${edit ? '' : 'disabled'}>${it.eq ? 'Equipped' : 'Equip'}</button>`}
      ${magic.attune ? html`<button type="button" class="chip" data-act="inv-at" data-i="${i}" aria-pressed="${!!it.at}" ${edit && (it.at || (attunedCount || 0) < 3) ? '' : 'disabled'}>${it.at ? 'Attuned' : 'Attune'}</button>` : ''}
      <span class="small muted">${titleCase(magic.rarity || 'uncommon')}${it.eq && (!magic.attune || it.at) ? ' · working' : magic.attune && !it.at ? ' · needs attunement' : ''}</span></div>` : '';
    return html`<div class="row inv-row"><span class="main"><span class="title" style="display:block">${nameBit}</span>${it.note ? html`<span class="sub" style="display:block">${it.note}</span>` : ''}</span>
      <div class="stepper"><button type="button" data-act="${scope}-q" data-i="${i}" data-d="-1" aria-label="One fewer" ${edit && cleanQty(it.q) > 0 ? '' : 'disabled'}>−</button><span class="val num">${cleanQty(it.q)}</span><button type="button" data-act="${scope}-q" data-i="${i}" data-d="1" aria-label="One more" ${edit ? '' : 'disabled'}>+</button></div>
      ${edit ? html`<button type="button" class="btn btn-ghost btn-sm" data-act="${scope}-edit" data-i="${i}" aria-label="Edit ${it.n || 'item'}">Edit</button><button type="button" class="btn btn-ghost btn-sm" data-act="${scope}-move" data-i="${i}">${scope === 'inv' ? 'To party' : 'Take'}</button><button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="${scope}-del" data-i="${i}" aria-label="Remove ${it.n || 'item'}">${icon('trash')}</button>` : ''}${toggles}</div>`;
  }
  function addItemHtml(scope) {
    return html`<div class="inv-add"><input type="text" id="${scope}Name" list="itemNames" maxlength="60" placeholder="Type any item name…" autocomplete="off" aria-label="Item name">
      <input type="number" id="${scope}Qty" value="1" min="1" max="9999" inputmode="numeric" aria-label="How many" style="width:70px">
      <input type="text" id="${scope}Note" maxlength="120" placeholder="Note (optional)" autocomplete="off" aria-label="Note">
      <button type="button" class="btn" data-act="${scope}-add">${icon('plus')} Add</button>
      <p class="hint inv-hint">Suggestions are optional: type anything.</p></div>`;
  }
  function invCardHtml(ch, edit) {
    const inv = Array.isArray(ch.inv) ? ch.inv : [];
    return html`<div class="card"><div class="card-title"><h3>Inventory</h3><span class="small muted">${inv.length ? plural(inv.length, 'item') : ''}</span></div>
      ${coinsHtml(ch.coins, 'coin', edit)}
      ${inv.length ? html`<div class="list">${inv.map((it, i) => itemRow(it, i, edit, 'inv', inv.filter((x) => x.at).length))}</div>` : html`<p class="hint">Nothing carried yet.</p>`}
      ${inv.some((x) => x.at) ? html`<p class="hint">Attuned to ${inv.filter((x) => x.at).length} of 3 items.</p>` : ''}
      ${edit ? addItemHtml('inv') : ''}</div>`;
  }
  function partyItems() {
    return [...S.party.values()].sort((a, b) => (a.ts || 0) - (b.ts || 0));
  }
  function partyCardHtml() {
    const edit = !S.readOnly;
    const items = partyItems();
    return html`<div class="card"><div class="card-title"><h3>Party inventory</h3><span class="small muted">Shared by everyone</span></div>
      ${coinsHtml(S.game.coins, 'pcoin', edit)}
      ${items.length ? html`<div class="list">${items.map((it, i) => itemRow(it, i, edit, 'party'))}</div>` : html`<p class="hint">The party’s shared loot goes here.</p>`}
      ${edit ? addItemHtml('party') : ''}</div>${itemSuggestions()}`;
  }
  // reads the add-item fields of a scope ("inv" or "party")
  function readNewItem(scope) {
    const name = String(($('#' + scope + 'Name') || {}).value || '').trim().slice(0, 60);
    if (!name) {
      toast('Type the item’s name first.', 'warn');
      const n = $('#' + scope + 'Name');
      if (n) n.focus();
      return null;
    }
    const hbItem = [...S.hb.values()].find((f) => f.kind === 'item' && f.name === name);
    const it = { id: Store.uid('v'), n: name, q: Math.max(1, cleanQty(($('#' + scope + 'Qty') || {}).value) || 1), note: String(($('#' + scope + 'Note') || {}).value || '').trim().slice(0, 120) };
    if (hbItem) it.hb = hbItem.id;
    // empty the fields so the next item starts fresh
    ['Name', 'Note'].forEach((f) => {
      const el = $('#' + scope + f);
      if (el) el.value = '';
    });
    const qty = $('#' + scope + 'Qty');
    if (qty) qty.value = '1';
    return it;
  }
  // small sheet to rename an item and change its note; onSave(name, note)
  function openItemEdit(it, onSave) {
    Sheet.open({
      title: 'Edit item',
      render: () => html`<form class="form" autocomplete="off"><label class="field"><span>Name</span><input type="text" id="itemEditName" maxlength="60" value="${it.n || ''}"></label>
        <label class="field"><span>Note</span><input type="text" id="itemEditNote" maxlength="120" value="${it.note || ''}" placeholder="Note (optional)"></label>
        <div class="btn-row end"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button type="submit" class="btn btn-primary" data-act="item-save">Save</button></div></form>`,
      submit: () => {
        const name = String(($('#itemEditName') || {}).value || '').trim().slice(0, 60);
        if (!name) return toast('An item needs a name.', 'warn');
        const note = String(($('#itemEditNote') || {}).value || '').trim().slice(0, 120);
        Sheet.close(true);
        onSave(name, note);
      },
    });
  }
  // party actions (Heroes list); returns true when handled
  function partyAct(a, b) {
    const items = partyItems();
    const it = b && b.dataset.i !== undefined ? items[Number(b.dataset.i)] : null;
    if (a === 'party-add') {
      const n = readNewItem('party');
      if (!n) return true;
      Store.Act.partyAdd({ n: n.n, q: n.q, note: n.note, hb: n.hb || null, by: S.me.pk });
      renderPanel('heroes', true);
      return true;
    }
    if (!it && /^party-/.test(a)) return true;
    if (a === 'party-edit') {
      openItemEdit(it, (n, note) => Store.Act.partyPatch(it.id, { n, note }));
      return true;
    }
    if (a === 'party-q') {
      const q = cleanQty(it.q) + Number(b.dataset.d);
      if (q <= 0) Store.Act.partyDel(it.id);
      else Store.Act.partyPatch(it.id, { q });
      return true;
    }
    if (a === 'party-del') {
      confirmSheet(`Remove ${it.n}?`, 'It’s removed from the party inventory for everyone.', 'Remove', () => Store.Act.partyDel(it.id));
      return true;
    }
    if (a === 'party-move') {
      const hero = myHero();
      if (!hero || !canEditChar(hero)) {
        toast('Make or pick your hero first (People and settings → Playing as).', 'warn');
        return true;
      }
      const inv = (Array.isArray(hero.inv) ? hero.inv : []).concat([{ id: Store.uid('v'), n: it.n, q: cleanQty(it.q) || 1, note: it.note || '', hb: it.hb || null }]);
      Store.Act.patchChar(hero.id, { inv });
      Store.Act.partyDel(it.id);
      toast(`${hero.name || 'Your hero'} takes ${it.n}.`);
      return true;
    }
    return false;
  }

  /* --------------------------------------------------- hero sheet */
  function sheetHtml(ch) {
    const R = D.rules;
    const d = Store.derived(ch);
    if (!d) return html`<p class="err">This hero’s data couldn’t be read.</p>`;
    const edit = canEditChar(ch);
    const hp = Store.heroHp(ch);
    const conds = ch.conds || [];
    const tok = tokenForChar(ch.id);
    const cls = d.cls;
    const sub = d.sub;
    const raceName = ch.subrace && R.subraces[ch.subrace] ? R.subraces[ch.subrace].n : d.race ? d.race.n : '';
    const bg = ch.background === 'custom' ? 'Custom background' : R.backgrounds[ch.background] ? R.backgrounds[ch.background].n : '';
    const mode = H.mode;
    const abil = Core.ABILS.map((ab) => html`<div class="abil"><button type="button" class="stat" data-act="roll-check" data-ab="${ab}" ${edit ? '' : 'disabled'}>
        <span class="k">${Core.ABIL_SHORT[ab]}</span><span class="v">${fmtMod(d.mods[ab])}</span><span class="score">${d.scores[ab]}</span></button>
        <button type="button" class="save-btn ${d.saves[ab].prof ? 'prof' : ''}" data-act="roll-save" data-ab="${ab}" ${edit ? '' : 'disabled'}>Save ${fmtMod(d.saves[ab].bonus)}</button></div>`);
    const skills = Object.keys(R.skills).map((sk) => {
      const s = d.skills[sk];
      return html`<button type="button" class="skill" data-act="roll-skill" data-sk="${sk}" ${edit ? '' : 'disabled'}><span class="pip ${s.exp ? 'exp' : s.prof ? 'on' : ''}"></span><span class="nm">${R.skills[sk].n}</span><span class="ab">${Core.ABIL_SHORT[s.ab]}</span><span class="bn">${fmtMod(s.bonus)}</span></button>`;
    });
    const attacks = d.attacks.map((a, i) => html`<div class="atk-row"><div style="min-width:0"><div class="title" style="font-weight:700">${a.n}${a.prof ? '' : html` <span class="badge red">not proficient</span>`}</div>
        <div class="sub small muted">${a.dmg} ${a.ty.toLowerCase()}${(a.extra || []).map((x) => ` + ${x[0]} ${x[1]}`).join('')}${a.vers ? ` · two hands ${a.vers}` : ''} · ${a.range}${a.using && a.using.length ? html` · <span style="color:var(--brass-hi)">${a.using.join(', ')}</span>` : ''}</div></div>
        <span class="bonus">${fmtMod(a.hit)}</span>
        <button type="button" class="btn btn-sm" data-act="roll-atk" data-i="${i}" ${edit ? '' : 'disabled'}>Attack</button></div>`);
    if (d.breath) {
      const b = d.breath;
      attacks.push(html`<div class="atk-row"><div style="min-width:0"><div class="title" style="font-weight:700">Breath Weapon</div>
        <div class="sub small muted">${b.dmg} ${b.ty.toLowerCase()} · DC ${b.dc} ${Core.ABIL_SHORT[b.save]} save, half on success · ${b.area.size}-ft ${b.area.shape}</div></div>
        <span class="bonus">DC ${b.dc}</span><button type="button" class="btn btn-sm" data-act="breath" ${edit ? '' : 'disabled'}>Use</button></div>`);
    }
    // spells
    let spells = '';
    const grantedBy = new Map(d.granted.map((g) => [g.id, g]));
    // casting numbers for spells a feat or feature grants with its own ability
    const grantCast = !d.cast && d.granted.length ? (() => {
      const ab = (d.granted.find((g) => g.ab) || {}).ab || 'cha';
      return { ab, dc: 8 + d.pb + d.mods[ab], atk: d.pb + d.mods[ab], mod: d.mods[ab], slots: [0, 0, 0, 0, 0, 0, 0, 0, 0], maxLvl: 0, granted: true };
    })() : null;
    if (d.cast || grantCast) {
      const castInfo = d.cast || grantCast;
      const known = [...new Set([...(ch.spells || []), ...d.granted.map((g) => g.id)])].map((i) => D.spellsById && D.spellsById.get(i)).filter(Boolean);
      const byLvl = {};
      known.forEach((sp) => (byLvl[sp.lvl] = byLvl[sp.lvl] || []).push(sp));
      const used = ch.slots || {};
      const lvls = [];
      for (let l = 0; l <= 9; l++) {
        const total = l ? castInfo.slots[l - 1] || 0 : 0;
        if (!byLvl[l] && !total) continue;
        const pips = [];
        for (let k = 0; k < total; k++) pips.push(html`<button type="button" class="slot-pip ${k < (used[l] || 0) ? 'used' : ''}" data-act="slot" data-l="${l}" data-k="${k}" aria-label="${ord(l)} level slot ${k + 1}" ${edit ? '' : 'disabled'}></button>`);
        lvls.push(html`<div class="spell-lvl"><div class="spell-lvl-head"><h4>${l === 0 ? 'Cantrips' : ord(l) + ' level'}${total ? ` · ${total - (used[l] || 0)} of ${total} slots` : ''}</h4>${total ? html`<div class="slot-pips">${pips}</div>` : ''}</div>
          ${byLvl[l] ? html`<div class="chips">${byLvl[l].sort((a, b) => a.n.localeCompare(b.n)).map((sp) => {
            const g = grantedBy.get(sp.i);
            return html`<button type="button" class="chip" data-act="spell" data-i="${sp.i}" title="${g ? 'From ' + g.src : ''}">${sp.n}${sp.conc ? ' ©' : ''}${sp.area ? html` ${icon('area')}` : ''}${g ? html` <span class="muted">${g.always ? '★' : '✦'}</span>` : ''}</button>`;
          })}</div>` : html`<p class="hint">No ${l ? ord(l) + '-level spells' : 'cantrips'} chosen.</p>`}</div>`);
      }
      spells = html`<div class="card"><div class="card-title"><h3>Spellcasting</h3><span class="small muted">${Core.ABIL_NAME[castInfo.ab]}</span></div>
        <div class="statline"><div class="stat"><span class="k">Save DC</span><span class="v">${castInfo.dc}</span></div><button type="button" class="stat" data-act="roll-spellatk" ${edit ? '' : 'disabled'}><span class="k">Spell attack</span><span class="v">${fmtMod(castInfo.atk)}</span></button>${castInfo.pact ? html`<div class="stat"><span class="k">Pact slots</span><span class="v">${ord(castInfo.maxLvl)}</span></div>` : ''}</div>
        ${D.spells ? lvls : html`<p class="hint">Loading spells…</p>`}
        ${!known.length ? html`<p class="hint">No spells chosen yet. ${edit ? 'Edit the hero to pick spells.' : ''}</p>` : ''}
        <p class="hint">© marks concentration${d.granted.length ? ', ★ always prepared (from a feature), ✦ chosen through a feature or feat' : ''}. Tap a spell to cast it, roll it, or place its area on the map.</p></div>`;
    }
    // resources
    const resUsed = ch.res || {};
    const res = d.resources.map((r) => {
      const when = Core.RESET_LABEL[r.reset] || Core.RESET_LABEL.long;
      const part = r.regain && r.reset !== 'none' ? ` (${r.regain} back each time${r.reset === 'short' ? ', all on a long rest' : ''})` : '';
      if (r.reset === 'none') return html`<div class="row"><span class="main"><span class="title" style="display:block">${r.n}</span><span class="sub" style="display:block">Unlimited</span></span></div>`;
      const usedN = Math.min(r.max, resUsed[r.key] || 0);
      const adjust = html`<div class="stepper"><button type="button" data-act="res-step" data-k="${r.key}" data-d="1" aria-label="Use one" ${edit && usedN < r.max ? '' : 'disabled'}>−</button><span class="val num">${r.max - usedN}</span><button type="button" data-act="res-step" data-k="${r.key}" data-d="-1" aria-label="Get one back" ${edit && usedN > 0 ? '' : 'disabled'}>+</button></div>
        <button type="button" class="btn btn-ghost btn-sm" data-act="res-fill" data-k="${r.key}" ${edit && usedN > 0 ? '' : 'disabled'}>Refill</button>`;
      const pips = [];
      if (r.max <= 10) for (let k = 0; k < r.max; k++) pips.push(html`<button type="button" class="slot-pip ${k < usedN ? 'used' : ''}" data-act="res" data-k="${r.key}" data-n="${k}" aria-label="${r.n} ${k + 1}" ${edit ? '' : 'disabled'}></button>`);
      return html`<div class="row res-row"><span class="main"><span class="title" style="display:block">${r.n}</span><span class="sub" style="display:block;white-space:normal">${r.max - usedN} of ${r.max} left · ${when}${part}</span></span>${pips.length ? html`<div class="slot-pips res-pips">${pips}</div>` : ''}${adjust}</div>`;
    });
    const condList = Object.keys(R.conditions);
    const death = ch.death || { s: 0, f: 0 };
    const deathHtml = hp.hp === 0 ? html`<div class="card"><div class="card-title"><h3>Death saves</h3><button type="button" class="btn btn-sm" data-act="roll-death" ${edit ? '' : 'disabled'}>Roll death save</button></div>
      <div class="death"><span class="small">Successes</span><div class="slot-pips ok">${[0, 1, 2].map((k) => html`<button type="button" class="slot-pip ${k < death.s ? 'used' : ''}" data-act="death" data-k="s" data-n="${k}" ${edit ? '' : 'disabled'}></button>`)}</div>
      <span class="small">Failures</span><div class="slot-pips bad">${[0, 1, 2].map((k) => html`<button type="button" class="slot-pip ${k < death.f ? 'used' : ''}" data-act="death" data-k="f" data-n="${k}" ${edit ? '' : 'disabled'}></button>`)}</div></div></div>` : '';
    const feats = d.features.map((f) => html`<button type="button" class="chip" data-act="feat" data-f="${f.id}">${(D.features && D.features[f.id] && D.features[f.id].n) || titleCase(f.id.replace(/-/g, ' '))} <span class="muted">${f.lvl}</span></button>`);
    const traits = d.traits.map((t) => html`<button type="button" class="chip" data-act="trait" data-t="${t}">${R.traits[t] ? R.traits[t].n : t}</button>`);
    const bgFeat = ch.background && R.backgrounds[ch.background] ? R.backgrounds[ch.background].feature : null;
    return html`
      <div class="panel-head"><button type="button" class="btn btn-ghost btn-sm" data-act="hero-back">${icon('back')} Heroes</button>
        <div class="btn-row">${edit ? html`<button type="button" class="btn btn-sm" data-act="place-token">${icon('target')} ${tok ? 'Find token' : 'Place token'}</button><button type="button" class="btn btn-sm" data-act="edit-hero">${icon('edit')} Edit</button>` : ''}</div></div>
      <div class="hero-head">${disc(ch.name, ch.color, ch.portrait, 'lg')}<div class="main"><div class="hero-name">${ch.name || 'Unnamed hero'}</div>
        <div class="hero-sub">Level ${d.level} ${raceName} ${cls.n}${sub ? ` (${sub.n})` : ''}${bg ? ` · ${bg}` : ''}</div>
        ${S.myChar !== ch.id && ch.owner === S.me.pk ? html`<button type="button" class="btn btn-ghost btn-sm" data-act="play-as" style="margin-top:6px">Play as this hero</button>` : ''}
        ${ch.owner !== S.me.pk && !S.dm ? html`<div class="small muted">Read only: another player’s hero.</div>` : ''}</div></div>
      <div class="card"><div class="hp-box"><div><div class="label">Hit points</div><div class="hp-big">${hp.hp}<small> / ${hp.max}${hp.tmp ? ` · +${hp.tmp} temp` : ''}</small></div></div>
        <div>${hpBar(hp.hp, hp.max)}</div></div>
        ${edit ? html`<div class="hp-ctrl"><input type="number" id="hpAmt" inputmode="numeric" min="0" placeholder="0" aria-label="Amount">
          <button type="button" class="btn btn-danger btn-sm" data-act="hp-dmg">Damage</button><button type="button" class="btn btn-heal btn-sm" data-act="hp-heal">Heal</button><button type="button" class="btn btn-sm" data-act="hp-temp">Temp HP</button></div>
          <div class="btn-row"><button type="button" class="btn btn-ghost btn-sm" data-act="rest-short">Short rest</button><button type="button" class="btn btn-ghost btn-sm" data-act="rest-long">Long rest</button><button type="button" class="btn btn-ghost btn-sm" data-act="rest-dawn">Dawn</button><span class="small muted">Hit dice ${d.hitDice}</span></div>` : ''}</div>
      ${deathHtml}
      <div class="statline">
        <div class="stat"><span class="k">Armor class</span><span class="v">${d.ac}</span></div>
        <button type="button" class="stat" data-act="roll-init" ${edit ? '' : 'disabled'}><span class="k">Initiative</span><span class="v">${fmtMod(d.init)}</span></button>
        <div class="stat"><span class="k">Speed</span><span class="v">${d.speed}<small class="muted"> ft</small></span></div>
        <div class="stat"><span class="k">Proficiency</span><span class="v">${fmtMod(d.pb)}</span></div>
        <div class="stat"><span class="k">Passive Perc.</span><span class="v">${d.passive}</span></div></div>
      ${edit ? html`<div class="btn-row"><span class="small muted">Next roll:</span><div class="seg">${['normal', 'adv', 'dis'].map((m) => html`<button type="button" data-act="mode" data-m="${m}" aria-pressed="${mode === m}">${m === 'normal' ? 'Normal' : m === 'adv' ? 'Advantage' : 'Disadvantage'}</button>`)}</div></div>` : ''}
      <div class="card"><div class="card-title"><h3>Abilities</h3><span class="small muted">Tap to roll a check or save</span></div><div class="abil-grid">${abil}</div></div>
      <div class="card"><div class="card-title"><h3>Skills</h3></div><div class="skill-list">${skills}</div></div>
      ${actionsCardHtml(ch, d, attacks, edit)}
      ${d.feats.some((f) => (f.kind || 'feat') === 'feat') ? html`<div class="card"><div class="card-title"><h3>Feats</h3></div><div class="list">${d.feats.filter((f) => (f.kind || 'feat') === 'feat').map((f) => html`<button type="button" class="row tap" data-act="hbfeat" data-id="${f.id}"><span class="main"><span class="title" style="display:block">${f.name}</span><span class="sub" style="display:block">${(f.effects || []).map(Core.describeEffect).filter(Boolean).join(' · ') || 'Description only'}</span></span></button>`)}</div></div>` : ''}
      ${spells}
      ${res.length ? html`<div class="card"><div class="card-title"><h3>Resources</h3></div><div class="list">${res}</div></div>` : ''}
      ${invCardHtml(ch, edit)}${itemSuggestions()}
      ${d.classSpecific.length ? html`<div class="card"><div class="card-title"><h3>${cls.n} table</h3></div><dl class="kv">${d.classSpecific.map(([k, v]) => html`<dt>${k}</dt><dd class="num">${v}</dd>`)}</dl></div>` : ''}
      <div class="card"><div class="card-title"><h3>Conditions</h3></div><div class="chips">${condList.map((c) => html`<button type="button" class="chip cond" data-act="cond" data-c="${c}" aria-pressed="${conds.includes(c)}" ${edit ? '' : 'disabled'}>${R.conditions[c].n}</button>`)}</div></div>
      <details class="fold"><summary>Features and traits</summary><div class="fold-in">
        <div class="label">${cls.n} features</div><div class="chips">${feats}</div>
        <div class="label">Racial traits</div><div class="chips">${traits.length ? traits : html`<span class="muted small">None</span>`}</div>
        ${bgFeat && bgFeat.n ? html`<div class="label">Background</div><div class="chips"><button type="button" class="chip" data-act="bgfeat">${bgFeat.n}</button></div>` : ''}</div></details>
      <div class="card"><div class="card-title"><h3>Notes</h3></div><textarea id="heroNotes" placeholder="Gear, gold, allies, secrets…" ${edit ? '' : 'readonly'}>${ch.notes || ''}</textarea></div>
      ${edit ? html`<div class="btn-row end"><button type="button" class="btn btn-danger btn-sm" data-act="delete-hero">${icon('trash')} Delete hero</button></div>` : ''}`;
  }

  /* ------------------------------------------------ actions card */
  // Everything a hero can do, split by how it's used: action, bonus action, reaction, other.
  const ACT_TABS = [['action', 'Action'], ['bonus', 'Bonus action'], ['reaction', 'Reaction'], ['other', 'Other']];
  function spellAct(sp) {
    const t = String(sp.time || '').toLowerCase();
    if (/bonus/.test(t)) return 'bonus';
    if (/reaction/.test(t)) return 'reaction';
    if (/^1 action/.test(t)) return 'action';
    return null;
  }
  function abilityName(a) {
    return a.name || (a.featId && D.features && D.features[a.featId] ? D.features[a.featId].n : titleCase(String(a.featId || a.key).replace(/^srd-/, '').replace(/-/g, ' ')));
  }
  // "2 Ki points · 3 of 5 left", or "2 superiority dice" when the hero has no tracker by that name
  function costText(ch, d, res, n, resName) {
    if (!n && !res) return '';
    const r = res && d.resources.find((x) => x.key === res);
    // "1 Ki point", "2 Ki points", "1 superiority die"
    const unit = (name, k) => (k === 1 ? String(name).replace(/ points$/i, ' point').replace(/ dice$/i, ' die') : name);
    if (r && r.reset === 'none') return 'No limit';
    if (r) {
      const left = r.max - Math.min(r.max, (ch.res || {})[r.key] || 0);
      return `${n ? 'Costs ' + n + ' ' + unit(r.n.replace(/\s*\(.*\)$/, ''), n) : 'Uses ' + r.n.replace(/\s*\(.*\)$/, '')} · ${left} of ${r.max} left`;
    }
    return resName ? `Costs ${n || 1} ${unit(resName, n || 1)}` : '';
  }
  function actionsCardHtml(ch, d, attacks, edit) {
    const tab = ACT_TABS.some(([k]) => k === H.actTab) ? H.actTab : 'action';
    const known = [...new Set([...(ch.spells || []), ...d.granted.map((g) => g.id)])].map((i) => D.spellsById && D.spellsById.get(i)).filter(Boolean);
    const costOf = new Map(d.grantedCost.filter((g) => g.costN || g.costRes).map((g) => [g.id, g]));
    const rows = {};
    ACT_TABS.forEach(([k]) => (rows[k] = []));
    d.abilities.forEach((a, i) => {
      const cost = costText(ch, d, a.res, a.n, a.resName);
      const r = a.res && d.resources.find((x) => x.key === a.res);
      const left = r ? r.max - Math.min(r.max, (ch.res || {})[r.key] || 0) : null;
      const unlimited = r && r.reset === 'none';
      rows[a.act].push(html`<div class="row act-row"><span class="main"><button type="button" class="linkish" data-act="ab-read" data-i="${i}">${abilityName(a)}</button>
        <span class="sub" style="display:block;white-space:normal">${[cost, a.note, a.roll ? 'Roll ' + a.roll : ''].filter(Boolean).join(' · ')}</span></span>
        <button type="button" class="btn btn-sm" data-act="ab-use" data-i="${i}" ${edit && (unlimited || left == null || left >= Math.max(1, a.n || 0)) ? '' : 'disabled'}>${a.roll ? 'Roll' : 'Use'}</button></div>`);
    });
    known.forEach((sp) => {
      const k = spellAct(sp);
      if (!k) return;
      const g = costOf.get(sp.i);
      const cost = g ? costText(ch, d, g.res, g.costN, g.costRes) : sp.lvl ? ord(sp.lvl) + '-level slot' : 'Cantrip';
      rows[k].push(html`<div class="row act-row"><span class="main"><span class="title" style="display:block">${sp.n}</span><span class="sub" style="display:block;white-space:normal">Spell · ${cost}${sp.conc ? ' · concentration' : ''}</span></span>
        <button type="button" class="btn btn-sm" data-act="spell" data-i="${sp.i}">Cast</button></div>`);
    });
    const count = (k) => rows[k].length + (k === 'action' ? attacks.length : 0);
    return html`<div class="card"><div class="card-title"><h3>Actions</h3><span class="small muted">${d.acNote}${d.critMin < 20 ? ` · crits on ${d.critMin}–20` : ''}${d.extraAttacks ? ` · ${1 + d.extraAttacks} attacks per Attack action` : ''}</span></div>
      ${d.toggles.length ? html`<div class="chips">${d.toggles.map((t) => html`<button type="button" class="chip fx-toggle" data-act="fx" data-k="${t.key}" aria-pressed="${t.on}" ${edit ? '' : 'disabled'}><b>${t.feat}</b> ${t.on ? 'on' : 'off'}${t.text.replace(/, when switched on$/, '').replace(/^no change on .*/, '') ? ' · ' + t.text.replace(/, when switched on$/, '') : ''}</button>`)}</div>` : ''}
      <div class="seg full act-tabs" role="tablist">${ACT_TABS.map(([k, label]) => html`<button type="button" role="tab" data-act="act-tab" data-t="${k}" aria-pressed="${tab === k}" aria-selected="${tab === k}">${label}${count(k) ? ` · ${count(k)}` : ''}</button>`)}</div>
      <div class="list">${tab === 'action' ? attacks : ''}${rows[tab]}${!count(tab) ? html`<p class="hint">${{ action: 'Nothing here yet.', bonus: 'No bonus actions yet.', reaction: 'No reactions yet.', other: 'Nothing here: this is for things like Action Surge, Metamagic or Divine Smite that happen on top of an action.' }[tab]}</p>` : ''}</div></div>`;
  }
  // replace LVL, PB and ability names in a roll, e.g. "1d6+WIS" or "2d8+LVL"
  function rollExprFor(d, ex) {
    return String(ex || '').replace(/\bLVL\b/g, d.level).replace(/\bPB\b/g, d.pb).replace(/\b(STR|DEX|CON|INT|WIS|CHA)\b/g, (m) => '(' + d.mods[m.toLowerCase()] + ')').replace(/\+\(-/g, '-').replace(/[()]/g, '');
  }

  function damageHero(ch, n) {
    const hp = Store.heroHp(ch);
    const tmp = hp.tmp || 0;
    const fromTmp = Math.min(tmp, n);
    const left = n - fromTmp;
    const nh = Math.max(0, hp.hp - left);
    const patch = { hp: nh, tmp: tmp - fromTmp };
    if (nh === 0 && hp.hp > 0) patch.death = { s: 0, f: 0 };
    Store.Act.patchChar(ch.id, patch);
    return nh;
  }
  function healHero(ch, n) {
    const hp = Store.heroHp(ch);
    const patch = { hp: Math.min(hp.max, Math.max(0, hp.hp) + n) };
    if (hp.hp <= 0) patch.death = { s: 0, f: 0 };
    Store.Act.patchChar(ch.id, patch);
  }

  function heroAct(a, b) {
    const R = D.rules;
    if (/^party-/.test(a)) return partyAct(a, b);
    if (a === 'new-hero') return openBuilder(null);
    if (a === 'open-hero') {
      H.view = 'sheet';
      H.id = b.dataset.id;
      H.mode = 'normal';
      loadSpells();
      Store.loadData('features').catch(() => {});
      return renderPanel('heroes', true);
    }
    if (a === 'hero-back') {
      H.view = 'list';
      return renderPanel('heroes', true);
    }
    const ch = S.chars.get(H.id);
    if (!ch) return;
    const d = Store.derived(ch);
    const who = ch.name || 'Hero';
    switch (a) {
      case 'edit-hero':
        return openBuilder(ch);
      case 'play-as':
        Store.setMyChar(ch.id);
        toast(`You’re playing ${who}.`);
        return renderPanel('heroes', true);
      case 'mode':
        H.mode = b.dataset.m;
        return renderPanel('heroes', true);
      case 'roll-check':
        rollD20(who, Core.ABIL_NAME[b.dataset.ab] + ' check', d.mods[b.dataset.ab] + (d.joat || 0), takeMode());
        break;
      case 'roll-save':
        rollD20(who, Core.ABIL_NAME[b.dataset.ab] + ' save', d.saves[b.dataset.ab].bonus, takeMode());
        break;
      case 'roll-skill':
        rollD20(who, R.skills[b.dataset.sk].n, d.skills[b.dataset.sk].bonus, takeMode());
        break;
      case 'roll-init': {
        const r = rollD20(who, 'Initiative', d.init, takeMode());
        if (r) addHeroInit(ch, r.t, d);
        break;
      }
      case 'roll-spellatk':
        if (d.cast || d.granted.length) rollD20(who, 'Spell attack', d.cast ? d.cast.atk : d.pb + d.mods[(d.granted.find((g) => g.ab) || {}).ab || 'cha'], takeMode());
        break;
      case 'roll-atk': {
        const at = d.attacks[Number(b.dataset.i)];
        // feats switched on are already in at.hit / at.dmg; typed extra damage rolls separately
        if (at) rollAttack(who, at.n + (at.using && at.using.length ? ` (${at.using.join(', ')})` : ''), at.hit, [[at.dmg, at.ty], ...(at.extra || [])], null, takeMode(), null, d.critMin, { adv: at.adv, gwf: at.gwf, brutal: at.brutal });
        break;
      }
      case 'breath': {
        const br = d.breath;
        if (!br) return;
        const r = Core.roll(br.dmg);
        postRoll({ who, label: `Breath Weapon · DC ${br.dc} ${Core.ABIL_SHORT[br.save]} save`, rolls: [mk(r, 'Damage', br.ty)] });
        useResource(ch, 'breath');
        const tok = tokenForChar(ch.id);
        Board.startAim({ shape: br.area.shape, size: br.area.size, width: br.area.width, color: ch.color, label: 'Breath Weapon', caster: tok && tok.id, spell: { roll: br.dmg, dc: br.dc, save: br.save, half: true, total: r && r.t } });
        show('table');
        break;
      }
      case 'hp-dmg':
      case 'hp-heal':
      case 'hp-temp': {
        const inp = $('#hpAmt');
        const n = Math.max(0, Math.floor(Number(inp && inp.value) || 0));
        if (!n) {
          toast('Enter an amount first.', 'warn');
          if (inp) inp.focus();
          return;
        }
        if (a === 'hp-dmg') {
          const nh = damageHero(ch, n);
          if (nh === 0) toast(`${who} drops to 0 hit points.`, 'warn');
        } else if (a === 'hp-heal') healHero(ch, n);
        else Store.Act.patchChar(ch.id, { tmp: Math.max(ch.tmp || 0, n) });
        if (inp) inp.value = '';
        break;
      }
      case 'rest-short':
      case 'rest-long':
      case 'rest-dawn': {
        const kind = a.slice(5);
        const rec = Core.restRecovery(d.resources, ch.res || {}, kind);
        const patch = {};
        if (Object.keys(rec.res).length) patch.res = rec.res;
        const lines = rec.lines.slice();
        if (kind === 'short' && ch.cls === 'warlock' && Object.values(ch.slots || {}).some((v) => v > 0)) {
          patch.slots = zeroKeys(ch.slots);
          lines.push('Pact Magic slots → all back');
        }
        if (kind === 'long') {
          Object.assign(patch, { hp: null, tmp: 0, slots: zeroKeys(ch.slots), death: { s: 0, f: 0 } });
          lines.unshift('Hit points → full' + (Object.values(ch.slots || {}).some((v) => v > 0) ? ', spell slots → all back' : ''));
        }
        if (Object.keys(patch).length) Store.Act.patchChar(ch.id, patch);
        const title = { short: 'takes a short rest', long: 'finishes a long rest', dawn: 'greets the dawn' }[kind];
        Store.Act.log({ kind: 'sys', who, label: `${who} ${title}. ${lines.length ? 'Back: ' + lines.join('; ') + '.' : 'Nothing to refill.'}` });
        if (kind === 'short') {
          postRoll({ who, label: 'Short rest', rolls: [mk(Core.roll('1d' + d.hd + Core.exprMod(d.mods.con)), 'Hit die (spend if needed)')] });
          if (d.songOfRest) postRoll({ who, label: `Song of Rest: each ally who spends a Hit Die regains this much extra`, rolls: [mk(Core.roll('1' + d.songOfRest), 'Extra healing')] });
        }
        toast(lines.length ? `${title[0].toUpperCase() + title.slice(1)}: ${lines.length} thing${lines.length === 1 ? '' : 's'} back.` : 'Nothing to refill.');
        break;
      }
      case 'res-fill': {
        Store.Act.patchChar(ch.id, { res: { [b.dataset.k]: 0 } });
        break;
      }
      case 'slot': {
        const l = b.dataset.l;
        const k = Number(b.dataset.k);
        const used = Object.assign({}, ch.slots || {});
        used[l] = k < (used[l] || 0) ? k : k + 1;
        Store.Act.patchChar(ch.id, { slots: used });
        break;
      }
      case 'res': {
        const k = b.dataset.k;
        const n = Number(b.dataset.n);
        const used = Object.assign({}, ch.res || {});
        used[k] = n < (used[k] || 0) ? n : n + 1;
        Store.Act.patchChar(ch.id, { res: used });
        break;
      }
      case 'res-step': {
        const k = b.dataset.k;
        const used = Object.assign({}, ch.res || {});
        used[k] = Math.max(0, (used[k] || 0) + Number(b.dataset.d));
        Store.Act.patchChar(ch.id, { res: used });
        break;
      }
      case 'cond': {
        const c = b.dataset.c;
        const list = (ch.conds || []).slice();
        const i = list.indexOf(c);
        if (i >= 0) list.splice(i, 1);
        else list.push(c);
        Store.Act.patchChar(ch.id, { conds: list });
        break;
      }
      case 'death': {
        const k = b.dataset.k;
        const n = Number(b.dataset.n);
        const death = Object.assign({ s: 0, f: 0 }, ch.death || {});
        death[k] = n < death[k] ? n : n + 1;
        Store.Act.patchChar(ch.id, { death });
        break;
      }
      case 'roll-death': {
        const r = Core.roll('1d20');
        const death = Object.assign({ s: 0, f: 0 }, ch.death || {});
        let note = '';
        if (r.nat === 20) {
          Store.Act.patchChar(ch.id, { hp: 1, death: { s: 0, f: 0 } });
          note = ' · back on their feet with 1 HP';
        } else if (r.nat === 1) {
          death.f = Math.min(3, death.f + 2);
          note = ' · two failures';
        } else if (r.t >= 10) death.s = Math.min(3, death.s + 1);
        else death.f = Math.min(3, death.f + 1);
        if (r.nat !== 20) Store.Act.patchChar(ch.id, { death });
        if (death.s >= 3) note = ' · stable';
        if (death.f >= 3) note = ' · has died';
        postRoll({ who, label: 'Death save' + note, rolls: [mk(r, r.t >= 10 ? 'Success' : 'Failure')] });
        break;
      }
      case 'spell':
        return openSpell(b.dataset.i, ch);
      case 'feat':
        return openText(D.features && D.features[b.dataset.f] ? D.features[b.dataset.f].n : 'Feature', D.features && D.features[b.dataset.f] ? D.features[b.dataset.f].d : 'Loading…');
      case 'trait':
        return openText(R.traits[b.dataset.t].n, R.traits[b.dataset.t].d);
      case 'bgfeat': {
        const f = R.backgrounds[ch.background].feature;
        return openText(f.n, f.d);
      }
      case 'place-token':
        return placeHeroToken(ch);
      case 'inv-add': {
        const it = readNewItem('inv');
        if (!it) return;
        Store.Act.patchChar(ch.id, { inv: (Array.isArray(ch.inv) ? ch.inv : []).concat([it]) });
        return;
      }
      case 'inv-edit': {
        const i = Number(b.dataset.i);
        const it = (Array.isArray(ch.inv) ? ch.inv : [])[i];
        if (!it) return;
        return openItemEdit(it, (n, note) => {
          const cur = S.chars.get(ch.id) || ch;
          const inv = (Array.isArray(cur.inv) ? cur.inv : []).slice();
          const j = inv.findIndex((x) => x.id === it.id);
          if (j < 0) return;
          inv[j] = Object.assign({}, inv[j], { n, note });
          Store.Act.patchChar(ch.id, { inv });
        });
      }
      case 'inv-eq':
      case 'inv-at': {
        const inv = (Array.isArray(ch.inv) ? ch.inv : []).slice();
        const i = Number(b.dataset.i);
        if (!inv[i]) return;
        const k = a === 'inv-eq' ? 'eq' : 'at';
        if (k === 'at' && !inv[i].at && inv.filter((x) => x.at).length >= 3) return toast('A hero can be attuned to 3 items at most.', 'warn');
        inv[i] = Object.assign({}, inv[i], { [k]: inv[i][k] ? 0 : 1 });
        Store.Act.patchChar(ch.id, { inv });
        return;
      }
      case 'act-tab':
        H.actTab = b.dataset.t;
        return renderPanel('heroes', true);
      case 'ab-read': {
        const x = d.abilities[Number(b.dataset.i)];
        if (!x) return;
        const text = x.featId && D.features && D.features[x.featId] ? D.features[x.featId].d : x.desc;
        return openText(abilityName(x), [text, [costText(ch, d, x.res, x.n, x.resName), x.note].filter(Boolean).join(' · ')].filter(Boolean).join('\n\n'));
      }
      case 'ab-use': {
        const x = d.abilities[Number(b.dataset.i)];
        if (!x) return;
        const name = abilityName(x);
        const unl = x.res && (d.resources.find((rr) => rr.key === x.res) || {}).reset === 'none';
        if (x.res && x.n !== 0 && !unl) {
          const r = d.resources.find((rr) => rr.key === x.res);
          const used = Object.assign({}, ch.res || {});
          const left = r ? r.max - Math.min(r.max, used[x.res] || 0) : 0;
          const n = Math.max(1, x.n || 1);
          if (left < n) return toast(`Not enough ${r ? r.n.toLowerCase() : x.resName} left.`, 'warn');
          used[x.res] = (used[x.res] || 0) + n;
          Store.Act.patchChar(ch.id, { res: used });
        }
        const ex = rollExprFor(d, x.roll);
        if (ex && Core.parseDice(ex)) {
          const r = Core.roll(ex);
          postRoll({ who, label: name + (x.heal ? ' · healing' : ''), rolls: [mk(r, x.heal ? 'Healing' : '')] });
          if (x.heal && r) healHero(ch, r.t);
        } else Store.Act.log({ kind: 'sys', who, label: `${who} uses ${name}${x.note ? ': ' + x.note : ''}.` });
        return;
      }
      case 'hb-read': {
        const f = S.hb.get(b.dataset.id);
        if (f) openFeat(f);
        return;
      }
      case 'inv-q':
      case 'inv-del':
      case 'inv-move': {
        const inv = (Array.isArray(ch.inv) ? ch.inv : []).slice();
        const i = Number(b.dataset.i);
        const it = inv[i];
        if (!it) return;
        if (a === 'inv-q') {
          const q = cleanQty(it.q) + Number(b.dataset.d);
          if (q <= 0) inv.splice(i, 1);
          else inv[i] = Object.assign({}, it, { q });
        } else if (a === 'inv-move') {
          Store.Act.partyAdd({ n: it.n, q: cleanQty(it.q) || 1, note: it.note || '', hb: it.hb || null, by: S.me.pk });
          inv.splice(i, 1);
          toast(`${it.n} goes to the party inventory.`);
        } else inv.splice(i, 1);
        Store.Act.patchChar(ch.id, { inv });
        return;
      }
      case 'fx': {
        const k = b.dataset.k;
        Store.Act.patchChar(ch.id, { fx: { [k]: (ch.fx || {})[k] ? 0 : 1 } });
        return;
      }
      case 'hbfeat': {
        const f = S.hb.get(b.dataset.id);
        if (f) openFeat(f);
        return;
      }
      case 'delete-hero':
        return confirmSheet('Delete ' + who + '?', 'This removes the hero and their tokens for everyone at the table. It can’t be undone.', 'Delete hero', () => {
          Store.Act.deleteChar(ch.id);
          H.view = 'list';
          renderPanel('heroes', true);
        });
    }
  }
  function zeroKeys(o) {
    const out = {};
    Object.keys(o || {}).forEach((k) => (out[k] = 0));
    return out;
  }
  function takeMode() {
    const m = H.mode;
    if (m !== 'normal') {
      H.mode = 'normal';
      schedule('heroes');
    }
    return m;
  }
  function useResource(ch, key) {
    const used = Object.assign({}, ch.res || {});
    used[key] = (used[key] || 0) + 1;
    Store.Act.patchChar(ch.id, { res: used });
  }
  async function placeHeroToken(ch) {
    const have = tokenForChar(ch.id);
    if (have) {
      show('table');
      Board.focusToken(have.id);
      return;
    }
    const sid = await Store.Act.ensureScene();
    const spot = Board.freeSpot(1);
    const id = Store.Act.addToken({ scene: sid, kind: 'pc', char: ch.id, c: spot.c, r: spot.r, size: 1, owner: ch.owner, ts: Date.now() });
    if (ch.owner === S.me.pk && !S.myChar) Store.setMyChar(ch.id);
    show('table');
    setTimeout(() => Board.focusToken(id), 60);
    toast(`${ch.name || 'Your hero'} is on the map. Drag the token to move.`);
  }
  function addHeroInit(ch, total, d) {
    if (!S.game.combat && !S.init.size) return;
    const existing = [...S.init.values()].find((e) => e.char === ch.id);
    const tok = tokenForChar(ch.id);
    const doc = { name: ch.name || 'Hero', val: total, dex: d.mods.dex, kind: 'pc', char: ch.id, tok: tok ? tok.id : null, ts: Date.now() };
    Store.Act.initSet(existing ? existing.id : null, doc);
  }

  function heroInput(t) {
    if (H.view === 'build') return builderInput(t);
  }
  function heroChange(t) {
    if (H.view === 'build') return builderChange(t);
    if (t.dataset.coin && /^pcoin-/.test(t.id)) {
      if (!S.readOnly) Store.Act.setGame({ coins: { [t.dataset.coin]: cleanQty(t.value) } });
      return;
    }
    if (t.dataset.coin && /^coin-/.test(t.id)) {
      const ch = S.chars.get(H.id);
      if (ch && canEditChar(ch)) Store.Act.patchChar(ch.id, { coins: { [t.dataset.coin]: cleanQty(t.value) } });
      return;
    }
    if (t.id === 'heroNotes') {
      const ch = S.chars.get(H.id);
      if (ch && canEditChar(ch)) Store.Act.patchChar(ch.id, { notes: String(t.value).slice(0, 8000) });
    }
  }

  function loadSpells() {
    if (!D.spells) Store.loadData('spells').catch(() => toast('Couldn’t load the spell list. Check your connection.', 'warn'));
  }

  /* ------------------------------------------------------ builder */
  const DEFAULT_DRAFT = () => ({
    name: '', race: 'human', subrace: '', cls: 'fighter', subclass: '', level: 1, background: 'acolyte', bgSkills: [], method: 'array',
    base: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, raceChoice: [], raceSkills: [], asi: {}, skills: [], expertise: [], armor: 'none', shield: false,
    weapons: [], spells: [], feats: [], freeFeats: 0, styles: [], picks: {}, hpMode: 'avg', hpManual: '', color: S.me.color, portrait: '', ancestry: '', align: '', acBonus: 0, speedBonus: 0, customRes: [], notes: '',
  });
  function openBuilder(ch) {
    loadSpells();
    H.view = 'build';
    H.editId = ch ? ch.id : null;
    if (ch) {
      H.draft = Object.assign(DEFAULT_DRAFT(), Store.clone(ch));
      delete H.draft.id;
    } else {
      const saved = Store.LS.get(DRAFT_KEY, null);
      H.draft = saved && typeof saved === 'object' ? Object.assign(DEFAULT_DRAFT(), saved) : DEFAULT_DRAFT();
    }
    H.spellQ = '';
    H.spellLvl = 0;
    show('heroes');
    renderPanel('heroes', true);
    panels.heroes.el.scrollTop = 0;
  }
  let draftT = 0;
  function saveDraft() {
    if (H.editId) return;
    clearTimeout(draftT);
    draftT = setTimeout(() => Store.LS.set(DRAFT_KEY, H.draft), 400);
  }
  const PB_BUDGET = 27;
  function builderHtml() {
    const R = D.rules;
    const c = H.draft;
    const cls = R.classes[c.cls];
    const race = R.races[c.race];
    const d = Core.derive(c, R, Store.featsFor(c));
    const lvl = d.level;
    const opt = (v, label, cur) => html`<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${label}</option>`;
    const raceOpts = Object.keys(R.races).map((k) => opt(k, R.races[k].n, c.race));
    const subs = race ? race.subs : [];
    const clsOpts = Object.keys(R.classes).map((k) => opt(k, R.classes[k].n, c.cls));
    const subcls = cls.subs.filter((s) => lvl >= s.start);
    const ancestors = Object.keys(R.traits).filter((k) => k.startsWith('draconic-ancestry-'));
    // ability rows
    const rb = d.racial;
    const pbCost = c.method === 'buy' ? Core.pointBuyCost(c.base) : null;
    const asiUsed = Core.ABILS.reduce((s, ab) => s + (Number(c.asi[ab]) || 0), 0);
    const featIds = (c.feats || []).filter((id) => S.hb.has(id) && (S.hb.get(id).kind || 'feat') === 'feat');
    const freeFeats = Math.max(0, Math.min(4, Number(c.freeFeats) || 0));
    const featCost = Math.max(0, featIds.length - freeFeats) * 2; // a feat takes the place of one Ability Score Improvement
    const asiLeft = d.asiPoints - asiUsed - featCost;
    const canAddFeat = featIds.length < freeFeats || asiLeft >= 2;
    const abRows = Core.ABILS.map((ab) => {
      let input;
      if (c.method === 'array') {
        input = html`<select id="b-${ab}" data-base="${ab}" aria-label="${Core.ABIL_NAME[ab]} score">${Core.STANDARD_ARRAY.map((v) => opt(v, v, c.base[ab]))}</select>`;
      } else if (c.method === 'buy') {
        const v = c.base[ab];
        const up = v < 15 && pbCost != null && pbCost + (Core.POINT_COST[v + 1] - Core.POINT_COST[v]) <= PB_BUDGET;
        input = html`<div class="stepper"><button type="button" data-act="pb" data-ab="${ab}" data-d="-1" ${v > 8 ? '' : 'disabled'} aria-label="Lower">−</button><span class="val num">${v}</span><button type="button" data-act="pb" data-ab="${ab}" data-d="1" ${up ? '' : 'disabled'} aria-label="Raise">+</button></div>`;
      } else {
        input = html`<input type="number" id="b-${ab}" data-base="${ab}" min="1" max="30" value="${c.base[ab]}" inputmode="numeric" aria-label="${Core.ABIL_NAME[ab]} score">`;
      }
      const asi = Number(c.asi[ab]) || 0;
      return html`<div class="ab-row"><b>${Core.ABIL_SHORT[ab]}</b>${input}<span class="rc">${rb[ab] ? '+' + rb[ab] : '—'}</span>
        ${d.asiPoints ? html`<div class="stepper"><button type="button" data-act="asi" data-ab="${ab}" data-d="-1" ${asi > 0 ? '' : 'disabled'} aria-label="Remove improvement">−</button><span class="val num">${asi ? '+' + asi : '0'}</span><button type="button" data-act="asi" data-ab="${ab}" data-d="1" ${asiLeft > 0 && d.scores[ab] < 20 ? '' : 'disabled'} aria-label="Add improvement">+</button></div>` : html`<span class="rc">—</span>`}
        <span><span class="tot" style="display:block">${d.scores[ab]}</span><span class="md" style="display:block">${fmtMod(d.mods[ab])}</span></span></div>`;
    });
    // skills
    const bgSk = Core.backgroundSkills(c, R);
    const raceSk = Core.racialSkills(c, R);
    const choice = cls.skills || { choose: 0, from: [] };
    const picked = (c.skills || []).filter((s) => choice.from.includes(s));
    const skillChips = choice.from.map((sk) => {
      const granted = bgSk.has(sk) || raceSk.has(sk);
      const on = picked.includes(sk);
      return html`<button type="button" class="chip" data-act="skill" data-sk="${sk}" aria-pressed="${on}" ${!on && (granted || picked.length >= choice.choose) ? 'disabled' : ''}>${R.skills[sk].n}</button>`;
    });
    const granted = [...bgSk, ...raceSk].map((sk) => R.skills[sk] && html`<span class="chip locked">${R.skills[sk].n}</span>`);
    const profAll = new Set([...picked, ...bgSk, ...raceSk]);
    const expChips = d.expertiseSlots ? [...profAll, ...d.choices.filter((x) => x.kind === 'skills').flatMap((x) => (c.picks || {})[x.key] || [])].filter((v, i, a) => a.indexOf(v) === i).sort().map((sk) => {
      const on = (c.expertise || []).includes(sk);
      return html`<button type="button" class="chip" data-act="exp" data-sk="${sk}" aria-pressed="${on}" ${!on && (c.expertise || []).filter((x) => profAll.has(x)).length >= d.expertiseSlots ? 'disabled' : ''}>${R.skills[sk].n}</button>`;
    }) : null;
    // gear
    const armorGroups = ['Light', 'Medium', 'Heavy'].map((cat) => html`<optgroup label="${cat} armor${cls.armor.includes(cat) ? '' : ' (not proficient)'}">${Object.keys(R.armor).filter((k) => R.armor[k].cat === cat).map((k) => opt(k, `${R.armor[k].n} · AC ${R.armor[k].base}${R.armor[k].dex ? (R.armor[k].max != null ? ' + Dex (max ' + R.armor[k].max + ')' : ' + Dex') : ''}`, c.armor))}</optgroup>`);
    const wq = (H.wq || '').toLowerCase();
    const weaponChips = ['Simple', 'Martial'].map((cat) => html`<div class="label">${cat} weapons</div><div class="chips">${Object.keys(R.weapons).filter((k) => R.weapons[k].cat === cat && (!wq || R.weapons[k].n.toLowerCase().includes(wq))).map((k) => html`<button type="button" class="chip" data-act="weapon" data-w="${k}" aria-pressed="${(c.weapons || []).includes(k)}">${R.weapons[k].n}${Core.weaponProficient(k, c, R) ? '' : ' ·'}</button>`)}</div>`);
    // spells
    let spellSec = '';
    if (d.cast) {
      const maxL = d.cast.maxLvl;
      const list = D.spells || [];
      const chosen = new Set(c.spells || []);
      const nCantrip = list.filter((s) => chosen.has(s.i) && s.lvl === 0).length;
      const nLeveled = list.filter((s) => chosen.has(s.i) && s.lvl > 0).length;
      const lvTabs = [];
      for (let l = 0; l <= Math.max(maxL, 0); l++) lvTabs.push(html`<button type="button" data-act="spell-lvl" data-l="${l}" aria-pressed="${H.spellLvl === l}">${l === 0 ? 'Cantrips' : ord(l)}</button>`);
      const q = H.spellQ.toLowerCase();
      const listCls = cls.spellList || c.cls; // a homebrew class can borrow another class's list
      const avail = list.filter((s) => (s.cls.includes(listCls) || s.cls.includes(c.cls)) && s.lvl === H.spellLvl && (!q || s.n.toLowerCase().includes(q))).sort((a, b) => a.n.localeCompare(b.n));
      const guide = [];
      if (d.cast.cantrips) guide.push(`${d.cast.cantrips} cantrips`);
      if (d.cast.known) guide.push(`${d.cast.known} spells known`);
      if (d.cast.prepared) guide.push(`${d.cast.prepared} spells prepared each day (${Core.ABIL_SHORT[d.cast.ab]} mod + level)`);
      spellSec = html`<details class="fold" open><summary>Spells <span class="small muted">${nCantrip} cantrips · ${nLeveled} spells</span></summary><div class="fold-in">
        <p class="hint">At level ${lvl}: ${guide.join(', ') || 'no spells yet'}. ${maxL ? `Highest slot: ${ord(maxL)} level.` : 'No spell slots yet at this level.'}${c.cls === 'wizard' ? ' Wizards: pick the spells you have prepared.' : ''}</p>
        ${D.spells ? html`<div class="seg" style="flex-wrap:wrap">${lvTabs}</div>
        <input type="search" id="spellQ" placeholder="Search ${R.classes[c.cls].n.toLowerCase()} spells" value="${H.spellQ}" aria-label="Search spells">
        <div class="pick-list">${avail.length ? avail.map((s) => html`<button type="button" class="pick" data-act="pick-spell" data-i="${s.i}" aria-pressed="${chosen.has(s.i)}"><span class="box">${chosen.has(s.i) ? '✓' : ''}</span><span class="nm">${s.n}</span><span class="small muted">${s.school}${s.area ? ` · ${s.area.size}-ft ${s.area.shape}` : ''}</span></button>`) : html`<p class="hint">No spells match.</p>`}</div>` : html`<p class="hint">Loading spells…</p>`}
      </div></details>`;
    }
    const portrait = safeImg(c.portrait);
    return html`
      <div class="panel-head"><button type="button" class="btn btn-ghost btn-sm" data-act="build-cancel">${icon('back')} ${H.editId ? 'Back to sheet' : 'Heroes'}</button><h2>${H.editId ? 'Edit hero' : 'New hero'}</h2></div>
      <div class="card"><div class="card-title"><h3>Who they are</h3></div>
        <label class="field"><span>Name</span><input type="text" id="b-name" data-bind="name" value="${c.name}" maxlength="60" placeholder="Thorin Ironfoot" autocomplete="off"></label>
        <div class="grid2"><label class="field"><span>Race</span><select id="b-race" data-field="race">${raceOpts}</select></label>
          ${subs.length ? html`<label class="field"><span>Subrace</span><select id="b-subrace" data-field="subrace">${opt('', 'None', c.subrace)}${subs.map((s) => opt(s, R.subraces[s].n, c.subrace))}</select></label>` : html`<span></span>`}</div>
        ${c.race === 'dragonborn' ? html`<label class="field"><span>Draconic ancestry</span><select id="b-anc" data-field="ancestry">${opt('', 'Choose a dragon', c.ancestry)}${ancestors.map((k) => opt(k, `${R.traits[k].n.replace(/^Draconic Ancestry \((.*)\)$/, '$1')} · ${R.traits[k].breath.type} ${R.traits[k].breath.shape}`, c.ancestry))}</select></label>` : ''}
        ${race && race.choose ? html`<div class="field"><span>+1 to two abilities (Half-Elf)</span><div class="chips">${Core.ABILS.filter((ab) => !race.bonus[ab]).map((ab) => html`<button type="button" class="chip" data-act="race-ab" data-ab="${ab}" aria-pressed="${(c.raceChoice || []).includes(ab)}" ${!(c.raceChoice || []).includes(ab) && (c.raceChoice || []).length >= race.choose ? 'disabled' : ''}>${Core.ABIL_NAME[ab]}</button>`)}</div></div>
          <div class="field"><span>Skill Versatility: two skills</span><div class="chips">${Object.keys(R.skills).map((sk) => html`<button type="button" class="chip" data-act="race-sk" data-sk="${sk}" aria-pressed="${(c.raceSkills || []).includes(sk)}" ${!(c.raceSkills || []).includes(sk) && (c.raceSkills || []).length >= 2 ? 'disabled' : ''}>${R.skills[sk].n}</button>`)}</div></div>` : ''}
        <div class="grid2"><label class="field"><span>Class</span><select id="b-cls" data-field="cls">${clsOpts}</select></label>
          <div class="field"><span>Level</span><div class="stepper"><button type="button" data-act="lvl" data-d="-1" ${lvl > 1 ? '' : 'disabled'} aria-label="Lower level">−</button><span class="val num">${lvl}</span><button type="button" data-act="lvl" data-d="1" ${lvl < 20 ? '' : 'disabled'} aria-label="Raise level">+</button></div></div></div>
        ${(() => {
          const flavor = (cls.subs[0] && cls.subs[0].flavor) || cls.subFlavor || 'Subclass';
          const startAt = cls.subs.length ? Math.min(...cls.subs.map((x) => x.start)) : cls.subStart || 3;
          if (!cls.subs.length) return html`<p class="hint">${flavor} at level ${startAt}: there are none for this class yet. Make one in Homebrew → Subclasses.</p>`;
          return html`<label class="field"><span>${flavor}${lvl < startAt ? ` (from level ${startAt})` : ''}</span><select id="b-sub" data-field="subclass" ${lvl < startAt ? 'disabled' : ''}>${opt('', lvl < startAt ? `Chosen at level ${startAt}` : 'Choose later', c.subclass)}${cls.subs.map((x) => html`<option value="${x.i}" ${x.i === c.subclass ? 'selected' : ''} ${lvl >= x.start ? '' : 'disabled'}>${x.n}${x.hb ? ' (homebrew)' : ''}</option>`)}</select></label>`;
        })()}
        <div class="grid2"><label class="field"><span>Background</span><select id="b-bg" data-field="background">${Object.keys(R.backgrounds).map((k) => opt(k, R.backgrounds[k].n, c.background))}${opt('custom', 'Custom background', c.background)}</select></label>
          <label class="field"><span>Alignment</span><input type="text" id="b-align" data-bind="align" value="${c.align}" maxlength="30" placeholder="Neutral good" autocomplete="off"></label></div>
        ${c.background === 'custom' ? html`<div class="field"><span>Background skills (pick two)</span><div class="chips">${Object.keys(R.skills).map((sk) => html`<button type="button" class="chip" data-act="bg-sk" data-sk="${sk}" aria-pressed="${(c.bgSkills || []).includes(sk)}" ${!(c.bgSkills || []).includes(sk) && (c.bgSkills || []).length >= 2 ? 'disabled' : ''}>${R.skills[sk].n}</button>`)}</div></div>` : ''}
        <div class="field"><span>Token color</span><div class="swatches">${Store.PALETTE.map((col) => html`<button type="button" class="swatch" style="--c:${col}" data-act="color" data-c="${col}" aria-pressed="${c.color === col}" aria-label="Color ${col}"></button>`)}</div></div>
        <div class="field"><span>Portrait</span><div class="btn-row">${portrait ? disc(c.name, c.color, portrait, 'lg') : ''}<label class="btn btn-sm">${icon('upload')} ${portrait ? 'Change photo' : 'Add a photo'}<input type="file" id="b-portrait" accept="image/*" class="sr"></label>${portrait ? html`<button type="button" class="btn btn-ghost btn-sm" data-act="portrait-clear">Remove</button>` : ''}</div></div>
      </div>
      <div class="card"><div class="card-title"><h3>Ability scores</h3><span class="small muted num">${c.method === 'buy' ? `${PB_BUDGET - (pbCost || 0)} of ${PB_BUDGET} points left` : ''}</span></div>
        <div class="seg full">${[['array', 'Standard array'], ['buy', 'Point buy'], ['manual', 'Manual']].map(([m, l]) => html`<button type="button" data-act="method" data-m="${m}" aria-pressed="${c.method === m}">${l}</button>`)}</div>
        ${c.method === 'manual' ? html`<div class="btn-row"><button type="button" class="btn btn-sm" data-act="roll-scores">${icon('d20')} Roll 4d6, drop lowest</button><span class="hint">Rolls go to the shared log.</span></div>` : ''}
        <div class="ab-table"><div class="ab-row head"><span></span><span>Base</span><span>Race</span><span>${d.asiPoints ? 'Improve' : ''}</span><span>Total</span></div>${abRows}</div>
        ${d.asiPoints ? html`<p class="hint">Ability Score Improvements at level ${lvl}: ${Math.max(0, asiLeft)} of ${d.asiPoints} points left${featCost ? ` (feats use ${featCost})` : ''}. Scores stop at 20.</p>` : ''}
      </div>
      <div class="card"><div class="card-title"><h3>Skills</h3><span class="small muted">${picked.length} of ${choice.choose} chosen</span></div>
        <div class="chips">${skillChips}</div>
        ${granted.length ? html`<div class="label">From race and background</div><div class="chips">${granted}</div>` : ''}
        ${expChips ? html`<div class="label">Expertise (${d.expertiseSlots})</div><div class="chips">${expChips.length ? expChips : html`<span class="hint">Choose skills first.</span>`}</div>` : c.cls === 'bard' ? html`<p class="hint">Expertise: pick 2 skills at level 3, 2 more at level 10.</p>` : c.cls === 'rogue' ? html`<p class="hint">Expertise: pick 2 skills at level 1, 2 more at level 6.</p>` : ''}
      </div>
      <div class="card"><div class="card-title"><h3>Armor and weapons</h3><span class="small muted">AC ${d.ac}</span></div>
        <div class="grid2"><label class="field"><span>Armor</span><select id="b-armor" data-field="armor">${opt('none', 'No armor', c.armor)}${armorGroups}</select></label>
          <label class="field" style="align-content:end"><span>Shield</span><button type="button" class="chip" data-act="shield" aria-pressed="${!!c.shield}">${c.shield ? 'Shield (+2 AC)' : 'No shield'}</button></label></div>
        <input type="search" id="weaponQ" placeholder="Find a weapon" value="${H.wq || ''}" aria-label="Find a weapon">
        ${weaponChips}
        <p class="hint">A dot after a weapon means this hero isn’t proficient with it.</p>
      </div>
      ${spellSec}
      ${d.styleOptions.length ? html`<div class="card"><div class="card-title"><h3>Fighting style</h3><span class="small muted">${d.styleSlots ? `${(c.styles || []).filter((x) => d.styleOptions.includes(x)).length} of ${d.styleSlots}` : ''}</span></div>
        ${d.styleSlots ? html`<div class="chips">${d.styleOptions.map((st) => {
          const on = (c.styles || []).includes(st);
          return html`<button type="button" class="chip" data-act="style" data-v="${st}" aria-pressed="${on}" ${on || (c.styles || []).filter((x) => d.styleOptions.includes(x)).length < d.styleSlots ? '' : 'disabled'}>${titleCase(st.replace(/-/g, ' '))}</button>`;
        })}</div><p class="hint">Archery, Defense and Dueling change the sheet’s numbers; Great Weapon Fighting rerolls 1s and 2s on damage. The others show as text.</p>` : html`<p class="hint">Chosen at level 2.</p>`}</div>` : ''}
      ${d.choices.length ? html`<div class="card"><div class="card-title"><h3>Choices from features and feats</h3></div>
        ${d.choices.map((ch2) => {
          const cur = (c.picks || {})[ch2.key] || [];
          const full = cur.length >= ch2.n;
          if (ch2.kind === 'options') {
            const nm = (o) => o.name || (o.srd && D.features && D.features[o.id] ? D.features[o.id].n.replace(/^[^:]*:\s*/, '') : titleCase(o.id.replace(/-/g, ' ')));
            const info = (o) => (o.srd && D.features && D.features[o.id] ? D.features[o.id].d : o.desc) || '';
            return html`<div class="field"><span>${ch2.label}: choose ${ch2.n} (${cur.length} chosen)</span><div class="chips">${ch2.options.map((o) => html`<button type="button" class="chip" data-act="pick" data-k="${ch2.key}" data-v="${o.id}" data-n="${ch2.n}" aria-pressed="${cur.includes(o.id)}" title="${String(info(o)).slice(0, 300)}" ${cur.includes(o.id) || !full ? '' : 'disabled'}>${nm(o)}</button>`)}</div>
              <p class="hint">Hover or long-press an option to read it. Chosen options appear on the sheet under Actions or Features.</p></div>`;
          }
          if (ch2.kind === 'skills') {
            return html`<div class="field"><span>${ch2.label}: choose ${ch2.n} skill${ch2.n === 1 ? '' : 's'} (${cur.length} chosen)</span><div class="chips">${ch2.from.map((sk) => html`<button type="button" class="chip" data-act="pick" data-k="${ch2.key}" data-v="${sk}" data-n="${ch2.n}" aria-pressed="${cur.includes(sk)}" ${cur.includes(sk) || !full ? '' : 'disabled'}>${R.skills[sk].n}</button>`)}</div></div>`;
          }
          const top = ch2.maxLvl === 'slot' ? (d.cast ? d.cast.maxLvl : 1) : ch2.maxLvl;
          const q = (H.pickQ || '').toLowerCase();
          const pool = (D.spells || []).filter((sp) => sp.lvl <= top && (ch2.from === 'any' || sp.cls.includes(ch2.from)));
          const shown = pool.filter((sp) => cur.includes(sp.i) || (!q || sp.n.toLowerCase().includes(q))).sort((a, b2) => cur.includes(b2.i) - cur.includes(a.i) || a.lvl - b2.lvl || a.n.localeCompare(b2.n)).slice(0, 40);
          return html`<div class="field"><span>${ch2.label}: choose ${ch2.n} spell${ch2.n === 1 ? '' : 's'}, up to ${top ? ord(top) + ' level' : 'cantrips'}${ch2.from === 'any' ? ' from any class' : ''} (${cur.length} chosen)</span>
            <div class="pick-list">${shown.map((sp) => html`<button type="button" class="pick" data-act="pick" data-k="${ch2.key}" data-v="${sp.i}" data-n="${ch2.n}" aria-pressed="${cur.includes(sp.i)}" ${cur.includes(sp.i) || !full ? '' : 'disabled'}><span class="box">${cur.includes(sp.i) ? '✓' : ''}</span><span class="nm">${sp.n}</span><span class="small muted">${sp.lvl ? ord(sp.lvl) : 'cantrip'}</span></button>`)}</div></div>`;
        })}
        ${d.choices.some((x) => x.kind === 'spells') ? html`<input type="search" id="pickQ" value="${H.pickQ || ''}" placeholder="Search spells for these choices" aria-label="Search spells">` : ''}</div>` : ''}
      <div class="card"><div class="card-title"><h3>Feats</h3><span class="small muted">${featIds.length} chosen</span></div>
        ${[...S.hb.values()].some((f) => (f.kind || 'feat') === 'feat') ? html`<div class="chips">${[...S.hb.values()].filter((f) => (f.kind || 'feat') === 'feat').sort((a, b) => String(a.name).localeCompare(String(b.name))).map((f) => {
          const on = featIds.includes(f.id);
          return html`<button type="button" class="chip" data-act="feat" data-id="${f.id}" aria-pressed="${on}" ${on || canAddFeat ? '' : 'disabled'}>${f.name}</button>`;
        })}</div>` : html`<p class="hint">No feats at this table yet. Make them in the Homebrew tab and they show up here.</p>`}
        <div class="btn-row"><span class="small">Bonus feats</span><div class="stepper"><button type="button" data-act="freefeat" data-d="-1" ${freeFeats > 0 ? '' : 'disabled'} aria-label="Fewer bonus feats">−</button><span class="val num">${freeFeats}</span><button type="button" data-act="freefeat" data-d="1" ${freeFeats < 4 ? '' : 'disabled'} aria-label="More bonus feats">+</button></div></div>
        <p class="hint">Each feat takes the place of one Ability Score Improvement (2 points). Bonus feats are ones your DM grants on top, which cost nothing.</p></div>
      <div class="card"><div class="card-title"><h3>Hit points</h3><span class="small muted">${d.hitDice}</span></div>
        <div class="seg full"><button type="button" data-act="hpmode" data-m="avg" aria-pressed="${c.hpMode !== 'manual'}">Average (${c.hpMode === 'manual' ? Core.derive(Object.assign({}, c, { hpMode: 'avg' }), R, Store.featsFor(c)).hpMax : d.hpMax})</button><button type="button" data-act="hpmode" data-m="manual" aria-pressed="${c.hpMode === 'manual'}">I rolled</button></div>
        ${c.hpMode === 'manual' ? html`<label class="field"><span>Max hit points</span><input type="number" id="b-hp" data-bind="hpManual" min="1" max="999" value="${c.hpManual}" inputmode="numeric"></label>` : ''}
        <div class="grid2"><label class="field"><span>Extra AC (magic, Defense style)</span><input type="number" id="b-acb" data-bind="acBonus" min="-5" max="10" value="${c.acBonus || 0}" inputmode="numeric"></label>
          <label class="field"><span>Extra speed (ft)</span><input type="number" id="b-spb" data-bind="speedBonus" min="-30" max="60" step="5" value="${c.speedBonus || 0}" inputmode="numeric"></label></div>
      </div>
      <div class="card"><div class="card-title"><h3>Custom trackers</h3><button type="button" class="btn btn-sm" data-act="res-add">${icon('plus')} Add</button></div>
        ${(c.customRes || []).length ? (c.customRes || []).map((r, i) => html`<div class="grid2"><input type="text" id="cr-n-${i}" data-res="${i}" data-k="n" value="${r.n}" placeholder="Luck points" aria-label="Tracker name"><div class="btn-row"><input type="number" id="cr-m-${i}" data-res="${i}" data-k="max" value="${r.max}" min="1" max="999" style="width:90px" aria-label="Uses"><button type="button" class="btn btn-ghost btn-sm" data-act="res-del" data-i="${i}">${icon('trash')}</button></div>
          <select id="cr-r-${i}" data-res="${i}" data-k="reset" aria-label="Comes back">${RESET_OPTS.map(([v, l]) => html`<option value="${v}" ${(r.reset || 'long') === v ? 'selected' : ''}>${l}</option>`)}</select>
          <input type="text" id="cr-g-${i}" data-res="${i}" data-k="regain" value="${r.regain || ''}" maxlength="20" placeholder="How many back: empty = all, 1, or 1d6+1" aria-label="How many come back"></div>`) : html`<p class="hint">For anything the sheet doesn’t track: luck points, a magic item’s charges, arrows.</p>`}
      </div>
      <div class="card"><div class="card-title"><h3>At a glance</h3></div>
        <dl class="kv"><dt>Hit points</dt><dd class="num">${d.hpMax}</dd><dt>Armor class</dt><dd class="num">${d.ac} · ${d.acNote}</dd><dt>Speed</dt><dd class="num">${d.speed} ft</dd><dt>Initiative</dt><dd class="num">${fmtMod(d.init)}</dd>
        ${d.cast ? html`<dt>Spell save DC</dt><dd class="num">${d.cast.dc} (attack ${fmtMod(d.cast.atk)})</dd>` : ''}<dt>Proficiency</dt><dd class="num">${fmtMod(d.pb)}</dd></dl></div>
      <div class="save-bar"><button type="button" class="btn btn-ghost" data-act="build-cancel">Cancel</button><button type="button" class="btn btn-primary" data-act="build-save">${icon('check')} ${H.editId ? 'Save changes' : 'Create hero'}</button></div>`;
  }

  function toggleIn(arr, v, max) {
    const a = (arr || []).slice();
    const i = a.indexOf(v);
    if (i >= 0) a.splice(i, 1);
    else if (max === undefined || a.length < max) a.push(v);
    return a;
  }
  function builderAct(a, b) {
    const R = D.rules;
    const c = H.draft;
    let rerender = true;
    switch (a) {
      case 'build-cancel':
        H.view = H.editId ? 'sheet' : 'list';
        if (H.editId) H.id = H.editId;
        break;
      case 'build-save':
        return saveHero();
      case 'lvl':
        c.level = Math.max(1, Math.min(20, (Number(c.level) || 1) + Number(b.dataset.d)));
        trimForClass();
        break;
      case 'method': {
        c.method = b.dataset.m;
        if (c.method === 'array') c.base = { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 };
        else if (c.method === 'buy') c.base = { str: 8, dex: 8, con: 8, int: 8, wis: 8, cha: 8 };
        break;
      }
      case 'pb': {
        const ab = b.dataset.ab;
        const v = Math.max(8, Math.min(15, c.base[ab] + Number(b.dataset.d)));
        const next = Object.assign({}, c.base, { [ab]: v });
        const cost = Core.pointBuyCost(next);
        if (cost != null && cost <= PB_BUDGET) c.base = next;
        break;
      }
      case 'asi': {
        const ab = b.dataset.ab;
        const asi = Object.assign({}, c.asi);
        asi[ab] = Math.max(0, (Number(asi[ab]) || 0) + Number(b.dataset.d));
        c.asi = asi;
        break;
      }
      case 'roll-scores': {
        const vals = [];
        const rolls = [];
        for (const ab of Core.ABILS) {
          const r = Core.roll('4d6kh3');
          vals.push(r.t);
          rolls.push(mk(r, Core.ABIL_SHORT[ab]));
          c.base[ab] = r.t;
        }
        postRoll({ who: c.name || S.me.nick || 'New hero', label: 'Ability scores (4d6, drop lowest)', rolls });
        break;
      }
      case 'skill': {
        const choice = R.classes[c.cls].skills || { choose: 0 };
        c.skills = toggleIn(c.skills, b.dataset.sk, choice.choose);
        break;
      }
      case 'exp':
        c.expertise = toggleIn(c.expertise, b.dataset.sk);
        break;
      case 'race-ab':
        c.raceChoice = toggleIn(c.raceChoice, b.dataset.ab, 2);
        break;
      case 'race-sk':
        c.raceSkills = toggleIn(c.raceSkills, b.dataset.sk, 2);
        break;
      case 'bg-sk':
        c.bgSkills = toggleIn(c.bgSkills, b.dataset.sk, 2);
        break;
      case 'color':
        c.color = b.dataset.c;
        break;
      case 'shield':
        c.shield = !c.shield;
        break;
      case 'weapon':
        c.weapons = toggleIn(c.weapons, b.dataset.w, 12);
        break;
      case 'spell-lvl':
        H.spellLvl = Number(b.dataset.l);
        break;
      case 'pick-spell':
        c.spells = toggleIn(c.spells, b.dataset.i, 80);
        break;
      case 'hpmode':
        c.hpMode = b.dataset.m;
        if (c.hpMode === 'manual' && !c.hpManual) c.hpManual = Core.derive(Object.assign({}, c, { hpMode: 'avg' }), R, Store.featsFor(c)).hpMax;
        break;
      case 'res-add':
        c.customRes = (c.customRes || []).concat([{ id: Store.uid('r'), n: '', max: 1 }]).slice(0, 12);
        break;
      case 'res-del':
        c.customRes = (c.customRes || []).filter((x, i) => i !== Number(b.dataset.i));
        break;
      case 'feat':
        c.feats = toggleIn(c.feats, b.dataset.id);
        break;
      case 'freefeat':
        c.freeFeats = Math.max(0, Math.min(4, (Number(c.freeFeats) || 0) + Number(b.dataset.d)));
        break;
      case 'style': {
        const dd = Core.derive(c, R, Store.featsFor(c));
        const cur = (c.styles || []).filter((x) => dd.styleOptions.includes(x));
        const v = b.dataset.v;
        c.styles = cur.includes(v) ? cur.filter((x) => x !== v) : cur.length < dd.styleSlots ? cur.concat([v]) : cur;
        break;
      }
      case 'pick': {
        const k = b.dataset.k;
        const n = Number(b.dataset.n) || 1;
        const picks = Object.assign({}, c.picks || {});
        const cur = (picks[k] || []).slice();
        const i = cur.indexOf(b.dataset.v);
        if (i >= 0) cur.splice(i, 1);
        else if (cur.length < n) cur.push(b.dataset.v);
        picks[k] = cur;
        c.picks = picks;
        break;
      }
      case 'portrait-clear':
        c.portrait = '';
        break;
      default:
        rerender = false;
    }
    saveDraft();
    if (rerender) renderPanel('heroes', true);
  }
  function trimForClass() {
    const R = D.rules;
    const c = H.draft;
    const cls = R.classes[c.cls];
    if (!cls) return;
    const choice = cls.skills || { choose: 0, from: [] };
    c.skills = (c.skills || []).filter((s) => choice.from.includes(s)).slice(0, choice.choose);
    const lvl = Math.max(1, Math.min(20, Number(c.level) || 1));
    if (c.subclass && !cls.subs.some((s) => s.i === c.subclass && lvl >= s.start)) c.subclass = '';
    const pts = Core.asiPoints(c, R) - Math.max(0, (c.feats || []).filter((id) => S.hb.has(id)).length - (Number(c.freeFeats) || 0)) * 2;
    let used = 0;
    const asi = {};
    Core.ABILS.forEach((ab) => {
      const v = Math.min(Number(c.asi[ab]) || 0, Math.max(0, pts - used));
      if (v) asi[ab] = v;
      used += v;
    });
    c.asi = asi;
  }
  function builderInput(t) {
    const c = H.draft;
    if (t.dataset.bind) {
      c[t.dataset.bind] = t.type === 'number' ? (t.value === '' ? '' : Number(t.value)) : t.value;
      saveDraft();
      return;
    }
    if (t.id === 'spellQ') {
      H.spellQ = t.value;
      refreshPick('heroes');
      return;
    }
    if (t.id === 'pickQ') {
      H.pickQ = t.value;
      refreshPick('heroes');
      return;
    }
    if (t.id === 'weaponQ') {
      H.wq = t.value;
      refreshPick('heroes');
      return;
    }
    if (t.dataset.res !== undefined) {
      const i = Number(t.dataset.res);
      const list = (c.customRes || []).slice();
      if (list[i]) {
        list[i] = Object.assign({}, list[i], { [t.dataset.k]: t.dataset.k === 'max' ? Math.max(1, Math.min(999, Number(t.value) || 1)) : String(t.value).slice(0, 40) });
        if (t.tagName === 'SELECT') {
          c.customRes = list;
          saveDraft();
          return renderPanel('heroes', true);
        }
        c.customRes = list;
        saveDraft();
      }
      return;
    }
    if (t.dataset.base && t.type === 'number') {
      c.base = Object.assign({}, c.base, { [t.dataset.base]: Math.max(1, Math.min(30, Number(t.value) || 10)) });
      saveDraft();
    }
  }
  // re-render while a search box keeps focus
  function refreshPick(id) {
    const p = panels[id];
    p.typing = false;
    renderPanel(id, true);
  }
  function builderChange(t) {
    const R = D.rules;
    const c = H.draft;
    if (t.id === 'b-portrait' && t.files && t.files[0]) {
      makePortrait(t.files[0]).then((url) => {
        c.portrait = url;
        saveDraft();
        renderPanel('heroes', true);
      }).catch((e) => toast(e.message || 'That photo couldn’t be used.', 'warn'));
      return;
    }
    if (t.dataset.field) {
      const f = t.dataset.field;
      c[f] = t.value;
      if (f === 'race') {
        c.subrace = R.races[c.race] && R.races[c.race].subs[0] ? R.races[c.race].subs[0] : '';
        c.raceChoice = [];
        c.raceSkills = [];
        if (c.race !== 'dragonborn') c.ancestry = '';
      }
      if (f === 'cls') {
        c.subclass = '';
        c.spells = [];
        c.expertise = [];
        trimForClass();
      }
      saveDraft();
      renderPanel('heroes', true);
      return;
    }
    if (t.dataset.base && t.tagName === 'SELECT') {
      // standard array: swap so each value is used once
      const ab = t.dataset.base;
      const v = Number(t.value);
      const base = Object.assign({}, c.base);
      const other = Core.ABILS.find((k) => k !== ab && base[k] === v);
      if (other) base[other] = base[ab];
      base[ab] = v;
      c.base = base;
      saveDraft();
      renderPanel('heroes', true);
      return;
    }
    if (t.dataset.bind || t.dataset.base || t.dataset.res !== undefined) renderPanel('heroes', true);
  }
  async function makePortrait(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = () => rej(new Error('That file isn’t an image this browser can open.'));
        img.src = url;
      });
      const s = Math.min(img.naturalWidth, img.naturalHeight);
      const cv = document.createElement('canvas');
      cv.width = cv.height = 160;
      cv.getContext('2d').drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, 160, 160);
      return cv.toDataURL('image/jpeg', 0.82);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  function saveHero() {
    const R = D.rules;
    const c = Store.clone(H.draft);
    c.name = String(c.name || '').trim().slice(0, 60);
    if (!c.name) {
      toast('Give your hero a name first.', 'warn');
      const n = $('#b-name');
      if (n) n.focus();
      return;
    }
    if (c.race === 'dragonborn' && !c.ancestry) {
      toast('Choose a draconic ancestry for your dragonborn.', 'warn');
      return;
    }
    c.level = Math.max(1, Math.min(20, Number(c.level) || 1));
    c.acBonus = Number(c.acBonus) || 0;
    c.speedBonus = Number(c.speedBonus) || 0;
    c.customRes = (c.customRes || []).filter((r) => r.n);
    if (c.method === 'buy' && (Core.pointBuyCost(c.base) || 99) > PB_BUDGET) {
      toast('Point buy is over budget.', 'warn');
      return;
    }
    if (c.hpMode === 'manual' && !(Number(c.hpManual) > 0)) c.hpMode = 'avg';
    const existing = H.editId && S.chars.get(H.editId);
    if (existing) {
      ['owner', 'hp', 'tmp', 'slots', 'res', 'conds', 'death', 'notes', 'fx'].forEach((k) => {
        if (existing[k] !== undefined) c[k] = Store.clone(existing[k]);
      });
      const max = Core.derive(c, R, Store.featsFor(c)).hpMax;
      if (c.hp != null && c.hp > max) c.hp = max;
    } else {
      c.owner = S.me.pk;
      c.hp = null;
      c.tmp = 0;
      c.conds = [];
    }
    delete c.id;
    const id = Store.Act.saveChar(H.editId, c);
    if (!H.editId) {
      clearTimeout(draftT); // a draft save still waiting would bring this hero back as the next draft
      Store.LS.set(DRAFT_KEY, null);
      if (!S.myChar || !S.chars.has(S.myChar)) Store.setMyChar(id);
      toast(`${c.name} is ready. Place their token from the sheet.`);
    }
    H.view = 'sheet';
    H.id = id;
    H.editId = null;
    renderPanel('heroes', true);
    panels.heroes.el.scrollTop = 0;
  }

  /* --------------------------------------------------- spell card */
  function spellDamageAt(sp, slot, charLevel, mod) {
    if (!sp.dmg) return null;
    if (sp.dmg.slot) {
      const keys = Object.keys(sp.dmg.slot).map(Number).sort((a, b) => a - b);
      const k = keys.filter((x) => x <= slot).pop() || keys[0];
      return Core.cleanExpr(sp.dmg.slot[k], mod);
    }
    if (sp.dmg.char) {
      const keys = Object.keys(sp.dmg.char).map(Number).sort((a, b) => a - b);
      const k = keys.filter((x) => x <= charLevel).pop() || keys[0];
      return Core.cleanExpr(sp.dmg.char[k], mod);
    }
    return null;
  }
  function spellHealAt(sp, slot, mod) {
    if (!sp.heal) return null;
    const keys = Object.keys(sp.heal).map(Number).sort((a, b) => a - b);
    const k = keys.filter((x) => x <= slot).pop() || keys[0];
    return Core.cleanExpr(sp.heal[k], mod);
  }
  function openSpell(idx, ch) {
    const sp = D.spellsById && D.spellsById.get(idx);
    if (!sp) return;
    let slot = sp.lvl;
    Sheet.open({
      title: sp.n,
      wide: true,
      live: ['chars'],
      render() {
        const hero = ch && S.chars.get(ch.id);
        const d = hero ? Store.derived(hero) : null;
        const edit = hero && canEditChar(hero);
        const R = D.rules;
        let castBox = '';
        const paid = hero && d && d.grantedCost.find((g) => g.id === sp.i && (g.costN || g.costRes));
        if (paid && edit) castBox = html`<div class="card"><div class="btn-row"><button type="button" class="btn btn-primary" data-act="cast-cost">Cast: ${costText(hero, d, paid.res, paid.costN, paid.costRes).replace(/^Costs /, 'spend ')}</button></div><p class="hint">From ${paid.src}${paid.note ? ' · ' + paid.note : ''}. No spell slot needed.</p></div>`;
        else if (d && d.cast && edit) {
          const used = hero.slots || {};
          const lvOpts = [];
          for (let l = Math.max(1, sp.lvl); l <= 9; l++) {
            const tot = d.cast.slots[l - 1] || 0;
            if (tot) lvOpts.push({ l, left: tot - (used[l] || 0) });
          }
          if (sp.lvl > 0 && !lvOpts.some((o) => o.l === slot)) slot = lvOpts.length ? lvOpts[0].l : sp.lvl;
          const dmgE = spellDamageAt(sp, slot || 1, d.level, d.cast.mod);
          const healE = spellHealAt(sp, slot || 1, d.cast.mod);
          castBox = html`<div class="card">${sp.lvl > 0 ? html`<div class="field"><span>Cast at</span><div class="seg" style="flex-wrap:wrap">${lvOpts.map((o) => html`<button type="button" data-act="slot-lvl" data-l="${o.l}" aria-pressed="${slot === o.l}" ${o.left > 0 ? '' : 'disabled'}>${ord(o.l)} · ${o.left} left</button>`)}</div>${!lvOpts.length ? html`<p class="hint">No slots can cast this spell at this level.</p>` : ''}</div>` : ''}
            <div class="btn-row">${sp.lvl > 0 ? html`<button type="button" class="btn btn-primary" data-act="cast" ${lvOpts.some((o) => o.l === slot && o.left > 0) ? '' : 'disabled'}>Cast (use a ${ord(slot)} slot)</button>` : ''}
            ${sp.atk ? html`<button type="button" class="btn" data-act="sp-atk">Spell attack ${fmtMod(d.cast.atk)}</button>` : ''}
            ${dmgE ? html`<button type="button" class="btn" data-act="sp-dmg">Damage ${dmgE}</button>` : ''}
            ${healE ? html`<button type="button" class="btn btn-heal" data-act="sp-heal">Heal ${healE}</button>` : ''}
            ${sp.area ? html`<button type="button" class="btn" data-act="sp-area">${icon('area')} Place ${sp.area.size}-ft ${sp.area.shape}</button>` : ''}</div>
            ${sp.dc ? html`<p class="hint">Targets make a DC ${d.cast.dc} ${Core.ABIL_NAME[sp.dc.ability]} save${sp.dc.success === 'half' ? ', taking half damage on a success' : sp.dc.success === 'none' ? '; a success avoids the effect' : ''}.</p>` : ''}</div>`;
        } else if (sp.area) {
          castBox = html`<div class="btn-row"><button type="button" class="btn" data-act="sp-area">${icon('area')} Place ${sp.area.size}-ft ${sp.area.shape}</button></div>`;
        }
        return html`<div class="tagline"><span class="badge brass">${sp.lvl === 0 ? sp.school + ' cantrip' : ord(sp.lvl) + '-level ' + sp.school.toLowerCase()}</span>${sp.conc ? html`<span class="badge">Concentration</span>` : ''}${sp.ritual ? html`<span class="badge">Ritual</span>` : ''}${sp.area ? html`<span class="badge">${sp.area.size}-ft ${sp.area.kind}</span>` : ''}</div>
          <dl class="kv"><dt>Casting time</dt><dd>${sp.time}</dd><dt>Range</dt><dd>${sp.range}</dd><dt>Components</dt><dd>${sp.comp}${sp.mat ? ` (${sp.mat})` : ''}</dd><dt>Duration</dt><dd>${sp.dur}</dd><dt>Classes</dt><dd>${sp.cls.map((c) => R.classes[c] ? R.classes[c].n : c).join(', ')}</dd></dl>
          ${castBox}
          <div class="prose">${sp.desc}</div>${sp.higher ? html`<div class="prose"><b>At higher levels.</b> ${sp.higher}</div>` : ''}`;
      },
      act(a, b, e, draw) {
        const hero = ch && S.chars.get(ch.id);
        const d = hero ? Store.derived(hero) : null;
        const who = hero ? hero.name : S.me.nick || 'Someone';
        const lvlTxt = sp.lvl > 0 ? ` (${ord(slot)} level)` : '';
        if (a === 'cast-cost' && hero) {
          const g = d.grantedCost.find((x) => x.id === sp.i);
          if (!g) return;
          if (g.res) {
            const r = d.resources.find((rr) => rr.key === g.res);
            const used = Object.assign({}, hero.res || {});
            const n = Math.max(1, g.costN || 1);
            if (!r || r.max - Math.min(r.max, used[g.res] || 0) < n) return toast(`Not enough ${r ? r.n.toLowerCase() : g.costRes} left.`, 'warn');
            used[g.res] = (used[g.res] || 0) + n;
            Store.Act.patchChar(hero.id, { res: used });
          }
          Store.Act.log({ kind: 'sys', who, label: `${who} casts ${sp.n} (${costText(hero, d, null, g.costN, g.costRes || 'uses') || g.src}).` });
          return toast(`${sp.n} cast.`);
        }
        if (a === 'slot-lvl') {
          slot = Number(b.dataset.l);
          return draw();
        }
        if (a === 'cast' && hero) {
          const used = Object.assign({}, hero.slots || {});
          used[slot] = (used[slot] || 0) + 1;
          Store.Act.patchChar(hero.id, { slots: used });
          Store.Act.log({ kind: 'sys', who, label: `${who} casts ${sp.n}${lvlTxt}.` });
          toast(`${sp.n} cast. One ${ord(slot)}-level slot used.`);
          return;
        }
        if (a === 'sp-atk' && d) return rollD20(who, sp.n + ' · spell attack', d.cast.atk, takeMode());
        if (a === 'sp-dmg' && d) {
          const ex = spellDamageAt(sp, slot || 1, d.level, d.cast.mod);
          return rollExpr(who, sp.n + lvlTxt + (sp.dc ? ` · DC ${d.cast.dc} ${Core.ABIL_SHORT[sp.dc.ability]} save` : ''), ex, sp.dmg.type);
        }
        if (a === 'sp-heal' && d) {
          let ex = spellHealAt(sp, slot || 1, (d.cast || { mod: 0 }).mod);
          let note = '';
          if (d.disciple && sp.lvl > 0) {
            ex += '+' + (2 + (slot || sp.lvl));
            note = ' · Disciple of Life';
          }
          if (d.supremeHealing) {
            ex = String(Core.maxExpr(ex));
            note += ' · Supreme Healing (max dice)';
          }
          return rollExpr(who, sp.n + lvlTxt + ' · healing' + note, ex);
        }
        if (a === 'sp-area') {
          const tok = hero ? tokenForChar(hero.id) : null;
          const dm = d && sp.dmg ? spellDamageAt(sp, slot || sp.lvl || 1, d.level, d.cast ? d.cast.mod : 0) : null;
          Sheet.close(true);
          Board.startAim({ shape: sp.area.shape, size: sp.area.size, width: sp.area.width, color: hero ? hero.color : S.me.color, label: sp.n, caster: sp.area.self && tok ? tok.id : null,
            spell: { roll: dm, dc: d && d.cast ? d.cast.dc : null, save: sp.dc ? sp.dc.ability : null, half: sp.dc ? sp.dc.success === 'half' : false } });
          show('table');
          if (!sp.area.self || !tok) toast('Drag on the map to position the area, then tap Place.');
        }
      },
    });
  }
  function openText(title, text) {
    Sheet.open({ title, render: () => html`<div class="prose">${text || ''}</div>` });
  }

  /* ---------------------------------------------- monster stat block */
  function monsterLine(m) {
    return `${m.size} ${m.type}${m.sub ? ` (${m.sub})` : ''}, ${m.align}`;
  }
  function openStatBlock(monIdx, tokId) {
    const m = D.monstersById && D.monstersById.get(monIdx);
    if (!m) {
      Store.loadData('monsters').then(() => openStatBlock(monIdx, tokId)).catch(() => toast('Couldn’t load monsters.', 'warn'));
      return;
    }
    Sheet.open({
      title: m.n,
      wide: true,
      live: ['tokens', 'art'],
      render() {
        const t = tokId && S.tokens.get(tokId);
        const who = t ? t.name : m.n;
        const ab = m.abil.map((v, i) => html`<button type="button" data-act="m-check" data-i="${i}"><span class="k">${Core.ABIL_SHORT[Core.ABILS[i]]}</span><span class="v">${v}</span> <span class="muted small">${fmtMod(Core.abMod(v))}</span></button>`);
        const line = (k, v) => (v ? html`<div><b>${k}</b> ${v}</div>` : '');
        const saves = m.saves ? Object.keys(m.saves).map((k) => `${Core.ABIL_SHORT[k] || k} ${fmtMod(m.saves[k])}`).join(', ') : '';
        const skills = m.skills ? Object.keys(m.skills).map((k) => `${k} ${fmtMod(m.skills[k])}`).join(', ') : '';
        const actItem = (a, sec, i) => html`<div class="sb-item"><b>${a.n}${a.use ? ` (${a.use})` : ''}.</b> ${a.d}
          ${a.hit != null || (a.dmg && a.dmg.length) || a.area ? html`<div class="btn-row">${a.hit != null ? html`<button type="button" class="btn btn-sm" data-act="m-atk" data-sec="${sec}" data-i="${i}">Attack ${fmtMod(a.hit)}</button>` : ''}
          ${a.dmg && a.dmg.length ? html`<button type="button" class="btn btn-sm" data-act="m-dmg" data-sec="${sec}" data-i="${i}">Damage ${a.dmg.map((x) => x[0]).join(' + ')}</button>` : ''}
          ${a.area ? html`<button type="button" class="btn btn-sm" data-act="m-area" data-sec="${sec}" data-i="${i}">${icon('area')} ${a.area.size}-ft ${a.area.shape}</button>` : ''}</div>` : ''}</div>`;
        const sec = (title, key) => (m[key] && m[key].length ? html`<div class="sb-sec"><h4>${title}</h4>${m[key].map((a, i) => actItem(a, key, i))}</div>` : '');
        return html`<div class="statblock">
          ${t ? html`<div class="card"><div class="card-title"><h3>${t.name}</h3><span class="badge ${t.hp <= 0 ? 'red' : ''}">${healthWord(t.hp, t.max)}</span></div>
            <div class="hp-box"><div class="hp-big">${t.hp}<small> / ${t.max}</small></div>${hpBar(t.hp, t.max)}</div>
            <div class="hp-ctrl"><input type="number" id="sbHp" inputmode="numeric" min="0" placeholder="0" aria-label="Amount"><button type="button" class="btn btn-danger btn-sm" data-act="m-hurt">Damage</button><button type="button" class="btn btn-heal btn-sm" data-act="m-heal">Heal</button></div></div>` : ''}
          ${Store.monImg(m.i) ? html`<div class="btn-row">${disc(m.n, '#e2654f', Store.monImg(m.i), 'lg monster')}</div>` : ''}<div class="sb-sub">${monsterLine(m)}</div><hr class="sb-rule">
          <div>${line('Armor Class', `${m.ac}${m.acn ? ` (${m.acn})` : ''}`)}${line('Hit Points', `${m.hp} (${m.hd})`)}${line('Speed', m.speed)}</div><hr class="sb-rule">
          <div class="sb-abil">${ab}</div><hr class="sb-rule">
          <div>${line('Saving Throws', saves)}${line('Skills', skills)}${line('Damage Vulnerabilities', m.vul)}${line('Damage Resistances', m.res)}${line('Damage Immunities', m.imm)}${line('Condition Immunities', m.cimm)}${line('Senses', m.senses)}${line('Languages', m.lang || '—')}${line('Challenge', `${Core.crLabel(m.cr)} (${m.xp.toLocaleString()} XP) · Proficiency ${fmtMod(m.pb)}`)}</div>
          ${m.traits && m.traits.length ? html`<hr class="sb-rule"><div class="sb-sec">${m.traits.map((a, i) => actItem(a, 'traits', i))}</div>` : ''}
          ${sec('Actions', 'actions')}${sec('Legendary Actions', 'legend')}${sec('Reactions', 'react')}
          ${!t && S.dm ? html`<div class="btn-row"><button type="button" class="btn btn-primary" data-act="m-place">${icon('target')} Add one to the map</button><button type="button" class="btn" data-act="m-enc">${icon('plus')} Add to encounter</button></div>` : ''}
          </div>`;
      },
      act(a, b) {
        const t = tokId && S.tokens.get(tokId);
        const who = t ? t.name : m.n;
        if (a === 'm-check') {
          const i = Number(b.dataset.i);
          const k = Core.ABILS[i];
          const save = m.saves && m.saves[k] != null ? m.saves[k] : Core.abMod(m.abil[i]);
          return rollD20(who, Core.ABIL_NAME[k] + ' save', save);
        }
        const act = b.dataset.sec ? m[b.dataset.sec][Number(b.dataset.i)] : null;
        if (a === 'm-atk' && act) return rollAttack(who, act.n, act.hit, (act.dmg || []).map((x) => [x[0].replace(/\s+/g, ''), x[1]]));
        if (a === 'm-dmg' && act) {
          const rolls = act.dmg.map((x) => mk(Core.roll(x[0].replace(/\s+/g, '')), 'Damage', x[1]));
          return postRoll({ who, label: act.n + (act.dc ? ` · DC ${act.dc[1]} ${Core.ABIL_SHORT[act.dc[0]] || ''} save` : ''), rolls });
        }
        if (a === 'm-area' && act) {
          Sheet.close(true);
          const dm = act.dmg && act.dmg[0] ? act.dmg[0][0].replace(/\s+/g, '') : null;
          Board.startAim({ shape: act.area.shape, size: act.area.size, width: act.area.width, color: '#e2654f', label: act.n, caster: act.area.self && t ? t.id : null,
            spell: { roll: dm, dc: act.dc ? act.dc[1] : null, save: act.dc ? act.dc[0] : null, half: act.dc ? act.dc[2] === 'half' : false } });
          show('table');
          return;
        }
        if ((a === 'm-hurt' || a === 'm-heal') && t) {
          const inp = $('#sbHp');
          const n = Math.max(0, Math.floor(Number(inp && inp.value) || 0));
          if (!n) return toast('Enter an amount first.', 'warn');
          const hp = a === 'm-hurt' ? Math.max(0, t.hp - n) : Math.min(t.max, t.hp + n);
          Store.Act.patchToken(t.id, { hp });
          if (inp) inp.value = '';
          return;
        }
        if (a === 'm-place') {
          Sheet.close(true);
          deployMonsters([{ i: m.i, n: 1 }], { hidden: Enc.hidden, hpMode: Enc.hpMode, rollInit: false });
          show('table');
          return;
        }
        if (a === 'm-enc') {
          addToEncounter(m.i);
          toast(`${m.n} added to the encounter.`);
        }
      },
    });
  }

  /* ------------------------------------------------- token on the map */
  function selCardHtml(t, info) {
    const R = D.rules;
    const edit = !S.readOnly && (S.dm || Board.ownsToken(t));
    const isPc = t.kind === 'pc';
    const mon = info.mon;
    const showNums = S.dm || t.kind !== 'monster' || edit;
    const sub = isPc ? (info.ch ? heroLine(info.ch) : 'Hero') : mon ? `CR ${Core.crLabel(mon.cr)} ${mon.type}` : 'Token';
    const stats = [];
    if (info.ac != null && showNums) stats.push(html`<span class="badge">AC ${info.ac}</span>`);
    if (info.max) stats.push(showNums ? html`<span class="badge ${info.hp <= 0 ? 'red' : ''}">HP ${info.hp}/${info.max}${info.tmp ? ` +${info.tmp}` : ''}</span>` : html`<span class="badge ${info.hp <= 0 ? 'red' : info.hp / info.max <= 0.5 ? 'red' : ''}">${healthWord(info.hp, info.max)}</span>`);
    if (t.hidden) stats.push(html`<span class="badge">Hidden from players</span>`);
    (info.conds || []).forEach((c) => stats.push(html`<span class="badge red">${R && R.conditions[c] ? R.conditions[c].n : c}</span>`));
    const inInit = [...S.init.values()].some((e) => e.tok === t.id || (isPc && e.char === t.char));
    return html`<div class="selcard" data-hud>
      <div class="selcard-head">${disc(info.name, info.color, info.img, t.kind === 'monster' ? 'monster' : '')}
        <div class="main"><div class="title">${info.name}</div><div class="small muted">${sub}</div></div>
        <button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="sel-close" aria-label="Close">${icon('x')}</button></div>
      ${stats.length ? html`<div class="stats">${stats}</div>` : ''}
      ${edit && info.max ? html`<div class="hp-ctrl"><input type="number" id="selHp" inputmode="numeric" min="0" placeholder="0" aria-label="Amount"><button type="button" class="btn btn-danger btn-sm" data-act="sel-dmg">Damage</button><button type="button" class="btn btn-heal btn-sm" data-act="sel-heal">Heal</button></div>` : ''}
      <div class="btn-row">${isPc ? html`<button type="button" class="btn btn-sm" data-act="sel-sheet">${icon('helm')} Sheet</button>` : mon && S.dm ? html`<button type="button" class="btn btn-sm" data-act="sel-sheet">${icon('book')} Stat block</button>` : ''}
        ${edit ? html`<button type="button" class="btn btn-sm" data-act="sel-conds">Conditions</button>` : ''}
        ${edit && S.game.combat && !inInit ? html`<button type="button" class="btn btn-sm" data-act="sel-init">${icon('hourglass')} Roll initiative</button>` : ''}
        ${edit ? html`<button type="button" class="btn btn-ghost btn-sm" data-act="sel-more">${icon('more')} More</button>` : ''}</div></div>`.__html;
  }
  function boardAct(act, b, selId) {
    const t = selId && S.tokens.get(selId);
    switch (act) {
      case 'scene-upload':
        return openScenes(true);
      case 'scene-sample':
        return makeSampleDungeon();
      case 'go-heroes':
        return show('heroes');
    }
    if (!t) return;
    const info = Board.tokInfo(t);
    switch (act) {
      case 'sel-close':
        return Board.selectTok(null);
      case 'sel-dmg':
      case 'sel-heal': {
        const inp = document.getElementById('selHp');
        const n = Math.max(0, Math.floor(Number(inp && inp.value) || 0));
        if (!n) {
          toast('Enter an amount first.', 'warn');
          if (inp) inp.focus();
          return;
        }
        applyHp(t, act === 'sel-dmg' ? -n : n);
        if (inp) inp.value = '';
        return;
      }
      case 'sel-sheet':
        if (t.kind === 'pc' && S.chars.has(t.char)) {
          H.view = 'sheet';
          H.id = t.char;
          loadSpells();
          show('heroes');
          return;
        }
        if (t.mon) return openStatBlock(t.mon, t.id);
        return;
      case 'sel-conds':
        return openConditions(t);
      case 'sel-init':
        return rollTokenInit(t);
      case 'sel-more':
        return openTokenMore(t, info);
    }
  }
  function applyHp(t, delta) {
    if (t.kind === 'pc') {
      const ch = S.chars.get(t.char);
      if (!ch) return;
      if (delta < 0) damageHero(ch, -delta);
      else healHero(ch, delta);
      return;
    }
    if (!t.max) return;
    const hp = Math.max(0, Math.min(t.max, (t.hp == null ? t.max : t.hp) + delta));
    Store.Act.patchToken(t.id, { hp });
    if (hp === 0 && delta < 0) toast(`${t.name || 'Token'} drops to 0 HP.`);
  }
  function openConditions(t) {
    const R = D.rules;
    if (!R) return;
    Sheet.open({
      title: 'Conditions',
      live: ['tokens', 'chars'],
      render() {
        const tok = S.tokens.get(t.id);
        if (!tok) return html`<p class="hint">This token is gone.</p>`;
        const list = tok.kind === 'pc' ? ((S.chars.get(tok.char) || {}).conds || []) : tok.conds || [];
        return html`<p class="hint">${Board.tokInfo(tok).name}</p><div class="chips">${Object.keys(R.conditions).map((c) => html`<button type="button" class="chip cond" data-act="c" data-c="${c}" aria-pressed="${list.includes(c)}">${R.conditions[c].n}</button>`)}</div>
          ${list.length ? html`<div class="list">${list.map((c) => R.conditions[c] ? html`<details class="fold"><summary>${R.conditions[c].n}</summary><div class="fold-in prose">${R.conditions[c].d}</div></details>` : '')}</div>` : ''}`;
      },
      act(a, b) {
        if (a !== 'c') return;
        const tok = S.tokens.get(t.id);
        if (!tok) return;
        const c = b.dataset.c;
        if (tok.kind === 'pc') {
          const ch = S.chars.get(tok.char);
          if (!ch) return;
          Store.Act.patchChar(ch.id, { conds: toggleIn(ch.conds, c) });
        } else Store.Act.patchToken(tok.id, { conds: toggleIn(tok.conds, c) });
      },
    });
  }
  function rollTokenInit(t) {
    if (t.kind === 'pc') {
      const ch = S.chars.get(t.char);
      if (!ch) return;
      const d = Store.derived(ch);
      const r = rollD20(ch.name, 'Initiative', d.init);
      if (r) addHeroInit(ch, r.t, d);
      return;
    }
    const m = t.mon && D.monstersById ? D.monstersById.get(t.mon) : null;
    const dex = m ? Core.abMod(m.abil[1]) : 0;
    const r = rollD20(t.name, 'Initiative', dex);
    if (r) Store.Act.initSet(null, { name: t.name, val: r.t, dex, kind: t.kind, tok: t.id, hidden: t.hidden ? 1 : 0, ts: Date.now() });
  }
  function openTokenMore(t) {
    Sheet.open({
      title: 'Token options',
      live: ['tokens', 'art'],
      render() {
        const tok = S.tokens.get(t.id);
        if (!tok) return html`<p class="hint">This token is gone.</p>`;
        const info = Board.tokInfo(tok);
        const isPc = tok.kind === 'pc';
        return html`${!isPc ? html`<label class="field"><span>Name</span><input type="text" id="tkName" value="${tok.name || ''}" maxlength="40"></label>` : html`<p class="hint">${info.name}’s name and color come from their hero sheet.</p>`}
          <label class="field"><span>Sees (ft, for fog of war; empty = scene default)</span><input type="number" id="tkVision" value="${tok.vision != null ? tok.vision : ''}" min="0" max="1000" step="5" inputmode="numeric"></label>
          <div class="field"><span>Size</span><div class="seg">${[[0.5, 'Tiny'], [1, 'Small/Med'], [2, 'Large'], [3, 'Huge'], [4, 'Garg.']].map(([s, l]) => html`<button type="button" data-act="size" data-s="${s}" aria-pressed="${Number(tok.size || 1) === s}">${l}</button>`)}</div></div>
          ${!isPc ? html`<div class="grid2"><label class="field"><span>Max HP</span><input type="number" id="tkMax" value="${tok.max || ''}" min="0" max="9999" inputmode="numeric"></label><label class="field"><span>AC</span><input type="number" id="tkAc" value="${tok.ac || ''}" min="0" max="40" inputmode="numeric"></label></div>
          <div class="field"><span>Color</span><div class="swatches">${['#e2654f', ...Store.PALETTE].map((col) => html`<button type="button" class="swatch" style="--c:${col}" data-act="color" data-c="${col}" aria-pressed="${tok.color === col}" aria-label="Color ${col}"></button>`)}</div></div>` : ''}
          ${tok.mon ? html`<div class="field"><span>Picture for every ${(info.mon && info.mon.n) || 'monster'}</span><div class="btn-row">${info.img ? disc(info.name, info.color, info.img, 'lg monster') : ''}<label class="btn btn-sm">${icon('upload')} Set picture<input type="file" id="tkImg" accept="image/*" class="sr"></label>${S.art.has(tok.mon) ? html`<button type="button" class="btn btn-ghost btn-sm" data-act="img-clear">Remove</button>` : ''}</div></div>` : ''}
          <div class="btn-row">${S.dm ? html`<button type="button" class="btn" data-act="hide">${icon(tok.hidden ? 'eye' : 'eye-off')} ${tok.hidden ? 'Reveal to players' : 'Hide from players'}</button>` : ''}
            ${!isPc ? html`<button type="button" class="btn" data-act="dup">${icon('copy')} Duplicate</button>` : ''}
            <button type="button" class="btn btn-danger" data-act="remove">${icon('trash')} Remove from map</button></div>`;
      },
      act(a, b) {
        const tok = S.tokens.get(t.id);
        if (!tok) return;
        if (a === 'size') Store.Act.patchToken(tok.id, { size: Number(b.dataset.s) });
        else if (a === 'color') Store.Act.patchToken(tok.id, { color: b.dataset.c });
        else if (a === 'hide') Store.Act.patchToken(tok.id, { hidden: tok.hidden ? 0 : 1 });
        else if (a === 'img-clear' && tok.mon) Store.W.del('art/' + tok.mon);
        else if (a === 'dup') {
          const spot = Board.freeSpot(tok.size);
          const copy = Object.assign({}, tok, { c: spot.c, r: spot.r, ts: Date.now(), hp: tok.max, conds: [] });
          delete copy.id;
          Store.Act.addToken(copy);
          toast('Duplicated.');
        } else if (a === 'remove') {
          Sheet.close(true);
          Board.selectTok(null);
          Store.Act.removeToken(tok.id);
        }
      },
      change(tg) {
        const tok = S.tokens.get(t.id);
        if (!tok) return;
        if (tg.id === 'tkName') Store.Act.patchToken(tok.id, { name: String(tg.value).trim().slice(0, 40) || tok.name });
        if (tg.id === 'tkMax') {
          const mx = Math.max(0, Math.floor(Number(tg.value) || 0));
          Store.Act.patchToken(tok.id, { max: mx, hp: Math.min(tok.hp == null ? mx : tok.hp, mx) });
        }
        if (tg.id === 'tkImg' && tg.files && tg.files[0] && tok.mon) {
          makePortrait(tg.files[0]).then((url) => Store.W.set('art/' + tok.mon, { img: url, by: S.me.pk, ts: Date.now() })).then(() => toast('Picture set for every token of this monster.')).catch((er) => toast(er.message || 'That picture couldn’t be used.', 'warn'));
          return;
        }
        if (tg.id === 'tkVision') Store.Act.patchToken(tok.id, { vision: tg.value === '' ? null : Math.max(0, Math.min(1000, Number(tg.value) || 0)) });
        if (tg.id === 'tkAc') Store.Act.patchToken(tok.id, { ac: Math.max(0, Math.floor(Number(tg.value) || 0)) });
      },
    });
  }

  /* ------------------------------------------------------ templates */
  const SHAPES = [['circle', 'Circle'], ['cone', 'Cone'], ['cube', 'Square'], ['line', 'Line']];
  const tplDraft = { shape: 'circle', size: 20, width: 5, label: '', color: null, q: '' };
  function myHero() {
    return S.myChar && S.chars.get(S.myChar) ? S.chars.get(S.myChar) : myChars()[0] || null;
  }
  function openTemplatePicker() {
    loadSpells();
    Sheet.open({
      title: 'Spell area',
      live: ['data'],
      render() {
        const hero = myHero();
        const known = hero ? (hero.spells || []).map((i) => D.spellsById && D.spellsById.get(i)).filter((s) => s && s.area) : [];
        const d = hero ? Store.derived(hero) : null;
        const q = tplDraft.q.toLowerCase();
        const found = q && D.spells ? D.spells.filter((s) => s.area && s.n.toLowerCase().includes(q)).slice(0, 12) : [];
        const chip = (sp) => html`<button type="button" class="chip" data-act="from-spell" data-i="${sp.i}">${sp.n} <span class="muted">${sp.area.size}-ft ${sp.area.shape}</span></button>`;
        return html`${known.length || (d && d.breath) ? html`<div class="field"><span>${hero.name}’s areas</span><div class="chips">${known.map(chip)}${d && d.breath ? html`<button type="button" class="chip" data-act="from-breath">Breath Weapon <span class="muted">${d.breath.area.size}-ft ${d.breath.area.shape}</span></button>` : ''}</div></div>` : ''}
          <label class="field"><span>Any spell</span><input type="search" id="tplQ" value="${tplDraft.q}" placeholder="Fireball, Cone of Cold, Spirit Guardians…" autocomplete="off"></label>
          ${found.length ? html`<div class="chips">${found.map(chip)}</div>` : q && D.spells ? html`<p class="hint">No spell with an area matches “${tplDraft.q}”.</p>` : ''}
          <hr class="sep"><div class="label">Or draw your own</div>
          <div class="seg full">${SHAPES.map(([s, l]) => html`<button type="button" data-act="shape" data-s="${s}" aria-pressed="${tplDraft.shape === s}">${l}</button>`)}</div>
          <div class="grid2"><label class="field"><span>${tplDraft.shape === 'circle' ? 'Radius (ft)' : tplDraft.shape === 'cube' ? 'Side (ft)' : 'Length (ft)'}</span><input type="number" id="tplSize" value="${tplDraft.size}" min="5" max="400" step="5" inputmode="numeric"></label>
            ${tplDraft.shape === 'line' ? html`<label class="field"><span>Width (ft)</span><input type="number" id="tplW" value="${tplDraft.width}" min="5" max="60" step="5" inputmode="numeric"></label>` : html`<label class="field"><span>Label</span><input type="text" id="tplLabel" value="${tplDraft.label}" maxlength="40" placeholder="Optional"></label>`}</div>
          <div class="chips">${[5, 10, 15, 20, 30, 60].map((s) => html`<button type="button" class="chip" data-act="qsize" data-s="${s}" aria-pressed="${tplDraft.size === s}">${s} ft</button>`)}</div>
          <div class="btn-row end"><button type="button" class="btn btn-primary" data-act="go">${icon('area')} Place on the map</button></div>
          <p class="hint">Squares at least half covered count as inside, the grid rule from the DMG. Cones and lines from a hero start at the edge of their token.</p>`;
      },
      act(a, b, e, draw) {
        const hero = myHero();
        const tok = hero ? tokenForChar(hero.id) : null;
        const d = hero ? Store.derived(hero) : null;
        if (a === 'from-spell') {
          const sp = D.spellsById.get(b.dataset.i);
          if (!sp) return;
          const isMine = hero && (hero.spells || []).includes(sp.i);
          const dm = isMine && d && sp.dmg ? spellDamageAt(sp, sp.lvl || 1, d.level, d.cast ? d.cast.mod : 0) : sp.dmg && sp.dmg.slot ? Object.values(sp.dmg.slot)[0] : sp.dmg && sp.dmg.char ? Object.values(sp.dmg.char)[0] : null;
          Sheet.close(true);
          Board.startAim({ shape: sp.area.shape, size: sp.area.size, width: sp.area.width, color: hero ? hero.color : S.me.color, label: sp.n, caster: sp.area.self && tok ? tok.id : null,
            spell: { roll: dm ? Core.cleanExpr(dm, d && d.cast ? d.cast.mod : 0) : null, dc: isMine && d && d.cast ? d.cast.dc : null, save: sp.dc ? sp.dc.ability : null, half: sp.dc ? sp.dc.success === 'half' : false } });
          return show('table');
        }
        if (a === 'from-breath' && d && d.breath) {
          Sheet.close(true);
          Board.startAim({ shape: d.breath.area.shape, size: d.breath.area.size, width: d.breath.area.width, color: hero.color, label: 'Breath Weapon', caster: tok && tok.id, spell: { roll: d.breath.dmg, dc: d.breath.dc, save: d.breath.save, half: true } });
          return show('table');
        }
        if (a === 'shape') {
          tplDraft.shape = b.dataset.s;
          return draw();
        }
        if (a === 'qsize') {
          tplDraft.size = Number(b.dataset.s);
          return draw();
        }
        if (a === 'go') {
          Sheet.close(true);
          Board.startAim({ shape: tplDraft.shape, size: tplDraft.size, width: tplDraft.width, color: tplDraft.color || S.me.color, label: tplDraft.label, caster: (tplDraft.shape === 'cone' || tplDraft.shape === 'line') && Board.selected() ? Board.selected() : null });
          show('table');
        }
      },
      input(t, draw) {
        if (t.id === 'tplQ') {
          tplDraft.q = t.value;
          Sheet.cur.typing = false;
          draw();
        }
        if (t.id === 'tplSize') tplDraft.size = Math.max(5, Math.min(400, Number(t.value) || 5));
        if (t.id === 'tplW') tplDraft.width = Math.max(5, Math.min(60, Number(t.value) || 5));
        if (t.id === 'tplLabel') tplDraft.label = String(t.value).slice(0, 40);
      },
    });
  }
  function openTemplateSheet(id) {
    const st = { saved: {}, include: null, amount: '', note: '' };
    Sheet.open({
      title: 'Area',
      live: ['tpls', 'tokens', 'chars'],
      render() {
        const t = S.tpls.get(id);
        if (!t) return html`<p class="hint">This area was removed.</p>`;
        const hit = Board.tokensInTemplate(t);
        const mineOrDm = S.dm || t.owner === S.me.pk;
        if (!st.include) {
          st.include = new Set();
          st.seen = new Set();
        }
        hit.tokens.forEach((x) => {
          if (!st.seen.has(x.id)) {
            st.seen.add(x.id);
            st.include.add(x.id);
          }
        });
        const owner = [...S.peers].find((p) => p.presence && p.presence.pk === t.owner);
        const rows = hit.tokens.map((tok) => {
          const info = Board.tokInfo(tok);
          const nums = S.dm || tok.kind !== 'monster';
          const s = st.saved[tok.id];
          return html`<div class="row"><input type="checkbox" data-inc="${tok.id}" ${st.include.has(tok.id) ? 'checked' : ''} aria-label="Include ${info.name}">${disc(info.name, info.color, info.img, tok.kind === 'monster' ? 'monster sm' : 'sm')}
            <span class="main"><span class="title" style="display:block">${info.name}</span><span class="sub" style="display:block">${info.max ? (nums ? `HP ${info.hp}/${info.max}` : healthWord(info.hp, info.max)) : ''}${s ? ` · save ${s.t} ${s.ok ? 'succeeds' : 'fails'}` : ''}</span></span>
            ${t.save ? html`<button type="button" class="chip" data-act="saved" data-id="${tok.id}" aria-pressed="${!!(s && s.ok)}">${s && s.ok ? 'Saved' : 'Failed'}</button>` : ''}</div>`;
        });
        return html`<div class="tagline"><span class="badge brass">${Board.tplLabel(t)}</span>${t.dc ? html`<span class="badge">DC ${t.dc} ${Core.ABIL_SHORT[t.save] || ''} save${t.half ? ', half on success' : ''}</span>` : ''}${owner ? html`<span class="badge">by ${owner.presence.nm || 'someone'}</span>` : ''}</div>
          <div class="label">Inside the area · ${plural(hit.cells.length, 'square')}</div>
          ${rows.length ? html`<div class="list">${rows}</div>` : html`<p class="hint">No tokens are inside.</p>`}
          ${rows.length && (S.dm || mineOrDm) ? html`<div class="card">
            ${t.save ? html`<div class="btn-row"><button type="button" class="btn btn-sm" data-act="roll-saves">${icon('d20')} Roll ${Core.ABIL_SHORT[t.save] || ''} saves</button><span class="hint">${t.dc ? 'Against DC ' + t.dc + '.' : 'Set a DC to auto-mark results.'}</span></div>` : ''}
            <div class="hp-ctrl"><input type="number" id="areaAmt" inputmode="numeric" min="0" placeholder="Damage" value="${st.amount}" aria-label="Damage amount">
              ${t.roll ? html`<button type="button" class="btn btn-sm" data-act="roll-dmg">Roll ${t.roll}</button>` : ''}
              <button type="button" class="btn btn-danger btn-sm" data-act="apply">Apply</button></div>
            <p class="hint">${t.half ? 'Targets marked Saved take half, rounded down.' : t.save ? 'Targets marked Saved take no damage.' : 'Everyone ticked takes the full amount.'}</p></div>` : ''}
          ${mineOrDm ? html`<div class="btn-row"><button type="button" class="btn" data-act="move">${icon('move')} Move</button><button type="button" class="btn btn-danger" data-act="remove">${icon('trash')} Remove</button></div>` : ''}`;
      },
      act(a, b, e, draw) {
        const t = S.tpls.get(id);
        if (!t) return;
        const hit = Board.tokensInTemplate(t);
        if (a === 'saved') {
          const cur = st.saved[b.dataset.id] || { t: '—', ok: false };
          st.saved[b.dataset.id] = { t: cur.t, ok: !cur.ok };
          return draw();
        }
        if (a === 'roll-saves') {
          const ab = t.save;
          const rolls = [];
          hit.tokens.forEach((tok) => {
            if (!st.include.has(tok.id)) return;
            let bonus = 0;
            let name = tok.name;
            if (tok.kind === 'pc') {
              const ch = S.chars.get(tok.char);
              const d = ch && Store.derived(ch);
              bonus = d ? d.saves[ab].bonus : 0;
              name = ch ? ch.name : 'Hero';
            } else {
              const m = tok.mon && D.monstersById && D.monstersById.get(tok.mon);
              const i = Core.ABILS.indexOf(ab);
              bonus = m ? (m.saves && m.saves[ab] != null ? m.saves[ab] : Core.abMod(m.abil[i])) : 0;
            }
            const r = Core.roll(Core.d20Expr(bonus));
            st.saved[tok.id] = { t: r.t, ok: t.dc ? r.t >= t.dc : false };
            rolls.push(mk(r, name));
          });
          if (rolls.length) postRoll({ who: S.me.nick || 'DM', label: `${Core.ABIL_NAME[ab] || 'Saving'} saves${t.dc ? ' vs DC ' + t.dc : ''} · ${t.label || 'area'}`, rolls });
          return draw();
        }
        if (a === 'roll-dmg' && t.roll) {
          const r = rollExpr(S.me.nick || 'Someone', (t.label || 'Area') + ' damage', t.roll);
          if (r) {
            st.amount = r.t;
            draw();
          }
          return;
        }
        if (a === 'apply') {
          const inp = document.getElementById('areaAmt');
          const n = Math.max(0, Math.floor(Number(inp && inp.value) || 0));
          if (!n) return toast('Enter or roll the damage first.', 'warn');
          let count = 0;
          hit.tokens.forEach((tok) => {
            if (!st.include.has(tok.id)) return;
            const s = st.saved[tok.id];
            const dmg = s && s.ok ? (t.half ? Math.floor(n / 2) : t.save ? 0 : n) : n;
            if (dmg > 0) {
              applyHp(tok, -dmg);
              count++;
            }
          });
          toast(`Damage applied to ${plural(count, 'target')}.`);
          st.amount = '';
          return draw();
        }
        if (a === 'move') {
          Sheet.close(true);
          Board.editTemplate(id);
          return show('table');
        }
        if (a === 'remove') {
          Sheet.close(true);
          Store.Act.removeTemplate(id);
        }
      },
      change(tg, draw) {
        if (tg.dataset.inc) {
          if (tg.checked) st.include.add(tg.dataset.inc);
          else st.include.delete(tg.dataset.inc);
        }
        if (tg.id === 'areaAmt') st.amount = tg.value;
      },
    });
  }
  /* ============================================ ENCOUNTER (DM) */
  const Enc = Object.assign({ name: '', mons: [], q: '', crMin: '', crMax: '', type: '', hpMode: 'avg', hidden: true, group: true, partyMode: 'heroes', exclude: [], count: 4, level: 3, loaded: null, limit: 60 }, Store.LS.get('tt.enc', {}));
  const CRS = [0, 0.125, 0.25, 0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 19, 20, 21, 22, 23, 24, 30];
  function saveEnc() {
    const { name, mons, crMin, crMax, type, hpMode, hidden, group, partyMode, exclude, count, level, loaded } = Enc;
    Store.LS.set('tt.enc', { name, mons, crMin, crMax, type, hpMode, hidden, group, partyMode, exclude, count, level, loaded });
  }
  function partyLevels() {
    if (Enc.partyMode === 'manual') return Array.from({ length: Math.max(1, Math.min(12, Enc.count)) }, () => Math.max(1, Math.min(20, Enc.level)));
    return [...S.chars.values()].filter((c) => !Enc.exclude.includes(c.id)).map((c) => Math.max(1, Math.min(20, Number(c.level) || 1)));
  }
  function addToEncounter(i) {
    const row = Enc.mons.find((m) => m.i === i);
    if (row) row.n = Math.min(40, row.n + 1);
    else Enc.mons.push({ i, n: 1 });
    saveEnc();
    schedule('encounter');
  }
  function encRender() {
    if (!S.dm) return html`<div class="empty"><h3>Encounters are for the DM</h3><p class="hint">Switch your role to DM in People and settings to build encounters.</p></div>`;
    if (!D.monsters) {
      Store.loadData('monsters').catch(() => toast('Couldn’t load monsters. Check your connection.', 'warn'));
      return html`<div class="panel-head"><h2>Encounter</h2></div><div class="empty"><h3>Gathering the bestiary…</h3><p class="hint">Loading 334 SRD monsters.</p></div>`;
    }
    const party = partyLevels();
    const group = Enc.mons.map((r) => ({ m: D.monstersById.get(r.i), n: r.n })).filter((g) => g.m);
    const ev = Core.encounter(party, group.map((g) => ({ xp: g.m.xp, count: g.n })));
    const top = Math.max(ev.thresholds[3] * 1.25, ev.adjusted, 1);
    const pos = (v) => Math.min(100, (v / top) * 100);
    const heroes = [...S.chars.values()];
    const q = Enc.q.toLowerCase();
    const crMin = Enc.crMin === '' ? -1 : Number(Enc.crMin);
    const crMax = Enc.crMax === '' ? 99 : Number(Enc.crMax);
    const types = [...new Set(D.monsters.map((m) => m.type))].sort();
    const list = D.monsters.filter((m) => (!q || m.n.toLowerCase().includes(q)) && m.cr >= crMin && m.cr <= crMax && (!Enc.type || m.type === Enc.type)).sort((a, b) => a.cr - b.cr || a.n.localeCompare(b.n));
    const saved = [...S.encs.values()].sort((a, b) => (b.updated || 0) - (a.updated || 0));
    const crOpt = (v, cur) => html`<option value="${v}" ${String(cur) === String(v) ? 'selected' : ''}>${v === '' ? 'Any' : Core.crLabel(v)}</option>`;
    return html`<div class="panel-head"><h2>Encounter</h2>${Enc.loaded && S.encs.has(Enc.loaded) ? html`<span class="badge">Editing “${S.encs.get(Enc.loaded).name}”</span>` : ''}</div>
      <div class="card"><div class="card-title"><h3>Party</h3><div class="seg"><button type="button" data-act="party" data-m="heroes" aria-pressed="${Enc.partyMode === 'heroes'}">Heroes</button><button type="button" data-act="party" data-m="manual" aria-pressed="${Enc.partyMode === 'manual'}">Custom</button></div></div>
        ${Enc.partyMode === 'heroes' ? (heroes.length ? html`<div class="chips">${heroes.map((c) => html`<button type="button" class="chip" data-act="ex" data-id="${c.id}" aria-pressed="${!Enc.exclude.includes(c.id)}">${c.name} · ${c.level || 1}</button>`)}</div>` : html`<p class="hint">No heroes yet. Use a custom party, or have players create heroes.</p>`)
          : html`<div class="grid2"><div class="field"><span>Characters</span><div class="stepper"><button type="button" data-act="pc" data-d="-1">−</button><span class="val num">${Enc.count}</span><button type="button" data-act="pc" data-d="1">+</button></div></div>
          <div class="field"><span>Level</span><div class="stepper"><button type="button" data-act="pl" data-d="-1">−</button><span class="val num">${Enc.level}</span><button type="button" data-act="pl" data-d="1">+</button></div></div></div>`}
      </div>
      <div class="card meter"><div class="card-title"><span class="diff-label diff-${ev.label}">${ev.label}</span><span class="small muted num">${ev.adjusted.toLocaleString()} adjusted XP${ev.count ? ` (×${ev.mult})` : ''}</span></div>
        ${party.length ? html`<div class="meter-bar" style="background:linear-gradient(90deg,#33463d 0 ${pos(ev.thresholds[0])}%,#2f6e4b ${pos(ev.thresholds[0])}% ${pos(ev.thresholds[1])}%,#76782a ${pos(ev.thresholds[1])}% ${pos(ev.thresholds[2])}%,#8c5a1f ${pos(ev.thresholds[2])}% ${pos(ev.thresholds[3])}%,#8c2b1f ${pos(ev.thresholds[3])}% 100%)">${ev.count ? html`<span class="meter-mark" style="left:${pos(ev.adjusted)}%"></span>` : ''}</div>
        <div class="meter-ticks">${['Easy', 'Medium', 'Hard', 'Deadly'].map((l, i) => html`<span style="left:${pos(ev.thresholds[i])}%">${l}</span>`)}</div>
        <p class="hint">Party of ${party.length}: Easy ${ev.thresholds[0].toLocaleString()} · Medium ${ev.thresholds[1].toLocaleString()} · Hard ${ev.thresholds[2].toLocaleString()} · Deadly ${ev.thresholds[3].toLocaleString()} XP. Each hero earns ${ev.perPlayer.toLocaleString()} XP.</p>` : html`<p class="hint">Add a party to rate the encounter.</p>`}
      </div>
      <div class="card"><div class="card-title"><h3>Monsters in this fight</h3><span class="small muted num">${ev.xp.toLocaleString()} XP</span></div>
        ${group.length ? html`<div class="list">${group.map((g) => html`<div class="row mon-row"><span class="cr">${Core.crLabel(g.m.cr)}</span><button type="button" class="main" data-act="sb" data-i="${g.m.i}" style="background:none;border:0;text-align:left;cursor:pointer;padding:0;color:inherit;min-width:0"><span class="title" style="display:block">${g.m.n}</span><span class="sub" style="display:block">${(g.m.xp * g.n).toLocaleString()} XP · AC ${g.m.ac} · HP ${g.m.hp}</span></button>
          <div class="stepper"><button type="button" data-act="cnt" data-i="${g.m.i}" data-d="-1" aria-label="One fewer">−</button><span class="val num">${g.n}</span><button type="button" data-act="cnt" data-i="${g.m.i}" data-d="1" aria-label="One more">+</button></div></div>`)}</div>
          <div class="grid2"><label class="field"><span>Hit points</span><select id="encHp"><option value="avg" ${Enc.hpMode === 'avg' ? 'selected' : ''}>Average</option><option value="roll" ${Enc.hpMode === 'roll' ? 'selected' : ''}>Rolled</option></select></label>
            <label class="field"><span>Name</span><input type="text" id="encName" value="${Enc.name}" maxlength="50" placeholder="Goblin ambush"></label></div>
          <div class="chips"><button type="button" class="chip" data-act="opt" data-k="hidden" aria-pressed="${Enc.hidden}">Start hidden</button><button type="button" class="chip" data-act="opt" data-k="group" aria-pressed="${Enc.group}">Same initiative per kind</button></div>
          <div class="btn-row"><button type="button" class="btn btn-primary" data-act="deploy-init">${icon('hourglass')} Add to map and roll initiative</button><button type="button" class="btn" data-act="deploy">${icon('target')} Add to map</button></div>
          <div class="btn-row"><button type="button" class="btn btn-sm" data-act="save-enc">${icon('check')} ${Enc.loaded && S.encs.has(Enc.loaded) ? 'Save changes' : 'Save encounter'}</button>${Enc.loaded && S.encs.has(Enc.loaded) ? html`<button type="button" class="btn btn-sm btn-ghost" data-act="save-new">Save as new</button>` : ''}<button type="button" class="btn btn-sm btn-ghost" data-act="clear-enc">Clear</button></div>`
          : html`<p class="hint">Add monsters from the list below. Tap a name to read its stat block.</p>`}
      </div>
      ${saved.length ? html`<details class="fold"><summary>Saved encounters <span class="small muted">${saved.length}</span></summary><div class="fold-in"><div class="list">${saved.map((e) => {
        const ms = (e.mons || []).map((r) => ({ m: D.monstersById.get(r.i), n: r.n })).filter((x) => x.m);
        const sev = Core.encounter(party, ms.map((x) => ({ xp: x.m.xp, count: x.n })));
        return html`<div class="row"><span class="main"><span class="title" style="display:block">${e.name || 'Untitled'}</span><span class="sub" style="display:block">${ms.map((x) => `${x.n}× ${x.m.n}`).join(', ')}</span></span><span class="small diff-${sev.label}">${sev.label}</span>
          <button type="button" class="btn btn-sm" data-act="load-enc" data-id="${e.id}">Load</button><button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="del-enc" data-id="${e.id}" aria-label="Delete">${icon('trash')}</button></div>`;
      })}</div></div></details>` : ''}
      <div class="card"><div class="card-title"><h3>Bestiary</h3><span class="small muted">${list.length} of ${D.monsters.length}</span></div>
        <input type="search" id="monQ" value="${Enc.q}" placeholder="Search monsters" aria-label="Search monsters" autocomplete="off">
        <div class="grid3"><label class="field"><span>CR from</span><select id="crMin">${['', ...CRS].map((v) => crOpt(v, Enc.crMin))}</select></label><label class="field"><span>CR to</span><select id="crMax">${['', ...CRS].map((v) => crOpt(v, Enc.crMax))}</select></label>
          <label class="field"><span>Type</span><select id="monType"><option value="">Any</option>${types.map((t) => html`<option value="${t}" ${Enc.type === t ? 'selected' : ''}>${titleCase(t)}</option>`)}</select></label></div>
        <div class="list">${list.slice(0, Enc.limit).map((m) => html`<div class="row mon-row">${Store.monImg(m.i) ? disc(m.n, '#e2654f', Store.monImg(m.i), 'sm monster') : ''}<span class="cr">${Core.crLabel(m.cr)}</span><button type="button" class="main" data-act="sb" data-i="${m.i}" style="background:none;border:0;text-align:left;cursor:pointer;padding:0;color:inherit;min-width:0"><span class="title" style="display:block">${m.n}</span><span class="sub" style="display:block">${m.size} ${m.type} · ${m.xp.toLocaleString()} XP · AC ${m.ac} · HP ${m.hp}</span></button>
          <button type="button" class="btn btn-sm btn-icon" data-act="add" data-i="${m.i}" aria-label="Add ${m.n}">${icon('plus')}</button></div>`)}</div>
        ${list.length > Enc.limit ? html`<button type="button" class="btn btn-ghost" data-act="more-mons">Show ${Math.min(60, list.length - Enc.limit)} more</button>` : ''}
      </div>
      <details class="fold"><summary>Custom token</summary><div class="fold-in">
        <div class="grid2"><label class="field"><span>Name</span><input type="text" id="ctName" maxlength="40" placeholder="Captain Vex"></label><label class="field"><span>Size</span><select id="ctSize"><option value="1">Small/Medium</option><option value="2">Large</option><option value="3">Huge</option><option value="4">Gargantuan</option><option value="0.5">Tiny</option></select></label></div>
        <div class="grid2"><label class="field"><span>Hit points</span><input type="number" id="ctHp" min="0" max="9999" inputmode="numeric" placeholder="22"></label><label class="field"><span>AC</span><input type="number" id="ctAc" min="0" max="40" inputmode="numeric" placeholder="14"></label></div>
        <div class="btn-row end"><button type="button" class="btn" data-act="custom-token">${icon('target')} Put on the map</button></div></div></details>`;
  }
  function encAct(a, b) {
    switch (a) {
      case 'party':
        Enc.partyMode = b.dataset.m;
        break;
      case 'ex':
        Enc.exclude = toggleIn(Enc.exclude, b.dataset.id);
        break;
      case 'pc':
        Enc.count = Math.max(1, Math.min(12, Enc.count + Number(b.dataset.d)));
        break;
      case 'pl':
        Enc.level = Math.max(1, Math.min(20, Enc.level + Number(b.dataset.d)));
        break;
      case 'add':
        return addToEncounter(b.dataset.i);
      case 'cnt': {
        const row = Enc.mons.find((m) => m.i === b.dataset.i);
        if (row) {
          row.n += Number(b.dataset.d);
          if (row.n <= 0) Enc.mons = Enc.mons.filter((m) => m !== row);
          row.n = Math.min(40, row.n);
        }
        break;
      }
      case 'sb':
        return openStatBlock(b.dataset.i);
      case 'opt':
        Enc[b.dataset.k] = !Enc[b.dataset.k];
        break;
      case 'more-mons':
        Enc.limit += 60;
        break;
      case 'deploy':
      case 'deploy-init':
        deployMonsters(Enc.mons, { hidden: Enc.hidden, hpMode: Enc.hpMode, rollInit: a === 'deploy-init', group: Enc.group });
        show('table');
        return;
      case 'save-enc':
      case 'save-new': {
        const name = (Enc.name || '').trim() || 'Encounter ' + (S.encs.size + 1);
        const id = Store.Act.saveEncounter(a === 'save-enc' && Enc.loaded && S.encs.has(Enc.loaded) ? Enc.loaded : null, { name, mons: Enc.mons.map((m) => ({ i: m.i, n: m.n })) });
        Enc.loaded = id;
        Enc.name = name;
        toast(`Saved “${name}”.`);
        break;
      }
      case 'clear-enc':
        Enc.mons = [];
        Enc.name = '';
        Enc.loaded = null;
        break;
      case 'load-enc': {
        const e = S.encs.get(b.dataset.id);
        if (!e) return;
        Enc.mons = (e.mons || []).map((m) => ({ i: m.i, n: m.n }));
        Enc.name = e.name || '';
        Enc.loaded = e.id;
        panels.encounter.el.scrollTop = 0;
        break;
      }
      case 'del-enc': {
        const e = S.encs.get(b.dataset.id);
        if (!e) return;
        return confirmSheet('Delete “' + (e.name || 'encounter') + '”?', 'The saved encounter goes away for good. Monsters already on the map stay.', 'Delete', () => {
          Store.Act.deleteEncounter(e.id);
          if (Enc.loaded === e.id) Enc.loaded = null;
          saveEnc();
        });
      }
      case 'custom-token': {
        const name = ($('#ctName').value || '').trim().slice(0, 40) || 'Token';
        const size = Number($('#ctSize').value) || 1;
        const hp = Math.max(0, Math.floor(Number($('#ctHp').value) || 0));
        const ac = Math.max(0, Math.floor(Number($('#ctAc').value) || 0));
        Store.Act.ensureScene().then((sid) => {
          const spot = Board.freeSpot(size);
          const id = Store.Act.addToken({ scene: sid, kind: 'npc', name, size, c: spot.c, r: spot.r, hp: hp || null, max: hp || null, ac: ac || null, color: '#c9b48a', conds: [], hidden: 0, owner: S.me.pk, ts: Date.now() });
          show('table');
          setTimeout(() => Board.focusToken(id), 60);
        });
        return;
      }
      default:
        return;
    }
    saveEnc();
    renderPanel('encounter', true);
  }
  function encInput(t) {
    if (t.id === 'monQ') {
      Enc.q = t.value;
      Enc.limit = 60;
      refreshPick('encounter');
    }
    if (t.id === 'encName') {
      Enc.name = t.value.slice(0, 50);
      saveEnc();
    }
  }
  function encChange(t) {
    if (t.id === 'crMin') Enc.crMin = t.value;
    else if (t.id === 'crMax') Enc.crMax = t.value;
    else if (t.id === 'monType') Enc.type = t.value;
    else if (t.id === 'encHp') Enc.hpMode = t.value;
    else return;
    Enc.limit = 60;
    saveEnc();
    renderPanel('encounter', true);
  }
  async function deployMonsters(rows, opts) {
    if (!D.monstersById) await Store.loadData('monsters');
    const sid = await Store.Act.ensureScene();
    const counters = {};
    S.tokens.forEach((t) => {
      if (t.scene === sid && t.mon) counters[t.mon] = Math.max(counters[t.mon] || 0, t.num || 0);
    });
    const placed = [];
    let taken = [];
    const groupInit = {};
    const logRolls = [];
    for (const row of rows) {
      const m = D.monstersById.get(row.i);
      if (!m) continue;
      const size = Core.SIZE_CELLS[m.size] || 1;
      for (let k = 0; k < row.n; k++) {
        const num = (counters[m.i] = (counters[m.i] || 0) + 1);
        let hp = m.hp;
        if (opts.hpMode === 'roll') {
          const r = Core.roll(String(m.hd).replace(/\s+/g, ''));
          if (r) hp = Math.max(1, r.t);
        }
        const spot = Board.freeSpot(size, taken);
        taken = spot.cells;
        const name = `${m.n} ${num}`;
        const id = Store.Act.addToken({ scene: sid, kind: 'monster', mon: m.i, name, num, c: spot.c, r: spot.r, size, hp, max: hp, ac: m.ac, hidden: opts.hidden ? 1 : 0, conds: [], ts: Date.now() });
        placed.push(id);
        if (opts.rollInit) {
          const dex = Core.abMod(m.abil[1]);
          let total;
          if (opts.group && groupInit[m.i] !== undefined) total = groupInit[m.i];
          else {
            const r = Core.roll(Core.d20Expr(dex));
            total = r.t;
            groupInit[m.i] = total;
            logRolls.push(mk(r, opts.group ? m.n : name));
          }
          Store.Act.initSet(null, { name, val: total, dex, kind: 'monster', tok: id, hidden: opts.hidden ? 1 : 0, ts: Date.now() });
        }
      }
    }
    if (logRolls.length) postRoll({ who: 'DM', label: 'Monster initiative', rolls: logRolls, priv: 1 });
    if (opts.rollInit && !S.game.combat) setTimeout(() => startCombat(), 400);
    toast(`${plural(placed.length, 'monster')} on the map${opts.hidden ? ', hidden from players' : ''}.`);
    if (placed[0]) setTimeout(() => Board.focusToken(placed[0], false), 80);
  }

  /* ================================================== COMBAT */
  function initOrder(visibleOnly) {
    let list = [...S.init.values()];
    if (visibleOnly && !S.dm) list = list.filter((e) => !e.hidden && !(e.tok && S.tokens.get(e.tok) && S.tokens.get(e.tok).hidden));
    return list.sort((a, b) => (Number(b.val) || 0) - (Number(a.val) || 0) || (Number(b.dex) || 0) - (Number(a.dex) || 0) || String(a.name).localeCompare(String(b.name)) || (a.id < b.id ? -1 : 1));
  }
  function initVisual(e) {
    const t = e.tok && S.tokens.get(e.tok);
    if (e.kind === 'pc' || (t && t.kind === 'pc')) {
      const ch = S.chars.get(e.char || (t && t.char));
      return { name: ch ? ch.name : e.name, color: (ch && safeColor(ch.color)) || '#8fb0a5', img: ch && ch.portrait, monster: false, hp: ch ? Store.heroHp(ch) : null };
    }
    return { name: (t && t.name) || e.name, color: (t && safeColor(t.color)) || '#e2654f', monster: e.kind === 'monster', hp: t && t.max ? { hp: t.hp, max: t.max } : null, hidden: e.hidden || (t && t.hidden) };
  }
  function startCombat() {
    const list = initOrder(false);
    Store.Act.setGame({ combat: 1, round: 1, turn: list.length ? list[0].id : null });
    Store.Act.log({ kind: 'sys', who: S.me.nick || 'DM', label: 'Roll for initiative! Combat begins.' });
  }
  function advance(dir) {
    const list = initOrder(false);
    if (!list.length) return;
    let i = list.findIndex((e) => e.id === S.game.turn);
    let round = Number(S.game.round) || 1;
    if (i < 0) i = dir > 0 ? -1 : 0;
    let n = i + dir;
    if (n >= list.length) {
      n = 0;
      round += 1;
    }
    if (n < 0) {
      n = list.length - 1;
      round = Math.max(1, round - 1);
    }
    Store.Act.setGame({ turn: list[n].id, round });
  }
  function myTurn() {
    const e = S.game.combat && S.init.get(S.game.turn);
    if (!e) return false;
    if (e.char) {
      const ch = S.chars.get(e.char);
      return !!ch && ch.owner === S.me.pk;
    }
    const t = e.tok && S.tokens.get(e.tok);
    return !!t && Board.ownsToken(t);
  }
  const CI = { edit: null };
  function combatRender() {
    const list = initOrder(true);
    const active = !!S.game.combat;
    const cur = S.init.get(S.game.turn);
    const curName = cur ? initVisual(cur).name : '';
    const heroesNoInit = [...S.chars.values()].filter((c) => ![...S.init.values()].some((e) => e.char === c.id));
    const rows = list.map((e) => {
      const v = initVisual(e);
      const now = active && S.game.turn === e.id;
      const hpTxt = v.hp && v.hp.max ? (S.dm || !v.monster ? `HP ${v.hp.hp}/${v.hp.max}` : healthWord(v.hp.hp, v.hp.max)) : '';
      return html`<div class="row init-row ${now ? 'now' : ''}">
        <span class="init-val">${CI.edit === e.id ? html`<input type="number" id="initEdit" value="${e.val}" inputmode="numeric" aria-label="Initiative">` : html`<button type="button" class="btn btn-ghost btn-sm" data-act="edit-init" data-id="${e.id}" style="min-width:52px;font-size:17px;font-weight:700" ${S.dm || myEntry(e) ? '' : 'disabled'}>${e.val}</button>`}</span>
        <span class="disc sm ${v.monster ? 'monster' : ''}" style="--c:${v.color}">${initials(v.name)}</span>
        <button type="button" class="main" data-act="focus" data-id="${e.id}" style="background:none;border:0;text-align:left;cursor:pointer;padding:0;color:inherit;min-width:0"><span class="title" style="display:block">${v.name}${v.hidden ? ' · hidden' : ''}</span><span class="sub" style="display:block">${now ? 'Taking their turn · ' : ''}${hpTxt}</span></button>
        ${S.dm ? html`<button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="rm-init" data-id="${e.id}" aria-label="Remove">${icon('x')}</button>` : ''}</div>`;
    });
    return html`<div class="panel-head"><h2>Combat</h2>${active ? html`<span class="badge brass">Round ${S.game.round || 1}</span>` : ''}</div>
      ${active ? html`<div class="card"><div class="card-title"><h3>${curName ? curName + '’s turn' : 'Choose who goes first'}</h3></div>
        <div class="btn-row">${S.dm ? html`<button type="button" class="btn" data-act="prev">${icon('back')} Back</button>` : ''}${S.dm || myTurn() ? html`<button type="button" class="btn btn-primary" data-act="next">${myTurn() && !S.dm ? 'End my turn' : 'Next turn'}</button>` : ''}</div></div>`
        : html`<div class="empty"><h3>No fight yet</h3><p class="hint">${S.dm ? 'Add monsters from the Encounter tab with “roll initiative”, or start combat with whoever is listed.' : 'When the DM starts combat, roll initiative from your hero’s sheet.'}</p>
          ${S.dm ? html`<button type="button" class="btn btn-primary" data-act="start" ${list.length ? '' : 'disabled'}>Start combat</button>` : ''}</div>`}
      ${rows.length ? html`<div class="list">${rows}</div>` : html`<p class="hint">Nobody has rolled initiative.</p>`}
      <div class="btn-row">${heroesNoInit.length && (S.dm) ? html`<button type="button" class="btn btn-sm" data-act="roll-heroes">${icon('d20')} Roll for heroes (${heroesNoInit.length})</button>` : ''}
        ${S.myChar && S.chars.has(S.myChar) && !initOrder(false).some((e) => e.char === S.myChar) ? html`<button type="button" class="btn btn-sm" data-act="roll-mine">${icon('d20')} Roll my initiative</button>` : ''}
        ${S.dm && (active || list.length) ? html`<button type="button" class="btn btn-danger btn-sm" data-act="end">End combat</button>` : ''}</div>
      <p class="hint">Ties go to the higher Dexterity. Tap an initiative number to change it.</p>`;
  }
  function myEntry(e) {
    if (e.char) {
      const ch = S.chars.get(e.char);
      return !!ch && ch.owner === S.me.pk;
    }
    return false;
  }
  function combatAct(a, b) {
    switch (a) {
      case 'start':
        return startCombat();
      case 'next':
        return advance(1);
      case 'prev':
        return advance(-1);
      case 'end':
        return confirmSheet('End combat?', 'This clears the initiative order for everyone.', 'End combat', () => {
          Store.Act.setGame({ combat: 0, turn: null, round: 0 });
          S.init.forEach((e) => Store.Act.initRemove(e.id));
          Store.Act.log({ kind: 'sys', who: S.me.nick || 'DM', label: 'Combat ends.' });
        });
      case 'rm-init':
        Store.Act.initRemove(b.dataset.id);
        if (S.game.turn === b.dataset.id) advance(1);
        return;
      case 'edit-init':
        CI.edit = b.dataset.id;
        renderPanel('combat', true);
        setTimeout(() => {
          const i = $('#initEdit');
          if (i) {
            i.focus();
            i.select();
          }
        }, 20);
        return;
      case 'focus': {
        const e = S.init.get(b.dataset.id);
        if (!e) return;
        const tok = e.tok || (e.char && ([...S.tokens.values()].find((t) => t.char === e.char) || {}).id);
        if (tok) {
          show('table');
          setTimeout(() => Board.focusToken(tok), 40);
        }
        return;
      }
      case 'roll-heroes': {
        const rolls = [];
        S.chars.forEach((ch) => {
          if ([...S.init.values()].some((e) => e.char === ch.id)) return;
          const d = Store.derived(ch);
          if (!d) return;
          const r = Core.roll(Core.d20Expr(d.init));
          rolls.push(mk(r, ch.name));
          const tok = [...S.tokens.values()].find((t) => t.char === ch.id);
          Store.Act.initSet(null, { name: ch.name, val: r.t, dex: d.mods.dex, kind: 'pc', char: ch.id, tok: tok ? tok.id : null, ts: Date.now() });
        });
        if (rolls.length) postRoll({ who: S.me.nick || 'DM', label: 'Initiative for heroes', rolls, priv: 0 });
        return;
      }
      case 'roll-mine': {
        const ch = S.chars.get(S.myChar);
        if (!ch) return;
        const d = Store.derived(ch);
        const r = rollD20(ch.name, 'Initiative', d.init);
        const tok = [...S.tokens.values()].find((t) => t.char === ch.id);
        if (r) Store.Act.initSet(null, { name: ch.name, val: r.t, dex: d.mods.dex, kind: 'pc', char: ch.id, tok: tok ? tok.id : null, ts: Date.now() });
      }
    }
  }
  function combatChange(t) {
    if (t.id === 'initEdit' && CI.edit) {
      const v = Math.floor(Number(t.value));
      if (Number.isFinite(v)) Store.Act.initPatch(CI.edit, { val: v });
      CI.edit = null;
      renderPanel('combat', true);
    }
  }

  /* ================================================== DICE + LOG */
  const Dice = { mode: 'normal', expr: '' };
  function partsHtml(p) {
    return (p || []).map((x, i) => {
      const sg = x.s < 0 ? ' − ' : i ? ' + ' : '';
      if (x.v !== undefined) return sg + x.v;
      const dropped = new Set(x.x || []);
      const dice = (x.r || []).map((v, k) => (dropped.has(k) ? `<s>${esc(v)}</s>` : esc(v))).join(', ');
      return html`${sg}${(x.r || []).length}d${x.d} (${raw(dice)})`;
    });
  }
  function entryHtml(e) {
    const col = safeColor(e.col) || '#36594f';
    const time = new Date(e.ts || 0);
    const when = isNaN(time) ? '' : time.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (e.kind === 'chat') return html`<div class="entry" style="--c:${col}"><div><div class="who"><b>${e.who || 'Someone'}</b><span>${when}</span></div><div class="chat">${e.text || ''}</div></div></div>`;
    if (e.kind === 'sys') return html`<div class="entry sys" style="--c:${col}"><div><div class="who"><span>${when}</span></div><div class="lbl">${e.label || ''}</div></div></div>`;
    const rolls = (e.rolls || []).map((r) => {
      const cls = r.nat === 20 ? 'crit' : r.nat === 1 ? 'fumble' : '';
      return html`<div><div class="small muted">${r.l || ''}${r.ty ? ` · ${r.ty.toLowerCase()}` : ''}${r.nat === 20 ? ' · natural 20' : r.nat === 1 ? ' · natural 1' : ''}</div><div class="tot ${cls}">${r.t}</div><div class="det">${r.e} = ${partsHtml(r.p)}</div></div>`;
    });
    return html`<div class="entry ${e.priv ? 'priv' : ''}" style="--c:${col}"><div><div class="who"><b>${e.who || 'Someone'}</b><span>${when}${e.priv ? ' · hidden from players' : ''}</span></div><div class="lbl">${e.label || 'Roll'}</div><div class="res">${rolls}</div></div></div>`;
  }
  function trayHtml() {
    return html`<div class="dice-tray">
      <div class="dice-row">${[4, 6, 8, 10, 12, 20, 100].map((s) => html`<button type="button" class="die-btn" data-act="die" data-s="${s}">d${s}</button>`)}</div>
      <div class="btn-row"><div class="seg">${['normal', 'adv', 'dis'].map((m) => html`<button type="button" data-act="dmode" data-m="${m}" aria-pressed="${Dice.mode === m}">${m === 'normal' ? 'Normal' : m === 'adv' ? 'Adv' : 'Dis'}</button>`)}</div><span class="small muted">applies to d20</span>
        ${S.dm ? html`<button type="button" class="chip" data-act="dpriv" aria-pressed="${dmPrivate}">${dmPrivate ? 'Hidden rolls on' : 'Hidden rolls off'}</button>` : ''}</div>
      <form class="expr-row" data-form="expr"><input type="text" id="diceExpr" placeholder="2d6+3, 4d6kh3, or say something" autocomplete="off" value="${Dice.expr}" aria-label="Dice or message"><button type="submit" class="btn btn-primary">Send</button></form></div>`;
  }
  function logRender() {
    const list = S.log.filter((e) => !e.priv || S.dm || e.by === S.me.pk);
    return html`<div class="panel-head"><h2>Dice</h2>${S.dm && S.log.length ? html`<button type="button" class="btn btn-ghost btn-sm" data-act="clear-log">Clear log</button>` : ''}</div>
      <div class="card">${trayHtml()}</div>
      <div class="log-list" id="logList">${list.length ? list.map(entryHtml) : html`<div class="empty"><h3>No rolls yet</h3><p class="hint">Every roll at the table lands here, with each die shown.</p></div>`}</div>`;
  }
  function diceAct(a, b, e) {
    if (a === 'die') {
      const s = Number(b.dataset.s);
      if (s === 20) rollD20(S.me.nick || 'Someone', 'd20', 0, Dice.mode);
      else rollExpr(S.me.nick || 'Someone', 'd' + s, '1d' + s);
      Dice.mode = 'normal';
      return true;
    }
    if (a === 'dmode') {
      Dice.mode = b.dataset.m;
      return true;
    }
    if (a === 'dpriv') {
      dmPrivate = !dmPrivate;
      Store.LS.set('tt.dmPrivate', dmPrivate);
      return true;
    }
    if (a === 'clear-log') {
      confirmSheet('Clear the dice log?', 'All rolls and messages disappear for everyone.', 'Clear log', () => Store.Act.clearLog());
      return false;
    }
    return false;
  }
  function submitExpr(input) {
    const text = String(input.value || '').trim();
    if (!text) return;
    const cleaned = text.replace(/^\/r(oll)?\s+/i, '');
    if (Core.parseDice(cleaned)) {
      rollExpr(S.me.nick || 'Someone', cleaned, cleaned);
    } else if (/^\/r/i.test(text)) {
      toast('That isn’t a dice expression I can read. Try 2d6+3.', 'warn');
      return;
    } else {
      Store.Act.log({ kind: 'chat', who: S.me.nick || 'Someone', text: text.slice(0, 500) });
    }
    input.value = '';
    Dice.expr = '';
  }
  function scrollLog() {
    const p = panels.log && panels.log.el;
    if (p) p.scrollTop = p.scrollHeight;
  }
  function openDice() {
    Sheet.open({
      title: 'Dice',
      live: ['log'],
      render: () => {
        const list = S.log.filter((e) => !e.priv || S.dm || e.by === S.me.pk).slice(-6);
        return html`${trayHtml()}<div class="log-list">${list.map(entryHtml)}</div>`;
      },
      act(a, b, e, draw) {
        if (diceAct(a, b, e)) draw();
      },
      input(t) {
        if (t.id === 'diceExpr') Dice.expr = t.value;
      },
      submit(form, draw) {
        const inp = form.querySelector('#diceExpr');
        if (!inp) return;
        submitExpr(inp);
        if (Sheet.cur) Sheet.cur.typing = false;
        draw();
        const again = document.getElementById('diceExpr');
        if (again) again.focus();
      },
    });
  }

  /* ================================================== SCENES (DM) */
  let uploadState = null;
  function openScenes(startUpload) {
    const st = { name: '', cols: 30, rows: 20, acrossDraft: '' };
    Sheet.open({
      title: 'Scenes and maps',
      wide: true,
      live: ['scenes', 'game', 'maps'],
      render() {
        const scenes = [...S.scenes.values()].sort((a, b) => (a.created || 0) - (b.created || 0));
        const act = Store.activeScene();
        const gr = Object.assign({ size: 70, ox: 0, oy: 0, show: true, color: '#000000', alpha: 0.3 }, act.grid || {});
        const [W, Hh] = Board.dims();
        const across = act.mapId ? Math.round((W / gr.size) * 10) / 10 : act.cols || 30;
        return html`<div class="list">${scenes.length ? scenes.map((s) => html`<div class="row"><span class="main"><span class="title" style="display:block">${s.name || 'Untitled'}</span><span class="sub" style="display:block">${s.mapId ? `Map · ${s.w}×${s.h}px` : `Blank grid · ${s.cols}×${s.rows}`}</span></span>
            ${s.id === act.id ? html`<span class="badge brass">Showing</span>` : html`<button type="button" class="btn btn-sm" data-act="show" data-id="${s.id}">Show to table</button>`}
            <button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="del" data-id="${s.id}" aria-label="Delete ${s.name}">${icon('trash')}</button></div>`) : html`<p class="hint">No saved scenes. The table is on a blank grid.</p>`}</div>
          ${uploadState ? html`<div class="card"><div class="small">${uploadState.label}</div><div class="progress"><i style="width:${Math.round(uploadState.p * 100)}%"></i></div></div>` : ''}
          <div class="btn-row"><label class="btn btn-primary">${icon('upload')} Upload a map<input type="file" id="mapFile" accept="image/png,image/jpeg,image/webp" class="sr"></label>
            <button type="button" class="btn" data-act="sample">${icon('sparkle')} Sample dungeon</button>
            <button type="button" class="btn" data-act="blank">${icon('grid')} New blank grid</button></div>
          <p class="hint">Maps are shrunk to fit if needed (up to 3000 px on the long side) and stored with the table, so everyone sees them.</p>
          <div class="card"><div class="card-title"><h3>Grid for “${act.name || 'this scene'}”</h3><button type="button" class="chip" data-act="gshow" aria-pressed="${gr.show}">${gr.show ? 'Grid shown' : 'Grid hidden'}</button></div>
            <label class="field"><span>Scene name</span><input type="text" id="scName" value="${act.name || ''}" maxlength="60"></label>
            ${act.mapId ? html`<div class="grid2"><label class="field"><span>Squares across the map</span><input type="number" id="gAcross" value="${across}" min="2" max="300" step="0.5" inputmode="decimal"></label>
              <label class="field"><span>Square size (px)</span><input type="number" id="gSize" value="${Math.round(gr.size * 100) / 100}" min="8" max="400" step="0.25" inputmode="decimal"></label></div>
              <input type="range" id="gSizeR" min="10" max="300" step="0.25" value="${gr.size}" aria-label="Square size">
              <div class="grid2"><label class="field"><span>Shift right (px)</span><input type="range" id="gOx" min="0" max="${Math.round(gr.size)}" step="0.5" value="${((gr.ox % gr.size) + gr.size) % gr.size}"></label>
                <label class="field"><span>Shift down (px)</span><input type="range" id="gOy" min="0" max="${Math.round(gr.size)}" step="0.5" value="${((gr.oy % gr.size) + gr.size) % gr.size}"></label></div>
              <p class="hint">Most battle maps list their size, like “30×20”. Enter the first number in Squares across, then nudge the shift sliders until the lines sit on the map’s own grid.</p>`
              : html`<div class="grid2"><label class="field"><span>Columns</span><input type="number" id="gCols" value="${act.cols || 30}" min="4" max="120" inputmode="numeric"></label><label class="field"><span>Rows</span><input type="number" id="gRows" value="${act.rows || 20}" min="4" max="120" inputmode="numeric"></label></div>`}
            <div class="grid2"><div class="field"><span>Line color</span><div class="seg"><button type="button" data-act="gcol" data-c="#000000" aria-pressed="${gr.color === '#000000'}">Dark</button><button type="button" data-act="gcol" data-c="#e9e2cf" aria-pressed="${gr.color !== '#000000'}">Light</button></div></div>
              <label class="field"><span>Line strength</span><input type="range" id="gAlpha" min="0.05" max="0.9" step="0.05" value="${gr.alpha}"></label></div>
            <div class="field"><span>Fog of war</span><div class="btn-row"><button type="button" class="chip" data-act="fog" aria-pressed="${!!(act.fog && act.fog.enabled)}">${act.fog && act.fog.enabled ? 'Fog on' : 'Fog off'}</button>
              <label class="field" style="width:130px"><span>Heroes see (ft)</span><input type="number" id="fogVision" value="${(act.fog && act.fog.vision) || 60}" min="5" max="1000" step="5" inputmode="numeric"></label>
              <button type="button" class="btn btn-ghost btn-sm" data-act="fog-reset">Reset explored area</button></div>
              <p class="hint">Players see only what their heroes can see; walls block sight. Draw walls with the wall tool on the map (drag; tap a wall to remove it). Set a token’s own vision in its More options.</p></div>
            <div class="field"><span>Diagonal movement</span><div class="seg"><button type="button" data-act="diag" data-d="5" aria-pressed="${(S.game.diag || '5') === '5'}">Every square 5 ft</button><button type="button" data-act="diag" data-d="5-10" aria-pressed="${S.game.diag === '5-10'}">5-10-5</button></div></div>
          </div>`;
      },
      act(a, b) {
        const act = Store.activeScene();
        const gr = Object.assign({ size: 70, ox: 0, oy: 0, show: true, color: '#000000', alpha: 0.3 }, act.grid || {});
        if (a === 'show') return Store.Act.setGame({ scene: b.dataset.id });
        if (a === 'del') {
          const s = S.scenes.get(b.dataset.id);
          return confirmSheet(`Delete “${s ? s.name : 'scene'}”?`, 'Its map, tokens and areas are removed for everyone. Heroes stay.', 'Delete scene', () => Store.Act.deleteScene(b.dataset.id).then(() => openScenes()));
        }
        if (a === 'sample') {
          Sheet.close(true);
          return makeSampleDungeon();
        }
        if (a === 'blank') {
          Store.Act.newBlankScene(30, 20, 'Blank grid ' + (S.scenes.size + 1));
          return;
        }
        if (a === 'gshow') return Store.Act.patchScene(act.id, { grid: Object.assign({}, gr, { show: !gr.show }) });
        if (a === 'gcol') return Store.Act.patchScene(act.id, { grid: Object.assign({}, gr, { color: b.dataset.c, alpha: b.dataset.c === '#000000' ? 0.3 : 0.18 }) });
        if (a === 'fog') return Store.Act.patchScene(act.id, { fog: { enabled: !(act.fog && act.fog.enabled) } });
        if (a === 'fog-reset') {
          const doc = Object.assign({}, act);
          delete doc.id;
          delete doc.virtual;
          doc.fog = Object.assign({}, act.fog || {}, { explored: {}, epoch: Date.now() });
          if (S.scenes.has(act.id)) Store.W.set('scenes/' + act.id, doc);
          return toast('Explored area reset.');
        }
        if (a === 'diag') return Store.Act.setGame({ diag: b.dataset.d });
      },
      input(t) {
        const act = Store.activeScene();
        const gr = Object.assign({ size: 70, ox: 0, oy: 0 }, act.grid || {});
        if (t.id === 'gSizeR') {
          Board.previewGrid(Object.assign({}, gr, { size: Number(t.value) }));
          const n = $('#gSize');
          if (n) n.value = t.value;
        }
        if (t.id === 'gOx') Board.previewGrid(Object.assign({}, gr, { ox: Number(t.value) }));
        if (t.id === 'gOy') Board.previewGrid(Object.assign({}, gr, { oy: Number(t.value) }));
        if (t.id === 'gAlpha') Board.previewGrid(Object.assign({}, gr, { alpha: Number(t.value) }));
      },
      change(t) {
        const act = Store.activeScene();
        const gr = Object.assign({ size: 70, ox: 0, oy: 0, show: true, color: '#000000', alpha: 0.3 }, act.grid || {});
        const [W] = Board.dims();
        const setGrid = (patch) => {
          Board.previewGrid(null);
          Store.Act.patchScene(act.id, { grid: Object.assign({}, gr, patch) });
        };
        if (t.id === 'mapFile' && t.files && t.files[0]) return doUpload(t.files[0]);
        if (t.id === 'fogVision') return Store.Act.patchScene(act.id, { fog: { vision: Math.max(5, Math.min(1000, Number(t.value) || 60)) } });
        if (t.id === 'scName') return Store.Act.patchScene(act.id, { name: String(t.value).trim().slice(0, 60) || act.name });
        if (t.id === 'gAcross') {
          const n = Number(t.value);
          if (n >= 2 && act.w) setGrid({ size: Math.round((act.w / n) * 100) / 100 });
          return;
        }
        if (t.id === 'gSize' || t.id === 'gSizeR') {
          const s = Number(t.value);
          if (s >= 8) setGrid({ size: s });
          return;
        }
        if (t.id === 'gOx') return setGrid({ ox: Number(t.value) });
        if (t.id === 'gOy') return setGrid({ oy: Number(t.value) });
        if (t.id === 'gAlpha') return setGrid({ alpha: Number(t.value) });
        if (t.id === 'gCols' || t.id === 'gRows') {
          const v = Math.max(4, Math.min(120, Math.floor(Number(t.value) || 0)));
          return Store.Act.patchScene(act.id, t.id === 'gCols' ? { cols: v } : { rows: v });
        }
        void W;
      },
      onClose: () => Board.previewGrid(null),
    });
    if (startUpload) setTimeout(() => {
      const f = $('#mapFile');
      if (f) f.click();
    }, 60);
  }
  async function doUpload(file) {
    if (!/^image\//.test(file.type)) return toast('Choose a PNG, JPEG or WebP image.', 'warn');
    uploadState = { label: 'Preparing ' + file.name + '…', p: 0.05 };
    if (Sheet.cur) Sheet.cur.draw();
    try {
      await Store.Act.uploadMap(file, (p) => {
        uploadState = { label: 'Saving map to the table…', p: 0.1 + p * 0.9 };
        if (Sheet.cur) Sheet.cur.draw();
      });
      uploadState = null;
      Sheet.close(true);
      show('table');
      toast('Map is up. Open Scenes and maps to line up the grid.');
      setTimeout(() => openScenes(), 600);
    } catch (e) {
      uploadState = null;
      if (Sheet.cur) Sheet.cur.draw();
      toast(e && e.message ? e.message : 'The map upload didn’t finish.', 'warn');
    }
  }

  /* --------------------------------------------- sample dungeon art */
  function mulberry(seed) {
    return () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function drawDungeon(seed) {
    const cols = 32;
    const rows = 22;
    const g = 64;
    const W = cols * g;
    const Hh = rows * g;
    const rnd = mulberry(seed);
    const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
    const floor = Array.from({ length: rows }, () => new Array(cols).fill(0));
    const rooms = [];
    for (let tries = 0; tries < 200 && rooms.length < 8; tries++) {
      const w = ri(4, 8);
      const h = ri(4, 7);
      const x = ri(1, cols - w - 2);
      const y = ri(1, rows - h - 2);
      if (rooms.some((r) => x < r.x + r.w + 2 && x + w + 2 > r.x && y < r.y + r.h + 2 && y + h + 2 > r.y)) continue;
      rooms.push({ x, y, w, h, cx: x + Math.floor(w / 2), cy: y + Math.floor(h / 2) });
    }
    rooms.sort((a, b) => a.cx - b.cx);
    rooms.forEach((r) => {
      for (let i = r.x; i < r.x + r.w; i++) for (let j = r.y; j < r.y + r.h; j++) floor[j][i] = 1;
    });
    const carve = (x, y) => {
      for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) if (y + b < rows - 1 && x + a < cols - 1 && y + b > 0 && x + a > 0) floor[y + b][x + a] = floor[y + b][x + a] || 2;
    };
    for (let k = 1; k < rooms.length; k++) {
      const a = rooms[k - 1];
      const b = rooms[k];
      let x = a.cx;
      let y = a.cy;
      while (x !== b.cx) {
        carve(x, y);
        x += x < b.cx ? 1 : -1;
      }
      while (y !== b.cy) {
        carve(x, y);
        y += y < b.cy ? 1 : -1;
      }
      carve(x, y);
    }
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = Hh;
    const cx = cv.getContext('2d');
    // bedrock
    cx.fillStyle = '#1c1a17';
    cx.fillRect(0, 0, W, Hh);
    for (let i = 0; i < 2600; i++) {
      const v = 24 + Math.floor(rnd() * 18);
      cx.fillStyle = `rgb(${v},${v - 2},${v - 5})`;
      cx.beginPath();
      cx.ellipse(rnd() * W, rnd() * Hh, 4 + rnd() * 22, 3 + rnd() * 14, rnd() * 3, 0, Math.PI * 2);
      cx.fill();
    }
    // flagstones
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        if (!floor[j][i]) continue;
        const base = floor[j][i] === 2 ? 112 : 128;
        for (let a = 0; a < 2; a++) {
          for (let b = 0; b < 2; b++) {
            const v = base + Math.floor(rnd() * 22) - 11;
            cx.fillStyle = `rgb(${v + 6},${v},${v - 12})`;
            cx.fillRect(i * g + a * (g / 2) + 1, j * g + b * (g / 2) + 1, g / 2 - 2, g / 2 - 2);
          }
        }
        cx.fillStyle = 'rgba(40,34,26,0.35)';
        cx.fillRect(i * g, j * g, g, 1.5);
        cx.fillRect(i * g, j * g, 1.5, g);
      }
    }
    // walls along floor edges
    const isF = (i, j) => i >= 0 && j >= 0 && i < cols && j < rows && floor[j][i];
    cx.lineCap = 'square';
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        if (!floor[j][i]) continue;
        const x = i * g;
        const y = j * g;
        const edges = [[!isF(i, j - 1), x, y, x + g, y], [!isF(i, j + 1), x, y + g, x + g, y + g], [!isF(i - 1, j), x, y, x, y + g], [!isF(i + 1, j), x + g, y, x + g, y + g]];
        edges.forEach(([on, x1, y1, x2, y2]) => {
          if (!on) return;
          cx.strokeStyle = '#0d0c0a';
          cx.lineWidth = g * 0.2;
          cx.beginPath();
          cx.moveTo(x1, y1);
          cx.lineTo(x2, y2);
          cx.stroke();
          cx.strokeStyle = 'rgba(160,150,130,0.35)';
          cx.lineWidth = 2;
          cx.stroke();
        });
      }
    }
    // dressing
    rooms.forEach((r, k) => {
      const px = (c) => c * g;
      if (k === 0) {
        // stairs
        for (let s = 0; s < 6; s++) {
          cx.fillStyle = s % 2 ? '#6e6658' : '#7c7465';
          cx.fillRect(px(r.x) + 4, px(r.y) + 4 + s * ((g * 2 - 8) / 6), g * 2 - 8, (g * 2 - 8) / 6);
        }
      }
      if (k % 3 === 1 && r.w >= 5 && r.h >= 5) {
        [[r.x + 1, r.y + 1], [r.x + r.w - 2, r.y + 1], [r.x + 1, r.y + r.h - 2], [r.x + r.w - 2, r.y + r.h - 2]].forEach(([c, rr]) => {
          const grd = cx.createRadialGradient(px(c) + g / 2 - 6, px(rr) + g / 2 - 6, 2, px(c) + g / 2, px(rr) + g / 2, g * 0.42);
          grd.addColorStop(0, '#b3aa96');
          grd.addColorStop(1, '#4e473c');
          cx.fillStyle = grd;
          cx.beginPath();
          cx.arc(px(c) + g / 2, px(rr) + g / 2, g * 0.38, 0, Math.PI * 2);
          cx.fill();
        });
      }
      if (k % 3 === 2) {
        const grd = cx.createRadialGradient(px(r.cx), px(r.cy), 4, px(r.cx), px(r.cy), g * 1.3);
        grd.addColorStop(0, '#2f6f86');
        grd.addColorStop(1, '#173847');
        cx.fillStyle = grd;
        cx.beginPath();
        cx.ellipse(px(r.cx), px(r.cy), g * 1.25, g * 0.9, 0.2, 0, Math.PI * 2);
        cx.fill();
      }
      if (k === rooms.length - 1) {
        cx.fillStyle = '#5b3a1e';
        cx.fillRect(px(r.x + r.w - 2) + 10, px(r.y + 1) + 18, g - 20, g - 30);
        cx.fillStyle = '#c99a3c';
        cx.fillRect(px(r.x + r.w - 2) + 10, px(r.y + 1) + 28, g - 20, 4);
      }
      // torch glow
      const tx = px(r.x) + g * 0.3;
      const ty = px(r.cy) + g / 2;
      const glow = cx.createRadialGradient(tx, ty, 2, tx, ty, g * 2.2);
      glow.addColorStop(0, 'rgba(255,190,90,0.38)');
      glow.addColorStop(1, 'rgba(255,190,90,0)');
      cx.fillStyle = glow;
      cx.beginPath();
      cx.arc(tx, ty, g * 2.2, 0, Math.PI * 2);
      cx.fill();
      // rubble
      for (let i = 0; i < 7; i++) {
        const c = ri(r.x, r.x + r.w - 1);
        const rr = ri(r.y, r.y + r.h - 1);
        cx.fillStyle = 'rgba(70,64,54,0.9)';
        cx.beginPath();
        cx.arc(px(c) + rnd() * g, px(rr) + rnd() * g, 2 + rnd() * 5, 0, Math.PI * 2);
        cx.fill();
      }
    });
    // vignette
    const vg = cx.createRadialGradient(W / 2, Hh / 2, Math.min(W, Hh) * 0.3, W / 2, Hh / 2, Math.max(W, Hh) * 0.7);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.45)');
    cx.fillStyle = vg;
    cx.fillRect(0, 0, W, Hh);
    return { cv, W, H: Hh, g };
  }
  async function makeSampleDungeon() {
    toast('Drawing a dungeon…');
    try {
      const { cv, W, H: Hh, g } = drawDungeon((Date.now() % 100000) + 7);
      const blob = await new Promise((res) => cv.toBlob(res, 'image/jpeg', 0.82));
      if (!blob) throw new Error('no image');
      await Store.Act.storeGeneratedMap(blob, W, Hh, 'Sample dungeon', g);
      show('table');
      toast('Sample dungeon is on the table. Each square is 5 feet.');
    } catch (e) {
      console.error(e);
      toast('The sample map couldn’t be saved.', 'warn');
    }
  }

  /* ================================================== HOMEBREW */
  // The table's own feats, magic items, spells, monsters, subclasses and classes. Every field is
  // bound to a path in the draft (data-path="features.2.name"), so nested lists share one editor.
  const HB_KINDS = [
    ['feat', 'Feats', 'feat'], ['item', 'Magic items', 'magic item'], ['spell', 'Spells', 'spell'],
    ['monster', 'Monsters', 'monster'], ['subclass', 'Subclasses', 'subclass'], ['class', 'Classes', 'class'],
  ];
  const HB = { view: 'list', kind: 'feat', id: null, draft: null };
  const FX_LABEL = {
    attack: 'Attack change (to hit, damage)', ability: 'Ability score increase', ac: 'Armor class bonus', speed: 'Speed bonus',
    init: 'Initiative bonus', hpPerLevel: 'Hit points per level', passive: 'Passive Perception bonus', save: 'Saving throw bonus',
    saveProf: 'Saving throw proficiency', skillProf: 'Skill proficiency', resource: 'Limited uses (tracker)', crit: 'Wider critical range',
    spells: 'Spells (grant or choose)', skillChoice: 'Choose skill proficiencies', expertise: 'Extra Expertise picks', extraAttack: 'Extra Attack',
    unarmored: 'Unarmored Defense', armorProf: 'Armor training', checkHalf: 'Half proficiency on ability checks',
    options: 'Choose from options (maneuvers, totems, techniques…)',
  };
  const FX_DEFAULT = {
    attack: { when: 'toggle', filter: 'any', hit: 0, dmg: '' }, ability: { ab: 'str', n: 1 }, ac: { n: 1 }, speed: { n: 5 }, init: { n: 1 },
    hpPerLevel: { n: 1 }, passive: { n: 5 }, save: { ab: 'all', n: 1 }, saveProf: { ab: 'con' }, skillProf: { sk: 'perception' },
    resource: { name: '', max: 'pb', reset: 'long' }, crit: { min: 19 },
    spells: { mode: 'choose', count: 2, from: 'any', maxLvl: '1', ab: '', free: false, list: [] }, skillChoice: { n: 2, from: [] }, expertise: { n: 2 },
    extraAttack: { n: 1 }, unarmored: { ab: 'con' }, armorProf: { cat: 'Medium' }, checkHalf: { abs: ['str', 'dex', 'con'] },
    options: { label: '', n: 1, more: '', options: [] },
  };
  const ROW_DEFAULT = {
    features: () => ({ lvl: '1', name: '', desc: '', act: '', costRes: '', costN: '', roll: '', note: '', effects: [] }),
    options: () => ({ id: Store.uid('o'), name: '', desc: '', act: '', costRes: '', costN: '', roll: '', note: '', effects: [] }),
    traits: () => ({ n: '', d: '' }),
    legend: () => ({ n: '', d: '' }),
    react: () => ({ n: '', d: '' }),
    actions: () => ({ n: '', d: '', hit: '', dmg: '', dmgType: '', save: '', dc: '', saveOn: 'half', area: '', areaSize: '15' }),
  };
  function hbDefault(kind) {
    const base = { kind, name: '', desc: '' };
    switch (kind) {
      case 'item': return Object.assign(base, { rarity: 'uncommon', attune: false, weapon: '', effects: [] });
      case 'spell': return Object.assign(base, { lvl: '1', school: 'Evocation', cls: [], time: '1 action', range: '60 feet', comp: 'V, S', dur: 'Instantaneous', conc: false, ritual: false, atk: '', save: '', saveOn: 'half', dmg: '', dmgType: '', dmgUp: '', grow: true, heal: '', healUp: '', area: '', areaSize: '20', areaWidth: '5', areaSelf: false, higher: '' });
      case 'monster': return Object.assign(base, { size: 'Medium', type: 'monstrosity', align: 'unaligned', ac: '12', acn: '', hp: '11', hd: '2d8+2', speed: '30 ft.', abil: ['10', '10', '10', '10', '10', '10'], cr: '1', saves: {}, senses: 'passive Perception 10', lang: '—', vul: '', res: '', imm: '', cimm: '', traits: [], actions: [], legend: [], react: [] });
      case 'subclass': return Object.assign(base, { cls: 'fighter', features: [] });
      case 'class': return Object.assign(base, { hd: '8', saves: ['str', 'con'], armor: ['Light'], weapons: 'simple', skillsChoose: '2', skills: [], cast: 'none', castAb: 'int', spellList: 'wizard', cantrips: '0', subLevel: '3', subLevels: '3, 7, 10, 15, 18', subName: 'Path', features: [] });
      default: return Object.assign(base, { effects: [] });
    }
  }
  // Optional starting points for classes: the usual shape of each kind of class.
  const CLASS_FRAMEWORKS = {
    martial: { label: 'Martial (weapons and armor)', hd: '10', saves: ['str', 'con'], armor: ['Light', 'Medium', 'Heavy', 'Shield'], weapons: 'martial', skillsChoose: '2', cast: 'none', subLevel: '3', subLevels: '3, 7, 10, 15, 18', rows: [[1, 'Combat training'], [2, 'Level 2 feature'], [5, 'Extra Attack', [{ t: 'extraAttack', n: 1 }]], [9, 'Level 9 feature'], [11, 'Improved Extra Attack', [{ t: 'extraAttack', n: 2 }]], [13, 'Level 13 feature'], [17, 'Level 17 feature'], [20, 'Capstone']] },
    expert: { label: 'Expert (skills and cunning)', hd: '8', saves: ['dex', 'int'], armor: ['Light'], weapons: 'simple', skillsChoose: '4', cast: 'none', subLevel: '3', subLevels: '3, 9, 13, 17', rows: [[1, 'Expertise', [{ t: 'expertise', n: 2 }]], [2, 'Level 2 feature'], [5, 'Level 5 feature'], [6, 'More Expertise', [{ t: 'expertise', n: 2 }]], [7, 'Level 7 feature'], [11, 'Level 11 feature'], [15, 'Level 15 feature'], [20, 'Capstone']] },
    half: { label: 'Half caster (warrior with spells)', hd: '10', saves: ['wis', 'cha'], armor: ['Light', 'Medium', 'Heavy', 'Shield'], weapons: 'martial', skillsChoose: '2', cast: 'half', castAb: 'cha', subLevel: '3', subLevels: '3, 7, 15, 20', rows: [[1, 'Level 1 feature'], [2, 'Fighting technique'], [5, 'Extra Attack', [{ t: 'extraAttack', n: 1 }]], [6, 'Level 6 feature'], [10, 'Level 10 feature'], [14, 'Level 14 feature'], [18, 'Level 18 feature']] },
    full: { label: 'Full caster (scholar of magic)', hd: '6', saves: ['int', 'wis'], armor: [], weapons: 'simple', skillsChoose: '2', cast: 'full', castAb: 'int', cantrips: '3', subLevel: '2', subLevels: '2, 6, 10, 14', rows: [[1, 'Level 1 feature'], [18, 'Level 18 feature'], [20, 'Capstone']] },
    pact: { label: 'Pact caster (bargain for power)', hd: '8', saves: ['wis', 'cha'], armor: ['Light'], weapons: 'simple', skillsChoose: '2', cast: 'pact', castAb: 'cha', cantrips: '2', subLevel: '1', subLevels: '1, 6, 10, 14', rows: [[2, 'Level 2 feature'], [3, 'Level 3 feature'], [11, 'Level 11 feature'], [20, 'Capstone']] },
    divine: { label: 'Divine caster (faith and healing)', hd: '8', saves: ['wis', 'cha'], armor: ['Light', 'Medium', 'Shield'], weapons: 'simple', skillsChoose: '2', cast: 'full', castAb: 'wis', cantrips: '3', subLevel: '1', subLevels: '1, 2, 6, 8, 17', rows: [[2, 'Level 2 feature'], [5, 'Level 5 feature'], [10, 'Level 10 feature']] },
  };
  // the levels a class's subclasses usually get features at
  function subclassLevels(clsId) {
    const R = D.rules;
    const C = R && R.classes[clsId];
    if (!C) return [];
    if (C.hb) {
      const f = S.hb.get(clsId.slice(3));
      return String((f && f.subLevels) || C.subStart || 3).split(/[,\s]+/).map(Number).filter((n) => n >= 1 && n <= 20);
    }
    const sub = C.subs.find((x) => !x.hb) || C.subs[0];
    return sub ? Object.keys(sub.levels).map(Number).concat([sub.start]).filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b) : [];
  }
  const canEditHb = (f) => !S.readOnly && (S.dm || !f || f.by === S.me.pk);
  const kindName = (k) => (HB_KINDS.find((x) => x[0] === k) || HB_KINDS[0])[2];
  const getPath = (o, path) => String(path).split('.').reduce((a, k) => (a == null ? a : a[k]), o);
  function setPath(o, path, v) {
    const ks = String(path).split('.');
    const last = ks.pop();
    const t = ks.reduce((a, k) => (a == null ? a : a[k]), o);
    if (t && typeof t === 'object') t[last] = v;
  }
  const pid = (path) => 'hb-' + String(path).replace(/\./g, '-');
  function fxLines(f) {
    return (f.effects || []).map(Core.describeEffect).filter(Boolean);
  }
  // one-line summary of any homebrew entry, for lists
  function hbSummary(f) {
    switch (f.kind) {
      case 'item': return [titleCase(f.rarity || 'uncommon'), f.attune ? 'requires attunement' : '', f.weapon && D.rules && D.rules.weapons[f.weapon] ? D.rules.weapons[f.weapon].n : '', ...fxLines(f)].filter(Boolean).join(' · ');
      case 'spell': {
        const sp = D.spellsById && D.spellsById.get('hb-' + f.id);
        return sp ? `${sp.lvl ? ord(sp.lvl) + '-level ' + sp.school.toLowerCase() : sp.school + ' cantrip'}${sp.dmg ? ' · ' + Object.values(sp.dmg.slot || sp.dmg.char)[0] + ' ' + sp.dmg.type.toLowerCase() : ''}${sp.area ? ` · ${sp.area.size}-ft ${sp.area.shape}` : ''}` : '';
      }
      case 'monster': {
        const m = D.monstersById && D.monstersById.get('hb-' + f.id);
        return m ? `CR ${Core.crLabel(m.cr)} ${m.size.toLowerCase()} ${m.type} · AC ${m.ac} · HP ${m.hp}` : '';
      }
      case 'subclass': {
        const C = D.rules && D.rules.classes[f.cls];
        return `${C ? C.n : 'Class'} · ${plural((f.features || []).length, 'feature')}`;
      }
      case 'class': return `d${f.hd || 8} hit die · ${f.cast && f.cast !== 'none' ? f.cast + ' caster' : 'no spellcasting'} · ${plural((f.features || []).length, 'feature')}`;
      default: return fxLines(f).join(' · ') || 'Description only';
    }
  }
  function openFeat(f) {
    const lines = fxLines(f);
    openText(f.name || 'Feat', (f.desc || '') + (lines.length ? (f.desc ? '\n\n' : '') + 'In Tavern Table:\n• ' + lines.join('\n• ') : ''));
  }

  /* ---- form pieces: every input carries data-path */
  const fText = (path, label, ph, max) => html`<label class="field"><span>${label}</span><input type="text" id="${pid(path)}" data-path="${path}" value="${getPath(HB.draft, path) || ''}" maxlength="${max || 60}" placeholder="${ph || ''}" autocomplete="off" ${/costRes$/.test(path) ? raw('list="costNames"') : ''}></label>`;
  const fNum = (path, label, step) => html`<label class="field"><span>${label}</span><input type="number" id="${pid(path)}" data-path="${path}" value="${getPath(HB.draft, path) == null ? '' : getPath(HB.draft, path)}" step="${step || 1}" inputmode="numeric"></label>`;
  const fArea = (path, label, ph, max) => html`<label class="field"><span>${label}</span><textarea id="${pid(path)}" data-path="${path}" maxlength="${max || 3000}" placeholder="${ph || ''}">${getPath(HB.draft, path) || ''}</textarea></label>`;
  const fSel = (path, label, opts) => html`<label class="field"><span>${label}</span><select id="${pid(path)}" data-path="${path}">${opts.map(([v, l]) => html`<option value="${v}" ${String(getPath(HB.draft, path)) === String(v) ? 'selected' : ''}>${l}</option>`)}</select></label>`;
  const fTog = (path, label) => html`<button type="button" class="chip" data-act="hb-tog" data-path="${path}" aria-pressed="${!!getPath(HB.draft, path)}">${label}</button>`;
  const fChips = (path, label, opts) => {
    const cur = getPath(HB.draft, path) || [];
    return html`<div class="field"><span>${label}</span><div class="chips">${opts.map(([v, l]) => html`<button type="button" class="chip" data-act="hb-chip" data-path="${path}" data-v="${v}" aria-pressed="${cur.includes(v)}">${l}</button>`)}</div></div>`;
  };
  const abOpts = () => Core.ABILS.map((a) => [a, Core.ABIL_NAME[a]]);
  const dmgOpts = (first) => [['', first], ...Core.DAMAGE_TYPES.map((t) => [t, titleCase(t)])];
  const classOpts = () => Object.keys(D.rules.classes).map((k) => [k, D.rules.classes[k].n]);

  function fxFields(e, path) {
    const R = D.rules;
    const p = (f) => path + '.' + f;
    switch (e.t) {
      case 'attack':
        return html`<div class="grid2">${fSel(p('when'), 'When', [['toggle', 'Switch on the sheet'], ['always', 'Always on']])}${fSel(p('filter'), 'Applies to', Core.ATTACK_FILTERS.map((f) => [f, f === 'any' ? 'All weapon attacks' : f === 'item' ? 'This item’s own weapon' : titleCase(f) + ' attacks']))}</div>
          <div class="grid3">${fNum(p('hit'), 'To hit')}${fText(p('dmg'), 'Extra damage', '3 or 1d6', 20)}${fSel(p('dmgType'), 'Damage type', dmgOpts('Weapon’s type'))}</div>`;
      case 'ability': return html`<div class="grid2">${fSel(p('ab'), 'Ability', abOpts())}${fNum(p('n'), 'Increase')}</div>`;
      case 'ac': case 'speed': case 'init': case 'hpPerLevel': case 'passive': return fNum(p('n'), 'Amount', e.t === 'speed' ? 5 : 1);
      case 'save': return html`<div class="grid2">${fSel(p('ab'), 'Saving throw', [['all', 'All saves'], ...abOpts()])}${fNum(p('n'), 'Bonus')}</div>`;
      case 'saveProf': return fSel(p('ab'), 'Saving throw', abOpts());
      case 'skillProf': return fSel(p('sk'), 'Skill', Object.keys(R.skills).map((k) => [k, R.skills[k].n]));
      case 'resource':
        return html`<div class="grid3">${fText(p('name'), 'Name', 'Uses', 40)}${fSel(p('max'), 'How many', [['pb', 'Proficiency bonus'], ...Core.ABILS.map((a) => [a, Core.ABIL_SHORT[a] + ' modifier']), ...[1, 2, 3, 4, 5].map((n) => [String(n), String(n)])])}${fSel(p('reset'), 'Comes back', RESET_OPTS)}</div>
          ${e.reset === 'none' || e.reset === 'never' ? '' : fText(p('regain'), 'How many come back each time', 'empty = all; 1; or dice like 1d6+1', 20)}`;
      case 'crit': return fSel(p('min'), 'Critical hit on', [['19', '19–20'], ['18', '18–20']]);
      case 'spells': {
        const lists = [['any', 'Any class’s list'], ...Object.keys(R.classes).filter((k) => R.classes[k].cast).map((k) => [k, R.classes[k].n + ' list'])];
        const common = html`<div class="grid2">${fSel(p('ab'), 'Cast with', [['', 'The hero’s spellcasting ability'], ...abOpts()])}<div class="field"><span>Free casting</span><div class="chips">${fTog(p('free'), 'Each once per long rest without a slot')}</div></div></div>
          <div class="grid3">${fText(p('costRes'), 'Or cast by spending (tracker)', 'Ki points', 40)}${fNum(p('costN'), 'How many')}${fText(p('note'), 'Note', 'Instead of a spell slot', 120)}</div>`;
        if (e.mode === 'fixed') {
          const chosen = Array.isArray(e.list) ? e.list : [];
          const q = (HB.spq || '').toLowerCase();
          const pool = (D.spells || []).filter((sp) => !chosen.includes(sp.i) && q && sp.n.toLowerCase().includes(q)).slice(0, 24);
          return html`${fSel(p('mode'), 'How', [['choose', 'The player chooses'], ['fixed', 'These exact spells, always prepared']])}
            <div class="field"><span>Spells (${chosen.length})</span><div class="chips">${chosen.map((id) => html`<button type="button" class="chip" data-act="hb-chip" data-path="${p('list')}" data-v="${id}" aria-pressed="true">${(D.spellsById && D.spellsById.get(id) || { n: id }).n} ✕</button>`)}</div></div>
            <input type="search" id="hb-spq" value="${HB.spq || ''}" placeholder="Search spells to add" aria-label="Search spells to add">
            ${pool.length ? html`<div class="chips">${pool.map((sp) => html`<button type="button" class="chip" data-act="hb-chip" data-path="${p('list')}" data-v="${sp.i}" aria-pressed="false">+ ${sp.n} <span class="muted">${sp.lvl ? ord(sp.lvl) : 'cantrip'}</span></button>`)}</div>` : ''}${common}`;
        }
        return html`${fSel(p('mode'), 'How', [['choose', 'The player chooses'], ['fixed', 'These exact spells, always prepared']])}
          <div class="grid3">${fNum(p('count'), 'How many')}${fSel(p('maxLvl'), 'Up to level', [['slot', 'Highest slot level'], ['0', 'Cantrips only'], ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [String(n), ord(n)])])}${fSel(p('from'), 'From', lists)}</div>${common}`;
      }
      case 'skillChoice': return html`${fNum(p('n'), 'How many skills')}${fChips(p('from'), 'Only from these (none picked = any skill)', Object.keys(R.skills).map((k) => [k, R.skills[k].n]))}`;
      case 'expertise': case 'extraAttack': return fNum(p('n'), e.t === 'extraAttack' ? 'Extra attacks' : 'Extra picks');
      case 'unarmored': return fSel(p('ab'), 'AC is 10 + Dex +', [['dex', 'nothing else'], ...abOpts().filter(([a]) => a !== 'dex')]);
      case 'armorProf': return fSel(p('cat'), 'Training with', [['Light', 'Light armor'], ['Medium', 'Medium armor'], ['Heavy', 'Heavy armor'], ['Shield', 'Shields']]);
      case 'checkHalf': return fChips(p('abs'), 'On checks with', abOpts());
      case 'options':
        return html`<div class="grid3">${fText(p('label'), 'What the player chooses', 'Maneuvers, Totem animal…', 60)}${fNum(p('n'), 'How many at first')}${fText(p('more'), 'More at higher levels', '7:2, 10:2, 15:2', 60)}</div>
          <p class="hint">“7:2, 10:2” means 2 more at level 7 and 2 more at level 10. Each option can have its own effects, cost and action type.</p>
          ${rowsEditor(p('options'), 'Options', 'Option', (q) => html`${fText(q + '.name', 'Name', '', 60)}${fArea(q + '.desc', 'Description', 'In your own words', 2000)}${useFields(q)}${fxEditor(q + '.effects')}`)}`;
    }
    return '';
  }
  // the effects list at a path (a feat, an item, or one class feature)
  function fxEditor(path, hint) {
    const list = getPath(HB.draft, path) || [];
    return html`<div class="fx-box">${list.map((e, i) => html`<div class="fx-row"><div class="card-title"><b>${FX_LABEL[e.t] || e.t}</b><button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="hb-del" data-path="${path}" data-i="${i}" aria-label="Remove this effect">${icon('trash')}</button></div>
        ${fxFields(e, path + '.' + i)}<p class="hint fx-sum">${Core.describeEffect(e)}</p></div>`)}
      <div class="expr-row"><select id="${pid(path)}-type" aria-label="Effect to add">${Core.EFFECT_TYPES.filter((t) => !(t === 'options' && /\.options\./.test(path))).map((t) => html`<option value="${t}">${FX_LABEL[t]}</option>`)}</select><button type="button" class="btn btn-sm" data-act="hb-fx-add" data-path="${path}">${icon('plus')} Add effect</button></div>
      ${hint ? html`<p class="hint">${hint}</p>` : ''}</div>`;
  }
  // a list of rows (features, traits, actions) with add/remove
  function rowsEditor(path, title, addLabel, rowFn) {
    const list = getPath(HB.draft, path) || [];
    return html`<div class="card"><div class="card-title"><h3>${title}</h3><button type="button" class="btn btn-sm" data-act="hb-row-add" data-path="${path}">${icon('plus')} ${addLabel}</button></div>
      ${list.length ? list.map((r, i) => html`<div class="fx-row"><div class="card-title"><b>${r.name || r.n || addLabel}</b><button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="hb-del" data-path="${path}" data-i="${i}" aria-label="Remove">${icon('trash')}</button></div>${rowFn(path + '.' + i, r)}</div>`) : html`<p class="hint">None yet.</p>`}</div>`;
  }
  // how an ability is used: action type, cost from a tracker, a roll, a short note
  const RESET_OPTS = [['short', 'Short rest (all back on a long rest)'], ['long', 'Long rest'], ['dawn', 'At dawn'], ['never', 'Never (DM refills)'], ['none', 'No limit']];
  const USE_ACTS = [['', 'Always on (not an action)'], ['action', 'Action'], ['bonus', 'Bonus action'], ['reaction', 'Reaction'], ['other', 'Other / special']];
  const COST_NAMES = ['Ki points', 'Sorcery points', 'Rage', 'Channel Divinity', 'Bardic Inspiration', 'Superiority dice', 'Wild Shape', 'Lay on Hands', 'Action Surge'];
  const at = (p, k) => (p ? p + '.' + k : k);
  const useFields = (p) => html`<div class="use-box"><div class="label">How it’s used (optional)</div>
    <div class="grid3">${fSel(at(p, 'act'), 'Used as', USE_ACTS)}${fText(at(p, 'costRes'), 'Costs (tracker name)', 'Ki points', 40)}${fNum(at(p, 'costN'), 'How many')}</div>
    <div class="grid2">${fText(at(p, 'roll'), 'Roll', '1d8+WIS or 2d6+LVL', 30)}${fText(at(p, 'note'), 'Short note shown under it', 'Range 60 ft, Wis save', 120)}</div>
    <p class="hint">The cost uses a tracker with that name: a class one (Ki points, Sorcery points, Rage…) or one you add with a “Limited uses” effect. In rolls, STR…CHA mean the ability modifier, PB proficiency bonus, LVL the hero’s level.</p></div>
    <datalist id="costNames">${COST_NAMES.map((n) => html`<option value="${n}"></option>`)}</datalist>`;
  const nameDesc = (p) => html`${fText(p + '.n', 'Name', '', 60)}${fArea(p + '.d', 'Description', 'In your own words', 2000)}`;
  const featureRow = (p) => html`<div class="grid2">${fNum(p + '.lvl', 'Level')}${fText(p + '.name', 'Name', '', 60)}</div>${fArea(p + '.desc', 'Description', 'What it does, in your own words', 3000)}${useFields(p)}${fxEditor(p + '.effects', 'Effects switch on when the hero reaches this level.')}`;

  function hbFormHtml() {
    const f = HB.draft;
    const R = D.rules;
    const head = html`<div class="card">${fText('name', 'Name', `Your ${kindName(f.kind)}’s name`, 60)}${fArea('desc', 'Description (shown in the app)', 'In your own words', f.kind === 'spell' ? 6000 : 3000)}</div>`;
    switch (f.kind) {
      case 'item':
        return html`${head}<div class="card"><div class="grid2">${fSel('rarity', 'Rarity', ['common', 'uncommon', 'rare', 'very rare', 'legendary', 'artifact'].map((r) => [r, titleCase(r)]))}${fSel('weapon', 'It’s a weapon', [['', 'Not a weapon'], ...Object.keys(R.weapons).map((k) => [k, R.weapons[k].n])])}</div>
          <div class="chips">${fTog('attune', 'Requires attunement')}</div>
          <p class="hint">An item’s effects work while the hero has it equipped (and attuned, if it needs attunement). A weapon item gets its own attack row on the sheet; use “This item’s own weapon” for bonuses that only apply to it.</p></div>
          <div class="card">${useFields('')}</div>
          <div class="card"><div class="card-title"><h3>What it does in the app</h3></div>${fxEditor('effects')}</div>`;
      case 'spell':
        return html`${head}<div class="card"><div class="grid3">${fSel('lvl', 'Level', [['0', 'Cantrip'], ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [String(n), ord(n)])])}${fSel('school', 'School', Core.SCHOOLS.map((x) => [x, x]))}${fText('time', 'Casting time', '1 action', 40)}</div>
          <div class="grid3">${fText('range', 'Range', '60 feet', 40)}${fText('comp', 'Components', 'V, S, M', 60)}${fText('dur', 'Duration', 'Instantaneous', 60)}</div>
          <div class="chips">${fTog('conc', 'Concentration')}${fTog('ritual', 'Ritual')}</div>
          ${fChips('cls', 'Spell lists it’s on', classOpts())}</div>
          <div class="card"><div class="card-title"><h3>What the app rolls</h3></div>
          <div class="grid3">${fSel('atk', 'Spell attack', [['', 'No attack roll'], ['melee', 'Melee'], ['ranged', 'Ranged']])}${fSel('save', 'Saving throw', [['', 'No save'], ...abOpts()])}${fSel('saveOn', 'On a successful save', [['half', 'Half damage'], ['none', 'No effect']])}</div>
          <div class="grid3">${fText('dmg', 'Damage', '3d8', 30)}${fSel('dmgType', 'Damage type', dmgOpts('Force'))}${f.lvl === '0' ? html`<div class="field"><span>Gets stronger</span><div class="chips">${fTog('grow', 'At levels 5, 11, 17')}</div></div>` : fText('dmgUp', 'Extra per slot above', '1d8', 20)}</div>
          <div class="grid2">${fText('heal', 'Healing', '1d8+MOD', 30)}${f.lvl === '0' ? '' : fText('healUp', 'Extra healing per slot above', '1d8', 20)}</div>
          <div class="grid3">${fSel('area', 'Area', [['', 'No area'], ['circle', 'Circle (radius)'], ['cone', 'Cone'], ['cube', 'Square / cube'], ['line', 'Line']])}${fNum('areaSize', 'Size (ft)', 5)}${f.area === 'line' ? fNum('areaWidth', 'Width (ft)', 5) : html`<div class="field"><span>From the caster</span><div class="chips">${fTog('areaSelf', 'Starts at the caster')}</div></div>`}</div>
          <p class="hint">Write MOD for the caster’s spellcasting modifier. Leave a box empty if the spell doesn’t do that.</p>
          ${fArea('higher', 'At higher levels (text)', 'Optional', 2000)}</div>`;
      case 'monster':
        return html`${head}<div class="card"><div class="field"><span>Picture</span><div class="btn-row">${f.img ? disc(f.name, '#e2654f', f.img, 'lg') : ''}<label class="btn btn-sm">${icon('upload')} ${f.img ? 'Change picture' : 'Add a picture'}<input type="file" id="hb-img-file" accept="image/*" class="sr"></label>${f.img ? html`<button type="button" class="btn btn-ghost btn-sm" data-act="hb-tog" data-path="img">Remove</button>` : ''}</div></div></div>
          <div class="card"><div class="grid3">${fSel('size', 'Size', Core.SIZES.map((x) => [x, x]))}${fText('type', 'Type', 'beast, undead, fey…', 40)}${fText('align', 'Alignment', 'unaligned', 40)}</div>
          <div class="grid3">${fNum('ac', 'Armor class')}${fText('acn', 'Armor note', 'natural armor', 60)}${fSel('cr', 'Challenge', Core.CR_LIST.map((c) => [String(c), Core.crLabel(c) + ' (' + Core.CR_XP[Core.CR_LIST.indexOf(c)].toLocaleString() + ' XP)']))}</div>
          <div class="grid3">${fNum('hp', 'Hit points')}${fText('hd', 'Hit dice', '4d8+4', 20)}${fText('speed', 'Speed', '30 ft., fly 60 ft.', 80)}</div>
          <div class="abil-grid">${Core.ABILS.map((a, i) => fNum('abil.' + i, Core.ABIL_SHORT[a]))}</div>
          <div class="label">Saving throw bonuses (leave empty if none)</div><div class="abil-grid">${Core.ABILS.map((a) => fNum('saves.' + a, Core.ABIL_SHORT[a]))}</div>
          <div class="grid2">${fText('senses', 'Senses', 'darkvision 60 ft., passive Perception 12', 120)}${fText('lang', 'Languages', '—', 120)}</div>
          <div class="grid2">${fText('res', 'Resistances', '', 160)}${fText('imm', 'Immunities', '', 160)}</div>
          <div class="grid2">${fText('vul', 'Vulnerabilities', '', 120)}${fText('cimm', 'Condition immunities', '', 160)}</div></div>
          ${rowsEditor('traits', 'Traits', 'Trait', nameDesc)}
          ${rowsEditor('actions', 'Actions', 'Action', (p) => html`${nameDesc(p)}<div class="grid3">${fNum(p + '.hit', 'To hit (empty: none)')}${fText(p + '.dmg', 'Damage', '2d6+3', 30)}${fSel(p + '.dmgType', 'Damage type', dmgOpts('None'))}</div>
            <div class="grid3">${fSel(p + '.save', 'Saving throw', [['', 'No save'], ...abOpts()])}${fNum(p + '.dc', 'DC')}${fSel(p + '.saveOn', 'On a success', [['half', 'Half damage'], ['none', 'No effect']])}</div>
            <div class="grid2">${fSel(p + '.area', 'Area', [['', 'No area'], ['circle', 'Circle'], ['cone', 'Cone'], ['cube', 'Square'], ['line', 'Line']])}${fNum(p + '.areaSize', 'Size (ft)', 5)}</div>`)}
          ${rowsEditor('legend', 'Legendary actions', 'Legendary action', nameDesc)}
          ${rowsEditor('react', 'Reactions', 'Reaction', nameDesc)}`;
      case 'subclass':
        {
          const lv = subclassLevels(f.cls);
          const have = new Set((f.features || []).map((x) => Number(x.lvl)));
          const missing = lv.filter((n) => !have.has(n));
          return html`${head}<div class="card">${fSel('cls', 'For the class', classOpts().filter(([k]) => k !== 'hb-' + HB.id))}
            <p class="hint">Heroes of that class can pick it in the hero builder at the class’s usual subclass level.</p>
            ${lv.length ? html`<div class="framework"><b>Framework (optional):</b> ${D.rules.classes[f.cls] ? D.rules.classes[f.cls].n : 'This class'} subclasses usually get features at levels ${lv.join(', ')}.
              ${missing.length ? html`<button type="button" class="btn btn-sm" data-act="hb-frame-sub">${icon('plus')} Add empty features at ${missing.join(', ')}</button>` : html`<span class="small muted"> Every usual level has a feature.</span>`}</div>` : ''}</div>
            ${rowsEditor('features', 'Features', 'Feature', featureRow)}`;
        }
      case 'class':
        return html`${head}<div class="card framework"><b>Start from a framework (optional)</b><p class="hint" style="margin:4px 0 8px">Fills in the usual hit die, saves, training, spellcasting, subclass levels and key features for that kind of class. You can change everything afterwards.</p>
          <div class="chips">${Object.keys(CLASS_FRAMEWORKS).map((k) => html`<button type="button" class="chip" data-act="hb-frame-class" data-k="${k}">${CLASS_FRAMEWORKS[k].label}</button>`)}</div></div>
          <div class="card"><div class="grid3">${fSel('hd', 'Hit die', [['6', 'd6'], ['8', 'd8'], ['10', 'd10'], ['12', 'd12']])}${fSel('saves.0', 'Saving throw 1', abOpts())}${fSel('saves.1', 'Saving throw 2', abOpts())}</div>
          ${fChips('armor', 'Armor training', [['Light', 'Light'], ['Medium', 'Medium'], ['Heavy', 'Heavy'], ['Shield', 'Shields']])}
          <div class="grid2">${fSel('weapons', 'Weapons', [['simple', 'Simple weapons'], ['martial', 'Simple and martial'], ['none', 'None']])}${fNum('skillsChoose', 'Skills to choose')}</div>
          ${fChips('skills', 'Skills to choose from', Object.keys(R.skills).map((k) => [k, R.skills[k].n]))}</div>
          <div class="card"><div class="card-title"><h3>Spellcasting</h3></div><div class="grid3">${fSel('cast', 'Spellcaster', [['none', 'None'], ['full', 'Full (like a wizard)'], ['half', 'Half (like a paladin)'], ['third', 'One-third'], ['pact', 'Pact (like a warlock)']])}${fSel('castAb', 'Ability', abOpts())}${fNum('cantrips', 'Cantrips known')}</div>
          ${fSel('spellList', 'Spell list', [...Object.keys(R.classes).filter((k) => !/^hb-/.test(k) && R.classes[k].cast).map((k) => [k, R.classes[k].n + ' spells']), ['own', 'Only spells tagged with this class']])}</div>
          <div class="card"><div class="card-title"><h3>Subclass</h3></div><div class="grid3">${fNum('subLevel', 'Chosen at level')}${fText('subName', 'Called', 'Path, Oath, Circle…', 40)}${fText('subLevels', 'Subclass features at levels', '3, 7, 10, 15, 18', 60)}</div>
            <p class="hint">Heroes choose their ${f.subName || 'subclass'} in the hero builder at level ${f.subLevel || 3}. The feature levels give new subclasses for this class their framework.</p>
            ${HB.id ? html`<div class="list">${[...S.hb.values()].filter((x) => x.kind === 'subclass' && x.cls === 'hb-' + HB.id).map((x) => html`<div class="row"><span class="main"><span class="title">${x.name}</span></span><button type="button" class="btn btn-sm" data-act="hb-edit" data-id="${x.id}">${icon('edit')} Edit</button></div>`)}</div>
              <button type="button" class="btn btn-sm" data-act="hb-new-sub">${icon('plus')} New ${f.subName || 'subclass'} for this class</button>` : html`<p class="hint">Save the class first, then you can add its subclasses here.</p>`}</div>
          ${rowsEditor('features', 'Class features', 'Feature', featureRow)}
          <p class="hint">Proficiency bonus, Ability Score Improvements (levels 4, 8, 12, 16, 19) and spell slots follow the standard tables.</p>`;
      default:
        return html`${head}<div class="card">${useFields('')}</div><div class="card"><div class="card-title"><h3>What the app does</h3></div>${fxEditor('effects', 'Use “Switch on the sheet” for anything a player chooses to use on a turn: the hero sheet gets an on/off button and the rolls change while it’s on. Things the app can’t track, like reactions or cover, go in the description.')}</div>`;
    }
  }
  function hbEditHtml() {
    const existing = HB.id && S.hb.get(HB.id);
    return html`<div class="panel-head"><button type="button" class="btn btn-ghost btn-sm" data-act="hb-back">${icon('back')} Homebrew</button><h2>${HB.id ? 'Edit ' : 'New '}${kindName(HB.draft.kind)}</h2></div>
      ${hbFormHtml()}
      <div class="save-bar">${existing && canEditHb(existing) ? html`<button type="button" class="btn btn-danger" data-act="hb-remove">${icon('trash')} Delete</button>` : ''}<span class="grow"></span>
        <button type="button" class="btn btn-ghost" data-act="hb-back">Cancel</button><button type="button" class="btn btn-primary" data-act="hb-save">${icon('check')} Save</button></div>`;
  }
  function hbRender() {
    if (!rulesReady()) return html`<div class="empty"><h3>Opening the rulebook…</h3></div>`;
    if (HB.view === 'edit' && HB.draft) return hbEditHtml();
    const kind = HB.kind;
    const list = [...S.hb.values()].filter((f) => (f.kind || 'feat') === kind).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const count = (k) => [...S.hb.values()].filter((f) => (f.kind || 'feat') === k).length;
    const where = { feat: 'Heroes take feats in the hero builder.', item: 'Add items to a hero’s inventory by name, then equip them on the sheet.', spell: 'Spells appear in the hero builder for the classes you tag, and on spell cards.', monster: 'Monsters appear in the Encounter tab’s bestiary.', subclass: 'Subclasses appear in the hero builder.', class: 'Classes appear in the hero builder.' }[kind];
    return html`<div class="panel-head"><h2>Homebrew</h2>${S.readOnly ? '' : html`<button type="button" class="btn btn-primary" data-act="hb-new">${icon('plus')} New ${kindName(kind)}</button>`}</div>
      <div class="btn-row"><button type="button" class="btn btn-ghost btn-sm" data-act="hb-export" ${S.hb.size ? '' : 'disabled'}>Export homebrew</button>${S.readOnly ? '' : html`<button type="button" class="btn btn-ghost btn-sm" data-act="hb-import">Import homebrew</button>`}</div>
      <div class="chips">${HB_KINDS.map(([k, label]) => html`<button type="button" class="chip" data-act="hb-kind" data-k="${k}" aria-pressed="${k === kind}">${label}${count(k) ? ` · ${count(k)}` : ''}</button>`)}</div>
      ${list.length ? html`<div class="list">${list.map((f) => html`<div class="row"><span class="main"><span class="title" style="display:block">${f.name || 'Untitled'}</span><span class="sub" style="display:block">${hbSummary(f)}${f.byName || Store.accountName(f.by) ? ' · by ' + (f.byName || Store.accountName(f.by)) : ''}</span></span>
          ${canEditHb(f) ? html`<button type="button" class="btn btn-sm" data-act="hb-edit" data-id="${f.id}">${icon('edit')} Edit</button>` : ''}</div>`)}</div>`
        : html`<div class="empty"><h3>No homebrew ${kindName(kind)}s yet</h3><p class="hint">Write your table’s own and pick what they do from menus, so the app can apply them.</p>${S.readOnly ? '' : html`<button type="button" class="btn btn-primary" data-act="hb-new">${icon('plus')} Make a ${kindName(kind)}</button>`}</div>`}
      <p class="hint">${where} Everything here belongs to this campaign and is shared with everyone at the table.</p>`;
  }
  function hbAct(a, b) {
    const f = HB.draft;
    const path = b && b.dataset.path;
    switch (a) {
      case 'hb-kind':
        HB.kind = b.dataset.k;
        break;
      case 'hb-export': {
        const items = [...S.hb.values()].map((x) => Object.assign({ id: x.id }, Store.clone(x)));
        saveFile(`tavern-table-homebrew-${stamp()}.json`, JSON.stringify({ type: 'tavern-table-homebrew', v: 1, items }));
        return;
      }
      case 'hb-import':
        pickFile('.json,application/json').then((file) => file && file.text()).then((txt) => {
          if (!txt) return;
          let n = 0;
          let skipped = 0;
          try {
            const data = JSON.parse(txt);
            if (!data || data.type !== 'tavern-table-homebrew' || !Array.isArray(data.items)) throw new Error('bad');
            const have = new Set([...S.hb.values()].map((x) => (x.kind || 'feat') + '|' + String(x.name).toLowerCase()));
            data.items.slice(0, 2000).forEach((x) => {
              if (!x || typeof x !== 'object' || !/^[A-Za-z0-9_-]{1,80}$/.test(String(x.id)) || !HB_KINDS.some((k) => k[0] === (x.kind || 'feat'))) return skipped++;
              const key = (x.kind || 'feat') + '|' + String(x.name).toLowerCase();
              if (S.hb.has(x.id) || have.has(key)) return skipped++; // already here: never duplicated or overwritten
              const doc = Object.assign({}, x);
              delete doc.id;
              Store.W.set('homebrew/' + x.id, doc);
              have.add(key);
              n++;
            });
          } catch (er) {
            return toast('That file isn’t a Tavern Table homebrew export.', 'warn');
          }
          toast(`Imported ${n} new ${n === 1 ? 'entry' : 'entries'}${skipped ? `, skipped ${skipped} already here` : ''}.`);
        });
        return;
      case 'hb-new':
        HB.view = 'edit';
        HB.id = null;
        HB.draft = hbDefault(HB.kind);
        break;
      case 'hb-edit': {
        const doc = S.hb.get(b.dataset.id);
        if (!doc) return;
        HB.view = 'edit';
        HB.id = doc.id;
        HB.draft = Object.assign(hbDefault(doc.kind || 'feat'), Store.clone(doc));
        delete HB.draft.id;
        break;
      }
      case 'hb-back':
        HB.view = 'list';
        HB.draft = null;
        break;
      case 'hb-frame-sub': {
        if (!f) return;
        const have = new Set((f.features || []).map((x) => Number(x.lvl)));
        subclassLevels(f.cls).filter((n) => !have.has(n)).forEach((n) => f.features.push({ lvl: String(n), name: '', desc: '', effects: [] }));
        f.features.sort((x, y) => Number(x.lvl) - Number(y.lvl));
        break;
      }
      case 'hb-frame-class': {
        const fw = CLASS_FRAMEWORKS[b.dataset.k];
        if (!f || !fw) return;
        ['hd', 'saves', 'armor', 'weapons', 'skillsChoose', 'cast', 'castAb', 'cantrips', 'subLevel', 'subLevels'].forEach((k) => fw[k] !== undefined && (f[k] = Store.clone(fw[k])));
        const have = new Set((f.features || []).map((x) => Number(x.lvl) + '|' + x.name));
        fw.rows.forEach(([lvl, name, effects]) => {
          if (!have.has(lvl + '|' + name)) f.features.push({ lvl: String(lvl), name, desc: '', effects: Store.clone(effects || []) });
        });
        f.features.sort((x, y) => Number(x.lvl) - Number(y.lvl));
        toast('Framework filled in. Rename the features and describe them in your own words.');
        break;
      }
      case 'hb-new-sub': {
        if (!HB.id) return;
        HB.kind = 'subclass';
        const clsId = 'hb-' + HB.id;
        HB.id = null;
        HB.draft = hbDefault('subclass');
        HB.draft.cls = clsId;
        subclassLevels(clsId).forEach((n) => HB.draft.features.push({ lvl: String(n), name: '', desc: '', effects: [] }));
        break;
      }
      case 'hb-tog':
        if (f && path === 'img') f.img = '';
        else if (f) setPath(f, path, !getPath(f, path));
        break;
      case 'hb-chip': {
        if (!f) return;
        const cur = (Array.isArray(getPath(f, path)) ? getPath(f, path) : []).slice();
        const i = cur.indexOf(b.dataset.v);
        if (i >= 0) cur.splice(i, 1);
        else cur.push(b.dataset.v);
        setPath(f, path, cur);
        break;
      }
      case 'hb-fx-add': {
        const t = ($('#' + pid(path) + '-type') || {}).value;
        const list = f && getPath(f, path);
        if (!Array.isArray(list) || !FX_DEFAULT[t]) return;
        if (list.length >= 20) return toast('That’s the most effects one entry can have.', 'warn');
        list.push(Object.assign({ t }, Store.clone(FX_DEFAULT[t])));
        break;
      }
      case 'hb-row-add': {
        const list = f && getPath(f, path);
        const key = String(path).split('.').pop();
        if (!Array.isArray(list) || !ROW_DEFAULT[key]) return;
        if (list.length >= 40) return toast('That list is full.', 'warn');
        list.push(ROW_DEFAULT[key]());
        break;
      }
      case 'hb-del': {
        const list = f && getPath(f, path);
        if (Array.isArray(list)) list.splice(Number(b.dataset.i), 1);
        break;
      }
      case 'hb-save': {
        if (!f) return;
        const name = String(f.name || '').trim().slice(0, 60);
        if (!name) {
          toast('Give it a name first.', 'warn');
          const n = $('#hb-name');
          if (n) n.focus();
          return;
        }
        const existing = HB.id && S.hb.get(HB.id);
        const doc = Object.assign(Store.clone(f), { name, desc: String(f.desc || '').slice(0, 6000), by: existing ? existing.by : S.me.pk, byName: existing ? existing.byName || Store.accountName(existing.by) : S.me.nick || '' });
        if (sizeOk(doc)) {
          Store.Act.saveHomebrew(HB.id, doc);
          toast(`Saved “${name}”.`);
          HB.view = 'list';
          HB.draft = null;
        }
        break;
      }
      case 'hb-remove': {
        const doc = S.hb.get(HB.id);
        if (!doc) return;
        return confirmSheet(`Delete “${doc.name}”?`, 'It’s removed for everyone in this campaign. Heroes who used it lose its effects. This can’t be undone.', 'Delete', () => {
          Store.Act.deleteHomebrew(doc.id);
          HB.view = 'list';
          HB.draft = null;
          renderPanel('homebrew', true);
        });
      }
      default:
        return;
    }
    const keep = panels.homebrew.el.scrollTop;
    renderPanel('homebrew', true);
    panels.homebrew.el.scrollTop = ['hb-kind', 'hb-new', 'hb-edit', 'hb-back', 'hb-save'].includes(a) ? 0 : keep;
  }
  function sizeOk(doc) {
    if (JSON.stringify(doc).length < 250000) return true;
    toast('That’s too much text for one entry. Shorten the descriptions a little.', 'warn');
    return false;
  }
  // typing updates the draft only; summaries and dependent fields refresh when a field is left (change)
  function hbInput(t) {
    if (t.id === 'hb-spq') {
      HB.spq = t.value;
      panels.homebrew.typing = false;
      const keep = panels.homebrew.el.scrollTop;
      renderPanel('homebrew', true);
      panels.homebrew.el.scrollTop = keep;
      return;
    }
    if (HB.draft && t.dataset.path) setPath(HB.draft, t.dataset.path, t.value);
  }
  function hbChange(t) {
    if (t.id === 'hb-img-file' && t.files && t.files[0] && HB.draft) {
      return makePortrait(t.files[0]).then((url) => {
        HB.draft.img = url;
        renderPanel('homebrew', true);
      }).catch((er) => toast(er.message || 'That picture couldn’t be used.', 'warn'));
    }
    hbInput(t);
    if (t.dataset.path) {
      panels.homebrew.typing = false;
      const keep = panels.homebrew.el.scrollTop;
      renderPanel('homebrew', true);
      panels.homebrew.el.scrollTop = keep;
    }
  }

  /* ================================================== PEOPLE */
  // Campaigns: list, open, rename the current one, start a new one
  function openCampaigns() {
    const st = { list: null, err: '', newName: '', rename: Store.campaignName(), busy: false };
    const load = (draw) => Store.campaigns().then((l) => {
      st.list = l;
      st.rename = Store.campaignName();
      if (draw) draw();
    });
    const where = S.server ? 'on this table’s server, so everyone can open them' : S.mode === 'remote' && !S.p2p ? 'with this shared page, so everyone can open them' : 'on this device';
    Sheet.open({
      title: 'Campaigns',
      render() {
        if (!st.list) return html`<p class="hint">Loading campaigns…</p>`;
        return html`<p class="hint">Campaigns are saved ${where}. Switching reloads the page.${S.p2p && S.p2p.role === 'host' ? ' While you host online, each campaign has its own invite link.' : ''}</p>
          <div class="list">${st.list.map((c) => html`<div class="row"><span class="main"><span class="title" style="display:block">${c.name}</span></span>
            ${c.id === S.camp ? html`<span class="badge brass">Open now</span>` : html`<button type="button" class="btn btn-sm" data-act="open" data-id="${c.id}">Open</button>`}</div>`)}</div>
          ${S.canWrite ? html`<div class="card"><label class="field"><span>Rename this campaign</span><input type="text" id="campRename" value="${st.rename}" maxlength="60" autocomplete="off"></label>
            <div class="btn-row end"><button type="button" class="btn btn-sm" data-act="rename">${icon('check')} Rename</button></div></div>
          <div class="card"><label class="field"><span>Start a new campaign</span><input type="text" id="campNew" value="${st.newName}" maxlength="60" placeholder="Campaign name" autocomplete="off"></label>
            <div class="btn-row end"><button type="button" class="btn btn-primary" data-act="create" ${st.busy ? 'disabled' : ''}>${icon('plus')} Create and open</button></div></div>` : ''}
          ${st.err ? html`<p class="err">${st.err}</p>` : ''}`;
      },
      act(a, b, e, draw) {
        if (a === 'open') return Store.switchCampaign(b.dataset.id);
        if (a === 'rename') {
          const v = String(($('#campRename') || {}).value || '').trim();
          if (!v) return;
          Store.renameCampaign(S.camp, v).then(() => load(draw)).then(() => toast('Campaign renamed.')).catch(() => {
            st.err = 'Renaming didn’t work. Check your connection.';
            draw();
          });
          return;
        }
        if (a === 'create') {
          const v = String(($('#campNew') || {}).value || '').trim();
          if (!v) {
            toast('Give the campaign a name first.', 'warn');
            return;
          }
          st.busy = true;
          draw();
          Store.createCampaign(v).then((id) => id && Store.switchCampaign(id)).catch(() => {
            st.busy = false;
            st.err = 'The campaign couldn’t be created. Check your connection.';
            draw();
          });
        }
      },
      input(t) {
        if (t.id === 'campNew') st.newName = t.value;
        if (t.id === 'campRename') st.rename = t.value;
      },
    });
    load(Sheet.cur && Sheet.cur.draw);
  }
  // Play online card: host from this browser, or show the link; guests see where they are
  function onlineCard() {
    const p = S.p2p;
    if (p && p.role === 'host') {
      const msg = { online: 'Your table is online. Anyone with the link can join while this tab stays open.', starting: 'Connecting to the online lobby…', reconnecting: 'Lost the online lobby for a moment, reconnecting…', taken: 'Another tab or device is already hosting this table. Close it, then reload this page.', offline: 'Couldn’t reach the online lobby. Check your internet connection; it retries by itself.', unsupported: 'This browser can’t host online games. Try a current Chrome, Firefox, Edge or Safari.' }[p.status] || '';
      return html`<div class="card"><div class="card-title"><h3>Play online</h3><span class="badge ${p.status === 'online' ? 'green' : ''}">${p.status === 'online' ? 'Online' : 'Not yet online'}</span></div>
        <p class="prose">${msg}</p>
        <input type="text" readonly value="${Store.inviteLink()}" aria-label="Invite link" onfocus="this.select()">
        <div class="btn-row"><button type="button" class="btn btn-primary" data-act="copy-invite">${icon('copy')} Copy invite link</button><button type="button" class="btn btn-ghost" data-act="host-stop">Stop hosting</button></div>
        <p class="hint">Your browser is the table: everything is saved on this device. Keep this tab open while you play (on a phone, keep the screen on). The link stays the same every session.</p></div>`;
    }
    if (p && p.role === 'guest') {
      const trouble = p.trouble === 'peer-unavailable' ? 'The DM’s table isn’t open right now. This page connects by itself as soon as it is.' : S.offline ? 'Connecting to the DM’s table…' : 'You’re playing at the DM’s table. Everything you do is saved there.';
      return html`<div class="card"><div class="card-title"><h3>Online table</h3><span class="badge ${S.offline ? '' : 'green'}">${S.offline ? 'Waiting' : 'Connected'}</span></div>
        <p class="prose">${trouble}</p><p class="hint">Keep this link to come back later. The game runs while the DM’s tab is open.</p>
        <div class="btn-row"><button type="button" class="btn btn-ghost btn-sm" data-act="leave-online">Leave and play solo</button></div></div>`;
    }
    if (S.mode === 'local') {
      return html`<div class="card"><div class="card-title"><h3>Play online</h3></div>
        <p class="prose">Turn this table into an online game: you get a link to send to friends, and they join from any phone or computer. No accounts.</p>
        <div class="btn-row"><button type="button" class="btn btn-primary" data-act="host-start">${icon('users')} Host this table online</button></div>
        <p class="hint">Your browser becomes the table, so keep this tab open while you play. Your heroes, maps and homebrew come along.</p></div>`;
    }
    return '';
  }
  function openPeople() {
    Sheet.open({
      title: 'People and settings',
      wide: true,
      live: ['peers', 'me', 'chars', 'game'],
      render() {
        const mine = myChars();
        const seen = new Set();
        const people = [];
        S.peers.forEach((p) => {
          const k = (p.presence && p.presence.pk) || p.peer;
          if (seen.has(k) || p.kind !== 'viewer') return;
          seen.add(k);
          people.push(p);
        });
        const me = (S.me.acct && S.accounts.get(S.me.acct)) || (S.accountsMode ? { name: S.me.nick } : null);
        return html`<div class="card"><div class="card-title"><h3>Account</h3>${me ? html`<button type="button" class="btn btn-sm" data-act="signout">Sign out</button>` : html`<button type="button" class="btn btn-sm btn-primary" data-act="account">Sign in or create</button>`}</div>
          <p class="prose" style="margin:0">${me ? html`Signed in as <b>${me.name}</b>. Your settings and heroes follow you to any device.${S.accountsMode ? ' Your name and color here are what others see; you sign in with the name you registered.' : ''}` : 'Not signed in: settings stay on this device only.'}</p>
          ${S.accountsMode ? (S.me.isOwner ? accountsAdminHtml() : '') : S.dm && S.accounts.size ? html`<details class="fold"><summary>Accounts at this table <span class="small muted">${S.accounts.size}</span></summary><div class="fold-in"><div class="list">${[...S.accounts.entries()].map(([id, a]) => html`<div class="row"><span class="main"><span class="title" style="display:block">${a.name}</span><span class="sub" style="display:block">${plural([...S.chars.values()].filter((c) => c.owner === id).length, 'hero')}${a.dm ? ' · DM' : ''}</span></span>
            <input type="password" id="rp-${id}" inputmode="numeric" maxlength="6" placeholder="New PIN" aria-label="New PIN for ${a.name}" style="width:110px"><button type="button" class="btn btn-sm" data-act="reset-pin" data-id="${id}">Reset PIN</button></div>`)}</div></div></details>` : ''}</div>
          ${(S.accountsMode ? S.me.isOwner : S.dm || S.mode === 'local' || (S.p2p && S.p2p.role === 'host')) ? html`<div class="card"><div class="card-title"><h3>Backup</h3></div>
            <p class="hint">One file with the whole table: accounts, heroes, inventories, homebrew, campaigns, maps, tokens, fog and the dice log. Restore it here or on another device.</p>
            <div class="btn-row"><button type="button" class="btn btn-sm" data-act="backup">Download backup</button><button type="button" class="btn btn-sm" data-act="restore">Restore backup</button></div></div>` : ''}
          <div class="card"><div class="card-title"><h3>Campaign</h3>${S.p2p && S.p2p.role === 'guest' ? '' : html`<button type="button" class="btn btn-sm" data-act="campaigns">${icon('book')} Switch or start another</button>`}</div>
          <p class="prose" style="margin:0"><b>${Store.campaignName()}</b>. Each campaign has its own maps, heroes, encounters, dice log and homebrew.</p></div>
          <div class="card"><div class="card-title"><h3>You</h3>${S.me.isOwner ? html`<span class="badge brass">Table owner</span>` : ''}</div>
          <label class="field"><span>Your name at the table</span><input type="text" id="pNick" value="${S.me.nick}" maxlength="40" placeholder="What friends call you" autocomplete="off"></label>
          <div class="field"><span>Your color</span><div class="swatches">${Store.PALETTE.map((col) => html`<button type="button" class="swatch" style="--c:${col}" data-act="pcol" data-c="${col}" aria-pressed="${S.me.color === col}" aria-label="Color ${col}"></button>`)}</div></div>
          ${S.accountsMode ? html`<div class="field"><span>Role</span><p class="prose" style="margin:0">${S.dm ? 'Dungeon Master' : 'Player'} <span class="small muted">· the table owner decides who is a DM</span></p></div>` : html`<div class="field"><span>Role on this device</span><div class="seg"><button type="button" data-act="role" data-r="player" aria-pressed="${!S.dm}">Player</button><button type="button" data-act="role" data-r="dm" aria-pressed="${S.dm}">Dungeon Master</button></div></div>`}
          ${mine.length ? html`<label class="field"><span>Playing as</span><select id="pChar"><option value="">Nobody yet</option>${mine.map((c) => html`<option value="${c.id}" ${S.myChar === c.id ? 'selected' : ''}>${c.name}</option>`)}</select></label>` : ''}
          <button type="button" class="chip" data-act="names" aria-pressed="${!!showNames}">${showNames ? 'Token names always shown' : 'Token names on hover'}</button></div>
          <div class="card"><div class="card-title"><h3>At the table now</h3><span class="small muted">${people.length}</span></div>
            ${people.length ? html`<div class="list">${people.map((p) => {
              const pr = p.presence || {};
              const ch = pr.ch && S.chars.get(pr.ch);
              return html`<div class="row"><span class="disc sm" style="--c:${safeColor(pr.col) || '#888'}">${initials(pr.nm || '?')}</span><span class="main"><span class="title" style="display:block">${pr.nm || (p.isMe ? 'You' : 'Someone')}${p.isMe ? ' (you)' : ''}</span><span class="sub" style="display:block">${pr.dm ? 'DM' : 'Player'}${ch ? ' · ' + ch.name : ''}${pr.w === 1 ? '' : p.isMe && S.relay ? ' · limited access' : ''}${p.guest ? ' · guest' : ''}</span></span></div>`;
            })}</div>` : html`<p class="hint">${S.mode === 'local' ? 'Solo mode: this table is only on this device. Use Play online below to bring friends in.' : 'Only you for now.'}</p>`}</div>
          ${onlineCard()}
          ${S.p2p || S.mode === 'local' ? '' : S.server ? html`<div class="card"><div class="card-title"><h3>Invite friends</h3></div>
            <p class="prose">${S.accountsMode ? 'Send friends this address. Each friend creates their own account with a name and password; players move their own heroes and tokens, and the table owner decides who is a DM.' : 'Send friends this address and the table password. Everyone who has both can move tokens, roll and edit heroes.'}</p>
            <input type="text" readonly value="${location.origin + location.pathname}" aria-label="Table address" onfocus="this.select()">
            <p class="hint">${S.accountsMode ? 'Anyone who can open this address can create an account, so only share it with your group.' : S.me.isOwner ? 'This computer is running the table. Keep the server window open while you play; closing it ends the game for everyone (nothing is lost, just start it again).' : 'The table runs on the DM’s computer. If it stops, your screen says Reconnecting… until it is back.'}</p></div>` : html`<div class="card"><div class="card-title"><h3>Invite friends</h3></div>
            <p class="prose">Share this page from its share menu with each friend’s email and give them edit access (Editor), so they can move tokens and roll. Keep the public link off, since edit access for invited friends only holds while the page isn’t shared by link. Each friend signs in with their own Claude account.</p>
            <p class="hint">Friends with view-only access can still watch the table live. While your page is open, their own moves and rolls are passed through it when possible.</p></div>`}
          ${S.dm ? html`<div class="card"><div class="card-title"><h3>DM tools</h3></div><div class="btn-row"><button type="button" class="btn btn-sm" data-act="scenes">${icon('map')} Scenes and maps</button><button type="button" class="btn btn-danger btn-sm" data-act="clear-log">Clear dice log</button></div></div>` : ''}
          <div class="card"><div class="card-title"><h3>About the rules</h3></div><p class="hint">This work includes material taken from the System Reference Document 5.1 (“SRD 5.1”) by Wizards of the Coast LLC and available at <a href="https://dnd.wizards.com/resources/systems-reference-document" target="_blank" rel="noopener">dnd.wizards.com</a>. The SRD 5.1 is licensed under the <a href="https://creativecommons.org/licenses/by/4.0/legalcode" target="_blank" rel="noopener">Creative Commons Attribution 4.0 International License</a>. Encounter difficulty uses the XP thresholds and multipliers from the 5e encounter-building rules.</p></div>`;
      },
      act(a, b) {
        if (a === 'pcol') return Store.setColor(b.dataset.c);
        if (a === 'role') {
          Store.setRole(b.dataset.r === 'dm');
          renderTabs();
          if (!S.dm && (tab === 'encounter' || sideTab === 'encounter')) show('heroes');
          return;
        }
        if (a === 'names') {
          showNames = !showNames;
          Store.LS.set('tt.names', showNames);
          document.getElementById('board').classList.toggle('show-names', showNames);
          return Sheet.cur && Sheet.cur.draw();
        }
        if (a === 'scenes') return openScenes();
        if (a === 'campaigns') return openCampaigns();
        if (a === 'account') return openAccount();
        if (a === 'signout') return Promise.resolve(Store.signOut()).then(() => location.reload());
        if (a === 'reset-pw') {
          const inp = document.getElementById('rp-' + b.dataset.id);
          return Store.adminResetPassword(b.dataset.id, inp && inp.value).then(() => {
            if (inp) inp.value = '';
            toast('Password reset. Tell them the new one.');
          }).catch((er) => toast(er.message, 'warn'));
        }
        if (a === 'set-dm') return Store.adminSetDm(b.dataset.id, b.dataset.dm === '1').then(() => toast(b.dataset.dm === '1' ? 'They’re a DM now.' : 'They’re a player now.')).catch((er) => toast(er.message, 'warn'));
        if (a === 'reset-pin') {
          const inp = document.getElementById('rp-' + b.dataset.id);
          return Store.resetPin(b.dataset.id, inp && inp.value).then(() => toast('PIN reset. Tell them the new one.')).catch((er) => toast(er.message, 'warn'));
        }
        if (a === 'backup') {
          toast('Gathering the whole table…');
          return Store.backup().then((bk) => saveFile(`tavern-table-backup-${stamp()}.json`, JSON.stringify(bk))).catch((er) => toast(er.message || 'The backup didn’t work.', 'warn'));
        }
        if (a === 'restore') {
          return pickFile('.json,application/json').then((f) => f && f.text()).then((txt) => {
            if (!txt) return;
            return confirmSheet('Restore this backup?', 'Everything in the file is written back into this table. Things that exist here but not in the file stay. The page reloads afterwards.', 'Restore', () => {
              let bk;
              try {
                bk = JSON.parse(txt);
              } catch (er) {
                return toast('That file isn’t a Tavern Table backup.', 'warn');
              }
              Store.restore(bk).then(() => location.reload()).catch((er) => toast(er.message || 'Restoring didn’t work.', 'warn'));
            }, false);
          });
        }
        if (a === 'host-start') return Store.startHosting();
        if (a === 'host-stop') return confirmSheet('Stop playing online?', 'Friends are disconnected and the table goes back to this device only. Nothing is deleted, and you can host again later with the same link.', 'Stop hosting', () => Store.stopHosting(), false);
        if (a === 'leave-online') return Store.leaveOnline();
        if (a === 'copy-invite') {
          const link = Store.inviteLink();
          const done = () => toast('Link copied. Send it to your friends.');
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done, () => toast('Copy the link from the box above.', 'warn'));
          else toast('Copy the link from the box above.', 'warn');
          return;
        }
        if (a === 'clear-log') return confirmSheet('Clear the dice log?', 'All rolls and messages disappear for everyone.', 'Clear log', () => Store.Act.clearLog());
      },
      change(t) {
        if (t.id === 'pNick') Store.setNick(String(t.value).trim().slice(0, 40));
        if (t.id === 'pChar') Store.setMyChar(t.value || null);
      },
    });
  }
  let showNames = Store.LS.get('tt.names', false);
  // accounts mode: the table owner's list of accounts (passwords and DM rights live on the server)
  function accountsAdminHtml() {
    if (!S.accounts.size) return '';
    const list = [...S.accounts.entries()].sort((a, b) => String(a[1].name).localeCompare(String(b[1].name)));
    return html`<details class="fold"><summary>Accounts at this table <span class="small muted">${S.accounts.size}</span></summary><div class="fold-in"><div class="list">${list.map(([id, a]) => html`<div class="row" style="flex-wrap:wrap"><span class="main"><span class="title" style="display:block">${a.name}${id === S.me.acct ? ' (you)' : ''}</span><span class="sub" style="display:block">${plural([...S.chars.values()].filter((c) => c.owner === id).length, 'hero')}${a.dm ? ' · DM' : ''}</span></span>
      <button type="button" class="btn btn-sm" data-act="set-dm" data-id="${id}" data-dm="${a.dm ? '0' : '1'}">${a.dm ? 'Make player' : 'Make DM'}</button>
      <input type="password" id="rp-${id}" minlength="8" maxlength="200" autocomplete="new-password" placeholder="New password" aria-label="New password for ${a.name}" style="width:140px"><button type="button" class="btn btn-sm" data-act="reset-pw" data-id="${id}">Reset password</button></div>`)}</div></div></details>`;
  }

  function openAccount() {
    const st = { err: '', busy: false, pick: '' };
    Sheet.open({
      title: 'Welcome to the table',
      render() {
        const list = [...S.accounts.entries()].sort((a, b) => String(a[1].name).localeCompare(String(b[1].name)));
        return html`${list.length ? html`<div class="card"><div class="card-title"><h3>Sign in</h3></div>
            <label class="field"><span>Your name</span><select id="acPick">${list.map(([id, a]) => html`<option value="${id}" ${st.pick === id ? 'selected' : ''}>${a.name}</option>`)}</select></label>
            <label class="field"><span>PIN</span><input type="password" id="acPin" inputmode="numeric" maxlength="6" autocomplete="current-password"></label>
            <div class="btn-row end"><button type="button" class="btn btn-primary" data-act="signin">Sign in</button></div></div>` : ''}
          <div class="card"><div class="card-title"><h3>${list.length ? 'New here? Make an account' : 'Make your account'}</h3></div>
            <label class="field"><span>Name</span><input type="text" id="acName" maxlength="40" value="${S.me.nick || ''}" autocomplete="off"></label>
            <div class="grid2"><label class="field"><span>PIN (4–6 digits)</span><input type="password" id="acNew" inputmode="numeric" maxlength="6" autocomplete="new-password"></label>
            <label class="field"><span>PIN again</span><input type="password" id="acNew2" inputmode="numeric" maxlength="6" autocomplete="new-password"></label></div>
            <div class="btn-row end"><button type="button" class="btn ${list.length ? '' : 'btn-primary'}" data-act="create" ${st.busy ? 'disabled' : ''}>Create account</button></div>
            <p class="hint">Your account keeps your name, color, role, heroes and the hero you play, on any device that opens this table. ${S.me.acct ? '' : 'Heroes already on this device move into the first account made here.'}</p></div>
          ${st.err ? html`<p class="err">${st.err}</p>` : ''}`;
      },
      act(a, b, e, draw) {
        if (a === 'signin') {
          const id = $('#acPick').value;
          st.pick = id;
          if (Store.signIn(id, $('#acPin').value)) return location.reload();
          st.err = 'That PIN doesn’t match. Ask the DM to reset it if you forgot it.';
          return draw();
        }
        if (a === 'create') {
          const pin = $('#acNew').value;
          if (pin !== $('#acNew2').value) {
            st.err = 'The two PINs aren’t the same.';
            return draw();
          }
          const name = $('#acName').value; // read before the form redraws
          st.busy = true;
          draw();
          Store.createAccount(name, pin).then(() => location.reload()).catch((er) => {
            st.busy = false;
            st.err = er.message;
            draw();
          });
        }
      },
    });
  }
  function askName() {
    if (S.me.nick) return;
    Sheet.open({
      title: 'Welcome to the table',
      render: () => html`<p class="prose">Pick the name your friends will see next to your rolls and on the map.</p>
        <form data-form="nick" class="expr-row"><input type="text" id="nickFirst" maxlength="40" placeholder="Your name" autocomplete="off" value="${S.me.profileName || ''}"><button type="submit" class="btn btn-primary">Join</button></form>`,
      submit(form) {
        const v = String(form.querySelector('#nickFirst').value || '').trim().slice(0, 40);
        if (!v) return;
        Store.setNick(v);
        Sheet.close(true);
      },
    });
    setTimeout(() => {
      const i = $('#nickFirst');
      if (i) i.focus();
    }, 50);
  }

  /* ================================================== wiring */
  function init(hot) {
    if (hot && hot.tab) tab = hot.tab;
    if (hot && hot.sideTab) sideTab = hot.sideTab;
    panel('heroes', { render: heroesRender, act: (a, b, e) => (H.view === 'build' ? builderAct(a, b, e) : heroAct(a, b, e)), input: heroInput, change: heroChange });
    panel('encounter', { render: encRender, act: encAct, input: encInput, change: encChange });
    panel('combat', { render: combatRender, act: combatAct, change: combatChange });
    panel('homebrew', { render: hbRender, act: hbAct, input: hbInput, change: hbChange });
    panel('log', {
      render: logRender,
      act: (a, b, e) => {
        if (diceAct(a, b, e)) renderPanel('log', true);
      },
      input: (t) => {
        if (t.id === 'diceExpr') Dice.expr = t.value;
      },
      after: scrollLog,
    });
    panels.log.el.addEventListener('submit', (e) => {
      e.preventDefault();
      submitExpr($('#diceExpr'));
      panels.log.typing = false;
      renderPanel('log', true);
      const i = $('#diceExpr');
      if (i) i.focus();
    });
    document.getElementById('tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (b) show(b.dataset.tab);
    });
    document.getElementById('sideTabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (b) show(b.dataset.tab);
    });
    document.getElementById('settingsBtn').addEventListener('click', openPeople);
    document.getElementById('scenePill').addEventListener('click', () => (S.dm ? openScenes() : toast(`The DM is showing “${Store.activeScene().name || 'Blank grid'}”.`)));
    window.matchMedia('(min-width: 960px)').addEventListener('change', () => applyPanels());
    document.getElementById('board').classList.toggle('show-names', !!showNames);

    Store.on('chars', () => schedule('heroes', 'encounter', 'combat'));
    Store.on('data', () => schedule('heroes', 'encounter', 'combat'));
    Store.on('encs', () => schedule('encounter'));
    Store.on('homebrew', () => schedule('homebrew', 'heroes'));
    Store.on('party', () => schedule('heroes'));
    Store.on('art', () => schedule('encounter'));
    Store.on('accounts', () => renderTop());
    Store.on('game', () => schedule('heroes'));
    Store.on('tokens', () => schedule('combat', 'heroes'));
    Store.on('init', () => schedule('combat'));
    let lastTurn = null;
    Store.on('game', () => {
      schedule('combat');
      renderTop();
      if (S.game.combat && S.game.turn && S.game.turn !== lastTurn) {
        lastTurn = S.game.turn;
        if (myTurn()) toast('It’s your turn.', null, { color: '#f3cf78', ms: 5000 });
      }
      if (!S.game.combat) lastTurn = null;
    });
    Store.on('scenes', renderTop);
    Store.on('peers', renderTop);
    Store.on('loaded', () => {
      renderTop();
      schedule('heroes', 'combat', 'log', 'encounter');
    });
    Store.on('me', () => {
      renderTop();
      renderTabs();
      schedule('heroes', 'encounter', 'combat', 'log');
    });
    Store.on('log', (fresh) => {
      schedule('log');
      if (!fresh || !fresh.length) return;
      const viewingLog = currentPanel() === 'log';
      fresh.forEach((e) => {
        if (e.by === S.me.pk) return;
        if (e.priv && !S.dm) return;
        if (Date.now() - (e.ts || 0) > 60000) return;
        if (!viewingLog && e.kind === 'roll') rollToast(e);
        else if (!viewingLog && e.kind === 'chat') toast(`${e.who || 'Someone'}: ${String(e.text || '').slice(0, 120)}`, null, { color: safeColor(e.col) || undefined });
      });
      if (!viewingLog) {
        unseenLog = true;
        renderTabs();
      }
    });
    renderTabs();
    applyPanels();
    renderTop();
  }
  function afterBoot() {
    if (!(S.p2p && S.p2p.role === 'guest')) {
      Store.campaigns().then(() => {
        renderTop();
        if (S.dm && S.canWrite && S.campName && S.game.cname !== S.campName && S.loaded) Store.Act.setGame({ cname: S.campName });
      });
    }
    renderTop();
    renderTabs();
    // everyone signs in once per device (automated test browsers skip this unless the address has ?acct)
    if (S.accountsMode) return; // signed in on the server already, with a name
    const testSkip = navigator.webdriver && !/[?&]acct\b/.test(location.search);
    const wantAcct = () => S.loaded && !S.me.acct && !testSkip;
    if (wantAcct()) setTimeout(openAccount, 300);
    else if (!S.loaded && !testSkip) Store.on('loaded', () => wantAcct() && !Sheet.cur && openAccount());
    else if (S.mode === 'remote' && !S.me.nick) setTimeout(askName, 600);
  }

  return {
    init, afterBoot, toast, show, openTemplatePicker, openTemplateSheet, openScenes, openDice, boardAct, selCardHtml, initOrder, initVisual,
    openStatBlock, snapshot: () => ({ tab, sideTab, view: Board.getView() }),
  };
})();
window.UI = UI;
