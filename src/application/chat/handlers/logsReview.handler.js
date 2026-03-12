/**
 * logsReview.handler.js
 * Flujo especial para preguntas analíticas de evaluación/compensation fit basadas en logs.
 * Ej: "Based off Tony's logs for 2025 - would you consider he be a fit employee to make 80k a month?"
 *
 * Devuelve respuesta compuesta con:
 * - resolvedEntity
 * - kpiSummary
 * - logsPreview (mín 5 registros)
 * - logsPdfLink
 * - analysisText
 */
const sqlRepo = require("../../../repos/sql.repo");
const { getContext, setContext, setPending } = require("../../../domain/context/conversationState");
const { wantsLogsPerformanceReview, extractEntityFromLogsPhrase, isRejectedLogsIntroToken } = require("../../../services/logsRoster/logsRoster.service");
const { buildKpiPackSql, buildPeerComparisonSql, extractTimeWindow, defaultThisMonthWindow } = require("../../../services/kpis/kpiPack.service");
const { findUserByResolvedName } = require("../../../services/pdf/pdfLinks.service");
const { applyLockedFiltersParam } = require("../pipeline/filterInjection");
const { listDimensions, getDimension } = require("../../../domain/dimensions/dimensionRegistry");
const { getAssistantProfile } = require("../../../services/assistantProfile");
const openai = require("../../../infra/openai.client");
const { same } = require("../../../utils/chatRoute.helpers");
const { buildSuggestions } = require("../../../domain/ui/suggestions.builder");
const { noDataFoundResponse } = require("../../../utils/errors");
const { buildActiveFiltersText } = require("../../../domain/ui/activeFilters");
const { findFocusCandidates } = require("../../../repos/focus.repo");
const { FOCUS } = require("../../../domain/focus/focusRegistry");

const LOGS_PREVIEW_COLUMNS = `
  idLead,
  dateCameIn,
  TRIM(COALESCE(NULLIF(submitterName,''), submitter)) AS submitter,
  name, 
  Status,
  ClinicalStatus,
  LegalStatus,
  Confirmed,
  COALESCE(convertedValue,0) AS convertedValue,
  dateDropped,
  attorney,
  TeamName,
  RegionName
`.replace(/\s+/g, " ").trim();

function buildLogsPreviewBaseSql(message, lang) {
  let w = extractTimeWindow(message, lang, 365);
  if (!w?.matched) w = defaultThisMonthWindow(lang);
  const timeClause = (w?.where || "").trim().toUpperCase().startsWith("WHERE ")
    ? (w.where || "").trim().slice(6).trim()
    : (w?.where || "").trim();
  const wherePart = timeClause ? `WHERE ${timeClause}` : "WHERE 1=1";
  return `
    SELECT ${LOGS_PREVIEW_COLUMNS}
    FROM performance_data.dmLogReportDashboard
    ${wherePart}
    ORDER BY dateCameIn DESC, idLead DESC
    LIMIT 5
  `.trim();
}

function buildCompensationFitPrompt({ lang, question, entityName, kpiSummary, logsPreview, peerComparison, targetCompensation, windowLabel, performanceDiagnosis }) {
  const isEs = lang === "es";
  const kpiJson = JSON.stringify(kpiSummary || {}, null, 2);
  const previewJson = JSON.stringify(logsPreview || [], null, 2).slice(0, 3000);
  const peerJson = peerComparison ? JSON.stringify(peerComparison, null, 2) : "";

  const peerSection = peerComparison
    ? (isEs
        ? `\nCOMPARACIÓN CON PEERS (mismo período, mismo scope):\n${peerJson}\n\nUsa estos datos para enriquecer la respuesta. Indica ranking, posición vs promedio, y si la muestra es limitada dilo.`
        : `\nPEER COMPARISON (same period, same scope):\n${peerJson}\n\nUse this data to enrich your answer. Mention ranking, position vs average, and if sample is limited say so.`)
    : "";

  const diagnosisSection = performanceDiagnosis?.diagnosis
    ? (isEs
        ? `\nDIAGNÓSTICO DE DESEMPEÑO (precalculado, debes incluirlo en tu respuesta):\n${performanceDiagnosis.diagnosis}\n- Fortaleza: ${performanceDiagnosis.strength}\n- Debilidad: ${performanceDiagnosis.weakness}\n- Riesgo: ${performanceDiagnosis.risk}\n- Siguiente paso: ${performanceDiagnosis.nextStep}\n\nDEBES incluir en tu primer bloque: "Diagnóstico de desempeño: ${performanceDiagnosis.diagnosis}" y luego explicar brevemente fortaleza, debilidad, riesgo y siguiente paso recomendado.`
        : `\nPERFORMANCE DIAGNOSIS (pre-computed, you must include it in your answer):\n${performanceDiagnosis.diagnosis}\n- Strength: ${performanceDiagnosis.strength}\n- Weakness: ${performanceDiagnosis.weakness}\n- Risk: ${performanceDiagnosis.risk}\n- Recommended next step: ${performanceDiagnosis.nextStep}\n\nYou MUST include in your response: "Performance diagnosis: ${performanceDiagnosis.diagnosis}" and then briefly explain strength, weakness, risk, and recommended next step.`)
    : "";

  return isEs
    ? `Eres un asesor ejecutivo de operaciones. El usuario pregunta sobre si el desempeño de ${entityName} justifica una compensación objetivo.

PREGUNTA: "${question}"

PERIODO: ${windowLabel || "N/A"}

RESUMEN DE KPIs (agregados del período):
${kpiJson}

MUESTRA DE CASOS/LOGS (últimos 5 registros):
${previewJson}
${peerSection}
${targetCompensation ? `\nCOMPENSACIÓN OBJETIVO MENCIONADA: ${targetCompensation}` : ""}
${diagnosisSection}

INSTRUCCIONES (OBLIGATORIO seguir esta estructura ejecutiva):
1. Conclusión: Responde directamente con "Sí", "No" o "Todavía no" según el desempeño del período.
2. Por qué: Razones principales. Si hay peerComparison, incluye ranking vs peers (ej: "ranks #5 of 24 by volume").
3. Evidencia: Métricas (gross_cases, confirmed_rate, dropped_rate, case_converted_value).
4. Siguiente paso: Recomendación concreta (ej: revisar dropped cases, comparar tendencia mensual).

Formato: 4-6 bullets que empiecen con "- ". La primera línea DEBE ser la respuesta directa a la pregunta del usuario.
Basado SOLO en los datos. No inventes métricas. No uses símbolos de moneda.`
    : `You are an executive operations advisor. The user is asking whether ${entityName}'s performance justifies a target compensation.

QUESTION: "${question}"

PERIOD: ${windowLabel || "N/A"}

KPI SUMMARY (aggregated for the period):
${kpiJson}

SAMPLE OF CASES/LOGS (last 5 records):
${previewJson}
${peerSection}
${targetCompensation ? `\nTARGET COMPENSATION MENTIONED: ${targetCompensation}` : ""}
${diagnosisSection}

INSTRUCTIONS (REQUIRED executive structure):
1. Conclusion: Answer directly with "Yes," "No," or "Not yet" based on period performance.
2. Why: Main reasons. If peerComparison exists, include ranking vs peers (e.g. "ranks #5 of 24 by volume").
3. Evidence: Supporting metrics (gross_cases, confirmed_rate, dropped_rate, case_converted_value).
4. Next step: Concrete recommendation (e.g. review dropped cases, compare monthly trend).

Format: 4-6 bullets starting with "- ". The FIRST bullet MUST be the direct answer to the user's question.
Example tone: "Based on Tony's 2025 logs, I would not currently consider his performance strong enough to justify an 80k/month compensation level. While volume is solid, the confirmation rate is moderate and the dropped rate is too high."
Use ONLY the data provided. Do not invent metrics. Do not use currency symbols.`;
}

function extractTargetCompensation(message = "") {
  const m = String(message || "").toLowerCase();
  const match = m.match(/\b(?:make|worth|justify|at)\s+(?:an?\s+)?(\d+)k\s*(?:a|per)\s*month/i)
    || m.match(/\b(\d+)\s*k\s*(?:a|per)\s*month/i)
    || m.match(/(\d+)\s*k\s*\/?\s*month/i);
  if (match && match[1]) {
    const k = parseInt(match[1], 10);
    return `${k}k/month`;
  }
  return null;
}

/**
 * Performance diagnosis from kpiSummary + peerComparison only (no invented metrics).
 * Returns { diagnosis, strength, weakness, risk, nextStep } for EN/ES.
 */
function computePerformanceDiagnosis(kpiSummary, peerComparison, lang) {
  const isEs = lang === "es";
  const num = (v) => {
    const n = Number(v);
    return Number.isNaN(n) ? 0 : n;
  };
  const gross = num(kpiSummary?.gross_cases);
  const confirmedRate = num(kpiSummary?.confirmed_rate);
  const droppedRate = num(kpiSummary?.dropped_rate);
  const convertedValue = num(kpiSummary?.case_converted_value ?? kpiSummary?.total_converted_value ?? 0);

  const avg = peerComparison?.averages || {};
  const ranks = peerComparison?.ranks || {};
  const peerCount = peerComparison?.peerCount || 0;
  const avgGross = num(avg.gross_cases);
  const avgConfirmed = num(avg.confirmed_rate);
  const avgDropped = num(avg.dropped_rate);
  const hasPeers = peerCount >= 2;

  const rankVolume = ranks.gross_cases != null ? ranks.gross_cases : null;
  const rankConfirmed = ranks.confirmed_rate != null ? ranks.confirmed_rate : null;
  const rankDropped = ranks.dropped_rate != null ? ranks.dropped_rate : null;
  const topTier = (r) => r != null && peerCount > 0 && r <= Math.max(1, Math.ceil(peerCount * 0.25));
  const bottomTier = (r) => r != null && peerCount > 0 && r >= Math.max(1, Math.floor(peerCount * 0.75));
  const aboveAvg = (val, avgVal) => avgVal > 0 && val >= avgVal * 1.05;
  const belowAvg = (val, avgVal) => avgVal > 0 && val <= avgVal * 0.95;

  let diagnosis = "";
  let strength = "";
  let weakness = "";
  let risk = "";
  let nextStep = "";

  if (hasPeers) {
    const volumeTop = topTier(rankVolume) || aboveAvg(gross, avgGross);
    const volumeLow = bottomTier(rankVolume) || belowAvg(gross, avgGross);
    const confirmedHigh = topTier(rankConfirmed) || aboveAvg(confirmedRate, avgConfirmed);
    const confirmedLow = bottomTier(rankConfirmed) || belowAvg(confirmedRate, avgConfirmed);
    const droppedHigh = bottomTier(rankDropped) || aboveAvg(droppedRate, avgDropped);
    const droppedLow = topTier(rankDropped) || belowAvg(droppedRate, avgDropped);

    if (volumeTop && confirmedLow && droppedHigh) {
      diagnosis = isEs ? "Alto volumen / baja eficiencia de conversión" : "High volume / low conversion efficiency";
      strength = isEs ? "Volumen de casos alto vs pares." : "High case volume vs peers.";
      weakness = isEs ? "Tasa de confirmación por debajo del promedio; dropped alto." : "Confirmation rate below average; high dropped rate.";
      risk = isEs ? "Riesgo de desperdicio de volumen si no se mejora conversión." : "Risk of wasting volume if conversion does not improve.";
      nextStep = isEs ? "Revisar causas de dropped y procesos de confirmación." : "Review dropped causes and confirmation process.";
    } else if (volumeLow && confirmedHigh && droppedLow) {
      diagnosis = isEs ? "Bajo volumen / alta eficiencia" : "Low volume / high efficiency";
      strength = isEs ? "Buena tasa de confirmación y bajo dropped vs pares." : "Good confirmation rate and low dropped vs peers.";
      weakness = isEs ? "Volumen por debajo del promedio." : "Volume below average.";
      risk = isEs ? "Poco riesgo de calidad; límite es escala." : "Low quality risk; limit is scale.";
      nextStep = isEs ? "Priorizar crecimiento de volumen manteniendo calidad." : "Prioritize volume growth while maintaining quality.";
    } else if (droppedHigh && (convertedValue > 0 || aboveAvg(convertedValue, num(avg.total_converted_value)))) {
      diagnosis = isEs ? "Ingresos fuertes pero inestables" : "Revenue strong but unstable";
      strength = isEs ? "Valor convertido sólido." : "Solid converted value.";
      weakness = isEs ? "Dropped alto afecta consistencia." : "High dropped affects consistency.";
      risk = isEs ? "Riesgo de caída de conversión si no se controla dropped." : "Risk of conversion decline if dropped is not controlled.";
      nextStep = isEs ? "Reducir dropped sin sacrificar volumen." : "Reduce dropped without sacrificing volume.";
    } else if (droppedHigh) {
      diagnosis = isEs ? "Alto riesgo de dropped" : "High drop risk";
      strength = isEs ? (volumeTop ? "Volumen alto." : "Algunas métricas positivas.") : (volumeTop ? "High volume." : "Some positive metrics.");
      weakness = isEs ? "Tasa de dropped muy por encima del promedio." : "Dropped rate well above average.";
      risk = isEs ? "Impacto en conversión y reputación." : "Impact on conversion and reputation.";
      nextStep = isEs ? "Auditar causas de dropped y plan de acción." : "Audit dropped causes and action plan.";
    } else if (confirmedHigh && droppedLow && (volumeTop || !volumeLow)) {
      diagnosis = isEs ? "Desempeño equilibrado fuerte" : "Strong balanced performer";
      strength = isEs ? "Confirmación alta y dropped bajo vs pares." : "High confirmation and low dropped vs peers.";
      weakness = isEs ? (volumeLow ? "Volumen a mejorar." : "Sin debilidad crítica.") : (volumeLow ? "Volume to improve." : "No critical weakness.");
      risk = isEs ? "Riesgo bajo si se mantiene tendencia." : "Low risk if trend is maintained.";
      nextStep = isEs ? "Mantener estándares y escalar si aplica." : "Maintain standards and scale if applicable.";
    } else if (volumeLow && confirmedLow && (droppedHigh || belowAvg(confirmedRate, avgConfirmed))) {
      diagnosis = isEs ? "Por debajo del promedio en KPIs clave" : "Below average across key KPIs";
      strength = isEs ? "Base para mejorar con acciones concretas." : "Base to improve with concrete actions.";
      weakness = isEs ? "Volumen, confirmación y/o dropped por debajo del promedio." : "Volume, confirmation and/or dropped below average.";
      risk = isEs ? "Riesgo de quedar rezagado vs pares." : "Risk of falling behind peers.";
      nextStep = isEs ? "Plan de mejora por métrica con seguimiento." : "Improvement plan per metric with follow-up.";
    } else {
      diagnosis = isEs ? "Desempeño mixto" : "Mixed performance";
      strength = isEs ? "Algunos indicadores positivos vs pares." : "Some positive indicators vs peers.";
      weakness = isEs ? "Sin patrón claro de fortaleza o debilidad." : "No clear pattern of strength or weakness.";
      risk = isEs ? "Riesgo moderado según evolución." : "Moderate risk depending on evolution.";
      nextStep = isEs ? "Monitorear tendencias y comparar con pares." : "Monitor trends and compare with peers.";
    }
  } else {
    if (droppedRate >= 25 && confirmedRate < 70) {
      diagnosis = isEs ? "Alto volumen / baja eficiencia de conversión" : "High volume / low conversion efficiency";
      strength = isEs ? "Volumen de casos presente." : "Case volume present.";
      weakness = isEs ? "Dropped alto y confirmación baja." : "High dropped and low confirmation.";
      risk = isEs ? "Riesgo de ineficiencia operativa." : "Operational inefficiency risk.";
      nextStep = isEs ? "Revisar causas de dropped y confirmación." : "Review dropped and confirmation causes.";
    } else if (droppedRate >= 20) {
      diagnosis = isEs ? "Alto riesgo de dropped" : "High drop risk";
      strength = isEs ? "Datos disponibles para analizar." : "Data available to analyze.";
      weakness = isEs ? "Tasa de dropped alta." : "High dropped rate.";
      risk = isEs ? "Impacto en conversión." : "Impact on conversion.";
      nextStep = isEs ? "Auditar dropped y definir acciones." : "Audit dropped and define actions.";
    } else if (confirmedRate >= 75 && droppedRate <= 10) {
      diagnosis = isEs ? "Desempeño equilibrado fuerte" : "Strong balanced performer";
      strength = isEs ? "Buena confirmación y bajo dropped." : "Good confirmation and low dropped.";
      weakness = isEs ? "Sin debilidad crítica." : "No critical weakness.";
      risk = isEs ? "Riesgo bajo." : "Low risk.";
      nextStep = isEs ? "Mantener y escalar." : "Maintain and scale.";
    } else {
      diagnosis = isEs ? "Desempeño mixto" : "Mixed performance";
      strength = isEs ? "Métricas disponibles para seguimiento." : "Metrics available for follow-up.";
      weakness = isEs ? "Combinación de indicadores." : "Combination of indicators.";
      risk = isEs ? "Riesgo moderado." : "Moderate risk.";
      nextStep = isEs ? "Monitorear y comparar con pares cuando haya datos." : "Monitor and compare with peers when data is available.";
    }
  }

  return { diagnosis, strength, weakness, risk, nextStep };
}

/**
 * AI Performance Score (0-100) basado en KPIs reales + comparación vs peers.
 * Ponderación:
 * - 30% volumen (gross_cases)
 * - 30% confirmed rate
 * - 25% dropped rate (mejor si es más bajo)
 * - 15% converted value
 *
 * Usa los ranks de peerComparison cuando existan para normalizar vs peers.
 */
function computePerformanceScore(kpiSummary, peerComparison) {
  const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);

  const peerCount = peerComparison?.peerCount || 0;
  const ranks = peerComparison?.ranks || {};

  const scoreFromRank = (rank, higherIsBetter = true) => {
    if (!rank || !peerCount || peerCount < 2) return null;
    const r = Number(rank);
    if (!Number.isFinite(r) || r <= 0) return null;
    const denom = peerCount - 1 || 1;
    let percentile;
    if (higherIsBetter) {
      // rank=1 -> 1.0, rank=last -> 0.0
      percentile = 1 - (r - 1) / denom;
    } else {
      // para dropped_rate: rank=1 (más bajo) -> 1.0
      percentile = 1 - (r - 1) / denom;
    }
    const base = clamp(percentile, 0, 1);
    return Math.round(20 + base * 80); // mínimo 20 para evitar 0 absoluto
  };

  let volumeScore = scoreFromRank(ranks.gross_cases, true);
  let conversionScore = scoreFromRank(ranks.confirmed_rate, true);
  let dropControlScore = scoreFromRank(ranks.dropped_rate, false);
  let valueScore = scoreFromRank(ranks.total_converted_value, true);

  // Fallback simple si no hay peers o ranks (usa solo KPIs absolutos de kpiSummary)
  const num = (v) => {
    const n = Number(v);
    return Number.isNaN(n) ? 0 : n;
  };

  if (peerCount < 2 || (!volumeScore && !conversionScore && !dropControlScore && !valueScore)) {
    const gross = num(kpiSummary?.gross_cases);
    const confirmedRate = num(kpiSummary?.confirmed_rate);
    const droppedRate = num(kpiSummary?.dropped_rate);
    const convertedValue = num(
      kpiSummary?.case_converted_value ?? kpiSummary?.total_converted_value ?? 0
    );

    const scaleLinear = (value, low, high) => {
      if (value <= low) return 20;
      if (value >= high) return 95;
      const ratio = (value - low) / (high - low);
      return Math.round(20 + ratio * 75);
    };

    if (!volumeScore) volumeScore = scaleLinear(gross, 5, 80);
    if (!conversionScore) conversionScore = scaleLinear(confirmedRate, 40, 85);
    if (!dropControlScore) {
      // menor droppedRate => mejor score
      if (droppedRate <= 5) dropControlScore = 95;
      else if (droppedRate >= 40) dropControlScore = 25;
      else dropControlScore = Math.round(95 - ((droppedRate - 5) / 35) * 70);
    }
    if (!valueScore) valueScore = scaleLinear(convertedValue, 10000, 150000);
  }

  // Asegura que cada componente tenga un valor razonable
  volumeScore = clamp(volumeScore || 50, 0, 100);
  conversionScore = clamp(conversionScore || 50, 0, 100);
  dropControlScore = clamp(dropControlScore || 50, 0, 100);
  valueScore = clamp(valueScore || 50, 0, 100);

  const total =
    0.3 * volumeScore +
    0.3 * conversionScore +
    0.25 * dropControlScore +
    0.15 * valueScore;

  return {
    total: Math.round(clamp(total, 0, 100)),
    components: {
      volumeScore,
      conversionScore,
      dropControlScore,
      valueScore,
    },
    weights: {
      volume: 0.3,
      confirmedRate: 0.3,
      droppedRate: 0.25,
      convertedValue: 0.15,
    },
    peerCount,
  };
}

const PEER_METRICS_HIGHER_BETTER = ["gross_cases", "confirmed_cases", "confirmed_rate", "total_converted_value"];
const PEER_METRICS_LOWER_BETTER = ["dropped_rate"];

function findEntityRow(rows, entityValue) {
  if (!Array.isArray(rows) || !entityValue) return null;
  const ev = String(entityValue).trim();
  // Exact match first
  let row = rows.find((r) => same(r.submitter_key, ev));
  if (row) return row;
  // First token match (e.g. "Tony" in "Tony Press Accidente Inc")
  const firstToken = ev.split(/\s+/)[0];
  if (firstToken && firstToken.length >= 2) {
    row = rows.find((r) =>
      String(r.submitter_key || "").toLowerCase().includes(firstToken.toLowerCase())
    );
    if (row) return row;
  }
  return null;
}

function computePeerComparison(rows, entityValue, scopeType = "submitter") {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const entityRow = findEntityRow(rows, entityValue);
  if (!entityRow) return { scopeType, entity: entityValue, peerCount: rows.length, limited: true, reason: "entity_not_found_in_peers" };

  const peerCount = rows.length;
  const entityMetrics = {
    gross_cases: Number(entityRow.gross_cases) || 0,
    confirmed_cases: Number(entityRow.confirmed_cases) || 0,
    confirmed_rate: Number(entityRow.confirmed_rate) || 0,
    total_converted_value: Number(entityRow.total_converted_value) || 0,
    dropped_rate: Number(entityRow.dropped_rate) || 0,
  };

  const ranks = {};
  for (const m of PEER_METRICS_HIGHER_BETTER) {
    const sorted = [...rows].sort((a, b) => (Number(b[m]) || 0) - (Number(a[m]) || 0));
    const idx = sorted.findIndex((r) => same(r.submitter_key, entityRow.submitter_key));
    ranks[m] = idx >= 0 ? idx + 1 : null;
  }
  for (const m of PEER_METRICS_LOWER_BETTER) {
    const sorted = [...rows].sort((a, b) => (Number(a[m]) || 999) - (Number(b[m]) || 999));
    const idx = sorted.findIndex((r) => same(r.submitter_key, entityRow.submitter_key));
    ranks[m] = idx >= 0 ? idx + 1 : null;
  }

  const sums = { gross_cases: 0, confirmed_cases: 0, confirmed_rate: 0, total_converted_value: 0, dropped_rate: 0 };
  const count = rows.length;
  for (const r of rows) {
    sums.gross_cases += Number(r.gross_cases) || 0;
    sums.confirmed_cases += Number(r.confirmed_cases) || 0;
    sums.confirmed_rate += Number(r.confirmed_rate) || 0;
    sums.total_converted_value += Number(r.total_converted_value) || 0;
    sums.dropped_rate += Number(r.dropped_rate) || 0;
  }
  const averages = {
    gross_cases: count ? Math.round(sums.gross_cases / count) : 0,
    confirmed_cases: count ? Math.round(sums.confirmed_cases / count) : 0,
    confirmed_rate: count ? Math.round((sums.confirmed_rate / count) * 100) / 100 : 0,
    total_converted_value: count ? Math.round((sums.total_converted_value / count) * 100) / 100 : 0,
    dropped_rate: count ? Math.round((sums.dropped_rate / count) * 100) / 100 : 0,
  };

  const limited = peerCount < 3;

  return {
    scopeType,
    entity: entityValue,
    peerCount,
    ranks,
    averages,
    entityMetrics,
    limited,
    reason: limited ? "small_sample_size" : null,
  };
}

async function handleLogsReview({
  reqId,
  logEnabled,
  uiLang,
  cid,
  messageWithDefaultPeriod,
  effectiveMessage,
  filters,
  suggestionsBase,
  userName,
}) {
  const wantsReview = wantsLogsPerformanceReview(effectiveMessage);
  console.log(`[${reqId}] [route] handleLogsReview entered wantsLogsPerformanceReview=${wantsReview}`);
  if (!wantsReview) return null;

  const scopeDims = [
    { key: "person", type: "submitter" },
    { key: "attorney", type: "attorney" },
    { key: "office", type: "office" },
    { key: "team", type: "team" },
    { key: "pod", type: "pod" },
    { key: "region", type: "region" },
    { key: "director", type: "director" },
    { key: "intake", type: "intake" },
  ];
  let entityValue = null;
  let focusType = "submitter";
  for (const d of scopeDims) {
    if (filters?.[d.key]?.locked && filters[d.key].value) {
      entityValue = String(filters[d.key].value).trim();
      focusType = d.type;
      break;
    }
  }
  // Fallback: si no hay en filters pero hay focus activo (ej: Submitter resuelto en UI)
  if (!entityValue && cid) {
    const ctx = getContext(cid) || {};
    if (ctx.scopeMode === "focus" && ctx.focus?.type && ctx.focus?.value) {
      const ft = String(ctx.focus.type).trim();
      const fv = String(ctx.focus.value).trim();
      if (["submitter", "attorney", "office", "team", "pod", "region", "director", "intake"].includes(ft)) {
        entityValue = fv;
        focusType = ft;
      }
    }
  }
  const ctx = cid ? (getContext(cid) || {}) : {};
  console.log(`[${reqId}] [entity] resolved type=${focusType} value="${entityValue}"`);
  console.log(`[${reqId}] [entity] scopeMode=${ctx.scopeMode || "null"} focus.type=${ctx.focus?.type || "null"}`);
  console.log(`[${reqId}] [entity] filters.person=${JSON.stringify(filters?.person || null)}`);
  if (!entityValue) {
    const nlCandidateRaw = extractEntityFromLogsPhrase(effectiveMessage);
    if (nlCandidateRaw) {
      console.log(`[${reqId}] [entity_nl] matched logs phrase pattern`);

      let nlCandidate = String(nlCandidateRaw).trim();
      if (nlCandidate) {
        const firstToken = nlCandidate.split(/\s+/)[0] || "";
        if (isRejectedLogsIntroToken(firstToken)) {
          console.log(`[${reqId}] [entity_nl] intro token stripped="${firstToken}"`);
          nlCandidate = nlCandidate.split(/\s+/).slice(1).join(" ").trim();
        }
      }

      if (!nlCandidate) {
        console.log(`[${reqId}] [entity_nl] candidate empty after intro-strip, skipping NL resolution`);
        return null;
      }

      console.log(`[${reqId}] [entity_nl] extracted candidate="${nlCandidate}"`);
      console.log(`[${reqId}] [entity_nl] resolving candidate under scope=submitter`);
      const scopeType = "submitter";
      const cfg = FOCUS[scopeType];
      if (cfg) {
        const rows = await findFocusCandidates({ type: scopeType, query: nlCandidate, limit: 500 });
        if (reqId) console.log(`[${reqId}] [entity_nl] findFocusCandidates query="${nlCandidate}" rows=${rows.length}`);
        if (rows.length === 1) {
          const resolvedValue = (cfg.canonicalFromRow ? cfg.canonicalFromRow(rows[0]) : rows[0].name) || nlCandidate;
          entityValue = String(resolvedValue).trim();
          focusType = scopeType;
          console.log(`[${reqId}] [entity_nl] resolved entity value="${entityValue}"`);
          if (cid) {
            const nextFilters = { person: { value: entityValue, locked: true, exact: true } };
            ["office", "team", "pod", "region", "director", "intake", "attorney"].forEach((k) => { nextFilters[k] = null; });
            setContext(cid, {
              scopeMode: "focus",
              focus: { type: scopeType, value: entityValue, label: entityValue },
              filters: nextFilters,
              lastPerson: entityValue,
            });
          }
        } else if (rows.length >= 2 && cid) {
          const def = getDimension("person");
          const label = uiLang === "es" ? (def?.labelEs || "person") : (def?.labelEn || "Submitter");
          const prompt = uiLang === "es"
            ? `Encontré ${rows.length} coincidencias para ${label} "${nlCandidate}". ¿Cuál es la correcta?`
            : `I found ${rows.length} matches for ${label} "${nlCandidate}". Which one is correct?`;
          const options = rows.map((r, idx) => ({
            id: String(idx + 1),
            label: (cfg.canonicalFromRow ? cfg.canonicalFromRow(r) : r.name) || "",
            value: (cfg.canonicalFromRow ? cfg.canonicalFromRow(r) : r.name) || "",
          }));
          setPending(cid, {
            kind: "pick_dimension_candidate",
            dimKey: "person",
            focusType: "submitter",
            prompt,
            options,
            originalMessage: effectiveMessage,
          });
          return {
            ok: true,
            answer: prompt,
            rowCount: 0,
            aiComment: "logs_review_pick",
            chart: null,
            pick: { type: "pick_dimension_candidate", options },
            suggestions: null,
          };
        }
      }
    }
    if (!entityValue) {
      console.log(`[${reqId}] [route] logsReview returning null reason=no_entityValue (filters+ctx.focus both empty)`);
      return null;
    }
  }

  const resolvedEntity = { type: focusType, value: entityValue };
  const personValueForPdf = focusType === "submitter" ? entityValue : null;

  // Siempre inyectar la entidad resuelta en filters para QUERY A (métricas del target).
  // Nunca usar leaderboard genérico como fuente del KPI principal.
  const FOCUS_TO_DIM = { submitter: "person", attorney: "attorney", office: "office", team: "team", pod: "pod", region: "region", director: "director", intake: "intake" };
  const dimKey = FOCUS_TO_DIM[focusType] || "person";
  const effectiveFilters = { ...(filters || {}) };
  effectiveFilters[dimKey] = { value: entityValue, locked: true, exact: true };

  const { sql: kpiSql, params: kpiParams, windowLabel } = buildKpiPackSql(messageWithDefaultPeriod, {
    lang: uiLang,
    filters: effectiveFilters,
  });

  console.log(`[${reqId}] [QUERY_A] sql=${(kpiSql || "").replace(/\s+/g, " ").slice(0, 400)}...`);
  console.log(`[${reqId}] [QUERY_A] params=${JSON.stringify(kpiParams || [])}`);

  let kpiSummary = {};
  try {
    const kpiRows = await sqlRepo.query(kpiSql, kpiParams);
    kpiSummary = (Array.isArray(kpiRows) && kpiRows[0]) ? kpiRows[0] : {};
    console.log(`[${reqId}] [QUERY_A] result=${JSON.stringify(kpiSummary)}`);
  } catch (e) {
    if (logEnabled) console.error(`[${reqId}] [logsReview] KPI query failed:`, e?.message);
  }

  const previewBase = buildLogsPreviewBaseSql(messageWithDefaultPeriod, uiLang);
  const { sql: previewSql, params: previewParams } = applyLockedFiltersParam({
    baseSql: previewBase,
    filters: effectiveFilters,
    personValueFinal: focusType === "submitter" ? entityValue : null,
    listDimensions,
    focusType,
  });

  let logsPreview = [];
  try {
    const previewRows = await sqlRepo.query(previewSql, previewParams);
    logsPreview = Array.isArray(previewRows) ? previewRows : [];
    if (logEnabled) console.log(`[${reqId}] [logsReview] Preview OK rows=${logsPreview.length}`);
  } catch (e) {
    if (logEnabled) console.error(`[${reqId}] [logsReview] Preview query failed:`, e?.message);
  }

  const grossCases = Number(kpiSummary?.gross_cases ?? 0);
  if (grossCases === 0) {
    const entityDisplayName = focusType === "submitter" ? entityValue : null;
    const hasRestrictiveFilters = ["attorney", "office", "pod", "team", "region", "director", "intake"].some(
      (k) => effectiveFilters?.[k]?.locked && effectiveFilters[k].value
    );
    const activeFiltersText = buildActiveFiltersText(effectiveFilters, windowLabel, uiLang);
    const { answer, suggestions } = noDataFoundResponse(uiLang, {
      personName: entityDisplayName || undefined,
      period: windowLabel || undefined,
      hasRestrictiveFilters: Boolean(hasRestrictiveFilters),
      activeFiltersText: activeFiltersText || undefined,
    });
    return {
      ok: true,
      mode: "logs_performance_review",
      answer,
      rowCount: 0,
      aiComment: "no_data",
      chart: null,
      suggestions,
      resolvedEntity,
      kpiSummary: {},
      logsPreview: [],
      logsPdfLink: null,
      peerComparison: null,
      analysisText: "",
      logsPerformanceReview: null,
      pdfLinks: null,
      pdfItems: [],
    };
  }

  let peerComparison = null;
  if (focusType === "submitter") {
    try {
      const { sql: peerSql, params: peerParams } = buildPeerComparisonSql(messageWithDefaultPeriod, {
        lang: uiLang,
        filters: effectiveFilters,
      });
      console.log(`[${reqId}] [QUERY_B] sql=${(peerSql || "").replace(/\s+/g, " ").slice(0, 400)}...`);
      console.log(`[${reqId}] [QUERY_B] params=${JSON.stringify(peerParams || [])}`);
      const peerRows = await sqlRepo.query(peerSql, peerParams);
      const peerArr = Array.isArray(peerRows) ? peerRows : [];
      peerComparison = computePeerComparison(peerArr, entityValue, focusType);
      if (peerComparison) {
        const avgConfirmed = peerComparison.averages?.confirmed_rate ?? null;
        const avgDropped = peerComparison.averages?.dropped_rate ?? null;
        const entityRank = peerComparison.ranks?.gross_cases ?? null;
        console.log(`[${reqId}] [QUERY_B] result peer_count=${peerComparison.peerCount} entityRank=${entityRank} avg_confirmed_rate=${avgConfirmed} avg_dropped_rate=${avgDropped}`);
      }
    } catch (e) {
      if (logEnabled) console.error(`[${reqId}] [logsReview] Peer comparison failed:`, e?.message);
    }
  }

  let logsPdfLink = null;
  if (personValueForPdf) {
    try {
      const userCandidates = await findUserByResolvedName(sqlRepo, personValueForPdf, 1);
      if (userCandidates.length && userCandidates[0]?.logsIndividualFile) {
        logsPdfLink = String(userCandidates[0].logsIndividualFile).trim();
        if (logEnabled) console.log(`[${reqId}] [logsReview] PDF found: logsPdfLink=${logsPdfLink ? "yes" : "no"}`);
      }
    } catch (e) {
      if (logEnabled) console.error(`[${reqId}] [logsReview] PDF lookup failed:`, e?.message);
    }
  }

  const targetCompensation = extractTargetCompensation(effectiveMessage);
  const profile = getAssistantProfile(uiLang);

  const performanceDiagnosis = computePerformanceDiagnosis(kpiSummary, peerComparison, uiLang);
  const performanceScore = computePerformanceScore(kpiSummary, peerComparison);

  const prompt = buildCompensationFitPrompt({
    lang: uiLang,
    question: effectiveMessage,
    entityName: entityValue,
    kpiSummary,
    logsPreview,
    peerComparison,
    targetCompensation,
    windowLabel,
    performanceDiagnosis,
  });

  let analysisText = "";
  try {
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      max_output_tokens: 520,
      input: [
        {
          role: "system",
          content: uiLang === "es"
            ? `Tu nombre es ${profile.name}. Eres un asesor ejecutivo. La PRIMERA línea DEBE responder directamente la pregunta (Sí/No/Todavía no). Si hay peerComparison, incluye ranking vs peers. Luego razones y métricas. Bullets con "- ". ${profile.style}`
            : `Your name is ${profile.name}. You are an executive advisor. The FIRST line MUST directly answer the user's question (Yes/No/Not yet). If peerComparison exists, include ranking vs peers. Then reasons and metrics. Bullets with "- ". ${profile.style}`,
        },
        { role: "user", content: prompt },
      ],
    });
    analysisText = response?.output?.[0]?.content?.[0]?.text || "";
  } catch (e) {
    if (logEnabled) console.error(`[${reqId}] [logsReview] LLM failed:`, e?.message);
    analysisText = uiLang === "es"
      ? "No pude generar el análisis. Por favor intenta de nuevo."
      : "I couldn't generate the analysis. Please try again.";
  }

  const pdfItems = logsPdfLink
    ? [{ id: "logs", label: uiLang === "es" ? "Abrir Log completo (PDF)" : "Open Full Log PDF", url: logsPdfLink }]
    : [];
  const pdfLinks = logsPdfLink
    ? { logsPdf: logsPdfLink, rosterPdf: null, items: pdfItems }
    : null;

  // Construye capa de AI Performance Score sobre el análisis ejecutivo, sin reemplazarlo.
  let scoreHeader = "";
  if (performanceScore) {
    const totalScore = performanceScore.total;
    const vol = performanceScore.components.volumeScore;
    const conv = performanceScore.components.conversionScore;
    const drop = performanceScore.components.dropControlScore;
    const val = performanceScore.components.valueScore;
    const diagText = performanceDiagnosis?.diagnosis || (uiLang === "es" ? "Sin diagnóstico disponible" : "No diagnosis available");
    if (uiLang === "es") {
      scoreHeader =
        `AI Performance Score: ${totalScore}/100\n` +
        `Diagnosis: ${diagText}\n` +
        `- Volume score: ${vol}/100\n` +
        `- Conversion score: ${conv}/100\n` +
        `- Drop control score: ${drop}/100\n` +
        `- Value score: ${val}/100\n\n`;
    } else {
      scoreHeader =
        `AI Performance Score: ${totalScore}/100\n` +
        `Diagnosis: ${diagText}\n` +
        `- Volume score: ${vol}/100\n` +
        `- Conversion score: ${conv}/100\n` +
        `- Drop control score: ${drop}/100\n` +
        `- Value score: ${val}/100\n\n`;
    }
  }

  // Answer: capa de score + análisis ejecutivo. Documents y Recent cases se renderizan desde payload en el frontend.
  const answer = (scoreHeader + analysisText).trim();

  const droppedRate = Number(kpiSummary?.dropped_rate ?? 0);
  const highDropRate = droppedRate >= 40;
  const suggestions = buildSuggestions(effectiveMessage, uiLang, { performance: true, highDropRate });

  const mainCardEntityName = entityValue;
  const mainCardData = kpiSummary;
  console.log(`[${reqId}] [main_card] source=QUERY_A`);
  console.log(`[${reqId}] [main_card] entityName="${mainCardEntityName}"`);
  console.log(`[${reqId}] [main_card] data=${JSON.stringify(mainCardData)}`);
  console.log(`[${reqId}] [main_card_check] resolvedEntity="${resolvedEntity.value}"`);
  console.log(`[${reqId}] [main_card_check] mainCard.entityName="${mainCardEntityName}"`);
  if (mainCardEntityName !== resolvedEntity.value && process.env.NODE_ENV !== "production") {
    throw new Error(`[main_card_check] MISMATCH: resolvedEntity="${resolvedEntity.value}" vs mainCard.entityName="${mainCardEntityName}"`);
  }

  return {
    ok: true,
    mode: "logs_performance_review",
    answer,
    rowCount: logsPreview.length,
    aiComment: "logs_performance_review",
    chart: null,
    suggestions,
    resolvedEntity,
    kpiSummary,
    logsPreview,
    logsPdfLink: logsPdfLink || null,
    peerComparison: peerComparison || null,
    analysisText: analysisText.trim(),
    performanceDiagnosis: performanceDiagnosis || null,
    performanceScore: performanceScore || null,
    logsPerformanceReview: {
      resolvedEntity,
      kpiSummary,
      logsPreview,
      logsPdfLink: logsPdfLink || null,
      peerComparison: peerComparison || null,
      analysisText: analysisText.trim(),
      windowLabel: windowLabel || null,
      performanceDiagnosis: performanceDiagnosis || null,
    },
    pdfLinks,
    pdfItems,
  };
}

module.exports = { handleLogsReview };
