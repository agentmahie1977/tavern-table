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
