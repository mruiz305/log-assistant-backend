
function normalizeQuickActionMessage(msg = "", uiLang = "en") {
  return String(msg || "").trim();
}

function isTopQuickAction(msg = "") {
  const m = String(msg || "").trim();

  if (/^last\s+7\s+days$/i.test(m)) return true;
  if (/^últimos?\s+7\s+d[ií]as$/i.test(m)) return true;
  if (/^this\s+month$/i.test(m)) return true;
  if (/^este\s+mes$/i.test(m)) return true;
  if (/^top\s+reps$/i.test(m)) return true;
  if (/^see\s+dropped$/i.test(m)) return true;
  if (/^ver\s+dropped$/i.test(m)) return true;

  return (
    /^confirmed\s*\(\s*month\s*\)$/i.test(m) ||
    /^credit\s*\(\s*month\s*\)$/i.test(m) ||
    /^best\s+confirmation\s*\(\s*year\s*\)$/i.test(m) ||
    /^dropped\s+last\s+3\s+months$/i.test(m) ||
    /^summary\s*\(\s*week\s*\)$/i.test(m) ||
    /^dropped\s+today\s*\(\s*office\s*\)$/i.test(m)
  );
}

/* =========================================================
   Helpers: filter injection (person)
   - Reusa TU regla: submitterName LIKE (fallback submitter)
   - Respeta exact vs like
========================================================= */

function getPersonFilterWhereAndParams(filters) {
  const person = filters?.person?.value ? String(filters.person.value).trim() : "";
  const locked = Boolean(filters?.person?.locked);
  if (!person || !locked) return { whereSql: "", params: [] };

  const exact = Boolean(filters?.person?.exact);

  // Campo estándar del proyecto: submitterName (fallback submitter)
  const fieldExpr = `LOWER(TRIM(COALESCE(NULLIF(submitterName,''), submitter)))`;

  if (exact) {
    return {
      whereSql: ` AND ${fieldExpr} = LOWER(TRIM(?))`,
      params: [person],
    };
  }

  return {
    whereSql: ` AND ${fieldExpr} LIKE CONCAT('%', LOWER(TRIM(?)), '%')`,
    params: [person],
  };
}

/** Mapeo dimensión -> columna dmLogReportDashboard */
const DIM_COL_MAP = {
  office: "OfficeName",
  pod: "PODEName",
  team: "TeamName",
  region: "RegionName",
  director: "DirectorName",
  intake: "intakeSpecialist",
  attorney: "attorney",
};

/**
 * Construye WHERE + params para todos los filtros (person + office, pod, etc.).
 * Usado por quick actions para respetar el filtro de la respuesta.
 */
function getAllFiltersWhereAndParams(filters) {
  const parts = [];
  const params = [];

  const { whereSql: personWhere, params: personParams } = getPersonFilterWhereAndParams(filters);
  if (personWhere) {
    parts.push(personWhere.trim().replace(/^AND\s*/i, ""));
    params.push(...personParams);
  }

  for (const [key, col] of Object.entries(DIM_COL_MAP)) {
    const lock = filters?.[key];
    if (!lock?.locked || !lock?.value) continue;
    const v = String(lock.value || "").trim();
    if (!v) continue;
    parts.push(`LOWER(TRIM(${col})) LIKE CONCAT('%', LOWER(TRIM(?)), '%')`);
    params.push(v);
  }

  const whereSql = parts.length ? " AND " + parts.join(" AND ") : "";
  return { whereSql, params };
}

function buildTopQuickActionSql(actionMsg, uiLang, opts = {}) {
  const m = String(actionMsg || "").trim();
  const filters = opts?.filters || {};

  const monthStart = `DATE_FORMAT(CURDATE(), '%Y-%m-01')`;
  const monthEnd = `DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)`;

  const last7Start = `DATE_SUB(CURDATE(), INTERVAL 6 DAY)`; // 7 días incluyendo hoy
  const tomorrow = `DATE_ADD(CURDATE(), INTERVAL 1 DAY)`;

  // Inyección de todos los filtros (person, office, pod, etc.) del contexto
  const { whereSql: filtersWhere, params: filtersParams } = getAllFiltersWhereAndParams(filters);

  // UI: Last 7 days / Últimos 7 días -> serie por día
  if (/^last\s+7\s+days$/i.test(m) || /^últimos?\s+7\s+d[ií]as$/i.test(m)) {
    const sql = `
      SELECT
        DATE(dateCameIn) AS day,
        COUNT(*) AS gross_cases,
        SUM(CASE WHEN UPPER(Status) LIKE '%DROP%' THEN 1 ELSE 0 END) AS dropped_cases,
        SUM(CASE WHEN Confirmed=1 THEN 1 ELSE 0 END) AS confirmed_cases,
        ROUND(SUM(COALESCE(convertedValue,0)), 2) AS case_converted_value
      FROM dmLogReportDashboard
      WHERE dateCameIn >= ${last7Start} AND dateCameIn < ${tomorrow}
      ${filtersWhere}
      GROUP BY DATE(dateCameIn)
      ORDER BY day ASC
    `.trim();

    return {
      sql,
      params: [...filtersParams],
      windowLabel: uiLang === "es" ? "Últimos 7 días" : "Last 7 days",
      mode: "series_last7",
    };
  }

  // UI: This month / Este mes -> serie por día
  if (/^this\s+month$/i.test(m) || /^este\s+mes$/i.test(m)) {
    const sql = `
      SELECT
        DATE(dateCameIn) AS day,
        COUNT(*) AS gross_cases,
        SUM(CASE WHEN UPPER(Status) LIKE '%DROP%' THEN 1 ELSE 0 END) AS dropped_cases,
        SUM(CASE WHEN Confirmed=1 THEN 1 ELSE 0 END) AS confirmed_cases,
        ROUND(SUM(COALESCE(convertedValue,0)), 2) AS case_converted_value
      FROM dmLogReportDashboard
      WHERE dateCameIn >= ${monthStart} AND dateCameIn < ${monthEnd}
      ${filtersWhere}
      GROUP BY DATE(dateCameIn)
      ORDER BY day ASC
    `.trim();

    return {
      sql,
      params: [...filtersParams],
      windowLabel: uiLang === "es" ? "Mes en curso" : "This month",
      mode: "series_month_daily",
    };
  }

  // UI: See dropped / Ver dropped -> últimos 3 meses por mes
  if (/^see\s+dropped$/i.test(m) || /^ver\s+dropped$/i.test(m)) {
    const sql = `
      SELECT
        YEAR(dateCameIn) AS y,
        MONTH(dateCameIn) AS m,
        COUNT(*) AS gross_cases,
        SUM(CASE WHEN UPPER(Status) LIKE '%DROP%' THEN 1 ELSE 0 END) AS dropped_cases,
        ROUND(100 * SUM(CASE WHEN UPPER(Status) LIKE '%DROP%' THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 2) AS dropped_rate
      FROM dmLogReportDashboard
      WHERE dateCameIn >= DATE_SUB(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 2 MONTH)
        AND dateCameIn < DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)
      ${filtersWhere}
      GROUP BY YEAR(dateCameIn), MONTH(dateCameIn)
      ORDER BY y DESC, m DESC
      LIMIT 3
    `.trim();

    return {
      sql,
      params: [...filtersParams],
      windowLabel: uiLang === "es" ? "Últimos 3 meses" : "Last 3 months",
      mode: "dropped_3m",
    };
  }

  // UI: Top reps -> top 10 submitters (serie)
  if (/^top\s+reps$/i.test(m)) {
    const sql = `
      SELECT
        TRIM(submitterName) AS submitter,
        COUNT(*) AS gross_cases,
        SUM(CASE WHEN Confirmed=1 THEN 1 ELSE 0 END) AS confirmed_cases,
        ROUND(100 * SUM(CASE WHEN Confirmed=1 THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 2) AS confirmed_rate,
        ROUND(SUM(COALESCE(convertedValue,0)), 2) AS case_converted_value
      FROM dmLogReportDashboard
      WHERE dateCameIn >= ${monthStart} AND dateCameIn < ${monthEnd}
        AND TRIM(submitterName) <> ''
      ${filtersWhere}
      GROUP BY TRIM(submitterName)
      ORDER BY gross_cases DESC, case_converted_value DESC
      LIMIT 10
    `.trim();

    return {
      sql,
      params: [...filtersParams],
      windowLabel: uiLang === "es" ? "Mes en curso (Top reps)" : "This month (Top reps)",
      mode: "top_reps_month",
    };
  }

  // --- compat viejo ---
  if (/^confirmed\s*\(\s*month\s*\)$/i.test(m)) {
    const sql = `
      SELECT
        COUNT(*) AS gross_cases,
        SUM(CASE WHEN Confirmed=1 THEN 1 ELSE 0 END) AS confirmed_cases,
        ROUND(100 * SUM(CASE WHEN Confirmed=1 THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 2) AS confirmed_rate,
        ROUND(SUM(COALESCE(convertedValue,0)), 2) AS case_converted_value,
        SUM(CASE WHEN UPPER(Status) LIKE '%DROP%' THEN 1 ELSE 0 END) AS dropped_cases,
        ROUND(100 * SUM(CASE WHEN UPPER(Status) LIKE '%DROP%' THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 2) AS dropped_rate,
        SUM(CASE WHEN UPPER(Status) LIKE '%PROBLEM%' THEN 1 ELSE 0 END) AS problem_cases,
        ROUND(100 * SUM(CASE WHEN UPPER(Status) LIKE '%PROBLEM%' THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 2) AS problem_rate,
        SUM(CASE WHEN Confirmed=0 AND UPPER(Status) LIKE '%ACTI%' THEN 1 ELSE 0 END) AS active_cases,
        SUM(CASE WHEN Confirmed=0 AND UPPER(Status) LIKE '%REF%' THEN 1 ELSE 0 END) AS referout_cases
      FROM dmLogReportDashboard
      WHERE dateCameIn >= ${monthStart} AND dateCameIn < ${monthEnd}
      ${filtersWhere}
    `.trim();

    return {
      sql,
      params: [...filtersParams],
      windowLabel: uiLang === "es" ? "Mes en curso" : "This month",
      mode: "kpi_pack",
    };
  }

  if (/^summary\s*\(\s*week\s*\)$/i.test(m)) {
    const sql = `
      SELECT
       COUNT(*) AS gross_cases,

SUM(CASE WHEN Confirmed=1 THEN 1 ELSE 0 END) AS confirmed_cases,
ROUND(100 * SUM(CASE WHEN Confirmed=1 THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 2) AS confirmed_rate,

ROUND(SUM(COALESCE(convertedValue,0)), 2) AS case_converted_value,

SUM(CASE WHEN UPPER(Status) LIKE '%DROP%' THEN 1 ELSE 0 END) AS dropped_cases,
ROUND(100 * SUM(CASE WHEN UPPER(Status) LIKE '%DROP%' THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 2) AS dropped_rate,

SUM(CASE WHEN UPPER(Status) LIKE '%PROBLEM%' THEN 1 ELSE 0 END) AS problem_cases,
ROUND(100 * SUM(CASE WHEN UPPER(Status) LIKE '%PROBLEM%' THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 2) AS problem_rate,

SUM(CASE WHEN Confirmed=1 AND UPPER(Status) LIKE '%PROBLEM%' THEN 1 ELSE 0 END) AS leakage_confirmed_problem,
SUM(CASE WHEN Confirmed=1 AND UPPER(Status) LIKE '%DROP%' THEN 1 ELSE 0 END) AS leakage_confirmed_dropped_status,
SUM(CASE WHEN Confirmed=1 AND UPPER(ClinicalStatus) LIKE '%DROP%' THEN 1 ELSE 0 END) AS leakage_confirmed_clinical_dropped,

/* ==========================
   ✅ MÁS ESTADOS (OPEN / PIPELINE)
   ========================== */

/* Active (mejorado) */
SUM(
  CASE
    WHEN Confirmed=0 AND (
      UPPER(Status) LIKE '%ACTI%' OR
      UPPER(Status) LIKE '%OPEN%' OR
      UPPER(Status) LIKE '%IN PROGRESS%' OR
      UPPER(Status) LIKE '%WORKING%'
    )
    THEN 1 ELSE 0
  END
) AS active_cases,

/* Referout / Transfer */
SUM(
  CASE
    WHEN Confirmed=0 AND (
      UPPER(Status) LIKE '%REF%' OR
      UPPER(Status) LIKE '%REFER%' OR
      UPPER(Status) LIKE '%TRANSFER%'
    )
    THEN 1 ELSE 0
  END
) AS referout_cases,

/* Pending / Waiting */
SUM(
  CASE
    WHEN Confirmed=0 AND (
      UPPER(Status) LIKE '%PEND%' OR
      UPPER(Status) LIKE '%WAIT%' OR
      UPPER(Status) LIKE '%HOLD%'
    )
    THEN 1 ELSE 0
  END
) AS pending_cases,

/* Scheduled / Appointment */
SUM(
  CASE
    WHEN Confirmed=0 AND (
      UPPER(Status) LIKE '%SCHED%' OR
      UPPER(Status) LIKE '%APPT%' OR
      UPPER(Status) LIKE '%APPOINT%'
    )
    THEN 1 ELSE 0
  END
) AS scheduled_cases,

/* No contact / Unreachable */
SUM(
  CASE
    WHEN Confirmed=0 AND (
      UPPER(Status) LIKE '%NO CONTACT%' OR
      UPPER(Status) LIKE '%UNREACH%' OR
      UPPER(Status) LIKE '%NO ANSWER%' OR
      UPPER(Status) LIKE '%VOICEMAIL%' OR
      UPPER(Status) LIKE '%VM%' OR
      UPPER(Status) LIKE '%DISCONNECT%'
    )
    THEN 1 ELSE 0
  END
) AS unreachable_cases,

/* Docs missing / Incomplete */
SUM(
  CASE
    WHEN Confirmed=0 AND (
      UPPER(Status) LIKE '%DOC%' OR
      UPPER(Status) LIKE '%DOCUMENT%' OR
      UPPER(Status) LIKE '%PAPERWORK%' OR
      UPPER(Status) LIKE '%INCOMPLETE%'
    )
    THEN 1 ELSE 0
  END
) AS docs_missing_cases

FROM dmLogReportDashboard
      WHERE dateCameIn >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) AND dateCameIn < CURDATE()
      ${filtersWhere}
    `.trim();

    return {
      sql,
      params: [...filtersParams],
      windowLabel: uiLang === "es" ? "Últimos 7 días" : "Last 7 days",
      mode: "kpi_pack",
    };
  }

  if (/^dropped\s+last\s+3\s+months$/i.test(m)) {
    const sql = `
      SELECT
        YEAR(dateCameIn) AS y,
        MONTH(dateCameIn) AS m,
        COUNT(*) AS gross_cases,
        SUM(CASE WHEN UPPER(Status) LIKE '%DROP%' THEN 1 ELSE 0 END) AS dropped_cases,
        ROUND(100 * SUM(CASE WHEN UPPER(Status) LIKE '%DROP%' THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 2) AS dropped_rate
      FROM dmLogReportDashboard
      WHERE dateCameIn >= DATE_SUB(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 2 MONTH)
        AND dateCameIn < DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)
      ${filtersWhere}
      GROUP BY YEAR(dateCameIn), MONTH(dateCameIn)
      ORDER BY y DESC, m DESC
      LIMIT 3
    `.trim();

    return {
      sql,
      params: [...filtersParams],
      windowLabel: uiLang === "es" ? "Últimos 3 meses" : "Last 3 months",
      mode: "dropped_3m",
    };
  }

  if (/^best\s+confirmation\s*\(\s*year\s*\)$/i.test(m)) {
    const sql = `
      SELECT
        TRIM(submitterName) AS submitter,
        COUNT(*) AS gross_cases,
        SUM(CASE WHEN Confirmed=1 THEN 1 ELSE 0 END) AS confirmed_cases,
        ROUND(100 * SUM(CASE WHEN Confirmed=1 THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 2) AS confirmed_rate
      FROM dmLogReportDashboard
      WHERE YEAR(dateCameIn) = YEAR(CURDATE())
        AND TRIM(submitterName) <> ''
      ${filtersWhere}
      GROUP BY TRIM(submitterName)
      HAVING gross_cases >= 10
      ORDER BY confirmed_rate DESC, confirmed_cases DESC, gross_cases DESC
      LIMIT 10
    `.trim();

    return {
      sql,
      params: [...filtersParams],
      windowLabel: uiLang === "es" ? "Año en curso" : "This year",
      mode: "best_confirmation_year",
    };
  }

  if (/^dropped\s+today\s*\(\s*office\s*\)$/i.test(m)) {
    const sql = `
      SELECT
        OfficeName AS office,
        COUNT(*) AS gross_cases,
        SUM(CASE WHEN UPPER(Status) LIKE '%DROP%' THEN 1 ELSE 0 END) AS dropped_cases,
        ROUND(
          100 * SUM(CASE WHEN UPPER(Status) LIKE '%DROP%' THEN 1 ELSE 0 END)
          / NULLIF(COUNT(*),0),
          2
        ) AS dropped_rate
      FROM dmLogReportDashboard
      WHERE DATE(dateCameIn) = CURDATE()
      ${filtersWhere}
      GROUP BY OfficeName
      ORDER BY dropped_cases DESC, gross_cases DESC
    `.trim();

    return {
      sql,
      params: [...filtersParams],
      windowLabel: uiLang === "es" ? "Hoy (por oficina)" : "Today (by office)",
      mode: "dropped_today_office",
    };
  }

  return null;
}

module.exports = {
  normalizeQuickActionMessage,
  isTopQuickAction,
  buildTopQuickActionSql,
};
