// services/ownerAnswer.service.js  (o el archivo donde tengas esto)
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

/**
 * ✅ Prompt builder (versión menos “robótica”):
 * - Permite 1 línea inicial de contexto (no bullet)
 * - Bullets más largos (más naturales)
 * - Números requeridos solo en 2 bullets (normal) / en la mayoría (experto)
 * - Menos meta-texto (INTENT_DETECTADO, RowCount, SQL) para no contaminar el tono
 * - Incluye 1 ejemplo de salida
 */
function buildPrompt({
  lang,
  today,
  dayOfMonth,
  question,
  intent,
  sql, // solo referencia: lo minimizamos para no “robotizar”
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

  const hasPeriod = Boolean(kpiWindow && String(kpiWindow).trim());

  // Solo mostramos Periodo si existe (sin N/A)
  const periodLine = hasPeriod
    ? (isEs ? `Periodo: ${kpiWindow}` : `Period: ${kpiWindow}`)
    : '';

  // Primera línea opcional (solo si hay periodo)
  const firstLineRule = hasPeriod
    ? (isEs
        ? `- La PRIMERA línea (no bullet) puede ser: "ℹ️ ${kpiWindow}: ..." (opcional).`
        : `- The FIRST line (not a bullet) may be: "ℹ️ ${kpiWindow}: ..." (optional).`)
    : (isEs
        ? `- No inventes periodos ni menciones "sin filtro de tiempo".`
        : `- Do not invent periods or mention "no time filter".`);

  // ✅ Cabecera “humana” (menos meta)
  // NOTA: dejamos intent/sql/rowCount fuera del “texto principal”; se van a un bloque interno reducido.
  const header = isEs
    ? `
Asistente: ${assistantName}.
Estilo: ${assistantStyle}
${who}

${hello}
Hoy es ${today} (día ${dayOfMonth}).

Pregunta:
"${question}"

${periodLine ? `${periodLine}\n` : ''}

Contexto (resumen de datos):
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

${periodLine ? `${periodLine}\n` : ''}

Context (data summary):
${payload}
`.trim();

  // ✅ Reglas de negocio (las mantenemos, pero sin gritar)
  const businessRules = isEs
    ? `
Reglas de negocio clave:
- Confirmed=1 = casos confirmados (confirmed_cases). No es "case converted".
- "Conversion value" del dashboard = case_converted_value = SUM(convertedValue) (crédito/valor).
- Status/ClinicalStatus describe salud operativa (Problem/Dropped/Ref Out) y NO invalida confirmados ni crédito.
- Dropped sube = malo; Dropped baja = bueno.
`.trim()
    : `
Key business rules:
- Confirmed=1 = confirmed cases (confirmed_cases). Not "case converted".
- "Conversion value" = case_converted_value = SUM(convertedValue) (credit/value).
- Status/ClinicalStatus is operational health (Problem/Dropped/Ref Out); it does NOT invalidate confirmed or credit.
- Dropped up = bad; Dropped down = good.
`.trim();

  const baseline = isEs
    ? `
Baseline:
- Si existe kpiPack: úsalo como números base (gross_cases, confirmed_cases, confirmed_rate, case_converted_value, dropped_rate, problem_rate).
- Si kpiPack contradice el sample: prioriza kpiPack.
`.trim()
    : `
Baseline:
- If kpiPack exists: use it as baseline (gross_cases, confirmed_cases, confirmed_rate, case_converted_value, dropped_rate, problem_rate).
- If kpiPack contradicts sample: prioritize kpiPack.
`.trim();

  const intentRules = isEs
    ? `
Intención:
- intent=cnv: usa "confirmados" y "tasa de confirmación".
- intent=health: prioriza Problem/Dropped y sus tasas.
- intent=mix: menciona confirmados + leakage (confirmados con Problem/Dropped/Clinical dropped) y crédito.
`.trim()
    : `
Intent:
- intent=cnv: use "confirmed" and "confirmation rate".
- intent=health: prioritize Problem/Dropped and rates.
- intent=mix: mention confirmed + leakage (confirmed with Problem/Dropped/Clinical dropped) and credit.
`.trim();

  const roleMap = isEs
    ? `
Mapa de roles:
- submitter/representante/agent/rep/entered by => submitterName/submitter
- intake/intake specialist/locked down => intakeSpecialist
- attorney/abogado => attorney
- office/oficina => OfficeName
- team/equipo => TeamName
- pod => PODEName
- region => RegionName
- director => DirectorName
`.trim()
    : `
Role mapping:
- submitter/agent/rep/entered by => submitterName/submitter
- intake/intake specialist/locked down => intakeSpecialist
- attorney/lawyer => attorney
- office => OfficeName
- team => TeamName
- pod => PODEName
- region => RegionName
- director => DirectorName
`.trim();

  const note = isEs
    ? `
Notas:
- Si hay anio/mes (agrupado), habla de tendencia.
- Si hay OfficeName/TeamName, menciona top 1–2 con magnitud.
- Si das una tasa (%), intenta incluir numerador/denominador (ej: 18 de 803).
`.trim()
    : `
Notes:
- If grouped by year/month, speak in trends.
- If grouped by OfficeName/TeamName, mention top 1–2 with magnitude.
- If you state a rate (%), try to include numerator/denominator (e.g., 18 of 803).
`.trim();

  // ✅ Terminología (suave)
  const terminology = isEs
    ? `
Terminología preferida:
- Usa "confirmados" y "tasa de confirmación" como términos estándar.
- Si el usuario dice "convertido/conversión", aclara con tacto y responde usando "confirmado/confirmación".
`.trim()
    : `
Preferred terminology:
- Use "confirmed" and "confirmation rate" as standard terms.
- If the user says "converted/conversion", gently clarify and answer using "confirmed/confirmation".
`.trim();

  // ✅ Ejemplo (muy importante para “naturalidad”)
  const example = isEs
    ? `
Ejemplo de salida (solo para guiar estilo):
ℹ️ Últimos 7 días: 803 casos; 18 confirmados (2.2%).
- 🟡 Confirmación baja: 18/803; revisa calidad de intake en top 2 oficinas.
- 🎯 Hoy: audita 10 confirmados con Problem/Dropped y corrige causa raíz.
- 🟢 Dropped bajó 0.8 pts; mantén el mismo flujo de seguimiento.
`.trim()
    : `
Example output (style guide):
ℹ️ Last 7 days: 803 cases; 18 confirmed (2.2%).
- 🟡 Low confirmation: 18/803; review intake quality in top 2 offices.
- 🎯 Today: audit 10 confirmed with Problem/Dropped and fix root cause.
- 🟢 Dropped down 0.8 pts; keep the same follow-up flow.
`.trim();

  // ✅ Bloque “interno” mínimo (para que no contamine el tono)
  // Si quieres, puedes apagarlo por completo.
  const internalTiny = isEs
    ? `
(Interno, no citar):
- intent=${intent}; rowCount=${rowCount}
- sql_ref=${String(sql || '').slice(0, 220)}
`.trim()
    : `
(Internal, do not quote):
- intent=${intent}; rowCount=${rowCount}
- sql_ref=${String(sql || '').slice(0, 220)}
`.trim();

  // ✅ EXPERT
  if (expertAnalysis) {
    return `
${header}

Modo: análisis experto (directo, humano, sin jerga técnica).

Guías de formato:
${firstLineRule}
- Devuelve 6–9 bullets (una línea por bullet).
- Cada bullet ≤ 28 palabras.
- Incluye números cuando aporten claridad; al menos 5 bullets deben tener 1 número o %.
- Si mencionas una tasa (%), intenta incluir numerador/denominador (ej: 18 de 803).
- Usa separador de miles con coma (1,234) y punto solo para decimales (12.3).
- No uses símbolos de moneda.
- Iconos sugeridos: 🔎 diagnóstico | 🎯 acción | 🔴 riesgo | 🟡 atención | 🟢 positivo | ℹ️ info | ❓ siguiente paso

Contenido recomendado:
- 1 bullet lectura ejecutiva (qué pasa).
- 1 bullet diagnóstico (qué sugiere).
- 2 bullets acciones concretas (hoy / esta semana).
- 1 bullet riesgo/alerta (si aplica).
- 1 bullet con pregunta inteligente de siguiente paso.

${terminology}

${businessRules}

${intentRules}

${baseline}

${roleMap}

${note}

${example}

${internalTiny}
`.trim();
  }

  // ✅ NORMAL (menos “robot”)
  return `
${header}

Guías de formato (naturales, pero concisas):
${firstLineRule}
- Puedes usar 1 línea inicial (no bullet) para contexto.
- Devuelve 3–5 bullets (una línea por bullet).
- Cada bullet ≤ 24 palabras.
- Al menos 2 bullets deben incluir 1 número o % (no todos).
- Usa separador de miles con coma (1,234) y punto solo para decimales (12.3).
- No uses símbolos de moneda.
- Evita generalidades; sé específico cuando puedas.
- Iconos sugeridos: 🔴 problema | 🟡 atención | 🟢 positivo | ℹ️ info

${terminology}

${businessRules}

${intentRules}

${baseline}

${roleMap}

${note}

${example}

${internalTiny}
`.trim();
}

/**
 * ✅ Post-proceso de terminología (menos agresivo)
 * - Ya NO reemplaza "conversión" en cualquier contexto
 * - Solo arregla frases KPI típicas
 * - Evita borrar "cnv" si está pegado a otra palabra
 */
function postProcessTerminology(out, lang) {
  let s = String(out || '').trim();

  if (lang === 'es') {
    s = s
      // casos típicos KPI
      .replace(/\btasa\s+de\s+conversi[oó]n\b/gi, 'tasa de confirmación')
      .replace(/\bconversion\s+value\b/gi, 'valor de crédito')
      // "convertidos" cuando claramente se refiere a casos
      .replace(/\bcasos?\s+convertidos?\b/gi, 'casos confirmados')
      .replace(/\bconvertidos?\b/gi, 'confirmados');

    // limpia tokens sueltos "(CNV)" o "CNV" cuando aparezcan aislados
    s = s.replace(/(\(|\s)\s*cnv\s*(\)|\s)/gi, ' ').replace(/\s{2,}/g, ' ').trim();
    return s;
  }

  s = s
    .replace(/\bconversion\s+rate\b/gi, 'confirmation rate')
    .replace(/\bconversion\s+value\b/gi, 'credit value')
    .replace(/\bconverted\s+cases\b/gi, 'confirmed cases')
    .replace(/\bconverted\b/gi, 'confirmed');

  s = s.replace(/(\(|\s)\s*cnv\s*(\)|\s)/gi, ' ').replace(/\s{2,}/g, ' ').trim();
  return s;
}

function formatThousandsInText(text = '') {
  return String(text || '').replace(/\b(\d{4,})\b/g, (m) => {
    // no tocar años
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
    // ✅ más tokens para que suene humano (menos telegráfico)
    max_output_tokens: expertAnalysis ? 420 : 260,
    input: [
      {
        role: 'system',
        content:
          lang === 'es'
            ? `Tu nombre es ${profile.name}. Eres un asesor ejecutivo de operaciones. Habla claro, natural y directo. ${profile.style}`
            : `Your name is ${profile.name}. You are an executive operations advisor. Speak clearly, naturally, and directly. ${profile.style}`,
      },
      { role: 'user', content: prompt },
    ],
  });

  const raw = response.output?.[0]?.content?.[0]?.text || '';
  let cleaned = postProcessTerminology(raw, lang);

  // ✅ si NO hay kpiWindow, eliminamos cualquier frase “sin filtro de tiempo”
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
