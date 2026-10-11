/* Состояние карточки практики: XP за пропуск, накопление подсказок,
   «Показать решение» без затирания своего ответа и полное восстановление
   снапшота после «перезагрузки» (F5) и «Назад»/«Вперёд».

   Реальные js/data.js + js/state.js + js/app.js в браузерной VM:
   1. Пропуск не приносит XP вовсе (анти-фарм: «пропустить всё» не должен
      платить минимум за каждую тему), попытка фиксируется со флагом
      skipped и уводит задание в повторение.
   2. Подсказки открываются одна за другой и остаются на экране ВСЕ
      (вторая — после первой, а не вместо неё).
   3. «Показать решение» НЕ перезаписывает поле ввода ученика: свой ответ
      остаётся, верный виден в блоке решения; поле блокируется.
   4. Снапшот карточки (подсказки, черновик, решение, пропуски) и
      результаты сессии переживают F5: restoreSessionFromStorage +
      renderTask возвращают карточку ровно в том состоянии.
   5. «Назад»/«Вперёд» по сессии показывают сохранённые состояния.
*/
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const catalog = JSON.parse(read("server/catalog.json"));

let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${cond || !detail ? "" : ` | ${detail}`}`);
  if (!cond) failures += 1;
};

/* DOM: слоты с id и input-ы живут ВНУТРИ разметки #screen — innerHTML
   парсится в живые узлы (как в браузере), клетки ответ-таблицы ищутся
   по [data-match-cell]. */
class FakeElement {
  constructor(tagName = "div") {
    this.tagName = String(tagName || "div").toUpperCase();
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.attributes = {};
    this._innerHTML = "";
    this._nodes = {};
    this.__match = null;
    const classes = new Set();
    this.classList = {
      add: (...n) => n.forEach((x) => classes.add(x)),
      remove: (...n) => n.forEach((x) => classes.delete(x)),
      contains: (n) => classes.has(n),
      toggle: (n, f) => { const on = f === undefined ? !classes.has(n) : !!f; if (on) classes.add(n); else classes.delete(n); return on; },
    };
  }
  set innerHTML(v) {
    this._innerHTML = String(v);
    this._nodes = {};
    const inputs = [];
    const re = /<input\b[^>]*>/g;
    let m;
    while ((m = re.exec(this._innerHTML)) !== null) {
      const tag = m[0];
      const attr = (a) => { const r = new RegExp("\\b" + a + '="([^"]*)"').exec(tag); return r ? r[1] : null; };
      inputs.push({ id: attr("id"), match: attr("data-match-cell"), value: attr("value") || "", disabled: /\bdisabled\b/.test(tag) });
    }
    const rest = this._innerHTML.replace(/<input\b[^>]*>/g, "");
    for (const mm of rest.matchAll(/id="([A-Za-z][\w-]*)"/g)) {
      const child = new FakeElement("div");
      child.setAttribute("id", mm[1]);
      this._nodes[mm[1]] = child;
    }
    for (const inp of inputs) {
      const node = new FakeElement("input");
      node.value = inp.value;
      node.disabled = inp.disabled;
      if (inp.id) { node.setAttribute("id", inp.id); this._nodes[inp.id] = node; }
      if (inp.match != null) {
        node.setAttribute("data-match-cell", inp.match);
        node.__match = Number(inp.match);
        this._nodes["__match" + inp.match] = node;
      }
    }
  }
  get innerHTML() { return this._innerHTML; }
  appendChild(c) { return c; }
  remove() {}
  setAttribute(n, v) { this.attributes[n] = String(v); }
  getAttribute(n) { return this.attributes[n] ?? null; }
  removeAttribute(n) { delete this.attributes[n]; }
  addEventListener() {}
  removeEventListener() {}
  querySelector() { return null; }
  querySelectorAll(sel) {
    if (sel === "[data-match-cell]") {
      return Object.values(this._nodes)
        .filter((n) => n.__match != null)
        .sort((a, b) => a.__match - b.__match);
    }
    return [];
  }
  closest() { return null; }
  focus() {}
  select() {}
}

const noop = () => {};
const memoryStorage = () => {
  const values = new Map();
  return {
    getItem: (k) => (values.has(k) ? values.get(k) : null),
    setItem: (k, v) => values.set(k, String(v)),
    removeItem: (k) => values.delete(k),
    clear: () => values.clear(),
  };
};

function buildSandbox(cat, subject) {
  const screen = new FakeElement("div");  screen.setAttribute("id", "screen");
  const elements = new Map([["screen", screen]]);
  const findInTree = (id) => (screen._nodes && screen._nodes[id]) || null;
  const document = {
    readyState: "complete",
    title: "",
    hidden: false,
    activeElement: null,
    documentElement: new FakeElement("html"),
    head: new FakeElement("head"),
    body: new FakeElement("body"),
    createElement: (tag) => new FakeElement(tag),
    getElementById: (id) => {
      const hit = findInTree(id) || elements.get(id);
      if (hit) return hit;
      const made = new FakeElement("div");
      elements.set(id, made);
      return made;
    },
    querySelector: () => null,
    querySelectorAll: (sel) => screen.querySelectorAll(sel),
    addEventListener: noop,
    removeEventListener: noop,
  };
  const sandbox = {
    console: { log: noop, info: noop, warn: noop, error: noop, table: noop },
    setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
    requestAnimationFrame: () => 0, cancelAnimationFrame: noop,
    document,
    location: { hash: "#/session", href: "http://localhost/", origin: "http://localhost" },
    history: { replaceState: noop, pushState: noop },
    localStorage: memoryStorage(), sessionStorage: memoryStorage(),
    navigator: { userAgent: "session-persist-test", locks: {} },
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    scrollTo: noop,
    fetch: async () => { throw new Error("session-persist test must not perform network I/O"); },
    CustomEvent: class { constructor(t, i = {}) { this.type = t; this.detail = i.detail; } },
    Event: class { constructor(t) { this.type = t; } },
    MutationObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    crypto: require("crypto").webcrypto,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.addEventListener = noop;
  sandbox.removeEventListener = noop;
  sandbox.dispatchEvent = () => true;
  sandbox.HTMLElement = FakeElement;
  sandbox.__catalog = { ...cat, subject };
  sandbox.__subject = subject;
  vm.createContext(sandbox);
  vm.runInContext(
    [read("js/data.js"), read("js/state.js"), read("js/ai-limit.js"), read("js/app.js")].join("\n"),
    sandbox,
    { filename: "session-persist-bundle.js" }
  );
  vm.runInContext(`
    DataAPI.load(__catalog);
    Store.subject = __subject;
    Store.subjects = DataAPI.subjects();
    Store.ready = true;
    Store.state = Store.defaultState();
    Store.state.onboarded = true;
    Store.accountId = "session-persist";
    Store.save = () => Promise.resolve();
    Vendor.ensureMath = () => Promise.resolve();
    Vendor.loadScript = () => Promise.resolve();
    Session.cur = null; Lesson.cur = null;
    globalThis.__goCalls = [];
    go = (route, param) => { globalThis.__goCalls.push([route, param || null]); };
    toast = (html) => {};
    renderTopbar = () => {};
  `, sandbox, { timeout: 30000 });
  return { sandbox, screen };
}

const run = (sandbox, code) => vm.runInContext(code, sandbox, { timeout: 30000 });
const html = (sandbox, id) => run(sandbox, `(() => { const e = document.getElementById(${JSON.stringify(id)}); return e ? e.innerHTML : ""; })()`);

/* Один сценарий на трёх заданиях: A — пропуск, B — подсказки + решение,
   C — черновик. Проверки — снапшот после F5 и «Назад»/«Вперёд». */
function scenario(tasks, label, cat, subject) {
  const tag = `${label}/${tasks.map((t) => t.id).join("+")}`;
  const { sandbox } = buildSandbox(cat, subject);
  run(sandbox, `DataAPI.load(__catalog)`);
  const ids = tasks.map((t) => t.id);
  run(sandbox, `Session.start({ title: "Снапшот", taskIds: ${JSON.stringify(ids)}, mode: "practice" })`);
  run(sandbox, `renderTask(document.getElementById("screen"))`);

  const answer = String(tasks[1].answer ?? "");
  const answer0 = String(tasks[0].answer ?? "");
  const wrong0 = answer0.split("").map((d) => (d === "1" ? "0" : "1")).join("") || "9";
  const wrong = answer.split("").map((d) => (d === "1" ? "0" : "1")).join("") || "9";
  const setValue = (v) => run(sandbox, `(() => {
    const cells = document.querySelectorAll("[data-match-cell]");
    if (cells.length) { cells.forEach((c, i) => { c.value = String(${JSON.stringify(v)}[i] || ""); }); return; }
    const input = document.getElementById("answerInput");
    if (input) input.value = ${JSON.stringify(v)};
  })()`);
  const answerVal = () => run(sandbox, `sessionAnswerValue()`);
  const inputsDisabled = () => run(sandbox, `(() => {
    const cells = document.querySelectorAll("[data-match-cell]");
    if (cells.length) return cells.every((c) => c.disabled);
    const input = document.getElementById("answerInput");
    return input ? input.disabled : null;
  })()`);
  const reload = () => {
    run(sandbox, `Session.cur = null`);
    const ok = run(sandbox, `restoreSessionFromStorage("session", null)`);
    run(sandbox, `renderTask(document.getElementById("screen"))`);
    return ok;
  };

  /* --- 1. пропуск: 0 XP, попытка со флагом, задание уходит в повторение --- */
  const xpBefore = run(sandbox, `Store.state.xp`);
  run(sandbox, `sessionSkip()`);
  check(`${tag}: пропуск не начисляет XP`, run(sandbox, `Store.state.xp`) === xpBefore,
    `${xpBefore} -> ${run(sandbox, `Store.state.xp`)}`);
  check(`${tag}: пропуск записан как skipped-попытка`,
    run(sandbox, `(() => { const a = Store.state.taskAttempts[0]; return !!a && a.skipped === true && a.correct === false; })()`),
    JSON.stringify(run(sandbox, `(() => { const a = Store.state.taskAttempts[0]; return a && { skipped: a.skipped, correct: a.correct }; })()`)));
  check(`${tag}: после пропуска сессия на втором задании`, run(sandbox, `Session.cur.idx`) === 1);

  /* «Назад» на пропущенное: карточка ОЖИВАЕТ — пропуск не ответ, а пауза */
  run(sandbox, `sessionPrev()`);
  check(`${tag}: назад на пропущенное — карточка снова живая`,
    run(sandbox, `Session.cur.answered`) === false);
  check(`${tag}: назад на пропущенное — плашка «можно ответить»`,
    /У тебя это задание пропущено, но ты можешь на него ответить/.test(html(sandbox, "feedbackSlot")),
    html(sandbox, "feedbackSlot").replace(/<[^>]*>/g, "").slice(0, 80));
  check(`${tag}: назад на пропущенное — ввод доступен`, inputsDisabled() === false);
  check(`${tag}: F5 не запирает пропущенное задание`,
    reload() === true && run(sandbox, `Session.cur.answered`) === false
      && /можешь на него ответить/.test(html(sandbox, "feedbackSlot")),
    html(sandbox, "feedbackSlot").replace(/<[^>]*>/g, "").slice(0, 60));

  /* Ошибка на оживлённой карточке: живой фидбек важнее плашки и переживает
     уход («Далее») и возврат — плашка не должна его перетирать */
  setValue(wrong0);
  run(sandbox, `sessionSubmit()`);
  check(`${tag}: ошибка на оживлённой карточке видна`,
    /Пока не сходится/.test(html(sandbox, "feedbackSlot")),
    html(sandbox, "feedbackSlot").replace(/<[^>]*>/g, "").slice(0, 80));
  run(sandbox, `sessionSkip()`);
  run(sandbox, `sessionPrev()`);
  check(`${tag}: возврат после ошибки — блок ошибки, а не плашка`,
    /Пока не сходится/.test(html(sandbox, "feedbackSlot"))
      && !/можешь на него ответить/.test(html(sandbox, "feedbackSlot")),
    html(sandbox, "feedbackSlot").replace(/<[^>]*>/g, "").slice(0, 80));
  check(`${tag}: F5 после ошибки — блок ошибки на месте`,
    reload() === true && /Пока не сходится/.test(html(sandbox, "feedbackSlot")),
    html(sandbox, "feedbackSlot").replace(/<[^>]*>/g, "").slice(0, 60));

  /* Поздний ответ на пропущенное: принят, запись пропуска ЗАМЕНЕНА */
  setValue(answer0);
  run(sandbox, `sessionSubmit()`);
  check(`${tag}: поздний ответ на пропущенное принят`,
    run(sandbox, `Session.cur.answered`) === true && /Правильно/.test(html(sandbox, "feedbackSlot")),
    html(sandbox, "feedbackSlot").replace(/<[^>]*>/g, "").slice(0, 80));
  check(`${tag}: поздний ответ заменил запись пропуска — запись одна`,
    run(sandbox, `Session.cur.results.length`) === 1
      && run(sandbox, `Session.cur.results[0].correct`) === true
      && run(sandbox, `Session.cur.results[0].skipped`) === false,
    JSON.stringify(run(sandbox, `Session.cur.results`)));
  /* Ответив, вернуться и перерешить уже нельзя — карточка финальна */
  run(sandbox, `sessionNext()`);
  run(sandbox, `sessionPrev()`);
  check(`${tag}: после позднего ответа карточка финальна`,
    run(sandbox, `Session.cur.answered`) === true && inputsDisabled() === true
      && !/можешь на него ответить/.test(html(sandbox, "feedbackSlot")));
  run(sandbox, `sessionNext()`);

  /* --- 2. подсказки накапливаются, решение не затирает свой ответ --- */
  run(sandbox, `sessionHint()`);            // уровень 1 доступен сразу
  check(`${tag}: подсказка 1 на экране`, /Подсказка 1\./.test(html(sandbox, "hintSlot")));
  setValue(wrong);
  run(sandbox, `sessionSubmit()`);          // ошибка 1 открывает уровень 2
  run(sandbox, `sessionHint()`);
  const twoHints = html(sandbox, "hintSlot");
  check(`${tag}: вторая подсказка идёт ПОСЛЕ первой, а не вместо`,
    /Подсказка 1\./.test(twoHints) && /Подсказка 2\./.test(twoHints), twoHints.replace(/<[^>]*>/g, "").slice(0, 80));
  setValue(wrong);
  run(sandbox, `sessionSubmit()`);          // ошибка 2
  setValue(wrong);
  run(sandbox, `sessionSubmit()`);          // ошибка 3 открывает решение
  run(sandbox, `sessionHint()`);            // уровень 3
  check(`${tag}: все три подсказки на экране`,
    [/Подсказка 1\./, /Подсказка 2\./, /Подсказка 3\./].every((r) => r.test(html(sandbox, "hintSlot"))));
  setValue(wrong);                          // свой (неверный) ответ остаётся в поле
  run(sandbox, `sessionShowAnswer()`);
  check(`${tag}: своё поле ответа НЕ перезаписано верным`,
    answerVal() === wrong, `поле=${JSON.stringify(answerVal())} ожидали свой=${JSON.stringify(wrong)}`);
  check(`${tag}: верный ответ виден в блоке решения`,
    new RegExp(`ответ:\\s*${answer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(html(sandbox, "feedbackSlot")),
    html(sandbox, "feedbackSlot").slice(0, 80));
  check(`${tag}: ввод заблокирован после показа решения`, inputsDisabled() === true);

  /* --- 3. F5 на отвеченном задании: всё возвращается --- */
  check(`${tag}: перезагрузка восстанавливает сессию`, reload() === true);
  check(`${tag}: после F5 — то же задание и то же состояние`,
    run(sandbox, `Session.cur.idx`) === 1 && run(sandbox, `Session.cur.answered`) === true);
  check(`${tag}: после F5 — решение и разбор на месте`,
    /Ответ показан/.test(html(sandbox, "feedbackSlot")) && /Разбор/.test(html(sandbox, "feedbackSlot")));
  check(`${tag}: после F5 — свой ответ в поле не затёрт`, answerVal() === wrong);
  check(`${tag}: после F5 — ввод заблокирован`, inputsDisabled() === true);
  check(`${tag}: после F5 — подсказки дорисованы`,
    [/Подсказка 1\./, /Подсказка 3\./].every((r) => r.test(html(sandbox, "hintSlot"))));
  check(`${tag}: после F5 — результаты сессии целы`, run(sandbox, `Session.cur.results.length`) === 2);

  /* --- 4. черновик и подсказки незавершённого задания переживают F5 --- */
  run(sandbox, `sessionNext()`);
  check(`${tag}: далее — третье задание чистым бланком`,
    run(sandbox, `Session.cur.idx`) === 2 && run(sandbox, `Session.cur.answered`) === false
    && answerVal() === "" && !/Подсказка/.test(html(sandbox, "hintSlot")));
  setValue(wrong.slice(0, 3) || "12");
  run(sandbox, `sessionHint()`);
  check(`${tag}: перезагрузка на живом задании восстанавливает сессию`, reload() === true);
  check(`${tag}: после F5 — черновик ответа в поле`,
    answerVal() === (wrong.slice(0, 3) || "12"), JSON.stringify(answerVal()));
  check(`${tag}: после F5 — открытая подсказка на месте`, /Подсказка 1\./.test(html(sandbox, "hintSlot")));
  check(`${tag}: после F5 — задание всё ещё не отвечено`, run(sandbox, `Session.cur.answered`) === false);

  /* --- 5. «Назад»/«Вперёд» показывают сохранённые состояния --- */
  run(sandbox, `sessionPrev()`);
  check(`${tag}: назад на отвеченное — состояние решения`,
    run(sandbox, `Session.cur.answered`) === true && /Ответ показан/.test(html(sandbox, "feedbackSlot")));
  run(sandbox, `sessionNext()`);
  check(`${tag}: вперёд на живое — черновик и подсказка вернулись`,
    run(sandbox, `Session.cur.answered`) === false && /Подсказка 1\./.test(html(sandbox, "hintSlot"))
    && answerVal() === (wrong.slice(0, 3) || "12"));
}

const autoCheck = (t) => t && t.type !== "long_text" && (t.metadata || {}).check !== "self"
  && /^\d{1,6}$/.test(String(t.answer ?? "").trim()) && !(t.visual || {}).required;
const pickN = (cat, n, pred) => (cat.tasks || []).filter(pred).slice(0, n);

const mathCat = catalog;
const normals = pickN(mathCat, 3, (t) => autoCheck(t) && !/соответств|соотнеси/i.test(String(t.text || "")));
if (normals.length === 3) scenario(normals, "поле", mathCat, "profile_math");
else check("поле: три авто-проверяемых задания для потока", false, `найдено ${normals.length}`);

/* Задания-соответствия (ответ-таблица) — в русском каталоге. */
const ruCat = JSON.parse(read("server/catalog_russian.json"));
const matches = pickN(ruCat, 3, (t) => autoCheck(t) && /соответств|соотнес/i.test(String(t.text || "")) && String(t.answer ?? "").length >= 3);
if (matches.length === 3) scenario(matches, "таблица", ruCat, "russian");
else console.log(`     · таблица: заданий-соответствий для потока ${matches.length} — сценарий пропущен`);

console.log(failures ? `\n${failures} FAILURES` : "\nALL OK");
process.exitCode = failures ? 1 : 0;
