/* Durable client-side subject contract guard.
   Runs the real data/state/app modules in a browser-shaped VM. */
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
  fetch: async () => { throw new Error("subject-ui test must not perform network I/O"); },
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
  [read("js/data.js"), read("js/state.js"), read("js/app.js")].join("\n"),
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
`, sandbox);

const sectionRoutes = ["training", "errors", "trials", "stats"];
const taskRoutes = ["session", "practice", "boss", "daily", "review", "lesson"];
const routes = [...sectionRoutes, ...taskRoutes];
const parents = {
  session: "training",
  practice: "training",
  boss: "trials",
  daily: "trials",
  review: "trials",
  lesson: "path",
};

vm.runInContext(`
  globalThis.renderLockedRoutes = async () => {
    const output = {};
    for (const route of ${JSON.stringify(routes)}) {
      location.hash = "#/" + route;
      document.getElementById("screen").innerHTML = "";
      await render();
      output[route] = {
        html: document.getElementById("screen").innerHTML,
        parent: typeof taskParentRoute === "function" ? taskParentRoute(route) : null,
      };
    }
    return output;
  };
`, sandbox);
async function runBehavioralChecks() {
const rendered = await vm.runInContext("renderLockedRoutes()", sandbox);

const titleOf = (html) => {
  const match = /<div class="page-title">([\s\S]*?)<\/div>/.exec(html);
  return match ? match[1].replace(/<[^>]+>/g, "").trim() : "";
};
const visibleText = (html) => html
  .replace(/<svg\b[\s\S]*?<\/svg>/g, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ")
  .replace(/\s+/g, " ")
  .trim();
const routeEvidence = routes.map((route) => ({
  route,
  nonEmpty: rendered[route].html.trim().length > 0,
  title: titleOf(rendered[route].html),
}));
const invalidSections = routeEvidence.filter((item) => !item.nonEmpty || !item.title);
check(
  `SECTION PARITY non-empty/title (${routes.length} routes)`,
  invalidSections.length === 0,
  invalidSections.map((item) => `${item.route}: title=${JSON.stringify(item.title)}`).join("; ") || "all rendered",
);

const byText = new Map();
for (const route of routes) {
  const text = visibleText(rendered[route].html);
  byText.set(text, [...(byText.get(text) || []), route]);
}
const collisions = [...byText.entries()].filter(([, routeList]) => routeList.length > 1);
check(
  `SECTION PARITY distinct text (${routes.length} routes)`,
  collisions.length === 0 && byText.size === routes.length,
  collisions.map(([, routeList]) => routeList.join("=")).join("; ") || `${byText.size} unique renderings`,
);

const exitEvidence = taskRoutes.map((route) => {
  const html = rendered[route].html;
  const button = /<button\b[^>]*onclick="go\('([^']+)'\)"[^>]*>/.exec(html);
  const actual = button ? button[1] : null;
  return {
    route,
    actual,
    expected: parents[route],
    helper: rendered[route].parent,
    enabled: !!button && !/\bdisabled\b/.test(button[0]),
  };
});
const badExits = exitEvidence.filter((item) =>
  item.actual !== item.expected || item.helper !== item.expected || !item.enabled
);
check(
  `TASK-ROUTE EXIT parent controls (${taskRoutes.length} routes)`,
  badExits.length === 0,
  exitEvidence.map((item) => `${item.route}->${item.actual || "missing"}`).join(", "),
);

vm.runInContext(`
  Store.state = Store.defaultState();
  const xpBefore = Store.state.xp;
  const awarded = addXp(100, "subject-ui-isolation-test");
  globalThis.fakeLearningResult = {
    next: nextStepCandidates(),
    content: DataAPI.hasLearningContent(),
    forecast: DataAPI.forecastConfig(),
    awarded,
    xpBefore,
    xpAfter: Store.state.xp,
    daily: dailyTaskIds(),
    dailyState: Store.state.daily,
  };
`, sandbox);
const fake = sandbox.fakeLearningResult;
check("NO FAKE LEARNING DATA recommendations", Array.isArray(fake.next) && fake.next.length === 0);
check("NO FAKE LEARNING DATA content selector", fake.content === false);
check("NO FAKE LEARNING DATA forecast config", fake.forecast === null);
check(
  "NO FAKE LEARNING DATA XP guard",
  fake.awarded === 0 && fake.xpBefore === 0 && fake.xpAfter === 0,
  `returned=${fake.awarded}, xp=${fake.xpAfter}`,
);
check(
  "NO FAKE LEARNING DATA daily selection",
  Array.isArray(fake.daily)
  && fake.daily.length === 0
  && fake.dailyState.date === null
  && fake.dailyState.solved === 0
  && fake.dailyState.done === false
  && Array.isArray(fake.dailyState.taskIds)
  && fake.dailyState.taskIds.length === 0,
);

for (const id of SUBJECT_IDS) {
  sandbox.contractPayload = serverLikePayload(id);
  vm.runInContext(`
    DataAPI.load(contractPayload);
    globalThis.contractInfoResult = (() => {
      const contractItem = DataAPI.subjectInfo(${JSON.stringify(id)});
      return contractItem ? { features: contractItem.features, id: contractItem.id } : null;
    })();
  `, sandbox);
  const info = sandbox.contractInfoResult;
  const features = info && info.features;
  check(
    `CONTRACT COMPLETENESS ${id}`,
    !!info && info.id === id
    && !!features && typeof features === "object" && !Array.isArray(features)
    && Object.keys(features).sort().join(",") === [...REQUIRED_FEATURES].sort().join(","),
    features ? Object.keys(features).sort().join(",") : "missing",
  );
}

console.log(`${failures ? `${failures} FAILURES` : "ALL OK"}: ${checks} checks`);
}

runBehavioralChecks().then(
  () => process.exit(failures ? 1 : 0),
  (error) => {
    check("subject-ui harness", false, error && (error.stack || String(error)));
    console.log(`${failures ? `${failures} FAILURES` : "ALL OK"}: ${checks} checks`);
    process.exit(1);
  }
);
