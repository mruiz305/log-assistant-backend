/* ============================================================
   KPI Pack SQL Builder (Time Window + Dimension filters)
   - 1 fila con KPIs
   - Usa dateCameIn como fecha principal
   - ✅ Default: si NO detecta ventana de tiempo, ASUME "este mes"
   - ✅ Column real: convertedValue (según tu DDL)
   ============================================================ */

function normalizeText(s = "") {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.,;()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function makeLabel(kind, a, b, lang = "es") {
  const es = lang === "es";
  switch (kind) {
    case "today":
      return es ? "hoy" : "today";
    case "this_week":
      return es ? "esta semana" : "this week";
    case "this_month":
      return es ? "este mes" : "this month";
    case "last_month":
      return es ? "último mes" : "last month";
    case "current_year":
      return es ? "año actual" : "current year";
    case "last_year":
      return es ? "año pasado" : "last year";
    case "year":
      return es ? `año ${a}` : `year ${a}`;
    case "month_year":
      return `${a} ${b}`;
    case "month_only":
      return es ? `${a} (más reciente)` : `${a} (most recent)`;
    case "range":
      return es ? `rango ${a} a ${b}` : `range ${a} to ${b}`;
    case "days":
      return es ? `últimos ${a} días` : `last ${a} days`;
    case "months":
      return es ? `últimos ${a} meses` : `last ${a} months`;
    case "quarters":
      return es ? `trimestre ${a} ${b}` : `Q${a} ${b}`;
    case "default_days":
      return es ? `últimos ${a} días` : `last ${a} days`;
    default:
      return es ? "sin filtro de tiempo" : "no time filter";
  }
}

function monthNameToNumber(token) {
  let t = String(token || "").toLowerCase();
  if (t === "sept") t = "septiembre";

  const map = {
    enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
    julio: 7, agosto: 8, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
    jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  };

  return map[t] ?? null;
}

function monthLabel(num, lang = "es") {
  const es = lang === "es";
  const namesEs = [null, "enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
  const namesEn = [null, "January","February","March","April","May","June","July","August","September","October","November","December"];
  return es ? namesEs[num] : namesEn[num];
}

/** Devuelve { where, label, matched } */
function extractTimeWindow(question, lang = "es", defaultWindowDays = null) {
  const q = normalizeText(question);

  if (q.includes("hoy") || q.includes("today")) {
    return {
      matched: true,
      where: `WHERE dateCameIn >= CURDATE() AND dateCameIn < DATE_ADD(CURDATE(), INTERVAL 1 DAY)`,
      label: makeLabel("today", 0, null, lang),
    };
  }

  if (q.includes("esta semana") || q.includes("this week")) {
    return {
      matched: true,
      where: `WHERE dateCameIn >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)
             AND dateCameIn < DATE_ADD(DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY), INTERVAL 7 DAY)`,
      label: makeLabel("this_week", 0, null, lang),
    };
  }

  if (q.includes("este mes") || q.includes("this month") || q.includes("current month")) {
    return {
      matched: true,
      where: `WHERE dateCameIn >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
             AND dateCameIn < DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)`,
      label: makeLabel("this_month", 0, null, lang),
    };
  }

  if (q.includes("ultimo mes") || q.includes("último mes") || q.includes("last month") || q.includes("mes pasado")) {
    return {
      matched: true,
      where: `WHERE dateCameIn >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01')
             AND dateCameIn < DATE_FORMAT(CURDATE(), '%Y-%m-01')`,
      label: makeLabel("last_month", 0, null, lang),
    };
  }

  if (q.includes("ano pasado") || q.includes("año pasado") || q.includes("last year")) {
    return {
      matched: true,
      where: `WHERE dateCameIn >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 YEAR), '%Y-01-01')
             AND dateCameIn < DATE_FORMAT(CURDATE(), '%Y-01-01')`,
      label: makeLabel("last_year", 0, null, lang),
    };
  }

  if (q.includes("este ano") || q.includes("este año") || q.includes("this year") || q.includes("current year")) {
    return {
      matched: true,
      where: `WHERE dateCameIn >= DATE_FORMAT(CURDATE(), '%Y-01-01')
             AND dateCameIn < DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-01-01'), INTERVAL 1 YEAR)`,
      label: makeLabel("current_year", 0, null, lang),
    };
  }

  const mDays = q.match(/(?:ultim(?:os|as))\s+(\d{1,3})\s+dias?/) || q.match(/(?:last|past)\s+(\d{1,3})\s+days?/);
  if (mDays) {
    const n = parseInt(mDays[1], 10);
    if (!Number.isNaN(n) && n > 0) {
      return {
        matched: true,
        where: `WHERE dateCameIn >= DATE_SUB(CURDATE(), INTERVAL ${n} DAY)`,
        label: makeLabel("days", n, null, lang),
      };
    }
  }

  const mMonths = q.match(/(?:ultim(?:os|as))\s+(\d{1,2})\s+mes(?:es)?/) || q.match(/(?:last|past)\s+(\d{1,2})\s+months?/);
  if (mMonths) {
    const n = parseInt(mMonths[1], 10);
    if (!Number.isNaN(n) && n > 0) {
      return {
        matched: true,
        where: `WHERE dateCameIn >= DATE_SUB(CURDATE(), INTERVAL ${n} MONTH)`,
        label: makeLabel("months", n, null, lang),
      };
    }
  }

  // Rango ISO: YYYY-MM-DD ... YYYY-MM-DD
  const mRangeIso = q.match(
    /\b(19\d{2}|20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b.*\b(19\d{2}|20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/
  );
  if (mRangeIso) {
    const start = `${mRangeIso[1]}-${mRangeIso[2]}-${mRangeIso[3]}`;
    const end = `${mRangeIso[4]}-${mRangeIso[5]}-${mRangeIso[6]}`;
    return {
      matched: true,
      where: `WHERE dateCameIn >= DATE('${start}')
             AND dateCameIn < DATE_ADD(DATE('${end}'), INTERVAL 1 DAY)`,
      label: makeLabel("range", start, end, lang),
    };
  }

  // Mes + año: "marzo 2025" / "03/2025"
  const mMonthYearWord = q.match(
    /\b(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|sept|octubre|noviembre|diciembre|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b\s+(?:de\s+)?\b(19\d{2}|20\d{2})\b/
  );
  const mMonthYearNum = q.match(/\b(0?[1-9]|1[0-2])\s*[/\-]\s*(19\d{2}|20\d{2})\b/);

  if (mMonthYearWord || mMonthYearNum) {
    let monthNum, yearNum;
    if (mMonthYearWord) {
      monthNum = monthNameToNumber(mMonthYearWord[1]);
      yearNum = parseInt(mMonthYearWord[2], 10);
    } else {
      monthNum = parseInt(mMonthYearNum[1], 10);
      yearNum = parseInt(mMonthYearNum[2], 10);
    }

    if (monthNum && yearNum) {
      const start = `${yearNum}-${String(monthNum).padStart(2, "0")}-01`;
      return {
        matched: true,
        where: `WHERE dateCameIn >= DATE('${start}')
               AND dateCameIn < DATE_ADD(DATE('${start}'), INTERVAL 1 MONTH)`,
        label: makeLabel("month_year", monthLabel(monthNum, lang), yearNum, lang),
      };
    }
  }

  // Año específico
  const mYear = q.match(/\b(19\d{2}|20\d{2})\b/);
  if (mYear) {
    const y = parseInt(mYear[1], 10);
    return {
      matched: true,
      where: `WHERE dateCameIn >= DATE('${y}-01-01')
             AND dateCameIn < DATE('${y + 1}-01-01')`,
      label: makeLabel("year", y, null, lang),
    };
  }

  // Fallback controlado por días (si lo pides)
  if (Number.isInteger(defaultWindowDays) && defaultWindowDays > 0) {
    return {
      matched: true,
      where: `WHERE dateCameIn >= DATE_SUB(CURDATE(), INTERVAL ${defaultWindowDays} DAY)`,
      label: makeLabel("default_days", defaultWindowDays, null, lang),
    };
  }

  return { matched: false, where: "", label: makeLabel("no_time", null, null, lang) };
}

/** ✅ Default: si no hay tiempo, aplica ESTE MES */
function defaultThisMonthWindow(lang = "es") {
  return {
    matched: true,
    where: `WHERE dateCameIn >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
           AND dateCameIn < DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)`,
    label: makeLabel("this_month", 0, null, lang),
  };
}

/** Helper genérico LIKE con tokens (para dims) */
function buildTokenLikeWhere(column, rawValue, paramsOut) {
  const q = String(rawValue || "").trim();
  if (!q) return null;

  const tokens = q
    .split(/\s+/g)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 6);

  if (!tokens.length) return null;

  const exprs = tokens.map(() => `LOWER(TRIM(${column})) LIKE CONCAT('%', LOWER(TRIM(?)), '%')`);
  paramsOut.push(...tokens);
  return exprs.length === 1 ? exprs[0] : `(${exprs.join(" AND ")})`;
}

function buildKpiPackSql(message, opts = {}) {
  const lang = opts.lang === "es" ? "es" : "en";
  
  // 1) ventana
 // 1) Extraer ventana desde el mensaje
  let w = extractTimeWindow(message, lang, opts.defaultWindowDays ?? null);

  // 2) ✅ Si NO hubo match, forzar ESTE MES
  if (!w?.matched) {
    w = defaultThisMonthWindow(lang);
  }
   // quitar WHERE para poder concatenar filtros
  const timeClause = String(w.where || '').trim().toUpperCase().startsWith('WHERE ')
    ? String(w.where || '').trim().slice(6).trim()
    : String(w.where || '').trim();

  const whereParts = [];
  const params = [];

  if (timeClause) whereParts.push(timeClause);


   // ✅ filtros (nuevo): viene del route como opts.filters
  const filters = opts.filters || {};

  // mapping seguro a columnas reales
  const dimMap = {
    person: { col: "COALESCE(NULLIF(submitterName,''), submitter)", mode: "coalesce" },
    office: { col: "OfficeName" },
    team: { col: "TeamName" },
    pod: { col: "PODEName" },
    region: { col: "RegionName" },
    director: { col: "DirectorName" },
    attorney: { col: "attorney" },
    intake: { col: "intakeSpecialist" },
  };

  function pushLike(colExpr, value) {
    whereParts.push(`LOWER(TRIM(${colExpr})) LIKE CONCAT('%', LOWER(TRIM(?)), '%')`);
    params.push(String(value || "").trim());
  }

  // aplica en orden (no importa mucho, pero consistente)
  for (const key of ["office","team","pod","region","director","attorney","intake","person"]) {
    const f = filters?.[key];
    if (!f?.value) continue;
    const v = String(f.value || "").trim();
    if (!v) continue;

    const def = dimMap[key];
    if (!def?.col) continue;

    if (key === "person") {
      // ✅ persona SIEMPRE por submitterName/submitter (coalesce)
      pushLike(def.col, v);
    } else {
      pushLike(def.col, v);
    }
  }


  const whereClause = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

  // ✅ convertedValue real
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
  SUM(CASE WHEN Confirmed=0 AND UPPER(Status) LIKE '%ACTI%' THEN 1 ELSE 0 END) AS active_cases,
  SUM(CASE WHEN Confirmed=0 AND UPPER(Status) LIKE '%REF%' THEN 1 ELSE 0 END) AS referout_cases
FROM performance_data.dmLogReportDashboard
${whereClause};
`.trim();

  return {
    sql,
    params,
    windowLabel: w.label,
    timeMatched: true,
  };
}

module.exports = { buildKpiPackSql, extractTimeWindow };
