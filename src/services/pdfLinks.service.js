function wantsPdfLinks(message = '') {
  return /(pdf|url|link|enlace|log\b|logs\b|log completo|full log|roster|reporte|report|details)/i.test(
    String(message || '')
  );
}

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
  // Intento: extraer lo que está entre "give me|dame|mostrar|show" y "log|logs|pdf|roster|report"
  const raw = String(message || '');
  const n = normalizeText(raw);

  // patrones EN/ES
  const patterns = [
    /(?:give me|show me|get me)\s+(.*?)\s+(?:log|logs|pdf|roster|report|details)\b/i,
    /(?:dame|muestrame|mostrar|ensename|quiero)\s+(.*?)\s+(?:log|logs|pdf|roster|reporte|report|detalles)\b/i,
  ];

  for (const rx of patterns) {
    const m = n.match(rx);
    if (m && m[1]) {
      const phrase = m[1].trim();
      if (phrase.length >= 3) return phrase;
    }
  }

  // fallback: quitar palabras típicas y quedarse con lo que parece nombre
  return n
    .replace(/\b(give|me|the|show|get|dame|el|la|los|las|de|del|para|por|un|una|log|logs|pdf|roster|reporte|report|details)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildTokens(phrase = '') {
  const stop = new Set([
    'give','me','the','show','get','dame','muestrame','mostrar','quiero',
    'log','logs','pdf','roster','reporte','report','details',
    'de','del','la','el','los','las','por','para','un','una'
  ]);

  const tokens = normalizeText(phrase)
    .split(' ')
    .map((x) => x.trim())
    .filter((x) => x.length >= 3 && !stop.has(x));

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
async function findUserPdfLinks(pool, text = '') {
  const message = String(text || '').trim();
  if (!message) return null;

  const phrase = extractPersonPhrase(message);
  const tokens = buildTokens(phrase);

  // Si no hay tokens útiles, no busques
  if (!phrase || phrase.length < 3) return null;

  // armamos condiciones por tokens (AND)
  const tokenConds = [];
  const tokenParams = [];

  for (const tk of tokens.slice(0, 4)) { // máximo 4 tokens para no exagerar
    tokenConds.push(
      `(LOWER(TRIM(name)) LIKE CONCAT('%', ?, '%') OR LOWER(TRIM(nick)) LIKE CONCAT('%', ?, '%'))`
    );
    tokenParams.push(tk, tk);
  }

  const sql = `
    SELECT
      email, name, nick, logsIndividualFile, rosterIndividualFile,

      (
        CASE
          WHEN LOWER(TRIM(name)) = LOWER(TRIM(?)) THEN 100
          WHEN LOWER(TRIM(nick)) = LOWER(TRIM(?)) THEN 95
          WHEN LOWER(TRIM(name)) LIKE CONCAT('%', LOWER(TRIM(?)), '%') THEN 80
          WHEN LOWER(TRIM(nick)) LIKE CONCAT('%', LOWER(TRIM(?)), '%') THEN 75
          ELSE 0
        END
        +
        ${tokenConds.length ? `(${tokenConds.map(() => '10').join(' + ')})` : '0'}
      ) AS score

    FROM stg_g_users
    WHERE
      LOWER(TRIM(name)) = LOWER(TRIM(?))
      OR LOWER(TRIM(nick)) = LOWER(TRIM(?))
      OR LOWER(TRIM(name)) LIKE CONCAT('%', LOWER(TRIM(?)), '%')
      OR LOWER(TRIM(nick)) LIKE CONCAT('%', LOWER(TRIM(?)), '%')
      ${tokenConds.length ? `OR (${tokenConds.join(' AND ')})` : ''}

    ORDER BY score DESC
    LIMIT 1
  `.trim();

  const params = [
    phrase, phrase, phrase, phrase, // score checks
    phrase, phrase, phrase, phrase, // WHERE checks
    ...tokenParams,                 // tokens
  ];

  console.log('\nPDFLINKS_LOOKUP_MESSAGE =>', message);
  console.log('PDFLINKS_EXTRACTED_PHRASE =>', phrase);
  console.log('PDFLINKS_TOKENS =>', tokens);
  console.log('PDFLINKS_SQL =>', sql);
  console.log('PDFLINKS_PARAMS =>', params);

  const [u] = await pool.query(sql, params);
  return u && u[0] ? u[0] : null;
}

module.exports = { wantsPdfLinks, findUserPdfLinks };
