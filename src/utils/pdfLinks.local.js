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

/**
 * Convierte un nombre “sucio” en tokens útiles para búsqueda:
 * - soporta "Apellido, Nombre"
 * - quita signos/puntos
 * - separa por espacios / coma / guión
 * - elimina tokens muy cortos (ej: "a", "de")
 */
function tokenizeName(raw = '') {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
    // convierte coma/guion a espacio para tokenizar
    .replace(/[,/\\|]+/g, ' ')
    .replace(/[-]+/g, ' ')
    // quita puntos y signos raros
    .replace(/[.()]/g, ' ')
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!s) return [];

  const tokens = s
    .split(/\s+/)
    .map((x) => x.trim())
    .filter(Boolean)
    // descarta tokens muy cortos (pero deja "li", "al" si te sirve)
    .filter((x) => x.length >= 2)
    // corta a máximo 4 para no volver la query muy estricta
    .slice(0, 4);

  return tokens;
}

async function findSubmitterCandidates(pool, rawName, limit = 8) {
  const name = String(rawName || '').trim();
  if (!name) return [];

  // ✅ tokens por palabra (soporta coma / invertidos / guiones)
  const parts = tokenizeName(name);
  if (parts.length === 0) return [];

  // AND por tokens => “busca por palabra”, independiente del orden
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
