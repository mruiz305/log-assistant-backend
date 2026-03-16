
function looksLikeNewTopic(msg = "", uiLang = "en") {
  const m = String(msg || "").toLowerCase().trim();
  if (/(otra cosa|cambiando de tema|nuevo tema|diferente|ahora|por cierto|adem[aá]s)/i.test(m)) return true;
  if (/(another thing|change topic|new topic|now|by the way|also)/i.test(m)) return true;
  if (/(top\s+reps|ranking|por\s+oficina|by\s+office|por\s+team|by\s+team|por\s+region|by\s+region)/i.test(m)) return true;
  return false;
}

/**
 * Entity-switch follow-up patterns: "What about Maria?", "How about Juan?", "And Maria?", "¿Y Maria?", "¿Qué tal Maria?".
 * Explicit entity name must override prior entity. Used to avoid routing as conversational_followup.
 */
const ENTITY_SWITCH_RX = [
  /^what\s+about\s+([a-zA-Z][a-zA-Z0-9\-\s]*?)\s*(?:\s+(this\s+month|last\s+month|this\s+year|last\s+year|this\s+week|last\s+week))?\s*[?.!]?\s*$/i,
  /^how\s+about\s+([a-zA-Z][a-zA-Z0-9\-\s]*?)\s*(?:\s+(this\s+month|last\s+month|this\s+year|last\s+year|this\s+week|last\s+week))?\s*[?.!]?\s*$/i,
  /^and\s+([a-zA-Z][a-zA-Z0-9\-\s]*?)\s*(?:\s+(this\s+month|last\s+month|this\s+year|last\s+year|this\s+week|last\s+week))?\s*[?.!]?\s*$/i,
  /^[¿]?y\s+([a-zA-Z][a-zA-Z0-9\-\s]*?)\s*(?:\s+(este\s+mes|mes\s+pasado|este\s+año|año\s+pasado|esta\s+semana|semana\s+pasada))?\s*[?.!]?\s*$/i,
  /^[¿]?qu[eé]\s+tal\s+([a-zA-Z][a-zA-Z0-9\-\s]*?)\s*[?.!]?\s*$/i,
];

/** Period keywords that must NOT be treated as entity names */
const PERIOD_ENTITY_STOPWORDS = new Set([
  "last", "this", "el", "esta", "este", "esa", "ese", "mes", "month", "year", "año",
  "week", "semana", "ayer", "yesterday", "today", "hoy", "pasado", "pasada",
]);
/** Multi-word period phrases (e.g. "last month" parsed as entity) */
const PERIOD_PHRASE_RX = /^(last|this|el|esta|este|mes|año|year|week|semana)\s+(month|year|week|mes|año|semana|pasado|pasada)/i;

function isEntitySwitchFollowUp(msg = "") {
  const m = String(msg || "").trim();
  if (!m || m.length > 80) return false;
  const extracted = extractEntitySwitch(m);
  if (!extracted || !extracted.entity) return false;
  const entityLower = extracted.entity.toLowerCase().trim();
  if (PERIOD_ENTITY_STOPWORDS.has(entityLower)) return false;
  if (PERIOD_PHRASE_RX.test(entityLower)) return false; // "last month" etc.
  return true;
}

/**
 * Extract { entity, periodOverride } from entity-switch message, or null.
 */
function extractEntitySwitch(msg = "") {
  const m = String(msg || "").trim();
  for (const rx of ENTITY_SWITCH_RX) {
    const match = m.match(rx);
    if (match) {
      const entity = (match[1] || "").trim();
      const periodOverride = (match[2] || "").trim();
      if (!entity || entity.length < 2) continue;
      const entityLower = entity.toLowerCase();
      if (PERIOD_ENTITY_STOPWORDS.has(entityLower)) return null; // "And last month?" → period follow-up
      if (PERIOD_PHRASE_RX.test(entityLower)) return null; // "last month" parsed as entity
      return { entity, periodOverride: periodOverride || null };
    }
  }
  return null;
}

/**
 * True if the message is asking for entity/person clarification (which one, who exactly).
 * These must NOT be expanded or routed to analysis/conversational follow-up.
 * Prefer pending disambiguation context over contextual analysis.
 */
function isEntityClarification(msg = "") {
  const m = String(msg || "").trim();
  if (!m || m.length > 80) return false;
  const lower = m.toLowerCase();
  return (
    /^which\s+(?:one|tony|maria|juan|john)\s+(?:did\s+you\s+mean|do\s+you\s+mean)\??\s*$/i.test(m) ||
    /^which\s+(?:one|tony|maria|juan|john)\s*\??\s*$/i.test(m) ||
    /^which\s+one\s+(?:did\s+you\s+mean|do\s+you\s+mean)\??\s*$/i.test(m) ||
    /^who\s+exactly\??\s*$/i.test(m) ||
    /^who\s+do\s+you\s+mean\??\s*$/i.test(m) ||
    /^[¿]?(cu[aá]l\s+(?:tony|maria|juan|uno)|qui[eé]n\s+exactamente)\??\s*$/i.test(m)
  );
}

module.exports = {
  looksLikeNewTopic,
  isEntityClarification,
  isEntitySwitchFollowUp,
  extractEntitySwitch,
};
