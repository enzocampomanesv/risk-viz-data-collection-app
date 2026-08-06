/*
 * pairplan.js — deterministic pairwise comparison plan generator.
 *
 * Pure functions only: no DOM, no Firebase. Everything here is a function of
 * (items, settings, seed, idx, lap) so the exact same plan can be regenerated
 * from a tiny persisted state ({seed, idx, lap}) on every page load — nothing
 * about the pair list itself needs to be stored in the database.
 *
 * Design (locked with the researcher):
 *  - Pairing is ALWAYS within-group; cross-group pairs never occur.
 *  - The "preparation" group is warm-up only: paired like any other group,
 *    capped by prep_comparisons, but never written to the comparisons node
 *    and excluded from the real per-group pools.
 *  - comparisons_per_group caps each group's pair pool via a seeded random
 *    SUBSET (not "first N"), and that subset is fixed once per participant —
 *    looping reshuffles ORDER, never re-samples WHICH pairs were chosen.
 *  - grouped mode: each group's (capped) pairs in full, in spreadsheet group
 *    order; pairs WITHIN a group are seeded-shuffled. No loop (ends after one
 *    pass through all groups).
 *  - shuffled mode: every group's capped pairs concatenated, then the whole
 *    set is seeded-shuffled together. If loop is on, exhausting the sequence
 *    reshuffles the SAME pair set into a new lap. Each lap's order is derived
 *    by reseeding from (seed, lapNumber) — a pure function, not a mutable
 *    stream — so lap N is always lap N no matter how many times or in what
 *    order it's requested. This is what makes resume safe: re-deriving the
 *    plan from a freshly loaded page and asking for lap 7 reproduces exactly
 *    the same lap 7 a stateful "continue advancing the RNG" design could not.
 *  - shown_left/shown_right (display-side randomization) are likewise a pure
 *    function of (seed, lap, idx), not a stream draw — re-rendering the same
 *    comparison after a refresh shows it on the same side rather than
 *    flickering, and never perturbs the pairing RNG's draw sequence.
 */
(function (root) {
  "use strict";

  /* ---------------------------- seeded RNG ---------------------------- */
  // mulberry32: tiny, fast, good-enough statistical quality for UI shuffling.
  // Deterministic: same seed -> same infinite stream of [0,1) draws.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Hash an arbitrary string (e.g. `${uid}:${session}:pairwise`) to a 32-bit
  // int so callers can seed from human-readable identifiers. djb2 variant.
  function hashSeed(str) {
    str = String(str);
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    }
    return h >>> 0;
  }

  // Fisher–Yates using a provided RNG (mutates and returns a copy of arr).
  function seededShuffle(arr, rng) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  }

  // Random subset of size n from arr (n>=length returns all), via shuffle+slice
  // — never "first N", so capping doesn't systematically favor early rows.
  function seededSample(arr, n, rng) {
    if (n <= 0 || n >= arr.length) return arr.slice();
    return seededShuffle(arr, rng).slice(0, n);
  }

  /* ---------------------------- pairing core ---------------------------- */
  // All unique unordered pairs from a list of item ids, canonical order
  // (lower id first lexicographically) so pair identity is stable regardless
  // of how items were discovered.
  function allPairs(ids) {
    const out = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const [a, b] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]];
        out.push({ item_a: a, item_b: b });
      }
    }
    return out;
  }

  function groupBy(items, key) {
    const m = new Map();
    items.forEach((it) => {
      const k = it[key];
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(it);
    });
    return m;
  }

  /**
   * Build the full deterministic plan for one participant.
   *
   * @param {Array}  items   comparison_items (each {id, group, ...})
   * @param {Object} settings { pairwise_sequence_mode, pairwise_loop, comparisons_per_group, prep_comparisons }
   * @param {String|Number} seedInput  stable per-participant identifier (e.g. `${uid}:${session}`) or a raw numeric seed
   * @returns {Object} {
   *   seed,                 // resolved numeric seed (persist this, not seedInput)
   *   prepPairs,            // [{item_a,item_b}] — warm-up, never persisted/written
   *   groupOrder,           // [groupName,...] in spreadsheet first-appearance order (excludes "preparation")
   *   groupPools,           // Map<groupName, [{item_a,item_b}]>  — fixed capped pool per group, pre-RNG-consumption
   *   sequenceMode,         // "grouped" | "shuffled"
   *   loop,                 // bool (always false in grouped mode, even if settings said otherwise)
   *   lap1,                 // [{item_a,item_b,group}] — the first lap's ordered sequence
   *   totalNonLoop          // length of lap1; in grouped/non-loop mode this is the whole section
   * }
   */
  function buildPlan(items, settings, seedInput) {
    const seed = typeof seedInput === "number" ? (seedInput >>> 0) : hashSeed(seedInput);
    const rng = mulberry32(seed);

    const mode = settings.pairwise_sequence_mode === "shuffled" ? "shuffled" : "grouped";
    const loop = mode === "shuffled" && !!settings.pairwise_loop; // grouped never loops
    const perGroupCap = Number(settings.comparisons_per_group) || 0;
    const prepCap = Number(settings.prep_comparisons) || 0;

    const byGroup = groupBy(items, "group");

    // Prep: paired and capped the same way as a real group, but kept separate
    // and never mixed into groupPools.
    const prepItems = (byGroup.get("preparation") || []).map((it) => it.id);
    const prepAll = allPairs(prepItems);
    const prepPairs = seededSample(prepAll, prepCap, rng);

    // Real groups, in first-appearance order (stable, not Map iteration luck
    // across engines — Map does preserve insertion order in JS, but we make
    // the contract explicit rather than relying on the reader knowing that).
    const groupOrder = [];
    items.forEach((it) => {
      if (it.group !== "preparation" && !groupOrder.includes(it.group)) groupOrder.push(it.group);
    });

    const groupPools = new Map();
    groupOrder.forEach((g) => {
      const ids = (byGroup.get(g) || []).map((it) => it.id);
      const pairs = allPairs(ids);
      groupPools.set(g, seededSample(pairs, perGroupCap, rng).map((p) => Object.assign({ group: g }, p)));
    });

    const lap1 = mode === "grouped"
      ? groupOrder.flatMap((g) => seededShuffle(groupPools.get(g), rng))
      : seededShuffle(groupOrder.flatMap((g) => groupPools.get(g)), rng);

    return {
      seed, prepPairs, groupOrder, groupPools,
      sequenceMode: mode, loop,
      lap1, totalNonLoop: lap1.length,
    };
  }

  /**
   * Compute lap N (1-indexed) of the shuffled+loop sequence.
   *
   * IMPORTANT: this must be a pure function of (plan.seed, lapNumber) — calling
   * it twice with the same lapNumber must return an identical sequence, since
   * resume correctness depends on it. We do NOT reuse buildPlan()'s RNG object
   * (that stream is single-use, consumed while building groupPools/lap1) —
   * instead each lap reshuffles the fixed pool with a *freshly seeded* RNG
   * derived from (plan.seed, lapNumber), so lap 7 is always lap 7 regardless
   * of how many times or in what order it's requested.
   */
  function relap(plan, lapNumber) {
    if (plan.sequenceMode !== "shuffled" || !plan.loop) {
      throw new Error("relap() only applies to shuffled mode with loop enabled");
    }
    if (lapNumber <= 1) return plan.lap1;
    const flatPool = plan.groupOrder.flatMap((g) => plan.groupPools.get(g));
    const lapRng = mulberry32(hashSeed(`${plan.seed}:lap${lapNumber}`));
    return seededShuffle(flatPool, lapRng);
  }

  /**
   * Resolve which comparison the participant should see right now, given
   * persisted progress {idx, lap}. Returns null if the section is complete
   * (only possible in non-loop modes; loop mode never naturally completes —
   * the host's gate release is what ends it).
   */
  function currentPair(plan, idx, lap) {
    lap = lap || 1;
    const seq = lap === 1 ? plan.lap1 : relap(plan, lap);
    if (idx < seq.length) return { pair: seq[idx], idx, lap, seq_len: seq.length };
    if (plan.loop) return currentPair(plan, idx - seq.length, lap + 1);
    return null; // exhausted, non-loop
  }

  /**
   * Deterministic left/right display assignment for a specific (lap, idx)
   * position — a pure function, NOT a stream draw, so re-rendering the same
   * comparison (e.g. after a refresh) shows it on the same side rather than
   * flickering to the opposite side each time. Seeded independently of the
   * pairing RNG so display-side choice never perturbs pair selection/order.
   */
  function drawSide(plan, lap, idx) {
    const r = mulberry32(hashSeed(`${plan.seed}:side:${lap}:${idx}`))();
    return r < 0.5 ? ["item_a", "item_b"] : ["item_b", "item_a"];
  }

  const PairPlan = {
    mulberry32, hashSeed, seededShuffle, seededSample,
    allPairs, buildPlan, relap, currentPair, drawSide,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = PairPlan;
  else root.PairPlan = PairPlan;
})(typeof window !== "undefined" ? window : globalThis);
