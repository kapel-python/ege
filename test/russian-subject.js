/* Client-side regression: a coming-soon subject exposes its real locked topic,
   but no learning entities, recommendations, diagnostics, daily selection or XP. */
const fs = require("fs");
const vm = require("vm");
const catalog = JSON.parse(fs.readFileSync("server/catalog_russian.json", "utf8"));
catalog.subject = "russian";
catalog.subjects = [
  { id: "profile_math", title: "Профильная математика", status: "ready", features: { lessons: true, practice: true, forecast: true } },
  { id: "basic_math", title: "Базовая математика", status: "ready", features: { lessons: true, practice: true, forecast: true } },
  { id: "russian", title: "Русский язык", status: "coming-soon", locked: true, features: { lessons: false, practice: false, forecast: false, path: true } },
];
const sandbox = { console, catalog, setTimeout, clearTimeout };
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync("js/data.js", "utf8") + "\n" + fs.readFileSync("js/state.js", "utf8") +
  `\n;DataAPI.load(catalog); Store.ready = true; Store.state = Store.defaultState();`,
  sandbox,
  { filename: "russian-client.js" }
);
let fails = 0;
const check = (name, condition) => { console.log(`${condition ? "ok  " : "FAIL"} ${name}`); if (!condition) fails++; };
vm.runInContext(`
  globalThis.russianChecks = {
    topic: DataAPI.skills().find((item) => item.id === "russian_essay"),
    category: DataAPI.categories().find((item) => item.id === "russian_writing"),
    locked: DataAPI.isSubjectLocked(),
    empty: DataAPI.isSubjectEmpty(),
    content: DataAPI.hasLearningContent(),
    tasks: DataAPI.tasks().length,
    lessons: DataAPI.lessons().length,
    missions: DataAPI.missions().length,
    diagnostics: DataAPI.diagnosticTasks().length,
    daily: DataAPI.daily().target,
    achievements: DataAPI.achievements().length,
    next: nextStepCandidates(),
  };
`, sandbox);
const result = sandbox.russianChecks;
check("русский предмет зарегистрирован", result.locked === true);
check("реальная locked-тема видна в каталоге", !!result.topic && result.topic.name === "Итоговое сочинение" && result.topic.locked === true);
check("категория темы видна", !!result.category);
check("в предмете нет учебных сущностей", result.content === false && result.tasks === 0 && result.lessons === 0 && result.missions === 0 && result.diagnostics === 0);
check("нет daily/достижений для пустого предмета", result.daily === 0 && result.achievements === 0);
check("рекомендации не предлагают несуществующую практику", Array.isArray(result.next) && result.next.length === 0);
vm.runInContext(`applyOnboarding("russian", null, null, [], "Тест"); globalThis.russianState = { xp: Store.state.xp, solved: Store.state.totalSolved, stats: Store.state.skillStats, attempts: Store.state.taskAttempts, timeline: Store.state.timeline, daily: Store.state.daily, lessons: Store.state.completedLessons, missions: Store.state.missionsDone, achievements: Store.state.achievements, adjustments: Store.state.xpAdjustments };`, sandbox);
check("онбординг не создаёт XP или фиктивную статистику", sandbox.russianState.xp === 0 && sandbox.russianState.solved === 0 && Object.keys(sandbox.russianState.stats).length === 0);
check("locked-профиль не получает учебные события", sandbox.russianState.attempts.length === 0 && sandbox.russianState.timeline.length === 0 && sandbox.russianState.daily.taskIds.length === 0 && Object.keys(sandbox.russianState.lessons).length === 0 && Object.keys(sandbox.russianState.missions).length === 0 && Object.keys(sandbox.russianState.achievements).length === 0 && sandbox.russianState.adjustments.length === 0);
/* Parity with the two published math subjects: a ready catalog keeps its
   per-skill zero buckets and can recommend real work; only the Russian
   coming-soon catalog is metadata-only. */
const profileCatalog = JSON.parse(fs.readFileSync("server/catalog.json", "utf8"));
const basicCatalog = JSON.parse(fs.readFileSync("server/catalog_basic.json", "utf8"));
const registry = [
  { id: "profile_math", title: "Профильная математика", status: "ready", locked: false, comingSoon: false, features: { lessons: true, practice: true, forecast: true, diagnostics: true, missions: true, bosses: true, daily: true } },
  { id: "basic_math", title: "Базовая математика", status: "ready", locked: false, comingSoon: false, features: { lessons: true, practice: true, forecast: true, diagnostics: true, missions: true, bosses: true, daily: true } },
  { id: "russian", title: "Русский язык", status: "coming-soon", locked: true, comingSoon: true, features: { lessons: false, practice: false, forecast: false, diagnostics: false, missions: false, bosses: false, daily: false, path: true } },
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

/* Future publication of the same Russian registry must not need a new client
   branch: unlocking the metadata and adding one real node opens only that
   node's learning surfaces. */
const futureRussian = {
  ...catalog,
  status: "ready",
  locked: false,
  comingSoon: false,
  availability: "ready",
  features: { lessons: true, practice: true, forecast: true, diagnostics: true, missions: true, bosses: true, daily: true, path: true },
  subjects: registry.map((item) => item.id === "russian"
    ? { ...item, status: "ready", locked: false, comingSoon: false, availability: "ready", features: { lessons: true, practice: true, forecast: true, diagnostics: true, missions: true, bosses: true, daily: true, path: true } }
    : item),
  categories: [{ id: "russian_writing", name: "Русский язык", status: "ready", locked: false, subject: "russian" }],
  skills: [{ id: "russian_essay", name: "Итоговое сочинение", cat: "russian_writing", status: "ready", locked: false, subject: "russian" }],
  tasks: [{ id: "russian_task_1", skill: "russian_essay", diff: 1, text: "Условие", answer: "1", subject: "russian" }],
  lessons: [{ id: "russian_lesson_1", skill: "russian_essay", title: "Урок", steps: [{ id: "step-1" }], subject: "russian" }],
  missions: [{ id: "russian_mission_1", skill: "russian_essay", title: "Практика", tasks: ["russian_task_1"] }],
  achievements: [{ id: "russian_achievement_1", name: "Первый русский шаг" }],
  daily: { skill: "russian_essay", target: 1, xp: 10, title: "Подборка" },
  goals: [{ id: "russian_goal_1", label: "Русский" }],
  diagnosticTasks: ["russian_task_1"],
  forecast: { weights: { russian_essay: 1 }, total: 1, scale: [0, 1] },
};
sandbox.catalog = futureRussian;
vm.runInContext(`
  DataAPI.load(catalog);
  Store.subject = DataAPI.currentSubject();
  Store.ready = false;
  Store.state = Store.defaultState();
  globalThis.futureResult = {
    available: DataAPI.isSubjectAvailable(),
    task: DataAPI.practiceTasks().length,
    lesson: DataAPI.lessons().length,
    mission: DataAPI.missions().length,
    achievement: DataAPI.achievements().length,
    diagnostic: DataAPI.diagnosticTasks().length,
    daily: DataAPI.daily().target,
    forecast: !!DataAPI.forecastConfig(),
    stats: Object.keys(Store.state.skillStats).length,
  };
`, sandbox);
const future = sandbox.futureResult;
check("будущий русский контент открывает только реальные узлы", future.available && future.task === 1 && future.lesson === 1 && future.mission === 1 && future.achievement === 1 && future.diagnostic === 1 && future.daily === 1 && future.forecast && future.stats === 1);

/* Account/session boundary: a subject response without auth may preserve the
   session only for the same account; a changed account fails closed. */
vm.runInContext(`
  Store.accountId = "account-a";
  Store.auth = { registered: true, email: "a@example.test" };
  Store._applyBootstrap({ catalog: catalog, accountId: "account-b", state: { subject: "russian" } });
  globalThis.authBoundary = { accountId: Store.accountId, registered: Store.auth.registered };
`, sandbox);
check("смена accountId без auth не сохраняет старую сессию", sandbox.authBoundary.accountId === "account-b" && sandbox.authBoundary.registered === false);

/* Каждый раздел locked-предмета обязан показывать СВОЮ структуру.
   Регрессия: один guard отправлял training/errors/trials/stats в общую
   карточку, из-за чего «Ошибки» и «Тренировка» были неотличимы.
   Здесь проверяем и прямой вызов экрана (в обход render()), и route. */
{
  const appSrc = fs.readFileSync("js/app.js", "utf8");
  // app.js — большой браузерный модуль; для этой проверки достаточно
  // вытащить объявления copy-таблицы и чистые функции-helper'ы.
  const sectionCopy = /const SUBJECT_SECTION_COPY = (\{[\s\S]*?\n\});/.exec(appSrc);
  check("в app.js есть таблица section-specific copy", !!sectionCopy);
  if (sectionCopy) {
    const copy = vm.runInContext("(" + sectionCopy[1] + ")", sandbox);
    const required = ["training", "errors", "trials", "stats", "path", "skill",
      "session", "practice", "boss", "daily", "review", "lesson"];
    const missing = required.filter((r) => !copy[r] || !copy[r].title || !copy[r].sub || !copy[r].empty);
    check("section-specific copy покрывает все разделы", missing.length === 0);
    const sigs = required.map((r) => [copy[r].title, copy[r].empty].join("|"));
    check("у каждого раздела свой заголовок и текст пустого состояния",
      new Set(sigs).size === sigs.length);
    check("training и errors различаются",
      copy.training.empty !== copy.errors.empty && copy.training.title !== copy.errors.title);
  }
  // Прямой вызов screenTraining обязан передать route (иначе fallback на
  // общую карточку). Проверяем наличие вызова с третьим аргументом.
  check("screenTraining передаёт route в screenSubjectUnavailable",
    /if \(state\.empty \|\| state\.locked\) return screenSubjectUnavailable\(root, state\.locked, "training"\);/.test(appSrc));
  // Defensive guards у остальных экранов: прямой вызов не должен рисуть
  // ready-подобный экран с нулями. Ищем guard в начале тела функции,
  // игнорируя любое количество комментариев над ним.
  const guardIn = (fn) => {
    const start = appSrc.indexOf("function " + fn + "(root) {");
    if (start < 0) return false;
    const body = appSrc.slice(start, start + 900);
    return new RegExp("if \\(subjectLearningUnavailable\\(\\)\\) return screenSubjectUnavailable\\(root, true, \"" + fn.replace("screen", "").toLowerCase() + "\"\\);").test(body);
  };
  check("screenErrors/screenTrials/screenStats имеют locked-guard",
    guardIn("screenErrors") && guardIn("screenTrials") && guardIn("screenStats"));
  // Деление на ноль в daily-карте недопустимо даже при обходе guard.
  check("daily-карта не делит на dailyGoal без проверки",
    appSrc.includes("${dailyGoal ? dailyTitle") && !appSrc.includes("${dailyTitle}\n        <div style=\"margin:14px 0 6px\">"));
  // Футер не должен скрываться на locked-разделах.
  check("locked-разделы не скрывают футер",
    !/SUBJECT_CONTENT_ROUTES\.has\(route\)\) \{\s*screen\.innerHTML = "";\s*screenSubjectUnavailable\(screen, true, route\);\s*try \{ if \(window\.Footer\) Footer\.hide\(\); \}/.test(appSrc));
}

console.log(fails ? `${fails} FAILURES` : "ALL OK");
process.exit(fails ? 1 : 0);
