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
  t("у каждого задания есть содержание", DataAPI.tasks().every((x) => x.hint && x.solution && x.text && x.answer));
  t("у каждого навыка есть >= 5 заданий", DataAPI.skills().every((s) => DataAPI.tasksBySkill(s.id).length >= 5));
  t("уроки и шаги загружены из каталога", DataAPI.lessons().length > 0 && DataAPI.lessons().every((l) => l.steps && l.steps.length));

  t("checkAnswer exact", checkAnswer(DataAPI.task("eq1"), "5"));
  t("checkAnswer comma/dot", checkAnswer(DataAPI.task("eq6"), "0,5"));
  t("checkAnswer wrong", !checkAnswer(DataAPI.task("eq1"), "6"));

  Store.reset();
  t("стартовый level 1", levelInfo().level === 1);
  const task = DataAPI.task("dv3");
  recordAnswer(task, false, 0, 30);
  t("ошибка записалась", Store.state.errors.length === 1 && !Store.state.errors[0].resolved);
  const before = Store.state.xp;
  recordAnswer(task, true, 0, 25);
  t("ошибка закрыта и XP начислен", Store.state.errors[0].resolved && Store.state.errorsResolved === 1 && Store.state.xp > before);
  t("попытки сохранены в runtime-снимке", Store.state.taskAttempts.length === 2);

  Store.reset();
  const lesson = DataAPI.lesson("quad-discriminant");
  const lessonXp = Store.state.xp;
  const first = completeLesson(lesson, 20, { wrongAttempts: 2, durationSec: 30 });
  const second = completeLesson(lesson, 20, { wrongAttempts: 1, durationSec: 10 });
  t("первое завершение урока даёт награду", first.firstCompletion && first.totalXp === lesson.xp + 20 && Store.state.xp === lessonXp + lesson.xp + 20);
  t("повтор урока не фармит XP", !second.firstCompletion && second.totalXp === 0 && Store.state.xp === lessonXp + lesson.xp + 20);
  t("история урока сохранена", Store.state.lessonAttempts.length === 2);

  Store.reset();
  applyOnboarding("base", "g80", DataAPI.diagnosticTasks().map((id) => ({ taskId: id, correct: true })));
  t("диагностика сохраняет только реальные ответы", Store.state.onboarded && Store.state.xp === 0 && Store.state.diagnostics.length === 5 && Store.state.totalSolved === 5);
  t("онбординг не создаёт случайный прогресс", Store.state.skillStats.wordproblems.progress === 0);

  Store.reset();
  addXp(5000, "test");
  t("уровень считается из XP", levelInfo().level > 3);
  Store.reset();
  for (let i = 0; i < DataAPI.daily().target; i++) recordAnswer(DataAPI.tasksBySkill("functions")[i % DataAPI.tasksBySkill("functions").length], true, 0, 20);
  t("daily награда зависит от фактических ответов", Store.state.daily.done && Store.state.xp >= DataAPI.daily().xp);

  console.log(fails ? `\n${fails} FAILURES` : "\nALL OK");
  process.exit(fails ? 1 : 0);
};
eval(src + `\n;(${testBody.toString()})();`);
