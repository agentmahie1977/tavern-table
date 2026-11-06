"""Compact the SRD 5.1 JSON (5e-bits/5e-database, 2014/en) into small files for the app.

Usage: python3 -I prep_srd.py <srd_en_dir> <out_dir>
"""
import json, os, re, sys

SRC, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)


def load(name):
    with open(os.path.join(SRC, f"5e-SRD-{name}.json"), encoding="utf-8") as f:
        return json.load(f)


def join(desc):
    if isinstance(desc, list):
        return "\n\n".join(d.strip() for d in desc if d and d.strip())
    return (desc or "").strip()


def dump(name, obj):
    path = os.path.join(OUT, name)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    print(name, os.path.getsize(path))


# ---------------------------------------------------------------- spells
SHAPE = {"sphere": "circle", "cylinder": "circle", "cone": "cone", "cube": "cube", "line": "line"}
AOE_OVERRIDE = {
    "hypnotic-pattern": ("cube", 30),
    "spirit-guardians": ("sphere", 15),
    "cloud-of-daggers": ("cube", 5),
    "flame-strike": ("cylinder", 10),
}
AOE_DROP = {"forbiddance", "guards-and-wards", "mirage-arcane", "private-sanctum", "hallucinatory-terrain"}

spells = []
for s in load("Spells"):
    desc = join(s.get("desc"))
    area = None
    a = s.get("area_of_effect")
    if s["index"] in AOE_OVERRIDE:
        t, z = AOE_OVERRIDE[s["index"]]
        a = {"type": t, "size": z}
    if a and s["index"] not in AOE_DROP and a["size"] <= 400:
        t, z = a["type"], a["size"]
        if t in ("sphere", "cylinder") and s["index"] not in AOE_OVERRIDE:
            m = re.search(r"(\d+)-foot[- ]radius", desc) or re.search(r"radius of (\d+) feet", desc)
            if m:
                z = int(m.group(1))
        area = {"shape": SHAPE[t], "size": z, "kind": t}
        if t == "line":
            m = re.search(r"(\d+) feet (?:wide|thick)", desc)
            area["width"] = max(5, int(m.group(1))) if m else 5
        if s.get("range", "").lower().startswith("self"):
            area["self"] = True
    dmg = None
    if s.get("damage"):
        d0 = s["damage"][0]
        dmg = {"type": (d0.get("damage_type") or {}).get("name", "")}
        if "damage_at_slot_level" in d0:
            dmg["slot"] = d0["damage_at_slot_level"]
        if "damage_at_character_level" in d0:
            dmg["char"] = d0["damage_at_character_level"]
    dc = None
    if s.get("dc"):
        dc = {"ability": s["dc"]["dc_type"]["index"], "success": s["dc"].get("dc_success", "none")}
    o = {
        "i": s["index"], "n": s["name"], "lvl": s["level"], "school": s["school"]["name"],
        "time": s.get("casting_time", ""), "range": s.get("range", ""),
        "comp": ", ".join(s.get("components", [])), "dur": s.get("duration", ""),
        "desc": desc, "cls": [c["index"] for c in s.get("classes", [])],
    }
    if s.get("material"): o["mat"] = s["material"]
    if s.get("concentration"): o["conc"] = 1
    if s.get("ritual"): o["ritual"] = 1
    if s.get("higher_level"): o["higher"] = join(s["higher_level"])
    if area: o["area"] = area
    if dmg: o["dmg"] = dmg
    if dc: o["dc"] = dc
    if s.get("attack_type"): o["atk"] = s["attack_type"]
    if s.get("heal_at_slot_level"): o["heal"] = s["heal_at_slot_level"]
    spells.append(o)
dump("spells.json", spells)

# ---------------------------------------------------------------- monsters
ABIL = ["strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma"]


def speed_str(sp):
    parts = []
    for k, v in sp.items():
        if k == "hover":
            parts.append("(hover)")
            continue
        parts.append(v if k == "walk" else f"{k} {v}")
    return ", ".join(parts)


def senses_str(se):
    parts = []
    for k, v in se.items():
        label = k.replace("_", " ")
        parts.append(f"{label} {v}")
    return ", ".join(parts)


def names(lst):
    out = []
    for x in lst or []:
        out.append(x["name"] if isinstance(x, dict) else str(x))
    return ", ".join(out)


def action(a):
    o = {"n": a["name"], "d": a.get("desc", "")}
    if a.get("attack_bonus") is not None:
        o["hit"] = a["attack_bonus"]
    dm = []
    for d in a.get("damage") or []:
        if "damage_dice" in d:
            dm.append([d["damage_dice"], (d.get("damage_type") or {}).get("name", "")])
        elif "from" in d:  # choice of damage options; take the first option
            opts = d["from"].get("options", [])
            if opts and "damage_dice" in opts[0]:
                dm.append([opts[0]["damage_dice"], (opts[0].get("damage_type") or {}).get("name", "")])
    if dm:
        o["dmg"] = dm
    if a.get("dc"):
        o["dc"] = [a["dc"]["dc_type"]["index"], a["dc"].get("dc_value"), a["dc"].get("success_type", "none")]
    desc = a.get("desc", "")
    m = re.search(r"(\d+)-foot line that is (\d+) feet wide", desc)
    if m:
        o["area"] = {"shape": "line", "size": int(m.group(1)), "width": int(m.group(2)), "self": True}
    else:
        m = re.search(r"(\d+)-foot cone", desc)
        if m:
            o["area"] = {"shape": "cone", "size": int(m.group(1)), "self": True}
        else:
            m = re.search(r"(\d+)-foot[- ]radius", desc)
            if m and int(m.group(1)) <= 120:
                o["area"] = {"shape": "circle", "size": int(m.group(1))}
            else:
                m = re.search(r"(\d+)-foot cube", desc)
                if m:
                    o["area"] = {"shape": "cube", "size": int(m.group(1))}
    u = a.get("usage")
    if u:
        if u.get("type") == "recharge on roll":
            o["use"] = f"Recharge {u.get('min_value')}–6" if u.get("min_value", 6) < 6 else "Recharge 6"
        elif u.get("type") == "per day":
            o["use"] = f"{u.get('times')}/Day"
        elif u.get("type") == "recharge after rest":
            o["use"] = "Recharges after a rest"
    return o


monsters = []
for m in load("Monsters"):
    ac = m["armor_class"][0]
    acn = ""
    if ac.get("armor"):
        acn = ", ".join(x["name"].lower() for x in ac["armor"])
    elif ac.get("type") not in (None, "dex"):
        acn = ac["type"].replace("_", " ")
    saves, skills = {}, {}
    for p in m.get("proficiencies", []):
        nm = p["proficiency"]["name"]
        if nm.startswith("Saving Throw: "):
            saves[nm.split(": ")[1].lower()] = p["value"]
        elif nm.startswith("Skill: "):
            skills[nm.split(": ")[1]] = p["value"]
    o = {
        "i": m["index"], "n": m["name"], "size": m["size"], "type": m["type"],
        "align": m.get("alignment", ""), "ac": ac["value"], "hp": m["hit_points"],
        "hd": m.get("hit_points_roll") or m.get("hit_dice"), "speed": speed_str(m.get("speed", {})),
        "abil": [m[a] for a in ABIL], "cr": m["challenge_rating"], "xp": m["xp"],
        "pb": m.get("proficiency_bonus", 2), "senses": senses_str(m.get("senses", {})),
        "lang": m.get("languages", ""),
    }
    if m.get("subtype"): o["sub"] = m["subtype"]
    if acn: o["acn"] = acn
    if saves: o["saves"] = saves
    if skills: o["skills"] = skills
    for key, src in (("vul", "damage_vulnerabilities"), ("res", "damage_resistances"), ("imm", "damage_immunities"), ("cimm", "condition_immunities")):
        v = names(m.get(src))
        if v: o[key] = v
    if m.get("special_abilities"):
        o["traits"] = [action(a) for a in m["special_abilities"]]
    o["actions"] = [action(a) for a in m.get("actions", [])]
    if m.get("legendary_actions"):
        o["legend"] = [action(a) for a in m["legendary_actions"]]
    if m.get("reactions"):
        o["react"] = [action(a) for a in m["reactions"]]
    monsters.append(o)
dump("monsters.json", monsters)

# ---------------------------------------------------------------- rules
profs = {p["index"]: p for p in load("Proficiencies")}
equipment = load("Equipment")
weapons, armor = {}, {}
for e in equipment:
    cat = e["equipment_category"]["index"]
    if cat == "weapon":
        w = {"n": e["name"], "cat": e["weapon_category"], "rng": e["weapon_range"],
             "dmg": (e.get("damage") or {}).get("damage_dice", ""),
             "ty": ((e.get("damage") or {}).get("damage_type") or {}).get("name", ""),
             "props": [p["index"] for p in e.get("properties", [])]}
        if e.get("two_handed_damage"):
            w["vers"] = e["two_handed_damage"]["damage_dice"]
        r = e.get("range") or {}
        if e["weapon_range"] == "Ranged":
            w["range"] = [r.get("normal"), r.get("long")]
        if e.get("throw_range"):
            w["thrown"] = [e["throw_range"].get("normal"), e["throw_range"].get("long")]
        weapons[e["index"]] = w
    elif cat == "armor":
        a = {"n": e["name"], "cat": e["armor_category"], "base": e["armor_class"]["base"],
             "dex": bool(e["armor_class"].get("dex_bonus")), "max": e["armor_class"].get("max_bonus")}
        if e.get("str_minimum"): a["str"] = e["str_minimum"]
        if e.get("stealth_disadvantage"): a["stealth"] = True
        armor[e["index"]] = a


def prof_to_weapons(pidx):
    p = profs.get(pidx)
    if not p or p["type"] != "Weapons":
        return None
    ref = (p.get("reference") or {}).get("index")
    if ref == "simple-weapons":
        return [k for k, w in weapons.items() if w["cat"] == "Simple"]
    if ref == "martial-weapons":
        return [k for k, w in weapons.items() if w["cat"] == "Martial"]
    if ref in weapons:
        return [ref]
    return []


def prof_to_armor(pidx):
    p = profs.get(pidx)
    if not p or p["type"] != "Armor":
        return None
    ref = (p.get("reference") or {}).get("index")
    if ref == "armor":
        return ["Light", "Medium", "Heavy"]
    if ref == "light-armor": return ["Light"]
    if ref == "medium-armor": return ["Medium"]
    if ref == "heavy-armor": return ["Heavy"]
    if ref == "shields" or pidx == "shields": return ["Shield"]
    return []


skills = {s["index"]: {"n": s["name"], "ab": s["ability_score"]["index"]} for s in load("Skills")}
levels = load("Levels")
features_raw = load("Features")
features = {}
for f in features_raw:
    features[f["index"]] = {"n": f["name"], "lvl": f.get("level"), "d": join(f.get("desc"))}
dump("features.json", features)

subclasses = load("Subclasses")
classes = {}
for c in load("Classes"):
    ci = c["index"]
    wp, ar = set(), set()
    for p in c["proficiencies"]:
        w = prof_to_weapons(p["index"])
        if w is not None: wp.update(w)
        a = prof_to_armor(p["index"])
        if a is not None: ar.update(a)
    choice = None
    for pc in c["proficiency_choices"]:
        opts = pc["from"].get("options", [])
        idxs = [o["item"]["index"] for o in opts if o.get("item")]
        sk = [i[len("skill-"):] for i in idxs if i.startswith("skill-")]
        if sk:
            choice = {"choose": pc["choose"], "from": sk}
            break
    lv = []
    for L in sorted([x for x in levels if x.get("class", {}).get("index") == ci and "subclass" not in x], key=lambda x: x["level"]):
        e = {"lvl": L["level"], "pb": L.get("prof_bonus"), "asi": L.get("ability_score_bonuses", 0),
             "feats": [f["index"] for f in L.get("features", [])]}
        sc = L.get("spellcasting")
        if sc:
            e["slots"] = [sc.get(f"spell_slots_level_{i}", 0) for i in range(1, 10)]
            if "cantrips_known" in sc: e["cantrips"] = sc["cantrips_known"]
            if "spells_known" in sc: e["known"] = sc["spells_known"]
        cs = L.get("class_specific")
        if cs: e["cs"] = cs
        lv.append(e)
    subs = []
    for s in subclasses:
        if s["class"]["index"] != ci:
            continue
        sl = {}
        for L in levels:
            if L.get("subclass", {}).get("index") == s["index"]:
                sl[str(L["level"])] = [f["index"] for f in L.get("features", [])]
        start = min(int(k) for k in sl) if sl else 3
        subs.append({"i": s["index"], "n": s["name"], "flavor": s.get("subclass_flavor", ""), "start": start, "levels": sl, "d": join(s.get("desc"))})
    sca = (c.get("spellcasting") or {}).get("spellcasting_ability", {}).get("index")
    classes[ci] = {"n": c["name"], "hd": c["hit_die"], "saves": [s["index"] for s in c["saving_throws"]],
                   "skills": choice, "weapons": sorted(wp), "armor": sorted(ar),
                   "cast": sca, "levels": lv, "subs": subs}

traits = {}
for t in load("Traits"):
    traits[t["index"]] = {"n": t["name"], "d": join(t.get("desc"))}
    ts = t.get("trait_specific") or {}
    if "breath_weapon" in ts:
        bw = ts["breath_weapon"]
        aoe = bw.get("area_of_effect", {})
        traits[t["index"]]["breath"] = {"type": ts["damage_type"]["name"], "shape": aoe.get("type"), "size": aoe.get("size"),
                                         "save": (bw.get("dc") or {}).get("dc_type", {}).get("index")}
    if t.get("proficiencies"):
        traits[t["index"]]["profs"] = [p["index"] for p in t["proficiencies"]]

races = {}
for r in load("Races"):
    o = {"n": r["name"], "speed": r["speed"], "size": r["size"],
         "bonus": {b["ability_score"]["index"]: b["bonus"] for b in r["ability_bonuses"]},
         "traits": [t["index"] for t in r.get("traits", [])], "subs": [s["index"] for s in r.get("subraces", [])],
         "langs": [l["name"] for l in r.get("languages", [])]}
    if r.get("ability_bonus_options"):
        o["choose"] = r["ability_bonus_options"]["choose"]
    races[r["index"]] = o
subraces = {}
for s in load("Subraces"):
    subraces[s["index"]] = {"n": s["name"], "race": s["race"]["index"],
                            "bonus": {b["ability_score"]["index"]: b["bonus"] for b in s["ability_bonuses"]},
                            "traits": [t["index"] for t in s.get("racial_traits", [])]}

backgrounds = {}
for b in load("Backgrounds"):
    feat = b.get("feature") or {}
    backgrounds[b["index"]] = {"n": b["name"],
                               "skills": [p["index"][len("skill-"):] for p in b.get("starting_proficiencies", []) if p["index"].startswith("skill-")],
                               "feature": {"n": feat.get("name", ""), "d": join(feat.get("desc"))}}

conditions = {c["index"]: {"n": c["name"], "d": join(c.get("desc"))} for c in load("Conditions")}

rules = {"classes": classes, "races": races, "subraces": subraces, "traits": traits, "backgrounds": backgrounds,
         "skills": skills, "conditions": conditions, "weapons": weapons, "armor": armor}
dump("rules.json", rules)
