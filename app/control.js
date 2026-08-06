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
  consent: "Consent", registration: "Registration",
  questionnaire: "Questionnaire", discussion: "Discussion",
  likert: "Likert"
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
    const gated = this.config.sections.filter((s) => s.gate && s.type !== "discussion");
    const disc = this.config.sections.find((s) => s.type === "discussion");
    const discPrompts = disc ? (disc.prompts || []) : [];

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

        ${disc ? `
        <div class="card" id="disc-card">
          <h2>Discussion</h2>
          <p class="hint">Everyone's screen shows the prompt you pick. Release them to the next section when discussion is done.</p>
          <div class="disc-nav">
            <button id="disc-prev" class="btn-sm">‹ Prev</button>
            <span id="disc-pos">– / ${discPrompts.length}</span>
            <button id="disc-next" class="btn-sm">Next ›</button>
          </div>
          <div id="disc-preview" class="disc-preview muted"></div>
          <div class="row" style="margin-top:.7rem">
            <div><div class="row__label">Release</div>
              <div class="row__sub">Lets participants tap Continue to move on.</div></div>
            <div style="display:flex;align-items:center;gap:.6rem">
              <span id="disc-gate-pill" class="pill">…</span>
              <button id="disc-release" class="btn-sm btn-sm--accent">…</button>
            </div>
          </div>
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
    this.wireDiscussion();
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
      await this.db.ref("control").update({ session: name, section_gates: gates, presentation_idx: 0 });
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

  /* ----------------------------- discussion ----------------------------- */
  wireDiscussion() {
    const disc = this.config.sections.find((s) => s.type === "discussion");
    if (!disc) return;
    const n = (disc.prompts || []).length;
    const setIdx = (i) => this.db.ref("control/presentation_idx").set(Math.max(0, Math.min(i, Math.max(0, n - 1))));
    document.getElementById("disc-prev").addEventListener("click", () => setIdx((this.state.presIdx || 0) - 1));
    document.getElementById("disc-next").addEventListener("click", () => setIdx((this.state.presIdx || 0) + 1));
    document.getElementById("disc-release").addEventListener("click", () => {
      const open = this.state.gates[disc.id] === "open";
      this.db.ref(`control/section_gates/${disc.id}`).set(open ? "locked" : "open");
    });
    this.paintDiscCard();
  },

  paintDiscCard() {
    const disc = this.config.sections.find((s) => s.type === "discussion");
    if (!disc) return;
    const prompts = disc.prompts || [];
    const n = prompts.length;
    const idx = Math.max(0, Math.min(this.state.presIdx || 0, Math.max(0, n - 1)));
    const pos = document.getElementById("disc-pos");
    const prev = document.getElementById("disc-preview");
    const pb = document.getElementById("disc-prev");
    const nb = document.getElementById("disc-next");
    if (!pos) return;
    pos.textContent = `${n ? idx + 1 : 0} / ${n}`;
    const p = prompts[idx] || {};
    prev.textContent = p.text || (p.image ? `[image] ${p.image}` : "(empty)");
    if (pb) pb.disabled = idx <= 0;
    if (nb) nb.disabled = idx >= n - 1;
    const open = this.state.gates[disc.id] === "open";
    const pill = document.getElementById("disc-gate-pill");
    const btn = document.getElementById("disc-release");
    if (pill) { pill.textContent = open ? "RELEASED" : "SHOWING"; pill.className = "pill " + (open ? "pill--open" : "pill--locked"); }
    if (btn) { btn.textContent = open ? "Re-hold" : "Release"; btn.className = "btn-sm " + (open ? "" : "btn-sm--accent"); }
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
      this.paintDiscCard();
      this.renderMonitor();
    });

    this.db.ref("control/presentation_idx").on("value", (s) => {
      this.state.presIdx = (typeof s.val() === "number") ? s.val() : 0;
      this.paintDiscCard();
    });

    this.db.ref("control/broadcast").on("value", (s) => {
      const b = s.val();
      const el = document.getElementById("bc-current");
      if (el) el.textContent = (b && b.text) ? `Currently showing: "${b.text}"` : "Nothing showing now.";
    });

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
      if (this.state.gatingEnabled && sec.gate && sec.type !== "discussion" && this.state.gates[sec.id] !== "open") waiting[idx]++;
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
  wordPromptSections() {
    return this.config.sections
      .filter((s) => s.type === "questionnaire")
      .map((s) => ({ sec: s, prompts: (s.questions || []).filter((q) => q.type === "word_prompt") }))
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
        <label>Group by <select id="wc-group"><option value="">(none)</option>${fields.map((f) => `<option value="${esc(f.id)}">${esc(f.label || f.id)}</option>`).join("")}</select></label>
        <button id="wc-redraw" class="btn-sm">↻ Redraw</button>
      </div>
      <div id="wc-area"></div>`;
    host.appendChild(card);
    const update = () => this.drawClouds(card.querySelector("#wc-prompt").value, card.querySelector("#wc-group").value);
    this._cloudRedraw = update;
    card.querySelector("#wc-prompt").addEventListener("change", update);
    card.querySelector("#wc-group").addEventListener("change", update);
    card.querySelector("#wc-redraw").addEventListener("click", update);
    update();
  },

  drawClouds(promptId, groupField) {
    const area = document.getElementById("wc-area"); area.innerHTML = "";
    const pById = this.state.participantsRaw;
    const labelMap = groupField ? this.attrValueLabels(groupField) : {};
    const groups = {};
    Object.keys(this.results.words || {}).forEach((uid) => {
      const rec = (this.results.words[uid] || {})[promptId];
      if (!this.sessOK(rec)) return;
      let g = "(all)";
      if (groupField) { const v = ((pById[uid] || {}).fields || {})[groupField]; g = (v != null && v !== "") ? (labelMap[v] || v) : "(not set)"; }
      groups[g] = groups[g] || {};
      (rec.words || []).forEach((w) => { const k = String(w).toLowerCase(); groups[g][k] = (groups[g][k] || 0) + 1; });
    });
    const gkeys = Object.keys(groups).sort();
    this._cloudsDrawn = gkeys.length > 0;
    if (!gkeys.length) { area.innerHTML = "<div class='muted'>No words for this prompt in this session.</div>"; return; }
    gkeys.forEach((g) => {
      const entries = Object.entries(groups[g]).sort((a, b) => b[1] - a[1]).slice(0, 60);
      const total = entries.reduce((a, e) => a + e[1], 0);
      const wrap = document.createElement("div"); wrap.className = "wc-group";
      wrap.innerHTML = `<div class="wc-title">${esc(g)} · ${total} words</div>`;
      area.appendChild(wrap);
      if (window.WordCloud && entries.length) {
        const canvas = document.createElement("canvas");
        canvas.width = area.clientWidth || 600; canvas.height = 300; wrap.appendChild(canvas);
        const maxC = entries[0][1];
        window.WordCloud(canvas, {
          list: entries, gridSize: 8, weightFactor: (s) => Math.max(12, (s / maxC) * 54),
          color: () => ["#0E7C86", "#1A1D21", "#5B6470"][Math.floor(Math.random() * 3)],
          backgroundColor: "#ffffff", rotateRatio: 0.3
        });
      } else {
        const tbl = document.createElement("div"); tbl.className = "wc-fallback";
        const maxC = entries[0] ? entries[0][1] : 1;
        tbl.innerHTML = entries.map((e) => `<span style="font-size:${Math.max(12, (e[1] / maxC) * 30)}px">${esc(e[0])} <span class="muted">${e[1]}</span></span>`).join(" ");
        wrap.appendChild(tbl);
      }
    });
  },

  renderLikert(host) {
    const dims = (this.config.likert.dimensions || []);
    const points = this.config.likert.points || 5;
    const stimTitles = {};
    this.config.sections.filter((s) => s.type === "likert").forEach((s) => (s.stimuli || []).forEach((st) => { stimTitles[st.id] = st.title || st.id; }));
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
      const C = (q.choices || []).length;
      const slots = C + (q.has_other ? 1 : 0);   // "Other" slot lives at index C
      const counts = new Array(slots).fill(0);
      let respondents = 0;
      const others = [];
      Object.keys(data).forEach((uid) => {
        const rec = (data[uid] || {})[q.id];
        if (!rec || !this.sessOK(rec)) return;
        respondents++;
        this.selectedIdxs(rec).forEach((i) => { if (i >= 0 && i < slots) counts[i]++; });
        const ot = (rec.other_text || "").trim();
        if (ot) others.push({ who: who(uid), text: ot });
      });

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
      fieldIds.forEach((f) => { row[f] = (p.fields || {})[f]; }); return row;
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
