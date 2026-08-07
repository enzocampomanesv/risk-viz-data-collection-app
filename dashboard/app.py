"""
app.py — Flood study dashboard.

Quick-look analytics + clean export over the live Firebase data, with a
cross-filter that restricts every analytical view to the respondents matching
conditions on their answers (e.g. impacts includes 'Property damage' AND
'Stress'). Config is fetched live from Hosting so filters/labels match what
participants saw.

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
attr, session_of, qmeta = F.respondent_attributes(config, raw)
qmeta_by_id = {q["id"]: q for q in qmeta}

# ------------------------------- sidebar: session + cross-filter -------------------------------
st.sidebar.caption(f"Config source: {cfg_source}")
sessions = sorted([s for s in pdf_all["session"].dropna().unique()]) if len(pdf_all) else []
session = st.sidebar.selectbox("Session", ["(all sessions)"] + sessions)


def in_session(uid):
    return session == "(all sessions)" or session_of.get(uid) == session


def by_session(df):
    if df is None or len(df) == 0 or session == "(all sessions)" or "session" not in df.columns:
        return df
    return df[df["session"] == session]


# Universe of respondents for the current session.
universe = [uid for uid in attr.keys() if in_session(uid)]

st.sidebar.markdown("### Cross-filter")
st.sidebar.caption("Restrict Word clouds, Likert and Choices to respondents matching ALL conditions below.")
n_cond = st.sidebar.number_input("Number of conditions", min_value=0, max_value=6, value=0, step=1)

conditions = []
for k in range(int(n_cond)):
    st.sidebar.markdown(f"**Condition {k + 1}**")
    qid = st.sidebar.selectbox("Question", [q["id"] for q in qmeta],
                               format_func=lambda x: qmeta_by_id[x]["prompt"], key=f"cond_q_{k}")
    q = qmeta_by_id[qid]
    # value options: config options (+ Other) then any observed extras (typed Other)
    observed = set()
    for uid in universe:
        observed |= attr.get(uid, {}).get(qid, set())
    opts = list(q.get("choices") or [])
    if q.get("has_other"):
        opts.append("Other")
    for v in sorted(observed):
        if v not in opts:
            opts.append(v)
    vals = st.sidebar.multiselect("Values", opts, key=f"cond_v_{k}")
    mode = "any"
    if q.get("multi"):
        mode = st.sidebar.radio("Match", ["includes any", "includes all"], key=f"cond_m_{k}",
                                horizontal=True) == "includes all" and "all" or "any"
    conditions.append({"qid": qid, "values": set(vals), "mode": mode})

matched = A.apply_filters(attr, universe, conditions)
active_conditions = [c for c in conditions if c["values"]]
if active_conditions:
    st.sidebar.success(f"{len(matched)} of {len(universe)} respondents match")
else:
    st.sidebar.caption(f"{len(universe)} respondents in scope (no active filter)")


def filt(df):
    """Session filter + cross-filter (by uid) for a long dataframe."""
    df = by_session(df)
    if df is None or len(df) == 0:
        return df
    if active_conditions and "uid" in df.columns:
        df = df[df["uid"].isin(matched)]
    return df


def explode_relabel(df, fid):
    """Explode a (possibly list-valued) attribute column into one row per value,
    blanks -> (not set). Used for grouping/breakdowns."""
    if fid not in df.columns:
        return df
    df = df.explode(fid).copy()
    df[fid] = df[fid].map(lambda v: labels.get(fid, {}).get(v, v) if isinstance(v, str) and v != "" else "(not set)")
    return df


tabs = st.tabs(["Overview", "Word clouds", "Likert", "Choices", "Export"])

# =============================== OVERVIEW ===============================
with tabs[0]:
    st.subheader("Participation")
    pdf = by_session(pdf_all)
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

        if field_ids:
            st.markdown("**Breakdown by attribute** (whole session)")
            pick = st.selectbox("Attribute", field_ids, format_func=lambda x: field_label.get(x, x), key="ov_attr")
            counts = explode_relabel(pdf, pick)[pick].value_counts()
            st.bar_chart(counts)
    else:
        st.info("No participants in this session yet.")

# =============================== WORD CLOUDS ===============================
with tabs[1]:
    st.subheader("Word clouds")
    if active_conditions:
        st.caption(f"Filtered: {len(matched)} of {len(universe)} respondents.")
    prompts = F.word_prompts(config)
    wl = filt(F.words_long(raw["word_responses"], pdf_all))
    if not prompts:
        st.info("No word prompts configured.")
    elif wl is None or len(wl) == 0:
        st.info("No word responses for the current session / filter.")
    else:
        pid = st.selectbox("Prompt", list(prompts.keys()), format_func=lambda x: prompts.get(x, x))
        group = st.selectbox("Group by", ["(none)"] + field_ids,
                             format_func=lambda x: "(none)" if x == "(none)" else field_label.get(x, x))
        gfield = None if group == "(none)" else group
        freqs = A.word_frequencies(wl, prompt_id=pid, group_field=gfield)
        try:
            from wordcloud import WordCloud
            have_wc = True
        except Exception:
            have_wc = False
            st.warning("Install `wordcloud` for image clouds; showing frequency tables instead.")

        any_shown = False
        for gval, counter in freqs.items():
            if not counter:
                continue
            any_shown = True
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
        if not any_shown:
            st.info("No words for this prompt in the current scope.")

# =============================== LIKERT ===============================
with tabs[2]:
    st.subheader("Format assessment (Likert)")
    if active_conditions:
        st.caption(f"Filtered: {len(matched)} of {len(universe)} respondents.")
    al = filt(F.assessments_long(raw["assessments"], config, pdf_all))
    dims = [d["id"] for d in config.get("likert", {}).get("dimensions", [])]
    dim_label = {d["id"]: d.get("label", d["id"]) for d in config.get("likert", {}).get("dimensions", [])}
    points = config.get("likert", {}).get("points", 5)
    if al is None or len(al) == 0:
        st.info("No assessments for the current session / filter.")
    else:
        summ = A.likert_summary(al, dims)
        stim_titles = {s["id"]: (s.get("title") or s["id"])
                       for sec in config["sections"] if sec.get("type") == "assessment"
                       for s in sec.get("stimuli", [])}
        summ["stimulus"] = summ["stimulus_id"].map(lambda x: stim_titles.get(x, x))
        summ["dimension"] = summ["dimension"].map(lambda x: dim_label.get(x, x))
        st.markdown(f"**Mean rating by stimulus × dimension** (1–{points})")
        pivot = summ.pivot(index="stimulus", columns="dimension", values="mean").round(2)
        st.dataframe(pivot, use_container_width=True)
        st.bar_chart(pivot)
        with st.expander("Counts and standard deviations"):
            st.dataframe(summ[["stimulus", "dimension", "n", "mean", "sd"]].round(2),
                         use_container_width=True, hide_index=True)

# =============================== CHOICES ===============================
with tabs[3]:
    st.subheader("Choice questions")
    if active_conditions:
        st.caption(f"Filtered: {len(matched)} of {len(universe)} respondents.")
    choice_qs = [q for q in qmeta]  # all single/multiple choice questions
    if not choice_qs:
        st.info("No choice questions configured.")
    else:
        uids = matched if active_conditions else set(universe)
        for q in choice_qs:
            counts, resp = A.choice_distribution(attr, uids, q)
            kind = "select all that apply" if q["multi"] else "single choice"
            tag = " · profile" if q["profile"] else ""
            st.markdown(f"**{q['prompt']}**  <span style='color:#888'>({kind}{tag})</span>",
                        unsafe_allow_html=True)
            if resp == 0:
                st.caption("No responses in the current scope.")
                continue
            rows = []
            for label in A.ordered_option_labels(q, counts):
                c = counts.get(label, 0)
                rows.append({"option": label, "n": c, "% of respondents": round(100 * c / resp) if resp else 0})
            dfc = pd.DataFrame(rows)
            st.dataframe(dfc, use_container_width=True, hide_index=True)
            st.caption(f"{resp} respondents")

# =============================== EXPORT ===============================
with tabs[4]:
    st.subheader("Export")
    st.caption("Filtered to the selected session (not the cross-filter). CSV per table, plus a single SQLite .db.")

    tables = {
        "participants": by_session(pdf_all),
        "word_responses": by_session(F.words_long(raw["word_responses"], pdf_all)),
        "assessments": by_session(F.assessments_long(raw["assessments"], config, pdf_all)),
        "choices": by_session(F.choices_long(raw["choices"], config, pdf_all)),
    }
    # Join list-valued (multi-select) cells so CSV/SQLite stay one row per record.
    tables = {k: (F.stringify_lists(v) if v is not None and len(v) else v) for k, v in tables.items()}
    tag = "all" if session == "(all sessions)" else session

    st.markdown("**CSV (per table)**")
    for name, df in tables.items():
        if df is not None and len(df):
            st.download_button(f"⬇ {name}.csv", df.to_csv(index=False).encode("utf-8"),
                               file_name=f"{name}_{tag}.csv", mime="text/csv", key=f"csv_{name}")
        else:
            st.caption(f"{name}: (no rows)")

    st.markdown("**SQLite (.db, all tables)**")
    con = sqlite3.connect(":memory:")
    for name, df in tables.items():
        (df if (df is not None and len(df)) else pd.DataFrame()).to_sql(name, con, if_exists="replace", index=False)
    tmp = sqlite3.connect("export_tmp.db")
    con.backup(tmp); tmp.close(); con.close()
    with open("export_tmp.db", "rb") as fh:
        st.download_button(f"⬇ flood_study_{tag}.db", fh.read(),
                           file_name=f"flood_study_{tag}.db", mime="application/x-sqlite3")
