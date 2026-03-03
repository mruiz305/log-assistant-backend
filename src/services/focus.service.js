// src/services/focus.service.js
const { FOCUS } = require("../domain/focus/focusRegistry");
const { findFocusCandidates } = require("../repos/focus.repo");
const { setPending, setContext, clearPending, getContext } = require("../domain/context/conversationState");

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
 */
async function resolveAndSetFocus({ cid, type, query, limit = 10 }) {
  const cfg = FOCUS[type];
  if (!cfg) {
    return { ok: false, reason: `Tipo de focus inválido: ${type}` };
  }

  const rows = await findFocusCandidates({ type, query, limit });

  if (!rows.length) {
    return {
      ok: false,
      reason: `No encontré coincidencias para "${query}" en ${cfg.label}.`,
    };
  }

  // 1 match => set focus directo
  if (rows.length === 1) {
    const r = rows[0];
    const value = (cfg.canonicalFromRow ? cfg.canonicalFromRow(r) : (r.name || r.attorney || r.office)) || "";

    setContext(cid, {
      scopeMode: "focus",
      focus: { type, value, label: value },
    });
    clearPending(cid);

    return {
      ok: true,
      applied: true,
      focus: { type, value },
      message: `Listo. Enfoque configurado en **${cfg.label}**: **${value}**.`,
    };
  }

  // múltiples => pedir pick
  const options = rows.map((r, idx) => rowToOption(type, r, idx));

  setPending(cid, {
    kind: "pick_focus_candidate",
    focusType: type,
    query,
    options: options.map((o) => ({ id: o.id, label: o.label, value: o.value })),
  });

  return {
    ok: true,
    applied: false,
    askPick: true,
    message:
      `Encontré ${options.length} coincidencias para "${query}" en **${cfg.label}**.\n` +
      options.map((o) => `${o.id}) ${o.label}`).join("\n") +
      `\n\nResponde con **1-${options.length}**.`,
  };
}

/**
 * Modo GENERAL: sin filtros de entidad, solo periodo
 */
function setGeneralMode(cid) {
  setContext(cid, { scopeMode: "general", focus: null });
  clearPending(cid);
  return { ok: true, message: "Listo. Modo **GENERAL** activado (solo periodo de tiempo, sin filtros por entidad)." };
}

module.exports = { resolveAndSetFocus, setGeneralMode };
