/* ============================================================
   lemma go — полоса прогресса чтения для всех статичных страниц.

   Одна реализация на всех (как site-reveal): тонкая градиентная
   полоса accent→green поверх страницы, показывает, сколько дочитано.
   Элемент #read-progress страница НЕ создаёт — модуль вставляет его
   сам, поэтому подключение — одна строка:
     <script src="/js/site-progress.js"></script>

   Прогрессивное улучшение: без JS полосы нет и не надо. Полоса
   position:fixed, pointer-events:none — не ловит клики. Скролл —
   пассивный слушатель (rAF-троттлинг): passive-скролл не блокирует
   прокрутку. prefers-reduced-motion и lite-anim полосу скрывают:
   движение индикатора — та же анимация, что и reveal.

   Приоритет стилей — инлайновые на созданном элементе: модуль не
   тянет отдельный CSS-файл ради одной полосы (страницы, где полоса
   не нужна, просто не подключают скрипт).
   ============================================================ */(function () {
  "use strict";
  if (window.__EGE_SITE_PROGRESS) return; // защита от двойного подключения
  window.__EGE_SITE_PROGRESS = true;

  var reduced = false;
  try {
    reduced = window.matchMedia
      && matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (e) {}
  if (reduced) return; // движение индикатора выключено тем же гейтом, что и reveal
  // lite-anim полосу НЕ скрывает: это индикатор, а не анимация —
  // rAF-троттлинг + passive-скролл стоят копейки даже на слабом железе.

  var bar = document.createElement("div");
  bar.id = "read-progress";
  bar.setAttribute("aria-hidden", "true");
  bar.style.cssText = "position:fixed;top:0;left:0;height:3px;width:0%;"
    + "background:linear-gradient(90deg,var(--accent,#0277B6),var(--green,#15803d));"
    + "z-index:1000;pointer-events:none;border-radius:0 999px 999px 0;"
    + "box-shadow:0 1px 4px -1px rgba(56,189,248,0.5);";
  document.body.appendChild(bar);

  var ticking = false;
  function paint() {
    ticking = false;
    var h = document.documentElement;
    var max = h.scrollHeight - h.clientHeight;
    var p = max > 0 ? (h.scrollTop / max) * 100 : 0;
    bar.style.width = p.toFixed(2) + "%";
  }
  window.addEventListener("scroll", function () {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(paint);
    }
  }, { passive: true });
  window.addEventListener("resize", paint, { passive: true });
  paint();
})();
