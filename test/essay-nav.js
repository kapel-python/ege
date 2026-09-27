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
   5. Готовая проверка одиночной сессии — зелёный блок отчёта, а единственное
      действие визита «Завершить →» стоит ОТДЕЛЬНОЙ строкой ПОД блоком (как
      в остальных предметах), а не внутри него; на чистом бланке и на неудачной
      проверке такой строки нет вовсе. Кнопка закрывает визит итоговым
      экраном (ТРЕНИРОВКА ЗАВЕРШЕНА, +XP, «Разбор сочинения →» со ссылкой
      на отчёт).
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

/* Слоты, созданные отрисовкой карточки, хранят в себе вложенные узлы
   (например #feedbackSlot). Настоящий DOM так не делает — getElementById
   всегда возвращает живой элемент, — а тестовый без этого терял бы
   содержимое слотов при перечитывании. */
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
    this._nodes = {};
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
  set innerHTML(v) {
    this._innerHTML = String(v);
    this.children = [];
    // Вложенные слоты (id="...") переживают перерисовку: настоящий DOM
    // держит их живыми, тестовый обязан вести себя так же, иначе код,
    // монтирующий отчёт в #feedbackSlot, терял бы адресат.
    this._nodes = {};
    for (const m of this._innerHTML.matchAll(/id="([A-Za-z][\w-]*)"/g)) {
      const child = new FakeElement("div");
      child.setAttribute("id", m[1]);
      this._nodes[m[1]] = child;
    }
    // Кнопка «Взять другое» — по onclick, не по id: её ищет querySelector.
    // Обработчик у кнопки — подтверждение askEssayTakeAnother (прямое действие
    // essayTakeAnother зовёт уже оно), поэтому регексп ловит именно его.
    const take = /<button[^>]*onclick="askEssayTakeAnother\(\)"/.exec(this._innerHTML);
    if (take) {
      const btn = new FakeElement("button");
      btn.setAttribute("onclick", "askEssayTakeAnother()");
      this._nodes.__takeAnother = btn;
    }
  }
  get innerHTML() {
    // Возвращаем разметку вместе с содержимым слотов — как в браузере,
    // где их текст является частью #screen.innerHTML.
    let html = this._innerHTML;
    for (const [id, child] of Object.entries(this._nodes)) {
      if (!child._innerHTML) continue;
      html = html.replace(`id="${id}"`, `id="${id}" data-slot="${id}">${child._innerHTML.replace(/^/, "")}`);
    }
    return html;
  }
  _slot(id) {
    if (!this._nodes[id]) {
      const child = new FakeElement("div");
      child.setAttribute("id", id);
      this._nodes[id] = child;
    }
    return this._nodes[id];
  }
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
/* Вложенный слот отрисованной карточки (напр. #feedbackSlot из разметки
   #screen) и есть тот же узел, что getElementById вернёт в браузере. */
const findInTree = (root, id) => {
  if (root._nodes && root._nodes[id]) return root._nodes[id];
  for (const c of root.children) {
    const hit = findInTree(c, id);
    if (hit) return hit;
  }
  return null;
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
  getElementById: (id) => findInTree(elements.get("screen") || document.body, id) || element(id),
  querySelector: (sel) => {
    const m = /^\[onclick="([^"]+)"\]$/.exec(String(sel || ""));
    if (m && /EssayTakeAnother/.test(m[1])) {
      return findInTree(elements.get("screen") || document.body, "__takeAnother") || null;
    }
    return null;
  },
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
    takeAnother: head.includes("askEssayTakeAnother()"),
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
    // ALL_READY: чем больше submissionId, тем свежее отчёт. Самый свежий
    // (re27_8) в новом круге переписывается первым.
    check("всё готово — новый круг начинается со САМОГО СВЕЖЕГО отчёта (re27_8)",
      entered.taskIds && entered.taskIds.join(",") === "re27_8", JSON.stringify(entered));
  }
  {
    // Прогресс второго круга: re27_1 только что переписано (submissionId 37 —
    // меньше прежних, отчёт устарел), остальные готовые — свежее. Значит
    // re27_1 уходит в конец, а не предлагается снова.
    const cycle2 = {
      ...ALL_READY,
      re27_1: { status: "ready", submissionId: 37, clientId: "c-1b", wordCount: 310 },
    };
    const { sandbox } = buildSandbox({ statuses: cycle2 });
    const entered = await enterPractice(sandbox);
    check("переписанное уходит в конец, а не предлагается снова (re27_8)",
      entered.taskIds && entered.taskIds.join(",") === "re27_8", JSON.stringify(entered));
  }
  {
    // Свежий отчёт у re27_2 — вот его и предлагаем первым.
    const cycle2b = {
      ...ALL_READY,
      re27_2: { status: "ready", submissionId: 999, clientId: "c-2b", wordCount: 320 },
    };
    const { sandbox } = buildSandbox({ statuses: cycle2b });
    const entered = await enterPractice(sandbox);
    check("свежее всего переписанное (re27_2) идёт первым",
      entered.taskIds && entered.taskIds.join(",") === "re27_2", JSON.stringify(entered));
  }
  {
    // Отправленное, но не проверенное — продолжить его, а не начинать чистое.
    const { sandbox } = buildSandbox({
      statuses: { re27_4: { status: "submitted", submissionId: 41, clientId: "c-4", wordCount: 250 } },
    });
    const entered = await enterPractice(sandbox);
    check("недоведённое (submitted) — вернуться в него раньше чистых",
      entered.taskIds && entered.taskIds.join(",") === "re27_4", JSON.stringify(entered));
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
    const dlg = () => run(sandbox, `(() => {
      const root = document.getElementById("device-modal-root");
      return root ? root.innerHTML : "";
    })()`);
    const alive = () => run(sandbox, `Session.cur ? Session.cur.taskIds.join(",") : "сессии нет"`);
    // Клик по кнопке — подтверждение, а не действие: тот же .dlg, что у
    // «Выйти» в шапке, пока ничего не отложено.
    run(sandbox, `askEssayTakeAnother()`);
    const d = dlg();
    check("клик открывает общее окно подтверждения, а не откладывает сразу",
      d.includes("dlg-backdrop") && d.includes("Взять другое сочинение?")
      && d.includes("Практика сочинений") && d.includes("Остаться")
      && d.includes("Взять другое") && alive() === "re27_4", d.slice(0, 200));
    check("окно честно говорит про черновик (в редакторе пусто)",
      /Эта тема уйдёт в конец очереди/.test(d) && !/черновик пропадёт/.test(d),
      d.replace(/<[^>]+>/g, " ").trim().slice(0, 220));
    run(sandbox, `closeDeviceModal()`);
    check("«Остаться» (закрытие окна) ничего не откладывает",
      alive() === "re27_4" && !run(sandbox, `localStorage.getItem("ege_essay_skipped")`),
      alive());
    // Тот же путь с написанным черновиком: он сгорает, и об этом сказано прямо.
    run(sandbox, `document.getElementById("essayInput").value = Array(20).fill("слово").join(" ");`);
    run(sandbox, `askEssayTakeAnother()`);
    const dDraft = dlg();
    check("с черновиком окно предупреждает, что он пропадёт",
      /Несохранённый черновик пропадёт/.test(dDraft),
      dDraft.replace(/<[^>]+>/g, " ").trim().slice(0, 240));
    // Подтверждение — прямой вызов essayTakeAnother: откладывает и открывает
    // следующее сочинение.
    run(sandbox, `dlgConfirmOk()`);
    const after = run(sandbox, `({
      cur: Session.cur,
      dlg: document.getElementById("device-modal-root").innerHTML,
      skipped: JSON.parse(localStorage.getItem("ege_essay_skipped") || "{}"),
    })`);
    check("подтверждение закрывает сессию и откладывает текст",
      after.cur === null && after.dlg === ""
      && ((after.skipped["testnav:russian"] || []).join(",") === "re27_4"),
      JSON.stringify(after));
    await flush();
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
    check("последнее недоведённое не отпускает (тост, сессия жива)",
      stayed === true && /последн/i.test(warned), warned);
  }

  /* ---------- 5. Готовая проверка — блок отчёта, финиш кнопкой ---------- */
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
    const done = run(sandbox, `({
      alive: !!Session.cur,
      html: document.getElementById("screen").innerHTML,
      block: document.getElementById("feedbackSlot").innerHTML,
      nav: document.getElementById("essayNavSlot").innerHTML,
    })`);
    check("готовый разбор — сначала блок отчёта, а не редирект на финиш",
      done.alive === true && done.html.includes("Проверка завершена"), done.html.slice(0, 120));
    check("в блоке отчёта XP и кнопка разбора",
      /16 \/ 22/.test(done.html) && done.block.includes("Посмотреть результат")
      && !done.block.includes("Завершить"), done.block.slice(0, 200));
    check("«Завершить →» — отдельной строкой ПОД блоком (как в остальных предметах)",
      done.nav.includes("Завершить →") && done.nav.includes("sessionFinish()")
      && done.nav.includes("session-nav")
      && done.html.indexOf("Проверка завершена") < done.html.indexOf("Завершить →"),
      done.nav.slice(0, 160));
    run(sandbox, `sessionFinish()`);
    await flush();
    const fin = run(sandbox, `({
      curNull: Session.cur === null,
      html: document.getElementById("screen").innerHTML,
    })`);
    check("кнопка «Завершить» закрывает визит итоговым экраном", fin.curNull === true
      && fin.html.includes("ТРЕНИРОВКА ЗАВЕРШЕНА"), fin.html.slice(0, 120));
    check("на итоговом экране кнопка разбора со ссылкой на отчёт",
      fin.html.includes("Разбор сочинения") && fin.html.includes("/essay/77"),
      fin.html.slice(fin.html.indexOf("Разбор"), fin.html.indexOf("Разбор") + 120));
    check("XP начислен", /\+\d+ XP/.test(fin.html), (fin.html.match(/\+\d+ XP/) || [])[0] || "");
  }

  /* ---------- 6. Новый круг: бланк чистый, но с пометкой о прошлом разборе ---------- */
  {
    const { sandbox } = buildSandbox({ statuses: ALL_READY });
    const entered = await enterPractice(sandbox); // самый свежий отчёт = re27_8
    const taskId = entered.taskIds[0];
    run(sandbox, `renderTask(document.getElementById("screen"))`);
    await flush(); // essayRestoreReady подтянет СТАРЫЙ ready — бланк должен уцелеть
    const head = run(sandbox, `document.getElementById("screen").innerHTML`);
    const feedback = run(sandbox, `document.getElementById("feedbackSlot").innerHTML`);
    check("в новом круге редактор не подменён старым отчётом",
      !feedback.includes("уже проверено") && head.includes("askEssayTakeAnother()"),
      feedback.slice(0, 100));
    const pastId = run(sandbox, `(EssayStatuses.map["${taskId}"] || {}).submissionId`);
    check("визит помечен как повторный, со ссылкой на прошлый разбор",
      head.includes("уже было проверено") && head.includes("/essay/" + pastId),
      `task=${taskId} pastId=${pastId} head=${head.slice(0, 160)}`);
  }

  /* ---------- 7. Перезагрузка возвращает к заданию, а не в конец практики ---------- */
  {
    const { sandbox } = buildSandbox({ statuses: ALL_READY });
    const entered = await enterPractice(sandbox);
    const taskId = entered.taskIds[0];
    // НОВЫЙ КРУГ: все 8 готовы, визит попал на переписанное первым. Локальных
    // меток у визита нет, и restore не должен их заводить: его собственная
    // запись на следующей перезагрузке выглядела бы как «свой визит» —
    // визит улетал бы на финиш, а «Взять другое» становилась мёртвой.
    run(sandbox, `renderTask(document.getElementById("screen"))`);
    await flush();
    const newCycle = run(sandbox, `({
      written: Object.keys(Session.cur.essayWrittenByTask || {}).join(","),
      readyByTask: Object.keys(Session.cur.essayReadyByTask || {}).join(","),
      alive: !!Session.cur,
    })`);
    check("новый круг: restore не оставляет меток (иначе перезагрузка = финиш)",
      newCycle.alive && !newCycle.written && !newCycle.readyByTask, JSON.stringify(newCycle));

    // ПЕРЕЗАГРУЗКА без отправки: то же задание, финиша нет.
    run(sandbox, `renderTask(document.getElementById("screen"))`);
    await flush();
    const afterReload = run(sandbox, `({
      task: Session.cur ? Session.cur.taskIds.join(",") : null,
      html: document.getElementById("screen").innerHTML,
    })`);
    check("перезагрузка без отправки возвращает к тому же заданию, не к финишу",
      afterReload.task === taskId
        && !afterReload.html.includes("ТРЕНИРОВКА ЗАВЕРШЕНА")
        && afterReload.html.includes("askEssayTakeAnother()"),
      JSON.stringify({ task: afterReload.task, fin: afterReload.html.includes("ТРЕНИРОВКА ЗАВЕРШЕНА") }));
  }
  {
    const { sandbox } = buildSandbox({ statuses: ALL_READY });
    const entered = await enterPractice(sandbox);
    const taskId = entered.taskIds[0];
    // ЭТОТ ЖЕ визит отправлял: метки от отправки пережили перезагрузку,
    // проверка успела завершиться. Экран потерян — возвращаем зелёный блок
    // с кнопками, а НЕ итог практики: в остальных предметах перезагрузка
    // возвращает к текущему заданию.
    run(sandbox, `
      Session.cur.results = [];
      Session.cur.essayReadyByTask = {};
      Session.cur.essayWrittenByTask = { "${taskId}": { clientId: "c-z", wordCount: 300, status: "ready" } };
      renderTask(document.getElementById("screen"));
    `);
    await flush();
    const fin = run(sandbox, `({
      curNull: Session.cur === null,
      html: document.getElementById("screen").innerHTML,
      block: document.getElementById("feedbackSlot").innerHTML,
      nav: document.getElementById("essayNavSlot").innerHTML,
    })`);
    check("после отправки и перезагрузки — блок отчёта, а не конец практики",
      fin.curNull === false && fin.html.includes("Проверка завершена")
        && !fin.html.includes("ТРЕНИРОВКА ЗАВЕРШЕНА"), fin.html.slice(0, 160));
    check("восстановленный блок — только разбор, «Завершить →» строкой ниже",
      fin.block.includes("Посмотреть результат") && !fin.block.includes("Завершить")
        && fin.nav.includes("Завершить →")
        && !/\+\d+ XP/.test(fin.html),
      fin.block.slice(0, 200));
    // Повторная перезагрузка того же состояния — тот же экран (идемпотентно).
    run(sandbox, `renderTask(document.getElementById("screen"))`);
    await flush();
    const again = run(sandbox, `({
      curNull: Session.cur === null,
      html: document.getElementById("screen").innerHTML,
      nav: document.getElementById("essayNavSlot").innerHTML,
    })`);
    check("ещё одна перезагрузка не ломает экран (блок на месте, визит жив)",
      again.curNull === false && again.html.includes("Проверка завершена"), again.html.slice(0, 120));
    check("после повторной перезагрузки «Завершить →» тоже на месте",
      again.nav.includes("Завершить →"), again.nav.slice(0, 120));
  }

  /* ---------- 8. Гость и офлайн ---------- */
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

  /* ---------- 9. «Взять другое» гаснет, когда откладывать нечего ---------- */
  {
    const { sandbox } = buildSandbox({ statuses: {} });
    await enterPractice(sandbox); // [re27_1]
    run(sandbox, `renderTask(document.getElementById("screen"))`);
    await flush();
    const takeBtn = () => run(sandbox, `(() => {
      const b = document.querySelector('[onclick="askEssayTakeAnother()"]');
      return b ? (b.style.display || "") : "нет кнопки";
    })()`);
    check("чистый бланк: кнопка видна", takeBtn() !== "none" && takeBtn() !== "нет кнопки", takeBtn());
    const navRow = () => run(sandbox, `document.getElementById("essayNavSlot").innerHTML`);
    check("чистый бланк: строки «Завершить →» нет (закрывать нечего)",
      !navRow().includes("Завершить"), navRow().slice(0, 100));
    // Старая готовая работа по ЭТОМУ ЖЕ заданию не должна делать кнопку
    // мёртвой: карта про текущий визит в метки не попадает (видит их сам
    // визит), иначе «Взять другое» молча ничего не делал бы.
    run(sandbox, `
      essayStatusesApply({ re27_1: { status: "ready", submissionId: 5, clientId: "c-x", wordCount: 200 } });
    `);
    await flush();
    check("старая готовая работа не делает «Взять другое» мёртвой",
      takeBtn() !== "none" && takeBtn() !== "нет кнопки", takeBtn());
    check("чужая готовая работа «Завершить →» не протаскивает",
      !navRow().includes("Завершить"), navRow().slice(0, 100));
    // А вот реальная сохранённая работа сессии (отправлено в этом визите) —
    // кнопку гасит: откладывать уже нечего.
    run(sandbox, `
      Session.cur.essayReadyByTask = { re27_1: { text: "текст", wordCount: 200, status: "submitted", clientId: "c-y" } };
      essaySyncTakeAnotherVisibility(Session.task());
    `);
    await flush();
    check("сохранённая работа сессии прячет кнопку",
      takeBtn() === "none", takeBtn());
  }
  {
    // Сценарий ученика с полным кругом: все 8 тем проверены, он зашёл в новый
    // круг, карта принесла готовый отчёт по текущему заданию — и «Взять
    // другое» обязана РЕАЛЬНО откладывать текст, а не молча выходить.
    const { sandbox } = buildSandbox({ statuses: ALL_READY });
    const entered = await enterPractice(sandbox);
    const first = entered.taskIds[0];
    run(sandbox, `renderTask(document.getElementById("screen"))`);
    await flush();
    run(sandbox, `Session.cur.essayDraftByTask = { "${first}": "черновик визита" }`);
    const vis = run(sandbox, `(() => {
      const b = document.querySelector('[onclick="askEssayTakeAnother()"]');
      return b ? (b.style.display || "") : "нет кнопки";
    })()`);
    check("новый круг: «Взять другое» видна, хотя про тему есть готовый отчёт",
      vis !== "none" && vis !== "нет кнопки", vis);
    run(sandbox, `essayTakeAnother()`);
    await flush();
    const after = run(sandbox, `Session.cur ? Session.cur.taskIds.join(",") : "сессии нет"`);
    check("клик по «Взять другое» в новом круге откладывает текст и берёт другое",
      after !== first && after !== "сессии нет", `было ${first}, стало ${after}`);
    check("отложенный визит чистый: прошлый отчёт не вылез отчётом",
      run(sandbox, `!document.getElementById("feedbackSlot").innerHTML.includes("уже проверено")`));
  }

  /* ---------- 10. Кнопка отправки прячется, когда есть что продолжать ---------- */
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
  {
    // Жалоба ученика: в новом круге (все 8 тем проверены) после набора текста
    // кнопка «Отправить сочинение» исчезала. Причина — restore заводил метки
    // по текущему заданию из прошлого разбора, и сохранённый старый текст
    // сравнивался с новым. Свежая карта не должна влиять на отправку.
    const { sandbox } = buildSandbox({ statuses: ALL_READY });
    await enterPractice(sandbox);
    run(sandbox, `
      globalThis.__submitWrap2 = { style: {} };
      document.querySelector = (sel) => sel === ".essay-editor__submit" ? globalThis.__submitWrap2 : null;
      renderTask(document.getElementById("screen"));
    `);
    await flush();
    const t0 = run(sandbox, `Session.cur.taskIds.join(",")`);
    run(sandbox, `
      document.getElementById("essayInput").value = Array(200).fill("новое").join(" ");
      essaySyncSubmitVisibility(Session.task());
    `);
    const shown = run(sandbox, `globalThis.__submitWrap2.style.display || ""`);
    check("новый круг: кнопка отправки видна и после набора текста",
      shown !== "none", `task=${t0} display="${shown}"`);
    const sendBtn = run(sandbox, `(() => {
      const b = document.getElementById("essaySubmitBtn");
      return b ? { disabled: !!b.disabled, inDom: true } : { inDom: false };
    })()`);
    check("кнопка «Отправить сочинение» на месте в DOM нового круга",
      sendBtn.inDom === true, JSON.stringify(sendBtn));
  }

  /* ---------- 11. Старые многозадачные сессии живут как раньше ---------- */
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
