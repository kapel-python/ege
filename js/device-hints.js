/* Подсказки устройства для сервера (точные модель и версия ОС).

   Проблема: современный Chrome УРЕЗАЕТ User-Agent — там всегда
   «Linux; Android 10; K» и «Windows NT 10.0», поэтому по одному UA сервер
   видит лишь «Android-смартфон» и не отличает Windows 10 от 11, а модель
   телефона (вплоть до «POCO F6 Pro») не видит вовсе. Точные значения живут
   в Client Hints: `navigator.userAgentData.getHighEntropyValues()` отдаёт
   model / platformVersion / platform / mobile безо всякого UA-парсинга.

   Модуль один раз читает их при загрузке вкладки и прикладывает к каждому
   same-origin `/api/`-запросу заголовками `X-Ege-*`. Сервер (`parse_client_hints`
   в server.py) чистит их так же строго, как стандартные `Sec-CH-UA-*`, и
   хранит только готовое название («POCO F6 Pro · Android 16»,
   «Windows 11 PC», «iPhone · iOS 17») — сырьё нигде не оседает.

   Своих запросов модуль не делает и ничего не показывает: если API
   недоступно (Safari, старый браузер) — заголовков просто нет, сервер
   работает по UA как раньше. */
(function () {
  "use strict";
  var HEADERS = null;

  function cleanToken(value, maxLen) {
    try {
      var s = String(value == null ? "" : value).trim().slice(0, maxLen || 64);
      if (s.length < 1) return "";
      if (/not[\s\/()]*a[\s\/()]*brand/i.test(s)) return "";
      if (!/[0-9A-Za-zА-Яа-яЁё]/.test(s)) return "";
      if (/[^0-9A-Za-zА-Яа-яЁё _\-+()./]/.test(s)) return "";
      var low = s.toLowerCase();
      if (low === "k" || low === "build" || low === "mobile"
          || low === "android" || low === "linux" || low === "unknown") return "";
      return s;
    } catch (_) { return ""; }
  }

  function cleanVersion(value) {
    try {
      var m = /^\s*(\d{1,3})(?:[._](\d{1,3}))?/.exec(String(value == null ? "" : value));
      if (!m) return "";
      var major = parseInt(m[1], 10);
      if (!(major >= 0 && major <= 99)) return "";
      return String(major);
    } catch (_) { return ""; }
  }

  function collect() {
    var done = function (h) { HEADERS = h; };
    try {
      var ud = null;
      try { ud = navigator.userAgentData || null; } catch (_) { ud = null; }
      if (ud && typeof ud.getHighEntropyValues === "function") {
        ud.getHighEntropyValues(["model", "platformVersion", "platform", "mobile"]).then(function (v) {
          var h = {};
          var model = cleanToken(v && v.model, 64);
          if (model) h["X-Ege-Device-Model"] = model;
          var ver = cleanVersion(v && v.platformVersion);
          if (ver) h["X-Ege-OS-Version"] = ver;
          var plat = cleanToken(v && v.platform, 32);
          if (plat) h["X-Ege-Platform"] = plat;
          try {
            if (typeof v.mobile === "boolean") h["X-Ege-Mobile"] = v.mobile ? "1" : "0";
          } catch (_) {}
          // iPad в десктопном режиме притворяется Macintosh: по UA его не
          // отличить от MacBook, а тачскрин выдаёт (десктопов с тачем почти нет).
          try {
            var ua = String((navigator && navigator.userAgent) || "");
            var touch = Number((navigator && navigator.maxTouchPoints) || 0);
            if (/Macintosh/.test(ua) && touch > 1 && !h["X-Ege-Platform"]) {
              h["X-Ege-Platform"] = "iPadOS";
            }
          } catch (_) {}
          done(h);
        }, function () { done({}); });
        return;
      }
    } catch (_) {}
    // Без userAgentData — только iPad-детект, остальное решает сервер по UA.
    try {
      var ua2 = String((navigator && navigator.userAgent) || "");
      var touch2 = Number((navigator && navigator.maxTouchPoints) || 0);
      if (/Macintosh/.test(ua2) && touch2 > 1) { done({ "X-Ege-Platform": "iPadOS" }); return; }
    } catch (_) {}
    done({});
  }

  function sameOriginApi(url) {
    try {
      var u = String(url == null ? "" : url);
      if (u.indexOf("/api/") === 0) return true;
      var loc = window.location;
      var abs = new URL(u, loc.origin);
      return abs.origin === loc.origin && abs.pathname.indexOf("/api/") === 0;
    } catch (_) { return false; }
  }

  function patchFetch() {
    try {
      if (window.__egeHintsFetchPatched || typeof window.fetch !== "function") return;
      window.__egeHintsFetchPatched = true;
      var origFetch = window.fetch.bind(window);
      window.fetch = function (input, init) {
        try {
          var url = typeof input === "string" ? input : (input && input.url) || "";
          if (HEADERS && sameOriginApi(url)) {
            var keys = Object.keys(HEADERS);
            if (keys.length) {
              init = init || {};
              var headers = new Headers(init.headers || (typeof input !== "string" && input && input.headers) || {});
              for (var i = 0; i < keys.length; i++) {
                if (!headers.has(keys[i])) headers.set(keys[i], HEADERS[keys[i]]);
              }
              init.headers = headers;
            }
          }
        } catch (_) {}
        return origFetch(input, init);
      };
    } catch (_) {}
  }

  try {
    collect();
    patchFetch();
  } catch (_) {}
})();
