"""Build-time content converter: study_content.xlsx -> config/content.json.

The participant app, control room, and dashboard read this JSON (never Excel),
so the team's single editing surface is the spreadsheet. Run after editing:

    python tools/build_content.py

Validates ids, required columns, settings, groups, and warns on missing images.
Exits non-zero (without writing) on blocking errors.
"""
import json, os, sys
from openpyxl import load_workbook

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

def questionnaire_section_ids():
    """Ordered ids of questionnaire sections in config.json (for scoping
    questions). First entry is the default home for un-tagged questions."""
    try:
        cfg = json.load(open(os.path.join(ROOT, "config", "config.json")))
        return [s["id"] for s in cfg.get("sections", []) if s.get("type") == "questionnaire"]
    except Exception:
        return []

PROMPT_FOLDER = "images/prompts"

def resolve_image(raw):
    """'image' cells (questions / discussion / likert_stimuli) accept either a
    bare filename (resolved against PROMPT_FOLDER) or a full path (containing
    '/'), kept as-is for backward compatibility with rows already written as
    images/prompts/xx.jpg."""
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
    settings = {
        "likert_points": as_int(kv.get("likert_points"), 5, "[settings] likert_points"),
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

    # ---------- questions (questionnaire content) ----------
    # Long format like the registration tab: one row per choice, the question id
    # repeated down the rows. The FIRST row for an id is its header (type/prompt/
    # image/has_other/word limits); every row (header included) may carry one
    # choice_text. A repeated id means "same question", not a duplicate.
    recs, _ = read_sheet(wb, "questions")
    q_secs = questionnaire_section_ids()
    default_q_sec = q_secs[0] if q_secs else None
    TYPE_ALIASES = {
        "single_choice": "single_choice", "single-choice": "single_choice", "single": "single_choice",
        "multiple_choice": "multiple_choice", "multiple-choice": "multiple_choice",
        "multi_choice": "multiple_choice", "multi-choice": "multiple_choice", "multi": "multiple_choice",
        "word_prompt": "word_prompt", "word-prompt": "word_prompt", "word": "word_prompt",
    }
    CHOICE_TYPES = ("single_choice", "multiple_choice")
    order, byid = [], {}
    for r in recs:
        rid, row = s(r.get("id")), r["__row"]
        if not rid:
            errors.append(f"[questions row {row}] missing id "
                          f"(every row, including extra choice rows, needs the question id).")
            continue
        if rid not in byid:
            raw_type = s(r.get("type")).lower()
            qtype = TYPE_ALIASES.get(raw_type)
            if qtype is None:
                errors.append(f"[questions row {row}] question '{rid}' has invalid or missing type "
                              f"'{s(r.get('type'))}' (use single_choice | multiple_choice | word_prompt).")
            byid[rid] = {"id": rid, "row": row, "type": qtype,
                         "section": s(r.get("section")) or default_q_sec,
                         "prompt": s(r.get("prompt")), "image": resolve_image(r.get("image")),
                         "has_other": as_bool(r.get("has_other"), False),
                         "max_words_raw": r.get("max_words"), "min_words_raw": r.get("min_words"),
                         "choices": []}
            order.append(rid)
        ct = s(r.get("choice_text"))
        if ct:
            byid[rid]["choices"].append(ct)

    clean = []
    for rid in order:
        q = byid[rid]
        where = f"[questions '{rid}']"
        if q["type"] is None:
            continue  # invalid type already reported
        if q_secs and q["section"] not in q_secs:
            errors.append(f"{where} section '{q['section']}' is not a questionnaire section "
                          f"(valid: {', '.join(q_secs)}).")
        if not q["prompt"]:
            errors.append(f"{where} missing prompt.")
        check_image(q["image"], where)
        rec = {"id": rid, "section": q["section"], "type": q["type"],
               "prompt": q["prompt"], "image": q["image"]}
        if q["type"] in CHOICE_TYPES:
            if len(q["choices"]) < 2:
                errors.append(f"{where} needs at least 2 choices (has {len(q['choices'])}). "
                              f"Add a row per choice with the same id.")
            rec["choices"] = q["choices"]
            rec["has_other"] = q["has_other"]
        else:  # word_prompt
            maxw = as_int(q["max_words_raw"], 5, f"{where} max_words")
            minw = as_int(q["min_words_raw"], 1, f"{where} min_words")
            if minw < 1: errors.append(f"{where} min_words must be >= 1.")
            if maxw < minw: errors.append(f"{where} max_words < min_words.")
            if q["choices"]:
                warnings.append(f"{where} is a word_prompt but has choice_text rows — they are ignored.")
            if q["has_other"]:
                warnings.append(f"{where} has_other is ignored on a word_prompt.")
            rec["max_words"] = maxw
            rec["min_words"] = minw
        clean.append(rec)
    content["questions"] = clean

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

    if errors:
        print("BUILD FAILED — fix these and re-run:\n  - " + "\n  - ".join(errors))
        if warnings: print("\nWarnings:\n  - " + "\n  - ".join(warnings))
        sys.exit(1)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(content, open(OUT, "w"), indent=2, ensure_ascii=False)
    counts = ", ".join(f"{k}={len(v)}" for k, v in content.items() if isinstance(v, list))
    print(f"OK — wrote {os.path.relpath(OUT, ROOT)}  ({counts})")
    qtypes = {}
    for q in content["questions"]:
        qtypes[q["type"]] = qtypes.get(q["type"], 0) + 1
    qsummary = ", ".join(f"{t}={n}" for t, n in qtypes.items()) or "none"
    print(f"   questions: {qsummary} | likert={settings['likert_points']}pt")
    if warnings:
        print("Warnings (non-blocking):\n  - " + "\n  - ".join(warnings))

if __name__ == "__main__":
    main()
