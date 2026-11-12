// 同群串行：一个群同时只跑一个 turn；排太久的旧消息直接丢掉，别回几分钟前的话。
export function createChatQueue({ maxWaiting = 2, staleMs = 40_000, now = Date.now } = {}) {
  const chats = new Map();

  function stateOf(key) {
    let s = chats.get(key);
    if (!s) { s = { key, running: false, waiting: [] }; chats.set(key, s); }
    return s;
  }

  function drop(item, reason) {
    const queueWaitMs = now() - item.enqueuedAt;
    item.resolve({ ...item.meta, text: "", silent: false, dropped: reason, ms: queueWaitMs, queueWaitMs });
  }

  function next(s) {
    if (!s.waiting.length) { chats.delete(s.key); return; }
    // 直达消息（@/私聊/引用自己）优先取；同为直达时仍先进先出
    let idx = s.waiting.findIndex((x) => x.priority);
    if (idx < 0) idx = 0;
    const item = s.waiting.splice(idx, 1)[0];
    void run(s, item);
  }

  async function run(s, item) {
    s.running = true;
    const startedAt = now();
    try {
      if (startedAt - item.enqueuedAt > staleMs) drop(item, "stale");
      else {
        const result = await item.job();
        if (result && typeof result === "object") result.queueWaitMs = startedAt - item.enqueuedAt;
        item.resolve(result);
      }
    } catch (e) {
      item.reject(e);
    } finally {
      s.running = false;
      next(s);
    }
  }

  function dropWaiting(key, reason = "reset") {
    const s = chats.get(key);
    if (!s) return 0;
    const n = s.waiting.length;
    for (const item of s.waiting.splice(0)) drop(item, reason);
    if (!s.running) chats.delete(key);
    return n;
  }

  return {
    enqueue(key, job, meta = {}) {
      const s = stateOf(key);
      const item = { job, meta, enqueuedAt: now(), priority: Boolean(meta.priority) };
      const p = new Promise((resolve, reject) => { item.resolve = resolve; item.reject = reject; });
      if (!s.running) { void run(s, item); return p; }
      s.waiting.push(item);
      while (s.waiting.length > maxWaiting) {
        // 先丢最旧的普通消息；只有全是直达时才丢最早的直达
        let idx = s.waiting.findIndex((x) => !x.priority);
        if (idx < 0) idx = 0;
        drop(s.waiting.splice(idx, 1)[0], "queue");
      }
      return p;
    },
    dropWaiting(key, reason = "reset") {
      return dropWaiting(key, reason);
    },
    reset(key) {
      return dropWaiting(key, "reset");
    },
    stats() {
      let running = 0, waiting = 0;
      for (const s of chats.values()) {
        if (s.running) running++;
        waiting += s.waiting.length;
      }
      return { chats: chats.size, running, waiting };
    },
  };
}
