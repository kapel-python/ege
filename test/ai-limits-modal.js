/* Гейт лимита ИИ-проверок на «Пути» и окно «лимит исчерпан».
   Реальные js/data.js + js/state.js + js/app.js в браузерной VM.

   Проверяется ровно то, что требует задача:
   1. Тема сочинения определяется данными каталога (long_text-задания), а не
      захардкоженным id — любой предмет с сочинением подхватывается сам.
   2. Клик по теме сочинения при исчерпанном лимите НЕ открывает окно темы:
      вместо него — единое .dlg-окно (та же система, что у устройств профиля
      и дисклеймера модели на ege-result.html) с живым таймером ЧЧ:ММ:СС и
      остатком «0 из 3».
   3. При наличии хотя бы одной проверки открывается обычное окно темы,
      окно лимита не показывается.
   4. Гость и офлайн не блокируются: решает сервер при отправке (429 AI_LIMIT).
   5. Таймер дотикал до нуля → перезапрос → проверка вернулась → окно лимита
      закрывается и открывается тема, которую ученик хотел.
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
let limitResponse = { ok: true, limit: 3, remaining: 3, resetInSec: null, windowSec: 28800 };
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
vm.runInContext([read("js/data.js"), read("js/state.js"), read("js/app.js")].join("\n"), sandbox,
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

(async () => {
  /* 1. Тема сочинения определяется данными, а не id. */
  check("тема с сочинениями распознаётся как ИИ-проверяемая",
    run(`skillUsesAiChecks("russian_essay_source")`) === true);
  check("тема без long_text-заданий — нет",
    run(`skillUsesAiChecks("no_such_skill")`) === false);

  /* 2. aiLimitFmt: живой формат ЧЧ:ММ:СС. */
  check("aiLimitFmt(0)", run(`aiLimitFmt(0)`) === "00:00:00");
  check("aiLimitFmt(3661)", run(`aiLimitFmt(3661)`) === "01:01:01");
  check("aiLimitFmt(28800)", run(`aiLimitFmt(28800)`) === "08:00:00");

  /* 3. Лимит есть → обычное окно темы, окна лимита нет. */
  location_hash("skill", "russian_essay_source");
  limitResponse = { ok: true, limit: 3, remaining: 2, resetInSec: 20000, windowSec: 28800 };
  run(`AiLimits.cache = null; AiLimits.accountId = null;`);
  await run(`openEssaySkillModalGated("russian_essay_source"); "done"`);
  await flush();
  check("при remaining=2 открылось окно темы", modalRoot().includes("modal-backdrop"), modalRoot().slice(0, 80));
  check("окно лимита НЕ показано", !devRoot().includes("dlg-backdrop"), devRoot().slice(0, 80));

  /* 4. Лимит исчерпан → окно темы НЕ открывается, вместо него .dlg-окно. */
  run(`closeModal && closeModal()`);
  element("modal-root").innerHTML = "";
  element("device-modal-root").innerHTML = "";
  limitResponse = { ok: true, limit: 3, remaining: 0, resetInSec: 3661, windowSec: 28800 };
  run(`AiLimits.cache = null; AiLimits.accountId = null;`);
  await run(`openEssaySkillModalGated("russian_essay_source"); "done"`);
  await flush();
  const dlg = devRoot();
  check("окно темы НЕ открылось", !modalRoot().includes("modal-backdrop"), modalRoot().slice(0, 80));
  check("открыто .dlg-окно лимита (та же система, что у устройств)", dlg.includes("dlg-backdrop"));
  check("заголовок «Проверки на сегодня закончились»", dlg.includes("Проверки на сегодня закончились"));
  check("текст про лимит 3 проверки в день", dlg.includes("3 проверки сочинения в день на аккаунт"), dlg.slice(0, 200));
  check("остаток «0 из 3»", dlg.includes(">0</span> из 3"), (dlg.match(/data-ai-limit-left[^<]*</) || [""])[0]);
  check("живой таймер ЧЧ:ММ:СС из resetInSec", dlg.includes("01:01:01"), (dlg.match(/\d\d:\d\d:\d\d/) || [""])[0]);
  check("закрытие крестиком и кнопкой", dlg.includes('onclick="closeAiLimitModal()"'));
  check("тикающий интервал запущен", intervals.length >= 1, String(intervals.length));

  /* 5. Esc/фон: closeAiLimitModal чистит контейнер. */
  run(`closeAiLimitModal()`);
  check("closeAiLimitModal очищает окно", devRoot() === "");

  /* 6. Таймер дотикал до нуля → перезапрос → проверка вернулась → открылась тема. */
  element("modal-root").innerHTML = "";
  intervals.length = 0;
  const timerSpan = { textContent: "", isConnected: true };
  element("device-modal-root")._qs["[data-ai-limit-timer]"] = timerSpan;
  limitResponse = { ok: true, limit: 3, remaining: 0, resetInSec: 2, windowSec: 28800 };
  run(`AiLimits.cache = null; AiLimits.accountId = null;`);
  await run(`openEssaySkillModalGated("russian_essay_source"); "done"`);
  await flush();
  check("окно лимита снова открыто", devRoot().includes("dlg-backdrop"));
  check("начальный рендер таймера 00:00:02", devRoot().includes("00:00:02"),
        (devRoot().match(/\d\d:\d\d:\d\d/) || [""])[0]);
  const tick = intervals[intervals.length - 1];
  check("интервал тика пойман", typeof tick === "function");
  limitCalls.length = 0;
  limitResponse = { ok: true, limit: 3, remaining: 1, resetInSec: null, windowSec: 28800 };
  tick(); // left: 2 -> 1
  check("тик обновляет цифры", timerSpan.textContent === "00:00:01", timerSpan.textContent);
  tick(); // left: 1 -> 0 → перезапрос
  await flush();
  check("по нулю таймера лимит перезапрошен у сервера", limitCalls.length >= 1, String(limitCalls.length));
  check("проверка вернулась → окно лимита закрыто", !devRoot().includes("dlg-backdrop"), devRoot().slice(0, 60));
  check("и открылась тема, которую ученик хотел", modalRoot().includes("modal-backdrop"), modalRoot().slice(0, 60));

  /* 7. Гость: запроса к /api/ai/limits нет, окно темы открывается сразу. */
  element("modal-root").innerHTML = "";
  element("device-modal-root").innerHTML = "";
  run(`Store.accountId = null; AiLimits.cache = null; AiLimits.accountId = null;`);
  limitCalls.length = 0;
  await run(`openEssaySkillModalGated("russian_essay_source"); "done"`);
  await flush();
  check("гость не вызывает /api/ai/limits", limitCalls.length === 0, String(limitCalls.length));
  check("гостю открывается обычное окно темы", modalRoot().includes("modal-backdrop"));
  run(`Store.accountId = "limits-ui";`);

  /* 8. Офлайн: не блокируем, открываем тему (сервер решит при отправке). */
  element("modal-root").innerHTML = "";
  limitResponse = null;
  run(`AiLimits.cache = null; AiLimits.accountId = null; AiLimits.pending = null;`);
  await run(`openEssaySkillModalGated("russian_essay_source"); "done"`);
  await flush();
  check("офлайн не блокирует окно темы", modalRoot().includes("modal-backdrop"));
  check("окно лимита не показано", !devRoot().includes("dlg-backdrop"));

  /* 9. Успешная проверка локально уменьшает кэш остатка. */
  run(`AiLimits.accountId = Store.accountId;
       AiLimits.cache = { limit: 3, remaining: 1, resetInSec: null, windowSec: 28800, at: Date.now() };
       aiLimitsNoteSpend();`);
  const after = run(`AiLimits.cache.remaining`);
  check("aiLimitsNoteSpend: 1 → 0", after === 0, String(after));
  check("и таймер появляется (следующая через 8ч)", run(`AiLimits.cache.resetInSec`) === 28800);

  /* 10. Кэш другого аккаунта не считается свежим. */
  run(`Store.accountId = "another";`);
  check("кэш чужого аккаунта инвалиден", run(`aiLimitsFreshCached()`) === null);

  console.log(failures ? `\n${failures} FAILURES` : "\nALL OK");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

function location_hash(route, param) {
  sandbox.location.hash = `#/${route}/${param}`;
}
