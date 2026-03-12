
const { chatOrchestratorHandle } = require("../application/chat/chat.orchestrator");
const { makeTimers } = require("../utils/timers");

// Opcional: controla logs con env
function toBool(v) {
  if (v === true || v === "true" || v === 1 || v === "1") return true;
  return false;
}

function normalizeLang(v) {
  const x = String(v || "").toLowerCase().trim();
  return x === "es" ? "es" : "en";
}

function pickClientId({ query, body, user }) {
  return (
    (query && (query.cid || query.clientId || query.conversationId || query.convid)) ||
    (body && (body.cid || body.clientId || body.conversationId || body.convid)) ||
    (user && (user.cid || user.clientId)) ||
    null
  );
}

function pickMessage({ body, query }) {
  // soporta varios nombres típicos para no romper el front
  return (
    (body && (body.message || body.text || body.q || body.prompt)) ||
    (query && (query.message || query.text || query.q)) ||
    ""
  );
}

function pickUid(user) {
  // requireFirebaseAuth usualmente pone req.user.uid
  if (!user) return null;
  return user.uid || user.user_id || user.id || null;
}

async function handleChatMessage({ reqId, user, query, body }) {
  const timers = makeTimers();

  const debug = toBool(query?.debug || body?.debug);
  const debugPerf = toBool(query?.debugPerf || body?.debugPerf);

  // si ya tienes una variable propia, cámbiala aquí
  const logEnabled = toBool(process.env.LOG_SQL || query?.logSql || body?.logSql);

  const uiLang = normalizeLang(query?.lang || body?.lang);

  let message = String(pickMessage({ body, query }) || "").trim();

  // Contrato para selección de pick (cuando el usuario hace clic en una opción):
  // - message: "1", "2", ... (1-based) o el label/value de la opción
  // - body.pickIndex / body.selectedIndex: 0-based (se convierte a "1", "2"...)
  // - body.meta?.pickIndex / body.meta?.selectedIndex: 0-based
  // - body.pickValue / body.meta?.pickValue: label o value de la opción seleccionada
  //
  // FIX: Priorizar pick meta cuando exista. Si el front envía message=original + pickIndex,
  // usar la selección (no el mensaje original) para que tryResolvePick resuelva correctamente.
  const hasPickMeta =
    typeof (body?.pickIndex ?? body?.selectedIndex ?? body?.meta?.pickIndex ?? body?.meta?.selectedIndex) === "number" ||
    !!(body?.pickValue ?? body?.meta?.pickValue ?? body?.selectedOption?.value ?? body?.selectedOption?.label);

  // Priorizar pickValue sobre pickIndex: cuando el front filtra la lista, el índice es sobre la
  // lista filtrada pero el backend tiene la lista completa → usar valor evita selección incorrecta
  if (hasPickMeta) {
    const pickVal = body?.pickValue ?? body?.meta?.pickValue ?? body?.selectedOption?.value ?? body?.selectedOption?.label;
    if (pickVal && typeof pickVal === "string") {
      message = String(pickVal).trim();
    } else {
      const idx = body?.pickIndex ?? body?.selectedIndex ?? body?.meta?.pickIndex ?? body?.meta?.selectedIndex;
      if (typeof idx === "number" && idx >= 0) {
        message = String(idx + 1); // 0-based -> 1-based para tryResolvePick
      }
    }
  } else if (!message) {
    // fallback legacy: si no hay message ni pick meta
    const idx = body?.pickIndex ?? body?.selectedIndex ?? body?.meta?.pickIndex ?? body?.meta?.selectedIndex;
    if (typeof idx === "number" && idx >= 0) {
      message = String(idx + 1);
    } else {
      const pickVal = body?.pickValue ?? body?.meta?.pickValue ?? body?.selectedOption?.value ?? body?.selectedOption?.label;
      if (pickVal && typeof pickVal === "string") message = String(pickVal).trim();
    }
  }

  const cidFinal = pickClientId({ query, body, user });
  const uid = pickUid(user);

  // [DEBUG] Log valor recibido al seleccionar opción
  if (debug || logEnabled || body?.meta?.pick || hasPickMeta || /^[1-9]$/.test(message)) {
    console.log(
      `[handleChatMessage] IN msg="${message}" cid="${cidFinal || "(null)"}" hasPickMeta=${hasPickMeta} meta=${JSON.stringify(body?.meta || {})}`
    );
  }

  const out = await chatOrchestratorHandle({
    req: { user, query, body },
    reqId,
    timers,
    debugPerf,
    debug,
    logEnabled,
    uid,
    cid: cidFinal,
    uiLang,
    message,
  });

  return out;
}

module.exports = { handleChatMessage };
