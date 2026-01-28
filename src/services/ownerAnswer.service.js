// src/services/ownerAnswer.service.js
const openai = require("../infra/openai.client");
const { sanitizeRowsForSummary } = require("./summarySanitizer.service");
const { classifyIntent } = require("./intent");
const { getAssistantProfile } = require("./assistantProfile");

/** ✅ Detecta cuando el usuario quiere “análisis experto” */
function wantsExpertAnalysis(q = "") {
  const s = String(q || "").toLowerCase();
  return /(analisis|análisis|insight|recomend|recomendaci|como experto|expert|interpret|qué significa|que significa|por qué|porque|causa|acciones|siguientes pasos|estrateg|oportunidad|riesgo)/i.test(
    s
  );
}

function detectAnswerMode(rows, meta = {}) {
  if (meta?.mode) return String(meta.mode).toLowerCase();

  const r = Array.isArray(rows) && rows[0] ? rows[0] : null;
  if (!r) return "default";

  const keys = Object.keys(r).map((k) => String(k).toLowerCase());

  const isPerf =
    keys.includes("ttd") ||
    keys.includes("confirmationrate") ||
    keys.includes("confirmed_rate") ||
    keys.includes("convertedvalue") ||
    keys.includes("case_converted_value") ||
    keys.includes("dropped_rate") ||
    keys.includes("dropped_cases");

  return isPerf ? "performance" : "default";
}

function buildPerformanceHintFromRows(rows) {
  const top = Array.isArray(rows) ? rows.slice(0, 10) : [];
  const normalized = top.map((r) => ({
    name:
      r.name ??
      r.submitterName ??
      r.submitter ??
      r.OfficeName ??
      r.TeamName ??
      r.PODEName ??
      r.RegionName ??
      r.DirectorName ??
      null,
    ttd: r.ttd ?? null,
    confirmed: r.confirmed ?? r.confirmed_cases ?? null,
    confirmationRate: r.confirmationRate ?? r.confirmed_rate ?? null,
    dropped_cases: r.dropped_cases ?? null,
    dropped_rate: r.dropped_rate ?? null,
    convertedValue: r.convertedValue ?? r.case_converted_value ?? null,
  }));

  return JSON.stringify(
    {
      performance_schema: {
        ttd: "total cases (count)",
        confirmed: "confirmed cases",
        confirmationRate: "confirmed/ttd * 100",
        dropped_cases: "dropped cases",
        dropped_rate: "dropped/ttd * 100",
        convertedValue: "SUM(convertedValue)",
      },
      top10: normalized,
      note: "If there is only 1 row, summarize only that entity. If there are multiple, highlight top performers + outliers.",
    },
    null,
    2
  ).slice(0, 5000);
}

/**
 * Helpers to detect "pobre" output and force a rewrite
 */
function countBullets(text = "") {
  const lines = String(text || "").split("\n");
  return lines.filter((l) => /^\s*-\s+/.test(l)).length;
}

function isTooPoor(text = "") {
  const t = String(text || "").trim();
  if (!t) return true;

  // Exact symptom
  if (
    /^Encontr[eé]\s+\d+\s+caso\(s\)\s+en\s+el\s+per[ií]odo\s+seleccionado\.?$/i.test(
      t
    )
  ) {
    return true;
  }

  // No bullets and very short
  if (countBullets(t) < 2 && t.length < 220) return true;

  return false;
}

/**
 * ✅ Prompt builder
 */
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
  answerMode,
  modeHint,
}) {
  const isEs = lang === "es";
  const who = userName
    ? isEs
      ? `Usuario: ${userName}.`
      : `User: ${userName}.`
    : "";
  const hello = userName ? `${assistantGreeting}, ${userName}.` : `${assistantGreeting}.`;

  const hasPeriod = Boolean(kpiWindow && String(kpiWindow).trim());
  const periodLine = hasPeriod ? (isEs ? `Periodo: ${kpiWindow}` : `Period: ${kpiWindow}`) : "";

  const firstLineRule = hasPeriod
    ? isEs
      ? `- La PRIMERA línea (no bullet) puede ser: "ℹ️ ${kpiWindow}: ..." (opcional).`
      : `- The FIRST line (not a bullet) may be: "ℹ️ ${kpiWindow}: ..." (optional).`
    : isEs
    ? `- No inventes periodos ni menciones "sin filtro de tiempo".`
    : `- Do not invent periods or mention "no time filter".`;

  const header = isEs
    ? `
Asistente: ${assistantName}.
Estilo: ${assistantStyle}
${who}

${hello}
Hoy es ${today} (día ${dayOfMonth}).

Pregunta:
"${question}"

${periodLine ? `${periodLine}\n` : ""}

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

${periodLine ? `${periodLine}\n` : ""}

Context (data summary):
${payload}
`.trim();

  const businessRules = isEs
    ? `
Reglas de negocio clave:
- Confirmed=1 = casos confirmados (confirmed_cases). NO es "case converted".
- "Valor de conversión" del dashboard = valor de conversión = SUM(convertedValue).
- "Valor de conversión" es un MONTO (no una unidad).
- El valor puede ser decimal; NO agregues "$", "USD", "dólares" ni moneda.
- Para "valor de conversión": escribe SOLO el número (ej: "valor de conversión: 40.31").
- NO agregues "unidades", "pts", "puntos" ni etiquetas de unidad. NO inventes unidad.
- Si el valor es 0 o nulo, dilo como "valor de conversión: 0".
- Status/ClinicalStatus describe salud operativa (Problem/Dropped/Ref Out) y NO invalida confirmados ni valor de conversión.
- Dropped sube = malo; Dropped baja = bueno.
- No uses símbolos de moneda.
`.trim()
    : `
Key business rules:
- Confirmed=1 = confirmed cases (confirmed_cases). Not "case converted".
- "Conversion value" = conversion value = SUM(convertedValue).
- "Conversion value" is an AMOUNT (not a unit).
- The value may be decimal; do NOT add "$", "USD", "dollars", or any currency.
- For "conversion value": write ONLY the number (e.g., "conversion value: 40.31").
- Do NOT add "units", "pts", "points", or any unit label. Do NOT invent a unit.
- If the value is 0 or null, say "conversion value: 0".
- Status/ClinicalStatus is operational health (Problem/Dropped/Ref Out); it does NOT invalidate confirmed nor conversion value.
- Dropped up = bad; Dropped down = good.
- Do not use currency symbols.
`.trim();

  const conversionValueRules = isEs
    ? `
- Si kpiPack trae case_converted_value (aunque sea 0), SIEMPRE menciona "valor de conversión: <número>" al menos una vez.
- Para "valor de conversión": escribe SOLO el número (sin unidades / sin moneda).
`.trim()
    : `
- If kpiPack includes case_converted_value (even if 0), ALWAYS mention "conversion value: <number>" at least once.
- For "conversion value": write ONLY the number (no units / no currency symbol).
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
- intent=mix: menciona confirmados + leakage y valor de conversión.
`.trim()
    : `
Intent:
- intent=cnv: use "confirmed" and "confirmation rate".
- intent=health: prioritize Problem/Dropped and rates.
- intent=mix: mention confirmed + leakage and conversion value.
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
- Si hay OfficeName/TeamName/PODEName/RegionName/DirectorName, menciona top 1–2 con magnitud.
- Si das una tasa (%), intenta incluir numerador/denominador (ej: 18 de 803).
`.trim()
    : `
Notes:
- If grouped by year/month, speak in trends.
- If grouped by OfficeName/TeamName/PODEName/RegionName/DirectorName, mention top 1–2 with magnitude.
- If you state a rate (%), try to include numerator/denominator (e.g., 18 of 803).
`.trim();

  const terminology = isEs
    ? `
Terminología preferida:
- Usa "confirmados" y "tasa de confirmación".
- Si el usuario dice "convertido/conversión", aclara con tacto y responde usando "confirmado/confirmación".
- Para el monto, usa "valor de conversión".
`.trim()
    : `
Preferred terminology:
- Use "confirmed" and "confirmation rate".
- If the user says "converted/conversion", gently clarify and answer using "confirmed/confirmation".
- For the amount, use "conversion value".
`.trim();

  const perfRules = isEs
    ? `
Modo PERFORMANCE:
- La tabla trae métricas por entidad (rep/oficina/pod/region/team/director).
- Siempre menciona: TTD, confirmed, confirmationRate, dropped_rate y convertedValue si están presentes.
- Si rowCount=1: analiza solo esa entidad.
- Si hay varias filas: resume top 3 por TTD o valor de conversión y 1–2 outliers (confirmationRate o dropped_rate).
- No inventes métricas que no estén en los datos.
`.trim()
    : `
PERFORMANCE mode:
- The table contains metrics by entity (rep/office/pod/region/team/director).
- Always mention: TTD, confirmed, confirmationRate, dropped_rate and convertedValue if present.
- If rowCount=1: analyze only that entity.
- If multiple rows: summarize top 3 by TTD or conversion value and 1–2 outliers (confirmationRate or dropped_rate).
- Do not invent metrics not present in the data.
`.trim();

  const example = isEs
    ? `
Ejemplo de salida (solo para guiar estilo):
ℹ️ Últimos 7 días: 803 casos; 18 confirmados (2.2%). Valor de conversión: 40.31
- 🟡 Confirmación baja: 18/803; revisa calidad de intake en top 2 oficinas.
- 🎯 Hoy: audita 10 confirmados con Problem/Dropped y corrige causa raíz.
- 🟢 Dropped bajó 0.8 pts; mantén el mismo flujo de seguimiento.
`.trim()
    : `
Example:
ℹ️ Last 7 days: 803 cases; 18 confirmed (2.2%). Conversion value: 40.31
- 🟡 Low confirmation: 18/803; review intake quality in top 2 offices.
- 🎯 Today: audit 10 confirmed with Problem/Dropped and fix root cause.
- 🟢 Dropped down 0.8 pts; keep the same follow-up flow.
`.trim();

  const internalTiny = isEs
    ? `
(Interno, no citar):
- intent=${intent}; rowCount=${rowCount}; mode=${answerMode || "default"}
- sql_ref=${String(sql || "").slice(0, 220)}
`.trim()
    : `
(Internal, do not quote):
- intent=${intent}; rowCount=${rowCount}; mode=${answerMode || "default"}
- sql_ref=${String(sql || "").slice(0, 220)}
`.trim();

  const modeBlock =
    answerMode === "performance"
      ? `\n${perfRules}\n${modeHint ? `\nPERF_HINT:\n${modeHint}\n` : ""}`
      : "";

  if (expertAnalysis) {
    return `
${header}

Modo: análisis experto (directo, humano, sin jerga técnica).

FORMATO OBLIGATORIO:
${firstLineRule}
- Devuelve SIEMPRE 7–9 bullets.
- Cada bullet debe empezar con "- " (guion + espacio).
- Cada bullet ≤ 28 palabras.
- Al menos 5 bullets deben incluir 1 número o %.
- Si mencionas una tasa (%), intenta incluir numerador/denominador.
- Usa separador de miles con coma y punto solo para decimales.
- No uses símbolos de moneda.
${conversionValueRules}

${terminology}

${businessRules}

${intentRules}

${baseline}

${roleMap}

${note}

${modeBlock}

${example}

${internalTiny}
`.trim();
  }

  return `
${header}

FORMATO OBLIGATORIO:
${firstLineRule}
- Devuelve SIEMPRE 4–6 bullets.
- Cada bullet debe empezar con "- " (guion + espacio).
- Cada bullet ≤ 24 palabras.
- Al menos 2 bullets deben incluir 1 número o %.
- Usa separador de miles con coma y punto solo para decimales.
- No uses símbolos de moneda.
- Si hay poca data, completa con: 1 riesgo, 1 acción inmediata, 1 siguiente paso (pregunta), sin inventar métricas.
${conversionValueRules}

${terminology}

${businessRules}

${intentRules}

${baseline}

${roleMap}

${note}

${modeBlock}

${example}

${internalTiny}
`.trim();
}

/**
 * ✅ Post-proceso de terminología (sin romper saltos de línea)
 */
function postProcessTerminology(out, lang) {
  let s = String(out || "").trim();

  const normalizeSpacesKeepNewlines = (text) =>
    String(text || "")
      .split("\n")
      .map((line) => line.replace(/[ \t]{2,}/g, " ").trimEnd())
      .join("\n")
      .trim();

  if (lang === "es") {
    s = s
      .replace(/\btasa\s+de\s+conversi[oó]n\b/gi, "tasa de confirmación")
      .replace(/\bconversion\s+value\b/gi, "valor de conversión")
      .replace(/\bcredit\s+value\b/gi, "valor de conversión")
      .replace(/\bvalor\s+de\s+cr[eé]dito\b/gi, "valor de conversión")
      .replace(/\bcasos?\s+convertidos?\b/gi, "casos confirmados")
      .replace(/\bconvertidos?\b/gi, "confirmados");

    s = s
      .replace(
        /\b(valor\s+de\s+conversi[oó]n)\s+de\s+([0-9]+(?:\.[0-9]+)?)\s+unidades\b/gi,
        "$1: $2"
      )
      .replace(
        /\b(valor\s+de\s+conversi[oó]n)\s*:\s*([0-9]+(?:\.[0-9]+)?)\s+unidades\b/gi,
        "$1: $2"
      )
      .replace(
        /\b(valor\s+de\s+conversi[oó]n)\s*:\s*\$?\s*([0-9]+(?:\.[0-9]+)?)\s*(usd|dolares|dólares)?\b/gi,
        "$1: $2"
      )
      .replace(
        /\b(valor\s+de\s+conversi[oó]n)\s+de\s+\$?\s*([0-9]+(?:\.[0-9]+)?)\s*(usd|dolares|dólares)?\b/gi,
        "$1: $2"
      );

    s = s.replace(/(\(|\s)\s*cnv\s*(\)|\s)/gi, " ");
    return normalizeSpacesKeepNewlines(s);
  }

  s = s
    .replace(/\bconversion\s+rate\b/gi, "confirmation rate")
    .replace(/\bcredit\s+value\b/gi, "conversion value")
    .replace(/\bconverted\s+cases\b/gi, "confirmed cases")
    .replace(/\bconverted\b/gi, "confirmed")
    .replace(
      /\bconversion\s+value\s+of\s+([0-9]+(?:\.[0-9]+)?)\s+units\b/gi,
      "conversion value: $1"
    )
    .replace(
      /\bconversion\s+value\s*:\s*([0-9]+(?:\.[0-9]+)?)\s+units\b/gi,
      "conversion value: $1"
    )
    .replace(
      /\bconversion\s+value\s*:\s*\$?\s*([0-9]+(?:\.[0-9]+)?)\s*(usd|dollars)?\b/gi,
      "conversion value: $1"
    );

  return normalizeSpacesKeepNewlines(s);
}

function formatThousandsInText(text = "") {
  return String(text || "").replace(/\b(\d{4,})\b/g, (m) => {
    if (/^(19|20)\d{2}$/.test(m)) return m; // no tocar años
    return m.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  });
}

async function buildOwnerAnswer(question, sql, rows, meta = {}) {
  const langRaw = String(meta?.lang || "").trim().toLowerCase();
  const lang = langRaw.startsWith("es") ? "es" : "en";

  const profile = getAssistantProfile(lang);

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const dayOfMonth = now.getDate();

  const intent = classifyIntent(question);
  const expertAnalysis = wantsExpertAnalysis(question);

  const answerMode = detectAnswerMode(rows, meta);
  const modeHint = answerMode === "performance" ? buildPerformanceHintFromRows(rows) : null;

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
    answerMode,
    modeHint,
  });

  // 1) first attempt
  const response1 = await openai.responses.create({
    model: "gpt-4.1-mini",
    max_output_tokens: expertAnalysis ? 520 : answerMode === "performance" ? 420 : 380,
    input: [
      {
        role: "system",
        content:
          lang === "es"
            ? `Tu nombre es ${profile.name}. Eres un asesor ejecutivo de operaciones. RESPONDE SIEMPRE en bullets que empiecen con "- ". ${profile.style}`
            : `Your name is ${profile.name}. You are an executive operations advisor. ALWAYS respond in bullets starting with "- ". ${profile.style}`,
      },
      { role: "user", content: prompt },
    ],
  });

  const raw1 = response1.output?.[0]?.content?.[0]?.text || "";
  let cleaned1 = postProcessTerminology(raw1, lang);

  if (!meta?.kpiWindow || !String(meta.kpiWindow).trim()) {
    cleaned1 = cleaned1
      .split("\n")
      .filter((l) => !/sin filtro de tiempo|no time filter/i.test(l))
      .join("\n")
      .trim();
  }

  // 2) fallback rewrite if too poor
  if (isTooPoor(cleaned1)) {
    const repairPrompt =
      lang === "es"
        ? `
Reescribe la respuesta usando SOLO el contexto provisto.
FORMATO OBLIGATORIO:
- Devuelve 5–7 bullets.
- Cada línea debe empezar con "- " (guion + espacio).
- Incluye números reales si existen en kpiPack/summary/sample; NO inventes.
- Si hay poca data: incluye 1 riesgo, 1 acción inmediata, 1 siguiente paso (pregunta), sin inventar métricas.

Pregunta: "${question}"
Periodo: ${meta?.kpiWindow || "N/A"}
Contexto JSON:
${payload}
`
        : `
Rewrite the answer using ONLY the provided context.
REQUIRED FORMAT:
- Return 5–7 bullets.
- Each line must start with "- " (dash + space).
- Include real numbers if present in kpiPack/summary/sample; do NOT invent.
- If data is limited: include 1 risk, 1 immediate action, 1 next-step question, without inventing metrics.

Question: "${question}"
Period: ${meta?.kpiWindow || "N/A"}
Context JSON:
${payload}
`;

    const response2 = await openai.responses.create({
      model: "gpt-4.1-mini",
      max_output_tokens: 420,
      input: [
        {
          role: "system",
          content:
            lang === "es"
              ? `Tu nombre es ${profile.name}. Responde estrictamente en bullets que empiecen con "- ".`
              : `Your name is ${profile.name}. Respond strictly in bullets starting with "- ".`,
        },
        { role: "user", content: repairPrompt.trim() },
      ],
    });

    const raw2 = response2.output?.[0]?.content?.[0]?.text || "";
    let cleaned2 = postProcessTerminology(raw2, lang);

    if (!meta?.kpiWindow || !String(meta.kpiWindow).trim()) {
      cleaned2 = cleaned2
        .split("\n")
        .filter((l) => !/sin filtro de tiempo|no time filter/i.test(l))
        .join("\n")
        .trim();
    }

    return formatThousandsInText(cleaned2);
  }

  return formatThousandsInText(cleaned1);
}

module.exports = { buildOwnerAnswer };
