/**
 * Tests for messageNormalizer.
 * Run: node test/messageNormalizer.test.js
 * Uses normalizeMessageInternal to test patterns without feature flag.
 */

const assert = require("assert");
const { normalizeMessageInternal, normalizeMessage } = require("../src/utils/messageNormalizer");

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

console.log("messageNormalizer tests\n");

let passed = 0;
let failed = 0;

// Casos que DEBEN normalizarse
(() => {
  const r = runTest("How is Tony doing this year? → Tony performance this year", () => {
  const r = normalizeMessageInternal("How is Tony doing this year?");
  assert.strictEqual(r.normalized, "Tony performance this year");
  assert.strictEqual(r.meta?.matched, true);
});
  if (r.ok) passed++; else failed++;
})();

(() => {
  const r = runTest("How is Maria doing lately? → Maria performance last 30 days", () => {
    const out = normalizeMessageInternal("How is Maria doing lately?");
    assert.strictEqual(out.normalized, "Maria performance last 30 days");
  });
  if (r.ok) passed++; else failed++;
})();

(() => {
  const r = runTest("How is Maria doing? → Maria performance this month", () => {
  const r = normalizeMessageInternal("How is Maria doing?");
  assert.strictEqual(r.normalized, "Maria performance this month");
});
  if (r.ok) passed++; else failed++;
})();

(() => {
  const r = runTest("Do you think Tony is performing well? → Tony performance this month", () => {
  const r = normalizeMessageInternal("Do you think Tony is performing well?");
  assert.strictEqual(r.normalized, "Tony performance this month");
});
  if (r.ok) passed++; else failed++;
})();

(() => {
  const r = runTest("How has Tony been performing this month? → Tony performance this month", () => {
    const out = normalizeMessageInternal("How has Tony been performing this month?");
    assert.strictEqual(out.normalized, "Tony performance this month");
    assert.strictEqual(out.meta?.matched, true);
  });
  if (r.ok) passed++; else failed++;
})();

(() => {
  const r = runTest("Is Tony performing well this month? → Tony performance this month", () => {
    const out = normalizeMessageInternal("Is Tony performing well this month?");
    assert.strictEqual(out.normalized, "Tony performance this month");
  });
  if (r.ok) passed++; else failed++;
})();

(() => {
  const r = runTest("Show me how Maria compares with the others → Maria performance by reps", () => {
  const r = normalizeMessageInternal("Show me how Maria compares with the others");
  assert.strictEqual(r.normalized, "Maria performance by reps");
});
  if (r.ok) passed++; else failed++;
})();

(() => {
  const r = runTest("Give me the most recent cases from Tony → Tony most recent cases", () => {
  const r = normalizeMessageInternal("Give me the most recent cases from Tony");
  assert.strictEqual(r.normalized, "Tony most recent cases");
});
  if (r.ok) passed++; else failed++;
})();

(() => {
  const r = runTest("How bad is Tony's drop rate compared to the team → Tony dropped rate vs team", () => {
  const r = normalizeMessageInternal("How bad is Tony's drop rate compared to the team?");
  assert.strictEqual(r.normalized, "Tony dropped rate vs team");
});
  if (r.ok) passed++; else failed++;
})();

// Casos que NO deben cambiar (no hay patrón)
(() => {
  const r = runTest("How many cases did Tony handle in 2025? → unchanged", () => {
  const input = "How many cases did Tony handle in 2025?";
  const r = normalizeMessageInternal(input);
  assert.strictEqual(r.normalized, input);
  assert.ok(!r.meta?.matched);
});
  if (r.ok) passed++; else failed++;
})();

(() => {
  const r = runTest("Tony's logs → unchanged", () => {
  const input = "Tony's logs";
  const r = normalizeMessageInternal(input);
  assert.strictEqual(r.normalized, input);
});
  if (r.ok) passed++; else failed++;
})();

(() => {
  const r = runTest("Top reps → unchanged", () => {
  const input = "Top reps";
  const r = normalizeMessageInternal(input);
  assert.strictEqual(r.normalized, input);
});
  if (r.ok) passed++; else failed++;
})();

// normalizeMessage con feature flag OFF devuelve original
(() => {
  const r = runTest("normalizeMessage (flag off) returns original", () => {
  const input = "How is Tony doing this year?";
  const r = normalizeMessage(input, "en");
  assert.strictEqual(r.normalized, input);
  assert.ok(!r.meta?.matched);
});
  if (r.ok) passed++; else failed++;
})();

// Edge cases
(() => {
  const r = runTest("empty string → empty", () => {
  const r = normalizeMessageInternal("");
  assert.strictEqual(r.normalized, "");
});
  if (r.ok) passed++; else failed++;
})();

(() => {
  const r = runTest("null/undefined → empty string", () => {
  assert.strictEqual(normalizeMessageInternal(null).normalized, "");
  assert.strictEqual(normalizeMessageInternal(undefined).normalized, "");
});
  if (r.ok) passed++; else failed++;
})();

// ES patterns
(() => {
  const r = runTest("¿Cómo está Tony este año? → Tony performance este año", () => {
  const r = normalizeMessageInternal("¿Cómo está Tony este año?", "es");
  assert.strictEqual(r.normalized, "Tony performance este año");
});
  if (r.ok) passed++; else failed++;
})();

(() => {
  const r = runTest("Muéstrame los casos más recientes de Maria → Maria most recent cases", () => {
  const r = normalizeMessageInternal("Muéstrame los casos más recientes de Maria", "es");
  assert.strictEqual(r.normalized, "Maria most recent cases");
});
  if (r.ok) passed++; else failed++;
})();

console.log(`\n${passed} passed`);
if (failed > 0) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log("All tests passed.\n");
