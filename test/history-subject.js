/* Client-side regression: an opened history subject exposes its real topics:
   part 1 №1–12 (auto-checked short-answer practice, maps/images with local
   visuals) and part 2 №13–21 (self-checked against the official solution).
   Lessons are on: one per line. */
const fs = require("fs");
const vm = require("vm");
const catalog = JSON.parse(fs.readFileSync("server/catalog_history.json", "utf8"));
catalog.subject = "history";
catalog.subjects = [
  { id: "profile_math", title: "Профильная математика", status: "ready", features: { lessons: true, practice: true, forecast: true } },
  { id: "basic_math", title: "Базовая математика", status: "ready", features: { lessons: true, practice: true, forecast: true } },
  { id: "history", title: "История", status: "ready", locked: false, features: { lessons: true, practice: true, forecast: true, diagnostics: true, missions: true, bosses: true, daily: true, path: true } },
];
const sandbox = { console, catalog, setTimeout, clearTimeout };
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync("js/data.js", "utf8") + "\n" + fs.readFileSync("js/state.js", "utf8") +
  `\n;DataAPI.load(catalog); Store.ready = true; Store.state = Store.defaultState();`,
  sandbox,
  { filename: "history-client.js" }
);
let fails = 0;
const check = (name, condition) => { console.log(`${condition ? "ok  " : "FAIL"} ${name}`); if (!condition) fails++; };
vm.runInContext(`
  globalThis.historyChecks = {
    skillIds: DataAPI.skills().map((item) => item.id),
    skills: DataAPI.skills().length,
    locked: DataAPI.isSubjectLocked(),
    available: DataAPI.isSubjectAvailable(),
    empty: DataAPI.isSubjectEmpty(),
    content: DataAPI.hasLearningContent(),
    tasks: DataAPI.tasks().length,
    practice: DataAPI.practiceTasks().length,
    lessons: DataAPI.lessons().length,
    missions: DataAPI.missions().length,
    bosses: DataAPI.bosses().length,
    diagnostics: DataAPI.diagnosticTasks().length,
    daily: DataAPI.daily().target,
    dailyPicked: dailyTaskIds(),
    auto: DataAPI.tasks().filter((t) => (t.check || "auto") === "auto").length,
    self: DataAPI.tasks().filter((t) => t.check === "self").length,
    visuals: DataAPI.tasks().filter((t) => t.visual && t.visual.assetId).length,
    next: nextStepCandidates(),
  };
`, sandbox);
const result = sandbox.historyChecks;
const EXPECTED_SKILLS = ["h01_dates", "h02_chrono", "h03_facts", "h04_table", "h05_persons", "h06_source", "h07_culture", "h08_image", "h09_map", "h10_map", "h11_maptext", "h12_mapchoice", "h13_attr", "h14_search", "h15_imgout", "h16_wow", "h17_causes", "h18_terms", "h19_termfact", "h20_args", "h21_thesis"];
check("история зарегистрирована и открыта с уроками", result.locked === false && result.available === true);
check("21 тема экзамена на месте", result.skills === 21 && EXPECTED_SKILLS.every((id) => result.skillIds.includes(id)));
check("практика и уроки открыты, миссии и боссы на месте",
  result.content === true && result.tasks > 0 && result.practice === result.tasks && result.lessons === 21 && result.missions === 21 && result.bosses === 4);
check("часть 1 — автопроверка, часть 2 — самопроверка", result.auto > 0 && result.self > 0 && result.auto + result.self === result.tasks);
check("карты и изображения — с рисунками", result.visuals >= 400);
check("диагностика и ежедневная подборка подключены", result.diagnostics === 6 && result.daily === 5 && result.dailyPicked.length === 5);
check("своих достижений каталог не описывает — сервер подставляет стандартный набор",
  vm.runInContext(`DataAPI.achievements().length`, sandbox) === 0);
check("рекомендации предлагают реальную практику", Array.isArray(result.next) && result.next.length > 0);
vm.runInContext(`Store.state = Store.defaultState(); applyOnboarding("history", null, null, [], "Тест"); globalThis.historyState = { xp: Store.state.xp, solved: Store.state.totalSolved, stats: Store.state.skillStats, attempts: Store.state.taskAttempts, timeline: Store.state.timeline, daily: Store.state.daily, lessons: Store.state.completedLessons, missions: Store.state.missionsDone, achievements: Store.state.achievements, adjustments: Store.state.xpAdjustments };`, sandbox);
check("онбординг не создаёт XP или фиктивную статистику", sandbox.historyState.xp === 0 && sandbox.historyState.solved === 0 && JSON.stringify(Object.keys(sandbox.historyState.stats).sort()) === JSON.stringify(result.skillIds.slice().sort()));
check("профиль без событий: попыток/таймлайна/daily нет", sandbox.historyState.attempts.length === 0 && sandbox.historyState.timeline.length === 0 && sandbox.historyState.daily.taskIds.length === 0 && Object.keys(sandbox.historyState.lessons).length === 0 && Object.keys(sandbox.historyState.missions).length === 0 && Object.keys(sandbox.historyState.achievements).length === 0 && sandbox.historyState.adjustments.length === 0);

/* Parity with the two published math subjects: a ready catalog keeps its
   per-skill zero buckets and can recommend real work. */
const profileCatalog = JSON.parse(fs.readFileSync("server/catalog.json", "utf8"));
const basicCatalog = JSON.parse(fs.readFileSync("server/catalog_basic.json", "utf8"));
const registry = [
  { id: "profile_math", title: "Профильная математика", status: "ready", locked: false, comingSoon: false, features: { lessons: true, practice: true, forecast: true, diagnostics: true, missions: true, bosses: true, daily: true } },
  { id: "basic_math", title: "Базовая математика", status: "ready", locked: false, comingSoon: false, features: { lessons: true, practice: true, forecast: true, diagnostics: true, missions: true, bosses: true, daily: true } },
  { id: "history", title: "История", status: "ready", locked: false, comingSoon: false, features: { lessons: true, practice: true, forecast: true, diagnostics: true, missions: true, bosses: true, daily: true } },
];
function readyCatalog(source, id) {
  return { ...source, subject: id, subjects: registry, forecast: { weights: {}, total: 1, scale: [0, 1] } };
}
function inspectReady(source, id) {
  sandbox.catalog = readyCatalog(source, id);
  vm.runInContext(`
    DataAPI.load(catalog);
    Store.subject = DataAPI.currentSubject();
    Store.ready = false;
    Store.state = Store.defaultState();
    globalThis.parityResult = {
      available: DataAPI.isSubjectAvailable(),
      empty: DataAPI.isSubjectEmpty(),
      skills: DataAPI.availableSkills().length,
      stats: Object.keys(Store.state.skillStats).length,
      next: nextStepCandidates().length,
    };
  `, sandbox);
  return sandbox.parityResult;
}
const profileParity = inspectReady(profileCatalog, "profile_math");
const basicParity = inspectReady(basicCatalog, "basic_math");
check("профиль: ready-контракт и нулевые skillStats сохраняются", profileParity.available && !profileParity.empty && profileParity.stats === profileParity.skills && profileParity.next > 0);
check("база: ready-контракт и нулевые skillStats сохраняются", basicParity.available && !basicParity.empty && basicParity.stats === basicParity.skills && basicParity.next > 0);

/* Account/session boundary: a subject response without auth may preserve the
   session only for the same account; a changed account fails closed. */
vm.runInContext(`
  Store.accountId = "account-a";
  Store.auth = { registered: true, email: "a@example.test" };
  Store._applyBootstrap({ catalog: catalog, accountId: "account-b", state: { subject: "history" } });
  globalThis.authBoundary = { accountId: Store.accountId, registered: Store.auth.registered };
`, sandbox);
check("смена accountId без auth не сохраняет старую сессию", sandbox.authBoundary.accountId === "account-b" && sandbox.authBoundary.registered === false);

console.log(fails ? `${fails} FAILURES` : "ALL OK");
process.exit(fails ? 1 : 0);
