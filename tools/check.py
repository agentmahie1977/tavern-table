"""Usage: python3 tools/check.py [project_root]
One consolidated check: phone solo flows + three simulated people sharing a table."""
import functools, http.server, os, socketserver, sys, threading, time, traceback
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "shots")
os.makedirs(OUT, exist_ok=True)
page_html = open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
skeleton = ('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
            '<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}body{margin:0;font:14px system-ui}img{max-width:100%}[hidden]{display:none!important}</style></head><body>'
            + page_html + '</body></html>')
open(os.path.join(ROOT, "test.html"), "w", encoding="utf-8").write(skeleton)
MOCK = open(os.path.join(ROOT, "tools", "mock_claude.js"), encoding="utf-8").read()

Handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
Handler.log_message = lambda *a: None
httpd = socketserver.TCPServer(("127.0.0.1", 0), Handler)
port = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{port}/test.html"

results, logs = [], {}


def step(name, fn):
    try:
        v = fn()
        results.append(("ok", name, "" if v is None else str(v)[:160]))
    except Exception as e:
        results.append(("FAIL", name, (str(e) or repr(e)).split("\n")[0][:300]))


def watch(page, label):
    logs[label] = []
    page.on("console", lambda m: m.type in ("error", "warning") and logs[label].append(f"{m.type}: {m.text[:300]}"))
    page.on("pageerror", lambda e: logs[label].append(f"pageerror: {str(e)[:400]}"))


def block_external(ctx):
    ctx.route("**/*", lambda r: r.continue_() if r.request.url.startswith(f"http://127.0.0.1:{port}") or r.request.url.startswith("data:") or r.request.url.startswith("blob:") else r.abort())


def wf(page, expr, timeout=6000):
    page.wait_for_function(expr, timeout=timeout)


with sync_playwright() as p:
    chrome = "/usr/bin/google-chrome"
    browser = p.chromium.launch(executable_path=chrome, args=["--no-sandbox"]) if os.path.exists(chrome) else p.chromium.launch()

    # ------------------------------------------------ A: phone, solo mode
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    block_external(ctx)
    a = ctx.new_page()
    watch(a, "phone")
    a.goto(BASE)
    step("boots in solo mode with rules", lambda: wf(a, "Store.S.mode==='local' && !!Store.Data.rules && document.querySelectorAll('.rail button').length>=5"))
    step("setup card shows for DM", lambda: a.wait_for_selector(".board-msg:not([hidden]) [data-act=scene-sample]", timeout=3000))
    a.screenshot(path=os.path.join(OUT, "a0_phone_first.png"))

    def sample():
        a.click("[data-act=scene-sample]")
        wf(a, "Store.S.scenes.size===1 && document.querySelector('.mapimg') && !document.querySelector('.mapimg').hidden", 15000)
        return a.evaluate("(()=>{const s=[...Store.S.scenes.values()][0];return s.name+' '+s.w+'x'+s.h+' chunks '+s.chunks})()")
    step("sample dungeon generated and shown", sample)

    def build_hero():
        a.click(".tab[data-tab=heroes]")
        a.click("[data-act=new-hero]")
        a.fill("#b-name", "Thorin")
        a.select_option("#b-race", "dwarf")
        a.select_option("#b-cls", "wizard")
        for _ in range(4):
            a.click("[data-act=lvl][data-d='1']")
        chips = a.locator("[data-act=skill]:not([disabled])")
        chips.nth(0).click()
        a.locator("[data-act=skill]:not([disabled])").nth(1).click()
        a.click("[data-act=weapon][data-w=dagger]")
        a.click("[data-act=method][data-m=buy]")
        for _ in range(7):
            a.click("[data-act=pb][data-ab=int][data-d='1']")
        wf(a, "!!Store.Data.spells", 8000)
        a.click("[data-act=spell-lvl][data-l='3']")
        a.fill("#spellQ", "fire")
        a.click("[data-act=pick-spell][data-i=fireball]")
        a.click("[data-act=spell-lvl][data-l='0']")
        a.click("[data-act=pick-spell][data-i=fire-bolt]")
        a.click("[data-act=build-save]")
        wf(a, "Store.S.chars.size===1 && !!document.querySelector('.hero-name')")
        return a.evaluate("(()=>{const c=[...Store.S.chars.values()][0];const d=Store.derived(c);return [c.name,c.level,c.cls,d.hpMax,d.ac,d.scores.int,d.cast.dc,JSON.stringify(c.spells)].join(' | ')})()")
    step("hero builder creates a level 5 wizard", build_hero)
    a.screenshot(path=os.path.join(OUT, "a1_phone_sheet.png"), full_page=False)

    def place():
        a.click("[data-act=place-token]")
        wf(a, "document.querySelectorAll('.tok').length===1 && !document.getElementById('side').offsetParent")
        return a.evaluate("JSON.stringify([...Store.S.tokens.values()].map(t=>[t.c,t.r]))")
    step("token placed on the map", place)

    def drag():
        t0 = a.evaluate("(()=>{const t=[...Store.S.tokens.values()][0];return [t.c,t.r]})()")
        box = a.locator(".tok").first.bounding_box()
        cell = box["width"]
        cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        a.mouse.move(cx, cy)
        a.mouse.down()
        for i in range(1, 11):
            a.mouse.move(cx + cell * 2 * i / 10, cy + cell * i / 10)
        a.mouse.up()
        wf(a, f"(()=>{{const t=[...Store.S.tokens.values()][0];return t.c==={t0[0]+2}&&t.r==={t0[1]+1}}})()")
        return f"moved from {t0} by (+2,+1), cell {cell:.1f}px"
    step("drag moves the token by whole squares", drag)

    def roll_skill():
        a.click(".tab[data-tab=heroes]")
        a.click("[data-act=roll-skill][data-sk=arcana]")
        wf(a, "Store.S.log.length>=1")
        return a.evaluate("JSON.stringify(Store.S.log[Store.S.log.length-1].rolls[0])")
    step("skill roll lands in the log", roll_skill)

    def fireball():
        a.click("[data-act=spell][data-i=fireball]")
        a.wait_for_selector(".sheet [data-act=sp-area]", timeout=3000)
        a.click(".sheet [data-act=sp-area]")
        a.wait_for_selector(".aimbar [data-act=aim-place]", timeout=3000)
        a.click(".aimbar [data-act=aim-place]")
        wf(a, "Store.S.tpls.size===1")
        return a.evaluate("JSON.stringify([...Store.S.tpls.values()][0])")
    step("fireball area placed from the spell card", fireball)

    def encounter():
        a.click(".tab[data-tab=encounter]")
        wf(a, "!!Store.Data.monsters && !!document.getElementById('monQ')", 8000)
        a.fill("#monQ", "goblin")
        a.wait_for_selector("[data-act=add][data-i=goblin]", timeout=3000)
        for _ in range(3):
            a.click("[data-act=add][data-i=goblin]")
        a.click("[data-act=add][data-i=hobgoblin]") if a.locator("[data-act=add][data-i=hobgoblin]").count() else None
        txt = a.locator(".diff-label").first.inner_text()
        a.click("[data-act=deploy-init]")
        wf(a, "[...Store.S.tokens.values()].filter(t=>t.kind==='monster').length>=3 && Store.S.init.size>=1", 6000)
        wf(a, "Store.S.game.combat===1", 4000)
        return txt + " | " + a.evaluate("JSON.stringify(initOrderDump())".replace("initOrderDump()", "UI.initOrder(false).map(e=>e.name+':'+e.val)"))
    step("encounter builder rates and deploys goblins with initiative", encounter)
    a.screenshot(path=os.path.join(OUT, "a2_phone_table.png"))

    def area_sheet():
        a.evaluate("(()=>{const t=[...Store.S.tpls.values()][0];const g=[...Store.S.tokens.values()].find(x=>x.kind==='monster');const gr=Board.grid();Store.Act.patchTemplate(t.id,{x:gr.ox+(g.c+0.5)*gr.size,y:gr.oy+(g.r+0.5)*gr.size})})()")
        wf(a, "(()=>{const t=[...Store.S.tpls.values()][0];return Board.tokensInTemplate(t).tokens.length>=1})()")
        a.evaluate("UI.openTemplateSheet([...Store.S.tpls.values()][0].id)")
        a.wait_for_selector(".sheet [data-act=roll-saves]", timeout=3000)
        a.click(".sheet [data-act=roll-saves]")
        a.click(".sheet [data-act=roll-dmg]")
        before = a.evaluate("[...Store.S.tokens.values()].filter(t=>t.kind==='monster').map(t=>t.hp).join(',')")
        a.click(".sheet [data-act=apply]")
        wf(a, f"[...Store.S.tokens.values()].filter(t=>t.kind==='monster').map(t=>t.hp).join(',')!=='{before}'")
        after = a.evaluate("[...Store.S.tokens.values()].filter(t=>t.kind==='monster').map(t=>t.hp).join(',')")
        a.click(".sheet [data-close]")
        return f"goblin HP {before} -> {after}"
    step("area sheet rolls saves and applies damage", area_sheet)

    def combat_next():
        a.click(".tab[data-tab=combat]")
        t0 = a.evaluate("Store.S.game.turn")
        a.click("[data-act=next]")
        wf(a, f"Store.S.game.turn!=={t0!r}".replace("None", "null"))
        return a.evaluate("Store.S.game.round+' '+Store.S.game.turn")
    step("next turn advances initiative", combat_next)

    def dice():
        a.click(".tab[data-tab=log]")
        n = a.evaluate("Store.S.log.length")
        a.fill("#diceExpr", "2d6+3")
        a.press("#diceExpr", "Enter")
        wf(a, f"Store.S.log.length>{n}")
        a.fill("#diceExpr", "hello table")
        a.press("#diceExpr", "Enter")
        wf(a, f"Store.S.log.length>{n + 1}")
        return a.evaluate("JSON.stringify(Store.S.log.slice(-2).map(e=>e.kind+':'+(e.text||e.rolls[0].t)))")
    step("dice tray rolls expressions and sends chat", dice)

    def grid_cal():
        a.click(".tab[data-tab=table]")
        a.click(".rail [data-act=scenes]")
        a.wait_for_selector("#gAcross", timeout=3000)
        a.fill("#gAcross", "16")
        a.press("#gAcross", "Tab")
        wf(a, "Math.abs(Store.activeScene().grid.size - Store.activeScene().w/16) < 0.05")
        a.click(".sheet [data-close]")
        return a.evaluate("Store.activeScene().grid.size")
    step("grid calibration by squares across", grid_cal)

    # ---------------------------- B: three people at one table (desktop)
    ctx2 = browser.new_context(viewport={"width": 1280, "height": 820})
    block_external(ctx2)
    ctx2.add_init_script(MOCK)
    owner = ctx2.new_page()
    watch(owner, "owner")
    owner.goto(BASE + "?mock=1&uid=u_ann&name=Ann&owner=1&role=editor")
    step("owner boots on the shared store as DM", lambda: wf(owner, "Store.S.mode==='remote' && Store.S.dm===true && Store.S.canWrite===true && !!Store.Data.rules"))
    owner.wait_for_timeout(700)
    if owner.locator(".sheet #nickFirst").count():
        owner.fill("#nickFirst", "Ann")
        owner.press("#nickFirst", "Enter")
    player = ctx2.new_page()
    watch(player, "player")
    player.goto(BASE + "?mock=1&uid=u_bob&name=Bob&role=editor")
    viewer = ctx2.new_page()
    watch(viewer, "viewer")
    viewer.goto(BASE + "?mock=1&uid=u_cat&name=Cat&role=viewer")
    step("player and viewer boot", lambda: (wf(player, "Store.S.mode==='remote' && !!Store.Data.rules"), wf(viewer, "Store.S.mode==='remote' && !!Store.Data.rules")))
    for pg, nm in ((player, "Bob"), (viewer, "Cat")):
        pg.wait_for_timeout(700)
        if pg.locator(".sheet #nickFirst").count():
            pg.fill("#nickFirst", nm)
            pg.press("#nickFirst", "Enter")

    def scene_shared():
        owner.evaluate("Store.Act.newBlankScene(24,16,'Crossroads')")
        wf(player, "Store.S.scenes.size===1 && Store.activeScene().name==='Crossroads'")
        wf(viewer, "Store.activeScene().name==='Crossroads'")
        return "both see Crossroads"
    step("a scene the DM makes shows up for everyone", scene_shared)

    def peers_seen():
        wf(owner, "new Set(Store.S.peers.map(p=>p.presence&&p.presence.pk).filter(Boolean)).size===3", 6000)
        return owner.evaluate("JSON.stringify(Store.S.peers.map(p=>[p.presence.nm,p.presence.w,p.presence.dm]))")
    step("presence lists all three people", peers_seen)

    def player_hero():
        player.evaluate("Store.Act.saveChar('bobhero',{owner:Store.S.me.pk,name:'Mira',race:'elf',subrace:'high-elf',cls:'rogue',level:3,background:'acolyte',method:'array',base:{str:8,dex:15,con:14,int:12,wis:13,cha:10},skills:['stealth','acrobatics','perception','deception'],expertise:['stealth','perception'],weapons:['shortsword','shortbow'],armor:'leather-armor',color:'#5fb2d9',hp:null,tmp:0,conds:[]})")
        wf(owner, "Store.S.chars.has('bobhero')")
        player.evaluate("(async()=>{const sid=await Store.Act.ensureScene();Store.Act.addToken({scene:sid,kind:'pc',char:'bobhero',c:3,r:3,size:1,owner:Store.S.me.pk,ts:Date.now()})})()")
        wf(owner, "[...Store.S.tokens.values()].some(t=>t.char==='bobhero')")
        wf(viewer, "document.querySelectorAll('.tok').length===1")
        return owner.evaluate("(()=>{const c=Store.S.chars.get('bobhero');const d=Store.derived(c);return 'AC '+d.ac+' stealth '+d.skills.stealth.bonus+' hp '+d.hpMax})()")
    step("player's hero and token sync to DM and viewer", player_hero)

    def live_drag():
        box = player.locator(".tok").first.bounding_box()
        cell = box["width"]
        cx, cy = box["x"] + cell / 2, box["y"] + cell / 2
        player.mouse.move(cx, cy)
        player.mouse.down()
        for i in range(1, 8):
            player.mouse.move(cx + cell * 3 * i / 7, cy)
        wf(owner, "!!document.querySelector('.tok.remote')", 4000)
        player.mouse.up()
        wf(owner, "[...Store.S.tokens.values()].find(t=>t.char==='bobhero').c===6", 4000)
        return "DM saw the drag live, then the final square"
    step("token drag is visible to the DM while dragging", live_drag)

    def dm_cannot_be_blocked():
        tid = owner.evaluate("[...Store.S.tokens.values()][0].id")
        owner.evaluate(f"Store.Act.patchToken('{tid}',{{c:8,r:5}})")
        wf(player, f"Store.S.tokens.get('{tid}').c===8")
        return "DM moved the player's token"
    step("DM can move any token", dm_cannot_be_blocked)

    def viewer_relay():
        viewer.click(".side-tab[data-tab=log]")
        viewer.fill("#diceExpr", "1d20+4")
        viewer.press("#diceExpr", "Enter")
        wf(viewer, "Store.S.relay===true", 4000)
        wf(owner, "Store.S.log.some(e=>e.who==='Cat' && e.kind==='roll')", 6000)
        wf(viewer, "Store.S.log.some(e=>e.who==='Cat')", 6000)
        return owner.evaluate("JSON.stringify(Store.S.log.filter(e=>e.who==='Cat').map(e=>e.rolls[0].e+'='+e.rolls[0].t))")
    step("view-only friend's roll is relayed through the DM's page", viewer_relay)

    def viewer_hero_relay():
        viewer.evaluate("Store.Act.saveChar('cathero',{owner:Store.S.me.pk,name:'Brindle',race:'halfling',subrace:'lightfoot-halfling',cls:'bard',level:2,background:'acolyte',method:'array',base:{str:8,dex:14,con:13,int:10,wis:12,cha:15},skills:['persuasion','performance','insight'],weapons:['rapier'],armor:'leather-armor',color:'#b98ee0',hp:null,tmp:0,conds:[],notes:'Plays the lute badly.'})")
        wf(owner, "Store.S.chars.has('cathero') && Store.S.chars.get('cathero').notes==='Plays the lute badly.'", 6000)
        viewer.evaluate("Store.Act.addToken({id:'cattok',scene:Store.activeScene().id,kind:'pc',char:'cathero',c:1,r:1,size:1,owner:Store.S.me.pk,ts:Date.now()})")
        wf(owner, "Store.S.tokens.has('cattok')", 6000)
        viewer.evaluate("Store.Act.patchToken('cattok',{c:2,r:2})")
        wf(owner, "Store.S.tokens.get('cattok').c===2", 6000)
        wf(viewer, "Store.relayPending()===0", 6000)
        return "hero, token and move arrived; relay queue drained"
    step("view-only friend's hero, token and move are relayed", viewer_hero_relay)

    def ping():
        player.evaluate("Store.Act.ping(300,300)")
        wf(owner, "document.querySelectorAll('.ping').length>=1", 4000)
        return "ping shown on DM's map"
    step("pings reach other people", ping)

    def sel_card():
        owner.evaluate("Board.selectTok('cattok')")
        owner.wait_for_selector(".selcard #selHp", timeout=3000)
        owner.fill("#selHp", "3")
        owner.click(".selcard [data-act=sel-dmg]")
        wf(viewer, "Store.heroHp(Store.S.chars.get('cathero')).hp===Store.heroHp(Store.S.chars.get('cathero')).max-3", 4000)
        return viewer.evaluate("JSON.stringify(Store.heroHp(Store.S.chars.get('cathero')))")
    step("DM damages a hero from the map; the player sees it", sel_card)
    owner.wait_for_timeout(300)
    owner.screenshot(path=os.path.join(OUT, "b1_desktop_dm.png"))
    browser.close()

httpd.shutdown()
for r in results:
    print(*r, sep=" | ")
for k, v in logs.items():
    uniq = []
    for x in v:
        if x not in uniq:
            uniq.append(x)
    print(f"--- {k}: {len(v)} console messages")
    for x in uniq[:25]:
        print("   ", x)
