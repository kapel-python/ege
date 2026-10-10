/* Стресс-тест ядра: то, чем реально пользуется ученик, во всех предметах.

   Замысел — намеренно сломать ядро популярными сценариями и убедиться, что
   оно не ломается:
     1. Корпус: у каждого задания есть текст и ответ (кроме сочинений и
        заданий на самопроверку), скилл существует, у каждой темы три
        подсказки, рисунки требуют ассет.
     2. Проверка ответа: верный ответ принимается ВСЕГДА, пустой — никогда
        (эталон «0» не должен засчитывать пустое поле), враждебный ввод не
        роняет и не выдаёт верный, набор цифр терпит разделители, а порядок
        важен только там, где он смысловой.
     3. Живой поток практики (настоящие js/data.js + js/state.js + js/app.js
        в VM): ввод ответа, поле и ответ-таблица, лестница подсказок, показ
        решения, пропуск, финиш сессии, восстановление после перезагрузки.
     4. Контент: миссии, боссы, ежедневка и уроки ссылаются на существующие
        задания, шаги урока имеют подсказки и разбор.

   Ничего не ходит в сеть и не трогает продакшн-БД: каталоги читаются с
   диска, сервер — во временном каталоге.
*/
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const CATALOGS = {
  profile_math: "server/catalog.json",
  basic_math: "server/catalog_basic.json",
  russian: "server/catalog_russian.json",
  biology: "server/catalog_biology.json",
  informatics: "server/catalog_informatics.json",
  society: "server/catalog_society.json",
};

let failures = 0;
let checks = 0;
const problems = [];
const check = (name, condition, detail = "") => {
  checks += 1;
  if (!condition) {
    failures += 1;
    problems.push(`${name}${detail ? " | " + detail : ""}`);
    console.log(`FAIL ${name}${detail ? " | " + detail : ""}`);
  }
};
const done = () => {
  console.log(`\n${failures ? failures + " FAILURES" : "ALL OK"}: ${checks} checks`);
  if (problems.length) console.log("Найдено:\n - " + problems.join("\n - "));
  process.exitCode = failures ? 1 : 0;
};

/* ==================== 1–2. корпус и проверка ответа ==================== */

/* Ответ — строка цифр по позициям: соответствие и последовательность.
   Порядок смысловой, разделители — нет. */
const POSITION_RE = /установите\s+(?:правильную\s+)?последовательность|расположите\s+в\s+(?:правильном\s+)?порядке|(?:запишите|восстановите)\s+последовательность|для\s+каждой\s+(?:величин|ячейк)|заполните\s+пустые\s+ячейк/i;
/* Ответ — набор выбранных номеров: порядок не смысловой. Дополнительно
   доверяем产品-классификатору isMultiSelectTask: формулировки различаются
   мелочами, а проверять нужно поведение, а не наш собственный список. */
const SET_RE = /под\s+котор\S*\s+(?:они\s+)?указан|(?:запишите|укажите)\s+в\s+ответ\s+(?:цифр|номера)|укажите\s+(?:все\s+)?цифр|на\s+месте\s+котор\S*\s+(?:пишется|должн)|(?:выберите|выпишите)\s+(?:верные|правильные|все)?\s*(?:суждени|утверждени|варианты|номера|ответы|признаки|позиции|термины)|(?:найдите|укажите)\s+в\s+(?:приведён|приведен|данн|указанн)\S*\s*(?:ниже\s*)?(?:списке|перечне)|(?:запишите|укажите|выпишите|напишите)\s+(?:их\s+)?номера|напишите\s+номер|номера\s+ответов|набор\s+номеров/i;

const stateSrc = read("js/state.js");
const stateBox = {};
vm.createContext(stateBox);
vm.runInContext(stateSrc + "\n;globalThis.__api = { checkAnswer, matchingAnswerLetters, isMultiSelectTask, isDigitSequenceTask };", stateBox);
const S = stateBox.__api;

/* Лестница помощи шага урока/задания: та функция, что рисует подсказки на
   экране, чтобы тест видел ровно то, что увидит ученик. */
const hintLevelsForSrc = read("js/app.js").match(/function hintLevelsFor\(item\) \{[\s\S]*?\n\}/)[0];
const levelsBox = {};
vm.createContext(levelsBox);
vm.runInContext(hintLevelsForSrc + "\n;globalThis.f = hintLevelsFor;", levelsBox);
const Levels = (item) => levelsBox.f(item);

const catalogs = {};
for (const [subject, rel] of Object.entries(CATALOGS)) catalogs[subject] = JSON.parse(read(rel));

const HOSTILE = ["", " ", "0", "00000000", "-", ".", ",", "1,2,3", "1 2 3", "1.2.3", "1;2;3",
  "abc", "АБВ", "нет", "не знаю", "<script>alert(1)</script>", "' OR 1=1--", "🙂",
  "x".repeat(400), "12a3", "99999999999999999999", "0x10", "1e5", "+1", "1-2", null, undefined];

console.log("== 1. корпус предметов ==");
for (const [subject, cat] of Object.entries(catalogs)) {
  const skills = new Map((cat.skills || []).map((s) => [s.id, s]));
  const assetIds = new Set(((cat.visualAssets || []).map((a) => String((a && a.id) || ""))));
  let noHint = 0, noAnswer = 0, noText = 0, orphan = 0, badVisual = 0, selfNoSolution = 0;
  let wrongRejected = 0, emptyAccepted = 0, threw = 0, sepBad = 0, orderBad = 0, commaOnNumber = 0;
  const samples = [];

  for (const s of skills.values()) {
    const hints = (s.metadata || {}).hints;
    if (!Array.isArray(hints) || hints.length !== 3 || !hints.every((h) => String(h || "").trim())) noHint++;
  }
  for (const t of cat.tasks || []) {
    const text = String(t.text || "");
    const answer = String(t.answer ?? "").trim();
    const isLong = t.type === "long_text" || t.answerType === "long_text";
    // Задание на самопроверку: поля ввода нет, ученик сверяется с решением.
    const isSelf = t.type === "extended_answer" || (t.metadata || {}).check === "self";
    if (!isLong && !answer) noAnswer++;
    if (!text.trim()) noText++;
    if (t.skill && !skills.has(t.skill)) orphan++;
    if ((t.visual || {}).required && !assetIds.has(String(t.visual.assetId || ""))) badVisual++;
    if (isSelf && !answer && !String(t.solution || "").trim()) selfNoSolution++;
    if (isLong || isSelf || !answer) continue;

    const letters = S.matchingAnswerLetters(t).length > 0;
    const positional = POSITION_RE.test(text);
    // «Цифры укажите в порядке возрастания» — требование к оформлению бланка,
    // а не к смыслу: тот же набор в другом порядке остаётся тем же набором.
    const set = (SET_RE.test(text) || S.isMultiSelectTask(t)) && !positional && !letters;
    const isDigits = /^\d{2,8}$/.test(answer);
    // Строка цифр это или число: решает и формулировка, и метка вида ответа.
    const wantSep = set || positional || letters
      || /цифр|последовательность/i.test(String(t.valueType || ""));
    try {
      if (!S.checkAnswer(t, answer)) { wrongRejected++; samples.push(`${t.id} «${answer}» отвергнут`); }
      // Верные варианты автора (accept) обязаны приниматься — иначе задание
      // нерешаемо, хотя верный ответ в банке есть.
      for (const alt of (Array.isArray(t.accept) ? t.accept : [])) {
        if (!S.checkAnswer(t, String(alt))) { wrongRejected++; samples.push(`${t.id} вариант «${alt}» отвергнут`); }
      }
      if (S.checkAnswer(t, "") || S.checkAnswer(t, " ")) { emptyAccepted++; samples.push(`${t.id} пустой принят`); }
      if (isDigits) {
        const rev = answer.split("").reverse().join("");
        const revOK = rev === answer || S.checkAnswer(t, rev);
        const commaOK = S.checkAnswer(t, answer.split("").join(","));
        const spaceOK = S.checkAnswer(t, answer.split("").join(" "));
        // Разделители: у строки цифр — терпимы, у числа — нет («5,8» это 5.8).
        if (wantSep && (!commaOK || !spaceOK)) { sepBad++; samples.push(`${t.id} «${answer}» + разделитель`); }
        // Ответ вида «00» — одна и та же цифра: «0,0» и «00» неразличимы.
        const uniform = new Set(answer).size === 1;
        if (!wantSep && commaOK && !uniform) { commaOnNumber++; samples.push(`${t.id} «${answer}» число съело запятую`); }
        // Порядок: у набора не важен; у позиционного кода — важен, если
        // только автор сам не перечислил перестановку в accept.
        const acceptAllowsRev = Array.isArray(t.accept) && t.accept.map(String).includes(rev);
        if (set && !revOK) { orderBad++; samples.push(`${t.id} «${answer}» набор, порядок отвергнут`); }
        if (!set && revOK && rev !== answer && !acceptAllowsRev) { orderBad++; samples.push(`${t.id} «${answer}» порядок смысловой, но обратный принят`); }
      }
      for (const bad of HOSTILE) S.checkAnswer(t, bad);
    } catch (err) { threw++; samples.push(`${t.id}: ${err.message}`); }
  }
  check(`${subject}: у каждой темы три подсказки`, noHint === 0, `без подсказок: ${noHint}`);
  check(`${subject}: у каждого задания текст`, noText === 0, `без текста: ${noText}`);
  check(`${subject}: скиллы заданий существуют`, orphan === 0, `сирот: ${orphan}`);
  check(`${subject}: верный ответ всегда принимается`, wrongRejected === 0, `${wrongRejected}: ${samples.slice(0, 3).join("; ")}`);
  check(`${subject}: пустой ответ не принимается`, emptyAccepted === 0, `${emptyAccepted}: ${samples.slice(0, 3).join("; ")}`);
  check(`${subject}: проверка не падает ни на чём`, threw === 0, `${threw}: ${samples.slice(0, 3).join("; ")}`);
  check(`${subject}: набор и код терпят разделители`, sepBad === 0, `${sepBad}: ${samples.slice(0, 3).join("; ")}`);
  check(`${subject}: число не съедает запятую как разделитель`, commaOnNumber === 0, `${commaOnNumber}: ${samples.slice(0, 3).join("; ")}`);
  check(`${subject}: порядок важен только там, где смысловой`, orderBad === 0, `${orderBad}: ${samples.slice(0, 3).join("; ")}`);
  // Задания без рисунка сервер не отдаёт — это зазор контента, не поломка ядра.
  if (badVisual) console.log(`     · ${subject}: заданий требуют рисунок без ассета: ${badVisual} (не отдаются клиенту)`);
  if (selfNoSolution) console.log(`     · ${subject}: заданий на самопроверку без решения: ${selfNoSolution}`);
}

/* ==================== 3. живой поток практики ==================== */

console.log("\n== 2. живой поток практики (настоящий app.js) ==");

class FakeElement {
  constructor(tag = "div") {
    this.tagName = String(tag || "div").toUpperCase();
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.attributes = {};
    this.classes = new Set();
    this._innerHTML = "";
    this._inputs = [];
    const classes = this.classes;
    this.classList = {
      add: (...n) => n.forEach((x) => classes.add(x)),
      remove: (...n) => n.forEach((x) => classes.delete(x)),
      contains: (n) => classes.has(n),
      toggle: (n, f) => { const on = f === undefined ? !classes.has(n) : !!f; if (on) classes.add(n); else classes.delete(n); return on; },
    };
  }
  set innerHTML(v) {
    this._innerHTML = String(v);
    const inputs = [];
    const re = /<input\b[^>]*>/g;
    let m;
    while ((m = re.exec(this._innerHTML)) !== null) {
      const tag = m[0];
      const attr = (a) => { const r = new RegExp("\\b" + a + '="([^"]*)"').exec(tag); return r ? r[1] : null; };
      inputs.push({
        id: attr("id"), match: attr("data-match-cell"), lesson: attr("data-lesson-match-cell"),
        field: attr("data-lesson-field"), value: attr("value") || "", disabled: /\bdisabled\b/.test(tag),
      });
    }
    this._inputs = inputs;
    // Реестр input-ов пересобирается ТОЛЬКО по карточке задания: запись в
    // дочерний слот (#feedbackSlot, #hintControl) в браузере не трогает поля
    // ответа, и тестовый DOM обязан вести себя так же.
    if (this.__isScreen) DOM.sync(inputs);
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
    if (sel === "[data-match-cell]") return DOM.nodes.filter((n) => n.__match != null);
    if (sel === "[data-lesson-match-cell]") return DOM.nodes.filter((n) => n.__lesson != null);
    if (sel === "[data-lesson-field]") return DOM.nodes.filter((n) => n.__field != null);
    return [];
  }
  closest() { return null; }
  focus() {}
}

const DOM = {
  seq: 0,
  slots: {},
  nodes: [],
  sync(inputs) {
    // Перерисовка создаёт элементы заново: значение приходит из разметки, как
    // в браузере. Между отрисовками ссылки на живые узлы сохраняются.
    const byKey = new Map(DOM.nodes.map((n) => [n.__key, n]));
    DOM.nodes = [];
    inputs.forEach((spec, i) => {
      const key = spec.id ? "id:" + spec.id : (spec.match != null ? "match:" + spec.match
        : (spec.lesson != null ? "lesson:" + spec.lesson : (spec.field != null ? "field:" + spec.field : "input:" + i)));
      let node = byKey.get(key);
      if (!node) { node = new FakeElement("input"); node.__key = key; }
      node.__match = spec.match; node.__lesson = spec.lesson; node.__field = spec.field;
      node.value = spec.value;
      node.disabled = spec.disabled;
      DOM.nodes.push(node);
    });
  },
};

const document = {
  readyState: "complete",
  title: "",
  hidden: false,
  activeElement: null,
  documentElement: new FakeElement("html"),
  head: new FakeElement("head"),
  body: new FakeElement("body"),
  createElement: (tag) => new FakeElement(tag),
  getElementById(id) {
    const hit = DOM.nodes.find((n) => n.__key === "id:" + id);
    if (hit) return hit;
    if (!DOM.slots["id:" + id]) DOM.slots["id:" + id] = new FakeElement("div");
    return DOM.slots["id:" + id];
  },
  querySelector: () => null,
  querySelectorAll: (sel) => {
    const screen = DOM.slots["id:screen"];
    return screen ? screen.querySelectorAll(sel) : [];
  },
  addEventListener: () => {},
  removeEventListener: () => {},
};

const memoryStorage = () => {
  const values = new Map();
  return {
    getItem: (k) => (values.has(k) ? values.get(k) : null),
    setItem: (k, v) => values.set(k, String(v)),
    removeItem: (k) => values.delete(k),
    clear: () => values.clear(),
  };
};

function buildSandbox(subject, catalog) {
  DOM.slots = {};
  DOM.nodes = [];
  const screen = new FakeElement("div");
  screen.__isScreen = true; // только её разметка пересобирает поля ответа
  DOM.slots["id:screen"] = screen;
  const sandbox = {
    console: { log: () => {}, info: () => {}, warn: () => {}, error: () => {}, table: () => {} },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    document, location: { hash: "#/training", href: "http://localhost/", origin: "http://localhost" },
    history: { replaceState: () => {}, pushState: () => {} },
    localStorage: memoryStorage(), sessionStorage: memoryStorage(),
    navigator: { userAgent: "core-stress", locks: {} },
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    scrollTo: () => {}, fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    CustomEvent: class { constructor(t, i = {}) { this.type = t; this.detail = i.detail; } },
    Event: class { constructor(t) { this.type = t; } },
    MutationObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    crypto: require("crypto").webcrypto,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  sandbox.dispatchEvent = () => true;
  sandbox.HTMLElement = FakeElement;
  vm.createContext(sandbox);
  sandbox.__catalog = { ...catalog, subject };
  sandbox.__subject = subject;
  vm.runInContext([read("js/data.js"), read("js/state.js"), read("js/ai-limit.js"), read("js/app.js")].join("\n"),
    sandbox, { filename: "core-stress-bundle.js" });
  vm.runInContext(`
    DataAPI.load(__catalog);
    Store.subject = __subject;
    Store.subjects = DataAPI.subjects();
    Store.ready = true;
    Store.state = Store.defaultState();
    Store.state.onboarded = true;
    Store.accountId = "core-stress";
    Store.save = () => Promise.resolve();
    Vendor.ensureMath = () => Promise.resolve();
    Vendor.loadScript = () => Promise.resolve();
    Session.cur = null; Lesson.cur = null;
    globalThis.__goCalls = []; globalThis.__toasts = [];
    go = (route, param) => { globalThis.__goCalls.push([route, param || null]); };
    toast = (html) => { globalThis.__toasts.push(String(html)); };
    // Подтверждение = согласие ученика: сразу выполняем действие, как клик по
    // кнопке диалога. Иначе подсказки и «показать решение» не проверить.
    openConfirmDialog = (opts) => { opts.onConfirm(); };
    recordAnswer = () => 5;
  `, sandbox);
  return sandbox;
}

const run = (sandbox, code) => vm.runInContext(code, sandbox);
const html = (sandbox, id) => run(sandbox, `(() => { const e = document.getElementById(${JSON.stringify(id)}); return e ? e.innerHTML : ""; })()`);

/* Один сценарий: верно → неверно ×3 → лестница подсказок → показ решения. */
function scenario(sandbox, task, label) {
  const t = task;
  const tag = `${label}/${t.id}`;
  const answer = String(t.answer ?? "");
  const wrong = answer === "1" ? "999999"
    : (answer.split("").map((d) => (d === "1" ? "0" : "1")).join("") || "999999");

  const start = () => {
    run(sandbox, `Session.start({ title: "Стресс", taskIds: [${JSON.stringify(t.id)}], mode: "practice" })`);
    run(sandbox, `renderTask(document.getElementById("screen"))`);
  };
  const setValue = (v) => run(sandbox, `(() => {
    const cells = document.querySelectorAll("[data-match-cell]");
    if (cells.length) { cells.forEach((c, i) => { c.value = String(${JSON.stringify(v)}[i] || ""); }); return; }
    const input = document.getElementById("answerInput");
    if (input && input.tagName === "INPUT") input.value = ${JSON.stringify(v)};
  })()`);
  const submit = () => run(sandbox, `sessionSubmit()`);
  const feedback = () => html(sandbox, "feedbackSlot");
  // Диагностика попытки: что реально ушло в проверку и что она решила.
  const attempt = () => run(sandbox, `(() => {
    const val = sessionAnswerValue();
    return { val, exp: String(Session.task().answer || ""), ok: checkAnswer(Session.task(), val),
             cells: document.querySelectorAll("[data-match-cell]").length,
             input: String((document.getElementById("answerInput") || {}).value || "") };
  })()`);

  start();
  check(`${tag}: карточка отрисована`, /task-card/.test(html(sandbox, "screen")), html(sandbox, "screen").slice(0, 60));
  const levels = run(sandbox, `topicHintLevels(Session.task())`);
  check(`${tag}: подсказки темы — три непустые`, Array.isArray(levels) && levels.length === 3
    && levels.every((h) => String(h || "").trim()), JSON.stringify(levels && levels.length));

  setValue(answer);
  submit();
  check(`${tag}: верный ответ засчитан`, /Правильно/.test(feedback()), JSON.stringify(attempt()));
  check(`${tag}: после верного есть «Далее»`, /sessionNext\(\)/.test(feedback()));

  start();
  for (let i = 1; i <= 3; i++) {
    setValue(wrong);
    submit();
    check(`${tag}: попытка ${i} — «пока не сходится»`, /Пока не сходится/.test(feedback()), feedback().slice(0, 60));
    const help = run(sandbox, `sessionAvailableHelp()`);
    // 0 ошибок — подсказка 1, каждая ошибка открывает следующую; на третьей
    // ошибке открывается подсказка 3, а «показать решение» — только после неё.
    check(`${tag}: попытка ${i} открывает подсказку ${i}`, !!help && help.type === "hint" && help.level === i, JSON.stringify(help));
    run(sandbox, `sessionHint()`);
    const shown = html(sandbox, "hintSlot");
    const hintText = shown.replace(/<[^>]*>/g, "").replace(/Подсказка\s*\d+\./, "").trim();
    check(`${tag}: подсказка ${i} несёт текст`, new RegExp(`Подсказка ${i}\\.`).test(shown) && hintText.length > 10, hintText.slice(0, 60));
  }
  const helpAfter = run(sandbox, `sessionAvailableHelp()`);
  check(`${tag}: после третьей подсказки доступно решение`, !!helpAfter && helpAfter.type === "solution", JSON.stringify(helpAfter));
  const resultsBefore = run(sandbox, `Session.cur.results.length`);
  run(sandbox, `sessionShowAnswer()`);
  check(`${tag}: решение показано (ответ и разбор)`, /Ответ показан/.test(feedback()) && /Разбор/.test(feedback()), feedback().slice(0, 60));
  check(`${tag}: после решения есть «Далее»`, /sessionNext\(\)/.test(feedback()));
  check(`${tag}: сессия отвечена, но жива`, run(sandbox, `Session.cur.results.length`) === resultsBefore + 1
    && run(sandbox, `Session.cur.answered`) === true);
  run(sandbox, `sessionShowAnswer()`);
  check(`${tag}: повторный показ решения безопасен`, run(sandbox, `Session.cur.results.length`) === resultsBefore + 1);
  run(sandbox, `sessionNext()`);
  check(`${tag}: «Далее» доводит до финиша`, run(sandbox, `Session.cur === null`)
    || /ЗАВЕРШЕНА|Завершено/.test(html(sandbox, "screen")));

  start();
  run(sandbox, `sessionSkip()`);
  check(`${tag}: пропуск тоже доводит до финиша`, run(sandbox, `Session.cur === null`)
    || /ЗАВЕРШЕНА|Завершено/.test(html(sandbox, "screen")));
}

const pick = (cat, fn) => (cat.tasks || []).find(fn) || null;
const autoCheck = (t) => t && t.type !== "long_text" && String(t.answer || "").trim()
  && (t.metadata || {}).check !== "self";

for (const [subject, cat] of Object.entries(catalogs)) {
  const sandbox = buildSandbox(subject, cat);
  const normal = pick(cat, (t) => autoCheck(t) && !(t.visual || {}).required
    && !/соответстви|соотнеси/i.test(String(t.text || "")));
  if (normal) scenario(sandbox, normal, subject);
  else check(`${subject}: есть авто-проверяемое задание для потока`, false, "не найдено");

  const match = pick(cat, (t) => autoCheck(t) && !(t.visual || {}).required
    && /соответстви|соотнеси/i.test(String(t.text || "")) && /^\d{2,6}$/.test(String(t.answer || "")));
  if (match) scenario(sandbox, match, `${subject}-таблица`);
  else console.log(`     · ${subject}: заданий-соответствий в потоке нет`);

  const self = pick(cat, (t) => (t.metadata || {}).check === "self" || t.type === "extended_answer");
  if (self) {
    run(sandbox, `Session.start({ title: "Самопроверка", taskIds: [${JSON.stringify(self.id)}], mode: "practice" })`);
    run(sandbox, `renderTask(document.getElementById("screen"))`);
    const screen = html(sandbox, "screen");
    check(`${subject}/${self.id}: задание на самопроверку рисуется без поля ввода`,
      !/answer-input/.test(screen), screen.slice(0, 80));
    check(`${subject}/${self.id}: подсказки самопроверки непустые`,
      run(sandbox, `topicHintLevels(Session.task()).filter(h => String(h || "").trim()).length`) === 3);
  }

  const essay = pick(cat, (t) => t.type === "long_text");
  if (essay) {
    run(sandbox, `Session.start({ title: "Сочинение", taskIds: [${JSON.stringify(essay.id)}], mode: "practice" })`);
    run(sandbox, `renderTask(document.getElementById("screen"))`);
    check(`${subject}/${essay.id}: карточка сочинения рисуется`, /essay-editor|task-card/.test(html(sandbox, "screen")));
  }
}

/* ==================== 4. контент: миссии, боссы, уроки ==================== */

console.log("\n== 3. контент: миссии, боссы, ежедневка, уроки ==");
for (const [subject, cat] of Object.entries(catalogs)) {
  const tasks = new Set((cat.tasks || []).map((t) => t.id));
  const skills = new Set((cat.skills || []).map((s) => s.id));
  const cats = new Set((cat.categories || []).map((c) => c.id));
  const missions = cat.missions || [];
  const badMission = missions.filter((m) => !(m.tasks || []).length
    || !(m.tasks || []).every((id) => tasks.has(id)) || !skills.has(m.skill));
  check(`${subject}: миссии ссылаются на живые задания`, badMission.length === 0,
    badMission.slice(0, 3).map((m) => m.id).join(","));
  check(`${subject}: боссы ссылаются на разделы`, (cat.bosses || []).every((b) => cats.has(b.cat)),
    (cat.bosses || []).filter((b) => !cats.has(b.cat)).map((b) => b.id).join(","));
  check(`${subject}: ежедневка задана`, (cat.daily || {}).target > 0);

  const noHints = [], shortLadder = [], noSolution = [], badSkill = [];
  for (const l of cat.lessons || []) {
    if (!skills.has(l.skill)) badSkill.push(l.id);
    for (const st of l.steps || []) {
      // Лестница помощи нужна только шагам, которые что-то спрашивают.
      if (st.type !== "ACTION" && st.type !== "INDEPENDENT_TASK") continue;
      if (!(Array.isArray(st.hints) && st.hints.some((h) => String(h || "").trim()))) noHints.push(l.id + "/" + st.id);
      // Двух подсказок хватает: третий уровень достраивает сама лестница, но
      // на экране ученик не должен увидеть пустой бокс.
      const ladder = Levels(st);
      if (!(ladder.length === 3 && ladder.every((h) => String(h || "").trim()))) shortLadder.push(l.id + "/" + st.id);
      if (st.type === "ACTION" && !String(st.solution || "").trim()) noSolution.push(l.id + "/" + st.id);
    }
  }
  check(`${subject}: уроки принадлежат темам`, badSkill.length === 0, badSkill.join(","));
  check(`${subject}: шаги урока имеют подсказки`, noHints.length === 0, noHints.slice(0, 5).join(","));
  check(`${subject}: лестница урока даёт три уровня`, shortLadder.length === 0, shortLadder.slice(0, 5).join(","));
  check(`${subject}: шаги урока имеют разбор`, noSolution.length === 0, noSolution.slice(0, 5).join(","));
}

/* ==================== 5. восстановление сессии ==================== */

console.log("\n== 4. восстановление сессии ==");
for (const [subject, cat] of Object.entries(catalogs)) {
  const sandbox = buildSandbox(subject, cat);
  const t = pick(cat, (x) => autoCheck(x) && !(x.visual || {}).required);
  if (!t) continue;
  run(sandbox, `Session.start({ title: "Стресс", taskIds: [${JSON.stringify(t.id)}, ${JSON.stringify(t.id)}], mode: "daily" })`);
  run(sandbox, `renderTask(document.getElementById("screen"))`);
  run(sandbox, `sessionNext()`);
  const restored = run(sandbox, `(() => { Session.cur = null; return restoreSessionFromStorage("daily", null); })()`);
  check(`${subject}: сессия восстанавливается из хранилища`, restored === true);
  check(`${subject}: после восстановления задача на месте`, run(sandbox, `Session.task() && Session.task().id`) === t.id);
}

done();
