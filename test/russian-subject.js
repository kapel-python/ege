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
console.log(fails ? `${fails} FAILURES` : "ALL OK");
process.exit(fails ? 1 : 0);
