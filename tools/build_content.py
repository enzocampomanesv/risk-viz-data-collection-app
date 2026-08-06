"""Build-time content converter: study_content.xlsx -> config/content.json.

The participant app, control room, and dashboard read this JSON (never Excel),
so the team's single editing surface is the spreadsheet. Run after editing:

    python tools/build_content.py

Validates ids, required columns, settings, groups, and warns on missing images.
Exits non-zero (without writing) on blocking errors.
"""
import json, os, re, sys
from openpyxl import load_workbook

# Inline-highlight colour palette accepted in study-authored text ([[name:…]]).
# Keep in sync with HL_COLORS in app/config-loader.js and the .hl--* CSS.
HL_COLORS = {"red", "green", "blue", "amber", "teal"}
RE_HL = re.compile(r"\[\[([a-zA-Z]+):")

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
XLSX = os.path.join(ROOT, "study_content.xlsx")
OUT  = os.path.join(ROOT, "config", "content.json")

errors, warnings = [], []

def s(v):
    return "" if v is None else str(v).strip()

def as_bool(v, default=False):
    t = s(v).lower()
    if t in ("yes", "true", "1", "on"): return True
    if t in ("no", "false", "0", "off", ""): return default if t == "" else False
    return default

def as_int(v, default, where):
    try:
        return int(float(s(v)))
    except Exception:
        if s(v) != "":
            errors.append(f"{where}: '{s(v)}' is not a whole number.")
        return default

def read_sheet(wb, name):
    if name not in wb.sheetnames:
        errors.append(f"[{name}] tab is missing from the workbook.")
        return [], []
    ws = wb[name]
    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        return [], []
    headers = [s(h) for h in rows[0]]
    out = []
    for i, raw in enumerate(rows[1:], start=2):
        if all(c is None or s(c) == "" for c in raw):
            continue
        rec = {headers[j]: (raw[j] if j < len(raw) else None) for j in range(len(headers))}
        rec["__row"] = i
        out.append(rec)
    return out, headers

def comparison_folder():
    try:
        cfg = json.load(open(os.path.join(ROOT, "config", "config.json")))
        return (cfg.get("comparison") or {}).get("folder", "images/visual_v1")
    except Exception:
        return "images/visual_v1"

def word_section_ids():
    """Ordered ids of word_association sections in config.json (for scoping
    word_prompts). First entry is the default home for un-tagged prompts."""
    try:
        cfg = json.load(open(os.path.join(ROOT, "config", "config.json")))
        return [s["id"] for s in cfg.get("sections", []) if s.get("type") == "word_association"]
    except Exception:
        return []

PROMPT_FOLDER = "images/prompts"

def resolve_image(raw):
    """word_prompts/discussion/likert_stimuli 'image' cells accept either a bare
    filename (resolved against PROMPT_FOLDER, like comparison_items' 'file' column)
    or a full path (containing '/'), kept as-is for backward compatibility with
    rows already written as images/prompts/xx.jpg."""
    v = s(raw)
    if not v:
        return None
    return v if "/" in v else f"{PROMPT_FOLDER}/{v}"

def check_image(path, where):
    if path and not os.path.exists(os.path.join(ROOT, path)):
        warnings.append(f"{where}: image not found yet: {path}")

def dup_check(seen, rid, where):
    if rid in seen:
        errors.append(f"{where}: duplicate id '{rid}'.")
    seen.add(rid)

def main():
    if not os.path.exists(XLSX):
        sys.exit(f"ERROR: {XLSX} not found. Run tools/make_template.py first.")
    wb = load_workbook(XLSX, data_only=True)
    content = {}

    # ---------- settings ----------
    recs, _ = read_sheet(wb, "settings")
    kv = {s(r.get("key")): r.get("value") for r in recs}
    mode = s(kv.get("pairwise_sequence_mode")).lower() or "grouped"
    if mode not in ("grouped", "shuffled"):
        errors.append(f"[settings] pairwise_sequence_mode must be 'grouped' or 'shuffled' (got '{mode}').")
    loop = as_bool(kv.get("pairwise_loop"), False)
    if mode == "grouped" and loop:
        warnings.append("[settings] pairwise_loop is ignored in 'grouped' mode (grouped never loops).")
        loop = False
    settings = {
        "likert_points":         as_int(kv.get("likert_points"), 5, "[settings] likert_points"),
        "pairwise_sequence_mode": mode,
        "pairwise_loop":         loop,
        "comparisons_per_group": as_int(kv.get("comparisons_per_group"), 0, "[settings] comparisons_per_group"),
        "prep_comparisons":      as_int(kv.get("prep_comparisons"), 0, "[settings] prep_comparisons"),
        "pairwise_landscape":    as_bool(kv.get("pairwise_landscape"), True),
        "pairwise_prompt":       s(kv.get("pairwise_prompt")) or "Which option do you prefer?",
    }
    if settings["likert_points"] < 2:
        errors.append("[settings] likert_points must be 2 or more.")
    content["settings"] = settings

    # ---------- registration -> participant_fields ----------
    recs, _ = read_sheet(wb, "registration")
    fields, by_id, order = {}, set(), []
    TYPE_MAP = {"single-choice": "select", "single_choice": "select", "select": "select",
                "text": "text", "number": "number", "numerical": "number", "numeric": "number"}
    for r in recs:
        fid = s(r.get("field_id"))
        if not fid:
            errors.append(f"[registration row {r['__row']}] missing field_id."); continue
        if fid not in fields:
            ftype = TYPE_MAP.get(s(r.get("type")).lower(), "select")
            fields[fid] = {"id": fid, "label": s(r.get("label")), "type": ftype,
                           "required": as_bool(r.get("required"), True), "options": []}
            order.append(fid)
        ov = s(r.get("option_value"))
        if ov:
            fields[fid]["options"].append({"value": ov, "text": s(r.get("option_text")) or ov})
        if s(r.get("label")) and not fields[fid]["label"]:
            fields[fid]["label"] = s(r.get("label"))
    pf = []
    for fid in order:
        f = fields[fid]
        if not f["label"]:
            errors.append(f"[registration] field '{fid}' has no label.")
        if f["type"] == "select" and not f["options"]:
            errors.append(f"[registration] single-choice field '{fid}' has no options.")
        if f["type"] != "select":
            f.pop("options")
        pf.append(f)
    content["participant_fields"] = pf

    # ---------- word_prompts ----------
    recs, _ = read_sheet(wb, "word_prompts")
    word_secs = word_section_ids()
    default_word_sec = word_secs[0] if word_secs else None
    seen, clean = set(), []
    for r in recs:
        rid, row = s(r.get("id")), r["__row"]
        if not rid: errors.append(f"[word_prompts row {row}] missing id."); continue
        dup_check(seen, rid, f"[word_prompts row {row}]")
        if not s(r.get("text")): errors.append(f"[word_prompts row {row}] missing text.")
        maxw = as_int(r.get("max_words"), 5, f"[word_prompts row {row}] max_words")
        minw = as_int(r.get("min_words"), 1, f"[word_prompts row {row}] min_words")
        if minw < 1: errors.append(f"[word_prompts row {row}] min_words must be >= 1.")
        if maxw < minw: errors.append(f"[word_prompts row {row}] max_words < min_words.")
        img = resolve_image(r.get("image")); check_image(img, f"[word_prompts row {row}]")
        sec = s(r.get("section")) or default_word_sec
        if word_secs and sec not in word_secs:
            errors.append(f"[word_prompts row {row}] section '{sec}' is not a word_association "
                          f"section (valid: {', '.join(word_secs)}).")
        clean.append({"id": rid, "section": sec, "text": s(r.get("text")), "image": img, "max_words": maxw, "min_words": minw})
    content["word_prompts"] = clean

    # ---------- discussion ----------
    recs, _ = read_sheet(wb, "discussion")
    seen, clean = set(), []
    for r in recs:
        rid, row = s(r.get("id")), r["__row"]
        if not rid: errors.append(f"[discussion row {row}] missing id."); continue
        dup_check(seen, rid, f"[discussion row {row}]")
        text, img = s(r.get("text")) or None, resolve_image(r.get("image"))
        if not text and not img: errors.append(f"[discussion row {row}] needs text or image.")
        check_image(img, f"[discussion row {row}]")
        clean.append({"id": rid, "text": text, "image": img})
    content["discussion_prompts"] = clean

    # ---------- likert_stimuli ----------
    recs, _ = read_sheet(wb, "likert_stimuli")
    seen, clean = set(), []
    for r in recs:
        rid, row = s(r.get("id")), r["__row"]
        if not rid: errors.append(f"[likert_stimuli row {row}] missing id."); continue
        dup_check(seen, rid, f"[likert_stimuli row {row}]")
        body, img = s(r.get("body")), resolve_image(r.get("image"))
        if not body and not img: warnings.append(f"[likert_stimuli row {row}] has neither body nor image.")
        check_image(img, f"[likert_stimuli row {row}]")
        clean.append({"id": rid, "title": s(r.get("title")) or None, "body": body or None, "image": img})
    content["likert_stimuli"] = clean

    # ---------- comparison_items ----------
    recs, _ = read_sheet(wb, "comparison_items")
    folder = comparison_folder()
    seen, clean, groups = set(), [], {}
    for r in recs:
        rid, row = s(r.get("id")), r["__row"]
        if not rid: errors.append(f"[comparison_items row {row}] missing id."); continue
        dup_check(seen, rid, f"[comparison_items row {row}]")
        f, text = s(r.get("file")), s(r.get("text"))
        group = s(r.get("group")) or "default"
        if not f and not text:
            errors.append(f"[comparison_items row {row}] needs a 'file' or 'text'.")
        if f: check_image(os.path.join(folder, f), f"[comparison_items row {row}]")
        groups[group] = groups.get(group, 0) + 1
        clean.append({"id": rid, "label": s(r.get("label")) or None,
                      "file": f or None, "text": text or None, "group": group})
    for g, n in groups.items():
        if g != "preparation" and n < 2:
            warnings.append(f"[comparison_items] group '{g}' has only {n} item — needs >=2 to form a pair.")
    content["comparison_items"] = clean
    content["_comparison_groups"] = [g for g in groups if g != "preparation"]

    # ---------- choice_questions ----------
    recs, headers = read_sheet(wb, "choice_questions")
    choice_cols = [h for h in headers if h.startswith("choice")]
    seen, clean = set(), []
    for r in recs:
        rid, row = s(r.get("id")), r["__row"]
        if not rid: errors.append(f"[choice_questions row {row}] missing id."); continue
        dup_check(seen, rid, f"[choice_questions row {row}]")
        if not s(r.get("prompt")): errors.append(f"[choice_questions row {row}] missing prompt.")
        choices = [s(r.get(c)) for c in choice_cols if s(r.get(c))]
        if len(choices) < 2:
            errors.append(f"[choice_questions row {row}] needs at least 2 choices.")
        for txt in [s(r.get("prompt"))] + choices:
            for name in RE_HL.findall(txt or ""):
                if name not in HL_COLORS:
                    warnings.append(f"[choice_questions row {row}] unknown highlight colour '[[{name}:…]]' "
                                    f"(allowed: {', '.join(sorted(HL_COLORS))}) — it will render as plain text.")
        clean.append({"id": rid, "prompt": s(r.get("prompt")), "choices": choices})
    content["choice_questions"] = clean

    if errors:
        print("BUILD FAILED — fix these and re-run:\n  - " + "\n  - ".join(errors))
        if warnings: print("\nWarnings:\n  - " + "\n  - ".join(warnings))
        sys.exit(1)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(content, open(OUT, "w"), indent=2, ensure_ascii=False)
    counts = ", ".join(f"{k}={len(v)}" for k, v in content.items() if isinstance(v, list))
    print(f"OK — wrote {os.path.relpath(OUT, ROOT)}  ({counts})")
    print(f"   groups: {content['_comparison_groups']} + preparation | mode={settings['pairwise_sequence_mode']} loop={settings['pairwise_loop']} likert={settings['likert_points']}pt")
    if warnings:
        print("Warnings (non-blocking):\n  - " + "\n  - ".join(warnings))

if __name__ == "__main__":
    main()
