/**
 * Tests for entity/person query sanitization.
 * Ensures metric/period words are stripped before entity search.
 * Run: node test/entityCandidate.test.js
 */

const assert = require("assert");
const { sanitizeEntityForSearch } = require("../src/utils/entityCandidate");
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

console.log("Entity candidate sanitization tests\n");

let passed = 0;
let failed = 0;

// --- sanitizeEntityForSearch ---
const s1 = runTest("Maria confirm → Maria", () => {
  const out = sanitizeEntityForSearch("Maria confirm");
  assert.strictEqual(out, "Maria");
});
if (s1.ok) passed++; else failed++;

const s2 = runTest("Maria confirm this month → Maria", () => {
  const out = sanitizeEntityForSearch("Maria confirm this month");
  assert.strictEqual(out, "Maria");
});
if (s2.ok) passed++; else failed++;

const s3 = runTest("Tony have in 2025 → Tony", () => {
  const out = sanitizeEntityForSearch("Tony have in 2025");
  assert.strictEqual(out, "Tony");
});
if (s3.ok) passed++; else failed++;

const s4 = runTest("Juan drop rate this year → Juan", () => {
  const out = sanitizeEntityForSearch("Juan drop rate this year");
  assert.strictEqual(out, "Juan");
});
if (s4.ok) passed++; else failed++;

const s5 = runTest("Tony (single name) unchanged", () => {
  const out = sanitizeEntityForSearch("Tony");
  assert.strictEqual(out, "Tony");
});
if (s5.ok) passed++; else failed++;

const s6 = runTest("Maria Chacon (multi-word name) unchanged", () => {
  const out = sanitizeEntityForSearch("Maria Chacon");
  assert.strictEqual(out, "Maria Chacon");
});
if (s6.ok) passed++; else failed++;

const s7 = runTest("Maria Chacon confirm → Maria Chacon", () => {
  const out = sanitizeEntityForSearch("Maria Chacon confirm");
  assert.strictEqual(out, "Maria Chacon");
});
if (s7.ok) passed++; else failed++;

// --- extractDimensionAndValue person extraction ---
const d1 = runTest("How many cases did Maria confirm this month? → person=Maria", () => {
  const d = extractDimensionAndValue("How many cases did Maria confirm this month?", "en");
  assert.ok(d && d.key === "person");
  assert.strictEqual(d.value, "Maria");
});
if (d1.ok) passed++; else failed++;

const d2 = runTest("How many confirmed cases did Tony have in 2025? → person=Tony", () => {
  const d = extractDimensionAndValue("How many confirmed cases did Tony have in 2025?", "en");
  assert.ok(d && d.key === "person");
  assert.strictEqual(d.value, "Tony");
});
if (d2.ok) passed++; else failed++;

const d3 = runTest("What was Juan's drop rate this year? → person=Juan", () => {
  const d = extractDimensionAndValue("What was Juan's drop rate this year?", "en");
  assert.ok(d && d.key === "person");
  assert.strictEqual(d.value, "Juan");
});
if (d3.ok) passed++; else failed++;

const d4 = runTest("Control: What was the drop rate in 2025? → no person", () => {
  const d = extractDimensionAndValue("What was the drop rate in 2025?", "en");
  assert.ok(!d || d.key !== "person");
});
if (d4.ok) passed++; else failed++;

const d5 = runTest("How many cases did Tony have in 2025? → person=Tony", () => {
  const d = extractDimensionAndValue("How many cases did Tony have in 2025?", "en");
  assert.ok(d && d.key === "person");
  assert.strictEqual(d.value, "Tony");
});
if (d5.ok) passed++; else failed++;

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
