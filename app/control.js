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

// Small inline-SVG icons (stroke = currentColor, so they inherit button colour).
const ICON_PATHS = {
  restore: '<polyline points="7 3 3.5 6.5 7 10"/><path d="M3.5 6.5H10a3 3 0 0 1 3 3V13"/>',
  x:       '<path d="M4 4 12 12"/><path d="M12 4 4 12"/>',
  split:   '<path d="M8 4v8"/><path d="M6.5 8H2.5"/><path d="M4.3 6 2.3 8l2 2"/><path d="M9.5 8h4"/><path d="M11.7 6l2 2-2 2"/>',
  merge:   '<path d="M2.5 8h4"/><path d="M4.5 6 6.5 8 4.5 10"/><path d="M13.5 8h-4"/><path d="M11.5 6 9.5 8l2 2"/>',
  star:    '<path d="M8 2.3 9.7 5.9l3.9.4-2.9 2.7.8 3.9L8 11l-3.5 1.9.8-3.9L2.4 6.3l3.9-.4z"/>',
  undo:    '<polyline points="7 3 3.5 6.5 7 10"/><path d="M3.5 6.5H10a3 3 0 0 1 3 3V13"/>',
  redo:    '<polyline points="9 3 12.5 6.5 9 10"/><path d="M12.5 6.5H6a3 3 0 0 0-3 3V13"/>'
};
function icon(name) {
  const filled = name === "star";
  const paint = filled ? 'fill="currentColor" stroke="none"' : 'fill="none" stroke="currentColor" stroke-width="1.5"';
  return `<svg class="ic" viewBox="0 0 16 16" width="14" height="14" ${paint} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ""}</svg>`;
}

// Small "i" info button that reveals a popover of instructional text on click,
// so guidance isn't constantly on screen. Toggling is handled by one delegated
// capture-phase listener (see wireInfo).
function info(text) {
  return `<span class="info"><button type="button" class="info__btn" aria-label="More info" title="More info">i</button><span class="info__pop">${esc(text)}</span></span>`;
}

const SECTION_LABELS = {
  welcome: "Welcome",
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
    const gated = this.config.sections.filter((s) => s.gate && s.type !== "assessment" && s.type !== "notice");
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

        <!-- Persistent facilitation panel: always available while running -->
        <div id="facil" class="facil facil--collapsed">
          <div class="facil__bar">
            <button id="facil-toggle" class="facil__togglebtn" aria-expanded="false">
              <span class="facil__chev">▸</span> <span id="facil-summary">Live: —</span>
            </button>
            <div class="facil__quick">
              <input id="bc-text" class="facil__bcinput" type="text" placeholder="Broadcast a message…" autocomplete="off">
              <button id="bc-send" class="btn-sm btn-sm--accent">Send</button>
              <button id="bc-clear" class="btn-sm">Clear</button>
              <span class="facil__sep" aria-hidden="true"></span>
              <select id="force-section-select" class="facil__moveselect" title="Move everyone to…">${this.config.sections.map((s) => `<option value="${esc(s.id)}">${esc(labelFor(s))}</option>`).join("")}</select>
              <button id="force-section-go" class="btn-sm btn-sm--danger">Move</button>
            </div>
          </div>
          <div id="bc-current" class="facil__bccur"></div>
          <div class="facil__body">
            <div class="facil__sec">
              <div class="facil__h">Live participation</div>
              <div id="monitor" class="monitor"><div class="muted">Loading…</div></div>
            </div>
            <div class="facil__sec">
              <div class="facil__h">Gating</div>
              <div class="row">
                <div><div class="row__label">Gate master switch</div>
                  <div class="row__sub">When off, self-paced sections ignore gates (word cloud still waits for you).</div></div>
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
          </div>
        </div>

        <div class="ctrl-tabs">
          <button id="tabbtn-setup" class="ctrl-tab">Setup</button>
          <button id="tabbtn-wordcloud" class="ctrl-tab ctrl-tab--on">Word cloud</button>
          <button id="tabbtn-assessment" class="ctrl-tab">Assessment</button>
          <button id="tabbtn-results" class="ctrl-tab">Results</button>
        </div>

        <div id="live-bar" class="live-bar" style="display:none">
          <span class="live-dot" aria-hidden="true"></span>
          <span id="live-status">Live</span>
          <label class="live-sess">Session <select id="view-session"></select></label>
          <button id="live-pause" class="btn-sm">Pause</button>
        </div>

        <div id="tab-setup" style="display:none">
          <div class="card">
            <h2>Workshop sessions ${info("Only the active session accepts participants; when none is active, entry and all writes are frozen. Create sessions ahead of time; on the day, Activate the right one (this locks all gates and clears previous host state). Deactivate to freeze data at the end. No data is deleted.")}</h2>
            <p class="hint">Active session: <strong id="cur-session">…</strong></p>
            <div class="field">
              <input id="session-input" type="text" placeholder="new session name, e.g. accra-2026-03" />
              <button id="session-create" class="btn-sm">Create session</button>
            </div>
            <div id="session-list" class="session-list"><div class="muted">Loading…</div></div>
            <div style="border-top:1px solid var(--color-border);margin-top:.7rem;padding-top:.7rem">
              <button id="reset-participants" class="btn-sm btn-sm--danger">Reset all participants ${info("Clears everyone's progress and responses and sends connected participants back to the welcome screen. Handy for un-sticking people during testing. Sessions are kept.")}</button>
            </div>
          </div>
          <div class="card">
            <h2>Back button visibility ${info("These screens hide Back by default. Switch each on independently if you want participants able to return.")}</h2>
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
            <h2>Danger zone</h2>
            <details class="danger">
              <summary>Clear all data before the first real workshop</summary>
              <p class="hint">Permanently deletes <strong>every</strong> participant, response, word-cleaning decision, and session, and resets host state. Use this once to wipe test/dev data before your first workshop. This cannot be undone.</p>
              <div class="field">
                <input id="wipe-confirm" type="text" placeholder="type DELETE ALL to enable" autocomplete="off" />
                <button id="wipe-go" class="btn-sm btn-sm--danger" disabled>Clear everything</button>
              </div>
              <p class="hint" id="wipe-status"></p>
            </details>
          </div>
        </div><!-- /tab-setup -->

        <div id="tab-wordcloud" style="display:none">
          ${wc ? `
          <div class="card" id="wc-card">
            <h2>Run the word cloud ${info("Everyone sees the prompt you pick, with the input open. Move to the next prompt when the room is done. Open the word-cloud gate in the Gating panel above to let people in. The live cloud is below.")}</h2>
            <div class="disc-nav">
              <button id="wc-prev" class="btn-sm">‹ Prev</button>
              <span id="wc-pos">– / ${wcPrompts.length}</span>
              <button id="wc-next" class="btn-sm">Next ›</button>
            </div>
            <div id="wc-preview" class="disc-preview muted"></div>
            <div id="wc-count" class="hint" style="margin-top:.6rem"></div>
          </div>` : ""}
          <div id="r-words"></div>
        </div><!-- /tab-wordcloud -->

        <div id="tab-assessment" style="display:none">
          ${assess ? `
          <div class="card" id="assess-card">
            <h2>Run the assessment ${info("Everyone sees the figure you pick. Discuss it, then reveal the scale so participants can score it. Moving to the next figure hides the scale again. Use \u201cMove everyone\u201d in the panel to bring the room in.")}</h2>
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
          </div>` : ""}
          <div id="r-likert"></div>
        </div><!-- /tab-assessment -->

        <div id="tab-results" style="display:none">
          <div id="r-choice"></div>
          <div id="r-export"></div>
        </div><!-- /tab-results -->
      </div>`;

    document.getElementById("signout").addEventListener("click", () => firebase.auth().signOut());
    this.wireInfo();
    this.wireFacilPanel();
    this.wireSession();
    this.wireGating(gated);
    this.wireAssessment();
    this.wireWordcloud();
    this.wireBackFlags();
    this.wireBroadcast();
    this.wireForceSection();
    this.wireTabs();
    this.wireCleanup();
    this.subscribe(gated);
    this.startLive();
    this.wireCollapsible();
  },

  // Persistent facilitation panel: collapse/expand toggle. Broadcast and move
  // are inline in the bar (always usable without expanding); expanding reveals
  // the full monitor and gating.
  // One capture-phase listener drives every info popover: it runs before the
  // card-collapse handler on <h2>, so clicking an info button inside a heading
  // toggles the popover without collapsing the card. Works for buttons added
  // later (word-cloud toolkit) too, since it's delegated.
  wireInfo() {
    if (this._infoWired) return;
    this._infoWired = true;
    document.addEventListener("click", (e) => {
      const btn = e.target.closest && e.target.closest(".info__btn");
      if (btn) {
        e.stopPropagation(); e.preventDefault();
        const box = btn.parentElement;
        const wasOpen = box.classList.contains("info--open");
        document.querySelectorAll(".info--open").forEach((o) => o.classList.remove("info--open"));
        if (!wasOpen) box.classList.add("info--open");
      } else if (!(e.target.closest && e.target.closest(".info"))) {
        document.querySelectorAll(".info--open").forEach((o) => o.classList.remove("info--open"));
      }
    }, true);
  },

  wireFacilPanel() {
    const panel = document.getElementById("facil");
    const toggle = document.getElementById("facil-toggle");
    const setOpen = (open) => {
      panel.classList.toggle("facil--collapsed", !open);
      toggle.setAttribute("aria-expanded", String(open));
      toggle.querySelector(".facil__chev").textContent = open ? "▾" : "▸";
    };
    setOpen(localStorage.getItem("RISKVIZ_FACIL_OPEN") === "1");
    toggle.addEventListener("click", () => {
      const open = panel.classList.contains("facil--collapsed");
      setOpen(open);
      localStorage.setItem("RISKVIZ_FACIL_OPEN", open ? "1" : "0");
    });
  },

  // Make every card collapsible by clicking its <h2>. Collapse state is keyed by
  // the header text, defaults to collapsed (so a fresh load shows just titles),
  // and persists across reloads in localStorage. A card the host has explicitly
  // toggled keeps that choice; only not-yet-seen cards use the collapsed default.
  _loadCollapsed() {
    if (this._collapsed) return this._collapsed;
    try { this._collapsed = JSON.parse(localStorage.getItem("RISKVIZ_CARD_COLLAPSED") || "{}") || {}; }
    catch (e) { this._collapsed = {}; }
    return this._collapsed;
  },
  wireCollapsible(root) {
    const state = this._loadCollapsed();
    (root || document).querySelectorAll(".card > h2").forEach((h) => {
      const card = h.parentElement;
      const key = (h.textContent || "").trim();
      // Unseen card → default collapsed; seen card → its remembered state.
      const collapsed = (key in state) ? state[key] : true;
      card.classList.toggle("card--collapsed", collapsed);
      if (h._collapWired) return;
      h._collapWired = true;
      h.addEventListener("click", () => {
        const now = card.classList.toggle("card--collapsed");
        state[key] = now;
        try { localStorage.setItem("RISKVIZ_CARD_COLLAPSED", JSON.stringify(state)); } catch (e) { /* ignore */ }
      });
    });
  },

  wireTabs() {
    const tabs = ["setup", "wordcloud", "assessment", "results"];
    const analytical = { wordcloud: true, assessment: true, results: true };
    const show = (tab) => {
      this.tab = tab;
      tabs.forEach((t) => {
        document.getElementById("tab-" + t).style.display = (t === tab) ? "" : "none";
        document.getElementById("tabbtn-" + t).classList.toggle("ctrl-tab--on", t === tab);
      });
      // The session/live bar is shared across analytical tabs, hidden on Setup.
      document.getElementById("live-bar").style.display = analytical[tab] ? "" : "none";
    };
    tabs.forEach((t) => document.getElementById("tabbtn-" + t).addEventListener("click", () => show(t)));
    show("wordcloud");
  },

  /* ----------------------------- session ----------------------------- */
  seqSafe(name) { return String(name).replace(/[.#$/\[\]]/g, "_"); },

  wireSession() {
    document.getElementById("session-create").addEventListener("click", async () => {
      const name = document.getElementById("session-input").value.trim();
      if (!name) { alert("Type a session name first."); return; }
      if (/[.#$/\[\]]/.test(name)) { alert("Session name can't contain . # $ / [ ]"); return; }
      if (this._sessions && this._sessions[name]) { alert("That session already exists."); return; }
      try {
        await this.db.ref(`sessions/${name}`).set({ created_at: firebase.database.ServerValue.TIMESTAMP, active: false });
        document.getElementById("session-input").value = "";
      } catch (e) { alert("Could not create session: " + e.message); }
    });
    // Live list of sessions + which one is active.
    this.db.ref("sessions").on("value", (s) => { this._sessions = s.val() || {}; this.renderSessionList(); });
    const reset = document.getElementById("reset-participants");
    if (reset) reset.addEventListener("click", () => this.resetParticipants());
    this.db.ref("control/active_session").on("value", (s) => {
      this._activeSession = s.val() || null;
      const el = document.getElementById("cur-session");
      if (el) el.textContent = this._activeSession || "none (frozen)";
      this.renderSessionList();
    });
  },

  renderSessionList() {
    const host = document.getElementById("session-list");
    if (!host) return;
    const names = Object.keys(this._sessions || {}).sort();
    if (!names.length) { host.innerHTML = "<div class='muted'>No sessions yet. Create one above.</div>"; return; }
    const active = this._activeSession;
    host.innerHTML = names.map((name) => {
      const isActive = name === active;
      return `<div class="session-row ${isActive ? "session-row--on" : ""}">
        <div class="session-row__name">${esc(name)} ${isActive ? '<span class="pill pill--open">ACTIVE</span>' : ""}</div>
        <div class="session-row__acts">
          <button class="btn-sm ${isActive ? "" : "btn-sm--accent"} session-act" data-name="${esc(name)}" data-act="${isActive ? "off" : "on"}">${isActive ? "Deactivate" : "Activate"}</button>
          ${isActive ? "" : `<button class="btn-sm btn-sm--danger session-del" data-name="${esc(name)}">Delete</button>`}
        </div>
      </div>`;
    }).join("");
    host.querySelectorAll(".session-act").forEach((b) => b.addEventListener("click", () => {
      if (b.dataset.act === "on") this.activateSession(b.dataset.name);
      else this.deactivateSession(b.dataset.name);
    }));
    host.querySelectorAll(".session-del").forEach((b) => b.addEventListener("click", () => this.deleteSession(b.dataset.name)));
  },

  async deleteSession(name) {
    if (name === this._activeSession) { alert("Deactivate this session before deleting it."); return; }
    if (!confirm(`Delete session "${name}"?\n\nThis removes it from the session list only. Responses already collected under this name are NOT deleted and stay viewable in Results. Re-creating a session with the same name re-links them.`)) return;
    try { await this.db.ref(`sessions/${name}`).remove(); }
    catch (e) { alert("Could not delete: " + e.message); }
  },

  // Tucked-away, type-to-confirm full wipe. Deletes all data-node children
  // (participants/word_responses/assessments/choices), the per-session counters,
  // and the whole sessions + control subtrees. Admin-only by rules.
  wireCleanup() {
    const input = document.getElementById("wipe-confirm");
    const go = document.getElementById("wipe-go");
    if (!input || !go) return;
    input.addEventListener("input", () => { go.disabled = input.value.trim() !== "DELETE ALL"; });
    go.addEventListener("click", () => this.cleanupAll());
  },

  // Delete all participant records, responses, and per-session counters.
  // Shared by "reset participants" and the full cleanup. Admin-only by rules.
  async _clearParticipantData(setStatus) {
    for (const node of ["participants", "word_responses", "assessments", "choices"]) {
      if (setStatus) setStatus(`Clearing ${node}…`);
      const snap = await this.db.ref(node).once("value");
      const val = snap.val() || {};
      const upd = {};
      Object.keys(val).forEach((k) => { upd[k] = null; });
      if (Object.keys(upd).length) await this.db.ref(node).update(upd);
    }
    const names = new Set(Object.keys(this._sessions || {}));
    Object.values(this.state.participantsRaw || {}).forEach((p) => { if (p && p.session) names.add(p.session); });
    if (names.size) {
      if (setStatus) setStatus("Clearing counters…");
      const seqUpd = {};
      names.forEach((n) => { seqUpd[n] = null; });
      await this.db.ref("participant_seq").update(seqUpd);
    }
  },

  // Send every connected participant back to the welcome screen as if entering
  // for the first time: clear their record + responses, then push a reset signal
  // that reloads their open app. Session markers and control state are kept.
  async resetParticipants() {
    if (!confirm("Reset ALL participants?\n\nThis clears everyone's progress and responses and sends every connected participant back to the welcome screen, as if entering for the first time. Session markers are kept. Handy for un-sticking participants during testing.")) return;
    try {
      await this._clearParticipantData();
      await this.db.ref("control/reset").set(firebase.database.ServerValue.TIMESTAMP);
      alert("All participants reset. Open apps will return to the welcome screen.");
    } catch (e) {
      alert("Reset failed: " + e.message);
    }
  },

  async cleanupAll() {
    const input = document.getElementById("wipe-confirm");
    const status = document.getElementById("wipe-status");
    if (!input || input.value.trim() !== "DELETE ALL") return;
    if (!confirm("Final check: permanently delete ALL workshop data and sessions? This cannot be undone.")) return;
    const setStatus = (t) => { if (status) status.textContent = t; };
    try {
      await this._clearParticipantData(setStatus);
      setStatus("Resetting sessions & host state…");
      await this.db.ref("control").set(null);
      await this.db.ref("sessions").set(null);
      setStatus("");
      input.value = "";
      document.getElementById("wipe-go").disabled = true;
      alert("All workshop data cleared. Create and activate a fresh session to begin.");
    } catch (e) {
      setStatus("Cleanup failed: " + e.message);
    }
  },

  async activateSession(name) {
    if (!confirm(`Activate "${name}"?\n\nParticipants will be able to join and submit. Any other active session is deactivated, all gates are re-locked, and host presentation state is reset. No data is deleted.`)) return;
    // Flip active flags: this one on, all others off.
    const sessUpdate = {};
    Object.keys(this._sessions || {}).forEach((n) => { sessUpdate[`${n}/active`] = (n === name); });
    // Control: point active_session here, mirror to session (legacy/results view),
    // re-lock gates, reset host-driven presentation state.
    const gates = {};
    this.config.sections.filter((s) => s.gate).forEach((s) => { gates[s.id] = "locked"; });
    const ctrl = { active_session: name, session: name, section_gates: gates };
    this.config.sections.filter((s) => s.type === "assessment").forEach((s) => { ctrl[`pres/${s.id}`] = { idx: 0, likert_shown: false }; });
    this.config.sections.filter((s) => s.type === "wordcloud").forEach((s) => { ctrl[`pres/${s.id}`] = { idx: 0 }; });
    try {
      await this.db.ref("sessions").update(sessUpdate);
      await this.db.ref("control").update(ctrl);
    } catch (e) { alert("Could not activate: " + e.message); }
  },

  async deactivateSession(name) {
    if (!confirm(`Deactivate "${name}"?\n\nData is frozen: participants can no longer join or submit. No data is deleted. You can re-activate later.`)) return;
    try {
      await this.db.ref(`sessions/${name}/active`).set(false);
      await this.db.ref("control/active_session").remove();   // null = nothing active = frozen
    } catch (e) { alert("Could not deactivate: " + e.message); }
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
    const send = async () => {
      const input = document.getElementById("bc-text");
      const text = input.value.trim();
      if (!text) return;
      await this.db.ref("control/broadcast").set({ text, ts: firebase.database.ServerValue.TIMESTAMP });
      input.value = "";
    };
    document.getElementById("bc-send").addEventListener("click", send);
    document.getElementById("bc-text").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); send(); }
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
      // Mirror of the active session name; stays at the last name when frozen so
      // the monitor and results still reference the just-run workshop. The
      // "active vs frozen" label (cur-session) is owned by the active_session
      // listener in wireSession.
      this.state.session = s.val() || "(none set)";
      // Follow the active session in the results view until the host explicitly
      // picks a different one from the session selector.
      if (!this._viewPinned) {
        this.viewSession = this.state.session;
        this.refreshLiveBarOptions();
        this._dirty = true;
        this.renderLive(true);
      }
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
      if (this.state.gatingEnabled && sec.gate && sec.type !== "assessment" && sec.type !== "notice" && this.state.gates[sec.id] !== "open") waiting[idx]++;
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

    // Compact one-line summary for the collapsed facilitation bar: where most
    // people are + total waiting.
    const summary = document.getElementById("facil-summary");
    if (summary) {
      const totalWaiting = waiting.reduce((a, b) => a + b, 0);
      let topIdx = -1, topN = 0;
      counts.forEach((c, i) => { if (c > topN) { topN = c; topIdx = i; } });
      const where = topIdx >= 0 ? `${topN} in ${labelFor(sections[topIdx])}` : (done ? `${done} finished` : "no participants yet");
      summary.textContent = `Live: ${where}${totalWaiting ? ` · ${totalWaiting} waiting` : ""} · ${inSession.length} total`;
    }
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

  // Live data now runs continuously (not only on the Results tab), because the
  // word cloud, assessment Likert, and results are spread across activity tabs
  // that stay mounted. Started once from renderPanel.
  startLive() {
    this.stopLive();
    this.results = { words: {}, assess: {}, choices: {} };
    this._dirty = true; this._paused = false; this._lastUpdate = null; this._liveRefs = []; this._cloudsDrawn = false;
    this.viewSession = this.state.session;

    const addRef = (path, ev, cb) => { const r = this.db.ref(path); r.on(ev, cb); this._liveRefs.push([r, ev, cb]); };
    addRef("assessments", "value", (s) => { this.results.assess = s.val() || {}; this._dirty = true; this.paintAssessCard(); });
    addRef("choices", "value", (s) => { this.results.choices = s.val() || {}; this._dirty = true; });
    addRef("word_responses", "value", (s) => {
      this.results.words = s.val() || {};
      this.paintWcCard();
      if (!this._cloudsDrawn && this._cloudRedraw) this._cloudRedraw();
    });

    this.wireLiveBar();
    this.renderWordResults(document.getElementById("r-words"));   // word cloud toolkit (its own tab)
    setTimeout(() => this.renderLive(true), 500);
    this._liveTimer = setInterval(() => { if (this._dirty && !this._paused) this.renderLive(); }, 3000);
  },

  stopLive() {
    if (this._liveTimer) { clearInterval(this._liveTimer); this._liveTimer = null; }
    (this._liveRefs || []).forEach(([r, ev, cb]) => r.off(ev, cb));
    this._liveRefs = [];
  },

  // Populate + wire the shared session/live bar (session picker, pause).
  wireLiveBar() {
    const sel = document.getElementById("view-session");
    if (!sel) return;
    const sessions = this.allSessions();
    sel.innerHTML = sessions.map((s) => `<option value="${esc(s)}"${s === this.viewSession ? " selected" : ""}>${esc(s)}</option>`).join("")
      + `<option value="(all)"${this.viewSession === "(all)" ? " selected" : ""}>(all sessions)</option>`;
    document.getElementById("live-pause").addEventListener("click", (e) => {
      this._paused = !this._paused;
      e.target.textContent = this._paused ? "Resume" : "Pause";
      this.updateLiveBar();
      if (!this._paused) this.renderLive(true);
    });
    sel.addEventListener("change", (e) => {
      this.viewSession = e.target.value;
      this._viewPinned = true;
      this._cloudsDrawn = false;
      this.renderLive(true);
      if (this._cloudRedraw) this._cloudRedraw();
      this.updateLiveBar();
    });
    this.updateLiveBar();
  },

  // Keep the session picker options fresh as new sessions produce data.
  refreshLiveBarOptions() {
    const sel = document.getElementById("view-session");
    if (!sel) return;
    const sessions = this.allSessions();
    const want = sessions.map((s) => `<option value="${esc(s)}"${s === this.viewSession ? " selected" : ""}>${esc(s)}</option>`).join("")
      + `<option value="(all)"${this.viewSession === "(all)" ? " selected" : ""}>(all sessions)</option>`;
    if (sel.innerHTML !== want) sel.innerHTML = want;
  },

  updateLiveBar() {
    const st = document.getElementById("live-status");
    const bar = document.getElementById("live-bar");
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
    this.refreshLiveBarOptions();
    this.renderLikert(document.getElementById("r-likert"));
    this.renderQuestionnaireResults(document.getElementById("r-choice"));
    this.renderExport(document.getElementById("r-export"));
    this.updateLiveBar();
    this.wireCollapsible();
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
      </div>
      <div class="res-actions">
        <button id="wc-redraw" class="btn-sm">↻ Redraw</button>
        <button id="wc-export" class="btn-sm">⬇ PNG</button>
        <button id="wc-export-csv" class="btn-sm">⬇ CSV</button>
      </div>
      <div class="res-actions">
        <button id="wc-clean" class="btn-sm btn-sm--accent">🧹 Clean words (AI)</button>
        <button id="wc-broadcast" class="btn-sm btn-sm--accent">📡 Broadcast to participants</button>
      </div>
      <div id="wc-clean-status" class="hint"></div>
      <details class="wc-ai-setup">
        <summary>AI cleaning setup</summary>
        <div class="wc-ai-setup__body">
          <div class="hint" style="flex-basis:100%">Provider: <b>Gemini (Google)</b>. Cleaning runs from this browser using your key.</div>
          <label>Model <input id="wc-ai-model" type="text" placeholder="(default)" autocomplete="off"></label>
          <label>API key <input id="wc-ai-key" type="password" placeholder="paste key (stored only in this browser)" autocomplete="off"></label>
          <button id="wc-ai-save" class="btn-sm">Save</button>
          <button id="wc-ai-check" class="btn-sm">Check models</button>
          <span id="wc-ai-saved" class="hint"></span>
          <div class="hint">The key stays in this browser only, never uploaded. Use a trusted host computer, not a shared one. The Model box is used as typed (no need to Save first); Save just remembers it for next time.</div>
          <div id="wc-ai-models" class="hint" style="flex-basis:100%"></div>
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
  aiDefaultModel() {
    // Google is retiring the 2.5 flash line for new keys; 3.x flash is the
    // current default. Use "Check models" to see exactly what your key allows.
    return "gemini-3.6-flash";
  },
  // Read the live fields first (so what's typed is used immediately, no Save
  // needed), then fall back to the saved value, then the default.
  aiConfig() {
    const modelEl = document.getElementById("wc-ai-model");
    const keyEl = document.getElementById("wc-ai-key");
    const liveModel = modelEl ? modelEl.value.trim() : "";
    const liveKey = keyEl ? keyEl.value.trim() : "";
    const model = liveModel || (localStorage.getItem("RISKVIZ_AI_MODEL") || "").trim() || this.aiDefaultModel();
    const key = liveKey || localStorage.getItem("RISKVIZ_AI_KEY") || "";
    return { provider: "gemini", key, model };
  },
  wireAiSetup() {
    const key = document.getElementById("wc-ai-key");
    const model = document.getElementById("wc-ai-model");
    if (!model) return;
    key.value = localStorage.getItem("RISKVIZ_AI_KEY") || "";
    model.value = (localStorage.getItem("RISKVIZ_AI_MODEL") || "").trim();
    model.placeholder = `(default: ${this.aiDefaultModel()})`;
    document.getElementById("wc-ai-save").addEventListener("click", () => {
      localStorage.setItem("RISKVIZ_AI_KEY", key.value.trim());
      localStorage.setItem("RISKVIZ_AI_MODEL", model.value.trim());
      const saved = document.getElementById("wc-ai-saved");
      if (saved) { saved.textContent = "Saved."; setTimeout(() => { saved.textContent = ""; }, 2000); }
    });
    document.getElementById("wc-ai-check").addEventListener("click", () => this.checkModels());
  },

  // List the models this key can actually call (definitive, per-account), and
  // let the host click one to fill the Model field.
  async checkModels() {
    const out = document.getElementById("wc-ai-models");
    const keyEl = document.getElementById("wc-ai-key");
    const key = (keyEl ? keyEl.value.trim() : "") || localStorage.getItem("RISKVIZ_AI_KEY") || "";
    if (!key) { if (out) out.textContent = "Add your API key first."; return; }
    if (out) out.textContent = "Checking…";
    let res;
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=200`);
    } catch (e) { if (out) out.textContent = "Check failed (network/CORS): " + e.message; return; }
    if (!res.ok) { if (out) out.textContent = `Could not list models (${res.status}): ${(await res.text()).slice(0, 140)}`; return; }
    const data = await res.json();
    const models = (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).indexOf("generateContent") !== -1)
      .map((m) => String(m.name || "").replace(/^models\//, ""))
      .filter((n) => n.indexOf("gemini") === 0)
      .sort();
    if (!models.length) { if (out) out.textContent = "No text-generation Gemini models available for this key."; return; }
    out.innerHTML = "Models your key can use (click to select):<br>"
      + models.map((n) => `<button class="btn-sm wc-model-pick" data-m="${esc(n)}">${esc(n)}</button>`).join(" ");
    out.querySelectorAll(".wc-model-pick").forEach((b) => b.addEventListener("click", () => {
      const mf = document.getElementById("wc-ai-model");
      if (mf) mf.value = b.dataset.m;
      localStorage.setItem("RISKVIZ_AI_MODEL", b.dataset.m);
    }));
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
          backgroundColor: "#ffffff", rotateRatio: 0.3,
          // Shrink an over-large word to fit the canvas instead of silently
          // dropping it (the cause of words intermittently disappearing).
          shrinkToFit: true, drawOutOfBound: false
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
    if (!cfg.key) { if (status) status.textContent = "Add your API key in 'AI cleaning setup' first."; return; }
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
      + "removed = (a) gibberish/nonsense (e.g. random letters), and (b) profanity, curse words, slurs, "
      + "racial/ethnic slurs, sexual or anatomical terms (e.g. genitalia), and other offensive or sensitive "
      + "words, in ANY language. Give a short reason ('gibberish', 'profanity', 'slur', 'sexual term'). "
      + "Do NOT remove ordinary real words that merely relate to the topic. "
      + "merges = groups of terms that mean the same thing or are minor typos of each other "
      + "(e.g. tv/television, televsion/television). Only group clear synonyms or typos, not merely related words. "
      + "Every term/member must be copied verbatim from the input list. Output nothing but the JSON.";
    const payload = terms.map((t) => `${t} (${counts[t]})`).join(", ");
    const user = "Terms with counts:\n" + payload;
    const text = await this._callGemini(cfg.key, cfg.model, sys, user);
    return this._parseProposal(text, terms);
  },

  // Shared fetch with a friendly quota message and a small backoff for transient
  // per-minute 429s. Fails fast on daily-limit / hard-zero quota (retrying is
  // pointless). `label` names the provider for error text.
  async _aiFetch(label, url, opts) {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res;
      try {
        res = await fetch(url, opts);
      } catch (e) {
        throw new Error(`${label}: network/CORS error (${e.message}). The provider must allow browser requests.`);
      }
      if (res.ok) return res;
      const body = await res.text();
      if (res.status === 429) {
        const daily = /daily|per day|RESOURCE_EXHAUSTED|limit['"\s:]*0|quota/i.test(body);
        const perDay = /daily|per day/i.test(body);
        // Retry only transient per-minute limits, and only if it doesn't look
        // like a daily / zero-quota exhaustion.
        if (attempt < maxAttempts && !perDay) {
          await new Promise((r) => setTimeout(r, attempt * 1500));
          continue;
        }
        throw new Error(`${label}: quota/rate limit (429). This is an account or model-quota issue, not a bug. Try a lighter model (e.g. a flash/lite or 8B model) or wait and retry.${daily ? " Your daily free quota may be used up." : ""}`);
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(`${label}: auth error (${res.status}). Check the API key for this provider.`);
      }
      throw new Error(`${label} ${res.status}: ${body.slice(0, 160)}`);
    }
  },

  async _callGemini(key, model, sys, user) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
    const res = await this._aiFetch("Gemini", url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: sys }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { responseMimeType: "application/json" }
      })
    });
    const data = await res.json();
    return ((((data.candidates || [])[0] || {}).content || {}).parts || []).map((p) => p.text || "").join("");
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

  // Manually remove a word (host judgement, on top of the LLM). Writes ts too so
  // the record is valid even if this is the first cleaning action for the prompt.
  async manualRemove(promptId, term) {
    const session = this.viewSession;
    if (!session || session === "(all)") return;
    await this.db.ref(`control/word_cleaning/${session}/${promptId}`).update({
      ts: firebase.database.ServerValue.TIMESTAMP,
      [`removed/${term}`]: { reason: "removed by host", overridden: false }
    });
  },

  // Set which member of a merge group is the canonical (shown) term. Also clears
  // any split flag on that member, since the canonical is always included.
  async setCanonical(promptId, canonKey, mem) {
    const session = this.viewSession;
    if (!session || session === "(all)") return;
    await this.db.ref(`control/word_cleaning/${session}/${promptId}/merges/${canonKey}`).update({
      canonical: mem,
      [`split/${mem}`]: null
    });
  },

  renderCleaningReview(promptId) {
    const el = document.getElementById("wc-review");
    if (!el) return;
    const dec = ((this._cleaning || {})[this.viewSession] || {})[promptId];
    // Show the panel whenever a cleaning run exists for this prompt (even with no
    // removals/merges), so the manual-removal list is available afterwards.
    if (!dec) { el.innerHTML = ""; return; }
    const removed = dec.removed || {}, merges = dec.merges || {};
    const remRows = Object.keys(removed).sort().map((t) => {
      const r = removed[t];
      return `<div class="wc-rev__row ${r.overridden ? "wc-rev__row--off" : ""}">
        <span class="wc-rev__term">${esc(t)}</span>
        <span class="wc-rev__reason">${esc(r.reason || "removed")}</span>
        <button class="btn-sm btn-icon ${r.overridden ? "btn-icon--danger" : ""} wc-rev-remove" data-term="${esc(t)}" data-to="${r.overridden ? "0" : "1"}" title="${r.overridden ? "Remove again" : "Put back"}" aria-label="${r.overridden ? "Remove again" : "Put back"}">${r.overridden ? icon("x") : icon("restore")}</button>
      </div>`;
    }).join("");
    const merRows = Object.keys(merges).sort().map((canon) => {
      const m = merges[canon];
      const members = Array.isArray(m.members) ? m.members : Object.keys(m.members || {});
      const split = m.split || {};
      const memHTML = members.map((mem) => {
        if (mem === m.canonical) return `<span class="wc-rev__canon">${icon("star")} ${esc(mem)} <span class="muted">(main word)</span></span>`;
        const isSplit = !!split[mem];
        return `<span class="wc-rev__mem ${isSplit ? "wc-rev__mem--split" : ""}">${esc(mem)}
          ${isSplit ? "" : `<button class="btn-sm btn-icon wc-rev-canon" data-canon="${esc(canon)}" data-mem="${esc(mem)}" title="Make main word" aria-label="Make main word">${icon("star")}</button>`}
          <button class="btn-sm btn-icon wc-rev-split" data-canon="${esc(canon)}" data-mem="${esc(mem)}" data-to="${isSplit ? "0" : "1"}" title="${isSplit ? "Re-merge" : "Split out"}" aria-label="${isSplit ? "Re-merge" : "Split out"}">${isSplit ? icon("merge") : icon("split")}</button>
        </span>`;
      }).join('<span class="wc-rev__sep" aria-hidden="true">|</span>');
      return `<div class="wc-rev__row ${m.overridden ? "wc-rev__row--off" : ""}">
        <span class="wc-rev__group">→ ${esc(m.canonical)}: ${memHTML}</span>
        <button class="btn-sm btn-icon wc-rev-group" data-canon="${esc(canon)}" data-to="${m.overridden ? "0" : "1"}" title="${m.overridden ? "Redo group" : "Undo group"}" aria-label="${m.overridden ? "Redo group" : "Undo group"}">${m.overridden ? icon("redo") : icon("undo")}</button>
        <button class="btn-sm btn-icon btn-icon--danger wc-rev-delmerge" data-canon="${esc(canon)}" title="Remove this merge from the list" aria-label="Remove this merge">${icon("x")}</button>
      </div>`;
    }).join("");

    // Manual list: the words currently shown in the cloud (processed). Each can
    // be removed by hand, or ticked and merged together. Reversible above.
    const proc = (this._wcFreqs && this._wcFreqs.promptId === promptId) ? (this._wcFreqs.processed || {}) : {};
    const procTerms = Object.keys(proc).sort((a, b) => proc[b] - proc[a]);
    const manRows = procTerms.map((t) =>
      `<span class="wc-rev__chip">
        <label class="wc-rev__pick"><input type="checkbox" class="wc-merge-chk" data-term="${esc(t)}"> ${esc(t)}</label>
        <span class="muted">${proc[t]}</span>
        <button class="btn-sm btn-icon btn-icon--danger wc-rev-manual" data-term="${esc(t)}" title="Remove this word" aria-label="Remove this word">${icon("x")}</button>
      </span>`
    ).join(" ");

    el.innerHTML = `<div class="wc-review">
      <div class="wc-review__h">AI cleaning <span class="muted">${esc(dec.model || "")}</span> ${info("Everything here is reversible. Removed words can be put back, merges undone or split, and the main shown word changed with \u2605.")}</div>
      ${remRows ? `<div class="wc-review__sec"><div class="wc-review__t">Removed</div>${remRows}</div>` : ""}
      ${merRows ? `<div class="wc-review__sec"><div class="wc-review__t">Merged</div>${merRows}</div>` : ""}
      ${manRows ? `<div class="wc-review__sec"><div class="wc-review__t">Adjust words by hand ${info("Use the trash icon to remove a word. To merge: tick 2 or more words, then Merge selected \u2014 the most frequent becomes the main word (change it with \u2605).")}</div>
        <div class="wc-rev__manual">${manRows}</div>
        <div class="wc-rev__manualbar">
          <button class="btn-sm wc-merge-go" disabled>Merge selected</button>
        </div></div>` : ""}
    </div>`;

    el.querySelectorAll(".wc-rev-remove").forEach((b) =>
      b.addEventListener("click", () => this._setCleaningFlag(promptId, `removed/${b.dataset.term}/overridden`, b.dataset.to === "1")));
    el.querySelectorAll(".wc-rev-group").forEach((b) =>
      b.addEventListener("click", () => this._setCleaningFlag(promptId, `merges/${b.dataset.canon}/overridden`, b.dataset.to === "1")));
    el.querySelectorAll(".wc-rev-delmerge").forEach((b) =>
      b.addEventListener("click", () => this.removeMerge(promptId, b.dataset.canon)));
    el.querySelectorAll(".wc-rev-split").forEach((b) =>
      b.addEventListener("click", () => this._setCleaningFlag(promptId, `merges/${b.dataset.canon}/split/${b.dataset.mem}`, b.dataset.to === "1" ? true : null)));
    el.querySelectorAll(".wc-rev-canon").forEach((b) =>
      b.addEventListener("click", () => this.setCanonical(promptId, b.dataset.canon, b.dataset.mem)));
    el.querySelectorAll(".wc-rev-manual").forEach((b) =>
      b.addEventListener("click", () => this.manualRemove(promptId, b.dataset.term)));

    const goBtn = el.querySelector(".wc-merge-go");
    const checks = () => Array.from(el.querySelectorAll(".wc-merge-chk")).filter((c) => c.checked).map((c) => c.dataset.term);
    el.querySelectorAll(".wc-merge-chk").forEach((c) =>
      c.addEventListener("change", () => { if (goBtn) goBtn.disabled = checks().length < 2; }));
    if (goBtn) goBtn.addEventListener("click", () => this.manualMerge(promptId, checks()));
  },

  // Delete a merge group entirely (removes it from the Merged list). Its members
  // return to standing on their own. Not reversible from the panel, unlike Undo.
  async removeMerge(promptId, canonKey) {
    const session = this.viewSession;
    if (!session || session === "(all)") return;
    await this.db.ref(`control/word_cleaning/${session}/${promptId}/merges/${canonKey}`).remove();
  },

  // Manually merge selected processed terms into one group. Flattens correctly:
  // if a selected term is itself an existing merge's canonical, its members are
  // absorbed into the new group and the old group removed, so applyCleaning's
  // single-level fold stays correct. Canonical = most frequent among selected.
  async manualMerge(promptId, terms) {
    const session = this.viewSession;
    if (!session || session === "(all)") return;
    const uniq = Array.from(new Set(terms || []));
    if (uniq.length < 2) return;
    const dec = ((this._cleaning || {})[session] || {})[promptId] || {};
    const merges = dec.merges || {};
    const proc = (this._wcFreqs && this._wcFreqs.promptId === promptId) ? (this._wcFreqs.processed || {}) : {};
    let canon = uniq[0], best = -1;
    uniq.forEach((t) => { const c = proc[t] || 0; if (c > best) { best = c; canon = t; } });

    const members = {};
    const toDelete = [];
    uniq.forEach((t) => {
      const g = merges[t];
      if (g && !g.overridden) {                     // absorb an existing group's members
        const list = Array.isArray(g.members) ? g.members : Object.keys(g.members || {});
        list.forEach((mm) => { members[mm] = true; });
        if (t !== canon) toDelete.push(t);
      } else {
        members[t] = true;
      }
    });
    members[canon] = true;

    const update = {
      ts: firebase.database.ServerValue.TIMESTAMP,
      [`merges/${canon}`]: { canonical: canon, members, split: {}, overridden: false }
    };
    toDelete.forEach((k) => { update[`merges/${k}`] = null; });
    await this.db.ref(`control/word_cleaning/${session}/${promptId}`).update(update);
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
    host.innerHTML = `<div class="card"><h2>Export (CSV) ${info("This session only. For SQLite .db and the full pipeline, use the Python dashboard.")}</h2><div id="exp-btns" class="res-controls"></div></div>`;
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
