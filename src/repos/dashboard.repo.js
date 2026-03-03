
const sqlRepo = require("./sql.repo");

async function getTopRepsMTD(limit = 10) {
  const sql = `
    SELECT
      TRIM(submitterName) AS name,
      COUNT(*) AS ttd,
      SUM(CASE WHEN confirmed = 1 THEN 1 ELSE 0 END) AS confirmed,
      ROUND(
        (SUM(CASE WHEN confirmed = 1 THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0)) * 100,
        2
      ) AS confirmationRate,
      ROUND(SUM(COALESCE(convertedValue, 0)), 2) AS convertedValue
    FROM performance_data.dmLogReportDashboard
    WHERE dateCameIn >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
      AND dateCameIn <  DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)
      AND TRIM(submitterName) <> ''
    GROUP BY TRIM(submitterName)
    ORDER BY ttd DESC, convertedValue DESC, confirmed DESC
    LIMIT ?
  `.trim();

  return sqlRepo.query(sql, [Number(limit) || 10]);
}

// básico 
async function getMonthKpisBasic() {
  const sql = `
    SELECT
      COUNT(*) AS total,
      ROUND(SUM(COALESCE(convertedValue,0)), 2) AS convertedValue,
      SUM(CASE WHEN confirmed = 1 THEN 1 ELSE 0 END) AS confirmed,
      SUM(CASE WHEN dropped = 1 THEN 1 ELSE 0 END) AS dropped
    FROM performance_data.dmLogReportDashboard
    WHERE dateCameIn >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
      AND dateCameIn <  DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)
  `.trim();

  const rows = await sqlRepo.query(sql);
  return rows?.[0] || null;
}

// src/repos/dashboard.repo.js
const sqlRepo = require("./sql.repo");

async function getMonthKpisMTD() {
  const sql = `
    SELECT
      COUNT(*) AS total,
      ROUND(SUM(COALESCE(convertedValue,0)), 2) AS conversionValue,
      SUM(CASE WHEN confirmed = 1 THEN 1 ELSE 0 END) AS confirmed,
      ROUND(
        (SUM(CASE WHEN confirmed = 1 THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0)) * 100,
        2
      ) AS confirmationRate,

      SUM(CASE WHEN LOWER(TRIM(status)) = 'dropped' THEN 1 ELSE 0 END) AS dropped,
      ROUND(
        (SUM(CASE WHEN LOWER(TRIM(status)) = 'dropped' THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0)) * 100,
        2
      ) AS droppedRate,

      SUM(CASE WHEN LOWER(TRIM(status)) = 'active' THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN LOWER(TRIM(status)) IN ('referout','refer out','refer-out','ref out') THEN 1 ELSE 0 END) AS referOut,
      SUM(CASE WHEN LOWER(TRIM(status)) LIKE '%problem%' THEN 1 ELSE 0 END) AS problemCases,

      ROUND(SUM(COALESCE(convertedValue, 0)), 2) AS convertedValue
    FROM performance_data.dmLogReportDashboard
    WHERE dateCameIn >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
      AND dateCameIn <  DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)
  `.trim();

  const rows = await sqlRepo.query(sql);
  const k = rows?.[0] || {};

  return {
    total: Number(k.total || 0),
    confirmed: Number(k.confirmed || 0),
    confirmationRate: Number(k.confirmationRate || 0),
    dropped: Number(k.dropped || 0),
    droppedRate: Number(k.droppedRate || 0),
    active: Number(k.active || 0),
    referOut: Number(k.referOut || 0),
    problemCases: Number(k.problemCases || 0),
    convertedValue: Number(k.convertedValue || 0),
    conversionValue: Number(k.conversionValue || 0),
  };
}


async function getTopAttorneysMTD(limit = 10) {
  const sql = `
    SELECT
      TRIM(attorney) AS name,
      SUM(CASE WHEN confirmed = 1 THEN 1 ELSE 0 END) AS confirmed,
      COUNT(*) AS ttd,
      ROUND(SUM(COALESCE(convertedValue, 0)), 2) AS convertedValue
    FROM performance_data.dmLogReportDashboard
    WHERE dateCameIn >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
      AND dateCameIn <  DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)
      AND TRIM(attorney) <> ''
    GROUP BY TRIM(attorney)
    ORDER BY confirmed DESC, convertedValue DESC, ttd DESC
    LIMIT ?
  `.trim();

  return sqlRepo.query(sql, [Number(limit) || 10]);
}

module.exports = {
  getTopRepsMTD,
  getMonthKpisBasic,
  getMonthKpisMTD,
  getTopAttorneysMTD,
};
