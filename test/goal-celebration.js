/* Окно «Цель достигнута»: триггер смотрит на КЛИЕНТСКИЙ прогноз дашборда
   (forecast().mid), а не на серверный; окно — один раз на (предмет, цель).
   Грузятся настоящие js/data.js + js/state.js + js/goal-celebration.js. */
const fs = require("fs");

const dataSrc = fs.readFileSync("js/data.js", "utf8");
const stateSrc = fs.readFileSync("js/state.js", "utf8");
const gcSrc = fs.readFileSync("js/goal-celebration.js", "utf8");
const cssSrc = fs.readFileSync("css/goal-celebration.css", "utf8");
const indexHtml = fs.readFileSync("index.html", "utf8");

function serverLikePayload(subjectId, catalogFile) {
  const catalog = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
  const contracts = ["profile_math", "basic_math", "russian"].map((id) =>
    JSON.parse(fs.readFileSync(`server/subjects/${id}.json`, "utf8"))
  );
  const contract = contracts.find((item) => item.id === subjectId);
  const publicInfo = (item) => ({
    id: item.id, title: item.title, short: item.short,
    description: item.description || "", status: item.status,
    locked: !!item.locked, comingSoon: !!item.comingSoon,
    availability: item.availability || item.status,
    forecast: item.forecast, features: item.features,
    ...(item.metadata ? { metadata: item.metadata } : {}),
  });
  return {
    ...catalog, subject: subjectId,
    subjects: contracts.map(publicInfo),
    subjectInfo: publicInfo(contract),
    forecast: contract.forecast,
  };
}

/* --- минимальные браузерные заглушки (только для DOM окна) --- */
function makeEl(id) {
  return {
    _id: id, textContent: "", _html: "",
    classList: { add() {}, remove() {} },
    style: { setProperty() {} },
    setAttribute() {}, disabled: false,
    hidden: id === "gc-ov" || id === "gc-s2",
    focus() {}, onclick: null, offsetWidth: 0, offsetHeight: 0,
    scrollTop: 0, scrollTo() {}, addEventListener() {},
    querySelectorAll() { return []; }, getAnimations: undefined,
    className: "", childNodes: [],
  };
}
const elRegistry = new Map();
const lsMap = new Map();
function installStubs() {
  Object.defineProperty(globalThis, "document", {
    value: {
      hidden: false, readyState: "complete", activeElement: null,
      documentElement: { style: {}, dataset: {}, classList: { add() {}, remove() {} } },
      body: { appendChild() {}, insertAdjacentHTML() {} },
      createElement: () => makeEl("dyn"),
      createDocumentFragment: () => ({ append() {} }),
      getElementById: (id) => {
        if (!elRegistry.has(id)) elRegistry.set(id, makeEl(id));
        return elRegistry.get(id);
      },
      addEventListener() {},
    }, configurable: true,
  });
  Object.defineProperty(globalThis, "matchMedia", {
    value: () => ({ matches: true }), configurable: true,
  });
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
      setItem: (k, v) => { lsMap.set(k, String(v)); },
    }, configurable: true,
  });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    value: () => 0, configurable: true,
  });
  const realInterval = globalThis.setInterval;
  Object.defineProperty(globalThis, "setInterval", {
    value: () => 0, configurable: true,
  });
  return () => { Object.defineProperty(globalThis, "setInterval", { value: realInterval, configurable: true }); };
}
const el = (id) => elRegistry.get(id);

const testBody = async () => {
  let fails = 0;
  const t = (name, cond, extra) => {
    console.log((cond ? "ok   " : "FAIL ") + name + (cond || !extra ? "" : " | " + extra));
    if (!cond) fails++;
  };

  /* 0. Интеграция: CSS/JS подключены, неймспейс не течёт в сайт. */
  t("index.html подключает css после dlg.css",
    indexHtml.indexOf("css/goal-celebration.css") > indexHtml.indexOf("css/dlg.css"));
  t("index.html подключает js после state.js",
    indexHtml.indexOf("js/goal-celebration.js") > indexHtml.indexOf("js/state.js"));
  t("css: нет глобальных селекторов (всё под gc-)", (cssSrc.match(/(^|\n)\.(?!gc-)[a-z]/g) || []).length === 0);
  t("css: свои keyframes с префиксом", /@keyframes gc-pop/.test(cssSrc) && !/@keyframes (pop|pulse|fade)[ {]/.test(cssSrc));
  t("css: z-index выше всех окон сайта (300)", /z-index:300/.test(cssSrc));

  DataAPI.load(serverLikePayload("profile_math", "server/catalog.json"));
  Store.ready = false;
  const now = Date.now(), HOUR = 3600 * 1000, DAY = 24 * HOUR;

  function strongSetup() {
    Store.reset();
    for (const sk of DataAPI.skills()) {
      const l = (DataAPI.lessonsBySkill(sk.id)[0]) || null;
      if (l) Store.state.completedLessons[l.id] = { ts: now - 3 * DAY };
      Store.state.skillStats[sk.id] = { progress: 0, solved: 14, correct: 13, timeSec: 400 };
      for (let i = 0; i < 14; i++) {
        Store.state.taskAttempts.push({ taskId: `gc_${sk.id}_${i}`, skill: sk.id, correct: i !== 5, hintLevel: 0, seconds: 30, closesTaskId: null, ts: now - i * HOUR });
      }
    }
    Store.state.goal = "g60";
    Store.state.streak = 14;
    Store.state.totalTimeSec = 7200;
    Store.state.activity = {
      "2026-09-01": { solved: 3, correct: 2, xp: 10 },
      "2026-09-02": { solved: 0, correct: 0, xp: 0 },
      "2026-09-03": { solved: 5, correct: 4, xp: 20 },
    };
    Store.state.achievements = {
      "streak7": { ts: now - 2 * DAY },
      "no-such": { ts: now - DAY },
      "hundred": { ts: now - 3 * DAY },
    };
    Store.state.forecastHistory = [
      { date: "2026-09-01", low: 30, high: 42, mid: 36 },
      { date: "2026-09-10", low: 44, high: 54, mid: 49 },
      { date: "2026-09-20", low: 55, high: 65, mid: 60 },
    ];
  }

  /* 1. Сильный ученик с целью g60: окно открывается, данные честные. */
  strongSetup();
  const live = forecast();
  t("прекондиция: сильный mid ≥ 60", live.mid >= 60, JSON.stringify(live));
  t("цель g60 парсится в 60", globalThis.__goalCelebration.goalNum() === 60);
  t("окно открылось при достижении", globalThis.maybeCelebrateGoal() === true);
  await new Promise((r) => setTimeout(r, 600));
  t("заголовок называет цель 60", (el("gc-h1").innerHTML || "").includes("60"),
    el("gc-h1").innerHTML);
  const key = globalThis.__goalCelebration.flagKey("profile_math", "g60");
  t("флаг «уже поздравили» выставлен", lsMap.get(key) === "1");
  t("повторный тик молчит (флаг)", globalThis.maybeCelebrateGoal() === false);
  el("gc-cls1").onclick();
  t("закрытие кнопкой не падает, окно скрыто", el("gc-ov").hidden === true);

  const c = globalThis.collectGoalCelebrationData();
  t("history маппится из forecastHistory целиком", c && c.data.history.length === 3
    && c.data.history[0].t === "2026-09-01" && c.data.history[0].score === 36);
  t("уроки: done>0, total из каталога", c.data.topicsDone > 0 && c.data.topicsTotal === DataAPI.lessons().length,
    `${c.data.topicsDone}/${c.data.topicsTotal}`);
  t("avg: 120 мин / уроки", c.data.avg.unit === "мин" && c.data.avg.label === "в среднем на урок"
    && c.data.avg.value === Math.max(1, Math.round(120 / c.data.topicsDone)), JSON.stringify(c.data.avg));
  t("streak из стора", c.data.streak === 14);
  t("activity: только дни с занятиями", Array.isArray(c.data.activity) && c.data.activity.length === 2
    && c.data.activity.every((a) => a.value > 0), JSON.stringify(c.data.activity));
  t("достижения: реальные имена по порядку, чужие id отброшены",
    JSON.stringify(c.data.achievements) === JSON.stringify(["Первая сотня", "Неделя в строю"]),
    JSON.stringify(c.data.achievements));

  /* 2. Ниже цели — тишина. */
  Store.reset();
  Store.state.goal = "g60";
  t("новичок: тик молчит ниже цели", globalThis.maybeCelebrateGoal() === false);

  /* 3. Нет цели — тишина. */
  strongSetup();
  Store.state.goal = null;
  t("без цели: collect null, тик молчит",
    globalThis.collectGoalCelebrationData() === null && globalThis.maybeCelebrateGoal() === false);

  /* 4. Пустая история — fallback на текущую точку, окно всё равно честное. */
  strongSetup();
  Store.state.forecastHistory = [];
  lsMap.clear();
  const c0 = globalThis.collectGoalCelebrationData();
  t("пустая история: одна текущая точка", c0 && c0.data.history.length === 1
    && c0.data.history[0].score === c0.current);

  /* 5. Валидация ручного вызова. */
  t("пустой вызов отклоняется", globalThis.openGoalCelebration(null) === false);
  t("без истории отклоняется",
    globalThis.openGoalCelebration({ goal: 60, history: [], topicsDone: 1, avg: { value: 1 } }) === false);

  /* 6. Гарантия доставки: пик истории брал цель, текущий просел — окно всё равно выходит. */
  Store.reset();
  Store.state.goal = "g60";
  Store.state.forecastHistory = [
    { date: "2026-09-01", low: 30, high: 42, mid: 36 },
    { date: "2026-09-20", low: 58, high: 68, mid: 63 },
  ];
  lsMap.clear();
  const cp = globalThis.collectGoalCelebrationData();
  t("прекондиция пика: текущий ниже цели, пик выше",
    cp && cp.current < 60 && cp.peak >= 60, cp && `${cp.current}/${cp.peak}`);
  t("просевший прогноз: окно выходит по пику", globalThis.maybeCelebrateGoal() === true);
  await new Promise((r) => setTimeout(r, 600));
  el("gc-cls1").onclick();

  console.log(fails ? `\n${fails} FAILURES` : "\nALL OK");
  process.exit(fails ? 1 : 0);
};

const restore = installStubs();
eval(dataSrc + "\n" + stateSrc + "\n" + gcSrc + `\n;(${testBody.toString()})();`);
restore();
