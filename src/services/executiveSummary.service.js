// services/executiveSummary.service.js
const openai = require('../infra/openai.client');
const { getAssistantProfile } = require('./assistantProfile');

function fmtKpiPayload({ windowLabel, kpis }) {
  return JSON.stringify(
    {
      windowLabel,
      kpis: {
        total: Number(kpis.total || 0),
        confirmed: Number(kpis.confirmed || 0),
        confirmationRate: Number(kpis.confirmationRate || 0),
        dropped: Number(kpis.dropped || 0),
        droppedRate: Number(kpis.droppedRate || 0),
        active: Number(kpis.active || 0),
        referOut: Number(kpis.referOut || 0),
        problemCases: Number(kpis.problemCases || 0),
      },
    },
    null,
    2
  );
}

async function generateExecutiveSummary({ lang = 'en', windowLabel, kpis, userName = null }) {
  const isEs = lang === 'es';
  const profile = getAssistantProfile(lang);

  const payload = fmtKpiPayload({ windowLabel, kpis });

  const prompt = isEs
    ? `
MODO: DASHBOARD_EXEC_SUMMARY

Contexto:
- Este resumen es para un dashboard ejecutivo.
- Debe basarse SOLO en los KPIs provistos (no inventar métricas).
- No menciones SQL, tablas, ni "dataset".

Periodo:
${windowLabel}

KPIs (JSON):
${payload}

INSTRUCCIONES:
- Devuelve SOLO bullets (una línea por bullet).
- 4 a 6 bullets máximo.
- Cada bullet debe incluir al menos 1 número (cantidad o %).
- Si mencionas una tasa (%), incluye numerador y denominador (ej: 15 de 995).
- Señala: 1 lectura ejecutiva, 1 diagnóstico, 1-2 acciones, 1 riesgo si aplica.
- Usa términos: "confirmados" y "tasa de confirmación" (NO "conversión").
- NO uses símbolos de moneda.
`.trim()
    : `
MODE: DASHBOARD_EXEC_SUMMARY

Context:
- This executive summary is for a dashboard.
- Use ONLY the provided KPIs (do not invent metrics).
- Do not mention SQL, tables, or "dataset".

Period:
${windowLabel}

KPIs (JSON):
${payload}

INSTRUCTIONS:
- Output ONLY bullets (one line per bullet).
- 4 to 6 bullets max.
- Each bullet must include at least 1 number (count or %).
- If you state a rate (%), include numerator/denominator (e.g., 15 of 995).
- Include: 1 executive read, 1 diagnosis, 1-2 actions, 1 risk if applicable.
- Use terms: "confirmed" and "confirmation rate" (NOT "conversion").
- No currency symbols.
`.trim();

  const response = await openai.responses.create({
    model: 'gpt-4.1-mini',
    // bajo para que sea estable y consistente
    max_output_tokens: 220,
    input: [
      {
        role: 'system',
        content: isEs
          ? `Tu nombre es ${profile.name}. Eres un asesor ejecutivo de operaciones. ${profile.style}`
          : `Your name is ${profile.name}. You are an executive operations advisor. ${profile.style}`,
      },
      { role: 'user', content: prompt },
    ],
  });

  const raw = response.output?.[0]?.content?.[0]?.text || '';
  return String(raw || '').trim();
}

module.exports = { generateExecutiveSummary };
