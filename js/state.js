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
      name: null,
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
      daily: { date: null, solved: 0, done: false, taskIds: [] },
      dailyHistory: [], // завершённые дни Daily; источник истории без отдельной статистики
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
      this.state.dailyHistory = Array.isArray(parsed.dailyHistory) ? parsed.dailyHistory : [];
      this.state.version = defaults.version;
      this.ready = true;
      ensureDailyChallenge();
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
  // Daily Challenge resets at midnight Moscow time, regardless of browser TZ.
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Moscow" }));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function yesterdayStr() {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Moscow" }));
  d.setDate(d.getDate() - 1);
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
  const skill = DataAPI.skill(skillId);
  if (!skill) return 0;
  const stats = Store.state.skillStats[skillId] || { solved: 0, correct: 0 };
  const lessons = DataAPI.lessonsBySkill(skillId);
  const lessonDone = lessons.filter((lesson) => !!Store.state.completedLessons[lesson.id]).length;
  // Progress is mastery, not XP: theory is confirmed by a completed lesson,
  // practice grows from real answers and their accuracy (capped at 10 tasks).
  const theoryWeight = lessons.length ? 30 : 0;
  const practiceWeight = 100 - theoryWeight;
  const theory = lessons.length ? (lessonDone / lessons.length) * theoryWeight : 0;
  const accuracy = stats.solved ? stats.correct / stats.solved : 0;
  const practice = Math.min(1, stats.solved / 10) * accuracy * practiceWeight;
  return Math.round(Math.min(100, theory + practice));
}

function skillProgressBreakdown(skillId) {
  const skill = DataAPI.skill(skillId);
  const stats = Store.state.skillStats[skillId] || { solved: 0, correct: 0 };
  const lessons = DataAPI.lessonsBySkill(skillId);
  const lessonDone = lessons.filter((lesson) => !!Store.state.completedLessons[lesson.id]).length;
  const theoryWeight = lessons.length ? 30 : 0;
  const practiceWeight = 100 - theoryWeight;
  const accuracy = stats.solved ? stats.correct / stats.solved : 0;
  const theory = lessons.length ? (lessonDone / lessons.length) * theoryWeight : 0;
  const practice = Math.min(1, stats.solved / 10) * accuracy * practiceWeight;
  return { total: Math.round(theory + practice), theory: Math.round(theory), practice: Math.round(practice), lessonDone, lessonTotal: lessons.length, solved: stats.solved, accuracy: Math.round(accuracy * 100) };
}

function catProgress(catId) {
  const skills = DataAPI.skills().filter((s) => s.cat === catId);
  if (!skills.length) return 0;
  return Math.round(skills.reduce((a, s) => a + skillProgress(s.id), 0) / skills.length);
}

/* weak | in-progress | completed | mastered
   Topics are intentionally all available. The order in the path is a visual
   curriculum hint, not an access gate: every catalog topic can be practiced
   independently, including topics without a lesson. */
function skillStatus(skill) {
  const p = skillProgress(skill.id);
  const solved = (Store.state.skillStats[skill.id] || {}).solved || 0;
  if (p >= 90) return "mastered";
  if (p >= 70) return "completed";
  if (p < 35 && solved > 0) return "weak";
  return "in-progress";
}

function openErrorCount(skillId) {
  return Store.state.errors.reduce((n, e) => n + (!e.resolved && e.skill === skillId ? 1 : 0), 0);
}

/* Задания в taskAttempts лежат в порядке unshift (новые первыми), поэтому
   цикл можно остановить на первой же записи старше окна. */
function recentlyPracticedSkillIds(withinMs) {
  const cutoff = Date.now() - withinMs;
  const ids = new Set();
  for (const a of Store.state.taskAttempts) {
    if (Number(a.ts || 0) < cutoff) break;
    ids.add(a.skill);
  }
  return ids;
}

/* opts.avoidRecentMs: не выбирать навык, который активно тренировали только
   что — иначе «слабый навык» может зациклиться на бессмысленном повторе
   темы, которую ученик и так только что прорешал (см. recommendations()).
   Если после исключения недавних навыков не осталось кандидатов (например,
   ученик только что прошёл смешанное испытание по всем темам), возвращаемся
   к полному списку, а не отдаём null. */
function weakestSkill(opts = {}) {
  const skills = DataAPI.skills();
  if (!skills.length) return null;
  const recent = opts.avoidRecentMs ? recentlyPracticedSkillIds(opts.avoidRecentMs) : null;
  const pool = recent ? skills.filter((s) => !recent.has(s.id)) : skills;
  const candidates = pool.length ? pool : skills;
  let worst = null;
  for (const s of candidates) {
    if (!worst) { worst = s; continue; }
    const a = skillProgress(s.id), b = skillProgress(worst.id);
    if (a < b) { worst = s; continue; }
    if (a > b) continue;
    // Равный прогресс: предпочитаем навык, по которому уже есть реальный
    // сигнал (ошибки, попытки), а не просто первый в каталоге — иначе на
    // старте (всё 0%) «слабейшим» всегда становится случайный первый навык.
    const aErr = openErrorCount(s.id), bErr = openErrorCount(worst.id);
    if (aErr !== bErr) { if (aErr > bErr) worst = s; continue; }
    const aSolved = (Store.state.skillStats[s.id] || {}).solved || 0;
    const bSolved = (Store.state.skillStats[worst.id] || {}).solved || 0;
    if (aSolved > bSolved) worst = s;
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

/* Последний незавершённый урок (по времени начала) — самое дешёвое
   следующее действие: доучить то, что уже начато, а не открывать новое. */
function mostRecentOpenLesson() {
  const sessions = Store.state.lessonSessions || {};
  let best = null;
  for (const lessonId of Object.keys(sessions)) {
    const lesson = DataAPI.lesson(lessonId);
    if (!lesson) continue; // урок мог быть удалён из каталога после обновления
    const session = sessions[lessonId];
    if (!best || Number(session.startTs || 0) > Number(best.session.startTs || 0)) best = { lessonId, session, lesson };
  }
  return best;
}

/* ============================================================
   Прогноз балла по фактическому прогрессу и истории ответов
   ============================================================ */

function forecast() {
  const skills = DataAPI.skills();
  const avg = skills.length ? skills.reduce((a, s) => a + skillProgress(s.id), 0) / skills.length : 0;
  // 27 is the approximate zero-preparation baseline; the remaining range is
  // driven by demonstrated mastery rather than XP or self-assessment.
  const mid = Math.round(27 + avg * 0.73);
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
  return String(str).trim().toLowerCase().replace(/\s+/g, "").replace(/,/g, ".").replace(/−/g, "-");
}

function numericAnswer(value) {
  const text = normalizeAnswer(value);
  if (/^[+-]?\d+(?:\.\d+)?\/[+-]?\d+(?:\.\d+)?$/.test(text)) {
    const [n, d] = text.split("/").map(Number);
    return d === 0 ? NaN : n / d;
  }
  return Number(text);
}

function checkAnswer(task, input) {
  if (!task || input == null) return false;
  const expected = String(task.answer);
  // Equation tasks with several roots require the complete set, not one
  // acceptable alternative. Decimal answers remain single scalar values.
  const isMultiRoot = task.type === "extended_answer" && expected.includes(", ");
  const expectedParts = isMultiRoot ? expected.split(/,\s+/) : [expected];
  const inputParts = expectedParts.length > 1
    ? String(input).trim().split(/\s*[,;]\s*/)
    : [String(input)];
  if (isMultiRoot && inputParts.length !== expectedParts.length) return false;

  const sameValue = (left, right) => {
    const a = normalizeAnswer(left);
    const b = normalizeAnswer(right);
    if (a === b) return true;
    const na = numericAnswer(a), nb = numericAnswer(b);
    return Number.isFinite(na) && Number.isFinite(nb) && Math.abs(na - nb) < 1e-6;
  };

  // Order is immaterial for a set of roots. Matching each expected root once
  // also prevents a repeated value from satisfying two different roots.
  if (!isMultiRoot) {
    return sameValue(expected, inputParts[0]) || expectedParts.some((part) => sameValue(part, inputParts[0]));
  }

  const unused = inputParts.slice();
  return expectedParts.every((part) => {
    const index = unused.findIndex((candidate) => sameValue(part, candidate));
    if (index < 0) return false;
    unused.splice(index, 1);
    return true;
  });
}

function dailyDateKey() { return todayStr(); }

function dateKeyForTimestamp(ts) {
  const d = new Date(Number(ts) || 0);
  if (!Number.isFinite(d.getTime())) return "";
  const msk = new Date(d.toLocaleString("en-US", { timeZone: "Europe/Moscow" }));
  return `${msk.getFullYear()}-${String(msk.getMonth() + 1).padStart(2, "0")}-${String(msk.getDate()).padStart(2, "0")}`;
}

function dailyHistory() {
  return Array.isArray(Store.state.dailyHistory) ? Store.state.dailyHistory : [];
}

function dailyTaskIdsForDate(date) {
  const item = dailyHistory().find((entry) => entry.date === date);
  return item && Array.isArray(item.taskIds) ? item.taskIds : [];
}

function dailyCandidateScore(task, historyIds, now) {
  const stats = Store.state.skillStats[task.skill] || { solved: 0, correct: 0 };
  const attempts = Store.state.taskAttempts.filter((item) => item.taskId === task.id);
  const recentAttempts = attempts.filter((item) => now - Number(item.ts || 0) < 14 * 86400000);
  const recentErrors = Store.state.errors.filter((item) => item.taskId === task.id && !item.resolved).length;
  const accuracy = stats.solved ? stats.correct / stats.solved : 0;
  const mastery = skillProgress(task.skill);
  const coldStart = !Store.state.totalSolved && !Store.state.taskAttempts.length && !Store.state.errors.length;
  let score = 0;
  score += recentErrors * 8;
  score += Math.max(0, 1 - accuracy) * 5;
  score += Math.max(0, 3 - Math.min(3, recentAttempts.length)) * 2;
  // A new user gets approachable tasks; an active user gets a modest
  // difficulty lift while weak skills and unresolved errors stay first.
  score += coldStart ? (4 - task.diff) * 2 : task.diff * 0.6;
  score += Math.max(0, 100 - mastery) * 0.04;
  if (historyIds.includes(task.id)) score -= 18;
  if (recentAttempts[0] && now - Number(recentAttempts[0].ts || 0) < 86400000) score -= 12;
  return score;
}

function selectDailyTaskIds(date) {
  const daily = DataAPI.daily();
  const target = Math.max(1, Number(daily.target) || 1);
  const pool = DataAPI.practiceTasks().filter((task) => task && task.id && task.skill);
  if (!pool.length) return [];
  const historyIds = dailyHistory().flatMap((entry) => entry.taskIds || []);
  const now = Date.now();
  const ranked = pool.map((task) => ({ task, score: dailyCandidateScore(task, historyIds, now) }))
    .sort((a, b) => b.score - a.score || a.task.id.localeCompare(b.task.id));
  const selected = ranked.filter((item) => !historyIds.includes(item.task.id)).slice(0, target).map((item) => item.task.id);
  if (selected.length < target) {
    for (const item of ranked) {
      if (selected.length >= target) break;
      if (!selected.includes(item.task.id)) selected.push(item.task.id);
    }
  }
  return selected;
}

function ensureDailyChallenge() {
  if (!Store.state) return;
  const date = dailyDateKey();
  if (Store.state.daily && Store.state.daily.date === date && (Store.state.daily.taskIds || []).length) {
    if (!Array.isArray(Store.state.daily.countedTaskIds)) {
      const selected = new Set(Store.state.daily.taskIds);
      Store.state.daily.countedTaskIds = Array.from(new Set((Store.state.taskAttempts || [])
        .filter((attempt) => attempt.correct && dateKeyForTimestamp(attempt.ts) === date && selected.has(attempt.taskId))
        .map((attempt) => attempt.taskId)));
      Store.state.daily.solved = Math.max(Number(Store.state.daily.solved) || 0, Store.state.daily.countedTaskIds.length);
    }
    return;
  }
  const existing = dailyHistory().find((entry) => entry.date === date);
  if (existing && existing.taskIds && existing.taskIds.length) {
    const current = Store.state.daily && Store.state.daily.date === date ? Store.state.daily : {};
    Store.state.daily = Object.assign({ date, solved: 0, done: false, taskIds: [] }, existing, current);
    const counted = new Set((Store.state.taskAttempts || [])
      .filter((attempt) => attempt.correct && dateKeyForTimestamp(attempt.ts) === date && dailyTaskIdsForDate(date).includes(attempt.taskId))
      .map((attempt) => attempt.taskId));
    Store.state.daily.countedTaskIds = Array.from(counted);
    Store.state.daily.solved = Math.max(Number(Store.state.daily.solved) || 0, counted.size);
    existing.solved = Store.state.daily.solved;
    existing.done = !!Store.state.daily.done;
    existing.countedTaskIds = Store.state.daily.countedTaskIds;
    Store.state.daily.done = Store.state.daily.solved >= existing.taskIds.length;
    return;
  }
  Store.state.daily = { date, solved: 0, done: false, taskIds: selectDailyTaskIds(date) };
  Store.state.dailyHistory = dailyHistory().filter((entry) => entry.date !== date);
  Store.state.dailyHistory.unshift(Store.state.daily);
  Store.state.dailyHistory = Store.state.dailyHistory.slice(0, 30);
  Store.save();
}

function dailyTaskIds() {
  ensureDailyChallenge();
  return Store.state.daily.taskIds || [];
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

  /* Daily Challenge counts only the server-backed selection for this date.
     A regular practice answer must never accidentally complete the challenge.
     It must also only count a task that was actually solved: recordAnswer is
     also called with correct=false for a skip or a shown answer, and those
     must not silently "complete" the challenge and pay out its XP. */
  ensureDailyChallenge();
  const d = DataAPI.daily();
  const selectedIds = dailyTaskIds();
  const countedIds = s.daily.countedTaskIds || [];
  if (correct && !s.daily.done && selectedIds.includes(task.id) && !countedIds.includes(task.id)) {
    s.daily.countedTaskIds = countedIds.concat(task.id);
    s.daily.solved = s.daily.countedTaskIds.length;
    if (s.daily.solved >= selectedIds.length) {
      s.daily.done = true;
      addTimeline("Ежедневная задача выполнена");
      Store.emit("dailydone", { xp: d.xp });
      addXp(d.xp, "daily");
    }
    const historyEntry = dailyHistory().find((entry) => entry.date === s.daily.date);
    if (historyEntry) Object.assign(historyEntry, s.daily);
    Store.save();
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
  // totalSolved counts every attempt (correct, wrong or skipped — see
  // recordAnswer); these two badges are literally named "solve the first/
  // 100th task" and must only fire on answers actually gotten right, the
  // same bar XP and the Daily Challenge already use.
  if (s.totalCorrect >= 1) unlockAchievement("first-solve");
  if (s.totalCorrect >= 100) unlockAchievement("hundred");
  if (s.correctSeries >= 20) unlockAchievement("series20");
  if (s.errorsResolved >= 10) unlockAchievement("comeback");
  if (s.streak >= 7) unlockAchievement("streak7");
  if (s.bossesDefeated.length >= 1) unlockAchievement("boss1");
  if (catProgress("part1") >= 80) unlockAchievement("part1_master");
}

function addTimeline(text) {
  Store.state.timeline.unshift({ ts: Date.now(), text });
  if (Store.state.timeline.length > 40) Store.state.timeline.length = 40;
}

/* ============================================================
   Рекомендации (rule-based)

   Приоритет одного «что делать дальше» построен по стоимости и полезности
   действия, а не по произвольному порядку проверок:
   1) доучить начатый урок — уже открытый контекст, дешевле всего закончить;
   2) накопленные открытые ошибки — конкретный, проверенный сигнал слабости;
   3) самый слабый навык — но не тот, что только что интенсивно тренировали
      (иначе рекомендация зацикливается на бессмысленном повторе);
   4) испытания — босс, если открыт, иначе Daily Challenge, если не закрыт.
   Каждый навык встречается в списке не больше одного раза за вызов.
   ============================================================ */

function recommendations() {
  const s = Store.state;
  const recs = [];
  const mentionedSkills = new Set();

  const openLesson = mostRecentOpenLesson();
  if (openLesson) {
    recs.push({ text: `Доучить урок «${openLesson.lesson.title}» — начат, но не завершён`, route: "#/training", icon: "bulb" });
    mentionedSkills.add(openLesson.lesson.skill);
  }

  const openErrors = s.errors.filter((e) => !e.resolved);
  if (openErrors.length >= 3) {
    recs.push({ text: `Повторить слабые места — открыто ${openErrors.length} ошибок`, route: "#/errors", icon: "rotate" });
  }

  // 45 минут — окно «только что тренировал это», после которого повтор той
  // же темы снова становится осмысленной рекомендацией, а не залипанием.
  const worst = weakestSkill({ avoidRecentMs: 45 * 60 * 1000 });
  if (worst && !mentionedSkills.has(worst.id)) {
    const untouched = !((s.skillStats[worst.id] || {}).solved);
    const mission = DataAPI.missions().find((m) => m.skill === worst.id && !s.missionsDone[m.id]);
    if (mission) {
      recs.push({ text: `Миссия «${mission.title}» — ${untouched ? "начать" : "прокачать"} тему «${worst.name}»`, route: "#/training", icon: "target" });
    } else {
      recs.push({ text: untouched ? `Начать тему «${worst.name}»` : `Тренировка по теме «${worst.name}» — самый слабый навык`, route: "#/training", icon: "target" });
    }
  }

  const readyBoss = DataAPI.bosses().find((b) => bossUnlocked(b) && !bossDefeated(b));
  if (readyBoss) {
    recs.push({ text: `Доступен ${readyBoss.title} — проверь себя`, route: "#/trials", icon: "crown" });
  } else if (!s.daily.done) {
    recs.push({ text: "Закрыть Daily Challenge до конца дня", route: "#/trials", icon: "zap" });
  }
  return recs.slice(0, 3);
}

function recommendationText() {
  const strong = strongestSkill();
  const weak = weakestSkill();
  // strongestSkill()/weakestSkill() break ties by catalog order, so with no
  // real differentiation yet (a fresh account, or several skills still tied
  // at 0%) they can both resolve to the very same skill — which would read
  // as "you're doing great at X, but X needs work". Only claim a strong vs.
  // weak split once progress actually shows one.
  if (!weak || !strong || Store.state.totalSolved < 3 || skillProgress(strong.id) <= skillProgress(weak.id)) {
    return "Пройди первую тренировку — система начнёт строить персональные рекомендации на основе твоих результатов.";
  }
  return `У тебя хорошо идёт тема «${strong.name}», но «${weak.name}» пока отстаёт. Сфокусируйся на ней — это даст максимальный прирост к прогнозу балла.`;
}

/* ============================================================
   Онбординг / диагностика
   ============================================================ */

function applyOnboarding(selfLevel, goalId, diagnosticResults, name) {
  const s = Store.state;
  /* Самооценка сохраняется как настройка профиля, но не превращается в
     искусственный прогресс. Прогресс строится только по ответам диагностики
     и последующим фактическим действиям. */
  for (const sk of DataAPI.skills()) s.skillStats[sk.id] = { progress: 0, solved: 0, correct: 0, timeSec: 0 };
  s.daily = { date: null, solved: 0, done: false, taskIds: [] };
  s.dailyHistory = [];
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
  const cleanedName = String(name || "").trim().replace(/\s+/g, " ").slice(0, 60);
  s.name = cleanedName || null;
  s.onboarded = true;
  s.xp = 0;
  recordForecastSnapshot();
  addTimeline("Пройдена диагностика, профиль навыков построен");
  Store.save();
  checkAchievements();
}
