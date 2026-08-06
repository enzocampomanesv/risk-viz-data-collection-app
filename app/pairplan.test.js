/* Node test suite for pairplan.js. Run: node app/pairplan.test.js
 * No framework — plain asserts, exits non-zero on first failure so it's
 * CI-friendly, prints a pass count on success. */
const assert = require("assert");
const PP = require("./pairplan.js");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (e) { console.error(`FAIL - ${name}\n      ${e.message}`); process.exit(1); }
}

function items(spec) {
  // spec: { groupName: count, ... } -> [{id:"g1-0",group:"g1"}, ...]
  const out = [];
  Object.entries(spec).forEach(([g, n]) => {
    for (let i = 0; i < n; i++) out.push({ id: `${g}-${i}`, group: g });
  });
  return out;
}

function pairKey(p) { return `${p.item_a}|${p.item_b}`; }
function nC2(n) { return (n * (n - 1)) / 2; }

console.log("pairplan.js test suite");

/* ---------------------------------------------------------------- */
test("RNG determinism: same seed -> identical draw sequence", () => {
  const r1 = PP.mulberry32(42), r2 = PP.mulberry32(42);
  for (let i = 0; i < 20; i++) assert.strictEqual(r1(), r2());
});

test("RNG: different seeds diverge", () => {
  const r1 = PP.mulberry32(1), r2 = PP.mulberry32(2);
  const a = [], b = [];
  for (let i = 0; i < 10; i++) { a.push(r1()); b.push(r2()); }
  assert.notDeepStrictEqual(a, b);
});

test("hashSeed: same string -> same hash; different strings (likely) differ", () => {
  assert.strictEqual(PP.hashSeed("abc"), PP.hashSeed("abc"));
  assert.notStrictEqual(PP.hashSeed("abc"), PP.hashSeed("abd"));
});

test("seededShuffle: deterministic for a given rng seed, and a permutation (same multiset)", () => {
  const arr = [1, 2, 3, 4, 5];
  const s1 = PP.seededShuffle(arr, PP.mulberry32(7));
  const s2 = PP.seededShuffle(arr, PP.mulberry32(7));
  assert.deepStrictEqual(s1, s2);
  assert.deepStrictEqual([...s1].sort(), [...arr].sort());
});

test("seededSample: n=0 or n>=length returns everything (uncapped)", () => {
  const arr = [1, 2, 3, 4];
  assert.strictEqual(PP.seededSample(arr, 0, PP.mulberry32(1)).length, 4);
  assert.strictEqual(PP.seededSample(arr, 99, PP.mulberry32(1)).length, 4);
});

test("seededSample: capped size is exact and is a SUBSET, not necessarily a prefix", () => {
  const arr = [1, 2, 3, 4, 5, 6, 7, 8];
  const sample = PP.seededSample(arr, 3, PP.mulberry32(99));
  assert.strictEqual(sample.length, 3);
  sample.forEach((x) => assert.ok(arr.includes(x)));
  let allPrefix = true;
  for (let s = 0; s < 30; s++) {
    const samp = PP.seededSample(arr, 3, PP.mulberry32(s));
    if (JSON.stringify([...samp].sort()) !== JSON.stringify([1, 2, 3])) { allPrefix = false; break; }
  }
  assert.ok(!allPrefix, "sampling should not always degrade to the first N items");
});

test("allPairs: nC2 pairs, canonical order (item_a < item_b lexicographically), no self-pairs", () => {
  const ids = ["b", "a", "c"];
  const pairs = PP.allPairs(ids);
  assert.strictEqual(pairs.length, nC2(3));
  pairs.forEach((p) => {
    assert.ok(p.item_a < p.item_b, `expected canonical order, got ${p.item_a}/${p.item_b}`);
    assert.notStrictEqual(p.item_a, p.item_b);
  });
  const keys = new Set(pairs.map(pairKey));
  assert.strictEqual(keys.size, pairs.length, "no duplicate pairs");
});

/* ---------------------------------------------------------------- */
console.log("\n  -- buildPlan: pairing correctness --");

test("pairing NEVER crosses groups", () => {
  const its = items({ LoD: 5, format: 4 });
  const settings = { pairwise_sequence_mode: "shuffled", pairwise_loop: false, comparisons_per_group: 0, prep_comparisons: 0 };
  const plan = PP.buildPlan(its, settings, "p1");
  const byId = new Map(its.map((it) => [it.id, it.group]));
  plan.lap1.forEach((pr) => {
    assert.strictEqual(byId.get(pr.item_a), byId.get(pr.item_b), `cross-group pair found: ${pr.item_a}/${pr.item_b}`);
    assert.strictEqual(byId.get(pr.item_a), pr.group);
  });
});

test("uncapped: every possible within-group pair appears exactly once, across both groups", () => {
  const its = items({ LoD: 5, format: 4 });
  const settings = { pairwise_sequence_mode: "grouped", pairwise_loop: false, comparisons_per_group: 0, prep_comparisons: 0 };
  const plan = PP.buildPlan(its, settings, "p1");
  assert.strictEqual(plan.lap1.length, nC2(5) + nC2(4));
  const expected = new Set([
    ...PP.allPairs(its.filter((i) => i.group === "LoD").map((i) => i.id)).map(pairKey),
    ...PP.allPairs(its.filter((i) => i.group === "format").map((i) => i.id)).map(pairKey),
  ]);
  const got = new Set(plan.lap1.map(pairKey));
  assert.deepStrictEqual(got, expected);
});

test("preparation group is isolated: its pairs are NOT in groupOrder/groupPools/lap1", () => {
  const its = items({ preparation: 3, LoD: 4 });
  const settings = { pairwise_sequence_mode: "grouped", pairwise_loop: false, comparisons_per_group: 0, prep_comparisons: 0 };
  const plan = PP.buildPlan(its, settings, "p1");
  assert.deepStrictEqual(plan.groupOrder, ["LoD"]);
  assert.strictEqual(plan.groupPools.has("preparation"), false);
  assert.strictEqual(plan.prepPairs.length, nC2(3));
  const lapKeys = new Set(plan.lap1.map(pairKey));
  plan.prepPairs.forEach((pr) => assert.ok(!lapKeys.has(pairKey(pr)), "prep pair leaked into real lap1"));
});

test("groupOrder follows first-appearance (spreadsheet) order, not alphabetical", () => {
  const its = [
    { id: "z1", group: "zebra" }, { id: "z2", group: "zebra" },
    { id: "a1", group: "alpha" }, { id: "a2", group: "alpha" },
  ];
  const settings = { pairwise_sequence_mode: "grouped", pairwise_loop: false, comparisons_per_group: 0, prep_comparisons: 0 };
  const plan = PP.buildPlan(its, settings, "p1");
  assert.deepStrictEqual(plan.groupOrder, ["zebra", "alpha"]);
});

console.log("\n  -- comparisons_per_group capping --");

test("cap < possible pairs: each group's pool is capped to exactly N", () => {
  const its = items({ LoD: 6, format: 5 });
  const settings = { pairwise_sequence_mode: "grouped", pairwise_loop: false, comparisons_per_group: 4, prep_comparisons: 0 };
  const plan = PP.buildPlan(its, settings, "p1");
  assert.strictEqual(plan.groupPools.get("LoD").length, 4);
  assert.strictEqual(plan.groupPools.get("format").length, 4);
  assert.strictEqual(plan.lap1.length, 8);
});

test("cap >= possible pairs: behaves as uncapped for that group", () => {
  const its = items({ tiny: 3 });
  const settings = { pairwise_sequence_mode: "grouped", pairwise_loop: false, comparisons_per_group: 99, prep_comparisons: 0 };
  const plan = PP.buildPlan(its, settings, "p1");
  assert.strictEqual(plan.groupPools.get("tiny").length, 3);
});

test("cap is PER GROUP (independently applied), not a single overall cap", () => {
  const its = items({ A: 10, B: 10, C: 10 });
  const settings = { pairwise_sequence_mode: "shuffled", pairwise_loop: false, comparisons_per_group: 5, prep_comparisons: 0 };
  const plan = PP.buildPlan(its, settings, "p1");
  assert.strictEqual(plan.groupPools.get("A").length, 5);
  assert.strictEqual(plan.groupPools.get("B").length, 5);
  assert.strictEqual(plan.groupPools.get("C").length, 5);
  assert.strictEqual(plan.lap1.length, 15);
});

test("cap resamples per participant (different seeds -> can select different pair subsets)", () => {
  const its = items({ G: 8 });
  const settings = { pairwise_sequence_mode: "grouped", pairwise_loop: false, comparisons_per_group: 4, prep_comparisons: 0 };
  const subsets = new Set();
  for (let s = 0; s < 15; s++) {
    const plan = PP.buildPlan(its, settings, `participant-${s}`);
    subsets.add(JSON.stringify([...plan.groupPools.get("G")].map(pairKey).sort()));
  }
  assert.ok(subsets.size > 1, "expected per-participant resampling to yield more than one distinct subset across 15 seeds");
});

test("prep_comparisons caps independently of comparisons_per_group", () => {
  const its = items({ preparation: 6, G: 6 });
  const settings = { pairwise_sequence_mode: "grouped", pairwise_loop: false, comparisons_per_group: 0, prep_comparisons: 3 };
  const plan = PP.buildPlan(its, settings, "p1");
  assert.strictEqual(plan.prepPairs.length, 3);
  assert.strictEqual(plan.groupPools.get("G").length, 15);
});

console.log("\n  -- sequencing: grouped vs shuffled --");

test("grouped mode: group A's pairs all appear (contiguously) before group B's", () => {
  const its = items({ first: 4, second: 4 });
  const settings = { pairwise_sequence_mode: "grouped", pairwise_loop: false, comparisons_per_group: 0, prep_comparisons: 0 };
  const plan = PP.buildPlan(its, settings, "p1");
  const groups = plan.lap1.map((p) => p.group);
  const firstLastIdx = groups.lastIndexOf("first");
  const secondFirstIdx = groups.indexOf("second");
  assert.ok(firstLastIdx < secondFirstIdx, "expected all 'first' pairs to precede all 'second' pairs");
});

test("grouped mode: within-group order is seeded-shuffled, not spreadsheet/id order", () => {
  const its = items({ G: 6 });
  const settings = { pairwise_sequence_mode: "grouped", pairwise_loop: false, comparisons_per_group: 0, prep_comparisons: 0 };
  let foundShuffled = false;
  for (let s = 0; s < 10; s++) {
    const plan = PP.buildPlan(its, settings, `seed-${s}`);
    const canonical = PP.allPairs(its.map((i) => i.id)).map(pairKey);
    if (JSON.stringify(plan.lap1.map(pairKey)) !== JSON.stringify(canonical)) { foundShuffled = true; break; }
  }
  assert.ok(foundShuffled, "expected at least one seed to produce non-canonical (shuffled) within-group order");
});

test("grouped mode ignores pairwise_loop even if set true in settings", () => {
  const its = items({ G: 4 });
  const settings = { pairwise_sequence_mode: "grouped", pairwise_loop: true, comparisons_per_group: 0, prep_comparisons: 0 };
  const plan = PP.buildPlan(its, settings, "p1");
  assert.strictEqual(plan.loop, false);
});

test("shuffled mode: groups are interleaved (not all of one group contiguously) for at least one seed", () => {
  const its = items({ X: 5, Y: 5 });
  const settings = { pairwise_sequence_mode: "shuffled", pairwise_loop: false, comparisons_per_group: 0, prep_comparisons: 0 };
  let foundInterleaved = false;
  for (let s = 0; s < 10; s++) {
    const plan = PP.buildPlan(its, settings, `seed-${s}`);
    const groups = plan.lap1.map((p) => p.group);
    const switches = groups.slice(1).filter((g, i) => g !== groups[i]).length;
    if (switches > 1) { foundInterleaved = true; break; }
  }
  assert.ok(foundInterleaved, "expected shuffled mode to interleave groups for at least one seed");
});

console.log("\n  -- loop / relap --");

test("relap throws for grouped mode or loop=false", () => {
  const its = items({ G: 4 });
  const grouped = PP.buildPlan(its, { pairwise_sequence_mode: "grouped", pairwise_loop: false, comparisons_per_group: 0, prep_comparisons: 0 }, "p1");
  assert.throws(() => PP.relap(grouped, 2));
  const noLoop = PP.buildPlan(its, { pairwise_sequence_mode: "shuffled", pairwise_loop: false, comparisons_per_group: 0, prep_comparisons: 0 }, "p1");
  assert.throws(() => PP.relap(noLoop, 2));
});

test("relap(lap=1) returns lap1 itself", () => {
  const its = items({ G: 5 });
  const plan = PP.buildPlan(its, { pairwise_sequence_mode: "shuffled", pairwise_loop: true, comparisons_per_group: 0, prep_comparisons: 0 }, "p1");
  assert.deepStrictEqual(PP.relap(plan, 1), plan.lap1);
});

test("each lap is the SAME pair set, re-ordered (not re-sampled)", () => {
  const its = items({ G: 6 });
  const plan = PP.buildPlan(its, { pairwise_sequence_mode: "shuffled", pairwise_loop: true, comparisons_per_group: 0, prep_comparisons: 0 }, "p1");
  const lap1set = new Set(plan.lap1.map(pairKey));
  for (let lap = 2; lap <= 5; lap++) {
    const seq = PP.relap(plan, lap);
    assert.strictEqual(seq.length, plan.lap1.length);
    assert.deepStrictEqual(new Set(seq.map(pairKey)), lap1set, `lap ${lap} pair set should equal lap 1's pair set`);
  }
});

test("laps differ in ORDER from each other (for a seed where that's checkable) and from lap1", () => {
  const its = items({ G: 7 });
  const plan = PP.buildPlan(its, { pairwise_sequence_mode: "shuffled", pairwise_loop: true, comparisons_per_group: 0, prep_comparisons: 0 }, "order-diff-seed");
  const lap2 = PP.relap(plan, 2), lap3 = PP.relap(plan, 3);
  assert.notDeepStrictEqual(plan.lap1.map(pairKey), lap2.map(pairKey));
  assert.notDeepStrictEqual(lap2.map(pairKey), lap3.map(pairKey));
});

test("relap is idempotent: calling relap(plan, N) repeatedly gives identical results", () => {
  const its = items({ G: 6 });
  const plan = PP.buildPlan(its, { pairwise_sequence_mode: "shuffled", pairwise_loop: true, comparisons_per_group: 0, prep_comparisons: 0 }, "p1");
  const a = PP.relap(plan, 4), b = PP.relap(plan, 4), c = PP.relap(plan, 4);
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(b, c);
});

test("relap is idempotent ACROSS a freshly rebuilt plan object (the actual resume scenario)", () => {
  const its = items({ G: 6 });
  const settings = { pairwise_sequence_mode: "shuffled", pairwise_loop: true, comparisons_per_group: 0, prep_comparisons: 0 };
  const planA = PP.buildPlan(its, settings, "resume-seed");
  const lapA3 = PP.relap(planA, 3);
  const planB = PP.buildPlan(its, settings, "resume-seed");
  const lapB3 = PP.relap(planB, 3);
  assert.deepStrictEqual(lapA3, lapB3, "lap 3 must be identical whether computed from the original plan or a freshly rebuilt one");
});

console.log("\n  -- currentPair / resume --");

test("currentPair walks idx within lap 1 correctly and matches lap1 array directly", () => {
  const its = items({ G: 5 });
  const plan = PP.buildPlan(its, { pairwise_sequence_mode: "grouped", pairwise_loop: false, comparisons_per_group: 0, prep_comparisons: 0 }, "p1");
  for (let i = 0; i < plan.lap1.length; i++) {
    const r = PP.currentPair(plan, i, 1);
    assert.deepStrictEqual(r.pair, plan.lap1[i]);
    assert.strictEqual(r.lap, 1);
  }
});

test("currentPair returns null past the end in non-loop mode (section complete)", () => {
  const its = items({ G: 4 });
  const plan = PP.buildPlan(its, { pairwise_sequence_mode: "grouped", pairwise_loop: false, comparisons_per_group: 0, prep_comparisons: 0 }, "p1");
  assert.strictEqual(PP.currentPair(plan, plan.lap1.length, 1), null);
  assert.strictEqual(PP.currentPair(plan, 999, 1), null);
});

test("currentPair rolls over into lap 2+ when loop is on and idx exceeds one lap's length", () => {
  const its = items({ G: 5 });
  const plan = PP.buildPlan(its, { pairwise_sequence_mode: "shuffled", pairwise_loop: true, comparisons_per_group: 0, prep_comparisons: 0 }, "p1");
  const n = plan.lap1.length;
  const atStartOfLap2 = PP.currentPair(plan, n, 1);
  assert.strictEqual(atStartOfLap2.lap, 2);
  assert.strictEqual(atStartOfLap2.idx, 0);
  assert.deepStrictEqual(atStartOfLap2.pair, PP.relap(plan, 2)[0]);
});

test("currentPair never returns null when loop is on, however large idx/lap get", () => {
  const its = items({ G: 4 });
  const plan = PP.buildPlan(its, { pairwise_sequence_mode: "shuffled", pairwise_loop: true, comparisons_per_group: 0, prep_comparisons: 0 }, "p1");
  assert.notStrictEqual(PP.currentPair(plan, 0, 50), null);
  assert.notStrictEqual(PP.currentPair(plan, plan.lap1.length * 3 + 1, 1), null);
});

test("FULL RESUME SCENARIO: rebuilding the plan from scratch and asking for (idx, lap) reproduces the exact same comparison", () => {
  const its = items({ LoD: 6, format: 5 });
  const settings = { pairwise_sequence_mode: "shuffled", pairwise_loop: true, comparisons_per_group: 4, prep_comparisons: 0 };
  const seedStr = "uid-abc123:session-pilot";

  const planSession1 = PP.buildPlan(its, settings, seedStr);
  const shown1 = PP.currentPair(planSession1, 3, 3);
  const side1 = PP.drawSide(planSession1, 3, 3);

  const planSession2 = PP.buildPlan(its, settings, seedStr);
  const shown2 = PP.currentPair(planSession2, 3, 3);
  const side2 = PP.drawSide(planSession2, 3, 3);

  assert.deepStrictEqual(shown1, shown2, "resumed comparison must be identical");
  assert.deepStrictEqual(side1, side2, "resumed display side must be identical");
});

console.log("\n  -- drawSide --");

test("drawSide is deterministic per (lap, idx) and returns a valid permutation of item_a/item_b", () => {
  const plan = PP.buildPlan(items({ G: 4 }), { pairwise_sequence_mode: "grouped", pairwise_loop: false, comparisons_per_group: 0, prep_comparisons: 0 }, "p1");
  const a = PP.drawSide(plan, 1, 0), b = PP.drawSide(plan, 1, 0);
  assert.deepStrictEqual(a, b);
  assert.ok(
    (a[0] === "item_a" && a[1] === "item_b") || (a[0] === "item_b" && a[1] === "item_a")
  );
});

test("drawSide varies across different (lap, idx) positions (not a constant)", () => {
  const plan = PP.buildPlan(items({ G: 6 }), { pairwise_sequence_mode: "grouped", pairwise_loop: false, comparisons_per_group: 0, prep_comparisons: 0 }, "p1");
  const sides = new Set();
  for (let i = 0; i < 15; i++) sides.add(PP.drawSide(plan, 1, i).join(","));
  assert.ok(sides.size > 1, "expected drawSide to produce both orderings across many positions");
});

console.log(`\n${passed} passed, 0 failed`);
