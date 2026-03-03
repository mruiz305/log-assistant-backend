
const sqlRepo = require("./sql.repo");

async function findPersonCandidates({ rawPerson, parts = [], limit = 8 }) {
  const safeLimit = Number(limit) || 8;

  // Si ya te pasan parts, úsalo. Si no, que el caller los arme.
  if (!Array.isArray(parts) || !parts.length) return [];

  const expr = "LOWER(TRIM(submitterName))";
  const likeConds = parts
    .slice(0, 6)
    .map(() => `${expr} LIKE CONCAT('%', LOWER(TRIM(?)), '%')`)
    .join(" AND ");

  const sql = `
    SELECT
      TRIM(submitterName) AS submitter,
      COUNT(*) AS cnt
    FROM dmLogReportDashboard
    WHERE
      dateCameIn >= DATE_SUB(CURDATE(), INTERVAL 180 DAY)
      AND TRIM(submitterName) <> ''
      AND (${likeConds})
    GROUP BY TRIM(submitterName)
    ORDER BY cnt DESC, submitter ASC
    LIMIT ${safeLimit}
  `.trim();

  return await sqlRepo.query(sql, parts.slice(0, 6));
}

module.exports = {
  findPersonCandidates,
};
