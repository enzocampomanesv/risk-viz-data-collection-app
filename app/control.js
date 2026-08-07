/* =========================================================================
   control.js — host control room (Phase 5).
   Admin-only (Email/Password + `admin` custom claim). Lets the facilitator
   open/close section gates, toggle the gate master switch, set the session,
   start a new workshop (reset gates + new session), watch live participation,
   and broadcast a message to all participants. Vanilla JS, no build step.
   ========================================================================= */

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const SECTION_LABELS = {
  consent: "Consent",
  questionnaire: "Questionnaire", notice: "Notice",
  assessment: "Assessment", wordcloud: "Word cloud"
};
const labelFor = (s) => (s.label ? s.label : (SECTION_LABELS[s.type] || s.id));

const BACK_TOGGLES = [
  { key: "questionnaire", label: "Questionnaire", sub: "control/back_questionnaire" },
  { key: "end",           label: "End screen",    sub: "control/back_end" },
];

function toCSV(rows, cols) {
  const head = cols.join(",");
  const esc = (v) => { v = v == null ? "" : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  return [head].concat(rows.map((r) => cols.map((c) => esc(r[c])).join(","))).join("\n");
}
function downloadText(filename, text, mime = "text/csv") {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}


const Control = {
  db: null,
  config: null,
  user: null,
  state: { gates: {}, gatingEnabled: false, session: "", participants: [], participantsRaw: {} },
  results: null,
  tab: "control",

  el() { return document.getElementById("ctrl"); },

  async boot() {
    try {
      if (typeof firebaseConfig === "undefined" || firebaseConfig.apiKey === "PASTE_HERE") {
        throw new Error("credentials.js is not filled in yet (see SETUP.md).");
      }
      firebase.initializeApp(firebaseConfig);
      this.db = firebase.database();
      const [, config] = await Promise.all([ThemeLoader.load(), ConfigLoader.load()]);
      this.config = config;

      firebase.auth().onAuthStateChanged(async (user) => {
        if (!user) { this.stopLive(); return this.renderLogin(); }
        const token = await user.getIdTokenResult(true);
        if (!token.claims.admin) {
          await firebase.auth().signOut();
          return this.renderLogin("That account is not an admin. Run set_admin_claim.py for it, then sign in again.");
        }
        this.user = user;
        this.renderPanel();
      });
    } catch (e) {
      this.el().innerHTML = `<div class="errbox">${esc(e.message)}</div>`;
    }
  },

  /* ----------------------------- login ----------------------------- */
  renderLogin(err) {
    this.el().innerHTML = `
      <div class="ctrl-wrap">
        <div class="login card">
          <h2>Control room sign-in</h2>
          <div class="field">
            <input id="email" type="email" placeholder="Host email" autocomplete="username" />
            <input id="pass" type="password" placeholder="Password" autocomplete="current-password" />
          </div>
          <button id="signin" class="btn btn--primary" style="margin-top:.6rem;width:100%">Sign in</button>
          <div class="err">${err ? esc(err) : ""}</div>
        </div>
      </div>`;
    const go = async () => {
      const email = document.getElementById("email").value.trim();
      const pass = document.getElementById("pass").value;
      const errEl = this.el().querySelector(".err");
      errEl.textContent = "Signing in…";
      try { await firebase.auth().signInWithEmailAndPassword(email, pass); }
      catch (e) { errEl.textContent = e.message; }
    };
    document.getElementById("signin").addEventListener("click", go);
    document.getElementById("pass").addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  },

  /* ----------------------------- panel ----------------------------- */
  renderPanel() {
    const gated = this.config.sections.filter((s) => s.gate && s.type !== "assessment" && s.type !== "wordcloud");
    const assess = this.config.sections.find((s) => s.type === "assessment");
    const stimuli = assess ? (assess.stimuli || []) : [];
    const wc = this.config.sections.find((s) => s.type === "wordcloud");
    const wcPrompts = wc ? (wc.prompts || []) : [];

    this.el().innerHTML = `
      <div class="ctrl-wrap">
        <div class="ctrl-head">
          <h1>Control room</h1>
          <div><span class="who">${esc(this.user.email)}</span> &middot; <a id="signout">sign out</a></div>
        </div>

        <div class="ctrl-tabs">
          <button id="tabbtn-control" class="ctrl-tab ctrl-tab--on">Control</button>
          <button id="tabbtn-results" class="ctrl-tab">Results</button>
        </div>

        <div id="tab-control">
        <div class="card">
          <h2>Workshop session</h2>
          <p class="hint">Current: <strong id="cur-session">…</strong></p>
          <div class="field">
            <input id="session-input" type="text" placeholder="e.g. accra-2026-03" />
            <button id="new-workshop" class="btn-sm btn-sm--danger">Start new workshop</button>
          </div>
          <p class="hint" style="margin-top:.6rem">"Start new workshop" sets this session name and re-locks all gates. No data is deleted.</p>
        </div>

        <div class="card">
          <h2>Gating</h2>
          <div class="row">
            <div><div class="row__label">Gate master switch</div>
              <div class="row__sub">When off, everyone is self-paced (gates ignored).</div></div>
            <div style="display:flex;align-items:center;gap:.6rem">
              <span id="gating-pill" class="pill">…</span>
              <button id="gating-toggle" class="btn-sm">…</button>
            </div>
          </div>
          ${gated.map((s) => `
          <div class="row" data-gate="${esc(s.id)}">
            <div><div class="row__label">${esc(labelFor(s))}</div>
              <div class="row__sub">${esc(s.id)}</div></div>
            <div style="display:flex;align-items:center;gap:.6rem">
              <span class="pill gate-pill">…</span>
              <button class="btn-sm gate-toggle">…</button>
            </div>
          </div>`).join("")}
        </div>

        ${assess ? `
        <div class="card" id="assess-card">
          <h2>Format assessment</h2>
          <p class="hint">Everyone sees the figure you pick. Discuss it, then reveal the scale so participants can score it. Moving to the next figure hides the scale again.</p>
          <div class="disc-nav">
            <button id="as-prev" class="btn-sm">‹ Prev</button>
            <span id="as-pos">– / ${stimuli.length}</span>
            <button id="as-next" class="btn-sm">Next ›</button>
          </div>
          <div id="as-preview" class="disc-preview muted"></div>
          <div class="row" style="margin-top:.7rem">
            <div><div class="row__label">Likert scale</div>
              <div class="row__sub">Reveal the scoring scale under the current figure.</div></div>
            <div style="display:flex;align-items:center;gap:.6rem">
              <span id="as-likert-pill" class="pill">…</span>
              <button id="as-likert-toggle" class="btn-sm btn-sm--accent">…</button>
            </div>
          </div>
          <div id="as-count" class="hint" style="margin-top:.6rem"></div>
          <p class="hint" style="margin-top:.4rem">Use "Move everyone" below to bring the room into this activity and to move them on when the last figure is done.</p>
        </div>` : ""}

        ${wc ? `
        <div class="card" id="wc-card">
          <h2>Word cloud</h2>
          <p class="hint">Everyone sees the prompt you pick, with the word input open. Move to the next prompt when the room is done. Live cloud is on the Results tab.</p>
          <div class="disc-nav">
            <button id="wc-prev" class="btn-sm">‹ Prev</button>
            <span id="wc-pos">– / ${wcPrompts.length}</span>
            <button id="wc-next" class="btn-sm">Next ›</button>
          </div>
          <div id="wc-preview" class="disc-preview muted"></div>
          <div id="wc-count" class="hint" style="margin-top:.6rem"></div>
          <p class="hint" style="margin-top:.4rem">Use "Move everyone" below to bring the room in and to move them on after the last prompt.</p>
        </div>` : ""}

        <div class="card">
          <h2>Back button visibility</h2>
          <p class="hint">These three screens hide Back by default. Switch each on independently if you want participants able to return.</p>
          ${BACK_TOGGLES.map((t) => `
          <div class="row" data-backflag="${t.key}">
            <div><div class="row__label">${esc(t.label)}</div>
              <div class="row__sub">${esc(t.sub)}</div></div>
            <div style="display:flex;align-items:center;gap:.6rem">
              <span class="pill backflag-pill">…</span>
              <button class="btn-sm backflag-toggle">…</button>
            </div>
          </div>`).join("")}
        </div>

        <div class="card">
          <h2>Live participation</h2>
          <p class="hint">Participants in the current session, by where they are now.</p>
          <div id="monitor" class="monitor"><div class="muted">Loading…</div></div>
        </div>

        <div class="card">
          <h2>Move everyone</h2>
          <p class="hint">Jumps every connected participant in this session to the chosen section now. Saved answers are kept — this only changes which screen they're on. Use sparingly.</p>
          <div class="field">
            <select id="force-section-select">${this.config.sections.map((s) => `<option value="${esc(s.id)}">${esc(labelFor(s))} (${esc(s.id)})</option>`).join("")}</select>
            <button id="force-section-go" class="btn-sm btn-sm--danger">Move everyone here</button>
          </div>
        </div>

        <div class="card">
          <h2>Broadcast message</h2>
          <p class="hint">Shows as a banner on every participant's screen until cleared.</p>
          <div class="field"><textarea id="bc-text" placeholder="e.g. Please put your phones down and look up."></textarea></div>
          <div style="display:flex;gap:.5rem;margin-top:.6rem">
            <button id="bc-send" class="btn-sm btn-sm--accent">Send</button>
            <button id="bc-clear" class="btn-sm">Clear</button>
          </div>
          <p class="hint" id="bc-current" style="margin-top:.6rem"></p>
        </div>
        </div><!-- /tab-control -->

        <div id="tab-results" style="display:none"></div>
      </div>`;

    document.getElementById("signout").addEventListener("click", () => firebase.auth().signOut());
    this.wireSession();
    this.wireGating(gated);
    this.wireAssessment();
    this.wireWordcloud();
    this.wireBackFlags();
    this.wireBroadcast();
    this.wireForceSection();
    this.wireTabs();
    this.subscribe(gated);
  },

  wireTabs() {
    const show = (tab) => {
      this.tab = tab;
      document.getElementById("tab-control").style.display = tab === "control" ? "" : "none";
      document.getElementById("tab-results").style.display = tab === "results" ? "" : "none";
      document.getElementById("tabbtn-control").classList.toggle("ctrl-tab--on", tab === "control");
      document.getElementById("tabbtn-results").classList.toggle("ctrl-tab--on", tab === "results");
      if (tab === "results") this.loadResults();
      else this.stopLive();
    };
    document.getElementById("tabbtn-control").addEventListener("click", () => show("control"));
    document.getElementById("tabbtn-results").addEventListener("click", () => show("results"));
  },

  /* ----------------------------- session ----------------------------- */
  wireSession() {
    document.getElementById("new-workshop").addEventListener("click", async () => {
      const name = document.getElementById("session-input").value.trim();
      if (!name) { alert("Type a session name first."); return; }
      if (!confirm(`Start new workshop "${name}"?\n\nThis sets the session name and re-locks all gates. Existing data is kept (tagged by its session).`)) return;
      const gates = {};
      this.config.sections.filter((s) => s.gate).forEach((s) => { gates[s.id] = "locked"; });
      const update = { session: name, section_gates: gates };
      // Reset any host-driven presentation state (assessment figure + scale,
      // wordcloud prompt index).
      this.config.sections.filter((s) => s.type === "assessment").forEach((s) => {
        update[`pres/${s.id}`] = { idx: 0, likert_shown: false };
      });
      this.config.sections.filter((s) => s.type === "wordcloud").forEach((s) => {
        update[`pres/${s.id}`] = { idx: 0 };
      });
      await this.db.ref("control").update(update);
      document.getElementById("session-input").value = "";
    });
  },

  /* ----------------------------- gating ----------------------------- */
  wireGating(gated) {
    document.getElementById("gating-toggle").addEventListener("click", async () => {
      await this.db.ref("control/gating_enabled").set(!this.state.gatingEnabled);
    });
    this.el().querySelectorAll(".row[data-gate]").forEach((row) => {
      const id = row.dataset.gate;
      row.querySelector(".gate-toggle").addEventListener("click", async () => {
        const open = this.state.gates[id] === "open";
        await this.db.ref(`control/section_gates/${id}`).set(open ? "locked" : "open");
      });
    });
  },

  /* ----------------------------- assessment (merged discussion + Likert) ----------------------------- */
  wireAssessment() {
    const assess = this.config.sections.find((s) => s.type === "assessment");
    if (!assess) return;
    this._assessId = assess.id;
    const stimuli = assess.stimuli || [];
    const n = stimuli.length;
    const presRef = this.db.ref(`control/pres/${assess.id}`);

    // Moving to a figure always hides the scale (write idx + likert_shown:false
    // together) so the next figure never inherits the previous reveal state.
    const goTo = (i) => {
      const idx = Math.max(0, Math.min(i, Math.max(0, n - 1)));
      presRef.set({ idx, likert_shown: false });
    };
    document.getElementById("as-prev").addEventListener("click", () => goTo((this.assessIdx || 0) - 1));
    document.getElementById("as-next").addEventListener("click", () => goTo((this.assessIdx || 0) + 1));
    document.getElementById("as-likert-toggle").addEventListener("click", () => {
      presRef.set({ idx: this.assessIdx || 0, likert_shown: !this.assessLikert });
    });
    this.paintAssessCard();
  },

  paintAssessCard() {
    const assess = this.config.sections.find((s) => s.type === "assessment");
    if (!assess) return;
    const stimuli = assess.stimuli || [];
    const n = stimuli.length;
    const idx = Math.max(0, Math.min(this.assessIdx || 0, Math.max(0, n - 1)));
    const pos = document.getElementById("as-pos");
    if (!pos) return;
    pos.textContent = `${n ? idx + 1 : 0} / ${n}`;
    const st = stimuli[idx] || {};
    const prev = document.getElementById("as-preview");
    prev.textContent = st.title || (st.image ? `[image] ${st.image}` : (st.caption || "(empty)"));
    const pb = document.getElementById("as-prev");
    const nb = document.getElementById("as-next");
    if (pb) pb.disabled = idx <= 0;
    if (nb) nb.disabled = idx >= n - 1;

    const shown = !!this.assessLikert;
    const pill = document.getElementById("as-likert-pill");
    const btn = document.getElementById("as-likert-toggle");
    if (pill) { pill.textContent = shown ? "SHOWN" : "HIDDEN"; pill.className = "pill " + (shown ? "pill--open" : "pill--locked"); }
    if (btn) { btn.textContent = shown ? "Hide scale" : "Show scale"; btn.className = "btn-sm " + (shown ? "" : "btn-sm--accent"); }

    // Live submission count for the current figure (informational, not a block).
    const countEl = document.getElementById("as-count");
    if (countEl) {
      const stimId = st.id;
      const inSession = this.state.participants.filter((p) => (p.session || "") === this.state.session).length;
      let answered = 0;
      const assessData = this.results && this.results.assess ? this.results.assess : (this._assessLive || {});
      Object.keys(assessData || {}).forEach((uid) => {
        const rec = (assessData[uid] || {})[stimId];
        if (rec && (rec.session || "") === this.state.session) answered++;
      });
      countEl.textContent = stimId ? `Answered this figure: ${answered}${inSession ? " of " + inSession : ""}` : "";
    }
  },

  /* ----------------------------- wordcloud (host-paced) ----------------------------- */
  wireWordcloud() {
    const wc = this.config.sections.find((s) => s.type === "wordcloud");
    if (!wc) return;
    this._wcId = wc.id;
    const prompts = wc.prompts || [];
    const n = prompts.length;
    const presRef = this.db.ref(`control/pres/${wc.id}`);
    const goTo = (i) => presRef.set({ idx: Math.max(0, Math.min(i, Math.max(0, n - 1))) });
    document.getElementById("wc-prev").addEventListener("click", () => goTo((this.wcIdx || 0) - 1));
    document.getElementById("wc-next").addEventListener("click", () => goTo((this.wcIdx || 0) + 1));
    this.paintWcCard();
  },

  paintWcCard() {
    const wc = this.config.sections.find((s) => s.type === "wordcloud");
    if (!wc) return;
    const prompts = wc.prompts || [];
    const n = prompts.length;
    const idx = Math.max(0, Math.min(this.wcIdx || 0, Math.max(0, n - 1)));
    const pos = document.getElementById("wc-pos");
    if (!pos) return;
    pos.textContent = `${n ? idx + 1 : 0} / ${n}`;
    const p = prompts[idx] || {};
    const prev = document.getElementById("wc-preview");
    prev.textContent = p.prompt || (p.image ? `[image] ${p.image}` : "(empty)");
    const pb = document.getElementById("wc-prev");
    const nb = document.getElementById("wc-next");
    if (pb) pb.disabled = idx <= 0;
    if (nb) nb.disabled = idx >= n - 1;

    const countEl = document.getElementById("wc-count");
    if (countEl) {
      const pid = p.id;
      const inSession = this.state.participants.filter((x) => (x.session || "") === this.state.session).length;
      const wordData = (this.results && this.results.words) ? this.results.words : (this._wordLive || {});
      let answered = 0;
      Object.keys(wordData || {}).forEach((uid) => {
        const rec = (wordData[uid] || {})[pid];
        if (rec && (rec.session || "") === this.state.session) answered++;
      });
      countEl.textContent = pid ? `Answered this prompt: ${answered}${inSession ? " of " + inSession : ""}` : "";
    }
  },

  /* --------------------- back-button visibility (questionnaire/end) --------------------- */
  wireBackFlags() {
    this.state.backFlags = this.state.backFlags || { questionnaire: false, end: false };
    this.el().querySelectorAll(".row[data-backflag]").forEach((row) => {
      const key = row.dataset.backflag;
      row.querySelector(".backflag-toggle").addEventListener("click", async () => {
        const on = this.state.backFlags[key] === true;
        await this.db.ref(`control/back_${key}`).set(!on);
      });
    });
    this.paintBackFlags();
  },

  paintBackFlags() {
    this.el().querySelectorAll(".row[data-backflag]").forEach((row) => {
      const key = row.dataset.backflag;
      const on = this.state.backFlags[key] === true;
      const pill = row.querySelector(".backflag-pill");
      const btn = row.querySelector(".backflag-toggle");
      if (pill) { pill.textContent = on ? "ON" : "OFF"; pill.className = "pill backflag-pill " + (on ? "pill--open" : "pill--locked"); }
      if (btn) { btn.textContent = on ? "Turn off" : "Turn on"; btn.className = "btn-sm backflag-toggle " + (on ? "" : "btn-sm--accent"); }
    });
  },

  /* ----------------------------- broadcast ----------------------------- */
  wireBroadcast() {
    document.getElementById("bc-send").addEventListener("click", async () => {
      const text = document.getElementById("bc-text").value.trim();
      if (!text) return;
      await this.db.ref("control/broadcast").set({ text, ts: firebase.database.ServerValue.TIMESTAMP });
    });
    document.getElementById("bc-clear").addEventListener("click", async () => {
      await this.db.ref("control/broadcast").set(null);
      document.getElementById("bc-text").value = "";
    });
  },

  wireForceSection() {
    const sel = document.getElementById("force-section-select");
    const go = document.getElementById("force-section-go");
    if (!sel || !go) return;
    go.addEventListener("click", async () => {
      const id = sel.value;
      const label = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : id;
      if (!this.state.session || this.state.session === "(none set)") {
        alert("Set a workshop session first."); return;
      }
      if (!confirm(`Move every connected participant in "${this.state.session}" to ${label} now?`)) return;
      await this.db.ref("control/force_section").set({
        section_id: id,
        session: this.state.session,
        ts: firebase.database.ServerValue.TIMESTAMP
      });
    });
  },

  /* ----------------------------- live listeners ----------------------------- */
  subscribe(gated) {
    this.db.ref("control/session").on("value", (s) => {
      this.state.session = s.val() || "(none set)";
      const el = document.getElementById("cur-session");
      if (el) el.textContent = this.state.session;
      this.renderMonitor();
    });

    this.db.ref("control/gating_enabled").on("value", (s) => {
      this.state.gatingEnabled = s.val() === true;
      const pill = document.getElementById("gating-pill");
      const btn = document.getElementById("gating-toggle");
      if (pill) { pill.textContent = this.state.gatingEnabled ? "ON" : "OFF"; pill.className = "pill " + (this.state.gatingEnabled ? "pill--on" : "pill--off"); }
      if (btn) btn.textContent = this.state.gatingEnabled ? "Turn off" : "Turn on";
      this.renderMonitor();
    });

    this.db.ref("control/section_gates").on("value", (s) => {
      this.state.gates = s.val() || {};
      this.el().querySelectorAll(".row[data-gate]").forEach((row) => {
        const id = row.dataset.gate;
        const open = this.state.gates[id] === "open";
        const pill = row.querySelector(".gate-pill");
        const btn = row.querySelector(".gate-toggle");
        pill.textContent = open ? "OPEN" : "LOCKED";
        pill.className = "pill gate-pill " + (open ? "pill--open" : "pill--locked");
        btn.textContent = open ? "Lock" : "Open";
        btn.className = "btn-sm gate-toggle " + (open ? "" : "btn-sm--accent");
      });
      this.paintAssessCard();
      this.paintWcCard();
      this.renderMonitor();
    });

    const assess = this.config.sections.find((s) => s.type === "assessment");
    if (assess) {
      this.db.ref(`control/pres/${assess.id}`).on("value", (s) => {
        const v = s.val() || {};
        this.assessIdx = (typeof v.idx === "number") ? v.idx : 0;
        this.assessLikert = v.likert_shown === true;
        this.paintAssessCard();
      });
      // Light live feed of assessment answers so the per-figure submission count
      // updates without opening the Results tab.
      this.db.ref("assessments").on("value", (s) => {
        this._assessLive = s.val() || {};
        this.paintAssessCard();
      });
    }

    const wc = this.config.sections.find((s) => s.type === "wordcloud");
    if (wc) {
      this.db.ref(`control/pres/${wc.id}`).on("value", (s) => {
        const v = s.val() || {};
        this.wcIdx = (typeof v.idx === "number") ? v.idx : 0;
        this.paintWcCard();
      });
      this.db.ref("word_responses").on("value", (s) => {
        this._wordLive = s.val() || {};
        this.paintWcCard();
      });
    }

    this.db.ref("control/broadcast").on("value", (s) => {
      const b = s.val();
      const el = document.getElementById("bc-current");
      if (el) el.textContent = (b && b.text) ? `Currently showing: "${b.text}"` : (b && b.image ? "Currently showing: a word cloud." : "Nothing showing now.");
    });

    this.watchCleaning();

    ["questionnaire", "end"].forEach((key) => {
      this.db.ref(`control/back_${key}`).on("value", (s) => {
        this.state.backFlags[key] = s.val() === true;
        this.paintBackFlags();
      });
    });

    this.db.ref("participants").on("value", (s) => {
      const all = s.val() || {};
      this.state.participantsRaw = all;
      this.state.participants = Object.keys(all).map((uid) => all[uid]);
      // Participant progress and participant_no changes arrive here — flag the
      // live view dirty so the Results tab reflects them on the next 3s tick.
      this._dirty = true;
      this.renderMonitor();
      this.paintAssessCard();
      this.paintWcCard();
    });
  },

  renderMonitor() {
    const el = document.getElementById("monitor");
    if (!el) return;
    const sections = this.config.sections;
    const inSession = this.state.participants.filter((p) => (p.session || "") === this.state.session);

    const counts = sections.map(() => 0);
    let waiting = sections.map(() => 0);
    let done = 0;
    inSession.forEach((p) => {
      const idx = (p.progress && typeof p.progress.section_idx === "number") ? p.progress.section_idx : 0;
      if (idx >= sections.length) { done++; return; }
      counts[idx]++;
      const sec = sections[idx];
      if (this.state.gatingEnabled && sec.gate && sec.type !== "assessment" && sec.type !== "notice" && sec.type !== "wordcloud" && this.state.gates[sec.id] !== "open") waiting[idx]++;
    });

    const rows = sections.map((s, i) => {
      if (counts[i] === 0) return "";
      const w = waiting[i] ? ` <span class="pill pill--locked" style="margin-left:.4rem">${waiting[i]} waiting</span>` : "";
      return `<div class="monitor__row"><span>${esc(labelFor(s))}${w}</span><span class="monitor__count">${counts[i]}</span></div>`;
    }).filter(Boolean).join("");

    el.innerHTML =
      (rows || `<div class="muted">No participants in this session yet.</div>`) +
      (done ? `<div class="monitor__row"><span>Finished</span><span class="monitor__count">${done}</span></div>` : "") +
      `<div class="monitor__total">Total in "${esc(this.state.session)}": ${inSession.length}</div>`;
  },

  /* ----------------------------- results tab ----------------------------- */
  sessOK(rec) {
    if (!rec) return false;
    const v = this.viewSession;
    if (v === "(all)" || v === "(none set)") return true;
    return rec.session === v;
  },
  allSessions() {
    const set = new Set();
    Object.values(this.state.participantsRaw || {}).forEach((p) => { if (p && p.session) set.add(p.session); });
    if (this.state.session && this.state.session !== "(none set)") set.add(this.state.session);
    return Array.from(set).sort();
  },
  attrValueLabels(fieldId) {
    const f = (this.config.participant_fields || []).find((x) => x.id === fieldId);
    const m = {};
    if (f) (f.options || []).forEach((o) => { m[o.value] = o.text || o.value; });
    return m;
  },

  async loadResults() {
    const host = document.getElementById("tab-results");
    host.innerHTML = `<div class="card"><div class="muted">Connecting live to "${esc(this.state.session)}"…</div></div>`;
    this.stopLive();
    this.results = { words: {}, assess: {}, choices: {} };
    this._dirty = true; this._paused = false; this._lastUpdate = null; this._liveRefs = []; this._cloudsDrawn = false;
    this.viewSession = this.state.session;

    const addRef = (path, ev, cb) => { const r = this.db.ref(path); r.on(ev, cb); this._liveRefs.push([r, ev, cb]); };
    // Small per-user nodes: keep a fresh full snapshot.
    addRef("assessments", "value", (s) => { this.results.assess = s.val() || {}; this._dirty = true; });
    addRef("choices", "value", (s) => { this.results.choices = s.val() || {}; this._dirty = true; });
    addRef("word_responses", "value", (s) => {
      this.results.words = s.val() || {};
      if (!this._cloudsDrawn && this._cloudRedraw) this._cloudRedraw();
    });

    this.renderResults();                                // build the shell (incl. word clouds)
    setTimeout(() => this.renderLive(true), 500);        // first paint once snapshots have settled
    this._liveTimer = setInterval(() => { if (this._dirty && !this._paused) this.renderLive(); }, 3000);
  },

  stopLive() {
    if (this._liveTimer) { clearInterval(this._liveTimer); this._liveTimer = null; }
    (this._liveRefs || []).forEach(([r, ev, cb]) => r.off(ev, cb));
    this._liveRefs = [];
  },

  renderResults() {
    const host = document.getElementById("tab-results");
    const sessions = this.allSessions();
    const opts = sessions.map((s) => `<option value="${esc(s)}"${s === this.viewSession ? " selected" : ""}>${esc(s)}</option>`).join("")
      + `<option value="(all)"${this.viewSession === "(all)" ? " selected" : ""}>(all sessions)</option>`;
    host.innerHTML = `
      <div class="live-bar">
        <span class="live-dot" aria-hidden="true"></span>
        <span id="live-status">Live</span>
        <label class="live-sess">Session <select id="view-session">${opts}</select></label>
        <button id="live-pause" class="btn-sm">Pause</button>
      </div>
      <p class="hint" style="margin:.2rem 0 .7rem">Choice results &amp; Likert update every 3s; word clouds update when you change a filter or press Redraw. Viewing a past session shows static history. The Python dashboard remains the home for SQLite export.</p>
      <div id="r-words"></div><div id="r-likert"></div>
      <div id="r-choice"></div>
      <div id="r-export"></div>`;
    document.getElementById("live-pause").addEventListener("click", (e) => {
      this._paused = !this._paused;
      e.target.textContent = this._paused ? "Resume" : "Pause";
      this.updateLiveBar();
      if (!this._paused) this.renderLive(true);
    });
    document.getElementById("view-session").addEventListener("change", (e) => {
      this.viewSession = e.target.value;
      this._cloudsDrawn = false;
      this.renderLive(true);
      if (this._cloudRedraw) this._cloudRedraw();
      this.updateLiveBar();
    });
    this.renderWordResults(document.getElementById("r-words"));
    this.updateLiveBar();
  },

  updateLiveBar() {
    const st = document.getElementById("live-status");
    const bar = document.querySelector(".live-bar");
    if (!st || !bar) return;
    const viewing = this.viewSession !== this.state.session;   // a past/other session = static
    const stamp = this._lastUpdate ? this._lastUpdate.toLocaleTimeString() : "—";
    st.textContent = this._paused ? "Paused"
      : viewing ? `Viewing — ${this.viewSession === "(all)" ? "all sessions" : this.viewSession}`
      : `Live · updated ${stamp}`;
    bar.classList.toggle("live-bar--static", this._paused || viewing);
  },

  renderLive(force) {
    if (!force && (!this._dirty || this._paused)) return;
    this._dirty = false;
    this._lastUpdate = new Date();
    this.renderLikert(document.getElementById("r-likert"));
    this.renderQuestionnaireResults(document.getElementById("r-choice"));
    this.renderExport(document.getElementById("r-export"));
    this.updateLiveBar();
  },

  // Word prompts are now word_prompt-typed questions inside questionnaire
  // sections. Collect them per section for the prompt picker.
  // Sources for the results word clouds: BOTH the self-paced questionnaire
  // word_prompt questions AND the host-paced wordcloud sections. Both write to
  // the same word_responses node, so both belong in the prompt picker.
  wordPromptSections() {
    return this.config.sections
      .map((s) => {
        if (s.type === "questionnaire") return { sec: s, prompts: (s.questions || []).filter((q) => q.type === "word_prompt") };
        if (s.type === "wordcloud") return { sec: s, prompts: (s.prompts || []) };
        return { sec: s, prompts: [] };
      })
      .filter((e) => e.prompts.length);
  },

  renderWordResults(host) {
    const wordSecs = this.wordPromptSections();
    const total = wordSecs.reduce((n, e) => n + e.prompts.length, 0);
    const card = document.createElement("div"); card.className = "card";
    if (!total) { card.innerHTML = "<h2>Word clouds</h2><div class='muted'>No word prompts.</div>"; host.appendChild(card); return; }
    const fields = this.config.participant_fields || [];
    // One <optgroup> per questionnaire section (only when there's more than one)
    // so the host can tell the activities apart in the prompt picker.
    const promptOpts = wordSecs.map((e) => {
      const opts = e.prompts.map((p) => `<option value="${esc(p.id)}">${esc(p.prompt || p.id)}</option>`).join("");
      if (!opts) return "";
      return wordSecs.length > 1 ? `<optgroup label="${esc(labelFor(e.sec))}">${opts}</optgroup>` : opts;
    }).join("");
    card.innerHTML = `<h2>Word clouds</h2>
      <div class="res-controls">
        <label>Prompt <select id="wc-prompt">${promptOpts}</select></label>
        <label>Group by <select id="wc-group"><option value="">(none)</option>${fields.map((f) => `<option value="${esc(f.id)}">${esc(f.label || f.id)}${f.multi ? " (multi-select)" : ""}</option>`).join("")}</select></label>
        <button id="wc-redraw" class="btn-sm">↻ Redraw</button>
        <button id="wc-clean" class="btn-sm btn-sm--accent">🧹 Clean words (AI)</button>
        <button id="wc-export" class="btn-sm">⬇ PNG</button>
        <button id="wc-export-csv" class="btn-sm">⬇ CSV (raw + processed)</button>
        <button id="wc-broadcast" class="btn-sm btn-sm--accent">📡 Broadcast to participants</button>
      </div>
      <div id="wc-clean-status" class="hint"></div>
      <details class="wc-ai-setup">
        <summary>AI cleaning setup</summary>
        <div class="wc-ai-setup__body">
          <label>Provider
            <select id="wc-ai-provider">
              <option value="claude">Claude (Anthropic)</option>
              <option value="gemini">Gemini (Google)</option>
              <option value="ollama">Ollama (local / open-source)</option>
            </select>
          </label>
          <label>API key <input id="wc-ai-key" type="password" placeholder="paste key (stored only in this browser)" autocomplete="off"></label>
          <label id="wc-ai-url-wrap" style="display:none">Ollama URL <input id="wc-ai-url" type="text" placeholder="http://localhost:11434"></label>
          <button id="wc-ai-save" class="btn-sm">Save</button>
          <span id="wc-ai-saved" class="hint"></span>
          <div class="hint">The key stays in this browser only (never uploaded). Use a trusted host computer, not a shared one.</div>
        </div>
      </details>
      <div id="wc-broadcast-status" class="hint"></div>
      <div id="wc-area"></div>
      <div id="wc-review"></div>`;
    host.appendChild(card);
    const update = () => this.drawClouds(card.querySelector("#wc-prompt").value, card.querySelector("#wc-group").value);
    this._cloudRedraw = update;
    card.querySelector("#wc-prompt").addEventListener("change", update);
    card.querySelector("#wc-group").addEventListener("change", update);
    card.querySelector("#wc-redraw").addEventListener("click", update);
    card.querySelector("#wc-clean").addEventListener("click", () => this.cleanWords());
    card.querySelector("#wc-export").addEventListener("click", () => this.exportWordcloudPNG());
    card.querySelector("#wc-export-csv").addEventListener("click", () => this.exportWordcloudCSV());
    card.querySelector("#wc-broadcast").addEventListener("click", () => this.broadcastWordcloud());
    this.wireAiSetup();
    update();
  },

  /* ----------------------------- AI cleaning setup (host-only, browser-local key) ----------------------------- */
  aiConfig() {
    return {
      provider: localStorage.getItem("RISKVIZ_AI_PROVIDER") || "claude",
      key: localStorage.getItem("RISKVIZ_AI_KEY") || "",
      url: localStorage.getItem("RISKVIZ_AI_URL") || "http://localhost:11434"
    };
  },
  wireAiSetup() {
    const cfg = this.aiConfig();
    const prov = document.getElementById("wc-ai-provider");
    const key = document.getElementById("wc-ai-key");
    const url = document.getElementById("wc-ai-url");
    const urlWrap = document.getElementById("wc-ai-url-wrap");
    if (!prov) return;
    prov.value = cfg.provider; key.value = cfg.key; url.value = cfg.url;
    const syncUrl = () => { urlWrap.style.display = prov.value === "ollama" ? "" : "none"; };
    syncUrl();
    prov.addEventListener("change", syncUrl);
    document.getElementById("wc-ai-save").addEventListener("click", () => {
      localStorage.setItem("RISKVIZ_AI_PROVIDER", prov.value);
      localStorage.setItem("RISKVIZ_AI_KEY", key.value.trim());
      localStorage.setItem("RISKVIZ_AI_URL", url.value.trim() || "http://localhost:11434");
      const saved = document.getElementById("wc-ai-saved");
      if (saved) { saved.textContent = "Saved."; setTimeout(() => { saved.textContent = ""; }, 2000); }
    });
  },

  // Which group values a participant belongs to for the chosen attribute. A
  // single-select attribute yields one value; a multi-select attribute yields
  // one per selected value, so the participant appears in each of those groups
  // (overlapping membership — counts can exceed the participant total).
  groupValuesFor(uid, groupField, labelMap) {
    if (!groupField) return ["(all)"];
    const v = ((this.state.participantsRaw[uid] || {}).fields || {})[groupField];
    const label = (x) => labelMap[x] || x;
    if (Array.isArray(v)) return v.length ? v.map(label) : ["(not set)"];
    return [(v != null && v !== "") ? label(v) : "(not set)"];
  },

  // Apply the active (non-overridden) cleaning decisions for a prompt to a raw
  // {word: count} map: drop removed terms, fold merged members into their
  // canonical. Returns a new map; the raw map is untouched.
  applyCleaning(promptId, rawMap) {
    const dec = ((this._cleaning || {})[this.viewSession] || {})[promptId];
    if (!dec) return Object.assign({}, rawMap);
    const removed = dec.removed || {};
    const merges = dec.merges || {};
    const termMap = {};
    Object.keys(merges).forEach((canon) => {
      const m = merges[canon] || {};
      if (m.overridden) return;
      const split = m.split || {};
      const members = Array.isArray(m.members) ? m.members : Object.keys(m.members || {});
      members.forEach((mem) => {
        if (mem === m.canonical) return;
        if (split[mem]) return;
        termMap[mem] = m.canonical;
      });
    });
    const out = {};
    Object.keys(rawMap).forEach((w) => {
      const rm = removed[w];
      if (rm && !rm.overridden) return;         // actively removed
      const key = termMap[w] || w;              // fold into canonical if merged
      out[key] = (out[key] || 0) + rawMap[w];
    });
    return out;
  },

  drawClouds(promptId, groupField) {
    const area = document.getElementById("wc-area"); area.innerHTML = "";
    const labelMap = groupField ? this.attrValueLabels(groupField) : {};
    const rawGroups = {};
    Object.keys(this.results.words || {}).forEach((uid) => {
      const rec = (this.results.words[uid] || {})[promptId];
      if (!this.sessOK(rec)) return;
      this.groupValuesFor(uid, groupField, labelMap).forEach((g) => {
        rawGroups[g] = rawGroups[g] || {};
        (rec.words || []).forEach((w) => { const k = String(w).toLowerCase(); rawGroups[g][k] = (rawGroups[g][k] || 0) + 1; });
      });
    });
    // Processed groups = raw with active cleaning decisions applied.
    const groups = {};
    Object.keys(rawGroups).forEach((g) => { groups[g] = this.applyCleaning(promptId, rawGroups[g]); });
    // Keep the prompt-level raw + processed term frequencies for CSV export.
    const rawAll = {}, procAll = {};
    Object.keys(rawGroups).forEach((g) => Object.entries(rawGroups[g]).forEach(([w, c]) => { rawAll[w] = (rawAll[w] || 0) + c; }));
    Object.keys(groups).forEach((g) => Object.entries(groups[g]).forEach(([w, c]) => { procAll[w] = (procAll[w] || 0) + c; }));
    this._wcFreqs = { promptId, raw: rawAll, processed: procAll };

    const gkeys = Object.keys(groups).sort();
    this._cloudsDrawn = gkeys.length > 0;
    // Record rendered canvases for Export PNG / Broadcast (bare clouds — the
    // canvas holds only the cloud; the group title is a separate DOM element).
    this._wcRender = { promptId, canvases: [] };
    // Broadcast is only meaningful for a single cloud; disable it when grouped.
    const bcBtn = document.getElementById("wc-broadcast");
    if (bcBtn) {
      bcBtn.disabled = gkeys.length > 1;
      bcBtn.title = gkeys.length > 1 ? "Broadcasting sends one cloud — set Group by to (none) first." : "";
    }
    this.renderCleaningReview(promptId);
    if (!gkeys.length) { area.innerHTML = "<div class='muted'>No words for this prompt in this session.</div>"; return; }
    // Render clouds at a high internal resolution (CSS scales them down to fit),
    // so exported/broadcast images are large and crisp.
    const RW = 1000, RH = 480;
    gkeys.forEach((g) => {
      const entries = Object.entries(groups[g]).sort((a, b) => b[1] - a[1]).slice(0, 60);
      const total = entries.reduce((a, e) => a + e[1], 0);
      const wrap = document.createElement("div"); wrap.className = "wc-group";
      const title = gkeys.length > 1 || g !== "(all)" ? `${g} · ${total} words` : `${total} words`;
      wrap.innerHTML = `<div class="wc-title">${esc(title)}</div>`;
      area.appendChild(wrap);
      if (window.WordCloud && entries.length) {
        const canvas = document.createElement("canvas");
        canvas.width = RW; canvas.height = RH; wrap.appendChild(canvas);
        const maxC = entries[0][1];
        window.WordCloud(canvas, {
          list: entries, gridSize: 12, weightFactor: (s) => Math.max(18, (s / maxC) * 90),
          color: () => ["#0E7C86", "#1A1D21", "#5B6470"][Math.floor(Math.random() * 3)],
          backgroundColor: "#ffffff", rotateRatio: 0.3
        });
        this._wcRender.canvases.push({ groupKey: g, canvas });
      } else {
        const tbl = document.createElement("div"); tbl.className = "wc-fallback";
        const maxC = entries[0] ? entries[0][1] : 1;
        tbl.innerHTML = entries.map((e) => `<span style="font-size:${Math.max(12, (e[1] / maxC) * 30)}px">${esc(e[0])} <span class="muted">${e[1]}</span></span>`).join(" ");
        wrap.appendChild(tbl);
      }
    });
  },

  _downloadCanvasPNG(canvas, filename) {
    canvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    }, "image/png");
  },

  // Export the current cloud(s) as bare PNG(s): no title, no labels, just the
  // cloud. One file when ungrouped; one file per group otherwise (the group name
  // is in the filename so the set stays legible).
  exportWordcloudPNG() {
    const r = this._wcRender;
    if (!r || !r.canvases.length) { alert("No word-cloud image to export yet (draw a cloud first)."); return; }
    const single = r.canvases.length === 1;
    r.canvases.forEach((c, i) => {
      const safe = String(c.groupKey || ("g" + i)).replace(/[^\w-]+/g, "_");
      const name = single ? `wordcloud_${r.promptId}.png` : `wordcloud_${r.promptId}_${safe}.png`;
      // Stagger multi-file downloads so the browser doesn't drop them.
      setTimeout(() => this._downloadCanvasPNG(c.canvas, name), i * 300);
    });
  },

  // Broadcast the current single cloud as a bare image to every participant.
  async broadcastWordcloud() {
    const status = document.getElementById("wc-broadcast-status");
    const r = this._wcRender;
    if (!r || !r.canvases.length) { if (status) status.textContent = "No word-cloud image to broadcast yet."; return; }
    if (r.canvases.length > 1) { if (status) status.textContent = "Broadcasting sends one cloud — set Group by to (none) first."; return; }
    const dataUrl = r.canvases[0].canvas.toDataURL("image/png");
    if (dataUrl.length > 1200000) {
      if (status) status.textContent = "Image too large to broadcast — try fewer words.";
      return;
    }
    try {
      await this.db.ref("control/broadcast").set({
        image: dataUrl,
        ts: firebase.database.ServerValue.TIMESTAMP
      });
      if (status) status.textContent = "Broadcast sent. Use the Broadcast card's Clear to remove it.";
    } catch (e) {
      if (status) status.textContent = "Broadcast failed: " + e.message;
    }
  },

  /* ----------------------------- AI word cleaning ----------------------------- */
  // Gather the current prompt's distinct terms + counts (session-scoped, raw).
  promptTermCounts(promptId) {
    const counts = {};
    Object.keys(this.results.words || {}).forEach((uid) => {
      const rec = (this.results.words[uid] || {})[promptId];
      if (!this.sessOK(rec)) return;
      (rec.words || []).forEach((w) => { const k = String(w).toLowerCase().trim(); if (k) counts[k] = (counts[k] || 0) + 1; });
    });
    return counts;
  },

  async cleanWords() {
    const status = document.getElementById("wc-clean-status");
    const promptId = document.getElementById("wc-prompt").value;
    const session = this.viewSession;
    if (!session || session === "(all)") { if (status) status.textContent = "Pick a single session before cleaning."; return; }
    const cfg = this.aiConfig();
    if (cfg.provider !== "ollama" && !cfg.key) { if (status) status.textContent = "Add your API key in 'AI cleaning setup' first."; return; }
    const counts = this.promptTermCounts(promptId);
    const terms = Object.keys(counts);
    if (terms.length < 2) { if (status) status.textContent = "Not enough words to clean yet."; return; }
    const existing = ((this._cleaning || {})[session] || {})[promptId];
    if (existing && !confirm("Re-running will replace the current cleaning for this prompt, including any manual reverts. Continue?")) return;

    if (status) status.textContent = `Cleaning ${terms.length} terms with ${cfg.provider}…`;
    let proposal;
    try {
      proposal = await this.aiClean(cfg, terms, counts);
    } catch (e) {
      if (status) status.textContent = "Cleaning failed: " + (e.message || e);
      return;
    }
    const decision = this.buildDecision(proposal, counts, cfg.provider);
    try {
      await this.db.ref(`control/word_cleaning/${session}/${promptId}`).set(decision);
      const nrem = Object.keys(decision.removed).length, nmer = Object.keys(decision.merges).length;
      if (status) status.textContent = `Done: ${nrem} removed, ${nmer} merge group(s). Review below; the cloud now uses the cleaned words.`;
    } catch (e) {
      if (status) status.textContent = "Could not save cleaning: " + e.message;
    }
  },

  // Turn a validated proposal into the stored decision. Canonical is chosen
  // deterministically as the highest-count member (ties: first), NOT the model's
  // pick, so "prefer the more frequent term" always holds.
  buildDecision(proposal, counts, model) {
    const removed = {}, merges = {};
    const used = {};
    (proposal.removed || []).forEach((r) => {
      const t = String(r.term || "").toLowerCase().trim();
      if (t && t in counts && !used[t]) { removed[t] = { reason: String(r.reason || "").slice(0, 120), overridden: false }; used[t] = true; }
    });
    (proposal.merges || []).forEach((g) => {
      const members = (g.members || []).map((m) => String(m).toLowerCase().trim())
        .filter((m) => m in counts && !used[m]);
      const uniq = Array.from(new Set(members));
      if (uniq.length < 2) return;
      uniq.forEach((m) => { used[m] = true; });
      const canonical = uniq.slice().sort((a, b) => (counts[b] - counts[a]) || (a < b ? -1 : 1))[0];
      const memObj = {}; uniq.forEach((m) => { memObj[m] = true; });
      merges[canonical] = { canonical, members: memObj, split: {}, overridden: false };
    });
    return { ts: firebase.database.ServerValue.TIMESTAMP, model, removed, merges };
  },

  // Provider dispatch. All return { removed:[{term,reason}], merges:[{members:[...]}] }.
  async aiClean(cfg, terms, counts) {
    const sys = "You clean a list of short words/phrases from a workshop word-cloud. "
      + "Return ONLY JSON: {\"removed\":[{\"term\":\"\",\"reason\":\"\"}],\"merges\":[{\"members\":[\"\",\"\"]}]}. "
      + "removed = gibberish/nonsense (e.g. random letters) only; do NOT remove real words. "
      + "merges = groups of terms that mean the same thing or are minor typos of each other "
      + "(e.g. tv/television, televsion/television). Only group clear synonyms or typos, not merely related words. "
      + "Every term/member must be copied verbatim from the input list. Output nothing but the JSON.";
    const payload = terms.map((t) => `${t} (${counts[t]})`).join(", ");
    const user = "Terms with counts:\n" + payload;
    let text;
    if (cfg.provider === "claude") text = await this._callClaude(cfg.key, sys, user);
    else if (cfg.provider === "gemini") text = await this._callGemini(cfg.key, sys, user);
    else text = await this._callOllama(cfg.url, sys, user);
    return this._parseProposal(text, terms);
  },

  async _callClaude(key, sys, user) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5", max_tokens: 1500,
        system: sys, messages: [{ role: "user", content: user }]
      })
    });
    if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const data = await res.json();
    return (data.content || []).map((b) => b.text || "").join("");
  },

  async _callGemini(key, sys, user) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: sys }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { responseMimeType: "application/json" }
      })
    });
    if (!res.ok) throw new Error(`Gemini API ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const data = await res.json();
    return ((((data.candidates || [])[0] || {}).content || {}).parts || []).map((p) => p.text || "").join("");
  },

  async _callOllama(baseUrl, sys, user) {
    const res = await fetch(`${(baseUrl || "").replace(/\/$/, "")}/api/chat`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "llama3.1", stream: false, format: "json",
        messages: [{ role: "system", content: sys }, { role: "user", content: user }]
      })
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const data = await res.json();
    return (data.message || {}).content || "";
  },

  // Parse + strictly validate the model output. Anything malformed is dropped
  // rather than trusted; members must be verbatim input terms.
  _parseProposal(text, terms) {
    const termSet = new Set(terms);
    let obj;
    try {
      const m = String(text).match(/\{[\s\S]*\}/);
      obj = JSON.parse(m ? m[0] : text);
    } catch (e) { throw new Error("Model did not return valid JSON."); }
    const removed = Array.isArray(obj.removed) ? obj.removed
      .map((r) => ({ term: String((r && r.term) || "").toLowerCase().trim(), reason: String((r && r.reason) || "") }))
      .filter((r) => termSet.has(r.term)) : [];
    const merges = Array.isArray(obj.merges) ? obj.merges
      .map((g) => ({ members: (Array.isArray(g && g.members) ? g.members : []).map((m) => String(m).toLowerCase().trim()).filter((m) => termSet.has(m)) }))
      .filter((g) => g.members.length >= 2) : [];
    return { removed, merges };
  },

  // Live decisions listener → keep this._cleaning fresh and redraw.
  watchCleaning() {
    if (this._cleaningRef) return;
    this._cleaningRef = this.db.ref("control/word_cleaning");
    this._cleaningRef.on("value", (s) => {
      this._cleaning = s.val() || {};
      if (this._cloudRedraw && document.getElementById("wc-area")) this._cloudRedraw();
    });
  },

  // Write a single override flag (revert / re-apply), path-scoped so it never
  // touches raw data.
  async _setCleaningFlag(promptId, path, value) {
    const session = this.viewSession;
    if (!session || session === "(all)") return;
    await this.db.ref(`control/word_cleaning/${session}/${promptId}/${path}`).set(value);
  },

  renderCleaningReview(promptId) {
    const el = document.getElementById("wc-review");
    if (!el) return;
    const dec = ((this._cleaning || {})[this.viewSession] || {})[promptId];
    if (!dec || (!Object.keys(dec.removed || {}).length && !Object.keys(dec.merges || {}).length)) {
      el.innerHTML = "";
      return;
    }
    const removed = dec.removed || {}, merges = dec.merges || {};
    const remRows = Object.keys(removed).sort().map((t) => {
      const r = removed[t];
      return `<div class="wc-rev__row ${r.overridden ? "wc-rev__row--off" : ""}">
        <span class="wc-rev__term">${esc(t)}</span>
        <span class="wc-rev__reason">${esc(r.reason || "removed")}</span>
        <button class="btn-sm wc-rev-remove" data-term="${esc(t)}" data-to="${r.overridden ? "1" : "0"}">${r.overridden ? "Remove again" : "Put back"}</button>
      </div>`;
    }).join("");
    const merRows = Object.keys(merges).sort().map((canon) => {
      const m = merges[canon];
      const members = Array.isArray(m.members) ? m.members : Object.keys(m.members || {});
      const split = m.split || {};
      const memHTML = members.map((mem) => {
        if (mem === m.canonical) return `<span class="wc-rev__canon">${esc(mem)}</span>`;
        const isSplit = !!split[mem];
        return `<span class="wc-rev__mem ${isSplit ? "wc-rev__mem--split" : ""}">${esc(mem)}
          <button class="btn-sm wc-rev-split" data-canon="${esc(canon)}" data-mem="${esc(mem)}" data-to="${isSplit ? "0" : "1"}">${isSplit ? "re-merge" : "split"}</button>
        </span>`;
      }).join(" ");
      return `<div class="wc-rev__row ${m.overridden ? "wc-rev__row--off" : ""}">
        <span class="wc-rev__group">→ ${esc(m.canonical)}: ${memHTML}</span>
        <button class="btn-sm wc-rev-group" data-canon="${esc(canon)}" data-to="${m.overridden ? "0" : "1"}">${m.overridden ? "redo group" : "undo group"}</button>
      </div>`;
    }).join("");

    el.innerHTML = `<div class="wc-review">
      <div class="wc-review__h">AI cleaning — <span class="muted">${esc(dec.model || "")}</span> · you can revert anything</div>
      ${remRows ? `<div class="wc-review__sec"><div class="wc-review__t">Removed</div>${remRows}</div>` : ""}
      ${merRows ? `<div class="wc-review__sec"><div class="wc-review__t">Merged</div>${merRows}</div>` : ""}
    </div>`;

    el.querySelectorAll(".wc-rev-remove").forEach((b) =>
      b.addEventListener("click", () => this._setCleaningFlag(promptId, `removed/${b.dataset.term}/overridden`, b.dataset.to === "1")));
    el.querySelectorAll(".wc-rev-group").forEach((b) =>
      b.addEventListener("click", () => this._setCleaningFlag(promptId, `merges/${b.dataset.canon}/overridden`, b.dataset.to === "1")));
    el.querySelectorAll(".wc-rev-split").forEach((b) =>
      b.addEventListener("click", () => this._setCleaningFlag(promptId, `merges/${b.dataset.canon}/split/${b.dataset.mem}`, b.dataset.to === "1" ? true : null)));
  },

  _downloadCSV(rows, filename) {
    const csv = rows.map((r) => r.map((c) => {
      const s = String(c == null ? "" : c);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  },

  // Export raw and processed term-frequency CSVs for the current prompt.
  exportWordcloudCSV() {
    const f = this._wcFreqs;
    const status = document.getElementById("wc-clean-status");
    if (!f) { if (status) status.textContent = "Draw a cloud first."; return; }
    const toRows = (map) => [["word", "count"]].concat(
      Object.entries(map).sort((a, b) => b[1] - a[1]).map(([w, c]) => [w, c]));
    this._downloadCSV(toRows(f.raw), `words_raw_${f.promptId}.csv`);
    setTimeout(() => this._downloadCSV(toRows(f.processed), `words_processed_${f.promptId}.csv`), 300);
  },

  renderLikert(host) {
    const dims = (this.config.likert.dimensions || []);
    const points = this.config.likert.points || 5;
    const stimTitles = {};
    this.config.sections.filter((s) => s.type === "assessment").forEach((s) => (s.stimuli || []).forEach((st) => { stimTitles[st.id] = st.title || st.id; }));
    const agg = {};
    Object.keys(this.results.assess || {}).forEach((uid) => {
      const stims = this.results.assess[uid] || {};
      Object.keys(stims).forEach((sid) => {
        const rec = stims[sid]; if (!this.sessOK(rec)) return;
        agg[sid] = agg[sid] || {};
        dims.forEach((d) => { if (typeof rec[d.id] === "number") { const a = agg[sid][d.id] = agg[sid][d.id] || { s: 0, n: 0 }; a.s += rec[d.id]; a.n++; } });
      });
    });
    const sids = Object.keys(agg);
    if (!sids.length) { host.innerHTML = `<div class="card"><h2>Likert</h2><div class='muted'>No assessments in this session yet.</div></div>`; return; }
    const blocks = sids.map((sid) => {
      const rows = dims.map((d) => {
        const a = agg[sid][d.id];
        const mean = a ? a.s / a.n : null;
        const pct = mean != null ? Math.max(0, (mean - 1) / (points - 1) * 100) : 0;
        return `<div class="lk-row">
            <div class="lk-row__label">${esc(d.label || d.id)}</div>
            <div class="lk-row__track"><div class="lk-row__bar" style="width:${pct}%"></div></div>
            <div class="lk-row__val">${mean != null ? mean.toFixed(2) : "—"} <span class="muted">· n=${a ? a.n : 0}</span></div>
          </div>`;
      }).join("");
      return `<div class="lk-stim"><div class="lk-stim__title">${esc(stimTitles[sid] || sid)}</div>${rows}</div>`;
    }).join("");
    host.innerHTML = `<div class="card"><h2>Likert — mean rating (1–${points})</h2>${blocks}</div>`;
  },

  // Normalise a stored choice answer to a list of selected option indices.
  // Handles multiple_choice (choice_idxs array, or RTDB's object form when read
  // back) and single_choice (choice_idx). Used by results and export.
  selectedIdxs(rec) {
    if (Array.isArray(rec.choice_idxs)) return rec.choice_idxs.filter((x) => typeof x === "number");
    if (rec.choice_idxs && typeof rec.choice_idxs === "object") return Object.values(rec.choice_idxs).filter((x) => typeof x === "number");
    if (typeof rec.choice_idx === "number") return [rec.choice_idx];
    return [];
  },

  // Live poll bars for questionnaire choice questions (single_choice &
  // multiple_choice) across every questionnaire section. Each bar shows the
  // share of respondents who picked that option (multi doesn't sum to 100%, so
  // the denominator is respondents, not picks), with the leading option
  // highlighted. Verbatim "Other" free-text answers are listed beneath.
  // word_prompt questions are shown in the Word clouds card, not here.
  renderQuestionnaireResults(host) {
    if (!host) return;
    const questions = [];
    this.config.sections.filter((s) => s.type === "questionnaire").forEach((s) =>
      (s.questions || []).forEach((q) => {
        if (q.type === "single_choice" || q.type === "multiple_choice") questions.push(q);
      })
    );
    if (!questions.length) { host.innerHTML = ""; return; }

    const pById = this.state.participantsRaw || {};
    const who = (uid) => (pById[uid] && pById[uid].participant_no) || uid.slice(-5);

    const data = this.results.choices || {};
    const blocks = questions.map((q) => {
      const rawChoices = q.choices || [];
      const C = rawChoices.length;
      const slots = C + (q.has_other ? 1 : 0);   // "Other" slot lives at index C
      const counts = new Array(slots).fill(0);
      let respondents = 0;
      const others = [];

      if (q.profile) {
        // Profile answers live in participants/{uid}/fields/{qid} as the option
        // text (string) or an array of texts (multi) — NOT in the choices node.
        // Map each value back to its option bar; values that aren't among the
        // options are typed "Other" (route to the Other bar + verbatim list).
        const idxOf = {};
        rawChoices.forEach((c, i) => { idxOf[ConfigLoader.stripMarkup(c)] = i; });
        Object.keys(pById).forEach((uid) => {
          const p = pById[uid] || {};
          if (!this.sessOK(p)) return;                 // participant's own session
          const fv = (p.fields || {})[q.id];
          if (fv === undefined || fv === null || fv === "") return;
          respondents++;
          (Array.isArray(fv) ? fv : [fv]).forEach((v) => {
            const key = String(v);
            if (key in idxOf) counts[idxOf[key]]++;
            else if (q.has_other) { counts[C]++; others.push({ who: who(uid), text: key }); }
          });
        });
      } else {
        Object.keys(data).forEach((uid) => {
          const rec = (data[uid] || {})[q.id];
          if (!rec || !this.sessOK(rec)) return;
          respondents++;
          this.selectedIdxs(rec).forEach((i) => { if (i >= 0 && i < slots) counts[i]++; });
          const ot = (rec.other_text || "").trim();
          if (ot) others.push({ who: who(uid), text: ot });
        });
      }

      const max = Math.max(0, ...counts);
      const labels = (q.choices || []).slice();
      if (q.has_other) labels.push("Other");
      const bars = labels.map((text, i) => {
        const c = counts[i];
        const pct = respondents ? Math.round((c / respondents) * 100) : 0;
        const lead = respondents > 0 && c === max && c > 0;
        return `<div class="poll-opt ${lead ? "poll-opt--lead" : ""}">
            <div class="poll-opt__text">${ConfigLoader.fmtInline(text)}</div>
            <div class="poll-opt__bar">
              <div class="poll-opt__track"><div class="poll-opt__fill" style="width:${pct}%"></div></div>
              <div class="poll-opt__val">${c} · ${pct}%</div>
            </div>
          </div>`;
      }).join("");
      const otherList = others.length
        ? `<div class="poll-q__others"><div class="poll-q__others-h muted">Other (${others.length}):</div>` +
          others.map((o) => `<div class="poll-other"><code>${esc(o.who)}</code> ${esc(o.text)}</div>`).join("") +
          `</div>`
        : "";
      const kind = q.type === "multiple_choice" ? "select all that apply" : "single choice";
      return `<div class="poll-q">
          <div class="poll-q__prompt">${ConfigLoader.fmtInline(q.prompt)} <span class="muted">(${esc(kind)})</span></div>
          ${bars}${otherList}
          <div class="poll-q__total muted">${respondents} respondent${respondents === 1 ? "" : "s"}</div>
        </div>`;
    }).join("");

    host.innerHTML = `<div class="card"><h2>Questionnaire results (live)</h2>${blocks}</div>`;
  },

  renderExport(host) {
    const pById = this.state.participantsRaw;
    const fieldIds = (this.config.participant_fields || []).map((f) => f.id);
    const dims = (this.config.likert.dimensions || []).map((d) => d.id);
    const pno = (uid) => (pById[uid] || {}).participant_no || "";

    const participants = Object.keys(pById).map((uid) => {
      const p = pById[uid] || {};
      const row = { uid, participant_no: p.participant_no || "", session: p.session,
                    section_idx: (p.progress || {}).section_idx, created_at: p.created_at, fields_ts: p.fields_ts };
      fieldIds.forEach((f) => { const v = (p.fields || {})[f]; row[f] = Array.isArray(v) ? v.join(";") : v; });
      return row;
    }).filter((r) => this.sessOK(r));

    const words = [];
    Object.keys(this.results.words || {}).forEach((uid) => Object.keys(this.results.words[uid] || {}).forEach((pid) => {
      const rec = this.results.words[uid][pid]; if (!this.sessOK(rec)) return;
      (rec.words || []).forEach((w) => words.push({ uid, participant_no: pno(uid), prompt_id: pid, word: w, session: rec.session, ts: rec.ts }));
    }));

    const assess = [];
    Object.keys(this.results.assess || {}).forEach((uid) => Object.keys(this.results.assess[uid] || {}).forEach((sid) => {
      const rec = this.results.assess[uid][sid]; if (!this.sessOK(rec)) return;
      const row = { uid, participant_no: pno(uid), stimulus_id: sid, session: rec.session, ts: rec.ts };
      dims.forEach((d) => { row[d] = rec[d]; }); assess.push(row);
    }));

    // Questionnaire choice questions across all questionnaire sections.
    const qMeta = {};
    this.config.sections.filter((s) => s.type === "questionnaire").forEach((s) =>
      (s.questions || []).forEach((q) => { if (q.type === "single_choice" || q.type === "multiple_choice") qMeta[q.id] = q; })
    );
    // One row per selected option (tidy long format, like word_responses). The
    // "Other" slot (index === choices.length) exports as choice_text "Other"
    // with the free text in other_text.
    const choices = [];
    Object.keys(this.results.choices || {}).forEach((uid) => Object.keys(this.results.choices[uid] || {}).forEach((qid) => {
      const rec = this.results.choices[uid][qid]; if (!this.sessOK(rec)) return;
      const q = qMeta[qid] || {}; const opts = q.choices || []; const C = opts.length;
      const type = rec.type || (Array.isArray(rec.choice_idxs) ? "multiple_choice" : "single_choice");
      const other = (rec.other_text || "").trim();
      const idxs = this.selectedIdxs(rec);
      idxs.forEach((i) => {
        const isOther = q.has_other && i === C;
        choices.push({ uid, participant_no: pno(uid), question_id: qid, type,
          choice_idx: i, choice_text: isOther ? "Other" : ConfigLoader.stripMarkup(opts[i] || ""),
          other_text: isOther ? other : "", session: rec.session, ts: rec.ts });
      });
    }));

    const tag = (this.viewSession === "(all)" || this.viewSession === "(none set)") ? "all" : this.viewSession;
    const sets = [
      ["participants", participants, ["uid", "participant_no", "session", "section_idx", "created_at", "fields_ts", ...fieldIds]],
      ["word_responses", words, ["uid", "participant_no", "prompt_id", "word", "session", "ts"]],
      ["assessments", assess, ["uid", "participant_no", "stimulus_id", ...dims, "session", "ts"]],
      ["choices", choices, ["uid", "participant_no", "question_id", "type", "choice_idx", "choice_text", "other_text", "session", "ts"]]
    ];
    host.innerHTML = `<div class="card"><h2>Export (CSV)</h2><p class="hint">This session only. For SQLite .db and the full pipeline, use the Python dashboard.</p><div id="exp-btns" class="res-controls"></div></div>`;
    const btns = host.querySelector("#exp-btns");
    sets.forEach(([name, rows, cols]) => {
      const b = document.createElement("button"); b.className = "btn-sm";
      b.textContent = `⬇ ${name}.csv (${rows.length})`;
      b.disabled = !rows.length;
      b.addEventListener("click", () => downloadText(`${name}_${tag}.csv`, toCSV(rows, cols)));
      btns.appendChild(b);
    });
  }
};

window.addEventListener("DOMContentLoaded", () => Control.boot());
