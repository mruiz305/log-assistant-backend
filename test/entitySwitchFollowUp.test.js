/**
 * Tests for explicit entity-switch follow-up handling.
 * "What about Maria?" after "What was Alix's drop rate?" → Maria's drop rate.
 * Run: node test/entitySwitchFollowUp.test.js
 */

const assert = require("assert");
const { isEntitySwitchFollowUp, extractEntitySwitch } = require("../src/utils/topic");
const { classifyWithRules } = require("../src/application/chat/aiOrchestrator/aiIntentClassification.service");
const { expandFollowUpWithRules } = require("../src/application/chat/aiOrchestrator/expandFollowUp.service");

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

console.log("Entity-switch follow-up tests\n");

let passed = 0;
let failed = 0;

// --- isEntitySwitchFollowUp detection ---
const t1 = runTest("What about Maria? → entity switch", () => {
  assert.strictEqual(isEntitySwitchFollowUp("What about Maria?"), true);
});
if (t1.ok) passed++; else failed++;

const t2 = runTest("How about Juan? → entity switch", () => {
  assert.strictEqual(isEntitySwitchFollowUp("How about Juan?"), true);
});
if (t2.ok) passed++; else failed++;

const t3 = runTest("And Maria? → entity switch", () => {
  assert.strictEqual(isEntitySwitchFollowUp("And Maria?"), true);
});
if (t3.ok) passed++; else failed++;

const t4 = runTest("¿Y Maria? → entity switch", () => {
  assert.strictEqual(isEntitySwitchFollowUp("¿Y Maria?"), true);
});
if (t4.ok) passed++; else failed++;

const t5 = runTest("¿Qué tal Maria? → entity switch", () => {
  assert.strictEqual(isEntitySwitchFollowUp("¿Qué tal Maria?"), true);
});
if (t5.ok) passed++; else failed++;

const t6 = runTest("And last month? → NOT entity switch (no new entity)", () => {
  assert.strictEqual(isEntitySwitchFollowUp("And last month?"), false);
});
if (t6.ok) passed++; else failed++;

// --- extractEntitySwitch ---
const t7 = runTest("extractEntitySwitch: What about Maria?", () => {
  const out = extractEntitySwitch("What about Maria?");
  assert.ok(out);
  assert.strictEqual(out.entity, "Maria");
  assert.strictEqual(out.periodOverride || "", "");
});
if (t7.ok) passed++; else failed++;

const t8 = runTest("extractEntitySwitch: And Maria this month?", () => {
  const out = extractEntitySwitch("And Maria this month?");
  assert.ok(out);
  assert.strictEqual(out.entity, "Maria");
  assert.ok(out.periodOverride && out.periodOverride.toLowerCase().includes("month"));
});
if (t8.ok) passed++; else failed++;

// --- Classification: entity switch → follow_up, NOT conversational_followup ---
const t9 = runTest("What about Maria? → follow_up, needs_data=true", () => {
  const r = classifyWithRules("What about Maria?", "en");
  assert.strictEqual(r.primary_intent, "follow_up");
  assert.strictEqual(r.needs_data, true);
  assert.strictEqual(r.needs_sql, true);
});
if (t9.ok) passed++; else failed++;

const t10 = runTest("¿Y Maria? → follow_up, NOT conversational_followup", () => {
  const r = classifyWithRules("¿Y Maria?", "es");
  assert.strictEqual(r.primary_intent, "follow_up");
  assert.notStrictEqual(r.primary_intent, "conversational_followup");
});
if (t10.ok) passed++; else failed++;

// --- Expansion: use lastMetric and lastPeriod, replace entity ---
const t11 = runTest("Expand: What about Maria? (Alix, drop rate, this year)", () => {
  const ctx = { lastPerson: "Alix", lastPeriod: "this year", lastMetric: "drop rate", uiLang: "en" };
  const out = expandFollowUpWithRules("What about Maria?", ctx);
  assert.ok(out);
  assert.ok(out.toLowerCase().includes("maria"));
  assert.ok(out.toLowerCase().includes("drop rate"));
  assert.ok(out.toLowerCase().includes("this year"));
  assert.ok(!out.toLowerCase().includes("alix"));
});
if (t11.ok) passed++; else failed++;

const t12 = runTest("Expand: What about Juan? (Tony, cases, this month)", () => {
  const ctx = { lastPerson: "Tony", lastPeriod: "this month", lastMetric: "cases", uiLang: "en" };
  const out = expandFollowUpWithRules("What about Juan?", ctx);
  assert.ok(out);
  assert.ok(out.toLowerCase().includes("juan"));
  assert.ok(out.toLowerCase().includes("confirmed"));
  assert.ok(out.toLowerCase().includes("this month"));
  assert.ok(!out.toLowerCase().includes("tony"));
});
if (t12.ok) passed++; else failed++;

const t13 = runTest("Expand: ¿Y Maria? (Alix, drop rate, Spanish)", () => {
  const ctx = { lastPerson: "Alix", lastPeriod: "este año", lastMetric: "drop rate", uiLang: "es" };
  const out = expandFollowUpWithRules("¿Y Maria?", ctx);
  assert.ok(out);
  assert.ok(out.toLowerCase().includes("maria"));
  assert.ok(out.toLowerCase().includes("cancelación") || out.toLowerCase().includes("drop"));
  assert.ok(!out.toLowerCase().includes("alix"));
});
if (t13.ok) passed++; else failed++;

const t14 = runTest("Expand: And Maria this month? (period override)", () => {
  const ctx = { lastPerson: "Tony", lastPeriod: "last month", lastMetric: "cases", uiLang: "en" };
  const out = expandFollowUpWithRules("And Maria this month?", ctx);
  assert.ok(out);
  assert.ok(out.toLowerCase().includes("maria"));
  assert.ok(out.toLowerCase().includes("this month"));
  assert.ok(!out.toLowerCase().includes("last month"));
});
if (t14.ok) passed++; else failed++;

const t15 = runTest("Control: And last month? (period follow-up, not entity switch) uses lastPerson", () => {
  const ctx = { lastPerson: "Maria", lastPeriod: "", lastMetric: "cases", uiLang: "en" };
  const out = expandFollowUpWithRules("And last month?", ctx);
  assert.ok(out);
  assert.ok(out.toLowerCase().includes("maria") || out.toLowerCase().includes("for maria"));
  assert.ok(out.toLowerCase().includes("last month"));
});
if (t15.ok) passed++; else failed++;

// --- Entity-switch fallback for dimension extraction ---
const t16 = runTest("extractEntitySwitch: What about Maria this month?", () => {
  const out = extractEntitySwitch("What about Maria this month?");
  assert.ok(out);
  assert.strictEqual(out.entity, "Maria");
  assert.ok(out.periodOverride && out.periodOverride.toLowerCase().includes("month"));
});
if (t16.ok) passed++; else failed++;

// --- Summary ---
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
