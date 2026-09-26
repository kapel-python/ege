/* Навигация практики сочинений: подпись основной кнопки и «Назад».
   Реальные js/data.js + js/state.js + js/app.js в браузерной VM.

   Проверяется ровно то, что ломалось:
   1. Подпись «Далее →» / «Написать ещё раз» / «Завершить» у сочинения.
   2. Куда ведёт кнопка (ближайшее написанное вперёд, иначе следующее).
   3. Ряд навигации («Назад» + вперёд) есть у КАЖДОГО сочинения — и под
      готовым отчётом, и на ненаписанном, где раньше его не было вовсе.
   4. Карта написанных работ приходит с сервера целиком: на живом входе в
      практику клиент знал только то, до чего дошёл в текущей сессии, и
      подпись становилась «Написать ещё раз» даже при готовых работах дальше.
   5. Гость/офлайн не ломают навигацию: остаётся то, что отправлено в сессии.
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
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this._innerHTML = "";
    this.children = [];
    this.attributes = {};
    const classes = new Set();
    this.classList = {
      add: (...n) => n.forEach((x) => classes.add(x)),
      remove: (...n) => n.forEach((x) => classes.delete(x)),
      contains: (n) => classes.has(n),
      toggle: (n, force) => {
        const on = force === undefined ? !classes.has(n) : !!force;
        if (on) classes.add(n); else classes.delete(n);
        return on;
      },
    };
  }
  set innerHTML(v) { this._innerHTML = String(v); this.children = []; }
  get innerHTML() { return this._innerHTML; }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  insertBefore(c) { this.children.unshift(c); c.parentNode = this; return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute(n, v) { this.attributes[n] = String(v); }
  getAttribute(n) { return this.attributes[n] ?? null; }
  removeAttribute(n) { delete this.attributes[n]; }
  addEventListener() {}
  removeEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  focus() {}
  getBoundingClientRect() { return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 }; }
  getClientRects() { return []; }
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

/* Уже написанные работы ученика: как у живого аккаунта, который начинал
   практику не с нуля. Готовы 1, 2, 3, 5 и 6; 4, 7 и 8 не написаны. */
const WRITTEN = {
  re27_1: { status: "ready", submissionId: 8, clientId: "c-1", wordCount: 332 },
  re27_2: { status: "ready", submissionId: 10, clientId: "c-2", wordCount: 340 },
  re27_3: { status: "ready", submissionId: 12, clientId: "c-3", wordCount: 205 },
  re27_5: { status: "ready", submissionId: 13, clientId: "c-5", wordCount: 281 },
  re27_6: { status: "ready", submissionId: 14, clientId: "c-6", wordCount: 281 },
};
const readySubmission = (taskId) => ({
  submissionId: WRITTEN[taskId].submissionId,
  taskId,
  skill: "russian_essay_source",
  subject: "russian",
  wordCount: WRITTEN[taskId].wordCount,
  clientId: WRITTEN[taskId].clientId,
  status: "ready",
  text: "Счастливым можно считать человека, который нашёл дело по душе и сохранил верных друзей рядом.",
  result: { total_score: 16, max_score: 22, criteria: [] },
});

/* guest: true — сервер отвечает 401 (профиля нет), и карты не будет. */
function makeFetch({ guest = false, fail = false } = {}) {
  const calls = [];
  const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  return {
    calls,
    fetch: async (url) => {
      const u = String(url);
      calls.push(u);
      const path = u.split("?")[0];
      if (path === "/api/catalog-tasks") {
        return json({ tasks: catalog.tasks || [], visualAssets: catalog.visualAssets || {}, visualAudit: {} });
      }
      if (path === "/api/catalog-lessons") return json({ lessons: catalog.lessons || [] });
      if (path === "/api/essay-text") {
        return json({ ok: true, sourceText: { author: "А. Твардовский", text: "Отчизна знает меня.", wordCount: 3 } });
      }
      if (path === "/api/essays") {
        if (guest) return json({ error: "Нужен профиль" }, 401);
        if (fail) throw new Error("offline");
        if (/[?&]statuses=1/.test(u)) return json({ ok: true, subject: "russian", statuses: WRITTEN });
        const taskId = (/[?&]taskId=([^&]+)/.exec(u) || [])[1];
        if (taskId && WRITTEN[taskId]) return json({ ok: true, subject: "russian", submission: readySubmission(decodeURIComponent(taskId)) });
        return json({ error: "Сочинение не найдено" }, 404);
      }
      throw new Error("essay-nav test must not perform network I/O: " + u);
    },
  };
}

function buildSandbox(options) {
  const net = makeFetch(options);
  const sandbox = {
    console: { log: noop, info: noop, warn: noop, error: noop },
    setTimeout: () => 0,
    clearTimeout: noop,
    setInterval: () => 0,
    clearInterval: noop,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: noop,
    document,
    location: { hash: "#/training", href: "http://localhost/", origin: "http://localhost" },
    history: { replaceState: noop },
    localStorage: memoryStorage(),
    sessionStorage: memoryStorage(),
    navigator: { userAgent: "essay-nav-test", locks: {} },
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    scrollTo: noop,
    fetch: net.fetch,
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
      { id: "profile_math", title: "Профильная математика", status: "ready", features: { lessons: true, practice: true } },
      { id: "basic_math", title: "Базовая математика", status: "ready", features: { lessons: true, practice: true } },
      { id: "russian", title: "Русский язык", status: "ready", locked: false, features: { lessons: false, practice: true, missions: true, path: true } },
    ],
  };
  vm.createContext(sandbox);
  vm.runInContext(
    [read("js/data.js"), read("js/state.js"), read("js/app.js")].join("\n"),
    sandbox,
    { filename: "essay-nav-bundle.js" }
  );
  vm.runInContext(`
    DataAPI.load(catalogPayload);
    Store.subject = "russian";
    Store.subjects = DataAPI.subjects();
    Store.ready = true;
    Store.state = Store.defaultState();
    Store.state.onboarded = true;
    Store.accountId = "testnav";
    Store.save = () => Promise.resolve();
    Vendor.ensureMath = () => Promise.resolve();
    Vendor.loadScript = () => Promise.resolve();
    Session.cur = null;
    Lesson.cur = null;
    // Сессия практики сочинений: все 8 заданий темы, как у живого входа.
    globalThis.ESSAY_TASK_IDS = DataAPI.practiceTasksBySkill("russian_essay_source").map((item) => item.id);
    Session.start({ title: "Тренировка: Сочинение", taskIds: ESSAY_TASK_IDS, mode: "quick" });
    if (typeof EssayStatuses !== "undefined") { EssayStatuses.subject = ""; EssayStatuses.map = null; EssayStatuses.inflight = ""; }
  `, sandbox);
  return { sandbox, net };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const flush = async (times = 6) => { for (let i = 0; i < times; i++) await settle(); };

/* Состояние экрана задания: что реально нарисовано. */
const screenOf = (sandbox) => vm.runInContext(`
  (() => {
    const slot = document.getElementById("essayNavSlot");
    const row = slot ? slot.innerHTML : "";
    const head = document.getElementById("screen").innerHTML;
    const label = (/onclick="sessionNext\\(\\)">([^<]+)</.exec(row) || [])[1] || "";
    return {
      task: Session.task().id,
      idx: Session.cur.idx,
      row: row.trim().length > 0,
      label,
      back: row.includes("sessionPrev()"),
      headBack: head.includes("id=\\"sessionPrevBtn\\""),
      written: Object.keys(Session.cur.essayWrittenByTask || {}).sort(),
      nextTarget: sessionNextTarget(),
      labelFn: sessionNextLabel(),
    };
  })()
`, sandbox);

async function main() {
  /* ---------- 1. Живой вход: работы уже есть, сессия только началась ---------- */
  {
    const { sandbox, net } = buildSandbox({});
    vm.runInContext(`renderTask(document.getElementById("screen"))`, sandbox);
    await flush();

    const first = screenOf(sandbox);
    check("1-е задание: подпись «Далее →» (впереди есть написанные работы)",
      first.labelFn === "Далее →" && first.label === "Далее →", `label=${first.label} labelFn=${first.labelFn}`);
    check("1-е задание: «Далее» ведёт на ближайшее написанное (2-е)",
      first.nextTarget === 1, `target=${first.nextTarget}`);
    check("карта написанных работ пришла с сервера целиком",
      first.written.join(",") === "re27_1,re27_2,re27_3,re27_5,re27_6", first.written.join(","));
    check("1-е задание: «Назад» не показан (возвращаться некуда)",
      first.back === false && first.headBack === false, `row=${first.back} head=${first.headBack}`);

    // Шаг вперёд: 2-е задание (тоже готовое) — ряд на месте, «Назад» есть.
    vm.runInContext(`sessionNext()`, sandbox);
    await flush();
    const second = screenOf(sandbox);
    check("2-е задание: ряд навигации отрисован", second.row === true);
    check("2-е задание: «Назад» есть в ряду", second.back === true);
    check("2-е задание: «Назад» в шапке не дублируется", second.headBack === false);
    check("2-е задание: подпись «Далее →»", second.label === "Далее →", second.label);

    vm.runInContext(`sessionNext()`, sandbox); // 3-е
    await flush();
    const third = screenOf(sandbox);
    check("3-е задание: «Далее» через ненаписанное 4-е уходит на 5-е",
      third.idx === 2 && third.nextTarget === 4, `idx=${third.idx} target=${third.nextTarget}`);
    vm.runInContext(`sessionNext()`, sandbox); // 5-е
    await flush();
    const fifth = screenOf(sandbox);
    check("«Далее» с 3-го приводит на готовое 5-е задание", fifth.idx === 4 && fifth.task === "re27_5",
      `${fifth.idx}/${fifth.task}`);
    check("5-е задание: подпись «Далее →»", fifth.label === "Далее →", fifth.label);

    vm.runInContext(`sessionNext()`, sandbox); // 6-е — последнее написанное
    await flush();
    const sixth = screenOf(sandbox);
    check("6-е задание (дальше написанного нет): «Написать ещё раз»",
      sixth.label === "Написать ещё раз", sixth.label);
    check("«Написать ещё раз» ведёт на следующее ненаписанное (7-е)",
      sixth.nextTarget === 6, `target=${sixth.nextTarget}`);

    vm.runInContext(`sessionNext()`, sandbox); // 7-е — НЕ написано
    await flush();
    const seventh = screenOf(sandbox);
    check("7-е задание (сочинение не написано): ряд навигации есть", seventh.row === true);
    check("7-е задание: «Назад» есть — кнопка не исчезает на ненаписанном",
      seventh.back === true, `row=${seventh.row} back=${seventh.back}`);
    check("7-е задание: видно и «Написать ещё раз»", seventh.label === "Написать ещё раз", seventh.label);
    check("на ненаписанном задании редактор на месте",
      vm.runInContext(`!!document.getElementById("essayInput")`, sandbox) === true);

    vm.runInContext(`sessionPrev()`, sandbox);
    await flush();
    const backToSixth = screenOf(sandbox);
    check("«Назад» с ненаписанного возвращает на 6-е задание",
      backToSixth.idx === 5 && backToSixth.task === "re27_6", `${backToSixth.idx}/${backToSixth.task}`);

    vm.runInContext(`Session.cur.idx = 7; renderTask(document.getElementById("screen"))`, sandbox);
    await flush();
    const last = screenOf(sandbox);
    check("последнее задание: «Завершить»", last.label === "Завершить", last.label);
    check("карта запрошена один раз за сессию",
      net.calls.filter((u) => /[?&]statuses=1/.test(u)).length === 1,
      String(net.calls.filter((u) => /statuses=1/.test(u)).length));
  }

  /* ---------- 2. Гость: 401 — навигация не ломается ---------- */
  {
    const { sandbox } = buildSandbox({ guest: true });
    vm.runInContext(`renderTask(document.getElementById("screen"))`, sandbox);
    await flush();
    const state = screenOf(sandbox);
    check("гость: ряд навигации на месте", state.row === true && state.back === false);
    check("гость: без карты подпись «Написать ещё раз» (писать ещё нечего дальше)",
      state.label === "Написать ещё раз", state.label);
    check("гость: лишних запросов карты не повторяет бесконечно",
      state.written.length === 0, state.written.join(","));
  }

  /* ---------- 3. Офлайн: исключение из fetch не ломает экран ---------- */
  {
    const { sandbox } = buildSandbox({ fail: true });
    vm.runInContext(`renderTask(document.getElementById("screen"))`, sandbox);
    await flush();
    const state = screenOf(sandbox);
    check("офлайн: ряд навигации отрисован", state.row === true);
    check("офлайн: подпись не сломана", state.label === "Написать ещё раз", state.label);
  }

  /* ---------- 4. Написанное в этой сессии попадает в карту без сервера ---------- */
  {
    const { sandbox } = buildSandbox({ guest: true });
    vm.runInContext(`
      renderTask(document.getElementById("screen"));
      essayMarkWritten("re27_8", { clientId: "live", wordCount: 300, status: "ready" });
      renderTask(document.getElementById("screen"));
    `, sandbox);
    await flush();
    const state = screenOf(sandbox);
    check("отправленное в сессии сочинение учитывается навигацией",
      state.written.includes("re27_8"), state.written.join(","));
    const withWrittenAhead = vm.runInContext(`
      Session.cur.idx = 6; renderTask(document.getElementById("screen"));
      ({ label: sessionNextLabel(), target: sessionNextTarget() })
    `, sandbox);
    check("после отправки подпись впереди меняется на «Далее →»",
      withWrittenAhead.label === "Далее →" && withWrittenAhead.target === 7,
      JSON.stringify(withWrittenAhead));
  }

  console.log(failures ? `\n${failures} FAILURES` : "\nALL OK");
  process.exit(failures ? 1 : 0);
}

main();
