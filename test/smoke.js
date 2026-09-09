/* Core smoke test. Catalog content is read from the same SQLite bootstrap
   export used by the backend; no browser storage or synthetic account state. */
const fs = require("fs");
const src = fs.readFileSync("js/data.js", "utf8") + "\n" + fs.readFileSync("js/state.js", "utf8");
const testBody = async () => {
  let fails = 0;
  const t = (name, cond) => { console.log((cond ? "ok  " : "FAIL") + " " + name); if (!cond) fails++; };
  DataAPI.load(JSON.parse(fs.readFileSync("server/catalog.json", "utf8")));
  Store.ready = false;
  Store.state = Store.defaultState();

  t("все навыки существуют в темах", DataAPI.skills().every((s) => DataAPI.categories().some((c) => c.id === s.cat)));
  t("все задания ссылаются на навыки", DataAPI.tasks().every((x) => DataAPI.skills().some((s) => s.id === x.skill)));
  t("все задания миссий существуют", DataAPI.missions().every((m) => m.tasks.every((id) => !!DataAPI.task(id))));
  t("диагностические задания существуют", DataAPI.diagnosticTasks().every((id) => !!DataAPI.task(id)));
  t("у каждого задания есть содержание", DataAPI.tasks().every((x) => (x.hint || (x.hints && x.hints.length)) && x.solution && x.text && x.answer));
  t("каталог содержит ровно 49 задач, подтверждённых ege_complete.txt", DataAPI.tasks().length === 49);
  t("каждый из 20 номеров ЕГЭ представлен", DataAPI.skills().every((s) => DataAPI.tasksBySkill(s.id).length > 0));
  // №6 и №13 официально имеют только один подтверждённый образец в демоверсии
  // 2027 (см. ege_complete.txt) — это не пробел, а честная граница источника.
  const singleExampleSkills = new Set(["n06_random_var", "n13_financial"]);
  t("у каждого навыка (кроме №6 и №13) есть >= 2 задания", DataAPI.skills()
    .filter((s) => !singleExampleSkills.has(s.id))
    .every((s) => DataAPI.tasksBySkill(s.id).length >= 2));
  t("развёрнутые задания №14-20 помечены для самопроверки", DataAPI.tasks()
    .filter((x) => x.type === "extended_answer")
    .every((x) => x.selfCheck === true));
  t("каждая задача несёт свой первоисточник", DataAPI.tasks().every((x) => x.sourceId && x.status === "official-demo-2027"));
  t("уроки и шаги загружены из каталога", DataAPI.lessons().length > 0 && DataAPI.lessons().every((l) => l.steps && l.steps.length));
  const visualAssets = DataAPI.visualAssets();
  t("реестр visual assets загружен", visualAssets.length >= 4 && visualAssets.every((asset) => asset.src && asset.type && asset.alt && asset.source && asset.sourceId));
  t("реестр visual assets поддерживает SVG/PNG/JPG", ["svg", "image", "image"].every((type, index) => visualAssets[index].type === type)
    && visualAssets.some((asset) => asset.src.endsWith(".svg"))
    && visualAssets.some((asset) => asset.src.endsWith(".png"))
    && visualAssets.some((asset) => asset.src.endsWith(".jpg")));
  t("аудит визуальных условий сохранён", DataAPI.visualAudit().defaultStatus === "text-only"
    && DataAPI.visualAudit().taskStatuses.n02_p2 === "visual-optional"
    && DataAPI.visualAudit().references.some((item) => item.examNumber === "№9" && item.status === "visual-required"));
  t("заблокированные визуалы (нет официального PDF) честно помечены required без asset", DataAPI.tasks()
    .filter((x) => x.visual && x.visual.required)
    .every((x) => !x.visual.assetId && x.visual.note));
  const auditedTaskIds = Object.keys(DataAPI.visualAudit().taskStatuses || {});
  t("статусы визуального аудита покрывают только существующие задания", auditedTaskIds.length === DataAPI.tasks().length
    && auditedTaskIds.every((id) => !!DataAPI.task(id)));
  t("ссылки заданий на visual assets разрешаются (или честно помечены как недоступные)", DataAPI.tasks()
    .every((task) => !task.visual || (task.visual.assetId ? !!DataAPI.visualAsset(task.visual.assetId) : !!task.visual.required)));
  t("№2 подключает MathVisual-схему векторов", DataAPI.task("n02_p2").mathVisual
    && DataAPI.task("n02_p2").mathVisual.type === "vector_diagram"
    && !DataAPI.task("n02_p2").visual);
  const MATHVISUAL_TYPES = ["coordinate_geometry", "vector_diagram", "function_graph", "derivative_graph",
    "triangle", "quadrilateral", "polygon", "circle_geometry", "3d_solid", "probability_diagram", "probability_tree"];
  t("MathVisual-задачи ссылаются на поддерживаемые типы движка и не дублируют static visual", DataAPI.tasks()
    .filter((x) => x.mathVisual)
    .every((x) => MATHVISUAL_TYPES.includes(x.mathVisual.type) && !x.visual
      && (Array.isArray(x.mathVisual.objects) || Array.isArray(x.mathVisual.nodes) || x.mathVisual.type === "3d_solid")));

  t("checkAnswer exact", checkAnswer(DataAPI.task("n01_p1"), "3"));
  t("checkAnswer comma/dot", checkAnswer(DataAPI.task("n04_p1"), "0,3"));
  t("checkAnswer fraction (generic, not tied to a specific catalog task)", checkAnswer({ answer: "3/4" }, "6/8"));
  // №14-20 переведены на самопроверку (см. ниже) и больше не проверяются
  // через checkAnswer в интерфейсе; логика множественных корней остаётся
  // общей функцией и проверяется здесь синтетическим примером.
  const multiRootExample = { type: "extended_answer", answer: "37π/4, 39π/4" };
  t("checkAnswer accepts all multiple roots", checkAnswer(multiRootExample, "37π/4, 39π/4"));
  t("checkAnswer rejects incomplete multiple roots", !checkAnswer(multiRootExample, "37π/4"));
  t("checkAnswer rejects trailing garbage", !checkAnswer(DataAPI.task("n01_p1"), "3abc"));
  t("checkAnswer wrong", !checkAnswer(DataAPI.task("n01_p1"), "6"));

  Store.reset();
  t("стартовый level 1", levelInfo().level === 1);
  const task = DataAPI.task("n11_p1");
  recordAnswer(task, false, 0, 30);
  t("ошибка записалась", Store.state.errors.length === 1 && !Store.state.errors[0].resolved);
  const before = Store.state.xp;
  recordAnswer(task, true, 0, 25);
  t("ошибка закрыта и XP начислен", Store.state.errors[0].resolved && Store.state.errorsResolved === 1 && Store.state.xp > before);
  t("попытки сохранены в runtime-снимке", Store.state.taskAttempts.length === 2);

  Store.reset();
  const lesson = DataAPI.lesson("lesson_n07_exponential");
  const lessonXp = Store.state.xp;
  const first = completeLesson(lesson, 20, { wrongAttempts: 2, durationSec: 30 });
  const second = completeLesson(lesson, 20, { wrongAttempts: 1, durationSec: 10 });
  t("первое завершение урока даёт награду", first.firstCompletion && first.totalXp === lesson.xp + 20 && Store.state.xp === lessonXp + lesson.xp + 20);
  t("повтор урока не фармит XP", !second.firstCompletion && second.totalXp === 0 && Store.state.xp === lessonXp + lesson.xp + 20);
  t("история урока сохранена", Store.state.lessonAttempts.length === 2);

  Store.reset();
  applyOnboarding("base", "g80", DataAPI.diagnosticTasks().map((id) => ({ taskId: id, correct: true })));
  t("диагностика сохраняет только реальные ответы", Store.state.onboarded && Store.state.xp === 0 && Store.state.diagnostics.length === 5 && Store.state.totalSolved === 5);
  t("онбординг не создаёт случайный прогресс", Store.state.skillStats.n11_word_problems.progress === 0);

  Store.reset();
  addXp(5000, "test");
  t("уровень считается из XP", levelInfo().level > 3);
  Store.reset();
  ensureDailyChallenge();
  const dailyIds = dailyTaskIds();
  t("daily выбирает задания из существующего банка", dailyIds.length === DataAPI.daily().target && dailyIds.every((id) => !!DataAPI.task(id)));
  const outsideDaily = DataAPI.tasks().find((task) => !dailyIds.includes(task.id));
  if (outsideDaily) recordAnswer(outsideDaily, true, 0, 20);
  t("обычная практика не засчитывается в daily", Store.state.daily.solved === 0 && !Store.state.daily.done);
  for (const id of dailyIds) recordAnswer(DataAPI.task(id), true, 0, 20);
  t("daily награда зависит от фактических ответов", Store.state.daily.done && Store.state.xp >= DataAPI.daily().xp);
  t("daily не считает повтор одного задания дважды", Store.state.daily.solved === dailyIds.length);
  const dailySnapshot = JSON.parse(JSON.stringify(Store.state));
  dailySnapshot.daily.countedTaskIds = undefined;
  Store.state = dailySnapshot;
  ensureDailyChallenge();
  t("daily восстанавливает зачтённые задания после перезагрузки", Store.state.daily.solved === dailyIds.length);

  console.log(fails ? `\n${fails} FAILURES` : "\nALL OK");
  process.exit(fails ? 1 : 0);
};
eval(src + `\n;(${testBody.toString()})();`);
