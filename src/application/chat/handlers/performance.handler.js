
const sqlRepo = require("../../../repos/sql.repo");

const { buildOwnerAnswer } = require("../../../services/answers/ownerAnswer.service");
const {
  wantsPerformance,
  resolvePerformanceGroupBy,
  buildPerformanceKpiSql,
} = require("../../../services/kpis/performanceKpi.service");

const { listDimensions } = require("../../../domain/dimensions/dimensionRegistry");
const { logSql } = require("../../../utils/chatRoute.helpers");
const { friendlyError } = require("../../../utils/errors");

const { buildPerformanceCards, shouldShowChartPayload } = require("../../../domain/ui/cardsAndChart.builder");
const { buildMiniChart } = require("../../../utils/miniChart");

function detectPerformanceGroupKey(msg = "", uiLang = "en") {
  const m = String(msg || "").toLowerCase();

  if (/(by\s+office|por\s+oficina)/i.test(m)) return "office";
  if (/(by\s+pod|por\s+pod)/i.test(m)) return "pod";
  if (/(by\s+region|por\s+regi[oó]n)/i.test(m)) return "region";
  if (/(by\s+team|por\s+equipo|por\s+team)/i.test(m)) return "team";
  if (/(top\s+reps|reps|submitter|person|persona|representante)/i.test(m)) return "person";

  return "person";
}

function detectPerformanceWindowExpr(msg = "", uiLang = "en") {
  const m = String(msg || "").toLowerCase();

  if (/(last\s+7\s+days|últimos?\s+7\s+d[ií]as|ultimos?\s+7\s+dias)/i.test(m)) {
    return {
      fromExpr: `DATE_SUB(CURDATE(), INTERVAL 6 DAY)`,
      toExpr: `DATE_ADD(CURDATE(), INTERVAL 1 DAY)`,
      windowLabel: uiLang === "es" ? "Últimos 7 días" : "Last 7 days",
    };
  }

  if (/(last\s+30\s+days|últimos?\s+30\s+d[ií]as|ultimos?\s+30\s+dias)/i.test(m)) {
    return {
      fromExpr: `DATE_SUB(CURDATE(), INTERVAL 29 DAY)`,
      toExpr: `DATE_ADD(CURDATE(), INTERVAL 1 DAY)`,
      windowLabel: uiLang === "es" ? "Últimos 30 días" : "Last 30 days",
    };
  }

  if (/(this\s+week|esta\s+semana|semana)/i.test(m)) {
    return {
      fromExpr: `DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)`,
      toExpr: `DATE_ADD(DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY), INTERVAL 7 DAY)`,
      windowLabel: uiLang === "es" ? "Esta semana" : "This week",
    };
  }

  return {
    fromExpr: `DATE_FORMAT(CURDATE(), '%Y-%m-01')`,
    toExpr: `DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)`,
    windowLabel: uiLang === "es" ? "Mes en curso" : "Month-to-date",
  };
}

async function handlePerformance({
  reqId,
  logEnabled,
  debug,
  uiLang,
  cid, // (opcional, no se usa aquí)
  messageWithDefaultPeriod,
  filters,
  suggestionsBase,
  userName,
}) {
  if (!wantsPerformance(messageWithDefaultPeriod)) return null;

  const groupKey = detectPerformanceGroupKey(messageWithDefaultPeriod, uiLang);
  const groupBy = resolvePerformanceGroupBy(groupKey);
  const win = detectPerformanceWindowExpr(messageWithDefaultPeriod, uiLang);

  // arma filtros simples desde contexto (solo valores)
  const perfFilters = {};
  for (const d of listDimensions()) {
    const lock = filters?.[d.key];
    if (lock?.locked && lock?.value) perfFilters[d.key] = String(lock.value);
  }

  const { sql: perfSql, params: perfParams } = buildPerformanceKpiSql({
    groupBy,
    fromExpr: win.fromExpr,
    toExpr: win.toExpr,
    filters: perfFilters,
    limit: 50,
  });

  if (logEnabled) logSql(reqId, "performance_leaderboard", perfSql, perfParams);

  let perfRows = [];
  try {
    const r = await sqlRepo.query(perfSql, perfParams);
    perfRows = Array.isArray(r) ? r : [];
  } catch (e) {
    console.error(`[${reqId}] performance query failed:`, e?.message || e);
    return {
      ok: true,
      answer: friendlyError(uiLang, reqId),
      rowCount: 0,
      aiComment: "friendly_error_performance",
      userName: userName || null,
      chart: null,
      suggestions: suggestionsBase,
      ...(debug ? { debugDetails: String(e?.message || e) } : {}),
    };
  }

  const kpi = Array.isArray(perfRows) && perfRows[0] ? perfRows[0] : null;
  const pickedName = kpi?.name || kpi?.submitterName || filters?.person?.value || null;

  const cards = buildPerformanceCards(uiLang, {
    windowLabel: win.windowLabel,
    name: pickedName,
    kpi,
  });

  const answer = await buildOwnerAnswer(
    `${messageWithDefaultPeriod} (${win.windowLabel})`,
    perfSql,
    perfRows,
    {
      lang: uiLang,
      userName,
      mode: "performance_leaderboard",
      kpiPack: kpi,
      kpiWindow: win.windowLabel,
    }
  );

  const chartWanted = shouldShowChartPayload({ topQuickAction: false, rows: perfRows });
  const chart = chartWanted
    ? buildMiniChart(`${messageWithDefaultPeriod} (${win.windowLabel})`, uiLang, { kpiPack: kpi, rows: perfRows })
    : null;

  return {
    ok: true,
    answer,
    cards,
    rowCount: perfRows.length,
    aiComment: "performance_leaderboard",
    userName,
    chart: chart || null,
    suggestions: suggestionsBase,
    executedSql: debug ? perfSql : undefined,
  };
}

module.exports = { handlePerformance };
