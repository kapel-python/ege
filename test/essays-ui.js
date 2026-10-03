/* Plus-гейт «Моих сочинений»: без подписки история не читается
   и не рисуется (даже на миллисекунду), вместо неё — пейволл.
   Каркас харнесса (FakeElement/VM/пейлоад) — тот же, что в subject-ui.js. */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");
const readJson = (relative) => JSON.parse(read(relative));
const SUBJECT_IDS = ["profile_math", "basic_math", "russian"];
const REQUIRED_FEATURES = [
  "lessons", "practice", "forecast", "diagnostics",
  "missions", "bosses", "daily", "path",
];
const CATALOG_FILES = {
  profile_math: "server/catalog.json",
  basic_math: "server/catalog_basic.json",
  russian: "server/catalog_russian.json",
};

let failures = 0;
let checks = 0;
const check = (name, condition, detail = "") => {
  checks += 1;
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"} ${name}${detail ? ` | ${detail}` : ""}`);
};

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = String(tagName).toUpperCase();
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.isConnected = true;
    this.offsetWidth = 0;
    this.offsetHeight = 0;
    this.value = "";
    this._innerHTML = "";
    this.children = [];
    this.attributes = {};
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : !!force;
        if (on) classes.add(name); else classes.delete(name);
        return on;
      },
    };
  }
  set innerHTML(value) { this._innerHTML = String(value); this.children = []; }
  get innerHTML() { return this._innerHTML; }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  insertBefore(child) { this.children.unshift(child); child.parentNode = this; return child; }
  removeChild(child) { this.children = this.children.filter((item) => item !== child); return child; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener() {}
  removeEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  focus() {}
  getClientRects() { return []; }
}

const elements = new Map();
const element = (id) => {
  if (!elements.has(id)) elements.set(id, new FakeElement(id === "screen" ? "main" : "div"));
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
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
};
const noop = () => {};
const sandbox = {
  console: { log: noop, info: noop, warn: noop, error: noop },
  setTimeout: () => 0,
  clearTimeout: noop,
  setInterval: () => 0,
  clearInterval: noop,
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: noop,
  document,
  location: { hash: "#/dashboard", href: "http://localhost/", origin: "http://localhost" },
  history: { replaceState: noop },
  localStorage: memoryStorage(),
  sessionStorage: memoryStorage(),
  navigator: { userAgent: "subject-ui-test", locks: {} },
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  scrollTo: noop,
  fetch: async (url) => {
    // Ленивые срезы каталога отдаём с диска — тест рендерит реальные экраны
    // открытого предмета. Любой другой запрос — по-прежнему запрещён.
    const u = String(url);
    const path = u.split("?")[0];
    const subjectMatch = /[?&]subject=([^&]+)/.exec(u);
    const subject = subjectMatch ? decodeURIComponent(subjectMatch[1]) : "russian";
    const source = CATALOG_FILES[subject] ? readJson(CATALOG_FILES[subject]) : null;
    const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });
    if (source && path === "/api/catalog-tasks") {
      return jsonResponse({ tasks: source.tasks || [], visualAssets: source.visualAssets || [], visualAudit: source.visualAudit || {} });
    }
    if (source && path === "/api/catalog-lessons") {
      return jsonResponse({ lessons: source.lessons || [] });
    }
    throw new Error("subject-ui test must not perform network I/O: " + u);
  },
  CustomEvent: class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
  Event: class Event { constructor(type) { this.type = type; } },
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

vm.createContext(sandbox);
vm.runInContext(
  [read("js/data.js"), read("js/state.js"), read("js/agent-spa.js"), read("js/app.js")].join("\n"),
  sandbox,
  { filename: "subject-ui-bundle.js" }
);

const contracts = Object.fromEntries(
  SUBJECT_IDS.map((id) => [id, readJson(`server/subjects/${id}.json`)])
);
const publicInfo = (contract) => ({
  id: contract.id,
  title: contract.title,
  short: contract.short,
  description: contract.description || "",
  status: contract.status,
  locked: !!contract.locked,
  comingSoon: !!contract.comingSoon,
  availability: contract.availability || contract.status,
  forecast: contract.forecast,
  features: contract.features,
  metadata: contract.metadata || {},
});
const subjects = SUBJECT_IDS.map((id) => publicInfo(contracts[id]));
const serverLikePayload = (id) => ({
  ...readJson(CATALOG_FILES[id]),
  subject: id,
  subjects,
  subjectInfo: publicInfo(contracts[id]),
  forecast: contracts[id].forecast,
});

sandbox.russianPayload = serverLikePayload("russian");
vm.runInContext(`
  DataAPI.load(russianPayload);
  Store.subject = "russian";
  Store.subjects = DataAPI.subjects();
  Store.ready = true;
  Store.state = Store.defaultState();
  Store.state.onboarded = true;
  Session.cur = null;
  Lesson.cur = null;
  Store.save = () => Promise.resolve();
  // Вендор грузится через onload <script>, которого в FakeElement нет:
  // для предмета с контентом render() доходит до Vendor.ensureMath, поэтому
  // здесь он заглушается (этот тест про экраны, а не про загрузчик).
  Vendor.ensureMath = () => Promise.resolve();
  Vendor.loadScript = () => Promise.resolve();
`, sandbox);// ---------------------------------------------------------------------------
// Контракт гейта Plus для «Моих сочинений».
// Замечание харнесса: FakeElement не парсит innerHTML в детей, поэтому
// мутации через поздний getElementById здесь ненаблюдаемы. Проверяем
// наблюдаемое: какие запросы ушли (лог fetch) и что отдают чистые
// рендереры (essayPaywallHTML / essaysBodyHTML) — саму подстановку в DOM
// гоняем вживую в браузере.
// ---------------------------------------------------------------------------
const essayCalls = [];
sandbox.fetch = async (url) => {
  essayCalls.push(String(url));
  const u = String(url);
  if (u.includes("/api/essays?history=1")) {
    return { ok: true, status: 200,
             json: async () => ({ ok: true, subject: "russian", items: [],
               total: 0, limit: 100, offset: 0, hasEssayTasks: true,
               essaySkills: ["russian_essay_source"] }) };
  }
  throw new Error("essays-ui test must not perform network I/O: " + u);
};

const MOCK_SNAP = { hasEssayTasks: true, total: 1, items: [{
  submissionId: 7, taskId: "re27_1", taskTopic: null, examNumber: "27",
  wordCount: 180, clientId: "c1", status: "ready",
  totalScore: 15, maxScore: 22, verdict: "Хорошо.", criteria: [],
  createdAt: Date.now(), evaluatedAt: Date.now() }],
  essaySkills: ["russian_essay_source"] };

async function runEssayGateChecks() {
// 1. Без подписки: screenEssays резолвится, историю не читает,
//    пейволл ведёт на тариф.
await vm.runInContext(`(async () => {
  Subscription = { status: async () => ({ active: false }) };
  location.hash = "#/essays";
  await screenEssays(document.getElementById("screen"));
})()`, sandbox);
check("ESSAYS no history fetch without Plus",
  !essayCalls.some((u) => u.includes("/api/essays")),
  `history fetch: ${essayCalls.filter((u) => u.includes("/api/essays")).join(",") || "none"}`);
const payFree = vm.runInContext(`essayPaywallHTML(false)`, sandbox);
check("ESSAYS paywall links tariff",
  payFree.includes("/subscription") && payFree.includes('class="plus"'), payFree.slice(0, 80));

// 2. Гость: истории нет, пейволл ведёт в профиль.
essayCalls.length = 0;
await vm.runInContext(`(async () => {
  Subscription = { status: async () => ({ guest: true }) };
  location.hash = "#/essays";
  await screenEssays(document.getElementById("screen"));
})()`, sandbox);
check("ESSAYS no history fetch for guest",
  !essayCalls.some((u) => u.includes("/api/essays")),
  `history fetch: ${essayCalls.filter((u) => u.includes("/api/essays")).join(",") || "none"}`);
const payGuest = vm.runInContext(`essayPaywallHTML(true)`, sandbox);
check("ESSAYS paywall links profile for guest",
  payGuest.includes("#/profile"), payGuest.slice(0, 80));

// 3. С подпиской: история читается, тело рисуется с счётчиками.
essayCalls.length = 0;
await vm.runInContext(`(async () => {
  Subscription = { status: async () => ({ active: true }) };
  location.hash = "#/essays";
  await screenEssays(document.getElementById("screen"));
})()`, sandbox);
check("ESSAYS history fetched with Plus",
  essayCalls.some((u) => u.includes("/api/essays?history=1")), `calls=${essayCalls.length}`);
const bodyHtml = vm.runInContext(`(function(){ globalThis.__snap = ${JSON.stringify(MOCK_SNAP).replace(/</g, "\\u003c")}; return essaysBodyHTML(globalThis.__snap); })()`, sandbox);
check("ESSAYS body renders counters",
  bodyHtml.includes("написано") && bodyHtml.includes("Все работы"), bodyHtml.slice(0, 80));

// 4. Карточка Пути без подписки историю не читает.
essayCalls.length = 0;
await vm.runInContext(`(async () => {
  Subscription = { status: async () => ({ active: false }) };
  location.hash = "#/path";
  EssayHistory.cache = null; EssayHistory.promise = null; EssayHistory.subject = "";
  screenPath(document.getElementById("screen"));
  await essayPathSlotLoad();
})()`, sandbox);
check("ESSAYS path slot silent without Plus",
  !essayCalls.some((u) => u.includes("/api/essays")),
  `history fetch: ${essayCalls.filter((u) => u.includes("/api/essays")).join(",") || "none"}`);

// 5. Карточка Пути с подпиской историю читает.
essayCalls.length = 0;
await vm.runInContext(`(async () => {
  Subscription = { status: async () => ({ active: true }) };
  location.hash = "#/path";
  EssayHistory.cache = null; EssayHistory.promise = null; EssayHistory.subject = "";
  screenPath(document.getElementById("screen"));
  await essayPathSlotLoad();
})()`, sandbox);
check("ESSAYS path slot fetches with Plus",
  essayCalls.some((u) => u.includes("/api/essays?history=1")), `calls=${essayCalls.length}`);
}

runEssayGateChecks().then(
  () => { console.log(`${failures ? `${failures} FAILURES` : "ALL OK"}: ${checks} checks`); process.exit(failures ? 1 : 0); },
  (error) => {
    check("essays-ui harness", false, error && (error.stack || String(error)));
    console.log(`${failures ? `${failures} FAILURES` : "ALL OK"}: ${checks} checks`);
    process.exit(1);
  }
);
