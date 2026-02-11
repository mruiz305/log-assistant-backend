// src/utils/topic.js
function looksLikeNewTopic(msg = "", uiLang = "en") {
  const m = String(msg || "").toLowerCase().trim();
  if (/(otra cosa|cambiando de tema|nuevo tema|diferente|ahora|por cierto|adem[aá]s)/i.test(m)) return true;
  if (/(another thing|change topic|new topic|now|by the way|also)/i.test(m)) return true;
  if (/(top\s+reps|ranking|por\s+oficina|by\s+office|por\s+team|by\s+team|por\s+region|by\s+region)/i.test(m)) return true;
  return false;
}

module.exports = { looksLikeNewTopic };
