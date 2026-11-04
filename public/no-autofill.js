// Stops the browser filling saved logins (or other autofill) into fields on its own, e.g. the signed-in email
// landing in a search box. Browsers never autofill a read-only field, so every typing field starts read-only
// and becomes editable the moment someone presses, taps or tabs into it. Picking a suggestion from the
// browser's list still works, because by then the field is editable. Loaded in <head> so fields are guarded
// as the page is parsed, before the browser's own fill runs. A field marked data-af-skip is left alone.
(function () {
  var TYPES = { '': 1, text: 1, search: 1, email: 1, tel: 1, url: 1, password: 1, number: 1 };
  function typing(el) {
    if (el.tagName === 'TEXTAREA') return true;
    return el.tagName === 'INPUT' && TYPES[(el.getAttribute('type') || '').toLowerCase()] === 1;
  }
  function guard(el) {
    if (!typing(el) || el.readOnly || el.disabled || el.hasAttribute('data-af-skip') || el.hasAttribute('data-af-guard')) return;
    if (el === document.activeElement) return; // already being typed in (e.g. focused right after it was made)
    el.readOnly = true;
    el.setAttribute('data-af-guard', '');
  }
  function release(el) {
    if (el && el.hasAttribute && el.hasAttribute('data-af-guard')) {
      el.removeAttribute('data-af-guard');
      el.readOnly = false;
    }
  }
  function scan(root) {
    if (root.nodeType !== 1) return;
    if (root.tagName === 'INPUT' || root.tagName === 'TEXTAREA') guard(root);
    else if (root.querySelectorAll) root.querySelectorAll('input, textarea').forEach(guard);
  }
  new MutationObserver(function (list) {
    for (var i = 0; i < list.length; i++) for (var j = 0; j < list[i].addedNodes.length; j++) scan(list[i].addedNodes[j]);
  }).observe(document.documentElement, { childList: true, subtree: true });
  // Press/tap comes before focus, so the field is already editable when the browser decides whether to offer suggestions.
  document.addEventListener('pointerdown', function (e) { release(e.target.closest && e.target.closest('[data-af-guard]')); }, true);
  document.addEventListener('focusin', function (e) { release(e.target); }, true);
  // Read-only fields skip the browser's "required" checks, so before a form sends, release its fields and check again.
  document.addEventListener('submit', function (e) {
    var f = e.target;
    var held = f.querySelectorAll ? f.querySelectorAll('[data-af-guard]') : [];
    if (!held.length) return;
    held.forEach(release);
    if (!f.noValidate && f.checkValidity && !f.checkValidity()) { e.preventDefault(); e.stopImmediatePropagation(); f.reportValidity(); }
  }, true);
  window.releaseAutofillGuard = release; // for code that wants a field editable without focusing it
})();
