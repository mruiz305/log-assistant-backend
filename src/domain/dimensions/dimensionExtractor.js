
const { DIMENSIONS } = require("./dimensionRegistry");
const { isRejectedLogsIntroToken } = require("../../services/logsRoster/logsRoster.service");

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

// corta "extras" al final que NO son parte del nombre (periodos / conectores)
function stripTrailingNoise(value = "", lang = "es") {
  let v = cleanValue(value);

  // corta desde estos tokens típicos de periodo / conectores
  const cutRxEs =
    /\b(este\s+mes|mes\s+pasado|esta\s+semana|semana\s+pasada|hoy|ayer|mañana|últimos?\s+\d+\s+d[ií]as|ultimos?\s+\d+\s+dias|por\s+favor|pls|porfa|(?:en|in)\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s*\d{0,4}|(?:has|have|had|did|handle|handled|handles)\s+in\s+|(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s*\d{4})\b/i;

  const cutRxEn =
    /\b(this\s+month|last\s+month|this\s+week|last\s+week|today|yesterday|tomorrow|last\s+\d+\s+days|please|pls|(?:en|in)\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\s*\d{0,4}|(?:has|have|had|did|handle|handled|handles)\s+in\s+|(?:january|february|march|april|may|june|july|august|september|october|november|december)\s*\d{4})\b/i;

  const cutRx = lang === "es" ? cutRxEs : cutRxEn;
  const m = v.match(cutRx);
  if (m && typeof m.index === "number" && m.index >= 0) {
    v = v.slice(0, m.index).trim();
  }

  // remueve conectores/verbos colgando al final
  v = v.replace(/\b(y|and|con|with)\s*$/i, "").trim();
  v = v.replace(/\s+(?:handle|handled|handles|manej[oó]|manejaron)\s*$/i, "").trim();

  return v;
}

// evita usar como office/person valores que son frases de tiempo (have in, january 2026, etc.)
function looksLikeTimePhrase(value = "") {
  const v = String(value || "").toLowerCase().trim();
  if (!v || v.length < 2) return true;
  if (/^(have|has|had|did|in|on|during|for|of)\b/.test(v)) return true;
  if (/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s*\d{0,4}\b/.test(v)) return true;
  if (/\b(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s*\d{0,4}\b/.test(v)) return true;
  if (/^\d{4}$/.test(v)) return true;
  // "office have", "oficina Miami" - extracción incorrecta (debería ser office, no person)
  if (/\b(?:office|oficina)\b/.test(v)) return true;
  return false;
}

// evita usar "for 2025 - would you consider..." como nombre de persona
function looksLikeAnalyticalPhrase(value = "") {
  const v = String(value || "").toLowerCase().trim();
  if (!v || v.length < 5) return false;
  if (/^\d{4}\b/.test(v)) return true; // empieza con año
  if (/\bwould\s+you\s+consider\b/.test(v)) return true;
  if (/\b(?:fit\s+employee|worth|justify|salary|compensation|performance)\b/.test(v)) return true;
  if (/\bmake\s+\d+k\b/.test(v)) return true;
  return false;
}

// evita que "persona" sea un período (ej: "este mes", "últimos 7 días")
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
      // "la oficina Garcia, Katerine" / "oficina X" - priorizar sobre "X oficina"
      /\b(?:la\s+)?oficina\s+de\s+([^\n.;!?]{2,60})/i,
      /\b(?:la\s+)?oficina\s+([^\n.;!?]{2,60})/i,
      /\boficina\s+([^\n.;!?]{2,60})/i,
      /\boffice\s+([^\n.;!?]{2,60})/i,
      // "Tony Press oficina" / "X office" - excluir "la", "the"
      /(?!\b(?:cu[aá]ntos?|cu[aá]ntas?|hizo|tiene|tienen|casos|logs|la|the)\b)\b([A-Za-z][A-Za-z0-9\-']*(?:\s+[A-Za-z][A-Za-z0-9\-']*){0,2})\s+oficina\b/i,
      /(?!\b(?:how|many|did|have|has|had|cases|logs|the)\b)\b([A-Za-z][A-Za-z0-9\-']*(?:\s+[A-Za-z][A-Za-z0-9\-']*){0,2})\s+office\b/i,
    ]);

    add("attorney", [
      /\b(?:el\s+)?abogad[oa]\s+de\s+([^\n.;!?]{2,80})/i,
      /\b(?:the\s+)?attorney\s+of\s+([^\n.;!?]{2,80})/i,
      /\b(?:el\s+)?abogad[oa]\s+([^\n.;!?]{2,80})/i,
      /\b(?:the\s+)?attorney\s+([^\n.;!?]{2,80})/i,
      /\b(?:the\s+)?lawyer\s+([^\n.;!?]{2,80})/i,
    ]);

    add("team", [
      // "equipo de X" / "team of X" - priorizar para capturar nombre con coma (Gerardo, William)
      /\b(?:el\s+)?equipo\s+de\s+([^\n.;!?]{2,60})/i,
      /\b(?:the\s+)?team\s+of\s+([^\n.;!?]{2,60})/i,
      /\bequipo\s+([^\n.;!?]{2,60})/i,
      /\bteam\s+([^\n.;!?]{2,60})/i,
    ]);

    add("pod", [
      /\b(?:el\s+)?pod\s+de\s+([^\n.;!?]{2,60})/i,
      /\b(?:the\s+)?pod\s+of\s+([^\n.;!?]{2,60})/i,
      /\bpod\s+([^\n.;!?]{2,60})/i,
    ]);

    add("region", [
      /\b(?:la\s+)?regi[oó]n\s+de\s+([^\n.;!?]{2,60})/i,
      /\b(?:the\s+)?region\s+of\s+([^\n.;!?]{2,60})/i,
      /\bregi[oó]n\s+([^\n.;!?]{2,60})/i,
      /\bregion\s+([^\n.;!?]{2,60})/i,
    ]);

    add("director", [
      /\b(?:el\s+)?director\s+de\s+([^\n.;!?]{2,60})/i,
      /\b(?:the\s+)?director\s+of\s+([^\n.;!?]{2,60})/i,
      /\bdirector\s+([^\n.;!?]{2,60})/i,
    ]);

    add("intake", [
      /\bintake\s+specialist\s+of\s+([^\n.;!?]{2,60})/i,
      /\bespecialista\s+de\s+intake\s+([^\n.;!?]{2,60})/i,
      /\bintake\s+of\s+([^\n.;!?]{2,60})/i,
      /\bintake\s+specialist\s+([^\n.;!?]{2,60})/i,
      /\bintake\s+([^\n.;!?]{2,60})/i,
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
      // "the office Garcia, Katerine" / "office Garcia, Katerine" - PRIORIZAR sobre "X office" (evita capturar "the")
      // [^\n.;!?] permite coma en nombres (Garcia, Katerine)
      /\b(?:the\s+)?office\s+of\s+([^\n.;!?]{2,60})/i,
      /\b(?:the\s+)?office\s+([^\n.;!?]{2,60})/i,
      // "Tony Press office" / "Miami office" - 1-3 palabras ANTES de "office" (excluye "the", verbos, preguntas)
      /(?!\b(?:how|many|did|have|has|had|cases|logs|the)\b)\b([A-Za-z][A-Za-z0-9\-']*(?:\s+[A-Za-z][A-Za-z0-9\-']*){0,2})\s+office\b/i,
    ]);

    add("attorney", [
      /\b(?:the\s+)?attorney\s+of\s+([^\n.;!?]{2,80})/i,
      /\b(?:the\s+)?lawyer\s+of\s+([^\n.;!?]{2,80})/i,
      /\b(?:the\s+)?attorney\s+([^\n.;!?]{2,80})/i,
      /\b(?:the\s+)?lawyer\s+([^\n.;!?]{2,80})/i,
    ]);

    add("team", [
      // "the team of Gerardo, William" - priorizar para capturar nombre con coma
      /\b(?:the\s+)?team\s+of\s+([^\n.;!?]{2,60})/i,
      /\bteam\s+([^\n.;!?]{2,60})/i,
    ]);

    add("pod", [
      /\b(?:the\s+)?pod\s+of\s+([^\n.;!?]{2,60})/i,
      /\bpod\s+([^\n.;!?]{2,60})/i,
    ]);

    add("region", [
      /\b(?:the\s+)?region\s+of\s+([^\n.;!?]{2,60})/i,
      /\bregion\s+([^\n.;!?]{2,60})/i,
    ]);

    add("director", [
      /\b(?:the\s+)?director\s+of\s+([^\n.;!?]{2,60})/i,
      /\bdirector\s+([^\n.;!?]{2,60})/i,
    ]);

    add("intake", [
      /\bintake\s+specialist\s+of\s+([^\n.;!?]{2,60})/i,
      /\bintake\s+of\s+([^\n.;!?]{2,60})/i,
      /\bintake\s+specialist\s+([^\n.;!?]{2,60})/i,
      /\bintake\s+([^\n.;!?]{2,60})/i,
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
 *    - "how many <metric> <X> has/did/got ..."
 *    - "how many cases did X ..."
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
      if (value.length >= 2 && !looksLikeTimePhrase(value)) return { key: p.key, value, matchType: "explicit" };
    }
  }

  const isEs = lang === "es";

  // 2a) "X performance [period]" / "how is X doing" / "how is X performing" / "how has X been performing"
  const rxLeadingPersonPerformance =
    /^([A-Za-z][A-Za-z0-9\-']*(?:\s+[A-Za-z][A-Za-z0-9\-']*)?)\s+performance\b/i;
  const rxHowIsDoing = /^how\s+is\s+(.+?)\s+doing\b/i;
  const rxHowIsPerforming = /^how\s+is\s+(.+?)\s+performing\b/i;
  const rxHowHasBeenPerforming = /^how\s+has\s+(.+?)\s+been\s+(?:doing|performing)\b/i;
  const rxIsPerformingWell = /^is\s+(.+?)\s+performing\s+well\b/i;
  for (const rx of [rxLeadingPersonPerformance, rxHowIsDoing, rxHowIsPerforming, rxHowHasBeenPerforming, rxIsPerformingWell]) {
    const mm = raw.match(rx);
    if (mm && mm[1]) {
      const value = stripTrailingNoise(mm[1], lang);
      if (value.length >= 2 && !looksLikePeriod(value, lang) && !looksLikeTimePhrase(value)) {
        if (!isRejectedLogsIntroToken(value)) return { key: "person", value, matchType: "fallback_performance_phrase" };
      }
    }
  }

  // 2a') "X's performance" - nombre (1 palabra) inmediatamente antes de 's
  const rxNamePossessivePerformance = /\b([A-Za-z][A-Za-z0-9\-]+)\s*['\u2019]?s\s+performance\b/i;
  const mmPerf = raw.match(rxNamePossessivePerformance);
  if (mmPerf && mmPerf[1]) {
    const value = stripTrailingNoise(mmPerf[1], lang);
    if (value.length >= 2 && !looksLikePeriod(value, lang) && !looksLikeTimePhrase(value) && !isRejectedLogsIntroToken(value)) {
      return { key: "person", value, matchType: "fallback_performance_possessive" };
    }
  }

  // 2b) "Based off X's logs" / "X's logs for YYYY" - PRIORITARIO sobre "logs for X"
  //    Evita que "logs for 2025 - would you consider..." capture la frase analítica.
  //    Permitir año opcional entre 's y logs: "Tony's 2025 logs"
  const rxBasedOffName = /\b(?:based\s+)(?:off|on)\s+([A-Za-z][A-Za-z0-9\-]*(?:\s+[A-Za-z][A-Za-z0-9\-']*)?)\s*['\u2019]?s\s+(?:\d{4}\s+)?logs/i;
  const rxNameLogsFor = /([A-Za-z][A-Za-z0-9\-]*(?:\s+[A-Za-z][A-Za-z0-9\-']*)?)\s*['\u2019]?s\s+logs\s+for\b/i;
  const rxNamePossessiveLogs = /([A-Za-z][A-Za-z0-9\-]*(?:\s+[A-Za-z][A-Za-z0-9\-']*)?)\s*['\u2019]?s\s+(?:\d{4}\s+)?logs\b/i;

  for (const rx of [rxBasedOffName, rxNameLogsFor, rxNamePossessiveLogs]) {
    const mm = raw.match(rx);
    if (mm && mm[1]) {
      const value = stripTrailingNoise(mm[1], lang);
      if (value.length >= 2 && !looksLikeTimePhrase(value) && !isRejectedLogsIntroToken(value)) {
        return { key: "person", value, matchType: "fallback_logs_possessive" };
      }
    }
  }

  // 3) persona: patrones "casos/logs de X" - rechazar si captura frase analítica
  const rxCasesOf = isEs
    ? /\b(?:dame|mu[eé]strame|ver|lista|listado|casos|logs)\b[\s\S]{0,25}?\b(?:de|del)\s+([^\n.;!?]{2,60})/i
    : /\b(?:give\s+me|show\s+me|see|list|cases|logs)\b[\s\S]{0,25}?\b(?:of|for)\s+([^\n.;!?]{2,60})/i;

  let m = raw.match(rxCasesOf);
  if (m && m[1]) {
    const value = stripTrailingNoise(m[1], lang);
    if (value.length >= 2 && !looksLikePeriod(value, lang) && !looksLikeTimePhrase(value) && !looksLikeAnalyticalPhrase(value) && !isRejectedLogsIntroToken(value)) {
      return { key: "person", value, matchType: "fallback_cases" };
    }
  }

  // =========================================================
  // 2b) "how many <metric> <PERSON> has/did/got ..."
  //     Cubre: "How many cases Karla have...", "How many dropped Mariel has in 2025?"
  //     Group 1 = metric, Group 2 = person
  // =========================================================
  const rxHowManyMetricHasEn =
    /\bhow\s+many\s+(cases|logs|dropped|confirmed|problem|active|refer\s*out|referout|converted|gross)\s+(.{2,60}?)(?=\s+\b(has|have|did|got)\b)/i;
  const rxHowManyMetricHasEs =
    /\bcu[áa]ntos?\s+(casos|logs|caidos|caídos|confirmados|confirmadas|problema|problemas|activos|activas|referidos|referidas|convertidos|convertidas|brutos)\s+(.{2,60}?)(?=\s+\b(tiene|tienen|hizo|tuvo|hace|realiz[oó])\b)/i;

  if (!isEs) {
    const mm = raw.match(rxHowManyMetricHasEn);
    // mm[1]=metric (cases|logs), mm[2]=person (Karla)
    if (mm && mm[2]) {
      const value = stripTrailingNoise(mm[2], lang);
      if (value.length >= 2 && !looksLikePeriod(value, lang) && !looksLikeTimePhrase(value) && !isRejectedLogsIntroToken(value)) {
        return { key: "person", value, matchType: "fallback_howmany_metric_has" };
      }
    }
  } else {
    const mm = raw.match(rxHowManyMetricHasEs);
    // mm[1]=metric, mm[2]=person
    if (mm && mm[2]) {
      const value = stripTrailingNoise(mm[2], lang);
      if (value.length >= 2 && !looksLikePeriod(value, lang) && !looksLikeTimePhrase(value) && !isRejectedLogsIntroToken(value)) {
        return { key: "person", value, matchType: "fallback_howmany_metric_has" };
      }
    }
  }

  // =========================================================
  // 2b2) "how many cases have <PERSON> ..." (verb before person)
  //      Cubre: "How many cases have Maria in the last month?"
  //      Captura hasta preposición/periodo (in, on, last, etc.)
  // =========================================================
  const rxHowManyHavePersonEn =
    /\bhow\s+many\s+(?:cases|logs)\s+have\s+([A-Za-z][A-Za-z0-9\-']*(?:\s+(?!in\b|on\b|during\b|for\b|last\b|this\b|the\b)[A-Za-z][A-Za-z0-9\-']*){0,3})(?=\s+(?:in|on|during|for|last|this|the)\b|[?.!,;:]|$)/i;
  if (!isEs) {
    const mm = raw.match(rxHowManyHavePersonEn);
    if (mm && mm[1]) {
      const value = stripTrailingNoise(mm[1], lang);
      if (value.length >= 2 && !looksLikePeriod(value, lang) && !looksLikeTimePhrase(value) && !isRejectedLogsIntroToken(value)) {
        return { key: "person", value, matchType: "fallback_howmany_have_person" };
      }
    }
  }

  // =========================================================
  // 2c) "how many cases/logs did <X> handle ..." -> attorney (law firms "handle" cases)
  //     Prioridad sobre person para "Kanner & Pintaluga (Georgia) handle"
  // =========================================================
  const rxCasesDidHandleEn =
    /\bhow\s+many\s+(?:cases|logs)\s+did\s+(.{2,60}?)\s+handle(?=\s+\b(in|on|during|for)\b|[?.!,;:]|$)/i;
  if (!isEs) {
    const mm = raw.match(rxCasesDidHandleEn);
    if (mm && mm[1]) {
      const value = stripTrailingNoise(mm[1], lang);
      if (value.length >= 2 && !looksLikePeriod(value, lang) && !looksLikeTimePhrase(value)) {
        return { key: "attorney", value, matchType: "fallback_cases_did_handle" };
      }
    }
  }

  // =========================================================
  // 2d) "how many cases/logs did <PERSON> ..."
  // =========================================================
  const rxCasesDidEn =
    /\bhow\s+many\s+(?:cases|logs)\s+did\s+(.{2,60}?)(?=\s+\b(in|on|during|for)\b|[?.!,;:]|$)/i;

  const rxCasesDidEs =
    /\bcu[aá]ntos?\s+(?:casos|logs)\s+(?:hizo|hace|realiz[oó])\s+(.{2,60}?)(?=\s+\b(en|durante|para)\b|[?.!,;:]|$)/i;

  if (!isEs) {
    const mm = raw.match(rxCasesDidEn);
    if (mm && mm[1]) {
      const value = stripTrailingNoise(mm[1], lang);
      if (value.length >= 2 && !looksLikePeriod(value, lang) && !looksLikeTimePhrase(value) && !isRejectedLogsIntroToken(value)) {
        return { key: "person", value, matchType: "fallback_cases_did" };
      }
    }
  } else {
    const mm = raw.match(rxCasesDidEs);
    if (mm && mm[1]) {
      const value = stripTrailingNoise(mm[1], lang);
      if (value.length >= 2 && !looksLikePeriod(value, lang) && !looksLikeTimePhrase(value) && !isRejectedLogsIntroToken(value)) {
        return { key: "person", value, matchType: "fallback_cases_did" };
      }
    }
  }

  // 4) fallback suave: "de X" / "for X" - RECHAZAR si parece frase analítica (año, "would you consider", etc.)
  const rxPerson = isEs
    ? /\b(?:de|del)\s+([^\n.;!?]{2,60})/i
    : /\b(?:of|for)\s+([^\n.;!?]{2,60})/i;

  m = raw.match(rxPerson);
  if (m && m[1]) {
    const value = stripTrailingNoise(m[1], lang);
    if (value.length >= 2 && !looksLikePeriod(value, lang) && !looksLikeTimePhrase(value)) {
      if (!looksLikeAnalyticalPhrase(value) && !isRejectedLogsIntroToken(value)) {
        return { key: "person", value, matchType: "fallback" };
      }
    }
  }

  return null;
}

/** Extrae SOLO la dimensión indicada (para override cuando scope está pre-seleccionado) */
function extractDimensionForFocusType(message = "", focusType = "", lang = "es") {
  const raw = String(message || "").trim();
  if (!raw || !focusType) return null;
  const dimKey = { team: "team", office: "office", pod: "pod", attorney: "attorney", region: "region", director: "director", intake: "intake", submitter: "person" }[String(focusType).toLowerCase()];
  if (!dimKey) return null;
  const patterns = buildExplicitPatterns(lang).filter((p) => p.key === dimKey);
  for (const p of patterns) {
    const m = raw.match(p.rx);
    if (m && m[1]) {
      const value = stripTrailingNoise(m[1], lang);
      if (value.length >= 2 && !looksLikeTimePhrase(value)) return { key: dimKey, value, matchType: "explicit" };
    }
  }
  return null;
}

module.exports = { extractDimensionAndValue, extractDimensionForFocusType };
