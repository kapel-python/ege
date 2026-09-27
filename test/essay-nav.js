/* Практика сочинений «один визит — одно сочинение».
   Реальные js/data.js + js/state.js + js/ai-limit.js + js/app.js в браузерной VM.

   Контракт входа (startEssayPractice):
   1. Вход создаёт сессию ровно из ОДНОГО задания — никаких списков 8/8,
      счётчиков «4/8» и прогресс-баров внутри визита.
   2. Какое именно: первое недописанное по порядку каталога. Готовность —
      серверная карта ready (GET /api/essays?statuses=1, свежая на каждый
      вход: работу могли дописать с другого устройства) + метки сессии.
      Пропущенные («Взять другое») — в последнюю очередь и сгорают, когда
      других недописанных не осталось. Всё готово — новый круг с 1-го
      текста (старые работы остаются историей).
   3. Активная недописанная работа возвращается (Session.start повторно
      не вызывается): затирать начатое новым визитом нельзя.
   4. Одиночная сессия: нет ряда навигации («Далее»/«Назад»/«Написать ещё
      раз»), нет «Пропустить», есть редактор + «Взять другое».
   5. Готовая проверка одиночной сессии — сразу итоговый экран
      (ТРЕНИРОВКА ЗАВЕРШЕНА, +XP, кнопка «Разбор сочинения →» со ссылкой
      на отчёт), а не зелёный блок с навигацией.
   6. «Взять другое» откладывает текст (localStorage, без XP и попыток);
      последнее недописанное не отпускает — дальше только новый круг.
   7. Гость/офлайн вход не ломают: решает локальное.
   8. Старые многозадачные сессии (localStorage до переезда) продолжают
      жить по прежним правилам — новых таких не создаём.
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
  head: new FakeElement("html"),
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

/* Готовы 1, 2, 3, 5 и 6; 4, 7 и 8 не написаны. */
const WRITTEN = {
  re27_1: { status: "ready", submissionId: 8, clientId: "c-1", wordCount: 332 },
  re27_2: { status: "ready", submissionId: 10, clientId: "c-2", wordCount: 340 },
  re27_3: { status: "ready", submissionId: 12, clientId: "c-3", wordCount: 205 },
  re27_5: { status: "ready", submissionId: 13, clientId: "c-5", wordCount: 281 },
  re27_6: { status: "ready", submissionId: 14, clientId: "c-6", wordCount: 281 },
};
const ALL_READY = Object.fromEntries(
  ["re27_1", "re27_2", "re27_3", "re27_4", "re27_5", "re27_6", "re27_7", "re27_8"]
    .map((id, i) => [id, { status: "ready", submissionId: 100 + i, clientId: `c-${id}`, wordCount: 300 }])
);
const readySubmission = (taskId, over = {}) => ({
  submissionId: (WRITTEN[taskId] || ALL_READY[taskId] || {}).submissionId || 1,
  taskId,
  skill: "russian_essay_source",
  subject: "russian",
  wordCount: 300,
  clientId: `c-${taskId}`,
  status: "ready",
  text: "Счастливым можно считать человека, который нашёл дело по душе и сохранил верных друзей рядом.",
  result: { total_score: 16, max_score: 22, criteria: [] },
  ...over,
});

/* guest: сервер отвечает 401 (профиля нет) и карты не будет. */
function makeFetch({ guest = false, fail = false, statuses = WRITTEN } = {}) {
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
        if (taskId) {
          const id = decodeURIComponent(taskId);
          if (statuses[id] && statuses[id].status === "ready") {
            return json({ ok: true, subject: "russian", submission: readySubmission(id, statuses[id]) });
          }
          if (statuses[id]) {
            return json({
              ok: true, subject: "russian",
              submission: { ...readySubmission(id), ...statuses[id], status: statuses[id].status },
            });
          }
        }
        return json({ error: "Сочинение не найдено" }, 404);
      }
      throw new Error("essay-nav test must not perform network I/O: " + u);
    },
  };
}

function buildSandbox(options) {
  elements.clear();
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
    [read("js/data.js"), read("js/state.js"), read("js/ai-limit.js"), read("js/app.js")].join("\n"),
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
    globalThis.__goCalls = [];
    globalThis.__toasts = [];
    go = (route, param) => { globalThis.__goCalls.push([route, param || null]); };
    toast = (html) => { globalThis.__toasts.push(String(html)); };
    if (typeof EssayStatuses !== "undefined") { EssayStatuses.subject = ""; EssayStatuses.map = null; EssayStatuses.inflight = ""; }
  `, sandbox);
  return { sandbox, net };
}

const flush = async (times = 8) => { for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0)); };
const run = (sandbox, code) => vm.runInContext(code, sandbox);

/* Вход в практику: какая сессия создана. */
const enterPractice = async (sandbox) => {
  await run(sandbox, `startEssayPractice("russian_essay_source")`);
  await flush();
  return run(sandbox, `({
    taskIds: Session.cur ? Session.cur.taskIds.slice() : null,
    mode: Session.cur ? Session.cur.mode : null,
    title: Session.cur ? Session.cur.title : null,
  })`);
};

/* Состояние экрана одиночной сессии. */
const singleScreenOf = (sandbox) => run(sandbox, `(() => {
  const slot = document.getElementById("essayNavSlot");
  const head = document.getElementById("screen").innerHTML;
  return {
    task: Session.task().id,
    navRow: slot ? slot.innerHTML : "",
    headCounter: head.includes("session-head__progress"),
    headSlash: /\\/\\s*\\d/.test(head),
    takeAnother: head.includes("essayTakeAnother()"),
    skip: head.includes("sessionSkip()"),
  };
})()`);

async function main() {
  /* ---------- 1. Вход выбирает первое недописанное ---------- */
  {
    const { sandbox, net } = buildSandbox({});
    const entered = await enterPractice(sandbox);
    check("вход с готовыми 1,2,3,5,6 — сессия из одного задания re27_4",
      entered.taskIds && entered.taskIds.join(",") === "re27_4" && entered.mode === "quick",
      JSON.stringify(entered));
    check("карта готовых запрошена свежая (statuses=1)",
      net.calls.filter((u) => /[?&]statuses=1/.test(u)).length >= 1,
      String(net.calls.filter((u) => /statuses=1/.test(u)).length));
  }
  {
    const { sandbox } = buildSandbox({ statuses: {} });
    const entered = await enterPractice(sandbox);
    check("чистый аккаунт — первое задание re27_1",
      entered.taskIds && entered.taskIds.join(",") === "re27_1", JSON.stringify(entered));
  }
  {
    const { sandbox } = buildSandbox({ statuses: ALL_READY });
    const entered = await enterPractice(sandbox);
    check("всё готово — новый круг с re27_1",
      entered.taskIds && entered.taskIds.join(",") === "re27_1", JSON.stringify(entered));
    const toasts = run(sandbox, `globalThis.__toasts.join(" | ")`);
    check("новый круг объявляется тостом", /Новый круг/.test(toasts), toasts);
  }

  /* ---------- 2. Активная недописанная возвращается ---------- */
  {
    const { sandbox } = buildSandbox({});
    await enterPractice(sandbox); // [re27_4]
    run(sandbox, `globalThis.__cur1 = Session.cur; globalThis.__goCalls = [];`);
    await enterPractice(sandbox); // повторный вход — та же сессия
    const intact = run(sandbox, `Session.cur === globalThis.__cur1 && Session.cur.taskIds.join(",") === "re27_4"`);
    const wentSession = run(sandbox, `globalThis.__goCalls.some((c) => c[0] === "session")`);
    check("активная недописанная: та же сессия, переход в неё",
      intact === true && wentSession === true, `intact=${intact} go=${wentSession}`);
  }

  /* ---------- 3. Одиночный экран: нет навигации и счётчиков ---------- */
  {
    const { sandbox } = buildSandbox({ statuses: {} });
    await enterPractice(sandbox); // [re27_1]
    run(sandbox, `renderTask(document.getElementById("screen"))`);
    await flush();
    const st = singleScreenOf(sandbox);
    check("нет ряда навигации", st.navRow === "", JSON.stringify(st.navRow).slice(0, 80));
    check("нет счётчика N/8", st.headCounter === false && st.headSlash === false,
      `counter=${st.headCounter} slash=${st.headSlash}`);
    check("есть «Взять другое», нет «Пропустить»",
      st.takeAnother === true && st.skip === false, `take=${st.takeAnother} skip=${st.skip}`);
  }

  /* ---------- 4. Пропуски: в конец очереди, потом сгорают ---------- */
  {
    const { sandbox } = buildSandbox({});
    run(sandbox, `localStorage.setItem("ege_essay_skipped",
      JSON.stringify({ "testnav:russian": ["re27_4"] }))`);
    const entered = await enterPractice(sandbox);
    check("пропущенное re27_4 отложено — вход даёт re27_7",
      entered.taskIds && entered.taskIds.join(",") === "re27_7", JSON.stringify(entered));
  }
  {
    const { sandbox } = buildSandbox({});
    await enterPractice(sandbox); // [re27_4]
    run(sandbox, `renderTask(document.getElementById("screen"))`);
    await flush();
    run(sandbox, `essayTakeAnother()`);
    const after = run(sandbox, `({
      cur: Session.cur,
      skipped: JSON.parse(localStorage.getItem("ege_essay_skipped") || "{}"),
    })`);
    check("«Взять другое» закрывает сессию и откладывает текст",
      after.cur === null
      && ((after.skipped["testnav:russian"] || []).join(",") === "re27_4"),
      JSON.stringify(after.skipped));
    const entered = await enterPractice(sandbox);
    check("следующий вход — re27_7, а не отложенное",
      entered.taskIds && entered.taskIds.join(",") === "re27_7", JSON.stringify(entered));
  }
  {
    const { sandbox } = buildSandbox({});
    run(sandbox, `localStorage.setItem("ege_essay_skipped",
      JSON.stringify({ "testnav:russian": ["re27_4", "re27_7", "re27_8"] }))`);
    const entered = await enterPractice(sandbox);
    check("все недописанные отложены — пропуски сгорели, снова re27_4",
      entered.taskIds && entered.taskIds.join(",") === "re27_4", JSON.stringify(entered));
    const cleared = run(sandbox, `localStorage.getItem("ege_essay_skipped")`);
    check("сгоревшие пропуски убраны из хранилища",
      !JSON.parse(cleared)["testnav:russian"] || !JSON.parse(cleared)["testnav:russian"].length,
      cleared);
  }
  {
    // 7 из 8 готовы, осталось re27_8: отпускать некуда.
    const seven = Object.fromEntries(Object.entries(ALL_READY).filter(([id]) => id !== "re27_8"));
    const { sandbox } = buildSandbox({ statuses: seven });
    await enterPractice(sandbox);
    run(sandbox, `renderTask(document.getElementById("screen"))`);
    await flush();
    run(sandbox, `globalThis.__toasts = []; essayTakeAnother();`);
    const stayed = run(sandbox, `!!Session.cur && Session.cur.taskIds.join(",") === "re27_8"`);
    const warned = run(sandbox, `globalThis.__toasts.join(" | ")`);
    check("последнее недописанное не отпускает (тост, сессия жива)",
      stayed === true && /последнее/i.test(warned), warned);
  }

  /* ---------- 5. Готовая проверка — сразу итоговый экран ---------- */
  {
    const { sandbox } = buildSandbox({ statuses: {} });
    await enterPractice(sandbox); // [re27_1]
    run(sandbox, `renderTask(document.getElementById("screen"))`);
    await flush();
    run(sandbox, `essayFinishReady(Session.task(), {
      submissionId: 77, clientId: "c-new", taskId: "re27_1", skill: "russian_essay_source",
      subject: "russian", wordCount: 200, status: "ready",
      text: "Счастливым можно считать человека, который нашёл дело по душе.",
      result: { total_score: 16, max_score: 22, criteria: [] },
    }, "текст", 200, 30)`);
    await flush();
    const fin = run(sandbox, `({
      curNull: Session.cur === null,
      html: document.getElementById("screen").innerHTML,
    })`);
    check("сессия закрыта итоговым экраном", fin.curNull === true
      && fin.html.includes("ТРЕНИРОВКА ЗАВЕРШЕНА"), fin.html.slice(0, 120));
    check("на итоговом экране кнопка разбора со ссылкой на отчёт",
      fin.html.includes("Разбор сочинения") && fin.html.includes("/essay/77"),
      fin.html.slice(fin.html.indexOf("Разбор"), fin.html.indexOf("Разбор") + 120));
    check("XP начислен", /\+\d+ XP/.test(fin.html), (fin.html.match(/\+\d+ XP/) || [])[0] || "");
  }

  /* ---------- 6. Новый круг: старый готовый отчёт не блокирует бланк ---------- */
  {
    const { sandbox } = buildSandbox({ statuses: ALL_READY });
    await enterPractice(sandbox); // [re27_1], новый круг
    run(sandbox, `renderTask(document.getElementById("screen"))`);
    await flush(); // essayRestoreReady подтянет СТАРЫЙ ready — бланк должен уцелеть
    const head = run(sandbox, `document.getElementById("screen").innerHTML`);
    const feedback = run(sandbox, `document.getElementById("feedbackSlot").innerHTML`);
    check("в новом круге редактор не подменён старым отчётом",
      !feedback.includes("уже проверено") && head.includes("essayTakeAnother()"),
      feedback.slice(0, 100));
  }

  /* ---------- 7. Гость и офлайн ---------- */
  {
    const { sandbox } = buildSandbox({ guest: true });
    const entered = await enterPractice(sandbox);
    check("гость: вход не падает, первое задание",
      entered.taskIds && entered.taskIds.join(",") === "re27_1", JSON.stringify(entered));
  }
  {
    const { sandbox } = buildSandbox({ fail: true });
    const entered = await enterPractice(sandbox);
    check("офлайн: вход не падает, решает локальное",
      entered.taskIds && entered.taskIds.join(",") === "re27_1", JSON.stringify(entered));
  }

  /* ---------- 8. Кнопка отправки прячется, когда есть что продолжать ---------- */
  {
    const { sandbox } = buildSandbox({ statuses: {} });
    await enterPractice(sandbox); // [re27_1]
    run(sandbox, `
      globalThis.__submitWrap = { style: {} };
      document.querySelector = (sel) => sel === ".essay-editor__submit" ? globalThis.__submitWrap : null;
      renderTask(document.getElementById("screen"));
    `);
    await flush();
    const freshVisible = run(sandbox, `globalThis.__submitWrap.style.display || ""`);
    check("чистый бланк: кнопка отправки видна", freshVisible !== "none", freshVisible);
    // Неудачная проверка: текст сохранён, результата нет.
    run(sandbox, `globalThis.__draft = Array(200).fill("слово").join(" ")`);
    run(sandbox, `
      Session.cur.essayReadyByTask = { re27_1: { text: globalThis.__draft, wordCount: 200, status: "submitted", clientId: "c-x" } };
      Session.cur.essayDraftByTask = { re27_1: globalThis.__draft };
      renderTask(document.getElementById("screen"));
    `);
    await flush();
    check("неудача: дубль отправки спрятан", run(sandbox, `globalThis.__submitWrap.style.display`) === "none");
    // Правка после неудачи — уже новая работа: кнопка возвращается.
    run(sandbox, `
      document.getElementById("essayInput").value = globalThis.__draft + " ещё";
      essaySyncSubmitVisibility(Session.task());
    `);
    check("правка текста возвращает кнопку отправки",
      run(sandbox, `globalThis.__submitWrap.style.display`) !== "none");
    // Resume-блок — единственное действие.
    run(sandbox, `
      document.getElementById("essayInput").value = globalThis.__draft;
      essayMountResumeFeedback(Session.task());
    `);
    const mounted = run(sandbox, `document.getElementById("feedbackSlot").innerHTML`);
    check("блок «Проверка не завершена» предлагает продолжить",
      mounted.includes("Продолжить проверку"), mounted.slice(0, 80));
    check("после resume-блока дубль отправки снова спрятан",
      run(sandbox, `globalThis.__submitWrap.style.display`) === "none");
  }

  /* ---------- 9. Старые многозадачные сессии живут как раньше ---------- */
  {
    const { sandbox } = buildSandbox({});
    run(sandbox, `
      Session.start({ title: "Тренировка: Сочинение", taskIds: ESSAY_IDS(), mode: "quick" });
      function ESSAY_IDS() { return DataAPI.practiceTasksBySkill("russian_essay_source").map((t) => t.id); }
      renderTask(document.getElementById("screen"));
    `);
    await flush();
    const row = run(sandbox, `document.getElementById("essayNavSlot").innerHTML`);
    check("многозадачная сессия по-прежнему рисует ряд навигации",
      row.includes("sessionNext()") && row.includes("Далее →"), row.slice(0, 100));
  }

  console.log(failures ? `\n${failures} FAILURES` : "\nALL OK");
  process.exit(failures ? 1 : 0);
}

main();
