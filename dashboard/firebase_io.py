"""
firebase_io.py — data access for the dashboard.

- Connects to Firebase with the Admin SDK (serviceAccountKey.json).
- Fetches the LIVE config.json + content.json from Hosting (so attribute
  filters, dimensions, and labels always match what participants saw), falling
  back to the local repo copies if offline.
- Derives the merged config the same way app/config-loader.js does (profile
  questions -> participant_fields, content -> sections, sparse Likert anchors).
- Reshapes the raw RTDB trees into tidy DataFrames, and builds the per-
  respondent attribute table the cross-filter engine runs on.

Schema (current): participants, word_responses, assessments, choices.
Pairwise/comparison nodes were removed in the overhaul and are not read here.
"""
import json
import os
import re

import pandas as pd
import requests

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
CRED_JS = os.path.join(ROOT, "app", "credentials.js")
HOSTING_URL = os.environ.get("DASHBOARD_HOSTING_URL", "https://s4a-risk-viz.web.app")
SERVICE_KEY = os.path.join(os.path.dirname(__file__), "serviceAccountKey.json")

# Inline markup used in study-authored text (mirror of config-loader.js). We
# only need to strip it for display / grouping / filtering.
_RE_COLOR = re.compile(r"\[\[([a-z]+):([\s\S]+?)\]\]")
_RE_BOLD = re.compile(r"\*\*([\s\S]+?)\*\*")


def strip_markup(v):
    v = "" if v is None else str(v)
    v = _RE_COLOR.sub(r"\2", v)
    v = _RE_BOLD.sub(r"\1", v)
    return v


# --------------------------- Firebase connection ---------------------------
def _read_credentials_js():
    """Pull databaseURL out of app/credentials.js so we don't duplicate config.
    These are public identifiers, not secrets."""
    text = open(CRED_JS, encoding="utf-8").read()
    db = re.search(r'databaseURL:\s*"([^"]+)"', text)
    pid = re.search(r'projectId:\s*"([^"]+)"', text)
    if not db or "PASTE_HERE" in db.group(1):
        raise RuntimeError("databaseURL not set in app/credentials.js")
    return db.group(1), (pid.group(1) if pid else None)


def init_firebase():
    import firebase_admin
    from firebase_admin import credentials, db as _db
    if not firebase_admin._apps:
        if not os.path.exists(SERVICE_KEY):
            raise RuntimeError(f"Missing {SERVICE_KEY} (see dashboard/README.md).")
        database_url, _ = _read_credentials_js()
        firebase_admin.initialize_app(credentials.Certificate(SERVICE_KEY),
                                      {"databaseURL": database_url})
    return _db


def load_raw():
    """Return the raw dicts for each record type in the current schema."""
    db = init_firebase()
    nodes = ["participants", "word_responses", "assessments", "choices"]
    return {n: (db.reference(n).get() or {}) for n in nodes}


# ------------------------------ config (live) ------------------------------
def _anchors_for(points, lo, mid, hi):
    lo = lo or "Not at all"
    mid = mid or "Partially"
    hi = hi or "Very much"
    midpos = (points - 1) // 2
    return [lo if i == 0 else hi if i == points - 1 else mid if i == midpos else ""
            for i in range(points)]


def _merge_content(cfg, content):
    """Replicate app/config-loader.js mergeContent: attach Excel-derived content
    to the config sections and derive participant_fields from profile questions."""
    if not content:
        return cfg
    settings = content.get("settings") or {}
    cfg["settings"] = settings

    pts = settings.get("likert_points") or cfg.get("likert", {}).get("points") or 5
    cfg.setdefault("likert", {})["points"] = pts
    cfg["likert"]["anchors"] = _anchors_for(pts, settings.get("anchor_low"),
                                            settings.get("anchor_mid"), settings.get("anchor_high"))

    questions = content.get("questions") or []
    wc_prompts = content.get("wordcloud") or []
    stimuli = content.get("stimuli") or []
    sections = cfg.get("sections", [])
    first_q = next((s["id"] for s in sections if s.get("type") == "questionnaire"), None)
    first_wc = next((s["id"] for s in sections if s.get("type") == "wordcloud"), None)

    for s in sections:
        t = s.get("type")
        if t == "questionnaire":
            s["questions"] = [q for q in questions if (q.get("section") or first_q) == s["id"]]
        elif t == "wordcloud":
            s["prompts"] = [p for p in wc_prompts if (p.get("section") or first_wc) == s["id"]]
        elif t == "assessment":
            s["stimuli"] = stimuli
        elif t == "notice":
            s["title"] = settings.get(s.get("title_key")) or ""
            s["body"] = settings.get(s.get("body_key")) or ""

    # Derive participant_fields from profile-flagged questions (values are plain
    # choice texts, matching what the app stores in participants/fields).
    pf = []
    for s in sections:
        if s.get("type") != "questionnaire":
            continue
        for q in s.get("questions", []):
            if q.get("profile") and isinstance(q.get("choices"), list):
                opts = [{"value": strip_markup(c), "text": strip_markup(c)} for c in q["choices"]]
                pf.append({"id": q["id"], "label": q.get("prompt", q["id"]), "type": "select",
                           "multi": q.get("type") == "multiple_choice", "options": opts})
    cfg["participant_fields"] = pf
    return cfg


def load_config():
    """Fetch live config + content from Hosting; fall back to local repo files.
    Returns (config_dict, source_string)."""
    try:
        cfg = requests.get(f"{HOSTING_URL}/config/config.json", timeout=8).json()
        try:
            content = requests.get(f"{HOSTING_URL}/config/content.json", timeout=8).json()
        except Exception:
            content = None
        return _merge_content(cfg, content), f"live ({HOSTING_URL})"
    except Exception:
        cfg = json.load(open(os.path.join(ROOT, "config", "config.json"), encoding="utf-8"))
        cpath = os.path.join(ROOT, "config", "content.json")
        content = json.load(open(cpath, encoding="utf-8")) if os.path.exists(cpath) else None
        return _merge_content(cfg, content), "local repo files (offline)"


# ------------------------------ helpers ------------------------------
def choice_questions(config):
    """All single/multiple-choice questions across questionnaire sections,
    in flow order. These are the filterable + distributable questions."""
    out = []
    for s in config.get("sections", []):
        if s.get("type") == "questionnaire":
            for q in s.get("questions", []):
                if q.get("type") in ("single_choice", "multiple_choice"):
                    out.append(q)
    return out


def word_prompts(config):
    """{prompt_id: prompt_text} across word_prompt questions AND wordcloud
    sections (both write to word_responses)."""
    out = {}
    for s in config.get("sections", []):
        if s.get("type") == "questionnaire":
            for q in s.get("questions", []):
                if q.get("type") == "word_prompt":
                    out[q["id"]] = q.get("prompt", q["id"])
        elif s.get("type") == "wordcloud":
            for p in s.get("prompts", []):
                out[p["id"]] = p.get("prompt", p["id"])
    return out


def selected_idxs(rec):
    """Selected option indices from a choices record (multi array/object or
    single)."""
    ci = rec.get("choice_idxs")
    if isinstance(ci, list):
        return [x for x in ci if isinstance(x, int)]
    if isinstance(ci, dict):
        return [x for x in ci.values() if isinstance(x, int)]
    if isinstance(rec.get("choice_idx"), int):
        return [rec["choice_idx"]]
    return []


def _resolve_choice_set(q, rec):
    """A non-profile choice record -> set of selected option texts. The 'Other'
    slot resolves to its typed text (or the literal 'Other' if blank)."""
    if not rec:
        return set()
    opts = q.get("choices") or []
    C = len(opts)
    other = (rec.get("other_text") or "").strip()
    out = set()
    for i in selected_idxs(rec):
        if q.get("has_other") and i == C:
            out.add(other if other else "Other")
        elif 0 <= i < C:
            out.add(strip_markup(opts[i]))
    return out


# ------------------------------ reshaping ------------------------------
def participants_df(participants, config):
    """One row per participant; one column per participant_field id (raw value:
    scalar for single-select, list for multi-select), plus uid, participant_no,
    session, section_idx."""
    field_ids = [f["id"] for f in config.get("participant_fields", [])]
    rows = []
    for uid, p in (participants or {}).items():
        p = p or {}
        row = {"uid": uid, "participant_no": p.get("participant_no"),
               "session": p.get("session"),
               "section_idx": (p.get("progress") or {}).get("section_idx"),
               "created_at": p.get("created_at")}
        fields = p.get("fields") or {}
        for fid in field_ids:
            row[fid] = fields.get(fid)
        rows.append(row)
    return pd.DataFrame(rows)


def attribute_labels(config):
    """{field_id: {value: text}} for relabeling stored values to human text.
    Values already equal their text for derived profile fields, so this is
    mostly identity; kept for symmetry and any hand-authored options."""
    out = {}
    for f in config.get("participant_fields", []):
        out[f["id"]] = {o["value"]: o.get("text", o["value"]) for o in f.get("options", [])}
    return out


def words_long(word_responses, pdf):
    rows = []
    for uid, prompts in (word_responses or {}).items():
        for pid, rec in (prompts or {}).items():
            rec = rec or {}
            for w in rec.get("words", []) or []:
                rows.append({"uid": uid, "prompt_id": pid, "word": w,
                             "session": rec.get("session"), "ts": rec.get("ts")})
    df = pd.DataFrame(rows)
    if len(df) and pdf is not None:
        df = df.merge(pdf.drop(columns=["session"], errors="ignore"), on="uid", how="left")
    return df


def assessments_long(assessments, config, pdf):
    dims = [d["id"] for d in config.get("likert", {}).get("dimensions", [])]
    rows = []
    for uid, stims in (assessments or {}).items():
        for sid, rec in (stims or {}).items():
            rec = rec or {}
            row = {"uid": uid, "stimulus_id": sid, "session": rec.get("session"), "ts": rec.get("ts")}
            for d in dims:
                row[d] = rec.get(d)
            rows.append(row)
    df = pd.DataFrame(rows)
    if len(df) and pdf is not None:
        df = df.merge(pdf.drop(columns=["session"], errors="ignore"), on="uid", how="left")
    return df


def choices_long(choices, config, pdf=None):
    """One row per selected option per respondent (tidy long format, matching
    the app export). 'Other' rows carry choice_text 'Other' + other_text."""
    qmeta = {q["id"]: q for q in choice_questions(config)}
    rows = []
    for uid, byq in (choices or {}).items():
        for qid, rec in (byq or {}).items():
            rec = rec or {}
            q = qmeta.get(qid, {})
            opts = q.get("choices") or []
            C = len(opts)
            typ = rec.get("type") or ("multiple_choice"
                                      if isinstance(rec.get("choice_idxs"), (list, dict)) else "single_choice")
            other = (rec.get("other_text") or "").strip()
            for i in selected_idxs(rec):
                is_other = q.get("has_other") and i == C
                text = "Other" if is_other else (strip_markup(opts[i]) if 0 <= i < C else str(i))
                rows.append({"uid": uid, "question_id": qid, "type": typ, "choice_idx": i,
                             "choice_text": text, "other_text": other if is_other else "",
                             "session": rec.get("session"), "ts": rec.get("ts")})
    df = pd.DataFrame(rows)
    if len(df) and pdf is not None:
        df = df.merge(pdf.drop(columns=["session"], errors="ignore"), on="uid", how="left")
    return df


def respondent_attributes(config, raw):
    """Build the cross-filter universe.

    Returns:
      attr        : {uid: {question_id: set(selected value texts)}}
      session_of  : {uid: session}
      questions   : ordered list of choice-question dicts (id, prompt, choices,
                    has_other, profile, multi)
    Profile questions read participants/fields; the rest read the choices node.
    """
    participants = raw.get("participants") or {}
    choices = raw.get("choices") or {}
    qs = choice_questions(config)
    attr, session_of = {}, {}
    for uid, p in participants.items():
        p = p or {}
        session_of[uid] = p.get("session")
        fields = p.get("fields") or {}
        row = {}
        for q in qs:
            qid = q["id"]
            if q.get("profile"):
                fv = fields.get(qid)
                if isinstance(fv, list):
                    row[qid] = set(str(x) for x in fv)
                elif fv not in (None, ""):
                    row[qid] = {str(fv)}
                else:
                    row[qid] = set()
            else:
                row[qid] = _resolve_choice_set(q, (choices.get(uid) or {}).get(qid))
        attr[uid] = row
    meta = [{"id": q["id"], "prompt": strip_markup(q.get("prompt", q["id"])),
             "choices": [strip_markup(c) for c in (q.get("choices") or [])],
             "has_other": bool(q.get("has_other")), "profile": bool(q.get("profile")),
             "multi": q.get("type") == "multiple_choice"} for q in qs]
    return attr, session_of, meta


def stringify_lists(df):
    """CSV-friendly copy: join list-valued cells (multi-select attributes) with
    ';' so exports stay one row per record."""
    df = df.copy()
    for col in df.columns:
        df[col] = df[col].map(lambda v: ";".join(map(str, v)) if isinstance(v, list) else v)
    return df
