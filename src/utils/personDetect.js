const { mentionsPersonExplicitly } = require("./chatRoute.helpers");
const { extractPersonNameFromMessage } = require("./personRewrite");
const { extractDimensionAndValue } = require("../domain/dimensions/dimensionExtractor");
const { isRejectedLogsIntroToken } = require("../services/logsRoster/logsRoster.service");

function fallbackNameFromText(msg = "") {
  const m = String(msg || "").trim();
  const hit =
    m.match(/\bhas\s+([a-z]+)\s+([a-z]+)\b/i) ||
    m.match(/\bfor\s+([a-z]+)\s+([a-z]+)\b/i) ||
    m.match(/\bof\s+([a-z]+)\s+([a-z]+)\b/i);
  if (!hit) return null;

  // "has Tony been" -> "been" is verb, use only "Tony"
  const verbAfterName = new Set(["been", "have", "has", "had", "doing", "performing", "done"]);
  const full = verbAfterName.has(hit[2].toLowerCase()) ? hit[1].trim() : `${hit[1]} ${hit[2]}`.trim();
  if (full.length < 3) return null;

  const bad = new Set([
    "give","show","get","see","list","logs","cases","case","this","last","month","week","today","yesterday",
    "dame","muestrame","mostrar","ver","lista","casos","este","esta","mes","semana","hoy","ayer",
    "this month","this week","this year","last month","last week","last year","that month","the month",
    // descriptive / analytic terms that must never be treated as names
    "high","low","strong","weak","higher","lower","stronger","weaker","efficiency","volume","performance",
  ]);
  if (bad.has(full.toLowerCase())) return null;
  return full;
}

function safeExtractExplicitPerson(msg = "", uiLang = "en") {
  const m = String(msg || "").trim();
  if (!m) return null;
  if (!mentionsPersonExplicitly(m, uiLang)) return null;

  const p = extractPersonNameFromMessage(m);
  if (!p) return null;

  const v = String(p).trim();
  if (!v) return null;

  const bad = new Set([
    // EN helpers / noise
    "how", "many", "did", "in", "on", "during", "for",
    // comandos / keywords
    "give","show","get","see","list","logs","cases","case",
    "dame","muestrame","mostrar","ver","lista","casos",
    // periodos
    "this","last","month","week","today","yesterday",
    "este","esta","mes","semana","hoy","ayer",
  ]);

  const vv = v.toLowerCase();
  if (bad.has(vv)) return null;

  // evita 1 palabra muy corta (no "Tony", "John", "Li")
  if (!v.includes(" ") && v.length < 3) return null;

  if (v.length < 3) return null;

  return v;
}

/**
 * Detecta persona explícita en el mensaje desde todas las fuentes.
 * Usado para: invalidar entidad anterior cuando el usuario menciona otra persona.
 * Incluye: safeExtractExplicitPerson, fallbackNameFromText, dimension extractor (how is X doing, X performance).
 * Rechaza tokens intro de frases logs (Based, Using, From, According) para no usar como submitter.
 */
function getExplicitPersonFromMessage(msg = "", uiLang = "en") {
  const m = String(msg || "").trim();
  if (!m) return null;

  const fromSafe = safeExtractExplicitPerson(m, uiLang);
  if (fromSafe) {
    if (isRejectedLogsIntroToken(fromSafe)) {
      console.log(`[entity_nl] rejected fallback candidate="${fromSafe}" reason=stopword_intro_token`);
      return null;
    }
    return fromSafe;
  }

  const fromFallback = fallbackNameFromText(m);
  if (fromFallback) {
    if (isRejectedLogsIntroToken(fromFallback)) {
      console.log(`[entity_nl] rejected fallback candidate="${fromFallback}" reason=stopword_intro_token`);
      return null;
    }
    return fromFallback;
  }

  const dim = extractDimensionAndValue(m, uiLang);
  if (dim?.key === "person" && dim?.value) {
    const v = String(dim.value).trim();
    if (v.length >= 2) {
      if (isRejectedLogsIntroToken(v)) {
        console.log(`[entity_nl] rejected fallback candidate="${v}" reason=stopword_intro_token`);
        return null;
      }
      return v;
    }
  }

  return null;
}

module.exports = { safeExtractExplicitPerson, fallbackNameFromText, getExplicitPersonFromMessage };
