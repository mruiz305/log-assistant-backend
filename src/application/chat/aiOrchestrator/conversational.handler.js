/**
 * Conversational Handler
 * Responde a mensajes puramente conversacionales (saludos, cháchara) y a follow-ups
 * (what else, tell me more, explain that) usando contexto previo cuando existe.
 */

const openai = require("../../../infra/openai.client");
const { getAssistantProfile } = require("../../../services/assistantProfile");
const { getUserName } = require("../../../domain/context/userProfile");
const { buildSuggestions } = require("../../../domain/ui/suggestions.builder");

const MODEL = process.env.OPENAI_ORCHESTRATOR_MODEL || "gpt-4.1-mini";

/**
 * Maneja mensajes conversacionales (greeting, chitchat), follow-ups (tell me more) y analysis follow-ups (why is that, is that good or bad).
 */
async function handleConversational({ message, cid, uiLang, logEnabled, reqId, isFollowUp = false, isAnalysisFollowup = false, context = null }) {
  const lang = uiLang === "es" ? "es" : "en";
  const userName = cid ? getUserName(cid) : null;
  const profile = getAssistantProfile(lang);

  const hasContext = isFollowUp && context && (context.lastPerson || context.lastPeriod || context.lastMetric);

  let systemPrompt;
  if (hasContext && isAnalysisFollowup) {
    const ctxParts = [];
    if (context.lastPerson) ctxParts.push(lang === "es" ? `entidad: ${context.lastPerson}` : `entity: ${context.lastPerson}`);
    if (context.lastPeriod) ctxParts.push(lang === "es" ? `período: ${context.lastPeriod}` : `period: ${context.lastPeriod}`);
    if (context.lastMetric) ctxParts.push(lang === "es" ? `métrica: ${context.lastMetric}` : `metric: ${context.lastMetric}`);
    const ctxStr = ctxParts.join(", ");
    systemPrompt = lang === "es"
      ? `Eres ${profile.name}, un asistente de analytics. El usuario pregunta sobre la interpretación del resultado anterior (qué significa, por qué, si es bueno o malo, qué investigar). Contexto: ${ctxStr}. Da una interpretación concisa y profesional. No ejecutes nuevas consultas. Ofrece perspectivas, banderas rojas si aplica, y sugerencias de próximos pasos.`
      : `You are ${profile.name}, an analytics assistant. The user is asking about the interpretation of the previous result (what it means, why, good or bad, what to investigate). Context: ${ctxStr}. Provide a concise professional interpretation. Do not run new queries. Offer perspectives, red flags if applicable, and suggestions for next steps.`;
  } else if (hasContext) {
    const ctxParts = [];
    if (context.lastPerson) ctxParts.push(lang === "es" ? `entidad/persona: ${context.lastPerson}` : `entity/person: ${context.lastPerson}`);
    if (context.lastPeriod) ctxParts.push(lang === "es" ? `período: ${context.lastPeriod}` : `period: ${context.lastPeriod}`);
    if (context.lastMetric) ctxParts.push(lang === "es" ? `métrica: ${context.lastMetric}` : `metric: ${context.lastMetric}`);
    const ctxStr = ctxParts.join(", ");
    systemPrompt = lang === "es"
      ? `Eres ${profile.name}, un asistente de analytics. El usuario pidió más información sobre la respuesta anterior. El contexto reciente fue: ${ctxStr}. Elabora brevemente sobre ese tema (2-3 oraciones). No ejecutes nuevas consultas. Ofrece perspectivas o sugerencias basadas en el contexto.`
      : `You are ${profile.name}, an analytics assistant. The user asked for more on the previous answer. Recent context was: ${ctxStr}. Elaborate briefly on that topic (2-3 sentences). Do not run new queries. Offer perspectives or suggestions based on the context.`;
  } else {
    systemPrompt = lang === "es"
      ? `Eres ${profile.name}, un asistente de analytics profesional y amigable. Responde de forma breve y natural a saludos o comentarios conversacionales. No des datos ni análisis a menos que te lo pidan. Máximo 2-3 oraciones. Mantén tono profesional pero cercano.`
      : `You are ${profile.name}, a professional and friendly analytics assistant. Reply briefly and naturally to greetings or conversational comments. Don't provide data or analysis unless asked. Max 2-3 sentences. Keep a professional but warm tone.`;
  }

  const userGreeting = userName ? (lang === "es" ? `El usuario ${userName} dice: "${message}"` : `User ${userName} says: "${message}"`) : `User says: "${message}"`;

  try {
    const response = await openai.responses.create({
      model: MODEL,
      max_output_tokens: 150,
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userGreeting },
      ],
    });
    const text = (response?.output?.[0]?.content?.[0]?.text || "").trim();
    if (!text) throw new Error("Empty response");

    return {
      ok: true,
      answer: text,
      rowCount: 0,
      aiComment: isAnalysisFollowup ? "analysis_followup" : hasContext ? "conversational_followup" : "conversational",
      userName: userName || null,
      chart: null,
      suggestions: buildSuggestions(message, uiLang),
    };
  } catch (e) {
    if (logEnabled) console.error(`[${reqId}] [conversational] LLM failed:`, e?.message);
    return {
      ok: true,
      answer: lang === "es"
        ? "Hola, ¿en qué puedo ayudarte hoy con los analytics?"
        : "Hi, how can I help you with analytics today?",
      rowCount: 0,
      aiComment: "conversational_fallback",
      userName: userName || null,
      chart: null,
      suggestions: buildSuggestions(message, uiLang),
    };
  }
}

module.exports = { handleConversational };
