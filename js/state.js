/* ============================================================
   EGE CORE — state & game logic
   Вся мутация прогресса идёт через этот модуль; UI только
   читает вычисляемые геттеры и подписывается на события.
   ============================================================ */

const Store = {
  state: null,
  listeners: {},
  pendingSave: Promise.resolve(),
  loadPromise: null,
  ready: false,
  persistenceError: null,

  /* ------- persistence ------- */

  defaultState() {
    const skills = {};
    for (const s of DataAPI.skills()) {
      skills[s.id] = { progress: 0, solved: 0, correct: 0, timeSec: 0 };
    }
    return {
      version: 4,
      onboarded: false,
      goal: null,
      selfLevel: null,
      xp: 0,
      streak: 0,
      lastActiveDate: null,
      totalSolved: 0,
      totalCorrect: 0,
      totalTimeSec: 0,
      hintsUsed: 0,
      hintLevels: { 1: 0, 2: 0, 3: 0 }, // уровень помощи: 1 подсказка, 2 разбор, 3 показ ответа
      correctSeries: 0,
      bestSeries: 0,
      errorsResolved: 0,
      bossesDefeated: [],
      missionsDone: {},
      missionProgress: {},
      achievements: {},
      errors: [], // {taskId, skill, sub, ts, resolved}
      // Открытые ошибки в шагах урока; история хранит типы уже исправленных ошибок.
      lessonStepErrors: {}, // "lessonId:stepId" -> {count, skill, ts, types}
      lessonErrorHistory: [], // {lessonId, stepId, skill, type, ts}
      lessonSessions: {}, // незавершённые data-driven уроки, чтобы шаг не терялся при выходе
      completedLessons: {}, // lessonId -> {ts}
      lessonAttempts: [], // фактические завершения уроков
      taskAttempts: [], // фактическая история ответов по заданиям
      diagnostics: [], // результаты диагностик пользователя
      forecastHistory: [], // {date, low, high, mid}; один актуальный снимок на день
      activity: {}, // "2026-09-04" -> {solved, correct, xp}
      timeline: [], // {ts, text}
      daily: { date: null, solved: 0, done: false },
      skillStats: skills,
    };
  },

  async load() {
    this.loadPromise = (async () => {
      const payload = await ApiClient.get("/api/bootstrap");
      DataAPI.load(payload.catalog);
      const defaults = this.defaultState();
      const parsed = payload.state || {};
      this.state = Object.assign(defaults, parsed);
      this.state.skillStats = Object.assign(defaults.skillStats, parsed.skillStats || {});
      this.state.hintLevels = Object.assign(defaults.hintLevels, parsed.hintLevels || {});
      this.state.completedLessons = Object.assign({}, parsed.completedLessons || {});
      this.state.lessonSessions = Object.assign({}, parsed.lessonSessions || {});
      this.state.lessonErrorHistory = Array.isArray(parsed.lessonErrorHistory) ? parsed.lessonErrorHistory : [];
      this.state.forecastHistory = Array.isArray(parsed.forecastHistory) ? parsed.forecastHistory : [];
      this.state.lessonAttempts = Array.isArray(parsed.lessonAttempts) ? parsed.lessonAttempts : [];
      this.state.taskAttempts = Array.isArray(parsed.taskAttempts) ? parsed.taskAttempts : [];
      this.state.diagnostics = Array.isArray(parsed.diagnostics) ? parsed.diagnostics : [];
      this.state.version = defaults.version;
      this.ready = true;
      return this.state;
    })();
    return this.loadPromise;
  },

  save() {
    if (!this.state || !this.ready) return Promise.resolve();
    const snapshot = JSON.parse(JSON.stringify(this.state));
    this.pendingSave = this.pendingSave
      .catch(() => {})
      .then(() => ApiClient.put("/api/state", snapshot))
      .then(() => { this.persistenceError = null; })
      .catch((error) => {
        this.persistenceError = error;
        this.emit("persistenceerror", error);
      });
    return this.pendingSave;
  },

  reset() {
    this.state = this.defaultState();
    if (!this.ready) return Promise.resolve();
    this.pendingSave = this.pendingSave
      .catch(() => {})
      .then(() => ApiClient.delete("/api/state"))
      .catch((error) => {
        this.persistenceError = error;
        this.emit("persistenceerror", error);
      });
    return this.pendingSave;
  },

  /* ------- events ------- */

  on(evt, fn) { (this.listeners[evt] = this.listeners[evt] || []).push(fn); },
  emit(evt, data) { (this.listeners[evt] || []).forEach((fn) => fn(data)); },
};

/* ============================================================
   Уровни: xp для перехода n → n+1 = 400 + 120·n
   ============================================================ */

function xpForLevel(n) { return 400 + 120 * (n - 1); }

function levelInfo() {
  let xp = Store.state.xp;
  let level = 1;
  let need = xpForLevel(level);
  while (xp >= need) {
    xp -= need;
    level++;
    need = xpForLevel(level);
  }
  return { level, current: xp, need, pct: Math.round((xp / need) * 100) };
}

function addXp(amount, reason) {
  const before = levelInfo().level;
  Store.state.xp += amount;
  const after = levelInfo().level;
  todayActivity().xp += amount;
  Store.save();
  if (after > before) {
    addTimeline(`Новый уровень — Level ${after}`);
    Store.emit("levelup", { from: before, to: after });
  }
  Store.emit("xp", { amount, reason });
}

/* ============================================================
   Даты / streak / активность
   ============================================================ */

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function yesterdayStr() {
  const d = new Date(Date.now() - 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function todayActivity() {
  const key = todayStr();
  if (!Store.state.activity[key]) Store.state.activity[key] = { solved: 0, correct: 0, xp: 0 };
  return Store.state.activity[key];
}

function touchStreak() {
  const s = Store.state;
  const today = todayStr();
  if (s.lastActiveDate === today) return;
  s.streak = s.lastActiveDate === yesterdayStr() ? s.streak + 1 : 1;
  s.lastActiveDate = today;
  if (s.streak > 1) addTimeline(`Серия: ${s.streak} дн. подряд`);
}

/* ============================================================
   Навыки
   ============================================================ */

function skillProgress(skillId) {
  return Store.state.skillStats[skillId] ? Store.state.skillStats[skillId].progress : 0;
}

function catProgress(catId) {
  const skills = DataAPI.skills().filter((s) => s.cat === catId);
  if (!skills.length) return 0;
  return Math.round(skills.reduce((a, s) => a + skillProgress(s.id), 0) / skills.length);
}

/* locked | weak | in-progress | completed | mastered */
function skillStatus(skill) {
  if (skill.order > 0) {
    const prev = DataAPI.skills().find((s) => s.cat === skill.cat && s.order === skill.order - 1);
    if (prev && skillProgress(prev.id) < 35 && skillProgress(skill.id) === 0) return "locked";
  }
  const p = skillProgress(skill.id);
  const solved = Store.state.skillStats[skill.id].solved;
  if (p >= 90) return "mastered";
  if (p >= 70) return "completed";
  if (p < 35 && solved > 0) return "weak";
  if (p < 35 && solved === 0 && skill.order > 0) return "locked";
  return "in-progress";
}

function weakestSkill() {
  let worst = null;
  for (const s of DataAPI.skills()) {
    if (skillStatus(s) === "locked") continue;
    const p = skillProgress(s.id);
    if (!worst || p < skillProgress(worst.id)) worst = s;
  }
  return worst;
}

function strongestSkill() {
  let best = null;
  for (const s of DataAPI.skills()) {
    const p = skillProgress(s.id);
    if (!best || p > skillProgress(best.id)) best = s;
  }
  return best;
}

/* ============================================================
   Прогноз балла по фактическому прогрессу и истории ответов
   ============================================================ */

function forecast() {
  const skills = DataAPI.skills();
  const avg = skills.reduce((a, s) => a + skillProgress(s.id), 0) / skills.length;
  const acc = Store.state.totalSolved ? Store.state.totalCorrect / Store.state.totalSolved : 0.5;
  const mid = Math.round(30 + avg * 0.45 + acc * 15);
  return { low: Math.max(0, mid - 3), high: Math.min(100, mid + 4), mid };
}

/* Снимок обновляется в течение текущего дня, а дни прошлого остаются
   фактической историей. Никакой синтетической линии на графике нет. */
function recordForecastSnapshot() {
  const date = todayStr();
  const value = { date, ...forecast() };
  const history = Array.isArray(Store.state.forecastHistory) ? Store.state.forecastHistory : [];
  const i = history.findIndex((x) => x.date === date);
  if (i >= 0) history[i] = value;
  else history.push(value);
  Store.state.forecastHistory = history
    .filter((x) => x && /^\d{4}-\d{2}-\d{2}$/.test(x.date) && Number.isFinite(x.mid))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-90);
  return value;
}

function forecastHistory(days = 14) {
  const from = new Date(Date.now() - (days - 1) * 86400000);
  const cutoff = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, "0")}-${String(from.getDate()).padStart(2, "0")}`;
  return (Store.state.forecastHistory || []).filter((x) => x.date >= cutoff).sort((a, b) => a.date.localeCompare(b.date));
}

function forecastTrend(days = 14) {
  const history = forecastHistory(days);
  const current = forecast();
  const firstPast = history.find((x) => x.date !== todayStr());
  if (!firstPast) return null;
  return { delta: current.mid - firstPast.mid, fromDate: firstPast.date };
}

/* ============================================================
   Проверка ответов
   ============================================================ */

function normalizeAnswer(str) {
  return String(str).trim().toLowerCase().replace(/\s+/g, "").replace(",", ".").replace("−", "-");
}

function checkAnswer(task, input) {
  const a = normalizeAnswer(input);
  const b = normalizeAnswer(task.answer);
  if (a === b) return true;
  const na = parseFloat(a), nb = parseFloat(b);
  if (!isNaN(na) && !isNaN(nb)) return Math.abs(na - nb) < 1e-6;
  return false;
}

/* ============================================================
   Запись результата ответа — центральная точка игровой логики
   hintLevel: 0 — без помощи, 1 — подсказка, 2 — разбор,
   3 — ответ показан (задание считается нерешённым)
   ============================================================ */

function recordAnswer(task, correct, hintLevel, seconds, closesTaskId) {
  const s = Store.state;
  hintLevel = Number(hintLevel) || 0;
  if (hintLevel >= 3) correct = false; // посмотрел ответ = не решил сам
  touchStreak();

  s.taskAttempts.unshift({
    taskId: task.id,
    skill: task.skill,
    correct: !!correct,
    hintLevel,
    seconds: Number(seconds) || 0,
    closesTaskId: closesTaskId || null,
    ts: Date.now(),
  });
  s.taskAttempts = s.taskAttempts.slice(0, 5000);

  s.totalSolved++;
  s.totalTimeSec += seconds || 0;
  if (hintLevel > 0) {
    s.hintsUsed++;
    for (let l = 1; l <= Math.min(3, hintLevel); l++) s.hintLevels[l]++;
  }

  const st = s.skillStats[task.skill];
  st.solved++;
  st.timeSec += seconds || 0;

  const act = todayActivity();
  act.solved++;

  let xp = 0;
  if (correct) {
    s.totalCorrect++;
    st.correct++;
    act.correct++;
    s.correctSeries++;
    s.bestSeries = Math.max(s.bestSeries, s.correctSeries);
    xp = hintLevel >= 2 ? 5 + task.diff * 2 : (hintLevel === 1 ? 8 : 12) + task.diff * 6;
    st.progress = Math.min(100, st.progress + (st.progress < 60 ? 5 : 3));

    /* закрытие ошибки: по этому заданию или по исходному заданию,
       которое оно заменяет в повторении (умное повторение) */
    /* В умном повторении приоритет у исходной ошибки. Это важно, когда
       похожее задание само тоже было в списке ошибок: один ответ должен
       закрыть именно тот пункт, для которого он был подобран. */
    const err = (closesTaskId ? s.errors.find((e) => e.taskId === closesTaskId && !e.resolved) : null)
      || s.errors.find((e) => e.taskId === task.id && !e.resolved);
    if (err) {
      err.resolved = true;
      s.errorsResolved++;
      xp += 15;
      addTimeline(`Закрыта ошибка: ${task.sub}`);
    }
  } else {
    s.correctSeries = 0;
    // Неверный ответ остаётся сигналом для повторения, но не отнимает уже
    // заработанный прогресс: ошибка — нормальная часть обучения.
    if (!s.errors.some((e) => e.taskId === task.id && !e.resolved)) {
      s.errors.unshift({ taskId: task.id, skill: task.skill, sub: task.sub, ts: Date.now(), resolved: false });
    }
  }

  /* daily challenge */
  const d = DataAPI.daily();
  if (s.daily.date !== todayStr()) s.daily = { date: todayStr(), solved: 0, done: s.daily.done && s.daily.date === todayStr() };
  if (task.skill === d.skill && !s.daily.done) {
    s.daily.solved++;
    if (s.daily.solved >= d.target) {
      s.daily.done = true;
      addTimeline("Daily Challenge выполнен");
      Store.emit("dailydone", { xp: d.xp });
      addXp(d.xp, "daily");
    }
  }

  if (xp > 0) addXp(xp, "answer");

  if (s.totalSolved === 1) addTimeline("Первое задание решено");
  recordForecastSnapshot();
  Store.save();
  checkAchievements();
  Store.emit("answer", { task, correct, xp });
  return xp;
}

/* ============================================================
   Ошибки шагов уроков → профиль навыков
   ============================================================ */

function recordLessonStepError(lessonId, stepId, skillId, errorType = "Неуточнённая ошибка") {
  const s = Store.state;
  const key = `${lessonId}:${stepId}`;
  const cur = s.lessonStepErrors[key] || { count: 0, skill: skillId, ts: 0, types: {} };
  cur.count++;
  cur.ts = Date.now();
  cur.types = cur.types || {};
  cur.types[errorType] = (cur.types[errorType] || 0) + 1;
  s.lessonStepErrors[key] = cur;
  // Это история существующего механизма ошибок, а не отдельная система оценки.
  s.lessonErrorHistory.unshift({ lessonId, stepId, skill: skillId, type: errorType, ts: cur.ts });
  s.lessonErrorHistory = s.lessonErrorHistory.slice(0, 200);
  // Ошибка нужна для персонального повторения, а не как штраф к прогрессу.
  recordForecastSnapshot();
  Store.save();
}

function clearLessonStepError(lessonId, stepId) {
  delete Store.state.lessonStepErrors[`${lessonId}:${stepId}`];
  Store.save();
}

function lessonStepErrorsBySkill(skillId) {
  return Object.entries(Store.state.lessonStepErrors)
    .filter(([, v]) => v.skill === skillId)
    .map(([key, v]) => ({ key, ...v }));
}

function completeLesson(lesson, inputXp, result = {}) {
  const s = Store.state;
  const firstCompletion = !s.completedLessons[lesson.id];
  touchStreak();

  if (!firstCompletion) {
    s.lessonAttempts.unshift({
      lessonId: lesson.id,
      completed: true,
      firstCompletion: false,
      xp: 0,
      wrongAttempts: Number(result.wrongAttempts) || 0,
      durationSec: Number(result.durationSec) || 0,
      ts: Date.now(),
    });
    s.lessonAttempts = s.lessonAttempts.slice(0, 1000);
    addTimeline(`Урок повторён: «${lesson.title}»`);
    Store.save();
    return { firstCompletion, totalXp: 0 };
  }

  const totalXp = lesson.xp + inputXp;
  s.completedLessons[lesson.id] = { ts: Date.now() };
  s.lessonAttempts.unshift({
    lessonId: lesson.id,
    completed: true,
    firstCompletion: true,
    xp: totalXp,
    wrongAttempts: Number(result.wrongAttempts) || 0,
    durationSec: Number(result.durationSec) || 0,
    ts: Date.now(),
  });
  s.lessonAttempts = s.lessonAttempts.slice(0, 1000);
  addXp(totalXp, "lesson");
  const st = s.skillStats[lesson.skill];
  st.progress = Math.min(100, st.progress + 8);
  recordForecastSnapshot();
  addTimeline(`Урок пройден: «${lesson.title}»`);
  Store.save();
  checkAchievements();
  return { firstCompletion, totalXp };
}

/* ============================================================
   Миссии / боссы
   ============================================================ */

function missionProgress(mission) {
  return Store.state.missionProgress[mission.id] || 0;
}

function completeMission(mission) {
  if (Store.state.missionsDone[mission.id]) return;
  Store.state.missionsDone[mission.id] = { ts: Date.now() };
  addTimeline(`Миссия завершена: «${mission.title}»`);
  addXp(mission.xp, "mission");
  Store.emit("missiondone", mission);
}

function bossUnlocked(boss) {
  return catProgress(boss.cat) >= boss.unlockAt;
}

function bossDefeated(boss) {
  return Store.state.bossesDefeated.includes(boss.id);
}

function defeatBoss(boss) {
  if (!bossDefeated(boss)) {
    Store.state.bossesDefeated.push(boss.id);
    addTimeline(`Босс повержен: ${boss.title}`);
    addXp(boss.xp, "boss");
    /* рывок навыков ветки */
    for (const s of DataAPI.skills().filter((x) => x.cat === boss.cat)) {
      const st = Store.state.skillStats[s.id];
      st.progress = Math.min(100, st.progress + 6);
    }
    recordForecastSnapshot();
    Store.save();
    checkAchievements();
  }
}

/* ============================================================
   Достижения
   ============================================================ */

function achievementUnlocked(id) {
  return !!Store.state.achievements[id];
}

function unlockAchievement(id) {
  if (achievementUnlocked(id)) return;
  Store.state.achievements[id] = { ts: Date.now() };
  const a = DataAPI.achievements().find((x) => x.id === id);
  addTimeline(`Достижение: «${a.name}»`);
  Store.save();
  Store.emit("achievement", a);
}

function checkAchievements() {
  const s = Store.state;
  if (s.totalSolved >= 1) unlockAchievement("first-solve");
  if (s.totalSolved >= 100) unlockAchievement("hundred");
  if (s.correctSeries >= 20) unlockAchievement("series20");
  if (s.errorsResolved >= 10) unlockAchievement("comeback");
  if (s.streak >= 7) unlockAchievement("streak7");
  if (s.bossesDefeated.length >= 1) unlockAchievement("boss1");
  if (catProgress("geometry") >= 80) unlockAchievement("geometry80");
}

function addTimeline(text) {
  Store.state.timeline.unshift({ ts: Date.now(), text });
  if (Store.state.timeline.length > 40) Store.state.timeline.length = 40;
}

/* ============================================================
   Рекомендации (rule-based)
   ============================================================ */

function recommendations() {
  const recs = [];
  const worst = weakestSkill();
  const openErrors = Store.state.errors.filter((e) => !e.resolved);

  if (openErrors.length >= 3) {
    recs.push({ text: `Повторить слабые места — открыто ${openErrors.length} ошибок`, route: "#/errors", icon: "rotate" });
  }
  if (worst) {
    const mission = DataAPI.missions().find((m) => m.skill === worst.id && !Store.state.missionsDone[m.id]);
    if (mission) {
      recs.push({ text: `Миссия «${mission.title}» — прокачать тему «${worst.name}»`, route: "#/training", icon: "target" });
    } else {
      recs.push({ text: `Тренировка по теме «${worst.name}» — самый слабый навык`, route: "#/training", icon: "target" });
    }
  }
  const readyBoss = DataAPI.bosses().find((b) => bossUnlocked(b) && !bossDefeated(b));
  if (readyBoss) {
    recs.push({ text: `Доступен ${readyBoss.title} — проверь себя`, route: "#/trials", icon: "crown" });
  } else if (!Store.state.daily.done) {
    recs.push({ text: "Закрыть Daily Challenge до конца дня", route: "#/trials", icon: "zap" });
  }
  return recs.slice(0, 3);
}

function recommendationText() {
  const strong = strongestSkill();
  const weak = weakestSkill();
  if (!weak || Store.state.totalSolved < 3) {
    return "Пройди первую тренировку — система начнёт строить персональные рекомендации на основе твоих результатов.";
  }
  return `У тебя хорошо идёт тема «${strong.name}», но «${weak.name}» пока отстаёт. Сфокусируйся на ней — это даст максимальный прирост к прогнозу балла.`;
}

/* ============================================================
   Онбординг / диагностика
   ============================================================ */

function applyOnboarding(selfLevel, goalId, diagnosticResults) {
  const s = Store.state;
  /* Самооценка сохраняется как настройка профиля, но не превращается в
     искусственный прогресс. Прогресс строится только по ответам диагностики
     и последующим фактическим действиям. */
  for (const sk of DataAPI.skills()) s.skillStats[sk.id] = { progress: 0, solved: 0, correct: 0, timeSec: 0 };
  for (const r of diagnosticResults) {
    const task = DataAPI.task(r.taskId);
    if (!task) continue;
    const st = s.skillStats[task.skill];
    const diagnosticTs = Date.now();
    st.progress = Math.max(0, Math.min(100, r.correct ? st.progress + 22 : Math.max(5, st.progress - 10)));
    st.solved++;
    if (r.correct) st.correct++;
    s.totalSolved++;
    if (r.correct) s.totalCorrect++;
    s.taskAttempts.unshift({ taskId: task.id, skill: task.skill, correct: !!r.correct, hintLevel: 0, seconds: 0, closesTaskId: null, ts: diagnosticTs });
    s.diagnostics.unshift({ taskId: task.id, correct: !!r.correct, ts: diagnosticTs });
    const activity = todayActivity();
    activity.solved++;
    if (r.correct) activity.correct++;
  }
  s.taskAttempts = s.taskAttempts.slice(0, 5000);
  s.selfLevel = selfLevel;
  s.goal = goalId;
  s.onboarded = true;
  s.xp = 0;
  recordForecastSnapshot();
  addTimeline("Пройдена диагностика, профиль навыков построен");
  Store.save();
  checkAchievements();
}
