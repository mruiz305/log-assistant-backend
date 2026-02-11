const { handleChatMessage } = require("../usecases/handleChatMessage.usecase");
const { makeReqId } = require("../utils/chatRoute.helpers");

async function postChat(req, res) {
  const reqId = makeReqId();

  try {
    const result = await handleChatMessage({
      reqId,
      user: req.user || null,
      query: req.query || {},
      body: req.body || {},
    });

    return res.json(result);
  } catch (err) {
    console.error(`[${reqId}] chat.controller error:`, err);
    // fallback mínimo (el friendlyError vive en el usecase normalmente)
    return res.status(500).json({ ok: false, error: "Unhandled error" });
  }
}

module.exports = { postChat };
