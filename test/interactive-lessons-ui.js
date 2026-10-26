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

console.log(fails ? fails + " FAILURES" : "ALL ILESSONS UI OK");
process.exit(fails ? 1 : 0);
