/* Навигация практики сочинений: подпись основной кнопки и «Назад».
   Реальные js/data.js + js/state.js + js/app.js в браузерной VM.

   Проверяется ровно то, что ломалось:
   1. Подпись говорит о СОСЕДНЕМ задании и ничего больше:
        следующее написано                  → «Далее →»
        следующее чистое, текущее написано   → «Написать ещё раз»
        следующее чистое, текущее пишем сами → кнопки нет вовсе
        следующего задания нет                → «Завершить»
   2. Кнопка ведёт строго на следующее задание (никаких прыжков через
      ненаписанные) — и подпись всегда описывает этот самый шаг.
   3. Ряд «Назад» есть у КАЖДОГО сочинения, кроме первого, даже когда
      кнопки вперёд нет; на первом ненаписанном ряда нет вовсе.
   4. Карта написанных работ приходит с сервера целиком: на живом входе в
      практику клиент знал только то, до чего дошёл в текущей сессии, и
      подпись кнопки получалась неверной.
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

/* Уже написанные работы: как у живого аккаунта, который начинал практику не
   с нуля. Готовы 1, 2, 3, 5 и 6; 4, 7 и 8 не написаны — из них 4 и 7 стоят
   в середине списка, поэтому видно все три состояния кнопки подряд. */
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

/* guest: сервер отвечает 401 (профиля нет) и карты не будет.
   noSubmissions: точечный запрос тоже пуст — честный чистый аккаунт. */
function makeFetch({ guest = false, fail = false, statuses = WRITTEN, noSubmissions = false } = {}) {
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
        if (/[?&]statuses=1/.test(u)) return json({ ok: true, subject: "russian", statuses });
        const taskId = (/[?&]taskId=([^&]+)/.exec(u) || [])[1];
        if (!noSubmissions && taskId && WRITTEN[taskId]) {
          return json({ ok: true, subject: "russian", submission: readySubmission(decodeURIComponent(taskId)) });
        }
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

const flush = async (times = 6) => { for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0)); };

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
      labelFn: sessionNextLabel(),
      back: row.includes("sessionPrev()"),
      headBack: head.includes("id=\\"sessionPrevBtn\\""),
      written: Object.keys(Session.cur.essayWrittenByTask || {}).sort(),
      nextTarget: sessionNextTarget(),
      hasEditor: !!document.getElementById("essayInput"),
    };
  })()
`, sandbox);

const goto = (sandbox, idx) => vm.runInContext(`
  Session.cur.idx = ${idx}; renderTask(document.getElementById("screen"));
`, sandbox);

async function main() {
  /* ---------- 1. Живой вход: работы уже есть, сессия только началась ---------- */
  {
    const { sandbox, net } = buildSandbox({});
    vm.runInContext(`renderTask(document.getElementById("screen"))`, sandbox);
    await flush();

    const first = screenOf(sandbox);
    check("карта написанных работ пришла с сервера целиком",
      first.written.join(",") === "re27_1,re27_2,re27_3,re27_5,re27_6", first.written.join(","));

    /* Ожидаемая подпись на каждом задании: говорит о СЛЕДУЮЩЕМ. */
    const expected = [
      { idx: 0, task: "re27_1", label: "Далее →", back: false, target: 1 },
      { idx: 1, task: "re27_2", label: "Далее →", back: true, target: 2 },
      { idx: 2, task: "re27_3", label: "Написать ещё раз", back: true, target: 3 },
      { idx: 3, task: "re27_4", label: "Далее →", back: true, target: 4 },
      { idx: 4, task: "re27_5", label: "Далее →", back: true, target: 5 },
      { idx: 5, task: "re27_6", label: "Написать ещё раз", back: true, target: 6 },
      { idx: 6, task: "re27_7", label: "", back: true, target: 7 },
      { idx: 7, task: "re27_8", label: "Завершить", back: true, target: 8 },
    ];
    for (const step of expected) {
      goto(sandbox, step.idx);
      await flush();
      const st = screenOf(sandbox);
      const where = `${step.idx + 1}/8 ${step.task}${sessionNote(step)}`;
      check(`${where}: подпись «${step.label || "нет кнопки"}»`,
        st.label === step.label && st.labelFn === step.label, `label=${st.label}`);
      check(`${where}: «Назад» ${step.back ? "есть" : "нет"}`,
        st.back === step.back, `back=${st.back}`);
      check(`${where}: кнопка ведёт строго на следующее`,
        st.nextTarget === step.target, `target=${st.nextTarget}`);
      check(`${where}: «Назад» в шапке не дублируется`, st.headBack === false);
    }

    /* Ряда нет только там, где показать нечего. */
    goto(sandbox, 6); // 7/8 не написано, 8/8 не написано: вперёд некуда
    await flush();
    const deadEnd = screenOf(sandbox);
    check("на «тупике» (7/8) кнопки вперёд нет, но «Назад» остаётся",
      deadEnd.label === "" && deadEnd.back === true && deadEnd.row === true,
      `label=${deadEnd.label} back=${deadEnd.back} row=${deadEnd.row}`);
    check("на «тупике» редактор сочинения на месте", deadEnd.hasEditor === true);

    goto(sandbox, 0);
    await flush();
    check("на первом задании «Назад» не показан (возвращаться некуда)",
      screenOf(sandbox).back === false);

    /* Шаг реальной кнопкой туда, где её раньше не было. */
    goto(sandbox, 3); // 4/8 не написано, дальше 5/8 готово
    await flush();
    vm.runInContext(`sessionNext()`, sandbox);
    await flush();
    check("с ненаписанного 4-го «Далее» уводит на готовое 5-е",
      screenOf(sandbox).task === "re27_5", screenOf(sandbox).task);

    goto(sandbox, 2); // 3/8 готово, 4/8 чистое
    await flush();
    vm.runInContext(`sessionNext()`, sandbox);
    await flush();
    check("«Написать ещё раз» с 3-го открывает чистый бланк 4-го",
      screenOf(sandbox).task === "re27_4" && screenOf(sandbox).label === "Далее →",
      `${screenOf(sandbox).task}/${screenOf(sandbox).label}`);

    /* «Назад» работает и там, где кнопки вперёд нет. */
    goto(sandbox, 6);
    await flush();
    vm.runInContext(`sessionPrev()`, sandbox);
    await flush();
    check("«Назад» с 7-го возвращает на 6-е", screenOf(sandbox).task === "re27_6",
      screenOf(sandbox).task);

    check("карта запрошена один раз за сессию",
      net.calls.filter((u) => /[?&]statuses=1/.test(u)).length === 1,
      String(net.calls.filter((u) => /statuses=1/.test(u)).length));
  }

  /* ---------- 2. Чистый аккаунт: писать нечего — кнопок нет ---------- */
  {
    const { sandbox } = buildSandbox({ statuses: {}, noSubmissions: true });
    vm.runInContext(`renderTask(document.getElementById("screen"))`, sandbox);
    await flush();
    const first = screenOf(sandbox);
    check("чистый аккаунт: на первом задании ряда нет вовсе",
      first.row === false && first.label === "" && first.back === false,
      `row=${first.row} label=${first.label}`);
    check("чистый аккаунт: писать нечего — и написать нечего",
      first.labelFn === "" && first.hasEditor === true, first.labelFn);
    goto(sandbox, 1);
    await flush();
    const second = screenOf(sandbox);
    check("чистый аккаунт: дальше ряд есть только из-за «Назад»",
      second.row === true && second.back === true && second.label === "",
      `back=${second.back} label=${second.label}`);
    goto(sandbox, 7);
    await flush();
    check("чистый аккаунт: последнее задание закрывает тренировку",
      screenOf(sandbox).label === "Завершить", screenOf(sandbox).label);
  }

  /* ---------- 3. Гость: 401 — навигация не ломается ---------- */
  {
    const { sandbox } = buildSandbox({ guest: true });
    vm.runInContext(`renderTask(document.getElementById("screen"))`, sandbox);
    await flush();
    const state = screenOf(sandbox);
    check("гость: экран отрисован, кнопок вперёд нет", state.row === false && state.label === "");
    check("гость: лишних запросов карты не повторяет бесконечно",
      state.written.length === 0, state.written.join(","));
  }

  /* ---------- 4. Офлайн: исключение из fetch не ломает экран ---------- */
  {
    const { sandbox } = buildSandbox({ fail: true });
    vm.runInContext(`renderTask(document.getElementById("screen"))`, sandbox);
    await flush();
    const state = screenOf(sandbox);
    check("офлайн: подпись не сломана", state.labelFn === "" && state.hasEditor === true, state.labelFn);
  }

  /* ---------- 5. Написанное в этой сессии попадает в карту без сервера ---------- */
  {
    const { sandbox } = buildSandbox({ guest: true });
    vm.runInContext(`
      renderTask(document.getElementById("screen"));
      essayMarkWritten("re27_2", { clientId: "live", wordCount: 300, status: "ready" });
      renderTask(document.getElementById("screen"));
    `, sandbox);
    await flush();
    const state = screenOf(sandbox);
    check("отправленное в сессии сочинение учитывается навигацией",
      state.written.includes("re27_2"), state.written.join(","));
    check("написанное СЛЕДУЮЩЕЕ задание даёт «Далее →» (есть что посмотреть)",
      state.labelFn === "Далее →", state.labelFn);
    const next = vm.runInContext(`
      Session.cur.idx = 1; renderTask(document.getElementById("screen"));
      ({ label: sessionNextLabel(), target: sessionNextTarget() })
    `, sandbox);
    check("на написанном задании с чистым следующим — «Написать ещё раз»",
      next.label === "Написать ещё раз" && next.target === 2, JSON.stringify(next));
  }

  console.log(failures ? `\n${failures} FAILURES` : "\nALL OK");
  process.exit(failures ? 1 : 0);
}

/* Пояснение к ожиданию: что там с текущим и следующим заданием. */
function sessionNote(step) {
  const current = step.idx < 8 && ["re27_1", "re27_2", "re27_3", "re27_5", "re27_6"].includes(step.task);
  const nextTask = ["re27_1", "re27_2", "re27_3", "re27_4", "re27_5", "re27_6", "re27_7", "re27_8"][step.idx + 1];
  const next = nextTask ? ["re27_1", "re27_2", "re27_3", "re27_5", "re27_6"].includes(nextTask) : null;
  return ` [текущее ${current ? "написано" : "чистое"}, следующее ${nextTask ? (next ? "готово" : "чистое") : "нет"}]`;
}

main();
