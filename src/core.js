/* ===================================================================
   core.js — pure game logic: dice, 5e character math, encounter math,
   grid geometry. No DOM access, so it can be unit-tested in Node.
   =================================================================== */
const Core = (() => {
  'use strict';
  const ABILS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
  const ABIL_NAME = { str: 'Strength', dex: 'Dexterity', con: 'Constitution', int: 'Intelligence', wis: 'Wisdom', cha: 'Charisma' };
  const ABIL_SHORT = { str: 'STR', dex: 'DEX', con: 'CON', int: 'INT', wis: 'WIS', cha: 'CHA' };
  const SIZE_CELLS = { Tiny: 0.5, Small: 1, Medium: 1, Large: 2, Huge: 3, Gargantuan: 4 };
  const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8];
  const POINT_COST = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };
  const MINUS = '−';

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const abMod = (score) => Math.floor(((score || 10) - 10) / 2);
  const fmtMod = (n) => (n >= 0 ? '+' : MINUS) + Math.abs(n);
  const exprMod = (n) => (n === 0 ? '' : n > 0 ? '+' + n : '-' + Math.abs(n));

  /* ------------------------------------------------------------ dice */
  let rng = null; // test hook: function(sides) -> 1..sides
  function rollDie(sides) {
    if (rng) return rng(sides);
    const buf = new Uint32Array(1);
    const limit = Math.floor(0x100000000 / sides) * sides;
    let x;
    do {
      crypto.getRandomValues(buf);
      x = buf[0];
    } while (x >= limit);
    return (x % sides) + 1;
  }

  // Grammar: term (('+'|'-') term)*, term := [N]d(S|%)[kh|kl|dh|dl[N]] | N
  function parseDice(src) {
    const raw = String(src == null ? '' : src).toLowerCase();
    if (/[0-9%]\s+[0-9d]/.test(raw)) return null;
    const s = raw.replace(/\s+/g, '').replace(/−/g, '-');
    if (!s || s.length > 80) return null;
    const re = /([+-]?)(?:(\d*)d(\d+|%)((?:kh|kl|dh|dl|k|d)\d*)?|(\d+))/y;
    const terms = [];
    let i = 0;
    while (i < s.length) {
      re.lastIndex = i;
      const m = re.exec(s);
      if (!m || m[0] === '' || m[0] === '+' || m[0] === '-') return null;
      if (terms.length && !m[1]) return null;
      const sign = m[1] === '-' ? -1 : 1;
      if (m[3] !== undefined) {
        const count = m[2] === '' ? 1 : parseInt(m[2], 10);
        const sides = m[3] === '%' ? 100 : parseInt(m[3], 10);
        if (!(count >= 1 && count <= 100 && sides >= 1 && sides <= 1000)) return null;
        let keep = null;
        if (m[4]) {
          const op = m[4].replace(/\d+$/, '');
          const nRaw = m[4].slice(op.length);
          const n = nRaw === '' ? 1 : parseInt(nRaw, 10);
          if (op === 'kh' || op === 'k') keep = { hi: true, n };
          else if (op === 'kl') keep = { hi: false, n };
          else if (op === 'dl' || op === 'd') keep = { hi: true, n: count - n };
          else if (op === 'dh') keep = { hi: false, n: count - n };
          if (!keep || keep.n < 0 || keep.n > count) return null;
        }
        terms.push({ sign, count, sides, keep });
      } else {
        const value = parseInt(m[5], 10);
        if (!(value <= 100000)) return null;
        terms.push({ sign, value });
      }
      i = re.lastIndex;
    }
    return terms.length ? terms : null;
  }

  function termsToExpr(terms) {
    return terms
      .map((t, i) => {
        const sg = t.sign < 0 ? '-' : i ? '+' : '';
        if (t.value !== undefined) return sg + t.value;
        let k = '';
        if (t.keep) k = (t.keep.hi ? 'kh' : 'kl') + t.keep.n;
        return sg + t.count + 'd' + t.sides + k;
      })
      .join('');
  }

  // Roll an expression. Returns {e, t, p, nat} or null.
  //  p: parts, dice term {s, d, r:[...], x:[dropped idx]} or constant {s, v}
  //  nat: natural value of the first kept d20 (for crit/fumble), else null
  function roll(expr) {
    const terms = typeof expr === 'string' ? parseDice(expr) : expr;
    if (!terms) return null;
    let total = 0;
    let nat = null;
    const parts = terms.map((t) => {
      if (t.value !== undefined) {
        total += t.sign * t.value;
        return { s: t.sign, v: t.value };
      }
      const r = [];
      for (let i = 0; i < t.count; i++) r.push(rollDie(t.sides));
      let dropped = [];
      if (t.keep) {
        const idx = r.map((v, i) => i).sort((a, b) => (t.keep.hi ? r[b] - r[a] : r[a] - r[b]) || a - b);
        dropped = idx.slice(t.keep.n).sort((a, b) => a - b);
      }
      let sum = 0;
      r.forEach((v, i) => {
        if (!dropped.includes(i)) sum += v;
      });
      total += t.sign * sum;
      if (nat === null && t.sides === 20 && t.sign > 0) {
        const kept = r.filter((v, i) => !dropped.includes(i));
        if (kept.length === 1) nat = kept[0];
      }
      const part = { s: t.sign, d: t.sides, r };
      if (dropped.length) part.x = dropped;
      return part;
    });
    return { e: termsToExpr(terms), t: total, p: parts, nat };
  }

  function d20Expr(bonus, mode) {
    const base = mode === 'adv' ? '2d20kh1' : mode === 'dis' ? '2d20kl1' : '1d20';
    return base + exprMod(bonus);
  }

  // Double the dice of a damage expression (critical hit)
  function critExpr(expr) {
    const t = parseDice(expr);
    if (!t) return expr;
    return termsToExpr(t.map((x) => (x.value !== undefined ? x : Object.assign({}, x, { count: x.count * 2, keep: null }))));
  }

  // Average of an expression (for monster HP)
  function avgExpr(expr) {
    const t = parseDice(expr);
    if (!t) return 0;
    let a = 0;
    t.forEach((x) => {
      if (x.value !== undefined) a += x.sign * x.value;
      else a += x.sign * (x.keep ? x.keep.n : x.count) * ((x.sides + 1) / 2);
    });
    return Math.floor(a);
  }

  // Replace "MOD" in SRD heal strings and tidy spacing
  function cleanExpr(s, modVal) {
    return String(s).replace(/MOD/g, String(modVal >= 0 ? modVal : '(' + modVal + ')')).replace(/\s+/g, '').replace(/\+\(-/g, '-').replace(/\)/g, '').replace(/\+-/g, '-');
  }

  /* ---------------------------------------------- character derivation */
  const ARMORLESS = 'none';

  function proficiencyBonus(level) {
    return 2 + Math.floor((clamp(level, 1, 20) - 1) / 4);
  }

  function racialBonus(c, R) {
    const out = { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 };
    const race = R.races[c.race];
    if (race) {
      for (const k in race.bonus) out[k] += race.bonus[k];
      if (race.choose && Array.isArray(c.raceChoice)) {
        c.raceChoice.slice(0, race.choose).forEach((ab) => {
          if (out[ab] !== undefined && !race.bonus[ab]) out[ab] += 1;
        });
      }
    }
    const sub = c.subrace && R.subraces[c.subrace];
    if (sub && sub.race === c.race) for (const k in sub.bonus) out[k] += sub.bonus[k];
    return out;
  }

  function asiPoints(c, R) {
    const cls = R.classes[c.cls];
    if (!cls) return 0;
    const L = cls.levels[clamp(c.level || 1, 1, 20) - 1];
    return (L ? L.asi || 0 : 0) * 2;
  }

  function pointBuyCost(base) {
    let total = 0;
    for (const ab of ABILS) {
      const v = base[ab];
      if (POINT_COST[v] === undefined) return null;
      total += POINT_COST[v];
    }
    return total;
  }

  function weaponProficient(widx, c, R) {
    const cls = R.classes[c.cls];
    if (cls && cls.weapons.includes(widx)) return true;
    const traits = raceTraitIds(c, R);
    for (const t of traits) {
      const tr = R.traits[t];
      if (!tr || !tr.profs) continue;
      for (const p of tr.profs) {
        const w = p.replace(/s$/, '');
        if (w === widx) return true;
      }
    }
    return false;
  }

  function raceTraitIds(c, R) {
    const out = [];
    const race = R.races[c.race];
    if (race) out.push(...race.traits);
    const sub = c.subrace && R.subraces[c.subrace];
    if (sub && sub.race === c.race) out.push(...sub.traits);
    if (c.race === 'dragonborn' && c.ancestry && R.traits[c.ancestry]) out.push(c.ancestry);
    return out;
  }

  function racialSkills(c, R) {
    const set = new Set();
    for (const t of raceTraitIds(c, R)) {
      const tr = R.traits[t];
      if (tr && tr.profs) tr.profs.forEach((p) => p.startsWith('skill-') && set.add(p.slice(6)));
    }
    if (c.race === 'half-elf' && Array.isArray(c.raceSkills)) c.raceSkills.slice(0, 2).forEach((s) => set.add(s));
    return set;
  }

  function backgroundSkills(c, R) {
    if (c.background && c.background !== 'custom' && R.backgrounds[c.background]) return new Set(R.backgrounds[c.background].skills);
    return new Set((c.bgSkills || []).slice(0, 2));
  }

  function expertiseSlots(c) {
    const lv = c.level || 1;
    if (c.cls === 'rogue') return lv >= 6 ? 4 : 2;
    if (c.cls === 'bard') return lv >= 10 ? 4 : lv >= 3 ? 2 : 0;
    return 0;
  }

  /* ------------------------------------------- homebrew feat effects */
  // A homebrew feat is {id, name, desc, effects:[...]}; shared data, so every field is checked here.
  const EFFECT_TYPES = ['attack', 'ability', 'ac', 'speed', 'init', 'hpPerLevel', 'passive', 'save', 'saveProf', 'skillProf', 'resource', 'crit'];
  const ATTACK_FILTERS = ['any', 'melee', 'ranged', 'heavy', 'finesse', 'light', 'thrown', 'unarmed', 'spell', 'item'];
  const DAMAGE_TYPES = ['acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning', 'necrotic', 'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder'];
  const int = (v, lo, hi) => clamp(Math.round(Number(v) || 0), lo, hi);
  function cleanDmg(src) {
    const t = parseDice(String(src || ''));
    if (!t || t.some((x) => x.keep)) return '';
    const ex = termsToExpr(t);
    return ex.startsWith('-') ? ex : '+' + ex;
  }
  // flatten feats into checked effects, each with a stable key (featId_index)
  function featEffects(feats) {
    const out = [];
    (feats || []).forEach((f) => {
      if (!f || !Array.isArray(f.effects)) return;
      f.effects.slice(0, 20).forEach((e, i) => {
        if (!e || !EFFECT_TYPES.includes(e.t)) return;
        out.push(Object.assign({}, e, { key: String(f.id) + '_' + i, feat: String(f.name || 'Feat').slice(0, 60), src: String(f.id) }));
      });
    });
    return out;
  }
  const LIMIT = { ac: 10, speed: 60, init: 10, hpPerLevel: 5, passive: 10, save: 10 };
  function sumOf(fx, t, pick) {
    let n = 0;
    fx.forEach((e) => {
      if (e.t === t && (!pick || pick(e))) n += int(e.n, -LIMIT[t], LIMIT[t]);
    });
    return n;
  }
  // a short plain-language line for an effect (sheet, editor preview)
  function describeEffect(e) {
    const sg = (n) => (n >= 0 ? '+' : MINUS) + Math.abs(n);
    const filt = (f) => (f === 'any' || !f ? 'weapon attacks' : f === 'spell' ? 'spell attacks' : f === 'item' ? 'this item’s attacks' : f + ' attacks');
    switch (e.t) {
      case 'attack': {
        const bits = [];
        if (int(e.hit, -20, 20)) bits.push(sg(int(e.hit, -20, 20)) + ' to hit');
        const d = cleanDmg(e.dmg);
        if (d) bits.push(d.replace(/^\+/, '+').replace(/^-/, MINUS) + ' damage' + (e.dmgType && DAMAGE_TYPES.includes(e.dmgType) ? ' (' + e.dmgType + ')' : ''));
        return (bits.join(', ') || 'no change') + ' on ' + filt(e.filter) + (e.when === 'toggle' ? ', when switched on' : '');
      }
      case 'ability': return (ABIL_NAME[e.ab] || 'Ability') + ' ' + sg(int(e.n, -4, 4)) + ' (max 20)';
      case 'ac': return 'Armor class ' + sg(int(e.n, -10, 10));
      case 'speed': return 'Speed ' + sg(int(e.n, -60, 60)) + ' ft';
      case 'init': return 'Initiative ' + sg(int(e.n, -10, 10));
      case 'hpPerLevel': return sg(int(e.n, -5, 5)) + ' hit points per level';
      case 'passive': return 'Passive Perception ' + sg(int(e.n, -10, 10));
      case 'save': return (e.ab === 'all' ? 'All saving throws' : (ABIL_NAME[e.ab] || '') + ' saves') + ' ' + sg(int(e.n, -10, 10));
      case 'saveProf': return 'Proficient in ' + (ABIL_NAME[e.ab] || '') + ' saves';
      case 'skillProf': return 'Proficient in ' + String(e.sk || '').replace(/-/g, ' ');
      case 'resource': return String(e.name || 'Uses') + ': ' + (e.max === 'pb' ? 'proficiency bonus' : ABILS.includes(e.max) ? ABIL_SHORT[e.max] + ' modifier (min 1)' : int(e.max, 1, 99)) + ' per ' + (e.reset === 'short' ? 'short rest' : 'long rest');
      case 'crit': return 'Critical hit on ' + int(e.min, 15, 20) + '–20';
    }
    return '';
  }

  /* ------------------------------- homebrew classes, spells, monsters */
  // Turn homebrew docs (shared data: check everything) into the same shapes as the SRD data.
  const SCHOOLS = ['Abjuration', 'Conjuration', 'Divination', 'Enchantment', 'Evocation', 'Illusion', 'Necromancy', 'Transmutation'];
  const SIZES = ['Tiny', 'Small', 'Medium', 'Large', 'Huge', 'Gargantuan'];
  const SHAPES = ['circle', 'cone', 'cube', 'line'];
  const CR_LIST = [0, 0.125, 0.25, 0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30];
  const CR_XP = [10, 25, 50, 100, 200, 450, 700, 1100, 1800, 2300, 2900, 3900, 5000, 5900, 7200, 8400, 10000, 11500, 13000, 15000, 18000, 20000, 22000, 25000, 33000, 41000, 50000, 62000, 75000, 90000, 105000, 120000, 135000, 155000];
  const txt = (v, n) => String(v == null ? '' : v).slice(0, n || 200);
  const titleWord = (w) => String(w || '').replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
  // a dice expression, optionally with MOD (spellcasting modifier); '' if it isn't one
  function cleanSpellDice(src) {
    const v = String(src || '').replace(/\s+/g, '');
    if (!v || v.length > 40 || !parseDice(v.replace(/MOD/gi, '0'))) return '';
    return v.replace(/mod/gi, 'MOD');
  }
  // multiply every dice count and number in an expression by k (2d6+1 x2 -> 4d6+2)
  function scaleExpr(expr, k) {
    const t = parseDice(expr);
    if (!t || k <= 0) return '';
    return termsToExpr(t.map((x) => (x.value !== undefined ? Object.assign({}, x, { value: x.value * k }) : Object.assign({}, x, { count: Math.min(100, x.count * k), keep: null }))));
  }
  function featureLevels(features, prefix) {
    const out = {};
    (Array.isArray(features) ? features : []).slice(0, 40).forEach((ft, k) => {
      const l = String(int(ft && ft.lvl, 1, 20));
      (out[l] = out[l] || []).push(prefix + '-' + k);
    });
    return out;
  }
  function homebrewClass(f, R) {
    if (!f || !R || !R.classes.wizard) return null;
    const castType = ['full', 'half', 'third', 'pact'].includes(f.cast) ? f.cast : 'none';
    const tableOf = (id) => R.classes[id].levels;
    const zero = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const slotsAt = (l) => {
      if (castType === 'full') return tableOf('wizard')[l - 1].slots.slice();
      if (castType === 'half') return (tableOf('paladin')[l - 1].slots || zero).slice();
      if (castType === 'pact') return tableOf('warlock')[l - 1].slots.slice();
      if (castType === 'third') return Math.floor(l / 3) > 0 ? tableOf('wizard')[Math.floor(l / 3) - 1].slots.slice() : zero.slice();
      return zero.slice();
    };
    const feats = featureLevels(f.features, 'hb-' + f.id);
    const weapons = Object.keys(R.weapons).filter((k) => (f.weapons === 'martial' ? true : f.weapons === 'simple' ? R.weapons[k].cat === 'Simple' : false));
    const saves = (Array.isArray(f.saves) ? f.saves : []).filter((a) => ABILS.includes(a)).slice(0, 2);
    const levels = [];
    for (let l = 1; l <= 20; l++) {
      levels.push({ lvl: l, pb: proficiencyBonus(l), asi: [4, 8, 12, 16, 19].filter((x) => x <= l).length, feats: feats[String(l)] || [], slots: slotsAt(l), cantrips: castType === 'none' ? 0 : int(f.cantrips, 0, 10), cs: {} });
    }
    return {
      n: txt(f.name, 60) || 'Homebrew class', hd: [6, 8, 10, 12].includes(Number(f.hd)) ? Number(f.hd) : 8, saves,
      skills: { choose: int(f.skillsChoose, 0, 6), from: (Array.isArray(f.skills) ? f.skills : []).filter((k) => R.skills[k]) },
      weapons, armor: (Array.isArray(f.armor) ? f.armor : []).filter((a) => ['Light', 'Medium', 'Heavy', 'Shield'].includes(a)),
      cast: castType === 'none' ? null : ABILS.includes(f.castAb) ? f.castAb : 'int', castType, pact: castType === 'pact',
      spellList: f.spellList && f.spellList !== 'own' ? String(f.spellList) : null, subStart: int(f.subLevel || 3, 1, 20), subFlavor: txt(f.subName, 40) || 'Subclass',
      levels, subs: [], hb: true, d: txt(f.desc, 3000),
    };
  }
  function spellFromHomebrew(f) {
    const lvl = int(f.lvl, 0, 9);
    const sp = {
      i: 'hb-' + f.id, n: txt(f.name, 60) || 'Homebrew spell', lvl, school: SCHOOLS.includes(f.school) ? f.school : 'Evocation',
      time: txt(f.time, 60) || '1 action', range: txt(f.range, 60) || 'Self', comp: txt(f.comp, 60) || 'V, S', dur: txt(f.dur, 60) || 'Instantaneous',
      cls: (Array.isArray(f.cls) ? f.cls : []).map(String).slice(0, 30), conc: !!f.conc, ritual: !!f.ritual, desc: txt(f.desc, 6000), higher: txt(f.higher, 2000), hb: true,
    };
    if (f.atk === 'melee' || f.atk === 'ranged') sp.atk = f.atk;
    if (ABILS.includes(f.save)) sp.dc = { ability: f.save, success: f.saveOn === 'none' ? 'none' : 'half' };
    const table = (base, up, grows) => {
      const out = {};
      if (lvl === 0) {
        out['1'] = base;
        if (grows) [[5, 2], [11, 3], [17, 4]].forEach(([l, k]) => (out[String(l)] = scaleExpr(base, k) || base));
      } else {
        for (let l = lvl; l <= 9; l++) {
          const extra = up && l > lvl ? scaleExpr(up, l - lvl) : '';
          out[String(l)] = extra ? base + '+' + extra : base;
        }
      }
      return out;
    };
    const dmg = cleanSpellDice(f.dmg);
    const dmgUp = parseDice(String(f.dmgUp || '').replace(/\s+/g, '')) ? String(f.dmgUp).replace(/\s+/g, '') : '';
    if (dmg) {
      sp.dmg = { type: DAMAGE_TYPES.includes(f.dmgType) ? titleWord(f.dmgType) : 'Force' };
      sp.dmg[lvl === 0 ? 'char' : 'slot'] = table(dmg, dmgUp, lvl === 0 && f.grow !== false && !/MOD/.test(dmg));
    }
    const heal = cleanSpellDice(f.heal);
    const healUp = parseDice(String(f.healUp || '').replace(/\s+/g, '')) ? String(f.healUp).replace(/\s+/g, '') : '';
    if (heal) sp.heal = table(heal, healUp, false);
    if (SHAPES.includes(f.area)) {
      sp.area = { shape: f.area, size: int(f.areaSize, 5, 400), kind: f.area === 'circle' ? 'radius' : f.area };
      if (f.area === 'line') sp.area.width = int(f.areaWidth || 5, 5, 60);
      if (f.areaSelf) sp.area.self = true;
    }
    return sp;
  }
  function crValue(v) {
    const n = typeof v === 'string' && v.includes('/') ? Number(v.split('/')[0]) / Number(v.split('/')[1]) : Number(v);
    return CR_LIST.includes(n) ? n : 1;
  }
  function monsterFromHomebrew(f) {
    const cr = crValue(f.cr);
    const ab = (Array.isArray(f.abil) ? f.abil : []).slice(0, 6);
    while (ab.length < 6) ab.push(10);
    const rows = (list) => (Array.isArray(list) ? list : []).slice(0, 20).filter((a) => a && a.n).map((a) => {
      const r = { n: txt(a.n, 60), d: txt(a.d, 2000) };
      if (a.hit !== '' && a.hit != null && Number.isFinite(Number(a.hit))) r.hit = int(a.hit, -5, 30);
      const dm = String(a.dmg || '').replace(/\s+/g, '');
      if (dm && parseDice(dm)) r.dmg = [[dm, DAMAGE_TYPES.includes(a.dmgType) ? titleWord(a.dmgType) : '']];
      if (ABILS.includes(a.save)) r.dc = [a.save, int(a.dc || 10, 1, 40), a.saveOn === 'none' ? 'none' : 'half'];
      if (SHAPES.includes(a.area)) r.area = Object.assign({ shape: a.area, size: int(a.areaSize, 5, 400) }, a.area === 'line' ? { width: 5 } : {}, a.areaSelf ? { self: true } : {});
      return r;
    });
    const saves = {};
    ABILS.forEach((k) => {
      const v = f.saves && f.saves[k];
      if (v !== '' && v != null && Number.isFinite(Number(v))) saves[k] = int(v, -5, 30);
    });
    const hp = int(f.hp, 1, 9999);
    const hd = String(f.hd || '').replace(/\s+/g, '');
    const m = {
      i: 'hb-' + f.id, n: txt(f.name, 60) || 'Homebrew monster', size: SIZES.includes(f.size) ? f.size : 'Medium', type: txt(f.type, 40).toLowerCase() || 'monstrosity',
      align: txt(f.align, 40) || 'unaligned', ac: int(f.ac, 1, 40), acn: txt(f.acn, 60), hp, hd: hd && parseDice(hd) ? hd : String(hp), speed: txt(f.speed, 80) || '30 ft.',
      abil: ab.map((v) => int(v, 1, 30)), cr, xp: CR_XP[CR_LIST.indexOf(cr)], pb: cr < 5 ? 2 : cr < 9 ? 3 : cr < 13 ? 4 : cr < 17 ? 5 : cr < 21 ? 6 : cr < 25 ? 7 : cr < 29 ? 8 : 9,
      senses: txt(f.senses, 120), lang: txt(f.lang, 120), vul: txt(f.vul, 120), res: txt(f.res, 160), imm: txt(f.imm, 160), cimm: txt(f.cimm, 160),
      traits: rows(f.traits), actions: rows(f.actions), legend: rows(f.legend), react: rows(f.react), hb: true,
    };
    if (Object.keys(saves).length) m.saves = saves;
    return m;
  }

  function derive(c, R, feats) {
    const fx = featEffects(feats);
    const toggles = c.fx && typeof c.fx === 'object' ? c.fx : {};
    const fb = { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 };
    fx.forEach((e) => {
      if (e.t === 'ability' && fb[e.ab] !== undefined) fb[e.ab] += int(e.n, -4, 4);
    });
    const cls = R.classes[c.cls] || Object.values(R.classes)[0];
    const level = clamp(parseInt(c.level, 10) || 1, 1, 20);
    const L = cls.levels[level - 1] || {};
    const pb = L.pb || proficiencyBonus(level);
    const race = R.races[c.race] || null;
    const base = Object.assign({ str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, c.base || {});
    const rb = racialBonus(c, R);
    const asi = c.asi || {};
    const scores = {};
    const mods = {};
    for (const ab of ABILS) {
      const before = (parseInt(base[ab], 10) || 10) + rb[ab];
      const add = (parseInt(asi[ab], 10) || 0) + fb[ab];
      scores[ab] = add > 0 ? Math.max(before, Math.min(20, before + add)) : before + add;
      mods[ab] = abMod(scores[ab]);
    }
    const sub = (cls.subs || []).find((s) => s.i === c.subclass && level >= s.start) || null;

    // saves
    const saves = {};
    for (const ab of ABILS) {
      const prof = cls.saves.includes(ab) || fx.some((e) => e.t === 'saveProf' && e.ab === ab);
      saves[ab] = { prof, bonus: mods[ab] + (prof ? pb : 0) + sumOf(fx, 'save', (e) => e.ab === ab || e.ab === 'all') };
    }

    // skills
    const profSet = new Set([...(c.skills || []), ...backgroundSkills(c, R), ...racialSkills(c, R), ...fx.filter((e) => e.t === 'skillProf' && R.skills[e.sk]).map((e) => e.sk)]);
    const expSet = new Set((c.expertise || []).filter((s) => profSet.has(s)).slice(0, expertiseSlots(c)));
    const joat = c.cls === 'bard' && level >= 2 ? Math.floor(pb / 2) : 0;
    const skills = {};
    for (const sk in R.skills) {
      const ab = R.skills[sk].ab;
      const prof = profSet.has(sk);
      const exp = prof && expSet.has(sk);
      skills[sk] = { ab, prof, exp, bonus: mods[ab] + (exp ? pb * 2 : prof ? pb : joat) };
    }
    const passive = 10 + skills.perception.bonus + sumOf(fx, 'passive');

    // armor & AC
    const armor = c.armor && c.armor !== ARMORLESS ? R.armor[c.armor] : null;
    const shield = !!c.shield;
    let ac;
    let acNote = '';
    if (armor) {
      ac = armor.base + (armor.dex ? (armor.max != null ? Math.min(mods.dex, armor.max) : mods.dex) : 0);
      acNote = armor.n;
    } else if (c.cls === 'barbarian') {
      ac = 10 + mods.dex + mods.con;
      acNote = 'Unarmored Defense';
    } else if (c.cls === 'monk' && !shield) {
      ac = 10 + mods.dex + mods.wis;
      acNote = 'Unarmored Defense';
    } else if (sub && sub.i === 'draconic') {
      ac = 13 + mods.dex;
      acNote = 'Draconic Resilience';
    } else {
      ac = 10 + mods.dex;
      acNote = 'No armor';
    }
    if (shield) {
      ac += 2;
      acNote += ', shield';
    }
    ac += (parseInt(c.acBonus, 10) || 0) + sumOf(fx, 'ac');

    // speed
    let speed = race ? race.speed : 30;
    const cs = L.cs || {};
    if (c.cls === 'monk' && !armor && !shield && cs.unarmored_movement) speed += cs.unarmored_movement;
    if (c.cls === 'barbarian' && level >= 5 && !(armor && armor.cat === 'Heavy')) speed += 10;
    speed += (parseInt(c.speedBonus, 10) || 0) + sumOf(fx, 'speed');

    // hit points
    const hd = cls.hd;
    let hpMax;
    if (c.hpMode === 'manual' && parseInt(c.hpManual, 10) > 0) {
      hpMax = parseInt(c.hpManual, 10);
    } else {
      hpMax = hd + mods.con;
      for (let i = 2; i <= level; i++) hpMax += Math.max(1, Math.floor(hd / 2) + 1 + mods.con);
      if (c.subrace === 'hill-dwarf') hpMax += level;
      if (sub && sub.i === 'draconic') hpMax += level;
      hpMax += level * sumOf(fx, 'hpPerLevel');
      hpMax = Math.max(1, hpMax);
    }

    const init = mods.dex + joat + sumOf(fx, 'init');

    // spellcasting
    let cast = null;
    if (cls.cast && L.slots) {
      const ab = cls.cast;
      const slots = L.slots.slice();
      const isPact = c.cls === 'warlock' || !!cls.pact;
      let maxLvl = 0;
      slots.forEach((n, i) => {
        if (n > 0) maxLvl = i + 1;
      });
      let prepared = null;
      if (['cleric', 'druid', 'wizard'].includes(c.cls)) prepared = Math.max(1, mods[ab] + level);
      if (c.cls === 'paladin') prepared = Math.max(1, mods[ab] + Math.floor(level / 2));
      if (cls.hb) prepared = Math.max(1, mods[ab] + (cls.castType === 'full' || cls.castType === 'pact' ? level : Math.floor(level / 2)));
      cast = {
        ab, dc: 8 + pb + mods[ab], atk: pb + mods[ab] + fx.filter((e) => e.t === 'attack' && e.filter === 'spell' && (e.when !== 'toggle' || toggles[e.key])).reduce((n, e) => n + int(e.hit, -20, 20), 0), mod: mods[ab], slots, pact: isPact, maxLvl,
        cantrips: L.cantrips || 0, known: L.known || null, prepared,
      };
    }

    // attacks
    const attacks = [];
    const strM = mods.str;
    const dexM = mods.dex;
    const ma = c.cls === 'monk' && cs.martial_arts ? cs.martial_arts.dice_count + 'd' + cs.martial_arts.dice_value : null;
    const weaponAttack = (w, W, name, src) => {
      const finesse = W.props.includes('finesse');
      const ranged = W.rng === 'Ranged';
      const monkW = !!ma && (w === 'shortsword' || (W.cat === 'Simple' && !ranged && !W.props.includes('heavy') && !W.props.includes('two-handed')));
      let m = ranged ? dexM : finesse || monkW ? Math.max(strM, dexM) : strM;
      const prof = weaponProficient(w, c, R);
      let dice = W.dmg || '1';
      if (monkW && ma) {
        const a = avgExpr(ma);
        const b = avgExpr(dice);
        if (a > b) dice = ma;
      }
      const at = { id: src ? 'item-' + src : w, n: name || W.n, src: src || null, hit: m + (prof ? pb : 0), dmg: dice + exprMod(m), ty: W.ty, prof, tags: [ranged ? 'ranged' : 'melee', ...W.props.filter((p) => ['heavy', 'finesse', 'light', 'thrown'].includes(p))] };
      if (W.vers) at.vers = W.vers + exprMod(m);
      if (W.range) at.range = W.range.filter(Boolean).join('/') + ' ft';
      else if (W.thrown) at.range = 'thrown ' + W.thrown.filter(Boolean).join('/') + ' ft';
      else at.range = W.props.includes('reach') ? 'reach 10 ft' : 'reach 5 ft';
      return at;
    };
    for (const w of c.weapons || []) if (R.weapons[w]) attacks.push(weaponAttack(w, R.weapons[w]));
    // an equipped magic item can be a weapon of its own
    (feats || []).forEach((f) => {
      if (f && f.kind === 'item' && R.weapons[f.weapon]) attacks.push(weaponAttack(f.weapon, R.weapons[f.weapon], String(f.name || R.weapons[f.weapon].n).slice(0, 60), String(f.id)));
    });
    const unarmedM = ma ? Math.max(strM, dexM) : strM;
    attacks.push({ id: 'unarmed', n: 'Unarmed Strike', hit: unarmedM + pb, dmg: ma ? ma + exprMod(unarmedM) : String(Math.max(1, 1 + unarmedM)), ty: 'Bludgeoning', prof: true, range: 'reach 5 ft', tags: ['melee', 'unarmed'] });

    // homebrew attack effects: always-on ones change the numbers, toggles only while switched on
    const atkFx = fx.filter((e) => e.t === 'attack').map((e) => ({
      key: e.key, feat: e.feat, src: e.src, filter: ATTACK_FILTERS.includes(e.filter) ? e.filter : 'any', toggle: e.when === 'toggle',
      hit: int(e.hit, -20, 20), dmg: cleanDmg(e.dmg), dmgType: DAMAGE_TYPES.includes(e.dmgType) ? e.dmgType : '', text: describeEffect(e),
    }));
    atkFx.forEach((m) => (m.on = !m.toggle || !!toggles[m.key]));
    attacks.forEach((at) => {
      at.baseHit = at.hit;
      at.extra = [];
      at.using = [];
      atkFx.forEach((m) => {
        if (!m.on || m.filter === 'spell') return;
        if (m.filter === 'item' ? at.src !== m.src : m.filter !== 'any' && !at.tags.includes(m.filter)) return;
        at.hit += m.hit;
        if (m.dmg && m.dmgType) at.extra.push([m.dmg.replace(/^\+/, ''), m.dmgType]);
        else if (m.dmg) at.dmg += m.dmg;
        if (m.toggle && !at.using.includes(m.feat)) at.using.push(m.feat);
      });
    });
    const critMin = Math.min(20, ...fx.filter((e) => e.t === 'crit').map((e) => int(e.min, 15, 20)));

    // dragonborn breath weapon
    let breath = null;
    if (c.race === 'dragonborn' && c.ancestry && R.traits[c.ancestry] && R.traits[c.ancestry].breath) {
      const b = R.traits[c.ancestry].breath;
      const dice = level >= 16 ? '5d6' : level >= 11 ? '4d6' : level >= 6 ? '3d6' : '2d6';
      const shape = b.shape === 'line' ? 'line' : 'cone';
      breath = { dmg: dice, ty: b.type, dc: 8 + mods.con + pb, save: b.save || 'dex', area: shape === 'line' ? { shape, size: 30, width: 5, self: true } : { shape, size: 15, self: true } };
    }

    // features
    const features = [];
    for (let i = 0; i < level; i++) {
      for (const f of cls.levels[i].feats || []) features.push({ id: f, lvl: i + 1, src: cls.n });
    }
    if (sub) {
      for (const lv in sub.levels) if (parseInt(lv, 10) <= level) sub.levels[lv].forEach((f) => features.push({ id: f, lvl: parseInt(lv, 10), src: sub.n }));
    }
    features.sort((a, b) => a.lvl - b.lvl);
    const traits = raceTraitIds(c, R);

    // resources
    const resources = [];
    const add = (key, n, max) => max > 0 && resources.push({ key, n, max });
    if (c.cls === 'barbarian') add('rage', 'Rage', cs.rage_count === 9999 ? 99 : cs.rage_count || 0);
    if (c.cls === 'monk' && level >= 2) add('ki', 'Ki points', cs.ki_points || 0);
    if (c.cls === 'sorcerer' && level >= 2) add('sorcery', 'Sorcery points', cs.sorcery_points || 0);
    if (c.cls === 'cleric' && level >= 2) add('channel', 'Channel Divinity', cs.channel_divinity_charges || 0);
    if (c.cls === 'paladin' && level >= 3) add('channel', 'Channel Divinity', 1);
    if (c.cls === 'fighter') {
      add('second-wind', 'Second Wind', 1);
      if (level >= 2) add('surge', 'Action Surge', cs.action_surges || 1);
      if (level >= 9) add('indomitable', 'Indomitable', cs.indomitable_uses || 1);
    }
    if (c.cls === 'bard') add('inspiration', 'Bardic Inspiration (' + (cs.bardic_inspiration_die ? 'd' + cs.bardic_inspiration_die : 'd6') + ')', Math.max(1, mods.cha));
    if (c.cls === 'paladin') {
      add('lay-on-hands', 'Lay on Hands (HP pool)', 5 * level);
      add('divine-sense', 'Divine Sense', 1 + Math.max(0, mods.cha));
    }
    if (c.cls === 'druid' && level >= 2) add('wild-shape', 'Wild Shape', 2);
    if (c.cls === 'wizard') add('arcane-recovery', 'Arcane Recovery', 1);
    if (breath) add('breath', 'Breath Weapon', 1);
    for (const r of c.customRes || []) if (r && r.n) resources.push({ key: 'c:' + r.id, n: r.n, max: clamp(parseInt(r.max, 10) || 1, 1, 999), custom: true });
    fx.filter((e) => e.t === 'resource').forEach((e) => {
      const max = e.max === 'pb' ? pb : ABILS.includes(e.max) ? Math.max(1, mods[e.max]) : int(e.max, 1, 99);
      resources.push({ key: 'h:' + e.key, n: String(e.name || e.feat).slice(0, 40), max, reset: e.reset === 'short' ? 'short' : 'long', feat: e.feat });
    });

    const classSpecific = [];
    if (cs.sneak_attack) classSpecific.push(['Sneak Attack', cs.sneak_attack.dice_count + 'd' + cs.sneak_attack.dice_value]);
    if (ma) classSpecific.push(['Martial Arts', ma]);
    if (cs.rage_damage_bonus) classSpecific.push(['Rage damage', '+' + cs.rage_damage_bonus]);
    if (cs.brutal_critical_dice) classSpecific.push(['Brutal Critical', '+' + cs.brutal_critical_dice + ' die']);
    if (cs.extra_attacks) classSpecific.push(['Attacks per action', String(1 + cs.extra_attacks)]);
    if (cs.wild_shape_max_cr !== undefined && level >= 2) classSpecific.push(['Wild Shape max CR', crLabel(cs.wild_shape_max_cr)]);
    if (cs.invocations_known) classSpecific.push(['Invocations known', String(cs.invocations_known)]);
    if (cs.metamagic_known) classSpecific.push(['Metamagic known', String(cs.metamagic_known)]);
    if (cs.destroy_undead_cr) classSpecific.push(['Destroy Undead CR', crLabel(cs.destroy_undead_cr)]);
    if (cs.aura_range) classSpecific.push(['Aura range', cs.aura_range + ' ft']);
    if (cs.favored_enemies) classSpecific.push(['Favored enemies', String(cs.favored_enemies)]);

    return {
      level, pb, scores, mods, saves, skills, passive, init, speed, hpMax, ac, acNote, cast, attacks, breath,
      features, traits, resources, classSpecific, hitDice: level + 'd' + hd, hd, sub, cls, race, joat,
      expertiseSlots: expertiseSlots(c), asiPoints: asiPoints(c, R), racial: rb,
      critMin, toggles: atkFx.filter((m) => m.toggle), feats: (feats || []).filter(Boolean),
    };
  }

  /* ---------------------------------------------------- encounter math */
  const XP_THRESH = {
    1: [25, 50, 75, 100], 2: [50, 100, 150, 200], 3: [75, 150, 225, 400], 4: [125, 250, 375, 500],
    5: [250, 500, 750, 1100], 6: [300, 600, 900, 1400], 7: [350, 750, 1100, 1700], 8: [450, 900, 1400, 2100],
    9: [550, 1100, 1600, 2400], 10: [600, 1200, 1900, 2800], 11: [800, 1600, 2400, 3600], 12: [1000, 2000, 3000, 4500],
    13: [1100, 2200, 3400, 5100], 14: [1250, 2500, 3800, 5700], 15: [1400, 2800, 4300, 6400], 16: [1600, 3200, 4800, 7200],
    17: [2000, 3900, 5900, 8800], 18: [2100, 4200, 6300, 9500], 19: [2400, 4900, 7300, 10900], 20: [2800, 5700, 8500, 12700],
  };
  const MULTS = [0.5, 1, 1.5, 2, 2.5, 3, 4, 5];
  const DIFF = ['Easy', 'Medium', 'Hard', 'Deadly'];

  function encounterMultiplier(monsterCount, partySize) {
    if (monsterCount <= 0) return 0;
    let i = monsterCount === 1 ? 1 : monsterCount === 2 ? 2 : monsterCount <= 6 ? 3 : monsterCount <= 10 ? 4 : monsterCount <= 14 ? 5 : 6;
    if (partySize > 0 && partySize < 3) i += 1;
    else if (partySize >= 6) i -= 1;
    return MULTS[clamp(i, 0, MULTS.length - 1)];
  }

  // party: array of levels; group: [{xp, count}]
  function encounter(party, group) {
    const th = [0, 0, 0, 0];
    party.forEach((lv) => {
      const t = XP_THRESH[clamp(lv, 1, 20)];
      for (let i = 0; i < 4; i++) th[i] += t[i];
    });
    let count = 0;
    let xp = 0;
    group.forEach((g) => {
      count += g.count;
      xp += g.xp * g.count;
    });
    const mult = encounterMultiplier(count, party.length);
    const adjusted = Math.round(xp * mult);
    let level = -1;
    for (let i = 0; i < 4; i++) if (adjusted >= th[i] && th[i] > 0) level = i;
    const label = count === 0 ? 'Empty' : level < 0 ? 'Trivial' : DIFF[level];
    return { thresholds: th, count, xp, mult, adjusted, level, label, perPlayer: party.length ? Math.floor(xp / party.length) : 0 };
  }

  function crLabel(cr) {
    if (cr === 0.125) return '1/8';
    if (cr === 0.25) return '1/4';
    if (cr === 0.5) return '1/2';
    return String(cr);
  }

  /* ---------------------------------------------------- grid geometry */
  // template t: {shape, x, y, size(ft), width(ft), angle(rad)} in map px; grid g: {size, ox, oy}
  const CONE_HALF = Math.atan(0.5);

  function inTemplate(t, px, py, g) {
    const L = (t.size / 5) * g;
    const dx = px - t.x;
    const dy = py - t.y;
    switch (t.shape) {
      case 'circle':
        return dx * dx + dy * dy <= L * L + 1e-6;
      case 'cube':
        return px >= t.x - 1e-6 && px <= t.x + L + 1e-6 && py >= t.y - 1e-6 && py <= t.y + L + 1e-6;
      case 'cone': {
        const ux = Math.cos(t.angle || 0);
        const uy = Math.sin(t.angle || 0);
        const along = dx * ux + dy * uy;
        if (along <= 0 || along > L + 1e-6) return false;
        return Math.abs(dx * uy - dy * ux) <= along / 2 + 1e-6;
      }
      case 'line': {
        const W = ((t.width || 5) / 5) * g;
        const ux = Math.cos(t.angle || 0);
        const uy = Math.sin(t.angle || 0);
        const along = dx * ux + dy * uy;
        if (along < 0 || along > L + 1e-6) return false;
        return Math.abs(dx * uy - dy * ux) <= W / 2 + 1e-6;
      }
    }
    return false;
  }

  function templateCorners(t, g) {
    const L = (t.size / 5) * g;
    const a = t.angle || 0;
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    if (t.shape === 'circle') return [[t.x - L, t.y - L], [t.x + L, t.y + L]];
    if (t.shape === 'cube') return [[t.x, t.y], [t.x + L, t.y + L]];
    const half = t.shape === 'cone' ? L / 2 : (((t.width || 5) / 5) * g) / 2;
    const ex = t.x + ux * L;
    const ey = t.y + uy * L;
    if (t.shape === 'cone') return [[t.x, t.y], [ex - uy * half, ey + ux * half], [ex + uy * half, ey - ux * half]];
    return [[t.x - uy * half, t.y + ux * half], [t.x + uy * half, t.y - ux * half], [ex - uy * half, ey + ux * half], [ex + uy * half, ey - ux * half]];
  }

  function templateBBox(t, g) {
    const pts = templateCorners(t, g);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    pts.forEach(([x, y]) => {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    });
    return [x0, y0, x1, y1];
  }

  // Squares at least half covered by the area (DMG grid rule)
  function templateCells(t, grid) {
    const g = grid.size;
    const ox = grid.ox || 0;
    const oy = grid.oy || 0;
    const [x0, y0, x1, y1] = templateBBox(t, g);
    const c0 = Math.floor((x0 - ox) / g) - 1;
    const c1 = Math.floor((x1 - ox) / g) + 1;
    const r0 = Math.floor((y0 - oy) / g) - 1;
    const r1 = Math.floor((y1 - oy) / g) + 1;
    const N = 4;
    const cells = [];
    if ((c1 - c0) * (r1 - r0) > 60000) return cells;
    for (let c = c0; c <= c1; c++) {
      for (let r = r0; r <= r1; r++) {
        let n = 0;
        for (let i = 0; i < N; i++) {
          for (let j = 0; j < N; j++) {
            const px = ox + (c + (i + 0.5) / N) * g;
            const py = oy + (r + (j + 0.5) / N) * g;
            if (inTemplate(t, px, py, g)) n++;
          }
        }
        if (n >= (N * N) / 2) cells.push([c, r]);
      }
    }
    return cells;
  }

  function tokenCells(tok) {
    const s = Math.max(1, Math.round(tok.size || 1));
    const out = [];
    for (let i = 0; i < s; i++) for (let j = 0; j < s; j++) out.push([(tok.c || 0) + i, (tok.r || 0) + j]);
    return out;
  }

  function cellsHit(cells, tok) {
    const set = new Set(cells.map(([c, r]) => c + ',' + r));
    return tokenCells(tok).some(([c, r]) => set.has(c + ',' + r));
  }

  function distanceFt(dc, dr, rule) {
    const a = Math.abs(dc);
    const b = Math.abs(dr);
    const mx = Math.max(a, b);
    const mn = Math.min(a, b);
    if (rule === '5-10') return 5 * (mx + Math.floor(mn / 2));
    return 5 * mx;
  }

  // Edge of a square token (side s px, centered at cx,cy) in direction angle a
  function edgePoint(cx, cy, s, a) {
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    const k = s / 2 / Math.max(Math.abs(ux), Math.abs(uy), 1e-6);
    return [cx + ux * k, cy + uy * k];
  }

  return {
    ABILS, ABIL_NAME, ABIL_SHORT, SIZE_CELLS, STANDARD_ARRAY, POINT_COST, XP_THRESH, MINUS,
    clamp, abMod, fmtMod, exprMod, parseDice, termsToExpr, roll, d20Expr, critExpr, avgExpr, cleanExpr,
    proficiencyBonus, racialBonus, asiPoints, pointBuyCost, weaponProficient, racialSkills, backgroundSkills,
    expertiseSlots, derive, encounter, encounterMultiplier, crLabel, inTemplate, templateCorners, templateBBox,
    templateCells, tokenCells, cellsHit, distanceFt, edgePoint, CONE_HALF,
    EFFECT_TYPES, ATTACK_FILTERS, DAMAGE_TYPES, featEffects, describeEffect, cleanDmg,
    SCHOOLS, SIZES, SHAPES, CR_LIST, CR_XP, scaleExpr, featureLevels, homebrewClass, spellFromHomebrew, monsterFromHomebrew, crValue,
    _setRng: (f) => { rng = f; },
  };
})();
if (typeof module !== 'undefined') module.exports = Core;
