"""
app.py — Flood study control dashboard (Phase 6).

Quick-look analytics over live Firebase data. Attribute filters are derived
from config.json (live), so adding a participant_field shows up here with no
code change. The Bradley-Terry fit is an approximate sanity-check; the clean
comparison export (Export tab) is the real deliverable for your BT pipeline.

Run:  streamlit run dashboard/app.py
"""
import io
import sqlite3

import matplotlib.pyplot as plt
import pandas as pd
import streamlit as st

import analysis as A
import firebase_io as F

st.set_page_config(page_title="Flood Study Dashboard", layout="wide")


# ------------------------------- data loading -------------------------------
@st.cache_data(ttl=300)
def get_data():
    config, source = F.load_config()
    raw = F.load_raw()
    return config, source, raw


col_a, col_b = st.columns([4, 1])
col_a.title("Flood Risk Communication — Dashboard")
if col_b.button("↻ Refresh data"):
    st.cache_data.clear()
    st.rerun()

try:
    config, cfg_source, raw = get_data()
except Exception as e:
    st.error(f"Could not load data: {e}")
    st.stop()

pdf_all = F.participants_df(raw["participants"], config)
labels = F.attribute_labels(config)
field_ids = [f["id"] for f in config.get("participant_fields", [])]
field_label = {f["id"]: f.get("label", f["id"]) for f in config.get("participant_fields", [])}

# ------------------------------- sidebar -------------------------------
st.sidebar.caption(f"Config source: {cfg_source}")
sessions = sorted([s for s in pdf_all["session"].dropna().unique()]) if len(pdf_all) else []
session_choices = ["(all sessions)"] + sessions
session = st.sidebar.selectbox("Session", session_choices)


def by_session(df):
    if df is None or len(df) == 0 or session == "(all sessions)":
        return df
    return df[df["session"] == session] if "session" in df.columns else df


pdf = by_session(pdf_all)


def relabel(df, fid):
    """Map a field's stored values to human text; blanks -> (not set)."""
    if fid not in df.columns:
        return df
    df = df.copy()
    df[fid] = df[fid].map(lambda v: labels.get(fid, {}).get(v, v) if pd.notna(v) and v != "" else "(not set)")
    return df


tabs = st.tabs(["Overview", "Word clouds", "Likert", "Pairwise rankings", "Export"])

# =============================== OVERVIEW ===============================
with tabs[0]:
    st.subheader("Participation")
    n = len(pdf)
    n_sections = len(config["sections"])
    done = int((pd.to_numeric(pdf["section_idx"], errors="coerce") >= n_sections).sum()) if n else 0
    c1, c2, c3 = st.columns(3)
    c1.metric("Participants", n)
    c2.metric("Completed", done)
    c3.metric("In progress", n - done)

    if n:
        st.markdown("**Where participants are now**")
        prog = pd.to_numeric(pdf["section_idx"], errors="coerce").fillna(0).astype(int)
        prog_named = prog.map(lambda i: config["sections"][i]["id"] if i < n_sections else "finished")
        st.bar_chart(prog_named.value_counts())

        st.markdown("**Breakdown by attribute**")
        pick = st.selectbox("Attribute", field_ids, format_func=lambda x: field_label.get(x, x), key="ov_attr")
        st.bar_chart(relabel(pdf, pick)[pick].value_counts())
    else:
        st.info("No participants in this session yet.")

# =============================== WORD CLOUDS ===============================
with tabs[1]:
    st.subheader("Word associations")
    wl = F.words_long(raw["word_responses"], pdf_all)
    wl = by_session(wl)
    if wl is None or len(wl) == 0:
        st.info("No word responses in this session yet.")
    else:
        prompts = {p["id"]: p.get("text", p["id"])
                   for s in config["sections"] if s["type"] == "word_association" for p in s.get("prompts", [])}
        pid = st.selectbox("Prompt", list(prompts.keys()), format_func=lambda x: prompts.get(x, x))
        group = st.selectbox("Group by", ["(none)"] + field_ids,
                             format_func=lambda x: "(none)" if x == "(none)" else field_label.get(x, x))
        gfield = None if group == "(none)" else group
        wl_g = relabel(wl, gfield) if gfield else wl
        freqs = A.word_frequencies(wl_g, prompt_id=pid, group_field=gfield)

        try:
            from wordcloud import WordCloud
            have_wc = True
        except Exception:
            have_wc = False
            st.warning("Install `wordcloud` for image clouds; showing frequency tables instead.")

        for gval, counter in freqs.items():
            if not counter:
                continue
            st.markdown(f"**{gval}**  ·  {sum(counter.values())} words")
            if have_wc:
                wc = WordCloud(width=800, height=320, background_color="white",
                               colormap="viridis").generate_from_frequencies(counter)
                fig, ax = plt.subplots(figsize=(8, 3.2))
                ax.imshow(wc, interpolation="bilinear"); ax.axis("off")
                st.pyplot(fig); plt.close(fig)
            else:
                st.dataframe(pd.DataFrame(counter.most_common(), columns=["word", "count"]),
                             use_container_width=True, hide_index=True)

# =============================== LIKERT ===============================
with tabs[2]:
    st.subheader("Likert assessment")
    al = F.assessments_long(raw["assessments"], config, pdf_all)
    al = by_session(al)
    dims = [d["id"] for d in config.get("likert", {}).get("dimensions", [])]
    if al is None or len(al) == 0:
        st.info("No assessments in this session yet.")
    else:
        summ = A.likert_summary(al, dims)
        stim_titles = {s["id"]: (s.get("title") or s["id"])
                       for sec in config["sections"] if sec["type"] == "likert" for s in sec.get("stimuli", [])}
        summ["stimulus"] = summ["stimulus_id"].map(lambda x: stim_titles.get(x, x))
        st.markdown("**Mean rating by stimulus × dimension**")
        pivot = summ.pivot(index="stimulus", columns="dimension", values="mean").round(2)
        st.dataframe(pivot, use_container_width=True)
        st.bar_chart(pivot)
        with st.expander("Counts and standard deviations"):
            st.dataframe(summ[["stimulus", "dimension", "n", "mean", "sd"]].round(2),
                         use_container_width=True, hide_index=True)

# =============================== PAIRWISE ===============================
with tabs[3]:
    st.subheader("Pairwise rankings (quick-look Bradley-Terry)")
    st.caption("Approximate sanity-check using P(a>b)=sigmoid(strength_a−strength_b). "
               "Use the Export tab for the clean comparisons that feed your full BT pipeline.")

    def pairwise_block(node, item_set_type, title):
        df = F.comparisons_df(raw[node], pdf_all)
        df = by_session(df)
        st.markdown(f"### {title}")
        if df is None or len(df) == 0:
            st.info("No comparisons yet."); return
        item_ids = []
        for s in config["sections"]:
            if s["type"] == item_set_type:
                item_ids = [it["id"] for it in config["item_sets"][s["item_set"]].get("items", [])]
        labels_map = {}
        for s in config["sections"]:
            if s["type"] == item_set_type:
                for it in config["item_sets"][s["item_set"]].get("items", []):
                    labels_map[it["id"]] = it.get("label") or it["id"]

        wl_pairs = F.comparisons_to_winner_loser(df)
        fit = A.bt_fit(wl_pairs, item_ids)
        fit.insert(1, "label", fit["item"].map(lambda x: labels_map.get(x, x)))

        nc, comps, iso = A.graph_connectivity(wl_pairs, item_ids)
        pb = A.position_bias(df)
        c1, c2, c3 = st.columns(3)
        c1.metric("Comparisons", len(df))
        c2.metric("Graph components", nc, help="1 = fully connected; >1 means BT scores aren't comparable across groups")
        c3.metric("Left-win rate", f"{pb['left_win_rate']:.2f}", help=f"binomial p={pb['p_value']:.3f} vs 0.5 (position bias)")
        if nc > 1:
            st.warning(f"Comparison graph has {nc} disconnected components — rankings are not comparable across them. Isolated: {iso}")

        st.dataframe(fit[["rank", "label", "item", "strength", "n_comparisons", "wins", "win_rate"]]
                     .round({"strength": 3, "win_rate": 3}),
                     use_container_width=True, hide_index=True)
        ranked = fit.dropna(subset=["strength"]).sort_values("strength")
        fig, ax = plt.subplots(figsize=(7, max(2.5, 0.35 * len(ranked))))
        ax.barh(ranked["label"], ranked["strength"], color="#0E7C86")
        ax.set_xlabel("Bradley-Terry strength (logit)"); ax.axvline(0, color="#999", lw=0.8)
        st.pyplot(fig); plt.close(fig)

    pairwise_block("visual_comparisons", "visual_pairwise", "Visual")
    st.divider()
    pairwise_block("text_comparisons", "text_pairwise", "Text")

# =============================== EXPORT ===============================
with tabs[3 + 1]:
    st.subheader("Export")
    st.caption("Filtered to the selected session. CSV per table, plus a single SQLite .db for your BT pipeline.")

    pdf_x = by_session(pdf_all)
    tables = {
        "participants": pdf_x,
        "word_responses": by_session(F.words_long(raw["word_responses"], pdf_all)),
        "assessments": by_session(F.assessments_long(raw["assessments"], config, pdf_all)),
        "visual_comparisons": by_session(F.comparisons_df(raw["visual_comparisons"], pdf_all)),
        "text_comparisons": by_session(F.comparisons_df(raw["text_comparisons"], pdf_all)),
    }
    tag = "all" if session == "(all sessions)" else session

    st.markdown("**CSV (per table)**")
    for name, df in tables.items():
        if df is not None and len(df):
            st.download_button(f"⬇ {name}.csv", df.to_csv(index=False).encode("utf-8"),
                               file_name=f"{name}_{tag}.csv", mime="text/csv", key=f"csv_{name}")
        else:
            st.caption(f"{name}: (no rows)")

    st.markdown("**SQLite (.db, all tables)**")
    buf = io.BytesIO()
    con = sqlite3.connect(":memory:")
    for name, df in tables.items():
        (df if (df is not None and len(df)) else pd.DataFrame()).to_sql(name, con, if_exists="replace", index=False)
    # dump in-memory db to bytes
    tmp = sqlite3.connect("export_tmp.db")
    con.backup(tmp); tmp.close(); con.close()
    with open("export_tmp.db", "rb") as fh:
        st.download_button(f"⬇ flood_study_{tag}.db", fh.read(),
                           file_name=f"flood_study_{tag}.db", mime="application/x-sqlite3")
