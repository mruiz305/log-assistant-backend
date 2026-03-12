/** Base suggestions (always available). */
const BASE_SUGGESTIONS = {
  es: ["Últimos 7 días", "Este mes", "Top reps", "Ver dropped"],
  en: ["Last 7 days", "This month", "Top reps", "See dropped"],
};

/** Contextual suggestions by scenario. */
const CONTEXTUAL_SUGGESTIONS = {
  noData: {
    es: ["Probar 2025", "Quitar filtro actual", "Buscar por nombre completo"],
    en: ["Try 2025", "Remove current filter", "Search by full name"],
  },
  highDropRate: {
    es: ["Ver casos dropped", "Comparar con peers", "Tendencia mensual", "Abrir log PDF"],
    en: ["Show dropped cases", "Compare vs peers", "Show monthly trend", "Open full log PDF"],
  },
  performance: {
    es: ["Comparar con peers", "Ver casos recientes", "Abrir log PDF", "Tendencia confirmación"],
    en: ["Compare to peers", "Show most recent cases", "Open full log PDF", "See confirmation trend"],
  },
};

/**
 * Build suggestions. Optionally merges contextual suggestions based on result.
 * @param {string} message - User message (for future use).
 * @param {string} uiLang - "en" | "es"
 * @param {object} [ctx] - Optional context
 * @param {boolean} [ctx.noData] - No data found
 * @param {boolean} [ctx.highDropRate] - dropped_rate or problem rate high
 * @param {boolean} [ctx.performance] - Performance/leaderboard result
 */
function buildSuggestions(message = "", uiLang = "en", ctx = {}) {
  const lang = uiLang === "es" ? "es" : "en";
  const base = BASE_SUGGESTIONS[lang];

  if (ctx?.noData) {
    const extra = CONTEXTUAL_SUGGESTIONS.noData[lang];
    return [...new Set([...extra, ...base])].slice(0, 5);
  }
  if (ctx?.highDropRate) {
    const extra = CONTEXTUAL_SUGGESTIONS.highDropRate[lang];
    return [...new Set([...extra.slice(0, 2), ...base])].slice(0, 5);
  }
  if (ctx?.performance) {
    const extra = CONTEXTUAL_SUGGESTIONS.performance[lang];
    return [...new Set([...extra.slice(0, 2), ...base])].slice(0, 5);
  }

  return base;
}

module.exports = { buildSuggestions };
