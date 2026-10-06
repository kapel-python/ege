/* Проверка ответа без регистрации на SEO-страницах заданий (/ege/).
   Только локальное сравнение с data-answer: ни профиля, ни сети. */
(function () {
  document.querySelectorAll(".seo-check").forEach(function (f) {
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      var norm = function (s) {
        return String(s || "").trim().toLowerCase().replace(/\s+/g, " ").replace(",", ".");
      };
      var want = norm(f.getAttribute("data-answer"));
      var got = "";
      try {
        got = norm(new FormData(f).get("v"));
      } catch (_) {
        got = "";
      }
      var el = f.querySelector(".seo-check__res");
      if (!el) return;
      if (!got) {
        el.textContent = "Введи ответ выше.";
        return;
      }
      el.textContent = got === want
        ? "Верно! Так держать — дальше больше в тренажёре."
        : "Пока не сошлось — открой ответ и разбор выше.";
    });
  });
})();
