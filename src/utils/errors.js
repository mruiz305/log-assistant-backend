// src/utils/errors.js
function friendlyError(uiLang, reqId) {
  const base =
    uiLang === "es"
      ? "Ups 😅 no pude completar eso ahora mismo. ¿Puedes intentar de nuevo? Si quieres, dime el nombre completo y el período (por ejemplo: “este mes”)."
      : "Oops 😅 I couldn’t complete that right now. Can you try again? If you want, tell me the full name and the time window (e.g., “this month”).";
  return base + ` (ref: ${reqId})`;
}

module.exports = { friendlyError };
