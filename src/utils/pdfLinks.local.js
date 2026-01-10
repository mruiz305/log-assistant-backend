/* =========================================================
   PDF/LINKS HELPERS (local fallback)
========================================================= */

function wantsLinksLocal(message = '') {
  return /(pdf|url|link|enlace|log\b|logs\b|log completo|full log|details|roster|reporte|report)/i.test(
    String(message || '')
  );
}

function extractNameFromLogRequest(message = '') {
  const cleaned = String(message || '')
    .replace(/(give me|please|por favor|dame|mu[eé]strame|send me)/gi, ' ')
    .replace(/\b(the|el|la|los|las)\b/gi, ' ')
    .replace(/\b(log|logs|pdf|link|url|roster|reporte|report|details|completo)\b/gi, ' ')
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned.length >= 3 ? cleaned : null;
}

async function findSubmitterCandidates(pool, rawName, limit = 8) {
  const name = String(rawName || '').trim();
  if (!name) return [];

  const parts = name.split(/\s+/).filter(Boolean).slice(0, 3);
  if (parts.length === 0) return [];

  const likeConds = parts
    .map(
      () => `
    LOWER(TRIM(COALESCE(NULLIF(submitterName,''), submitter))) LIKE CONCAT('%', LOWER(TRIM(?)), '%')
  `
    )
    .join(' AND ');

  const sql = `
    SELECT
      TRIM(COALESCE(NULLIF(submitterName,''), submitter)) AS submitter,
      COUNT(*) AS cnt
    FROM dmLogReportDashboard
    WHERE ${likeConds}
    GROUP BY TRIM(COALESCE(NULLIF(submitterName,''), submitter))
    ORDER BY cnt DESC
    LIMIT ${Number(limit) || 8}
  `.trim();

  const [rows] = await pool.query(sql, parts);
  return Array.isArray(rows) ? rows : [];
}
module.exports = { wantsLinksLocal, extractNameFromLogRequest, findSubmitterCandidates };
