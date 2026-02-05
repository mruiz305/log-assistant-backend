// src/utils/dimensionResolver.js
const { DIMENSIONS } = require('../domain/dimensions/dimensionRegistry');

// Detecta si el mensaje tiene forma "oficina de X" (no "oficina Miami")
function isOfficeOfPersonPhrase(message = '', lang = 'es') {
  const s = String(message || '').trim();
  if (lang === 'es') return /\b(?:la\s+)?oficina\s+de\s+/i.test(s);
  return /\b(?:the\s+)?office\s+of\s+/i.test(s);
}

// Resuelve OfficeName a partir de un submitterName (persona)
async function resolveOfficeNameByPerson(poolConn, personName) {
  const p = String(personName || '').trim();
  if (!p) return null;

  const [rows] = await poolConn.query(
    `
    SELECT TRIM(OfficeName) AS officeName, COUNT(*) AS cnt
    FROM dmLogReportDashboard
    WHERE
      dateCameIn >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)
      AND TRIM(OfficeName) <> ''
      AND LOWER(TRIM(COALESCE(NULLIF(submitterName,''), submitter)))
          LIKE CONCAT('%', LOWER(TRIM(?)), '%')
    GROUP BY TRIM(OfficeName)
    ORDER BY cnt DESC
    LIMIT 1
    `.trim(),
    [p]
  );

  return rows?.[0]?.officeName ? String(rows[0].officeName).trim() : null;
}

/**
 * Entrada: { key, value } (del extractor)
 * Salida: { key, column, value, meta }
 */
async function resolveDimension(poolConn, extracted, message, lang = 'es') {
  if (!extracted?.key || !extracted?.value) return null;

  const key = String(extracted.key).trim();
  const rawValue = String(extracted.value).trim();

  const def = DIMENSIONS[key];
  if (!def?.column) return null;

  // ✅ Caso especial: "oficina de PERSONA" => resolver OfficeName real
  if (key === 'office' && isOfficeOfPersonPhrase(message, lang)) {
    const officeName = await resolveOfficeNameByPerson(poolConn, rawValue);
    if (officeName) {
      return {
        key: 'office',
        column: def.column,      // OfficeName
        value: officeName,       // ya resuelto
        meta: { resolvedFromPerson: rawValue },
      };
    }
    // si no pudo resolver, cae a comportamiento normal (OfficeName LIKE rawValue)
  }

  // Normal
  return { key, column: def.column, value: rawValue, meta: null };
}

module.exports = { resolveDimension };
