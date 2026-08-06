"""
firebase_io.py — data access for the dashboard.

- Connects to Firebase with the Admin SDK (serviceAccountKey.json).
- Fetches the LIVE config.json + content.json from Hosting (so attribute
  filters, Likert dimensions, and item labels always match what participants
  saw), falling back to the local repo copies if offline.
- Reshapes the raw RTDB trees into tidy DataFrames.
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


# --------------------------- Firebase connection ---------------------------
def _read_credentials_js():
    """Pull databaseURL (and projectId) out of app/credentials.js so we don't
    duplicate config. These are public identifiers, not secrets."""
    text = open(CRED_JS).read()
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
    """Return the raw dicts for each record type."""
    db = init_firebase()
    nodes = ["participants", "word_responses", "assessments",
             "visual_comparisons", "text_comparisons"]
    return {n: (db.reference(n).get() or {}) for n in nodes}


# ------------------------------ config (live) ------------------------------
def _merge_content(cfg, content):
    if not content:
        return cfg
    if isinstance(content.get("word_prompts"), list):
        for s in cfg["sections"]:
            if s["type"] == "word_association":
                s["prompts"] = content["word_prompts"]
    if isinstance(content.get("likert_stimuli"), list):
        for s in cfg["sections"]:
            if s["type"] == "likert":
                s["stimuli"] = content["likert_stimuli"]
    for s in cfg["sections"]:
        if s["type"] == "visual_pairwise" and isinstance(content.get("visual_items"), list):
            cfg.get("item_sets", {}).get(s["item_set"], {})["items"] = content["visual_items"]
        if s["type"] == "text_pairwise" and isinstance(content.get("text_items"), list):
            cfg.get("item_sets", {}).get(s["item_set"], {})["items"] = content["text_items"]
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
        cfg = json.load(open(os.path.join(ROOT, "config", "config.json")))
        cpath = os.path.join(ROOT, "config", "content.json")
        content = json.load(open(cpath)) if os.path.exists(cpath) else None
        return _merge_content(cfg, content), "local repo files (offline)"


# ------------------------------ reshaping ------------------------------
def participants_df(participants, config):
    """One row per participant; one column per participant_field id (raw value),
    plus uid, session, section_idx. Driven entirely by config → new fields appear
    automatically."""
    field_ids = [f["id"] for f in config.get("participant_fields", [])]
    rows = []
    for uid, p in (participants or {}).items():
        p = p or {}
        row = {"uid": uid, "session": p.get("session"),
               "section_idx": (p.get("progress") or {}).get("section_idx"),
               "created_at": p.get("created_at")}
        fields = p.get("fields") or {}
        for fid in field_ids:
            row[fid] = fields.get(fid)
        rows.append(row)
    return pd.DataFrame(rows)


def attribute_labels(config):
    """{field_id: {value: text}} for relabeling stored values to human text."""
    out = {}
    for f in config.get("participant_fields", []):
        out[f["id"]] = {o["value"]: o.get("text", o["value"]) for o in f.get("options", [])}
    return out


def words_long(word_responses, pdf):
    rows = []
    for uid, prompts in (word_responses or {}).items():
        for pid, rec in (prompts or {}).items():
            for w in (rec or {}).get("words", []) or []:
                rows.append({"uid": uid, "prompt_id": pid, "word": w, "session": (rec or {}).get("session")})
    df = pd.DataFrame(rows)
    return df.merge(pdf.drop(columns=["session"], errors="ignore"), on="uid", how="left") if len(df) else df


def assessments_long(assessments, config, pdf):
    dims = [d["id"] for d in config.get("likert", {}).get("dimensions", [])]
    rows = []
    for uid, stims in (assessments or {}).items():
        for sid, rec in (stims or {}).items():
            rec = rec or {}
            row = {"uid": uid, "stimulus_id": sid, "session": rec.get("session")}
            for d in dims:
                row[d] = rec.get(d)
            rows.append(row)
    df = pd.DataFrame(rows)
    return df.merge(pdf.drop(columns=["session"], errors="ignore"), on="uid", how="left") if len(df) else df


def comparisons_df(node_dict, pdf=None):
    rows = []
    for key, c in (node_dict or {}).items():
        c = c or {}
        rows.append({"id": key, "uid": c.get("uid"), "item_a": c.get("item_a"),
                     "item_b": c.get("item_b"), "winner": c.get("winner"),
                     "shown_left": c.get("shown_left"), "shown_right": c.get("shown_right"),
                     "session": c.get("session"), "ts": c.get("ts")})
    df = pd.DataFrame(rows)
    if len(df) and pdf is not None:
        df = df.merge(pdf.drop(columns=["session"], errors="ignore"), on="uid", how="left")
    return df


def comparisons_to_winner_loser(df):
    """Convert item_a/item_b/winner rows into (winner, loser) tuples for bt_fit."""
    out = []
    for _, r in df.iterrows():
        if pd.isna(r["winner"]):
            continue
        loser = r["item_b"] if r["winner"] == r["item_a"] else r["item_a"]
        out.append((r["winner"], loser))
    return out
