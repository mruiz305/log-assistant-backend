/**
 * Tests for conversational and analysis follow-up intent classification.
 * Ensures short interpretive messages route to conversational/analysis_followup,
 * NOT to KPI/SQL.
 * Run: node test/conversationalFollowup.test.js
 */

const assert = require("assert");
const { classifyWithRules } = require("../src/application/chat/aiOrchestrator/aiIntentClassification.service");
const { classifyIntentInfo } = require("../src/domain/intent/intent");

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

console.log("Conversational / analysis follow-up intent tests\n");

let passed = 0;
let failed = 0;

// --- conversational_followup: no SQL ---
const cf1 = runTest("What else can you tell me? → conversational_followup, needs_sql=false", () => {
  const r = classifyWithRules("What else can you tell me?", "en");
  assert.strictEqual(r.primary_intent, "conversational_followup");
  assert.strictEqual(r.needs_sql, false);
});
if (cf1.ok) passed++; else failed++;

const cf2 = runTest("Tell me more → conversational_followup", () => {
  const r = classifyWithRules("Tell me more", "en");
  assert.strictEqual(r.primary_intent, "conversational_followup");
  assert.strictEqual(r.needs_sql, false);
});
if (cf2.ok) passed++; else failed++;

const cf3 = runTest("Dime más → conversational_followup", () => {
  const r = classifyWithRules("Dime más", "es");
  assert.strictEqual(r.primary_intent, "conversational_followup");
  assert.strictEqual(r.needs_sql, false);
});
if (cf3.ok) passed++; else failed++;

const cf4 = runTest("Anything else? → conversational_followup", () => {
  const r = classifyWithRules("Anything else?", "en");
  assert.strictEqual(r.primary_intent, "conversational_followup");
  assert.strictEqual(r.needs_sql, false);
});
if (cf4.ok) passed++; else failed++;

const cf5 = runTest("Can you give me more detail? → conversational_followup", () => {
  const r = classifyWithRules("Can you give me more detail?", "en");
  assert.strictEqual(r.primary_intent, "conversational_followup");
  assert.strictEqual(r.needs_sql, false);
});
if (cf5.ok) passed++; else failed++;

const cf6 = runTest("¿Qué más me puedes decir? → conversational_followup", () => {
  const r = classifyWithRules("¿Qué más me puedes decir?", "es");
  assert.strictEqual(r.primary_intent, "conversational_followup");
  assert.strictEqual(r.needs_sql, false);
});
if (cf6.ok) passed++; else failed++;

const cf7 = runTest("¿Algo más? → conversational_followup", () => {
  const r = classifyWithRules("¿Algo más?", "es");
  assert.strictEqual(r.primary_intent, "conversational_followup");
  assert.strictEqual(r.needs_sql, false);
});
if (cf7.ok) passed++; else failed++;

// --- analysis_followup: no SQL ---
const af1 = runTest("What does that mean? → analysis_followup, needs_sql=false", () => {
  const r = classifyWithRules("What does that mean?", "en");
  assert.strictEqual(r.primary_intent, "analysis_followup");
  assert.strictEqual(r.needs_sql, false);
});
if (af1.ok) passed++; else failed++;

const af2 = runTest("Why is that? → analysis_followup", () => {
  const r = classifyWithRules("Why is that?", "en");
  assert.strictEqual(r.primary_intent, "analysis_followup");
  assert.strictEqual(r.needs_sql, false);
});
if (af2.ok) passed++; else failed++;

const af3 = runTest("Is that good or bad? → analysis_followup", () => {
  const r = classifyWithRules("Is that good or bad?", "en");
  assert.strictEqual(r.primary_intent, "analysis_followup");
  assert.strictEqual(r.needs_sql, false);
});
if (af3.ok) passed++; else failed++;

const af4 = runTest("What should we investigate? → analysis_followup", () => {
  const r = classifyWithRules("What should we investigate?", "en");
  assert.strictEqual(r.primary_intent, "analysis_followup");
  assert.strictEqual(r.needs_sql, false);
});
if (af4.ok) passed++; else failed++;

const af5 = runTest("Anything unusual there? → analysis_followup", () => {
  const r = classifyWithRules("Anything unusual there?", "en");
  assert.strictEqual(r.primary_intent, "analysis_followup");
  assert.strictEqual(r.needs_sql, false);
});
if (af5.ok) passed++; else failed++;

const af6 = runTest("¿Por qué pasó eso? → analysis_followup", () => {
  const r = classifyWithRules("¿Por qué pasó eso?", "es");
  assert.strictEqual(r.primary_intent, "analysis_followup");
  assert.strictEqual(r.needs_sql, false);
});
if (af6.ok) passed++; else failed++;

const af7 = runTest("¿Eso es bueno o malo? → analysis_followup", () => {
  const r = classifyWithRules("¿Eso es bueno o malo?", "es");
  assert.strictEqual(r.primary_intent, "analysis_followup");
  assert.strictEqual(r.needs_sql, false);
});
if (af7.ok) passed++; else failed++;

// --- classifyIntentInfo: needsSql false for follow-ups ---
const ci1 = runTest("classifyIntentInfo: Tell me more → needsSql=false", () => {
  const r = classifyIntentInfo("Tell me more");
  assert.strictEqual(r.needsSql, false);
});
if (ci1.ok) passed++; else failed++;

const ci2 = runTest("classifyIntentInfo: Why is that? → needsSql=false", () => {
  const r = classifyIntentInfo("Why is that?");
  assert.strictEqual(r.needsSql, false);
});
if (ci2.ok) passed++; else failed++;

// --- KPI queries still route to kpi (no regression) ---
const k1 = runTest("How many cases did Maria confirm? → kpi", () => {
  const r = classifyWithRules("How many cases did Maria confirm this month?", "en");
  assert.strictEqual(r.primary_intent, "kpi");
  assert.strictEqual(r.needs_sql, true);
});
if (k1.ok) passed++; else failed++;

const k2 = runTest("Show top reps this month → kpi/sql path", () => {
  const r = classifyWithRules("Show top reps this month", "en");
  assert.ok(r.needs_sql === true || r.primary_intent === "kpi", "should trigger data path");
});
if (k2.ok) passed++; else failed++;

// --- follow_up (data expansion) still works ---
const fu1 = runTest("And last month? → follow_up (needs expansion)", () => {
  const r = classifyWithRules("And last month?", "en");
  assert.strictEqual(r.primary_intent, "follow_up");
  assert.strictEqual(r.needs_sql, true);
});
if (fu1.ok) passed++; else failed++;

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
