"""
analysis.py — aggregation + the cross-filter engine for the dashboard.

The pairwise / Bradley-Terry machinery was removed with the pairwise activity.
What remains: word-frequency and Likert aggregation, choice distributions, and
the cross-filter engine that restricts any view to the respondents matching a
set of conditions on their answers.
"""
from collections import Counter

import pandas as pd


# --------------------------------------------------------------------------
# Cross-filter engine
# --------------------------------------------------------------------------
def apply_filters(attr, uids_universe, conditions):
    """Return the set of uids (subset of uids_universe) matching ALL conditions.

    attr        : {uid: {question_id: set(values)}}  (from respondent_attributes)
    conditions  : list of {"qid": str, "values": set, "mode": "any"|"all"}
                  - "any": respondent's value set intersects the chosen values
                  - "all": chosen values are a subset of the respondent's set
    A condition with an empty value set is ignored. Conditions AND together.
    A respondent who never answered a question has an empty set for it, so any
    non-empty condition on that question excludes them.
    """
    active = [c for c in conditions if c.get("values")]
    matched = set()
    for uid in uids_universe:
        row = attr.get(uid, {})
        ok = True
        for c in active:
            have = row.get(c["qid"], set())
            want = c["values"]
            if c.get("mode") == "all":
                if not want.issubset(have):
                    ok = False
                    break
            else:  # any
                if have.isdisjoint(want):
                    ok = False
                    break
        if ok:
            matched.add(uid)
    return matched


# --------------------------------------------------------------------------
# Choice distribution (single + multiple choice)
# --------------------------------------------------------------------------
def choice_distribution(attr, uids, question):
    """Counts per option over the given uids, plus the number of respondents.

    Returns (counts: Counter{value: n}, respondents: int). Multi-select does not
    sum to respondents, so callers should show 'share of respondents'.
    """
    qid = question["id"]
    counts = Counter()
    respondents = 0
    for uid in uids:
        vals = attr.get(uid, {}).get(qid, set())
        if vals:
            respondents += 1
        for v in vals:
            counts[v] += 1
    return counts, respondents


def ordered_option_labels(question, counts):
    """Option labels in config order, then any observed extras not already
    listed. Observed extras include typed 'Other' free-text values, and the
    literal 'Other' when someone picked Other without typing anything."""
    labels = list(question.get("choices") or [])
    for v in counts:
        if v not in labels:
            labels.append(v)
    return labels


# --------------------------------------------------------------------------
# Word frequencies + Likert aggregation
# --------------------------------------------------------------------------
def word_frequencies(words_long, prompt_id=None, group_field=None):
    """words_long: DataFrame (uid, prompt_id, word, + participant attributes).
    Returns {group_value: Counter(word->count)}; "(all)" when ungrouped.

    For a multi-select group field, explode the (list-valued) column first so a
    participant contributes to every group they belong to (overlapping).
    """
    df = words_long
    if df is None or len(df) == 0:
        return {}
    if prompt_id is not None:
        df = df[df["prompt_id"] == prompt_id]
    if group_field and group_field in df.columns:
        df = df.explode(group_field)
        df = df.copy()
        df[group_field] = df[group_field].map(lambda v: v if isinstance(v, str) and v != "" else "(not set)")
        out = {}
        for gval, sub in df.groupby(group_field):
            out[str(gval)] = Counter(sub["word"].str.lower())
        return out
    return {"(all)": Counter(df["word"].str.lower())}


def likert_summary(assess_long, dims):
    """assess_long: DataFrame (uid, stimulus_id, one column per dimension id).
    Returns DataFrame: stimulus_id, dimension, n, mean, sd."""
    rows = []
    if assess_long is None or len(assess_long) == 0:
        return pd.DataFrame(rows)
    for stim, sub in assess_long.groupby("stimulus_id"):
        for d in dims:
            if d in sub.columns:
                vals = pd.to_numeric(sub[d], errors="coerce").dropna()
                rows.append({"stimulus_id": stim, "dimension": d, "n": len(vals),
                             "mean": vals.mean(), "sd": vals.std(ddof=1) if len(vals) > 1 else 0.0})
    return pd.DataFrame(rows)
