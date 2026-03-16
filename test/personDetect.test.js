/**
 * Tests for person/entity signal detection, including possessive patterns.
 * Run: node test/personDetect.test.js
 */

const assert = require("assert");
const { getExplicitPersonFromMessage } = require("../src/utils/personDetect");
const { mentionsPersonExplicitly } = require("../src/utils/chatRoute.helpers");
const { extractPersonNameFromMessage } = require("../src/utils/personRewrite");
const { extractDimensionAndValue } = require("../src/domain/dimensions/dimensionExtractor");

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

console.log("personDetect tests – possessive entity signal\n");

let passed = 0;
let failed = 0;

// --- Tony's (ASCII apostrophe) ---
const t1 = runTest("Tony's drop rate in 2025 – mentionsPersonExplicitly", () => {
  assert.strictEqual(mentionsPersonExplicitly("What was Tony's drop rate in 2025?"), true);
});
if (t1.ok) passed++; else failed++;

const t2 = runTest("Tony's drop rate – getExplicitPersonFromMessage", () => {
  const p = getExplicitPersonFromMessage("What was Tony's drop rate in 2025?", "en");
  assert.ok(p, "expected person to be extracted");
  assert.ok(/tony/i.test(p), `expected Tony, got ${p}`);
});
if (t2.ok) passed++; else failed++;

// --- Tony's (typographic apostrophe U+2019) ---
const t3 = runTest("Tony's drop rate (typographic apostrophe) – mentionsPersonExplicitly", () => {
  const msg = "What was Tony\u2019s drop rate in 2025?";
  assert.strictEqual(mentionsPersonExplicitly(msg), true);
});
if (t3.ok) passed++; else failed++;

const t4 = runTest("Tony's drop rate (typographic apostrophe) – getExplicitPersonFromMessage", () => {
  const msg = "What was Tony\u2019s drop rate in 2025?";
  const p = getExplicitPersonFromMessage(msg, "en");
  assert.ok(p, "expected person to be extracted");
  assert.ok(/tony/i.test(p), `expected Tony, got ${p}`);
});
if (t4.ok) passed++; else failed++;

// --- Maria's confirmed cases ---
const t5 = runTest("Maria's confirmed cases this month – mentionsPersonExplicitly", () => {
  assert.strictEqual(mentionsPersonExplicitly("Maria's confirmed cases this month"), true);
});
if (t5.ok) passed++; else failed++;

const t6 = runTest("Maria's confirmed cases – getExplicitPersonFromMessage", () => {
  const p = getExplicitPersonFromMessage("Maria's confirmed cases this month", "en");
  assert.ok(p, "expected person to be extracted");
  assert.ok(/maria/i.test(p), `expected Maria, got ${p}`);
});
if (t6.ok) passed++; else failed++;

// --- Juan's (typographic apostrophe) ---
const t7 = runTest("Juan's performance this year – mentionsPersonExplicitly", () => {
  assert.strictEqual(mentionsPersonExplicitly("Juan\u2019s performance this year"), true);
});
if (t7.ok) passed++; else failed++;

const t8 = runTest("Juan's performance – getExplicitPersonFromMessage", () => {
  const p = getExplicitPersonFromMessage("Juan\u2019s performance this year", "en");
  assert.ok(p, "expected person to be extracted");
  assert.ok(/juan/i.test(p), `expected Juan, got ${p}`);
});
if (t8.ok) passed++; else failed++;

// --- Control: no person entity, no false positive ---
const t9 = runTest("Control: no person – mentionsPersonExplicitly false", () => {
  assert.strictEqual(mentionsPersonExplicitly("What was the drop rate in 2025?"), false);
});
if (t9.ok) passed++; else failed++;

const t10 = runTest("Control: no person – getExplicitPersonFromMessage null", () => {
  const p = getExplicitPersonFromMessage("What was the drop rate in 2025?", "en");
  assert.strictEqual(p, null);
});
if (t10.ok) passed++; else failed++;

// --- extractPersonNameFromMessage direct tests ---
const t11 = runTest("extractPersonNameFromMessage: Tony's drop rate", () => {
  const p = extractPersonNameFromMessage("What was Tony's drop rate in 2025?");
  assert.ok(p && /tony/i.test(p), `expected Tony, got ${p}`);
});
if (t11.ok) passed++; else failed++;

const t12 = runTest("extractPersonNameFromMessage: Tony's (typographic) drop rate", () => {
  const p = extractPersonNameFromMessage("What was Tony\u2019s drop rate in 2025?");
  assert.ok(p && /tony/i.test(p), `expected Tony, got ${p}`);
});
if (t12.ok) passed++; else failed++;

// --- extractDimensionAndValue ---
const t13 = runTest("extractDimensionAndValue: Tony's drop rate → person", () => {
  const d = extractDimensionAndValue("What was Tony's drop rate in 2025?", "en");
  assert.ok(d && d.key === "person", `expected person dimension, got ${JSON.stringify(d)}`);
  assert.ok(/tony/i.test(d.value), `expected Tony, got ${d.value}`);
});
if (t13.ok) passed++; else failed++;

// --- Existing patterns must still work ---
const t14 = runTest("How many cases did Tony have – still works", () => {
  const p = getExplicitPersonFromMessage("How many cases did Tony have in 2025?", "en");
  assert.ok(p && /tony/i.test(p), `expected Tony, got ${p}`);
});
if (t14.ok) passed++; else failed++;

// --- Exclude pronoun possessives ---
const t15 = runTest("it's, that's – no false positive", () => {
  assert.strictEqual(mentionsPersonExplicitly("it's a good rate"), false);
  assert.strictEqual(mentionsPersonExplicitly("that's the drop rate"), false);
});
if (t15.ok) passed++; else failed++;

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
