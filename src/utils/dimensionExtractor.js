// src/utils/dimensionExtractor.js
const { DIMENSIONS } = require("./dimensionRegistry");

function cleanValue(v = "") {
  let s = String(v || "").trim();

  // quita puntuación final
  s = s.replace(/[?.!,;:]+$/g, "").trim();

  // quita dobles espacios
  s = s.replace(/\s{2,}/g, " ").trim();

  // quita comillas
  s = s.replace(/^['"]+|['"]+$/g, "").trim();

  return s;
}

// ✅ corta "extras" al final que NO son parte del nombre (periodos / conectores)
function stripTrailingNoise(value = "", lang = "es") {
  let v = cleanValue(value);

  // corta desde estos tokens típicos de periodo / conectores
  const cutRxEs =
    /\b(este\s+mes|mes\s+pasado|esta\s+semana|semana\s+pasada|hoy|ayer|mañana|últimos?\s+\d+\s+d[ií]as|ultimos?\s+\d+\s+dias|por\s+favor|pls|porfa)\b/i;

  const cutRxEn =
    /\b(this\s+month|last\s+month|this\s+week|last\s+week|today|yesterday|tomorrow|last\s+\d+\s+days|please|pls)\b/i;

  const cutRx = lang === "es" ? cutRxEs : cutRxEn;
  const m = v.match(cutRx);
  if (m && typeof m.index === "number" && m.index >= 2) {
    v = v.slice(0, m.index).trim();
  }

  // remueve conectores colgando al final
  v = v.replace(/\b(y|and|con|with)\s*$/i, "").trim();

  return v;
}

// ✅ evita que "persona" sea un período (ej: "este mes", "últimos 7 días")
function looksLikePeriod(value = "", lang = "es") {
  const v = String(value || "").toLowerCase().trim();
  if (!v) return true;

  if (lang === "es") {
    return /(este\s+mes|mes\s+pasado|esta\s+semana|semana\s+pasada|hoy|ayer|mañana|últimos?\s+\d+\s+d[ií]as|ultimos?\s+\d+\s+dias)/i.test(
      v
    );
  }

  return /(this\s+month|last\s+month|this\s+week|last\s+week|today|yesterday|tomorrow|last\s+\d+\s+days)/i.test(
    v
  );
}

function buildExplicitPatterns(lang = "es") {
  const isEs = lang === "es";
  const list = [];

  const add = (key, patterns) => {
    for (const rx of patterns) list.push({ key, rx });
  };

  if (isEs) {
    add("office", [
      /\b(?:la\s+)?oficina\s+de\s+([^\n,.;!?]{2,60})/i,
      /\boficina\s+([^\n,.;!?]{2,60})/i,
    ]);

    add("attorney", [
      /\babogad[oa]\s+([^\n,.;!?]{2,60})/i,
      /\battorney\s+([^\n,.;!?]{2,60})/i,
    ]);

    add("team", [
      /\bequipo\s+([^\n,.;!?]{2,60})/i,
      /\bteam\s+([^\n,.;!?]{2,60})/i,
    ]);

    add("pod", [/\bpod\s+([^\n,.;!?]{2,60})/i]);

    add("region", [
      /\bregi[oó]n\s+([^\n,.;!?]{2,60})/i,
      /\bregion\s+([^\n,.;!?]{2,60})/i,
    ]);

    add("director", [/\bdirector\s+([^\n,.;!?]{2,60})/i]);

    add("intake", [
      /\bintake\s+specialist\s+([^\n,.;!?]{2,60})/i,
      /\bespecialista\s+de\s+intake\s+([^\n,.;!?]{2,60})/i,
      /\bintake\s+([^\n,.;!?]{2,60})/i,
      /\blocked\s+down\s+by\s+([^\n,.;!?]{2,60})/i,
      /\bcerrado\s+por\s+([^\n,.;!?]{2,60})/i,
      /\bbloqueado\s+por\s+([^\n,.;!?]{2,60})/i,
    ]);

    add("txLocation", [
      /\blocaci[oó]n\s+tx\s+([^\n,.;!?]{2,60})/i,
      /\btx\s+location\s+([^\n,.;!?]{2,60})/i,
    ]);

    add("regionEmail", [
      /\bregion\s*email\s+([^\n,.;!?]{2,80})/i,
      /\bemail\s+de\s+regi[oó]n\s+([^\n,.;!?]{2,80})/i,
    ]);
  } else {
    add("office", [
      /\b(?:the\s+)?office\s+of\s+([^\n,.;!?]{2,60})/i,
      /\boffice\s+([^\n,.;!?]{2,60})/i,
    ]);

    add("attorney", [
      /\battorney\s+([^\n,.;!?]{2,60})/i,
      /\blawyer\s+([^\n,.;!?]{2,60})/i,
    ]);

    add("team", [/\bteam\s+([^\n,.;!?]{2,60})/i]);

    add("pod", [/\bpod\s+([^\n,.;!?]{2,60})/i]);

    add("region", [/\bregion\s+([^\n,.;!?]{2,60})/i]);

    add("director", [/\bdirector\s+([^\n,.;!?]{2,60})/i]);

    add("intake", [
      /\bintake\s+specialist\s+([^\n,.;!?]{2,60})/i,
      /\bintake\s+([^\n,.;!?]{2,60})/i,
      /\blocked\s+down\s+by\s+([^\n,.;!?]{2,60})/i,
    ]);

    add("txLocation", [/\btx\s+location\s+([^\n,.;!?]{2,60})/i]);

    add("regionEmail", [/\bregion\s*email\s+([^\n,.;!?]{2,80})/i]);
  }

  return list;
}

/**
 * Regla:
 * 1) Si aparece un keyword explícito de dimensión => devuelve esa dimensión.
 * 2) Si NO hay explícita, intenta persona con patrones controlados:
 *    - "casos/logs de X"
 *    - "dame los casos de X"
 *    - "cases/logs for X" (en)
 *    - fallback: "de X" / "for X" (pero limpiando ruido)
 */
function extractDimensionAndValue(message = "", lang = "es") {
  const raw = String(message || "").trim();
  if (!raw) return null;

  // 1) explícitas primero
  const patterns = buildExplicitPatterns(lang);
  for (const p of patterns) {
    const m = raw.match(p.rx);
    if (m && m[1]) {
      const value = stripTrailingNoise(m[1], lang);
      if (value.length >= 2) return { key: p.key, value, matchType: "explicit" };
    }
  }

  const isEs = lang === "es";

  // 2) persona: patrones "casos/logs de X"
  const rxCasesOf = isEs
    ? /\b(?:dame|mu[eé]strame|ver|lista|listado|casos|logs)\b[\s\S]{0,25}?\b(?:de|del)\s+([^\n,.;!?]{2,60})/i
    : /\b(?:give\s+me|show\s+me|see|list|cases|logs)\b[\s\S]{0,25}?\b(?:of|for)\s+([^\n,.;!?]{2,60})/i;

  let m = raw.match(rxCasesOf);
  if (m && m[1]) {
    const value = stripTrailingNoise(m[1], lang);
    if (value.length >= 2 && !looksLikePeriod(value, lang)) {
      return { key: "person", value, matchType: "fallback_cases" };
    }
  }

  // 3) fallback suave: "de X" / "for X" (pero evitando períodos)
  const rxPerson = isEs
    ? /\b(?:de|del)\s+([^\n,.;!?]{2,60})/i
    : /\b(?:of|for)\s+([^\n,.;!?]{2,60})/i;

  m = raw.match(rxPerson);
  if (m && m[1]) {
    const value = stripTrailingNoise(m[1], lang);
    if (value.length >= 2 && !looksLikePeriod(value, lang)) {
      return { key: "person", value, matchType: "fallback" };
    }
  }

  return null;
}

module.exports = { extractDimensionAndValue };
