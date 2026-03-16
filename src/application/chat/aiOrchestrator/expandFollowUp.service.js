/**
 * Expand Follow-up Questions
 * Expande preguntas cortas que dependen del contexto usando contexto + opcionalmente IA.
 */

const openai = require("../../../infra/openai.client");
const { injectPersonFromContext } = require("../../../utils/chatRoute.helpers");
const { isEntityClarification, extractEntitySwitch } = require("../../../utils/topic");

const MODEL = process.env.OPENAI_ORCHESTRATOR_MODEL || "gpt-4.1-mini";

/** Patrones que indican follow-up de período */
const PERIOD_FOLLOW_UP = {
  es: [
    { rx: /\by\s+el\s+mes\s+pasado\b/i, expand: "último mes" },
    { rx: /\bmes\s+pasado\b/i, expand: "último mes" },
    { rx: /\by\s+ayer\b/i, expand: "ayer" },
    { rx: /\by\s+esta\s+semana\b/i, expand: "esta semana" },
    { rx: /\by\s+el\s+año\s+pasado\b/i, expand: "año pasado" },
    { rx: /\by\s+2024\b/i, expand: "2024" },
    { rx: /\by\s+2025\b/i, expand: "2025" },
  ],
  en: [
    { rx: /\band\s+last\s+month\b/i, expand: "last month" },
    { rx: /\blast\s+month\b/i, expand: "last month" },
    { rx: /\band\s+yesterday\b/i, expand: "yesterday" },
    { rx: /\band\s+this\s+week\b/i, expand: "this week" },
    { rx: /\band\s+last\s+year\b/i, expand: "last year" },
    { rx: /\band\s+2024\b/i, expand: "2024" },
    { rx: /\band\s+2025\b/i, expand: "2025" },
  ],
};

/**
 * Build entity-switch expanded query using lastMetric and lastPeriod.
 * Replaces prior entity with new entity; keeps metric and period.
 */
function buildEntitySwitchQuery({ entity, period, lastMetric, uiLang }) {
  const metric = String(lastMetric || "cases").toLowerCase().trim();
  const hasPeriod = period && period.length > 0;

  if (/drop\s*rate|dropped|tasa\s*de\s*cancel|baja/.test(metric)) {
    return uiLang === "es"
      ? `¿Cuál fue la tasa de cancelación de ${entity}${hasPeriod ? ` ${period}` : ""}?`
      : `What was ${entity}'s drop rate${hasPeriod ? ` ${period}` : ""}?`;
  }
  if (/confirmed|confirmados?|casos\s*confirmados/.test(metric)) {
    return uiLang === "es"
      ? `¿Cuántos casos confirmados tuvo ${entity}${hasPeriod ? ` ${period}` : ""}?`
      : `How many confirmed cases did ${entity} have${hasPeriod ? ` ${period}` : ""}?`;
  }
  if (/performance|desempeño|rendimiento/.test(metric)) {
    return uiLang === "es"
      ? `¿Cómo le fue a ${entity}${hasPeriod ? ` ${period}` : ""}?`
      : `How is ${entity} performing${hasPeriod ? ` ${period}` : ""}?`;
  }
  // default: cases
  return uiLang === "es"
    ? `¿Cuántos casos confirmados tuvo ${entity}${hasPeriod ? ` ${period}` : ""}?`
    : `How many confirmed cases did ${entity} have${hasPeriod ? ` ${period}` : ""}?`;
}

/**
 * Expande un mensaje follow-up usando contexto (reglas). Sin IA.
 * @param {string} message - Mensaje corto (ej. "And last month?")
 * @param {object} context - { lastPerson, lastPeriod, lastMetric, uiLang }
 * @returns {string|null} - Mensaje expandido o null si no es follow-up expandible
 */
function expandFollowUpWithRules(message, context = {}) {
  const m = String(message || "").trim();
  if (!m) return null;

  const uiLang = context?.uiLang === "es" ? "es" : "en";
  const lastPerson = context?.lastPerson || context?.filters?.person?.value || "";
  const lastPeriod = context?.lastPeriod || context?.kpiWindow || "";
  const lastMetric = context?.lastMetric || "cases";

  const patterns = PERIOD_FOLLOW_UP[uiLang] || PERIOD_FOLLOW_UP.en;
  for (const { rx, expand } of patterns) {
    if (rx.test(m)) {
      const baseQuery = lastMetric
        ? (uiLang === "es" ? `Cuántos casos confirmados` : `How many confirmed cases`)
        : (uiLang === "es" ? `Casos confirmados` : `Confirmed cases`);
      const withPerson = lastPerson ? injectPersonFromContext(baseQuery, uiLang, lastPerson) : baseQuery;
      return `${withPerson} ${expand}`.trim();
    }
  }

  // Entity-switch: "What about Maria?", "And Maria this month?", "¿Y Maria?" – use lastMetric + lastPeriod, new entity wins
  const entitySwitch = extractEntitySwitch(m);
  if (entitySwitch && entitySwitch.entity) {
    const period = entitySwitch.periodOverride || lastPeriod || "";
    return buildEntitySwitchQuery({
      entity: entitySwitch.entity,
      period,
      lastMetric,
      uiLang,
    }).trim();
  }

  if (/^which\s+one\s+(improved|did\s+better)\b/i.test(m) || /^cu[aá]l\s+mejor[oó]\b/i.test(m)) {
    const base = lastPeriod ? (uiLang === "es" ? `Cuál mejoró más` : `Which one improved the most`) + ` ${lastPeriod}` : (uiLang === "es" ? `Cuál mejoró más` : `Which one improved the most`);
    return base.trim();
  }

  return null;
}

/**
 * Expande follow-up con IA cuando las reglas no bastan.
 */
async function expandFollowUpWithAI(message, context = {}, opts = {}) {
  if (opts.useAI === false || process.env.AI_ORCHESTRATOR_ENABLED === "false") return null;

  const uiLang = context?.uiLang === "es" ? "es" : "en";
  const ctxStr = JSON.stringify({
    lastPerson: context?.lastPerson || "",
    lastPeriod: context?.lastPeriod || "",
    lastMetric: context?.lastMetric || "",
  });

  const systemPrompt = uiLang === "es"
    ? `El usuario hizo una pregunta de seguimiento corta. Expándela en una consulta completa usando el contexto.
Contexto: ${ctxStr}
Responde SOLO la consulta expandida, sin explicaciones. Ejemplo: "And last month?" con lastPerson=Maria, lastMetric=confirmed -> "How many confirmed cases did Maria have last month"`
    : `The user asked a short follow-up. Expand it into a full query using context.
Context: ${ctxStr}
Respond ONLY the expanded query, no explanation.`;

  try {
    const response = await openai.responses.create({
      model: MODEL,
      max_output_tokens: 120,
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `User: "${message}"` },
      ],
    });
    const text = (response?.output?.[0]?.content?.[0]?.text || "").trim();
    return text.length >= 5 ? text : null;
  } catch (e) {
    return null;
  }
}

/**
 * Expande mensaje follow-up. Primero reglas, luego IA si hace falta.
 */
async function expandFollowUp(message, context = {}, opts = {}) {
  if (isEntityClarification(message)) return null;

  const ruleExpanded = expandFollowUpWithRules(message, context);
  if (ruleExpanded) return ruleExpanded;

  return expandFollowUpWithAI(message, context, opts);
}

module.exports = {
  expandFollowUp,
  expandFollowUpWithRules,
  expandFollowUpWithAI,
};
