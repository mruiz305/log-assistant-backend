// src/services/performanceKpi.service.js

// Usar la inyección parametrizada (NO utils/dimension.js)
const {
  injectColumnTokensLike,
  injectSubmitterTokensLike,
} = require("../../application/chat/pipeline/filterInjection");

/**
 * Detecta intención de performance/ranking/top
 */
function wantsPerformance(msg = "") {
  const m = String(msg || "").toLowerCase();
  return /\b(performance|rendimiento|desempeño|ranking|top)\b/.test(m);
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

// helper: soporta string o lock object { value, locked, exact }
function readFilter(filterLike) {
  if (!filterLike) return { value: null, exact: false, locked: false };
  if (typeof filterLike === "string") return { value: filterLike, exact: false, locked: true };

  // lock object
  const value = filterLike?.value ?? null;
  const exact = Boolean(filterLike?.exact);
  const locked = filterLike?.locked !== false; // default true si viene objeto
  return { value, exact, locked };
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
    throw new Error(
      `buildPerformanceKpiSql: fromExpr/toExpr required (from=${fromExpr}, to=${toExpr})`
    );
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
    FROM dmLogReportDashboard
    WHERE dateCameIn >= ${fromExpr}
      AND dateCameIn < ${toExpr}
      AND ${dimCol} IS NOT NULL AND TRIM(${dimCol}) <> ''
  `.trim();

  let params = [];

  // filtros opcionales
  if (filters && typeof filters === "object") {
    // PERSON: usa fallback COALESCE(NULLIF(submitterName,''), submitter)
    //    (viene en injectSubmitterTokensLike)
    const personF = readFilter(filters.person);
    if (personF.locked && personF.value) {
      const out = injectSubmitterTokensLike(sql, String(personF.value), {
        exact: personF.exact,
      });
      sql = out.sql;
      params = params.concat(out.params || []);
    }

    const officeF = readFilter(filters.office);
    if (officeF.locked && officeF.value) {
      const out = injectColumnTokensLike(sql, "OfficeName", String(officeF.value), {
        exact: officeF.exact,
      });
      sql = out.sql;
      params = params.concat(out.params || []);
    }

    const podF = readFilter(filters.pod);
    if (podF.locked && podF.value) {
      const out = injectColumnTokensLike(sql, "PODEName", String(podF.value), {
        exact: podF.exact,
      });
      sql = out.sql;
      params = params.concat(out.params || []);
    }

    const regionF = readFilter(filters.region);
    if (regionF.locked && regionF.value) {
      const out = injectColumnTokensLike(sql, "RegionName", String(regionF.value), {
        exact: regionF.exact,
      });
      sql = out.sql;
      params = params.concat(out.params || []);
    }

    const teamF = readFilter(filters.team);
    if (teamF.locked && teamF.value) {
      const out = injectColumnTokensLike(sql, "TeamName", String(teamF.value), {
        exact: teamF.exact,
      });
      sql = out.sql;
      params = params.concat(out.params || []);
    }

    const attorneyF = readFilter(filters.attorney);
    if (attorneyF.locked && attorneyF.value) {
      const out = injectColumnTokensLike(sql, "attorney", String(attorneyF.value), {
        exact: attorneyF.exact,
      });
      sql = out.sql;
      params = params.concat(out.params || []);
    }

    const intakeF = readFilter(filters.intake);
    if (intakeF.locked && intakeF.value) {
      const out = injectColumnTokensLike(sql, "intakeSpecialist", String(intakeF.value), {
        exact: intakeF.exact,
      });
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
