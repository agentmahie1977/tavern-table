"""Assemble src/* into one index.html (the page content; the publisher adds the skeleton)."""
import os, sys

root = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), ".."))
src = os.path.join(root, "src")
read = lambda n: open(os.path.join(src, n), encoding="utf-8").read()

head = """<title>Tavern Table</title>
<meta name="claude:viewport-fit-sides" content="cover">
<meta name="description" content="A live battle map for 5e with friends: upload maps, move tokens together, build heroes and encounters, and place spell areas.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:ital,wght@0,400;0,700;1,400&family=IM+Fell+English+SC&display=swap">
"""
out = head + "<style>\n" + read("style.css") + "\n</style>\n" + read("body.html") + "\n<script>\n"
for name in ["core.js", "store.js", "map.js", "ui.js", "main.js"]:
    out += f"\n/* ---- {name} ---- */\n" + read(name)
out += "\n</script>\n"
if "</script" in "".join(read(n) for n in ["core.js", "store.js", "map.js", "ui.js", "main.js"]):
    raise SystemExit("script source contains </script")
with open(os.path.join(root, "index.html"), "w", encoding="utf-8") as f:
    f.write(out)
print("index.html", len(out.encode("utf-8")), "bytes")

# ---- website for GitHub Pages (served from docs/ on main): a full document plus data and vendor files
import shutil
site = os.path.join(root, "docs")
os.makedirs(os.path.join(site, "data"), exist_ok=True)
os.makedirs(os.path.join(site, "vendor"), exist_ok=True)
page = out.replace(
    '<link rel="stylesheet" href="https://fonts.googleapis.com',
    # never block the first paint on Google Fonts (it can be slow or blocked)
    '<link rel="stylesheet" media="print" onload="this.media=\'all\'" href="https://fonts.googleapis.com',
)
doc = ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
       '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
       '<style>:root{padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>'
       '</head><body>' + page + '</body></html>')
with open(os.path.join(site, "index.html"), "w", encoding="utf-8") as f:
    f.write(doc)
for n in ["rules", "spells", "monsters", "features"]:
    shutil.copyfile(os.path.join(root, "data", n + ".json"), os.path.join(site, "data", n + ".json"))
for n in ["peerjs.min.js", "peerjs.LICENSE"]:
    shutil.copyfile(os.path.join(root, "vendor", n), os.path.join(site, "vendor", n))
open(os.path.join(site, ".nojekyll"), "w").close()
print("docs/ website written")
