const TTL_MS = 10 * 60 * 1000; // 10 min
const store = new Map(); // key: clientId, value: { pending, ts }

function getPending(clientId) {
  const x = store.get(clientId);
  if (!x) return null;
  if (Date.now() - x.ts > TTL_MS) {
    store.delete(clientId);
    return null;
  }
  return x.pending;
}

function setPending(clientId, pending) {
  store.set(clientId, { pending, ts: Date.now() });
}

function clearPending(clientId) {
  store.delete(clientId);
}

module.exports = { getPending, setPending, clearPending };
