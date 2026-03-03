
const sqlRepo = require("../../../repos/sql.repo");

const { getUserName } = require("../../../domain/context/userProfile");
const { getContext, setContext } = require("../../../domain/context/conversationState");

const { listDimensions } = require("../../../domain/dimensions/dimensionRegistry");
const { logSql } = require("../../../utils/chatRoute.helpers");
const { friendlyError } = require("../../../utils/errors");

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

function clearContextForQuickAction(cid) {
  if (!cid) return;
  const ctxNow = getContext(cid) || {};
  const next = { ...ctxNow };
  const f = { ...(next.filters || {}) };

  for (const d of listDimensions()) f[d.key] = null;

  next.filters = f;
  next.lastPerson = null;
  next.pdfUser = null;

  setContext(cid, next);
}

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

  // Quick Action => limpiar contexto para que sea global
  if (cid) clearContextForQuickAction(cid);

  const qa = buildTopQuickActionSql(msg, uiLang);

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
    executedSql: debug ? qa.sql : undefined,
    ...(debug
      ? {
          chartDebug: { chartWanted, rowsLen: rowsQA.length },
        }
      : {}),
  };
}

module.exports = { handleQuickActions };
