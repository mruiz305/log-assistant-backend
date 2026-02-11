
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
    (query && (query.cid || query.clientId)) ||
    (body && (body.cid || body.clientId)) ||
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

  const message = String(pickMessage({ body, query }) || "").trim();

  const cid = pickClientId({ query, body, user });
  const uid = pickUid(user);

  // si tu front maneja conversation id separado, soporta también eso
  const conversationId =
    (query && (query.conversationId || query.convid)) ||
    (body && (body.conversationId || body.convid)) ||
    null;

  // Nota: el orchestrator espera `cid` (clientId) para estado en memoria
  // Si tienes conversationId, puedes decidir usarlo como cid cuando venga vacío:
  const cidFinal = cid || conversationId || null;

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
