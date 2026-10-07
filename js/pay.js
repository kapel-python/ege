/* ============================================================
   Plus — единый флоу оплаты (страницы /subscription и manage):
   подтверждение в окне .dlg → генерация счёта → редирект на шлюз →
   возврат ?pay=ok|fail → ожидание тем же .ege-loader, что в приложении
   (css/pay.css) с опросом confirm до первого терминального статуса.

   Счёт живёт на сервере, а не в DOM: обновление страницы, закрытие
   ожидания и смена устройства его не теряют — добивают баннер
   «Счёт ждёт оплаты» (renderPendingBanner) и автопроверка при возврате.
   Вечного окна нет: опрос — до ~2 минут, дальше «Проверь снова» /
   «Закрыть»; неоплаченный счёт умирает сам через ~30 минут в шлюзе,
   отменить можно кнопкой (POST payments/cancel, только свой pending).
   Зависимостей нет, стиль ES5 как на соседних страницах.
   ============================================================ */
var PayFlow = (function () {
  "use strict";

  var POLL_INTERVAL = 5000;
  var POLL_MAX = 24; /* ~2 минуты автоожидания, дальше — вручную */
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

  /* ---------- единое окно .dlg ---------- */
  var CARD_SVG = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>';
  var CHECK_SVG = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

  function openDlg(html, opts) {
    closeDlg();
    opts = opts || {};
    var back = document.createElement("div");
    back.className = "dlg-backdrop";
    back.id = "payDlg";
    back.innerHTML = '<div class="dlg" role="dialog" aria-modal="true" aria-label="' + esc(opts.label || "Оплата Plus") + '">'
      + (opts.locked ? "" : '<button class="dlg__close" type="button" data-x aria-label="Закрыть">×</button>')
      + html + "</div>";
    document.body.appendChild(back);
    function onKey(e) { if (e.key === "Escape") closeDlg(); }
    document.addEventListener("keydown", onKey);
    back._dlgKey = onKey;
    if (!opts.locked) {
      back.addEventListener("click", function (e) {
        if (e.target === back || e.target.closest("[data-x]")) closeDlg();
      });
    }
    try { document.body.style.overflow = "hidden"; } catch (e) {}
    return back;
  }
  function closeDlg() {
    var back = document.getElementById("payDlg");
    if (!back) return;
    try { document.removeEventListener("keydown", back._dlgKey); } catch (e) {}
    if (back.parentNode) back.parentNode.removeChild(back);
    try { document.body.style.overflow = ""; } catch (e) {}
  }

  function periodName(period) { return period === "year" ? "год" : "месяц"; }
  function periodDays(period) { return period === "year" ? "12 месяцев" : "30 дней"; }

  /* ---------- шаг 1: подтверждение до генерации счёта ---------- */
  function buy(opts) {
    opts = opts || {};
    var period = opts.period === "year" ? "year" : "month";
    var price = Number(opts.price) || (period === "year" ? 1590 : 199);
    var cancelled = false;
    var dlg = openDlg(
      '<div class="dlg__eyebrow">Подписка Plus</div>'
      + '<div class="dlg-device"><div class="dlg-device__icon" aria-hidden="true">' + CARD_SVG + "</div>"
      + '<div class="dlg-device__name">Оформить Plus · ' + esc(periodName(period)) + "</div></div>"
      + '<div class="dlg-kv">'
      + '<div class="dlg-kv__row"><span>Тариф</span><span>Plus · ' + esc(periodName(period)) + "</span></div>"
      + '<div class="dlg-kv__row"><span>К оплате</span><span><b>' + esc(fmtSum(price * 100)) + ' ₽</b></span></div>'
      + '<div class="dlg-kv__row"><span>Срок</span><span>' + esc(periodDays(period)) + "</span></div>"
      + '<div class="dlg-kv__row"><span>Оплата</span><span>СБП / карта, на стороне провайдера</span></div>'
      + "</div>"
      + '<div class="dlg__text">После нажатия откроется страница оплаты. Данные карты нам не попадают — к нам приходит только факт оплаты.</div>'
      + '<div class="dlg__actions">'
      + '<button class="btn btn-ghost btn--sm" type="button" data-x>Отмена</button>'
      + '<button class="btn btn-primary btn--sm" type="button" data-pay>Оплатить ' + esc(fmtSum(price * 100)) + " ₽</button>"
      + "</div>",
      { label: "Подтверждение оплаты" });
    var payBtn = dlg.querySelector("[data-pay]");
    payBtn.addEventListener("click", function () {
      if (cancelled) return;
      payBtn.disabled = true;
      payBtn.textContent = "Создаём счёт…";
      var key = "web-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
      api("/api/subscription/checkout", { period: period, idempotencyKey: key }).then(function (res) {
        if (cancelled) return; /* окно закрыли, пока создавался счёт: редиректа нет, счёт подберёт баннер */
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
    var oldClose = closeDlg;
    dlg.addEventListener("click", function (e) {
      if (e.target === dlg || (e.target.closest && e.target.closest("[data-x]"))) cancelled = true;
    });
    return { close: function () { cancelled = true; oldClose(); } };
  }

  function errorDlg(title, text, retry) {
    var dlg = openDlg(
      '<div class="dlg__eyebrow">Оплата</div>'
      + '<div class="dlg-device"><div class="dlg-device__icon" aria-hidden="true">' + CARD_SVG + "</div>"
      + '<div class="dlg-device__name">' + esc(title) + "</div></div>"
      + '<div class="dlg__text">' + esc(text) + "</div>"
      + '<div class="dlg__actions">'
      + (retry ? '<button class="btn btn-primary btn--sm" type="button" data-retry>Попробовать снова</button>' : "")
      + '<button class="btn btn-ghost btn--sm" type="button" data-x>Закрыть</button>'
      + "</div>",
      { label: String(title) });
    if (retry) {
      dlg.querySelector("[data-retry]").addEventListener("click", function () {
        closeDlg();
        window.dispatchEvent(new CustomEvent("pay:retry"));
      });
    }
  }

  /* ---------- шаг 2: ожидание после возврата ---------- */
  var waitState = null;

  function loaderHTML(title, sub) {
    return '<div class="ege-loader" role="status">'
      + '<div class="ege-loader__orbit"><div class="ege-loader__core">'
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5L3 8z"/></svg>'
      + "</div></div>"
      + '<div class="ege-loader__brand">ege easy <span>plus</span></div>'
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

  function pollOnce(publicId) {
    return api("/api/subscription/confirm", { paymentId: publicId }).then(function (res) {
      return { done: true, ok: true, res: res };
    }).catch(function (err) {
      var msg = (err && err.message) || "";
      if (/ещё не прошла/i.test(msg)) return { done: false };
      return { done: true, ok: false, message: msg || "Не получилось проверить оплату" };
    });
  }

  function pollUntil(publicId, onEvent) {
    var n = 0;
    waitState = waitState || {};
    waitState.stopped = false;
    function tick() {
      if (!waitState || waitState.stopped) return;
      n += 1;
      onEvent({ type: "attempt", n: n });
      pollOnce(publicId).then(function (r) {
        if (!waitState || waitState.stopped) return;
        if (r.done) { onEvent(r.ok ? { type: "ok" } : { type: "fail", message: r.message }); return; }
        if (n >= POLL_MAX) { onEvent({ type: "timeout" }); return; }
        waitState.timer = setTimeout(tick, POLL_INTERVAL);
      });
    }
    tick();
    return { stop: stopWaitTimer };
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
    waitBody(loaderHTML("Проверяем оплату…", "первый запрос"));
    latestPending().then(function (pend) {
      if (!waitState) return;
      if (!pend) {
        /* Счёта уже нет в pending: вебхук успел раньше возврата —
           сверяем подписку напрямую, это и есть «поймать почти сразу». */
        api("/api/subscription/status").then(function (st) {
          if (!waitState) return;
          cleanPayParam();
          if (st && st.active) {
            waitBody(loaderHTML("Оплата прошла!", "Plus уже активен"));
            setTimeout(function () { opts.onPaid ? opts.onPaid() : window.location.reload(); }, 900);
          } else {
            hideWait();
            errorDlg("Активных счетов нет", "Похоже, оплата не завершилась. Создай новый счёт.", false);
          }
        }).catch(function () { if (waitState) { hideWait(); cleanPayParam(); } });
        return;
      }
      var ref = pend.publicId || pend.id;
      pollUntil(ref, function (ev) {
        if (ev.type === "attempt") {
          waitBody(loaderHTML("Проверяем оплату…", "запрос " + ev.n + " · счёт " + fmtSum(pend.amountKopecks) + " ₽"));
        } else if (ev.type === "ok") {
          cleanPayParam();
          dropWait(ref);
          waitBody(loaderHTML("Оплата прошла!", "Plus активен"));
          setTimeout(function () { opts.onPaid ? opts.onPaid() : window.location.reload(); }, 900);
        } else if (ev.type === "fail") {
          cleanPayParam();
          waitBody(loaderHTML("Платёж не прошёл", ev.message)
            + '<div class="paywait__actions"><button class="btn btn-primary btn--sm" type="button" data-new>Создать новый счёт</button>'
            + '<button class="btn btn-ghost btn--sm" type="button" data-close>Закрыть</button></div>');
          bindWaitButtons(opts);
        } else if (ev.type === "timeout") {
          cleanPayParam();
          waitBody(loaderHTML("Пока не видим оплату", "провайдер молчит уже ~2 минуты")
            + '<div class="paywait__note">Деньги без подтверждения не уходят. Счёт живёт ~30 минут — можно вернуться позже, проверка добьёт.</div>'
            + '<div class="paywait__actions"><button class="btn btn-primary btn--sm" type="button" data-recheck>Проверить снова</button>'
            + '<button class="btn btn-ghost btn--sm" type="button" data-close>Закрыть</button></div>'
            + '<div class="paywait__note">Закрытие ничего не отменяет: счёт подберёт баннер ниже.</div>');
          bindWaitButtons(opts, ref);
        }
      });
    }).catch(function () { hideWait(); cleanPayParam(); });
  }

  function bindWaitButtons(opts, ref) {
    var box = document.getElementById("payWait");
    if (!box) return;
    var c = box.querySelector("[data-close]");
    if (c) c.addEventListener("click", stopWait);
    var n = box.querySelector("[data-new]");
    if (n) n.addEventListener("click", function () {
      hideWait();
      buy({ period: (opts && opts.period) || "month", price: (opts && opts.price) || 199 });
    });
    var r = box.querySelector("[data-recheck]");
    if (r && ref) r.addEventListener("click", function () {
      waitBody(loaderHTML("Проверяем оплату…", "ещё раз"));
      /* Повторный цикл с тем же разбором исходов: */
      pollUntil(ref, function (ev) {
        if (ev.type === "attempt") {
          waitBody(loaderHTML("Проверяем оплату…", "запрос " + ev.n));
        } else if (ev.type === "ok") {
          cleanPayParam();
          dropWait(ref);
          waitBody(loaderHTML("Оплата прошла!", "Plus активен"));
          setTimeout(function () { opts.onPaid ? opts.onPaid() : window.location.reload(); }, 900);
        } else if (ev.type === "fail") {
          cleanPayParam();
          waitBody(loaderHTML("Платёж не прошёл", ev.message)
            + '<div class="paywait__actions"><button class="btn btn-primary btn--sm" type="button" data-new>Создать новый счёт</button>'
            + '<button class="btn btn-ghost btn--sm" type="button" data-close>Закрыть</button></div>');
          bindWaitButtons(opts);
        } else if (ev.type === "timeout") {
          waitBody(loaderHTML("Пока не видим оплату", "провайдер всё ещё молчит")
            + '<div class="paywait__actions"><button class="btn btn-primary btn--sm" type="button" data-recheck>Проверить снова</button>'
            + '<button class="btn btn-ghost btn--sm" type="button" data-close>Закрыть</button></div>'
            + '<div class="paywait__note">Счёт живёт ~30 минут с создания.</div>');
          bindWaitButtons(opts, ref);
        }
      });
    });
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
      if (!st || st.active) return; /* Plus уже активен — счёта не было или вебхук добежал */
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
        pollUntil(ref, function (ev) {
          if (ev.type === "attempt") {
            waitBody(loaderHTML("Проверяем оплату…", "запрос " + ev.n));
          } else if (ev.type === "ok") {
            dropWait(ref);
            waitBody(loaderHTML("Оплата прошла!", "Plus активен"));
            setTimeout(function () { opts.onChanged ? opts.onChanged() : window.location.reload(); }, 900);
          } else if (ev.type === "fail") {
            waitBody(loaderHTML("Платёж не прошёл", ev.message)
              + '<div class="paywait__actions"><button class="btn btn-ghost btn--sm" type="button" data-close>Закрыть</button></div>');
            bindWaitButtons(opts);
          } else if (ev.type === "timeout") {
            waitBody(loaderHTML("Пока не видим оплату", "провайдер молчит уже ~2 минуты")
              + '<div class="paywait__actions"><button class="btn btn-ghost btn--sm" type="button" data-close>Закрыть</button></div>'
              + '<div class="paywait__note">Счёт живёт ~30 минут с создания.</div>');
            bindWaitButtons(opts);
          }
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
    });
  }

  return {
    buy: buy,
    bootReturn: bootReturn,
    renderPendingBanner: renderPendingBanner,
    closeDlg: closeDlg
  };
})();
