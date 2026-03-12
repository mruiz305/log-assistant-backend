const { DIMENSIONS } = require("./dimensionRegistry");
const { FOCUS } = require("../focus/focusRegistry");
const { findFocusCandidates } = require("../../repos/focus.repo");

/** Mapeo: dimension key -> focus type (tabla nexus) */
const DIM_TO_FOCUS = {
  person: "submitter",
  office: "office",
  pod: "pod",
  team: "team",
  region: "region",
  director: "director",
  intake: "intake",
  attorney: "attorney",
};

function buildOfficeLabel(r) {
  const parts = [];
  if (r.name) parts.push(r.name);
  if (r.office) parts.push(`— ${r.office}`);
  if (r.decription) parts.push(`(${r.decription})`);
  return parts.join(" ");
}

function rowToOption(focusType, r, idx) {
  const cfg = FOCUS[focusType];
  const canonical =
    (cfg?.canonicalFromRow ? cfg.canonicalFromRow(r) : r.name || r.attorney || r.office) || "";
  let label = canonical;
  if (focusType === "office") label = buildOfficeLabel(r);
  else if (focusType === "attorney") label = r.attorney || canonical;
  else if (r.email) label = `${canonical} (${r.email})`;
  return { id: String(idx + 1), label, value: canonical };
}

// Detecta si el mensaje tiene forma "oficina de X" (no "oficina Miami")
function isOfficeOfPersonPhrase(message = '', lang = 'es') {
  const s = String(message || '').trim();
  if (lang === 'es') return /\b(?:la\s+)?oficina\s+de\s+/i.test(s);
  return /\b(?:the\s+)?office\s+of\s+/i.test(s);
}

// Resuelve OfficeName a partir de un submitterName (persona)
async function resolveOfficeNameByPerson(sqlRepo, personName) {
  const p = String(personName || "").trim();
  if (!p) return null;

  const exec = typeof sqlRepo?.query === "function"
  ? async (sql, params) => sqlRepo.query(sql, params)          // sqlRepo => rows
  : async (sql, params) => (await sqlRepo.query(sql, params))[0]; // pool => [rows]

  const rows = await sqlRepo.query(
    `
    SELECT TRIM(OfficeName) AS officeName, COUNT(*) AS cnt
    FROM dmLogReportDashboard
    WHERE
      dateCameIn >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)
      AND TRIM(OfficeName) <> ''
      AND LOWER(TRIM(COALESCE(NULLIF(submitterName,''), submitter)))
          LIKE CONCAT('%', LOWER(TRIM(?)), '%')
    GROUP BY TRIM(OfficeName)
    ORDER BY cnt DESC
    LIMIT 1
    `.trim(),
    [p]
  );

  return rows?.[0]?.officeName ? String(rows[0].officeName).trim() : null;
}


const PICK_LIMIT = 500;

/**
 * Busca candidatos en la tabla nexus correspondiente a la dimensión.
 * Retorna: { resolved, value } | { needsPick, options, focusType, rawValue } | { tooMany, rawValue, focusType }
 */
async function resolveDimensionWithCandidates(extracted, limit = PICK_LIMIT) {
  if (!extracted?.key || !extracted?.value) return null;

  const key = String(extracted.key).trim();
  const rawValue = String(extracted.value).trim();
  const focusType = DIM_TO_FOCUS[key];

  if (!focusType || !FOCUS[focusType]) {
    return null;
  }

  const rows = await findFocusCandidates({
    type: focusType,
    query: rawValue,
    limit,
  });

  // [DEBUG] findFocusCandidates llamado (evitar que se ejecute tras selección)
  if (process.env.LOG_SQL || process.env.DEBUG_PICK) {
    console.log(`[dimensionResolver] findFocusCandidates type=${focusType} query="${rawValue}" rows=${rows.length}`);
  }

  if (rows.length === 0) {
    return { resolved: false, noMatches: true, rawValue, focusType };
  }

  if (rows.length === 1) {
    const cfg = FOCUS[focusType];
    const value =
      (cfg?.canonicalFromRow ? cfg.canonicalFromRow(rows[0]) : rows[0].name || rows[0].attorney) || "";
    return { resolved: true, value: value || rawValue };
  }

  const options = rows.map((r, idx) => rowToOption(focusType, r, idx));
  return {
    resolved: false,
    needsPick: true,
    focusType,
    rawValue,
    options,
  };
}

/**
 * Entrada: { key, value } (del extractor)
 * Salida: { key, column, value, meta } | { key, column, needsPick, pickOptions, ... }
 */
async function resolveDimension(sqlRepo, extracted, message, lang = "es") {
  if (!extracted?.key || !extracted?.value) return null;

  const key = String(extracted.key).trim();
  const rawValue = String(extracted.value).trim();

  const def = DIMENSIONS[key];
  if (!def?.column) return null;

  // Caso especial: "oficina de PERSONA" => resolver OfficeName real
  if (key === "office" && isOfficeOfPersonPhrase(message, lang)) {
    const officeName = await resolveOfficeNameByPerson(sqlRepo, rawValue);
    if (officeName) {
      return {
        key: "office",
        column: def.column,
        value: officeName,
        meta: { resolvedFromPerson: rawValue },
      };
    }
  }

  // Dimensiones con tabla nexus: buscar candidatos primero
  const focusType = DIM_TO_FOCUS[key];
  if (focusType && FOCUS[focusType]) {
    const result = await resolveDimensionWithCandidates(extracted, PICK_LIMIT);

    if (result?.noMatches) {
      return {
        key,
        column: def.column,
        noMatches: true,
        rawValue: result.rawValue,
        focusType: result.focusType,
      };
    }

    if (result?.needsPick) {
      return {
        key,
        column: def.column,
        value: rawValue,
        needsPick: true,
        pickKind: "pick_dimension_candidate",
        focusType,
        options: result.options,
        rawValue,
      };
    }

    if (result?.resolved && result.value) {
      return {
        key,
        column: def.column,
        value: result.value,
        meta: { resolvedFromNexus: focusType },
      };
    }
  }

  return { key, column: def.column, value: rawValue, meta: null };
}

module.exports = { resolveDimension, resolveDimensionWithCandidates, DIM_TO_FOCUS };
