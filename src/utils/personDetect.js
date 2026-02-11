// src/utils/personDetect.js
const { mentionsPersonExplicitly } = require("./chatRoute.helpers");
const { extractPersonNameFromMessage } = require("./personRewrite");

function fallbackNameFromText(msg = "") {
  const m = String(msg || "").trim();
  const hit =
    m.match(/\bhas\s+([a-z]+)\s+([a-z]+)\b/i) ||
    m.match(/\bfor\s+([a-z]+)\s+([a-z]+)\b/i) ||
    m.match(/\bof\s+([a-z]+)\s+([a-z]+)\b/i);
  if (!hit) return null;

  const full = `${hit[1]} ${hit[2]}`.trim();
  if (full.length < 3) return null;

  const bad = new Set([
    "give","show","get","see","list","logs","cases","case","this","last","month","week","today","yesterday",
    "dame","muestrame","mostrar","ver","lista","casos","este","esta","mes","semana","hoy","ayer",
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

  // evita 1 palabra suelta tipo "how", "maria" etc si tu extractor falla
  // (si quieres permitir 1 palabra como nombre, quita esta línea)
  if (!v.includes(" ") && v.length < 5) return null;

  if (v.length < 3) return null;

  return v;
}


module.exports = { safeExtractExplicitPerson, fallbackNameFromText };
