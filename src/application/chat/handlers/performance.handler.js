
const sqlRepo = require("../../../repos/sql.repo");

const { buildOwnerAnswer } = require("../../../services/answers/ownerAnswer.service");
const {
  wantsPerformance,
  resolvePerformanceGroupBy,
  buildPerformanceKpiSql,
} = require("../../../services/kpis/performanceKpi.service");
const { isAnalyticalQuestion, wantsLogsPerformanceReview } = require("../../../services/logsRoster/logsRoster.service");
const { getContext } = require("../../../domain/context/conversationState");
const { getExplicitPersonFromMessage } = require("../../../utils/personDetect");

const { listDimensions } = require("../../../domain/dimensions/dimensionRegistry");
const { logSql } = require("../../../utils/chatRoute.helpers");
const { friendlyError, noDataFoundResponse } = require("../../../utils/errors");
const { buildActiveFiltersText } = require("../../../domain/ui/activeFilters");

const { buildPerformanceCards, shouldShowChartPayload } = require("../../../domain/ui/cardsAndChart.builder");
const { buildSuggestions } = require("../../../domain/ui/suggestions.builder");
const { buildMiniChart } = require("../../../utils/miniChart");

function detectPerformanceGroupKey(msg = "", uiLang = "en") {
  const m = String(msg || "").toLowerCase();

  if (/(by\s+office|por\s+oficina)/i.test(m)) return "office";
  if (/(by\s+pod|por\s+pod)/i.test(m)) return "pod";
  if (/(by\s+region|por\s+regi[oó]n)/i.test(m)) return "region";
  if (/(by\s+team|por\s+equipo|por\s+team)/i.test(m)) return "team";
  if (/(by\s+director|por\s+director)/i.test(m)) return "director";
  if (/(by\s+attorney|por\s+abogado|por\s+attorney)/i.test(m)) return "attorney";
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

  // this year / este año - current calendar year
  if (/(this\s+year|este\s+a[nñ]o|a[nñ]o\s+actual)/i.test(m)) {
    return {
      fromExpr: `DATE_FORMAT(CURDATE(), '%Y-01-01')`,
      toExpr: `DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-01-01'), INTERVAL 1 YEAR)`,
      windowLabel: uiLang === "es" ? "Año en curso" : "Year-to-date",
    };
  }

  // this quarter / este trimestre
  if (/(this\s+quarter|este\s+trimestre|q[1-4])/i.test(m)) {
    return {
      fromExpr: `DATE_ADD(MAKEDATE(YEAR(CURDATE()), 1), INTERVAL (QUARTER(CURDATE())-1)*3 MONTH)`,
      toExpr: `DATE_ADD(MAKEDATE(YEAR(CURDATE()), 1), INTERVAL QUARTER(CURDATE())*3 MONTH)`,
      windowLabel: uiLang === "es" ? "Trimestre en curso" : "Quarter-to-date",
    };
  }

  // this month / este mes - current calendar month
  if (/(this\s+month|este\s+mes|mes\s+en\s+curso)/i.test(m)) {
    return {
      fromExpr: `DATE_FORMAT(CURDATE(), '%Y-%m-01')`,
      toExpr: `DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)`,
      windowLabel: uiLang === "es" ? "Mes en curso" : "Month-to-date",
    };
  }

  // año específico: "2025", "logs for 2025", "Tony's 2025 logs"
  const mYear = m.match(/\b(19\d{2}|20\d{2})\b/);
  if (mYear) {
    const y = parseInt(mYear[1], 10);
    return {
      fromExpr: `DATE('${y}-01-01')`,
      toExpr: `DATE_ADD(DATE('${y}-01-01'), INTERVAL 1 YEAR)`,
      windowLabel: uiLang === "es" ? `año ${y}` : `year ${y}`,
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
  console.log(`[${reqId}] [route] performance.handler entered (wantsPerformance=true)`);

  const SCOPE_DIM_KEYS = ["person", "attorney", "office", "team", "pod", "region", "director", "intake"];
  const hasResolvedEntityFromFilters = SCOPE_DIM_KEYS.some(
    (k) => filters?.[k]?.locked && filters[k].value
  );
  let hasResolvedEntityFromCtx = false;
  if (cid) {
    const ctx = getContext(cid) || {};
    if (ctx.scopeMode === "focus" && ctx.focus?.type && ctx.focus?.value) {
      hasResolvedEntityFromCtx = true;
    }
  }
  const hasResolvedEntity = hasResolvedEntityFromFilters || hasResolvedEntityFromCtx;
  const asksAboutSpecificPerson = Boolean(getExplicitPersonFromMessage(messageWithDefaultPeriod, uiLang));
  const isAnalytical = isAnalyticalQuestion(messageWithDefaultPeriod);
  const wantsLogsReview = wantsLogsPerformanceReview(messageWithDefaultPeriod);
  const isEntitySpecificComparison = (hasResolvedEntity && isAnalytical) || wantsLogsReview;

  // Evitar leaderboard genérico si el usuario preguntó por una persona pero no tenemos entidad resuelta
  if (!hasResolvedEntity && asksAboutSpecificPerson) {
    console.log(`[${reqId}] [route] performance returning null: user asked about specific person but no resolved entity (delegate to kpiOnly/normalAi)`);
    return null;
  }

  console.log(`[${reqId}] [route] performance guard: hasResolvedEntityFromFilters=${hasResolvedEntityFromFilters} hasResolvedEntityFromCtx=${hasResolvedEntityFromCtx} isAnalytical=${isAnalytical} wantsLogsReview=${wantsLogsReview}`);
  if (isEntitySpecificComparison) {
    console.log(`[${reqId}] [route] performance.handler returning null because entity-specific comparison must be handled by logsReview`);
    return null;
  }

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

  if (perfRows.length === 0) {
    const hasRestrictiveFilters = Object.keys(perfFilters || {}).length > 0;
    const activeFiltersText = buildActiveFiltersText(filters, win.windowLabel, uiLang);
    const { answer, suggestions } = noDataFoundResponse(uiLang, {
      hasRestrictiveFilters,
      activeFiltersText: activeFiltersText || undefined,
    });
    return {
      ok: true,
      answer,
      cards: null,
      rowCount: 0,
      aiComment: "no_data",
      userName: userName || null,
      chart: null,
      suggestions,
    };
  }

  const isEntitySpecificNow = (hasResolvedEntity && isAnalytical) || wantsLogsPerformanceReview(messageWithDefaultPeriod);
  if (isEntitySpecificNow) {
    console.log(`[${reqId}] [route] performance.handler returning null (defensive: entity-specific comparison must not use leaderboard card)`);
    return null;
  }

  const kpi = Array.isArray(perfRows) && perfRows[0] ? perfRows[0] : null;
  const pickedName = kpi?.name || kpi?.submitterName || filters?.person?.value || null;

  console.log(`[${reqId}] [route] performance building cards: kpi from perfRows[0] (generic leaderboard, non-entity-specific)`);
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

  const suggestions = buildSuggestions(messageWithDefaultPeriod, uiLang, { performance: true });

  return {
    ok: true,
    answer,
    cards,
    rowCount: perfRows.length,
    aiComment: "performance_leaderboard",
    userName,
    chart: chart || null,
    suggestions,
    kpiWindow: win.windowLabel,
    executedSql: debug ? perfSql : undefined,
  };
}

module.exports = { handlePerformance };
