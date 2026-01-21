/* =========================================================
   DIMENSION FILTERS (Office/Team/Pod/etc)
========================================================= */

/**
 * Extrae el "valor" después de "oficina de X", "team de X", etc.
 * Heurística simple pero funciona perfecto para:
 * - "cuantos casos tiene la oficina de Alix Romero"
 * - "cases for team of Miami East"
 */
function cleanDimensionValue(raw = '') {
  let v = String(raw || '').trim();

  // Quitar puntuación final
  v = v.replace(/[?.!,]+$/g, '').trim();

  // Cortar frases típicas de periodo (en ES/EN)
  // Importante: lo hacemos al final del string, para no romper nombres.
  v = v.replace(
    /\s+(en\s+este\s+mes|este\s+mes|this\s+month|en\s+el\s+mes|del\s+mes|of\s+this\s+month)\s*$/i,
    ''
  ).trim();

  v = v.replace(
    /\s+(esta\s+semana|en\s+esta\s+semana|this\s+week|en\s+la\s+semana|of\s+this\s+week)\s*$/i,
    ''
  ).trim();

  v = v.replace(
    /\s+(hoy|today|ayer|yesterday)\s*$/i,
    ''
  ).trim();

  v = v.replace(
    /\s+(ultimos|últimos|last)\s+\d+\s+(dias|días|days)\s*$/i,
    ''
  ).trim();

  v = v.replace(
    /\s+(este\s+ano|este\s+año|this\s+year|ytd)\s*$/i,
    ''
  ).trim();

  // Quitar comillas si vienen
  v = v.replace(/^['"]+|['"]+$/g, '').trim();

  return v;
}

function extractDimensionFromMessage(message = '', uiLang = 'es') {
  const raw = String(message || '').trim();

  const patterns = [
    { key: 'office',   rx: /\b(oficina|office)\s+(de|of)\s+(.+)$/i, column: 'OfficeName' },
    { key: 'team',     rx: /\b(equipo|team)\s+(de|of)\s+(.+)$/i,   column: 'TeamName' },
    { key: 'pod',      rx: /\b(pod)\s+(de|of)\s+(.+)$/i,          column: 'PODEName' }, // ajusta si es PODName
    { key: 'region',   rx: /\b(region)\s+(de|of)\s+(.+)$/i,       column: 'RegionName' },
    { key: 'director', rx: /\b(director)\s+(de|of)\s+(.+)$/i,     column: 'DirectorName' },
    { key: 'attorney', rx: /\b(attorney|abogado)\s+(de|of)\s+(.+)$/i, column: 'attorney' },
    { key: 'intake',   rx: /\b(intake|intake specialist|locked down)\s+(de|of)\s+(.+)$/i, column: 'intakeSpecialist' },
    { key: 'submitter',rx: /\b(submitter|representante|agent|rep|entered by)\s+(de|of)\s+(.+)$/i, column: '__SUBMITTER__' },
  ];

  for (const p of patterns) {
    const m = raw.match(p.rx);
    if (m && m[3]) {
      const value = cleanDimensionValue(m[3]);

      if (value.length >= 2) {
        return { key: p.key, column: p.column, value };
      }
    }
  }

  return null;
}



/**
 * Inyecta un filtro LIKE en SQL (antes de GROUP BY/ORDER BY/LIMIT).
 * - Si hay WHERE -> agrega AND ...
 * - Si no hay WHERE -> crea WHERE ...
 *
 * OJO: Esto es “prudente” y funciona para el 95% de queries simples (tu caso).
 */
function injectLikeFilter(sql, column, value) {
  let s = String(sql || '').trim();
  if (!s || !column || !value) return s;

  // ✅ 1) quitar ; finales (uno o varios) para poder insertar AND sin romper SQL
  s = s.replace(/;\s*$/g, '');

  const esc = String(value).replace(/'/g, "''").trim();
  if (!esc) return s;

  // Submitter especial
  let cond = '';
  if (column === '__SUBMITTER__') {
    cond = `LOWER(TRIM(COALESCE(NULLIF(submitterName,''), submitter))) LIKE CONCAT('%', LOWER(TRIM('${esc}')), '%')`;
  } else {
    cond = `LOWER(TRIM(${column})) LIKE CONCAT('%', LOWER(TRIM('${esc}')), '%')`;
  }

  // ✅ si ya está aplicado, no duplicar
  const lower = s.toLowerCase();
  if (lower.includes(cond.toLowerCase())) return s;

  // ✅ insertar antes de GROUP BY / ORDER BY / LIMIT (si existen)
  const cutRx = /\b(group\s+by|order\s+by|limit)\b/i;
  const m = s.match(cutRx);
  const cutAt = m ? m.index : -1;

  const head = cutAt >= 0 ? s.slice(0, cutAt).trimEnd() : s;
  const tail = cutAt >= 0 ? s.slice(cutAt) : '';

  if (/\bwhere\b/i.test(head)) {
    s = `${head} AND ${cond}\n${tail}`.trim();
  } else {
    s = `${head}\nWHERE ${cond}\n${tail}`.trim();
  }

  // ✅ opcional: volver a poner ; si quieres (no es obligatorio)
  return s;
}
module.exports = { extractDimensionFromMessage, injectLikeFilter };