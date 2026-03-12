// src/services/scopeWizard.service.js
const { setPending, setContext, clearPending, getContext } = require("../domain/context/conversationState");
const { FOCUS } = require("../domain/focus/focusRegistry");
const { resolveAndSetFocus, setGeneralMode } = require("./focus.service");

function scopeTypeOptions(uiLang = "en") {
  const es = uiLang === "es";

  const base = [
    { id: "1", label: es ? "General (sin filtro)" : "General (no filter)", value: "general" },
    { id: "2", label: "Office", value: "office" },
    { id: "3", label: "POD", value: "pod" },
    { id: "4", label: "Team", value: "team" },
    { id: "5", label: "Region", value: "region" },
    { id: "6", label: "Director", value: "director" },
    { id: "7", label: "Submitter", value: "submitter" },
    { id: "8", label: "Intake Specialist", value: "intake" },
    { id: "9", label: "Attorney", value: "attorney" },
  ];

  return base;
}

function openScopeWizard(cid, uiLang = "en") {
  const es = uiLang === "es";
  const prompt = es
    ? "Selecciona el tipo de filtro:"
    : "Select the scope type:";

  setPending(cid, {
    kind: "pick_scope_type",
    type: "scope_type",
    options: scopeTypeOptions(uiLang),
    prompt,
    originalMessage: null,
  });

  return { ok: true, answer: prompt, pick: { type: "scope_type", options: scopeTypeOptions(uiLang) } };
}

async function applyPickedScopeType({ cid, pickedValue, uiLang }) {
  const type = String(pickedValue || "").trim().toLowerCase();

  const SCOPE_DIM_KEYS = ["person", "office", "pod", "team", "region", "director", "intake", "attorney"];
  const ctxNow = getContext(cid) || {};
  const nextFilters = { ...(ctxNow.filters || {}) };
  SCOPE_DIM_KEYS.forEach((k) => { nextFilters[k] = null; });

  // ✅ 1) Guardar tipo elegido y limpiar scope anterior (evita office cuando eligió attorney)
  setContext(cid, {
    scopeMode: type === "general" ? "general" : "focus",
    focus: type === "general" ? null : { type, value: null, label: null },
    filters: nextFilters,
  });

  // ✅ 2) Si es general, no pedir nada más
  if (type === "general") {
    return {
      answer: uiLang === "es"
        ? "Listo. Modo **GENERAL** activado (solo periodo de tiempo, sin filtros por entidad)."
        : "Done. **GENERAL** mode enabled (time window only, no entity filters).",
    };
  }

  // ✅ 3) Pedir el valor (texto) del scope
  const prompt =
    uiLang === "es"
      ? `Escribe el ${type} (ej: "Miami", "Pod A", "Maria Chacon").`
      : `Type the ${type} (e.g. "Miami", "Pod A", "Maria Chacon").`;

  setPending(cid, {
    kind: "await_scope_value",
    focusType: type,
    prompt,
  });

  return { answer: prompt };
}


/** Indica si el mensaje parece una pregunta (no un valor de scope) */
function looksLikeQuestion(msg = "") {
  const m = String(msg || "").toLowerCase();
  return (
    /\b(how\s+many|what|show\s+me|give\s+me|list|dame|mu[eé]strame|cu[aá]ntos?|cu[aá]ntas?|cu[aá]l|which)\b/i.test(m) ||
    (m.length > 50 && /\b(cases|logs|confirmed|dropped|handle|handled)\b/i.test(m))
  );
}

async function handleAwaitScopeValue({ cid, focusType, message, uiLang, scopeValueOverride }) {
  // scopeValueOverride: cuando el mensaje es una pregunta, el orchestrator extrae el valor
  const q = String((scopeValueOverride ?? message) || "").trim();
  if (!q) return { ok: true, answer: uiLang === "es" ? "Dime el valor a buscar." : "Tell me what to search for." };

  const r = await resolveAndSetFocus({
    cid,
    type: focusType,
    query: q,
    limit: 500,
    originalMessage: String(message || "").trim() || null,
    uiLang,
  });

  // 0 matches: mostrar error (no usar valor literal en SQL)
  if (r.ok === false && r.reason) {
    return { ok: true, answer: r.reason, applied: false };
  }
  // resolveAndSetFocus ya crea pending pick si hay múltiples
  return { ok: true, answer: r.message, applied: r.applied === true };
}

module.exports = { openScopeWizard, applyPickedScopeType, handleAwaitScopeValue, looksLikeQuestion };
