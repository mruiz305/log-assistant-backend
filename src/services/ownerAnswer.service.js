const openai = require('../infra/openai.client');
const { sanitizeRowsForSummary } = require('./summarySanitizer.service');
const { classifyIntent } = require('./intent');

function buildPrompt({ lang, today, dayOfMonth, question, intent, sql, rowCount, payload, kpiWindow }) {
  if (lang === 'es') {
    return `
Hoy es ${today} (día ${dayOfMonth}).

Pregunta:
"${question}"

INTENT_DETECTADO: ${intent}

SQL (solo referencia, NO lo repitas):
${(sql || '').toString().slice(0, 1200)}

RowCount: ${rowCount}
Periodo:
${kpiWindow || 'N/A'}

Datos (payload):
${payload}

REGLAS CRÍTICAS (FORMATO):
- El PRIMER bullet debe empezar con el periodo: "ℹ️ ${kpiWindow || 'Periodo'}: ..."
- Máximo 4 bullets.
- Cada bullet ≤ 16 palabras.
- Cada bullet debe incluir al menos 1 número (cantidad o %).
- TODOS los números deben usar separación de miles con coma.
  Ejemplos CORRECTOS: 1,184 | 20,435 | 2,057 | 1,234.5
  Ejemplos INCORRECTOS: 1184 | 20435
- Usar punto solo para decimales.
- NO usar símbolos de moneda.
- NO usar frases vagas.
- Si incluye MES ACTUAL y hoy es antes del día 7:
  - usar ℹ️ "datos parciales"
  - NO declarar caídas vs meses cerrados
- Iconos:
  🔴 problema real | 🟡 atención | 🟢 positivo | ℹ️ informativo
- Si no hay números útiles: "ℹ️ Sin datos suficientes para concluir."
- Devuelve SOLO bullets (una línea por bullet).
- PROHIBIDO usar: "convertido", "convertidos", "conversión", "tasa de conversión".
- Debes usar SIEMPRE: "confirmados" y "tasa de confirmación".
- Si el usuario dice "convertido": corrige el término y responde usando "confirmado".

REGLAS DE NEGOCIO (CLAVE):
- Confirmed=1 = CASOS CONFIRMADOS (confirmed_cases). NO es "Case converted".
- "Conversion value" del dashboard = case_converted_value = SUM(convertedValue) (crédito/valor).
- Status/ClinicalStatus = salud operativa (Problem/Dropped/Ref Out). NO invalida confirmados ni crédito.
- Dropped SUBE = MALO (🔴/🟡). Dropped BAJA = BUENO (🟢). Nunca “inestable” si baja.

INTENCIÓN:
- Si intent=cnv: di "confirmados" y "tasa de confirmación"; NUNCA "convertidos/conversión".
- Si intent=health: prioriza Problem/Dropped y tasas (%).
- Si intent=mix: menciona confirmados + leakage (confirmados con Problem/Dropped/Clinical dropped) y crédito.

BASELINE (KPI PACK):
- Si kpiPack existe: úsalo como números base:
  gross_cases, confirmed_cases, confirmed_rate, case_converted_value, dropped_rate, problem_rate.
- Si kpiPack contradice el sample: prioriza kpiPack (baseline del periodo).

MAPA DE ROLES (OBLIGATORIO):
- "submitter", "representante", "agent", "rep", "entered by" => submitterName/submitter
- "intake", "intake specialist", "locked down" => intakeSpecialist
- "attorney", "abogado" => attorney
- "office", "oficina" => OfficeName
- "team", "equipo" => TeamName
- "pod" => PODEName
- "region" => RegionName
- "director" => DirectorName

NOTA:
- Si el dataset trae columnas anio/mes (agrupado), habla en términos de tendencia.
- Si trae columnas por OfficeName/TeamName, menciona top 1-2 y magnitud.
- Si mencionas una tasa (%), incluye numerador y denominador (ej: 18 de 803).
`.trim();
  }

  // English (default)
  return `
Today is ${today} (day ${dayOfMonth}).

Question:
"${question}"

DETECTED_INTENT: ${intent}

SQL (reference only, DO NOT repeat it):
${(sql || '').toString().slice(0, 1200)}

RowCount: ${rowCount}
Period:
${kpiWindow || 'N/A'}

Data (payload):
${payload}

CRITICAL FORMAT RULES:
- The FIRST bullet must start with the period: "ℹ️ ${kpiWindow || 'Period'}: ..."
- Max 4 bullets.
- Each bullet ≤ 16 words.
- Each bullet must include at least 1 number (count or %).
- ALL numbers must use thousands separators with commas.
  Correct: 1,184 | 20,435 | 2,057 | 1,234.5
  Wrong: 1184 | 20435
- Use dot only for decimals.
- Do NOT use currency symbols.
- No vague wording.
- If the question includes CURRENT MONTH and today is before day 7:
  - use ℹ️ "partial data"
  - do NOT claim MoM declines vs closed months
- Icons:
  🔴 real issue | 🟡 attention | 🟢 positive | ℹ️ informative
- If not enough numbers: "ℹ️ Not enough data to conclude."
- Output ONLY bullets (one per line).
- FORBIDDEN words: "converted", "conversion", "conversion rate", "CNV".
- Always use: "confirmed" and "confirmation rate".
- If user says "conversion/converted": correct terminology and answer with "confirmed".

BUSINESS RULES (KEY):
- Confirmed=1 = CONFIRMED CASES (confirmed_cases). Not "converted cases".
- Dashboard "conversion value" = case_converted_value = SUM(convertedValue) (credit/value).
- Status/ClinicalStatus = operational health (Problem/Dropped/Ref Out). Does NOT invalidate confirmed or credit.
- Dropped UP = BAD (🔴/🟡). Dropped DOWN = GOOD (🟢). Never call it “unstable” if it drops.

INTENT:
- If intent=cnv: focus on confirmed + confirmation rate; NEVER "conversion".
- If intent=health: focus on Problem/Dropped and rates.
- If intent=mix: mention confirmed + leakage (confirmed with Problem/Dropped/Clinical dropped) + credit.

BASELINE (KPI PACK):
- If kpiPack exists: use it as baseline numbers:
  gross_cases, confirmed_cases, confirmed_rate, case_converted_value, dropped_rate, problem_rate.
- If kpiPack contradicts the sample: trust kpiPack (baseline for the window).

NOTE:
- If output is grouped by year/month, speak in trend terms.
- If grouped by OfficeName/TeamName, call out top 1-2 and magnitude.
- If you mention a rate (%), include numerator and denominator (e.g., 18 of 803).
`.trim();
}

function postProcessTerminology(out, lang) {
  let s = String(out || '').trim();

  if (lang === 'es') {
    return s
      .replace(/\btasa\s+de\s+conversi[oó]n\s*\(cnv\)\b/gi, 'tasa de confirmación')
      .replace(/\btasa\s+de\s+conversi[oó]n\b/gi, 'tasa de confirmación')
      .replace(/\bconversi[oó]n(es)?\b/gi, 'confirmación')
      .replace(/\bconvertidos?\b/gi, 'confirmados')
      .replace(/\b\(?cnv\)?\b/gi, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/\(\s*\)/g, '')
      .replace(/\s+(?=\d+\.\s)/g, '\n')
      .trim();
  }

  // English
  return s
    .replace(/\bconversion\s+rate\b/gi, 'confirmation rate')
    .replace(/\bconversion\b/gi, 'confirmation')
    .replace(/\bconversions\b/gi, 'confirmations')
    .replace(/\bconverted\b/gi, 'confirmed')
    .replace(/\bconvert\b/gi, 'confirm')
    .replace(/\b\(?cnv\)?\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\(\s*\)/g, '')
    .trim();
}

async function buildOwnerAnswer(question, sql, rows, meta = {}) {
  const lang = meta?.lang === 'es' ? 'es' : 'en';

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const dayOfMonth = now.getDate();

  const intent = classifyIntent(question);

  const { summary, top, sample } = sanitizeRowsForSummary(question, rows);
  const rowCount = summary?.rowCount ?? 0;

  const payload = JSON.stringify({
    kpiWindow: meta?.kpiWindow || null,
    kpiPack: meta?.kpiPack || null,
    summary,
    top,
    sample,
  }).slice(0, 5000);

  const prompt = buildPrompt({
    lang,
    today,
    dayOfMonth,
    question,
    intent,
    sql,
    rowCount,
    payload,
    kpiWindow: meta?.kpiWindow || null,
  });

  const response = await openai.responses.create({
    model: 'gpt-4.1-mini',
    max_output_tokens: 170,
    input: [
      {
        role: 'system',
        content:
          lang === 'es'
            ? 'Eres un asesor ejecutivo de operaciones. Das bullets cortos, numéricos, y con conclusiones accionables.'
            : 'You are an executive operations advisor. Write short numeric bullets with actionable conclusions.',
      },
      { role: 'user', content: prompt },
    ],
  });

  const raw = response.output?.[0]?.content?.[0]?.text || '';
  return postProcessTerminology(raw, lang);
}

module.exports = { buildOwnerAnswer };
