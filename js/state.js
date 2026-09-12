/* ============================================================
   EGE CORE — state & game logic
   Вся мутация прогресса идёт через этот модуль; UI только
   читает вычисляемые геттеры и подписывается на события.
   ============================================================ */

const Store = {
  state: null,
  // Server-generated public Account ID (see server.py assign_account_id).
  // Deliberately kept outside `state`: state is the exact snapshot that
  // round-trips through PUT /api/state, and the id must never be something
  // the client can send back and have written.
  accountId: null,
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
      xpAdjustments: [], // ручные начисления опыта {amount, reason, ts}; сервер хранит их отдельным журналом и всегда добавляет к деривированному XP
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
      this.accountId = payload.accountId || null;
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
    this.accountId = null;
    if (!this.ready) return Promise.resolve();
    this.pendingSave = this.pendingSave
      .catch(() => {})
      .then(() => ApiClient.delete("/api/state"))
      // The DELETE removes the whole account row server-side; re-bootstrap so
      // the next request issues a fresh session with its own new Account ID,
      // instead of leaving the UI holding a stale, now-deleted one.
      .then(() => this.load())
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

/* Журнал XP-корректировок ведёт только сервер (admin grant). Раньше клиент
   мог добавить сюда запись, и сервер доверял ей при пересчёте XP — это был
   прямой обход защиты от накрутки. Теперь сервер игнорирует payload-записи,
   поэтому клиентская функция самоназначения XP удалена. */

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

/* Склонение числительных: plural(n, "день", "дня", "дней").
   Живёт здесь, а не в app.js: чистая логика, нужна и движку рекомендаций. */
function plural(n, one, few, many) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
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

  // Задание уже решалось верно раньше: за XP «решение задания» больше не
  // платим (иначе один и тот же ответ можно сдавать повторно бесконечно),
  // но если это закрывает открытую ошибку — тот бонус отдельный (см. ниже).
  const alreadyMastered = correct && s.taskAttempts.some((a) => a.taskId === task.id && a.correct);

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
    xp = alreadyMastered ? 0 : (hintLevel >= 2 ? 5 + task.diff * 2 : (hintLevel === 1 ? 8 : 12) + task.diff * 6);
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

/* ============================================================
   Движок «лучший следующий шаг»

   Чистая функция от серверного снимка состояния: каждый вызов заново
   оценивает все доступные действия по сигналам знаний (освоение навыка,
   точность, открытые ошибки, состояние уроков, давность и плотность
   практики, готовность боссов, прогресс Daily) и возвращает ранжированный
   список кандидатов. Фиксированной последовательности нет: после каждого
   ответа состояние меняется, и лучший шаг пересчитывается заново.

   Анти-зацикливание: у каждого навыка считается «утомление» — много
   попыток за последний час при низком освоении резко снижает ценность
   дальнейшей практики по теме и переключает стратегию: сначала теория,
   затем повторение ошибок, затем смена фокуса на другой навык.

   Кандидат — плоский дескриптор {action, payload, text, reason, icon,
   route, score}; исполнение действия — задача UI (app.js), чтобы движок
   оставался чистой логикой, тестируемой без DOM.
   ============================================================ */

/* Склонение числительных: plural(5, "день", "дня", "дней"). Живёт здесь,
   а не в app.js, потому что движок следующего шага использует его при
   построении текстов и должен оставаться тестируемым без DOM. */
function plural(n, one, few, many) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

const NEXTSTEP_FATIGUE_WINDOW_MS = 60 * 60 * 1000; // окно «недавняя практика»
const NEXTSTEP_FATIGUE_TASKS = 6;                  // столько попыток за час — тема перетренирована
const NEXTSTEP_RECENT_MS = 25 * 60 * 1000;         // свежая сессия по теме

/* Сигналы по одному навыку: прогресс, точность, ошибки, уроки, давность
   и плотность практики. Всё считается из фактической истории ответов. */
function skillSnapshot(skillId) {
  const s = Store.state;
  const stats = s.skillStats[skillId] || { solved: 0, correct: 0, timeSec: 0 };
  const now = Date.now();
  const cutoff = now - NEXTSTEP_FATIGUE_WINDOW_MS;
  let recent = 0, recentCorrect = 0, lastTs = 0;
  for (const a of s.taskAttempts) {
    if (a.skill !== skillId) continue;
    const ts = Number(a.ts) || 0;
    if (ts > lastTs) lastTs = ts;
    if (ts >= cutoff) { recent++; if (a.correct) recentCorrect++; }
  }
  const lessons = DataAPI.lessonsBySkill(skillId);
  const lesson = lessons[0] || null;
  const lessonDone = lessons.length > 0 && lessons.every((l) => !!s.completedLessons[l.id]);
  const solved = stats.solved || 0;
  const diagnosticMisses = (s.diagnostics || []).filter((d) => {
    const task = DataAPI.task(d.taskId);
    return task && task.skill === skillId && !d.correct;
  }).length;
  return {
    progress: skillProgress(skillId),
    solved,
    accuracy: solved ? stats.correct / solved : null,
    recent,
    recentAccuracy: recent ? recentCorrect / recent : null,
    fatigued: recent >= NEXTSTEP_FATIGUE_TASKS,
    ageMs: lastTs ? now - lastTs : Infinity,
    openErrors: openErrorCount(skillId),
    stepErrors: lessonStepErrorsBySkill(skillId).length,
    lesson,
    lessonDone,
    lessonOpen: lessons.some((l) => s.lessonSessions && s.lessonSessions[l.id]),
    diagnosticMisses,
    mission: DataAPI.missions().find((m) => m.skill === skillId && Array.isArray(m.tasks) && m.tasks.length) || null,
  };
}

/* Самый слабый навык из pool: ниже прогресс, при равенстве — больше
   открытых ошибок, больше промахов диагностики, больше решено. */
function weakestOf(pool) {
  let worst = null;
  for (const sk of pool) {
    if (!worst) { worst = sk; continue; }
    const a = skillSnapshot(sk.id), b = skillSnapshot(worst.id);
    if (a.progress !== b.progress) { if (a.progress < b.progress) worst = sk; continue; }
    if (a.openErrors !== b.openErrors) { if (a.openErrors > b.openErrors) worst = sk; continue; }
    if (a.diagnosticMisses !== b.diagnosticMisses) { if (a.diagnosticMisses > b.diagnosticMisses) worst = sk; continue; }
    if (a.solved !== b.solved) { if (a.solved > b.solved) worst = sk; }
  }
  return worst;
}

function nextStepCandidates() {
  const s = Store.state;
  const cands = [];
  const mentioned = new Set(); // навык уже представлен кандидатом — не дублируем
  const push = (cand) => cands.push(cand);

  /* 1. Доучить начатый урок: уже открытый контекст, самое дешёвое
     завершение. Всегда первый приоритет, пока урок не закрыт. */
  const openLesson = mostRecentOpenLesson();
  if (openLesson) {
    mentioned.add(openLesson.lesson.skill);
    push({
      action: "finish-lesson",
      payload: { lessonId: openLesson.lessonId },
      route: "#/training", icon: "bulb",
      text: `Продолжить урок «${openLesson.lesson.title}»`,
      reason: `Урок уже начат и сохранён на шаге ${Math.min((openLesson.session.idx || 0) + 1, openLesson.lesson.steps.length)} из ${openLesson.lesson.steps.length} — закончить начатое дешевле всего.`,
      score: 92,
    });
  }

  /* Снимки по всем навыкам — основа остальных кандидатов. */
  const snaps = {};
  for (const sk of DataAPI.skills()) snaps[sk.id] = skillSnapshot(sk.id);
  const mentionedSkills = () => Object.keys(snaps).filter((id) => mentioned.has(id));

  /* 2. Повторение слабых мест: накопленные открытые ошибки — самый
     конкретный сигнал пробела. Свежие ошибки «на горячую» не гоняем по
     кругу: если их навык только что интенсивно тренировался и всё равно
     проседает, полезнее вернуться к теории (кандидат ниже). */
  const openErrors = s.errors.filter((e) => !e.resolved);
  if (openErrors.length) {
    const now = Date.now();
    const freshErrors = openErrors.filter((e) => now - Number(e.ts || 0) < 10 * 60 * 1000);
    const topErrorSkill = openErrors.reduce((best, e) => {
      const count = openErrors.filter((x) => x.skill === e.skill).length;
      return !best || count > best.count ? { skill: e.skill, count } : best;
    }, null);
    const hotLoop = topErrorSkill && snaps[topErrorSkill.skill]
      && freshErrors.length >= 2 && snaps[topErrorSkill.skill].fatigued;
    let score = 52 + Math.min(openErrors.length, 6) * 6 + (openErrors.length >= 3 ? 6 : 0);
    if (hotLoop) score -= 30;
    push({
      action: "errors-review",
      payload: {},
      route: "#/errors", icon: "rotate",
      text: `Повторить слабые места — открыто ${openErrors.length} ${plural(openErrors.length, "ошибка", "ошибки", "ошибок")}`,
      reason: openErrors.length >= 3
        ? `Накопилось несколько нерешённых ошибок — их повторение даст больше, чем новая тема.`
        : `Открытая ошибка со временем забывается — закрой её, пока контекст свежий.`,
      score,
    });
  }

  /* 3. Урок по слабому навыку: теория важнее повторной зубрёжки, когда
     точность просела, тема не тронута или уже перетренирована. Пройденный
     урок тоже предлагаем — если навык после него так и не пошёл. */
  {
    const pool = DataAPI.skills().filter((sk) => {
      const snap = snaps[sk.id];
      if (!snap.lesson || mentioned.has(sk.id)) return false;
      if (!snap.lessonDone) return true;
      return snap.progress < 45 && snap.accuracy !== null && snap.accuracy < 0.5;
    });
    const weakTheory = pool.filter((sk) => {
      const snap = snaps[sk.id];
      return (snap.solved === 0 && snap.progress < 35)
        || (snap.accuracy !== null && snap.accuracy < 0.5 && snap.progress < 60)
        || (snap.fatigued && snap.recentAccuracy !== null && snap.recentAccuracy < 0.5)
        || (snap.lessonDone && snap.progress < 45 && snap.accuracy !== null && snap.accuracy < 0.5);
      /* Доказанный пробел (открытые ошибки, низкая точность) важнее
         «чистого нуля»: тему, в которой ученик уже споткнулся, закрывать
         раньше, чем просто первую нетронутую в каталоге. */
    }).sort((a, b) => {
      const sa = snaps[a.id], sb = snaps[b.id];
      if (sa.openErrors !== sb.openErrors) return sb.openErrors - sa.openErrors;
      const aa = sa.accuracy === null ? 2 : sa.accuracy;
      const ab = sb.accuracy === null ? 2 : sb.accuracy;
      if (aa !== ab) return aa - ab;
      return sa.progress - sb.progress;
    })[0] || null;
    if (weakTheory) {
      const snap = snaps[weakTheory.id];
      mentioned.add(weakTheory.id);
      const untouched = snap.solved === 0;
      const repeatAfterFail = snap.lessonDone;
      push({
        action: "lesson",
        payload: { lessonId: snap.lesson.id },
        route: "#/training", icon: "bulb",
        text: repeatAfterFail
          ? `Повторить урок «${snap.lesson.title}» — тема «${weakTheory.name}» так и не пошла`
          : `${untouched ? "Начать" : "Вернуться к"} уроку «${snap.lesson.title}» — тема «${weakTheory.name}»`,
        reason: repeatAfterFail
          ? `Урок по «${weakTheory.name}» пройден, но точность всё ещё ниже 50% — повтори объяснение, прежде чем решать дальше.`
          : snap.fatigued
            ? `По теме «${weakTheory.name}» много попыток без результата — сейчас полезнее разобраться в теории, чем решать дальше.`
            : snap.accuracy !== null && snap.accuracy < 0.5
              ? `Точность по «${weakTheory.name}» ниже 50% — сначала урок, практика после теории закрепится лучше.`
              : `Тема «${weakTheory.name}» пока не тронута — начинать её лучше с объяснения, а не сразу с заданий.`,
        score: snap.fatigued ? 82 : (repeatAfterFail ? 74 : (untouched ? 68 : 78)),
      });
    }
  }

  /* 4. Тренировка по самому слабому навыку (миссия): растёт при низком
     освоении и незакрытой миссии, падает при свежей практике и утомлении.
     Незавершённая миссия — бонус: дешевле закончить начатое. */
  {
    const pool = DataAPI.skills().filter((sk) => {
      const snap = snaps[sk.id];
      return snap.mission && !mentioned.has(sk.id) && snap.progress < 90;
    });
    const target = weakestOf(pool);
    if (target) {
      const snap = snaps[target.id];
      mentioned.add(target.id);
      const prog = snap.mission ? missionProgress(snap.mission) : 0;
      const started = snap.mission && prog > 0 && prog < snap.mission.tasks.length;
      let score = 56 + (100 - snap.progress) * 0.3;
      if (started) score += 14;
      /* Свежая практика: если последние попытки были безрезультатными —
         решать ту же тему подряд бессмысленно (полный штраф); если
         закрепление шло хорошо — повтор сразу просто менее ценен (мягкий). */
      if (snap.ageMs < NEXTSTEP_RECENT_MS) {
        score -= (snap.recentAccuracy !== null && snap.recentAccuracy < 0.5) ? 22 : 10;
      }
      if (snap.recentAccuracy !== null && snap.recentAccuracy < 0.4 && snap.lessonDone) score -= 12;
      if (snap.fatigued) score -= 35;
      /* Закрепление свежего: урок пройден совсем недавно — короткая
         тренировка сразу после теории закрепляет её лучше всего. */
      const lessonTs = snap.lesson && s.completedLessons[snap.lesson.id] ? Number(s.completedLessons[snap.lesson.id].ts) || 0 : 0;
      const justLearned = lessonTs && Date.now() - lessonTs < 2 * 3600 * 1000;
      if (justLearned && !snap.fatigued) score += 12;
      /* Теория раньше практики: по теме с непройденным уроком, которую
         ученик ещё не трогал или которая даётся с ошибками, сначала урок —
         иначе «потренируйся» вытесняет «изучи» у новичка. */
      const lessonFirst = !!snap.lesson && !snap.lessonDone && !started
        && (snap.solved === 0 || (snap.accuracy !== null && snap.accuracy < 0.5));
      if (lessonFirst) score -= 20;
      push({
        action: "practice",
        payload: { missionId: snap.mission.id, skillId: target.id },
        route: "#/training", icon: "target",
        text: started
          ? `Продолжить тренировку по теме «${target.name}» — ${prog}/${snap.mission.tasks.length}`
          : `Потренироваться в теме «${target.name}» — самое слабое место`,
        reason: started
          ? `Тренировка по «${target.name}» уже начата — закончить её сейчас проще всего.`
          : snap.fatigued
            ? `Тема «${target.name}» сейчас перетренирована — короткая пауза вернёт эффективность.`
            : lessonFirst
              ? `«${target.name}» — слабое место, но по ней есть непройденный урок: сначала разберись в теории, практика пойдёт лучше.`
              : `«${target.name}» — самый отстающий навык (${snap.progress}%), и его давно не тренировали.`,
        score,
      });
    }
  }

  /* 5. Босс открытой ветки: проверка готовности. Кап держит босса ниже
     работы над пробелами: пока есть навык < 45%, сначала устранение
     пробела, босс — потом. */
  {
    const minProgress = Math.min(...DataAPI.skills().map((sk) => snaps[sk.id].progress));
    let bestBoss = null, bestBossScore = 0;
    for (const b of DataAPI.bosses()) {
      if (!bossUnlocked(b) || bossDefeated(b)) continue;
      const cp = catProgress(b.cat);
      let score = Math.min(65, 50 + Math.max(0, cp - b.unlockAt) * 0.8);
      if (minProgress < 45) score -= 20;
      if (score > bestBossScore) { bestBossScore = score; bestBoss = b; }
    }
    if (bestBoss) {
      push({
        action: "boss",
        payload: { bossId: bestBoss.id },
        route: "#/trials", icon: "crown",
        text: `Пройти ${bestBoss.title.replace("БОСС: ", "")}`,
        reason: `Ветка «${DataAPI.category(bestBoss.cat).name}» прокачана до ${catProgress(bestBoss.cat)}% — босс покажет, держится ли результат на смешанных заданиях.`,
        score: bestBossScore,
      });
    }
  }

  /* 6. Ежедневная подборка: стимул держать ритм, ниже работы над пробелами. */
  ensureDailyChallenge();
  if (!s.daily.done) {
    const goal = dailyTaskIds().length || 1;
    const partial = Math.min(s.daily.solved || 0, goal) > 0;
    push({
      action: "daily",
      payload: {},
      route: "#/trials", icon: "zap",
      text: partial ? `Закончить ежедневную подборку — ${Math.min(s.daily.solved, goal)}/${goal}` : "Решить ежедневную подборку",
      reason: partial
        ? `Подборка почти закрыта — один заход, и день засчитан.`
        : `Короткая подборка из ${goal} заданий поддержит ритм и серию дней.`,
      score: partial ? 52 : 40,
    });
  }

  /* 7. Новая тема по карте: когда слабых мест нет (всё ≥ 45%), следующий
     полезный шаг — расширять охват. Тема берётся по порядку следования
     в карте внутри своей ветки — это и есть учебный маршрут «мягкой»
     зависимости между навыками. */
  {
    const minProgress = Math.min(...DataAPI.skills().map((sk) => snaps[sk.id].progress));
    const catOrder = {};
    DataAPI.categories().forEach((c, i) => { catOrder[c.id] = i; });
    const nextTopic = DataAPI.skills()
      .filter((sk) => snaps[sk.id].lesson && !snaps[sk.id].lessonDone && !snaps[sk.id].lessonOpen && !mentioned.has(sk.id))
      .sort((a, b) => (catOrder[a.cat] - catOrder[b.cat]) || (a.order - b.order))[0];
    if (nextTopic && minProgress >= 45) {
      const snap = snaps[nextTopic.id];
      mentioned.add(nextTopic.id);
      push({
        action: "lesson",
        payload: { lessonId: snap.lesson.id },
        route: "#/path", icon: "path",
        text: `Открыть новую тему — урок «${snap.lesson.title}»`,
        reason: `Текущие темы в хорошем состоянии — следующий рост даст новый навык по карте.`,
        score: 56,
      });
    }
  }

  /* 8. Смешанное испытание — запасной вариант, когда закрывать нечего:
     поддержание общей формы вместо бессмысленного повтора. */
  if (DataAPI.practiceTasks().length >= 5) {
    push({
      action: "mixed",
      payload: {},
      route: "#/trials", icon: "trials",
      text: "Пройти смешанное испытание",
      reason: `Слабых мест нет — проверка общей формы на заданиях из разных тем не даст застояться.`,
      score: 30,
    });
  }

  const priority = { "finish-lesson": 0, "lesson": 1, "errors-review": 2, "practice": 3, "boss": 4, "daily": 5, "mixed": 6 };
  return cands.sort((a, b) => b.score - a.score || priority[a.action] - priority[b.action]);
}

/* Лучший текущий шаг — голова ранжированного списка. Пересчитывается
   после каждого изменения состояния, поэтому следующий шаг никогда не
   зашит заранее: алгоритм заново оценивает ситуацию. */
function bestNextStep() {
  const cands = nextStepCandidates();
  return cands.length ? cands[0] : null;
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
