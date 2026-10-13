/* Client-side regression: an opened oge_society subject exposes its real topics:
   20 lines (part 1 short-answer + extended self-check, №7 photo tasks carry
   downloaded figures), exam axis "oge", no locked skills, 20 lessons, no essays. */
const fs = require("fs");
const vm = require("vm");
const catalog = JSON.parse(fs.readFileSync("server/catalog_oge_society.json", "utf8"));
catalog.subject = "oge_society";
// Сервер подмешивает forecast в каталог при сборке payload
// (server.py: _build_catalog_payload) — повторяем это в фикстуре из контракта.
const contract = JSON.parse(fs.readFileSync("server/subjects/oge_society.json", "utf8"));
catalog.forecast = contract.forecast;
catalog.subjects = [
  { id: "profile_math", title: "Профильная математика", exam: "ege", status: "ready", features: { lessons: true, practice: true, forecast: true } },
  { id: "basic_math", title: "Базовая математика", exam: "ege", status: "ready", features: { lessons: true, practice: true, forecast: true } },
  { id: "oge_society", title: "Обществознание (ОГЭ)", exam: "oge", status: "ready", locked: false, features: { lessons: true, practice: true, forecast: true, diagnostics: true, missions: true, bosses: true, daily: true, path: true } },
];
const sandbox = { console, catalog, setTimeout, clearTimeout };
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync("js/data.js", "utf8") + "\n" + fs.readFileSync("js/state.js", "utf8") +
  `\n;DataAPI.load(catalog); Store.ready = true; Store.state = Store.defaultState();`,
  sandbox,
  { filename: "oge-society-client.js" }
);
let fails = 0;
const check = (name, condition) => { console.log(`${condition ? "ok  " : "FAIL"} ${name}`); if (!condition) fails++; };
vm.runInContext(`
  globalThis.ogeChecks = {
    exam: DataAPI.subjectExam("oge_society"),
    examProfile: DataAPI.subjectExam("profile_math"),
    locked: DataAPI.isSubjectLocked(),
    available: DataAPI.isSubjectAvailable(),
    skills: DataAPI.skills().length,
    lockedSkills: DataAPI.skills().filter((s) => s.locked).map((s) => s.id).sort(),
    hintsOk: DataAPI.skills().every((s) => s.metadata && Array.isArray(s.metadata.hints) && s.metadata.hints.length === 3 && s.metadata.hints.every((h) => !!String(h || "").trim())),
    tasks: DataAPI.tasks().length,
    practice: DataAPI.practiceTasks().length,
    lessons: DataAPI.lessons().length,
    lessonsSkills: DataAPI.lessons().map((l) => l.skill).sort(),
    missions: DataAPI.missions().length,
    bosses: DataAPI.bosses().length,
    diagnostics: DataAPI.diagnosticTasks().length,
    goals: DataAPI.goals().map((g) => g.id).sort(),
    dailyTarget: DataAPI.daily().target,
    dailySkill: DataAPI.daily().skill,
    dailyPicked: dailyTaskIds(),
    forecastTotal: (DataAPI.forecastConfig() || {}).total,
    forecastScaleLen: ((DataAPI.forecastConfig() || {}).scale || []).length,
    forecastWeightsSum: Object.values((DataAPI.forecastConfig() || {}).weights || {}).reduce((a, b) => a + Number(b || 0), 0),
    next: nextStepCandidates().length,
  };
`, sandbox);
const result = sandbox.ogeChecks;
check("ось экзамена: oge_society=oge, profile_math=ege", result.exam === "oge" && result.examProfile === "ege");
check("предмет открыт и доступен", result.locked === false && result.available === true);
check("20 тем, locked нет (№7 открыта рисунками)", result.skills === 20 && result.lockedSkills.length === 0);
check("у каждой темы 3 подсказки", result.hintsOk === true);
check("задания на месте (20 открытых тем покрыты)", result.tasks >= 1100 && result.practice >= 1100);
check("20 уроков, по одному на линию", result.lessons === 20 && JSON.stringify(result.lessonsSkills) === JSON.stringify(["os01_concepts", "os02_table", "os03_compare", "os04_culture", "os05_man", "os06_social", "os07_photo", "os08_finance", "os09_agents", "os10_econ", "os11_politics", "os12_stats", "os13_law", "os14_match", "os15_socrel", "os16_lawjudge", "os17_significance", "os18_plan", "os19_analysis", "os20_examples"]));
check("миссии покрывают все темы", result.missions === 20);
check("4 босса по веткам", result.bosses === 4);
check("диагностика: 8 заданий", result.diagnostics === 8);
check("цели-оценки g3/g4/g5", JSON.stringify(result.goals) === JSON.stringify(["g3", "g4", "g5"]));
check("ежедневная подборка валидна", result.dailyTarget > 0 && !!result.dailySkill && result.dailyPicked.length > 0);
check("прогноз: total 37, шкала 38, сумма весов 37", result.forecastTotal === 37 && result.forecastScaleLen === 38 && result.forecastWeightsSum === 37);
check("движок шагов видит каталог", result.next > 0);
if (fails) { console.error(`FAILURES: ${fails}`); process.exit(1); }
console.log("oge-society client OK");
