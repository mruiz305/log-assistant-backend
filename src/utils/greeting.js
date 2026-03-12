function isGreeting(message = "") {
  const m = String(message || "").trim().toLowerCase();
  return /^(hola|hello|hi|hey|buenas|buenos dias|good morning|good afternoon|good evening)\b/i.test(m);
}

/** Primer nombre para saludo más cercano: "Maria Chacon" → "Maria" */
function firstName(fullName = "") {
  const n = String(fullName || "").trim().split(/\s+/)[0];
  return n.length >= 2 ? n : fullName;
}

function greetingAnswer(uiLang, userName) {
  const name = firstName(userName) || userName;
  const scopeHintEs = " Usa el filtro de scope arriba para enfocar por oficina, equipo, director, etc.";
  const scopeHintEn = " Use the scope filter above to focus by office, team, director, etc.";
  const hint = uiLang === "es" ? scopeHintEs : scopeHintEn;
  if (uiLang === "es") {
    return name
      ? `¡Hola ${name}! 👋 Qué gusto. ¿En qué puedo ayudarte hoy?${hint}`
      : `¡Hola! 👋 ¿En qué puedo ayudarte hoy?${hint}`;
  }
  return name
    ? `Hey ${name}! 👋 Good to see you. How can I help you today?${hint}`
    : `Hey there! 👋 How can I help you today?${hint}`;
}

module.exports = { isGreeting, greetingAnswer };
