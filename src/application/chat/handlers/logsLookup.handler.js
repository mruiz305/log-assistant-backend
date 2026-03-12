/**
 * logsLookup.handler.js
 * Maneja peticiones de LOGS: tabla + registros (mín. 5) + PDF opcional.
 * Usa focus para resolver la entidad.
 */
const sqlRepo = require("../../../repos/sql.repo");
const { FOCUS } = require("../../../domain/focus/focusRegistry");
const { findFocusCandidates } = require("../../../repos/focus.repo");
const { findUserByResolvedName } = require("../../../services/pdf/pdfLinks.service");
const {
  wantsLogsLookup,
  extractEntityPhrase,
} = require("../../../services/logsRoster/logsRoster.service");
const { extractTimeWindow, buildKpiPackSql } = require("../../../services/kpis/kpiPack.service");
const {
  getContext,
  setContext,
  setPending,
} = require("../../../domain/context/conversationState");
const { applyLockedFiltersParam } = require("../pipeline/filterInjection");
const { listDimensions } = require("../../../domain/dimensions/dimensionRegistry");
const { buildMiniChart } = require("../../../utils/miniChart");
const { shouldShowChartPayload } = require("../../../domain/ui/cardsAndChart.builder");
const { FOCUS_TO_DIM_KEY } = require("../../../utils/chatContextLocks");

const LOGS_DETAIL_COLUMNS = `
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
  OfficeName,
  TeamName,
  RegionName
`.replace(/\s+/g, " ").trim();

function buildLogsBaseSql(message, lang) {
  // Detecta ventana explícita (mes+año, año, etc.). Fallback: últimos 365 días.
  const w = extractTimeWindow(message || "", lang || "en", 365);
  const whereClause = String(w.where || "").trim() || "WHERE dateCameIn >= DATE_SUB(CURDATE(), INTERVAL 365 DAY)";
  return `
    SELECT ${LOGS_DETAIL_COLUMNS}
    FROM performance_data.dmLogReportDashboard
    ${whereClause}
    ORDER BY dateCameIn DESC
    LIMIT 20
  `.trim();
}

async function handleLogsLookup({
  reqId,
  logEnabled,
  uiLang,
  cid,
  effectiveMessage,
  forcedPick,
  pendingContext,
  suggestionsBase,
  userName,
}) {
  if (!wantsLogsLookup(effectiveMessage)) return null;

  const ctx = cid ? getContext(cid) || {} : {};
  const focusType = ctx.scopeMode === "focus" && ctx.focus?.type
    ? String(ctx.focus.type).trim()
    : "submitter";
  const focusValue = ctx.focus?.value ? String(ctx.focus.value).trim() : null;

  // Si ya hay entidad resuelta (focus + pick aplicado), usarla; NO extraer del mensaje (puede ser garbage:
  // "logs for 2025 - would you consider..." -> extractEntityPhrase devolvería "2025 - would you consider...").
  let query =
    ctx.scopeMode === "focus" && ctx.focus?.value ? focusValue : (extractEntityPhrase(effectiveMessage) || focusValue);
  if (!query) {
    return {
      ok: true,
      answer: uiLang === "es"
        ? "¿De quién quieres ver los logs? Indica el nombre."
        : "Whose logs do you want to see? Please provide a name.",
      rowCount: 0,
      aiComment: "logs_lookup_no_entity",
      chart: null,
      suggestions: suggestionsBase,
    };
  }

  const cfg = FOCUS[focusType];
  if (!cfg) {
    query = String(query).trim();
  }

  const rows = await findFocusCandidates({
    type: focusType,
    query: String(query).trim(),
    limit: 500,
  });

  if (!rows.length) {
    return {
      ok: true,
      answer: uiLang === "es"
        ? `No encontré coincidencias para "${query}" en ${cfg?.label || focusType}. Intenta con otro nombre o verifica la ortografía.`
        : `I couldn't find any matches for "${query}" in ${cfg?.label || focusType}. Try another name or check the spelling.`,
      rowCount: 0,
      aiComment: "logs_lookup_no_match",
      chart: null,
      suggestions: suggestionsBase,
    };
  }

  if (cid && rows.length >= 2 && !(forcedPick?.value && pendingContext?.kind === "pick_logs_entity")) {
    const options = rows.map((r, idx) => ({
      id: String(idx + 1),
      label: (cfg?.canonicalFromRow ? cfg.canonicalFromRow(r) : r.name || r.attorney || r.office) || "",
      value: (cfg?.canonicalFromRow ? cfg.canonicalFromRow(r) : r.name || r.attorney || r.office) || "",
    }));

    setPending(cid, {
      kind: "pick_logs_entity",
      focusType,
      options,
      originalMessage: effectiveMessage,
    });

    return {
      ok: true,
      answer: uiLang === "es"
        ? `Encontré ${options.length} coincidencias. ¿Cuál es la correcta?`
        : `I found ${options.length} matches. Which one is correct?`,
      rowCount: 0,
      aiComment: "logs_lookup_pick",
      chart: null,
      pick: { type: "pick_logs_entity", options },
      suggestions: null,
    };
  }

  const resolvedRow = rows.length === 1
    ? rows[0]
    : rows[Number(forcedPick?.id || forcedPick?.value || 1) - 1];
  if (!resolvedRow) {
    return {
      ok: true,
      answer: uiLang === "es" ? "No pude resolver el candidato." : "I couldn't resolve the candidate.",
      rowCount: 0,
      aiComment: "logs_lookup_pick_invalid",
      chart: null,
      suggestions: suggestionsBase,
    };
  }

  const resolvedValue = (cfg?.canonicalFromRow ? cfg.canonicalFromRow(resolvedRow) : resolvedRow.name || resolvedRow.attorney || resolvedRow.office) || "";
  const dimKey = FOCUS_TO_DIM_KEY[focusType] || "person";

  const filters = {};
  for (const k of ["person", "office", "pod", "team", "region", "director", "intake", "attorney"]) {
    filters[k] = k === dimKey ? { value: resolvedValue, locked: true, exact: true } : null;
  }

  if (cid) {
    setContext(cid, {
      scopeMode: "focus",
      focus: { type: focusType, value: resolvedValue, label: resolvedValue },
      filters,
      lastPerson: dimKey === "person" ? resolvedValue : ctx.lastPerson,
    });
    if (pendingContext?.kind === "pick_logs_entity") {
      setPending(cid, null);
    }
  }

  const baseSql = buildLogsBaseSql(effectiveMessage, uiLang);
  const { sql: finalSql, params } = applyLockedFiltersParam({
    baseSql,
    filters,
    personValueFinal: dimKey === "person" ? resolvedValue : null,
    listDimensions,
    focusType,
  });

  const logRows = await sqlRepo.query(finalSql, params);
  const rowsArr = Array.isArray(logRows) ? logRows : [];

  const displayName = resolvedValue;
  const hasMore = rowsArr.length >= 20;

  let logsPdf = null;
  const userCandidates = await findUserByResolvedName(sqlRepo, resolvedValue, 1);
  if (userCandidates.length && userCandidates[0]?.logsIndividualFile) {
    logsPdf = String(userCandidates[0].logsIndividualFile).trim();
  }

  const pdfItems = logsPdf
    ? [{ id: "logs", label: uiLang === "es" ? "Log completo (PDF)" : "Full log (PDF)", url: logsPdf }]
    : [];
  const pdfLinks = logsPdf ? { logsPdf, rosterPdf: null, items: pdfItems } : null;

  // === KPI summary for the resolved entity and period ===
  // Detect explicit period; if none, default to "this month"/"este mes" for analytics.
  const w0 = extractTimeWindow(effectiveMessage, uiLang === "es" ? "es" : "en", null);
  const needsDefaultMonth = !w0?.matched;
  const analyticsMessage = needsDefaultMonth
    ? (uiLang === "es" ? `${effectiveMessage} este mes` : `${effectiveMessage} this month`)
    : effectiveMessage;

  const { sql: kpiSql, params: kpiParams, windowLabel } = buildKpiPackSql(analyticsMessage, {
    lang: uiLang,
    filters,
  });

  if (logEnabled) {
    console.log(`[${reqId}] [logs_lookup] KPI sql=${(kpiSql || "").replace(/\s+/g, " ").slice(0, 400)}...`);
    console.log(`[${reqId}] [logs_lookup] KPI params=${JSON.stringify(kpiParams || [])}`);
  }

  let kpiSummary = null;
  try {
    const kpiRows = await sqlRepo.query(kpiSql, kpiParams);
    kpiSummary = Array.isArray(kpiRows) && kpiRows[0] ? kpiRows[0] : null;
  } catch (e) {
    if (logEnabled) console.error(`[${reqId}] [logs_lookup] KPI query failed:`, e?.message);
  }

  const es = uiLang === "es";
  const periodLabel = windowLabel || (es ? "este mes" : "this month");

  const num = (v) => {
    const n = Number(v || 0);
    return Number.isNaN(n) ? 0 : n;
  };

  const gross = num(kpiSummary?.gross_cases);
  const confirmed = num(kpiSummary?.confirmed_cases);
  const confirmedRate = num(kpiSummary?.confirmed_rate);
  const dropped = num(kpiSummary?.dropped_cases);
  const droppedRate = num(kpiSummary?.dropped_rate);
  const cv = num(kpiSummary?.case_converted_value);

  let diagnosis = "";
  let nextStep = "";
  if (gross === 0) {
    diagnosis = es
      ? "No hay casos registrados en este período."
      : "There are no cases recorded in this period.";
    nextStep = es
      ? "Verifica si el período o el submitter son correctos."
      : "Check whether the period or submitter are correct.";
  } else if (confirmedRate >= 70 && droppedRate <= 10) {
    diagnosis = es
      ? "Buen equilibrio entre volumen y calidad (alta confirmación, dropped controlado)."
      : "Good balance of volume and quality (high confirmation, controlled dropped).";
    nextStep = es
      ? "Mantener el estándar y monitorear tendencias mensuales."
      : "Maintain standards and monitor monthly trends.";
  } else if (droppedRate >= 25 && confirmedRate < 60) {
    diagnosis = es
      ? "Perfil de alto riesgo: dropped elevado y confirmación moderada/baja."
      : "High-risk profile: elevated dropped and moderate/low confirmation.";
    nextStep = es
      ? "Revisar causas de dropped y reforzar el proceso de seguimiento y cierre."
      : "Review dropped causes and strengthen follow-up and closing processes.";
  } else {
    diagnosis = es
      ? "Desempeño mixto: algunos indicadores positivos, otros a mejorar."
      : "Mixed performance: some positive indicators, others to improve.";
    nextStep = es
      ? "Profundizar en los casos dropped y confirmar si hay patrones por fuente o tipo de caso."
      : "Drill into dropped cases and check for patterns by source or case type.";
  }

  const answerLines = [];

  // Documents section (PDF link)
  if (logsPdf) {
    answerLines.push(es ? "### Documentos" : "### Documents");
    answerLines.push(es ? "- Abrir Log completo (PDF)" : "- Open Full Log PDF");
    answerLines.push("");
  }

  // Monthly performance summary
  answerLines.push(
    es
      ? `### Desempeño mensual — ${displayName} (${periodLabel})`
      : `### Monthly performance — ${displayName} (${periodLabel})`
  );
  answerLines.push(
    es ? `- Casos (gross): ${gross}` : `- Gross cases: ${gross}`
  );
  answerLines.push(
    es
      ? `- Confirmados: ${confirmed} (${confirmedRate.toFixed(2)}%)`
      : `- Confirmed: ${confirmed} (${confirmedRate.toFixed(2)}%)`
  );
  answerLines.push(
    es
      ? `- Dropped: ${dropped} (${droppedRate.toFixed(2)}%)`
      : `- Dropped: ${dropped} (${droppedRate.toFixed(2)}%)`
  );
  answerLines.push(
    es ? `- Conversion value: ${cv}` : `- Conversion value: ${cv}`
  );
  answerLines.push("");

  // Insight
  answerLines.push(es ? "### Insight" : "### Insight");
  answerLines.push(diagnosis);
  answerLines.push("");

  // Recommended action
  answerLines.push(es ? "### Acción recomendada" : "### Recommended action");
  answerLines.push(nextStep);

  const chartWanted = shouldShowChartPayload({ topQuickAction: false, rows: rowsArr });
  const chart = chartWanted
    ? buildMiniChart(effectiveMessage, uiLang, { kpiPack: null, rows: rowsArr })
    : null;

  return {
    ok: true,
    answer: answerLines.join("\n"),
    rowCount: rowsArr.length,
    aiComment: "logs_lookup",
    chart,
    pdfLinks,
    pdfItems,
    suggestions: suggestionsBase,
  };
}

module.exports = { handleLogsLookup };
