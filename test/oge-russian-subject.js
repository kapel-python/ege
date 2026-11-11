/* Client-side regression: an opened oge_russian subject exposes its real topics:
   13 lines (№1–11 short-answer + №13 essay), exam axis "oge", locked №12
   (сжатое изложение по аудио — на сайте слушать нечего), 12 уроков (по одному
   на открытую линию), сочинения есть (long_text). */
const fs = require("fs");
const vm = require("vm");
const catalog = JSON.parse(fs.readFileSync("server/catalog_oge_russian.json", "utf8"));
catalog.subject = "oge_russian";
// Сервер подмешивает forecast в каталог при сборке payload
// (server.py: _build_catalog_payload) — повторяем это в фикстуре.
const _weights = {
  or01_main: 1, or02_means: 1, or03_express: 1, or04_spell: 1,
  or05_punct: 1, or06_grammar: 1, or07_replace: 1, or08_syntax: 1,
  or09_nn: 1, or10_suff: 1, or11_vocab: 1, or13_essay: 9,
};
catalog.forecast = { weights: _weights, total: 20, scale: Array.from({ length: 21 }, (_, i) => i) };
catalog.subjects = [
  { id: "profile_math", title: "Профильная математика", exam: "ege", status: "ready", features: { lessons: true, practice: true, forecast: true } },
  { id: "russian", title: "Русский язык", exam: "ege", status: "ready", features: { lessons: true, practice: true, forecast: true } },
  { id: "oge_russian", title: "Русский язык (ОГЭ)", exam: "oge", status: "ready", locked: false, features: { lessons: true, practice: true, forecast: true, diagnostics: true, missions: true, bosses: true, daily: true, path: true } },
];
const sandbox = { console, catalog, setTimeout, clearTimeout };
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync("js/data.js", "utf8") + "\n" + fs.readFileSync("js/state.js", "utf8") +
  `\n;DataAPI.load(catalog); Store.ready = true; Store.state = Store.defaultState();`,
  sandbox,
  { filename: "oge-russian-client.js" }
);
let fails = 0;
const check = (name, condition) => { console.log(`${condition ? "ok  " : "FAIL"} ${name}`); if (!condition) fails++; };
vm.runInContext(`
  globalThis.ogeChecks = {
    exam: DataAPI.subjectExam("oge_russian"),
    examEge: DataAPI.subjectExam("russian"),
    locked: DataAPI.isSubjectLocked(),
    available: DataAPI.isSubjectAvailable(),
    skills: DataAPI.skills().length,
    lockedSkills: DataAPI.skills().filter((s) => s.locked).map((s) => s.id).sort(),
    hintsOk: DataAPI.skills().every((s) => s.metadata && Array.isArray(s.metadata.hints) && s.metadata.hints.length === 3 && s.metadata.hints.every((h) => !!String(h || "").trim())),
    tasks: DataAPI.tasks().length,
    practice: DataAPI.practiceTasks().length,
    essays: DataAPI.tasks().filter((t) => t.type === "long_text").length,
    lessons: DataAPI.lessons().length,
    lessonSkills: DataAPI.lessons().map((l) => l.skill).sort(),
    essayLesson: DataAPI.lessons().filter((l) => l.skill === "or13_essay").length,
    missions: DataAPI.missions().length,
    bosses: DataAPI.bosses().length,
    diagnostics: DataAPI.diagnosticTasks().length,
    goals: DataAPI.goals().map((g) => g.id).sort(),
    dailyTarget: DataAPI.daily().target,
    forecastTotal: (DataAPI.forecastConfig() || {}).total,
    forecastScaleLen: ((DataAPI.forecastConfig() || {}).scale || []).length,
    forecastWeightsSum: Object.values((DataAPI.forecastConfig() || {}).weights || {}).reduce((a, b) => a + Number(b || 0), 0),
    next: nextStepCandidates().length,
  };
`, sandbox);
const result = sandbox.ogeChecks;
check("ось экзамена: oge_russian=oge, russian=ege", result.exam === "oge" && result.examEge === "ege");
check("предмет открыт и доступен", result.locked === false && result.available === true);
check("13 тем, locked только or12_summary (изложение по аудио)",
  result.skills === 13 && JSON.stringify(result.lockedSkills) === JSON.stringify(["or12_summary"]));
check("у каждой темы 3 подсказки", result.hintsOk === true);
check("задания на месте (165 коротких + 12 сочинений)", result.tasks === 177 && result.essays === 12);
check("практика видит все задания (вкл. сочинения)", result.practice === 177);
check("12 уроков: 11 линий + сочинение",
  result.lessons === 12 && result.essayLesson === 1);
check("миссии покрывают все 12 открытых тем", result.missions === 12);
check("3 босса по веткам", result.bosses === 3);
check("диагностика непуста", result.diagnostics >= 5);
check("цели-оценки g3/g4/g5", JSON.stringify(result.goals) === JSON.stringify(["g3", "g4", "g5"]));
check("ежедневная подборка валидна", result.dailyTarget > 0);
check("прогноз: total 20, шкала 21, сумма весов 20", result.forecastTotal === 20 && result.forecastScaleLen === 21 && result.forecastWeightsSum === 20);
check("движок шагов видит каталог", result.next > 0);
if (fails) { console.error(`FAILURES: ${fails}`); process.exit(1); }
console.log("oge-russian client OK");
