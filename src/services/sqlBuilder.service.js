const openai = require('../infra/openai.client');
const fs = require('fs');
const path = require('path');
const { classifyIntent } = require('./intent');
const { getAssistantProfile } = require('./assistantProfile');

function normalizeText(s = '') {
  return (s || '')
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, ''); // quita acentos
}

function extractTimeWindow(question, uiLang = 'en', opts = {}) {
  const q = normalizeText(question);

  // defaults: NO asumir
  let where = '';
  let label = uiLang === 'es' ? 'sin filtro de tiempo' : 'no time filter';

  // =========================
  // HOY
  // =========================
  if (q.includes('hoy') || q.includes('today')) {
    return {
      where: `WHERE dateCameIn >= CURDATE() AND dateCameIn < DATE_ADD(CURDATE(), INTERVAL 1 DAY)`,
      label: uiLang === 'es' ? 'hoy' : 'today',
    };
  }

  // =========================
  // ESTA SEMANA (Lun..Dom)
  // =========================
  if (q.includes('esta semana') || q.includes('this week')) {
    return {
      where: `WHERE dateCameIn >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)
             AND dateCameIn < DATE_ADD(DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY), INTERVAL 7 DAY)`,
      label: uiLang === 'es' ? 'esta semana' : 'this week',
    };
  }

  // =========================
  // DÍAS: "ultimos 30 dias", "last 30 days"
  // =========================
  const mDaysEs = q.match(/ultim(?:os|as)\s+(\d{1,3})\s+dias?/);
  const mDaysEn = q.match(/last\s+(\d{1,3})\s+days?/);
  const mDays = mDaysEs || mDaysEn;
  if (mDays) {
    const n = parseInt(mDays[1], 10);
    if (!Number.isNaN(n) && n > 0) {
      return {
        where: `WHERE dateCameIn >= DATE_SUB(CURDATE(), INTERVAL ${n} DAY)`,
        label: uiLang === 'es' ? `últimos ${n} días` : `last ${n} days`,
      };
    }
  }

  // =========================
  // MESES: "ultimos 3 meses", "last 3 months"
  // =========================
  const mMonthsEs = q.match(/ultim(?:os|as)\s+(\d{1,2})\s+mes(?:es)?/);
  const mMonthsEn = q.match(/last\s+(\d{1,2})\s+months?/);
  const mMonths = mMonthsEs || mMonthsEn;
  if (mMonths) {
    const n = parseInt(mMonths[1], 10);
    if (!Number.isNaN(n) && n > 0) {
      return {
        where: `WHERE dateCameIn >= DATE_SUB(CURDATE(), INTERVAL ${n} MONTH)`,
        label: uiLang === 'es' ? `últimos ${n} meses` : `last ${n} months`,
      };
    }
  }

  // =========================
  // ESTE MES (calendario)
  // =========================
  if (q.includes('este mes') || q.includes('this month') || q.includes('current month') || q.includes('month to date') || q.includes('mes en curso')) {
    return {
      where: `WHERE dateCameIn >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
             AND dateCameIn < DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)`,
      label: uiLang === 'es' ? 'este mes' : 'this month',
    };
  }

  // =========================
  // ÚLTIMO MES (mes calendario anterior)
  // =========================
  if (q.includes('ultimo mes') || q.includes('último mes') || q.includes('last month')) {
    return {
      where: `WHERE dateCameIn >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01')
             AND dateCameIn < DATE_FORMAT(CURDATE(), '%Y-%m-01')`,
      label: uiLang === 'es' ? 'último mes' : 'last month',
    };
  }

  // =========================
  // AÑO PASADO (calendario)
  // =========================
  if (q.includes('ano pasado') || q.includes('año pasado') || q.includes('last year')) {
    return {
      where: `WHERE dateCameIn >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 YEAR), '%Y-01-01')
             AND dateCameIn < DATE_FORMAT(CURDATE(), '%Y-01-01')`,
      label: uiLang === 'es' ? 'año pasado' : 'last year',
    };
  }

  // =========================
  // AÑO ACTUAL
  // =========================
  if (q.includes('este ano') || q.includes('este año') || q.includes('this year') || q.includes('current year')) {
    return {
      where: `WHERE dateCameIn >= DATE_FORMAT(CURDATE(), '%Y-01-01')
             AND dateCameIn < DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-01-01'), INTERVAL 1 YEAR)`,
      label: uiLang === 'es' ? 'año actual' : 'current year',
    };
  }

  // =========================
  // RANGO ISO: YYYY-MM-DD ... YYYY-MM-DD
  // =========================
  const mRangeIso = q.match(
    /\b(19\d{2}|20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b.*\b(19\d{2}|20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/
  );
  if (mRangeIso) {
    const start = `${mRangeIso[1]}-${mRangeIso[2]}-${mRangeIso[3]}`;
    const end = `${mRangeIso[4]}-${mRangeIso[5]}-${mRangeIso[6]}`;
    return {
      where: `WHERE dateCameIn >= DATE('${start}')
             AND dateCameIn < DATE_ADD(DATE('${end}'), INTERVAL 1 DAY)`,
      label: uiLang === 'es' ? `rango ${start} a ${end}` : `range ${start} to ${end}`,
    };
  }

  // =========================
  // RANGO US: MM/DD/YYYY ... MM/DD/YYYY
  // =========================
  const mRangeUs = q.match(
    /\b(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/(19\d{2}|20\d{2})\b.*\b(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/(19\d{2}|20\d{2})\b/
  );
  if (mRangeUs) {
    const start = `${mRangeUs[3]}-${String(mRangeUs[1]).padStart(2, '0')}-${String(mRangeUs[2]).padStart(2, '0')}`;
    const end = `${mRangeUs[6]}-${String(mRangeUs[4]).padStart(2, '0')}-${String(mRangeUs[5]).padStart(2, '0')}`;
    return {
      where: `WHERE dateCameIn >= DATE('${start}')
             AND dateCameIn < DATE_ADD(DATE('${end}'), INTERVAL 1 DAY)`,
      label: uiLang === 'es' ? `rango ${start} a ${end}` : `range ${start} to ${end}`,
    };
  }

  // =========================
  // TRIMESTRE: Q1 2025 (Q2, Q3, Q4)
  // =========================
  const mQuarter = q.match(/\bq([1-4])\s*(19\d{2}|20\d{2})\b/);
  if (mQuarter) {
    const qNum = parseInt(mQuarter[1], 10);
    const yNum = parseInt(mQuarter[2], 10);
    const startMonth = (qNum - 1) * 3 + 1; // 1,4,7,10
    const start = `${yNum}-${String(startMonth).padStart(2, '0')}-01`;
    return {
      where: `WHERE dateCameIn >= DATE('${start}')
             AND dateCameIn < DATE_ADD(DATE('${start}'), INTERVAL 3 MONTH)`,
      label: uiLang === 'es' ? `trimestre ${qNum} ${yNum}` : `Q${qNum} ${yNum}`,
    };
  }

  // =========================
  // AÑO ESPECÍFICO: 2025
  // =========================
  const mYear = q.match(/\b(19\d{2}|20\d{2})\b/);
  if (mYear) {
    const y = parseInt(mYear[1], 10);
    return {
      where: `WHERE dateCameIn >= DATE('${y}-01-01')
             AND dateCameIn < DATE('${y + 1}-01-01')`,
      label: uiLang === 'es' ? `año ${y}` : `year ${y}`,
    };
  }

  // =========================
  // ✅ FALLBACK OPCIONAL (NO asumir salvo que lo pidas)
  // =========================
  const fallbackDays = Number(opts.defaultWindowDays || 0);
  if (!Number.isNaN(fallbackDays) && fallbackDays > 0) {
    return {
      where: `WHERE dateCameIn >= DATE_SUB(CURDATE(), INTERVAL ${fallbackDays} DAY)`,
      label: uiLang === 'es' ? `últimos ${fallbackDays} días` : `last ${fallbackDays} days`,
    };
  }

  return { where, label };
}

function tryGoldenTemplate(question, intent, uiLang = 'en', opts = {}) {
  const q = normalizeText(question);
  const { where, label } = extractTimeWindow(question, uiLang, opts);

  const has = (...words) => words.some((w) => q.includes(normalizeText(w)));

  // =========================
  // TEMPLATE 1: Confirmados + Gross + Dropped + %Dropped por mes
  // =========================
  const wantsMonthly =
    (intent === 'cnv' || intent === 'mix' || intent === 'general') &&
    (has('por mes', 'mensual', 'monthly') || has('mes', 'month'));

  const mentionsConfirmed = has('confirmad', 'confirmed', 'cnv', 'conversion', 'convertid');

  if (wantsMonthly && mentionsConfirmed) {
    const sql = `
SELECT
  YEAR(dateCameIn) AS anio,
  MONTH(dateCameIn) AS mes,
  SUM(CASE WHEN Confirmed = 1 THEN 1 ELSE 0 END) AS confirmed_cases,
  COUNT(*) AS gross_cases,
  SUM(CASE WHEN Status LIKE '%DROP%' THEN 1 ELSE 0 END) AS dropped_cases,
  ROUND(
    100 * SUM(CASE WHEN Status LIKE '%DROP%' THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0),
    2
  ) AS pct_dropped
FROM performance_data.dmLogReportDashboard
${where}
GROUP BY YEAR(dateCameIn), MONTH(dateCameIn)
ORDER BY anio, mes;
`.trim();

    return {
      sql,
      comment: `GoldenTemplate: confirmed_by_month (${label})`,
    };
  }

  // =========================
  // TEMPLATE 2: Salud operativa por Team (Problem/Dropped/umbrales)
  // =========================
  const wantsTeamHealth =
    (intent === 'health' || intent === 'mix' || intent === 'general') &&
    (has('team', 'equipo', 'por team', 'por equipo', 'teamname')) &&
    (has('dropped', 'drop', 'problem', 'probl', '>60', '>30'));

  if (wantsTeamHealth) {
    const sql = `
SELECT
  TeamName,
  COUNT(*) AS gross_cases,
  SUM(CASE WHEN Status LIKE '%PROBLEM%' THEN 1 ELSE 0 END) AS problem_cases,
  SUM(CASE WHEN Status LIKE '%PROBLEM%' AND Status LIKE '%30%' THEN 1 ELSE 0 END) AS problem_gt_30,
  SUM(CASE WHEN Status LIKE '%DROP%' THEN 1 ELSE 0 END) AS dropped_cases,
  SUM(CASE WHEN Status LIKE '%DROPPED%' AND Status LIKE '%60%' THEN 1 ELSE 0 END) AS dropped_gt_60
FROM performance_data.dmLogReportDashboard
${where}
GROUP BY TeamName
ORDER BY dropped_gt_60 DESC, problem_gt_30 DESC, dropped_cases DESC;
`.trim();

    return {
      sql,
      comment: `GoldenTemplate: health_by_team (${label})`,
    };
  }

  // =========================
  // TEMPLATE 3: Leakage por Office
  // =========================
  const wantsLeakage =
    (intent === 'mix' || intent === 'clinical' || intent === 'cnv' || intent === 'general') &&
    (has('leakage', 'confirmados con', 'confirmed with', 'confirmados que', 'confirmed that') ||
      (has('confirmad', 'confirmed', 'cnv') && has('problem', 'dropped', 'drop', 'clinical')));

  if (wantsLeakage) {
    const sql = `
SELECT
  OfficeName,
  SUM(CASE WHEN Confirmed = 1 THEN 1 ELSE 0 END) AS confirmed_cases,
  SUM(CASE WHEN Confirmed = 1 AND Status LIKE '%PROBLEM%' THEN 1 ELSE 0 END) AS confirmed_problem,
  SUM(CASE WHEN Confirmed = 1 AND Status LIKE '%DROP%' THEN 1 ELSE 0 END) AS confirmed_dropped_status,
  SUM(CASE WHEN Confirmed = 1 AND ClinicalStatus LIKE '%DROP%' THEN 1 ELSE 0 END) AS confirmed_clinical_dropped
FROM performance_data.dmLogReportDashboard
${where}
GROUP BY OfficeName
ORDER BY confirmed_problem DESC, confirmed_clinical_dropped DESC;
`.trim();

    return {
      sql,
      comment: `GoldenTemplate: leakage_by_office (${label})`,
    };
  }

  return null;
}

function safeLoadDataContract() {
  try {
    const contractPath = path.join(
      __dirname,
      '..',
      'contracts',
      'dmLogReportDashboard.contract.v1.json'
    );

    const raw = fs.readFileSync(contractPath, 'utf8');
    const obj = JSON.parse(raw);

    return JSON.stringify(obj); // compactado
  } catch {
    return '';
  }
}

function buildSchemaDescription(uiLang = 'en') {
  if (uiLang === 'es') {
    return `
Vista disponible: dmLogReportDashboard (solo lectura)

Columnas disponibles:
Status, idLead, idLeadOld, Origin, submitter, submitterName,
dateCameIn, dateDropped, created, leadStatus, LegalStatus, ClinicalStatus,
Confirmed, id, name, pipInsurance, atfaultInsurance, txLocation,
idot, ldot, Signed, doa, attorney, leadNotes, Compliance,
convertedValue, AttyDropReason, intakeSpecialist, Visits,
accidentState, formattedPhoneEntry,
DirectorEmail, RegionEmail, OfficeEmail, PODEmail, TeamEmail,
DirectorName, RegionName, OfficeName, PODEName, TeamName, officeLabel.

==================== VERDADES DEL DATASET (OBLIGATORIAS) ====================
- Esta tabla NO es histórica: cada idLead aparece UNA sola vez y representa el estado MÁS RECIENTE.
- Ignorar snapshotDate (si existe): no usarlo.

==================== REGLAS DE NEGOCIO (OBLIGATORIAS) ====================

1) SUBMITTER (SOLO SI LO PIDEN: submitter o representante):
   TRIM(COALESCE(NULLIF(submitterName,''), submitter)) AS submitter
   Es el campo por defecto cuando el usuario menciona nombres de personas sin rol.

2) CONFIRMADOS:
   - Confirmed = 1 => CASO CONFIRMADO (término operativo).
   - "tasa de confirmación" = confirmed_cases / gross_cases.
   - Confirmed es independiente de Status y ClinicalStatus.

3) CRÉDITO / VALOR:
   - convertedValue es el VALOR (crédito) del caso (suma de conversiones/valor).
   - NO confundir convertedValue con Confirmed.

4) ESTADOS OPERATIVOS (usar SIEMPRE Status, NO leadStatus para dropped/problem):
   - DROPPED general => Status LIKE '%DROP%'
   - DROPPED >60 => Status LIKE '%DROPPED%' AND Status LIKE '%60%'
   - PROBLEM => Status LIKE '%PROBLEM%'
   - PROBLEM >30 => Status LIKE '%PROBLEM%' AND Status LIKE '%30%'

   Nota: Un caso puede tener Confirmed=1 y Status/ClinicalStatus indicar PROBLEM/REF OUT/DROPPED.
         Status NO invalida Confirmed ni el crédito.

5) CLINICAL DROPPED (si lo piden explícitamente):
   - Clinical dropped => ClinicalStatus LIKE '%DROP%'

6) VISITS:
   - Visits puede venir NULL. No asumir 0.
   - Para comparaciones numéricas, usar COALESCE(Visits,0) SOLO cuando aplique.

7) FECHAS:
   - dateCameIn es la fecha principal para tendencias y agrupaciones, salvo que el usuario pida otra fecha.
   - Si el usuario pide "dropped date" o "cuando dropeó" => usar dateDropped.

8) FILTRO POR PERSONA (OBLIGATORIO):
- Si el usuario pide "casos de <persona>" y NO especifica rol:
  => filtra por submitterName/submitter (representante):
       WHERE LOWER(TRIM(COALESCE(NULLIF(submitterName,''), submitter))) LIKE CONCAT('%', LOWER(TRIM('X')), '%')
- Solo usar intakeSpecialist si el usuario dice explícitamente:
  "intake", "intake specialist", "locked down", "especialista de intake".
- Solo usar attorney si el usuario dice explícitamente:
  "attorney", "abogado".
- Solo usar OfficeName/TeamName/PODEName/RegionName/DirectorName si el usuario lo menciona.

==================== MAPA DE INTENCIÓN (OBLIGATORIO) ====================
- Si el usuario pide "confirmados" / "confirmed" => usar Confirmed.
- Si el usuario pide "crédito" / "conversion value" => usar SUM(convertedValue).
- Si el usuario pide "Dropped/Problem/Problem >30/Dropped >60" => usar Status (LIKE).
- "confirmados con problemas" =>
    WHERE Confirmed=1 AND (Status LIKE '%PROBLEM%' OR Status LIKE '%DROP%')
- "confirmados que dropearon clínicamente" =>
    WHERE Confirmed=1 AND ClinicalStatus LIKE '%DROP%'

==================== INSTRUCCIONES TÉCNICAS ====================
- Genera SOLO un SELECT contra dmLogReportDashboard.
- Respeta ONLY_FULL_GROUP_BY.
- EVITA DATE_FORMAT('%Y-%m'): usa YEAR(dateCameIn), MONTH(dateCameIn) o CONCAT(YEAR..MONTH..).
- No uses LIMIT en la consulta.
- NO inventes columnas.
- Cuando filtres por nombres: usa LIKE con LOWER(TRIM()) (no igualdad exacta), salvo que el usuario pida exact match.

Debes devolver JSON EXACTO:
{ 
  "sql": "...",
  "comment": "..."
}
`.trim();
  }

  return `
Available view: dmLogReportDashboard (read-only)

Available columns:
Status, idLead, idLeadOld, Origin, submitter, submitterName,
dateCameIn, dateDropped, created, leadStatus, LegalStatus, ClinicalStatus,
Confirmed, id, name, pipInsurance, atfaultInsurance, txLocation,
idot, ldot, Signed, doa, attorney, leadNotes, Compliance,
convertedValue, AttyDropReason, intakeSpecialist, Visits,
accidentState, formattedPhoneEntry,
DirectorEmail, RegionEmail, OfficeEmail, PODEmail, TeamEmail,
DirectorName, RegionName, OfficeName, PODEName, TeamName, officeLabel.

==================== DATASET TRUTHS (MANDATORY) ====================
- This table is NOT historical: each idLead appears once and represents the MOST RECENT state.
- Ignore snapshotDate (if present): never use it.

==================== BUSINESS RULES (MANDATORY) ====================

1) SUBMITTER (ONLY if requested: submitter/representative):
   TRIM(COALESCE(NULLIF(submitterName,''), submitter)) AS submitter

2) CONFIRMED CASES:
   - Confirmed = 1 => CONFIRMED case (operational term).
   - "confirmation rate" = confirmed_cases / gross_cases.
   - Confirmed is independent from Status and ClinicalStatus.

3) CREDIT / VALUE:
   - convertedValue is the CREDIT/VALUE amount (sum of conversion value).
   - Do NOT confuse convertedValue with Confirmed.

4) OPERATIONAL STATUSES (ALWAYS use Status, NOT leadStatus for dropped/problem):
   - DROPPED overall => Status LIKE '%DROP%'
   - DROPPED >60 => Status LIKE '%DROPPED%' AND Status LIKE '%60%'
   - PROBLEM => Status LIKE '%PROBLEM%'
   - PROBLEM >30 => Status LIKE '%PROBLEM%' AND Status LIKE '%30%'

   Note: a case may have Confirmed=1 and still show PROBLEM/REF OUT/DROPPED in Status/ClinicalStatus.
         Status does NOT invalidate confirmed or credit.

5) CLINICAL DROPPED (only if explicitly requested):
   - Clinical dropped => ClinicalStatus LIKE '%DROP%'

6) VISITS:
   - Visits can be NULL. Do not assume 0.
   - Use COALESCE(Visits,0) only when needed for numeric comparisons.

7) DATES:
   - dateCameIn is the primary date for trends/grouping unless another date is requested.
   - If user asks for dropped date => use dateDropped.

==================== INTENT MAP (MANDATORY) ====================
- If user asks "confirmed/confirmados" => use Confirmed.
- If user asks "credit/conversion value" => use SUM(convertedValue).
- If user asks Dropped/Problem/... => use Status (LIKE).
- "confirmed with problems" =>
    WHERE Confirmed=1 AND (Status LIKE '%PROBLEM%' OR Status LIKE '%DROP%')
- "confirmed clinical dropped" =>
    WHERE Confirmed=1 AND ClinicalStatus LIKE '%DROP%'

==================== TECH RULES ====================
- Output ONLY one SELECT against dmLogReportDashboard.
- Respect ONLY_FULL_GROUP_BY.
- Avoid DATE_FORMAT('%Y-%m'): prefer YEAR(dateCameIn), MONTH(dateCameIn).
- Do NOT use LIMIT.
- Do NOT invent columns.

Must return EXACT JSON:
{
  "sql": "...",
  "comment": "..."
}
`.trim();
}

function buildUserPrompt(question, intent, uiLang = 'en') {
  if (uiLang === 'es') {
    return `
Pregunta del usuario:
"${question}"

INTENT_DETECTADO: ${intent}

REGLAS DE INTENT:
- intent=cnv => enfócate en Confirmed (confirmados) y/o convertedValue (crédito) según la pregunta.
- intent=health => enfócate en Status (Problem/Dropped). No uses Confirmed salvo que lo pidan.
- intent=clinical => enfócate en ClinicalStatus y Visits cuando aplique.
- intent=mix => combina Confirmed + Status/ClinicalStatus según la pregunta.

Genera SOLO la consulta SQL correcta (un SELECT).
NO hagas bullets ni resumen ejecutivo aquí.
Devuelve solo el JSON solicitado.
`.trim();
  }

  return `
User question:
"${question}"

DETECTED_INTENT: ${intent}

INTENT RULES:
- intent=cnv => focus on Confirmed (confirmed cases) and/or convertedValue (credit) as requested.
- intent=health => focus on Status (Problem/Dropped). Do not use Confirmed unless requested.
- intent=clinical => focus on ClinicalStatus and Visits when applicable.
- intent=mix => combine Confirmed + Status/ClinicalStatus based on the question.

Generate ONLY the correct SQL query (one SELECT).
NO bullets, no executive summary here.
Return only the requested JSON.
`.trim();
}

async function buildSqlFromQuestion(question, uiLang = 'en', opts = {}) {
  const lang = uiLang === 'es' ? 'es' : 'en';

  const schemaDescription = buildSchemaDescription(lang);
  const dataContractJson = safeLoadDataContract();

  // ✅ classifyIntent ahora devuelve { intent, needsSql }
  const intentInfo = classifyIntent(question);
  const intent = intentInfo?.intent || 'general';

  // ✅ Golden template fallback (no OpenAI call)
  const golden = tryGoldenTemplate(question, intent, lang, opts);
  if (golden) return golden;

  const prompt = buildUserPrompt(question, intent, lang);
  const profile = getAssistantProfile(lang);

  const inputMessages = [
   {
  role: 'system',
  content:
    lang === 'es'
      ? `Tu nombre es ${profile.name}. Estilo: ${profile.style}. Eres un generador de SQL experto en MySQL. Solo SELECT. Solo JSON válido. No LIMIT.`
      : `Your name is ${profile.name}. Style: ${profile.style}. You are an expert MySQL SQL generator. ONLY SELECT. Output ONLY valid JSON. No LIMIT.`,
  },
    { role: 'system', content: schemaDescription },
  ];

  if (dataContractJson) {
    inputMessages.push({
      role: 'system',
      content: `DATA_CONTRACT_JSON:\n${dataContractJson}`,
    });
  }

  inputMessages.push({ role: 'user', content: prompt });

  const response = await openai.responses.create({
    model: 'gpt-5.1',
    input: inputMessages,
    text: {
      format: {
        type: 'json_schema',
        name: 'sql_builder_schema',
        schema: {
          type: 'object',
          properties: {
            sql: { type: 'string' },
            comment: { type: 'string' },
          },
          required: ['sql', 'comment'],
          additionalProperties: false,
        },
        strict: true,
      },
    },
  });

  const text = response.output[0].content[0].text;
  return JSON.parse(text);
}

module.exports = { buildSqlFromQuestion };
