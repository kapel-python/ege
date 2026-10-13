/* Client-side regression: an opened oge_history subject exposes its real topics:
   23 lines (part 1 short-answer + part 2 self-check), exam axis "oge",
   locked №8-14 (maps/schemes/images essential), 23 lessons (one per line), no essays. */
const fs = require("fs");
const vm = require("vm");
const catalog = JSON.parse(fs.readFileSync("server/catalog_oge_history.json", "utf8"));
catalog.subject = "oge_history";
// Сервер подмешивает forecast в каталог при сборке payload
// (server.py: _build_catalog_payload) — повторяем это в фикстуре.
// Веса — баллы ФИПИ по покрытым линиям (сумма 35).
const _weights = {
  oh01_dates: 2, oh02_sequence: 1, oh03_terms: 1, oh04_facts: 2,
  oh05_extraterm: 1, oh06_thesis: 1, oh07_stats: 2,
  oh08_map: 1, oh09_map2: 1, oh10_map3: 1, oh11_images: 1,
  oh12_scheme: 1, oh13_culture: 2, oh14_culture2: 1,
  oh15_world: 1, oh16_world2: 1, oh17_world3: 1,
  oh18_source: 2, oh19_source2: 2, oh20_source3: 2,
  oh21_errors: 3, oh22_compare: 2, oh23_situation: 3,
};
catalog.forecast = { weights: _weights, total: 35, scale: Array.from({ length: 36 }, (_, i) => i) };
catalog.subjects = [
  { id: "profile_math", title: "Профильная математика", exam: "ege", status: "ready", features: { lessons: true, practice: true, forecast: true } },
  { id: "basic_math", title: "Базовая математика", exam: "ege", status: "ready", features: { lessons: true, practice: true, forecast: true } },
  { id: "oge_math", title: "Математика (ОГЭ)", exam: "oge", status: "ready", locked: false, features: { lessons: false, practice: true, forecast: true, diagnostics: true, missions: true, bosses: true, daily: true, path: true } },
  { id: "oge_history", title: "История (ОГЭ)", exam: "oge", status: "ready", locked: false, features: { lessons: true, practice: true, forecast: true, diagnostics: true, missions: true, bosses: true, daily: true, path: true } },
];
const sandbox = { console, catalog, setTimeout, clearTimeout };
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync("js/data.js", "utf8") + "\n" + fs.readFileSync("js/state.js", "utf8") +
  `\n;DataAPI.load(catalog); Store.ready = true; Store.state = Store.defaultState();`,
  sandbox,
  { filename: "oge-history-client.js" }
);
let fails = 0;
const check = (name, condition) => { console.log(`${condition ? "ok  " : "FAIL"} ${name}`); if (!condition) fails++; };
vm.runInContext(`
  globalThis.ogeChecks = {
    exam: DataAPI.subjectExam("oge_history"),
    examProfile: DataAPI.subjectExam("profile_math"),
    locked: DataAPI.isSubjectLocked(),
    available: DataAPI.isSubjectAvailable(),
    skills: DataAPI.skills().length,
    lockedSkills: DataAPI.skills().filter((s) => s.locked).map((s) => s.id).sort(),
    hintsOk: DataAPI.skills().every((s) => s.metadata && Array.isArray(s.metadata.hints) && s.metadata.hints.length === 3 && s.metadata.hints.every((h) => !!String(h || "").trim())),
    tasks: DataAPI.tasks().length,
    practice: DataAPI.practiceTasks().length,
    lessons: DataAPI.lessons().length,
    lessonSkills: DataAPI.lessons().map((l) => l.skill).sort(),
    lessonFinalesOk: DataAPI.lessons().every((l) => {
      const ind = (l.steps || []).filter((s) => s.type === "INDEPENDENT_TASK");
      const tids = DataAPI.tasks().map((t) => t.id);
      return ind.length > 0 && ind.every((s) => tids.includes(s.taskId) &&
        (DataAPI.tasks().find((t) => t.id === s.taskId) || {}).skill === l.skill);
    }),
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
check("ось экзамена: oge_history=oge, profile_math=ege", result.exam === "oge" && result.examProfile === "ege");
check("предмет открыт и доступен", result.locked === false && result.available === true);
check("23 темы, locked пуст (фигуры открыли №8–14)", result.skills === 23 && result.lockedSkills.length === 0);
check("у каждой темы 3 подсказки", result.hintsOk === true);
check("задания на месте (все 23 темы, пулы взяты полностью)", result.tasks >= 900 && result.practice >= 900);
check("23 урока, по одному на линию, финалы — живые задания своих линий",
  result.lessons === 23 &&
  JSON.stringify(result.lessonSkills) === JSON.stringify(["oh01_dates", "oh02_sequence", "oh03_terms", "oh04_facts", "oh05_extraterm", "oh06_thesis", "oh07_stats", "oh08_map", "oh09_map2", "oh10_map3", "oh11_images", "oh12_scheme", "oh13_culture", "oh14_culture2", "oh15_world", "oh16_world2", "oh17_world3", "oh18_source", "oh19_source2", "oh20_source3", "oh21_errors", "oh22_compare", "oh23_situation"]) &&
  result.lessonFinalesOk === true);
check("миссии покрывают все 23 темы", result.missions === 23);
check("3 босса по веткам", result.bosses === 3);
check("диагностика непуста", result.diagnostics >= 6);
check("цели-оценки g3/g4/g5", JSON.stringify(result.goals) === JSON.stringify(["g3", "g4", "g5"]));
check("ежедневная подборка валидна", result.dailyTarget > 0 && !!result.dailySkill && result.dailyPicked.length > 0);
check("прогноз: total 35, шкала 36, сумма весов 35", result.forecastTotal === 35 && result.forecastScaleLen === 36 && result.forecastWeightsSum === 35);
check("движок шагов видит каталог", result.next > 0);
if (fails) { console.error(`FAILURES: ${fails}`); process.exit(1); }
console.log("oge-history client OK");
