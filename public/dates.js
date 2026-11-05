// Dates read the same way everywhere, whatever the browser's language: 05/11/2026 and 1:00 pm.
// The app formats dates with toLocaleString / toLocaleDateString / toLocaleTimeString and the browser's own locale
// ([] or none), so this sets that one default (day/month/year, 12-hour clock) instead of changing every call.
// A call that names its own locale (e.g. 'en-IN') is left as it is. Loaded before every other script.
(() => {
  const P = Date.prototype;
  const LOCALE = 'en-GB'; // day/month/year order
  const own = (l) => l == null || (Array.isArray(l) && !l.length);
  const TIME_KEYS = ['hour', 'minute', 'second', 'timeStyle', 'dayPeriod'];
  const DEFAULTS = {
    toLocaleString: { day: '2-digit', month: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' }, // 05/11/2026, 1:00 pm
    toLocaleDateString: { day: '2-digit', month: '2-digit', year: 'numeric' }, // 05/11/2026
    toLocaleTimeString: { hour: 'numeric', minute: '2-digit' }, // 1:00 pm
  };
  for (const name of Object.keys(DEFAULTS)) {
    const orig = P[name];
    P[name] = function (locales, opts) {
      if (!own(locales)) return orig.call(this, locales, opts);
      const o = opts ? { ...opts } : { ...DEFAULTS[name] };
      const hasTime = name !== 'toLocaleDateString' ? !opts || TIME_KEYS.some((k) => k in opts) || !['year', 'month', 'day', 'weekday', 'dateStyle'].some((k) => k in opts) : TIME_KEYS.some((k) => k in o);
      if (hasTime && o.hour12 == null && o.hourCycle == null) o.hour12 = true;
      return orig.call(this, LOCALE, o);
    };
  }
})();
