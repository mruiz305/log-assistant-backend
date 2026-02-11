
function buildSuggestions(message = "", uiLang = "en") {
  return uiLang === "es"
    ? ["Últimos 7 días", "Este mes", "Top reps", "Ver dropped"]
    : ["Last 7 days", "This month", "Top reps", "See dropped"];
}

module.exports = { buildSuggestions };
