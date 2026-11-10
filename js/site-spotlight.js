/* ============================================================
   lemma go — spotlight-свечение под курсором для карточек.

   Универсальный модуль для всех статичных страниц (как site-reveal).
   Карточки с классом .card (и .subject-tile, .preview-card) получают
   мягкое радиальное свечение, следующее за курсором. Работает через
   CSS-переменные --mx/--my на самом элементе: рисует ::before,
   который страница может стилизовать сама (лендинг так и делает).

   Подключение — одна строка, разметку менять не надо:
     <script src="/js/site-spotlight.js"></script>

   Стиль свечения — инлайн <style> из модуля: страница без своих
   правил получает готовый вид, страница со своими (лендинг) —
   перебивает селектором. pointermove — только на touch-устройствах
   не срабатывает, эффект честно мобильных не касается.
   ============================================================ */(function () {
  "use strict";
  if (window.__EGE_SITE_SPOTLIGHT) return; // защита от двойного подключения
  window.__EGE_SITE_SPOTLIGHT = true;

  var style = document.createElement("style");
  style.textContent = [
    ".card{position:relative;}",
    ".card::before{content:'';position:absolute;inset:0;border-radius:inherit;",
    "opacity:0;transition:opacity 0.4s cubic-bezier(0.16,1,0.3,1);",
    "pointer-events:none;z-index:0;",
    "background:radial-gradient(600px circle at var(--mx,50%) var(--my,50%),",
    "rgba(56,189,248,0.08),transparent 40%);}",
    ".card:hover::before{opacity:1;}",
    ".card>*{position:relative;z-index:1;}"
  ].join("");
  document.head.appendChild(style);

  var SELECTOR = ".card, .subject-tile, .preview-card";
  function track(el) {
    if (el.__egSpotlight) return;
    el.__egSpotlight = true;
    el.addEventListener("pointermove", function (e) {
      var r = el.getBoundingClientRect();
      el.style.setProperty("--mx", (e.clientX - r.left) + "px");
      el.style.setProperty("--my", (e.clientY - r.top) + "px");
    }, { passive: true });
  }
  function scan() {
    document.querySelectorAll(SELECTOR).forEach(track);
  }
  scan();
  // Динамика (модалки, фильтры, подгруженные списки) — ленивый MutationObserver
  if (window.MutationObserver) {
    var mo = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var k = 0; k < added.length; k++) {
          var n = added[k];
          if (n.nodeType !== 1) continue;
          if (n.matches && n.matches(SELECTOR)) track(n);
          if (n.querySelectorAll) n.querySelectorAll(SELECTOR).forEach(track);
        }
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
