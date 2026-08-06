"""
analysis.py — quick-look analytics for the control dashboard.

The Bradley-Terry fit here uses the SAME probability model as the AI-voter
training: P(a beats b) = sigmoid(strength_a - strength_b). The difference is
that strengths are free per-item parameters fit by maximum likelihood to the
human comparisons (no feature extractor, no generalization to unseen items).

This is a fast sanity-check / monitoring tool, NOT the full BT pipeline.
The headline deliverable is the clean comparison export (see firebase_io /
the Export tab), which feeds your proper BT workflow.
"""
from collections import Counter, defaultdict
import numpy as np
import pandas as pd


# --------------------------------------------------------------------------
# Bradley-Terry: MLE of per-item strengths under P(a>b)=sigmoid(beta_a-beta_b)
# --------------------------------------------------------------------------
def bt_fit(comparisons, item_ids, reg=1e-3):
    """
    comparisons : iterable of (winner_id, loser_id)
    item_ids    : list of all item ids to rank
    reg         : L2 strength penalty (keeps betas finite under separation)

    Returns a DataFrame: item, strength, rank, n_comparisons, wins, win_rate
    Strengths are centered (mean 0) for identifiability.
    """
    from scipy.optimize import minimize

    item_ids = list(item_ids)
    idx = {it: i for i, it in enumerate(item_ids)}
    n = len(item_ids)

    pairs = [(idx[w], idx[l]) for (w, l) in comparisons if w in idx and l in idx]
    counts = np.zeros(n, dtype=int)   # times each item appeared
    wins = np.zeros(n, dtype=int)
    for w, l in pairs:
        counts[w] += 1; counts[l] += 1; wins[w] += 1

    out = pd.DataFrame({"item": item_ids,
                        "n_comparisons": counts, "wins": wins,
                        "win_rate": np.where(counts > 0, wins / np.maximum(counts, 1), np.nan)})

    if not pairs:
        out["strength"] = np.nan
        out["rank"] = np.nan
        return out.sort_values("item").reset_index(drop=True)

    W = np.array(pairs)  # columns: winner, loser

    def negll(beta):
        d = beta[W[:, 0]] - beta[W[:, 1]]          # strength_winner - strength_loser
        ll = -np.logaddexp(0.0, -d).sum()          # sum log sigmoid(d)
        return -ll + 0.5 * reg * np.dot(beta, beta)

    def grad(beta):
        d = beta[W[:, 0]] - beta[W[:, 1]]
        one_minus_p = 1.0 / (1.0 + np.exp(d))      # 1 - sigmoid(d)
        g = np.zeros(n)
        np.add.at(g, W[:, 0], -one_minus_p)
        np.add.at(g, W[:, 1], one_minus_p)
        return g + reg * beta

    res = minimize(negll, np.zeros(n), jac=grad, method="L-BFGS-B")
    beta = res.x - res.x.mean()                    # center
    out["strength"] = beta
    out["rank"] = out["strength"].rank(ascending=False, method="min").astype("Int64")
    return out.sort_values("strength", ascending=False).reset_index(drop=True)


# --------------------------------------------------------------------------
# Diagnostics: comparison-graph connectivity + position (left/right) bias
# --------------------------------------------------------------------------
def graph_connectivity(comparisons, item_ids):
    """Union-find over compared items. Returns (n_components, components, isolated)."""
    item_ids = list(item_ids)
    parent = {it: it for it in item_ids}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]; x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    seen = set()
    for w, l in comparisons:
        if w in parent and l in parent:
            union(w, l); seen.add(w); seen.add(l)

    comps = defaultdict(list)
    for it in item_ids:
        comps[find(it)].append(it)
    components = list(comps.values())
    isolated = [it for it in item_ids if it not in seen]
    return len(components), components, isolated


def position_bias(df):
    """
    df: comparison rows with columns winner, shown_left, shown_right.
    Returns dict with left_win_rate, n, and a two-sided binomial p-value vs 0.5.
    """
    d = df.dropna(subset=["winner", "shown_left", "shown_right"])
    n = len(d)
    if n == 0:
        return {"n": 0, "left_wins": 0, "left_win_rate": np.nan, "p_value": np.nan}
    left_wins = int((d["winner"] == d["shown_left"]).sum())
    try:
        from scipy.stats import binomtest
        p = binomtest(left_wins, n, 0.5).pvalue
    except Exception:
        from scipy.stats import binom_test
        p = binom_test(left_wins, n, 0.5)
    return {"n": n, "left_wins": left_wins, "left_win_rate": left_wins / n, "p_value": p}


# --------------------------------------------------------------------------
# Word association + Likert aggregation
# --------------------------------------------------------------------------
def word_frequencies(words_long, prompt_id=None, group_field=None):
    """
    words_long: DataFrame with columns uid, prompt_id, word, + participant attributes.
    Returns {group_value: Counter(word->count)}. group_value is "(all)" when ungrouped.
    """
    df = words_long
    if prompt_id is not None:
        df = df[df["prompt_id"] == prompt_id]
    out = {}
    if group_field and group_field in df.columns:
        for gval, sub in df.groupby(group_field):
            out[str(gval)] = Counter(sub["word"].str.lower())
    else:
        out["(all)"] = Counter(df["word"].str.lower())
    return out


def likert_summary(assess_long, dims):
    """
    assess_long: DataFrame with uid, stimulus_id, one column per dimension id.
    Returns DataFrame: stimulus_id, dimension, n, mean, sd.
    """
    rows = []
    for stim, sub in assess_long.groupby("stimulus_id"):
        for d in dims:
            if d in sub.columns:
                vals = pd.to_numeric(sub[d], errors="coerce").dropna()
                rows.append({"stimulus_id": stim, "dimension": d,
                             "n": len(vals), "mean": vals.mean(), "sd": vals.std(ddof=1)})
    return pd.DataFrame(rows)
