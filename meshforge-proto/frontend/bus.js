// A tiny in-page event bus. Original MIT code.
// Materials, components, and the AI plugin talk through named events.
// Nothing on this bus stores an API key or a server address.

export function createBus() {
  const listeners = new Map();

  function on(name, fn) {
    const key = String(name || '');
    if (!key || typeof fn !== 'function') return () => {};
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key).add(fn);
    return () => off(key, fn);
  }

  function off(name, fn) {
    listeners.get(String(name || ''))?.delete(fn);
  }

  function emit(name, data) {
    const set = listeners.get(String(name || ''));
    if (!set || !set.size) return [];
    const out = [];
    for (const fn of [...set]) {
      try { out.push(fn(data, name)); }
      catch (err) { out.push({ ok: false, error: err?.message || String(err) }); }
    }
    return out;
  }

  return { on, off, emit };
}
