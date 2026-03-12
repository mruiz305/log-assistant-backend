
const sqlRepo = require("../../../repos/sql.repo");

const { getUserName } = require("../../../domain/context/userProfile");
const { getContext } = require("../../../domain/context/conversationState");

const { logSql } = require("../../../utils/chatRoute.helpers");
const { friendlyError, noDataFoundResponse } = require("../../../utils/errors");
const { buildActiveFiltersText } = require("../../../domain/ui/activeFilters");
const { cloneFilters, mergeFocusIntoFilters } = require("../../../utils/chatContextLocks");

const { buildOwnerAnswer } = require("../../../services/answers/ownerAnswer.service");
const { buildMiniChart } = require("../../../utils/miniChart");

const {
  buildInsightCards,
  looksLikeKpiPackRow,
  shouldShowChartPayload,
} = require("../../../domain/ui/cardsAndChart.builder");

const { buildSuggestions } = require("../../../domain/ui/suggestions.builder");

const {
  isTopQuickAction,
  buildTopQuickActionSql,
  normalizeQuickActionMessage,
} = require("../../../utils/quickActions");

async function handleQuickActions({
  reqId,
  logEnabled,
  debug,
  uiLang,
  cid,
  effectiveMessage,
}) {
  const msg = normalizeQuickActionMessage(effectiveMessage, uiLang);
  const topQuickAction = isTopQuickAction(msg);

  if (!topQuickAction) return null;

  // Usar filtros del contexto (respuesta previa o scope) para que los quicks respeten el filtro
  let filters = {};
  if (cid) {
    const ctx = getContext(cid) || {};
    filters = cloneFilters(ctx);
    filters = mergeFocusIntoFilters(filters, ctx);
  }

  const qa = buildTopQuickActionSql(msg, uiLang, { filters });

  if (!qa) {
    return {
      ok: true,
      answer:
        uiLang === "es"
          ? "No pude reconocer ese acceso rápido."
          : "I couldn’t recognize that quick action.",
      cards: [
        {
          type: "info",
          icon: "ℹ️",
          text: uiLang === "es" ? "Acción rápida desconocida." : "Unknown quick action.",
        },
      ],
      rowCount: 0,
      aiComment: "quick_action_unknown",
      userName: cid ? getUserName(cid) || null : null,
      chart: null,
      suggestions: buildSuggestions("", uiLang),
    };
  }

  if (logEnabled) logSql(reqId, `quick_action ${qa.mode}`, qa.sql, qa.params);

  let rowsQA = [];
  try {
    const r = await sqlRepo.query(qa.sql, qa.params);
    rowsQA = Array.isArray(r) ? r : [];
  } catch (e) {
    console.error(`[${reqId}] quick_action query failed:`, e?.message || e);
    return {
      ok: true,
      answer: friendlyError(uiLang, reqId),
      cards: [{ type: "error", icon: "⚠️", text: friendlyError(uiLang, reqId) }],
      rowCount: 0,
      aiComment: "friendly_error_quick_action",
      userName: cid ? getUserName(cid) || null : null,
      chart: null,
      suggestions: buildSuggestions("", uiLang),
      ...(debug ? { debugDetails: String(e?.message || e) } : {}),
    };
  }

  if (rowsQA.length === 0) {
    const hasRestrictiveFilters = ["attorney", "office", "pod", "team", "region", "director", "intake"].some(
      (k) => filters?.[k]?.locked && filters[k].value
    );
    const activeFiltersText = buildActiveFiltersText(filters, qa?.windowLabel, uiLang);
    const { answer, suggestions } = noDataFoundResponse(uiLang, {
      period: qa?.windowLabel || undefined,
      hasRestrictiveFilters,
      activeFiltersText: activeFiltersText || undefined,
    });
    return {
      ok: true,
      answer,
      cards: null,
      rowCount: 0,
      aiComment: "no_data",
      userName: cid ? getUserName(cid) || null : null,
      chart: null,
      suggestions,
    };
  }

  // kpiPack:
  // - Si devuelve KPI row, úsalo.
  // - Si devuelve series, derivamos sumando.
  let kpiPack = null;

  if (Array.isArray(rowsQA) && rowsQA[0] && looksLikeKpiPackRow(rowsQA[0])) {
    kpiPack = rowsQA[0];
  } else if (Array.isArray(rowsQA) && rowsQA.length) {
    const sum = rowsQA.reduce(
      (acc, r) => {
        acc.gross_cases += Number(r.gross_cases || 0);
        acc.dropped_cases += Number(r.dropped_cases || 0);
        acc.confirmed_cases += Number(r.confirmed_cases || 0);
        acc.case_converted_value += Number(r.case_converted_value || 0);
        return acc;
      },
      { gross_cases: 0, dropped_cases: 0, confirmed_cases: 0, case_converted_value: 0 }
    );

    sum.dropped_rate = sum.gross_cases ? (100 * sum.dropped_cases) / sum.gross_cases : 0;
    sum.confirmed_rate = sum.gross_cases ? (100 * sum.confirmed_cases) / sum.gross_cases : 0;

    kpiPack = sum;
  }

  const legacyAnswer = await buildOwnerAnswer(
    `${msg} (${qa.windowLabel})`,
    qa.sql,
    rowsQA,
    {
      kpiPack,
      kpiWindow: qa.windowLabel,
      lang: uiLang,
      userName: cid ? getUserName(cid) || null : null,
      mode: "quick_action",
    }
  );

  const cards = buildInsightCards(uiLang, {
    windowLabel: qa.windowLabel,
    kpiPack,
    mode: qa.mode,
  });

  const chartWanted = shouldShowChartPayload({ topQuickAction: true, rows: rowsQA });
  const chart = chartWanted
    ? buildMiniChart(`${msg} (${qa.windowLabel})`, uiLang, { kpiPack, rows: rowsQA })
    : null;

  return {
    ok: true,
    answer: legacyAnswer,
    cards,
    rowCount: Array.isArray(rowsQA) ? rowsQA.length : 0,
    aiComment: `quick_action_${qa.mode}`,
    userName: cid ? getUserName(cid) || null : null,
    chart: chart || null,
    suggestions: buildSuggestions("", uiLang),
    kpiWindow: qa.windowLabel,
    executedSql: debug ? qa.sql : undefined,
    ...(debug
      ? {
          chartDebug: { chartWanted, rowsLen: rowsQA.length },
        }
      : {}),
  };
}

module.exports = { handleQuickActions };
