// 每群串行的 post-turn worker：回复先发，记忆 finalize 在后台做；下一轮开始前 drain。
// 失败只记录，不阻塞/不 reject 当前回复。
export function createSerialFinalizer({ finalize, onError = () => {}, now = Date.now } = {}) {
  const chains = new Map();
  const pending = new Map();

  function schedule(key, job) {
    const prev = chains.get(key) ?? Promise.resolve();
    const next = prev.then(async () => {
      const t = now();
      try {
        await finalize(job);
        return { ok: true, ms: now() - t };
      } catch (e) {
        try { onError(e, job); } catch {}
        return { ok: false, ms: now() - t, error: String(e?.message ?? e).slice(0, 120) };
      }
    });
    const tail = next.then(() => {}, () => {});
    chains.set(key, tail);
    pending.set(key, next);
    tail.finally(() => {
      if (chains.get(key) === tail) chains.delete(key);
      if (pending.get(key) === next) pending.delete(key);
    });
    return next;
  }

  function drain(key) {
    return chains.get(key) ?? Promise.resolve();
  }

  function has(key) {
    return chains.has(key);
  }

  async function drainAll() {
    await Promise.all([...new Set([...chains.keys(), ...pending.keys()])].map(drain));
  }

  return { schedule, drain, has, drainAll };
}
