// src/application/chat/runtime/cache.js
const __cache = {
  userMemory: new Map(),
  sqlFromQ: new Map(),
};

function cacheGet(map, key) {
  const hit = map.get(key);
  if (!hit) return null;
  if (hit.exp && hit.exp < Date.now()) {
    map.delete(key);
    return null;
  }
  return hit.v;
}

function cacheSet(map, key, value, ttlMs) {
  map.set(key, { v: value, exp: Date.now() + (ttlMs || 0) });
  if (map.size > 300) {
    const firstKey = map.keys().next().value;
    map.delete(firstKey);
  }
}

module.exports = { __cache, cacheGet, cacheSet };
