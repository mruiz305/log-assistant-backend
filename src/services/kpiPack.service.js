/* ============================================================
   KPI Pack SQL Builder
   - 1 fila con KPIs (gross, confirmados, dropped, problem, leakage, crédito)
   - Usa dateCameIn como fecha principal
   - Reusa rangos de tiempo desde la pregunta (ES/EN)
   - Soporta filtro de persona: submitterName/intakeSpecialist/attorney (LIKE)
   ============================================================ */

function normalizeText(s = '') {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function detectWindow(message = '', lang = 'en') {
  const q = normalizeText(message);

  // WEEK
  if (q.includes('week') || q.includes('semana') || q.includes('weekly')) {
    return {
      where: "dateCameIn >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)",
      label: lang === 'es' ? 'últimos 7 días' : 'last 7 days',
    };
  }

  // MONTH (current month)
  if (q.includes('month') || q.includes('mes') || q.includes('mensual')) {
    return {
      where: "dateCameIn >= DATE_FORMAT(CURDATE(), '%Y-%m-01')",
      label: lang === 'es' ? 'mes actual' : 'current month',
    };
  }

  // YEAR (current year)
  if (q.includes('year') || q.includes('año') || q.includes('anual')) {
    return {
      where: "YEAR(dateCameIn) = YEAR(CURDATE())",
      label: lang === 'es' ? 'año actual' : 'current year',
    };
  }

  // DEFAULT
  return {
    where: "dateCameIn >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)",
    label: lang === 'es' ? 'últimos 90 días' : 'last 90 days',
  };
}

function makeLabel(kind, n, lang) {
  const L = lang === 'es' ? 'es' : 'en';

  if (kind === 'days') return L === 'es' ? `últimos ${n} días` : `last ${n} days`;
  if (kind === 'months') return L === 'es' ? `últimos ${n} meses` : `last ${n} months`;
  if (kind === 'this_month') return L === 'es' ? 'este mes' : 'this month';
  if (kind === 'last_month') return L === 'es' ? 'último mes' : 'last month';
  if (kind === 'today') return L === 'es' ? 'hoy' : 'today';
  if (kind === 'this_week') return L === 'es' ? 'esta semana' : 'this week';

  return L === 'es' ? 'últimos 90 días' : 'last 90 days';
}

function extractTimeWindow(question, lang = 'es') {
  const q = normalizeText(question);

  let where = `WHERE dateCameIn >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)`;
  let label = makeLabel('default', 90, lang);

  // Today (EN/ES)
  if (q.includes('hoy') || q.includes('today')) {
    where = `WHERE dateCameIn >= CURDATE()`;
    label = makeLabel('today', 0, lang);
    return { where, label };
  }

  // This week (Mon..Sun) (EN/ES)
  if (q.includes('esta semana') || q.includes('this week')) {
    where = `WHERE dateCameIn >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)`;
    label = makeLabel('this_week', 0, lang);
    return { where, label };
  }

  const mDays =
    q.match(/(?:ultim(?:os|as))\s+(\d{1,3})\s+dias?/) ||
    q.match(/(?:last|past)\s+(\d{1,3})\s+days?/);

  if (mDays) {
    const n = parseInt(mDays[1], 10);
    if (!Number.isNaN(n) && n > 0) {
      where = `WHERE dateCameIn >= DATE_SUB(CURDATE(), INTERVAL ${n} DAY)`;
      label = makeLabel('days', n, lang);
      return { where, label };
    }
  }

  const mMonths =
    q.match(/(?:ultim(?:os|as))\s+(\d{1,2})\s+mes(?:es)?/) ||
    q.match(/(?:last|past)\s+(\d{1,2})\s+months?/);

  if (mMonths) {
    const n = parseInt(mMonths[1], 10);
    if (!Number.isNaN(n) && n > 0) {
      where = `WHERE dateCameIn >= DATE_SUB(CURDATE(), INTERVAL ${n} MONTH)`;
      label = makeLabel('months', n, lang);
      return { where, label };
    }
  }

  if (q.includes('ultimo mes') || q.includes('último mes') || q.includes('last month')) {
    where = `WHERE dateCameIn >= DATE_SUB(CURDATE(), INTERVAL 1 MONTH)`;
    label = makeLabel('last_month', 1, lang);
    return { where, label };
  }

  if (q.includes('este mes') || q.includes('this month') || q.includes('current month')) {
    where = `WHERE dateCameIn >= DATE_FORMAT(CURDATE(), '%Y-%m-01')`;
    label = makeLabel('this_month', 0, lang);
    return { where, label };
  }

  return { where, label };
}

function buildPersonWhere(person) {
  if (!person || !person.value) return { clause: '', params: [] };

  const v = String(person.value || '').trim();
  if (!v) return { clause: '', params: [] };

  // Por defecto: submitterName (pero realmente usamos COALESCE(submitterName,submitter))
  if (!person.column || person.column === 'submitterName') {
    return {
      clause: `
        AND LOWER(TRIM(COALESCE(NULLIF(submitterName,''), submitter)))
          LIKE CONCAT('%', LOWER(TRIM(?)), '%')
      `.trim(),
      params: [v],
    };
  }

  if (person.column === 'intakeSpecialist') {
    return {
      clause: `
        AND LOWER(TRIM(intakeSpecialist))
          LIKE CONCAT('%', LOWER(TRIM(?)), '%')
      `.trim(),
      params: [v],
    };
  }

  if (person.column === 'attorney') {
    return {
      clause: `
        AND LOWER(TRIM(attorney))
          LIKE CONCAT('%', LOWER(TRIM(?)), '%')
      `.trim(),
      params: [v],
    };
  }

  return { clause: '', params: [] };
}

function buildKpiPackSql(message, opts = {}) {
  const lang = opts.lang === 'es' ? 'es' : 'en';
  const w = detectWindow(message, lang);

  const whereParts = [w.where];
  const params = [];

  // ✅ filtro persona si viene (submitterName/intake/attorney)
  if (opts.person?.value) {
    const val = String(opts.person.value || '').trim();

    if (opts.person.column === 'submitterName') {
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

  return { sql, params, windowLabel: w.label };
}


module.exports = { buildKpiPackSql };
