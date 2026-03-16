/**
 * AI Query Planner
 * Planifica pasos de ejecución antes de correr SQL/análisis.
 * Usado cuando la intención requiere datos o análisis.
 */

const openai = require("../../../infra/openai.client");

const MODEL = process.env.OPENAI_ORCHESTRATOR_MODEL || "gpt-4.1-mini";

/**
 * Genera un plan de ejecución para la consulta.
 * @param {string} message - Mensaje del usuario (posiblemente expandido)
 * @param {object} classification - Resultado de classifyIntent
 * @param {object} context - Contexto conversacional
 */
async function planQuery(message, classification, context = {}) {
  const uiLang = context?.uiLang === "es" ? "es" : "en";
  const ctx = {
    lastPerson: context?.lastPerson || "",
    lastPeriod: context?.lastPeriod || "",
    lastMetric: context?.lastMetric || "",
    intent: classification?.primary_intent || "kpi",
  };

  const systemPrompt = uiLang === "es"
    ? `Eres un planificador de consultas para un asistente de analytics.
Dado el mensaje del usuario y la clasificación de intención, genera un plan de pasos.

Responde SOLO un JSON válido:
{"task_type":"kpi|analysis|sql_data|comparison","steps":["step1","step2"],"needs_data":true,"needs_sql":true,"needs_analysis":false,"needs_disambiguation":false,"suggested_period":"this month","suggested_entity":null}

task_type: kpi (métricas numéricas), analysis (explicación/por qué), sql_data (datos estructurados), comparison (comparar períodos/entidades)
steps: pasos sugeridos como "resolve_context","extract_filters","retrieve_data","generate_explanation"
suggested_period: si se infiere del mensaje (this month, last month, 2025, etc.)
suggested_entity: si se menciona persona/attorney (ej. "Maria", "Tony")`
    : `You are a query planner for a case analytics assistant.
Given the user message and intent classification, output an execution plan.

Respond ONLY with valid JSON:
{"task_type":"kpi|analysis|sql_data|comparison","steps":["step1","step2"],"needs_data":true,"needs_sql":true,"needs_analysis":false,"needs_disambiguation":false,"suggested_period":null,"suggested_entity":null}`;

  const userPrompt = `Intent: ${ctx.intent}\nContext: lastPerson="${ctx.lastPerson}", lastPeriod="${ctx.lastPeriod}", lastMetric="${ctx.lastMetric}"\nMessage: "${message}"`;

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
    return normalizePlan(parsed, classification);
  } catch (e) {
    return buildDefaultPlan(classification);
  }
}

function normalizePlan(obj, classification) {
  if (!obj || typeof obj !== "object") return buildDefaultPlan(classification);
  const taskTypes = ["kpi", "analysis", "sql_data", "comparison"];
  const taskType = taskTypes.includes(obj.task_type) ? obj.task_type : (classification?.needs_analysis ? "analysis" : "kpi");
  const steps = Array.isArray(obj.steps) ? obj.steps : ["resolve_context", "extract_filters", "retrieve_data"];
  return {
    task_type: taskType,
    steps,
    needs_data: obj.needs_data !== false,
    needs_sql: obj.needs_sql !== false,
    needs_analysis: Boolean(obj.needs_analysis),
    needs_disambiguation: Boolean(obj.needs_disambiguation),
    suggested_period: obj.suggested_period || null,
    suggested_entity: obj.suggested_entity || null,
  };
}

function buildDefaultPlan(classification) {
  return {
    task_type: classification?.needs_analysis ? "analysis" : "kpi",
    steps: ["resolve_context", "extract_filters", "retrieve_data"],
    needs_data: classification?.needs_data !== false,
    needs_sql: classification?.needs_sql !== false,
    needs_analysis: Boolean(classification?.needs_analysis),
    needs_disambiguation: Boolean(classification?.needs_disambiguation),
    suggested_period: null,
    suggested_entity: null,
  };
}

/**
 * Determines whether the planner adds value for this classification.
 * Used to avoid unnecessary LLM calls for simple requests.
 * Intents that benefit: follow-up, mixed, analysis, disambiguation.
 * Skipped: greeting, conversational, help, simple kpi.
 */
function shouldUsePlanner(classification) {
  if (!classification?.primary_intent) return false;
  const intent = classification.primary_intent;
  const beneficial = ["follow_up", "mixed", "analysis", "disambiguation"];
  if (beneficial.includes(intent)) return true;
  if (intent === "sql_data" && (classification.needs_disambiguation || classification.needs_context_resolution)) return true;
  if (intent === "kpi" && (classification.needs_context_resolution || classification.needs_disambiguation)) return true;
  return false;
}

module.exports = { planQuery, buildDefaultPlan, shouldUsePlanner };
