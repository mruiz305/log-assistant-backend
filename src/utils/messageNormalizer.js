/**
 * Normaliza mensajes naturales a formas que el pipeline existente entiende.
 * Capa adicional: solo añade variantes; nunca elimina ni altera si no hay match.
 * Si no hay patrón que coincida, devuelve el mensaje original intacto.
 *
 * Feature flag: NORMALIZE_MESSAGE=true para activar (default: false).
 */

const ENABLED = process.env.NORMALIZE_MESSAGE === "true" || process.env.NORMALIZE_MESSAGE === "1";

/**
 * Patrones conservadores: mapean frases naturales a queries que el pipeline ya entiende.
 * Cada patrón debe producir algo que: wantsPerformance, wantsLogsPerformanceReview,
 * isKpiOnlyQuestion, o normalAi puedan interpretar.
 */
const NORMALIZE_PATTERNS = [
  // "How is X doing lately?" → "X performance last 30 days" (must be before generic doing+period)
  {
    pattern: /^how\s+is\s+(.+?)\s+doing\s+lately\s*[?.]?$/i,
    replacement: (_, name) => `${name.trim()} performance last 30 days`,
  },
  // "How is X doing [period]?" → "X performance [period]"
  {
    pattern: /^how\s+is\s+(.+?)\s+doing\s+(.+?)\s*[?.]?$/i,
    replacement: (_, name, period) => `${name.trim()} performance ${period.trim()}`,
  },
  // "How is X doing?" (sin periodo) → "X performance this month"
  {
    pattern: /^how\s+is\s+(.+?)\s+doing\s*[?.]?$/i,
    replacement: (_, name) => `${name.trim()} performance this month`,
  },
  // "Do you think X is performing well?" → "X performance this month"
  {
    pattern: /^do\s+you\s+think\s+(.+?)\s+is\s+performing\s+well\s*[?.]?$/i,
    replacement: (_, name) => `${name.trim()} performance this month`,
  },
  // "How is X performing [period]?" → "X performance [period]"
  {
    pattern: /^how\s+is\s+(.+?)\s+performing\s+(.+)$/i,
    replacement: (_, name, period) => `${name.trim()} performance ${period.trim()}`,
  },
  // "How is X performing?" → "X performance this month"
  {
    pattern: /^how\s+is\s+(.+?)\s+performing\s*[?.]?$/i,
    replacement: (_, name) => `${name.trim()} performance this month`,
  },
  // "How has X been performing [period]?" → "X performance [period]"
  {
    pattern: /^how\s+has\s+(.+?)\s+been\s+(?:doing|performing)\s+(.+?)[?.!]*$/i,
    replacement: (_, name, period) => `${name.trim()} performance ${period.trim()}`,
  },
  {
    pattern: /^how\s+has\s+(.+?)\s+been\s+(?:doing|performing)\s*[?.]?$/i,
    replacement: (_, name) => `${name.trim()} performance this month`,
  },
  // "Is X performing well [period]?" → "X performance [period]"
  {
    pattern: /^is\s+(.+?)\s+performing\s+well\s+(.+?)[?.!]*$/i,
    replacement: (_, name, period) => `${name.trim()} performance ${period.trim()}`,
  },
  {
    pattern: /^is\s+(.+?)\s+performing\s+well\s*[?.]?$/i,
    replacement: (_, name) => `${name.trim()} performance this month`,
  },
  // "Show me how X compares with the others" → "X performance by reps"
  {
    pattern: /^show\s+me\s+how\s+(.+?)\s+compares?\s+with\s+(?:the\s+)?others\s*[?.]?$/i,
    replacement: (_, name) => `${name.trim()} performance by reps`,
  },
  // "How does X compare to the team?" → "X dropped rate compare team"
  {
    pattern: /^how\s+(?:does|do)\s+(.+?)\s+compare\s+to\s+(?:the\s+)?team\s*[?.]?$/i,
    replacement: (_, name) => `${name.trim()} performance by reps`,
  },
  // "How bad is X's drop rate compared to the team?" → "X dropped rate vs team"
  {
    pattern: /^how\s+bad\s+is\s+(.+?)(?:'s)?\s+drop\s+rate\s+(?:compared?\s+to|vs?)\s+(?:the\s+)?(team|others)\s*[?.]?$/i,
    replacement: (_, name) => `${name.trim()} dropped rate vs team`,
  },
  // "Give me the most recent cases from X" → "X most recent cases"
  {
    pattern: /^give\s+me\s+the\s+most\s+recent\s+cases?\s+from\s+(.+)$/i,
    replacement: (_, name) => `${name.trim()} most recent cases`,
  },
  // "Show me the most recent cases from X" → "X most recent cases"
  {
    pattern: /^show\s+me\s+(?:the\s+)?most\s+recent\s+cases?\s+from\s+(.+)$/i,
    replacement: (_, name) => `${name.trim()} most recent cases`,
  },
  // ES: "¿Cómo está X este año?" → "X performance this year"
  {
    pattern: /^[¿]?c[oó]mo\s+est[aá]\s+(.+?)\s+(este\s+a[nñ]o|esta\s+semana|este\s+mes)\s*[?.]?$/i,
    replacement: (_, name, period) => `${name.trim()} performance ${period.trim()}`,
  },
  // ES: "Muéstrame los casos más recientes de X" → "X most recent cases"
  {
    pattern: /^[¿]?mu[eé]strame\s+los?\s+casos?\s+m[aá]s\s+recientes?\s+de\s+(.+)$/i,
    replacement: (_, name) => `${name.trim()} most recent cases`,
  },
];

/**
 * Aplica patrones de normalización (usado internamente y para tests).
 * @param {string} raw - Mensaje original
 * @param {string} uiLang - "en" | "es"
 * @returns {{ normalized: string, meta?: { matched: boolean } }}
 */
function normalizeMessageInternal(raw, uiLang = "en") {
  if (!raw || typeof raw !== "string") {
    return { normalized: String(raw || "").trim() };
  }
  const trimmed = String(raw).trim();
  if (!trimmed) return { normalized: trimmed };

  for (const { pattern, replacement } of NORMALIZE_PATTERNS) {
    const m = trimmed.match(pattern);
    if (m) {
      const normalized =
        typeof replacement === "function"
          ? String(replacement(...m)).trim()
          : String(replacement).trim();
      if (normalized && normalized !== trimmed) {
        return { normalized, meta: { matched: true } };
      }
    }
  }
  return { normalized: trimmed };
}

/**
 * Normaliza un mensaje si NORMALIZE_MESSAGE está activo.
 * @param {string} raw - Mensaje original
 * @param {string} uiLang - "en" | "es"
 * @returns {{ normalized: string, meta?: { matched: boolean } }}
 */
function normalizeMessage(raw, uiLang = "en") {
  if (!ENABLED) {
    return { normalized: String(raw || "").trim() };
  }
  return normalizeMessageInternal(raw, uiLang);
}

module.exports = { normalizeMessage, normalizeMessageInternal, NORMALIZE_PATTERNS };
