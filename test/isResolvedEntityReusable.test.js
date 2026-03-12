/**
 * Tests for isResolvedEntityReusable.
 * Run: node test/isResolvedEntityReusable.test.js
 */

const assert = require("assert");
const { isResolvedEntityReusable } = require("../src/utils/chatRoute.helpers");

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

console.log("isResolvedEntityReusable tests\n");

let passed = 0;
let failed = 0;

// Reuse: short name matches first token of resolved
const r1 = runTest("Tony matches Tony Press Accidente Inc", () => {
  assert.strictEqual(isResolvedEntityReusable("Tony", "Tony Press Accidente Inc"), true);
});
if (r1.ok) passed++; else failed++;

// Reuse: exact match
const r2 = runTest("Tony Press matches Tony Press", () => {
  assert.strictEqual(isResolvedEntityReusable("Tony Press", "Tony Press"), true);
});
if (r2.ok) passed++; else failed++;

// Reuse: locked starts with extracted + space
const r3 = runTest("Maria matches Maria Chacon", () => {
  assert.strictEqual(isResolvedEntityReusable("Maria", "Maria Chacon"), true);
});
if (r3.ok) passed++; else failed++;

// No reuse: different person
const r4 = runTest("Maria does NOT match Tony Press Accidente Inc", () => {
  assert.strictEqual(isResolvedEntityReusable("Maria", "Tony Press Accidente Inc"), false);
});
if (r4.ok) passed++; else failed++;

// No reuse: empty
const r5 = runTest("empty extracted returns false", () => {
  assert.strictEqual(isResolvedEntityReusable("", "Tony Press"), false);
});
if (r5.ok) passed++; else failed++;

// Case insensitive
const r6 = runTest("tony matches Tony Press (case insensitive)", () => {
  assert.strictEqual(isResolvedEntityReusable("tony", "Tony Press Accidente Inc"), true);
});
if (r6.ok) passed++; else failed++;

// Reuse: same full name (step 3 - user repeats Karla Porras, must keep Karla)
const r7 = runTest("Karla Porras matches Karla Porras (same entity, no revert to Tony)", () => {
  assert.strictEqual(isResolvedEntityReusable("Karla Porras", "Karla Porras"), true);
});
if (r7.ok) passed++; else failed++;

// No reuse: Karla vs Tony
const r8 = runTest("Karla Porras does NOT match Tony Press", () => {
  assert.strictEqual(isResolvedEntityReusable("Karla Porras", "Tony Press Accidente Inc"), false);
});
if (r8.ok) passed++; else failed++;

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
