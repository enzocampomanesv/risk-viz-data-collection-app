/*
 * config-loader.js
 * Loads config/config.json (structure) + config/content.json (Excel-derived
 * content), merges them, runs structural validation, and resolves with the
 * combined config. Throws on anything malformed so setup fails loudly.
 */
const ConfigLoader = (function () {

  const VALID_SECTION_TYPES = [
    "consent", "registration", "questionnaire",
    "discussion", "likert"
  ];

  // Question types allowed inside a questionnaire section.
  const VALID_QUESTION_TYPES = ["single_choice", "multiple_choice", "word_prompt"];

  // ---- inline rich text (study-authored) -------------------------------------
  // Authored in the xlsx and carried verbatim through content.json. Two rules,
  // both safe (HTML is escaped first; only <strong>/<span class="hl…"> emitted):
  //   **word**            -> bold
  //   [[name:words]]      -> coloured span, name in HL_COLORS
  // Combine as [[red:**high chance**]]. Unknown colour names render as plain
  // text. Not nestable (one colour token at a time).
  const HL_COLORS = ["red", "green", "blue", "amber", "teal"];
  const RE_COLOR = /\[\[([a-z]+):([\s\S]+?)\]\]/g;
  const RE_BOLD = /\*\*([\s\S]+?)\*\*/g;
  function escHTML(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  // Escaped, formatted HTML for display.
  function fmtInline(s) {
    return escHTML(s)
      .replace(RE_COLOR, (m, name, text) =>
        HL_COLORS.indexOf(name) >= 0 ? `<span class="hl hl--${name}">${text}</span>` : text)
      .replace(RE_BOLD, "<strong>$1</strong>");
  }
  // Plain text with the markup removed (for aria-labels, CSV export, analysis).
  function stripMarkup(s) {
    return String(s == null ? "" : s)
      .replace(RE_COLOR, "$2")
      .replace(RE_BOLD, "$1");
  }

  // Likert anchors derived from the number of points (set in the settings tab).
  function anchorsFor(points) {
    if (points === 3) return ["Disagree", "Neutral", "Agree"];
    if (points === 5) return ["1 - Not at all", "2", "3 - Neutral", "4", "5 - Very much"];
    return Array.from({ length: points }, (_, i) => String(i + 1));
  }

  // Merge Excel-derived content into the config structure. Content is the source
  // of truth for everything editable; config.json only carries fixed structure.
  function mergeContent(cfg, content) {
    if (!content) return;
    const settings = content.settings || {};
    cfg.settings = settings;
    if (Array.isArray(content.participant_fields)) cfg.participant_fields = content.participant_fields;

    // Likert points + anchors come from settings; dimensions stay in config.json.
    cfg.likert = cfg.likert || {};
    const pts = typeof settings.likert_points === "number" ? settings.likert_points : (cfg.likert.points || 5);
    cfg.likert.points = pts;
    cfg.likert.anchors = anchorsFor(pts);

    // First questionnaire section id — the home for any question that doesn't
    // carry a `section` (blank cell in the Excel `questions` tab).
    const firstQSec = (cfg.sections.find((s) => s.type === "questionnaire") || {}).id;

    cfg.sections.forEach((sec) => {
      if (sec.type === "questionnaire" && Array.isArray(content.questions)) {
        sec.questions = content.questions.filter((q) => (q.section || firstQSec) === sec.id);
      }
      if (sec.type === "discussion" && Array.isArray(content.discussion_prompts)) sec.prompts = content.discussion_prompts;
      if (sec.type === "likert" && Array.isArray(content.likert_stimuli)) sec.stimuli = content.likert_stimuli;
    });
  }

  // Per-question structural check for questionnaire sections. Mirrors the
  // build_content.py validation so a hand-edited content.json still fails loudly.
  function validateQuestion(q, where, errors) {
    if (!q || typeof q !== "object") { errors.push(`${where} is not an object`); return; }
    if (!q.id) errors.push(`${where} missing "id"`);
    if (!VALID_QUESTION_TYPES.includes(q.type)) {
      errors.push(`${where} invalid type "${q.type}" (single_choice | multiple_choice | word_prompt)`);
      return; // type-specific checks below would be meaningless
    }
    if (!q.prompt || String(q.prompt).trim() === "") errors.push(`${where} missing "prompt"`);
    if (q.type === "single_choice" || q.type === "multiple_choice") {
      if (!Array.isArray(q.choices) || q.choices.length < 2) {
        errors.push(`${where} (${q.type}) needs at least 2 choices`);
      }
    } else { // word_prompt
      if (typeof q.max_words !== "number" || typeof q.min_words !== "number") {
        errors.push(`${where} (word_prompt) needs numeric max_words and min_words`);
      } else if (q.min_words < 1 || q.max_words < q.min_words) {
        errors.push(`${where} (word_prompt) requires 1 <= min_words <= max_words`);
      }
    }
  }

  function validate(cfg) {
    const errors = [];
    ["study", "consent", "likert", "sections"].forEach((k) => {
      if (!(k in cfg)) errors.push(`Missing top-level key: "${k}"`);
    });

    if (Array.isArray(cfg.participant_fields)) {
      cfg.participant_fields.forEach((f, i) => {
        if (!f.id) errors.push(`participant_fields[${i}] missing "id"`);
        if (!f.label) errors.push(`participant_fields[${i}] missing "label"`);
        if (f.type === "select" && !Array.isArray(f.options)) {
          errors.push(`participant_fields[${i}] (single-choice) missing options — add option rows in the registration tab`);
        }
      });
    } else {
      errors.push(`"participant_fields" missing (registration tab → content.json)`);
    }

    if (cfg.likert) {
      if (typeof cfg.likert.points !== "number") errors.push(`likert.points must be a number (settings tab)`);
      if (!Array.isArray(cfg.likert.anchors) || cfg.likert.anchors.length !== cfg.likert.points) {
        errors.push(`likert.anchors length must equal likert.points (${cfg.likert.points})`);
      }
      if (!Array.isArray(cfg.likert.dimensions) || cfg.likert.dimensions.length === 0) {
        errors.push(`likert.dimensions must be a non-empty array`);
      }
    }

    if (Array.isArray(cfg.sections)) {
      const seen = new Set();
      cfg.sections.forEach((s, i) => {
        if (!s.id) errors.push(`sections[${i}] missing "id"`);
        if (seen.has(s.id)) errors.push(`Duplicate section id: "${s.id}"`);
        seen.add(s.id);
        if (!VALID_SECTION_TYPES.includes(s.type)) errors.push(`sections[${i}] invalid type "${s.type}"`);
        if (s.orientation && !["portrait", "landscape"].includes(s.orientation)) {
          errors.push(`sections[${i}] orientation must be "portrait" or "landscape"`);
        }
        if (s.type === "questionnaire") {
          if (!Array.isArray(s.questions) || s.questions.length === 0) {
            errors.push(`questionnaire section "${s.id}" has no questions (questions tab)`);
          } else {
            s.questions.forEach((q, qi) => validateQuestion(q, `sections[${i}].questions[${qi}]`, errors));
          }
        }
        if (s.type === "discussion" && (!Array.isArray(s.prompts) || s.prompts.length === 0)) {
          errors.push(`discussion section has no prompts (discussion tab)`);
        }
        if (s.type === "likert" && (!Array.isArray(s.stimuli) || s.stimuli.length === 0)) {
          errors.push(`likert section has no stimuli (likert_stimuli tab)`);
        }
      });
    } else {
      errors.push(`"sections" must be an array`);
    }

    if (errors.length) throw new Error("config validation failed:\n - " + errors.join("\n - "));
    return cfg;
  }

  async function load(url = "config/config.json", contentUrl = "config/content.json") {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`Could not fetch ${url}: HTTP ${res.status}`);
    let cfg;
    try { cfg = await res.json(); }
    catch (e) { throw new Error(`config.json is not valid JSON: ${e.message}`); }

    try {
      const cres = await fetch(contentUrl, { cache: "no-store" });
      if (cres.ok) mergeContent(cfg, await cres.json());
      else throw new Error(`HTTP ${cres.status}`);
    } catch (e) {
      throw new Error(`content.json not loaded (run tools/build_content.py): ${e.message}`);
    }

    return validate(cfg);
  }

  return { load, validate, mergeContent, anchorsFor, fmtInline, stripMarkup, HL_COLORS };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ConfigLoader;
