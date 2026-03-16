/**
 * Tests for queryPlan guardrails.
 * Run: node test/queryPlanGuardrails.test.js
 */

const assert = require("assert");
const {
  canUseSuggestedEntity,
  shouldTriggerDisambiguation,
  shouldUseNeedsAnalysis,
} = require("../src/application/chat/aiOrchestrator/queryPlanGuardrails");

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return { ok: true };
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    return { ok: false };
  }
}

console.log("queryPlan guardrails tests\n");

let passed = 0;
let failed = 0;

// --- canUseSuggestedEntity ---

const g1 = runTest("reject when no lastPerson (stale context)", () => {
  const r = canUseSuggestedEntity({
    queryPlan: { suggested_entity: "Maria" },
    lastPerson: "",
    effectiveMessage: "and last month?",
    uiLang: "en",
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "no_context_lastPerson");
});
if (g1.ok) passed++; else failed++;

const g2 = runTest("reject when suggested_entity mismatches context", () => {
  const r = canUseSuggestedEntity({
    queryPlan: { suggested_entity: "Juan" },
    lastPerson: "Maria Chacon",
    effectiveMessage: "and last month?",
    uiLang: "en",
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "suggested_entity_mismatch_context");
});
if (g2.ok) passed++; else failed++;

const g3 = runTest("reject explicit entity switch (How many cases did Juan confirm?)", () => {
  const r = canUseSuggestedEntity({
    queryPlan: { suggested_entity: "Maria" },
    lastPerson: "Maria Chacon",
    effectiveMessage: "How many cases did Juan confirm this month?",
    uiLang: "en",
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "explicit_entity_switch");
});
if (g3.ok) passed++; else failed++;

const g4 = runTest("reject new topic (Top reps by office)", () => {
  const r = canUseSuggestedEntity({
    queryPlan: { suggested_entity: "Maria" },
    lastPerson: "Maria Chacon",
    effectiveMessage: "Top reps by office",
    uiLang: "en",
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "new_topic");
});
if (g4.ok) passed++; else failed++;

const g5 = runTest("accept when context aligns (And last month?)", () => {
  const r = canUseSuggestedEntity({
    queryPlan: { suggested_entity: "Maria" },
    lastPerson: "Maria Chacon",
    effectiveMessage: "And last month?",
    uiLang: "en",
  });
  assert.strictEqual(r.ok, true);
});
if (g5.ok) passed++; else failed++;

const g6 = runTest("accept when suggested matches first token of lastPerson", () => {
  const r = canUseSuggestedEntity({
    queryPlan: { suggested_entity: "Maria" },
    lastPerson: "Maria Chacon",
    effectiveMessage: "compare with average",
    uiLang: "en",
  });
  assert.strictEqual(r.ok, true);
});
if (g6.ok) passed++; else failed++;

// --- shouldTriggerDisambiguation ---

const d1 = runTest("disambiguation: reject long message", () => {
  const r = shouldTriggerDisambiguation({
    queryPlan: { needs_disambiguation: true },
    effectiveMessage: "I would like to see the performance of Maria and compare with the team for this month",
    uiLang: "en",
  });
  assert.strictEqual(r, false);
});
if (d1.ok) passed++; else failed++;

const d2 = runTest("disambiguation: reject message with entity keyword", () => {
  const r = shouldTriggerDisambiguation({
    queryPlan: { needs_disambiguation: true },
    effectiveMessage: "Maria performance",
    uiLang: "en",
  });
  assert.strictEqual(r, false);
});
if (d2.ok) passed++; else failed++;

const d3 = runTest("disambiguation: accept short ambiguous message", () => {
  const r = shouldTriggerDisambiguation({
    queryPlan: { needs_disambiguation: true },
    effectiveMessage: "Analyze",
    uiLang: "en",
  });
  assert.strictEqual(r, true);
});
if (d3.ok) passed++; else failed++;

// --- shouldUseNeedsAnalysis ---

const a1 = runTest("needs_analysis: reject simple count", () => {
  const r = shouldUseNeedsAnalysis(true, "How many cases this month?");
  assert.strictEqual(r, false);
});
if (a1.ok) passed++; else failed++;

const a2 = runTest("needs_analysis: reject cuántos without analysis", () => {
  const r = shouldUseNeedsAnalysis(true, "Cuántos casos confirmó Maria");
  assert.strictEqual(r, false);
});
if (a2.ok) passed++; else failed++;

const a3 = runTest("needs_analysis: accept when question has why/compare", () => {
  const r = shouldUseNeedsAnalysis(true, "Why did conversions drop this month?");
  assert.strictEqual(r, true);
});
if (a3.ok) passed++; else failed++;

const a4 = runTest("needs_analysis: reject when metaNeedsAnalysis false", () => {
  const r = shouldUseNeedsAnalysis(false, "Why did conversions drop?");
  assert.strictEqual(r, false);
});
if (a4.ok) passed++; else failed++;

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
