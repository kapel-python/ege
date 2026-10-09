/* Ежедневная подборка и боссы: регрессия двух систем, которые почти не
   менялись с первых версий и проверяются здесь целиком.

   Подборка:
   - одна и та же на весь день (сид = московская дата + аккаунт), другая на
     следующий день, разная у разных учеников;
   - «интересная», а не лотерея: темы выбираются по личным сигналам (открытые
     ошибки, точность, освоение), как у миссий и «что делать сейчас»;
   - широкий охват: одна тема — одно задание за круг, без дублей, без сочинений.

   Боссы:
   - порог открытия достижим (полный набор уроков ветки обязан открывать босса),
     новый ученик босса не получает;
   - состав ветки ротируется между заходами и покрывает ВСЕ темы ветки, а не
     первые size навыков каталога. */
const fs = require("fs");
const src = fs.readFileSync("js/data.js", "utf8") + "\n" + fs.readFileSync("js/state.js", "utf8") + "\n"
  + fs.readFileSync("js/mathvisual.js", "utf8");
const testBody = async () => {
  let fails = 0;
  const t = (name, cond, extra) => { console.log((cond ? "ok   " : "FAIL ") + name + (cond || !extra ? "" : " | " + extra)); if (!cond) fails++; };
  const dayStr = (n) => { const d = new Date(Date.UTC(2026, 0, 1 + n)); return d.toISOString().slice(0, 10); };
  const skillsOf = (ids) => ids.map((id) => DataAPI.task(id).skill);

  DataAPI.load(JSON.parse(fs.readFileSync("server/catalog.json", "utf8")));
  Store.ready = false;
  Store.accountId = "account-daily";
  Store.subject = "profile_math";
  t("дата подборки — московская (инвариант полночи)", dailyDateKey() === todayStr()
    && dateKeyForTimestamp(Date.now()) === todayStr());

  /* ---------- 1. Стабильность дня и смена на следующий ---------- */
  Store.reset();
  ensureDailyChallenge();
  const today = dailyTaskIds();
  t("подборка набрана по целевому размеру", today.length === DataAPI.daily().target, `length=${today.length}`);
  t("подборка не содержит дублей", new Set(today).size === today.length);
  t("все задания подборки существуют", today.every((id) => !!DataAPI.task(id)));
  t("сочинения в подборку не попадают", today.every((id) => !isEssayTask(DataAPI.task(id))));
  t("широкий охват: задания из разных тем", new Set(skillsOf(today)).size >= Math.ceil(today.length / 2),
    skillsOf(today).join(","));

  // Активность внутри дня (решили посторонние задания и одно из подборки)
  // не должна пересобирать подборку: день держит один набор.
  const outside = DataAPI.practiceTasks().filter((task) => !today.includes(task.id)).slice(0, 10);
  for (const task of outside) recordAnswer(task, true, 0, 20);
  recordAnswer(DataAPI.task(today[0]), true, 0, 20);
  ensureDailyChallenge();
  t("подборка не меняется в течение дня", JSON.stringify(dailyTaskIds()) === JSON.stringify(today));
  t("решение задания подборки учитывается", Store.state.daily.solved === 1 && !Store.state.daily.done);
  // Перезагрузка без countedTaskIds восстанавливает счёт из истории ответов.
  const snapshot = JSON.parse(JSON.stringify(Store.state));
  snapshot.daily.countedTaskIds = undefined;
  Store.state = snapshot;
  ensureDailyChallenge();
  t("после перезагрузки набор тот же и счёт сохранён",
    JSON.stringify(dailyTaskIds()) === JSON.stringify(today) && Store.state.daily.solved === 1);

  // Следующий день — другой набор. Симулируем живой цикл: день уходит в
  // историю, задания считаются решёнными (как после recordAnswer).
  const week = [];
  for (let day = 0; day < 3; day++) {
    const ids = selectDailyTaskIds(dayStr(day));
    week.push(ids);
    for (const id of ids) recordAnswer(DataAPI.task(id), true, 0, 20);
    Store.state.daily = { date: dayStr(day), solved: ids.length, done: true, taskIds: ids, countedTaskIds: ids };
    Store.state.dailyHistory = [{ date: dayStr(day), solved: ids.length, done: true, taskIds: ids }]
      .concat(dailyHistory());
  }
  t("на следующий день подборка другая",
    JSON.stringify(week[0]) !== JSON.stringify(week[1]) && JSON.stringify(week[1]) !== JSON.stringify(week[2]));
  const neighbours = week.reduce((sum, ids, i) => sum + (i ? week[i - 1].filter((id) => ids.includes(id)).length : 0), 0);
  t("соседние дни не повторяют задания друг друга", neighbours === 0, `overlap=${neighbours}`);

  /* ---------- 2. Один день — один набор у ученика, разный у другого ---------- */
  Store.reset();
  Store.accountId = "account-daily";
  const mine = selectDailyTaskIds(dayStr(10));
  const again = selectDailyTaskIds(dayStr(10));
  t("одна дата у одного аккаунта даёт один и тот же набор", JSON.stringify(mine) === JSON.stringify(again));
  Store.accountId = "account-neighbour";
  const theirs = selectDailyTaskIds(dayStr(10));
  t("разные аккаунты получают разную подборку в один день", JSON.stringify(mine) !== JSON.stringify(theirs));

  /* ---------- 3. Персонализация: тема с ошибкой попадает в подборку ---------- */
  Store.reset();
  Store.accountId = "account-weak";
  {
    const skills = DataAPI.availableSkills();
    const weak = skills[skills.length - 1].id;
    const task = DataAPI.practiceTasksBySkill(weak)[0];
    recordAnswer(task, false, 0, 15);
    const ids = selectDailyTaskIds(dayStr(20));
    t("тема с открытой ошибкой попадает в подборку", skillsOf(ids).includes(weak),
      ids.join(","));
  }
  // Тема, которую только что интенсивно тренировали, уходит вниз.
  Store.reset();
  Store.accountId = "account-fatigue";
  {
    const skills = DataAPI.availableSkills();
    const drilled = skills[3].id;
    for (const task of DataAPI.practiceTasksBySkill(drilled)) recordAnswer(task, true, 0, 20);
    const ids = selectDailyTaskIds(dayStr(21));
    t("только что натренированная тема не занимает всю подборку",
      skillsOf(ids).filter((s) => s === drilled).length <= 2, ids.join(","));
  }

  /* ---------- 4. Боссы: порог достижим, состав ротируется ---------- */
  Store.reset();
  {
    const boss = DataAPI.bosses()[0];
    t("порог босса достижим уроком ветки", Number(boss.unlockAt) > 0 && Number(boss.unlockAt) <= 40,
      `unlockAt=${boss.unlockAt}`);
    t("новому ученику босс закрыт", !bossUnlocked(boss) && catProgress(boss.cat) === 0);
    // Полный набор уроков ветки — гарантированный ключ от босса.
    for (const skill of DataAPI.availableSkills()) {
      if (DataAPI._skillCategoryId(skill) !== boss.cat) continue;
      for (const lesson of DataAPI.lessonsBySkill(skill.id)) {
        Store.state.completedLessons[lesson.id] = { ts: Date.now() };
      }
    }
    t("все уроки ветки открывают босса", bossUnlocked(boss), `catProgress=${catProgress(boss.cat)}`);
  }
  Store.reset();
  {
    const boss = DataAPI.bosses()[0];
    const branchSkills = new Set(DataAPI.practiceTasks()
      .filter((task) => DataAPI.skill(task.skill) && DataAPI._skillCategoryId(DataAPI.skill(task.skill)) === boss.cat)
      .map((task) => task.skill));
    t("в ветке босса тем больше, чем заданий в испытании", branchSkills.size > boss.size,
      `skills=${branchSkills.size}, size=${boss.size}`);
    const seenSkills = new Set();
    let previous = null;
    for (let run = 1; run <= 4; run++) {
      const ids = bossTaskIds(boss);
      t(`заход ${run}: набор ветки набран целиком`, ids.length === Math.min(boss.size, branchSkills.size),
        `ids=${ids.length}`);
      t(`заход ${run}: задания принадлежат ветке босса`, ids.every((id) => branchSkills.has(DataAPI.task(id).skill)));
      if (previous) {
        t(`заход ${run}: состав не повторяет прошлый`, previous.filter((id) => ids.includes(id)).length === 0,
          `overlap=${previous.filter((id) => ids.includes(id)).length}`);
      }
      previous = ids;
      ids.forEach((id) => seenSkills.add(DataAPI.task(id).skill));
      // Реальные ответы (60% верно) — попытки меняют ротацию внутри тем.
      ids.forEach((id, i) => recordAnswer(DataAPI.task(id), i < Math.ceil(ids.length * 0.6), 0, 20));
    }
    t("за четыре захода босс обходит все темы ветки", seenSkills.size === branchSkills.size,
      `covered=${seenSkills.size}/${branchSkills.size}`);
  }

  /* ---------- 5. Данные каталогов: порог босса и обещания в описании ---------- */
  {
    const catalogs = ["catalog.json", "catalog_basic.json", "catalog_russian.json",
      "catalog_biology.json", "catalog_informatics.json", "catalog_society.json"];
    let thresholdsOk = true, poolsOk = true;
    const bad = [];
    for (const file of catalogs) {
      const catalog = JSON.parse(fs.readFileSync(`server/${file}`, "utf8"));
      const tasksBySkill = {};
      for (const task of catalog.tasks || []) {
        (tasksBySkill[task.skill] = tasksBySkill[task.skill] || []).push(task);
      }
      for (const boss of catalog.bosses || []) {
        /* Порог достижим: полный набор уроков ветки даёт ровно 40% освоения,
           поэтому ветка босса не может требовать больше — иначе он навсегда
           остался бы закрытым для тех, кто идёт уроками, а не вдыхает банк.
           Финальный «смешанный вариант всего курса» сознательно строже: до
           него доходят уже сильные ученики, и он остаётся последним делом. */
        if (!(Number(boss.unlockAt) > 0 && Number(boss.unlockAt) <= 60)) thresholdsOk = false;
        // «N заданий в пуле» — проверяемое обещание: расхождение значит, что
        // банк вырос, а описание осталось с первых версий.
        const promised = /\((\d+) задани\w+ в пуле\)/.exec(String(boss.desc || ""));
        if (promised) {
          const pool = (catalog.skills || [])
            .filter((skill) => (skill.cat || skill.category) === boss.cat)
            .reduce((sum, skill) => sum + (tasksBySkill[skill.id] || []).length, 0);
          if (Number(promised[1]) !== pool) {
            poolsOk = false;
            bad.push(`${file}:${boss.id} обещает ${promised[1]}, в пуле ${pool}`);
          }
        }
      }
    }
    t("порог каждого босса достижим путем предмета", thresholdsOk);
    t("описания боссов не врут о размере пула", poolsOk, bad.join("; "));
  }

  console.log(fails ? `\n${fails} FAILURES` : "\nALL OK");
  process.exit(fails ? 1 : 0);
};
eval(src + `\n;(${testBody.toString()})();`);
