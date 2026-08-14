/* =========================================================================
   app.js — participant app controller (Phase 2: consent + registration).
   Vanilla JS, no build step. Section rendering is dispatched by type so
   Phase 3-5 sections slot in without restructuring.
   ========================================================================= */

/* ---------- tiny markdown renderer (subset used by welcome / notice text) ---------- */
function escapeHTML(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function mdLite(src) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  const lines = src.split("\n");
  let html = "", list = false;
  const closeList = () => { if (list) { html += "</ul>"; list = false; } };
  for (let raw of lines) {
    const line = raw.trimEnd();
    if (/^##\s+/.test(line))      { closeList(); html += `<h2>${inline(line.replace(/^##\s+/, ""))}</h2>`; }
    else if (/^#\s+/.test(line))  { closeList(); html += `<h1>${inline(line.replace(/^#\s+/, ""))}</h1>`; }
    else if (/^[-*]\s+/.test(line)) { if (!list) { html += "<ul>"; list = true; } html += `<li>${inline(line.replace(/^[-*]\s+/, ""))}</li>`; }
    else if (line.trim() === "")  { closeList(); }
    else                          { closeList(); html += `<p>${inline(line)}</p>`; }
  }
  closeList();
  return html;
}

/* ---------------------------- App controller ---------------------------- */
const App = {
  db: null,
  state: {
    uid: null,
    config: null,
    theme: null,
    session: null,            // current workshop/session id (from control/session)
    gatingEnabled: false,     // master gate switch (control/gating_enabled overrides config)
    backFlags: { questionnaire: false, end: false },
    participant: {},          // mirror of participants/{uid}
    sectionIndex: 0,          // index into config.sections
    q: { step: 0, answers: {}, sectionId: null, reviewing: false },  // questionnaire sub-state
    gateRef: null             // active gate listener, if waiting
  },

  el() { return document.getElementById("app"); },

  /* ----- boot sequence ----- */
  async boot() {
    this.renderBoot("Loading…");
    try {
      if (typeof firebaseConfig === "undefined" || firebaseConfig.apiKey === "PASTE_HERE") {
        throw new Error("credentials.js is not filled in yet (see SETUP.md).");
      }
      firebase.initializeApp(firebaseConfig);
      this.db = firebase.database();

      // Theme + config in parallel.
      const [theme, config] = await Promise.all([ThemeLoader.load(), ConfigLoader.load()]);
      this.state.theme = theme;
      this.state.config = config;

      // Anonymous, persisted → same uid survives refresh (enables resume).
      await firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL);
      const cred = await firebase.auth().signInAnonymously();
      this.state.uid = cred.user.uid;

      // Session is no longer read at boot. A participant belongs to whichever
      // session they JOIN from the welcome screen (the host's active session).
      // A returning participant's session is restored from their record in
      // resume(). Until they join, this.state.session stays null and no write is
      // attempted (and the rules would reject one anyway).

      // Gate master switch: control/gating_enabled overrides config.host_gating.enabled.
      // Read once for the initial state, then keep live (applies at the next section entry).
      this.state.gatingEnabled = !!(config.host_gating && config.host_gating.enabled);
      try {
        const g = await this.db.ref("control/gating_enabled").once("value");
        if (typeof g.val() === "boolean") this.state.gatingEnabled = g.val();
      } catch (e) { /* keep config fallback */ }
      this.db.ref("control/gating_enabled").on("value", (s) => {
        if (typeof s.val() === "boolean") this.state.gatingEnabled = s.val();
      });

      // Live facilitator broadcast (boot value is baselined, not replayed).
      this.watchBroadcast();

      // Host-controlled Back-button visibility (questionnaire / end).
      this.watchBackFlags();

      // Presence: mark this participant connected (auto-cleared on disconnect) so
      // the host's monitor only counts people who are actually online.
      this.setupPresence();

      // Last force-section move this device has applied (persisted so a reload
      // doesn't re-apply an old move, but a move that happened while offline is
      // still caught up on reconnect).
      this._forceSeenTs = this._readForceTs();

      // Host "reset all participants" signal. Baseline the current value at boot,
      // then reload if the host pushes a newer reset timestamp (their record is
      // cleared server-side, so the reload lands them back on the welcome screen).
      try {
        const r = await this.db.ref("control/reset").once("value");
        this._resetBaseline = (typeof r.val() === "number") ? r.val() : 0;
      } catch (e) { this._resetBaseline = 0; }
      this.db.ref("control/reset").on("value", (s) => {
        const v = (typeof s.val() === "number") ? s.val() : 0;
        if (v > this._resetBaseline) window.location.reload();
      });

      await this.resume();

      // Host "move everyone to section X now" override. Attached after resume()
      // so this.state.session is known when it first evaluates — that lets a
      // resuming participant catch up to a move made while they were offline.
      this.watchForceSection();

      this.render();
    } catch (e) {
      this.renderError(e.message);
      console.error(e);
    }
  },

  /* ----- utility: reject a promise if it doesn't settle in time ----- */
  withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms / 1000}s`)), ms))
    ]);
  },

  /* ----- resume: read existing progress and jump to the right section ----- */
  async resume() {
    const ref = this.db.ref(`participants/${this.state.uid}`);
    let snap;
    try {
      snap = await this.withTimeout(ref.once("value"), 8000, "Database read");
    } catch (e) {
      throw new Error(
        "Could not reach the database. The most likely cause is a wrong databaseURL in " +
        "app/credentials.js — it must exactly match the URL shown at the top of Realtime " +
        "Database in the Firebase console " +
        "(e.g. https://YOUR-PROJECT-default-rtdb.europe-west1.firebasedatabase.app). [" + e.message + "]"
      );
    }
    const p = snap.val() || {};
    this.state.participant = p;
    // A returning participant keeps the session they joined.
    if (p.session) this.state.session = p.session;
    this.state.sectionIndex = (p.progress && typeof p.progress.section_idx === "number")
      ? p.progress.section_idx : 0;
    // Preload this participant's saved word answers (both the host-paced word-cloud
    // prompts and self-paced questionnaire word_prompts) so a refresh restores them
    // instead of showing empty inputs and inviting a double-submission.
    this._savedWords = {};
    try {
      const ws = await this.db.ref(`word_responses/${this.state.uid}`).once("value");
      const all = ws.val() || {};
      Object.keys(all).forEach((pid) => {
        if (all[pid] && Array.isArray(all[pid].words)) this._savedWords[pid] = all[pid].words.slice();
      });
    } catch (e) { /* non-fatal: inputs just start empty */ }
    // Non-profile choice answers live under choices/<uid> (as option indices);
    // preload them too so those questions restore their selection on refresh.
    this._savedChoices = {};
    try {
      const cs = await this.db.ref(`choices/${this.state.uid}`).once("value");
      this._savedChoices = cs.val() || {};
    } catch (e) { /* non-fatal */ }
  },

  /* ----- progress / writes ----- */
  async setProgress(idx) {
    this.state.sectionIndex = idx;
    await this.db.ref(`participants/${this.state.uid}`).update({
      created_at: this.state.participant.created_at || firebase.database.ServerValue.TIMESTAMP,
      session: this.state.session,
      progress: { section_idx: idx }
    });
    if (!this.state.participant.created_at) this.state.participant.created_at = Date.now();
    // Mirror the reset progress node (a section change clears the saved q_step).
    this.state.participant.progress = { section_idx: idx };
  },

  // RTDB keys can't contain . # $ / [ ]. Session names are free text (host-typed),
  // so sanitise before using one as the counter key. The readable participant_no
  // still uses the raw session string, so it stays exactly as the host named it.
  seqKey(session) { return String(session).replace(/[.#$/\[\]]/g, "_"); },

  // Assign a readable, per-workshop sequential id (e.g. "accra-001") exactly once.
  // The real Firebase uid stays the record key (and the security anchor); this is
  // just a friendly label stored alongside it. A transaction on the shared counter
  // keeps numbers unique even when many phones join in the same instant. The
  // guard makes a page refresh (which re-runs join only if not yet joined)
  // never claim a second number.
  async assignParticipantNumber() {
    if (this.state.participant.participant_no) return this.state.participant.participant_no;
    const session = this.state.session;
    try {
      const res = await this.db.ref(`participant_seq/${this.seqKey(session)}`)
        .transaction((cur) => (cur || 0) + 1);
      if (!res.committed) return null;
      const n = res.snapshot.val();
      const pno = `${session}-${String(n).padStart(3, "0")}`;
      await this.db.ref(`participants/${this.state.uid}`).update({ participant_no: pno });
      this.state.participant.participant_no = pno;
      return pno;
    } catch (e) {
      // Numbering is a cosmetic label — never let it block the participant; the
      // real uid still identifies them. A permission_denied here almost always
      // means database.rules.json hasn't been deployed yet (see SETUP.md).
      console.error("participant numbering failed (continuing without it)", e);
      return null;
    }
  },

  // Resolve a choice question's selected option index to its stored value: the
  // plain choice text, or (for the "Other" slot) the participant's typed text.
  selectedValue(question, i, otherText) {
    const choices = question.choices || [];
    if (question.has_other && i === choices.length) return (otherText || "").trim();
    return ConfigLoader.stripMarkup(choices[i] || "");
  },

  // Write a profile question's answer as a participant attribute (single value,
  // or an array of values for multiple_choice). Stored under participants/fields
  // so the control room and dashboard can group/filter by it.
  async writeProfileChoice(question, ans, isMulti) {
    let val;
    if (isMulti) {
      val = ans.idxs.slice().sort((a, b) => a - b).map((i) => this.selectedValue(question, i, ans.other));
    } else {
      val = this.selectedValue(question, ans.idx, ans.other);
    }
    const updates = { fields_ts: firebase.database.ServerValue.TIMESTAMP };
    updates[`fields/${question.id}`] = val;
    await this.db.ref(`participants/${this.state.uid}`).update(updates);
    this.state.participant.fields = this.state.participant.fields || {};
    this.state.participant.fields[question.id] = val;
  },

  /* --------------------------- rendering --------------------------- */
  isGated(section) {
    return !!(this.state.gatingEnabled && section.gate);
  },

  detachGate() {
    if (this.state.gateRef) {
      this.state.gateRef.ref.off("value", this.state.gateRef.handler);
      this.state.gateRef = null;
    }
  },

  render() {
    this.detachGate();
    this.detachPres();
    this.detachActiveSession();
    const cfg = this.state.config;
    const section = cfg.sections[this.state.sectionIndex];
    if (!section) return this.renderComplete();
    if (section.type === "welcome") return this.renderWelcome(section);
    if (section.type === "assessment") {
      // Host-paced activity: always hold until the host opens this section,
      // independent of the master gating switch (same as the word cloud).
      if (section.gate) return this.renderGated(section);
      return this.renderAssessmentFlow(section);
    }
    if (section.type === "wordcloud") {
      // Host-paced activity: always hold participants until the host opens this
      // section, independent of the master gating switch (which only governs
      // self-paced questionnaire gates). renderGated shows the wait screen until
      // control/section_gates/<id> is "open", then enters the word-cloud flow.
      if (section.gate) return this.renderGated(section);
      return this.renderWordcloudFlow(section);
    }
    if (section.type === "notice") return this.renderNotice(section);
    if (this.isGated(section)) return this.renderGated(section);
    return this.renderSection(section);
  },

  detachPres() {
    if (this._presRef) { this._presRef.off("value", this._presHandler); this._presRef = null; this._presHandler = null; }
  },

  detachActiveSession() {
    if (this._activeRef) { this._activeRef.off("value", this._activeHandler); this._activeRef = null; this._activeHandler = null; }
  },

  // Host-controlled visibility of the Back button on the "late" screens
  // (questionnaire, end) where it isn't on by default. Listened once at boot so
  // toggles from the control room take effect live, mid-session.
  watchBackFlags() {
    this.state.backFlags = this.state.backFlags || { questionnaire: false, end: false };
    ["questionnaire", "end"].forEach((key) => {
      this.db.ref(`control/back_${key}`).on("value", (s) => {
        this.state.backFlags[key] = s.val() === true;
        // Repaint only if we're currently showing the screen this flag affects,
        // so a toggle takes effect immediately without waiting for navigation.
        const cfg = this.state.config;
        const section = cfg.sections[this.state.sectionIndex];
        if (!section && key === "end") return this.renderComplete();
        if (section && section.type === key) this.render();
      });
    });
  },

  // Live facilitator broadcast. The message present at boot is treated as
  // already seen (baseline), so refreshers / late joiners don't replay old
  // messages — only broadcasts sent after this client connects pop up. Within a
  // session, a dismissed message won't re-show (tracked by ts).
  watchBroadcast() {
    let baselineSet = false;
    this.db.ref("control/broadcast").on("value", (s) => {
      const b = s.val();
      if (!baselineSet) { this._dismissedBroadcastTs = (b && b.ts) || 0; baselineSet = true; }
      this.renderBroadcast(b);
    });
  },

  // Host force-move: when the facilitator picks a section and hits "Move
  // everyone here", every connected participant in the session jumps to it.
  // Event-driven and independent of whatever screen is currently rendered.
  //
  // Semantics:
  //  - The value present at boot is recorded as a baseline and NOT acted on, so
  //    refreshers/late-joiners are governed by their own persisted progress
  //    rather than being teleported by a standing force.
  //  - Only acts on a strictly newer ts (one-shot), matching this session, with
  //    a section_id that resolves to a real section.
  //  - Preserves already-persisted answers; it only moves the section pointer,
  //    then re-seeds the target section's sub-state (mirroring prevSection).
  // Mark this participant present while connected; clear automatically on
  // disconnect so the host monitor doesn't count ghosts.
  setupPresence() {
    const uid = this.state.uid;
    if (!uid) return;
    const presRef = this.db.ref("presence/" + uid);
    this.db.ref(".info/connected").on("value", (s) => {
      if (s.val() === true) {
        presRef.onDisconnect().remove();
        presRef.set(true).catch(() => {});
      }
    });
  },

  _readForceTs() {
    try { return Number(localStorage.getItem("RISKVIZ_FORCE_TS") || 0) || 0; }
    catch (e) { return 0; }
  },
  _writeForceTs(ts) {
    this._forceSeenTs = ts;
    try { localStorage.setItem("RISKVIZ_FORCE_TS", String(ts)); } catch (e) { /* ignore */ }
  },

  watchForceSection() {
    this.db.ref("control/force_section").on("value", (snap) => {
      const v = snap.val();
      const ts = (v && typeof v.ts === "number") ? v.ts : 0;
      if (!v || !v.section_id) return;
      if (v.session !== this.state.session) return;          // scoped to this session
      if (!(ts > (this._forceSeenTs || 0))) return;          // apply only moves newer than the last one applied
      this._writeForceTs(ts);                                // remember, so a reload doesn't re-apply it
      const idx = this.state.config.sections.findIndex((s) => s.id === v.section_id);
      if (idx < 0) return;                                   // unknown section id — ignore
      this.setProgress(idx)
        .then(() => { this.seedSubState(this.state.config.sections[idx]); this.render(); })
        .catch((e) => this.renderError(e.message));
    });
  },

  // Hold the participant on a waiting screen until the host opens this section's gate.
  renderGated(section) {
    const ref = this.db.ref(`control/section_gates/${section.id}`);
    const handler = (snap) => {
      if (snap.val() === "open") {
        this.detachGate();
        this.renderSection(section);
      } else {
        this.renderWaiting(section);
      }
    };
    this.state.gateRef = { ref, handler };
    ref.on("value", handler);
  },

  renderSection(section) {
    switch (section.type) {
      case "welcome":       return this.renderWelcome(section);
      case "questionnaire": return this.renderQuestionnaire(section);
      case "notice":        return this.renderNotice(section);
      case "assessment":    return this.renderAssessmentFlow(section);
      case "wordcloud":     return this.renderWordcloudFlow(section);
      default:              return this.renderError(`Unknown section type: ${section.type}`);
    }
  },

  /* ===================== questionnaire =====================
     One question per step, dispatched by question type. Answers are held in
     memory for the session (a refresh restarts at the first question of the
     section but already-written answers persist in Firebase), and the section
     advances only after the last question. Intra-section Back is always
     available; the step-0 cross-section Back honours the host's
     back_questionnaire flag. Supports single_choice, multiple_choice (each with
     an optional free-text "Other"), and word_prompt. */
  renderQuestionnaire(section) {
    const q = this.state.q;
    // Entering a questionnaire section (forward completion, force-move, or a page
    // refresh) resumes at the exact question the participant last viewed in this
    // section (persisted under progress). A section they haven't started opens at
    // its first question. Intra-section navigation keeps q.step.
    if (q.sectionId !== section.id) {
      q.sectionId = section.id; q.reviewing = false;
      const prog = (this.state.participant && this.state.participant.progress) || {};
      q.step = (prog.q_section === section.id && typeof prog.q_step === "number") ? prog.q_step : 0;
    }
    const questions = section.questions || [];
    if (!questions.length) { this.setProgress(this.state.sectionIndex + 1).then(() => this.render()); return; }
    if (q.step < 0) q.step = 0;
    if (q.step >= questions.length) q.step = questions.length - 1;
    if (q.reviewing) return this.renderReviewSummary(section);
    this._persistStep(section);
    const question = questions[q.step];
    switch (question.type) {
      case "word_prompt":     return this.renderWordQuestion(section, question);
      case "single_choice":   return this.renderChoiceQuestion(section, question, false);
      case "multiple_choice": return this.renderChoiceQuestion(section, question, true);
      default:                return this.renderError(`Unknown question type: ${question.type}`);
    }
  },

  // Persist the currently-viewed question so a refresh returns to it exactly.
  // Stored beside section_idx; setProgress (a section change) naturally clears it.
  _persistStep(section) {
    const prog = (this.state.participant && this.state.participant.progress) || {};
    if (prog.q_section === section.id && prog.q_step === this.state.q.step) return;   // unchanged
    prog.q_section = section.id; prog.q_step = this.state.q.step;
    this.state.participant = this.state.participant || {};
    this.state.participant.progress = prog;
    this.db.ref(`participants/${this.state.uid}/progress`)
      .update({ q_section: section.id, q_step: this.state.q.step })
      .catch(() => {});
  },

  // Rebuild a choice question's in-memory selection (option indices + Other text)
  // from its stored answer: profile questions store plain choice texts under
  // participants/fields; other choice questions store option indices under choices.
  _restoreChoiceAnswer(question, isMulti) {
    const choices = question.choices || [];
    const blank = isMulti ? { idxs: [], other: "" } : { idx: null, other: "" };
    const otherIdx = choices.length;
    if (!question.profile) {
      const rec = (this._savedChoices || {})[question.id];
      if (!rec) return blank;
      if (isMulti) return { idxs: Array.isArray(rec.choice_idxs) ? rec.choice_idxs.slice() : [], other: rec.other_text || "" };
      return { idx: (typeof rec.choice_idx === "number") ? rec.choice_idx : null, other: rec.other_text || "" };
    }
    const stored = ((this.state.participant || {}).fields || {})[question.id];
    if (stored === undefined || stored === null || stored === "") return blank;
    const findIdx = (val) => {
      const v = String(val);
      for (let i = 0; i < choices.length; i++) if (ConfigLoader.stripMarkup(choices[i]) === v) return i;
      return question.has_other ? otherIdx : -1;   // unmatched → the Other slot
    };
    if (isMulti) {
      const vals = Array.isArray(stored) ? stored : [stored];
      const idxs = []; let other = "";
      vals.forEach((val) => { const i = findIdx(val); if (i < 0) return; idxs.push(i); if (i === otherIdx) other = String(val); });
      return { idxs, other };
    }
    const i = findIdx(stored);
    if (i < 0) return blank;
    return { idx: i, other: i === otherIdx ? String(stored) : "" };
  },

  // Shared navigation for questionnaire questions.
  qShowBack() {
    return this.state.q.step > 0 || (this.state.backFlags.questionnaire && this.state.sectionIndex > 0);
  },
  qBack(section) {
    const q = this.state.q;
    if (q.step > 0) { q.step--; this.renderQuestionnaire(section); }
    else this.prevSection();
  },
  // Called after an answer is written. If the just-answered question carries a
  // review flag, show the "check your answers" summary instead of advancing;
  // otherwise move to the next question, or the next section at the end.
  async qNext(section) {
    const q = this.state.q;
    const questions = section.questions || [];
    const cur = questions[q.step];
    if (cur && cur.review && !q.reviewing) { q.reviewing = true; return this.renderQuestionnaire(section); }
    if (q.step + 1 < questions.length) { q.step++; this.renderQuestionnaire(section); }
    else { await this.setProgress(this.state.sectionIndex + 1); this.render(); }
  },

  // single_choice (radio) and multiple_choice (checkbox). When has_other is set,
  // an "Other" option is appended at index === choices.length; selecting it
  // reveals a free-text box whose value must be non-empty to continue.
  renderChoiceQuestion(section, question, isMulti) {
    const q = this.state.q;
    const choices = question.choices || [];
    const hasOther = !!question.has_other;
    const otherIdx = choices.length;   // the "Other" slot, if present

    if (!q.answers[question.id]) {
      q.answers[question.id] = this._restoreChoiceAnswer(question, isMulti);
    }
    const ans = q.answers[question.id];
    const isSelected = (i) => isMulti ? ans.idxs.includes(i) : ans.idx === i;
    const otherOn = () => isMulti ? ans.idxs.includes(otherIdx) : ans.idx === otherIdx;

    const optionRow = (label, i) => {
      const rawLabel = ConfigLoader.stripMarkup(label);
      return `<button class="option ${isSelected(i) ? "option--selected" : ""}" type="button" data-idx="${i}"
          role="${isMulti ? "checkbox" : "radio"}" aria-checked="${isSelected(i)}"
          aria-label="${escapeHTML(rawLabel)}">
          <span>${ConfigLoader.fmtInline(label)}</span><span class="option__check"></span></button>`;
    };
    let optionsHTML = choices.map((text, i) => optionRow(text, i)).join("");
    if (hasOther) optionsHTML += optionRow("Other", otherIdx);

    this.mount(`
      <h2 class="title">${ConfigLoader.fmtInline(question.prompt)}</h2>
      ${question.image ? `<img class="prompt-img" src="${escapeHTML(question.image)}" alt="" />` : ""}
      <div class="options ${isMulti ? "options--multi" : ""}"
           role="${isMulti ? "group" : "radiogroup"}"
           aria-label="${escapeHTML(ConfigLoader.stripMarkup(question.prompt))}">${optionsHTML}</div>
      <div id="q-other-wrap" class="other-wrap" ${otherOn() ? "" : "hidden"}>
        <input id="q-other" class="text-input" type="text" autocomplete="off"
               placeholder="Please specify" value="${escapeHTML(ans.other || "")}"
               aria-label="Please specify your other answer" />
      </div>
      <div class="actions">
        ${this.qShowBack() ? `<button id="q-back" class="btn btn--ghost">Back</button>` : ""}
        <button id="q-next" class="btn btn--primary" disabled>Continue</button>
      </div>
    `);

    const nextBtn = document.getElementById("q-next");
    const otherWrap = document.getElementById("q-other-wrap");
    const otherInput = document.getElementById("q-other");

    const valid = () => {
      if (isMulti) {
        if (ans.idxs.length === 0) return false;
        if (ans.idxs.includes(otherIdx) && (ans.other || "").trim() === "") return false;
        return true;
      }
      if (ans.idx === null) return false;
      if (ans.idx === otherIdx && (ans.other || "").trim() === "") return false;
      return true;
    };
    const syncOther = (focusIfShown) => {
      const show = otherOn();
      otherWrap.hidden = !show;
      if (show && focusIfShown) otherInput.focus();
    };
    const refreshNext = () => { nextBtn.disabled = !valid(); };

    this.el().querySelectorAll(".option").forEach((b) =>
      b.addEventListener("click", () => {
        const i = +b.dataset.idx;
        let turnedOtherOn = false;
        if (isMulti) {
          const at = ans.idxs.indexOf(i);
          if (at >= 0) ans.idxs.splice(at, 1); else ans.idxs.push(i);
          const on = ans.idxs.includes(i);
          b.classList.toggle("option--selected", on);
          b.setAttribute("aria-checked", String(on));
          turnedOtherOn = i === otherIdx && on;
        } else {
          const wasOther = ans.idx === otherIdx;
          ans.idx = i;
          this.el().querySelectorAll(".option").forEach((x) => {
            const on = +x.dataset.idx === i;
            x.classList.toggle("option--selected", on);
            x.setAttribute("aria-checked", String(on));
          });
          turnedOtherOn = i === otherIdx && !wasOther;
        }
        // Only pull focus into the text box when "Other" itself was just
        // selected — not when the user ticks some other checkbox while Other
        // happens to remain checked.
        syncOther(turnedOtherOn);
        refreshNext();
      })
    );
    if (otherInput) otherInput.addEventListener("input", () => { ans.other = otherInput.value; refreshNext(); });

    const back = document.getElementById("q-back");
    if (back) back.addEventListener("click", () => this.qBack(section));
    nextBtn.addEventListener("click", async () => {
      if (!valid()) return;
      nextBtn.disabled = true;
      try {
        if (question.profile) await this.writeProfileChoice(question, ans, isMulti);
        else if (isMulti) await this.writeMultipleChoice(question, ans);
        else await this.writeSingleChoice(question, ans);
      } catch (e) { return this.renderError(e.message); }
      this.qNext(section);
    });
    refreshNext();
  },

  async writeSingleChoice(question, ans) {
    const otherIdx = (question.choices || []).length;
    const rec = {
      type: "single_choice",
      choice_idx: ans.idx,
      session: this.state.session,
      ts: firebase.database.ServerValue.TIMESTAMP
    };
    if (question.has_other && ans.idx === otherIdx) rec.other_text = (ans.other || "").trim();
    await this.db.ref(`choices/${this.state.uid}/${question.id}`).set(rec);
  },

  async writeMultipleChoice(question, ans) {
    const otherIdx = (question.choices || []).length;
    const rec = {
      type: "multiple_choice",
      choice_idxs: ans.idxs.slice().sort((a, b) => a - b),
      session: this.state.session,
      ts: firebase.database.ServerValue.TIMESTAMP
    };
    if (question.has_other && ans.idxs.includes(otherIdx)) rec.other_text = (ans.other || "").trim();
    await this.db.ref(`choices/${this.state.uid}/${question.id}`).set(rec);
  },

  // Human-readable summary of one question's in-memory answer, for the review
  // screen. Single/multiple choice resolve indices to their option text (or the
  // typed "Other"); word prompts join their entries.
  answerSummary(question) {
    const ans = this.state.q.answers[question.id];
    if (question.type === "word_prompt") {
      return (Array.isArray(ans) && ans.length) ? ans.join(", ") : "—";
    }
    if (!ans) return "—";
    if (question.type === "multiple_choice") {
      if (!ans.idxs || !ans.idxs.length) return "—";
      return ans.idxs.slice().sort((a, b) => a - b)
        .map((i) => this.selectedValue(question, i, ans.other)).join(", ");
    }
    if (ans.idx == null) return "—";
    return this.selectedValue(question, ans.idx, ans.other);
  },

  // "Check your answers" screen, shown when a review-flagged question is reached.
  // Lists every question in this section up to and including the review marker.
  renderReviewSummary(section) {
    const q = this.state.q;
    const questions = (section.questions || []).slice(0, q.step + 1);
    const rows = questions.map((question) =>
      `<div class="summary__row">
         <span class="summary__key">${ConfigLoader.fmtInline(question.prompt)}</span>
         <span class="summary__val">${escapeHTML(this.answerSummary(question))}</span>
       </div>`
    ).join("");

    this.mount(`
      <h2 class="title">Please check your answers</h2>
      <div class="summary">${rows}</div>
      <div class="actions">
        <button id="rev-back" class="btn btn--ghost">Back</button>
        <button id="rev-confirm" class="btn btn--primary">Looks good</button>
      </div>
    `);

    document.getElementById("rev-back").addEventListener("click", () => {
      // Leave review mode and return to the marker question so answers can be
      // corrected (and stepped back further from there).
      q.reviewing = false;
      this.renderQuestionnaire(section);
    });
    document.getElementById("rev-confirm").addEventListener("click", async (e) => {
      e.target.disabled = true;
      q.reviewing = false;
      if (q.step + 1 < (section.questions || []).length) { q.step++; this.renderQuestionnaire(section); }
      else { await this.setProgress(this.state.sectionIndex + 1); this.render(); }
    });
  },

  /* ----- notice: a between-activity screen (completion / welcome-back). Its
     copy comes from the settings tab. Participants have no controls; the host
     advances the whole room with "Move everyone here". ----- */
  renderNotice(section) {
    this.detachGate();
    this.detachPres();
    this.mount(`
      <div class="notice">
        <h2 class="title">${ConfigLoader.fmtInline(section.title || "")}</h2>
        ${section.body ? `<p class="lead">${ConfigLoader.fmtInline(section.body)}</p>` : ""}
        <div class="notice__wait muted">Please wait for the facilitator.</div>
      </div>
    `, { withProgress: false, withFooter: true });
  },

  /* ----- assessment: merged discussion + Likert, fully host-driven. The host
     shows a figure, the room discusses, then the host reveals the scale; the
     participant scores the three configured questions and may keep editing
     until the host advances the figure. Participant state is a pure mirror of
     control/pres/{sectionId} = { idx, likert_shown }; the section is entered
     and left by the host's force-move. ----- */
  renderAssessmentFlow(section) {
    this.detachPres();
    this.detachGate();
    this._presState = { idx: 0, likert_shown: false };
    this._presRef = this.db.ref(`control/pres/${section.id}`);
    this._presHandler = (s) => {
      const v = s.val() || {};
      // Defensive: a figure change always hides the scale, regardless of the
      // flag's write ordering, so figure N+1 never inherits N's revealed scale.
      const idx = (typeof v.idx === "number") ? v.idx : 0;
      const revealed = v.likert_shown === true && idx === (typeof v.idx === "number" ? v.idx : 0);
      this._presState = { idx, likert_shown: revealed };
      this.paintAssessment(section);
    };
    this._presRef.on("value", this._presHandler);
  },

  paintAssessment(section) {
    const stimuli = section.stimuli || [];
    const n = stimuli.length;
    const idx = Math.max(0, Math.min(this._presState.idx, Math.max(0, n - 1)));
    const stim = stimuli[idx] || {};
    const showLikert = this._presState.likert_shown && n > 0;

    const L = this.state.config.likert;
    const dims = L.dimensions || [];
    const points = L.points || 5;
    const anchors = L.anchors || [];

    // In-memory scores per figure (editable until the host advances).
    this.state.assess = this.state.assess || {};
    if (!this.state.assess[stim.id]) this.state.assess[stim.id] = {};
    const ans = this.state.assess[stim.id];
    this._assessSubmitted = this._assessSubmitted || {};

    // Slides: one stimulus can hold several (image and/or caption). The Likert
    // score attaches to stim.id, not the slide. Fall back to the top-level
    // image/caption for single-slide stimuli authored the old way.
    const slides = (stim.slides && stim.slides.length)
      ? stim.slides : [{ image: stim.image, caption: stim.caption }];
    this._assessSlide = this._assessSlide || {};
    if (this._assessSlide[stim.id] == null) this._assessSlide[stim.id] = 0;
    let si = Math.max(0, Math.min(this._assessSlide[stim.id], slides.length - 1));
    this._assessSlide[stim.id] = si;

    const slideInner = (i) => {
      const sl = slides[i] || {};
      const img = sl.image ? `<img class="stimulus-card__img" src="${escapeHTML(sl.image)}" alt="${escapeHTML(stim.title || "")}">` : "";
      const cap = sl.caption ? `<div class="stimulus-card__body">${escapeHTML(sl.caption)}</div>` : "";
      const nav = slides.length > 1 ? `
        <div class="carousel__nav">
          <button class="carousel__arrow" id="cz-prev" ${i <= 0 ? "disabled" : ""} aria-label="Previous image">‹</button>
          <span class="carousel__count">${i + 1} / ${slides.length}</span>
          <button class="carousel__arrow" id="cz-next" ${i >= slides.length - 1 ? "disabled" : ""} aria-label="Next image">›</button>
        </div>` : "";
      return img + cap + nav;
    };

    const scaleHTML = (dim) => {
      let btns = "";
      for (let p = 1; p <= points; p++) {
        const on = ans[dim.id] === p;
        btns += `<button class="scale__btn ${on ? "scale__btn--on" : ""}" type="button"
                   data-dim="${dim.id}" data-val="${p}"
                   aria-label="${escapeHTML(anchors[p - 1] || String(p))}">${p}</button>`;
      }
      // Sparse labels: low at the start, high at the end, mid under the centre.
      return `<div class="likert-row">
          <div class="likert-dim">${escapeHTML(dim.label)}</div>
          <div class="scale" role="radiogroup" aria-label="${escapeHTML(dim.label)}"
               style="grid-template-columns:repeat(${points},1fr)">${btns}</div>
          <div class="scale__ticks" style="grid-template-columns:repeat(${points},1fr)">${
            anchors.map((a) => `<span>${escapeHTML(a || "")}</span>`).join("")
          }</div>
        </div>`;
    };

    const likertBlock = showLikert ? `
      <div class="likert-rows">${dims.map(scaleHTML).join("")}</div>
      <div class="actions">
        <button id="as-submit" class="btn btn--primary" disabled>Submit</button>
      </div>
      <div id="as-status" class="muted assess-status"></div>
    ` : `
      <div class="assess-hold muted">Please follow the facilitator. Scoring will open shortly.</div>
    `;

    this.mount(`
      <div class="stimulus-card">
        ${stim.title ? `<div class="stimulus-card__title">${escapeHTML(stim.title)}</div>` : ""}
        <div id="as-carousel" class="carousel">${slideInner(si)}</div>
      </div>
      <div class="disc__counter muted">${n ? (idx + 1) + " / " + n : ""}</div>
      ${likertBlock}
    `, { withFooter: true });

    // Wire the slide carousel (participant-paced; arrows stop at the ends).
    const carousel = document.getElementById("as-carousel");
    const wireCarousel = () => {
      const prev = document.getElementById("cz-prev");
      const next = document.getElementById("cz-next");
      if (prev) prev.addEventListener("click", () => {
        si = Math.max(0, si - 1); this._assessSlide[stim.id] = si;
        carousel.innerHTML = slideInner(si); wireCarousel();
      });
      if (next) next.addEventListener("click", () => {
        si = Math.min(slides.length - 1, si + 1); this._assessSlide[stim.id] = si;
        carousel.innerHTML = slideInner(si); wireCarousel();
      });
    };
    wireCarousel();

    if (!showLikert) return;

    const submitBtn = document.getElementById("as-submit");
    const statusEl = document.getElementById("as-status");
    const allAnswered = () => dims.every((d) => typeof ans[d.id] === "number");
    const submitted = () => this._assessSubmitted[stim.id];
    const refresh = () => {
      submitBtn.disabled = !allAnswered();
      submitBtn.textContent = submitted() ? "Update" : "Submit";
      statusEl.textContent = submitted()
        ? "Saved. You can still change your answers until the group moves on."
        : "";
    };

    this.el().querySelectorAll(".scale__btn").forEach((b) =>
      b.addEventListener("click", () => {
        const dimId = b.dataset.dim, val = +b.dataset.val;
        ans[dimId] = val;
        this.el().querySelectorAll(`.scale__btn[data-dim="${dimId}"]`).forEach((x) =>
          x.classList.toggle("scale__btn--on", +x.dataset.val === val)
        );
        refresh();
      })
    );
    submitBtn.addEventListener("click", async () => {
      if (!allAnswered()) return;
      submitBtn.disabled = true;
      try { await this.writeAssessment(stim.id, ans); }
      catch (e) { return this.renderError(e.message); }
      this._assessSubmitted[stim.id] = true;
      refresh();
    });
    refresh();
  },

  /* ----- wordcloud: host-paced word prompts, single step. The host shows one
     prompt at a time (control/pres/{sectionId}.idx) with the input open; the
     participant types words and may keep editing until the host advances. Same
     word_responses store as the questionnaire word prompts. Entered/left by the
     host's force-move (or by finishing the prior section). ----- */
  renderWordcloudFlow(section) {
    this.detachPres();
    this.detachGate();
    this._presState = { idx: 0 };
    this._presRef = this.db.ref(`control/pres/${section.id}`);
    this._presHandler = (s) => {
      const v = s.val() || {};
      this._presState = { idx: (typeof v.idx === "number") ? v.idx : 0 };
      this.paintWordcloud(section);
    };
    this._presRef.on("value", this._presHandler);
  },

  paintWordcloud(section) {
    const prompts = section.prompts || [];
    const n = prompts.length;
    const idx = Math.max(0, Math.min(this._presState.idx, Math.max(0, n - 1)));
    const p = prompts[idx] || {};
    const maxW = p.max_words || 5, minW = p.min_words || 1, maxC = p.max_chars || 30;

    this.state.wc = this.state.wc || {};
    this._wcSubmitted = this._wcSubmitted || {};
    // Restore a previous submission for this prompt (e.g. after a page refresh)
    // from the words preloaded at resume, so the participant sees their saved
    // words instead of an empty box and doesn't re-enter/double-submit.
    if (!this.state.wc[p.id]) {
      const saved = (this._savedWords && this._savedWords[p.id]) ? this._savedWords[p.id].slice() : [];
      this.state.wc[p.id] = saved;
      if (saved.length) this._wcSubmitted[p.id] = true;
    }
    const words = this.state.wc[p.id];

    this.mount(`
      <div class="disc__counter muted">${n ? (idx + 1) + " / " + n : ""}</div>
      <div class="question">${ConfigLoader.fmtInline(p.prompt || "")}</div>
      ${p.image ? `<img class="prompt-img" src="${escapeHTML(p.image)}" alt="" />` : ""}
      ${this.chipInputHTML()}
      <div class="actions"><button id="wc-submit" class="btn btn--primary" disabled>Submit</button></div>
      <div id="wc-status" class="muted assess-status"></div>
    `, { withFooter: true });

    const submitBtn = document.getElementById("wc-submit");
    const statusEl = document.getElementById("wc-status");
    const submitted = () => this._wcSubmitted[p.id];
    this.wireChipInput(words, maxW, minW, maxC, () => {
      submitBtn.disabled = words.length < minW;
      submitBtn.textContent = submitted() ? "Update" : "Submit";
      statusEl.textContent = submitted()
        ? "Saved. You can still change your answer until the group moves on." : "";
    });
    submitBtn.addEventListener("click", async () => {
      if (words.length < minW) return;
      submitBtn.disabled = true;
      try { await this.writeWords(p.id, words); }
      catch (e) { return this.renderError(e.message); }
      this._wcSubmitted[p.id] = true;
      submitBtn.textContent = "Update";
      statusEl.textContent = "Saved. You can still change your answer until the group moves on.";
    });
  },

  renderWaiting(section) {
    this.mount(`
      <div class="waiting">
        <h2 class="title">Please wait</h2>
        <p class="lead muted">The facilitator will start this part shortly.<br>Your screen will continue automatically.</p>
        <div class="spinner" aria-hidden="true"></div>
      </div>
    `, { withProgress: true, withFooter: true });
  },

  /* ----- cross-section back (Option B) ----- */
  async prevSection() {
    const prevIdx = this.state.sectionIndex - 1;
    if (prevIdx < 0) return;
    await this.setProgress(prevIdx);
    this.seedSubState(this.state.config.sections[prevIdx]);
    this.render();
  },

  seedSubState(section) {
    if (section.type === "questionnaire") {
      // Re-entering a questionnaire section (via Back or force-move): restart at
      // its first question. Answers stay in memory, so prior picks re-appear.
      this.state.q.step = 0;
      this.state.q.reviewing = false;
      this.state.q.sectionId = section.id;
    }
  },

  progressBar() {
    // Deliberately decorative and static: a fixed accent strip that conveys NO
    // position or length, so participants don't anticipate how much remains.
    return `<div class="topstrip" aria-hidden="true"></div>`;
  },

  footer() {
    const logos = (this.state.theme && this.state.theme.logos) || [];
    if (!logos.length) return "";
    const items = logos.map((l) =>
      `<img src="${l.file}" alt="${l.alt || l.name}" onerror="this.outerHTML='<span class=&quot;footer-logos__placeholder&quot;>${l.name}</span>'">`
    ).join("");
    return `<div class="footer-logos">${items}</div>`;
  },

  mount(bodyHTML, { withProgress = true, withFooter = true } = {}) {
    this.el().innerHTML =
      `<div class="screen">
         ${withProgress ? this.progressBar() : ""}
         <div class="screen__body">${bodyHTML}</div>
       </div>
       ${withFooter ? this.footer() : ""}`;
  },

  /* ----- welcome (entry) -----
     Replaces consent (consent is now read aloud in person). Shows configurable
     copy and a "Join the <session> session" button that appears only while the
     host has a session active. Joining sets the participant's session to the
     active one and moves them into the study. */
  renderWelcome(section) {
    this.detachActiveSession();
    const paint = (activeName) => {
      const active = (typeof activeName === "string" && activeName) ? activeName : null;
      this.mount(`
        <div class="welcome">
          ${section.title ? `<h1 class="title">${escapeHTML(section.title)}</h1>` : ""}
          <div class="prose">${mdLite(section.body || "")}</div>
          <div class="actions">
            ${active
              ? `<button id="join-btn" class="btn btn--primary">Join the ${escapeHTML(active)} session</button>`
              : `<div class="welcome__wait muted">No session is open yet. Please wait for the facilitator to start the session.</div>`}
          </div>
        </div>
      `);
      if (active) {
        const btn = document.getElementById("join-btn");
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try { await this.join(active); }
          catch (e) { btn.disabled = false; this.renderError(e.message); }
        });
      }
    };
    this._activeRef = this.db.ref("control/active_session");
    this._activeHandler = (s) => paint(s.val());
    this._activeRef.on("value", this._activeHandler);
  },

  async join(activeName) {
    this.detachActiveSession();
    this.state.session = activeName;
    // Baseline the force-section clock to "now" for this session, so a move the
    // host made before this person joined isn't retroactively applied to them
    // (on this load or a later reload). Later moves still apply.
    try {
      const f = await this.db.ref("control/force_section").once("value");
      const fv = f.val();
      const fts = (fv && typeof fv.ts === "number" && fv.session === activeName) ? fv.ts : 0;
      this._writeForceTs(Math.max(this._forceSeenTs || 0, fts));
    } catch (e) { /* keep current baseline */ }
    // The first write MUST carry the session (the rules freeze writes whose
    // session != the active one). setProgress establishes the participant record
    // with created_at + session + progress; then the readable number is patched.
    await this.setProgress(this.state.sectionIndex + 1);
    await this.assignParticipantNumber();
    this.render();
  },

  /* ----- word_prompt question: chip input, one question per step ----- */
  async writeWords(promptId, words) {
    await this.db.ref(`word_responses/${this.state.uid}/${promptId}`).set({
      words: words.slice(),
      session: this.state.session,
      ts: firebase.database.ServerValue.TIMESTAMP
    });
  },

  // Shared chip-input for word entry (used by the self-paced questionnaire
  // word_prompt and the host-paced wordcloud section). Returns the markup; wire
  // it after mount with wireChipInput.
  chipInputHTML() {
    return `
      <div class="chip-input">
        <input id="wa-input" type="text" inputmode="text" autocomplete="off"
               autocapitalize="none" spellcheck="false" placeholder="Type a word" aria-label="Type a word" />
        <button id="wa-add" class="btn btn--ghost chip-input__add" type="button">Add</button>
      </div>
      <div id="wa-counter" class="muted chip-counter"></div>
      <div id="wa-chips" class="chips" aria-live="polite"></div>`;
  },

  // Wire the chip input into whatever mount already contains chipInputHTML().
  // Mutates `words` in place; calls onChange() on every change. Returns a
  // refresh() the caller can invoke after mutating state (e.g. after submit).
  wireChipInput(words, maxW, minW, maxC, onChange) {
    const input = document.getElementById("wa-input");
    const addBtn = document.getElementById("wa-add");
    const chipsEl = document.getElementById("wa-chips");
    const counterEl = document.getElementById("wa-counter");
    // Allow typing/pasting a comma-separated list; each resulting chip is still
    // capped at maxC (enforced per token in add()).
    input.maxLength = Math.max(maxC, maxC * maxW + maxW * 2);

    const refresh = () => {
      chipsEl.innerHTML = words.map((w, i) =>
        `<span class="chip">${escapeHTML(w)}<button class="chip__remove" data-i="${i}" type="button" aria-label="Remove ${escapeHTML(w)}">&times;</button></span>`
      ).join("");
      chipsEl.querySelectorAll(".chip__remove").forEach((b) =>
        b.addEventListener("click", () => { words.splice(+b.dataset.i, 1); refresh(); })
      );
      counterEl.textContent = `${words.length} of ${maxW} entr${maxW === 1 ? "y" : "ies"} · up to ${maxC} characters each`;
      const atMax = words.length >= maxW;
      input.disabled = atMax; addBtn.disabled = atMax;
      input.placeholder = atMax ? "Maximum reached" : "Type a word (commas add several)";
      if (onChange) onChange();
    };
    // Commit the field: split on commas/semicolons so one multi-concept entry
    // becomes several chips. Each token is trimmed, capped at maxC, de-duplicated
    // (case-insensitive), and added until the max-words cap is reached.
    const add = () => {
      const tokens = (input.value || "").split(/[,;]+/).map((t) => t.trim().slice(0, maxC)).filter((t) => t.length > 0);
      input.value = "";
      let added = false;
      for (const tok of tokens) {
        if (words.length >= maxW) break;
        if (words.some((w) => w.toLowerCase() === tok.toLowerCase())) continue;
        words.push(tok); added = true;
      }
      if (added) refresh();
      input.focus();
    };
    addBtn.addEventListener("click", add);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "," || e.key === ";") { e.preventDefault(); add(); }
    });
    refresh();
    return refresh;
  },

  renderWordQuestion(section, question) {
    const q = this.state.q;
    const maxW = question.max_words || 5;
    const minW = question.min_words || 1;
    const maxC = question.max_chars || 30;
    if (!q.answers[question.id]) {
      const saved = (this._savedWords && this._savedWords[question.id]) ? this._savedWords[question.id].slice() : [];
      q.answers[question.id] = saved;
    }
    const words = q.answers[question.id];

    this.mount(`
      <div class="question">${ConfigLoader.fmtInline(question.prompt)}</div>
      ${question.image ? `<img class="prompt-img" src="${escapeHTML(question.image)}" alt="" />` : ""}
      ${this.chipInputHTML()}
      <div class="actions">
        ${this.qShowBack() ? `<button id="q-back" class="btn btn--ghost">Back</button>` : ""}
        <button id="q-next" class="btn btn--primary">Continue</button>
      </div>
    `);

    const nextBtn = document.getElementById("q-next");
    const backBtn = document.getElementById("q-back");
    this.wireChipInput(words, maxW, minW, maxC, () => { nextBtn.disabled = words.length < minW; });
    if (backBtn) backBtn.addEventListener("click", () => this.qBack(section));
    nextBtn.addEventListener("click", async () => {
      if (words.length < minW) return;
      nextBtn.disabled = true;
      await this.writeWords(question.id, words);
      this.qNext(section);
    });
  },

  // Assessment score write. Keyed by stimulus; the three configured dimensions
  // plus session/ts. Editable resubmission just overwrites the same node.
  async writeAssessment(stimId, scores) {
    const payload = { session: this.state.session, ts: firebase.database.ServerValue.TIMESTAMP };
    this.state.config.likert.dimensions.forEach((d) => { payload[d.id] = scores[d.id]; });
    await this.db.ref(`assessments/${this.state.uid}/${stimId}`).set(payload);
  },

  renderComplete() {
    const canBack = this.state.backFlags.end;
    const lastIdx = this.state.config.sections.length - 1;
    this.mount(`<h2 class="title">All done</h2><p class="lead muted">Thank you — you've reached the end of the current flow.</p>
      ${canBack ? `<div class="actions"><button id="end-back" class="btn btn--ghost">Back</button></div>` : ""}`,
      { withProgress: false });
    const back = document.getElementById("end-back");
    if (back) back.addEventListener("click", async () => {
      // No "current section" exists past the end, so re-enter the last section
      // directly rather than via prevSection() (which decrements from a live one).
      if (lastIdx < 0) return;
      await this.setProgress(lastIdx);
      this.seedSubState(this.state.config.sections[lastIdx]);
      this.render();
    });
  },

  renderBroadcast(b) {
    const el = document.getElementById("broadcast");
    if (!el) return;
    const hasContent = b && (b.text || b.image);
    if (hasContent && this._dismissedBroadcastTs !== b.ts) {
      const body = b.image
        ? `<img class="broadcast__img" src="${escapeHTML(b.image)}" alt="Word cloud from the facilitator" />`
        : `<div class="broadcast__label">Message from the facilitator</div>
           <div class="broadcast__msg">${escapeHTML(b.text)}</div>`;
      const closable = !b.locked;
      el.innerHTML = `
        <div class="broadcast__box ${b.image ? "broadcast__box--image" : ""}" role="alertdialog" aria-modal="true">
          ${body}
          ${closable
            ? `<button id="broadcast-close" class="btn btn--primary">Close</button>`
            : `<div class="broadcast__msg muted" style="margin-top:.6rem">The facilitator will close this.</div>`}
        </div>`;
      el.style.display = "flex";
      if (closable) {
        document.getElementById("broadcast-close").addEventListener("click", () => {
          this._dismissedBroadcastTs = b.ts;
          el.style.display = "none";
          el.innerHTML = "";
        });
      }
    } else if (!hasContent) {
      el.style.display = "none";
      el.innerHTML = "";
    }
  },

  renderBoot(msg) { this.el().innerHTML = `<div class="boot">${msg}</div>`; },
  renderError(msg) { this.el().innerHTML = `<div class="errbox">Something went wrong:<br>${msg}</div>`; }
};

window.addEventListener("DOMContentLoaded", () => App.boot());
