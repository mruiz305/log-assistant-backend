const openai = require('../infra/openai.client');
const { sanitizeRowsForSummary } = require('./summarySanitizer.service');
const { classifyIntent } = require('./intent');
const { getAssistantProfile } = require('./assistantProfile');

/** ✅ Detecta cuando el usuario quiere “análisis experto” */
function wantsExpertAnalysis(q = '') {
  const s = String(q || '').toLowerCase();
  return /(analisis|análisis|insight|recomend|recomendaci|como experto|expert|interpret|qué significa|que significa|por qué|porque|causa|acciones|siguientes pasos|estrateg|oportunidad|riesgo)/i.test(
    s
  );
}

function buildPrompt({
  lang,
  today,
  dayOfMonth,
  question,
  intent,
  sql,
  rowCount,
  payload,
  kpiWindow,
  userName,
  assistantName,
  assistantStyle,
  assistantGreeting,
  expertAnalysis,
}) {
  const isEs = lang === 'es';
  const who = userName ? (isEs ? `Usuario: ${userName}.` : `User: ${userName}.`) : '';
  const hello = userName ? `${assistantGreeting}, ${userName}.` : `${assistantGreeting}.`;

  // ✅ Boolean real
  const hasPeriod = Boolean(kpiWindow && String(kpiWindow).trim());

  // ✅ Solo mostramos “Periodo/Period” si existe (y nunca "N/A")
  const periodLine = hasPeriod
    ? (isEs ? `Periodo:\n${kpiWindow}\n` : `Period:\n${kpiWindow}\n`)
    : '';

  // ✅ Regla del primer bullet SOLO si hay periodo; si no hay, NO mencionar “sin filtro de tiempo”
  const firstBulletRule = hasPeriod
    ? (isEs
        ? `- El PRIMER bullet debe empezar con el periodo: "ℹ️ ${kpiWindow}: ..."\n`
        : `- The FIRST bullet must start with the period: "ℹ️ ${kpiWindow}: ..."\n`)
    : (isEs
        ? `- NO menciones "sin filtro de tiempo" ni inventes periodos.\n`
        : `- Do NOT mention "no time filter" or invent periods.\n`);

  // ✅ Cabecera común (ES/EN)
  const header = isEs
    ? `
Asistente: ${assistantName}.
Estilo: ${assistantStyle}
${who}

${hello}
Hoy es ${today} (día ${dayOfMonth}).

Pregunta:
"${question}"

INTENT_DETECTADO: ${intent}

SQL (solo referencia, NO lo repitas):
${(sql || '').toString().slice(0, 1200)}

RowCount: ${rowCount}
${periodLine}Datos (payload):
${payload}
`.trim()
    : `
Assistant: ${assistantName}.
Style: ${assistantStyle}
${who}

${hello}
Today is ${today} (day ${dayOfMonth}).

Question:
"${question}"

DETECTED_INTENT: ${intent}

SQL (reference only, DO NOT repeat it):
${(sql || '').toString().slice(0, 1200)}

RowCount: ${rowCount}
${periodLine}Data (payload):
${payload}
`.trim();

  const businessRules = isEs
    ? `
REGLAS DE NEGOCIO (CLAVE):
- Confirmed=1 = CASOS CONFIRMADOS (confirmed_cases). NO es "Case converted".
- "Conversion value" del dashboard = case_converted_value = SUM(convertedValue) (crédito/valor).
- Status/ClinicalStatus = salud operativa (Problem/Dropped/Ref Out). NO invalida confirmados ni crédito.
- Dropped SUBE = MALO (🔴/🟡). Dropped BAJA = BUENO (🟢). Nunca “inestable” si baja.
`.trim()
    : `
BUSINESS RULES (CRITICAL):
- Confirmed=1 = CONFIRMED CASES (confirmed_cases). NOT "Case converted".
- "Conversion value" in dashboard = case_converted_value = SUM(convertedValue) (credit/value).
- Status/ClinicalStatus = operational health (Problem/Dropped/Ref Out). Does NOT invalidate confirmed or credit.
- Dropped UP = BAD (🔴/🟡). Dropped DOWN = GOOD (🟢). Never say “unstable” if dropping.
`.trim();

  const baseline = isEs
    ? `
BASELINE (KPI PACK):
- Si kpiPack existe: úsalo como números base:
  gross_cases, confirmed_cases, confirmed_rate, case_converted_value, dropped_rate, problem_rate.
- Si kpiPack contradice el sample: prioriza kpiPack (baseline del periodo).
`.trim()
    : `
BASELINE (KPI PACK):
- If kpiPack exists: use it as baseline numbers:
  gross_cases, confirmed_cases, confirmed_rate, case_converted_value, dropped_rate, problem_rate.
- If kpiPack contradicts sample: prioritize kpiPack (period baseline).
`.trim();

  const intentRules = isEs
    ? `
INTENCIÓN:
- Si intent=cnv: di "confirmados" y "tasa de confirmación"; NUNCA "convertidos/conversión".
- Si intent=health: prioriza Problem/Dropped y tasas (%).
- Si intent=mix: menciona confirmados + leakage (confirmados con Problem/Dropped/Clinical dropped) y crédito.
`.trim()
    : `
INTENT:
- If intent=cnv: say "confirmed" and "confirmation rate"; NEVER "converted/conversion".
- If intent=health: prioritize Problem/Dropped and rates (%).
- If intent=mix: mention confirmed + leakage (confirmed with Problem/Dropped/Clinical dropped) and credit.
`.trim();

  const roleMap = isEs
    ? `
MAPA DE ROLES (OBLIGATORIO):
- "submitter", "representante", "agent", "rep", "entered by" => submitterName/submitter
- "intake", "intake specialist", "locked down" => intakeSpecialist
- "attorney", "abogado" => attorney
- "office", "oficina" => OfficeName
- "team", "equipo" => TeamName
- "pod" => PODEName
- "region" => RegionName
- "director" => DirectorName
`.trim()
    : `
ROLE MAPPING (MANDATORY):
- "submitter", "agent", "rep", "entered by" => submitterName/submitter
- "intake", "intake specialist", "locked down" => intakeSpecialist
- "attorney", "lawyer" => attorney
- "office" => OfficeName
- "team" => TeamName
- "pod" => PODEName
- "region" => RegionName
- "director" => DirectorName
`.trim();

  const note = isEs
    ? `
NOTA:
- Si el dataset trae columnas anio/mes (agrupado), habla en términos de tendencia.
- Si trae columnas por OfficeName/TeamName, menciona top 1-2 y magnitud.
- Si mencionas una tasa (%), incluye numerador y denominador (ej: 18 de 803).
`.trim()
    : `
NOTE:
- If dataset includes year/month columns (grouped), speak in trend terms.
- If grouped by OfficeName/TeamName, mention top 1–2 with magnitude.
- If you mention a rate (%), include numerator and denominator (e.g., 18 of 803).
`.trim();

  const terminology = isEs
    ? `
REGLAS DE TERMINOLOGÍA:
- PROHIBIDO usar: "convertido", "convertidos", "conversión", "tasa de conversión".
- Debes usar SIEMPRE: "confirmados" y "tasa de confirmación".
- Si el usuario dice "convertido": corrige el término y responde usando "confirmado".
`.trim()
    : `
TERMINOLOGY:
- FORBIDDEN: "converted", "conversion", "conversion rate", "CNV".
- Always use: "confirmed" and "confirmation rate".
- If user says "converted", correct the term and respond using "confirmed".
`.trim();

  // ✅ EXPERT vs NORMAL
  if (expertAnalysis) {
    return `
${header}

${isEs ? 'MODO: ANALISIS_EXPERTO' : 'MODE: EXPERT_ANALYSIS'}

${isEs ? 'REGLAS (FORMATO):' : 'FORMAT RULES:'}
- ${isEs ? 'Devuelve SOLO bullets (una línea por bullet).' : 'Output ONLY bullets (one per line).'}
- ${isEs ? 'Entre 6 y 9 bullets.' : '6 to 9 bullets.'}
- ${isEs ? 'Cada bullet ≤ 26 palabras.' : 'Each bullet ≤ 26 words.'}
${firstBulletRule}- ${isEs ? 'Cada bullet debe incluir al menos 1 número (cantidad o %).' : 'Each bullet must include at least 1 number (count or %).'}
- ${isEs ? 'Si mencionas una tasa (%), incluye numerador y denominador (ej: 18 de 803).' : 'If you state a rate (%), include numerator/denominator (e.g., 18 of 803).'}
- ${isEs ? 'TODOS los números deben usar separación de miles con coma.' : 'Use thousands separators with commas.'}
- ${isEs ? 'Usar punto solo para decimales.' : 'Use dot only for decimals.'}
- ${isEs ? 'NO usar símbolos de moneda.' : 'No currency symbols.'}
- ${isEs
        ? 'Iconos: 🔎 diagnóstico | 🎯 acción | 🔴 riesgo | 🟡 atención | 🟢 positivo | ℹ️ informativo | ❓ siguiente paso'
        : 'Icons: 🔎 diagnosis | 🎯 action | 🔴 risk | 🟡 watch | 🟢 positive | ℹ️ info | ❓ next step'}

${isEs ? 'CONTENIDO OBLIGATORIO:' : 'REQUIRED CONTENT:'}
- ${isEs ? '1 bullet de lectura ejecutiva (qué está pasando).' : '1 executive read bullet (what’s happening).'}
- ${isEs ? '1 bullet de diagnóstico (qué sugiere el patrón).' : '1 diagnosis bullet (what the pattern suggests).'}
- ${isEs ? '2 bullets de acciones concretas (qué hacer hoy / esta semana).' : '2 concrete action bullets (what to do today / this week).'}
- ${isEs ? '1 bullet de riesgo/alerta (si aplica).' : '1 risk/alert bullet (if applicable).'}
- ${isEs ? '1 bullet con pregunta inteligente de siguiente paso.' : '1 smart next-step question bullet.'}

${terminology}

${businessRules}

${intentRules}

${baseline}

${roleMap}

${note}
`.trim();
  }

  // ✅ NORMAL
  return `
${header}

${isEs ? 'REGLAS CRÍTICAS (FORMATO):' : 'CRITICAL FORMAT RULES:'}
${firstBulletRule}- ${isEs ? 'Máximo 4 bullets.' : 'Max 4 bullets.'}
- ${isEs ? 'Cada bullet ≤ 16 palabras.' : 'Each bullet ≤ 16 words.'}
- ${isEs ? 'Cada bullet debe incluir al menos 1 número (cantidad o %).' : 'Each bullet must include at least 1 number (count or %).'}
- ${isEs ? 'TODOS los números deben usar separación de miles con coma.' : 'ALL numbers must use thousands separators with commas.'}
- ${isEs ? 'Usar punto solo para decimales.' : 'Use dot only for decimals.'}
- ${isEs ? 'NO usar símbolos de moneda.' : 'Do NOT use currency symbols.'}
- ${isEs ? 'NO usar frases vagas.' : 'No vague wording.'}
${isEs ? `- Si incluye MES ACTUAL y hoy es antes del día 7:
  - usar ℹ️ "datos parciales"
  - NO declarar caídas vs meses cerrados` : `- If current month and today is before day 7:
  - use ℹ️ "partial data"
  - do NOT claim drops vs closed months`}
- ${isEs
        ? 'Iconos: 🔴 problema real | 🟡 atención | 🟢 positivo | ℹ️ informativo'
        : 'Icons: 🔴 real issue | 🟡 attention | 🟢 positive | ℹ️ informative'}
- ${isEs ? 'Si no hay números útiles: "ℹ️ Sin datos suficientes para concluir."' : 'If no useful numbers: "ℹ️ Not enough data to conclude."'}
- ${isEs ? 'Devuelve SOLO bullets (una línea por bullet).' : 'Output ONLY bullets (one line per bullet).'}

${terminology}

${businessRules}

${intentRules}

${baseline}

${roleMap}

${note}
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
      .trim();
  }

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

function formatThousandsInText(text = '') {
  return String(text || '').replace(/\b(\d{4,})\b/g, (m) => {
    if (/^(19|20)\d{2}$/.test(m)) return m;
    return m.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  });
}

async function buildOwnerAnswer(question, sql, rows, meta = {}) {
  const lang = meta?.lang === 'es' ? 'es' : 'en';
  const profile = getAssistantProfile(lang);

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const dayOfMonth = now.getDate();

  const intent = classifyIntent(question);
  const expertAnalysis = wantsExpertAnalysis(question);

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
    userName: meta?.userName || null,
    assistantName: profile.name,
    assistantStyle: profile.style,
    assistantGreeting: profile.greeting,
    expertAnalysis,
  });

  const response = await openai.responses.create({
    model: 'gpt-4.1-mini',
    max_output_tokens: expertAnalysis ? 320 : 170,
    input: [
      {
        role: 'system',
        content:
          lang === 'es'
            ? `Tu nombre es ${profile.name}. Eres un asesor ejecutivo de operaciones. ${profile.style}`
            : `Your name is ${profile.name}. You are an executive operations advisor. ${profile.style}`,
      },
      { role: 'user', content: prompt },
    ],
  });

  const raw = response.output?.[0]?.content?.[0]?.text || '';
  let cleaned = postProcessTerminology(raw, lang);

  // ✅ si NO hay kpiWindow, eliminamos cualquier frase "sin filtro de tiempo"
  if (!meta?.kpiWindow || !String(meta.kpiWindow).trim()) {
    cleaned = cleaned
      .split('\n')
      .filter((l) => !/sin filtro de tiempo|no time filter/i.test(l))
      .join('\n')
      .trim();
  }

  return formatThousandsInText(cleaned);
}

module.exports = { buildOwnerAnswer };
