/* ============================================================
   KPI Pack SQL Builder (Time Window + Person filter)
   - 1 fila con KPIs
   - Usa dateCameIn como fecha principal
   - Soporta rangos: hoy, esta semana, este mes, último mes, año actual, año pasado,
     año específico (2025), mes+año (marzo 2025 / 03/2025), mes solo (marzo),
     últimos N días/meses, trimestre (Q1 2025), rango explícito (YYYY-MM-DD ... YYYY-MM-DD)
   - Soporta filtro persona: submitterName/intakeSpecialist/attorney (LIKE)
   - IMPORTANTE: si NO detecta ventana de tiempo, NO asume 90 días.
     (Opcional: puedes pasar opts.defaultWindowDays para tener fallback controlado.)
   ============================================================ */

function normalizeText(s = '') {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.,;()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function makeLabel(kind, a, b, lang = 'es') {
  const es = lang === 'es';
  switch (kind) {
    case 'today':
      return es ? 'hoy' : 'today';
    case 'this_week':
      return es ? 'esta semana' : 'this week';
    case 'this_month':
      return es ? 'este mes' : 'this month';
    case 'last_month':
      return es ? 'último mes' : 'last month';
    case 'current_year':
      return es ? 'año actual' : 'current year';
    case 'last_year':
      return es ? 'año pasado' : 'last year';
    case 'year':
      return es ? `año ${a}` : `year ${a}`;
    case 'month_year':
      return `${a} ${b}`; // a=nombre mes, b=año
    case 'month_only':
      return es ? `${a} (más reciente)` : `${a} (most recent)`;
    case 'range':
      return es ? `rango ${a} a ${b}` : `range ${a} to ${b}`;
    case 'days':
      return es ? `últimos ${a} días` : `last ${a} days`;
    case 'months':
      return es ? `últimos ${a} meses` : `last ${a} months`;
    case 'quarters':
      return es ? `trimestre ${a} ${b}` : `Q${a} ${b}`;
    case 'default_days':
      return es ? `últimos ${a} días` : `last ${a} days`;
    case 'no_time':
    default:
      return es ? 'sin filtro de tiempo' : 'no time filter';
  }
}

function monthNameToNumber(token) {
  let t = String(token || '').toLowerCase();
  if (t === 'sept') t = 'septiembre';

  const map = {
    // ES
    enero: 1,
    febrero: 2,
    marzo: 3,
    abril: 4,
    mayo: 5,
    junio: 6,
    julio: 7,
    agosto: 8,
    septiembre: 9,
    octubre: 10,
    noviembre: 11,
    diciembre: 12,
    // EN
    january: 1,
    february: 2,
    march: 3,
    april: 4,
    may: 5,
    june: 6,
    july: 7,
    august: 8,
    september: 9,
    october: 10,
    november: 11,
    december: 12,
    // EN short
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12,
  };

  return map[t] ?? null;
}

function monthLabel(num, lang = 'es') {
  const es = lang === 'es';
  const namesEs = [
    null,
    'enero',
    'febrero',
    'marzo',
    'abril',
    'mayo',
    'junio',
    'julio',
    'agosto',
    'septiembre',
    'octubre',
    'noviembre',
    'diciembre',
  ];
  const namesEn = [
    null,
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  return es ? namesEs[num] : namesEn[num];
}

/**
 * Devuelve { where, label, matched }
 * where incluye "WHERE ..." listo para usar, o '' si no hay match.
 */
function extractTimeWindow(question, lang = 'es', defaultWindowDays = null) {
  const q = normalizeText(question);

  // Default: NO asumir nada (para evitar "90 días" silencioso)
  let where = '';
  let label = makeLabel('no_time', null, null, lang);
  let matched = false;

  // Hoy
  if (q.includes('hoy') || q.includes('today')) {
    return {
      matched: true,
      where: `WHERE dateCameIn >= CURDATE() AND dateCameIn < DATE_ADD(CURDATE(), INTERVAL 1 DAY)`,
      label: makeLabel('today', 0, null, lang),
    };
  }

  // Esta semana (Lun..Dom)
  if (q.includes('esta semana') || q.includes('this week')) {
    return {
      matched: true,
      where: `WHERE dateCameIn >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)
             AND dateCameIn < DATE_ADD(DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY), INTERVAL 7 DAY)`,
      label: makeLabel('this_week', 0, null, lang),
    };
  }

  // Este mes (mes calendario)
  if (q.includes('este mes') || q.includes('this month') || q.includes('current month')) {
    return {
      matched: true,
      where: `WHERE dateCameIn >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
             AND dateCameIn < DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)`,
      label: makeLabel('this_month', 0, null, lang),
    };
  }

  // Último mes (mes calendario anterior)
  if (q.includes('ultimo mes') || q.includes('último mes') || q.includes('last month')) {
    return {
      matched: true,
      where: `WHERE dateCameIn >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01')
             AND dateCameIn < DATE_FORMAT(CURDATE(), '%Y-%m-01')`,
      label: makeLabel('last_month', 0, null, lang),
    };
  }

  // Año pasado (año calendario anterior)
  if (q.includes('ano pasado') || q.includes('año pasado') || q.includes('last year')) {
    return {
      matched: true,
      where: `WHERE dateCameIn >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 YEAR), '%Y-01-01')
             AND dateCameIn < DATE_FORMAT(CURDATE(), '%Y-01-01')`,
      label: makeLabel('last_year', 0, null, lang),
    };
  }

  // Año actual
  if (q.includes('este ano') || q.includes('este año') || q.includes('this year') || q.includes('current year')) {
    return {
      matched: true,
      where: `WHERE dateCameIn >= DATE_FORMAT(CURDATE(), '%Y-01-01')
             AND dateCameIn < DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-01-01'), INTERVAL 1 YEAR)`,
      label: makeLabel('current_year', 0, null, lang),
    };
  }

  // Últimos N días
  const mDays =
    q.match(/(?:ultim(?:os|as))\s+(\d{1,3})\s+dias?/) || q.match(/(?:last|past)\s+(\d{1,3})\s+days?/);
  if (mDays) {
    const n = parseInt(mDays[1], 10);
    if (!Number.isNaN(n) && n > 0) {
      return {
        matched: true,
        where: `WHERE dateCameIn >= DATE_SUB(CURDATE(), INTERVAL ${n} DAY)`,
        label: makeLabel('days', n, null, lang),
      };
    }
  }

  // Últimos N meses
  const mMonths =
    q.match(/(?:ultim(?:os|as))\s+(\d{1,2})\s+mes(?:es)?/) || q.match(/(?:last|past)\s+(\d{1,2})\s+months?/);
  if (mMonths) {
    const n = parseInt(mMonths[1], 10);
    if (!Number.isNaN(n) && n > 0) {
      return {
        matched: true,
        where: `WHERE dateCameIn >= DATE_SUB(CURDATE(), INTERVAL ${n} MONTH)`,
        label: makeLabel('months', n, null, lang),
      };
    }
  }

  // Rango explícito ISO: YYYY-MM-DD ... YYYY-MM-DD
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
      label: makeLabel('range', start, end, lang),
    };
  }

  // Rango US: MM/DD/YYYY ... MM/DD/YYYY
  const mRangeUs = q.match(
    /\b(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/(19\d{2}|20\d{2})\b.*\b(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/(19\d{2}|20\d{2})\b/
  );
  if (mRangeUs) {
    const start = `${mRangeUs[3]}-${String(mRangeUs[1]).padStart(2, '0')}-${String(mRangeUs[2]).padStart(2, '0')}`;
    const end = `${mRangeUs[6]}-${String(mRangeUs[4]).padStart(2, '0')}-${String(mRangeUs[5]).padStart(2, '0')}`;
    return {
      matched: true,
      where: `WHERE dateCameIn >= DATE('${start}')
             AND dateCameIn < DATE_ADD(DATE('${end}'), INTERVAL 1 DAY)`,
      label: makeLabel('range', start, end, lang),
    };
  }

  // Trimestre: Q1 2025 / primer trimestre 2025
  const mQuarter =
    q.match(/\bq([1-4])\s*(19\d{2}|20\d{2})\b/) ||
    q.match(/\b(1er|primer|first)\s+(trimestre|quarter)\s*(19\d{2}|20\d{2})\b/) ||
    q.match(/\b(2do|segundo|second)\s+(trimestre|quarter)\s*(19\d{2}|20\d{2})\b/) ||
    q.match(/\b(3er|tercer|third)\s+(trimestre|quarter)\s*(19\d{2}|20\d{2})\b/) ||
    q.match(/\b(4to|cuarto|fourth)\s+(trimestre|quarter)\s*(19\d{2}|20\d{2})\b/);

  if (mQuarter) {
    let qNum, yNum;

    if (mQuarter[0].startsWith('q')) {
      qNum = parseInt(mQuarter[1], 10);
      yNum = parseInt(mQuarter[2], 10);
    } else {
      const s = mQuarter[1] || '';
      if (String(s).includes('1') || s === 'primer' || s === 'first') qNum = 1;
      else if (String(s).includes('2') || s === 'segundo' || s === 'second') qNum = 2;
      else if (String(s).includes('3') || s === 'tercer' || s === 'third') qNum = 3;
      else qNum = 4;
      yNum = parseInt(mQuarter[mQuarter.length - 1], 10);
    }

    const startMonth = (qNum - 1) * 3 + 1; // 1,4,7,10
    const start = `${yNum}-${String(startMonth).padStart(2, '0')}-01`;

    return {
      matched: true,
      where: `WHERE dateCameIn >= DATE('${start}')
             AND dateCameIn < DATE_ADD(DATE('${start}'), INTERVAL 3 MONTH)`,
      label: makeLabel('quarters', qNum, yNum, lang),
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
      const start = `${yearNum}-${String(monthNum).padStart(2, '0')}-01`;
      return {
        matched: true,
        where: `WHERE dateCameIn >= DATE('${start}')
               AND dateCameIn < DATE_ADD(DATE('${start}'), INTERVAL 1 MONTH)`,
        label: makeLabel('month_year', monthLabel(monthNum, lang), yearNum, lang),
      };
    }
  }

  // Mes solo: "marzo" -> el mes más reciente ya pasado (si aún no llega este año, usa año anterior)
  const mMonthOnly = q.match(
    /\b(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|sept|octubre|noviembre|diciembre|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b/
  );
  if (mMonthOnly && !mMonthYearWord) {
    const monthNum = monthNameToNumber(mMonthOnly[1]);
    if (monthNum) {
      const mm = String(monthNum).padStart(2, '0');
      return {
        matched: true,
        where: `WHERE dateCameIn >= STR_TO_DATE(CONCAT(
                  IF(${monthNum} <= MONTH(CURDATE()), YEAR(CURDATE()), YEAR(CURDATE())-1),
                  '-${mm}-01'
                ), '%Y-%m-%d')
               AND dateCameIn < DATE_ADD(STR_TO_DATE(CONCAT(
                  IF(${monthNum} <= MONTH(CURDATE()), YEAR(CURDATE()), YEAR(CURDATE())-1),
                  '-${mm}-01'
                ), '%Y-%m-%d'), INTERVAL 1 MONTH)`,
        label: makeLabel('month_only', monthLabel(monthNum, lang), null, lang),
      };
    }
  }

  // Año específico: 2025
  const mYear = q.match(/\b(19\d{2}|20\d{2})\b/);
  if (mYear) {
    const y = parseInt(mYear[1], 10);
    return {
      matched: true,
      where: `WHERE dateCameIn >= DATE('${y}-01-01')
             AND dateCameIn < DATE('${y + 1}-01-01')`,
      label: makeLabel('year', y, null, lang),
    };
  }

  // Fallback controlado (SOLO si tú lo pides)
  if (!matched && Number.isInteger(defaultWindowDays) && defaultWindowDays > 0) {
    return {
      matched: true,
      where: `WHERE dateCameIn >= DATE_SUB(CURDATE(), INTERVAL ${defaultWindowDays} DAY)`,
      label: makeLabel('default_days', defaultWindowDays, null, lang),
    };
  }

  return { matched, where, label };
}

function buildKpiPackSql(message, opts = {}) {
  const lang = opts.lang === 'es' ? 'es' : 'en';

  // ✅ NO asumir 90 días. Si quieres fallback, pásalo explícito:
  // buildKpiPackSql(msg, { lang:'es', person, defaultWindowDays: 90 })
  const w = extractTimeWindow(message, lang, opts.defaultWindowDays ?? null);

  // quitar WHERE para poder concatenar más filtros
  const timeClause = String(w.where || '').trim().toUpperCase().startsWith('WHERE ')
    ? String(w.where || '').trim().slice(6).trim()
    : String(w.where || '').trim();

  // ✅ IMPORTANTE: NO meter '' como primer elemento (eso te rompe el WHERE y afecta nombres)
  const whereParts = [];
  const params = [];

  if (timeClause) whereParts.push(timeClause);

  // filtro persona (submitterName/intakeSpecialist/attorney)
  if (opts.person?.value) {
    const val = String(opts.person.value || '').trim();
    if (val) {
      if (!opts.person.column || opts.person.column === 'submitterName') {
        whereParts.push(
          "LOWER(TRIM(COALESCE(NULLIF(submitterName,''), submitter))) LIKE CONCAT('%', LOWER(TRIM(?)), '%')"
        );
        params.push(val);
      } else if (opts.person.column === 'intakeSpecialist') {
        whereParts.push("LOWER(TRIM(intakeSpecialist)) LIKE CONCAT('%', LOWER(TRIM(?)), '%')");
        params.push(val);
      } else if (opts.person.column === 'attorney') {
        whereParts.push("LOWER(TRIM(attorney)) LIKE CONCAT('%', LOWER(TRIM(?)), '%')");
        params.push(val);
      }
    }
  }

  const whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

  const sql = `
SELECT
  COUNT(*) AS gross_cases,
  SUM(CASE WHEN Confirmed=1 THEN 1 ELSE 0 END) AS confirmed_cases,
  ROUND(100 * SUM(CASE WHEN Confirmed=1 THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 2) AS confirmed_rate,
  ROUND(SUM(COALESCE(convertedValue,0)), 2) AS case_converted_value,
  SUM(CASE WHEN Status LIKE '%DROP%' THEN 1 ELSE 0 END) AS dropped_cases,
  ROUND(100 * SUM(CASE WHEN Status LIKE '%DROP%' THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 2) AS dropped_rate,
  SUM(CASE WHEN Status LIKE '%PROBLEM%' THEN 1 ELSE 0 END) AS problem_cases,
  ROUND(100 * SUM(CASE WHEN Status LIKE '%PROBLEM%' THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 2) AS problem_rate,
  SUM(CASE WHEN Confirmed=1 AND Status LIKE '%PROBLEM%' THEN 1 ELSE 0 END) AS leakage_confirmed_problem,
  SUM(CASE WHEN Confirmed=1 AND Status LIKE '%DROP%' THEN 1 ELSE 0 END) AS leakage_confirmed_dropped_status,
  SUM(CASE WHEN Confirmed=1 AND ClinicalStatus LIKE '%DROP%' THEN 1 ELSE 0 END) AS leakage_confirmed_clinical_dropped
FROM performance_data.dmLogReportDashboard
${whereClause};
`.trim();

  return {
    sql,
    params,
    windowLabel: w.label,
    timeMatched: !!w.matched,
  };
}

module.exports = { buildKpiPackSql, extractTimeWindow };
