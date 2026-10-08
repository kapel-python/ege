/* ============================================================
   Plus — единый флоу оплаты (страницы /subscription и manage):
   подтверждение в окне .dlg → генерация счёта → редирект на шлюз →
   возврат ?pay=ok|fail → ожидание тем же .ege-loader, что в приложении
   (css/pay.css) с опросом confirm до первого терминального статуса.

   Счёт живёт на сервере, а не в DOM: обновление страницы, закрытие
   ожидания и смена устройства его не теряют — добивают баннер
   «Счёт ждёт оплаты» (renderPendingBanner) и автопроверка при возврате.
   Долгого опроса нет: максимум два автоматических запроса (~5 секунд),
   дальше честное «Оплата не найдена» + ручная перепроверка; неоплаченный
   счёт умирает сам через ~30 минут в шлюзе, отменить можно кнопкой
   (POST payments/cancel, только свой pending). Успех сразу закрывает
   ожидание и обновляет страницу — висящего «Оплата прошла!» нет.
   Зависимостей нет, стиль ES5 как на соседних страницах.
   ============================================================ */
var PayFlow = (function () {
  "use strict";

  var CHECK_RETRY_MS = 5000; /* второй (и последний) автозапрос — через 5 с */
  var WAIT_KEY = "ege_pay_wait_v1";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtSum(kop) {
    return (Number(kop) / 100).toLocaleString("ru-RU", { maximumFractionDigits: 0 });
  }
  function fmtDate(ms) {
    try { return new Date(Number(ms)).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" }); }
    catch (e) { return ""; }
  }
  function api(path, body) {
    var opts = { headers: { "Accept": "application/json" }, credentials: "same-origin", cache: "no-store" };
    if (body !== undefined) {
      opts.method = "POST";
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts).then(function (resp) {
      return resp.json().catch(function () { return {}; }).then(function (data) {
        if (!resp.ok) {
          var err = new Error((data && data.error) || ("HTTP " + resp.status));
          err.status = resp.status;
          throw err;
        }
        return data;
      });
    });
  }

  /* ---------- ссылка «продолжить оплату»: только свой браузер ----------
     Сервер её в истории не отдаёт, поэтому запоминаем локально в момент
     создания счёта. Нет ссылки (другое устройство) — не беда: проверка
     и новый счёт идут через серверное состояние. */
  function loadWaits() {
    try { return JSON.parse(localStorage.getItem(WAIT_KEY) || "{}") || {}; }
    catch (e) { return {}; }
  }
  function waitUrl(id) {
    try { return loadWaits()[id] && loadWaits()[id].url; } catch (e) { return null; }
  }
  function saveWait(id, url) {
    try {
      var all = loadWaits();
      all[id] = { url: String(url), at: Date.now() };
      localStorage.setItem(WAIT_KEY, JSON.stringify(all));
    } catch (e) {}
  }
  function dropWait(id) {
    try {
      var all = loadWaits();
      if (all[id]) { delete all[id]; localStorage.setItem(WAIT_KEY, JSON.stringify(all)); }
    } catch (e) {}
  }

  /* ---------- окно: та же .dlg-система, что везде ----------
     Тот же контракт, что инфо-диалог устройства в профиле и окно о модели
     на ege-result: корень #pay-modal-root, рендер через innerHTML,
     закрытие — крестик / Esc / тап по фону, фокус возвращается вызвавшему.
     Своей сборки модалок у оплаты нет. */
  var payModalPrevFocus = null;

  function payModalRoot() {
    var root = null;
    try { root = document.getElementById("pay-modal-root"); } catch (e) { root = null; }
    if (!root) {
      try {
        root = document.createElement("div");
        root.id = "pay-modal-root";
        document.body.appendChild(root);
      } catch (e) { return null; }
    }
    return root;
  }

  function payModalEscHandler(e) {
    if (e.key === "Escape") closePayModal();
  }

  var payModalOnClose = null;
  function openPayModal(html, label, onClose) {
    var root = payModalRoot();
    if (!root) return null;
    payModalPrevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    payModalOnClose = (typeof onClose === "function") ? onClose : null;
    root.innerHTML = '<div class="dlg-backdrop">'
      + '<div class="dlg" role="dialog" aria-modal="true" aria-label="' + esc(label || "Оплата Plus") + '">'
      + '<button class="dlg__close" type="button" data-close aria-label="Закрыть окно">'
      + '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>'
      + "</button>"
      + html + "</div></div>";
    var back = root.firstChild;
    back.addEventListener("click", function (e) {
      if (e.target === back) closePayModal();
    });
    var x = root.querySelector("[data-close]");
    if (x) x.addEventListener("click", closePayModal);
    document.addEventListener("keydown", payModalEscHandler);
    var dlg = root.querySelector(".dlg");
    if (dlg) { dlg.setAttribute("tabindex", "-1"); try { dlg.focus({ preventScroll: true }); } catch (e) {} }
    return root;
  }
  function closePayModal() {
    var root = null;
    try { root = document.getElementById("pay-modal-root"); } catch (e) { root = null; }
    if (!root || !root.innerHTML) return;
    root.innerHTML = "";
    document.removeEventListener("keydown", payModalEscHandler);
    if (payModalPrevFocus && payModalPrevFocus.isConnected) {
      try { payModalPrevFocus.focus({ preventScroll: true }); } catch (e) {}
    }
    payModalPrevFocus = null;
    var cb = payModalOnClose;
    payModalOnClose = null;
    if (cb) { try { cb(); } catch (e) {} }
  }

  function periodName(period) { return period === "year" ? "год" : "месяц"; }
  function periodDays(period) { return period === "year" ? "12 месяцев" : "1 месяц"; }

  var CARD_SVG = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>';

  /* ---------- шаг 1: подтверждение до генерации счёта ---------- */
  /* Промокод применяется ЯВНО: кнопка «Применить» проверяет код на сервере
     (/api/subscription/promo/quote), показывает скидку и новую сумму до
     создания счёта. Правка кода после применения сбрасывает расчёт — иначе
     на экране висела бы скидка от другого кода. Если код введён, но не
     применён, «Оплатить» сначала применит его (и остановится, если код
     неверный), чтобы сумма на кнопке никогда не расходилась со счётом. */
  function buy(opts) {
    opts = opts || {};
    var period = opts.period === "year" ? "year" : "month";
    var price = Number(opts.price) || (period === "year" ? 1590 : 199);
    var cancelled = false;
    var applied = null; /* {code, discountKopecks, finalKopecks} */
    var root = openPayModal(
      '<div class="dlg__eyebrow">Подписка Plus</div>'
      + '<div class="dlg-device"><div class="dlg-device__icon" aria-hidden="true">' + CARD_SVG + "</div>"
      + '<div class="dlg-device__name">Оформить Plus · ' + esc(periodName(period)) + "</div></div>"
      + '<div class="dlg-kv">'
      + '<div class="dlg-kv__row"><span>Тариф</span><span>Plus · ' + esc(periodName(period)) + "</span></div>"
      + '<div class="dlg-kv__row"><span>К оплате</span><span><b id="payAmount">' + esc(fmtSum(price * 100)) + ' ₽</b></span></div>'
      + '<div class="dlg-kv__row" id="payDiscountRow" hidden><span>Скидка по промокоду</span><span id="payDiscount" style="font-weight:700"></span></div>'
      + '<div class="dlg-kv__row"><span>Срок</span><span>' + esc(periodDays(period)) + "</span></div>"
      + '<div class="dlg-kv__row"><span>Оплата</span><span>СБП / карта, на стороне провайдера</span></div>'
      + '<div class="dlg-kv__row" id="payFeeRow"><span>Комиссия</span><span>7%</span></div>'
      + "</div>"
      + '<div class="dlg__text">После нажатия откроется страница оплаты. Данные карты нам не попадают — к нам приходит только факт оплаты.</div>'
      + '<div class="dlg-promo"><label for="payPromo">Промокод</label>'
      + '<input id="payPromo" type="text" placeholder="если есть" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="16">'
      + '<button class="btn btn-ghost btn--sm" type="button" data-apply>Применить</button></div>'
      + '<div class="dlg-promo__state" id="payPromoState" hidden></div>'
      + '<div class="dlg__actions">'
      + '<button class="btn btn-ghost btn--sm" type="button" data-cancel>Отмена</button>'
      + '<button class="btn btn-primary btn--sm" type="button" data-pay>Оплатить ' + esc(fmtSum(price * 100)) + " ₽</button>"
      + "</div>",
      "Подтверждение оплаты",
      function () { cancelled = true; });
    if (!root) return { close: function () {} };
    var payBtn = root.querySelector("[data-pay]");
    var cancelBtn = root.querySelector("[data-cancel]");
    var applyBtn = root.querySelector("[data-apply]");
    var promoInput = root.querySelector("#payPromo");
    var amountEl = root.querySelector("#payAmount");
    var discountRow = root.querySelector("#payDiscountRow");
    var discountEl = root.querySelector("#payDiscount");
    var feeRow = root.querySelector("#payFeeRow");
    var promoState = root.querySelector("#payPromoState");
    if (cancelBtn) cancelBtn.addEventListener("click", closePayModal);

    function paintPrice(kopecks) {
      if (amountEl) amountEl.textContent = fmtSum(kopecks) + " ₽";
      if (payBtn) payBtn.textContent = Number(kopecks) === 0
        ? "Активировать Plus" : "Оплатить " + fmtSum(kopecks) + " ₽";
      /* 100%-код: счёта и шлюза нет, комиссию платить не с чего — строка
         «Комиссия» скрывается вместе с суммой. */
      if (feeRow) feeRow.hidden = Number(kopecks) === 0;
    }
    function clearApplied() {
      applied = null;
      if (discountRow) discountRow.hidden = true;
      paintPrice(price * 100);
    }
    function stateLine(text, ok) {
      if (!promoState) return;
      promoState.hidden = !text;
      promoState.className = "dlg-promo__state dlg-promo__state--" + (ok ? "ok" : "err");
      promoState.textContent = text || "";
    }
    /* Проверить код на сервере. true — применён (или кода нет), false — отказ. */
    function applyCode() {
      var code = String(promoInput && promoInput.value || "").trim().toUpperCase();
      if (promoInput) promoInput.value = code;
      if (!code) {
        clearApplied();
        stateLine("", true);
        return Promise.resolve(true);
      }
      applyBtn.disabled = true;
      var keep = applyBtn.textContent;
      applyBtn.textContent = "Проверяем…";
      return api("/api/subscription/promo/quote", { period: period, code: code }).then(function (q) {
        applied = q;
        if (discountRow) discountRow.hidden = false;
        if (discountEl) discountEl.textContent = "−" + fmtSum(q.discountKopecks) + " ₽";
        paintPrice(q.finalKopecks);
        stateLine("Промокод " + q.code + " применён: скидка " + fmtSum(q.discountKopecks) + " ₽", true);
        return true;
      }, function (err) {
        clearApplied();
        stateLine((err && err.message) || "Промокод не подошёл", false);
        return false;
      }).then(function (res) {
        applyBtn.disabled = false;
        applyBtn.textContent = keep;
        return res;
      });
    }
    if (applyBtn) applyBtn.addEventListener("click", function () { applyCode(); });
    if (promoInput) promoInput.addEventListener("input", function () {
      /* Код изменили после применения — скидка больше не про него. */
      if (applied && String(promoInput.value || "").trim().toUpperCase() !== applied.code) {
        clearApplied();
        stateLine("Нажми «Применить», чтобы проверить код", false);
      }
    });

    payBtn.addEventListener("click", function () {
      if (cancelled) return;
      payBtn.disabled = true;
      var typed = String(promoInput && promoInput.value || "").trim();
      /* Не применён, но введён — применяем сами и не создаём счёт при отказе. */
      var prep = applied ? Promise.resolve(true) : (typed ? applyCode() : Promise.resolve(true));
      prep.then(function (ok) {
        if (cancelled) return;
        if (ok === false) {
          payBtn.disabled = false;
          return;
        }
        payBtn.textContent = "Создаём счёт…";
        var key = "web-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
        var body = { period: period, idempotencyKey: key };
        if (applied) body.promoCode = applied.code;
        else if (typed) body.promoCode = typed;
        api("/api/subscription/checkout", body).then(function (res) {
          if (cancelled) return; /* окно закрыли, пока создавался счёт: редиректа нет, счёт подберёт баннер */
          if (res && res.status === "succeeded") {
            /* Код на 100%: счёта нет, Plus уже активен. */
            openPayModal(
              '<div class="dlg__eyebrow">Подписка Plus</div>'
              + '<div class="dlg-device"><div class="dlg-device__icon" aria-hidden="true">' + CARD_SVG + "</div>"
              + '<div class="dlg-device__name">Промокод применён</div></div>'
              + '<div class="dlg__text">Plus активен — лимиты уже увеличены. Приятной подготовки!</div>'
              + '<div class="dlg__actions">'
              + '<button class="btn btn-primary btn--sm" type="button" data-ok>Отлично</button>'
              + "</div>",
              "Промокод применён",
              function () { try { window.location.reload(); } catch (e) {} });
            var okBtn = root.querySelector("[data-ok]");
            if (okBtn) okBtn.addEventListener("click", function () { try { window.location.reload(); } catch (e) { closePayModal(); } });
            return;
          }
          if (res && res.paymentUrl) {
            saveWait(res.paymentId, res.paymentUrl);
            window.location.href = res.paymentUrl;
            return;
          }
          errorDlg("Не получилось создать счёт", "Провайдер не вернул ссылку на оплату. Деньги не списаны.", true);
        }).catch(function (err) {
          if (cancelled) return;
          if (err && err.status === 401) { window.location.href = "/dashboard#/profile"; return; }
          var text = (err && err.message) || "Попробуй ещё раз — деньги не списаны.";
          errorDlg("Не получилось создать счёт", text, true);
        });
      });
    });
    return { close: function () { cancelled = true; closePayModal(); } };
  }

  function errorDlg(title, text, retry) {
    var root = openPayModal(
      '<div class="dlg__eyebrow">Оплата</div>'
      + '<div class="dlg-device"><div class="dlg-device__icon" aria-hidden="true">' + CARD_SVG + "</div>"
      + '<div class="dlg-device__name">' + esc(title) + "</div></div>"
      + '<div class="dlg__text">' + esc(text) + "</div>"
      + '<div class="dlg__actions">'
      + (retry ? '<button class="btn btn-primary btn--sm" type="button" data-retry>Попробовать снова</button>' : "")
      + '<button class="btn btn-ghost btn--sm" type="button" data-closebtn>Закрыть</button>'
      + "</div>",
      String(title));
    if (root && retry) {
      root.querySelector("[data-retry]").addEventListener("click", function () {
        closePayModal();
        window.dispatchEvent(new CustomEvent("pay:retry"));
      });
    }
    if (root) {
      var cb = root.querySelector("[data-closebtn]");
      if (cb) cb.addEventListener("click", closePayModal);
    }
  }

  /* ---------- шаг 2: ожидание после возврата ---------- */
  var waitState = null;

  /* Лоадер — дословно тот же, что boot/ожидания приложения (loaderHTML
     в js/app.js): тот же логотип в ядре, тот же бренд, та же полоса.
     Своей анимации у оплаты нет. Токены логотипа — с fallback (в SPA
     резолвятся родные): на страницах без --success/--violet круги иначе
     пропадали бы. Тексты заголовка/подписи — параметры (состояние). */
  var LOADER_LOGO = '<svg viewBox="0 0 44 44" width="32" height="32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="20" cy="23" r="12" style="stroke:var(--accent, #0277B6)" stroke-width="3.6" stroke-linecap="round" stroke-dasharray="64 14" transform="rotate(-45 20 23)"/><circle cx="20" cy="23" r="6.8" style="stroke:var(--success, #16a34a)" stroke-width="2.6"/><circle cx="20" cy="23" r="2.3" style="fill:var(--violet, #7c3aed)"/><path d="M34 8v6M31 11h6" style="stroke:var(--success, #16a34a)" stroke-width="2" stroke-linecap="round"/><circle cx="8" cy="33" r="1.6" style="fill:var(--accent, #0277B6)" opacity=".8"/><circle cx="33.5" cy="30.5" r="1.3" style="fill:var(--violet, #7c3aed)" opacity=".7"/></svg>';

  function loaderHTML(title, sub) {
    return '<div class="card ege-loader" role="status">'
      + '<div class="ege-loader__orbit"><div class="ege-loader__core">' + LOADER_LOGO + "</div></div>"
      + '<div class="ege-loader__brand">ege <span>easy</span></div>'
      + '<div class="ege-loader__title">' + esc(title) + "</div>"
      + '<div class="ege-loader__sub">' + esc(sub) + "</div>"
      + '<div class="ege-loader__bar"><i></i></div></div>';
  }

  function showWait() {
    hideWait();
    waitState = { stopped: false, timer: null };
    var box = document.createElement("div");
    box.className = "paywait";
    box.id = "payWait";
    box.innerHTML = '<button class="paywait__close" type="button" aria-label="Закрыть ожидание">×</button>'
      + '<div style="width:100%;max-width:420px" id="payWaitBody"></div>';
    document.body.appendChild(box);
    box.querySelector(".paywait__close").addEventListener("click", stopWait);
    try { document.body.style.overflow = "hidden"; } catch (e) {}
  }
  function hideWait() {
    stopWaitTimer();
    var box = document.getElementById("payWait");
    if (box && box.parentNode) box.parentNode.removeChild(box);
    try { document.body.style.overflow = ""; } catch (e) {}
    waitState = null;
  }
  function waitBody(html) {
    var b = document.getElementById("payWaitBody");
    if (b) b.innerHTML = html;
  }
  function stopWaitTimer() {
    if (waitState && waitState.timer) { clearTimeout(waitState.timer); waitState.timer = null; }
    if (waitState) waitState.stopped = true;
  }
  function stopWait() {
    /* Закрытие — не отмена счёта: опрос останавливаем, счёт остаётся и
       добивается баннером; деньги без подтверждения провайдера не уходят. */
    hideWait();
  }

  function latestPending() {
    return api("/api/subscription/payments?limit=10&offset=0").then(function (hist) {
      var list = (hist && hist.payments) || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].status === "pending") return list[i];
      }
      return null;
    });
  }

  function checkOnce(publicId) {
    return api("/api/subscription/confirm", { paymentId: publicId }).then(function (res) {
      return { done: true, ok: true, res: res };
    }).catch(function (err) {
      var msg = (err && err.message) || "";
      if (/ещё не прошла/i.test(msg)) return { done: false };
      return { done: true, ok: false, message: msg || "Не получилось проверить оплату" };
    });
  }

  /* Проверка счёта: максимум два автоматических запроса (сразу и через
     5 секунд) — дальше честное «Оплата не найдена», а не бесконечный
     опрос: каждый запрос идёт в живой шлюз, долбить его запрещено
     (рейт-лимит). Ручная «Проверить снова» — тот же короткий цикл. */
  function checkTwice(publicId, onEvent) {
    waitState = waitState || {};
    waitState.stopped = false;
    function finish(r) {
      onEvent(r.ok ? { type: "ok" } : { type: "fail", message: r.message });
    }
    onEvent({ type: "attempt", n: 1 });
    checkOnce(publicId).then(function (r) {
      if (!waitState || waitState.stopped) return;
      if (r.done) { finish(r); return; }
      waitState.timer = setTimeout(function () {
        if (!waitState || waitState.stopped) return;
        onEvent({ type: "attempt", n: 2 });
        checkOnce(publicId).then(function (r2) {
          if (!waitState || waitState.stopped) return;
          if (r2.done) finish(r2);
          else onEvent({ type: "notfound" });
        });
      }, CHECK_RETRY_MS);
    });
  }

  /* Единый разбор исхода: успех сразу закрывает ожидание и обновляет
     страницу — висящего «Оплата прошла!» нет. cfg: {sumText, period,
     price, allowNew, onDone}. */
  function paintOutcome(ev, ref, cfg) {
    cfg = cfg || {};
    if (ev.type === "attempt") {
      waitBody(loaderHTML("Проверяем оплату…",
        (ev.n === 1 ? "первый запрос" : "второй запрос · ещё ~5 секунд")
        + (cfg.sumText ? " · " + cfg.sumText : "")));
      return;
    }
    if (ev.type === "ok") {
      cleanPayParam();
      dropWait(ref);
      hideWait();
      if (cfg.onDone) cfg.onDone();
      else window.location.reload();
      return;
    }
    if (ev.type === "fail") {
      cleanPayParam();
      var failHtml = loaderHTML("Платёж не прошёл", ev.message)
        + '<div class="paywait__actions">';
      if (cfg.allowNew) {
        failHtml += '<button class="btn btn-primary btn--sm" type="button" data-new>Создать новый счёт</button>';
      }
      failHtml += '<button class="btn btn-ghost btn--sm" type="button" data-close>Закрыть</button></div>';
      waitBody(failHtml);
      bindWaitButtons(cfg, ref);
      return;
    }
    cleanPayParam();
    waitBody(loaderHTML("Оплата не найдена", "два запроса — провайдер молчит")
      + '<div class="paywait__note">Деньги без подтверждения не уходят. Счёт живёт ~30 минут — можно вернуться позже.</div>'
      + '<div class="paywait__actions"><button class="btn btn-primary btn--sm" type="button" data-recheck>Проверить снова</button>'
      + '<button class="btn btn-ghost btn--sm" type="button" data-close>Закрыть</button></div>'
      + '<div class="paywait__note">Закрытие ничего не отменяет: счёт подберёт баннер ниже.</div>');
    bindWaitButtons(cfg, ref);
  }

  function bindWaitButtons(cfg, ref) {
    cfg = cfg || {};
    var box = document.getElementById("payWait");
    if (!box) return;
    var c = box.querySelector("[data-close]");
    if (c) c.addEventListener("click", stopWait);
    var n = box.querySelector("[data-new]");
    if (n) n.addEventListener("click", function () {
      hideWait();
      buy({ period: cfg.period || "month", price: cfg.price || 199 });
    });
    var r = box.querySelector("[data-recheck]");
    if (r && ref) r.addEventListener("click", function () {
      checkTwice(ref, function (ev) { paintOutcome(ev, ref, cfg); });
    });
  }

  /* Старт проверки при уже показанном ожидании (оверлей поднимает вызыватель). */
  function startCheck(ref, cfg) {
    checkTwice(ref, function (ev) { paintOutcome(ev, ref, cfg || {}); });
  }

  function cleanPayParam() {
    try {
      var u = new URL(window.location.href);
      if (u.searchParams.has("pay")) {
        u.searchParams.delete("pay");
        var rest = u.searchParams.toString();
        window.history.replaceState({}, "", u.pathname + (rest ? "?" + rest : "") + u.hash);
      }
    } catch (e) {}
  }

  /* Возврат с платёжной страницы. onPaid — что сделать при успехе
     (тост + перерисовка страницы). period/price — для кнопки
     «Создать новый счёт» в терминальных состояниях. */
  function bootReturn(opts) {
    opts = opts || {};
    var payFlag = null;
    try { payFlag = new URLSearchParams(window.location.search).get("pay"); } catch (e) {}
    if (!payFlag) return;
    if (payFlag === "fail") {
      cleanPayParam();
      errorDlg("Платёж не прошёл", "Деньги не списаны. Попробуй ещё раз или создай новый счёт.", false);
      return;
    }
    if (payFlag !== "ok") { cleanPayParam(); return; }
    showWait();
    waitBody(loaderHTML("Проверяем оплату…", "ищем счёт"));
    latestPending().then(function (pend) {
      if (!waitState) return;
      if (!pend) {
        /* Счёта уже нет в pending: вебхук успел раньше возврата —
           сверяем подписку напрямую, это и есть «поймать почти сразу». */
        api("/api/subscription/status").then(function (st) {
          if (!waitState) return;
          cleanPayParam();
          hideWait();
          if (st && st.active) {
            if (opts.onPaid) opts.onPaid();
            else window.location.reload();
          } else {
            errorDlg("Активных счетов нет", "Похоже, оплата не завершилась. Создай новый счёт.", false);
          }
        }).catch(function () { if (waitState) { hideWait(); cleanPayParam(); } });
        return;
      }
      var ref = pend.publicId || pend.id;
      startCheck(ref, {
        sumText: fmtSum(pend.amountKopecks) + " ₽",
        period: opts.period, price: opts.price, allowNew: true,
        onDone: function () { if (opts.onPaid) opts.onPaid(); else window.location.reload(); }
      });
    }).catch(function () { hideWait(); cleanPayParam(); });
  }

  /* ---------- баннер незавершённого счёта ---------- */
  function renderPendingBanner(el, opts) {
    opts = opts || {};
    if (!el) return;
    el.innerHTML = "";
    Promise.all([
      api("/api/subscription/status").catch(function () { return null; }),
      api("/api/subscription/payments?limit=10&offset=0").catch(function () { return null; })
    ]).then(function (res) {
      var st = res[0], hist = res[1];
      if (!st) return; /* статус не пришёл — не выдумываем счёт */
      /* Активный Plus больше НЕ прячет баннер: висящий счёт при активной
         подписке — это неоплаченное продление или старый счёт после гранта,
         и человеку нужна кнопка «Отменить счёт» (иначе он застревает:
         промокод заблокирован старым счётом, а отменить его негде). */
      var list = (hist && hist.payments) || [];
      var pend = null;
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].status === "pending") { pend = list[i]; break; }
      }
      if (!pend) return;
      var ref = pend.publicId || pend.id;
      var url = waitUrl(ref);
      var box = document.createElement("div");
      box.className = "pay-pending";
      box.innerHTML = "<b>Счёт ждёт оплаты</b> · " + esc(fmtSum(pend.amountKopecks)) + " ₽"
        + (pend.createdAt ? " · создан " + esc(fmtDate(pend.createdAt)) : "")
        + '<div class="pay-pending__row"></div>';
      var row = box.querySelector(".pay-pending__row");
      function mkBtn(cls, text, fn) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "btn " + cls;
        b.textContent = text;
        b.addEventListener("click", fn);
        row.appendChild(b);
        return b;
      }
      if (url) {
        mkBtn("btn-primary btn--sm", "Продолжить оплату", function () { window.location.href = url; });
      }
      mkBtn(url ? "btn-ghost btn--sm" : "btn-primary btn--sm", "Проверить оплату", function () {
        showWait();
        waitBody(loaderHTML("Проверяем оплату…", "первый запрос"));
        startCheck(ref, {
          sumText: fmtSum(pend.amountKopecks) + " ₽",
          onDone: function () { if (opts.onChanged) opts.onChanged(); else window.location.reload(); }
        });
      });
      mkBtn("btn-ghost btn--sm", "Отменить счёт", function () {
        this.disabled = true;
        this.textContent = "Отменяем…";
        var btn = this;
        api("/api/subscription/payments/cancel", { paymentId: ref }).then(function () {
          dropWait(ref);
          if (opts.onChanged) opts.onChanged();
          else window.location.reload();
        }).catch(function (err) {
          btn.disabled = false;
          btn.textContent = "Отменить счёт";
          if (opts.onError) opts.onError((err && err.message) || "Не получилось отменить счёт");
        });
      });
      el.appendChild(box);
      /* Один тихий автодобор для НАСТОЯЩЕГО шлюза (platega): человек закрыл
         вкладку на странице оплаты и вернулся позже, а вебхук задержался —
         при открытии страницы подписка включится сама, без кнопки. Это не
         опрос: один confirm на открытие (в него входит живой статус шлюза).
         Mock не трогаем: его pending — состояние dev/тестов, а не деньги. */
      if (opts.autoCheck && pend.provider === "platega" && !waitState) {
        api("/api/subscription/confirm", { paymentId: ref }).then(function (res) {
          if (res && res.status === "succeeded") {
            if (opts.onChanged) opts.onChanged();
            else window.location.reload();
          }
        }).catch(function () {
          /* Счёт мог истечь/отмениться на стороне шлюза — перечитываем
             локальный статус: если он больше не pending, баннер и запрет
             покупки должны уйти сами, без действий человека. */
          api("/api/subscription/payments?limit=10&offset=0").then(function (hist) {
            var list = (hist && hist.payments) || [];
            for (var i = 0; i < list.length; i++) {
              var p = list[i] || {};
              if (p.publicId === ref || String(p.id) === String(ref)) {
                if (p.status === "pending") return;
                if (opts.onChanged) opts.onChanged();
                else window.location.reload();
                return;
              }
            }
          }).catch(function () {});
        });
      }
    });
  }

  return {
    buy: buy,
    bootReturn: bootReturn,
    renderPendingBanner: renderPendingBanner,
    closeModal: closePayModal
  };
})();
