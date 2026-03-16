/**
 * logsRoster.service.js
 * Detecta intención logs vs roster para enrutar correctamente.
 * - logs: tabla + registros + PDF opcional
 * - roster: solo PDF/link
 */

function normalizeText(s = "") {
  return String(s || "")
    .toLowerCase()
    .replace(/['´`]/g, "'")
    .replace(/\b([a-z0-9]+)\s*'s\b/g, "$1")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normaliza candidatos de entidad para logs:
 * - "the tonys" -> "Tony"
 * - "tonys" -> "Tony"
 * - "tony" -> "Tony"
 * - preserva nombres multi-palabra ("kanner pintaluga").
 */
function normalizeLogsEntityCandidate(raw = "") {
  const orig = String(raw || "").trim();
  if (!orig) return null;

  let v = orig.trim();
  // Trabajar en minúsculas para normalizar artículos/plurales
  let lower = v.toLowerCase();

  // Quitar artículos iniciales comunes
  lower = lower.replace(/^(the|el|la|los|las)\s+/i, "").trim();

  if (!lower) return null;

  const tokens = lower.split(/\s+/);

  // Singularizar solo tokens simples (ej. "tonys" -> "tony") sin afectar nombres compuestos
  if (tokens.length === 1 && tokens[0].length > 3 && /s$/.test(tokens[0])) {
    tokens[0] = tokens[0].replace(/s$/, "");
  }

  const normalized =
    tokens
      .map((t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : ""))
      .join(" ")
      .trim() || null;

  if (normalized) {
    console.log(`[entity_normalize] raw="${orig}" normalized="${normalized}"`);
  }

  return normalized;
}

function isAnalyticalQuestion(message = "") {
  const m = String(message || "").toLowerCase();
  const patterns = [
    /\bbased\s+(?:off|on)\b/,
    /\bwould\s+you\s+consider\b/,
    /\bfit\s+employee\b/,
    /\bworth\b/,
    /\bjustify\b/,
    /\bsalary\b/,
    /\bcompensation\b/,
    /\bperformance\b/,
    /\bcompare\s+(?:to|with|against)\b/,
    /\bcompare\s+(?:to|with)?\s*peers\b/,
    /\b(?:top|best)\s+performer\b/,
    /\bamong\s+submitters\b/,
    /\babove\s+average\b/,
    /\bhow\s+does\s+(?:he|she|they)\s+rank\b/,
    /\bhow\s+do(?:es)?\s+.\s+rank\b/,
    /\bmake\s+\d+k\b/,
    // Preguntas analíticas conversacionales (weakness, strength)
    /\b(?:biggest|main|primary|key|biggest)\s+(?:weakness|strength|area\s+to\s+improve)\b/,
    /\bwhat\s+is\s+.+'s\s+(?:biggest|main)\s+(?:weakness|strength)\b/,
    /\b(?:weakness|strength)(?:es)?\s+(?:in|for|of)\b/,
  ];
  return patterns.some((rx) => rx.test(m));
}

function wantsLogsLookup(message = "") {
  const m = String(message || "").toLowerCase().trim();
  if (!m) return false;
  if (/\broster\b/.test(m)) return false;
  if (isAnalyticalQuestion(m)) return false;
  return /\blogs?\b/.test(m);
}

/**
 * Preguntas analíticas de evaluación/performance basadas en logs.
 * Ej: "Based off Tony's logs for 2025 - would you consider he be a fit employee to make 80k?"
 * También: "What is Tony's biggest weakness in 2025?" (weakness/strength sin "logs").
 * Debe ir a logsReview.handler, NO a normalAi.
 */
function wantsLogsPerformanceReview(message = "") {
  const m = String(message || "").toLowerCase().trim();
  if (!m) return false;
  const hasLogs = /\blogs?\b/.test(m);
  const hasWeaknessStrength = /\b(?:biggest|main|primary|key)\s+(?:weakness|strength)\b/.test(m) ||
    /\bwhat\s+is\s+.+[''']?s?\s+(?:biggest|main)\s+(?:weakness|strength)\b/i.test(m);
  if (!hasLogs && !hasWeaknessStrength) return false;
  return isAnalyticalQuestion(m);
}

function wantsRosterLookup(message = "") {
  const m = String(message || "").toLowerCase().trim();
  if (!m) return false;
  return /\broster\b/.test(m);
}

/**
 * Extrae la frase que podría ser nombre/entidad en mensajes tipo:
 * "Show me Tony's logs", "Give me Gerardo's roster", "Based off Tony's logs for 2025"
 */
function extractEntityPhrase(message = "") {
  const raw = String(message || "").trim();
  if (!raw) return null;
  const n = normalizeText(raw);

  const patterns = [
    /(?:give me|show me|get me|dame|muestrame|quiero ver|i want to see)\s+(.+?)\s+(?:log|logs|roster)\b/i,
    /(.+?)\s+logs?\s+(?:for|of)\s+/i,
    /\blogs?\s+(?:de|del|para)\s+(.+)$/i,
    /\blogs?\s+(?:of|for)\s+(.+)$/i,
    /\broster\s+(?:de|del|para|of|for)\s+(.+)$/i,
    /(?:de|del|of|for)\s+(.+?)\s+(?:logs?|roster)\b/i,
  ];

  for (const rx of patterns) {
    const mm = n.match(rx);
    if (mm && mm[1]) {
      const phrase = mm[1].trim().replace(/\s+/g, " ");
      if (phrase.length >= 2) {
        const normalized = normalizeLogsEntityCandidate(phrase);
        if (normalized && normalized.length >= 2) return normalized;
      }
    }
  }

  return null;
}

/**
 * Extrae el candidato a entidad (nombre) de frases tipo:
 * "Based on Tony's 2025 logs...", "Based off X's logs", "Using X's logs", "From X's logs",
 * "Review X's logs", "According to X's logs", "Based on Tony logs" (sin posesivo).
 * Devuelve solo el token/nombre (ej. "Tony") para usar en findFocusCandidates.
 */
function extractEntityFromLogsPhrase(message = "") {
  const raw = String(message || "").trim();
  if (!raw || !/\blogs\b/i.test(raw)) return null;

  // Normaliza comillas/apóstrofes “raras” a comilla simple para que los patrones
  // funcionen con "Tony’s", "Tony´s", etc.
  const normalizedRaw = raw.replace(/[’´`]/g, "'");

  const patterns = [
    // Based on X's 2025 logs / Based on X's logs (single word)
    /^based\s+on\s+([^\s']+)(?:'s)?\s+(?:\d{4}\s+)?logs\b/i,
    /^based\s+off\s+([^\s']+)(?:'s)?\s+(?:\d{4}\s+)?logs\b/i,
    // Multi-word: Based on Tony Press's logs
    /^based\s+on\s+(.+?)'s?\s+(?:\d{4}\s+)?logs\b/i,
    /^based\s+off\s+(.+?)'s?\s+(?:\d{4}\s+)?logs\b/i,
    /^using\s+([^\s']+)(?:'s)?\s+(?:\d{4}\s+)?logs\b/i,
    /^using\s+(.+?)'s?\s+(?:\d{4}\s+)?logs\b/i,
    /^from\s+([^\s']+)(?:'s)?\s+(?:\d{4}\s+)?logs\b/i,
    /^from\s+(.+?)'s?\s+(?:\d{4}\s+)?logs\b/i,
    /^review\s+([^\s']+)(?:'s)?\s+logs\b/i,
    /^review\s+(.+?)'s?\s+logs\b/i,
    /^according\s+to\s+([^\s']+)(?:'s)?\s+logs\b/i,
    /^according\s+to\s+(.+?)'s?\s+logs\b/i,
    // No possessive: "Based on Tony logs"
    /^based\s+on\s+(\w+)\s+logs\b/i,
    /^based\s+off\s+(\w+)\s+logs\b/i,
  ];

  for (const rx of patterns) {
    const m = normalizedRaw.match(rx);
    if (m && m[1]) {
      let candidate = String(m[1]).trim().replace(/\s+/g, " ");
      if (candidate.length >= 2) {
        return candidate;
      }
    }
  }

  return null;
}

/**
 * Extrae candidato a persona de preguntas weakness/strength sin "logs".
 * Ej: "What is Tony's biggest weakness in 2025?" -> "Tony"
 */
function extractEntityFromWeaknessPhrase(message = "") {
  const raw = String(message || "").trim();
  if (!raw) return null;
  const n = raw.replace(/['´`]/g, "'");
  const m = n.match(/\bwhat\s+is\s+(.+?)['']?s\s+(?:biggest|main|primary|key)\s+(?:weakness|strength)\b/i)
    || n.match(/\b(?:biggest|main)\s+(?:weakness|strength)\s+(?:of|for)\s+(.+?)(?:\s+in\s|\s+for\s|$)/i);
  if (m && m[1]) {
    const candidate = String(m[1]).trim().replace(/\s+/g, " ").replace(/\s+in\s+\d{4}.*$/i, "").trim();
    if (candidate.length >= 2) return candidate;
  }
  return null;
}

/** Tokens que no deben usarse como candidato a persona (intro de frases logs). */
const LOGS_INTRO_STOPWORDS = new Set(["based", "using", "from", "according"]);

function isRejectedLogsIntroToken(value = "") {
  if (!value || typeof value !== "string") return false;
  const first = String(value).trim().split(/\s+/)[0] || "";
  return LOGS_INTRO_STOPWORDS.has(first.toLowerCase());
}

module.exports = {
  wantsLogsLookup,
  wantsRosterLookup,
  wantsLogsPerformanceReview,
  isAnalyticalQuestion,
  extractEntityPhrase,
  extractEntityFromLogsPhrase,
  extractEntityFromWeaknessPhrase,
  isRejectedLogsIntroToken,
  normalizeText,
  normalizeLogsEntityCandidate,
};
