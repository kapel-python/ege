/* Единое окно задания на SEO-страницах (/ege/) — без регистрации и сети.
   Повторяет практику сайта (js/app.js), но локально:
   - подсказки по уровням: открываются по одной, первая — жёлтая, дальше —
     синие; после исчерпания у части 1 кнопка становится «Показать решение»;
   - часть 1 (краткий ответ): ввод + автопроверка; верно/неверно — те же
     состояния .feedback, что на сайте; ошибка открывает следующую
     подсказку;
   - часть 2 (check:"self"): поля ввода нет — «Сверить с решением» открывает
     официальный разбор, после чего честная отметка «Решил(а) верно / Не
     получилось» (без XP: здесь это демо, а не зачёт).
   Никаких запросов: только сравнение с data-answer из разметки. */
(function () {
  "use strict";
  var norm = function (s) {
    return String(s || "").trim().toLowerCase()
      .replace(/\s+/g, "").replace(/,/g, ".").replace(/−/g, "-");
  };
  var esc = function (s) {
    return String(s || "").replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };

  function feedbackBox(kind, head, bodyHtml) {
    return '<div class="seo-feedback__box seo-feedback--' + kind + '">'
      + '<div class="seo-feedback__head">' + head + '</div>'
      + (bodyHtml || "") + '</div>';
  }

  document.querySelectorAll(".seo-window").forEach(function (win) {
    var kind = win.getAttribute("data-kind") === "self" ? "self" : "auto";
    var hints = Array.prototype.slice.call(win.querySelectorAll(".seo-hint"));
    var hintBtn = win.querySelector(".seo-hint-btn");
    var feedback = win.querySelector(".seo-feedback");
    var solution = win.querySelector(".seo-solution");
    var form = win.querySelector(".seo-check");
    var level = 0;
    var total = hints.length;

    function showNextHint() {
      if (level >= total) return null;
      var box = hints[level];
      level += 1;
      if (box) box.hidden = false;
      if (hintBtn) {
        if (level >= total) {
          if (kind === "auto" && solution) {
            hintBtn.textContent = "Показать решение";
            hintBtn.setAttribute("data-mode", "solution");
          } else {
            hintBtn.disabled = true;
            hintBtn.textContent = "Все подсказки открыты";
          }
        } else {
          hintBtn.textContent = "Подсказка " + (level + 1);
        }
      }
      return box;
    }

    if (hintBtn) {
      hintBtn.addEventListener("click", function () {
        if (hintBtn.getAttribute("data-mode") === "solution") {
          showSolution("shown");
          return;
        }
        showNextHint();
      });
    }

    /* Официальное решение — из скрытого .seo-solution внутри окна. */
    function showSolution(kindName, withMark) {
      if (!solution || !feedback) return;
      var rows = solution.innerHTML;
      var head = kind === "self" ? "Самопроверка" : "Официальное решение";
      var html = rows + '<div class="seo-feedback__body">'
        + (kind === "self"
          ? "Сравни со своим решением на бумаге и честно отметь результат — это и есть проверка части 2."
          : "Задание ушло в повторение — тренажёр вернёт его в работе над ошибками.")
        + "</div>";
      if (withMark) {
        html += '<div class="seo-feedback__actions">'
          + '<button type="button" class="btn btn-ghost btn--sm" data-mark="0">Не получилось</button>'
          + '<button type="button" class="btn btn-primary btn--sm" data-mark="1">Решил(а) верно</button>'
          + "</div>";
      }
      feedback.innerHTML = feedbackBox(kindName, head, html);
      if (hintBtn) { hintBtn.disabled = true; }
      var revealBtn = win.querySelector(".seo-reveal-btn");
      if (revealBtn) revealBtn.remove();
      if (withMark) {
        feedback.querySelectorAll("[data-mark]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var ok = btn.getAttribute("data-mark") === "1";
            feedback.innerHTML = feedbackBox(ok ? "ok" : "bad",
              ok ? "Отмечено как решено" : "Отмечено для повторения",
              '<div class="seo-feedback__body">'
              + (ok ? "Закрепи результат в тренажёре — там за такие решения начисляется опыт и растёт прогноз балла."
                    : "Тренажёр вернёт похожие задания, пока тема не закроется чистым решением без подсказок.")
              + "</div>");
          });
        });
      }
    }

    var revealBtn = win.querySelector(".seo-reveal-btn");
    if (revealBtn) {
      revealBtn.addEventListener("click", function () {
        showSolution("shown", true);
      });
    }

    /* Часть 1: автопроверка короткого ответа. */
    if (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var input = form.querySelector(".answer-input");
        if (!input || !feedback) return;
        var got = norm(input.value);
        if (!got) {
          input.classList.add("answer-input--wrong");
          setTimeout(function () { input.classList.remove("answer-input--wrong"); }, 420);
          return;
        }
        var want = norm(form.getAttribute("data-answer"));
        if (got === want) {
          input.disabled = true;
          input.classList.add("answer-input--correct");
          feedback.innerHTML = feedbackBox("ok", "Правильно",
            '<div class="seo-feedback__body">В тренажёре за чистое решение без подсказок начисляется больше опыта — закрепи это задание там.</div>');
        } else {
          input.classList.add("answer-input--wrong");
          setTimeout(function () { input.classList.remove("answer-input--wrong"); }, 420);
          var opened = showNextHint();
          feedback.innerHTML = feedbackBox("bad", "Пока не сходится",
            '<div class="seo-feedback__body">'
            + (opened
              ? "Ошибка открыла следующую подсказку — можно попробовать ещё раз."
              : "Подсказки кончились — при необходимости открой разбор кнопкой.")
            + "</div>");
        }
      });
    }
  });
})();
