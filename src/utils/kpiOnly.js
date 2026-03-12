
function isKpiOnlyQuestion(msg = "") {
  const m = String(msg || "").toLowerCase();

  // Entity-vs-average / peer-comparison questions should NOT go through plain KPI-only.
  const hasComparisonSignal =
    /\bcompare(?:d)?\s+to\b/.test(m) ||
    /\bcompare(?:d)?\s+with\b/.test(m) ||
    /\bversus\b/.test(m) ||
    /\bvs\b/.test(m) ||
    /\bpeer(?:s)?\b/.test(m) ||
    /\baverage\s+submitter\b/.test(m) ||
    /\bpeer\s+average\b/.test(m) ||
    /\babove\s+average\b/.test(m) ||
    /\bbelow\s+average\b/.test(m);

  if (hasComparisonSignal) {
    return false;
  }

  const asksKpi =
    /(confirmed|confirmados|tasa|rate|dropped|problem|leakage|active|referout|valor\s+de\s+conversi[oó]n|conversion\s+value|kpi)/i.test(
      m
    );

  const asksListOrBreakdown =
    /(logs|lista|list|detalle|show me|dame|por\s+(oficina|team|equipo|pod|region|director|abogado|intake)|by\s+(office|team|pod|region|director|attorney|intake)|top\s+\d+|ranking)/i.test(
      m
    );

  return asksKpi && !asksListOrBreakdown;
}

function isHowManyCasesQuestion(msg = "", uiLang = "en") {
  const m = String(msg || "").toLowerCase().trim();
  const looksLikeListOrBreakdown =
    /(logs|list|lista|detalle|details|show me|dame|ver|breakdown|by\s+(office|team|pod|region|attorney|intake)|por\s+(oficina|equipo|pod|regi[oó]n|abogado|intake)|top\s+\d+)/i.test(
      m
    );
  if (looksLikeListOrBreakdown) return false;

  const countSignals = [
    /\bhow\s+many\b/,
    /\bcount\b/,
    /\btotal\b/,
    /\bnumber\s+of\b/,
    /\bcu[aá]ntos?\b/,
    /\bn[uú]mero\s+de\b/,
  ];
  const hasCountSignal = countSignals.some((rx) => rx.test(m));
  const hasCasesWord = /\b(cases|case|casos|caso|leads|lead)\b/i.test(m);

  const patterns = [
    /\bhow\s+many\s+(cases|leads)\b/i,
    /\b(cases|leads)\s+has\b/i,
    /\bcu[aá]ntos?\s+(casos|leads)\b/i,
    /\btotal\s+(cases|casos|leads)\b/i,
    /\bnumber\s+of\s+(cases|leads)\b/i,
  ];
  const matchesPattern = patterns.some((rx) => rx.test(m));

  const hasMonthHint =
    /(january|february|march|april|may|june|july|august|september|october|november|december|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)/i.test(
      m
    ) || /\b(20\d{2})\b/.test(m);

  if (hasCountSignal && hasCasesWord) return true;
  if (matchesPattern) return true;
  if (hasMonthHint && (hasCountSignal || hasCasesWord)) return true;

  return false;
}

module.exports = { isKpiOnlyQuestion, isHowManyCasesQuestion };
