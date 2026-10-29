/* Интерактивные уроки (БЕТА): клиентский контракт.
   Реальные js/data.js + js/state.js + js/app.js в VM-песочнице без DOM:
   селекторы DataAPI, topic-хелперы, экран (заглушка/урок/скелет),
   завершение с XP один раз, кнопка в модалке темы.
   Статика, без сервера. */
const fs = require("fs");
const vm = require("vm");

let fails = 0;
const t = (name, cond, detail) => {
  console.log((cond ? "ok   " : "FAIL ") + name + (detail && !cond ? " | " + detail : ""));
  if (!cond) fails++;
};

const read = (p) => fs.readFileSync(p, "utf8");
const dataJs = read("js/data.js");
const stateJs = read("js/state.js");
const appJs = read("js/app.js");

function block(src, marker) {
  const i = src.indexOf(marker);
  if (i < 0) throw new Error("not found: " + marker);
  let depth = 0, j = src.indexOf("{", i);
  for (; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (!depth) break; }
  }
  return src.slice(i, j + 1);
}

/* ---------- DataAPI ---------- */
{
  const sb = { console };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(dataJs, sb);
  const setup = `
    DataAPI.load({
      subject: "profile_math", subjectId: "profile_math",
      subjects: [{ id: "profile_math", status: "ready" }],
      categories: [{ id: "c1", name: "Часть 1" }],
      skills: [{ id: "n01", name: "Планиметрия", cat: "c1" }],
      tasks: [], lessons: [], missions: [], bosses: [],
      interactiveLessons: [
        { id: "v-meta", skill: "n01", title: "Мета", xp: 10, scenesCount: 2, _meta: true }
      ],
    });
  `;
  vm.runInContext(setup, sb);
  // Summary-подобная загрузка: полных сцен нет — деталей ждут.
  const r1 = vm.runInContext(
    `({ full: DataAPI.ilessonsReady(),
        all: DataAPI.ilessons().map((x) => x.id),
        bySkill: DataAPI.ilessonsBySkill("n01").map((x) => x.id),
        metaCount: DataAPI.ilessonScenesCount(DataAPI.ilesson("v-meta")) })`, sb);
  t("meta visible without full scenes", JSON.stringify(r1.all) === '["v-meta"]', JSON.stringify(r1));
  t("details not ready on meta", r1.full === false);
  t("bySkill meta only", JSON.stringify(r1.bySkill) === '["v-meta"]', JSON.stringify(r1.bySkill));
  t("meta scenesCount works", r1.metaCount === 2, JSON.stringify(r1));
  vm.runInContext(
    `DataAPI.loadDetails({ interactiveLessons: [
        { id: "v-01", skill: "n01", title: "Визуал", subtitle: "sub", xp: 30,
          scenes: [{ title: "S1", text: "hello" }, { text: "world" }] }
      ] })`, sb);
  const r2 = vm.runInContext(
    `({ full: DataAPI.ilessonsReady(),
        all: DataAPI.ilessons().map((x) => x.id),
        one: (DataAPI.ilesson("v-01") || {}).title,
        count: DataAPI.ilessonScenesCount(DataAPI.ilesson("v-01")),
        access: (DataAPI.ilessonForAccess("v-01") || {}).id,
        noAccess: DataAPI.ilessonForAccess("v-nope") })`, sb);
  t("details ready after slice", r2.full === true);
  t("full ilesson listed", JSON.stringify(r2.all) === '["v-01"]', JSON.stringify(r2.all));
  t("scenes counted", r2.count === 2);
  t("access ok / unknown null", r2.access === "v-01" && r2.noAccess === null, JSON.stringify(r2));
  // Чужой skill в details не принимается.
  vm.runInContext(`DataAPI.loadDetails({ interactiveLessons: [{ id: "v-x", skill: "zzz", title: "X", scenes: [{ text: "t" }] }] })`, sb);
  const r3 = vm.runInContext(`DataAPI.ilesson("v-x")`, sb);
  t("foreign skill rejected", r3 === null);
}

/* ---------- topic-хелперы ---------- */
{
  const code = [
    block(dataJs, "const DataAPI = {").slice(0, 0), // noop keep order
  ];
  const sb = { console };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(dataJs, sb);
  vm.runInContext(block(appJs, "function nonNegativeNumber("), sb);
  vm.runInContext(block(appJs, "function topicHasLesson("), sb);
  vm.runInContext(block(appJs, "function topicHasInteractiveLesson("), sb);
  vm.runInContext(block(appJs, "function topicHasPractice("), sb);
  vm.runInContext(block(appJs, "function topicHasLearningContent("), sb);
  vm.runInContext(`
    DataAPI.load({
      subject: "profile_math", subjectId: "profile_math",
      subjects: [{ id: "profile_math", status: "ready" }],
      categories: [{ id: "c1", name: "C" }],
      skills: [{ id: "n01", name: "T", cat: "c1" }],
      tasks: [], lessons: [], missions: [], bosses: [],
      interactiveLessons: [{ id: "v-01", skill: "n01", title: "V", xp: 1,
        scenes: [{ text: "t" }] }],
    });
    this.__r = {
      has: topicHasInteractiveLesson({ id: "n01" }),
      none: topicHasInteractiveLesson({ id: "zzz" }),
      content: topicHasLearningContent({ id: "n01" }),
    };`, sb);
  t("topic has ilesson", sb.__r.has === true);
  t("unknown topic has none", sb.__r.none === false);
  t("learning content includes ilesson", sb.__r.content === true);
}

/* ---------- completeInteractiveLesson: XP один раз ---------- */
{
  const sb = { console };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(`
    const safeObject = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
    const GUEST_STEP_LESSON = 3;
    const Store = { state: { completedILessons: {}, xp: 0 }, save() {} };
    const DataAPI = { ilessonForAccess: (id) => (id === "v-01"
      ? { id: "v-01", skill: "n01", title: "V", xp: 30 } : null) };
    const subjectLearningAvailable = () => true;
    const skillIsAccessible = () => true;
    let xpGiven = 0;
    const touchStreak = () => {};
    const addXp = (n) => { xpGiven += n; };
    const addTimeline = () => {};
    const bumpGuestSteps = () => {};
    const recordForecastSnapshot = () => {};
    const checkAchievements = () => {};
  `, sb);
  vm.runInContext(block(stateJs, "function completeInteractiveLesson("), sb);
  const out = vm.runInContext(`(function () {
    const first = completeInteractiveLesson("v-01");
    const second = completeInteractiveLesson("v-01");
    return { first, second, xpGiven, stored: Store.state.completedILessons };
  })()`, sb);
  t("first completion pays xp", out.first.firstCompletion === true && out.first.totalXp === 30, JSON.stringify(out.first));
  t("repeat pays nothing", out.second.firstCompletion === false && out.second.totalXp === 0, JSON.stringify(out.second));
  t("xp given once", out.xpGiven === 30, JSON.stringify(out.xpGiven));
  t("completion stored", !!out.stored["v-01"], JSON.stringify(out.stored));
}

/* ---------- screenInteractiveLesson: заглушка / урок / скелет ---------- */
{
  const iconsSrc = appJs.slice(appJs.indexOf("const ICONS = {"), appJs.indexOf("};", appJs.indexOf("const ICONS = {")) + 2);
  const code = [
    iconsSrc,
    block(appJs, "function esc("),
    block(appJs, "function icon("),
    block(stateJs, "function plural("),
    block(appJs, "function ilessonModuleName("),
    "const __ilessonScriptCache = {};",
    block(appJs, "function ilessonLoadModule("),
    block(appJs, "function ilessonSetCleanup("),
    block(appJs, "function renderStaticILesson("),
    block(appJs, "function screenInteractiveLesson("),
    block(appJs, "function finishInteractiveLesson("),
  ].join("\n");
  const run = (stub) => {
    const sb = Object.assign({ console }, stub);
    sb.window = sb;
    vm.createContext(sb);
    vm.runInContext(code, sb);
    vm.runInContext("this.__root = { innerHTML: \"\" }; screenInteractiveLesson(this.__root);", sb);
    return sb.__root.innerHTML;
  };
  const base = {
    routeParam: () => "n01",
    subjectSkillById: (id) => ({ id, name: "№1 — Планиметрия", ege: "№1" }),
    topicDisplayName: (s) => s.name,
    topicCategory: () => ({ title: "Часть 1" }),
    subjectDisplayName: (s) => s.title,
    go: () => {}, startSkillPractice: () => {},
    mathText: (s) => String(s),
    pageLoaderHTML: (s) => "LOADER:" + s,
    currentRoute: () => "ilesson",
    render: () => {},
    katex: {},
    Store: { state: { completedILessons: {} }, ensureDetails: () => Promise.resolve() },
  };
  // Ничего нет — заглушка с БЕТА и практикой.
  const htmlEmpty = run(Object.assign({}, base, {
    DataAPI: { ilessonsBySkill: () => [], ilessonsReady: () => true },
  }));
  t("placeholder for missing lesson", htmlEmpty.includes("скоро появится") && htmlEmpty.includes("БЕТА")
    && htmlEmpty.includes("startSkillPractice"), htmlEmpty.slice(0, 120));
  // Мета без сцен + детали не готовы — скелет и один фоновый fetch.
  let fetched = 0;
  const sb2 = Object.assign({ console }, base, {
    routeParam: () => "n01",
    DataAPI: {
      ilessonsBySkill: () => [{ id: "v-01", skill: "n01", title: "V", scenesCount: 2, _meta: true }],
      ilessonsReady: () => false,
    },
    katex: {},
    Store: { state: { completedILessons: {} }, ensureDetails: () => { fetched++; return Promise.resolve(); } },
  });
  sb2.window = sb2;
  vm.createContext(sb2);
  vm.runInContext(code, sb2);
  vm.runInContext("this.__root = { innerHTML: \"\" }; screenInteractiveLesson(this.__root);", sb2);
  t("meta without scenes shows loader", sb2.__root.innerHTML.includes("LOADER"), sb2.__root.innerHTML.slice(0, 80));
  t("single background fetch", fetched === 1);
  // Полные сцены — урок с кнопкой завершения.
  const htmlFull = run(Object.assign({}, base, {
    DataAPI: {
      ilessonsBySkill: () => [{ id: "v-01", skill: "n01", title: "Визуал", xp: 30,
        scenes: [{ title: "S1", text: "hello" }] }],
      ilessonsReady: () => true,
    },
  }));
  t("real lesson renders scenes", htmlFull.includes("S1") && htmlFull.includes("finishInteractiveLesson"), htmlFull.slice(0, 120));
}

/* ---------- модалка темы: кнопка есть всегда ---------- */
{
  t("modal has visual button",
    /openInteractiveLesson\('\$\{esc\(skillId\)\}'\)/.test(appJs)
    && appJs.includes("btn--visual")
    && appJs.includes("Интерактивный урок"));
  t("training lists ilessons section",
    appJs.includes("Интерактивные уроки") && appJs.includes("DataAPI.ilessons()"));
  t("ilesson route wired",
    appJs.includes('ilesson: screenInteractiveLesson')
    && appJs.includes('"ilesson"')
    && appJs.includes('route === "ilesson"'));
}

/* ---------- модули уроков: имя, mount, fallback, cleanup ---------- */
{
  const sb = { console };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext([
    block(appJs, "function ilessonModuleName("),
    block(appJs, "function ilessonSetCleanup("),
    block(appJs, "function renderStaticILesson("),
  ].join("\n"), sb);
  const nm = (il) => vm.runInContext(`ilessonModuleName(${JSON.stringify(il)})`, sb);
  t("module name ok", nm({ js: "v-trig-01" }) === "v-trig-01");
  t("module name rejects traversal", nm({ js: "../x" }) === "");
  t("module name rejects spaces", nm({ js: "a b" }) === "");
  t("module name rejects empty", nm({}) === "" && nm({ js: "" }) === "" && nm(null) === "");
  // cleanup: новый сносит старый.
  vm.runInContext(`var __calls = [];
    ilessonSetCleanup(() => { __calls.push("first"); });
    ilessonSetCleanup(() => { __calls.push("second"); });`, sb);
  const calls = vm.runInContext("__calls", sb);
  t("cleanup replaced, old called once", JSON.stringify(calls) === '["first"]', JSON.stringify(calls));
  vm.runInContext(`ilessonSetCleanup(null);`, sb);
  const afterNull = vm.runInContext(`typeof window.__ilessonCleanup`, sb);
  t("cleanup cleared", afterNull === "object", afterNull); // null
}

{
  // mount-путь: модуль из реестра грузится без DOM и монтируется в #ilessonApp.
  const iconsSrc = appJs.slice(appJs.indexOf("const ICONS = {"), appJs.indexOf("};", appJs.indexOf("const ICONS = {")) + 2);
  const code = [
    iconsSrc,
    block(appJs, "function esc("),
    block(appJs, "function icon("),
    block(stateJs, "function plural("),
    block(appJs, "function ilessonModuleName("),
    "const __ilessonScriptCache = {};",
    block(appJs, "function ilessonLoadModule("),
    block(appJs, "function ilessonSetCleanup("),
    block(appJs, "function renderStaticILesson("),
    block(appJs, "function screenInteractiveLesson("),
    block(appJs, "function finishInteractiveLesson("),
  ].join("\n");
  const flush = () => new Promise((res) => setTimeout(res, 10));
  (async () => {
    // mount вызван, cleanup записан.
    let mountedApi = null, cleaned = 0;
    const sb = {
      console,
      routeParam: () => "n01",
      subjectSkillById: (id) => ({ id, name: "T", ege: "№1" }),
      topicDisplayName: (s) => s.name,
      topicCategory: () => ({ title: "C" }),
      subjectDisplayName: (s) => s.title,
      go: () => {}, startSkillPractice: () => {},
      mathText: (s) => String(s),
      pageLoaderHTML: (s) => "LOADER:" + s,
      currentRoute: () => "ilesson",
      render: () => {},
      katex: {},
      Store: { state: { completedILessons: {} }, ensureDetails: () => Promise.resolve() },
      DataAPI: {
        ilessonsBySkill: () => [{ id: "v-01", skill: "n01", title: "V", js: "v-x",
          scenes: [{ title: "S1", text: "hello" }] }],
        ilessonsReady: () => true,
      },
      ILessonModules: { "v-x": { mount: (api) => { mountedApi = api; return () => { cleaned++; }; } } },
      document: { getElementById: (id) => (id === "ilessonApp" ? { innerHTML: "<div>app</div>" } : null) },
      completeInteractiveLesson: () => ({ firstCompletion: true, totalXp: 30 }),
      toast: () => {},
    };
    sb.window = sb;
    vm.createContext(sb);
    vm.runInContext(code, sb);
    vm.runInContext("this.__root = { innerHTML: \"\" }; screenInteractiveLesson(this.__root);", sb);
    t("module mode shows app shell", sb.__root.innerHTML.includes('id="ilessonApp"'), sb.__root.innerHTML.slice(0, 100));
    await flush(); await flush();
    t("module mounted with api", !!mountedApi && mountedApi.ilesson.id === "v-01" && typeof mountedApi.finish === "function");
    vm.runInContext("window.__ilessonCleanup()", sb);
    t("cleanup runs module teardown", cleaned === 1);
    // fallback: модуля нет — статичные сцены.
    const sb2 = Object.assign({}, sb, {
      ILessonModules: {},
      document: { getElementById: () => null },
      DataAPI: {
        ilessonsBySkill: () => [{ id: "v-02", skill: "n01", title: "V2", js: "v-missing",
          scenes: [{ title: "S9", text: "static" }] }],
        ilessonsReady: () => true,
      },
    });
    sb2.window = sb2;
    vm.createContext(sb2);
    vm.runInContext(code, sb2);
    vm.runInContext("this.__root = { innerHTML: \"\" }; screenInteractiveLesson(this.__root);", sb2);
    await flush(); await flush();
    t("missing module falls back to static", sb2.__root.innerHTML.includes("S9"), sb2.__root.innerHTML.slice(0, 120));
    // гейт вендора: без katex — скелет + одна фоновая загрузка, затем render.
    // Именно этот путь чинит «сырой TeX вместо формул» с живого скриншота.
    let ensured = 0, renders = 0;
    const sb3 = {
      console,
      routeParam: () => "n01",
      subjectSkillById: (id) => ({ id, name: "T", ege: "№1" }),
      topicDisplayName: (s) => s.name,
      topicCategory: () => ({ title: "C" }),
      subjectDisplayName: (s) => s.title,
      go: () => {}, startSkillPractice: () => {},
      mathText: (s) => String(s),
      pageLoaderHTML: (s) => "LOADER:" + s,
      currentRoute: () => "ilesson",
      render: () => { renders++; },
      Vendor: { ensureMath: () => { ensured++; return Promise.resolve(); } },
      Store: { state: { completedILessons: {} }, ensureDetails: () => Promise.resolve() },
      DataAPI: {
        ilessonsBySkill: () => [{ id: "v-03", skill: "n01", title: "V3",
          scenes: [{ title: "S1", text: "x" }] }],
        ilessonsReady: () => true,
      },
    };
    sb3.window = sb3;
    vm.createContext(sb3);
    vm.runInContext(code, sb3);
    vm.runInContext("this.__root = { innerHTML: \"\" }; screenInteractiveLesson(this.__root);", sb3);
    t("no katex shows math loader", sb3.__root.innerHTML.includes("LOADER"), sb3.__root.innerHTML.slice(0, 80));
    await flush(); await flush();
    t("vendor fetched once", ensured === 1, String(ensured));
    t("screen re-rendered after vendor", renders === 1, String(renders));
  })().then(() => {
    console.log(fails ? fails + " FAILURES" : "ALL ILESSONS UI OK");
    process.exit(fails ? 1 : 0);
  }).catch((e) => {
    console.log("FAIL async harness " + (e && e.message));
    process.exit(1);
  });
}
