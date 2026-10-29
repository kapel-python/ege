/* Единая теория: интерактивный урок равен обычному (разницы ноль).
   Грузятся настоящие js/data.js + js/state.js и настоящий каталог.
   Проверяется: теория 40 любым форматом, жёсткий потолок (оба — всё равно
   40), прогноз и его порог считают оба формата, следующий шаг предлагает
   интерактив при наличии, иначе обычный урок. */
const fs = require("fs");
const src = fs.readFileSync("js/data.js", "utf8") + "\n" + fs.readFileSync("js/state.js", "utf8");

/* Build the same public payload the server attaches to a ready subject. */
function serverLikePayload(subjectId, catalogFile) {
  const catalog = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
  const contracts = ["profile_math", "basic_math", "russian", "history"].map((id) =>
    JSON.parse(fs.readFileSync(`server/subjects/${id}.json`, "utf8"))
  );
  const contract = contracts.find((item) => item.id === subjectId);
  if (!contract) throw new Error(`Unknown subject contract: ${subjectId}`);

  const publicInfo = (item) => ({
    id: item.id,
    title: item.title,
    short: item.short,
    description: item.description || "",
    status: item.status,
    locked: !!item.locked,
    comingSoon: !!item.comingSoon,
    availability: item.availability || item.status,
    forecast: item.forecast,
    features: item.features,
    ...(item.metadata ? { metadata: item.metadata } : {}),
  });

  return {
    ...catalog,
    subject: subjectId,
    subjects: contracts.map(publicInfo),
    subjectInfo: publicInfo(contract),
    forecast: contract.forecast,
  };
}

const testBody = async () => {
  let fails = 0;
  const t = (name, cond, extra) => {
    console.log((cond ? "ok   " : "FAIL ") + name + (cond || !extra ? "" : " | " + extra));
    if (!cond) fails++;
  };
  DataAPI.load(serverLikePayload("profile_math", "server/catalog.json"));
  Store.ready = false;

  const now = Date.now();
  const DAY = 24 * 3600 * 1000;
  const N14 = "n14_trig_eq";
  const V14 = "v-trig-01";
  const L14 = (DataAPI.lessonsBySkill(N14)[0] || {}).id;
  const skills = DataAPI.skills();
  t("fixture: ilesson and classic share one skill", L14 === "lesson_n14_trig"
    && DataAPI.ilessonsBySkill(N14).some((l) => l.id === V14), `${L14} / ${V14}`);

  const setClassic = (on) => {
    if (on) Store.state.completedLessons[L14] = { ts: now - 3 * DAY };
    else delete Store.state.completedLessons[L14];
  };
  const setInteractive = (on) => {
    if (on) Store.state.completedILessons[V14] = { ts: now - 3 * DAY };
    else delete Store.state.completedILessons[V14];
  };

  /* ---------- 1. Теория 40 любым форматом, потолок жёсткий ---------- */
  Store.reset();
  t("theory: none -> 0", skillTheoryProgress(N14) === 0 && skillProgress(N14) === 0);
  setClassic(true);
  t("theory: classic -> 40", skillTheoryProgress(N14) === 40 && skillProgress(N14) === 40,
    `${skillTheoryProgress(N14)} / ${skillProgress(N14)}`);
  Store.reset();
  setInteractive(true);
  t("theory: interactive -> 40 (equal to classic)", skillTheoryProgress(N14) === 40 && skillProgress(N14) === 40,
    `${skillTheoryProgress(N14)} / ${skillProgress(N14)}`);
  setClassic(true);
  t("theory: both formats still 40, never 80", skillTheoryProgress(N14) === 40 && skillProgress(N14) === 40,
    `${skillTheoryProgress(N14)} / ${skillProgress(N14)}`);

  /* ---------- 2. Разбор прогресса един для обоих форматов ---------- */
  Store.reset();
  setInteractive(true);
  {
    const b = skillProgressBreakdown(N14);
    t("breakdown: interactive closes theory unit", b.lessonTotal === 1 && b.lessonDone === 1 && b.theory === 40,
      JSON.stringify(b));
  }
  Store.reset();
  {
    const b = skillProgressBreakdown(N14);
    t("breakdown: untouched theory unit open", b.lessonTotal === 1 && b.lessonDone === 0 && b.theory === 0,
      JSON.stringify(b));
  }

  /* ---------- 3. Статус темы видит интерактив ---------- */
  Store.reset();
  t("status: untouched is not-started", skillStatus(DataAPI.skill(N14)) === "not-started");
  setInteractive(true);
  t("status: interactive done is in-progress, not not-started",
    skillStatus(DataAPI.skill(N14)) === "in-progress", skillStatus(DataAPI.skill(N14)));

  /* ---------- 4. Прогноз: освоение любым форматом ---------- */
  Store.reset();
  setInteractive(true);
  t("forecast mastery: interactive -> 40", forecastSkillMastery(N14, now) === 40,
    String(forecastSkillMastery(N14, now)));
  setClassic(true);
  t("forecast mastery: both -> 40, no double", forecastSkillMastery(N14, now) === 40,
    String(forecastSkillMastery(N14, now)));
  Store.reset();
  setClassic(true);
  t("forecast mastery: classic -> 40", forecastSkillMastery(N14, now) === 40,
    String(forecastSkillMastery(N14, now)));

  /* ---------- 5. Порог и покрытие: без двойного счёта ---------- */
  Store.reset();
  {
    const r = forecastReadiness(0, skills.length);
    t("readiness: no double count of formats", r.totalLessons === 20 && r.doneLessons === 0,
      JSON.stringify({ total: r.totalLessons, done: r.doneLessons }));
    const c = forecastCoverage();
    t("coverage: total 20 with ilesson present", c.totalLessons === 20 && c.doneLessons === 0,
      JSON.stringify({ total: c.totalLessons, done: c.doneLessons }));
  }
  setInteractive(true);
  {
    const r = forecastReadiness(0, skills.length);
    t("readiness: interactive counts toward lesson gate", r.doneLessons === 1,
      JSON.stringify({ done: r.doneLessons, need: r.needLessons }));
    const c = forecastCoverage();
    t("coverage: interactive counts", c.doneLessons === 1 && c.lessonPct === 5,
      JSON.stringify({ done: c.doneLessons, pct: c.lessonPct }));
  }
  setClassic(true);
  {
    const r = forecastReadiness(0, skills.length);
    t("readiness: both formats count once", r.doneLessons === 1, JSON.stringify({ done: r.doneLessons }));
  }

  /* ---------- 6. Сквозное равенство прогноза ---------- */
  function strongSetup(useInteractiveForN14) {
    Store.reset();
    for (const sk of skills) {
      if (sk.id === N14 && useInteractiveForN14) {
        Store.state.completedILessons[V14] = { ts: now - 3 * DAY };
      } else {
        const l = (DataAPI.lessonsBySkill(sk.id)[0]) || null;
        if (l) Store.state.completedLessons[l.id] = { ts: now - 3 * DAY };
      }
      Store.state.skillStats[sk.id] = { progress: 0, solved: 14, correct: 13, timeSec: 400 };
      for (let i = 0; i < 14; i++) {
        Store.state.taskAttempts.push({ taskId: `syn_${sk.id}_${i}`, skill: sk.id, correct: i !== 5, hintLevel: 0, seconds: 30, closesTaskId: null, ts: now - i * 3600 * 1000 });
      }
    }
  }
  strongSetup(false);
  const midClassic = forecast().mid;
  strongSetup(true);
  const midInteractive = forecast().mid;
  t("forecast: ilesson instead of classic gives same mid",
    midClassic > 0 && midClassic === midInteractive, `${midClassic} vs ${midInteractive}`);

  /* ---------- 7. Следующий шаг: интерактив раньше классики ---------- */
  function strongExcept(weakId) {
    Store.reset();
    for (const sk of skills) {
      if (sk.id === weakId) {
        Store.state.skillStats[sk.id] = { progress: 0, solved: 0, correct: 0, timeSec: 0 };
        continue;
      }
      const l = (DataAPI.lessonsBySkill(sk.id)[0]) || null;
      if (l) Store.state.completedLessons[l.id] = { ts: now - 3 * DAY };
      Store.state.skillStats[sk.id] = { progress: 0, solved: 10, correct: 9, timeSec: 300 };
    }
  }
  strongExcept(N14);
  {
    const best = bestNextStep();
    t("next step: skill with ilesson -> ilesson first",
      best && best.action === "ilesson" && best.payload.skillId === N14 && best.payload.ilessonId === V14,
      JSON.stringify(best && { action: best.action, payload: best.payload }));
    t("next step: ilesson candidate has text, reason and cta",
      best && !!best.text && !!best.reason && !!best.cta);
    t("next step: same skill not duplicated by classic",
      nextStepCandidates().filter((c) => candidateSkillId(c) === N14).length === 1);
  }
  // Контроль: тема без интерактива — обычный урок, как раньше.
  strongExcept("n01_planimetry");
  {
    const best = bestNextStep();
    const l01 = (DataAPI.lessonsBySkill("n01_planimetry")[0] || {}).id;
    t("next step: skill without ilesson -> classic lesson",
      best && best.action === "lesson" && best.payload.lessonId === l01,
      JSON.stringify(best && { action: best.action, payload: best.payload }));
  }

  /* ---------- 8. Тема с одним интерактивом: вес практики 60 ---------- */
  DataAPI.load({
    subject: "profile_math", subjectId: "profile_math",
    subjects: [{ id: "profile_math", status: "ready" }],
    categories: [{ id: "c1", name: "C" }],
    skills: [{ id: "solo", name: "Solo", cat: "c1" }],
    tasks: [], lessons: [], missions: [], bosses: [],
    interactiveLessons: [{ id: "v-solo", skill: "solo", title: "V", xp: 10, scenes: [{ text: "t" }] }],
  });
  Store.reset();
  t("ilesson-only skill has theory", skillHasTheory("solo") === true);
  t("ilesson-only skill: practice weight 60, not 100", skillPracticeDetail("solo").weight === 60);
  t("ilesson-only skill: theory 0 before", skillTheoryProgress("solo") === 0);
  t("ilesson-only skill listed in theory skills", skillTheorySkills().includes("solo"));
  Store.state.completedILessons["v-solo"] = { ts: now };
  t("ilesson-only skill: done -> 40/40", skillTheoryProgress("solo") === 40 && skillProgress("solo") === 40);
  t("ilesson-only skill: forecast mastery 40", forecastSkillMastery("solo", now) === 40);
  t("candidateSkillId reads ilesson payload",
    candidateSkillId({ payload: { skillId: "solo", ilessonId: "v-solo" } }) === "solo"
    && candidateSkillId({ payload: { ilessonId: "v-solo" } }) === "solo");

  console.log(fails === 0 ? "ALL ILESSONS THEORY OK" : `FAILURES: ${fails}`);
  process.exit(fails ? 1 : 0);
};

eval(src + `\n;(${testBody.toString()})();`);
