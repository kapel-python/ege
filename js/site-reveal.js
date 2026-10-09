/* ============================================================
   ege easy — единое появление блоков (.rv / .rv-scale).

   Одна реализация на все статичные страницы (стиль —
   css/site-reveal.css). Раньше каждая страница держала свой
   IntersectionObserver: свои пороги, свои длительности, а на
   части страниц анимаций не было вовсе — вид страниц расходился.

   Подключение: <script src="/js/site-reveal.js"></script> БЕЗ defer
   (строку classList.add('js') ставим в <head>, иначе блоки
   мигнут видимыми до первой отрисовки). Классы rv / rv-scale
   ставим в разметке, каскад — переменной --d.

   Все элементы, включая первый экран, набираются наблюдателем:
   синхронный .in ломает transition — блок не успевает отрисоваться
   в opacity:0 (проверено на лендинге: таблетка и превью-карточки
   просто «мигали»). Динамика (блоки, добавленные после загрузки) —
   SiteReveal.scan().

   Хук для страниц со своими SVG-анимациями (лендинг):
   на элементе вспыхивает событие «rv:in».
   ============================================================ */(function () {
  "use strict";

  /* Только блочный reveal. Печать заголовков ([data-type]) — фишка
     лендинга: он сам режет слова в spans и САМ ставит .in после
     подготовки (через SiteReveal.markIn). Если общий модуль поставит
     .in раньше нарезки, transition по словам не сыграет и заголовок
     просто появится. Поэтому data-type здесь сознательно не ловим. */
  var SELECTOR = ".rv:not(.in), .rv-scale:not(.in)";

  function fireRvIn(el) {
    try {
      el.dispatchEvent(new CustomEvent("rv:in", { bubbles: true }));
    } catch (e) {
      try {
        var ev = document.createEvent("CustomEvent");
        if (ev && ev.initCustomEvent) ev.initCustomEvent("rv:in", true, false, null);
        el.dispatchEvent(ev);
      } catch (_) {}
    }
  }

  function markIn(el) {
    el.classList.add("in");
    fireRvIn(el);
    el.addEventListener("transitionend", function onEnd(e) {
      if (e.target !== el || e.propertyName !== "opacity") return;
      el.classList.add("done");
      el.removeEventListener("transitionend", onEnd);
    });
  }

  /* Найти новые .rv:not(.in) и показать/наблюдать. Зовётся при
     загрузке и после любой динамической отрисовки (manage, result).
     root — поддерево для динамических блоков (по умолчанию документ). */
  function scan(root) {
    var scope = root || document;
    var els;
    try {
      els = Array.prototype.slice.call(scope.querySelectorAll(SELECTOR));
    } catch (e) {
      return;
    }
    if (!els.length) return;
    document.documentElement.classList.add("js");

    var reduce = false;
    try {
      reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (e) {}
    if (reduce || !("IntersectionObserver" in window)) {
      els.forEach(markIn);
      return;
    }

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        markIn(en.target);
        io.unobserve(en.target);
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });

    /* Все элементы — через наблюдатель, включая первый экран: синхронный
       .in сюда же приводил к тому, что блок не успевал отрисоваться в
       opacity:0, transition не запускался и контент просто появлялся
       (баг с таблеткой и превью-карточками лендинга). IO срабатывает на
       следующем кадре после layout — движение играет. */
    els.forEach(function (el) { io.observe(el); });
  }

  window.SiteReveal = { scan: scan, markIn: markIn };

  /* Первый кадр: монтируем сразу при выполнении (тег синхронный
     в конце body). DOMContentLoaded — подстраховка. */
  try { scan(); } catch (e) {}
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scan);
  } else {
    scan();
  }
})();
