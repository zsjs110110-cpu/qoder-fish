// 进程内 LRU + TTL：只缓存渲染后的文本/元数据，不落盘、不跨进程。
const store = new Map();

export function cacheGet(key, now = Date.now()) {
  const hit = store.get(key);
  if (!hit) return null;
  if (hit.expires && now > hit.expires) { store.delete(key); return null; }
  // Move to end for LRU
  store.delete(key);
  store.set(key, hit);
  return structuredClone(hit.value);
}

export function cacheSet(key, value, { ttlMs = 0, max = 100 } = {}, now = Date.now()) {
  if (!key) return;
  store.set(key, { value: structuredClone(value), expires: ttlMs > 0 ? now + ttlMs : 0 });
  while (store.size > max) store.delete(store.keys().next().value);
}

export function cacheClear(prefix = "") {
  if (!prefix) { store.clear(); return; }
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
}
