function normalize(s = "") {
  return String(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

function tryResolvePick(message, options = []) {
  const raw = String(message || "").trim();
  const m = normalize(raw);

  // 1) Si el user manda "1", "2", etc.
  const asIndex = parseInt(raw, 10);
  if (!Number.isNaN(asIndex) && asIndex >= 1 && asIndex <= options.length) {
    return options[asIndex - 1];
  }

  // 2) Si manda el id
  const asId = parseInt(raw.replace(/[^\d]/g, ""), 10);
  if (!Number.isNaN(asId)) {
    const hit = options.find(o => String(o.id) === String(asId));
    if (hit) return hit;
  }

  // 3) Match por texto (contiene)
  const hit2 = options.find(o => normalize(o.label).includes(m) || m.includes(normalize(o.label)));
  if (hit2) return hit2;

  return null;
}

module.exports = { tryResolvePick };
