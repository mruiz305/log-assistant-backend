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

  // ✅ 1) Guardar tipo elegido inmediatamente
  setContext(cid, {
    scopeMode: type === "general" ? "general" : "focus",
    focus: type === "general" ? null : { type, value: null, label: null },
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


async function handleAwaitScopeValue({ cid, focusType, message, uiLang }) {
  // aquí el mensaje del usuario ES el texto a buscar (Miami, Alpha, etc.)
  const q = String(message || "").trim();
  if (!q) return { ok: true, answer: uiLang === "es" ? "Dime el valor a buscar." : "Tell me what to search for." };

  const r = await resolveAndSetFocus({ cid, type: focusType, query: q, limit: 10 });

  // resolveAndSetFocus ya crea pending pick si hay múltiples
  return { ok: true, answer: r.message };
}

module.exports = { openScopeWizard, applyPickedScopeType, handleAwaitScopeValue };
