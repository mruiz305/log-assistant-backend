
function detectLangFromMessage(msg = "") {
  const m = String(msg || "").toLowerCase();
  if (/(dame|casos|últimos|este mes|semana|por favor|hola|buenas|quiero)/i.test(m)) return "es";
  return "en";
}

module.exports = { detectLangFromMessage };
