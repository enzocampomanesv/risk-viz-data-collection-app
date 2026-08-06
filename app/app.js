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
function indexBy(arr, key) {
  const m = {};
  arr.forEach((o) => { m[o[key]] = o; });
  return m;
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
    backFlags: { pairwise: false, choice: false, end: false },
    participant: {},          // mirror of participants/{uid}
    sectionIndex: 0,          // index into config.sections
    reg: { step: 0, answers: {} },  // registration sub-state
    wa: { step: 0, answers: {} },   // word-association sub-state
    lk: { step: 0, answers: {} },   // likert sub-state
    ch: { step: 0, answers: {} },   // choice sub-state
    ch: { step: 0, answers: {} },   // choice sub-state
    pw: null,                 // pairwise sub-state (per active pairwise section)
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

      // Host-controlled Back-button visibility (pairwise / choice / end).
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

  async writeRegistration(answers) {
    await this.db.ref(`participants/${this.state.uid}`).update({ fields: answers });
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
    this.detachOrient();
    this.detachPres();
    const cfg = this.state.config;
    const section = cfg.sections[this.state.sectionIndex];
    if (!section) return this.renderComplete();
    if (section.type === "discussion") return this.renderDiscussionFlow(section);
    if (this.isGated(section)) return this.renderGated(section);
    return this.renderSection(section);
  },

  isPortrait() { return window.innerHeight > window.innerWidth; },
  detachOrient() {
    if (this._orientHandler) { window.removeEventListener("resize", this._orientHandler); this._orientHandler = null; }
  },
  detachPres() {
    if (this._presRef) { this._presRef.off("value", this._presHandler); this._presRef = null; this._presHandler = null; }
  },

  // Host-controlled visibility of the Back button on the three "late" screens
  // (pairwise, choice, end) where it isn't on by default. Listened once at
  // boot so toggles from the control room take effect live, mid-session.
  watchBackFlags() {
    this.state.backFlags = this.state.backFlags || { pairwise: false, choice: false, end: false };
    ["pairwise", "choice", "end"].forEach((key) => {
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
  // This is the ONLY thing that can interrupt a participant mid-pairwise-loop
  // (renderPairwiseComparison otherwise re-checks nothing after entry). It is
  // event-driven and independent of whatever screen is currently rendered.
  //
  // Semantics:
  //  - The value present at boot is recorded as a baseline and NOT acted on, so
  //    refreshers/late-joiners are governed by their own persisted progress
  //    rather than being teleported by a standing force.
  //  - Only acts on a strictly newer ts (one-shot), matching this session, with
  //    a section_id that resolves to a real section.
  //  - Preserves already-persisted sub-state (pw_plan, votes, registration); it
  //    only moves the section pointer, mirroring prevSection's teardown.
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
      this.state.pw = null;                                  // clean teardown of any pairwise loop
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
      case "consent":          return this.renderConsent(section);
      case "registration":     return this.renderRegistration(section);
      case "word_association": return this.renderWordAssociation(section);
      case "likert":           return this.renderLikert(section);
      case "pairwise":         return this.enterPairwise(section);
      case "choice":           return this.renderChoice(section);
      default:                 return this.renderError(`Unknown section type: ${section.type}`);
    }
  },

  // Temporary stub (replaced in Stage 4) so the full flow is walkable now.
  async writeChoice(qId, choiceIdx) {
    await this.db.ref(`choices/${this.state.uid}/${qId}`).set({
      choice_idx: choiceIdx,
      session: this.state.session,
      ts: firebase.database.ServerValue.TIMESTAMP
    });
  },

  // Single-select multiple-choice questions, one per step. Mirrors the likert
  // flow: answers held in memory this session (a refresh restarts at q1 but
  // already-written answers persist), section advances only after the last
  // question. Intra-question Back is always allowed; the step-0 cross-section
  // Back honours the host's back_choice flag.
  renderChoice(section) {
    const ch = this.state.ch;
    const questions = section.questions || [];
    if (!questions.length) { this.setProgress(this.state.sectionIndex + 1).then(() => this.render()); return; }
    if (ch.step >= questions.length) ch.step = questions.length - 1;
    const q = questions[ch.step];
    const canCrossBack = this.state.backFlags.choice;
    const showBack = ch.step > 0 || (canCrossBack && this.state.sectionIndex > 0);
    let selected = (q.id in ch.answers) ? ch.answers[q.id] : null;

    const options = (q.choices || []).map((text, i) =>
      `<button class="option ${selected === i ? "option--selected" : ""}" type="button" data-idx="${i}"
          aria-label="${escapeHTML(ConfigLoader.stripMarkup(text))}">
          <span>${ConfigLoader.fmtInline(text)}</span><span class="option__check"></span></button>`
    ).join("");

    this.mount(`
      <h2 class="title">${ConfigLoader.fmtInline(q.prompt)}</h2>
      <div class="options" role="radiogroup" aria-label="${escapeHTML(ConfigLoader.stripMarkup(q.prompt))}">${options}</div>
      <div class="actions">
        ${showBack ? `<button id="ch-back" class="btn btn--ghost">Back</button>` : ""}
        <button id="ch-next" class="btn btn--primary" disabled>Continue</button>
      </div>
    `);

    const nextBtn = document.getElementById("ch-next");
    const refreshNext = () => { nextBtn.disabled = selected === null; };
    this.el().querySelectorAll(".option").forEach((b) =>
      b.addEventListener("click", () => {
        selected = +b.dataset.idx;
        ch.answers[q.id] = selected;
        this.el().querySelectorAll(".option").forEach((x) => x.classList.toggle("option--selected", +x.dataset.idx === selected));
        refreshNext();
      })
    );
    const back = document.getElementById("ch-back");
    if (back) back.addEventListener("click", () => {
      if (ch.step > 0) { ch.step--; this.renderChoice(section); }
      else this.prevSection();
    });
    nextBtn.addEventListener("click", async () => {
      if (selected === null) return;
      nextBtn.disabled = true;
      try { await this.writeChoice(q.id, selected); }
      catch (e) { return this.renderError(e.message); }
      if (ch.step + 1 < questions.length) { ch.step++; this.renderChoice(section); }
      else { await this.setProgress(this.state.sectionIndex + 1); this.render(); }
    });
    refreshNext();
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
    } else if (section.type === "word_association") {
      this.state.wa.step = 0;  // answers retained in memory this session
    } else if (section.type === "likert") {
      this.state.lk.step = 0;
    } else if (section.type === "choice") {
      this.state.ch.step = 0;  // answers retained in memory this session
    } else if (section.type === "choice") {
      this.state.ch.step = 0;  // answers retained in memory this session
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

  mount(bodyHTML, { withProgress = true, withFooter = true, wide = false } = {}) {
    this.el().innerHTML =
      `<div class="screen ${wide ? "screen--wide" : ""}">
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

  /* ----- word association: chip input, one prompt per screen ----- */
  async writeWords(promptId, words) {
    await this.db.ref(`word_responses/${this.state.uid}/${promptId}`).set({
      words: words.slice(),
      session: this.state.session,
      ts: firebase.database.ServerValue.TIMESTAMP
    });
  },

  renderWordAssociation(section) {
    const wa = this.state.wa;
    const prompts = section.prompts || [];
    const prompt = prompts[wa.step];
    const maxW = prompt.max_words || 5;
    const minW = prompt.min_words || 1;
    if (!wa.answers[prompt.id]) wa.answers[prompt.id] = [];
    const words = wa.answers[prompt.id];

    this.mount(`
      <div class="question">${escapeHTML(prompt.text)}</div>
      ${prompt.image ? `<img class="prompt-img" src="${escapeHTML(prompt.image)}" alt="" />` : ""}
      <div class="chip-input">
        <input id="wa-input" type="text" inputmode="text" autocomplete="off"
               autocapitalize="none" spellcheck="false" placeholder="Type a word" aria-label="Type a word" />
        <button id="wa-add" class="btn btn--ghost chip-input__add" type="button">Add</button>
      </div>
      <div id="wa-counter" class="muted chip-counter"></div>
      <div id="wa-chips" class="chips" aria-live="polite"></div>
      <div class="actions">
        ${(wa.step > 0 || this.state.sectionIndex > 0) ? `<button id="wa-back" class="btn btn--ghost">Back</button>` : ""}
        <button id="wa-next" class="btn btn--primary">Continue</button>
      </div>
    `);

    const input = document.getElementById("wa-input");
    const addBtn = document.getElementById("wa-add");
    const chipsEl = document.getElementById("wa-chips");
    const counterEl = document.getElementById("wa-counter");
    const nextBtn = document.getElementById("wa-next");
    const backBtn = document.getElementById("wa-back");

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
    if (backBtn) backBtn.addEventListener("click", () => {
      if (wa.step > 0) { wa.step--; this.renderWordAssociation(section); }
      else this.prevSection();
    });
    nextBtn.addEventListener("click", async () => {
      if (words.length < minW) return;
      nextBtn.disabled = true;
      await this.writeWords(prompt.id, words);
      if (wa.step + 1 < prompts.length) { wa.step++; this.renderWordAssociation(section); }
      else { await this.setProgress(this.state.sectionIndex + 1); this.render(); }
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

  /* ----- pairwise: merged image/text cards, within-group pairing, prep
     warm-up, grouped/shuffled sequencing, optional looping laps. The actual
     pair selection/ordering/resume logic lives in pairplan.js (pure,
     unit-tested); this just drives the UI and persists {seed, idx, lap}. ----- */
  async enterPairwise(section) {
    // Already active for this section (e.g. after a vote re-render) — reuse.
    if (this.state.pw && this.state.pw.sectionId === section.id) return this.renderPairwiseFrame();

    const items = section.items || [];
    const settings = {
      pairwise_sequence_mode: section.sequence_mode,
      pairwise_loop: section.loop,
      comparisons_per_group: section.comparisons_per_group,
      prep_comparisons: section.prep_comparisons,
    };

    this.renderBoot("Preparing…");
    const planRef = this.db.ref(`participants/${this.state.uid}/pw_plan`);
    let rec;
    try {
      const snap = await this.withTimeout(planRef.once("value"), 8000, "Plan read");
      rec = snap.val();
    } catch (e) { return this.renderError(e.message); }
    // No pw_plan record yet means no real vote has ever been cast for this
    // participant — NOT "first page load", since the seed itself is a pure
    // function of (uid, session) and needs no reservation write. We only
    // persist pw_plan once idx/lap actually advance (see the vote handler
    // below), so "record exists" is an unambiguous signal that real voting
    // has started — which is exactly what decides whether prep runs again.
    const seed = PairPlan.hashSeed(`${this.state.uid}:${this.state.session}`);
    const hasRealProgress = !!rec;
    rec = rec || { seed, idx: 0, lap: 1 };

    const plan = PairPlan.buildPlan(items, settings, rec.seed);
    this.state.pw = {
      sectionId: section.id, folder: section.folder || "",
      itemsById: indexBy(items, "id"),
      plan, idx: rec.idx, lap: rec.lap || 1,
      prompt: section.prompt || "Which option do you prefer?",
      // Prep runs only when no real vote has ever been recorded. It is never
      // persisted itself, so a refresh DURING prep correctly restarts it
      // (no pw_plan exists yet either way) — but once the first real vote
      // exists, prep must never be forced again on a later resume.
      prepIdx: 0, inPrep: !hasRealProgress && plan.prepPairs.length > 0,
    };
    this.renderPairwiseFrame();
  },

  // Decide rotate-prompt vs comparison based on orientation; re-evaluate on resize.
  renderPairwiseFrame() {
    this.detachOrient();
    const section = this.state.config.sections[this.state.sectionIndex];
    const needsRotate = () => section.orientation === "landscape" && section.rotate_prompt && this.isPortrait();
    const evaluate = () => { needsRotate() ? this.renderRotatePrompt() : this.renderPairwiseComparison(); };
    this._orientHandler = evaluate;
    window.addEventListener("resize", evaluate);
    evaluate();
  },

  renderRotatePrompt() {
    this.mount(`
      <div class="rotate">
        <div class="rotate__icon" aria-hidden="true">⟲</div>
        <h2 class="title">Please turn your phone sideways</h2>
        <p class="lead muted">This part works best in landscape. Rotate your phone to continue.</p>
      </div>
    `, { withProgress: false, withFooter: false });
  },

  pairCard(item) {
    const pw = this.state.pw;
    if (item && item.file) {
      const src = (pw.folder ? pw.folder + "/" : "") + item.file;
      return `<img class="pw-img" src="${escapeHTML(src)}" alt="${escapeHTML(item.label || "")}"
                onerror="this.outerHTML='<div class=&quot;pw-img-missing&quot;>${escapeHTML(item.label || item.id)}</div>'">`;
    }
    return `<div class="pw-text">${escapeHTML((item && (item.text || item.label)) || "")}</div>`;
  },

  renderPairwiseComparison() {
    const pw = this.state.pw;
    if (!pw) return; // stale call (e.g. a resize event after this.finishPairwise() already ran) — nothing to render
    const canBack = this.state.backFlags.pairwise;

    // ---- prep (warm-up) phase: never persisted, never written ----
    if (pw.inPrep) {
      const prepPairs = pw.plan.prepPairs;
      if (pw.prepIdx >= prepPairs.length) { pw.inPrep = false; return this.renderPairwiseComparison(); }
      const pair = prepPairs[pw.prepIdx];
      const [leftKey, rightKey] = PairPlan.drawSide(pw.plan, 0, pw.prepIdx);
      const L = pw.itemsById[pair[leftKey]] || { id: pair[leftKey] };
      const R = pw.itemsById[pair[rightKey]] || { id: pair[rightKey] };
      this.mount(`
        <div class="pw-top">
          <div class="pw-progress">Warm-up</div>
          <div class="pw-question">${escapeHTML(pw.prompt)}</div>
        </div>
        <div class="pw-board">
          <button class="pw-card" data-side="left" type="button">${this.pairCard(L)}</button>
          <button class="pw-card" data-side="right" type="button">${this.pairCard(R)}</button>
        </div>
        <div class="actions pw-actions">
          ${canBack && pw.prepIdx === 0 ? `<button id="pw-back" class="btn btn--ghost">Back</button>` : ""}
          <button id="pw-next" class="btn btn--primary" disabled>Choose</button>
        </div>
      `, { withProgress: false, withFooter: false, wide: true });
      this.wirePairwiseCard(() => { pw.prepIdx += 1; this.renderPairwiseComparison(); });
      const back = document.getElementById("pw-back");
      if (back) back.addEventListener("click", () => { this.detachOrient(); this.prevSection(); });
      return;
    }

    // ---- real (recorded) comparisons ----
    const cur = PairPlan.currentPair(pw.plan, pw.idx, pw.lap);
    if (!cur) { this.detachOrient(); return this.finishPairwise(); }

    const pair = cur.pair;
    const [leftKey, rightKey] = PairPlan.drawSide(pw.plan, cur.lap, cur.idx);
    const L = pw.itemsById[pair[leftKey]] || { id: pair[leftKey] };
    const R = pw.itemsById[pair[rightKey]] || { id: pair[rightKey] };

    this.mount(`
      <div class="pw-top">
        <div class="pw-question">${escapeHTML(pw.prompt)}</div>
      </div>
      <div class="pw-board">
        <button class="pw-card" data-side="left" type="button">${this.pairCard(L)}</button>
        <button class="pw-card" data-side="right" type="button">${this.pairCard(R)}</button>
      </div>
      <div class="actions pw-actions">
        ${canBack ? `<button id="pw-back" class="btn btn--ghost">Back</button>` : ""}
        <button id="pw-next" class="btn btn--primary" disabled>Choose</button>
      </div>
    `, { withProgress: false, withFooter: false, wide: true });

    this.wirePairwiseCard(async (side) => {
      const winner = side === "left" ? pair[leftKey] : pair[rightKey];
      try {
        await this.writeComparison({
          group: pair.group, lap: cur.lap,
          item_a: pair.item_a, item_b: pair.item_b, winner,
          shown_left: pair[leftKey], shown_right: pair[rightKey],
        });
        // Advance idx within the current lap; currentPair() handles lap rollover
        // (loop mode) on the NEXT render, so we only ever persist a simple
        // monotonic idx here — rollover bookkeeping is pairplan.js's job, not ours.
        pw.idx = cur.idx + 1;
        pw.lap = cur.lap;
        const rolled = PairPlan.currentPair(pw.plan, pw.idx, pw.lap);
        if (rolled && rolled.lap !== cur.lap) { pw.idx = rolled.idx; pw.lap = rolled.lap; }
        await this.db.ref(`participants/${this.state.uid}/pw_plan`).set({ seed: pw.plan.seed, idx: pw.idx, lap: pw.lap });
      } catch (e) { return this.renderError(e.message); }
      this.renderPairwiseComparison();
    });
    const back = document.getElementById("pw-back");
    // Back leaves pw_plan's {idx, lap} exactly as persisted above — resuming
    // pairwise later picks up at the same spot rather than restarting.
    if (back) back.addEventListener("click", () => { this.detachOrient(); this.prevSection(); });
  },

  // Shared click-to-select-then-Choose wiring for both prep and real cards.
  // onChoose receives the selected side ("left"/"right"); prep ignores it.
  wirePairwiseCard(onChoose) {
    let selected = null;
    const nextBtn = document.getElementById("pw-next");
    this.el().querySelectorAll(".pw-card").forEach((c) =>
      c.addEventListener("click", () => {
        selected = c.dataset.side;
        this.el().querySelectorAll(".pw-card").forEach((x) => x.classList.toggle("pw-card--selected", x === c));
        nextBtn.disabled = false;
      })
    );
    nextBtn.addEventListener("click", () => {
      if (!selected) return;
      nextBtn.disabled = true;
      onChoose(selected);
    });
  },

  async writeComparison(c) {
    await this.db.ref("comparisons").push({
      uid: this.state.uid,
      group: c.group, lap: c.lap,
      item_a: c.item_a, item_b: c.item_b, winner: c.winner,
      shown_left: c.shown_left, shown_right: c.shown_right,
      session: this.state.session,
      ts: firebase.database.ServerValue.TIMESTAMP
    });
  },

  async finishPairwise() {
    this.detachOrient();
    this.state.pw = null;
    await this.setProgress(this.state.sectionIndex + 1);
    this.render();
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
