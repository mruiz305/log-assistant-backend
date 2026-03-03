
function isGreeting(message = "") {
  const m = String(message || "").trim().toLowerCase();
  return /^(hola|hello|hi|buenas|buenos dias|good morning|good afternoon|good evening)\b/i.test(m);
}

function greetingAnswer(uiLang, userName) {
  const name = userName ? ` ${userName}` : "";
  return uiLang === "es"
    ? `¡Hola${name}! ¿Qué te gustaría revisar?`
    : `Hi${name}! What would you like to check?`;
}

module.exports = { isGreeting, greetingAnswer };
