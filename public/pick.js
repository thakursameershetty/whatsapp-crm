// "A word from my list" for a template variable: every recipient gets one of the words (Friend, Champion, Explorer…),
// spread evenly over the recipients (each word about as often as the others) in a shuffled order that's the same
// every time. Loaded by the Send page (window.PickWords, for the preview) and by the server (require, for the send),
// so the preview shows exactly what's sent. Same method as Spotmies CRM's workflows (pick.ts there).
(function (root) {
  const DEFAULTS = ['Friend', 'Buddy', 'Champion', 'Explorer', 'Partner', 'Mate', 'Achiever', 'Maverick', 'Trendsetter', 'Chief',
    'Captain', 'Pioneer', 'Pro', 'Expert', 'Leader', 'Entrepreneur', 'Founder', 'Innovator', 'Visionary', 'Creator'];

  function fnv(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return h >>> 0;
  }
  // The words, tidy: trimmed, no blanks or repeats (and nothing that could break a message's variable).
  const clean = (list) => [...new Set((Array.isArray(list) ? list : String(list || '').split(/[\n,]/)).map((w) => String(w).replace(/[{}]/g, '').trim().slice(0, 60)).filter(Boolean))].slice(0, 200);
  const keyOf = (words) => `__pick_${fnv(words.join('\n')).toString(36)}`;

  // Each id's word: the least-used word so far, going through the ids in a shuffled order.
  function assign(words, ids) {
    const out = new Map();
    if (!words.length) return out;
    const key = keyOf(words);
    const order = [...words].sort((a, b) => fnv(`${key}|${a}`) - fnv(`${key}|${b}`));
    const used = new Map(order.map((w) => [w, 0]));
    const todo = [...new Set(ids)].sort((a, b) => fnv(`${key}|${a}`) - fnv(`${key}|${b}`) || (a < b ? -1 : 1));
    for (const id of todo) {
      let best = order[0];
      for (const w of order) if (used.get(w) < used.get(best)) best = w;
      out.set(id, best);
      used.set(best, used.get(best) + 1);
    }
    return out;
  }

  const api = { DEFAULTS, clean, assign };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PickWords = api;
})(typeof window !== 'undefined' ? window : globalThis);
