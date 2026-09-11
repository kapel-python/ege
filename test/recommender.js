/* Сценарные тесты движка «лучший следующий шаг» (nextStepCandidates).
   Проверяются не техническая работоспособность, а качество решений для
   типовых состояний ученика: новый аккаунт, слабая база, один пробел,
   перенасыщение темы (анти-зацикливание), незавершённые активности,
   конфликт приоритетов и пересчёт после результата. */
const fs = require("fs");
const src = fs.readFileSync("js/data.js", "utf8") + "\n" + fs.readFileSync("js/state.js", "utf8");
const testBody = async () => {
  let fails = 0;
  const t = (name, cond) => { console.log((cond ? "ok  " : "FAIL") + " " + name); if (!cond) fails++; };
  DataAPI.load(JSON.parse(fs.readFileSync("server/catalog.json", "utf8")));
  Store.ready = false;

  const now = Date.now();
  const HOUR = 3600 * 1000;
  const DAY = 24 * HOUR;
  const skills = DataAPI.skills();
  const lessonOf = (sid) => DataAPI.lessonsBySkill(sid)[0] || null;
  const missionOf = (sid) => DataAPI.missions().find((m) => m.skill === sid && Array.isArray(m.tasks) && m.tasks.length);

  /* Базовый набор: все навыки освоены на high% (урок пройден, точность
     высокая) — фон для сценариев, где важен один конкретный навык. */
  function makeStrongStudent(weakSetup) {
    Store.reset();
    for (const sk of skills) {
      const l = lessonOf(sk.id);
      if (l) Store.state.completedLessons[l.id] = { ts: now - 3 * DAY };
      Store.state.skillStats[sk.id] = { progress: 0, solved: 10, correct: 9, timeSec: 300 };
    }
    if (weakSetup) weakSetup();
  }

  function attemptsFor(sid, list) {
    // list: массив correct; ts — свежие, в пределах окна усталости
    for (let i = 0; i < list.length; i++) {
      Store.state.taskAttempts.unshift({ taskId: `syn_${sid}_${i}`, skill: sid, correct: !!list[i], hintLevel: 0, seconds: 20, closesTaskId: null, ts: now - i * 1000 });
    }
  }

  /* ---------- 1. Новый пользователь (после диагностики) ---------- */
  Store.reset();
  applyOnboarding("base", "g60", DataAPI.diagnosticTasks().map((id) => ({ taskId: id, correct: true })));
  {
    const best = bestNextStep();
    t("новичку: лучший шаг — урок (теория раньше практики)", best && best.action === "lesson" && !!best.payload.lessonId);
    t("новичку: не босс и не испытание", best.action !== "boss" && best.action !== "mixed");
    t("новичку: все кандидаты с текстом и причиной", nextStepCandidates().every((c) => c.text && c.reason));
  }

  /* ---------- 2. Слабая база: много ошибок в нескольких темах ---------- */
  Store.reset();
  {
    const errSkills = skills.slice(0, 4);
    for (const sk of errSkills) {
      const task = DataAPI.practiceTasksBySkill(sk.id)[0];
      recordAnswer(task, false, 0, 15);
      recordAnswer(DataAPI.practiceTasksBySkill(sk.id)[1] || task, false, 0, 15);
    }
    const best = bestNextStep();
    t("слабая база: приоритет — повторение ошибок", best && best.action === "errors-review");
  }

  /* ---------- 3. Один выраженный пробел, остальное хорошо ---------- */
  makeStrongStudent(() => {
    const weak = skills[5].id;
    Store.state.skillStats[weak] = { progress: 10, solved: 10, correct: 1, timeSec: 400 };
    attemptsFor(weak, [false, false, false, false, false, false, false, false, false, true]);
  });
  {
    const weak = skills[5].id;
    const best = bestNextStep();
    t("один пробел: лучший шаг — урок отстающей теми", best && best.action === "lesson" && best.payload.lessonId === (lessonOf(weak) || {}).id);
  }

  /* ---------- 4. После урока: закрепить новый навык практикой ---------- */
  makeStrongStudent(() => {
    const sid = skills[3].id;
    const l = lessonOf(sid);
    Store.state.completedLessons[l.id] = { ts: now }; // урок пройден только что
    Store.state.skillStats[sid] = { progress: 0, solved: 10, correct: 6, timeSec: 400 };
    attemptsFor(sid, [true, false, true, true, false]);
  });
  {
    const sid = skills[3].id;
    const best = bestNextStep();
    t("после урока: лучший шаг — тренировка освоенной темы", best && best.action === "practice" && best.payload.skillId === sid);
  }

  /* ---------- 5. Анти-зацикливание: тема перетренирована ---------- */
  // 5a. урок темы не пройден → система отправляет к теории, а не долбить дальше
  makeStrongStudent(() => {
    const sid = skills[7].id;
    const l = lessonOf(sid);
    if (l) delete Store.state.completedLessons[l.id];
    Store.state.skillStats[sid] = { progress: 10, solved: 8, correct: 1, timeSec: 300 };
    attemptsFor(sid, [true, false, false, false, false, false, false, false]);
  });
  {
    const sid = skills[7].id;
    const best = bestNextStep();
    t("перетренирована + урок не пройден: лучший шаг — урок этой темы",
      best && best.action === "lesson" && best.payload.lessonId === (lessonOf(sid) || {}).id);
    t("перетренирована: практика по этой теме не лидирует",
      best.action !== "practice" || best.payload.skillId !== sid);
  }
  // 5b. урок пройден → практика по этой теме подавлена, выбирается другое действие
  makeStrongStudent(() => {
    const sid = skills[7].id;
    Store.state.skillStats[sid] = { progress: 30, solved: 8, correct: 1, timeSec: 300 };
    attemptsFor(sid, [true, false, false, false, false, false, false, false]);
  });
  {
    const sid = skills[7].id;
    const best = bestNextStep();
    const practiceCand = nextStepCandidates().find((c) => c.action === "practice" && c.payload.skillId === sid);
    t("перетренирована + урок пройден: не предлагаем ещё раз гонять ту же тему",
      !practiceCand || practiceCand.score < best.score - 1 || best.payload.skillId !== sid);
  }

  /* ---------- 6. После половины практики: продолжить начатое ---------- */
  makeStrongStudent(() => {
    const sid = skills[2].id;
    const m = missionOf(sid);
    Store.state.skillStats[sid] = { progress: 0, solved: 10, correct: 6, timeSec: 400 };
    attemptsFor(sid, [true, false, true, true, false]);
    Store.state.missionProgress[m.id] = 1;
  });
  {
    const sid = skills[2].id;
    const best = bestNextStep();
    t("половина практики: лучший шаг — продолжить начатую тренировку",
      best && best.action === "practice" && best.payload.skillId === sid && /Продолжить/.test(best.text));
  }

  /* ---------- 7. Хороший ученик: почти всё освоено ---------- */
  makeStrongStudent(() => {
    for (const sk of skills) Store.state.skillStats[sk.id] = { progress: 0, solved: 12, correct: 11, timeSec: 300 };
  });
  {
    ensureDailyChallenge();
    Store.state.daily = { date: todayStr(), solved: 6, done: true, taskIds: dailyTaskIds(), countedTaskIds: dailyTaskIds() };
    const best = bestNextStep();
    t("хороший ученик: всё освоено, daily закрыт — лучший шаг готового босса", best && best.action === "boss");
  }

  /* ---------- 8. Почти завершивший курс: боссы повержены, daily закрыт ---------- */
  makeStrongStudent(() => {
    for (const sk of skills) Store.state.skillStats[sk.id] = { progress: 0, solved: 12, correct: 11, timeSec: 300 };
    Store.state.bossesDefeated = DataAPI.bosses().map((b) => b.id);
  });
  {
    ensureDailyChallenge();
    Store.state.daily = { date: todayStr(), solved: 6, done: true, taskIds: dailyTaskIds(), countedTaskIds: dailyTaskIds() };
    const best = bestNextStep();
    t("курс пройден: остаётся поддерживать форму (смешанное испытание)", best && best.action === "mixed");
  }

  /* ---------- 9. Незавершённый урок против ошибок и босса ---------- */
  makeStrongStudent(() => {
    const l = lessonOf(skills[9].id);
    Store.state.lessonSessions = { [l.id]: { idx: 1, stepState: {}, xp: 0, wrongAttempts: 0, startTs: now, returnRoute: "training" } };
    for (const sk of skills.slice(0, 3)) {
      Store.state.errors.unshift({ taskId: DataAPI.practiceTasksBySkill(sk.id)[0].id, skill: sk.id, sub: "s", ts: now - 2 * DAY, resolved: false });
    }
  });
  {
    const best = bestNextStep();
    const cands = nextStepCandidates();
    const idx = (action) => cands.findIndex((c) => c.action === action);
    t("конфликт: незавершённый урок — всегда первый", best && best.action === "finish-lesson");
    t("конфликт: ошибки важнее босса и ежедневной", idx("errors-review") > -1 && idx("errors-review") < idx("boss") && idx("boss") < idx("daily"));
  }

  /* ---------- 10. Пересчёт после результата ---------- */
  Store.reset();
  {
    const sk = skills[4];
    const tasks = DataAPI.practiceTasksBySkill(sk.id);
    for (const task of tasks) recordAnswer(task, false, 0, 15);
    t("пересчёт: до исправления есть кандидат «повторение ошибок»",
      nextStepCandidates().some((c) => c.action === "errors-review"));
    for (const task of tasks) recordAnswer(task, true, 0, 20);
    const after = nextStepCandidates();
    t("пересчёт: закрытые ошибки исчезают из кандидатов", !after.some((c) => c.action === "errors-review"));
    t("пересчёт: лучший шаг — обучение или тренировка (не испытание)",
      after[0].action === "lesson" || after[0].action === "practice" || after[0].action === "finish-lesson");
  }

  /* ---------- 11. Устойчивость к осиротевшим данным ---------- */
  Store.reset();
  {
    Store.state.lessonSessions = { "lesson-ghost": { idx: 0, stepState: {}, xp: 0, wrongAttempts: 0, startTs: now, returnRoute: "path" } };
    Store.state.diagnostics = [{ taskId: "ghost-task", correct: false, ts: now }];
    Store.state.errors = [{ taskId: "ghost-task", skill: skills[0].id, sub: "s", ts: now - 3 * DAY, resolved: false }];
    let ok = true;
    try { nextStepCandidates(); bestNextStep(); } catch (e) { ok = false; }
    t("осиротевшие ссылки (удалённые уроки/задания) не роняют движок", ok);
  }

  /* ---------- 12. Всегда есть хотя бы один следующий шаг ---------- */
  Store.reset();
  t("список кандидатов никогда пустым не бывает", nextStepCandidates().length >= 1 && !!bestNextStep());

  console.log(fails ? `\n${fails} FAILURES` : "\nALL OK");
  process.exit(fails ? 1 : 0);
};
eval(src + `\n;(${testBody.toString()})();`);
