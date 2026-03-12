
function normalize(s = "") {
  return String(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

function tryResolvePick(message, options = []) {
  const raw = String(message || "").trim();
  const m = normalize(raw);
  if (!raw || !options.length) return null;

  if (process.env.LOG_SQL || process.env.DEBUG_PICK) {
    console.log(
      `[tryResolvePick] msg="${raw.slice(0, 60)}" normalized="${m.slice(0, 60)}" optionsCount=${options.length}`
    );
  }

  // 0) Match exacto por value o label (cuando el front envía el texto de la opción)
  const exactHit = options.find(
    (o) =>
      normalize(String(o.value || "")) === m ||
      normalize(String(o.label || "")) === m ||
      String(o.value || "").trim() === raw ||
      String(o.label || "").trim() === raw
  );
  if (exactHit) {
    if (process.env.LOG_SQL || process.env.DEBUG_PICK) {
      console.log(`[tryResolvePick] RESOLVED via exact id=${exactHit.id} label="${(exactHit.label || "").slice(0, 40)}" value="${(exactHit.value || "").slice(0, 40)}"`);
    }
    return exactHit;
  }

  // 1) Si el user manda "1", "2", etc. (1-based)
  const asIndex = parseInt(raw, 10);
  if (!Number.isNaN(asIndex) && asIndex >= 1 && asIndex <= options.length) {
    const hit = options[asIndex - 1];
    if (process.env.LOG_SQL || process.env.DEBUG_PICK) {
      console.log(`[tryResolvePick] RESOLVED via index ${asIndex} id=${hit?.id} label="${(hit?.label || "").slice(0, 40)}"`);
    }
    return hit;
  }

  // 1b) Índice 0-based: "0" = primera opción (por si el front envía 0-based)
  if (!Number.isNaN(asIndex) && asIndex === 0 && options.length >= 1) {
    const hit = options[0];
    if (process.env.LOG_SQL || process.env.DEBUG_PICK) {
      console.log(`[tryResolvePick] RESOLVED via 0-based index id=${hit?.id} label="${(hit?.label || "").slice(0, 40)}"`);
    }
    return hit;
  }

  // 2) Si manda el id (numérico o string)
  const asId = parseInt(raw.replace(/[^\d]/g, ""), 10);
  if (!Number.isNaN(asId)) {
    const hit = options.find((o) => String(o.id) === String(asId) || String(o.id) === raw);
    if (hit) {
      if (process.env.LOG_SQL || process.env.DEBUG_PICK) {
        console.log(`[tryResolvePick] RESOLVED via id id=${hit.id} label="${(hit.label || "").slice(0, 40)}"`);
      }
      return hit;
    }
  }

  // 3) Match por texto (contiene) - label o value
  const hit2 = options.find(
    (o) =>
      normalize(String(o.label || "")).includes(m) ||
      m.includes(normalize(String(o.label || ""))) ||
      normalize(String(o.value || "")).includes(m) ||
      m.includes(normalize(String(o.value || "")))
  );
  if (hit2) {
    if (process.env.LOG_SQL || process.env.DEBUG_PICK) {
      console.log(`[tryResolvePick] RESOLVED via contains id=${hit2.id} label="${(hit2.label || "").slice(0, 40)}" value="${(hit2.value || "").slice(0, 40)}"`);
    }
    return hit2;
  }

  if (process.env.LOG_SQL || process.env.DEBUG_PICK) {
    console.log(`[tryResolvePick] NOT RESOLVED - no match for msg="${raw.slice(0, 40)}"`);
  }
  return null;
}

module.exports = { tryResolvePick };
