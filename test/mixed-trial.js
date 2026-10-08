/* Сценарные тесты подбора «Смешанного испытания» (mixedTrialTaskIds).
   Раньше набор был неизменным: первые count тем каталога и самый первый
   task в каждой — повторный запуск давал те же задания. Проверяем новое
   поведение: слабые и ошибочные темы идут первыми, внутри темы задание
   ротируется, набор остаётся широким (одна тема — одно задание за круг). */
const fs = require("fs");
const src = fs.readFileSync("js/data.js", "utf8") + "\n" + fs.readFileSync("js/state.js", "utf8");
const testBody = async () => {
  let fails = 0;
  const t = (name, cond, extra) => { console.log((cond ? "ok   " : "FAIL ") + name + (cond || !extra ? "" : " | " + extra)); if (!cond) fails++; };
  DataAPI.load(JSON.parse(fs.readFileSync("server/catalog.json", "utf8")));
  Store.ready = false;
  const now = Date.now();
  const tasksById = (ids) => ids.map((id) => DataAPI.task(id)).filter(Boolean);

  /* 1. Полный набор: count заданий, все из разных тем, без дублей. */
  Store.reset();
  {
    const ids = mixedTrialTaskIds(10);
    const tasks = tasksById(ids);
    t("набор: ровно 10 заданий", ids.length === 10, ids.join(","));
    t("набор: без дублей", new Set(ids).size === ids.length, ids.join(","));
    t("набор: все задания существуют в каталоге", tasks.length === ids.length);
    t("набор: охват — 10 разных тем", new Set(tasks.map((x) => x.skill)).size === 10, tasks.map((x) => x.skill).join(","));
  }

  /* 2. Ошибка и низкая точность поднимают тему в начало набора. */
  Store.reset();
  {
    const skills = DataAPI.skills();
    const weak = skills[skills.length - 1].id;
    const task = DataAPI.practiceTasksBySkill(weak)[0];
    recordAnswer(task, false, 0, 15);
    const ids = mixedTrialTaskIds(10);
    t("слабая тема: тема с ошибкой идёт первой", DataAPI.task(ids[0]).skill === weak, ids[0]);
  }

  /* 3. Ротация: второй запуск не повторяет задания прошлого, пока банк цел. */
  Store.reset();
  {
    const first = mixedTrialTaskIds(10);
    for (const id of first) {
      Store.state.taskAttempts.push({ taskId: id, skill: DataAPI.task(id).skill, correct: true, hintLevel: 0, seconds: 20, closesTaskId: null, ts: now });
    }
    const second = mixedTrialTaskIds(10);
    const overlap = second.filter((id) => first.includes(id)).length;
    t("ротация: второй запуск берёт другие задания", overlap === 0, `overlap=${overlap}`);
    t("ротация: второй набор тоже 10 разных тем", new Set(tasksById(second).map((x) => x.skill)).size === 10, second.join(","));
  }

  /* 4. Малое число тем: набор добирается следующими заданиями за круг. */
  Store.reset();
  {
    const ids = mixedTrialTaskIds(25);
    const tasks = tasksById(ids);
    t("добор: 25 заданий по 20 темам", ids.length === 25 && tasks.length === 25, `ids=${ids.length}`);
    t("добор: без дублей", new Set(ids).size === ids.length);
    t("добор: каждая тема максимум дважды", Math.max(...Object.values(tasks.reduce((m, x) => (m[x.skill] = (m[x.skill] || 0) + 1, m), {}))) <= 2);
  }

  console.log(fails ? `\n${fails} FAILURES` : "\nALL OK");
  process.exit(fails ? 1 : 0);
};
eval(src + `\n;(${testBody.toString()})();`);
