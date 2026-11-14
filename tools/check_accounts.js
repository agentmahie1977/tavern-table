#!/usr/bin/env node
/* Browser check for accounts mode: two people at a server started with --accounts.
   Run: node tools/check_accounts.js   (needs Playwright for Node: require('playwright')) */
'use strict';
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const results = [];
const step = async (name, fn) => {
  try {
    const v = await fn();
    results.push(['ok', name, v === undefined ? '' : JSON.stringify(v).slice(0, 160)]);
  } catch (e) {
    results.push(['FAIL', name, String(e.message || e).split('\n')[0].slice(0, 220)]);
  }
};
const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => res(p));
  });
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const PORT = await freePort();
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-acct-'));
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--accounts', '--port', String(PORT), '--data', DATA], { stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stderr.on('data', (d) => process.stderr.write('server: ' + d));
  await new Promise((res) => srv.stdout.on('data', (d) => String(d).includes('running') && res()));
  const URL = `http://localhost:${PORT}/`;
  const browser = await chromium.launch();
  const open = async (label) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 780 } });
    const p = await ctx.newPage();
    p.errs = [];
    p.label = label;
    p.on('pageerror', (e) => p.errs.push(String(e)));
    await p.goto(URL, { waitUntil: 'domcontentloaded' });
    return p;
  };
  const register = async (p, name, pw, switchToCreate) => {
    await p.waitForSelector('#signin #siName', { timeout: 15000 });
    if (switchToCreate) await p.click('#signin [data-m=create]');
    await p.fill('#siName', name);
    await p.fill('#siPass', pw);
    await p.fill('#siPass2', pw);
    await p.click('#siGo');
    await p.waitForFunction('Store.S.loaded && Store.S.server && Store.S.accountsMode', null, { timeout: 15000 });
  };
  const signIn = async (p, name, pw) => {
    await p.waitForSelector('#signin #siName', { timeout: 15000 });
    await p.fill('#siName', name);
    await p.fill('#siPass', pw);
    await p.click('#siGo');
    await p.waitForFunction('Store.S.loaded && Store.S.server && Store.S.accountsMode', null, { timeout: 15000 });
  };
  const toastSays = (p, text) => p.waitForFunction((t) => [...document.querySelectorAll('#toasts .toast')].some((e) => e.textContent.includes(t)), text, { timeout: 5000 });

  const dm = await open('dm');
  const pl = await open('player');
  let monId;
  let tokId;
  await step('sign-in screen comes before the table', async () => {
    await dm.waitForSelector('#signin', { timeout: 15000 });
    return dm.evaluate(() => [!!document.getElementById('siPass2Row') && !document.getElementById('siPass2Row').hidden, !Store.S.loaded]);
  });
  await step('mismatched passwords are caught on the page', async () => {
    await dm.fill('#siName', 'Dana');
    await dm.fill('#siPass', 'dragonfire1');
    await dm.fill('#siPass2', 'dragonfire2');
    await dm.click('#siGo');
    return dm.textContent('#siErr');
  });
  await step('first person registers and is the DM and owner', async () => {
    await register(dm, 'Dana', 'dragonfire1');
    const r = await dm.evaluate(() => [Store.S.dm, Store.S.me.isOwner, Store.S.me.nick, Store.S.me.pk === Store.S.authUser.id, !!document.getElementById('signin')]);
    expect(r[0] === true && r[1] === true && r[2] === 'Dana' && r[3] && !r[4], 'not DM/owner: ' + JSON.stringify(r));
    return r;
  });
  await step('wrong password shows a clear error', async () => {
    await pl.waitForSelector('#signin #siName', { timeout: 15000 });
    await pl.click('#signin [data-m=signin]');
    await pl.fill('#siName', 'Dana');
    await pl.fill('#siPass', 'not-the-password');
    await pl.click('#siGo');
    await pl.waitForFunction(() => document.getElementById('siErr').textContent.length > 0, null, { timeout: 5000 });
    const msg = await pl.textContent('#siErr');
    expect(msg === 'Wrong name or password.', msg);
    return msg;
  });
  await step('second person registers as a player', async () => {
    await pl.fill('#siPass', '');
    await register(pl, 'Pip', 'halfling-pw', true);
    const r = await pl.evaluate(() => [Store.S.dm, Store.S.me.isOwner, Store.S.me.nick]);
    expect(r[0] === false && r[1] === false && r[2] === 'Pip', JSON.stringify(r));
    return r;
  });
  await step('DM makes a hero and places a monster; player sees both', async () => {
    monId = await dm.evaluate(async () => {
      Store.Act.saveChar('dhero', { owner: Store.S.me.pk, name: 'Rhea', race: 'human', cls: 'fighter', level: 1, background: 'acolyte', method: 'array', base: { str: 15, dex: 14, con: 13, int: 8, wis: 10, cha: 12 }, skills: ['athletics', 'perception'], weapons: ['longsword'], armor: 'chain-mail', color: '#d9675f', hp: null, tmp: 0, conds: [] });
      const sid = await Store.Act.ensureScene();
      return Store.Act.addToken({ scene: sid, kind: 'monster', mon: 'goblin', name: 'Goblin', c: 2, r: 2, size: 1, hp: 7, max: 7, owner: Store.S.me.pk, ts: Date.now() });
    });
    await pl.waitForFunction((id) => Store.S.tokens.has(id) && Store.S.chars.has('dhero'), monId, { timeout: 8000 });
    return monId;
  });
  await step('player can’t move the DM’s monster (server refuses)', async () => {
    const ok = await pl.evaluate((id) => Store.Act.patchToken(id, { c: 7, r: 7 }), monId);
    expect(ok === false, 'write reported success');
    await toastSays(pl, 'permission');
    await wait(400);
    const at = await dm.evaluate((id) => [Store.S.tokens.get(id).c, Store.S.tokens.get(id).r], monId);
    expect(at[0] === 2 && at[1] === 2, 'monster moved: ' + at);
    expect(!(await pl.evaluate(() => Store.S.relay)), 'went into relay mode');
    return at;
  });
  await step('player can’t edit the DM’s hero', async () => {
    const ok = await pl.evaluate(() => Store.Act.patchChar('dhero', { name: 'Stolen', hp: 1 }));
    expect(ok === false, 'write reported success');
    await wait(400);
    const name = await dm.evaluate(() => Store.S.chars.get('dhero').name);
    expect(name === 'Rhea', 'hero changed: ' + name);
    return name;
  });
  await step('player makes their own hero and places it', async () => {
    tokId = await pl.evaluate(async () => {
      Store.Act.saveChar('phero', { owner: Store.S.me.pk, name: 'Mira', race: 'elf', subrace: 'high-elf', cls: 'rogue', level: 3, background: 'acolyte', method: 'array', base: { str: 8, dex: 15, con: 14, int: 12, wis: 13, cha: 10 }, skills: ['stealth', 'acrobatics', 'perception', 'deception'], expertise: ['stealth', 'perception'], weapons: ['shortsword', 'shortbow'], armor: 'leather-armor', color: '#5fb2d9', hp: null, tmp: 0, conds: [] });
      return Store.Act.addToken({ scene: Store.activeScene().id, kind: 'pc', char: 'phero', c: 4, r: 4, size: 1, owner: Store.S.me.pk, ts: Date.now() });
    });
    await dm.waitForFunction((id) => Store.S.tokens.has(id) && Store.S.chars.has('phero'), tokId, { timeout: 8000 });
    return dm.evaluate(() => Store.S.chars.get('phero').owner === [...Store.S.accounts.entries()].find(([, a]) => a.name === 'Pip')[0]);
  });
  await step('player moves their own token; DM sees it', async () => {
    const ok = await pl.evaluate((id) => Store.Act.patchToken(id, { c: 6, r: 5 }), tokId);
    expect(ok === true, 'move refused');
    await dm.waitForFunction((id) => Store.S.tokens.get(id).c === 6, tokId, { timeout: 5000 });
    return dm.evaluate((id) => [Store.S.tokens.get(id).c, Store.S.tokens.get(id).r], tokId);
  });
  await step('player edits their own hero and rolls', async () => {
    expect(await pl.evaluate(() => Store.Act.patchChar('phero', { notes: 'Quiet.' })), 'hero edit refused');
    await pl.evaluate(() => Store.Act.log({ kind: 'chat', who: 'Pip', text: 'hello from Pip' }));
    await dm.waitForFunction(() => Store.S.log.some((e) => e.text === 'hello from Pip') && Store.S.chars.get('phero').notes === 'Quiet.', null, { timeout: 5000 });
  });
  await step('player has no role switch, backup or account admin', async () => {
    await pl.click('#settingsBtn');
    await pl.waitForSelector('[data-act=signout]', { timeout: 5000 });
    const r = await pl.evaluate(() => [!!document.querySelector('[data-act=role]'), !!document.querySelector('[data-act=backup]'), !!document.querySelector('[data-act=set-dm]')]);
    expect(r.every((x) => !x), JSON.stringify(r));
    await pl.keyboard.press('Escape');
    return r;
  });
  await step('owner makes Pip a DM from People and settings', async () => {
    await dm.click('#settingsBtn');
    await dm.waitForSelector('[data-act=set-dm]', { timeout: 5000, state: 'attached' });
    await dm.evaluate(() => document.querySelector('details.fold') && (document.querySelector('details.fold').open = true));
    const pipId = await dm.evaluate(() => [...Store.S.accounts.entries()].find(([, a]) => a.name === 'Pip')[0]);
    await dm.evaluate((id) => document.querySelector(`[data-act=set-dm][data-id="${id}"]`).click(), pipId);
    await pl.waitForFunction('Store.S.dm === true', null, { timeout: 5000 });
    const ok = await pl.evaluate((id) => Store.Act.patchToken(id, { c: 3 }), monId);
    expect(ok === true, 'new DM still refused');
    await dm.waitForSelector(`[data-act=set-dm][data-id="${pipId}"][data-dm="0"]`, { timeout: 5000, state: 'attached' });
    await dm.evaluate(() => document.querySelector('details.fold') && (document.querySelector('details.fold').open = true));
    await dm.evaluate((id) => document.querySelector(`[data-act=set-dm][data-id="${id}"]`).click(), pipId);
    await pl.waitForFunction('Store.S.dm === false', null, { timeout: 5000 });
    expect((await pl.evaluate((id) => Store.Act.patchToken(id, { c: 2 }), monId)) === false, 'player again but allowed');
    return pipId;
  });
  await step('reload keeps both signed in', async () => {
    await dm.reload({ waitUntil: 'domcontentloaded' });
    await pl.reload({ waitUntil: 'domcontentloaded' });
    for (const p of [dm, pl]) await p.waitForFunction('Store.S.loaded && Store.S.accountsMode', null, { timeout: 15000 });
    const r = [await dm.evaluate(() => [Store.S.me.nick, Store.S.dm, !!document.getElementById('signin')]), await pl.evaluate(() => [Store.S.me.nick, Store.S.dm, !!document.getElementById('signin')])];
    expect(r[0][0] === 'Dana' && r[0][1] && !r[0][2] && r[1][0] === 'Pip' && !r[1][1] && !r[1][2], JSON.stringify(r));
    return r;
  });
  await step('password reset by the owner sends Pip back to the sign-in screen', async () => {
    await dm.click('#settingsBtn');
    await dm.waitForSelector('[data-act=reset-pw]', { timeout: 5000, state: 'attached' });
    const pipId = await dm.evaluate(() => [...Store.S.accounts.entries()].find(([, a]) => a.name === 'Pip')[0]);
    // fill and press in one go: the live sheet may redraw (and fold the list) between steps
    await dm.evaluate((id) => {
      document.getElementById('rp-' + id).value = 'brand-new-pw';
      document.querySelector(`[data-act=reset-pw][data-id="${id}"]`).click();
    }, pipId);
    await toastSays(dm, 'Password reset');
    await pl.waitForSelector('#signin #siName', { timeout: 15000 });
    await signIn(pl, 'pip', 'brand-new-pw');
    return pl.evaluate(() => Store.S.me.nick);
  });
  await step('sign out works', async () => {
    await pl.click('#settingsBtn');
    await pl.waitForSelector('[data-act=signout]', { timeout: 5000 });
    await pl.click('[data-act=signout]');
    await pl.waitForSelector('#signin #siName', { timeout: 15000 });
    const st = await pl.evaluate(() => fetch('api/me').then((r) => r.status));
    expect(st === 401, 'still signed in: ' + st);
    const dmSt = await dm.evaluate(() => fetch('api/me').then((r) => r.status));
    expect(dmSt === 200, 'DM signed out too');
    return [st, dmSt];
  });
  for (const p of [dm, pl]) if (p.errs.length) results.push(['note', p.label + ' page errors', p.errs.slice(0, 3).join(' | ')]);
  results.forEach((r) => console.log(r.join(' | ')));
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`accounts check: ${results.filter((r) => r[0] === 'ok').length} ok, ${failed} failed`);
  await browser.close();
  srv.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
