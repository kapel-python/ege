/* Единая модалка лимита ИИ-проверок.
   Реальные js/data.js + js/state.js + js/ai-limit.js + js/app.js в браузерной VM.

   Проверяется ровно то, что требует задача:
   1. Сочинения определяются данными каталога (long_text-задания), а не
      захардкоженным id — любой предмет с сочинением подхватывается сам.
   2. Окно темы на «Пути» открывается ВСЕГДА, без сверки с лимитом: гейта
      нет, лимит проверяет только сервер при отправке. Даже при remaining=0,
      гостю и в офлайне открывается обычное окно темы, а не модалка.
   3. Исчерпанный продуктовый лимит (429 AI_LIMIT внутри практики) — единое
      .dlg-окно (та же система, что у устройств профиля и модалок
      перепроверки на ege-result.html) с живым таймером ЧЧ:ММ:СС и
      остатком «0 из 5». Отдельных inline-блоков нет.
   4. Голый 429 burst-бакета — то же окно в режиме «Слишком частые запросы»
      с коротким отсчётом retryAfter; по нулю окно гаснет само.
   5. Таймер продуктового окна дотикал до нуля → перезапрос → проверка
      вернулась → окно закрывается (черновик цел, отправка повторяется
      кнопкой); иначе окно перезапускается с новым таймером.
   6. Успешная проверка локально уменьшает кэш остатка.
*/
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const catalog = JSON.parse(read("server/catalog_russian.json"));

let failures = 0;
const check = (name, condition, detail = "") => {
  if (!condition) failures += 1;
  console.log(`${condition ? "ok  " : "FAIL"} ${name}${detail ? ` | ${detail}` : ""}`);
};

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = String(tagName).toUpperCase();
    this._innerHTML = "";
    this.children = [];
    this.attributes = {};
    this._qs = {};
    const classes = new Set();
    this.classList = {
      add: (...n) => n.forEach((x) => classes.add(x)),
      remove: (...n) => n.forEach((x) => classes.delete(x)),
      contains: (n) => classes.has(n),
    };
  }
  set innerHTML(v) { this._innerHTML = String(v); }
  get innerHTML() { return this._innerHTML; }
  set id(v) { this.attributes.id = String(v); }
  get id() { return this.attributes.id || ""; }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  setAttribute(n, v) { this.attributes[n] = String(v); }
  getAttribute(n) { return this.attributes[n] ?? null; }
  addEventListener() {}
  removeEventListener() {}
  querySelector(sel) { return this._qs[sel] || null; }
  querySelectorAll() { return []; }
  focus() {}
}

const elements = new Map();
const element = (id) => {
  if (!elements.has(id)) elements.set(id, new FakeElement());
  return elements.get(id);
};
const document = {
  readyState: "loading",
  title: "",
  hidden: false,
  activeElement: null,
  documentElement: new FakeElement("html"),
  head: new FakeElement("head"),
  body: new FakeElement("body"),
  createElement: (tag) => new FakeElement(tag),
  getElementById: (id) => element(id),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  removeEventListener: () => {},
};
const memoryStorage = () => {
  const values = new Map();
  return {
    getItem: (k) => (values.has(k) ? values.get(k) : null),
    setItem: (k, v) => values.set(k, String(v)),
    removeItem: (k) => values.delete(k),
  };
};
const noop = () => {};

/* Управляемый ответ /api/ai/limits: limitResponse=null имитирует офлайн. */
let limitResponse = { ok: true, limit: 5, remaining: 5, resetInSec: null, windowSec: 28800 };
const limitCalls = [];
const intervals = [];

const sandbox = {
  console: { log: noop, info: noop, warn: noop, error: noop },
  setTimeout: () => 0,
  clearTimeout: noop,
  setInterval: (fn) => { intervals.push(fn); return intervals.length; },
  clearInterval: noop,
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: noop,
  document,
  location: { hash: "#/path", href: "http://localhost/", origin: "http://localhost" },
  history: { replaceState: noop },
  localStorage: memoryStorage(),
  sessionStorage: memoryStorage(),
  navigator: { userAgent: "ai-limits-modal-test", locks: {} },
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  scrollTo: noop,
  fetch: async (url) => {
    const u = String(url);
    if (u.split("?")[0] === "/api/ai/limits") {
      limitCalls.push(u);
      if (!limitResponse) throw new Error("offline");
      return { ok: true, status: 200, json: async () => limitResponse };
    }
    throw new Error("ai-limits-modal test must not perform network I/O: " + u);
  },
  CustomEvent: class CustomEvent { constructor(t, i = {}) { this.type = t; this.detail = i.detail; } },
  Event: class Event { constructor(t) { this.type = t; } },
  MutationObserver: class MutationObserver { observe() {} disconnect() {} },
  IntersectionObserver: class IntersectionObserver { observe() {} disconnect() {} },
  ResizeObserver: class ResizeObserver { observe() {} disconnect() {} },
  crypto: require("crypto").webcrypto,
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
sandbox.addEventListener = noop;
sandbox.removeEventListener = noop;
sandbox.dispatchEvent = () => true;
sandbox.HTMLElement = FakeElement;
sandbox.Footer = null;
sandbox.catalogPayload = {
  ...catalog,
  subject: "russian",
  subjects: [
    { id: "profile_math", title: "Профильная математика", status: "ready", features: {} },
    { id: "russian", title: "Русский язык", status: "ready", locked: false, features: { practice: true, path: true } },
  ],
};
vm.createContext(sandbox);
vm.runInContext([read("js/data.js"), read("js/state.js"), read("js/ai-limit.js"), read("js/app.js")].join("\n"), sandbox,
  { filename: "ai-limits-modal-bundle.js" });
vm.runInContext(`
  DataAPI.load(catalogPayload);
  Store.subject = "russian";
  Store.subjects = DataAPI.subjects();
  Store.ready = true;
  Store.state = Store.defaultState();
  Store.state.onboarded = true;
  Store.accountId = "limits-ui";
  Store.save = () => Promise.resolve();
`, sandbox);

const run = (code) => vm.runInContext(code, sandbox);
const flush = async (times = 8) => { for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0)); };
const devRoot = () => element("device-modal-root").innerHTML;
const modalRoot = () => element("modal-root").innerHTML;
const resetRoots = () => {
  element("modal-root").innerHTML = "";
  element("device-modal-root").innerHTML = "";
  element("device-modal-root")._qs = {};
};

(async () => {
  /* 1. Сочинения определяются данными, а не id. */
  check("тема с сочинениями распознаётся по long_text-заданиям",
    run(`asSafeArray(DataAPI.practiceTasksBySkill("russian_essay_source")).some((t) => isLongTextTask(t))`) === true);
  check("неизвестный skill — не сочинение",
    run(`asSafeArray(DataAPI.practiceTasksBySkill("no_such_skill")).some((t) => isLongTextTask(t))`) === false);

  /* 2. aiLimitFmt: живой формат ЧЧ:ММ:СС. */
  check("aiLimitFmt(0)", run(`aiLimitFmt(0)`) === "00:00:00");
  check("aiLimitFmt(3661)", run(`aiLimitFmt(3661)`) === "01:01:01");
  check("aiLimitFmt(28800)", run(`aiLimitFmt(28800)`) === "08:00:00");

  /* 3. Окно темы открывается всегда — даже при remaining=0 (гейта нет). */
  resetRoots();
  limitResponse = { ok: true, limit: 5, remaining: 0, resetInSec: 3661, windowSec: 28800 };
  limitCalls.length = 0;
  run(`openSkillModal("russian_essay_source")`);
  await flush();
  check("при remaining=0 открылось обычное окно темы", modalRoot().includes("modal-backdrop"), modalRoot().slice(0, 80));
  check("окно лимита НЕ показано", !devRoot().includes("dlg-backdrop"), devRoot().slice(0, 80));
  check("открытие темы не ходит за лимитом", limitCalls.length === 0, String(limitCalls.length));

  /* 4. Гость и офлайн: окно темы открывается сразу. */
  resetRoots();
  run(`Store.accountId = null;`);
  limitCalls.length = 0;
  run(`openSkillModal("russian_essay_source")`);
  await flush();
  check("гостю открывается обычное окно темы", modalRoot().includes("modal-backdrop"));
  check("гость не вызывает /api/ai/limits", limitCalls.length === 0, String(limitCalls.length));
  run(`Store.accountId = "limits-ui";`);

  /* 5. Продуктовый лимит: единое .dlg-окно с таймером и «0 из 5». */
  resetRoots();
  intervals.length = 0;
  run(`openAiLimitModal({ limit: 5, remaining: 0, resetInSec: 3661, windowSec: 28800 })`);
  await flush();
  const dlg = devRoot();
  check("открыто .dlg-окно лимита (та же система, что у устройств)", dlg.includes("dlg-backdrop"));
  check("заголовок «Проверки на сегодня закончились»", dlg.includes("Проверки на сегодня закончились"));
  check("текст про лимит 5 проверок в день", dlg.includes("5 проверок в день"), dlg.slice(0, 200));
  check("остаток «0 из 5»", dlg.includes(">0</span> из 5"), (dlg.match(/data-ai-limit-left[^<]*</) || [""])[0]);
  check("живой таймер ЧЧ:ММ:СС из resetInSec", dlg.includes("01:01:01"), (dlg.match(/\d\d:\d\d:\d\d/) || [""])[0]);
  check("закрытие крестиком и кнопкой", dlg.includes('onclick="closeAiLimitModal()"'));
  check("тикающий интервал запущен", intervals.length >= 1, String(intervals.length));

  /* 6. Esc/фон: closeAiLimitModal чистит контейнер. */
  run(`closeAiLimitModal()`);
  check("closeAiLimitModal очищает окно", devRoot() === "");

  /* 7. Таймер дотикал до нуля → перезапрос → проверка вернулась → окно закрыто. */
  resetRoots();
  intervals.length = 0;
  const timerSpan = { textContent: "", isConnected: true };
  element("device-modal-root")._qs["[data-ai-limit-timer]"] = timerSpan;
  limitResponse = { ok: true, limit: 5, remaining: 0, resetInSec: 2, windowSec: 28800 };
  run(`openAiLimitModal({ limit: 5, remaining: 0, resetInSec: 2, windowSec: 28800 })`);
  await flush();
  check("окно лимита открыто", devRoot().includes("dlg-backdrop"));
  check("начальный рендер таймера 00:00:02", devRoot().includes("00:00:02"),
        (devRoot().match(/\d\d:\d\d:\d\d/) || [""])[0]);
  const tick = intervals[intervals.length - 1];
  check("интервал тика пойман", typeof tick === "function");
  limitCalls.length = 0;
  limitResponse = { ok: true, limit: 5, remaining: 1, resetInSec: null, windowSec: 28800 };
  tick(); // left: 2 -> 1
  check("тик обновляет цифры", timerSpan.textContent === "00:00:01", timerSpan.textContent);
  tick(); // left: 1 -> 0 → перезапрос
  await flush();
  check("по нулю таймера лимит перезапрошен у сервера", limitCalls.length >= 1, String(limitCalls.length));
  check("проверка вернулась → окно лимита закрыто", !devRoot().includes("dlg-backdrop"), devRoot().slice(0, 60));

  /* 8. Таймер дотикал до нуля → сервер сказал ждать ещё → окно перезапущено. */
  resetRoots();
  intervals.length = 0;
  const timerSpan2 = { textContent: "", isConnected: true };
  element("device-modal-root")._qs["[data-ai-limit-timer]"] = timerSpan2;
  limitResponse = { ok: true, limit: 5, remaining: 0, resetInSec: 2, windowSec: 28800 };
  run(`openAiLimitModal({ limit: 5, remaining: 0, resetInSec: 2, windowSec: 28800 })`);
  await flush();
  const tick2 = intervals[intervals.length - 1];
  limitResponse = { ok: true, limit: 5, remaining: 0, resetInSec: 5000, windowSec: 28800 };
  tick2(); tick2();
  await flush();
  check("сервер сказал ждать → окно перезапущено с новым таймером",
    devRoot().includes("dlg-backdrop") && devRoot().includes("01:23:20"),
    (devRoot().match(/\d\d:\d\d:\d\d/) || [""])[0]);

  /* 9. Burst-режим: тот же .dlg, «Слишком частые запросы», короткий отсчёт. */
  resetRoots();
  intervals.length = 0;
  const burstSpan = { textContent: "", isConnected: true };
  element("device-modal-root")._qs["[data-ai-limit-timer]"] = burstSpan;
  run(`openAiLimitModal(null, 2)`);
  await flush();
  const burstDlg = devRoot();
  check("burst: открыто .dlg-окно", burstDlg.includes("dlg-backdrop"));
  check("burst: заголовок «Слишком частые запросы»", burstDlg.includes("Слишком частые запросы"));
  check("burst: начальный отсчёт 00:00:02", burstDlg.includes("00:00:02"));
  check("фолбэк лимита — единый общий (js/ai-limit.js), без NaN",
    run(`AI_LIMIT_FALLBACK`) === 5 && !burstDlg.includes("NaN"), String(run(`AI_LIMIT_FALLBACK`)));
  const burstTick = intervals[intervals.length - 1];
  check("burst: интервал тика пойман", typeof burstTick === "function");
  burstTick(); // left: 2 -> 1
  check("burst: тик обновляет цифры", burstSpan.textContent === "00:00:01", burstSpan.textContent);
  burstTick(); // left: 1 -> 0 → окно гаснет само
  check("burst: по нулю окно закрылось", !devRoot().includes("dlg-backdrop"), devRoot().slice(0, 60));

  /* 10. Burst с известным остатком: остаток виден, лимит не выдуман. */
  resetRoots();
  run(`openAiLimitModal({ limit: 5, remaining: 2, resetInSec: 20000, windowSec: 28800 }, 60)`);
  await flush();
  check("burst с остатком: показан «2 из 5»", devRoot().includes(">2</span> из 5"), devRoot().slice(0, 300));
  check("burst с остатком: короткий отсчёт, а не 8ч", devRoot().includes("00:01:00"), devRoot().slice(0, 300));

  /* 11. Успешная проверка локально уменьшает кэш остатка. */
  run(`AiLimits.accountId = Store.accountId;
       AiLimits.cache = { limit: 5, remaining: 1, resetInSec: null, windowSec: 28800, at: Date.now() };
       aiLimitsNoteSpend();`);
  const after = run(`AiLimits.cache.remaining`);
  check("aiLimitsNoteSpend: 1 → 0", after === 0, String(after));
  check("и таймер появляется (следующая через 8ч)", run(`AiLimits.cache.resetInSec`) === 28800);

  /* 12. Кэш другого аккаунта не считается свежим. */
  run(`Store.accountId = "another";`);
  check("кэш чужого аккаунта инвалиден", run(`aiLimitsFreshCached()`) === null);

  console.log(failures ? `\n${failures} FAILURES` : "\nALL OK");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
