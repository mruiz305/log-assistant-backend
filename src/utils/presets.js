/* =========================================================
   PRESETS (quick prompts)
========================================================= */

function presetToCanonicalMessage(preset, uiLang) {
  const es = uiLang === 'es';
  switch (preset) {
    case 'confirmed_month':
      return es ? 'confirmados este mes' : 'confirmed this month';
    case 'best_confirmation_year':
      return es ? 'mejor confirmación este año' : 'best confirmation this year';
    case 'dropped_last_3_months':
      return es ? 'dropped últimos 90 días' : 'dropped last 90 days';
    case 'summary_week':
      return es ? 'resumen últimos 7 días' : 'summary last 7 days';
    case 'credit_month':
      return es ? 'crédito este mes' : 'credit this month';
    case 'dropped_today_office':
      return es ? 'dropped hoy por oficina' : 'dropped today by office';
    default:
      return null;
  }
}

function presetToDeterministicSql(preset) {
  switch (preset) {
    case 'dropped_today_office':
      return `
        SELECT
          OfficeName,
          COUNT(*) AS dropped_cases
        FROM dmLogReportDashboard
        WHERE Status = 'DROPPED'
          AND dateCameIn >= CURDATE()
        GROUP BY OfficeName
        ORDER BY dropped_cases DESC
        LIMIT 12
      `.trim();

    case 'best_confirmation_year':
      return `
        SELECT
          TRIM(COALESCE(NULLIF(submitterName,''), submitter)) AS submitter,
          COUNT(*) AS gross_cases,
          SUM(CASE WHEN Confirmed=1 THEN 1 ELSE 0 END) AS confirmed_cases,
          ROUND( (SUM(CASE WHEN Confirmed=1 THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0)) * 100, 2) AS confirmed_rate
        FROM dmLogReportDashboard
        WHERE dateCameIn >= DATE_FORMAT(CURDATE(), '%Y-01-01')
          AND dateCameIn <  DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-01-01'), INTERVAL 1 YEAR)
        GROUP BY TRIM(COALESCE(NULLIF(submitterName,''), submitter))
        HAVING gross_cases >= 30
        ORDER BY confirmed_rate DESC, confirmed_cases DESC
        LIMIT 12
      `.trim();

    case 'confirmed_month':
      return `
        SELECT
          COUNT(*) AS gross_cases,
          SUM(CASE WHEN Confirmed=1 THEN 1 ELSE 0 END) AS confirmed_cases,
          ROUND((SUM(CASE WHEN Confirmed=1 THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0))*100, 2) AS confirmed_rate
        FROM dmLogReportDashboard
        WHERE dateCameIn >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
          AND dateCameIn <  DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)
      `.trim();

    case 'credit_month':
      return `
        SELECT
          COUNT(*) AS gross_cases,
          SUM(CASE WHEN Confirmed=1 THEN 1 ELSE 0 END) AS confirmed_cases,
          ROUND((SUM(CASE WHEN Confirmed=1 THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0))*100, 2) AS confirmed_rate,
          SUM(convertedValue) AS case_converted_value
        FROM dmLogReportDashboard
        WHERE dateCameIn >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
          AND dateCameIn <  DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)
      `.trim();

    case 'summary_week':
      return `
        SELECT
          DATE(dateCameIn) AS dayKey,
          DATE_FORMAT(dateCameIn, '%a %d') AS day,
          COUNT(*) AS gross_cases,
          SUM(CASE WHEN Confirmed=1 THEN 1 ELSE 0 END) AS confirmed_cases,
          SUM(CASE WHEN Status='DROPPED' THEN 1 ELSE 0 END) AS dropped_cases,
          SUM(CASE WHEN Status='PROBLEM' THEN 1 ELSE 0 END) AS problem_cases,
          SUM(CASE WHEN Confirmed=0 AND Status LIKE '%ACTI%' THEN 1 ELSE 0 END) AS active_cases,
          SUM(CASE WHEN Confirmed=0 AND Status LIKE '%REF%' THEN 1 ELSE 0 END) AS referout_cases
        FROM dmLogReportDashboard
        WHERE dateCameIn >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
          AND dateCameIn <  DATE_ADD(CURDATE(), INTERVAL 1 DAY)
        GROUP BY DATE(dateCameIn), DATE_FORMAT(dateCameIn, '%a %d')
        ORDER BY dayKey ASC
      `.trim();

    case 'dropped_last_3_months':
      return `
        SELECT
          YEAR(dateCameIn) AS anio,
          MONTH(dateCameIn) AS mes,
          COUNT(*) AS gross_cases,
          SUM(CASE WHEN Confirmed=1 THEN 1 ELSE 0 END) AS confirmed_cases,
          SUM(CASE WHEN Status='DROPPED' THEN 1 ELSE 0 END) AS dropped_cases,
          SUM(CASE WHEN Status='PROBLEM' THEN 1 ELSE 0 END) AS problem_cases,
          SUM(CASE WHEN Confirmed=0 AND Status LIKE '%ACTI%' THEN 1 ELSE 0 END) AS active_cases,
          SUM(CASE WHEN Confirmed=0 AND Status LIKE '%REF%' THEN 1 ELSE 0 END) AS referout_cases
        FROM dmLogReportDashboard
        WHERE dateCameIn >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)
          AND dateCameIn <  DATE_ADD(CURDATE(), INTERVAL 1 DAY)
        GROUP BY YEAR(dateCameIn), MONTH(dateCameIn)
        ORDER BY anio ASC, mes ASC
      `.trim();

    default:
      return null;
  }
}

module.exports  = {
  presetToCanonicalMessage,
  presetToDeterministicSql,
};  