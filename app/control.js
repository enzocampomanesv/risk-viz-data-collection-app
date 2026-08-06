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
  word_association: "Word association", discussion: "Discussion",
  likert: "Likert", pairwise: "Pairwise comparison", choice: "Choice questions"
};
const labelFor = (s) => SECTION_LABELS[s.type] || s.id;

const BACK_TOGGLES = [
  { key: "pairwise", label: "Pairwise comparison", sub: "control/back_pairwise" },
  { key: "choice",   label: "Choice questions",    sub: "control/back_choice" },
  { key: "end",      label: "End screen",          sub: "control/back_end" },
];

/* ------------------ in-browser quick-look analytics ------------------ */
// Same probability model as the AI-voter training: P(a>b)=sigmoid(strength_a-strength_b).
// Per-item strengths fit by gradient-descent MLE with light L2 (validated r≈0.97 vs Python).
function btFit(winnerLoser, itemIds, reg = 1e-2, iters = 600, lr = 1.0) {
  const idx = {}; itemIds.forEach((it, i) => { idx[it] = i; });
  const n = itemIds.length;
  const pairs = winnerLoser.filter((c) => c[0] in idx && c[1] in idx).map((c) => [idx[c[0]], idx[c[1]]]);
  const counts = new Array(n).fill(0), wins = new Array(n).fill(0);
  pairs.forEach(([w, l]) => { counts[w]++; counts[l]++; wins[w]++; });
  let beta = new Array(n).fill(0);
  if (pairs.length) {
    for (let t = 0; t < iters; t++) {
      const g = new Array(n).fill(0);
      for (const [w, l] of pairs) {
        const oneMinusP = 1 / (1 + Math.exp(beta[w] - beta[l]));
        g[w] -= oneMinusP; g[l] += oneMinusP;
      }
      for (let i = 0; i < n; i++) { g[i] = g[i] / pairs.length + reg * beta[i]; beta[i] -= lr * g[i]; }
    }
    const mean = beta.reduce((a, b) => a + b, 0) / n;
    beta = beta.map((b) => b - mean);
  } else beta = beta.map(() => NaN);
  return itemIds.map((it, i) => ({ item: it, strength: beta[i], n: counts[i], wins: wins[i], winRate: counts[i] ? wins[i] / counts[i] : NaN }))
    .sort((a, b) => (b.strength || -1e9) - (a.strength || -1e9));
}

function connectivity(winnerLoser, itemIds) {
  const parent = {}; itemIds.forEach((it) => { parent[it] = it; });
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const seen = new Set();
  winnerLoser.forEach(([a, b]) => { if (a in parent && b in parent) { parent[find(a)] = find(b); seen.add(a); seen.add(b); } });
  const roots = new Set(itemIds.map(find));
  return { components: roots.size, isolated: itemIds.filter((it) => !seen.has(it)) };
}

function normCdf(z) { // Abramowitz-Stegun
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
function positionBias(rows) {
  const d = rows.filter((r) => r.winner && r.shown_left);
  const n = d.length;
  if (!n) return { n: 0, leftRate: NaN, p: NaN };
  const leftWins = d.filter((r) => r.winner === r.shown_left).length;
  const z = (leftWins - n / 2) / Math.sqrt(n / 4);
  return { n, leftRate: leftWins / n, p: 2 * (1 - normCdf(Math.abs(z))) };
}

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

  /* --------------------- back-button visibility (pairwise/choice/end) --------------------- */
  wireBackFlags() {
    this.state.backFlags = this.state.backFlags || { pairwise: false, choice: false, end: false };
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

    ["pairwise", "choice", "end"].forEach((key) => {
      this.db.ref(`control/back_${key}`).on("value", (s) => {
        this.state.backFlags[key] = s.val() === true;
        this.paintBackFlags();
      });
    });

    this.db.ref("participants").on("value", (s) => {
      const all = s.val() || {};
      this.state.participantsRaw = all;
      this.state.participants = Object.keys(all).map((uid) => all[uid]);
      // Participant progress (e.g. finishing pairwise) and pw_plan changes arrive
      // here, not via the comparisons stream — flag the live view dirty so the
      // Results-tab pairwise-progress card reflects them on the next 3s tick.
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
    this.live = { comparisons: [] };
    this.results = { words: {}, assess: {}, choices: {} };
    this._dirty = true; this._paused = false; this._lastUpdate = null; this._liveRefs = []; this._cloudsDrawn = false;
    this.viewSession = this.state.session;

    const addRef = (path, ev, cb) => { const r = this.db.ref(path); r.on(ev, cb); this._liveRefs.push([r, ev, cb]); };
    // Append-only comparison stream: child_added gives existing rows then each new
    // vote. Single node since the Stage-3 redesign (was visual_/text_comparisons);
    // each row carries its own `group`, so per-group BT is a filter, not a node.
    addRef("comparisons", "child_added", (s) => { this.live.comparisons.push(Object.assign({ id: s.key }, s.val())); this._dirty = true; });
    // Small per-user nodes: keep a fresh full snapshot.
    addRef("assessments", "value", (s) => { this.results.assess = s.val() || {}; this._dirty = true; });
    addRef("choices", "value", (s) => { this.results.choices = s.val() || {}; this._dirty = true; });
    addRef("word_responses", "value", (s) => {
      this.results.words = s.val() || {};
      if (!this._cloudsDrawn && this._cloudRedraw) this._cloudRedraw();
    });

    this.renderResults();                                // build the shell (incl. word clouds)
    setTimeout(() => this.renderLive(true), 500);        // first paint once child_added has settled
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
      <p class="hint" style="margin:.2rem 0 .7rem">Rankings &amp; Likert update every 3s; word clouds update when you change a filter or press Redraw. Viewing a past session shows static history. The Python dashboard remains the home for SQLite export &amp; full BT.</p>
      <div id="r-words"></div><div id="r-likert"></div>
      <div id="r-choice"></div>
      <div id="r-pwprog"></div><div id="r-bt"></div><div id="r-export"></div>`;
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
    this.renderChoiceResults(document.getElementById("r-choice"));
    this.renderPairwiseProgress(document.getElementById("r-pwprog"));
    this.renderBtCard(document.getElementById("r-bt"));
    this.renderExport(document.getElementById("r-export"));
    this.updateLiveBar();
  },

  renderWordResults(host) {
    const wordSecs = this.config.sections.filter((s) => s.type === "word_association");
    const total = wordSecs.reduce((n, s) => n + (s.prompts || []).length, 0);
    const card = document.createElement("div"); card.className = "card";
    if (!total) { card.innerHTML = "<h2>Word clouds</h2><div class='muted'>No word prompts.</div>"; host.appendChild(card); return; }
    const fields = this.config.participant_fields || [];
    // One <optgroup> per word section (only when there's more than one) so the
    // host can tell the activities apart in the prompt picker.
    const promptOpts = wordSecs.map((sec) => {
      const opts = (sec.prompts || []).map((p) => `<option value="${esc(p.id)}">${esc(p.text || p.id)}</option>`).join("");
      if (!opts) return "";
      return wordSecs.length > 1 ? `<optgroup label="${esc(sec.label || labelFor(sec))}">${opts}</optgroup>` : opts;
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

  // Live poll bars for the choice section: per question, a bar per option
  // showing share of responses, leading option highlighted. Session-scoped.
  renderChoiceResults(host) {
    if (!host) return;
    const sec = this.config.sections.find((s) => s.type === "choice");
    const questions = (sec && sec.questions) || [];
    if (!sec || !questions.length) { host.innerHTML = ""; return; }

    const tally = {};
    questions.forEach((q) => { tally[q.id] = new Array((q.choices || []).length).fill(0); });
    const data = this.results.choices || {};
    Object.keys(data).forEach((uid) => {
      const byQ = data[uid] || {};
      Object.keys(byQ).forEach((qid) => {
        const rec = byQ[qid];
        if (!this.sessOK(rec) || !tally[qid]) return;
        const i = rec.choice_idx;
        if (typeof i === "number" && i >= 0 && i < tally[qid].length) tally[qid][i]++;
      });
    });

    const blocks = questions.map((q) => {
      const counts = tally[q.id];
      const total = counts.reduce((a, b) => a + b, 0);
      const max = Math.max(0, ...counts);
      const bars = (q.choices || []).map((text, i) => {
        const c = counts[i];
        const pct = total ? Math.round((c / total) * 100) : 0;
        const lead = total > 0 && c === max && c > 0;
        return `<div class="poll-opt ${lead ? "poll-opt--lead" : ""}">
            <div class="poll-opt__text">${ConfigLoader.fmtInline(text)}</div>
            <div class="poll-opt__bar">
              <div class="poll-opt__track"><div class="poll-opt__fill" style="width:${pct}%"></div></div>
              <div class="poll-opt__val">${c} · ${pct}%</div>
            </div>
          </div>`;
      }).join("");
      return `<div class="poll-q"><div class="poll-q__prompt">${ConfigLoader.fmtInline(q.prompt)}</div>${bars}
          <div class="poll-q__total muted">${total} response${total === 1 ? "" : "s"}</div></div>`;
    }).join("");

    host.innerHTML = `<div class="card"><h2>Choice results (live)</h2>${blocks}</div>`;
  },

  // Live per-participant pairwise telemetry (NOT the BT ranking — this is flow
  // position: who's warming up / voting / done, how many votes, what lap/group).
  // Lap is shown only in loop mode (otherwise always 1); current group only in
  // grouped mode (in shuffled mode consecutive pairs jump groups, so "current
  // group" is meaningless and would mislead). Session-scoped via viewSession.
  renderPairwiseProgress(host) {
    if (!host) return;
    const sections = this.config.sections || [];
    const pwIdx = sections.findIndex((s) => s.type === "pairwise");
    const sec = pwIdx >= 0 ? sections[pwIdx] : null;
    if (!sec) { host.innerHTML = ""; return; }
    const loop = !!sec.loop;
    const grouped = sec.sequence_mode === "grouped";

    // Per-uid vote tally + most-recent row (for current group in grouped mode).
    const tally = {}, latest = {};
    (this.live.comparisons || []).forEach((c) => {
      if (!this.sessOK(c)) return;
      tally[c.uid] = (tally[c.uid] || 0) + 1;
      if (!latest[c.uid] || (c.ts || 0) >= (latest[c.uid].ts || 0)) latest[c.uid] = c;
    });

    const praw = this.state.participantsRaw || {};
    let voting = 0, warmup = 0, doneN = 0, notYet = 0;
    const rows = [];
    Object.keys(praw).forEach((uid) => {
      const p = praw[uid] || {};
      if (!this.sessOK(p)) return;
      const secIdx = (p.progress && typeof p.progress.section_idx === "number") ? p.progress.section_idx : 0;
      if (secIdx < pwIdx) { notYet++; return; }            // hasn't reached pairwise — count only
      const votes = tally[uid] || 0;
      const lap = (p.pw_plan && p.pw_plan.lap) || 1;
      let phase, pill;
      if (secIdx > pwIdx)               { phase = "done";    pill = "pill--open"; doneN++; }
      else if (votes > 0 || p.pw_plan)  { phase = "voting";  pill = "pill--on";   voting++; }
      else                              { phase = "warm-up"; pill = "pill--off";  warmup++; }
      const grp = grouped && latest[uid] ? (latest[uid].group || "") : "";
      const meta = [String(votes) + (votes === 1 ? " vote" : " votes"),
                    loop ? `lap ${lap}` : "", grouped && grp ? esc(grp) : ""].filter(Boolean).join(" · ");
      rows.push(`<div class="monitor__row">
          <span><code>${esc(uid.slice(-5))}</code> <span class="pill ${pill}">${phase}</span></span>
          <span class="monitor__count">${meta}</span>
        </div>`);
    });

    const summary = [voting && `${voting} voting`, warmup && `${warmup} warm-up`,
                     doneN && `${doneN} done`, notYet && `${notYet} not yet reached`]
      .filter(Boolean).join(" · ") || "no participants in this session";
    host.innerHTML = `<div class="card"><h2>Pairwise progress (live)</h2>` +
      (rows.length ? rows.join("") : `<div class="muted">No participants have reached the pairwise section yet.</div>`) +
      `<div class="monitor__total">${summary}</div></div>`;
  },

  // One pairwise-ranking card with a group selector. BT is fit PER GROUP only:
  // there are no cross-group comparisons, so a pooled fit would be over a
  // disconnected graph and is not identifiable — hence no "all groups" option.
  // The shell (heading + <select> + body div) is built once and only the body
  // is refilled on the 3s live tick, so a host mid-selection doesn't have the
  // native dropdown yanked shut underneath them.
  renderBtCard(host) {
    if (!host) return;
    const sec = this.config.sections.find((s) => s.type === "pairwise");
    const groups = (sec && sec.groups) || [];
    if (!sec || !groups.length) {
      host.innerHTML = `<div class="card"><h2>Pairwise ranking</h2><div class='muted'>No pairwise section configured.</div></div>`;
      return;
    }
    // Keep btGroup pinned to a real group across session switches / first paint.
    this.btGroup = (this.btGroup && groups.includes(this.btGroup)) ? this.btGroup : groups[0];

    const items = sec.items || [];
    const labelMap = {}; items.forEach((i) => { labelMap[i.id] = i.label || i.id; });

    // Build the shell once (select survives live refreshes; only #bt-body repaints).
    if (!host.querySelector("#bt-group")) {
      const opts = groups.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join("");
      host.innerHTML = `<div class="card"><h2>Pairwise ranking</h2>
        <div class="res-controls"><label>Group <select id="bt-group">${opts}</select></label></div>
        <div id="bt-body"></div></div>`;
      const sel = host.querySelector("#bt-group");
      sel.value = this.btGroup;
      sel.addEventListener("change", (e) => { this.btGroup = e.target.value; this.fillBtBody(host, labelMap); });
    } else {
      // Groups are study-wide (not session-scoped) so the option list is stable;
      // just keep the visible selection in sync with btGroup.
      const sel = host.querySelector("#bt-group");
      if (sel.value !== this.btGroup) sel.value = this.btGroup;
    }
    this.fillBtBody(host, labelMap);
  },

  fillBtBody(host, labelMap) {
    const body = host.querySelector("#bt-body");
    if (!body) return;
    const sec = this.config.sections.find((s) => s.type === "pairwise");
    const groupItemIds = (sec.items || []).filter((i) => i.group === this.btGroup).map((i) => i.id);
    const rows = (this.live.comparisons || []).filter((c) => this.sessOK(c) && c.group === this.btGroup);
    if (!rows.length) {
      body.innerHTML = `<div class='muted'>No comparisons for "${esc(this.btGroup)}" in this session yet.</div>`;
      return;
    }
    const wl = rows.filter((r) => r.winner).map((r) => [r.winner, r.winner === r.item_a ? r.item_b : r.item_a]);
    const fit = btFit(wl, groupItemIds);
    const conn = connectivity(wl, groupItemIds);
    const pb = positionBias(rows);
    const maxAbs = Math.max(0.001, ...fit.map((f) => Math.abs(f.strength || 0)));
    const bars = fit.filter((f) => !isNaN(f.strength)).map((f, i) => {
      const pos = f.strength >= 0;
      const w = (Math.abs(f.strength) / maxAbs) * 48;
      return `<div class="btrow">
          <div class="btrow__label">${i + 1}. ${esc(labelMap[f.item] || f.item)}</div>
          <div class="btrow__track"><div class="btrow__bar" style="${pos ? "left:50%" : "right:50%"};width:${w}%;background:${pos ? "var(--color-accent)" : "#b04a4a"}"></div></div>
          <div class="btrow__val">${f.strength.toFixed(2)} <span class="muted">· ${f.n} · ${(f.winRate * 100).toFixed(0)}%</span></div>
        </div>`;
    }).join("");
    body.innerHTML = `
        <div class="res-diag">
          <span><strong>${rows.length}</strong> comparisons</span>
          <span>graph: <strong class="${conn.components === 1 ? "ok" : "bad"}">${conn.components} component${conn.components === 1 ? "" : "s"}</strong></span>
          <span>left-win: <strong>${(pb.leftRate * 100).toFixed(0)}%</strong> (p=${pb.p.toFixed(2)})</span>
        </div>
        ${conn.components > 1 ? `<div class="res-warn">Graph disconnected — rankings not comparable across components. Isolated: ${esc(conn.isolated.join(", ") || "none")}</div>` : ""}
        <div class="btchart">${bars}</div>`;
  },

  renderExport(host) {
    const pById = this.state.participantsRaw;
    const fieldIds = (this.config.participant_fields || []).map((f) => f.id);
    const dims = (this.config.likert.dimensions || []).map((d) => d.id);

    const participants = Object.keys(pById).map((uid) => {
      const p = pById[uid] || {}; const row = { uid, session: p.session, section_idx: (p.progress || {}).section_idx, created_at: p.created_at };
      fieldIds.forEach((f) => { row[f] = (p.fields || {})[f]; }); return row;
    }).filter((r) => this.sessOK(r));

    const words = [];
    Object.keys(this.results.words || {}).forEach((uid) => Object.keys(this.results.words[uid] || {}).forEach((pid) => {
      const rec = this.results.words[uid][pid]; if (!this.sessOK(rec)) return;
      (rec.words || []).forEach((w) => words.push({ uid, prompt_id: pid, word: w, session: rec.session }));
    }));

    const assess = [];
    Object.keys(this.results.assess || {}).forEach((uid) => Object.keys(this.results.assess[uid] || {}).forEach((sid) => {
      const rec = this.results.assess[uid][sid]; if (!this.sessOK(rec)) return;
      const row = { uid, stimulus_id: sid, session: rec.session }; dims.forEach((d) => { row[d] = rec[d]; }); assess.push(row);
    }));

    const choiceSec = this.config.sections.find((s) => s.type === "choice");
    const qChoices = {}; ((choiceSec && choiceSec.questions) || []).forEach((q) => { qChoices[q.id] = q.choices || []; });
    const choices = [];
    Object.keys(this.results.choices || {}).forEach((uid) => Object.keys(this.results.choices[uid] || {}).forEach((qid) => {
      const rec = this.results.choices[uid][qid]; if (!this.sessOK(rec)) return;
      choices.push({ uid, question_id: qid, choice_idx: rec.choice_idx, choice_text: ConfigLoader.stripMarkup((qChoices[qid] || [])[rec.choice_idx] || ""), session: rec.session });
    }));

    const comps = () => (this.live.comparisons || []).filter((r) => this.sessOK(r));
    const tag = (this.viewSession === "(all)" || this.viewSession === "(none set)") ? "all" : this.viewSession;
    const sets = [
      ["participants", participants, ["uid", "session", "section_idx", "created_at", ...fieldIds]],
      ["word_responses", words, ["uid", "prompt_id", "word", "session"]],
      ["assessments", assess, ["uid", "stimulus_id", ...dims, "session"]],
      ["choices", choices, ["uid", "question_id", "choice_idx", "choice_text", "session"]],
      ["comparisons", comps(), ["id", "uid", "group", "lap", "item_a", "item_b", "winner", "shown_left", "shown_right", "session", "ts"]]
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
