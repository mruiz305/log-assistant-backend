// src/application/chat/handlers/kpiOnly.handler.js
const sqlRepo = require("../../../repos/sql.repo");
const chatRepo = require("../../../repos/chat.repo");

const { buildOwnerAnswer } = require("../../../services/answers/ownerAnswer.service");
const { buildKpiPackSql } = require("../../../services/kpis/kpiPack.service");

const { logSql, tokenizePersonName } = require("../../../utils/chatRoute.helpers");
const { buildInsightCards } = require("../../../domain/ui/cardsAndChart.builder");
const { buildSuggestions } = require("../../../domain/ui/suggestions.builder");

const { isKpiOnlyQuestion, isHowManyCasesQuestion } = require("../../../utils/kpiOnly");

const { getContext, setContext, setPending } = require("../../../domain/context/conversationState");

const { getDimension } = require("../../../domain/dimensions/dimensionRegistry");
const { safeExtractExplicitPerson, fallbackNameFromText } = require("../../../utils/personDetect");

const { extractDimensionAndValue } = require("../../../domain/dimensions/dimensionExtractor");

/* =========================================================
   Helpers (Context)
========================================================= */

function mergeFiltersFromContext(cid, localFilters) {
  if (!cid) return localFilters || {};
  const ctxNow = getContext(cid) || {};
  return { ...(ctxNow.filters || {}), ...(localFilters || {}) };
}

function persistContextFilters({ cid, filters, lastPerson }) {
  if (!cid) return;
  const nextFilters = mergeFiltersFromContext(cid, filters);
  const payload = { filters: nextFilters };
  if (typeof lastPerson !== "undefined") payload.lastPerson = lastPerson;
  setContext(cid, payload);
}

function buildPickPrompt(uiLang, dimKey, rawValue) {
  const def = getDimension(dimKey);
  const label = uiLang === "es" ? def?.labelEs || dimKey : def?.labelEn || dimKey;
  return uiLang === "es"
    ? `Encontré varias coincidencias para ${label} "${rawValue}". ¿Cuál es la correcta?`
    : `I found multiple matches for ${label} "${rawValue}". Which one is correct?`;
}

/* =========================================================
   Helpers (Person detection)
========================================================= */

function normalizePersonValue(v) {
  const s = String(v || "").trim();
  if (!s) return null;

  const cleaned = s
    .replace(/^['"]+|['"]+$/g, "")
    .replace(/[?.!,;:]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
 
      // ✅ corta acciones coladas que NO son parte del nombre
  // Ej: "Tony press Submit" -> "Tony"
  const actionRx = /\b(press|pressed|submit|submitted|click|clicked|hit|entered|enter)\b/i;
  const mAct = cleaned.match(actionRx);
  let cleaned2 = cleaned;
  if (mAct && typeof mAct.index === "number" && mAct.index >= 2) {
    cleaned2 = cleaned.slice(0, mAct.index).trim();
  } else {
    cleaned2 = cleaned;
  }

  if (!cleaned2) return null;

  const bad = new Set([
    // ES
    "su",
    "sus",
    "él",
    "ella",
    "ellos",
    "ellas",
    "este",
    "esta",
    "ese",
    "esa",
    // EN
    "his",
    "her",
    "their",
    "him",
    "them",
    "he",
    "she",
    "this",
    "that",
    "those",
    "me",
    "my",
    "mine",
    "self",
  ]);

  if (bad.has(cleaned2.toLowerCase())) return null;
  if (cleaned2.length < 2) return null;

  return cleaned2;
}

// ⚠️ FIX: aquí NO usamos String.raw con \\b (doble escape). Usamos regex reales.
function detectExplicitPersonFromText({ effectiveMessage, messageWithDefaultPeriod, uiLang, logEnabled, reqId }) {
  const eff = String(effectiveMessage || "");
  const msg = String(messageWithDefaultPeriod || "");

  // 0) Detectores existentes
  let raw =
    normalizePersonValue(safeExtractExplicitPerson(eff, uiLang)) ||
    normalizePersonValue(fallbackNameFromText(eff)) ||
    normalizePersonValue(safeExtractExplicitPerson(msg, uiLang)) ||
    normalizePersonValue(fallbackNameFromText(msg));

  if (raw) {
    if (logEnabled) {
      console.log(`[${reqId}] [kpiOnly] person_detect stage0 HIT raw="${raw}"`);
    }
    return raw;
  }

  // 1) KPI/how-many con nombre en medio (EN/ES)
  // EN: "How many dropped Mariel has in 2025?"
  // EN alt: "How many dropped has Mariel in 2025?"
  const rxHowManyMetricHasEn_A =
    /\bhow\s+many\s+(?:cases|logs|dropped|confirmed|problem|active|refer\s*out|referout|converted|gross)\s+(.{2,60}?)\s+\b(?:has|have|did|got)\b(?=\s+\b(?:in|on|during|for)\b|[?.!,;:]|$)/i;

  const rxHowManyMetricHasEn_B =
    /\bhow\s+many\s+(?:cases|logs|dropped|confirmed|problem|active|refer\s*out|referout|converted|gross)\s+\b(?:has|have|did|got)\b\s+(.{2,60}?)(?=\s+\b(?:in|on|during|for)\b|[?.!,;:]|$)/i;

  // EN: "How many cases did Maria Chacon in January 2026?"
  const rxCasesDidEn =
  /\bhow\s+many\s+(?:cases|logs)\s+did\s+(.{2,60}?)(?=\s+\b(?:in|on|during|for|press|pressed|submit|submitted|click|clicked|hit|entered|enter)\b|[?.!,;:]|$)/i;

  // ES: "Cuántos caídos Mariel tiene en 2025?"
  const rxHowManyMetricHasEs =
    /\bcu[aá]ntos?\s+(?:casos|logs|caidos|caídos|confirmados|confirmadas|problema|problemas|activos|activas|referidos|referidas|convertidos|convertidas|brutos)\s+(.{2,60}?)\s+\b(?:tiene|tienen|hizo|tuvo|hace|realiz[oó])\b(?=\s+\b(?:en|durante|para)\b|[?.!,;:]|$)/i;

  // ES: "Cuántos casos hizo Maria Chacon en enero 2026"
  const rxCasesDidEs =
    /\bcu[aá]ntos?\s+(?:casos|logs)\s+(?:hizo|hace|realiz[oó])\s+(.{2,60}?)(?=\s+\b(?:en|durante|para)\b|[?.!,;:]|$)/i;

  const texts = [eff, msg];

  for (const t of texts) {
    let m = t.match(rxHowManyMetricHasEn_A);
    if (m && m[1]) {
      raw = normalizePersonValue(m[1]);
      if (raw) {
        if (logEnabled) console.log(`[${reqId}] [kpiOnly] person_detect stage1 HIT howmany EN_A raw="${raw}"`);
        return raw;
      }
    }

    m = t.match(rxHowManyMetricHasEn_B);
    if (m && m[1]) {
      raw = normalizePersonValue(m[1]);
      if (raw) {
        if (logEnabled) console.log(`[${reqId}] [kpiOnly] person_detect stage1 HIT howmany EN_B raw="${raw}"`);
        return raw;
      }
    }

    m = t.match(rxCasesDidEn);
    if (m && m[1]) {
      raw = normalizePersonValue(m[1]);
      if (raw) {
        if (logEnabled) console.log(`[${reqId}] [kpiOnly] person_detect stage1 HIT cases-did EN raw="${raw}"`);
        return raw;
      }
    }

    m = t.match(rxHowManyMetricHasEs);
    if (m && m[1]) {
      raw = normalizePersonValue(m[1]);
      if (raw) {
        if (logEnabled) console.log(`[${reqId}] [kpiOnly] person_detect stage1 HIT howmany ES raw="${raw}"`);
        return raw;
      }
    }

    m = t.match(rxCasesDidEs);
    if (m && m[1]) {
      raw = normalizePersonValue(m[1]);
      if (raw) {
        if (logEnabled) console.log(`[${reqId}] [kpiOnly] person_detect stage1 HIT cases-did ES raw="${raw}"`);
        return raw;
      }
    }
  }

  // 2) último recurso: dimensionExtractor
  for (const t of texts) {
    const dim = extractDimensionAndValue(t, uiLang);
    if (dim?.key === "person" && dim?.value) {
      raw = normalizePersonValue(dim.value);
      if (raw) {
        if (logEnabled) {
          console.log(
            `[${reqId}] [kpiOnly] person_detect stage2 HIT dimensionExtractor raw="${raw}" matchType=${dim.matchType}`
          );
        }
        return raw;
      }
    }
  }

  return null;
}

/* =========================================================
   Person Disambiguation (KPI-only)
========================================================= */

async function maybeDisambiguatePersonKpiOnly({
  reqId,
  logEnabled,
  uiLang,
  cid,
  effectiveMessage,
  messageWithDefaultPeriod,
  filters,
  skipThisTurn = false,
}) {
  if (!cid) return null;
  if (skipThisTurn) return null;

  const currentLocked =
    filters?.person?.locked && filters?.person?.value ? String(filters.person.value).trim() : "";
  const currentExact = Boolean(filters?.person?.exact);

  const explicitFromText = detectExplicitPersonFromText({
    effectiveMessage,
    messageWithDefaultPeriod,
    uiLang,
    logEnabled,
    reqId,
  });

  // Si el usuario NO escribió nombre, no tocamos persona (seguimos usando lock anterior)
  if (!explicitFromText) return null;

  const explicitPersonRaw = explicitFromText;

  // Si el user escribió un nombre distinto, permitimos cambio (reseteamos lock local)
  if (currentLocked && explicitPersonRaw && currentLocked.toLowerCase() !== explicitPersonRaw.toLowerCase()) {
    filters.person = null;
    persistContextFilters({ cid, filters, lastPerson: null });
  }

  // si ya coincide exacto, no hacemos nada
  if (currentLocked && currentExact && currentLocked.toLowerCase() === explicitPersonRaw.toLowerCase()) {
    return null;
  }

  // tokens para buscar candidatos
  const parts = tokenizePersonName(explicitPersonRaw).slice(0, 6);
  if (!parts.length) return null;

  if (logEnabled) {
    console.log(
      `[${reqId}] [kpiOnly] person_disamb check raw="${explicitPersonRaw}" current="${currentLocked}" exact=${currentExact} parts=`,
      parts
    );
  }

  const reps = await chatRepo.findPersonCandidates({
    rawPerson: explicitPersonRaw,
    parts,
    limit: 8,
  });

  if (logEnabled) {
    console.log(
      `[${reqId}] [kpiOnly] person_disamb candidates=`,
      Array.isArray(reps) ? reps.map((r) => `${r.submitter} (${r.cnt})`) : reps
    );
  }

  // 2+ candidatos -> pick
  if (Array.isArray(reps) && reps.length >= 2) {
    const def = getDimension("person");
    const prompt = buildPickPrompt(uiLang, "person", explicitPersonRaw);

    const options = reps.map((c) => ({
      id: String(c.submitter),
      label: String(c.submitter),
      sub: `${c.cnt} cases`,
      value: String(c.submitter),
    }));

    setPending(cid, {
      type: def?.pickType || "person_pick",
      prompt,
      options,
      dimKey: "person",
      originalMessage: effectiveMessage,
      originalMode: "person_disambiguation_kpiOnly",
    });

    return {
      ok: true,
      answer: prompt,
      rowCount: 0,
      aiComment: "person_disambiguation_kpiOnly",
      userName: null,
      chart: null,
      pick: { type: def?.pickType || "person_pick", options },
      suggestions: null,
    };
  }

  // 1 candidato -> lock exact
  if (Array.isArray(reps) && reps.length === 1) {
    const chosen = String(reps[0].submitter).trim();
    filters.person = { value: chosen, locked: true, exact: true };
    persistContextFilters({ cid, filters, lastPerson: chosen });

    if (logEnabled) {
      console.log(`[${reqId}] [kpiOnly] person_disamb auto-chosen="${chosen}" (exact=true)`);
    }
    return null;
  }

  // 0 candidatos -> lock raw (LIKE)
  filters.person = { value: explicitPersonRaw, locked: true, exact: false };
  persistContextFilters({ cid, filters, lastPerson: explicitPersonRaw });

  if (logEnabled) {
    console.log(`[${reqId}] [kpiOnly] person_disamb no matches -> lock LIKE raw="${explicitPersonRaw}"`);
  }

  return null;
}

/* =========================================================
   Handler
========================================================= */

async function handleKpiOnly({
  reqId,
  logEnabled,
  debug,
  uiLang,
  cid,
  messageWithDefaultPeriod,
  effectiveMessage,
  filters,
  hasAnyPersonSignal,
  suggestionsBase, // compat
  userName,
  forcedPick,
  pendingContext,
}) {
  if (logEnabled) {
    console.log(`[${reqId}] [kpiOnly] msg="${messageWithDefaultPeriod}" hasAnyPersonSignal=${hasAnyPersonSignal}`);
    console.log(`[${reqId}] [effectiveMessage] msg="${effectiveMessage}"`);
  }

  // Si venimos de pick de PERSON en este request
  let justAppliedPick = false;
  if (cid && forcedPick && pendingContext && pendingContext.dimKey === "person") {
    const chosen = String(forcedPick.value || forcedPick.id || "").trim();
    if (chosen) {
      filters.person = { value: chosen, locked: true, exact: true };
      persistContextFilters({ cid, filters, lastPerson: chosen });
      justAppliedPick = true;

      if (logEnabled) console.log(`[${reqId}] [kpiOnly] applied forcedPick person="${chosen}" (exact=true)`);
    }
  }

  // Forced KPI-only (how many...) cuando hay señal de persona
  if (hasAnyPersonSignal && isHowManyCasesQuestion(messageWithDefaultPeriod, uiLang)) {
    const pickOut = await maybeDisambiguatePersonKpiOnly({
      reqId,
      logEnabled,
      uiLang,
      cid,
      effectiveMessage,
      messageWithDefaultPeriod,
      filters,
      skipThisTurn: justAppliedPick,
    });
    if (pickOut) return pickOut;

    const { sql: kpiSql, params: kpiParams, windowLabel } = buildKpiPackSql(messageWithDefaultPeriod, {
      lang: uiLang,
      filters,
    });

    if (logEnabled) logSql(reqId, "kpi_only(forced) kpiSql", kpiSql, kpiParams);

    const kpiRows = await sqlRepo.query(kpiSql, kpiParams);
    const kpiPack = Array.isArray(kpiRows) && kpiRows[0] ? kpiRows[0] : null;

    const answer = await buildOwnerAnswer(messageWithDefaultPeriod, kpiSql, [], {
      kpiPack,
      kpiWindow: windowLabel,
      lang: uiLang,
      userName,
    });

    const cards = buildInsightCards(uiLang, { windowLabel, kpiPack, mode: "kpi_only_forced_how_many" });

    return {
      ok: true,
      answer,
      cards,
      rowCount: 0,
      aiComment: "kpi_only_forced_how_many",
      userName,
      chart: null,
      suggestions: buildSuggestions(effectiveMessage, uiLang),
      executedSql: debug ? kpiSql : undefined,
    };
  }

  // KPI-only simple
  if (isKpiOnlyQuestion(messageWithDefaultPeriod)) {
    const { sql: kpiSql, params: kpiParams, windowLabel } = buildKpiPackSql(messageWithDefaultPeriod, {
      lang: uiLang,
      filters,
    });

    if (logEnabled) logSql(reqId, "kpi_only kpiSql", kpiSql, kpiParams);

    const kpiRows = await sqlRepo.query(kpiSql, kpiParams);
    const kpiPack = Array.isArray(kpiRows) && kpiRows[0] ? kpiRows[0] : null;

    const answer = await buildOwnerAnswer(messageWithDefaultPeriod, kpiSql, [], {
      kpiPack,
      kpiWindow: windowLabel,
      lang: uiLang,
      userName,
    });

    const cards = buildInsightCards(uiLang, { windowLabel, kpiPack, mode: "kpi_only" });

    return {
      ok: true,
      answer,
      cards,
      rowCount: 0,
      aiComment: "kpi_only",
      userName,
      chart: null,
      suggestions: buildSuggestions(effectiveMessage, uiLang),
      executedSql: debug ? kpiSql : undefined,
    };
  }

  return null;
}

module.exports = { handleKpiOnly };
