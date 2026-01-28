// src/utils/personRewrite.js
const { normalizeText } = require("../utils/text");

/* =========================================================
   PERSON REWRITE (robusto: soporta '=' y 'LIKE' con %...%)
========================================================= */

function questionMentionsClient(message = "") {
  const q = normalizeText(message);
  return (
    q.includes("cliente") ||
    q.includes("client") ||
    q.includes("patient") ||
    q.includes("paciente") ||
    q.includes("lead") ||
    q.includes("case") ||
    q.includes("caso") ||
    q.includes("claimant") ||
    q.includes("injured") ||
    q.includes("nombre del caso") ||
    q.includes("nombre del cliente")
  );
}

function questionMentionsIntake(message = "") {
  const q = normalizeText(message);
  return (
    q.includes("intake") ||
    q.includes("intake specialist") ||
    q.includes("locked down") ||
    q.includes("lock down") ||
    q.includes("cerrado por") ||
    q.includes("bloqueado por")
  );
}

function escSql(v) {
  return String(v || "").replace(/'/g, "''");
}

/**
 * Convierte "LIKE '%x%'" o "='x'" a una expresión robusta:
 * LOWER(TRIM(COALESCE(NULLIF(submitterName,''), submitter))) LIKE CONCAT('%', LOWER(TRIM('x')), '%')
 *
 * y (si NO pidieron intake) reescribe intakeSpecialist también a PERSONA.
 */
function rewritePersonEqualsToLike(sql, message) {
  let s = String(sql || "");

  const isIntakeAsked = questionMentionsIntake(message);
  const isClientAsked = questionMentionsClient(message);

  // Match: intakeSpecialist = 'x'   | intakeSpecialist LIKE '%x%'
  const rxIntakeEq =
    /(?:\b\w+\b\.)?(?:`?\w+`?\.)?`?intakeSpecialist`?\s*=\s*'([^']+)'/gi;
  const rxIntakeLike =
    /(?:\b\w+\b\.)?(?:`?\w+`?\.)?`?intakeSpecialist`?\s+LIKE\s+'%([^%]+)%'/gi;

  // Match: submitterName = 'x' | submitterName LIKE '%x%'
  const rxSubmitterEq =
    /(?:\b\w+\b\.)?(?:`?\w+`?\.)?`?submitterName`?\s*=\s*'([^']+)'/gi;
  const rxSubmitterLike =
    /(?:\b\w+\b\.)?(?:`?\w+`?\.)?`?submitterName`?\s+LIKE\s+'%([^%]+)%'/gi;

  // Match: TRIM(COALESCE(NULLIF(submitterName,''), submitter)) = 'x'
  const rxCoalesceSubmitterEq =
    /TRIM\s*\(\s*COALESCE\s*\(\s*NULLIF\s*\(\s*submitterName\s*,\s*''\s*\)\s*,\s*submitter\s*\)\s*\)\s*\)\s*=\s*'([^']+)'/gi;

  // Match: TRIM(COALESCE(...)) LIKE '%x%'
  const rxCoalesceSubmitterLike =
    /TRIM\s*\(\s*COALESCE\s*\(\s*NULLIF\s*\(\s*submitterName\s*,\s*''\s*\)\s*,\s*submitter\s*\)\s*\)\s*\)\s+LIKE\s+'%([^%]+)%'/gi;

  // Match: name = 'x' | name LIKE '%x%'
  const rxNameEq = /(?:\b\w+\b\.)?(?:`?\w+`?\.)?`?name`?\s*=\s*'([^']+)'/gi;
  const rxNameLike =
    /(?:\b\w+\b\.)?(?:`?\w+`?\.)?`?name`?\s+LIKE\s+'%([^%]+)%'/gi;

  const toPersonLike = (raw) => {
    const v = escSql(raw);
    return `LOWER(TRIM(COALESCE(NULLIF(submitterName,''), submitter))) LIKE CONCAT('%', LOWER(TRIM('${v}')), '%')`;
  };

  // ✅ Si NO pidieron intake, y la IA filtró intakeSpecialist, lo convertimos a PERSONA
  if (!isIntakeAsked) {
    s = s.replace(rxIntakeEq, (_m, name) => toPersonLike(name));
    s = s.replace(rxIntakeLike, (_m, name) => toPersonLike(name));
  }

  // Siempre normalizar submitterName / coalesce a PERSONA
  s = s.replace(rxSubmitterEq, (_m, name) => toPersonLike(name));
  s = s.replace(rxSubmitterLike, (_m, name) => toPersonLike(name));
  s = s.replace(rxCoalesceSubmitterEq, (_m, name) => toPersonLike(name));
  s = s.replace(rxCoalesceSubmitterLike, (_m, name) => toPersonLike(name));

  // ✅ Si NO pidieron cliente/caso, y la IA filtró name, lo tratamos como PERSONA (esto era tu regla original)
  if (!isClientAsked) {
    s = s.replace(rxNameEq, (_m, name) => toPersonLike(name));
    s = s.replace(rxNameLike, (_m, name) => toPersonLike(name));
  }

  return s;
}

/**
 * Extrae el valor de "persona" desde el SQL si la IA lo metió:
 * - soporta '=' y 'LIKE %...%'
 */
function extractPersonFilterFromSql(sql = "") {
  const s = String(sql || "");

  // 1) TRIM(COALESCE(...)) = '...'
  let m = s.match(
    /TRIM\s*\(\s*COALESCE\s*\(\s*NULLIF\s*\(\s*submitterName\s*,\s*''\s*\)\s*,\s*submitter\s*\)\s*\)\s*=\s*'([^']+)'/i
  );
  if (m && m[1]) return { kind: "coalesce_trim_eq", value: m[1] };

  // 1b) TRIM(COALESCE(...)) LIKE '%...%'
  m = s.match(
    /TRIM\s*\(\s*COALESCE\s*\(\s*NULLIF\s*\(\s*submitterName\s*,\s*''\s*\)\s*,\s*submitter\s*\)\s*\)\s+LIKE\s+'%([^%]+)%'/i
  );
  if (m && m[1]) return { kind: "coalesce_trim_like", value: m[1] };

  // 2) COALESCE(...) = '...'
  m = s.match(
    /COALESCE\s*\(\s*NULLIF\s*\(\s*submitterName\s*,\s*''\s*\)\s*,\s*submitter\s*\)\s*=\s*'([^']+)'/i
  );
  if (m && m[1]) return { kind: "coalesce_eq", value: m[1] };

  // 2b) COALESCE(...) LIKE '%...%'
  m = s.match(
    /COALESCE\s*\(\s*NULLIF\s*\(\s*submitterName\s*,\s*''\s*\)\s*,\s*submitter\s*\)\s+LIKE\s+'%([^%]+)%'/i
  );
  if (m && m[1]) return { kind: "coalesce_like", value: m[1] };

  // 3) submitterName = '...'
  m = s.match(/\bsubmitterName\b\s*=\s*'([^']+)'/i);
  if (m && m[1]) return { kind: "submitterName_eq", value: m[1] };

  // 3b) submitterName LIKE '%...%'
  m = s.match(/\bsubmitterName\b\s+LIKE\s+'%([^%]+)%'/i);
  if (m && m[1]) return { kind: "submitterName_like", value: m[1] };

  // 4) submitter = '...'
  m = s.match(/\bsubmitter\b\s*=\s*'([^']+)'/i);
  if (m && m[1]) return { kind: "submitter_eq", value: m[1] };

  // 4b) submitter LIKE '%...%'
  m = s.match(/\bsubmitter\b\s+LIKE\s+'%([^%]+)%'/i);
  if (m && m[1]) return { kind: "submitter_like", value: m[1] };

  return null;
}

/**
 * Útil para detectar "casos de maria chacon" desde el mensaje (sin depender del SQL).
 */
function extractPersonNameFromMessage(message = "") {
  const raw = String(message || "").trim();
  const q = normalizeText(raw);

  // 1) entre comillas
  let m = raw.match(/["“”'‘’]([^"“”'‘’]{2,50})["“”'‘’]/);
  if (m && m[1]) return String(m[1]).trim();

  // 2) patrones "de/para/of/for/submitter"
  m = q.match(/\b(de|para|of|for|submitter|submittername)\s+([a-z0-9.\-_ ]{2,50})\b/);
  if (m && m[2]) {
    const idx = q.indexOf(m[2]);
    if (idx >= 0) return raw.slice(idx, idx + m[2].length).trim();
    return m[2].trim();
  }

  // 3) primera palabra tipo "Tony este mes"
  m = raw.match(/^([A-Za-z][A-Za-z.\-_]{1,40})\b/);
  if (m && m[1]) return m[1].trim();

  return null;
}

module.exports = {
  rewritePersonEqualsToLike,
  extractPersonFilterFromSql,
  extractPersonNameFromMessage,
};
