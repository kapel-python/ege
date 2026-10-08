/* Сценарные тесты CTA «привяжи аккаунт» для гостя с прогрессом
   (bumpGuestSteps / guestSaveCtaHTML). Блок показывается РОВНО ОДИН РАЗ:
   на пороге 8 осмысленных шагов. Проверяем, что считаются только
   ОСМЫСЛЕННЫЕ шаги (повтор уже освоенного задания — нет), что урок и
   миссия весят больше одного задания, что после показа блок больше не
   возвращается и что зарегистрированному аккаунту он не показывается. */
const fs = require("fs");
const src = fs.readFileSync("js/data.js", "utf8") + "\n" + fs.readFileSync("js/state.js", "utf8");
const testBody = async () => {
  let fails = 0;
  const t = (name, cond, extra) => { console.log((cond ? "ok   " : "FAIL ") + name + (cond || !extra ? "" : " | " + extra)); if (!cond) fails++; };

  // Полифил localStorage: guestCtaRead/Write рассчитаны на браузер.
  const ls = {};
  global.localStorage = {
    getItem: (k) => (k in ls ? ls[k] : null),
    setItem: (k, v) => { ls[k] = String(v); },
    removeItem: (k) => { delete ls[k]; },
  };

  DataAPI.load(JSON.parse(fs.readFileSync("server/catalog.json", "utf8")));
  Store.ready = false;
  const reset = () => {
    Store.reset();
    Store.accountId = "a_test01";
    Store.auth = { registered: false, email: null, providers: [], googleEnabled: false, hasPassword: false };
    try { localStorage.removeItem("ege_guest_cta_v1"); } catch (_) {}
  };

  /* 1. Гость с нулём шагов — блока нет. */
  reset();
  t("ноль шагов: блока нет", guestSaveCtaHTML() === "");

  /* 2. Порог 8: блок появляется и только один раз. */
  for (let i = 0; i < 8; i++) bumpGuestSteps(1);
  const html = guestSaveCtaHTML();
  t("порог 8: блок появился", html.includes("Аккаунт не привязан"), html.slice(0, 140));
  t("порог 8: кнопка ведёт на регистрацию", html.includes("go('register')"));
  t("порог 8: показывается один раз", guestSaveCtaHTML() === "");
  t("порог 8: до 20 повторно не показывается", guestSaveCtaPending() === 0);

  /* 3. Повтор уже освоенного задания шагом не считается. */
  reset();
  const skill = DataAPI.skills()[0].id;
  const task = DataAPI.practiceTasksBySkill(skill)[0];
  Store.state.taskAttempts.push({ taskId: task.id, skill, correct: true, hintLevel: 0, seconds: 5, closesTaskId: null, ts: Date.now() });
  const before = Number(guestCtaRead().steps) || 0;
  recordAnswer(task, true, 0, 5);
  t("повтор освоенного: шаг не добавлен", (Number(guestCtaRead().steps) || 0) === before, `${before} → ${guestCtaRead().steps}`);

  /* 4. Новое верное задание — ровно +1 шаг. */
  const task2 = DataAPI.practiceTasksBySkill(skill)[1];
  recordAnswer(task2, true, 0, 5);
  t("новое верное задание: +1 шаг", (Number(guestCtaRead().steps) || 0) === before + 1, guestCtaRead().steps);

  /* 5. Первое прохождение урока весит 3 шага. */
  const lesson = DataAPI.lessonsBySkill(skill)[0];
  if (lesson) {
    completeLesson(lesson, 0);
    t("урок: +3 шага", (Number(guestCtaRead().steps) || 0) === before + 4, guestCtaRead().steps);
  } else t("урок: +3 шага (урока в каталоге нет — пропуск)", true);

  /* 6. Завершённая миссия весит 3 шага. */
  reset();
  const mission = DataAPI.missions().find((m) => missionPracticeIds(m).length);
  if (mission) {
    completeMission(mission);
    t("миссия: +3 шага", (Number(guestCtaRead().steps) || 0) === 3, guestCtaRead().steps);
  } else t("миссия: +3 шага (миссий в каталоге нет — пропуск)", true);

  /* 6. Порог 40 и любые новые шаги: показ был ОДИН раз, блок не возвращается. */
  reset();
  for (let i = 0; i < 8; i++) bumpGuestSteps(1);
  t("порог 8: блок появился", guestSaveCtaHTML() !== "");
  t("показ один раз: до 40 и дальше блока нет", guestSaveCtaHTML() === "" && guestSaveCtaPending() === 0);
  for (let i = 0; i < 60; i++) bumpGuestSteps(1);
  t("60+ шагов: блока всё ещё нет", guestSaveCtaHTML() === "");

  /* 7. Зарегистрированному аккаунту блока нет, шаги не считаются. */
  reset();
  Store.auth = { registered: true, email: "x@y.ru", providers: [], googleEnabled: false, hasPassword: true };
  for (let i = 0; i < 30; i++) bumpGuestSteps(1);
  t("зарегистрированный: блока нет и шаги не копятся", guestSaveCtaHTML() === "" && guestSaveCtaPending() === 0, guestCtaRead().steps);

  console.log(fails ? `\n${fails} FAILURES` : "\nALL OK");
  process.exit(fails ? 1 : 0);
};
eval(src + `\n;(${testBody.toString()})();`);
