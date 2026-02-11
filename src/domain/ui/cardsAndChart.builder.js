//cardsAndChart.builder.js
function looksLikeKpiPackRow(r) {
  if (!r || typeof r !== "object") return false;
  return (
    "gross_cases" in r ||
    "confirmed_cases" in r ||
    "confirmed_rate" in r ||
    "dropped_cases" in r ||
    "problem_cases" in r
  );
}

function hasChartableShape(rows = []) {
  if (!Array.isArray(rows) || rows.length < 2) return false;

  const sample = rows[0] || {};
  const keys = Object.keys(sample);

  const hasLabelish =
    keys.some((k) =>
      ["label", "x", "date", "day", "m", "month", "submitter", "office"].includes(
        String(k).toLowerCase()
      )
    ) || keys.some((k) => /date|day|month|submitter|office|label|name/i.test(k));

  const hasNumeric = keys.some((k) => {
  const v = sample[k];
  return typeof v === "number" || (typeof v === "string" && v !== "" && !Number.isNaN(Number(v)));
});

  return Boolean(hasLabelish && hasNumeric);
}

function shouldShowChartPayload({ topQuickAction, rows }) {
  if (topQuickAction) return true;
  return hasChartableShape(rows);
}

function buildInsightCards(uiLang, { windowLabel, kpiPack }) {
  const es = uiLang === "es";

  const num = (v) => {
    const n = Number(v || 0);
    if (Number.isNaN(n)) return 0;
    return n;
  };

  const gross = num(kpiPack?.gross_cases);
  const dropped = num(kpiPack?.dropped_cases);
  const droppedRate = num(kpiPack?.dropped_rate);
  const confirmed = num(kpiPack?.confirmed_cases);
  const confirmedRate = num(kpiPack?.confirmed_rate);
  const cv = num(kpiPack?.case_converted_value);

  const cards = [];

  cards.push({
    type: "kpi",
    icon: "📊",
    title: windowLabel || (es ? "Resumen" : "Summary"),
    lines: [
      es ? `Casos (gross): ${gross}` : `Gross cases: ${gross}`,
      es
        ? `Dropped: ${dropped} (${droppedRate.toFixed(2)}%)`
        : `Dropped: ${dropped} (${droppedRate.toFixed(2)}%)`,
      es
        ? `Confirmados: ${confirmed} (${confirmedRate.toFixed(2)}%)`
        : `Confirmed: ${confirmed} (${confirmedRate.toFixed(2)}%)`,
      es ? `Conversion value: ${cv}` : `Conversion value: ${cv}`,
    ],
  });

  if (gross > 0) {
    const insightText =
      droppedRate <= 2
        ? (es
            ? `La tasa de dropped es baja (${droppedRate.toFixed(2)}%).`
            : `Dropped rate is low (${droppedRate.toFixed(2)}%).`)
        : (es
            ? `La tasa de dropped es notable (${droppedRate.toFixed(2)}%).`
            : `Dropped rate is notable (${droppedRate.toFixed(2)}%).`);

    cards.push({
      type: "insight",
      icon: "💡",
      title: es ? "Insight" : "Insight",
      text: insightText,
    });
  }

  const risk = droppedRate >= 5;
  if (risk) {
    cards.push({
      type: "risk",
      icon: "🔴",
      title: es ? "Riesgo" : "Risk",
      text: es
        ? "La tasa de dropped está alta; podría indicar un problema operativo o de calidad en intake."
        : "Dropped rate is high; it may signal an operational/quality issue in intake.",
    });
  }

  cards.push({
    type: "action",
    icon: "✅",
    title: es ? "Acción sugerida" : "Recommended action",
    text: es
      ? "Revisa los dropped recientes y clasifícalos por causa (falta de contacto, documentos, seguro, ubicación, etc.)."
      : "Audit recent dropped cases and classify root causes (contact, docs, insurance, location, etc.).",
  });

  cards.push({
    type: "next",
    icon: "➡️",
    title: es ? "Siguiente paso" : "Next step",
    text: es
      ? "¿Quieres que lo desglosemos por región, team u oficina?"
      : "Should we break this down by region, team, or office?",
  });

  return cards;
}

function buildPerformanceCards(uiLang, { windowLabel, name, kpi }) {
  const es = uiLang === "es";
  const num = (v) => {
    const n = Number(v || 0);
    return Number.isNaN(n) ? 0 : n;
  };

  const ttd = num(kpi?.ttd);
  const confirmed = num(kpi?.confirmed);
  const confirmationRate = num(kpi?.confirmationRate);
  const dropped = num(kpi?.dropped_cases);
  const droppedRate = num(kpi?.dropped_rate);
  const cv = num(kpi?.convertedValue);

  const who = String(name || "").trim() || (es ? "Este submitter" : "This submitter");

  const cards = [];

  cards.push({
    type: "kpi",
    icon: "📊",
    title: windowLabel || (es ? "Resumen" : "Summary"),
    lines: [
      es ? `${who}: ${ttd} casos (TTD)` : `${who}: ${ttd} cases (TTD)`,
      es
        ? `Confirmados: ${confirmed} (${confirmationRate.toFixed(2)}%)`
        : `Confirmed: ${confirmed} (${confirmationRate.toFixed(2)}%)`,
      es
        ? `Dropped: ${dropped} (${droppedRate.toFixed(2)}%)`
        : `Dropped: ${dropped} (${droppedRate.toFixed(2)}%)`,
      es ? `Conversion value: ${cv}` : `Conversion value: ${cv}`,
    ],
  });

  let insightText = "";
  if (ttd === 0) {
    insightText = es
      ? "No hay casos registrados en este período para este submitter."
      : "No cases recorded in this window for this submitter.";
  } else if (droppedRate <= 2) {
    insightText = es
      ? `La tasa de dropped es baja (${droppedRate.toFixed(2)}%).`
      : `Dropped rate is low (${droppedRate.toFixed(2)}%).`;
  } else if (droppedRate >= 5) {
    insightText = es
      ? `La tasa de dropped está alta (${droppedRate.toFixed(2)}%).`
      : `Dropped rate is high (${droppedRate.toFixed(2)}%).`;
  } else {
    insightText = es
      ? `La tasa de dropped es moderada (${droppedRate.toFixed(2)}%).`
      : `Dropped rate is moderate (${droppedRate.toFixed(2)}%).`;
  }

  cards.push({ type: "insight", icon: "💡", title: "Insight", text: insightText });

  cards.push({
    type: "action",
    icon: "✅",
    title: es ? "Acción sugerida" : "Recommended action",
    text:
      dropped > 0
        ? (es
            ? "Revisa los dropped recientes y clasifícalos por causa (contacto, docs, seguro, etc.)."
            : "Audit recent dropped cases and classify root causes (contact, docs, insurance, etc.).")
        : (es
            ? "Mantén monitoreo; si sube dropped, revisa la causa de inmediato."
            : "Keep monitoring; if dropped rises, investigate root cause quickly."),
  });

  cards.push({
    type: "next",
    icon: "➡️",
    title: es ? "Siguiente paso" : "Next step",
    text: es
      ? "¿Quieres verlo por día, o compararlo vs otros reps este mes?"
      : "Want it by day, or compare vs other reps this month?",
  });

  return cards;
}

module.exports = {
  looksLikeKpiPackRow,
  hasChartableShape,
  shouldShowChartPayload,
  buildInsightCards,
  buildPerformanceCards,
};
