// Node unit tests for core.js (dice, character math, encounter math, geometry)
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const dir = process.argv[2] || path.join(__dirname, '..');
global.crypto = require('crypto').webcrypto;
const Core = require(path.join(dir, 'src/core.js'));
const R = JSON.parse(fs.readFileSync(path.join(dir, 'data/rules.json'), 'utf8'));
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };

// ---- dice parsing
eq(Core.termsToExpr(Core.parseDice('2d6+3')), '2d6+3');
eq(Core.termsToExpr(Core.parseDice('d20')), '1d20');
eq(Core.termsToExpr(Core.parseDice('4d6dl1')), '4d6kh3');
eq(Core.termsToExpr(Core.parseDice('2d20kl1 - 2')), '2d20kl1-2');
eq(Core.termsToExpr(Core.parseDice('1d8 + 1d6 + 2')), '1d8+1d6+2');
eq(Core.termsToExpr(Core.parseDice('d%')), '1d100');
eq(Core.parseDice('2d6 3'), null, 'missing operator');
eq(Core.parseDice('hello'), null);
eq(Core.parseDice(''), null);
eq(Core.parseDice('1000d6'), null);
eq(Core.parseDice('+'), null);
eq(Core.parseDice('2d6+'), null);
eq(Core.termsToExpr(Core.parseDice('-1+1d4')), '-1+1d4');
// rolling with fixed rng
let seq = [];
Core._setRng((s) => seq.shift());
seq = [17, 4];
let r = Core.roll('2d20kh1+5');
eq(r.t, 22); eq(r.nat, 17); eq(r.p[0].x, [1]);
seq = [3, 19];
r = Core.roll('2d20kl1');
eq(r.t, 3); eq(r.nat, 3);
seq = [6, 1, 4, 3];
r = Core.roll('4d6kh3');
eq(r.t, 13); eq(r.p[0].x, [1]);
seq = [20];
r = Core.roll(Core.d20Expr(7, 'normal'));
eq(r.e, '1d20+7'); eq(r.nat, 20); eq(r.t, 27);
eq(Core.critExpr('2d6+3'), '4d6+3');
eq(Core.critExpr('1d8+1d6-1'), '2d8+2d6-1');
eq(Core.avgExpr('7d10+21'), 59);
eq(Core.avgExpr('2d6'), 7);
eq(Core.cleanExpr('1d8 + MOD', 3), '1d8+3');
eq(Core.cleanExpr('1d8 + MOD', -1), '1d8-1');
eq(Core.cleanExpr('1d4 + 4', 2), '1d4+4');
Core._setRng(null);
for (let i = 0; i < 200; i++) { const x = Core.roll('1d6').t; ok(x >= 1 && x <= 6); }

// ---- encounter
let e = Core.encounter([3, 3, 3, 3], [{ xp: 50, count: 6 }]);
eq(e.thresholds, [300, 600, 900, 1600]); eq(e.xp, 300); eq(e.mult, 2); eq(e.adjusted, 600); eq(e.label, 'Medium');
e = Core.encounter([1, 1], [{ xp: 200, count: 1 }]);
eq(e.mult, 1.5); eq(e.adjusted, 300); eq(e.label, 'Deadly');
e = Core.encounter([5, 5, 5, 5, 5, 5], [{ xp: 1800, count: 1 }]);
eq(e.mult, 0.5); eq(e.adjusted, 900); eq(e.label, 'Trivial');
e = Core.encounter([5, 5, 5, 5], []);
eq(e.label, 'Empty');
eq(Core.encounterMultiplier(15, 4), 4);
eq(Core.encounterMultiplier(15, 2), 5);

// ---- geometry: fireball, 20 ft radius at a grid intersection, 50px squares
const grid = { size: 50, ox: 0, oy: 0 };
let cells = Core.templateCells({ shape: 'circle', x: 500, y: 500, size: 20 }, grid);
ok(cells.length >= 44 && cells.length <= 52, 'fireball cells ' + cells.length);
const has = (cs, c, r) => cs.some(([a, b]) => a === c && b === r);
ok(has(cells, 9, 9) && has(cells, 10, 10) && has(cells, 6, 9) && has(cells, 13, 10), 'fireball covers axis');
ok(!has(cells, 6, 6) && !has(cells, 13, 13), 'fireball corners excluded');
// cube 15 ft at intersection
cells = Core.templateCells({ shape: 'cube', x: 100, y: 100, size: 15 }, grid);
eq(cells.length, 9);
// line 30x5 pointing right from intersection
cells = Core.templateCells({ shape: 'line', x: 100, y: 125, size: 30, width: 5, angle: 0 }, grid);
eq(cells.length, 6, 'line cells');
// cone 15 ft pointing right from an intersection: classic 15-ft cone ≈ 6-9 squares
cells = Core.templateCells({ shape: 'cone', x: 100, y: 100, size: 15, angle: 0 }, grid);
eq(cells.length, 4, 'cone from intersection');
ok(cells.every(([c]) => c >= 2), 'cone not behind origin');
// from the edge midpoint of a medium token: 1 + 1 + 3 squares
cells = Core.templateCells({ shape: 'cone', x: 100, y: 125, size: 15, angle: 0 }, grid);
eq(cells.length, 5, 'cone from token edge');
// diagonal cone from a corner
cells = Core.templateCells({ shape: 'cone', x: 100, y: 100, size: 15, angle: Math.PI / 4 }, grid);
ok(cells.length >= 4 && cells.length <= 7, 'diagonal cone ' + cells.length);
ok(Core.cellsHit([[3, 4]], { c: 2, r: 3, size: 2 }));
ok(!Core.cellsHit([[5, 5]], { c: 2, r: 3, size: 2 }));
eq(Core.distanceFt(3, 4, '5'), 20);
eq(Core.distanceFt(3, 4, '5-10'), 25);
eq(Core.edgePoint(0, 0, 50, 0), [25, 0]);

// ---- character derivation
const fighter = { cls: 'fighter', level: 5, race: 'dwarf', subrace: 'hill-dwarf', base: { str: 15, dex: 12, con: 14, int: 8, wis: 13, cha: 10 }, asi: { str: 2 }, skills: ['athletics', 'perception'], background: 'acolyte', armor: 'chain-mail', shield: true, weapons: ['battleaxe', 'longbow'] };
let d = Core.derive(fighter, R);
eq(d.scores.str, 17); eq(d.scores.con, 16); eq(d.scores.wis, 14); eq(d.pb, 3);
eq(d.ac, 18, 'chain mail + shield');
// HP: 10+3 + 4*(6+3) + 5 (hill dwarf) = 13+36+5 = 54
eq(d.hpMax, 54);
eq(d.speed, 25);
eq(d.skills.athletics.bonus, 6); eq(d.skills.insight.prof, true); eq(d.saves.con.bonus, 6);
const axe = d.attacks.find((a) => a.id === 'battleaxe');
eq(axe.hit, 6); eq(axe.dmg, '1d8+3'); eq(axe.vers, '1d10+3');
const bow = d.attacks.find((a) => a.id === 'longbow');
eq(bow.hit, 4); eq(bow.dmg, '1d8+1');
ok(d.features.some((f) => f.id === 'action-surge-1-use') || d.features.length > 3, 'features');
eq(d.cast, null);

const wiz = { cls: 'wizard', level: 3, race: 'elf', subrace: 'high-elf', base: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 }, skills: ['arcana', 'history'], background: 'custom', bgSkills: ['investigation', 'religion'], weapons: ['dagger', 'longsword'] };
d = Core.derive(wiz, R);
eq(d.scores.int, 16); eq(d.scores.dex, 16); eq(d.cast.dc, 13); eq(d.cast.atk, 5); eq(d.cast.slots.slice(0, 2), [4, 2]); eq(d.cast.maxLvl, 2);
eq(d.cast.prepared, 6); eq(d.cast.cantrips, 3);
eq(d.skills.perception.prof, true, 'keen senses');
eq(d.attacks.find((a) => a.id === 'longsword').hit, -1 + 2, 'elf weapon training'); eq(d.attacks.find((a) => a.id === 'longsword').prof, true);
eq(d.attacks.find((a) => a.id === 'dagger').hit, 3 + 2, 'finesse uses dex');
eq(d.ac, 13);
eq(d.hpMax, 6 + 1 + 2 * (4 + 1));

const monk = { cls: 'monk', level: 5, race: 'human', base: { str: 10, dex: 15, con: 13, int: 8, wis: 14, cha: 12 }, weapons: ['quarterstaff', 'shortsword'] };
d = Core.derive(monk, R);
eq(d.ac, 10 + 3 + 2, 'monk unarmored');
eq(d.speed, 40);
const staff = d.attacks.find((a) => a.id === 'quarterstaff');
eq(staff.hit, 3 + 3); eq(staff.dmg, '1d6+3');
ok(d.resources.some((x) => x.key === 'ki' && x.max === 5));
const unarmed = d.attacks.find((a) => a.id === 'unarmed');
eq(unarmed.dmg, '1d6+3');

const bard = { cls: 'bard', level: 3, race: 'half-elf', raceChoice: ['dex', 'con'], raceSkills: ['stealth', 'insight'], base: { str: 8, dex: 14, con: 12, int: 10, wis: 10, cha: 15 }, skills: ['persuasion', 'deception', 'performance'], expertise: ['persuasion', 'stealth'] };
d = Core.derive(bard, R);
eq(d.scores.cha, 17); eq(d.scores.dex, 15); eq(d.scores.con, 13);
eq(d.skills.persuasion.bonus, 3 + 4); eq(d.skills.stealth.bonus, 2 + 4); eq(d.skills.athletics.bonus, -1 + 1, 'jack of all trades');
eq(d.init, 2 + 1);
const db = { cls: 'sorcerer', level: 6, subclass: 'draconic', race: 'dragonborn', ancestry: 'draconic-ancestry-red', base: { str: 10, dex: 14, con: 14, int: 8, wis: 10, cha: 15 } };
d = Core.derive(db, R);
eq(d.ac, 13 + 2, 'draconic resilience');
eq(d.breath.dmg, '3d6'); eq(d.breath.dc, 8 + 2 + 3); eq(d.breath.area.shape, 'cone');
eq(d.hpMax, 6 + 2 + 5 * (4 + 2) + 6);
const war = { cls: 'warlock', level: 5, race: 'tiefling', base: { str: 8, dex: 14, con: 14, int: 12, wis: 10, cha: 15 } };
d = Core.derive(war, R);
eq(d.cast.pact, true); eq(d.cast.maxLvl, 3); eq(d.cast.slots[2], 2); eq(d.cast.known, 6);
eq(Core.pointBuyCost({ str: 15, dex: 15, con: 15, int: 8, wis: 8, cha: 8 }), 27);
eq(Core.pointBuyCost({ str: 16, dex: 8, con: 8, int: 8, wis: 8, cha: 8 }), null);

// ---- homebrew feat effects (made-up test feats)
const archer = { cls: 'fighter', level: 5, race: 'human', base: { str: 10, dex: 16, con: 14, int: 10, wis: 12, cha: 8 }, weapons: ['longbow', 'longsword'] };
const trade = { id: 'f1', name: 'Steady Draw', effects: [{ t: 'attack', when: 'toggle', filter: 'ranged', hit: -3, dmg: '6' }] };
const kit = { id: 'f2', name: 'Grab Bag', effects: [
  { t: 'ability', ab: 'dex', n: 1 }, { t: 'ac', n: 1 }, { t: 'speed', n: 5 }, { t: 'init', n: 2 }, { t: 'hpPerLevel', n: 1 },
  { t: 'saveProf', ab: 'wis' }, { t: 'skillProf', sk: 'stealth' }, { t: 'resource', name: 'Lucky break', max: 'pb', reset: 'short' },
  { t: 'crit', min: 19 }, { t: 'attack', filter: 'melee', dmg: '1d4', dmgType: 'fire' }, { t: 'bogus', n: 99 }] };
let base0 = Core.derive(archer, R);
let hbBow = (d) => d.attacks.find((a) => a.id === 'longbow');
let hbSword = (d) => d.attacks.find((a) => a.id === 'longsword');
d = Core.derive(archer, R, [trade]);
eq(hbBow(d).hit, hbBow(base0).hit, 'toggle off: no change');
eq(d.toggles.length, 1); eq(d.toggles[0].key, 'f1_0'); eq(d.toggles[0].on, false);
d = Core.derive(Object.assign({}, archer, { fx: { f1_0: 1 } }), R, [trade]);
eq(hbBow(d).hit, hbBow(base0).hit - 3, 'toggle on: to hit');
eq(hbBow(d).dmg, hbBow(base0).dmg + '+6', 'toggle on: damage');
eq(hbBow(d).using, ['Steady Draw']);
eq(hbSword(d).hit, hbSword(base0).hit, 'ranged-only effect leaves melee alone');
d = Core.derive(archer, R, [kit]);
eq(d.scores.dex, 18, 'human +1 and feat +1'); eq(d.mods.dex, 4);
eq(d.ac, base0.ac + 1 + 1, '+1 from the dex mod, +1 from the feat');
eq(d.speed, base0.speed + 5); eq(d.init, base0.init + 1 + 2, 'dex mod +1, feat +2');
eq(d.hpMax, base0.hpMax + 5);
eq(d.saves.wis.prof, true); eq(d.saves.wis.bonus, 1 + 3);
eq(d.skills.stealth.prof, true);
eq(d.resources.find((r) => r.key === 'h:f2_7').max, 3); eq(d.resources.find((r) => r.key === 'h:f2_7').reset, 'short');
eq(d.critMin, 19);
eq(hbSword(d).extra, [['1d4', 'fire']]); eq(hbBow(d).extra, []);
d = Core.derive(Object.assign({}, archer, { base: Object.assign({}, archer.base, { dex: 19 }) }), R, [kit, kit]);
eq(d.scores.dex, 20, 'ability boost stops at 20');
d = Core.derive(archer, R, [{ id: 'x', name: 'Junk', effects: [{ t: 'attack', hit: 'abc', dmg: '<b>1d4</b>' }, { t: 'ac', n: 1e9 }] }]);
eq(hbBow(d).hit, hbBow(base0).hit, 'bad numbers ignored'); eq(hbBow(d).dmg, hbBow(base0).dmg, 'bad dice ignored'); eq(d.ac, base0.ac + 10, 'clamped');
eq(Core.describeEffect(trade.effects[0]), '−3 to hit, +6 damage on ranged attacks, when switched on');
console.log('core tests passed:', n);
