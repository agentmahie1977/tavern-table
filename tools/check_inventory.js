// Browser check for the hero and party inventories (phone viewport, solo mode).
// Run: python3 tools/build.py && node tools/check_inventory.js
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');

(async () => {
  const port = 8700 + Math.floor(Math.random() * 500);
  const srv = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', path.join(__dirname, '..', 'docs')], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1000));
  const browser = await chromium.launch();
  const errors = [];
  let fail = null;
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await ctx.route(/fonts\./, (r) => r.abort());
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => m.type() === 'error' && !/fonts|ERR_FAILED|Failed to load resource/.test(m.text()) && errors.push('console: ' + m.text()));
    await page.goto(`http://127.0.0.1:${port}/?c=inv${Math.random().toString(36).slice(2, 8)}`);
    await page.waitForFunction('Store.S.loaded && !!Store.Data.rules', null, { timeout: 20000 });
    await page.evaluate(() => Store.Act.saveChar(null, { name: 'T', race: 'human', cls: 'fighter', level: 1, owner: Store.S.me.pk, base: {} }));
    await page.waitForTimeout(300);
    await page.tap('#tabs [data-tab=heroes]');
    const step = (s) => console.log('ok  ' + s);

    // party card is on the hero list
    const names = () => page.$$eval('#p-heroes .inv-row .title', (a) => a.map((x) => x.textContent.trim()));
    async function add(scope, name, qty, note, how) {
      await page.fill(`#${scope}Name`, name);
      if (qty) await page.fill(`#${scope}Qty`, String(qty));
      if (note) await page.fill(`#${scope}Note`, note);
      if (how === 'enter') await page.press(`#${scope}Name`, 'Enter');
      else await page.tap(`[data-act=${scope}-add]`);
      await page.waitForTimeout(250);
    }
    await page.waitForSelector('#partyName');
    assert(await page.$eval('#itemNames', (d) => [...d.options].some((o) => o.value === 'Bedroll')), 'datalist has gear');
    assert(await page.$eval('#itemNames', (d) => [...d.options].some((o) => o.value === 'Longsword')), 'datalist has weapons');
    assert((await page.getAttribute('#partyName', 'placeholder')).startsWith('Type any item name'), 'placeholder');
    step('suggestions include gear and weapons');
    await add('party', 'Bag of marbles', 2, 'found in a cellar');
    assert.deepStrictEqual(await names(), ['Bag of marbles']);
    assert.strictEqual(await page.inputValue('#partyName'), '');
    assert.strictEqual(await page.inputValue('#partyQty'), '1');
    assert(await page.textContent('#p-heroes .inv-row .sub') === 'found in a cellar');
    step('party free text add');
    await add('party', 'Candle stub', 0, '', 'enter');
    assert.deepStrictEqual(await names(), ['Bag of marbles', 'Candle stub']);
    step('party Enter adds');

    // edit name and note in the party
    await page.tap('#p-heroes [data-act=party-edit][data-i="0"]');
    await page.waitForSelector('#itemEditName');
    await page.fill('#itemEditName', 'Sack of marbles <b>');
    await page.fill('#itemEditNote', 'shiny');
    await page.press('#itemEditName', 'Enter');
    await page.waitForTimeout(300);
    assert.deepStrictEqual(await names(), ['Sack of marbles <b>', 'Candle stub']);
    assert.strictEqual(await page.$eval('#p-heroes .inv-row .sub', (e) => e.textContent), 'shiny');
    assert.strictEqual(await page.$$eval('#p-heroes .inv-row b', (e) => e.length), 0, 'escaped');
    step('party edit name/note');

    // quantity
    await page.tap('#p-heroes [data-act=party-q][data-i="0"][data-d="1"]');
    await page.waitForTimeout(250);
    assert.strictEqual(await page.$eval('#p-heroes .inv-row .val', (e) => e.textContent), '3');
    step('party quantity');

    // hero sheet
    await page.tap('[data-act=open-hero]');
    await page.waitForSelector('#invName');
    await add('inv', 'Rope, hempen (50 feet)', 0, '');
    await add('inv', 'Bag of marbles', 5, 'mine', 'enter');
    assert.deepStrictEqual(await names(), ['Rope, hempen (50 feet)', 'Bag of marbles']);
    assert.strictEqual(await page.inputValue('#invName'), '');
    step('hero free text + Enter add');
    await page.tap('#p-heroes [data-act=inv-q][data-i="1"][data-d="-1"]');
    await page.waitForTimeout(250);
    assert.strictEqual(await page.$$eval('#p-heroes .inv-row .val', (e) => e[1].textContent), '4');
    step('hero quantity');
    await page.tap('#p-heroes [data-act=inv-edit][data-i="1"]');
    await page.waitForSelector('#itemEditName');
    await page.fill('#itemEditName', 'Marbles');
    await page.fill('#itemEditNote', '');
    await page.tap('[data-act=item-save]');
    await page.waitForTimeout(300);
    assert.deepStrictEqual(await names(), ['Rope, hempen (50 feet)', 'Marbles']);
    assert.strictEqual(await page.$$eval('#p-heroes .inv-row .sub', (e) => e.length), 0, 'note cleared');
    step('hero edit name/note');
    await page.tap('#p-heroes [data-act=inv-move][data-i="1"]');
    await page.waitForTimeout(300);
    assert.deepStrictEqual(await names(), ['Rope, hempen (50 feet)']);
    await page.tap('[data-act=hero-back]');
    await page.waitForTimeout(300);
    let pn = await names();
    assert(pn.includes('Marbles'), 'moved to party: ' + pn);
    step('hero to party');
    const idx = pn.indexOf('Marbles');
    await page.tap(`#p-heroes [data-act=party-move][data-i="${idx}"]`);
    await page.waitForTimeout(300);
    assert(!(await names()).includes('Marbles'));
    const inv = await page.evaluate(() => [...Store.S.chars.values()][0].inv.map((i) => i.n + ':' + i.q));
    assert(inv.includes('Marbles:4'), 'taken: ' + inv);
    step('party take back');
  } catch (e) {
    fail = e;
  }
  await browser.close();
  srv.kill();
  if (fail) { console.error('FAIL', fail.message); process.exit(1); }
  if (errors.length) { console.error('page errors:\n' + errors.join('\n')); process.exit(1); }
  console.log('inventory check passed, no page errors');
})();
