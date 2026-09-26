/* Блок исходного текста: один каркас для обоих источников.
   Серверный текст (GET /api/essay-text) и текст, лежащий прямо в задании,
   рисуются одной функцией (sourceTextBlockHtml). Второй путь сегодня не
   встречается ни в одном задании каталога (все 8 работ задания 27 берут
   текст с сервера), поэтому он проверяется напрямую по рендеру — иначе
   он тихо разъехался бы с первым: свой мелкий шрифт, своя «синяя»
   кнопка, никакого копирования.

   Проверяется ровно то, что должно быть и у обоих:
   1. одинаковый каркас: плашка + чип-раскрытие + кнопка копии справа
      сверху, тело абзацами; старых .essay-source* классов нет;
   2. честная шапка: у серверного варианта автор и счётчик слов, у
      инлайнового — только счётчик, с правильными окончаниями;
   3. раскрытие работает от нажатой кнопки: два блока на экране не мешают
      друг другу, aria-expanded и подпись чипа синхронны;
   4. копирование кладёт в буфер именно текст блока (целиком, с абзацами),
      показывает галочку и через 1.8 с возвращает иконку; без Clipboard API
      работает запасной путь;
   5. стили: тело крупное (>=17px), подчёркивания у раскрытия нет.
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
const noop = () => {};
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

/* ---------- мини-DOM: элементы с classList/closest ---------- */
class FakeElement {
  constructor(tagName = "div") {
    this.tagName = String(tagName).toUpperCase();
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.value = "";
    this.parentNode = null;
    this._innerHTML = "";
    this._textContent = "";
    this.innerText = null;
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
  set textContent(v) { this._textContent = String(v); }
  get textContent() { return this._textContent; }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  select() {}
  setSelectionRange() {}
  setAttribute(n, v) { this.attributes[n] = String(v); }
  getAttribute(n) { return this.attributes[n] ?? null; }
  removeAttribute(n) { delete this.attributes[n]; }
  addEventListener() {}
  removeEventListener() {}
  focus() {}
  querySelector(sel) { return this.parts && this.parts[sel] ? this.parts[sel] : null; }
  querySelectorAll() { return this.paras || []; }
  closest(sel) {
    // селектор приходит классом («.source-text»), а classList ждёт имя
    const name = String(sel).replace(/^\./, "");
    let node = this;
    while (node) {
      if (node.classList && node.classList.contains(name)) return node;
      node = node.parentNode;
    }
    return null;
  }
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
  addEventListener: noop,
  removeEventListener: noop,
  execCommand: () => true,
};

function buildSandbox({ clipboard = null, secure = false } = {}) {
  const timers = [];
  const sandbox = {
    console: { log: noop, info: noop, warn: noop, error: noop },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: noop,
    setInterval: () => 0,
    clearInterval: noop,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: noop,
    document,
    location: { hash: "#/training", href: "http://localhost/", origin: "http://localhost" },
    history: { replaceState: noop },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    navigator: { userAgent: "source-block-test", locks: {}, clipboard },
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    scrollTo: noop,
    fetch: async () => { throw new Error("source-block test must not perform network I/O"); },
    CustomEvent: class CustomEvent { constructor(t, i = {}) { this.type = t; this.detail = i.detail; } },
    Event: class Event { constructor(t) { this.type = t; } },
    MutationObserver: class MutationObserver { observe() {} disconnect() {} },
    IntersectionObserver: class IntersectionObserver { observe() {} disconnect() {} },
    ResizeObserver: class ResizeObserver { observe() {} disconnect() {} },
    crypto: require("crypto").webcrypto,
    isSecureContext: secure,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.addEventListener = noop;
  sandbox.removeEventListener = noop;
  sandbox.dispatchEvent = () => true;
  sandbox.HTMLElement = FakeElement;
  sandbox.catalogPayload = {
    ...catalog,
    subject: "russian",
    subjects: [{ id: "russian", title: "Русский язык", status: "ready", features: { practice: true } }],
  };
  vm.createContext(sandbox);
  vm.runInContext([read("js/data.js"), read("js/state.js"), read("js/app.js")].join("\n"), sandbox,
    { filename: "source-block-bundle.js" });
  sandbox.fireTimers = () => { while (timers.length) timers.shift()(); };
  vm.runInContext(`
    DataAPI.load(catalogPayload);
    Store.subject = "russian";
    Store.subjects = DataAPI.subjects();
    Store.ready = true;
    Store.state = Store.defaultState();
    Store.accountId = "testsource";
    Store.save = () => Promise.resolve();
    Session.cur = null;
  `, sandbox);
  return { sandbox, timers };
}

/* Живой блок для проверки раскрытия и копирования: собираем те же узлы,
   что строит sourceTextBlockHtml, но руками — парсить HTML нечем. */
function makeBlock(sandbox, text) {
  return vm.runInContext(`(() => {
    const label = { textContent: "Читать" };
    const head = { attributes: {}, setAttribute(n, v) { this.attributes[n] = v; } };
    const iconEl = { _html: "", set innerHTML(v) { this._html = String(v); }, get innerHTML() { return this._html; } };
    const body = { innerText: ${JSON.stringify(text)}, textContent: ${JSON.stringify(text)}, querySelectorAll: () => [] };
    const box = new HTMLElement("div");
    box.classList.add("source-text", "source-text--collapsed");
    box.parts = { "[data-source-toggle-label]": label, ".source-text__head": head, ".source-text__body": body };
    const headBtn = new HTMLElement("button");
    headBtn.parentNode = box;
    const copyBtn = new HTMLElement("button");
    copyBtn.parentNode = box;
    copyBtn.parts = { ".source-text__copy-icon": iconEl };
    return { box, label, head, iconEl, headBtn, copyBtn };
  })()`, sandbox);
}

const SKELETON = [
  ['class="source-text source-text--collapsed"', /class="source-text source-text--collapsed"/],
  ["чип-раскрытие", /class="source-text__chip"/],
  ["подпись «Читать»", /data-source-toggle-label>Читать</],
  ["шеврон", /class="source-text__chev"/],
  ["кнопка копии", /class="source-text__copy"/],
  ["иконка копии", /class="source-text__copy-icon"/],
  ["тело", /class="source-text__body"/],
  ['раскрытие от кнопки', /onclick="sourceTextToggle\(this\)"/],
  ['копирование от кнопки', /onclick="sourceTextCopy\(this\)"/],
];
const FORBIDDEN = [
  ["старый класс .essay-source", /essay-source/],
  ["старая кнопка «Показать полностью»", /Показать полностью/],
  ["своя подпись в предпросмотре", /data-essay-source-(preview|full)/],
];

function assertSkeleton(label, html) {
  for (const [name, re] of SKELETON) check(`${label}: ${name}`, re.test(html));
  for (const [name, re] of FORBIDDEN) check(`${label}: нет ${name}`, !re.test(html));
}

async function main() {
  /* ---------- 1. Серверный источник (задание 27) ---------- */
  const serverHtml = vm.runInContext(`essaySourceTextHtml({
    author: "А.Я. Бруштейн", wordCount: 394,
    text: "Первый абзац текста.\\n\\nВторой абзац.",
  })`, sandboxOf().sandbox);
  assertSkeleton("серверный", serverHtml);
  check("серверный: автор и счётчик слов в шапке",
    /Исходный текст · А\.Я\. Бруштейн · 394 слова/.test(serverHtml),
    (serverHtml.match(/class="source-text__title">[^<]*/) || [])[0]);
  check("серверный: два абзаца", (serverHtml.match(/<p>/g) || []).length === 2);
  check("серверный: id блока прежний",
    /id="sourceTextBox"/.test(serverHtml));

  /* ---------- 2. Инлайновый источник (текст в самом задании) ---------- */
  const { sandbox } = sandboxOf();
  const inlineHtml = vm.runInContext(`(() => {
    const text = "Абзац один, достаточно длинный.\\n\\nАбзац два.";
    const t = { id: "x_long_1", type: "long_text", skill: "long_text_source", sourceText: text };
    return { html: essaySourceHtml(t), text };
  })()`, sandbox);
  assertSkeleton("инлайновый", inlineHtml.html);
  check("инлайновый: автор не выдуман, счётчик слов настоящий",
    /Исходный текст · 6 слов/.test(inlineHtml.html) && !/Бруштейн/.test(inlineHtml.html),
    (inlineHtml.html.match(/class="source-text__title">[^<]*/) || [])[0]);
  check("инлайновый: id блока прежний", /id="essaySource"/.test(inlineHtml.html));

  /* окончания счётчика слов — по-русски, а не «слов» на всё */
  const endings = [[1, "слово"], [2, "слова"], [5, "слов"], [11, "слов"], [21, "слово"], [112, "слов"]];
  for (const [n, word] of endings) {
    const html = vm.runInContext(`essaySourceHtml({ type: "long_text", sourceText: Array(${n} + 1).join("слово ") })`, sandbox);
    check(`инлайновый: ${n} → «${word}»`, new RegExp(`Исходный текст · ${n} ${word}`).test(html),
      (html.match(/class="source-text__title">[^<]*/) || [])[0]);
  }

  /* ---------- 3. Инлайновый блок виден только когда это настоящий текст ---------- */
  const cases = [
    ["короткая подпись источника — не блок", `{ type: "long_text", source: "Демоверсия ФИПИ 2024" }`, false],
    ["не long_text — не блок", `{ type: "short_text", sourceText: "Много слов. ".repeat(40) }`, false],
    ["обычный long_text с настоящим текстом — блок", `{ type: "long_text", sourceText: "Абзац. ".repeat(40) }`, true],
  ];
  for (const [name, task, want] of cases) {
    const got = vm.runInContext(`!!essaySourceHtml(${task})`, sandbox);
    check(name, got === want, `html=${got}`);
  }

  /* ---------- 4. Раскрытие: от кнопки, у каждого блока своё ---------- */
  {
    const one = makeBlock(sandbox, "Абзац один.\n\nАбзац два.");
    const two = makeBlock(sandbox, "Другой текст.");
    sandbox.__btn = one.headBtn;
    vm.runInContext("sourceTextToggle(__btn)", sandbox);
    check("раскрытие: подпись чипа «Скрыть»", one.label.textContent === "Скрыть", one.label.textContent);
    check("раскрытие: aria-expanded=true", one.head.attributes["aria-expanded"] === "true",
      one.head.attributes["aria-expanded"]);
    check("раскрытие: класс свёрнутого снят", one.box.classList.contains("source-text--collapsed") === false);
    check("раскрытие: второй блок не задет", two.label.textContent === "Читать", two.label.textContent);
    sandbox.__btn = two.headBtn;
    vm.runInContext("sourceTextToggle(__btn)", sandbox);
    check("раскрытие: блоки независимы (первый не схлопнулся)",
      two.label.textContent === "Скрыть" && one.label.textContent === "Скрыть",
      `${one.label.textContent}/${two.label.textContent}`);
    sandbox.__btn = one.headBtn;
    vm.runInContext("sourceTextToggle(__btn)", sandbox);
    check("раскрытие: повторный клик снова сворачивает",
      one.label.textContent === "Читать" && one.box.classList.contains("source-text--collapsed") === true);
  }

  /* ---------- 5. Копирование ---------- */
  {
    const written = [];
    const { sandbox: sec } = sandboxOf({ clipboard: { writeText: async (t) => { written.push(t); } }, secure: true });
    const blk = makeBlock(sec, "Первый абзац.\n\nВторой абзац.");
    const btn = blk.copyBtn;
    sec.__btn = btn;
    vm.runInContext("sourceTextCopy(__btn)", sec);
    await flush();
    check("копия: в буфер ушёл текст блока целиком",
      written.length === 1 && written[0] === "Первый абзац.\n\nВторой абзац.", JSON.stringify(written[0]));
    check("копия: кнопка показала галочку",
      btn.classList.contains("is-copied") && /M4 12\.5l5 5/.test(blk.iconEl.innerHTML));
    sec.fireTimers();
    check("копия: иконка вернулась к копии через 1.8 с",
      btn.classList.contains("is-copied") === false && /x="8" y="8"/.test(blk.iconEl.innerHTML),
      blk.iconEl.innerHTML.slice(0, 40));
  }

  /* копия без Clipboard API (старый браузер/не-secure контекст) */
  {
    const { sandbox: legacy } = sandboxOf({ clipboard: null, secure: false });
    const created = [];
    legacy.document.createElement = (tag) => { const el = new FakeElement(tag); created.push(el); return el; };
    const blk = makeBlock(legacy, "Текст для execCommand.");
    legacy.__btn = blk.copyBtn;
    vm.runInContext("sourceTextCopy(__btn)", legacy);
    await flush();
    check("копия: без Clipboard API работает запасной путь",
      created.some((el) => el.tagName === "TEXTAREA" && el.value === "Текст для execCommand."),
      created.map((el) => el.tagName).join(","));
    check("копия: запасной путь тоже показывает галочку", blk.copyBtn.classList.contains("is-copied") === true);
  }

  /* ---------- 6. Стили ---------- */
  {
    const css = read("css/styles.css");
    const bodyRule = (css.match(/\.source-text__body \{[^}]*\}/) || [""])[0];
    const font = parseFloat((bodyRule.match(/font-size:\s*([\d.]+)px/) || [])[1] || "0");
    const lh = parseFloat((bodyRule.match(/line-height:\s*([\d.]+)/) || [])[1] || "0");
    check("стили: тело крупное (>=17px)", font >= 17, `${font}px`);
    check("стили: межстрочный (>=1.7)", lh >= 1.7, `${lh}`);
    const rules = css.slice(css.indexOf("/* ---------- исходный текст"), css.indexOf("/* ---------- lessons"));
    check("стили: раскрытие не подчёркивается", !/text-decoration:\s*underline/.test(rules));
    check("стили: у блока есть и чип, и кнопка копии",
      /\.source-text__chip/.test(rules) && /\.source-text__copy/.test(rules));
    check("стили: старых .essay-source правил не осталось", !/^\.essay-source/m.test(css));
  }

  console.log(failures ? `\n${failures} FAILURES` : "\nALL OK");
  process.exit(failures ? 1 : 0);
}

/* Песочница без аргументов — для чистых рендеров и раскрытия. */
function sandboxOf(options) {
  return options ? buildSandbox(options) : buildSandbox();
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
