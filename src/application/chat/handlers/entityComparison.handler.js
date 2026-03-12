const sqlRepo = require("../../../repos/sql.repo");
const { buildKpiPackSql, buildPeerComparisonSql } = require("../../../services/kpis/kpiPack.service");
const { buildInsightCards } = require("../../../domain/ui/cardsAndChart.builder");

async function handleEntityComparison({
  reqId,
  logEnabled,
  uiLang,
  messageWithDefaultPeriod,
  filters,
  parsedAnalytics,
  userName,
}) {
  if (!parsedAnalytics || parsedAnalytics.intent !== "comparison_vs_average") return null;
  if (!parsedAnalytics.entity?.name || !parsedAnalytics.period) return null;

  const entityName = String(parsedAnalytics.entity.name).trim();
  const period = parsedAnalytics.period;

  console.log(
    `[${reqId}] [route] selected handler=entityComparison intent="${parsedAnalytics.intent}" entity="${entityName}" periodKind="${period.kind}"`
  );

  // A) Query A – entity metric (Tony 2025)
  const effectiveFilters = { ...(filters || {}) };
  effectiveFilters.person = { value: entityName, locked: true, exact: false };

  const { sql: kpiSql, params: kpiParams, windowLabel } = buildKpiPackSql(messageWithDefaultPeriod, {
    lang: uiLang,
    filters: effectiveFilters,
  });

  if (logEnabled) {
    console.log(`[${reqId}] [ENTITY_COMP] QUERY_A sql=${(kpiSql || "").replace(/\s+/g, " ").slice(0, 400)}...`);
    console.log(`[${reqId}] [ENTITY_COMP] QUERY_A params=${JSON.stringify(kpiParams || [])}`);
  }

  let kpiRow = null;
  try {
    const rows = await sqlRepo.query(kpiSql, kpiParams);
    kpiRow = Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch (e) {
    if (logEnabled) console.error(`[${reqId}] [ENTITY_COMP] QUERY_A failed:`, e?.message);
  }

  const entityConfirmedRate = kpiRow ? Number(kpiRow.confirmed_rate || 0) : 0;

  // B) Query B – average submitter metric for same period (excluding empty names)
  const filtersWithoutPerson = { ...(filters || {}) };
  filtersWithoutPerson.person = null;

  const { sql: peerSql, params: peerParams } = buildPeerComparisonSql(messageWithDefaultPeriod, {
    lang: uiLang,
    filters: filtersWithoutPerson,
  });

  if (logEnabled) {
    console.log(`[${reqId}] [ENTITY_COMP] QUERY_B sql=${(peerSql || "").replace(/\s+/g, " ").slice(0, 400)}...`);
    console.log(`[${reqId}] [ENTITY_COMP] QUERY_B params=${JSON.stringify(peerParams || [])}`);
  }

  let avgConfirmedRate = 0;
  let peerCount = 0;
  try {
    const peerRows = await sqlRepo.query(peerSql, peerParams);
    const arr = Array.isArray(peerRows) ? peerRows : [];
    const valid = arr.filter(
      (r) => String(r.submitter_key || "").trim() !== "" && r.confirmed_rate != null
    );
    peerCount = valid.length;
    if (valid.length) {
      const sum = valid.reduce((acc, r) => acc + Number(r.confirmed_rate || 0), 0);
      avgConfirmedRate = sum / valid.length;
    }
  } catch (e) {
    if (logEnabled) console.error(`[${reqId}] [ENTITY_COMP] QUERY_B failed:`, e?.message);
  }

  const diff = entityConfirmedRate - avgConfirmedRate;
  const es = uiLang === "es";
  const above = diff > 0;

  const entityRateStr = entityConfirmedRate.toFixed(2);
  const avgRateStr = avgConfirmedRate.toFixed(2);
  const diffAbsStr = Math.abs(diff).toFixed(2);

  const answer = es
    ? `En ${windowLabel || "el período"}, la tasa de casos confirmados de ${entityName} fue ${entityRateStr}%, que está ${above ? "por encima" : "por debajo"} del promedio de submitters (${avgRateStr}%) por ${diffAbsStr} puntos.`
    : `In ${windowLabel || "the period"}, ${entityName}'s confirmed case rate was ${entityRateStr}%, which is ${diffAbsStr} points ${above ? "above" : "below"} the average submitter rate of ${avgRateStr}%.`;

  const cards = kpiRow
    ? buildInsightCards(uiLang, { windowLabel, kpiPack: kpiRow, mode: "entity_comparison" })
    : null;

  return {
    ok: true,
    answer,
    cards,
    rowCount: 1,
    aiComment: "entity_comparison",
    userName: userName || null,
    chart: null,
    suggestions: null,
    kpiWindow: windowLabel,
    entityComparison: {
      entityName,
      period: windowLabel,
      entityConfirmedRate,
      avgConfirmedRate,
      diff,
      peerCount,
    },
  };
}

module.exports = { handleEntityComparison };

