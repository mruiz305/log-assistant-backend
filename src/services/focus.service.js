// src/services/focus.service.js
const { FOCUS } = require("../domain/focus/focusRegistry");
const { findFocusCandidates } = require("../repos/focus.repo");
const { setPending, setContext, clearPending, getContext } = require("../domain/context/conversationState");

const FOCUS_TO_DIM = {
  submitter: "person", office: "office", pod: "pod", team: "team",
  region: "region", director: "director", intake: "intake", attorney: "attorney",
};

function buildOfficeLabel(r) {
  // Muestra info útil, pero el valor para filtrar será r.name
  const parts = [];
  if (r.name) parts.push(r.name);
  if (r.office) parts.push(`— ${r.office}`);
  if (r.decription) parts.push(`(${r.decription})`);
  return parts.join(" ");
}

function rowToOption(type, r, idx) {
  const cfg = FOCUS[type];
  const canonical = (cfg.canonicalFromRow ? cfg.canonicalFromRow(r) : (r.name || r.attorney || r.office)) || "";

  let label = canonical;
  if (type === "office") label = buildOfficeLabel(r);
  else if (type === "attorney") label = r.attorney || canonical;
  else if (r.email) label = `${canonical} (${r.email})`;

  return {
    id: String(idx + 1),
    label,
    value: canonical, 
    raw: r,
  };
}

/**
 * Resuelve un focus pedido por el usuario:
 * - 0 matches => ok:false + reason
 * - 1 match  => setContext focus y scopeMode=focus
 * - N matches => setPending pick_focus_candidate y devuelve prompt para preguntar
 * @param {string} [uiLang] - "en" | "es" - UI language for messages
 */
async function resolveAndSetFocus({ cid, type, query, limit = 500, originalMessage = null, uiLang = "en" }) {
  const cfg = FOCUS[type];
  const isEs = uiLang === "es";

  if (!cfg) {
    return {
      ok: false,
      reason: isEs
        ? `Tipo de focus inválido: ${type}`
        : `Invalid focus type: ${type}`,
    };
  }

  const rows = await findFocusCandidates({ type, query, limit });

  if (!rows.length) {
    return {
      ok: false,
      reason: isEs
        ? `No encontré coincidencias para "${query}" en ${cfg.label}.`
        : `I couldn't find any matches for "${query}" in ${cfg.label}. Try another name or check the spelling.`,
    };
  }

  // 1 match => set focus directo y limpiar scope anterior (solo el nuevo)
  if (rows.length === 1) {
    const r = rows[0];
    const value = (cfg.canonicalFromRow ? cfg.canonicalFromRow(r) : (r.name || r.attorney || r.office)) || "";
    const dimKey = FOCUS_TO_DIM[type] || type;

    const ctxNow = getContext(cid) || {};
    const nextFilters = { ...(ctxNow.filters || {}) };
    ["person", "office", "pod", "team", "region", "director", "intake", "attorney"].forEach((k) => {
      nextFilters[k] = k === dimKey ? { value, locked: true, exact: true } : null;
    });

    setContext(cid, {
      scopeMode: "focus",
      focus: { type, value, label: value },
      filters: nextFilters,
    });
    clearPending(cid);

    return {
      ok: true,
      applied: true,
      focus: { type, value },
      message: isEs
        ? `Listo. Enfoque configurado en **${cfg.label}**: **${value}**.`
        : `Done. Focus set to **${cfg.label}**: **${value}**.`,
    };
  }

  // múltiples => pedir pick (guardar originalMessage para reejecutar la pregunta tras seleccionar)
  const options = rows.map((r, idx) => rowToOption(type, r, idx));

  setPending(cid, {
    kind: "pick_focus_candidate",
    focusType: type,
    query,
    originalMessage: originalMessage || null,
    options: options.map((o) => ({ id: o.id, label: o.label, value: o.value })),
  });

  return {
    ok: true,
    applied: false,
    askPick: true,
    message:
      isEs
        ? `Encontré ${options.length} coincidencias para "${query}" en **${cfg.label}**. Por favor elige una opción.`
        : `I found ${options.length} matches for "${query}" in **${cfg.label}**. Please choose one.`,
  };
}

/**
 * Modo GENERAL: sin filtros de entidad, solo periodo
 * @param {string} [uiLang] - "en" | "es"
 */
function setGeneralMode(cid, uiLang = "en") {
  setContext(cid, { scopeMode: "general", focus: null });
  clearPending(cid);
  const msg =
    uiLang === "es"
      ? "Listo. Modo **GENERAL** activado (solo periodo de tiempo, sin filtros por entidad)."
      : "Done. **GENERAL** mode enabled (time window only, no entity filters).";
  return { ok: true, message: msg };
}

module.exports = { resolveAndSetFocus, setGeneralMode };
