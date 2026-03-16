/**
 * AI Intent Classification
 * Clasifica cada mensaje usando IA para determinar tipo de interacción.
 * Fallback a reglas cuando la IA falla o está deshabilitada.
 */

const openai = require("../../../infra/openai.client");
const { isEntitySwitchFollowUp } = require("../../../utils/topic");

const MODEL = process.env.OPENAI_ORCHESTRATOR_MODEL || "gpt-4.1-mini";

const INTENTS = {
  CONVERSATIONAL: "conversational",
  CONVERSATIONAL_FOLLOWUP: "conversational_followup",
  ANALYSIS_FOLLOWUP: "analysis_followup",
  KPI: "kpi",
  ANALYSIS: "analysis",
  SQL_DATA: "sql_data",
  DISAMBIGUATION: "disambiguation",
  MIXED: "mixed",
  FOLLOW_UP: "follow_up",
  GREETING: "greeting",
  HELP: "help",
};

/**
 * Clasificación con IA. Retorna JSON estructurado.
 * @param {string} message - Mensaje del usuario
 * @param {object} context - { lastPerson, lastPeriod, lastMetric, filters, uiLang }
 */
async function classifyWithAI(message, context = {}) {
  const ctx = context || {};
  const uiLang = ctx.uiLang === "es" ? "es" : "en";
  const lastPerson = ctx.lastPerson || ctx.filters?.person?.value || "";
  const lastPeriod = ctx.lastPeriod || ctx.kpiWindow || "";
  const lastMetric = ctx.lastMetric || "";

  const systemPrompt = uiLang === "es"
    ? `Eres un clasificador de intención para un asistente de analytics de casos/legal.
Clasifica el mensaje del usuario en UNA de estas intenciones primarias:
- greeting: saludos simples (hola, buenos días, hi, hello)
- conversational: cháchara general, cómo estás, sin pedir datos
- help: pedir ayuda, qué puedes hacer, capacidades
- kpi: consultas numéricas (cuántos casos, confirmed, dropped, top N, ranking)
- analysis: pedir análisis, explicación, comparación, por qué, interpretación
- sql_data: pedir datos estructurados, listas, tablas explícitas
- follow_up: pregunta corta que depende del contexto (y el mes pasado? ¿y Maria? compare that)
- conversational_followup: pedir más información sobre la respuesta anterior (qué más puedes decir, dime más, explícame eso) - NO pedir nuevos datos
- analysis_followup: interpretar la respuesta anterior (qué significa eso, por qué pasó, eso es bueno o malo, qué investigar) - NO pedir nuevos datos
- disambiguation: mensaje ambiguo que requiere clarificación

REGLA CRÍTICA: Si el mensaje NO pide explícitamente nuevos datos (nueva entidad, métrica, período o comparación), prefiere conversational_followup o analysis_followup sobre kpi/analysis.
- mixed: mezcla de saludo/conversación + consulta (hola, cuántos casos tiene Juan)

Responde SOLO un JSON válido, sin markdown ni texto extra:
{"primary_intent":"...","secondary_intents":[],"needs_data":false,"needs_sql":false,"needs_analysis":false,"needs_disambiguation":false,"needs_context_resolution":false,"is_follow_up":false,"response_style":"professional_conversational"}

Contexto reciente (para follow-up): lastPerson="${lastPerson}", lastPeriod="${lastPeriod}", lastMetric="${lastMetric}"`
    : `You are an intent classifier for a case analytics assistant.
Classify the user message into ONE primary intent:
- greeting: simple greetings (hi, hello, good morning)
- conversational: general chitchat, how are you, no data request
- help: asking for help, what can you do, capabilities
- kpi: numeric queries (how many cases, confirmed, dropped, top N, ranking)
- analysis: request for analysis, explanation, comparison, why, interpretation
- sql_data: request for structured data, lists, explicit tables
- follow_up: short question depending on context (and last month? what about Maria? compare that)
- conversational_followup: asking for more on the PREVIOUS answer (what else can you tell me, tell me more, explain that) - NOT new data
- analysis_followup: interpreting the PREVIOUS result (what does that mean, why is that, is that good or bad, what to investigate) - NOT new data
- disambiguation: ambiguous message needing clarification

CRITICAL RULE: If the message does NOT explicitly request new data (new entity, metric, period, or comparison), prefer conversational_followup or analysis_followup over kpi/analysis.
- mixed: greeting/chitchat + query (hello, how many cases did Juan have)

Respond ONLY valid JSON, no markdown:
{"primary_intent":"...","secondary_intents":[],"needs_data":false,"needs_sql":false,"needs_analysis":false,"needs_disambiguation":false,"needs_context_resolution":false,"is_follow_up":false,"response_style":"professional_conversational"}

Recent context (for follow-up): lastPerson="${lastPerson}", lastPeriod="${lastPeriod}", lastMetric="${lastMetric}"`;

  const userPrompt = `Message: "${message}"`;

  try {
    const response = await openai.responses.create({
      model: MODEL,
      max_output_tokens: 256,
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });
    const text = response?.output?.[0]?.content?.[0]?.text || "";
    const cleaned = text.replace(/^```json\s*|\s*```$/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return normalizeClassification(parsed);
  } catch (e) {
    return null;
  }
}

function normalizeClassification(obj) {
  if (!obj || typeof obj !== "object") return null;
  const valid = [
    "greeting", "conversational", "conversational_followup", "analysis_followup", "help", "kpi", "analysis",
    "sql_data", "follow_up", "disambiguation", "mixed",
  ];
  const primary = valid.includes(obj.primary_intent) ? obj.primary_intent : null;
  if (!primary) return null;
  return {
    primary_intent: primary,
    secondary_intents: Array.isArray(obj.secondary_intents) ? obj.secondary_intents.filter((i) => valid.includes(i)) : [],
    needs_data: Boolean(obj.needs_data),
    needs_sql: Boolean(obj.needs_sql),
    needs_analysis: Boolean(obj.needs_analysis),
    needs_disambiguation: Boolean(obj.needs_disambiguation),
    needs_context_resolution: Boolean(obj.needs_context_resolution),
    is_follow_up: Boolean(obj.is_follow_up),
    response_style: obj.response_style || "professional_conversational",
  };
}

/**
 * Clasificación por reglas (fallback). Compatible con classifyIntentInfo.
 */
function classifyWithRules(message, uiLang = "en") {
  const m = String(message || "").trim().toLowerCase();
  if (!m) return { primary_intent: "conversational", needs_data: false, needs_sql: false, needs_analysis: false, needs_disambiguation: false, needs_context_resolution: false, is_follow_up: false };

  const isGreeting =
    /^(hi|hello|hey|hola|buenas|buenos\s+dias|buenas\s+tardes|buenos\s+dias|good\s+morning|good\s+afternoon)\b/.test(m) ||
    m.length <= 4;
  if (isGreeting) return { primary_intent: "greeting", needs_data: false, needs_sql: false, needs_analysis: false, needs_disambiguation: false, needs_context_resolution: false, is_follow_up: false };

  const isHelp = /(que\s+puedes\s+hacer|ayuda|help|what\s+can\s+you|capabilities|menu)\b/.test(m);
  if (isHelp) return { primary_intent: "help", needs_data: false, needs_sql: false, needs_analysis: false, needs_disambiguation: false, needs_context_resolution: false, is_follow_up: false };

  const isProfile = /\b(me\s+llamo|mi\s+nombre|my\s+name|i'?m\s+\w+)\b/.test(m);
  if (isProfile) return { primary_intent: "conversational", needs_data: false, needs_sql: false, needs_analysis: false, needs_disambiguation: false, needs_context_resolution: false, is_follow_up: false };

  // Entity-switch follow-up ("What about Maria?") must NOT be conversational_followup
  if (isEntitySwitchFollowUp(m)) {
    return { primary_intent: "follow_up", needs_data: true, needs_sql: true, needs_analysis: false, needs_disambiguation: false, needs_context_resolution: true, is_follow_up: true };
  }

  // Conversational follow-up: ask for more on PREVIOUS answer, NOT new data/entity/period
  const isConversationalFollowup =
    /^(what\s+else\s+can\s+you\s+tell\s+me|tell\s+me\s+more|explain\s+that|go\s+on|continue|anything\s+else|what\s+else)\??\s*$/i.test(m) ||
    /^(can\s+you\s+give\s+me\s+more\s+detail|give\s+me\s+more\s+detail|more\s+detail\s+please)\??\s*$/i.test(m) ||
    /^[¿]?(qu[eé]\s+m[aá]s\s+(me\s+)?puedes\s+decir|dime\s+m[aá]s|explica(?:me)?\s+eso|continua|sigue|algo\s+m[aá]s|qu[eé]\s+m[aá]s)\??\s*$/i.test(m) ||
    /^(what\s+else\s+can\s+you\s+tell|tell\s+me\s+more\s+about\s+that|explain\s+(that|more)|elaborate|expand\s+on\s+that)\??\s*$/i.test(m) ||
    /^(cuentame\s+m[aá]s|amplia|desarrolla|d[aá]me\s+m[aá]s\s+detalle|m[aá]s\s+detalle)\??\s*$/i.test(m);
  if (isConversationalFollowup) {
    return { primary_intent: "conversational_followup", needs_data: false, needs_sql: false, needs_analysis: false, needs_disambiguation: false, needs_context_resolution: false, is_follow_up: true };
  }

  // Analysis follow-up: interpret PREVIOUS result (what does that mean, why is that, is that good/bad)
  const isAnalysisFollowup =
    /^(what\s+does\s+that\s+mean|why\s+is\s+that|why\s+is\s+it|is\s+that\s+good\s+or\s+bad|what\s+should\s+we\s+investigate|anything\s+unusual\s+there|why\s+do\s+you\s+think\s+that\s+happened|why\s+did\s+that\s+happen|why\s+did\s+it\s+happen)\??\s*$/i.test(m) ||
    /^[¿]?(que\s+significa\s+eso|por\s+qu[eé]\s+pas[oó]\s+eso|(?:es\s+eso|eso\s+es)\s+bueno\s+o\s+malo|que\s+deber[ií]amos\s+investigar|hay\s+algo\s+inusual|que\s+crees\s+que\s+pas[oó])\??\s*$/i.test(m) ||
    /^(what\s+do\s+you\s+think|any\s+red\s+flags|any\s+concerns)\??\s*$/i.test(m) ||
    /^[¿]?(que\s+te\s+parece|alguna\s+se[nñ]al\s+de\s+alerta|algo\s+que\s+preocupe)\??\s*$/i.test(m);
  if (isAnalysisFollowup) {
    return { primary_intent: "analysis_followup", needs_data: false, needs_sql: false, needs_analysis: false, needs_disambiguation: false, needs_context_resolution: false, is_follow_up: true };
  }

  const isFollowUp =
    /^(y\s+el\s+mes\s+pasado|and\s+last\s+month|y\s+ayer|and\s+yesterday|y\s+esta\s+semana|what\s+about\s+\w+|compare\s+that|and\s+maria|y\s+maria|which\s+one)\b/i.test(m) ||
    /^\s*(and|y)\s+(last|el)\s+/.test(m);
  if (isFollowUp) return { primary_intent: "follow_up", needs_data: true, needs_sql: true, needs_analysis: false, needs_disambiguation: false, needs_context_resolution: true, is_follow_up: true };

  const hasKpi = /\b(how\s+many|cu[aá]ntos?|top\s+\d+|confirmed|dropped|cases|casos|ranking)\b/.test(m);
  const hasAnalysis = /\b(why|por\s+qu[eé]|analiz|compare|compare|explain|interpret)\b/.test(m);

  if (hasAnalysis && hasKpi) return { primary_intent: "mixed", needs_data: true, needs_sql: true, needs_analysis: true, needs_disambiguation: false, needs_context_resolution: false, is_follow_up: false };
  if (hasAnalysis) return { primary_intent: "analysis", needs_data: true, needs_sql: true, needs_analysis: true, needs_disambiguation: false, needs_context_resolution: false, is_follow_up: false };
  if (hasKpi) return { primary_intent: "kpi", needs_data: true, needs_sql: true, needs_analysis: false, needs_disambiguation: false, needs_context_resolution: false, is_follow_up: false };

  const isVeryShort = m.split(/\s+/).length <= 2 && m.length < 20;
  if (isVeryShort) return { primary_intent: "conversational", needs_data: false, needs_sql: false, needs_analysis: false, needs_disambiguation: true, needs_context_resolution: false, is_follow_up: false };

  return { primary_intent: "kpi", needs_data: true, needs_sql: true, needs_analysis: false, needs_disambiguation: false, needs_context_resolution: false, is_follow_up: false };
}

/**
 * Clasifica el mensaje. Usa IA si está habilitada, si no reglas.
 * @param {string} message - Mensaje del usuario
 * @param {object} context - Contexto conversacional
 * @param {object} opts - { useAI: true, logEnabled }
 */
async function classifyIntent(message, context = {}, opts = {}) {
  const useAI = opts.useAI !== false && process.env.AI_ORCHESTRATOR_ENABLED !== "false";
  const uiLang = context?.uiLang || "en";

  // Explicit entity-switch always wins: must be follow_up with needs_data, never conversational_followup
  if (isEntitySwitchFollowUp(message)) {
    return { primary_intent: "follow_up", needs_data: true, needs_sql: true, needs_analysis: false, needs_disambiguation: false, needs_context_resolution: true, is_follow_up: true };
  }

  if (useAI) {
    const aiResult = await classifyWithAI(message, { ...context, uiLang });
    if (aiResult) return aiResult;
  }

  return classifyWithRules(message, uiLang);
}

module.exports = {
  classifyIntent,
  classifyWithRules,
  classifyWithAI,
  INTENTS,
};
