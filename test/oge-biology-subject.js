/* Client-side regression: an opened oge_biology subject exposes its real topics:
   26 lines (part 1 short-answer + part 2 self-check), exam axis "oge",
   all open (9 figure-lines restored via assets/oge_biology),
   26 lessons (one per line), no essays. */
const fs = require("fs");
const vm = require("vm");
const catalog = JSON.parse(fs.readFileSync("server/catalog_oge_biology.json", "utf8"));
catalog.subject = "oge_biology";
// Сервер подмешивает forecast в каталог при сборке payload
// (server.py: _build_catalog_payload) — повторяем это в фикстуре.
const POINTS = {1:1,2:1,3:1,4:2,5:2,6:1,7:2,8:1,9:2,10:2,11:2,12:1,13:3,14:1,15:1,16:2,17:2,18:2,19:2,20:1,21:2,22:2,23:2,24:3,25:3,26:3};
const _weights = {};
catalog.skills.forEach((s) => {
  const m = /^ob(\d+)_/.exec(s.id);
  _weights[s.id] = m ? POINTS[Number(m[1])] : 1;
});
catalog.forecast = { weights: _weights, total: 47, scale: Array.from({ length: 48 }, (_, i) => i) };
catalog.subjects = [
  { id: "profile_math", title: "Профильная математика", exam: "ege", status: "ready", features: { lessons: true, practice: true, forecast: true } },
  { id: "oge_math", title: "Математика (ОГЭ)", exam: "oge", status: "ready", locked: false, features: { lessons: false, practice: true, forecast: true, diagnostics: true, missions: true, bosses: true, daily: true, path: true } },
  { id: "oge_biology", title: "Биология (ОГЭ)", exam: "oge", status: "ready", locked: false, features: { lessons: true, practice: true, forecast: true, diagnostics: true, missions: true, bosses: true, daily: true, path: true } },
];
const sandbox = { console, catalog, setTimeout, clearTimeout };
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync("js/data.js", "utf8") + "\n" + fs.readFileSync("js/state.js", "utf8") +
  `\n;DataAPI.load(catalog); Store.ready = true; Store.state = Store.defaultState();`,
  sandbox,
  { filename: "oge-biology-client.js" }
);
let fails = 0;
const check = (name, condition) => { console.log(`${condition ? "ok  " : "FAIL"} ${name}`); if (!condition) fails++; };
vm.runInContext(`
  globalThis.ogeChecks = {
    exam: DataAPI.subjectExam("oge_biology"),
    examMath: DataAPI.subjectExam("oge_math"),
    locked: DataAPI.isSubjectLocked(),
    available: DataAPI.isSubjectAvailable(),
    skills: DataAPI.skills().length,
    lockedSkills: DataAPI.skills().filter((s) => s.locked).map((s) => s.id).sort(),
    hintsOk: DataAPI.skills().every((s) => s.metadata && Array.isArray(s.metadata.hints) && s.metadata.hints.length === 3 && s.metadata.hints.every((h) => !!String(h || "").trim())),
    tasks: DataAPI.tasks().length,
    practice: DataAPI.practiceTasks().length,
    lessons: DataAPI.lessons().length,
    lessonSkills: DataAPI.lessons().map((l) => l.skill).sort(),
    skillIds: DataAPI.skills().map((s) => s.id).sort(),
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
check("ось экзамена: oge_biology=oge, oge_math=oge", result.exam === "oge" && result.examMath === "oge");
check("предмет открыт и доступен", result.locked === false && result.available === true);
check("26 тем, все открыты (фигуры восстановлены)", result.skills === 26 && JSON.stringify(result.lockedSkills) === JSON.stringify([]));
check("у каждой темы 3 подсказки", result.hintsOk === true);
check("задания на месте (26 тем покрыты)", result.tasks >= 1100 && result.practice >= 900);
check("26 уроков, по одному на линию", result.lessons === 26 && JSON.stringify(result.lessonSkills) === JSON.stringify(result.skillIds));
check("миссии покрывают все темы", result.missions === 26);
check("4 босса по веткам", result.bosses === 4);
check("диагностика непуста", result.diagnostics >= 6);
check("цели-оценки g3/g4/g5", JSON.stringify(result.goals) === JSON.stringify(["g3", "g4", "g5"]));
check("ежедневная подборка валидна", result.dailyTarget > 0 && !!result.dailySkill && result.dailyPicked.length > 0);
check("прогноз: total 47, шкала 48, сумма весов 47", result.forecastTotal === 47 && result.forecastScaleLen === 48 && result.forecastWeightsSum === 47);
check("движок шагов видит каталог", result.next > 0);
if (fails) { console.error(`FAILURES: ${fails}`); process.exit(1); }
console.log("oge-biology client OK");
