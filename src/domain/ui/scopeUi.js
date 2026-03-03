
const { FOCUS } = require("../focus/focusRegistry");

function buildScopeUi(ctx = {}, uiLang = "en") {
  const mode = ctx.scopeMode || "general";
  const focus = ctx.focus || null;

  if (mode !== "focus" || !focus?.type) {
    return { mode: "general", label: "General" };
  }

  const typeLabel = focus.type.charAt(0).toUpperCase() + focus.type.slice(1);

  if (!focus.value) {
    return {
      mode: "focus",
      label: `${typeLabel} `,
    };
  }

  return {
    mode: "focus",
    label: `${typeLabel}: ${focus.value}`,
  };
}

module.exports = { buildScopeUi };
