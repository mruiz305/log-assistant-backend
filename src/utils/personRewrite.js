const { normalizeText } = require('../utils/text');

/* =========================================================
   PERSON REWRITE
========================================================= */

function questionMentionsClient(message = '') {
  const q = normalizeText(message);
  return (
    q.includes('cliente') ||
    q.includes('client') ||
    q.includes('patient') ||
    q.includes('paciente') ||
    q.includes('lead') ||
    q.includes('case') ||
    q.includes('caso') ||
    q.includes('claimant') ||
    q.includes('injured') ||
    q.includes('nombre del caso') ||
    q.includes('nombre del cliente')
  );
}

function questionMentionsIntake(message = '') {
  const q = normalizeText(message);
  return (
    q.includes('intake') ||
    q.includes('intake specialist') ||
    q.includes('locked down') ||
    q.includes('lock down') ||
    q.includes('cerrado por') ||
    q.includes('bloqueado por')
  );
}

function rewritePersonEqualsToLike(sql, message) {
  let s = String(sql || '');

  const esc = (v) => String(v || '').replace(/'/g, "''");

  const isIntakeAsked = questionMentionsIntake(message);
  const isClientAsked = questionMentionsClient(message);

  const rxIntakeEq = /(?:\b\w+\b\.)?(?:`?\w+`?\.)?`?intakeSpecialist`?\s*=\s*'([^']+)'/gi;
  const rxSubmitterEq = /(?:\b\w+\b\.)?(?:`?\w+`?\.)?`?submitterName`?\s*=\s*'([^']+)'/gi;

  const rxCoalesceSubmitterEq =
    /TRIM\s*\(\s*COALESCE\s*\(\s*NULLIF\s*\(\s*submitterName\s*,\s*''\s*\)\s*,\s*submitter\s*\)\s*\)\s*\)\s*=\s*'([^']+)'/gi;

  const rxNameEq = /(?:\b\w+\b\.)?(?:`?\w+`?\.)?`?name`?\s*=\s*'([^']+)'/gi;

  if (!isIntakeAsked) {
    s = s.replace(rxIntakeEq, (m, name) => {
      const v = esc(name);
      return `LOWER(TRIM(COALESCE(NULLIF(submitterName,''), submitter))) LIKE CONCAT('%', LOWER(TRIM('${v}')), '%')`;
    });
  }

  s = s.replace(rxSubmitterEq, (m, name) => {
    const v = esc(name);
    return `LOWER(TRIM(COALESCE(NULLIF(submitterName,''), submitter))) LIKE CONCAT('%', LOWER(TRIM('${v}')), '%')`;
  });

  s = s.replace(rxCoalesceSubmitterEq, (m, name) => {
    const v = esc(name);
    return `LOWER(TRIM(COALESCE(NULLIF(submitterName,''), submitter))) LIKE CONCAT('%', LOWER(TRIM('${v}')), '%')`;
  });

  if (!isClientAsked) {
    s = s.replace(rxNameEq, (m, name) => {
      const v = esc(name);
      return `LOWER(TRIM(COALESCE(NULLIF(submitterName,''), submitter))) LIKE CONCAT('%', LOWER(TRIM('${v}')), '%')`;
    });
  }

  return s;
}

function extractPersonFilterFromSql(sql = '') {
  const s = String(sql || '');

  let m = s.match(
    /LOWER\s*\(\s*TRIM\s*\(\s*COALESCE\s*\(\s*NULLIF\s*\(\s*submitterName\s*,\s*''\s*\)\s*,\s*submitter\s*\)\s*\)\s*\)\s+LIKE\s+CONCAT\s*\(\s*'%'\s*,\s*LOWER\s*\(\s*TRIM\s*\(\s*'([^']+)'\s*\)\s*\)\s*,\s*'%'\s*\)/i
  );
  if (m) return { column: 'submitterName', value: m[1] };

  m = s.match(/\bsubmitterName\s+LIKE\s+'%([^']+)%'/i);
  if (m) return { column: 'submitterName', value: m[1] };

  m = s.match(/\bintakeSpecialist\s+LIKE\s+'%([^']+)%'/i);
  if (m) return { column: 'intakeSpecialist', value: m[1] };

  m = s.match(/\battorney\s+LIKE\s+'%([^']+)%'/i);
  if (m) return { column: 'attorney', value: m[1] };

  // ✅ NUEVO: caso IA con TRIM(COALESCE...) = 'X'
  m = s.match(
    /TRIM\s*\(\s*COALESCE\s*\(\s*NULLIF\s*\(\s*submitterName\s*,\s*''\s*\)\s*,\s*submitter\s*\)\s*\)\s*=\s*'([^']+)'/i
  );
  if (m) return { column: 'submitterName', value: m[1] };

  m = s.match(/\bsubmitterName\s*=\s*'([^']+)'/i);
  if (m) return { column: 'submitterName', value: m[1] };

  // ✅ NUEVO: si cae submitter='X', lo tratamos como persona
  m = s.match(/\bsubmitter\s*=\s*'([^']+)'/i);
  if (m) return { column: 'submitterName', value: m[1] };

  m = s.match(/\bintakeSpecialist\s*=\s*'([^']+)'/i);
  if (m) return { column: 'intakeSpecialist', value: m[1] };

  return null;
}


function extractPersonNameFromMessage(message = '') {
  const raw = String(message || '').trim();
  const q = normalizeText(raw);

  // 1) si viene entre comillas
  let m = raw.match(/["“”'‘’]([^"“”'‘’]{2,50})["“”'‘’]/);
  if (m && m[1]) return String(m[1]).trim();

  // 2) patrones con "de/para/of/for/submitter"
  m = q.match(/\b(de|para|of|for|submitter|submittername)\s+([a-z0-9.\-_ ]{2,50})\b/);
  if (m && m[2]) {
    // recuperar el segmento desde el raw para mantener mayúsculas
    const idx = q.indexOf(m[2]);
    if (idx >= 0) return raw.slice(idx, idx + m[2].length).trim();
    return m[2].trim();
  }

  // 3) si el mensaje empieza con una palabra (ej: "Tony este mes")
  m = raw.match(/^([A-Za-z][A-Za-z.\-_]{1,40})\b/);
  if (m && m[1]) return m[1].trim();

  return null;
}

module.exports = {
  rewritePersonEqualsToLike,
  extractPersonFilterFromSql, extractPersonNameFromMessage   }