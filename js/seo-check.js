/* Единое окно задания на SEO-страницах (/ege/) — без регистрации и сети.
   Повторяет практику сайта (js/app.js), но локально:
   - подсказки по уровням: открываются по одной, первая — жёлтая, дальше —
     синие; после исчерпания у части 1 кнопка становится «Показать решение»;
   - часть 1 (краткий ответ): ввод + автопроверка; верно/неверно — те же
     состояния .feedback, что на сайте; ошибка лишь говорит, что доступна
     следующая подсказка, — открывает её только явный клик по кнопке;
   - часть 2 (check:"self"): поля ввода нет — «Сверить с решением» открывает
     официальный разбор, после чего честная отметка «Решил(а) верно / Не
     получилось» (без XP: здесь это демо, а не зачёт).
   Никаких запросов: только сравнение с разметкой формы .seo-check.
   Проверка — упрощённое зеркало checkAnswer из js/state.js: norm как
   normalizeAnswer, строковое равенство + числовая эквивалентность с
   допуском 1e-6 (включая дроби a/b), кандидаты [data-answer,
   ...data-accept], мультикорни extended_answer («a, b» — порядок не
   важен), строгий формат цифровых ответов /^\d{2,12}$/ как в бланке ЕГЭ.
   data-accept (JSON-массив строк) и data-type читаются defensive: нет
   атрибутов — работает только по data-answer. */
(function () {
  "use strict";
  var norm = function (s) {
    return String(s == null ? "" : s).trim().toLowerCase()
      .replace(/\s+/g, "").replace(/ё/g, "е").replace(/,/g, ".").replace(/[−–—]/g, "-");
  };
  /* Числовое значение ответа: десятичные и дроби вида a/b — как
     numericAnswer в js/state.js. */
  var numericAnswer = function (value) {
    var text = norm(value);
    if (/^[+-]?\d+(?:\.\d+)?\/[+-]?\d+(?:\.\d+)?$/.test(text)) {
      var parts = text.split("/");
      var n = Number(parts[0]);
      var d = Number(parts[1]);
      return d === 0 ? NaN : n / d;
    }
    return Number(text);
  };
  /* Равенство ответов — как sameValue в checkAnswer (js/state.js):
     строковое равенство, затем числовая эквивалентность с допуском 1e-6,
     затем словесные ответы, где дефис/тире/пробел — один разделитель. */
  var sameValue = function (left, right) {
    var a = norm(left);
    var b = norm(right);
    /* Пустой ввод не равен ничему — в том числе нулю: без этого
       Number("") === 0 засчитывало бы эталон «0» пустым полем. */
    if (!a || !b) return false;
    if (a === b) return true;
    var na = numericAnswer(a);
    var nb = numericAnswer(b);
    if (isFinite(na) && isFinite(nb) && Math.abs(na - nb) < 1e-6) return true;
    if (/[a-zа-яё]/i.test(a) && /[a-zа-яё]/i.test(b)) {
      var loose = function (s) { return s.replace(/[\s\-–—−]+/g, ""); };
      if (loose(a) === loose(b)) return true;
    }
    return false;
  };
  /* data-accept — JSON-массив строк (в разметке HTML-escaped, getAttribute
     сущности уже раскодирует). Нет атрибута или битый — только data-answer. */
  var readAccept = function (form) {
    var raw = form.getAttribute("data-accept");
    if (!raw) return [];
    try {
      var parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map(function (v) { return String(v); });
      }
    } catch (e) { /* чужой/битый атрибут — игнорируем */ }
    return [];
  };
  var digitOnly = function (v) {
    return String(v == null ? "" : v).replace(/[^\d]/g, "");
  };
  /* Эталон из одних цифр — ответ пишется по клеткам бланка ЕГЭ. */
  var isDigitAnswer = function (s) {
    return /^\d{2,12}$/.test(String(s == null ? "" : s).trim());
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
      if (box) {
        box.hidden = false;
        /* Фокус — на открытую подсказку: скринридер объявляет её сразу,
           клавиатурный пользователь не теряет место. Кольца не будет
           (.seo-hint:focus без outline), моуш-пользователям не мешает. */
        try {
          box.setAttribute("tabindex", "-1");
          box.focus({ preventScroll: true });
          if (box.scrollIntoView) box.scrollIntoView({ block: "nearest" });
        } catch (_) {}
      }
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
      /* После раскрытия решения ввод мёртв: повторный сабмит больше не
         перезатрёт разбор на ok/bad. Фокус — на фидбек (там aria-live). */
      var frozen = win.querySelector(".answer-input");
      if (frozen) frozen.disabled = true;
      try {
        var fb = feedback.querySelector(".seo-feedback__box");
        if (fb) {
          fb.setAttribute("tabindex", "-1");
          fb.focus({ preventScroll: true });
          if (fb.scrollIntoView) fb.scrollIntoView({ block: "nearest" });
        }
      } catch (_) {}
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

    /* Часть 1: автопроверка короткого ответа (см. шапку файла). */
    if (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var input = form.querySelector(".answer-input");
        if (!input || !feedback) return;
        var raw = String(input.value == null ? "" : input.value);
        if (!raw.trim()) {
          input.classList.add("answer-input--wrong");
          setTimeout(function () { input.classList.remove("answer-input--wrong"); }, 420);
          return;
        }
        var expected = String(form.getAttribute("data-answer") || "");
        var candidates = [expected].concat(readAccept(form));
        var taskType = form.getAttribute("data-type") || "";
        var ok = false;

        if (isDigitAnswer(expected)) {
          /* Строгий формат бланка ЕГЭ: только цифры, по одной в клетке.
             «2,4,5» и «2 4 5» — нарушение формата, а не запись «245»
             (как isDigitSequenceTask + проверка формата в js/app.js).
             Пробелы по краям — шум набора, их прощаем. Без текста задания
             в разметке набор от последовательности не отличить, поэтому
             порядок считаем значимым; формат объясняет подпись сервера. */
          var trimmed = raw.trim();
          if (!/^\d+$/.test(trimmed)) {
            var digits = trimmed.replace(/\D/g, "");
            input.classList.add("answer-input--wrong");
            setTimeout(function () { input.classList.remove("answer-input--wrong"); }, 420);
            feedback.innerHTML = feedbackBox("bad", "Неверный формат записи",
              '<div class="seo-feedback__body">В бланке ЕГЭ такой ответ записывают'
              + " только цифрами, без запятых, точек и пробелов"
              + (digits ? " — в твоём случае это <b class=\"mono\">" + esc(digits) + "</b>" : "")
              + ". Перепиши ответ цифрами и попробуй ещё раз.</div>");
            return;
          }
          var wanted = candidates.map(digitOnly).filter(Boolean);
          ok = wanted.indexOf(trimmed) !== -1;
        } else {
          /* Несколько корней уравнения: нужно всё множество целиком, а не
             один корень; порядок не важен, каждый корень — один раз. */
          var isMultiRoot = taskType === "extended_answer" && expected.indexOf(", ") !== -1;
          var expectedParts = isMultiRoot ? expected.split(/,\s+/) : [expected];
          var inputParts = expectedParts.length > 1
            ? raw.trim().split(/\s*[,;]\s*/)
            : [raw];
          if (!isMultiRoot) {
            ok = candidates.some(function (cand) { return sameValue(cand, inputParts[0]); });
          } else if (inputParts.length === expectedParts.length) {
            var unused = inputParts.slice();
            ok = expectedParts.every(function (part) {
              var idx = -1;
              for (var i = 0; i < unused.length; i++) {
                if (sameValue(part, unused[i])) { idx = i; break; }
              }
              if (idx < 0) return false;
              unused.splice(idx, 1);
              return true;
            });
          } else {
            ok = false;
          }
        }

        if (ok) {
          input.disabled = true;
          if (hintBtn) hintBtn.disabled = true;
          input.classList.add("answer-input--correct");
          feedback.innerHTML = feedbackBox("ok", "Правильно",
            '<div class="seo-feedback__body">В тренажёре за чистое решение без подсказок начисляется больше опыта — закрепи это задание там.</div>');
        } else {
          input.classList.add("answer-input--wrong");
          setTimeout(function () { input.classList.remove("answer-input--wrong"); }, 420);
          feedback.innerHTML = feedbackBox("bad", "Пока не сходится",
            '<div class="seo-feedback__body">'
            + (level < total
              ? "Подсказка " + (level + 1) + " доступна по кнопке — открой её и попробуй ещё раз."
              : "Подсказки кончились — при необходимости открой разбор кнопкой.")
            + "</div>");
        }
      });
    }
  });
})();
