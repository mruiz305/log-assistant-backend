function wantsPdfLinks(message = '') {
  return /(pdf|url|link|enlace|log\b|logs\b|log completo|full log|roster|reporte|report|details)/i.test(
    String(message || '')
  );
}

async function findUserPdfCandidates(pool, text = '', limit = 8) {
  const q = String(text || '').trim();
  if (!q) return [];

  const parts = q.split(/\s+/).filter(Boolean).slice(0, 3); // 
  console.log('PDFLINKS_CANDIDATE_PARTS =>', parts);
  const likeConds = parts
    .map(() => `
      (LOWER(TRIM(name)) LIKE CONCAT('%', LOWER(TRIM(?)), '%')
       OR LOWER(TRIM(nick)) LIKE CONCAT('%', LOWER(TRIM(?)), '%'))
    `.trim())
    .join(' AND ');

  const params = [];
  for (const p of parts) params.push(p, p);

  const sql = `
    SELECT
      id,
      name,
      nick,
      email,
      logsIndividualFile,
      rosterIndividualFile
    FROM stg_g_users
    WHERE ${likeConds}
    ORDER BY name ASC
    LIMIT ${Number(limit) || 8}
  `.trim();
console.log('\nPDFLINKS_CANDIDATES_SQL =>', sql);
console.log('PDFLINKS_CANDIDATES_PARAMS =>', params);
  const [rows] = await pool.query(sql, params);

  console.log('PDFLINKS_CANDIDATES_ROWS =>', rows);
  return Array.isArray(rows) ? rows : [];
}

module.exports = {
  findUserPdfCandidates,
};


function normalizeText(s = '') {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractPersonPhrase(message = '') {
  const raw = String(message || '');
  const n = normalizeText(raw);

  const patterns = [
    /(?:give me|show me|get me)\s+(.*?)\s+(?:log|logs|pdf|roster|report|details)\b/i,
    /(?:dame|muestrame|muestrame|mostrar|ensename|quiero)\s+(.*?)\s+(?:log|logs|pdf|roster|reporte|report|detalles)\b/i,
  ];

  for (const rx of patterns) {
    const m = n.match(rx);
    if (m && m[1]) {
      const phrase = m[1].trim();
      if (phrase.length >= 2) return phrase;
    }
  }

  // fallback: quita palabras típicas, pero OJO: aquí NO filtramos todavía
  return n
    .replace(
      /\b(give|me|the|show|get|dame|el|la|los|las|de|del|para|por|un|una|log|logs|pdf|roster|reporte|report|details|detalles|completo)\b/g,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim();
}
function buildTokens(phrase = '') {
  // stopwords (ES/EN)
  const stop = new Set([
    'give', 'me', 'the', 'show', 'get',
    'dame', 'muestrame', 'mostrar', 'ensename', 'quiero',
    'log', 'logs', 'pdf', 'roster', 'reporte', 'report', 'details', 'detalles', 'completo',
    'de', 'del', 'la', 'el', 'los', 'las', 'por', 'para', 'un', 'una',
  ]);

  const tokens = normalizeText(phrase)
    .split(' ')
    .map((x) => x.trim())
    .filter(Boolean)
    // ✅ clave: quitamos stopwords aunque sean cortas (como "de")
    .filter((x) => !stop.has(x))
    // ✅ clave: ignoramos tokens muy cortos
    .filter((x) => x.length >= 2);

  // quita duplicados
  return [...new Set(tokens)];
}


/**
 * Resuelve un usuario desde stg_g_users.
 * Estrategia:
 * - Extrae frase de persona del mensaje
 * - Busca por exact match (name/nick)
 * - Busca por frase LIKE
 * - Busca por tokens (AND) para tolerar variantes
 * - Ordena por score y trae el mejor
 */
async function findUserPdfCandidates(pool, text = '', limit = 8) {
  const message = String(text || '').trim();
  if (!message) return [];

  const phrase = extractPersonPhrase(message);
  const tokens = buildTokens(phrase);

  console.log('\nPDFLINKS_LOOKUP =>', phrase);
  console.log('PDFLINKS_CANDIDATE_PARTS =>', tokens);

  // si no hay tokens, no hay forma confiable
  if (!tokens.length) return [];

  const andConds = tokens.slice(0, 4).map(() => {
    return `(LOWER(TRIM(name)) LIKE CONCAT('%', LOWER(TRIM(?)), '%')
          OR LOWER(TRIM(nick)) LIKE CONCAT('%', LOWER(TRIM(?)), '%'))`;
  });

  const sql = `
    SELECT
      id,
      name,
      nick,
      email,
      logsIndividualFile,
      rosterIndividualFile
    FROM stg_g_users
    WHERE ${andConds.join(' AND ')}
    ORDER BY name ASC
    LIMIT ${Number(limit) || 8}
  `.trim();

  const params = [];
  for (const tk of tokens.slice(0, 4)) params.push(tk, tk);

  console.log('\nPDFLINKS_CANDIDATES_SQL =>', sql);
  console.log('PDFLINKS_CANDIDATES_PARAMS =>', params);

  const [rows] = await pool.query(sql, params);
  console.log('PDFLINKS_CANDIDATES_ROWS =>', Array.isArray(rows) ? rows.length : 0);

  return Array.isArray(rows) ? rows : [];
}

async function findUserPdfLinks(pool, text = '') {
  const cands = await findUserPdfCandidates(pool, text, 8);
  return cands && cands[0] ? cands[0] : null;
}

module.exports = {
  wantsPdfLinks,
  findUserPdfLinks,
  findUserPdfCandidates,
};
