/**
 * Tests for entity clarification detection.
 * "Which Tony did you mean?" etc. must NOT be expanded or routed to analysis.
 * Run: node test/entityClarification.test.js
 */

const assert = require("assert");
const { isEntityClarification } = require("../src/utils/topic");

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

console.log("Entity clarification tests\n");

let passed = 0;
let failed = 0;

const t1 = runTest("Which Tony did you mean? → entity clarification", () => {
  assert.strictEqual(isEntityClarification("Which Tony did you mean?"), true);
});
if (t1.ok) passed++; else failed++;

const t2 = runTest("Which one did you mean? → entity clarification", () => {
  assert.strictEqual(isEntityClarification("Which one did you mean?"), true);
});
if (t2.ok) passed++; else failed++;

const t3 = runTest("Who exactly? → entity clarification", () => {
  assert.strictEqual(isEntityClarification("Who exactly?"), true);
});
if (t3.ok) passed++; else failed++;

const t4 = runTest("Which Maria? → entity clarification", () => {
  assert.strictEqual(isEntityClarification("Which Maria?"), true);
});
if (t4.ok) passed++; else failed++;

const t5 = runTest("Which Juan? → entity clarification", () => {
  assert.strictEqual(isEntityClarification("Which Juan?"), true);
});
if (t5.ok) passed++; else failed++;

const t6 = runTest("Control: How many cases did Tony have? → NOT entity clarification", () => {
  assert.strictEqual(isEntityClarification("How many cases did Tony have in 2025?"), false);
});
if (t6.ok) passed++; else failed++;

const t7 = runTest("Control: Tell me more → NOT entity clarification", () => {
  assert.strictEqual(isEntityClarification("Tell me more"), false);
});
if (t7.ok) passed++; else failed++;

const t8 = runTest("Empty string → NOT entity clarification", () => {
  assert.strictEqual(isEntityClarification(""), false);
});
if (t8.ok) passed++; else failed++;

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
