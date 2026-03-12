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

  // Descriptive adjectives that must never be treated as names
  const badWords = new Set([
    "high",
    "low",
    "hi",
    "strong",
    "weak",
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

module.exports = { validateEntityCandidate };

