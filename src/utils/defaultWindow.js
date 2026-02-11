function applyDefaultWindowToMessage(message, uiLang, userMemory) {
  // si no hay memoria o no hay defaultWindowDays, no toca nada
  const days = Number(userMemory?.defaultWindowDays || 0);
  if (!days || days <= 0) return message;

  // Si el mensaje ya menciona una ventana/periodo, no inyectar
  const m = String(message || "");
  const hasWindow = /\b(last|past)\s+\d+\s+(day|days|week|weeks|month|months)\b/i.test(m)
    || /\b(ultim[oa]s?)\s+\d+\s+(dia|dias|semana|semanas|mes|meses)\b/i.test(m)
    || /\b(mtd|ytd|qtd)\b/i.test(m);

  if (hasWindow) return message;

  // Inyecta una ventana simple
  return uiLang === "es"
    ? `${m} (últimos ${days} días)`
    : `${m} (last ${days} days)`;
}

module.exports = { applyDefaultWindowToMessage };
