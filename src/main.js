/* ===================================================================
   main.js — boot: draw the table first, then light up shared data.
   =================================================================== */
(function () {
  'use strict';
  let started = false;
  async function start(hotData) {
    if (started) return;
    started = true;
    const data = hotData || {};
    Board.init(document.getElementById('board'));
    UI.init(data);
    if (data.view) setTimeout(() => Board.setView(data.view), 50);
    Store.loadData('rules').catch(() => UI.toast('The rules data didn’t load. Reload the page to try again.', 'warn'));
    try {
      await Store.boot({ toast: UI.toast });
    } catch (e) {
      console.error('boot failed', e);
      UI.toast('The table couldn’t connect. Reload the page to try again.', 'warn');
    }
    UI.afterBoot();
  }
  const hot = window.claude && window.claude.hot;
  try {
    if (hot && typeof hot.snapshot === 'function') hot.snapshot(() => UI.snapshot());
  } catch (e) { /* optional */ }
  if (hot && typeof hot.ready === 'function') hot.ready(start);
  else start((hot && hot.data) || {});
})();
