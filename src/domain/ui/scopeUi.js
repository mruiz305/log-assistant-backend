function buildScopeUi(ctx = {}, uiLang = "en") {
  const mode = ctx.scopeMode || "general";
  const focus = ctx.focus || null;

  if (mode !== "focus" || !focus?.type) {
    return {
      mode: "general",
      label: "General",
      filtering: false,
      badge: "General",
      changeHint: uiLang === "es" ? "Cambiar filtro" : "Change filter",
    };
  }

  const typeLabel = focus.type.charAt(0).toUpperCase() + focus.type.slice(1);

  if (!focus.value) {
    return {
      mode: "focus",
      label: `${typeLabel} `,
      filtering: false,
      badge: `${typeLabel} `,
      changeHint: uiLang === "es" ? "Cambiar filtro" : "Change filter",
    };
  }

  const label = `${typeLabel}: ${focus.value}`;
  return {
    mode: "focus",
    label,
    filtering: true,
    badge: label,
    changeHint: uiLang === "es" ? "Cambiar filtro" : "Change filter",
  };
}

module.exports = { buildScopeUi };
