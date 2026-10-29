/* v-trig-01 — интерактивный модуль урока тригонометрии (БЕТА).
 * Контракт: window.ILessonModules["v-trig-01"] = { mount(api) -> cleanup }.
 * Тексты шагов — из api.ilesson.scenes[i] (каталог); DEV ниже — только
 * fallback для разработки (смысл 1:1 со сценами каталога).
 * Суть демо сохранена: SVG-движок круга (drag/snap/inertia), чипы знаков,
 * слайдеры Пифагора, квиз, облегчённая wave-подложка, replayable SCN,
 * сдержанный confetti на успех, звук по умолчанию ВЫКЛ.
 * Удалено: landing hero, .ov-модалка, логотип, собственный тёмный неон-шит
 * (только var(--...) сайта), свои кнопки/прогресс (используются .btn,
 * .progress, структура .card.lesson-card урока).
 */
(function () {
  "use strict";

  var DEV = [
    { eb: "Задача из ЕГЭ", t: "Решим её за 5 минут",
      text: "sin α = 3/5, α во II четверти. Найди tg α.\nБез заучивания формул: нужны только круг и теорема Пифагора. В конце вернёмся к этой задаче и решим её вместе." },
    { eb: "Шаг 1 · Круг", t: "Потяни точку",
      text: "Точка идёт против часовой стрелки. x — сдвиг вправо или влево (это косинус), y — высота (это синус). Точка прилипает к 30°, 45°, 60°, 90°." },
    { eb: "Шаг 2 · Знаки", t: "Где плюс, а где минус",
      text: "sin смотрим по y: выше оси — плюс, ниже — минус. cos смотрим по x: правее оси — плюс, левее — минус. tg и ctg — это деление: одинаковые знаки дают плюс, разные — минус." },
    { eb: "Шаг 3 · Треугольник", t: "Радиус равен 1 — это гипотенуза",
      text: "Из точки на ось опускается перпендикуляр — получается прямоугольный треугольник. Гипотенуза — радиус, она всегда 1. Катеты — x и y. Тяни точку: второй катет пересчитывается сам: x² + y² = 1." },
    { eb: "Шаг 4 · Пифагор", t: "Любая сторона треугольника",
      text: "Квадрат катета плюс квадрат катета равно квадрату гипотенузы. Подвигай слайдеры и найди неизвестную сторону." },
    { eb: "Шаг 5 · Реши сам", t: "Задачи как на ЕГЭ",
      text: "Закрепи: задачи на знаки и треугольник — как на экзамене. Точка покажет, где лежит ответ." },
    { eb: "Финал", t: "Возвращаемся к задаче",
      text: "sin α = 3/5, α во II четверти. Найди tg α.\n1) Катет 3, гипотенуза 5. 2) Второй катет √(25 − 9) = 4; во II четверти cos отрицательный: cos = −4/5. 3) tg = sin ÷ cos = (3/5) ÷ (−4/5) = −3/4." }
  ];

  /* Видимость слоёв SVG и поведение по шагам (индексы = DEV/сцены каталога). */
  var VIS = [
    { vis: "d q", a: 143.13, cine: true },
    { vis: "d q v s", a: 40, drag: true, cine: true },
    { vis: "d q v s l", drag: true, lab: "s", cine: true },
    { vis: "d v s t l", drag: true, cine: true },
    { vis: "d v t", a: 36.87 },
    { vis: "d q w hp", quiz: true },
    { vis: "d q v t l s", a: 143.13, final: true }
  ];
  var CINE_STEPS = { 0: 1, 1: 1, 2: 1, 3: 1 };

  var QP = {
    1: "M170,170 L285,170 A115,115 0 0 0 170,55 Z",
    2: "M170,170 L170,55 A115,115 0 0 0 55,170 Z",
    3: "M170,170 L55,170 A115,115 0 0 0 170,285 Z",
    4: "M170,170 L170,285 A115,115 0 0 0 285,170 Z"
  };
  var RM = ["I", "II", "III", "IV"];
  var CH = [
    { t: "Поставь точку туда, где <b>cos минус</b>, а <b>sin плюс</b>.", q: 2 },
    { t: "Теперь туда, где <b>sin минус</b>, а <b>cos плюс</b>.", q: 4 },
    { t: "И туда, где <b>tg плюс</b>, а <b>sin минус</b>.", q: 3 }
  ];
  var PM = { c: { n: ["a", "b"], r: [[1, 4], [1, 4]], d: [3, 4] }, b: { n: ["c", "a"], r: [[4, 6], [1, 3.5]], d: [5, 3] } };

  function rad(d) { return d * Math.PI / 180; }
  function f(x) { return +Number(x).toFixed(2); }
  function sg(x) { return x >= 0 ? "+" : "−"; }

  function mount(api) {
    var el = api.el;
    var esc = api.esc || (function (s) { return String(s); });
    var RED = false;
    try { RED = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}
    var scenes = (api.ilesson && Array.isArray(api.ilesson.scenes)) ? api.ilesson.scenes : [];
    var N = scenes.length >= 7 ? scenes.length : 7;
    function scene(i) {
      var s = scenes[i];
      if (s && (s.title || s.text)) {
        return { title: s.title || DEV[Math.min(i, 6)].t, text: s.text || DEV[Math.min(i, 6)].text };
      }
      var d = DEV[Math.min(i, 6)];
      return { title: d.t, text: d.text };
    }

    /* ---------- состояние ---------- */
    var idx = 0, A = 40, cur = null;
    var twRaf = 0, inrRaf = 0, fxRaf = 0, camTok = 0;
    var timers = [];
    var abort = null;
    var ro = null;
    var AC = null, muted = true;
    var LITE = false;
    try {
      var cn = navigator.connection;
      LITE = ((navigator.hardwareConcurrency || 8) <= 4) ||
        ((navigator.deviceMemory || 8) <= 4) ||
        (cn && cn.saveData) ||
        window.matchMedia("(prefers-reduced-data: reduce)").matches;
    } catch (e) {}
    var sc = 0, tn = 0;          /* квиз */
    var ci = 0, okc = 0;         /* чипы знаков */
    var stk = 0;
    var solKey = "";
    var finalBurstDone = false;
    var dead = false;

    function later(fn, ms) {
      var id = setTimeout(function () {
        if (dead) return;
        fn();
      }, ms);
      timers.push(id);
      return id;
    }
    function wait(ms) {
      return new Promise(function (res) {
        later(function () { res(); }, ms);
      });
    }

    /* ---------- звук (по умолчанию ВЫКЛ, только после жеста) ---------- */
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

    /* ---------- каркас ---------- */
    el.innerHTML =
      '<div class="il-trig">' +
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
      '<div class="il-hud"><div class="il-bead"></div><div class="il-cap"></div>' +
      '<button type="button" class="il-recap" aria-label="Повторить анимацию" hidden>↻</button>' +
      '<svg class="il-svg" viewBox="0 0 340 340" role="img" aria-label="Единичная окружность">' +
      '<path class="il-wedge il-gw" d=""/>' +
      '<polygon class="il-tri il-gt" points=""/>' +
      '<circle class="il-ring" cx="170" cy="170" r="115"/>' +
      '<line class="il-ax" x1="30" y1="170" x2="310" y2="170"/>' +
      '<line class="il-ax" x1="170" y1="30" x2="170" y2="310"/>' +
      '<g class="il-gd"><text class="il-dl" x="316" y="170" text-anchor="middle">0°</text>' +
      '<text class="il-dl" x="170" y="22" text-anchor="middle">90°</text>' +
      '<text class="il-dl" x="24" y="170" text-anchor="middle">180°</text>' +
      '<text class="il-dl" x="170" y="318" text-anchor="middle">270°</text></g>' +
      '<g class="il-gq"><text x="220" y="120" text-anchor="middle">I</text>' +
      '<text x="120" y="120" text-anchor="middle">II</text>' +
      '<text x="120" y="226" text-anchor="middle">III</text>' +
      '<text x="220" y="226" text-anchor="middle">IV</text></g>' +
      '<line class="il-rad il-gv" x1="170" y1="170" x2="170" y2="170"/>' +
      '<line class="il-cosl il-gv" x1="170" y1="170" x2="170" y2="170"/>' +
      '<line class="il-sinl il-gv" x1="170" y1="170" x2="170" y2="170"/>' +
      '<text class="il-th il-gt">1</text><text class="il-tx il-gl"></text><text class="il-ty il-gl"></text>' +
      '<text class="il-ad">α</text>' +
      '<polyline class="il-trail" points=""/>' +
      '<circle class="il-halo" r="12" cx="170" cy="170"/><circle class="il-pt" r="9" cx="170" cy="170"/>' +
      '<circle class="il-hit" r="30" cx="170" cy="170"/>' +
      "</svg>" +
      '<canvas class="il-wave"></canvas>' +
      '<div class="il-quads"><i>I</i><i>II</i><i>III</i><i>IV</i></div>' +
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
    var svg = $(".il-svg"), hud = $(".il-hud"), bead = $(".il-bead"),
      capBox = $(".il-cap"), extra = $(".il-extra"), wave = $(".il-wave"),
      recapBtn = $(".il-recap");
    var wctx = null;
    try { wctx = wave.getContext("2d"); } catch (e) {}

    abort = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var sig = abort ? { signal: abort.signal } : undefined;

    /* ---------- confetti (сдержанный, только успех) ---------- */
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
      var d = fx.width / Math.max(1, hud.getBoundingClientRect().width);
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
      var cx = r.width / 2, cy = r.height / 2;
      var cols = ["#8c9bff", "#c3a8ff", "#34e0a1", "#ffffff"];
      for (var i = 0; i < n; i++) {
        var a = Math.random() * 6.283, v = 2 + Math.random() * 5;
        PS.push({ x: cx, y: cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 1.5, r: 1.2 + Math.random() * 1.6, l: 0.8 + Math.random() * 0.6, c: cols[i % cols.length] });
      }
      if (!fxRaf) { fxSize(); fxRaf = requestAnimationFrame(fxLoop); }
    }

    /* ---------- SVG-движок ---------- */
    function setAttrs(sel, o) {
      var n = el.querySelector(sel);
      if (!n) return;
      for (var k in o) { try { n.setAttribute(k, o[k]); } catch (e) {} }
    }
    var trail = [];
    var trailT = 0;
    function live() {
      if (cur && typeof cur.live === "function") {
        try { cur.live(A, Math.cos(rad(A)), Math.sin(rad(A))); } catch (e) {}
      }
    }
    function draw(a) {
      A = ((a % 360) + 360) % 360;
      var c = Math.cos(rad(A)), s = Math.sin(rad(A));
      var x = 170 + 115 * c, y = 170 - 115 * s;
      [[".il-pt", { cx: x, cy: y }], [".il-halo", { cx: x, cy: y }], [".il-hit", { cx: x, cy: y }],
       [".il-cosl", { x2: x }], [".il-sinl", { x1: x, x2: x, y2: y }],
       [".il-rad", { x2: x, y2: y }],
       [".il-tri", { points: "170,170 " + x + ",170 " + x + "," + y }],
       [".il-th", { x: (170 + x) / 2 + (c >= 0 ? -14 : 14), y: (170 + y) / 2 + (s >= 0 ? -10 : 14) }],
       [".il-tx", { x: (170 + x) / 2, y: s >= 0 ? 192 : 158 }],
       [".il-ty", { x: x + (c >= 0 ? 12 : -12), y: (170 + y) / 2 + 4 }]
      ].forEach(function (kv) { setAttrs(kv[0], kv[1]); });
      var tx = el.querySelector(".il-tx"), ty = el.querySelector(".il-ty"), ad = el.querySelector(".il-ad");
      var labS = cur && cur.lab === "s";
      if (tx) { tx.textContent = labS ? ("x " + sg(c)) : "x"; tx.setAttribute("class", "il-tx il-gl" + (labS ? (c >= 0 ? " pos" : " neg") : "")); }
      if (ty) { ty.textContent = labS ? ("y " + sg(s)) : "y"; ty.setAttribute("class", "il-ty il-gl" + (labS ? (s >= 0 ? " pos" : " neg") : "")); }
      if (ad) ad.textContent = "α = " + Math.round(A) + "°";
      var TR = el.querySelector(".il-trail");
      if (TR && !LITE) {
        trail.push(x.toFixed(1) + "," + y.toFixed(1));
        if (trail.length > 26) trail.shift();
        TR.setAttribute("points", trail.join(" "));
        clearTimeout(trailT);
        trailT = setTimeout(function () {
          if (trail.length > 1) { trail.shift(); TR.setAttribute("points", trail.join(" ")); }
        }, 50);
        timers.push(trailT);
      }
      /* bead */
      var on = svg.classList.contains("v") && !svg.classList.contains("hp");
      if (on) {
        bead.textContent = exact(s, c);
        bead.style.left = (x / 340 * 100) + "%";
        bead.style.top = (y / 340 * 100) + "%";
        bead.classList.add("on");
      } else bead.classList.remove("on");
      /* wave */
      drawWave();
      updateQuads();
      live();
    }
    function exact(s, c) {
      var n = Math.round(A);
      if (Math.abs(A - n) < 0.6) {
        var ref = n <= 90 ? n : n <= 180 ? 180 - n : n <= 270 ? n - 180 : 360 - n;
        var T = { 0: ["0", "1"], 30: ["1/2", "√3/2"], 45: ["√2/2", "√2/2"], 60: ["√3/2", "1/2"], 90: ["1", "0"] }[ref];
        if (T) return "sin " + (T[0] === "0" ? "0" : (n > 180 && n < 360 ? "−" : "") + T[0]) + " · cos " + (T[1] === "0" ? "0" : (n > 90 && n < 270 ? "−" : "") + T[1]);
      }
      return "sin " + f(s) + " · cos " + f(c);
    }
    function tweenTo(t, ms) {
      cancelAnimationFrame(twRaf);
      if (RED) { draw(t); return Promise.resolve(); }
      ms = ms || 900;
      var a0 = A, d = ((t - a0) % 360 + 360) % 360;
      if (d > 180) d -= 360;
      var t0 = performance.now();
      return new Promise(function (res) {
        var k = function (now) {
          if (dead) { res(); return; }
          var p = Math.min(1, (now - t0) / ms);
          draw(a0 + d * (1 - Math.pow(1 - p, 3)));
          if (p < 1) twRaf = requestAnimationFrame(k); else res();
        };
        twRaf = requestAnimationFrame(k);
      });
    }

    /* drag + snap + inertia */
    var dg = false, vel = 0, la = 0, lt = 0, lastSnap = -1;
    var hit = el.querySelector(".il-hit");
    function angFromEvent(e) {
      var r = svg.getBoundingClientRect();
      return (Math.atan2(-(e.clientY - r.top - r.height / 2), e.clientX - r.left - r.width / 2) * 180 / Math.PI + 360) % 360;
    }
    function onDown(e) {
      if (!cur || !cur.drag || cine) return;
      dg = true;
      try { hit.setPointerCapture(e.pointerId); } catch (err) {}
      cancelAnimationFrame(twRaf); cancelAnimationFrame(inrRaf);
      la = A; lt = performance.now(); vel = 0;
    }
    function onMove(e) {
      if (!dg || !cur || !cur.drag || cine) return;
      var a = angFromEvent(e);
      var m = a % 90, snap = false;
      for (var i = 0; i < [0, 30, 45, 60, 90].length; i++) {
        var t = [0, 30, 45, 60, 90][i];
        if (Math.abs(m - t) < 3) { a = a - m + t; snap = true; break; }
      }
      if (snap && Math.round(a) !== Math.round(A)) {
        try { navigator.vibrate && navigator.vibrate(6); } catch (err) {}
        tone(1000, 0.05, "triangle", 0.035);
      }
      draw(a);
      var n = performance.now(), d = A - la;
      if (d > 180) d -= 360; if (d < -180) d += 360;
      if (n > lt) vel = vel * 0.6 + (d / Math.max(8, n - lt) * 16) * 0.4;
      la = A; lt = n;
    }
    function onUp() {
      if (!dg) return;
      dg = false;
      if (RED || Math.abs(vel) < 0.8 || !cur || !cur.drag || cine) return;
      var run = function () {
        if (dead) return;
        vel *= 0.95; draw(A + vel);
        if (Math.abs(vel) > 0.12) { inrRaf = requestAnimationFrame(run); }
        else {
          var m = A % 90, b = A - m, done = false;
          for (var i = 0; i < [0, 30, 45, 60, 90].length; i++) {
            if (Math.abs(m - [0, 30, 45, 60, 90][i]) < 5) { tweenTo(b + [0, 30, 45, 60, 90][i], 350); done = true; break; }
          }
          if (!done) draw(A);
        }
      };
      inrRaf = requestAnimationFrame(run);
    }
    if (hit) {
      hit.addEventListener("pointerdown", onDown, sig);
      hit.addEventListener("pointermove", onMove, sig);
      hit.addEventListener("pointerup", onUp, sig);
      hit.addEventListener("pointercancel", function () { dg = false; }, sig);
    }

    /* ---------- wave (облегчённая) ---------- */
    var WW = 0, WH = 0, lq = -1;
    function drawWave() {
      if (!wctx) return;
      var on = svg.classList.contains("v") && !svg.classList.contains("hp") && !LITE;
      wave.classList.toggle("on", !!on);
      if (!on) return;
      var r = wave.getBoundingClientRect();
      if (r.width < 2) return;
      if (wave.width !== Math.round(r.width) || !WW) {
        try {
          var k = Math.min(window.devicePixelRatio || 1, 2);
          wave.width = Math.round(r.width * k); wave.height = Math.round(r.height * k);
          wctx.setTransform(k, 0, 0, k, 0, 0);
        } catch (e) {}
      }
      WW = r.width; WH = r.height;
      var m = WH / 2, am = WH / 2 - 8;
      wctx.clearRect(0, 0, WW, WH);
      wctx.strokeStyle = "rgba(128,140,180,.5)"; wctx.lineWidth = 1;
      wctx.beginPath(); wctx.moveTo(0, m); wctx.lineTo(WW, m); wctx.stroke();
      [["cos", "#6d7cff"], ["sin", "#9a7bff"]].forEach(function (fn) {
        wctx.strokeStyle = fn[1]; wctx.lineWidth = 2; wctx.beginPath();
        for (var x = 0; x <= A / 360 * WW; x += 3) {
          var y = m - am * (fn[0] === "cos" ? Math.cos(rad(x / WW * 360)) : Math.sin(rad(x / WW * 360)));
          if (x) wctx.lineTo(x, y); else wctx.moveTo(x, y);
        }
        wctx.stroke();
      });
      var X = A / 360 * WW;
      wctx.strokeStyle = "rgba(128,140,180,.6)";
      wctx.beginPath(); wctx.moveTo(X, 0); wctx.lineTo(X, WH); wctx.stroke();
      var q = Math.floor(A / 90) % 4;
      if (q !== lq) {
        lq = q;
        $all(".il-quads i").forEach(function (n, k) { n.classList.toggle("on", k === q); });
      }
    }
    function updateQuads() { /* метки обновляются в drawWave */ }
    try {
      if (typeof ResizeObserver !== "undefined") {
        ro = new ResizeObserver(function () { drawWave(); fxSize(); });
        ro.observe(wave); ro.observe(hud);
      }
    } catch (e) {}
    window.addEventListener("resize", function () { fxSize(); drawWave(); }, sig);

    /* ---------- подписи SCN ---------- */
    var cine = false;
    function cap(t) {
      if (!t) { capBox.classList.remove("on"); capBox.textContent = ""; return; }
      capBox.textContent = t;
      capBox.classList.add("on");
    }

    /* Упрощённый кинематографический автоплей: только по кнопке. */
    function playScene(i) {
      var my = ++camTok;
      var alive = function () { return my === camTok && !dead; };
      cine = true;
      svg.classList.add("cine");
      recapBtn.hidden = true;
      cap("");
      cancelAnimationFrame(twRaf); cancelAnimationFrame(inrRaf);
      function ang(to, ms) {
        ms = ms || 900;
        var a0 = A, d = ((to - a0) % 360 + 360) % 360;
        if (d > 180) d -= 360;
        var t0 = performance.now();
        return new Promise(function (res, rej) {
          var k = function (now) {
            if (!alive()) { rej(new Error("dead")); return; }
            var p = Math.min(1, (now - t0) / ms);
            var e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
            draw(a0 + d * e);
            if (p < 1) requestAnimationFrame(k); else res();
          };
          requestAnimationFrame(k);
        });
      }
      function seq(steps) {
        var p = Promise.resolve();
        steps.forEach(function (s) {
          p = p.then(function () {
            if (!alive()) throw new Error("dead");
            if (typeof s === "string") { cap(s); return wait(1400); }
            return s();
          });
        });
        return p;
      }
      var job;
      if (i === 0) {
        job = seq(["Задача из ЕГЭ", function () { draw(0); return wait(500); },
          function () { return ang(143.13, 1800); }, "Сейчас это кажется сложным"]);
      } else if (i === 1) {
        var qs = ["Точка идёт по кругу", "x — вправо и влево", "y — вверх и вниз"];
        job = ang(0, 700).then(function () {
          return new Promise(function (res, rej) {
            var t0 = performance.now(), D = RED ? 10 : 4200, k2 = 0;
            var k = function (now) {
              if (!alive()) { rej(new Error("dead")); return; }
              var p = Math.min(1, (now - t0) / D);
              draw(360 * p);
              var qi = Math.floor(360 * p / 90);
              if (qi > k2) { k2 = qi; tone(500 + k2 * 120, 0.2, "triangle", 0.04); }
              if (k2 < 3 && p > [0.2, 0.5, 0.75][k2]) cap(qs[k2]);
              if (p < 1) requestAnimationFrame(k); else { ang(40, 900).then(res, rej); }
            };
            requestAnimationFrame(k);
          });
        }).then(function () { cap("Теперь твоя очередь: потяни точку"); return wait(1400); });
      } else if (i === 2) {
        var names = ["I четверть: всё плюс", "II четверть: плюс только у sin", "III четверть: плюс у tg и ctg", "IV четверть: плюс только у cos"];
        job = Promise.resolve();
        for (var q = 0; q < 4; q++) {
          (function (qq) {
            job = job.then(function () {
              if (!alive()) throw new Error("dead");
              setAttrs(".il-wedge", { d: QP[qq + 1] });
              svg.classList.add("w");
              return ang(45 + 90 * qq, 900).then(function () {
                cap(names[qq]); tone(520 + qq * 110, 0.3, "triangle", 0.05);
                return wait(1700);
              });
            });
          })(q);
        }
        job = job.then(function () { return ang(40, 900); });
      } else if (i === 3) {
        job = ang(36.87, 1100)
          .then(function () { cap("Из точки — перпендикуляр"); return wait(1000); })
          .then(function () { cap("Получился прямоугольный треугольник"); return wait(1400); })
          .then(function () { cap("x² + y² = 1"); tone(520, 0.3, "triangle", 0.05); burst(24); return wait(1800); })
          .then(function () { cap("Тяни точку: квадраты считаются сами"); return wait(1200); });
      } else {
        job = Promise.resolve();
      }
      return job.then(function () {
        if (!alive()) return;
        cine = false; svg.classList.remove("cine");
        cap(""); draw(A);
        recapBtn.hidden = !CINE_STEPS[curIdx()];
      }, function () {
        if (my !== camTok) return;
        cine = false; svg.classList.remove("cine"); cap(""); draw(A);
      });
    }

    /* ---------- контент шагов ---------- */
    function chipsH(c, s) {
      return [["sin", s], ["cos", c], ["tg", Math.abs(c) < 0.02 ? null : s / c], ["ctg", Math.abs(s) < 0.02 ? null : c / s]]
        .map(function (kv) {
          var n = kv[0], v = kv[1];
          var cls = v === null || Math.abs(v) < 0.02 ? "" : v > 0 ? "p" : "m";
          var val = v === null ? "—" : Math.abs(v) < 0.02 ? "0" : sg(v);
          return '<span class="' + cls + '">' + n + " " + val + "</span>";
        }).join("");
    }
    function tri(a, b, T) {
      var k = 34, P = [30, 236], B = [30 + a * k, 236], C = [30, 236 - b * k];
      return '<svg class="il-cv" viewBox="-30 0 330 260"><polygon points="' + P + " " + B + " " + C + '" class="il-tri2"/>' +
        '<line x1="30" y1="236" x2="' + B[0] + '" y2="236" class="il-cosl2"/>' +
        '<line x1="30" y1="236" x2="30" y2="' + C[1] + '" class="il-sinl2"/>' +
        '<text x="' + ((P[0] + B[0]) / 2) + '" y="256" text-anchor="middle">' + T.a + "</text>" +
        '<text x="22" y="' + ((C[1] + 236) / 2 + 4) + '" text-anchor="end">' + T.b + "</text>" +
        '<text x="' + ((B[0] + C[0]) / 2 + 12) + '" y="' + ((B[1] + C[1]) / 2 - 6) + '">' + T.c + "</text></svg>";
    }
    var pmode = "c";

    function nt() {
      var T = [[3, 4, 5], [5, 12, 13], [8, 15, 17], [7, 24, 25]][Math.floor(Math.random() * 4)];
      var qq = 1 + Math.floor(Math.random() * 4), sS = qq < 3 ? 1 : -1, sC = (qq === 1 || qq === 4) ? 1 : -1;
      var fl = Math.random() < 0.5, y = fl ? T[0] : T[1], x = fl ? T[1] : T[0], h = T[2];
      var S = sS * y, C = sC * x, kind = ["cos", "sin", "tg", "sg"][Math.floor(Math.random() * 4)];
      var fr = function (p, d) { return (p < 0 ? "−" : "") + Math.abs(p) + "/" + d; };
      var rq = RM[qq - 1] + " четверти", qs, ok, op, ex;
      if (kind === "sg") {
        var fn = ["sin", "cos", "tg", "ctg"][Math.floor(Math.random() * 4)];
        var v = fn === "sin" ? S : fn === "cos" ? C : S * C;
        qs = "α в " + rq + ". Какой знак у " + fn + " α?";
        ok = v > 0 ? "плюс" : "минус"; op = ["плюс", "минус"];
        ex = [(fn === "sin" ? "sin — это y: точка " + (S > 0 ? "выше" : "ниже") + " оси." : fn === "cos" ? "cos — это x: точка " + (C > 0 ? "правее" : "левее") + " оси." : fn + " — это деление: sin " + (S >= 0 ? "плюс" : "минус") + ", cos " + (C >= 0 ? "плюс" : "минус") + ".")];
      } else {
        var ga = kind === "sin" ? x : y, oa = kind === "sin" ? y : x;
        if (kind === "tg") {
          var n = S * C > 0 ? 1 : -1;
          ok = fr(n * y, x); op = [ok, fr(-n * y, x), fr(n * x, y), fr(-n * x, y)];
          qs = "sin α = " + fr(S, h) + ", α в " + rq + ". Чему равен tg α?";
        } else {
          var Nn = kind === "cos" ? C : S, G = kind === "cos" ? S : C;
          ok = fr(Nn, h); op = [ok, fr(-Nn, h), fr(Math.abs(G), h), fr(-Math.abs(G), h)];
          qs = (kind === "cos" ? "sin" : "cos") + " α = " + fr(G, h) + ", α в " + rq + ". Чему равен " + kind + " α?";
        }
        ex = ["Рисуем треугольник: гипотенуза " + h + ", катет " + ga + ". Второй катет: √(" + (h * h) + " − " + (ga * ga) + ") = " + oa + ".",
          kind === "cos" ? "В " + rq + " точка " + (C > 0 ? "правее" : "левее") + " оси." : kind === "sin" ? "В " + rq + " точка " + (S > 0 ? "выше" : "ниже") + " оси." : "Деление знаков: " + sg(S) + " ÷ " + sg(C) + " = " + sg(S * C) + "."];
      }
      if (op.length > 3) op.sort(function () { return Math.random() - 0.5; });
      var doneQ = false;
      svg.classList.add("w");
      setAttrs(".il-wedge", { d: QP[qq] });
      var scEl = extra.querySelector(".il-sc"), qt = extra.querySelector(".il-qt"),
        opBox = extra.querySelector(".il-op"), exBox = extra.querySelector(".il-ex");
      if (scEl) scEl.textContent = "Верно: " + sc + " из " + tn;
      if (qt) qt.innerHTML = "<b>" + esc(qs) + "</b>";
      if (exBox) exBox.innerHTML = "";
      if (opBox) {
        opBox.innerHTML = op.map(function (o) { return '<button type="button" class="btn btn--ghost btn--sm" data-o="' + esc(o) + '">' + esc(o) + "</button>"; }).join("");
        opBox.onclick = function (e) {
          var b = e.target.closest("[data-o]");
          if (!b || doneQ) return;
          doneQ = true; tn++;
          var r = b.dataset.o === ok;
          if (r) { sc++; burst(28); chime(); try { navigator.vibrate && navigator.vibrate([10, 40, 10]); } catch (err) {} }
          else { tone(170, 0.25, "sawtooth", 0.035); stk = 0; }
          if (r) stk++; else stk = 0;
          Array.prototype.forEach.call(opBox.querySelectorAll("[data-o]"), function (c2) {
            if (c2.dataset.o === ok) c2.classList.add("il-good");
            else if (c2 === b) c2.classList.add("il-bad");
            c2.disabled = true;
          });
          if (scEl) scEl.textContent = "Верно: " + sc + " из " + tn + (stk > 1 ? " · серия " + stk : "");
          tweenTo(Math.atan2(S, C) * 180 / Math.PI);
          if (exBox) {
            exBox.innerHTML = '<p class="il-tip"><b>' + (r ? "Верно!" : "Не совсем.") + "</b> Точка показывает, где лежит ответ.</p>" +
              ex.map(function (t) { return '<p class="il-sol">' + esc(t) + "</p>"; }).join("") +
              '<button type="button" class="btn btn--primary btn--sm il-nx">Следующая задача</button>';
            var nx = exBox.querySelector(".il-nx");
            if (nx) nx.onclick = nt;
          }
        };
      }
    }

    function renderExtra(i) {
      var c = Math.cos(rad(A)), s = Math.sin(rad(A));
      if (i === 1) {
        extra.innerHTML = '<div class="il-res"><div><b class="il-r1">' + RM[Math.floor(A / 90)] + '</b><span>четверть</span></div>' +
          '<div><b class="il-r2">' + f(c) + '</b><span>x = cos</span></div>' +
          '<div><b class="il-r3">' + f(s) + '</b><span>y = sin</span></div></div>';
        cur.live = function (a, cc, ss) {
          var r1 = extra.querySelector(".il-r1"), r2 = extra.querySelector(".il-r2"), r3 = extra.querySelector(".il-r3");
          if (r1) r1.textContent = RM[Math.floor(a / 90)];
          if (r2) r2.textContent = f(cc);
          if (r3) r3.textContent = f(ss);
        };
      } else if (i === 2) {
        ci = 0; okc = 0; solKey = "";
        extra.innerHTML = '<div class="il-rules"><div class="il-rl"><i>sin</i><span>смотрим на <b>y</b>: выше оси плюс, ниже минус</span></div>' +
          '<div class="il-rl"><i>cos</i><span>смотрим на <b>x</b>: правее оси плюс, левее минус</span></div>' +
          '<div class="il-rl"><i>tg, ctg</i><span>это деление: одинаковые знаки дают плюс, разные минус</span></div></div>' +
          '<div class="il-sgn"></div><p class="il-tip il-ch"></p>';
        var showCh = function () {
          var ch = extra.querySelector(".il-ch");
          if (ch) ch.innerHTML = ci < 3 ? "<b>Задание " + (ci + 1) + " из 3.</b> " + CH[ci].t : "<b>✓ Все знаки у тебя в руках.</b>";
        };
        showCh();
        cur.live = function (a, cc, ss) {
          var box = extra.querySelector(".il-sgn");
          if (box) box.innerHTML = chipsH(cc, ss);
          if (ci < 3 && !okc && Math.abs(cc) > 0.05 && Math.abs(ss) > 0.05 && Math.floor(a / 90) + 1 === CH[ci].q) {
            okc = 1; burst(20); tone(880, 0.15, "triangle", 0.04);
            var ch = extra.querySelector(".il-ch");
            if (ch) ch.innerHTML = "<b>✓ Верно!</b>";
            later(function () { ci++; okc = 0; showCh(); }, 1100);
          }
        };
      } else if (i === 3) {
        extra.innerHTML = '<div class="il-solbox"></div>';
        cur.live = function (a, cc, ss) {
          var s2 = ss * ss, key = f(ss) + "|" + f(cc);
          if (key === solKey) return;
          solKey = key;
          var box = extra.querySelector(".il-solbox");
          if (!box) return;
          box.innerHTML = ["y = " + f(ss) + ", значит y² = " + f(s2),
            "x² = 1 − " + f(s2) + " = " + f(1 - s2),
            "|x| = √" + f(1 - s2) + " = " + f(Math.abs(cc)) + ". Знак по четверти: x " + sg(cc),
            Math.abs(cc) < 0.02 ? "tg: делить на 0 нельзя" : "tg = y ÷ x = " + f(ss) + " ÷ " + f(cc) + " = " + f(ss / cc)
          ].map(function (t) { return '<p class="il-sol">' + esc(t) + "</p>"; }).join("");
        };
      } else if (i === 4) {
        extra.innerHTML = '<p class="il-tip">Квадрат катета + квадрат катета = квадрат гипотенузы.</p>' +
          '<div class="il-md"><button type="button" class="btn btn--ghost btn--sm" data-m="c">Найти c</button>' +
          '<button type="button" class="btn btn--ghost btn--sm" data-m="b">Найти катет</button></div>' +
          '<div class="il-sl"><label class="il-l1"></label><input type="range" class="il-s1"></div>' +
          '<div class="il-sl"><label class="il-l2"></label><input type="range" class="il-s2"></div>' +
          '<div class="il-tribox"></div><div class="il-solbox2"></div>';
        var upd = function () {
          var s1 = extra.querySelector(".il-s1"), s2 = extra.querySelector(".il-s2");
          if (!s1 || !s2) return;
          var v1 = +s1.value, v2 = +s2.value, a, b, cc2, L;
          if (pmode === "c") {
            a = v1; b = v2; cc2 = Math.hypot(a, b);
            L = ["c² = " + f(a) + "² + " + f(b) + "² = " + f(cc2 * cc2), "c = √" + f(cc2 * cc2) + " = " + f(cc2)];
          } else {
            cc2 = v1; a = v2; b = Math.sqrt(Math.max(0, cc2 * cc2 - a * a));
            L = ["b² = " + f(cc2) + "² − " + f(a) + "² = " + f(b * b), "b = √" + f(b * b) + " = " + f(b)];
          }
          var triBox = extra.querySelector(".il-tribox"), sol2 = extra.querySelector(".il-solbox2");
          if (triBox) triBox.innerHTML = tri(a, b, { a: "a = " + f(a), b: "b = " + (pmode === "b" ? "?" : f(b)), c: "c = " + (pmode === "c" ? "?" : f(cc2)) });
          if (sol2) sol2.innerHTML = L.map(function (t) { return '<p class="il-sol">' + esc(t) + "</p>"; }).join("");
          var l1 = extra.querySelector(".il-l1"), l2 = extra.querySelector(".il-l2");
          if (l1) l1.innerHTML = esc(PM[pmode].n[0]) + " = <b>" + f(v1) + "</b>";
          if (l2) l2.innerHTML = esc(PM[pmode].n[1]) + " = <b>" + f(v2) + "</b>";
        };
        var setM = function (m) {
          pmode = m;
          var d = PM[m];
          Array.prototype.forEach.call(extra.querySelectorAll(".il-md .btn"), function (bb) {
            var on = bb.dataset.m === m;
            bb.classList.toggle("btn--primary", on);
            bb.classList.toggle("btn--ghost", !on);
          });
          [[".il-s1", d.r[0], d.d[0]], [".il-s2", d.r[1], d.d[1]]].forEach(function (q) {
            var n = extra.querySelector(q[0]);
            if (n) { n.min = q[1][0]; n.max = q[1][1]; n.step = 0.5; n.value = q[2]; }
          });
          upd();
        };
        var md = extra.querySelector(".il-md");
        if (md) md.onclick = function (e) {
          var b = e.target.closest("[data-m]");
          if (b) { setM(b.dataset.m); tone(700, 0.08, "triangle", 0.03); }
        };
        var s1 = extra.querySelector(".il-s1"), s2 = extra.querySelector(".il-s2");
        if (s1) s1.oninput = upd;
        if (s2) s2.oninput = upd;
        setM(pmode);
        cur.live = null;
      } else if (i === 5) {
        extra.innerHTML = '<p class="il-sm il-sc"></p><p class="il-qt"></p><div class="il-op"></div><div class="il-ex"></div>';
        nt();
        cur.live = null;
      } else if (i === 6) {
        var rows = ["sin = 3/5: катет 3, гипотенуза 5.",
          "Второй катет: √(25 − 9) = 4. Во II четверти cos минус, значит cos = −4/5.",
          "tg = sin ÷ cos = (3/5) ÷ (−4/5) = −3/4."];
        extra.innerHTML = rows.map(function (t) {
          return '<div class="il-ok"><i>✓</i><p>' + esc(t) + "</p></div>";
        }).join("") + (tn ? '<p class="il-tip">Задач решено верно: <b>' + sc + "</b> из " + tn + ".</p>" : "");
        cur.live = null;
      } else {
        extra.innerHTML = "";
        cur.live = null;
      }
    }

    /* ---------- навигация ---------- */
    function curIdx() { return idx; }
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
      camTok++;
      cine = false;
      cancelAnimationFrame(twRaf); cancelAnimationFrame(inrRaf);
      cap("");
      idx = Math.max(0, Math.min(N - 1, i));
      var cfg = VIS[Math.min(idx, VIS.length - 1)] || { vis: "d q v" };
      cur = { drag: !!cfg.drag, lab: cfg.lab || null, live: null };
      svg.setAttribute("class", "il-svg " + cfg.vis + (cur.drag ? " dr" : ""));
      svg.classList.remove("cine");
      var s = scene(idx);
      var lab = $(".lesson-step-label"), ttl = $(".lesson-title"), txt = $(".lesson-body .lesson-text");
      if (lab) lab.textContent = "Шаг " + (idx + 1) + " из " + N;
      if (ttl) ttl.textContent = s.title || DEV[Math.min(idx, 6)].t;
      if (txt) {
        try { txt.innerHTML = api.mathText ? api.mathText(s.text || "") : esc(s.text || ""); }
        catch (e) { txt.textContent = s.text || ""; }
      }
      renderExtra(idx);
      var back = $(".il-back"), next = $(".il-next");
      if (back) back.disabled = idx === 0;
      if (next) next.textContent = idx === N - 1 ? "Готово" : "Дальше →";
      paintProgress(); paintFinish();
      recapBtn.hidden = !CINE_STEPS[idx] || RED;
      if (!RED && (idx === 0 || idx === 6)) svg.classList.add("intro");
      if (cfg.a != null) tweenTo(cfg.a); else draw(A);
      if (idx === N - 1 && !RED && !finalBurstDone) {
        finalBurstDone = true;
        later(function () { burst(40); chime(); }, 1200);
      }
      var body = el.querySelector(".lesson-card");
      if (body && body.scrollIntoView) { try { body.scrollIntoView({ block: "nearest" }); } catch (e) {} }
    }

    /* ---------- тулбар ---------- */
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
      el.querySelector(".il-trig").classList.toggle("lite", LITE);
    }
    if (replay) replay.onclick = function () {
      if (RED || !CINE_STEPS[idx]) return;
      playScene(idx);
    };
    if (recapBtn) recapBtn.onclick = function () {
      if (RED || !CINE_STEPS[idx]) return;
      playScene(idx);
    };
    if (soundBtn) soundBtn.onclick = function () {
      muted = !muted;
      if (!muted) {
        try { AC = AC || new (window.AudioContext || window.webkitAudioContext)(); if (AC.state === "suspended") AC.resume(); } catch (e) {}
        tone(880, 0.1);
      }
      paintToggles();
    };
    if (ecoBtn) ecoBtn.onclick = function () { LITE = !LITE; paintToggles(); draw(A); };
    var backB = $(".il-back"), nextB = $(".il-next");
    if (backB) backB.onclick = function () { if (idx > 0) go(idx - 1); };
    if (nextB) nextB.onclick = function () {
      if (idx < N - 1) go(idx + 1);
      else { try { api.done ? api.practice() : api.finish(); } catch (e) {} }
    };
    paintToggles();
    go(0);

    /* ---------- cleanup ---------- */
    return function () {
      dead = true;
      camTok++;
      try { abort && abort.abort(); } catch (e) {}
      cancelAnimationFrame(twRaf); cancelAnimationFrame(inrRaf); cancelAnimationFrame(fxRaf);
      timers.forEach(function (t) { clearTimeout(t); });
      try { ro && ro.disconnect(); } catch (e) {}
      try { if (AC && AC.state === "running") AC.suspend(); } catch (e) {}
      try { fx.remove(); } catch (e) {}
    };
  }

  window.ILessonModules = window.ILessonModules || {};
  window.ILessonModules["v-trig-01"] = { mount: mount };
})();
