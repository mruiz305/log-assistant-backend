/**
 * Words and phrases that must not be included in person/entity search.
 * Strip these from the entity query before findFocusCandidates / findPersonCandidates.
 */
const METRIC_AND_PERIOD_WORDS = new Set([
  "confirm", "confirmed", "cases", "case", "drop", "dropped", "gross", "performance",
  "problem", "conversion", "rate", "convert", "converted", "active", "refer", "referout",
  "have", "has", "had", "handle", "handled", "handles", "did", "do", "does", "got", "get",
  "this", "last", "year", "month", "week", "today", "yesterday",
  "casos", "logs", "confirmados", "confirmadas", "caidos", "caídos", "convertidos",
]);

/**
 * Normalizes the entity search query by stripping KPI/metric verbs, metric nouns,
 * and period phrases. Use before findFocusCandidates / findPersonCandidates.
 * @param {string} raw - Raw entity string (e.g. "Maria confirm this month")
 * @returns {string} Clean entity (e.g. "Maria")
 */
function sanitizeEntityForSearch(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";

  const words = s.split(/\s+/);
  const kept = [];
  for (const w of words) {
    const lower = w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    if (!lower || lower.length < 2) continue;
    if (METRIC_AND_PERIOD_WORDS.has(lower)) break;
    kept.push(w.trim());
  }
  const result = kept.join(" ").trim();
  return result || s;
}

function validateEntityCandidate(raw, { source, intent } = {}) {
  const candidate = String(raw || "").trim();
  const lower = candidate.toLowerCase();

  if (!candidate || candidate.length < 2) {
    logReject(candidate, "empty_or_too_short", source, intent);
    return { ok: false, reason: "empty_or_too_short" };
  }

  // Period phrases
  if (/^\d{4}$/.test(candidate)) {
    logReject(candidate, "period_phrase", source, intent);
    return { ok: false, reason: "period_phrase" };
  }
  if (/^in\s+\d{4}$/i.test(lower)) {
    logReject(candidate, "period_phrase", source, intent);
    return { ok: false, reason: "period_phrase" };
  }
  if (/^this\s+year$/i.test(lower) || /^this\s+month$/i.test(lower)) {
    logReject(candidate, "period_phrase", source, intent);
    return { ok: false, reason: "period_phrase" };
  }
  if (/^last\s+year$/i.test(lower) || /^last\s+month$/i.test(lower)) {
    logReject(candidate, "period_phrase", source, intent);
    return { ok: false, reason: "period_phrase" };
  }
  if (/^q[1-4]\s+\d{4}$/i.test(lower)) {
    logReject(candidate, "period_phrase", source, intent);
    return { ok: false, reason: "period_phrase" };
  }

  // Comparison phrases
  const comparisonPhrases = new Set([
    "average submitter",
    "the average submitter",
    "peer average",
    "peers",
  ]);
  if (comparisonPhrases.has(lower)) {
    logReject(candidate, "comparison_phrase", source, intent);
    return { ok: false, reason: "comparison_phrase" };
  }

  // Intro / preposition tokens
  const introTokens = ["in", "from", "based", "using", "according"];
  const firstToken = lower.split(/\s+/)[0];
  if (introTokens.includes(firstToken)) {
    logReject(candidate, "intro_token_only", source, intent);
    return { ok: false, reason: "intro_token_only" };
  }

  // Descriptive adjectives and metric words that must never be treated as names
  const badWords = new Set([
    "high", "low", "hi", "strong", "weak",
    "cases", "logs", "confirmed", "dropped", "problem", "active",
  ]);
  if (badWords.has(lower)) {
    logReject(candidate, "descriptive_word", source, intent);
    return { ok: false, reason: "descriptive_word" };
  }

  // Question-like phrases (full questions must never be treated as entity)
  if (/^(how\s+many|what\s+was|how\s+does|how\s+did)\b/i.test(lower)) {
    logReject(candidate, "question_phrase", source, intent);
    return { ok: false, reason: "question_phrase" };
  }

  return { ok: true, value: candidate };
}

function logReject(candidate, reason, source, intent) {
  console.log(
    `[candidate_validation] rawCandidate="${candidate}" rejected=true reason="${reason}" source="${source ||
      "unknown"}" intent="${intent || "unknown"}"`
  );
}

module.exports = { validateEntityCandidate, sanitizeEntityForSearch };

