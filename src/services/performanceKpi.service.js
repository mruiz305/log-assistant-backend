// src/services/performanceKpi.service.js
const { injectLikeFilterSmart } = require("../utils/dimension");

/**
 * Detecta intención de performance/ranking/top
 */
function wantsPerformance(msg = "") {
  const m = String(msg || "").toLowerCase();
  return /\b(performance|rendimiento|desempeño|ranking|top)\b/.test(m);
}
function applyLikeFilterSmart(baseSql, col, value) {
  const out = injectLikeFilterSmart(baseSql, col, value);

  // Caso 1: devuelve string
  if (typeof out === "string") return { sql: out, params: [] };

  // Caso 2: devuelve objeto { sql, params }
  if (out && typeof out === "object") {
    return {
      sql: out.sql || baseSql,
      params: Array.isArray(out.params) ? out.params : [],
    };
  }

  // fallback
  return { sql: baseSql, params: [] };
}

/**
 * Traduce dimKey lógico -> columna real del dashboard
 */
function resolvePerformanceGroupBy(dimKey) {
  const map = {
    person: "submitterName",
    rep: "submitterName",
    submitter: "submitterName",
    office: "OfficeName",
    pod: "PODEName",
    region: "RegionName",
    team: "TeamName",
  };
  return map[dimKey] || "submitterName";
}

/**
 * Performance KPI Leaderboard (SQL)
 */
function buildPerformanceKpiSql({
  groupBy = "submitterName",
  fromExpr,
  toExpr,
  filters = null,
  limit = 50,
} = {}) {
  const dimCol = groupBy;
 if (!fromExpr || !toExpr) {
  throw new Error(`buildPerformanceKpiSql: fromExpr/toExpr required (from=${fromExpr}, to=${toExpr})`);
}

  let sql = `
    SELECT
      ${dimCol} AS name,
      COUNT(*) AS ttd,
      SUM(CASE WHEN Confirmed = 1 THEN 1 ELSE 0 END) AS confirmed,
      ROUND(
        (SUM(CASE WHEN Confirmed = 1 THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0)) * 100
      , 2) AS confirmationRate,
      SUM(CASE WHEN Status LIKE '%DROP%' THEN 1 ELSE 0 END) AS dropped_cases,
      ROUND(
        100 * SUM(CASE WHEN Status LIKE '%DROP%' THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0)
      , 2) AS dropped_rate,
      ROUND(SUM(COALESCE(convertedValue, 0)), 2) AS convertedValue
    FROM performance_data.dmLogReportDashboard
    WHERE dateCameIn >= ${fromExpr}
      AND dateCameIn < ${toExpr}
      AND ${dimCol} IS NOT NULL AND TRIM(${dimCol}) <> ''
  `.trim();

  let params = [];

  // filtros opcionales
  if (filters && typeof filters === "object") {
    // ✅ regla tuya: persona SIEMPRE submitterName LIKE
    if (filters.person) {
     const out = applyLikeFilterSmart(sql, "submitterName", String(filters.person));
      sql = out.sql;
      params = params.concat(out.params);

    }

    if (filters.office) {
      const out = injectLikeFilter(sql, "OfficeName", filters.office);
      sql = out.sql;
      params = params.concat(out.params || []);
    }

    if (filters.pod) {
      const out = injectLikeFilter(sql, "PODEName", filters.pod);
      sql = out.sql;
      params = params.concat(out.params || []);
    }

    if (filters.region) {
      const out = injectLikeFilter(sql, "RegionName", filters.region);
      sql = out.sql;
      params = params.concat(out.params || []);
    }

    if (filters.team) {
      const out = injectLikeFilter(sql, "TeamName", filters.team);
      sql = out.sql;
      params = params.concat(out.params || []);
    }

    if (filters.attorney) {
      const out = injectLikeFilter(sql, "attorney", filters.attorney);
      sql = out.sql;
      params = params.concat(out.params || []);
    }

    if (filters.intake) {
      const out = injectLikeFilter(sql, "intakeSpecialist", filters.intake);
      sql = out.sql;
      params = params.concat(out.params || []);
    }
  }

  sql = `
    ${sql}
    GROUP BY ${dimCol}
    ORDER BY ttd DESC, convertedValue DESC, confirmed DESC
    LIMIT ${Number(limit) || 50}
  `.trim();

  return { sql, params };
}

module.exports = {
  wantsPerformance,
  resolvePerformanceGroupBy,
  buildPerformanceKpiSql,
};
