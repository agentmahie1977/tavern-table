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
  const setHTML = (el, h) => {
    el.innerHTML = typeof h === 'string' ? h : val(h);
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
  function rollAttack(who, name, hit, dmg, ty, mode, extra, critMin) {
    const m = mode || 'normal';
    const a = Core.roll(Core.d20Expr(hit, m));
    const crit = a && a.nat >= (critMin || 20);
    const rolls = [mk(a, 'To hit')];
    (Array.isArray(dmg) ? dmg : [[dmg, ty]]).forEach(([e, t]) => {
      if (!e) return;
      const d = Core.roll(crit ? Core.critExpr(e) : e);
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
    $('#sceneName').textContent = sc.name || 'Blank grid';
    const conn = $('#conn');
    conn.className = 'conn ' + (S.mode === 'local' ? 'solo' : S.loaded && !S.offline ? 'live' : '');
    conn.title = S.mode === 'local' ? 'Solo mode: this device only' : S.offline ? 'Reconnecting…' : S.loaded ? 'Live' : 'Connecting…';
    const pill = $('#statusPill');
    let st = '';
    if (S.mode === 'local') st = 'Solo · this device';
    else if (S.offline) st = 'Reconnecting…';
    else if (S.readOnly) st = 'View only';
    else if (S.stale && !S.loaded) st = 'Can’t reach the table';
    else if (S.relay) st = 'Limited access';
    pill.hidden = !st;
    pill.textContent = st;
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
      <p class="hint">Rolls from a hero’s sheet show up for everyone in the dice log.</p>`;
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
    if (d.cast) {
      const known = (ch.spells || []).map((i) => D.spellsById && D.spellsById.get(i)).filter(Boolean);
      const byLvl = {};
      known.forEach((sp) => (byLvl[sp.lvl] = byLvl[sp.lvl] || []).push(sp));
      const used = ch.slots || {};
      const lvls = [];
      for (let l = 0; l <= 9; l++) {
        const total = l ? d.cast.slots[l - 1] || 0 : 0;
        if (!byLvl[l] && !total) continue;
        const pips = [];
        for (let k = 0; k < total; k++) pips.push(html`<button type="button" class="slot-pip ${k < (used[l] || 0) ? 'used' : ''}" data-act="slot" data-l="${l}" data-k="${k}" aria-label="${ord(l)} level slot ${k + 1}" ${edit ? '' : 'disabled'}></button>`);
        lvls.push(html`<div class="spell-lvl"><div class="spell-lvl-head"><h4>${l === 0 ? 'Cantrips' : ord(l) + ' level'}${total ? ` · ${total - (used[l] || 0)} of ${total} slots` : ''}</h4>${total ? html`<div class="slot-pips">${pips}</div>` : ''}</div>
          ${byLvl[l] ? html`<div class="chips">${byLvl[l].sort((a, b) => a.n.localeCompare(b.n)).map((sp) => html`<button type="button" class="chip" data-act="spell" data-i="${sp.i}">${sp.n}${sp.conc ? ' ©' : ''}${sp.area ? html` ${icon('area')}` : ''}</button>`)}</div>` : html`<p class="hint">No ${l ? ord(l) + '-level spells' : 'cantrips'} chosen.</p>`}</div>`);
      }
      spells = html`<div class="card"><div class="card-title"><h3>Spellcasting</h3><span class="small muted">${Core.ABIL_NAME[d.cast.ab]}</span></div>
        <div class="statline"><div class="stat"><span class="k">Save DC</span><span class="v">${d.cast.dc}</span></div><button type="button" class="stat" data-act="roll-spellatk" ${edit ? '' : 'disabled'}><span class="k">Spell attack</span><span class="v">${fmtMod(d.cast.atk)}</span></button>${d.cast.pact ? html`<div class="stat"><span class="k">Pact slots</span><span class="v">${ord(d.cast.maxLvl)}</span></div>` : ''}</div>
        ${D.spells ? lvls : html`<p class="hint">Loading spells…</p>`}
        ${!known.length ? html`<p class="hint">No spells chosen yet. ${edit ? 'Edit the hero to pick spells.' : ''}</p>` : ''}
        <p class="hint">© marks concentration. Tap a spell to cast it, roll it, or place its area on the map.</p></div>`;
    }
    // resources
    const resUsed = ch.res || {};
    const res = d.resources.map((r) => {
      const usedN = Math.min(r.max, resUsed[r.key] || 0);
      if (r.max > 10) {
        return html`<div class="row"><span class="main"><span class="title" style="display:block">${r.n}</span><span class="sub" style="display:block">${r.max - usedN} of ${r.max} left</span></span>
          <div class="stepper"><button type="button" data-act="res-step" data-k="${r.key}" data-d="1" aria-label="Use one" ${edit && usedN < r.max ? '' : 'disabled'}>−</button><span class="val num">${r.max - usedN}</span><button type="button" data-act="res-step" data-k="${r.key}" data-d="-1" aria-label="Restore one" ${edit && usedN > 0 ? '' : 'disabled'}>+</button></div></div>`;
      }
      const pips = [];
      for (let k = 0; k < r.max; k++) pips.push(html`<button type="button" class="slot-pip ${k < usedN ? 'used' : ''}" data-act="res" data-k="${r.key}" data-n="${k}" aria-label="${r.n} ${k + 1}" ${edit ? '' : 'disabled'}></button>`);
      return html`<div class="row"><span class="main"><span class="title" style="display:block">${r.n}</span><span class="sub" style="display:block">${r.max - usedN} of ${r.max} left</span></span><div class="slot-pips res-pips">${pips}</div></div>`;
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
          <div class="btn-row"><button type="button" class="btn btn-ghost btn-sm" data-act="rest-short">Short rest</button><button type="button" class="btn btn-ghost btn-sm" data-act="rest-long">Long rest</button><span class="small muted">Hit dice ${d.hitDice}</span></div>` : ''}</div>
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
      <div class="card"><div class="card-title"><h3>Attacks</h3><span class="small muted">${d.acNote}${d.critMin < 20 ? ` · crits on ${d.critMin}–20` : ''}</span></div>
        ${d.toggles.length ? html`<div class="chips">${d.toggles.map((t) => html`<button type="button" class="chip fx-toggle" data-act="fx" data-k="${t.key}" aria-pressed="${t.on}" ${edit ? '' : 'disabled'}><b>${t.feat}</b> ${t.on ? 'on' : 'off'} · ${t.text.replace(/, when switched on$/, '')}</button>`)}</div>` : ''}
        <div class="list">${attacks}</div></div>
      ${d.feats.length ? html`<div class="card"><div class="card-title"><h3>Feats</h3></div><div class="list">${d.feats.map((f) => html`<button type="button" class="row tap" data-act="hbfeat" data-id="${f.id}"><span class="main"><span class="title" style="display:block">${f.name}</span><span class="sub" style="display:block">${(f.effects || []).map(Core.describeEffect).filter(Boolean).join(' · ') || 'Description only'}</span></span></button>`)}</div></div>` : ''}
      ${spells}
      ${res.length ? html`<div class="card"><div class="card-title"><h3>Resources</h3></div><div class="list">${res}</div></div>` : ''}
      ${d.classSpecific.length ? html`<div class="card"><div class="card-title"><h3>${cls.n} table</h3></div><dl class="kv">${d.classSpecific.map(([k, v]) => html`<dt>${k}</dt><dd class="num">${v}</dd>`)}</dl></div>` : ''}
      <div class="card"><div class="card-title"><h3>Conditions</h3></div><div class="chips">${condList.map((c) => html`<button type="button" class="chip cond" data-act="cond" data-c="${c}" aria-pressed="${conds.includes(c)}" ${edit ? '' : 'disabled'}>${R.conditions[c].n}</button>`)}</div></div>
      <details class="fold"><summary>Features and traits</summary><div class="fold-in">
        <div class="label">${cls.n} features</div><div class="chips">${feats}</div>
        <div class="label">Racial traits</div><div class="chips">${traits.length ? traits : html`<span class="muted small">None</span>`}</div>
        ${bgFeat && bgFeat.n ? html`<div class="label">Background</div><div class="chips"><button type="button" class="chip" data-act="bgfeat">${bgFeat.n}</button></div>` : ''}</div></details>
      <div class="card"><div class="card-title"><h3>Notes</h3></div><textarea id="heroNotes" placeholder="Gear, gold, allies, secrets…" ${edit ? '' : 'readonly'}>${ch.notes || ''}</textarea></div>
      ${edit ? html`<div class="btn-row end"><button type="button" class="btn btn-danger btn-sm" data-act="delete-hero">${icon('trash')} Delete hero</button></div>` : ''}`;
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
        if (d.cast) rollD20(who, 'Spell attack', d.cast.atk, takeMode());
        break;
      case 'roll-atk': {
        const at = d.attacks[Number(b.dataset.i)];
        // feats switched on are already in at.hit / at.dmg; typed extra damage rolls separately
        if (at) rollAttack(who, at.n + (at.using && at.using.length ? ` (${at.using.join(', ')})` : ''), at.hit, [[at.dmg, at.ty], ...(at.extra || [])], null, takeMode(), null, d.critMin);
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
      case 'rest-short': {
        // nested objects merge on update, so reset by writing zeros
        const res = {};
        ['second-wind', 'surge', 'channel', 'ki', 'wild-shape', 'breath'].forEach((k) => (res[k] = 0));
        d.resources.forEach((r) => r.reset === 'short' && (res[r.key] = 0));
        if (ch.cls === 'bard' && (ch.level || 1) >= 5) res.inspiration = 0;
        const patch = { res };
        if (ch.cls === 'warlock') patch.slots = zeroKeys(ch.slots);
        Store.Act.patchChar(ch.id, patch);
        postRoll({ who, label: 'Short rest', rolls: [mk(Core.roll('1d' + d.hd + Core.exprMod(d.mods.con)), 'Hit die (spend if needed)')] });
        toast('Short rest taken. Roll shown in case you spend a hit die.');
        break;
      }
      case 'rest-long':
        Store.Act.patchChar(ch.id, { hp: null, tmp: 0, slots: zeroKeys(ch.slots), res: zeroKeys(ch.res), death: { s: 0, f: 0 } });
        Store.Act.log({ kind: 'sys', who, label: `${who} finishes a long rest.` });
        break;
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
    weapons: [], spells: [], feats: [], freeFeats: 0, hpMode: 'avg', hpManual: '', color: S.me.color, portrait: '', ancestry: '', align: '', acBonus: 0, speedBonus: 0, customRes: [], notes: '',
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
    const featIds = (c.feats || []).filter((id) => S.hb.has(id));
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
    const expChips = d.expertiseSlots ? [...profAll].sort().map((sk) => {
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
      const avail = list.filter((s) => s.cls.includes(c.cls) && s.lvl === H.spellLvl && (!q || s.n.toLowerCase().includes(q))).sort((a, b) => a.n.localeCompare(b.n));
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
        ${subcls.length ? html`<label class="field"><span>${subcls[0].flavor || 'Subclass'}</span><select id="b-sub" data-field="subclass">${opt('', 'Choose later', c.subclass)}${subcls.map((s) => opt(s.i, s.n, c.subclass))}</select></label>` : html`<p class="hint">${cls.subs[0] ? `${cls.subs[0].flavor} unlocks at level ${cls.subs[0].start}.` : ''}</p>`}
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
        ${expChips ? html`<div class="label">Expertise (${d.expertiseSlots})</div><div class="chips">${expChips.length ? expChips : html`<span class="hint">Choose skills first.</span>`}</div>` : ''}
      </div>
      <div class="card"><div class="card-title"><h3>Armor and weapons</h3><span class="small muted">AC ${d.ac}</span></div>
        <div class="grid2"><label class="field"><span>Armor</span><select id="b-armor" data-field="armor">${opt('none', 'No armor', c.armor)}${armorGroups}</select></label>
          <label class="field" style="align-content:end"><span>Shield</span><button type="button" class="chip" data-act="shield" aria-pressed="${!!c.shield}">${c.shield ? 'Shield (+2 AC)' : 'No shield'}</button></label></div>
        <input type="search" id="weaponQ" placeholder="Find a weapon" value="${H.wq || ''}" aria-label="Find a weapon">
        ${weaponChips}
        <p class="hint">A dot after a weapon means this hero isn’t proficient with it.</p>
      </div>
      ${spellSec}
      <div class="card"><div class="card-title"><h3>Feats</h3><span class="small muted">${featIds.length} chosen</span></div>
        ${S.hb.size ? html`<div class="chips">${[...S.hb.values()].sort((a, b) => String(a.name).localeCompare(String(b.name))).map((f) => {
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
        ${(c.customRes || []).length ? (c.customRes || []).map((r, i) => html`<div class="grid2"><input type="text" id="cr-n-${i}" data-res="${i}" data-k="n" value="${r.n}" placeholder="Luck points" aria-label="Tracker name"><div class="btn-row"><input type="number" id="cr-m-${i}" data-res="${i}" data-k="max" value="${r.max}" min="1" max="999" style="width:90px" aria-label="Uses"><button type="button" class="btn btn-ghost btn-sm" data-act="res-del" data-i="${i}">${icon('trash')}</button></div></div>`) : html`<p class="hint">For anything the sheet doesn’t track: luck points, a magic item’s charges, arrows.</p>`}
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
        if (d && d.cast && edit) {
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
        if (a === 'sp-heal' && d) return rollExpr(who, sp.n + lvlTxt + ' · healing', spellHealAt(sp, slot || 1, d.cast.mod));
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
      live: ['tokens'],
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
          <div class="sb-sub">${monsterLine(m)}</div><hr class="sb-rule">
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
      live: ['tokens'],
      render() {
        const tok = S.tokens.get(t.id);
        if (!tok) return html`<p class="hint">This token is gone.</p>`;
        const info = Board.tokInfo(tok);
        const isPc = tok.kind === 'pc';
        return html`${!isPc ? html`<label class="field"><span>Name</span><input type="text" id="tkName" value="${tok.name || ''}" maxlength="40"></label>` : html`<p class="hint">${info.name}’s name and color come from their hero sheet.</p>`}
          <div class="field"><span>Size</span><div class="seg">${[[0.5, 'Tiny'], [1, 'Small/Med'], [2, 'Large'], [3, 'Huge'], [4, 'Garg.']].map(([s, l]) => html`<button type="button" data-act="size" data-s="${s}" aria-pressed="${Number(tok.size || 1) === s}">${l}</button>`)}</div></div>
          ${!isPc ? html`<div class="grid2"><label class="field"><span>Max HP</span><input type="number" id="tkMax" value="${tok.max || ''}" min="0" max="9999" inputmode="numeric"></label><label class="field"><span>AC</span><input type="number" id="tkAc" value="${tok.ac || ''}" min="0" max="40" inputmode="numeric"></label></div>
          <div class="field"><span>Color</span><div class="swatches">${['#e2654f', ...Store.PALETTE].map((col) => html`<button type="button" class="swatch" style="--c:${col}" data-act="color" data-c="${col}" aria-pressed="${tok.color === col}" aria-label="Color ${col}"></button>`)}</div></div>` : ''}
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
        <div class="list">${list.slice(0, Enc.limit).map((m) => html`<div class="row mon-row"><span class="cr">${Core.crLabel(m.cr)}</span><button type="button" class="main" data-act="sb" data-i="${m.i}" style="background:none;border:0;text-align:left;cursor:pointer;padding:0;color:inherit;min-width:0"><span class="title" style="display:block">${m.n}</span><span class="sub" style="display:block">${m.size} ${m.type} · ${m.xp.toLocaleString()} XP · AC ${m.ac} · HP ${m.hp}</span></button>
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
  // Feats the table writes itself. Effects are picked from menus, so the sheet can apply them.
  const HB = { view: 'list', id: null, draft: null };
  const FX_LABEL = {
    attack: 'Attack change (to hit, damage)', ability: 'Ability score increase', ac: 'Armor class bonus', speed: 'Speed bonus',
    init: 'Initiative bonus', hpPerLevel: 'Hit points per level', passive: 'Passive Perception bonus', save: 'Saving throw bonus',
    saveProf: 'Saving throw proficiency', skillProf: 'Skill proficiency', resource: 'Limited uses (tracker)', crit: 'Wider critical range',
  };
  const FX_DEFAULT = {
    attack: { when: 'toggle', filter: 'any', hit: 0, dmg: '' }, ability: { ab: 'str', n: 1 }, ac: { n: 1 }, speed: { n: 5 }, init: { n: 1 },
    hpPerLevel: { n: 1 }, passive: { n: 5 }, save: { ab: 'all', n: 1 }, saveProf: { ab: 'con' }, skillProf: { sk: 'perception' },
    resource: { name: '', max: 'pb', reset: 'long' }, crit: { min: 19 },
  };
  const canEditHb = (f) => !S.readOnly && (S.dm || !f || f.by === S.me.pk);
  function fxLines(f) {
    return (f.effects || []).map(Core.describeEffect).filter(Boolean);
  }
  function openFeat(f) {
    const lines = fxLines(f);
    openText(f.name || 'Feat', (f.desc || '') + (lines.length ? (f.desc ? '\n\n' : '') + 'In Tavern Table:\n• ' + lines.join('\n• ') : ''));
  }
  function fxFields(e, i) {
    const R = D.rules;
    const id = (f) => `hbf-${i}-${f}`;
    const sel = (f, opts, cur, label) => html`<label class="field"><span>${label}</span><select id="${id(f)}" data-e="${i}" data-f="${f}">${opts.map(([v, l]) => html`<option value="${v}" ${String(cur) === String(v) ? 'selected' : ''}>${l}</option>`)}</select></label>`;
    const num = (f, cur, label, step) => html`<label class="field"><span>${label}</span><input type="number" id="${id(f)}" data-e="${i}" data-f="${f}" value="${cur}" step="${step || 1}" inputmode="numeric"></label>`;
    const abOpts = Core.ABILS.map((a) => [a, Core.ABIL_NAME[a]]);
    switch (e.t) {
      case 'attack':
        return html`<div class="grid2">${sel('when', [['toggle', 'Switch on the sheet'], ['always', 'Always on']], e.when, 'When')}${sel('filter', Core.ATTACK_FILTERS.map((f) => [f, f === 'any' ? 'All weapon attacks' : titleCase(f) + ' attacks']), e.filter, 'Applies to')}</div>
          <div class="grid3">${num('hit', e.hit || 0, 'To hit')}<label class="field"><span>Extra damage</span><input type="text" id="${id('dmg')}" data-e="${i}" data-f="dmg" value="${e.dmg || ''}" placeholder="3 or 1d6" autocomplete="off"></label>${sel('dmgType', [['', 'Weapon’s type'], ...Core.DAMAGE_TYPES.map((t) => [t, titleCase(t)])], e.dmgType || '', 'Damage type')}</div>`;
      case 'ability':
        return html`<div class="grid2">${sel('ab', abOpts, e.ab, 'Ability')}${num('n', e.n, 'Increase')}</div>`;
      case 'ac': case 'speed': case 'init': case 'hpPerLevel': case 'passive':
        return num('n', e.n, 'Amount', e.t === 'speed' ? 5 : 1);
      case 'save':
        return html`<div class="grid2">${sel('ab', [['all', 'All saves'], ...abOpts], e.ab, 'Saving throw')}${num('n', e.n, 'Bonus')}</div>`;
      case 'saveProf':
        return sel('ab', abOpts, e.ab, 'Saving throw');
      case 'skillProf':
        return sel('sk', Object.keys(R.skills).map((k) => [k, R.skills[k].n]), e.sk, 'Skill');
      case 'resource':
        return html`<div class="grid3"><label class="field"><span>Name</span><input type="text" id="${id('name')}" data-e="${i}" data-f="name" value="${e.name || ''}" maxlength="40" placeholder="Uses" autocomplete="off"></label>
          ${sel('max', [['pb', 'Proficiency bonus'], ...Core.ABILS.map((a) => [a, Core.ABIL_SHORT[a] + ' modifier']), ...[1, 2, 3, 4, 5].map((n) => [String(n), String(n)])], e.max, 'How many')}
          ${sel('reset', [['long', 'Long rest'], ['short', 'Short rest']], e.reset, 'Comes back after')}</div>`;
      case 'crit':
        return sel('min', [['19', '19–20'], ['18', '18–20']], e.min, 'Critical hit on');
    }
    return '';
  }
  function hbEditHtml() {
    const f = HB.draft;
    const existing = HB.id && S.hb.get(HB.id);
    return html`<div class="panel-head"><button type="button" class="btn btn-ghost btn-sm" data-act="hb-back">${icon('back')} Homebrew</button><h2>${HB.id ? 'Edit feat' : 'New feat'}</h2></div>
      <div class="card"><label class="field"><span>Name</span><input type="text" id="hbName" value="${f.name}" maxlength="60" placeholder="Your feat’s name" autocomplete="off"></label>
        <label class="field"><span>Description (shown on the sheet)</span><textarea id="hbDesc" maxlength="3000" placeholder="What it does, in your words">${f.desc}</textarea></label></div>
      <div class="card"><div class="card-title"><h3>What the app does</h3></div>
        ${f.effects.length ? f.effects.map((e, i) => html`<div class="fx-row"><div class="card-title"><b>${FX_LABEL[e.t] || e.t}</b><button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="hb-fx-del" data-i="${i}" aria-label="Remove this effect">${icon('trash')}</button></div>
          ${fxFields(e, i)}<p class="hint fx-sum">${Core.describeEffect(e)}</p></div>`) : html`<p class="hint">No effects yet: the feat will show its description only.</p>`}
        <div class="expr-row"><select id="hbAddType" aria-label="Effect to add">${Core.EFFECT_TYPES.map((t) => html`<option value="${t}">${FX_LABEL[t]}</option>`)}</select><button type="button" class="btn" data-act="hb-fx-add">${icon('plus')} Add</button></div>
        <p class="hint">Use “Switch on the sheet” for anything a player chooses to use on a turn: the hero sheet gets an on/off button and the rolls change while it’s on. Things the app can’t track, like reactions or cover, go in the description.</p></div>
      <div class="save-bar">${existing && canEditHb(existing) ? html`<button type="button" class="btn btn-danger" data-act="hb-del">${icon('trash')} Delete</button>` : ''}<span class="grow"></span>
        <button type="button" class="btn btn-ghost" data-act="hb-back">Cancel</button><button type="button" class="btn btn-primary" data-act="hb-save">${icon('check')} Save feat</button></div>`;
  }
  function hbRender() {
    if (!rulesReady()) return html`<div class="empty"><h3>Opening the rulebook…</h3></div>`;
    if (HB.view === 'edit' && HB.draft) return hbEditHtml();
    const list = [...S.hb.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const usedBy = (id) => [...S.chars.values()].filter((c) => (c.feats || []).includes(id)).map((c) => c.name || 'Hero');
    return html`<div class="panel-head"><h2>Homebrew</h2>${S.readOnly ? '' : html`<button type="button" class="btn btn-primary" data-act="hb-new">${icon('plus')} New feat</button>`}</div>
      ${list.length ? html`<div class="list">${list.map((f) => {
        const users = usedBy(f.id);
        const lines = fxLines(f);
        return html`<div class="card"><div class="card-title"><h3>${f.name || 'Untitled feat'}</h3>${canEditHb(f) ? html`<button type="button" class="btn btn-sm" data-act="hb-edit" data-id="${f.id}">${icon('edit')} Edit</button>` : ''}</div>
          ${f.desc ? html`<p class="prose">${f.desc}</p>` : ''}
          ${lines.length ? html`<div class="chips">${lines.map((l) => html`<span class="badge brass">${l}</span>`)}</div>` : ''}
          <p class="hint">${users.length ? 'Taken by ' + users.join(', ') : 'No hero has taken this yet. Add it in the hero builder.'}</p></div>`;
      })}</div>` : html`<div class="empty"><h3>No homebrew yet</h3><p class="hint">Write your table’s own feats. Pick what each one does from a menu (bonuses, attack trade-offs, limited uses) and hero sheets apply it for you, with on/off buttons for anything used by choice.</p>
        ${S.readOnly ? '' : html`<button type="button" class="btn btn-primary" data-act="hb-new">${icon('plus')} Make a feat</button>`}</div>`}`;
  }
  function hbAct(a, b) {
    const f = HB.draft;
    switch (a) {
      case 'hb-new':
        HB.view = 'edit';
        HB.id = null;
        HB.draft = { name: '', desc: '', effects: [] };
        break;
      case 'hb-edit': {
        const doc = S.hb.get(b.dataset.id);
        if (!doc) return;
        HB.view = 'edit';
        HB.id = doc.id;
        HB.draft = { name: doc.name || '', desc: doc.desc || '', effects: Store.clone(doc.effects || []) };
        break;
      }
      case 'hb-back':
        HB.view = 'list';
        HB.draft = null;
        break;
      case 'hb-fx-add': {
        const t = ($('#hbAddType') || {}).value;
        if (!f || !FX_DEFAULT[t]) return;
        if (f.effects.length >= 20) return toast('That’s the most effects one feat can have.', 'warn');
        f.effects.push(Object.assign({ t }, Store.clone(FX_DEFAULT[t])));
        break;
      }
      case 'hb-fx-del':
        if (f) f.effects.splice(Number(b.dataset.i), 1);
        break;
      case 'hb-save': {
        if (!f) return;
        const name = String(f.name || '').trim().slice(0, 60);
        if (!name) {
          toast('Give the feat a name first.', 'warn');
          const n = $('#hbName');
          if (n) n.focus();
          return;
        }
        const existing = HB.id && S.hb.get(HB.id);
        Store.Act.saveHomebrew(HB.id, { kind: 'feat', name, desc: String(f.desc || '').slice(0, 3000), effects: f.effects.slice(0, 20), by: existing ? existing.by : S.me.pk });
        toast(`Saved “${name}”. Heroes can take it in the hero builder.`);
        HB.view = 'list';
        HB.draft = null;
        break;
      }
      case 'hb-del': {
        const doc = S.hb.get(HB.id);
        if (!doc) return;
        return confirmSheet(`Delete “${doc.name}”?`, 'Heroes who took it lose its effects. This can’t be undone.', 'Delete feat', () => {
          Store.Act.deleteHomebrew(doc.id);
          HB.view = 'list';
          HB.draft = null;
          renderPanel('homebrew', true);
        });
      }
      default:
        return;
    }
    renderPanel('homebrew', true);
    panels.homebrew.el.scrollTop = a === 'hb-fx-add' ? panels.homebrew.el.scrollTop : 0;
  }
  // typing updates the draft only; the summary lines refresh when a field is left (change)
  function hbInput(t) {
    const f = HB.draft;
    if (!f) return;
    if (t.id === 'hbName') f.name = t.value;
    else if (t.id === 'hbDesc') f.desc = t.value;
    else if (t.dataset.e !== undefined && f.effects[Number(t.dataset.e)]) f.effects[Number(t.dataset.e)][t.dataset.f] = t.value;
  }
  function hbChange(t) {
    hbInput(t);
    if (t.dataset.e !== undefined) {
      panels.homebrew.typing = false;
      renderPanel('homebrew', true);
    }
  }

  /* ================================================== PEOPLE */
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
        return html`<div class="card"><div class="card-title"><h3>You</h3>${S.me.isOwner ? html`<span class="badge brass">Table owner</span>` : ''}</div>
          <label class="field"><span>Your name at the table</span><input type="text" id="pNick" value="${S.me.nick}" maxlength="40" placeholder="What friends call you" autocomplete="off"></label>
          <div class="field"><span>Your color</span><div class="swatches">${Store.PALETTE.map((col) => html`<button type="button" class="swatch" style="--c:${col}" data-act="pcol" data-c="${col}" aria-pressed="${S.me.color === col}" aria-label="Color ${col}"></button>`)}</div></div>
          <div class="field"><span>Role on this device</span><div class="seg"><button type="button" data-act="role" data-r="player" aria-pressed="${!S.dm}">Player</button><button type="button" data-act="role" data-r="dm" aria-pressed="${S.dm}">Dungeon Master</button></div></div>
          ${mine.length ? html`<label class="field"><span>Playing as</span><select id="pChar"><option value="">Nobody yet</option>${mine.map((c) => html`<option value="${c.id}" ${S.myChar === c.id ? 'selected' : ''}>${c.name}</option>`)}</select></label>` : ''}
          <button type="button" class="chip" data-act="names" aria-pressed="${!!showNames}">${showNames ? 'Token names always shown' : 'Token names on hover'}</button></div>
          <div class="card"><div class="card-title"><h3>At the table now</h3><span class="small muted">${people.length}</span></div>
            ${people.length ? html`<div class="list">${people.map((p) => {
              const pr = p.presence || {};
              const ch = pr.ch && S.chars.get(pr.ch);
              return html`<div class="row"><span class="disc sm" style="--c:${safeColor(pr.col) || '#888'}">${initials(pr.nm || '?')}</span><span class="main"><span class="title" style="display:block">${pr.nm || (p.isMe ? 'You' : 'Someone')}${p.isMe ? ' (you)' : ''}</span><span class="sub" style="display:block">${pr.dm ? 'DM' : 'Player'}${ch ? ' · ' + ch.name : ''}${pr.w === 1 ? '' : p.isMe && S.relay ? ' · limited access' : ''}${p.guest ? ' · guest' : ''}</span></span></div>`;
            })}</div>` : html`<p class="hint">${S.mode === 'local' ? 'Solo mode: open this table from its shared link to see friends here.' : 'Only you for now.'}</p>`}</div>
          ${S.server ? html`<div class="card"><div class="card-title"><h3>Invite friends</h3></div>
            <p class="prose">Send friends this address and the table password. Everyone who has both can move tokens, roll and edit heroes.</p>
            <input type="text" readonly value="${location.origin + location.pathname}" aria-label="Table address" onfocus="this.select()">
            <p class="hint">${S.me.isOwner ? 'This computer is running the table. Keep the server window open while you play; closing it ends the game for everyone (nothing is lost, just start it again).' : 'The table runs on the DM’s computer. If it stops, your screen says Reconnecting… until it is back.'}</p></div>` : html`<div class="card"><div class="card-title"><h3>Invite friends</h3></div>
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
        if (a === 'clear-log') return confirmSheet('Clear the dice log?', 'All rolls and messages disappear for everyone.', 'Clear log', () => Store.Act.clearLog());
      },
      change(t) {
        if (t.id === 'pNick') Store.setNick(String(t.value).trim().slice(0, 40));
        if (t.id === 'pChar') Store.setMyChar(t.value || null);
      },
    });
  }
  let showNames = Store.LS.get('tt.names', false);

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
    renderTop();
    renderTabs();
    if (S.mode === 'remote' && !S.me.nick) setTimeout(askName, 600);
  }

  return {
    init, afterBoot, toast, show, openTemplatePicker, openTemplateSheet, openScenes, openDice, boardAct, selCardHtml, initOrder, initVisual,
    openStatBlock, snapshot: () => ({ tab, sideTab, view: Board.getView() }),
  };
})();
window.UI = UI;
