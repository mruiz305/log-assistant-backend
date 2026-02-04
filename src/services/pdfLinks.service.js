// src/services/pdfLinks.service.js

function wantsPdfLinks(message = "") {
  return /(pdf|url|link|enlace|log\b|logs\b|log completo|full log|roster|reporte|report|details)/i.test(
    String(message || "")
  );
}



function normalizeText(s = "") {
  return String(s || "")
    .toLowerCase()
    .replace(/[’´`]/g, "'")
    .replace(/\b([a-z0-9]+)\s*'s\b/g, "$1")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractPersonPhrase(message = "") {
  const raw = String(message || "");
  const n = normalizeText(raw);

  // ✅ 0) Caso EN/ES: "<name> logs for/of <date>"
  // ej: "give me the tony's logs for january 2026"
  // ej: "tony press logs for january 2026"
  let m = n.match(/(.+?)\s+logs?\s+(?:for|of)\s+.+$/i);
  if (m && m[1]) {
    const phrase = m[1].trim();
    if (phrase.length >= 2) return phrase;
  }

  // ✅ 0b) Caso ES: "<name> logs de/para <algo>"
  // ej: "tony press logs de enero 2026" (por si alguien escribe raro)
  m = n.match(/(.+?)\s+logs?\s+(?:de|del|para)\s+.+$/i);
  if (m && m[1]) {
    const phrase = m[1].trim();
    if (phrase.length >= 2) return phrase;
  }

  // ✅ 1) Patrones ES: "... logs de <nombre>"
  m = n.match(/\blogs?\s+(?:de|del|para)\s+(.+)$/i);
  if (m && m[1]) {
    const phrase = m[1].trim();
    if (phrase.length >= 2) return phrase;
  }

  // ✅ 2) Patrones EN: "... logs of/for <name>"
  // OJO: este patrón lo dejamos, pero ya no rompe el caso "tony logs for january 2026"
  // porque arriba capturamos el nombre ANTES de logs.
  m = n.match(/\blogs?\s+(?:of|for)\s+(.+)$/i);
  if (m && m[1]) {
    const phrase = m[1].trim();
    if (phrase.length >= 2) return phrase;
  }

  // ✅ 3) "show me <name> logs" / "give me <name> pdf"
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

  // ✅ 4) Fallback: limpiar palabras típicas
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

  // ✅ meses EN/ES (ya normalizados)
  const months = new Set([
    "january","february","march","april","may","june","july","august","september","october","november","december",
    "enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","setiembre","octubre","noviembre","diciembre",
  ]);

  const tokens = normalizeText(phrase)
    .split(" ")
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => !stop.has(x))
    .filter((x) => !months.has(x))            // ✅ quita meses
    .filter((x) => !/^(19|20)\d{2}$/.test(x)) // ✅ quita años tipo 2026
    .filter((x) => !/^\d{1,2}$/.test(x))      // ✅ quita días sueltos
    .filter((x) => x.length >= 2);

  return [...new Set(tokens)];
}


/**
 * Resuelve candidatos en stg_g_users usando tokens AND en (name/nick).
 * OJO: esto se usa solo cuando wantsPdfLinks() ya dio true.
 */
async function findUserPdfCandidates(pool, text = "", limit = 8) {
  const message = String(text || "").trim();
  if (!message) return [];

  const phrase = extractPersonPhrase(message);
  const tokens = buildTokens(phrase);

  console.log("\nPDFLINKS_LOOKUP =>", phrase);
  console.log("PDFLINKS_CANDIDATE_PARTS =>", tokens);

  // si no hay tokens, intenta un fallback más agresivo:
  // "dame los logs de tony" => si phrase salió raro, intenta tomar la última palabra útil
  if (!tokens.length) {
    const parts = normalizeText(phrase).split(" ").filter(Boolean);
    const last = parts.length ? parts[parts.length - 1] : "";

    const isYear = /^(19|20)\d{2}$/.test(last);
    const isMonth = new Set([
      "january","february","march","april","may","june","july","august","september","october","november","december",
      "enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","setiembre","octubre","noviembre","diciembre",
    ]).has(last);

    if (last && last.length >= 2 && last !== "los" && last !== "the" && !isYear && !isMonth) {
      tokens.push(last);
      console.log("PDFLINKS_FALLBACK_LAST_TOKEN =>", last);
    }
  }

  if (!tokens.length) return [];

  const andConds = tokens.slice(0, 4).map(
    () => `(LOWER(TRIM(name)) LIKE CONCAT('%', LOWER(TRIM(?)), '%')
         OR LOWER(TRIM(nick)) LIKE CONCAT('%', LOWER(TRIM(?)), '%'))`
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
  for (const tk of tokens.slice(0, 4)) params.push(tk, tk);

  console.log("\nPDFLINKS_CANDIDATES_SQL =>", sql);
  console.log("PDFLINKS_CANDIDATES_PARAMS =>", params);

  const [rows] = await pool.query(sql, params);
  console.log(
    "PDFLINKS_CANDIDATES_ROWS =>",
    Array.isArray(rows) ? rows.length : 0
  );

  return Array.isArray(rows) ? rows : [];
}

module.exports = {
  wantsPdfLinks,
  findUserPdfCandidates,
};
