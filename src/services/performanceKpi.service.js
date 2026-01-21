// src/services/performanceLeaderboard.service.js

const { injectLikeFilter } = require('../utils/dimension');

function buildPerformanceKpiSql({ groupBy = 'submitterName', fromExpr, toExpr }) {
  // groupBy puede ser: submitterName | office | pod | region | team (según tus columnas reales)
  const dimCol = groupBy;

  const sql = `
    SELECT
      ${dimCol} AS name,
      COUNT(*) AS ttd,
      SUM(CASE WHEN Confirmed = 1 THEN 1 ELSE 0 END) AS confirmed,
      ROUND((SUM(CASE WHEN Confirmed = 1 THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0)) * 100, 2) AS confirmationRate,
      SUM(CASE WHEN Status LIKE '%DROP%' THEN 1 ELSE 0 END) AS dropped_cases,
      ROUND(100 * SUM(CASE WHEN Status LIKE '%DROP%' THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 2) AS dropped_rate,
      ROUND(SUM(COALESCE(convertedValue, 0)), 2) AS convertedValue
    FROM dmLogReportDashboard
    WHERE dateCameIn >= ${fromExpr}
      AND dateCameIn < ${toExpr}
      AND ${dimCol} IS NOT NULL AND ${dimCol} <> ''
    GROUP BY ${dimCol}
    ORDER BY ttd DESC, convertedValue DESC, confirmed DESC
  `.trim();

  return { sql, params: [] };
}

module.exports = { buildPerformanceKpiSql };
