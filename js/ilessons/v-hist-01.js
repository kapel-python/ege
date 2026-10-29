/* v-hist-01 — интерактивный модуль урока истории (БЕТА).
 * Контракт: window.ILessonModules["v-hist-01"] = { mount(api) -> cleanup }.
 * Тексты шагов — из api.ilesson.scenes[i] (каталог); DEV ниже — только
 * fallback для разработки (смысл 1:1 со сценами каталога).
 * Суть демо сохранена: лента времени, камера (viewBox-tween), эры-пилюли,
 * кликабельные точки-якоря, квиз «расставь по порядку», replayable SCN,
 * сдержанный confetti на успех, звук по умолчанию ВЫКЛ.
 * Удалено: landing hero, .ov-модалка, логотип, собственный тёмный неон-шит
 * (только var(--...) сайта), свои кнопки/прогресс (используются .btn,
 * .progress, структура .card.lesson-card урока).
 */
(function () {
  "use strict";

  var DEV = [
    { eb: "Задача из ЕГЭ", t: "Решим её за секунду",
      text: "Расставь события по порядку — от самого раннего к самому позднему:\nКрещение Руси · Куликовская битва · Полтавская битва · Отмена крепостного права.\nПокажу способ, после которого такая задача решается за секунду." },
    { eb: "Шаг 1 · Лента времени", t: "Вся история — шесть глав",
      text: "Не десять веков, а шесть глав. Нажми на главу, и лента покажет её." },
    { eb: "Шаг 2 · Якорные даты", t: "13 дат держат всю историю",
      text: "Якорь — дата, которую знаешь точно. Остальные события привязываешь к ней, как лодку к якорю. Полтавская битва (1709): после основания Петербурга (1703), но до войны с Наполеоном (1812)." },
    { eb: "Шаг 3 · Реши сам", t: "Расставь события по порядку",
      text: "Нажимай события от самого раннего к самому позднему. Цветные значки — это главы. Сначала смотри на значок главы, потом на даты." },
    { eb: "Финал", t: "Возвращаемся к задаче",
      text: "Находим якоря: 988, 1380 и 1861 — известные даты.\nПолтава (1709) стоит между 1703 и 1812, значит между Куликовской битвой и отменой крепостного права.\nОтвет: Крещение Руси, Куликовская битва, Полтавская битва, отмена крепостного права." }
  ];

  /* Данные демо (канонический каркас ленты; тексты событий — короткие подписи). */
  var AN = [
    [862, "Призвание варягов"], [988, "Крещение Руси"], [1237, "Нашествие Батыя"],
    [1380, "Куликовская битва"], [1480, "Стояние на Угре"], [1547, "Иван IV — первый царь"],
    [1613, "Избрание Романовых"], [1703, "Основание Петербурга"], [1812, "Отечественная война"],
    [1861, "Отмена крепостного права"], [1917, "Революции"], [1941, "Великая Отечественная"], [1991, "Распад СССР"]
  ];
  var ER = [
    ["⚔️", "Древняя Русь", "862–1132", "#6d7cff"],
    ["🐎", "Раздробленность и Орда", "1132–1462", "#ff6b8a"],
    ["🏰", "Москва собирает Русь", "1462–1613", "#ff9a5a"],
    ["👑", "Империя Романовых", "1613–1825", "#c06bff"],
    ["🔥", "Реформы и революции", "1825–1917", "#22c9a0"],
    ["🚀", "XX век и новая Россия", "1917 — наши дни", "#38bdf8"]
  ];
  var EI = [[0, 1], [2, 3], [4, 5], [6, 8], [9, 10], [11, 12]];
  var EM = ["⛵", "✝️", "🏹", "⚔️", "🔓", "👑", "🏛️", "🌉", "🔥", "⛓️", "✊", "🪖", "🏚️"];
  var AX = AN.map(function (a, i) { return 24 + i * 352 / 12; });
  var POOL = AN.map(function (a, i) { return { n: a[1], y: a[0], e: [0, 0, 1, 1, 2, 2, 3, 3, 3, 4, 4, 5, 5][i] }; })
    .concat([{ n: "Ледовое побоище", y: 1242, e: 1 }, { n: "Полтавская битва", y: 1709, e: 3 },
      { n: "Первая русская революция", y: 1905, e: 4 }, { n: "Полёт Гагарина в космос", y: 1961, e: 5 }]);
  var EV4 = [["Куликовская битва", 1380], ["Отмена крепостного права", 1861], ["Крещение Руси", 988], ["Полтавская битва", 1709]];
  var ORD = [2, 0, 3, 1];
  var CINE_STEPS = { 0: 1, 1: 1, 2: 1, 4: 1 };

  function XY(y) {
    for (var i = 0; i < AN.length - 1; i++) {
      if (y <= AN[i + 1][0]) return AX[i] + (AX[i + 1] - AX[i]) * Math.max(0, (y - AN[i][0]) / (AN[i + 1][0] - AN[i][0]));
    }
    return AX[AN.length - 1];
  }
  function eraBox(k) {
    var s = EI[k][0], e = EI[k][1];
    var x0 = s ? (AX[s - 1] + AX[s]) / 2 : 10, x1 = e < 12 ? (AX[e] + AX[e + 1]) / 2 : 390;
    return [(x0 + x1) / 2 - 80, 110, 160, 120];
  }

  function mount(api) {
    var el = api.el;
    var esc = api.esc || (function (s) { return String(s); });
    var RED = false;
    try { RED = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}
    var scenes = (api.ilesson && Array.isArray(api.ilesson.scenes)) ? api.ilesson.scenes : [];
    var N = scenes.length >= 5 ? scenes.length : 5;
    function scene(i) {
      var s = scenes[i];
      if (s && (s.title || s.text)) {
        return { title: s.title || DEV[Math.min(i, 4)].t, text: s.text || DEV[Math.min(i, 4)].text };
      }
      var d = DEV[Math.min(i, 4)];
      return { title: d.t, text: d.text };
    }

    var idx = 0, dead = false;
    var VB = [0, 0, 400, 300], camRaf = 0, fxRaf = 0, tok = 0;
    var timers = [];
    var abort = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var sig = abort ? { signal: abort.signal } : undefined;
    var AC = null, muted = true;
    var LITE = false;
    try {
      LITE = ((navigator.hardwareConcurrency || 8) <= 4) || ((navigator.deviceMemory || 8) <= 4);
    } catch (e) {}
    var sc = 0, er = 0, ord = [], qidx = 0;
    var ERA = 0, needEras = false, finalBurstDone = false;
    var dr = false, cine = false;

    function later(fn, ms) {
      var id = setTimeout(function () { if (!dead) fn(); }, ms);
      timers.push(id);
      return id;
    }
    function wait(ms) {
      return new Promise(function (res) { later(res, ms); });
    }

    function tone(fq, d, type, v, t0) {
      if (muted) return;
      try {
        AC = AC || new (window.AudioContext || window.webkitAudioContext)();
        var o = AC.createOscillator(), g = AC.createGain(), t = AC.currentTime + (t0 || 0);
        o.type = type || "sine"; o.frequency.value = fq;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(v || 0.05, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + (d || 0.12));
        o.connect(g); g.connect(AC.destination);
        o.start(t); o.stop(t + (d || 0.12) + 0.02);
      } catch (e) {}
    }
    function chime() {
      [660, 880, 1320].forEach(function (z, i) { tone(z, 0.4, "sine", 0.06, i * 0.09); });
    }
    function whoosh() {
      if (muted) return;
      try {
        AC = AC || new (window.AudioContext || window.webkitAudioContext)();
        var n = AC.sampleRate * 0.5, b = AC.createBuffer(1, Math.floor(n), AC.sampleRate), d = b.getChannelData(0);
        for (var i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
        var s = AC.createBufferSource(), fl = AC.createBiquadFilter(), g = AC.createGain(), t = AC.currentTime;
        s.buffer = b; fl.type = "bandpass";
        fl.frequency.setValueAtTime(300, t);
        fl.frequency.exponentialRampToValueAtTime(3000, t + 0.4);
        g.gain.value = 0.05;
        s.connect(fl); fl.connect(g); g.connect(AC.destination); s.start();
      } catch (e) {}
    }

    /* ---------- каркас ---------- */
    el.innerHTML =
      '<div class="il-hist">' +
      '<div class="il-toolbar">' +
      '<div class="progress il-progress"><div class="progress__fill"></div></div>' +
      '<div class="il-tools">' +
      '<button type="button" class="btn btn--ghost btn--sm il-replay">↻ Показать анимацию</button>' +
      '<button type="button" class="btn btn--ghost btn--sm il-sound" aria-pressed="false">♪ Звук: выкл</button>' +
      '<button type="button" class="btn btn--ghost btn--sm il-eco" aria-pressed="false">⚡ Эко</button>' +
      "</div></div>" +
      '<div class="card lesson-card">' +
      '<div class="lesson-step-label"></div>' +
      '<div class="lesson-title"></div>' +
      '<div class="lesson-body"><div class="task-card__text lesson-text"></div></div>' +
      '<div class="il-hud"><div class="il-cap"></div>' +
      '<button type="button" class="il-skip" aria-label="Пропустить анимацию" title="Пропустить" hidden>⏭</button>' +
      '<svg class="il-svg" viewBox="0 0 400 300" role="img" aria-label="Лента времени"><g class="il-bands"></g><g class="il-fxg"></g></svg>' +
      "</div>" +
      '<div class="il-extra"></div>' +
      '<div class="lesson-nav">' +
      '<button type="button" class="btn btn--ghost il-back">← Назад</button>' +
      '<button type="button" class="btn btn--primary il-next">Дальше →</button>' +
      "</div></div>" +
      '<div class="il-finish"></div>' +
      "</div>";

    function $(s) { return el.querySelector(s); }
    function $all(s) { return Array.prototype.slice.call(el.querySelectorAll(s)); }
    var svg = $(".il-svg"), hud = $(".il-hud"), capBox = $(".il-cap"),
      extra = $(".il-extra"), skipBtn = $(".il-skip"), bandsG = $(".il-bands"), fxg = $(".il-fxg");

    /* ---------- confetti ---------- */
    var fx = document.createElement("canvas");
    fx.className = "il-fx";
    hud.appendChild(fx);
    var fctx = null;
    try { fctx = fx.getContext("2d"); } catch (e) {}
    var PS = [];
    function fxSize() {
      try {
        var r = hud.getBoundingClientRect(), k = Math.min(window.devicePixelRatio || 1, LITE ? 1 : 2);
        fx.width = Math.max(1, r.width * k); fx.height = Math.max(1, r.height * k);
      } catch (e) {}
    }
    function fxLoop() {
      if (!fctx || !PS.length) { fxRaf = 0; try { fctx && fctx.clearRect(0, 0, fx.width, fx.height); } catch (e) {} return; }
      var d = 1;
      try { d = fx.width / Math.max(1, hud.getBoundingClientRect().width); } catch (e) {}
      fctx.clearRect(0, 0, fx.width, fx.height);
      fctx.globalCompositeOperation = LITE ? "source-over" : "lighter";
      PS = PS.filter(function (p) { return p.l > 0; });
      for (var i = 0; i < PS.length; i++) {
        var p = PS[i];
        p.x += p.vx; p.y += p.vy; p.vx *= 0.985; p.vy = p.vy * 0.985 + 0.07; p.l -= 0.016;
        fctx.globalAlpha = Math.min(1, p.l);
        fctx.fillStyle = p.c;
        fctx.beginPath(); fctx.arc(p.x * d, p.y * d, Math.max(0.5, p.r * d * 3), 0, 7); fctx.fill();
      }
      fctx.globalAlpha = 1;
      fxRaf = requestAnimationFrame(fxLoop);
    }
    function burst(n) {
      if (RED || !fctx) return;
      n = LITE ? Math.ceil((n || 24) / 3) : (n || 24);
      var r = hud.getBoundingClientRect();
      var cols = ["#8c9bff", "#c3a8ff", "#34e0a1", "#ffd166", "#ffffff"];
      for (var i = 0; i < n; i++) {
        var a = Math.random() * 6.283, v = 2 + Math.random() * 5;
        PS.push({ x: r.width / 2, y: r.height / 2, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 1.5, r: 1.2 + Math.random() * 1.6, l: 0.8 + Math.random() * 0.6, c: cols[i % cols.length] });
      }
      if (!fxRaf) { fxSize(); fxRaf = requestAnimationFrame(fxLoop); }
    }
    function scrPt(x, y) {
      var r = svg.getBoundingClientRect();
      if (!r.width) return [0, 0];
      var k = Math.min(r.width / VB[2], r.height / VB[3]);
      return [r.left + r.width / 2 + (x - VB[0] - VB[2] / 2) * k, r.top + r.height / 2 + (y - VB[1] - VB[3] / 2) * k];
    }
    function burstAtSvg(x, y, n) {
      if (RED || !fctx) return;
      n = LITE ? Math.ceil((n || 24) / 3) : (n || 24);
      var pt = scrPt(x, y), hr = hud.getBoundingClientRect();
      var cols = ["#8c9bff", "#c3a8ff", "#34e0a1", "#ffd166", "#ffffff"];
      for (var i = 0; i < n; i++) {
        var a = Math.random() * 6.283, v = 2 + Math.random() * 5;
        PS.push({ x: pt[0] - hr.left, y: pt[1] - hr.top, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 1.5, r: 1.2 + Math.random() * 1.6, l: 0.8 + Math.random() * 0.6, c: cols[i % cols.length] });
      }
      if (!fxRaf) { fxSize(); fxRaf = requestAnimationFrame(fxLoop); }
    }

    /* ---------- лента ---------- */
    function camSet(b) { VB = b; svg.setAttribute("viewBox", b.join(" ")); }
    function flyTo(b, ms) {
      cancelAnimationFrame(camRaf);
      if (RED) { camSet(b); return Promise.resolve(); }
      ms = ms || 700;
      var a = VB.slice(), t0 = performance.now();
      return new Promise(function (res) {
        var k = function (n) {
          if (dead) { res(); return; }
          var p = Math.min(1, (n - t0) / ms);
          var e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
          camSet(a.map(function (v, i) { return v + (b[i] - v) * e; }));
          if (p < 1) camRaf = requestAnimationFrame(k); else res();
        };
        camRaf = requestAnimationFrame(k);
      });
    }
    function build() {
      var h = "";
      EI.forEach(function (se, k) {
        var s = se[0], e = se[1];
        var x0 = s ? (AX[s - 1] + AX[s]) / 2 : 10, x1 = e < 12 ? (AX[e] + AX[e + 1]) / 2 : 390;
        h += "<g class='il-band' data-k='" + k + "'><rect x='" + (x0 + 1) + "' y='161' width='" + (x1 - x0 - 2) + "' height='18' rx='9' fill='" + ER[k][3] + "'/>" +
          "<text x='" + ((x0 + x1) / 2) + "' y='132' text-anchor='middle' class='il-emo'>" + ER[k][0] + "</text></g>";
      });
      AN.forEach(function (a, i) {
        h += "<g class='il-dot' data-i='" + i + "'><circle cx='" + AX[i] + "' cy='170' r='13' class='il-hit'/>" +
          "<circle cx='" + AX[i] + "' cy='170' r='10' class='il-dc' style='stroke:" + ER[[0, 0, 1, 1, 2, 2, 3, 3, 3, 4, 4, 5, 5][i]][3] + "'/>" +
          "<text x='" + AX[i] + "' y='174.5' text-anchor='middle' class='il-em'>" + EM[i] + "</text>" +
          "<text x='" + AX[i] + "' y='" + (i % 2 ? 148 : 198) + "' text-anchor='middle' class='il-yr'>" + a[0] + "</text></g>";
      });
      h += "<text x='10' y='230' class='il-ax2'>← давно</text><text x='390' y='230' text-anchor='end' class='il-ax2'>сегодня →</text>";
      bandsG.innerHTML = h;
    }
    function cap(t) {
      if (!t) { capBox.classList.remove("on"); capBox.textContent = ""; return; }
      capBox.textContent = t;
      capBox.classList.add("on");
    }

    /* ---------- SCN (только по кнопке, без автоплея со звуком) ---------- */
    function playScene(i) {
      var my = ++tok;
      var alive = function () { return my === tok && !dead; };
      cine = true;
      hud.classList.add("cine");
      skipBtn.hidden = !!RED;
      cap("");
      function reset() {
        fxg.innerHTML = "";
        camSet([0, 0, 400, 300]);
        $all(".il-band,.il-dot").forEach(function (n) { n.style.opacity = ""; n.classList.remove("nudge"); });
        cap("");
      }
      reset();
      var job;
      if (i === 0) {
        job = (function () {
          $all(".il-band,.il-dot").forEach(function (n) { n.style.opacity = 0.3; });
          cap("Задача из ЕГЭ"); whoosh();
          return wait(1500).then(function () {
            if (!alive()) return;
            cap("Как расставить за секунду?");
            return wait(1600);
          });
        })();
      } else if (i === 1) {
        job = wait(300).then(function showNext() {
          if (!alive()) return;
          if (ERA >= 6) {
            $all(".il-era").forEach(function (r) { r.classList.remove("on"); });
            cap("Шесть глав — вся история");
            return flyTo([0, 0, 400, 300], 1000).then(function () { whoosh(); });
          }
          var k = ERA;
          var rows = $all(".il-era");
          rows.forEach(function (r, j) { r.classList.toggle("on", j === k); });
          cap(ER[k][1] + " — " + ER[k][2]);
          tone(330 + k * 70, 0.3, "triangle", 0.05);
          ERA++;
          return flyTo(eraBox(k), 700).then(function () { return wait(1100); }).then(showNext);
        });
      } else if (i === 2) {
        job = (function () {
          var ds = $all(".il-dot");
          cap("13 дат — каркас всей истории"); whoosh();
          var p = Promise.resolve();
          for (var d = 0; d < 13; d++) {
            (function (dd) {
              p = p.then(function () {
                if (!alive()) return;
                tone(380 + dd * 45, 0.15, "triangle", 0.04);
                burstAtSvg(AX[dd], 170, 10);
                return wait(RED ? 10 : 240);
              });
            })(d);
          }
          return p.then(function () {
            if (!alive()) return;
            cap("Нажми на любую картинку");
            var n = el.querySelector(".il-dot[data-i='3']");
            if (n) n.classList.add("nudge");
            return wait(900);
          });
        })();
      } else if (i === 4) {
        job = (function () {
          cap("Ставим по порядку"); whoosh();
          var p = Promise.resolve();
          for (var r = 0; r < 4; r++) {
            (function (rr) {
              p = p.then(function () {
                if (!alive()) return;
                var ev = EV4[ORD[rr]];
                var x = XY(ev[1]);
                fxg.insertAdjacentHTML("beforeend", "<line x1='" + x + "' y1='60' x2='" + x + "' y2='170' class='il-link'/><circle cx='" + x + "' cy='170' r='8' class='il-mk'/>");
                burstAtSvg(x, 170, 20);
                tone(520 + rr * 130, 0.3, "triangle", 0.05);
                cap((rr + 1) + ". " + ev[0] + " — " + ev[1]);
                return wait(1400);
              });
            })(r);
          }
          return p.then(function () {
            if (!alive()) return;
            cap("988 → 1380 → 1709 → 1861");
            return wait(1800);
          });
        })();
      } else {
        job = Promise.resolve();
      }
      return job.then(function () {
        if (!alive()) return;
        cine = false; hud.classList.remove("cine"); skipBtn.hidden = true;
        dr = (idx === 2);
        svg.setAttribute("class", "il-svg" + (dr ? " dr" : ""));
      }, function () {
        if (my !== tok) return;
        cine = false; hud.classList.remove("cine"); skipBtn.hidden = true;
      });
    }
    if (skipBtn) skipBtn.onclick = function () { tok++; cine = false; hud.classList.remove("cine"); skipBtn.hidden = true; cap(""); };

    /* ---------- квиз ---------- */
    function round() {
      var pk = [];
      var pool = POOL.slice().sort(function () { return Math.random() - 0.5; });
      for (var i = 0; i < pool.length && pk.length < (sc < 1 ? 3 : 4); i++) {
        var p = pool[i];
        var ok = pk.every(function (q) { return Math.abs(q.y - p.y) > (sc < 1 ? 120 : 20); });
        if (ok) pk.push(p);
      }
      ord = pk.slice().sort(function (a, b) { return a.y - b.y; });
      qidx = 0;
      fxg.innerHTML = "";
      var evs = extra.querySelector(".il-evs"), msg = extra.querySelector(".il-msg"),
        nx = extra.querySelector(".il-nx"), scEl = extra.querySelector(".il-sc");
      if (evs) {
        var list = pk.slice().sort(function () { return Math.random() - 0.5; });
        evs.innerHTML = list.map(function (pp) {
          return "<button type='button' class='il-ev' data-y='" + pp.y + "' data-e='" + pp.e + "'><i class='il-nb'></i>" +
            "<i class='il-chipE' style='background:" + ER[pp.e][3] + "'>" + ER[pp.e][0] + "</i><span>" + esc(pp.n) + "</span><em></em></button>";
        }).join("");
        evs.onclick = evClick;
      }
      if (msg) msg.textContent = "Нажимай события от самого раннего к самому позднему. Цветные значки — это главы.";
      if (nx) { nx.style.display = "none"; nx.onclick = round; }
      if (scEl) scEl.textContent = "Раундов решено: " + sc + " · ошибок: " + er;
    }
    function bet(y) {
      var i = -1;
      AN.forEach(function (a, k) { if (a[0] <= y) i = k; });
      if (i < 0) return "раньше всех якорей";
      if (i === 12) return "после 1991";
      return "между " + AN[i][0] + " («" + AN[i][1] + "») и " + AN[i + 1][0] + " («" + AN[i + 1][1] + "»)";
    }
    function evClick(e) {
      var b = e.target.closest(".il-ev");
      if (!b || b.dataset.d) return;
      var y = +b.dataset.y;
      var evs = extra.querySelector(".il-evs"), msg = extra.querySelector(".il-msg"),
        nx = extra.querySelector(".il-nx"), scEl = extra.querySelector(".il-sc");
      if (y === ord[qidx].y) {
        b.dataset.d = 1; b.classList.add("ok2");
        b.querySelector(".il-nb").textContent = qidx + 1;
        b.querySelector("em").textContent = y;
        qidx++;
        fxg.insertAdjacentHTML("beforeend", "<circle cx='" + XY(y) + "' cy='170' r='8' class='il-mk'/>");
        burstAtSvg(XY(y), 170, 18);
        tone(500 + qidx * 120, 0.25, "triangle", 0.05);
        if (qidx === ord.length) {
          sc++; chime(); burst(30);
          if (msg) msg.innerHTML = "<b>Идеально!</b> Так работает метод якорей.";
          if (nx) nx.style.display = "";
          if (scEl) scEl.textContent = "Раундов решено: " + sc + " · ошибок: " + er;
        }
      } else {
        b.classList.remove("bad2"); void b.offsetWidth; b.classList.add("bad2");
        er++; tone(170, 0.25, "sawtooth", 0.035);
        b.querySelector("em").textContent = y;
        if (msg) msg.innerHTML = "<b>" + y + " год</b> — глава «" + esc(ER[+b.dataset.e][1]) + "», " + esc(bet(y)) + ". Есть событие раньше?";
        if (scEl) scEl.textContent = "Раундов решено: " + sc + " · ошибок: " + er;
      }
    }

    /* ---------- контент шагов ---------- */
    function renderExtra(i) {
      if (i === 1) {
        needEras = true; ERA = 0;
        extra.innerHTML = "<p>Не десять веков, а шесть глав. Нажми на главу, и лента покажет её:</p>" +
          "<div class='il-rules'>" + ER.map(function (e2, k) {
            return "<div class='il-era' data-k='" + k + "' role='button' tabindex='0'><i class='il-em2' style='background:" + e2[3] + "'>" + e2[0] + "</i>" +
              "<span><b>" + esc(e2[1]) + "</b> <small>" + esc(e2[2]) + "</small></span></div>";
          }).join("") + "</div>" +
          "<p class='il-hint'>Нажимай «Дальше», и лента сама проведёт тебя по всем шести главам — или жми на главу вручную.</p>";
        var eras = extra.querySelectorAll(".il-era");
        Array.prototype.forEach.call(eras, function (r) {
          var act = function () {
            if (cine) return;
            var k = +r.dataset.k, on = r.classList.contains("on");
            Array.prototype.forEach.call(eras, function (q, j) { q.classList.toggle("on", !on && j === k); });
            flyTo(on ? [0, 0, 400, 300] : eraBox(k));
            tone(400 + k * 60, 0.2, "triangle", 0.04);
          };
          r.addEventListener("click", act, sig);
          r.addEventListener("keydown", function (ev) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); act(); } }, sig);
        });
      } else if (i === 2) {
        extra.innerHTML = "<div class='il-tip il-info'>Нажми на любую картинку на ленте, и узнаешь, что тогда случилось.</div>" +
          "<p><b>Якорь</b> — дата, которую ты знаешь точно. Остальные события привязываешь к ней, как лодку к якорю.</p>";
      } else if (i === 3) {
        extra.innerHTML = "<p class='il-sm il-sc'></p>" +
          "<p class='il-sm'>Порядок глав: " + ER.map(function (e2) { return e2[0]; }).join(" → ") + ". Сначала смотри на значок главы, потом на даты.</p>" +
          "<div class='il-evs'></div><p class='il-tip il-msg'></p>" +
          "<button type='button' class='btn btn--primary il-nx' style='display:none;width:100%'>Следующий раунд</button>";
        round();
      } else if (i === 4) {
        var rows = ["Находим якоря: 988, 1380 и 1861 — это известные даты.",
          "Полтава (1709) стоит между 1703 и 1812, значит между Куликовской битвой и отменой крепостного права.",
          "Ответ: Крещение Руси, Куликовская битва, Полтавская битва, отмена крепостного права."];
        extra.innerHTML = rows.map(function (t) {
          return "<div class='il-ok'><i>✓</i><p>" + esc(t) + "</p></div>";
        }).join("") + (sc ? "<p class='il-tip'>Раундов решено: <b>" + sc + "</b>, ошибок: " + er + ".</p>" : "");
      } else {
        extra.innerHTML = i === 0
          ? "<div class='il-task'>Расставь события по порядку — от самого раннего к самому позднему:<br>Крещение Руси · Куликовская битва · Полтавская битва · Отмена крепостного права</div>" +
            "<p>Обычно это пять минут зубрёжки. Покажу способ, после которого такая задача решается за секунду.</p>"
          : "";
      }
    }

    /* точки-якоря кликабельны только на шаге 2 */
    svg.addEventListener("click", function (e) {
      var g = e.target.closest(".il-dot");
      if (!g || !dr || cine) return;
      var i = +g.dataset.i, inf = extra.querySelector(".il-info");
      if (inf) inf.innerHTML = "<b>" + AN[i][0] + " — " + esc(AN[i][1]) + "</b><br><small>" + esc(ER[[0, 0, 1, 1, 2, 2, 3, 3, 3, 4, 4, 5, 5][i]][1]) + "</small>";
      $all(".il-dot.nudge").forEach(function (d) { d.classList.remove("nudge"); });
      burstAtSvg(AX[i], 170, 12);
      tone(420 + i * 50, 0.2, "triangle", 0.05);
    }, sig);
    /* пилюли эр вне SCN: клик по полосам */
    svg.addEventListener("click", function (e) {
      var b = e.target.closest(".il-band");
      if (!b || cine || idx !== 1) return;
      var k = +b.dataset.k;
      var rows = $all(".il-era"), on = rows[k] && rows[k].classList.contains("on");
      rows.forEach(function (q, j) { q.classList.toggle("on", !on && j === k); });
      flyTo(on ? [0, 0, 400, 300] : eraBox(k));
      tone(400 + k * 60, 0.2, "triangle", 0.04);
    }, sig);

    /* ---------- навигация ---------- */
    function paintProgress() {
      var bar = $(".il-progress .progress__fill");
      if (bar) bar.style.width = Math.round(((idx + 1) / N) * 100) + "%";
    }
    function paintFinish() {
      var box = $(".il-finish");
      if (!box) return;
      if (idx !== N - 1) { box.innerHTML = ""; return; }
      if (api.done) {
        box.innerHTML = '<div class="feedback feedback--ok"><div class="feedback__head">✓ Урок пройден</div></div>' +
          '<div class="il-finish__row"><button type="button" class="btn btn--primary btn--lg il-practice">Закрепить на практике</button></div>';
      } else {
        box.innerHTML = '<div class="il-finish__row">' +
          '<button type="button" class="btn btn--primary btn--lg il-done">✓ Я разобрался — завершить</button>' +
          '<button type="button" class="btn btn--ghost btn--lg il-practice">Закрепить на практике</button></div>';
      }
      var dn = box.querySelector(".il-done"), pr = box.querySelector(".il-practice");
      if (dn) dn.onclick = function () { try { api.finish(); } catch (e) {} };
      if (pr) pr.onclick = function () { try { api.practice(); } catch (e) {} };
    }
    function go(i) {
      tok++;
      cine = false;
      cancelAnimationFrame(camRaf);
      hud.classList.remove("cine");
      skipBtn.hidden = true;
      cap("");
      fxg.innerHTML = "";
      camSet([0, 0, 400, 300]);
      idx = Math.max(0, Math.min(N - 1, i));
      dr = (idx === 2);
      svg.setAttribute("class", "il-svg" + (dr ? " dr" : ""));
      var s = scene(idx);
      var lab = $(".lesson-step-label"), ttl = $(".lesson-title"), txt = $(".lesson-body .lesson-text");
      if (lab) lab.textContent = "Шаг " + (idx + 1) + " из " + N;
      if (ttl) ttl.textContent = s.title || DEV[Math.min(idx, 4)].t;
      if (txt) {
        try { txt.innerHTML = api.mathText ? api.mathText(s.text || "") : esc(s.text || ""); }
        catch (e) { txt.textContent = s.text || ""; }
      }
      renderExtra(idx);
      var back = $(".il-back"), next = $(".il-next");
      if (back) back.disabled = idx === 0;
      if (next) next.textContent = idx === N - 1 ? "Готово" : "Дальше →";
      paintProgress(); paintFinish();
      var rp = $(".il-replay");
      if (rp) rp.style.display = (CINE_STEPS[idx] && !RED) ? "" : "none";
      if (idx === N - 1 && !RED && !finalBurstDone) {
        finalBurstDone = true;
        later(function () { burst(40); chime(); }, 1200);
      }
    }

    var replay = $(".il-replay"), soundBtn = $(".il-sound"), ecoBtn = $(".il-eco");
    function paintToggles() {
      if (soundBtn) {
        soundBtn.textContent = muted ? "♪ Звук: выкл" : "♪ Звук: вкл";
        soundBtn.setAttribute("aria-pressed", String(!muted));
      }
      if (ecoBtn) {
        ecoBtn.classList.toggle("btn--primary", LITE);
        ecoBtn.classList.toggle("btn--ghost", !LITE);
        ecoBtn.setAttribute("aria-pressed", String(LITE));
      }
      var w = el.querySelector(".il-hist");
      if (w) w.classList.toggle("lite", LITE);
    }
    if (replay) replay.onclick = function () { if (!RED && CINE_STEPS[idx]) playScene(idx); };
    if (soundBtn) soundBtn.onclick = function () {
      muted = !muted;
      if (!muted) {
        try { AC = AC || new (window.AudioContext || window.webkitAudioContext)(); if (AC.state === "suspended") AC.resume(); } catch (e) {}
        tone(880, 0.1);
      }
      paintToggles();
    };
    if (ecoBtn) ecoBtn.onclick = function () { LITE = !LITE; paintToggles(); fxSize(); };
    var backB = $(".il-back"), nextB = $(".il-next");
    if (backB) backB.onclick = function () { if (idx > 0) go(idx - 1); };
    if (nextB) nextB.onclick = function () {
      if (idx === 1 && needEras && ERA < 6 && !cine && !RED) {
        /* Пошаговый обход эр кнопкой «Дальше» (как в демо): 6 нажатий — 6 глав. */
        var k = ERA;
        var rows = $all(".il-era");
        rows.forEach(function (r, j) { r.classList.toggle("on", j === k); });
        cap(ER[k][1] + " — " + ER[k][2]);
        tone(330 + k * 70, 0.3, "triangle", 0.05);
        ERA++;
        flyTo(eraBox(k), 700).then(function () {
          if (ERA === 6) {
            rows.forEach(function (r) { r.classList.remove("on"); });
            cap("Шесть глав — вся история");
            flyTo([0, 0, 400, 300], 1000);
          }
        });
        return;
      }
      if (idx < N - 1) go(idx + 1);
      else { try { api.done ? api.practice() : api.finish(); } catch (e) {} }
    };
    window.addEventListener("resize", fxSize, sig);

    build();
    paintToggles();
    go(0);

    return function () {
      dead = true;
      tok++;
      try { abort && abort.abort(); } catch (e) {}
      cancelAnimationFrame(camRaf); cancelAnimationFrame(fxRaf);
      timers.forEach(function (t) { clearTimeout(t); });
      try { if (AC && AC.state === "running") AC.suspend(); } catch (e) {}
      try { fx.remove(); } catch (e) {}
    };
  }

  window.ILessonModules = window.ILessonModules || {};
  window.ILessonModules["v-hist-01"] = { mount: mount };
})();
