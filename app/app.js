/* =========================================================================
   app.js — participant app controller (Phase 2: consent + registration).
   Vanilla JS, no build step. Section rendering is dispatched by type so
   Phase 3-5 sections slot in without restructuring.
   ========================================================================= */

/* ---------- tiny markdown renderer (subset used by consent text) ---------- */
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
    reg: { step: 0, answers: {} },  // registration sub-state
    q: { step: 0, answers: {} },    // questionnaire sub-state (one question per step)
    lk: { step: 0, answers: {} },   // likert sub-state
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

      // Current workshop/session id: control/session if set, else config default.
      try {
        const sSnap = await this.withTimeout(this.db.ref("control/session").once("value"), 8000, "Session read");
        this.state.session = sSnap.val() || (config.study && config.study.default_session) || "default";
      } catch (e) {
        this.state.session = (config.study && config.study.default_session) || "default";
      }

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

      // Host "move everyone to section X now" override.
      this.watchForceSection();

      await this.resume();
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
    this.state.sectionIndex = (p.progress && typeof p.progress.section_idx === "number")
      ? p.progress.section_idx : 0;
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
  },

  async writeConsent(version) {
    await this.db.ref(`participants/${this.state.uid}`).update({
      created_at: this.state.participant.created_at || firebase.database.ServerValue.TIMESTAMP,
      session: this.state.session,
      consent: { version, ts: firebase.database.ServerValue.TIMESTAMP }
    });
    this.state.participant.consent = { version };
    if (!this.state.participant.created_at) this.state.participant.created_at = Date.now();
  },

  // RTDB keys can't contain . # $ / [ ]. Session names are free text (host-typed),
  // so sanitise before using one as the counter key. The readable participant_no
  // still uses the raw session string, so it stays exactly as the host named it.
  seqKey(session) { return String(session).replace(/[.#$/\[\]]/g, "_"); },

  // Assign a readable, per-workshop sequential id (e.g. "accra-001") exactly once.
  // The real Firebase uid stays the record key (and the security anchor); this is
  // just a friendly label stored alongside it. A transaction on the shared counter
  // keeps numbers unique even when many phones consent in the same instant. The
  // guard makes a page refresh (which re-runs consent only if not yet consented)
  // never claim a second number.
  async assignParticipantNumber() {
    if (this.state.participant.participant_no) return this.state.participant.participant_no;
    const session = this.state.session;
    let n;
    try {
      const res = await this.db.ref(`participant_seq/${this.seqKey(session)}`)
        .transaction((cur) => (cur || 0) + 1);
      if (!res.committed) return null;
      n = res.snapshot.val();
    } catch (e) {
      // Non-fatal: the uid still identifies the participant. Don't block the flow.
      console.error("participant_seq transaction failed", e);
      return null;
    }
    const pno = `${session}-${String(n).padStart(3, "0")}`;
    await this.db.ref(`participants/${this.state.uid}`).update({ participant_no: pno });
    this.state.participant.participant_no = pno;
    return pno;
  },

  async writeRegistration(answers) {
    await this.db.ref(`participants/${this.state.uid}`).update({
      fields: answers,
      fields_ts: firebase.database.ServerValue.TIMESTAMP
    });
    this.state.participant.fields = answers;
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
    const cfg = this.state.config;
    const section = cfg.sections[this.state.sectionIndex];
    if (!section) return this.renderComplete();
    if (section.type === "discussion") return this.renderDiscussionFlow(section);
    if (this.isGated(section)) return this.renderGated(section);
    return this.renderSection(section);
  },

  detachPres() {
    if (this._presRef) { this._presRef.off("value", this._presHandler); this._presRef = null; this._presHandler = null; }
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
  watchForceSection() {
    let baselineSet = false;
    this.db.ref("control/force_section").on("value", (snap) => {
      const v = snap.val();
      const ts = (v && typeof v.ts === "number") ? v.ts : 0;
      if (!baselineSet) { this._forceSeenTs = ts; baselineSet = true; return; }
      if (!v || !v.section_id) return;
      if (v.session !== this.state.session) return;          // scoped to this session
      if (!(ts > (this._forceSeenTs || 0))) return;          // one-shot: newer events only
      this._forceSeenTs = ts;
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
      case "consent":       return this.renderConsent(section);
      case "registration":  return this.renderRegistration(section);
      case "questionnaire": return this.renderQuestionnaire(section);
      case "likert":        return this.renderLikert(section);
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
    const questions = section.questions || [];
    if (!questions.length) { this.setProgress(this.state.sectionIndex + 1).then(() => this.render()); return; }
    if (q.step >= questions.length) q.step = questions.length - 1;
    const question = questions[q.step];
    switch (question.type) {
      case "word_prompt":     return this.renderWordQuestion(section, question);
      case "single_choice":   return this.renderChoiceQuestion(section, question, false);
      case "multiple_choice": return this.renderChoiceQuestion(section, question, true);
      default:                return this.renderError(`Unknown question type: ${question.type}`);
    }
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
  async qNext(section) {
    const q = this.state.q;
    const questions = section.questions || [];
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
      q.answers[question.id] = isMulti ? { idxs: [], other: "" } : { idx: null, other: "" };
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
        if (isMulti) await this.writeMultipleChoice(question, ans);
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

  /* ----- discussion: host-synced display. Host navigates prompts; opening the
     gate releases (auto-advances) the whole group. Participants have no Back/
     Continue, so pacing is entirely host-controlled. ----- */
  renderDiscussionFlow(section) {
    const gated = this.state.gatingEnabled && section.gate;
    this._presIdx = this._presIdx || 0;
    this.detachPres();
    this.detachGate();

    this._presRef = this.db.ref("control/presentation_idx");
    this._presHandler = (s) => {
      this._presIdx = (typeof s.val() === "number") ? s.val() : 0;
      this.paintDiscussion(section);
    };
    this._presRef.on("value", this._presHandler);

    if (gated) {
      // Gate "open" = host releases the group → advance everyone automatically.
      const ref = this.db.ref(`control/section_gates/${section.id}`);
      const handler = (s) => {
        if (s.val() === "open") {
          this.detachPres();
          this.detachGate();
          this.setProgress(this.state.sectionIndex + 1).then(() => this.render());
        } else {
          this.paintDiscussion(section);
        }
      };
      this.state.gateRef = { ref, handler };
      ref.on("value", handler);
    } else {
      this.paintDiscussion(section);
    }
  },

  paintDiscussion(section) {
    const prompts = section.prompts || [];
    const n = prompts.length;
    const idx = Math.max(0, Math.min(this._presIdx, Math.max(0, n - 1)));
    const p = prompts[idx] || {};
    const img = p.image ? `<img class="disc__img" src="${escapeHTML(p.image)}" alt="">` : "";
    const text = p.text ? `<div class="disc__text">${escapeHTML(p.text)}</div>` : "";
    // Host-controlled: no participant Back/Continue (the host releases the group
    // by opening the gate). Continue appears ONLY in fully self-paced mode
    // (gating master switch off), so participants are never stranded there.
    const selfPaced = !(this.state.gatingEnabled && section.gate);
    this.mount(`
      <div class="disc">
        <div class="disc__counter muted">${n ? (idx + 1) + " / " + n : ""}</div>
        ${img}${text}
        ${selfPaced ? "" : `<div class="disc__hint muted">Please follow the facilitator.</div>`}
        ${selfPaced ? `<div class="actions"><button id="disc-continue" class="btn btn--primary">Continue</button></div>` : ""}
      </div>
    `, { withFooter: true });
    const cont = document.getElementById("disc-continue");
    if (cont) cont.addEventListener("click", () => {
      this.detachPres(); this.detachGate();
      this.setProgress(this.state.sectionIndex + 1).then(() => this.render());
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
    if (section.type === "registration") {
      this.state.reg.answers = Object.assign({}, this.state.participant.fields || {});
      this.state.reg.step = this.state.config.participant_fields.length; // land on confirm
    } else if (section.type === "questionnaire") {
      this.state.q.step = 0;   // answers retained in memory this session
    } else if (section.type === "likert") {
      this.state.lk.step = 0;
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

  /* ----- consent ----- */
  renderConsent(section) {
    const c = this.state.config.consent;
    let agreed = false;
    this.mount(`
      <div class="prose">${mdLite(c.markdown_text)}</div>
      <div id="consent-check" class="consent-check" role="checkbox" tabindex="0" aria-checked="false">
        <div class="consent-check__box"></div>
        <div>${c.checkbox_label}</div>
      </div>
      <div class="actions">
        <button id="consent-continue" class="btn btn--primary" disabled>Continue</button>
      </div>
    `);

    const box = document.getElementById("consent-check");
    const btn = document.getElementById("consent-continue");
    const toggle = () => {
      agreed = !agreed;
      box.classList.toggle("consent-check--on", agreed);
      box.setAttribute("aria-checked", String(agreed));
      btn.disabled = !agreed;
    };
    box.addEventListener("click", toggle);
    box.addEventListener("keydown", (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggle(); } });
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      await this.writeConsent(c.version);
      await this.assignParticipantNumber();
      await this.setProgress(this.state.sectionIndex + 1);
      this.state.reg = { step: 0, answers: {} };
      this.render();
    });
  },

  /* ----- registration: one field per screen, then confirm ----- */
  renderRegistration() {
    const fields = this.state.config.participant_fields;
    const reg = this.state.reg;
    if (Object.keys(reg.answers).length === 0 && this.state.participant.fields) {
      reg.answers = Object.assign({}, this.state.participant.fields);
    }

    if (reg.step >= fields.length) return this.renderRegConfirm(fields);

    const field = fields[reg.step];
    const current = reg.answers[field.id] != null ? reg.answers[field.id] : null;
    const isInput = field.type === "text" || field.type === "number";

    let inputHTML;
    if (isInput) {
      const t = field.type === "number" ? "number" : "text";
      inputHTML = `<input id="reg-input" class="text-input" type="${t}"
                     inputmode="${field.type === "number" ? "decimal" : "text"}"
                     value="${current != null ? escapeHTML(String(current)) : ""}"
                     placeholder="Type your answer" autocomplete="off">`;
    } else {
      inputHTML = `<div class="options" role="radiogroup" aria-label="${escapeHTML(field.label)}">${
        (field.options || []).map((o) => `<button class="option ${current === o.value ? "option--selected" : ""}" data-val="${escapeHTML(o.value)}">
            <span>${escapeHTML(o.text)}</span><span class="option__check"></span></button>`).join("")
      }</div>`;
    }

    this.mount(`
      <div class="question">${escapeHTML(field.label)}</div>
      ${inputHTML}
      <div class="actions">
        ${(reg.step > 0 || this.state.sectionIndex > 0) ? `<button id="reg-back" class="btn btn--ghost">Back</button>` : ""}
        <button id="reg-next" class="btn btn--primary" disabled>Continue</button>
      </div>
    `);

    const nextBtn = document.getElementById("reg-next");
    const valid = () => {
      const v = reg.answers[field.id];
      if (field.required === false) return true;
      return v != null && String(v).trim() !== "";
    };
    const refresh = () => { nextBtn.disabled = !valid(); };

    if (isInput) {
      const inp = document.getElementById("reg-input");
      inp.addEventListener("input", () => {
        if (inp.value === "") { delete reg.answers[field.id]; }
        else { reg.answers[field.id] = field.type === "number" ? Number(inp.value) : inp.value; }
        refresh();
      });
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter" && valid()) nextBtn.click(); });
    } else {
      this.el().querySelectorAll(".option").forEach((b) =>
        b.addEventListener("click", () => { reg.answers[field.id] = b.dataset.val; this.renderRegistration(); })
      );
    }

    const back = document.getElementById("reg-back");
    if (back) back.addEventListener("click", () => {
      if (reg.step > 0) { reg.step--; this.renderRegistration(); }
      else this.prevSection();
    });
    nextBtn.addEventListener("click", () => {
      if (!valid()) return;
      reg.step++; this.renderRegistration();
    });
    refresh();
  },

  renderRegConfirm(fields) {
    const reg = this.state.reg;
    const rows = fields.map((f) => {
      const val = reg.answers[f.id];
      let text;
      if (val == null || String(val).trim() === "") text = "—";
      else if (f.options) text = (f.options.find((o) => o.value === val) || {}).text || val;
      else text = String(val);
      return `<div class="summary__row"><span class="summary__key">${escapeHTML(f.label)}</span><span class="summary__val">${escapeHTML(String(text))}</span></div>`;
    }).join("");

    this.mount(`
      <h2 class="title">Please check your answers</h2>
      <div class="summary">${rows}</div>
      <div class="actions">
        <button id="conf-back" class="btn btn--ghost">Back</button>
        <button id="conf-submit" class="btn btn--primary">Looks good</button>
      </div>
    `);

    document.getElementById("conf-back").addEventListener("click", () => { reg.step = fields.length - 1; this.renderRegistration(); });
    document.getElementById("conf-submit").addEventListener("click", async (e) => {
      e.target.disabled = true;
      await this.writeRegistration(reg.answers);
      await this.setProgress(this.state.sectionIndex + 1);
      this.render();
    });
  },

  /* ----- word_prompt question: chip input, one question per step ----- */
  async writeWords(promptId, words) {
    await this.db.ref(`word_responses/${this.state.uid}/${promptId}`).set({
      words: words.slice(),
      session: this.state.session,
      ts: firebase.database.ServerValue.TIMESTAMP
    });
  },

  renderWordQuestion(section, question) {
    const q = this.state.q;
    const maxW = question.max_words || 5;
    const minW = question.min_words || 1;
    if (!q.answers[question.id]) q.answers[question.id] = [];
    const words = q.answers[question.id];

    this.mount(`
      <div class="question">${ConfigLoader.fmtInline(question.prompt)}</div>
      ${question.image ? `<img class="prompt-img" src="${escapeHTML(question.image)}" alt="" />` : ""}
      <div class="chip-input">
        <input id="wa-input" type="text" inputmode="text" autocomplete="off"
               autocapitalize="none" spellcheck="false" placeholder="Type a word" aria-label="Type a word" />
        <button id="wa-add" class="btn btn--ghost chip-input__add" type="button">Add</button>
      </div>
      <div id="wa-counter" class="muted chip-counter"></div>
      <div id="wa-chips" class="chips" aria-live="polite"></div>
      <div class="actions">
        ${this.qShowBack() ? `<button id="q-back" class="btn btn--ghost">Back</button>` : ""}
        <button id="q-next" class="btn btn--primary">Continue</button>
      </div>
    `);

    const input = document.getElementById("wa-input");
    const addBtn = document.getElementById("wa-add");
    const chipsEl = document.getElementById("wa-chips");
    const counterEl = document.getElementById("wa-counter");
    const nextBtn = document.getElementById("q-next");
    const backBtn = document.getElementById("q-back");

    const refresh = () => {
      chipsEl.innerHTML = words.map((w, i) =>
        `<span class="chip">${escapeHTML(w)}<button class="chip__remove" data-i="${i}" type="button" aria-label="Remove ${escapeHTML(w)}">&times;</button></span>`
      ).join("");
      chipsEl.querySelectorAll(".chip__remove").forEach((b) =>
        b.addEventListener("click", () => { words.splice(+b.dataset.i, 1); refresh(); })
      );
      counterEl.textContent = `${words.length} of ${maxW} word${maxW === 1 ? "" : "s"}`;
      const atMax = words.length >= maxW;
      input.disabled = atMax; addBtn.disabled = atMax;
      input.placeholder = atMax ? "Maximum reached" : "Type a word";
      nextBtn.disabled = words.length < minW;
    };

    const add = () => {
      const raw = (input.value || "").trim();
      if (!raw || words.length >= maxW) { input.value = ""; return; }
      if (words.some((w) => w.toLowerCase() === raw.toLowerCase())) { input.value = ""; return; }
      words.push(raw); input.value = ""; refresh(); input.focus();
    };

    addBtn.addEventListener("click", add);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
    if (backBtn) backBtn.addEventListener("click", () => this.qBack(section));
    nextBtn.addEventListener("click", async () => {
      if (words.length < minW) return;
      nextBtn.disabled = true;
      await this.writeWords(question.id, words);
      this.qNext(section);
    });

    refresh();
  },

  /* ----- likert: one stimulus per screen, four dimensions, 5-point scale ----- */
  async writeAssessment(stimId, scores) {
    const payload = { session: this.state.session, ts: firebase.database.ServerValue.TIMESTAMP };
    this.state.config.likert.dimensions.forEach((d) => { payload[d.id] = scores[d.id]; });
    await this.db.ref(`assessments/${this.state.uid}/${stimId}`).set(payload);
  },

  renderLikert(section) {
    const lk = this.state.lk;
    const stimuli = section.stimuli || [];
    const stim = stimuli[lk.step];
    const L = this.state.config.likert;
    const dims = L.dimensions;
    const points = L.points || 5;
    const anchors = L.anchors || [];
    if (!lk.answers[stim.id]) lk.answers[stim.id] = {};
    const ans = lk.answers[stim.id];

    const cleanAnchor = (s) => (s || "").replace(/^\s*\d+\s*[-–—:.]\s*/, "");
    const leftCap = cleanAnchor(anchors[0]);
    const rightCap = cleanAnchor(anchors[points - 1]);

    const scaleHTML = (dim) => {
      let btns = "";
      for (let p = 1; p <= points; p++) {
        const on = ans[dim.id] === p;
        btns += `<button class="scale__btn ${on ? "scale__btn--on" : ""}" type="button"
                   data-dim="${dim.id}" data-val="${p}"
                   aria-label="${escapeHTML(anchors[p - 1] || String(p))}">${p}</button>`;
      }
      return `<div class="likert-row">
          <div class="likert-dim">${escapeHTML(dim.label)}</div>
          <div class="scale" role="radiogroup" aria-label="${escapeHTML(dim.label)}"
               style="grid-template-columns:repeat(${points},1fr)">${btns}</div>
          <div class="scale__ends"><span>${escapeHTML(leftCap)}</span><span>${escapeHTML(rightCap)}</span></div>
        </div>`;
    };

    const imgHTML = stim.image
      ? `<img class="stimulus-card__img" src="${escapeHTML(stim.image)}" alt="${escapeHTML(stim.title || "")}">` : "";

    this.mount(`
      <div class="stimulus-card">
        ${stim.title ? `<div class="stimulus-card__title">${escapeHTML(stim.title)}</div>` : ""}
        ${imgHTML}
        ${stim.body ? `<div class="stimulus-card__body">${escapeHTML(stim.body)}</div>` : ""}
      </div>
      <div class="likert-rows">${dims.map(scaleHTML).join("")}</div>
      <div class="actions">
        ${(lk.step > 0 || this.state.sectionIndex > 0) ? `<button id="lk-back" class="btn btn--ghost">Back</button>` : ""}
        <button id="lk-next" class="btn btn--primary" disabled>Continue</button>
      </div>
    `);

    const nextBtn = document.getElementById("lk-next");
    const backBtn = document.getElementById("lk-back");
    const allAnswered = () => dims.every((d) => typeof ans[d.id] === "number");
    const refreshNext = () => { nextBtn.disabled = !allAnswered(); };

    this.el().querySelectorAll(".scale__btn").forEach((b) =>
      b.addEventListener("click", () => {
        const dimId = b.dataset.dim, val = +b.dataset.val;
        ans[dimId] = val;
        this.el().querySelectorAll(`.scale__btn[data-dim="${dimId}"]`).forEach((x) =>
          x.classList.toggle("scale__btn--on", +x.dataset.val === val)
        );
        refreshNext();
      })
    );
    if (backBtn) backBtn.addEventListener("click", () => {
      if (lk.step > 0) { lk.step--; this.renderLikert(section); }
      else this.prevSection();
    });
    nextBtn.addEventListener("click", async () => {
      if (!allAnswered()) return;
      nextBtn.disabled = true;
      await this.writeAssessment(stim.id, ans);
      if (lk.step + 1 < stimuli.length) { lk.step++; this.renderLikert(section); }
      else { await this.setProgress(this.state.sectionIndex + 1); this.render(); }
    });
    refreshNext();
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
    if (b && b.text && this._dismissedBroadcastTs !== b.ts) {
      el.innerHTML = `
        <div class="broadcast__box" role="alertdialog" aria-modal="true">
          <div class="broadcast__label">Message from the facilitator</div>
          <div class="broadcast__msg">${escapeHTML(b.text)}</div>
          <button id="broadcast-close" class="btn btn--primary">Close</button>
        </div>`;
      el.style.display = "flex";
      document.getElementById("broadcast-close").addEventListener("click", () => {
        this._dismissedBroadcastTs = b.ts;
        el.style.display = "none";
        el.innerHTML = "";
      });
    } else if (!b || !b.text) {
      el.style.display = "none";
      el.innerHTML = "";
    }
  },

  renderBoot(msg) { this.el().innerHTML = `<div class="boot">${msg}</div>`; },
  renderError(msg) { this.el().innerHTML = `<div class="errbox">Something went wrong:<br>${msg}</div>`; }
};

window.addEventListener("DOMContentLoaded", () => App.boot());
