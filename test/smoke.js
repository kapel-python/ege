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
  const parameterGraph = DataAPI.task("n19_p1").mathVisual;
  const parameterDomains = parameterGraph.objects.filter((o) => o.type === "function").map((o) => o.domain);
  t("№19 показывает все видимые ветви графика системы, без обрыва внутри окна", JSON.stringify(parameterDomains) === JSON.stringify([
    [-3.5, 0], [4, 7.5], [-3.5, 0], [4, 7.5],
  ]));
  const tangentCircle = DataAPI.task("n18_p2").mathVisual;
  t("№18.2 не обрезает окружность рамкой рисунка", tangentCircle.boundingBox[3] <= -13);

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

  // Некоторые задания честно помечены "рисунок обязателен, но недоступен"
  // (visual.required без assetId) — их нельзя решить без официального
  // источника. Они обязаны остаться в каталоге (для аудита и на случай
  // появления картинки), но не должны попадать ученику ни в один поток
  // выбора задания: свободную практику, daily, боссов, повторение ошибок,
  // миссии.
  const unsolvable = DataAPI.tasks().filter((x) => DataAPI.taskHasMissingVisual(x));
  t("в каталоге действительно есть задания с недоступным обязательным рисунком (иначе проверка ниже бессмысленна)", unsolvable.length > 0);
  t("practiceTasks() исключает задания без обязательного рисунка", unsolvable.every((x) => !DataAPI.practiceTasks().includes(x)));
  t("tasksBySkill/mission не подсовывают задание без рисунка", DataAPI.skills().every((sk) =>
    DataAPI.practiceTasksBySkill(sk.id).every((x) => !DataAPI.taskHasMissingVisual(x))));
  t("миссии не включают задания без обязательного рисунка", DataAPI.missions()
    .every((m) => m.tasks.every((id) => !DataAPI.taskHasMissingVisual(DataAPI.task(id)))));
  Store.reset();
  let dailyRerollsClean = true;
  for (let i = 0; i < 30; i++) {
    ensureDailyChallenge();
    if (!dailyTaskIds().every((id) => !DataAPI.taskHasMissingVisual(DataAPI.task(id)))) dailyRerollsClean = false;
    Store.state.daily.date = "reroll-" + i; // force a fresh pick next iteration
  }
  t("daily никогда не выбирает задание без обязательного рисунка (30 переигровок)", dailyRerollsClean);

  // ---------------------------------------------------------------
  // Аудит алгоритмов: регрессионные тесты для найденных и исправленных
  // ошибок бизнес-логики (см. отчёт аудита).
  // ---------------------------------------------------------------

  // Daily Challenge должен засчитывать только реально решённые задания:
  // пропуск/показ ответа/неверный ответ не должны "закрывать" челлендж.
  Store.reset();
  ensureDailyChallenge();
  {
    const ids = dailyTaskIds();
    for (const id of ids) recordAnswer(DataAPI.task(id), false, 0, 5); // все "не решены"
    t("daily НЕ засчитывает неверные/пропущенные ответы", Store.state.daily.solved === 0 && !Store.state.daily.done);
    const before = Store.state.xp;
    for (const id of ids) recordAnswer(DataAPI.task(id), true, 0, 20); // теперь решаем верно
    t("daily засчитывается только после реально верных ответов", Store.state.daily.done && Store.state.daily.solved === ids.length && Store.state.xp > before);
  }

  // Та же проверка для восстановления daily.countedTaskIds из истории попыток
  // (ветка ensureDailyChallenge, которая работает при загрузке/перезаходе).
  Store.reset();
  ensureDailyChallenge();
  {
    const ids = dailyTaskIds();
    for (const id of ids) recordAnswer(DataAPI.task(id), false, 0, 5);
    const snapshot = JSON.parse(JSON.stringify(Store.state));
    snapshot.daily.countedTaskIds = undefined;
    Store.state = snapshot;
    ensureDailyChallenge();
    t("восстановление daily после перезагрузки не засчитывает неверные попытки", Store.state.daily.solved === 0 && !Store.state.daily.done);
  }

  // Достижения "первое решение" / "сотня" обещают решённые (верные) задания,
  // а не просто попытки — не должны открываться от одних ошибок/пропусков.
  Store.reset();
  {
    const t1 = DataAPI.task("n11_p1");
    recordAnswer(t1, false, 0, 10);
    recordAnswer(t1, false, 0, 10);
    t("«Первый шаг» не открывается от неверных попыток", !achievementUnlocked("first-solve"));
    recordAnswer(t1, true, 0, 10);
    t("«Первый шаг» открывается после реально верного ответа", achievementUnlocked("first-solve"));
  }

  // Миссия не должна засчитываться (и платить XP) за пробег с массовыми
  // пропусками/ошибками — только за реальную работу (порог как у боссов).
  Store.reset();
  {
    const mission = DataAPI.missions().find((m) => Array.isArray(m.tasks) && m.tasks.length >= 2);
    const beforeXp = Store.state.xp;
    for (const id of mission.tasks) recordAnswer(DataAPI.task(id), false, 0, 5);
    t("миссия не отмечена завершённой без верных ответов", !Store.state.missionsDone[mission.id]);
    t("XP миссии не начислен без верных ответов", Store.state.xp === beforeXp);
  }

  // weakestSkill({avoidRecentMs}) не должен зацикливаться на теме, которую
  // ученик только что интенсивно тренировал — иначе рекомендация бессмысленна.
  Store.reset();
  {
    const skills = DataAPI.skills();
    for (const s of skills) Store.state.skillStats[s.id] = { progress: 0, solved: 10, correct: 9, timeSec: 100 };
    const justDrilled = skills[Math.min(2, skills.length - 1)].id;
    Store.state.skillStats[justDrilled] = { progress: 0, solved: 8, correct: 1, timeSec: 100 };
    const now = Date.now();
    Store.state.taskAttempts = Array.from({ length: 5 }, (_, i) => ({ taskId: `synthetic_${i}`, skill: justDrilled, correct: i === 0, hintLevel: 0, seconds: 10, ts: now - i * 1000 }));
    t("weakestSkill() без опций возвращает объективно худший навык", weakestSkill().id === justDrilled);
    t("weakestSkill({avoidRecentMs}) не возвращает только что натренированный навык", weakestSkill({ avoidRecentMs: 45 * 60 * 1000 }).id !== justDrilled);
  }

  // recommendations(): незавершённый урок — высший приоритет, и тема этого
  // урока не должна дублироваться отдельной рекомендацией "слабый навык".
  Store.reset();
  {
    const lesson = DataAPI.lessons()[0];
    Store.state.lessonSessions = { [lesson.id]: { idx: 1, stepState: {}, xp: 0, wrongAttempts: 0, startTs: Date.now(), returnRoute: "training" } };
    const recs = recommendations();
    t("recommendations() ставит незавершённый урок первым пунктом", recs[0] && recs[0].text.includes(lesson.title));
    t("recommendations() не дублирует навык урока отдельной рекомендацией", recs.filter((r) => r.text.includes(lesson.title)).length === 1);
  }

  // mostRecentOpenLesson игнорирует сессии уроков, которых больше нет в
  // каталоге (например, после обновления контента), и не падает.
  Store.reset();
  {
    Store.state.lessonSessions = { "lesson-does-not-exist": { idx: 0, stepState: {}, xp: 0, wrongAttempts: 0, startTs: Date.now(), returnRoute: "path" } };
    t("mostRecentOpenLesson() не падает на осиротевшей сессии", mostRecentOpenLesson() === null);
  }

  // Ключ активности (для графика "14 дней" в app.js) обязан совпадать с
  // ключом, под которым recordAnswer/todayActivity() реально пишут данные —
  // иначе график молча теряет/смещает данные для пользователей не из MSK.
  t("dateKeyForTimestamp(now) совпадает с todayStr() (инвариант графика активности)", dateKeyForTimestamp(Date.now()) === todayStr());

  console.log(fails ? `\n${fails} FAILURES` : "\nALL OK");
  process.exit(fails ? 1 : 0);
};
eval(src + `\n;(${testBody.toString()})();`);
