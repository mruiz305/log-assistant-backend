const TTL_MS = 10 * 60 * 1000; // 10 min
const store = new Map(); // key: clientId, value: { pending, context, ts }

function touch(clientId) {
  const x = store.get(clientId);
  if (!x) return;
  x.ts = Date.now();
  store.set(clientId, x);
}

function getPending(clientId) {
  const x = store.get(clientId);
  if (!x) return null;
  if (Date.now() - x.ts > TTL_MS) {
    store.delete(clientId);
    return null;
  }
  return x.pending || null;
}

function setPending(clientId, pending) {
  const x = store.get(clientId) || { pending: null, context: null, ts: Date.now() };
  x.pending = pending;
  x.ts = Date.now();
  store.set(clientId, x);
}

function clearPending(clientId) {
  const x = store.get(clientId);
  if (!x) return;
  x.pending = null;
  x.ts = Date.now();
  store.set(clientId, x);
}

function getContext(clientId) {
  const x = store.get(clientId);
  if (!x) return null;
  if (Date.now() - x.ts > TTL_MS) {
    store.delete(clientId);
    return null;
  }
  return x.context || null;
}

function setContext(clientId, context) {
  const x = store.get(clientId) || { pending: null, context: null, ts: Date.now() };
  x.context = { ...(x.context || {}), ...(context || {}) };
  x.ts = Date.now();
  store.set(clientId, x);
}

module.exports = { getPending, setPending, clearPending, getContext, setContext };
