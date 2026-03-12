/**
 * Detecta lenguaje analítico/evaluativo. Si la pregunta es de este tipo,
 * NO debe ir a pdfLinks (usar flujo focus/performance en su lugar).
 */
function isAnalyticalQuestion(message = "") {
  const m = String(message || "").toLowerCase();
  const patterns = [
    /\bbased\s+(?:off|on)\b/,
    /\bwould\s+you\s+consider\b/,
    /\bfit\s+employee\b/,
    /\bworth\b/,
    /\bjustify\b/,
    /\bjustifies\b/,
    /\bmake\s+\d+k\b/,
    /\bsalary\b/,
    /\bcompensation\b/,
    /\bperformance\b/,
    /\b(?:how\s+)?(?:well|good)\s+(?:did|does)\b/,
    /\bcompare\s+(?:to|with)\b/,
    /\b(?:his|her|their)\s+logs?\s+(?:for|of)\b/,
    /\b(?:logs?|data)\s+for\s+\d{4}\b/,
  ];
  return patterns.some((rx) => rx.test(m));
}

/**
 * Solo true cuando el usuario pide EXPLÍCITAMENTE un archivo/PDF.
 * "logs" aislado (ej. "Tony's logs for 2025") NO cuenta.
 */
function isExplicitFileRequest(message = "") {
  const m = String(message || "").toLowerCase();
  // Patrones explícitos: pdf, file, link, roster, open pdf, send file, show log pdf, etc.
  const explicit = [
    /\bpdf\b/,
    /\bfile\b/,
    /\blink\b/,
    /\benlace\b/,
    /\burl\b/,
    /\broster\b/,
    /\bopen\s+(?:the\s+)?pdf\b/,
    /\bsend\s+(?:me\s+)?(?:the\s+)?(?:pdf|file)\b/,
    /\bshow\s+(?:me\s+)?(?:the\s+)?(?:log\s+)?pdf\b/,
    /\blog\s*\/\s*pdf\b/,
    /\b(?:give|get|show)\s+me\s+.*\b(?:pdf|roster|file)\b/,
    /\b(?:dame|muestrame|mostrar|quiero)\s+.*\b(?:pdf|archivo|roster|expediente)\b/,
  ];
  return explicit.some((rx) => rx.test(m));
}

function wantsPdfLinks(message = "") {
  const m = String(message || "").trim();
  if (!m) return false;
  // Preguntas analíticas/evaluativas NUNCA van a pdfLinks
  if (isAnalyticalQuestion(m)) return false;
  // Solo si pide explícitamente archivo/PDF
  return isExplicitFileRequest(m);
}

function normalizeText(s = "") {
  return String(s || "")
    .toLowerCase()
    .replace(/[’´`]/g, "'")
    .replace(/\b([a-z0-9]+)\s*'s\b/g, "$1") // tony's -> tony
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractPersonPhrase(message = "") {
  const raw = String(message || "");
  const n = normalizeText(raw);

  // "<name> logs for/of <date>"
  let m = n.match(/(.+?)\s+logs?\s+(?:for|of)\s+.+$/i);
  if (m && m[1]) {
    const phrase = m[1].trim();
    if (phrase.length >= 2) return phrase;
  }

  // "<name> logs de/para <algo>"
  m = n.match(/(.+?)\s+logs?\s+(?:de|del|para)\s+.+$/i);
  if (m && m[1]) {
    const phrase = m[1].trim();
    if (phrase.length >= 2) return phrase;
  }

  // "... logs de <nombre>"
  m = n.match(/\blogs?\s+(?:de|del|para)\s+(.+)$/i);
  if (m && m[1]) {
    const phrase = m[1].trim();
    if (phrase.length >= 2) return phrase;
  }

  // "... logs of/for <name>"
  m = n.match(/\blogs?\s+(?:of|for)\s+(.+)$/i);
  if (m && m[1]) {
    const phrase = m[1].trim();
    if (phrase.length >= 2) return phrase;
  }

  // "show me <name> logs" / "give me <name> pdf"
  const patterns = [
    /(?:give me|show me|get me)\s+(.*?)\s+(?:log|logs|pdf|roster|report|details)\b/i,
    /(?:dame|muestrame|mostrar|ensename|quiero)\s+(.*?)\s+(?:log|logs|pdf|roster|reporte|report|detalles)\b/i,
  ];

  for (const rx of patterns) {
    const mm = n.match(rx);
    if (mm && mm[1]) {
      const phrase = mm[1].trim();
      if (phrase.length >= 2) return phrase;
    }
  }

  // fallback
  const cleaned = n
    .replace(
      /\b(give|me|the|show|get|dame|el|la|los|las|de|del|para|por|un|una|log|logs|pdf|roster|reporte|report|details|detalles|completo|full)\b/g,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) {
    const m2 = n.match(/\b(?:de|for|of)\s+(.+)$/i);
    if (m2 && m2[1]) return m2[1].trim();
  }

  return cleaned;
}

function buildTokens(phrase = "") {
  const stop = new Set([
    "give","me","the","show","get",
    "dame","muestrame","mostrar","ensename","quiero",
    "log","logs","pdf","roster","reporte","report","details","detalles",
    "completo","full",
    "de","del","la","el","los","las","por","para","un","una",
    "of","for",
  ]);

  const months = new Set([
    "january","february","march","april","may","june","july","august","september","october","november","december",
    "enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","setiembre","octubre","noviembre","diciembre",
  ]);

  const tokens = normalizeText(phrase)
    .split(" ")
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => !stop.has(x))
    .filter((x) => !months.has(x))
    .filter((x) => !/^(19|20)\d{2}$/.test(x))
    .filter((x) => !/^\d{1,2}$/.test(x))
    .filter((x) => x.length >= 2);

  return [...new Set(tokens)];
}

function buildNeedle(token = "") {
  const tk = normalizeText(token);
  if (!tk) return null;
  return `%${tk}%`;
}

/**
 * Ahora este método espera sqlRepo (no mysql2 pool)
 * sqlRepo.query(sql, params) debe devolver rows (array)
 */
async function findUserPdfCandidates(sqlRepo, text = "", limit = 8) {
  const message = String(text || "").trim();
  if (!message) return [];

  const phrase = extractPersonPhrase(message);
  const tokens = buildTokens(phrase);

  console.log("\nPDFLINKS_LOOKUP =>", phrase);
  console.log("PDFLINKS_CANDIDATE_PARTS =>", tokens);

  if (!tokens.length) return [];

  // Construye AND por token, pero usando LIKE ? con %token% ya armado
  const andConds = tokens.slice(0, 4).map(
    () => `(LOWER(TRIM(name)) LIKE ? OR LOWER(TRIM(nick)) LIKE ?)`
  );

  const sql = `
    SELECT
      id,
      name,
      nick,
      email,
      logsIndividualFile,
      rosterIndividualFile
    FROM stg_g_users
    WHERE ${andConds.join(" AND ")}
    ORDER BY name ASC
    LIMIT ${Number(limit) || 8}
  `.trim();

  const params = [];
  for (const tk of tokens.slice(0, 4)) {
    const needle = buildNeedle(tk);
    if (!needle) continue;
    params.push(needle, needle);
  }

  console.log("\nPDFLINKS_CANDIDATES_SQL =>", sql);
  console.log("PDFLINKS_CANDIDATES_PARAMS =>", params);

  const rows = await sqlRepo.query(sql, params);

  console.log(
    "PDFLINKS_CANDIDATES_ROWS =>",
    Array.isArray(rows) ? rows.length : 0
  );

  return Array.isArray(rows) ? rows : [];
}

/**
 * Busca usuario en stg_g_users por nombre resuelto (ej. desde focus).
 * Usado por logsLookup y rosterLookup.
 */
async function findUserByResolvedName(sqlRepo, resolvedName = "", limit = 5) {
  const name = String(resolvedName || "").trim();
  if (!name) return [];

  const { tokenizePersonName } = require("../../utils/chatRoute.helpers");
  const tokens = tokenizePersonName(name).filter((t) => t.length >= 2).slice(0, 4);
  if (!tokens.length) return [];

  const andConds = tokens.map(() => `(LOWER(TRIM(name)) LIKE ? OR LOWER(TRIM(nick)) LIKE ?)`).join(" AND ");
  const params = tokens.flatMap((t) => [`%${t}%`, `%${t}%`]);

  const sql = `
    SELECT id, name, nick, email, logsIndividualFile, rosterIndividualFile
    FROM stg_g_users
    WHERE ${andConds}
    ORDER BY name ASC
    LIMIT ${Number(limit) || 5}
  `.trim();

  const rows = await sqlRepo.query(sql, params);
  return Array.isArray(rows) ? rows : [];
}

module.exports = {
  wantsPdfLinks,
  findUserPdfCandidates,
  findUserByResolvedName,
};
