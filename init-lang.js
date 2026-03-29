"use strict";
(function(){
  // Fix #2: Defer setLang until DOMContentLoaded so all elements exist.
  function applyStoredLang() {
    try {
      const l = localStorage.getItem("datashop_lang");
      if (l && typeof setLang === "function") setLang(l);
    } catch(e) {}
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyStoredLang);
  } else {
    applyStoredLang();
  }
})();
