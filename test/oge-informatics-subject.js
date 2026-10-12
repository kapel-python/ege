/* Client-side regression: an opened oge_informatics subject exposes its real topics:
   16 lines (short-answer, №9 with figures), exam axis "oge",
   locked №11-16 (files/computer essential), no lessons, no essays. */
const fs = require("fs");
const vm = require("vm");
const catalog = JSON.parse(fs.readFileSync("server/catalog_oge_informatics.json", "utf8"));
catalog.subject = "oge_informatics";
// Сервер подмешивает forecast в каталог при сборке payload
// (server.py: _build_catalog_payload) — повторяем это в фикстуре.
const _weights = {};
catalog.skills.forEach((s) => {
  const m = /^oi(\d+)_/.exec(s.id);
  const n = m ? Number(m[1]) : 0;
  _weights[s.id] = n === 14 ? 3 : (n === 13 || n === 15 || n === 16 ? 2 : 1);
});
catalog.forecast = { weights: _weights, total: 21, scale: Array.from({ length: 22 }, (_, i) => i) };
catalog.subjects = [
  { id: "profile_math", title: "Профильная математика", exam: "ege", status: "ready", features: { lessons: true, practice: true, forecast: true } },
  { id: "basic_math", title: "Базовая математика", exam: "ege", status: "ready", features: { lessons: true, practice: true, forecast: true } },
  { id: "oge_informatics", title: "Информатика (ОГЭ)", exam: "oge", status: "ready", locked: false, features: { lessons: false, practice: true, forecast: true, diagnostics: true, missions: true, bosses: true, daily: true, path: true } },
];
const sandbox = { console, catalog, setTimeout, clearTimeout };
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync("js/data.js", "utf8") + "\n" + fs.readFileSync("js/state.js", "utf8") +
  `\n;DataAPI.load(catalog); Store.ready = true; Store.state = Store.defaultState();`,
  sandbox,
  { filename: "oge-informatics-client.js" }
);
let fails = 0;
const check = (name, condition) => { console.log(`${condition ? "ok  " : "FAIL"} ${name}`); if (!condition) fails++; };
vm.runInContext(`
  globalThis.ogeChecks = {
    exam: DataAPI.subjectExam("oge_informatics"),
    examProfile: DataAPI.subjectExam("profile_math"),
    locked: DataAPI.isSubjectLocked(),
    available: DataAPI.isSubjectAvailable(),
    skills: DataAPI.skills().length,
    lockedSkills: DataAPI.skills().filter((s) => s.locked).map((s) => s.id).sort(),
    hintsOk: DataAPI.skills().every((s) => s.metadata && Array.isArray(s.metadata.hints) && s.metadata.hints.length === 3 && s.metadata.hints.every((h) => !!String(h || "").trim())),
    tasks: DataAPI.tasks().length,
    practice: DataAPI.practiceTasks().length,
    lessons: DataAPI.lessons().length,
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
const LOCKED = ["oi11_filesearch", "oi12_filecount", "oi13_office", "oi14_spreadsheet", "oi15_robot", "oi16_coding"];
check("ось экзамена: oge_informatics=oge, profile_math=ege", result.exam === "oge" && result.examProfile === "ege");
check("предмет открыт и доступен", result.locked === false && result.available === true);
check("16 тем, locked ровно 6 компьютерных", result.skills === 16 && JSON.stringify(result.lockedSkills) === JSON.stringify(LOCKED));
check("у каждой темы 3 подсказки", result.hintsOk === true);
check("задания на месте (10 открытых тем, капы волн)", result.tasks === 520 && result.practice === 520);
check("уроков нет (пилот без lessons)", result.lessons === 0);
check("миссии покрывают открытые темы", result.missions === 10);
check("3 босса по веткам", result.bosses === 3);
check("диагностика непуста", result.diagnostics >= 6);
check("цели-оценки g3/g4/g5", JSON.stringify(result.goals) === JSON.stringify(["g3", "g4", "g5"]));
check("ежедневная подборка валидна", result.dailyTarget > 0 && !!result.dailySkill && result.dailyPicked.length > 0);
check("прогноз: total 21, шкала 22, сумма весов 21", result.forecastTotal === 21 && result.forecastScaleLen === 22 && result.forecastWeightsSum === 21);
check("движок шагов видит каталог", result.next > 0);
if (fails) { console.error(`FAILURES: ${fails}`); process.exit(1); }
console.log("oge-informatics client OK");
