/* ============================================================
   ege easy — state & game logic
   Вся мутация прогресса идёт через этот модуль; UI только
   читает вычисляемые геттеры и подписывается на события.
   ============================================================ */

/* Системная идемпотентность: каждая мутабельная сущность несёт стабильный
   client-generated ID (UUID). ID генерируется ОДИН раз в момент создания
   сущности и переиспользуется при ретраях/даблкликах — никогда не
   генерируется заново на каждое сохранение. Одинаковый ID = обновление той
   же записи на сервере (upsert по (user_id, subject, client_id)), а не новая
   строка. Мутабельные словари (skillStats, lessonSessions, ...) стабильно
   keyed естественными ID каталога (skill/lesson/mission/...); append-истории
   (taskAttempts, errors, timeline, ...) — этим UUID. */
function newEntityId() {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch (_) {}
  return `e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 6)}`;
}

/* Стабильный ключ дедупликации: строковый client ID в приоритете, иначе —
   полное содержимое (legacy-записи без ID, серверный fallback). */
function entityKey(item) {
  if (item && typeof item === "object") {
    for (const key of ["id", "clientId"]) {
      const value = item[key];
      if (typeof value === "string" && value) return `id:${value}`;
    }
    if (typeof item.id === "number" && Number.isFinite(item.id)) return `row:${item.id}`;
  }
  try { return `json:${JSON.stringify(item)}`; } catch (_) { return `json:${String(item)}`; }
}

/* Идентификатор предмета и доступность обучающихся доменов идут через
   DataAPI.  В коде_state не должно быть запасного перехода на профиль: иначе
   новый пустой предмет мог бы получить профильные skillStats или XP. */
function currentSubjectId() {
  try {
    if (typeof DataAPI !== "undefined" && DataAPI.currentSubject) {
      return String(DataAPI.currentSubject() || Store.subject || "profile_math");
    }
  } catch (_) {}
  return String(Store.subject || "profile_math");
}

function subjectLearningAvailable() {
  try {
    if (typeof DataAPI === "undefined") return false;
    if (DataAPI.hasLearningContent) return !!DataAPI.hasLearningContent();
    return !DataAPI.isSubjectEmpty();
  } catch (_) { return false; }
}

function subjectIsAvailable() {
  try {
    if (typeof DataAPI === "undefined") return false;
    return typeof DataAPI.isSubjectAvailable === "function"
      ? !!DataAPI.isSubjectAvailable()
      : !DataAPI.isSubjectEmpty();
  } catch (_) { return false; }
}

function skillIsAccessible(skillOrId) {
  try {
    if (typeof DataAPI === "undefined") return false;
    if (DataAPI.skillForAccess) return !!DataAPI.skillForAccess(
      skillOrId && typeof skillOrId === "object" ? skillOrId.id : skillOrId
    );
    return !!DataAPI.skill(skillOrId && typeof skillOrId === "object" ? skillOrId.id : skillOrId);
  } catch (_) { return false; }
}

function safeArray(value) { return Array.isArray(value) ? value : []; }
function safeObject(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function dataIdValue(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

const Store = {
  state: null,
  // Текущий предмет: часть снапшота (state.subject) и зеркало здесь для
  // запросов. Весь прогресс, каталог и прогнозы — строго в его рамках.
  subject: "profile_math",
  subjects: [],
  // Server-generated public Account ID (see server.py assign_account_id).
  // Deliberately kept outside `state`: state is the exact snapshot that
  // round-trips through PUT /api/state, and the id must never be something
  // the client can send back and have written.
  accountId: null,
  // Auth-срез текущего аккаунта из bootstrap: гость или зарегистрированный
  // пользователь (registered + email). Только для отображения в UI — никаких
  // решений на его основе, идентичность всегда определяется сервером по куке.
  auth: { registered: false, email: null },
  // Серверный признак администратора из того же bootstrap (isAdmin: true/false).
  // Решает только backend через admin_sessions; фронт его лишь отображает:
  // показывает/скрывает admin-блок и решает, запрашивать ли inbox. Никогда не
  // читается из localStorage и не отправляется обратно как доказательство.
  isAdmin: false,
  listeners: {},
  pendingSave: Promise.resolve(),
  loadPromise: null,
  ready: false,
  persistenceError: null,
  // Момент последней сверки с сервером (load или собственный save).
  // Другая вкладка после каждого save пишет маяк в localStorage; увидев
  // более свежий маяк, подтягиваем состояние с сервера вместо показа
  // старого снапшота из памяти (иначе stale-вкладка ещё и перетрёт сервер).
  lastSyncTs: 0,
  pendingExternalUpdate: false,
  // Последний подтверждённый серверный снимок нужен, чтобы при 409 отличить
  // собственные новые изменения от старых полей полного снапшота.
  lastSyncedState: null,
  // Один писатель на origin: navigator.locks держит право лидерства, а
  // BroadcastChannel переносит save-запросы и подтверждённые снимки.
  tabId: `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  tabChannel: null,
  tabChannelName: null,
  tabLockName: null,
  tabLeaderReady: false,
  isTabLeader: false,
  leaderTabId: null,
  leaderSeenAt: 0,
  leaderLockRelease: null,
  leaderAcquireInFlight: false,
  leaderHeartbeatTimer: null,
  leaderRequests: {},
  leaderSaveQueue: Promise.resolve(),
  deletedLessonSessions: [],
  deletedLessonStepErrors: [],

  /* ------- persistence ------- */

  defaultState() {
    const skills = {};
    for (const s of DataAPI.skills()) {
      if (typeof DataAPI.skillForAccess === "function" && !DataAPI.skillForAccess(s)) continue;
      if (s && s.id != null) skills[s.id] = { progress: 0, solved: 0, correct: 0, timeSec: 0 };
    }
    const subject = (typeof DataAPI !== "undefined" && DataAPI.currentSubject && DataAPI.currentSubject())
      || Store.subject || "profile_math";
    return {
      version: 4,
      stateVersion: 1,
      subject,
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
      errors: [], // {taskId, skill, sub, ts, resolved, kind: 'major'|'minor'}
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

  async load(subject) {
    this.loadPromise = (async () => {
      // Двухступенчатая загрузка: сначала лёгкий summary-каталог (~30 КБ)
      // + состояние, чтобы первая отрисовка была быстрой; тяжёлые тексты
      // заданий и шаги уроков (~250 КБ) догружаются лениво через ensureDetails.
      // Без явного subject запрос идёт без ?subject — сервер отдаёт
      // current_subject пользователя, поэтому выбранный предмет переживает
      // перезагрузку. Явный subject — только для точечной загрузки
      // (онбординг-фолбэк), он тоже подхватывается через _applyBootstrap.
      const qs = subject ? `?subject=${encodeURIComponent(subject)}` : "";
      let payload;
      try {
        payload = await ApiClient.get("/api/bootstrap-lite" + qs);
      } catch (_) {
        payload = await ApiClient.get("/api/bootstrap" + qs);
      }
      this._applyBootstrap(payload);
      return this.state;
    })();
    return this.loadPromise;
  },

  // Общий разбор bootstrap-пейлоада: и первичная загрузка, и ответ
  // POST /api/subject. Состояние одного предмета полностью заменяется
  // состоянием другого — никакого мержа, иначе данные смешаются.
  _applyBootstrap(payload) {
      const boot = safeObject(payload);
      const previousSubject = String(this.subject || "");
      const catalog = boot.catalog && typeof boot.catalog === "object" ? { ...boot.catalog } : {};
      const catalogDescribed = ["subject", "subjectId", "subjects", "subjectRegistry", "registry", "categories", "topics", "skills", "tasks", "lessons", "missions", "bosses", "achievements", "goals", "diagnosticTasks", "daily", "forecast"]
        .some((key) => Object.prototype.hasOwnProperty.call(catalog, key));
      const stateSubjectHint = safeObject(boot.state).subject;
      if (!catalog.subject && !catalog.subjectId && stateSubjectHint) catalog.subject = stateSubjectHint;
      DataAPI.load(catalog);
      this.accountId = boot.accountId || null;
      const auth = boot.auth;
      // Нет auth в пейлоаде (например, старый ответ POST /api/subject) —
      // не сбрасываем известную сессию в гостя: профиль покажет «Войти»,
      // хотя аккаунт авторизован. Сброс происходит только по явному
      // auth из ответа сервера.
      this.auth = auth && typeof auth === "object"
        ? { registered: !!auth.registered, email: auth.email || null }
        : (this.auth || { registered: false, email: null });
      // Fail-closed: нет явного true от сервера — не админ. Поле приходит из
      // bootstrap/bootstrap-lite/POST /api/subject; старые ответы без него
      // сбрасывают флаг, а не сохраняют чужой.
      this.isAdmin = boot.isAdmin === true;

      // Каталог — источник истины для subject. Если старый ответ не содержит
      // catalog.subject, допускаем subject из state; неизвестный id не
      // превращаем в profile_math (это важно для нового предмета).
      const statePayload = safeObject(boot.state);
      const catalogSubject = String(catalog.subject || catalog.subjectId || "").trim();
      const stateSubject = String(statePayload.subject || "").trim();
      this.subject = catalogSubject || stateSubject || currentSubjectId();
      this.subjects = DataAPI.subjects();
      this.detailsPromise = null;
      // Pending delete intents belong to the subject that was active before
      // this bootstrap. Never carry them into a newly selected/locked subject.
      if (previousSubject && previousSubject !== this.subject) {
        this.deletedLessonSessions = [];
        this.deletedLessonStepErrors = [];
      }

      const defaults = this.defaultState();
      const parsed = statePayload;
      this.state = Object.assign(defaults, parsed);
      this.state.subject = this.subject;
      this.state.version = defaults.version;

      const learningAvailable = subjectLearningAvailable();
      const preserveLearningState = learningAvailable || !catalogDescribed;
      const availableIds = new Set(
        (typeof DataAPI.availableSkills === "function" ? DataAPI.availableSkills() : DataAPI.skills())
          .map((skill) => String(skill.id)).filter(Boolean)
      );
      const validSkill = (id) => availableIds.has(String(id || ""));
      const validTask = (id) => !!(DataAPI.taskForAccess && DataAPI.taskForAccess(id));
      const validLesson = (id) => !!(DataAPI.lessonForAccess && DataAPI.lessonForAccess(id));

      // Не позволяем старому/чужому payload принести skillStats другого
      // предмета. Для locked/empty предмета возвращаем чистое состояние:
      // профиль можно завершить, но XP, попытки и «пустые» достижения не
      // должны выглядеть как результат несуществующего курса.
      const oldStats = safeObject(parsed.skillStats);
      const stats = preserveLearningState
        ? Object.fromEntries(Object.entries(defaults.skillStats).map(([id, value]) => [id, { ...value }]))
        : {};
      for (const [id, value] of Object.entries(oldStats)) {
        if (preserveLearningState && (!catalogDescribed || validSkill(id))) {
          const source = safeObject(value);
          stats[id] = {
            progress: Math.max(0, Number(source.progress) || 0),
            solved: Math.max(0, Number(source.solved) || 0),
            correct: Math.max(0, Number(source.correct) || 0),
            timeSec: Math.max(0, Number(source.timeSec ?? source.time_sec) || 0),
          };
        }
      }
      this.state.skillStats = stats;
      this.state.hintLevels = preserveLearningState
        ? Object.assign({ 1: 0, 2: 0, 3: 0 }, safeObject(parsed.hintLevels))
        : { 1: 0, 2: 0, 3: 0 };
      const completed = safeObject(parsed.completedLessons);
      const sessions = safeObject(parsed.lessonSessions);
      // Исторические факты сохраняем даже если конкретный урок/задание уже
      // исчез из обновлённого каталога: старые payload и orphan-записи должны
      // переживать reload.  Доступ к таким сущностям всё равно закрывают
      // DataAPI.*ForAccess; фильтрация ниже относится только к видимым
      // skillStats/ежедневной выборке.
      this.state.completedLessons = preserveLearningState ? { ...completed } : {};
      this.state.lessonSessions = preserveLearningState ? { ...sessions } : {};
      this.state.lessonStepErrors = preserveLearningState ? safeObject(parsed.lessonStepErrors) : {};
      this.state.lessonErrorHistory = preserveLearningState ? safeArray(parsed.lessonErrorHistory) : [];
      this.state.forecastHistory = preserveLearningState && (DataAPI.forecastConfig() || DataAPI.isLegacySubject())
        ? safeArray(parsed.forecastHistory) : [];
      this.state.lessonAttempts = preserveLearningState ? safeArray(parsed.lessonAttempts) : [];
      this.state.taskAttempts = preserveLearningState
        ? safeArray(parsed.taskAttempts).filter((item) => !item || !item.skill || !catalogDescribed || validSkill(item.skill))
        : [];
      this.state.diagnostics = preserveLearningState ? safeArray(parsed.diagnostics) : [];
      this.state.errors = preserveLearningState
        ? safeArray(parsed.errors).filter((item) => !item || !item.skill || !catalogDescribed || validSkill(item.skill))
        : [];
      this.state.bossesDefeated = preserveLearningState ? safeArray(parsed.bossesDefeated) : [];
      this.state.missionsDone = preserveLearningState ? safeObject(parsed.missionsDone) : {};
      this.state.missionProgress = preserveLearningState ? safeObject(parsed.missionProgress) : {};
      this.state.achievements = preserveLearningState ? safeObject(parsed.achievements) : {};
      this.state.activity = preserveLearningState ? safeObject(parsed.activity) : {};
      this.state.dailyHistory = preserveLearningState ? safeArray(parsed.dailyHistory) : [];
      this.state.timeline = preserveLearningState ? safeArray(parsed.timeline) : [];
      this.state.daily = preserveLearningState ? safeObject(parsed.daily) : { date: null, solved: 0, done: false, taskIds: [] };
      this.state.daily.taskIds = preserveLearningState
        ? safeArray(this.state.daily.taskIds).filter((id) => !catalogDescribed || validTask(id)) : [];
      this.state.daily.solved = preserveLearningState ? Math.max(0, Number(this.state.daily.solved) || 0) : 0;
      this.state.daily.done = preserveLearningState ? !!this.state.daily.done : false;
      this.state.xp = preserveLearningState ? Math.max(0, Number(parsed.xp) || 0) : 0;
      this.state.totalSolved = preserveLearningState ? Math.max(0, Number(parsed.totalSolved) || 0) : 0;
      this.state.totalCorrect = preserveLearningState ? Math.max(0, Number(parsed.totalCorrect) || 0) : 0;
      this.state.totalTimeSec = preserveLearningState ? Math.max(0, Number(parsed.totalTimeSec) || 0) : 0;
      this.state.hintsUsed = preserveLearningState ? Math.max(0, Number(parsed.hintsUsed) || 0) : 0;
      this.state.correctSeries = preserveLearningState ? Math.max(0, Number(parsed.correctSeries) || 0) : 0;
      this.state.bestSeries = preserveLearningState ? Math.max(0, Number(parsed.bestSeries) || 0) : 0;
      this.state.errorsResolved = preserveLearningState ? Math.max(0, Number(parsed.errorsResolved) || 0) : 0;
      this.state.streak = preserveLearningState ? Math.max(0, Number(parsed.streak) || 0) : 0;
      this.state.lastActiveDate = preserveLearningState ? (parsed.lastActiveDate || null) : null;
      // Журнал ручных XP-начислений тоже является learning-данными; locked
      // предмет не должен даже временно показывать чужой/старый журнал.
      this.state.xpAdjustments = preserveLearningState ? safeArray(parsed.xpAdjustments) : [];

      this.lastSyncedState = JSON.parse(JSON.stringify(this.state));
      this.ready = true;
      this.lastSyncTs = Date.now();
      this.pendingExternalUpdate = false;
      // Daily/forecast — производные состояния. Для locked/empty предмета
      // они не создаются вообще, поэтому не вызываем их и не запускаем save.
      if (learningAvailable) ensureDailyChallenge();
      // Фоновая догрузка деталей, пока пользователь смотрит первый экран:
      // переход в тренировку/урок потом откроется мгновенно. Ошибки здесь
      // не показываем — экраны сами дождутся деталей через ensureDetails.
      if (!DataAPI.detailsReady()) {
        const prefetch = () => this.ensureDetails().catch(() => {});
        try {
          if (typeof requestIdleCallback === "function") requestIdleCallback(prefetch, { timeout: 4000 });
          else setTimeout(prefetch, 1200);
        } catch (_) { /* ignore — детали подгрузятся по требованию */ }
      }
      return this.state;
  },

  // Полный каталог задач и уроков. Один полёт на сессию: параллельные
  // вызовы делят общий промис; после успеха бросаем событие catalogready,
  // чтобы лёгкие экраны обновили счётчики. Ошибка сбрасывает промис,
  // чтобы следующая навигация попробовала снова.
  ensureDetails() {
    if (DataAPI.detailsReady()) return Promise.resolve();
    if (this.detailsPromise) return this.detailsPromise;
    const qs = `?subject=${encodeURIComponent(this.subject || currentSubjectId())}`;
    this.detailsPromise = (async () => {
      const [tasksPayload, lessonsPayload] = await Promise.all([
        ApiClient.get("/api/catalog-tasks" + qs),
        ApiClient.get("/api/catalog-lessons" + qs),
      ]);
      DataAPI.loadDetails({
        tasks: tasksPayload.tasks,
        lessons: lessonsPayload.lessons,
        visualAssets: tasksPayload.visualAssets,
        visualAudit: tasksPayload.visualAudit,
      });
      this.emit("catalogready");
    })().catch((error) => { this.detailsPromise = null; throw error; });
    return this.detailsPromise;
  },

  // Межвкладочный координатор. Он не содержит бизнес-логики: все экраны по-
  // прежнему вызывают Store.save(), а выбор единственного писателя происходит
  // здесь. При отсутствии Locks/BroadcastChannel сохранение остаётся рабочим
  // через OCC, а не ломается на старом браузере.
  initTabLeader() {
    if (this.tabLeaderReady) return Promise.resolve();
    this.tabLeaderReady = true;
    if (typeof BroadcastChannel !== "function" || typeof navigator === "undefined" || !navigator.locks) {
      // Graceful fallback: CAS remains the authority where browser primitives
      // are unavailable (older WebViews/private modes).
      this.isTabLeader = true;
      this.leaderTabId = this.tabId;
      return Promise.resolve();
    }
    const scope = encodeURIComponent(this.accountId || "pending-account");
    this.tabChannelName = `ege-core-state-leader-v1:${scope}`;
    this.tabLockName = `ege-core-state-leader-v1:${scope}`;
    this.tabChannel = new BroadcastChannel(this.tabChannelName);
    this.tabChannel.onmessage = (event) => this._handleTabMessage(event && event.data);
    // Не объявляемся лидером до успешного захвата lock: иначе две одновременно
    // открытые вкладки кратко увидят друг друга «главными».
    this._tryBecomeTabLeader();
    this.leaderHeartbeatTimer = setInterval(() => {
      if (this.isTabLeader) this._announceLeaderStatus();
      else if (!this.leaderSeenAt || Date.now() - this.leaderSeenAt > 2500) this._tryBecomeTabLeader();
    }, 700);
    return Promise.resolve();
  },

  _postTabMessage(message) {
    try { if (this.tabChannel) this.tabChannel.postMessage({ ...message, from: this.tabId }); } catch (_) {}
  },

  _announceLeaderStatus() {
    this._postTabMessage({ type: "leader-heartbeat", leader: this.tabId });
  },

  _tryBecomeTabLeader() {
    if (this.isTabLeader || this.leaderAcquireInFlight || !this.tabChannel) return;
    this.leaderAcquireInFlight = true;
    navigator.locks.request(this.tabLockName || "ege-core-state-leader-v1", { ifAvailable: true }, async (lock) => {
      this.leaderAcquireInFlight = false;
      if (!lock) return;
      this.isTabLeader = true;
      this.leaderTabId = this.tabId;
      this.leaderSeenAt = Date.now();
      this._announceLeaderStatus();
      this.emit("tableader", { leader: true });
      await new Promise((resolve) => { this.leaderLockRelease = resolve; });
      this.leaderLockRelease = null;
      this.isTabLeader = false;
      if (this.leaderTabId === this.tabId) this.leaderTabId = null;
    }).catch(() => { this.leaderAcquireInFlight = false; });
  },

  releaseTabLeadership() {
    if (this.leaderHeartbeatTimer) clearInterval(this.leaderHeartbeatTimer);
    this.leaderHeartbeatTimer = null;
    if (this.leaderLockRelease) this.leaderLockRelease();
    try { if (this.tabChannel) this.tabChannel.close(); } catch (_) {}
    this.tabChannel = null;
  },

  _applyLeaderState(nextState) {
    if (!nextState || typeof nextState !== "object" || nextState.subject !== this.subject) return;
    const busy = (typeof Session !== "undefined" && Session && Session.cur)
      || (typeof Lesson !== "undefined" && Lesson && Lesson.cur);
    this.state = busy ? this.mergeConflictState(nextState, this.state || {}) : JSON.parse(JSON.stringify(nextState));
    this.lastSyncedState = JSON.parse(JSON.stringify(nextState));
    this.lastSyncTs = Date.now();
    if (busy) this.pendingExternalUpdate = true;
    else this.emit("externalupdate");
  },

  _handleLeaderSave(message) {
    if (!this.isTabLeader || !message || !message.snapshot) return;
    this.leaderSaveQueue = this.leaderSaveQueue
      .catch(() => {})
      .then(() => this._processLeaderSave(message));
    return this.leaderSaveQueue;
  },

  async _processLeaderSave(message) {
    try {
      const incoming = message.snapshot;
      if (incoming.subject !== this.subject) throw new Error("Другой предмет уже выбран в главной вкладке");
      const merged = this.mergeLeaderState(this.state || {}, incoming, message.baseState || {});
      // Leader owns the canonical in-memory snapshot as well as the only PUT.
      this.state = merged;
      const result = await this._saveSnapshot(merged);
      const confirmed = JSON.parse(JSON.stringify(this.state || merged));
      this._postTabMessage({ type: "state-saved", state: confirmed, result });
      this._postTabMessage({ type: "save-result", requestId: message.requestId, ok: true, result, state: confirmed });
    } catch (error) {
      this._postTabMessage({ type: "save-result", requestId: message.requestId, ok: false,
        error: { message: (error && error.message) || "Не удалось сохранить данные", status: error && error.status } });
    }
  },

  async _handleLeaderAction(message) {
    if (!this.isTabLeader || !message || !message.action) return;
    try {
      let payload;
      if (message.action === "switch-subject") {
        payload = await ApiClient.post("/api/subject", { subject: message.subject });
        this._applyBootstrap(payload);
      } else if (message.action === "reset") {
        await ApiClient.delete("/api/state");
        await this.load();
        payload = { state: this.state, accountId: this.accountId };
      } else {
        throw new Error("Неизвестное действие вкладки");
      }
      this._postTabMessage({ type: "action-result", requestId: message.requestId, ok: true, action: message.action, payload });
      if (message.action === "switch-subject") {
        this._postTabMessage({ type: "subject-switched", payload });
      }
    } catch (error) {
      this._postTabMessage({ type: "action-result", requestId: message.requestId, ok: false,
        error: { message: (error && error.message) || "Не удалось выполнить действие", status: error && error.status } });
    }
  },

  requestLeaderAction(action, data = {}) {
    if (this.isTabLeader || !this.tabChannel) {
      if (action === "switch-subject") return ApiClient.post("/api/subject", { subject: data.subject });
      if (action === "reset") return ApiClient.delete("/api/state");
      return Promise.reject(new Error("Неизвестное действие вкладки"));
    }
    const requestId = `${this.tabId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.leaderRequests[requestId]) return;
        delete this.leaderRequests[requestId];
        this._tryBecomeTabLeader();
        reject(new Error("Главная вкладка недоступна: попробуй ещё раз"));
      }, 5000);
      this.leaderRequests[requestId] = {
        resolve: (result) => { clearTimeout(timeout); resolve(result); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      };
      this._postTabMessage({ type: "leader-query" });
      this._postTabMessage({ type: "action-request", requestId, action, ...data });
    });
  },

  _handleTabMessage(message) {
    if (!message || message.from === this.tabId) return;
    if (message.type === "leader-heartbeat") {
      this.leaderTabId = message.leader || message.from;
      this.leaderSeenAt = Date.now();
      return;
    }
    if (message.type === "leader-query") {
      if (this.isTabLeader) this._announceLeaderStatus();
      return;
    }
    if (message.type === "save-request") {
      this._handleLeaderSave(message);
      return;
    }
    if (message.type === "action-request") {
      this._handleLeaderAction(message);
      return;
    }
    if (message.type === "subject-switched" && message.payload) {
      // Смена предмета — это не обычный state-saved: нужен и новый каталог.
      this._applyBootstrap(message.payload);
      this.emit("subjectchange", this.subject);
      return;
    }
    if (message.type === "state-saved") {
      this._applyLeaderState(message.state);
      return;
    }
    if (message.type === "action-result" && message.requestId && this.leaderRequests[message.requestId]) {
      const pending = this.leaderRequests[message.requestId];
      delete this.leaderRequests[message.requestId];
      if (message.ok) {
        if (message.action === "switch-subject" && message.payload) this._applyBootstrap(message.payload);
        if (message.action === "reset" && message.payload && message.payload.state) {
          this.state = JSON.parse(JSON.stringify(message.payload.state));
          this.accountId = message.payload.accountId || null;
        }
        pending.resolve(message.payload || {});
      }
      else {
        const error = Object.assign(new Error(message.error && message.error.message || "Не удалось выполнить действие"), message.error || {});
        pending.reject(error);
      }
      return;
    }
    if (message.type === "save-result" && message.requestId && this.leaderRequests[message.requestId]) {
      const pending = this.leaderRequests[message.requestId];
      delete this.leaderRequests[message.requestId];
      if (message.ok) {
        this._applyLeaderState(message.state);
        pending.resolve(message.result || {});
      } else {
        const error = Object.assign(new Error(message.error && message.error.message || "Не удалось сохранить данные"), message.error || {});
        pending.reject(error);
      }
    }
  },

  requestLeaderSave(snapshot) {
    if (this.isTabLeader || !this.tabChannel) return this._saveSnapshot(snapshot);
    const requestId = `${this.tabId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.leaderRequests[requestId]) return;
        delete this.leaderRequests[requestId];
        this._tryBecomeTabLeader();
        reject(new Error("Главная вкладка недоступна: попробуй сохранить ещё раз"));
      }, 5000);
      this.leaderRequests[requestId] = {
        resolve: (result) => { clearTimeout(timeout); resolve(result); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      };
      this._postTabMessage({ type: "leader-query" });
      this._postTabMessage({ type: "save-request", requestId, snapshot,
        baseState: JSON.parse(JSON.stringify(this.lastSyncedState || {})) });
    });
  },

  // Слияние после 409: серверный снимок — база. Добавляем только данные,
  // которые безопасно объединяются по смыслу: неизменяемые события и факты
  // завершения. Профиль, активные сессии и агрегаты остаются свежими с сервера.
  // Дедуп — по стабильному client ID (entityKey), поэтому повторная отправка
  // одного и того же события после ретрая/даблклика не удваивается ни в
  // памяти, ни на сервере (там — upsert по client_id + CAS-версия).
  mergeConflictState(fresh, local) {
    // Снимки разных предметов никогда не смешиваются, даже если старый
    // BroadcastChannel/409-путь успел доставить сообщение после switchSubject.
    if (fresh && local && fresh.subject && local.subject && fresh.subject !== local.subject) {
      return JSON.parse(JSON.stringify(fresh));
    }
    const merged = JSON.parse(JSON.stringify(fresh || {}));
    const unique = (items) => {
      const seen = new Set();
      return (items || []).filter((item) => {
        const key = (typeof entityKey === "function") ? entityKey(item) : JSON.stringify(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };
    for (const key of ["taskAttempts", "lessonAttempts", "errors", "lessonErrorHistory", "diagnostics", "dailyHistory", "timeline"]) {
      merged[key] = unique([...(fresh[key] || []), ...(local[key] || [])]);
    }
    for (const key of ["completedLessons", "missionsDone", "achievements"]) {
      merged[key] = Object.assign({}, fresh[key] || {}, local[key] || {});
    }
    merged.missionProgress = Object.assign({}, fresh.missionProgress || {});
    for (const [id, progress] of Object.entries(local.missionProgress || {})) {
      merged.missionProgress[id] = Math.max(Number(merged.missionProgress[id]) || 0, Number(progress) || 0);
    }
    merged.bossesDefeated = unique([...(fresh.bossesDefeated || []), ...(local.bossesDefeated || [])]);
    merged.stateVersion = fresh.stateVersion;
    merged.subject = fresh.subject;
    // Регистрация одноразово создаёт профиль: если локальный снимок его уже
    // создал, а серверный (ещё не получивший запись) нет — свежий серверный
    // снимок не должен откатывать профиль в «не зарегистрирован». Иначе после
    // конфликта экран снова просит пройти регистрацию, а имя/цель теряются.
    if (local && local.onboarded && !merged.onboarded) {
      for (const key of ["onboarded", "name", "selfLevel", "goal", "lastActiveDate"]) {
        if (key in local) merged[key] = local[key];
      }
    }
    return merged;
  },

  // Для живой главной вкладки можно применить больше, чем при 409: у нас есть
  // базовый снимок вторичной вкладки, поэтому переносим только поля, которые
  // она действительно изменила после последней синхронизации, не её старые
  // значения. Это сохраняет профиль и черновик урока без full-overwrite.
  mergeLeaderState(fresh, local, base) {
    const merged = this.mergeConflictState(fresh || {}, local || {});
    const changed = (key) => JSON.stringify((local || {})[key]) !== JSON.stringify((base || {})[key]);
    for (const key of ["name", "onboarded", "goal", "selfLevel", "lastActiveDate", "daily", "lessonSessions", "lessonStepErrors", "skillStats", "hintLevels", "activity", "forecastHistory"]) {
      if (changed(key)) merged[key] = JSON.parse(JSON.stringify(local[key]));
    }
    return merged;
  },

  async _saveDomains(snapshot) {
    const base = this.lastSyncedState || {};
    const subject = snapshot.subject;
    let version = snapshot.stateVersion;
    const request = async (method, path, body) => {
      const payload = { subject, expectedVersion: version, ...body };
      const result = await ApiClient[method](path, payload);
      if (!Number.isInteger(result.stateVersion) || result.stateVersion < 1) throw new Error("Сервер не вернул версию состояния");
      version = result.stateVersion;
      snapshot.stateVersion = version;
      if (this.state && this.subject === subject) this.state.stateVersion = version;
      return result;
    };
    const changed = (key) => JSON.stringify(snapshot[key]) !== JSON.stringify(base[key]);
    const learningAvailable = subjectLearningAvailable();
    // Новые события — по стабильному ID: повтор snapshot после ретрая не
    // шлёт уже подтверждённое (CAS-база lastSyncedState обновляется только
    // после успеха, tab-leader сериализует PUT одной очередью).
    const newItems = (key) => {
      const seen = new Set((base[key] || []).map((old) => entityKey(old)));
      return (snapshot[key] || []).filter((item) => !seen.has(entityKey(item)));
    };

    const attempts = learningAvailable ? newItems("taskAttempts") : [];
    if (attempts.length) await request("post", "/api/events/attempts", { events: attempts });
    const timeline = learningAvailable ? newItems("timeline") : [];
    if (timeline.length) await request("post", "/api/events/timeline", { events: timeline });
    for (const [skillId, progress] of Object.entries(snapshot.skillStats || {})) {
      if (!learningAvailable || !skillIsAccessible(skillId)) continue;
      if (JSON.stringify(progress) !== JSON.stringify((base.skillStats || {})[skillId])) {
        await request("patch", `/api/progress/${encodeURIComponent(skillId)}`, { progress });
      }
    }
    const baseErrors = learningAvailable ? (base.errors || []) : [];
    const sameError = (a, b) => {
      if (!a || !b) return false;
      // Стабильный client ID в приоритете (строковый UUID), затем server id.
      for (const key of ["clientId", "id"]) {
        const va = a[key], vb = b[key];
        if (typeof va === "string" && va && va === vb) return true;
        if (typeof va === "number" && va === vb) return true;
      }
      // Legacy без ID: естественный ключ, как раньше.
      return a.taskId === b.taskId && a.ts === b.ts && !a.id && !b.id && !a.clientId && !b.clientId;
    };
    // PATCH существующих — строго раньше POST новых: закрытие/апгрейд
    // обязаны лечь в БД до вставки новой ошибки по тому же заданию, иначе
    // серверный upsert по task_id склеит их в одну строку и мини-ошибка
    // после «провал → неидеальное решение» потеряется.
    for (const error of learningAvailable ? (snapshot.errors || []) : []) {
      const old = baseErrors.find((item) => sameError(item, error));
      if (!old) continue;
      // PATCH — идемпотентен: тот же resolved/kind даёт тот же результат.
      // Адресуем стабильным ID: server id, иначе client UUID (сервер умеет оба).
      const key = error.id || error.clientId;
      if (!key) continue;
      const patch = {};
      if (!!old.resolved !== !!error.resolved) patch.resolved = !!error.resolved;
      if ((old.kind || "major") !== (error.kind || "major")) patch.kind = error.kind || "major";
      if (Object.keys(patch).length) {
        await request("patch", `/api/errors/${encodeURIComponent(key)}`, patch);
      }
    }
    // POST новых — уже закрытые первыми: пара «провал → быстрый верный
    // ответ в одном сейве» обязана вставиться в этом порядке, иначе upsert
    // по task_id вернёт открытой строке чужой ID и resolved разойдётся
    // между клиентом и сервером.
    const newErrors = learningAvailable
      ? (snapshot.errors || []).filter((error) => !baseErrors.find((item) => sameError(item, error)))
      : [];
    const orderedNew = [...newErrors.filter((e) => !!e.resolved), ...newErrors.filter((e) => !e.resolved)];
    for (const error of orderedNew) {
      const sentClientId = error.clientId;
      const result = await request("post", "/api/errors", { error });
      if (result.error) {
        if (result.error.id && !error.id) error.id = result.error.id;
        if (result.error.clientId && !error.clientId) error.clientId = result.error.clientId;
        if (result.error.kind) error.kind = result.error.kind;
        const live = (this.state && this.state.errors || []).find((item) => (sameError(item, error) || (sentClientId && item.clientId === sentClientId)) && !item.id);
        if (live) {
          if (error.id) live.id = error.id;
          if (error.clientId) live.clientId = error.clientId;
          if (error.kind) live.kind = error.kind;
        }
        const liveByClient = (this.state && this.state.errors || []).find((item) => item.clientId && item.clientId === error.clientId);
        if (liveByClient && error.id) liveByClient.id = error.id;
        if (liveByClient && error.kind) liveByClient.kind = error.kind;
        // Ошибка создана и тут же закрыта до первого save (даблклик/
        // быстрый верный ответ): POST создаёт строку resolved=0, поэтому
        // сразу доводим флаг тем же стабильным ID — иначе resolved потеряется.
        if (!!error.resolved && !result.error.resolved) {
          const key = error.id || error.clientId;
          if (key) await request("patch", `/api/errors/${encodeURIComponent(key)}`, { resolved: true });
        }
      }
    }
    const settings = {};
    const settingKeys = ["name", "onboarded", "goal", "selfLevel"];
    for (const key of settingKeys) if (changed(key)) settings[key] = snapshot[key];
    if (Object.keys(settings).length) await request("patch", "/api/settings", { settings });
    const domains = {};
    const learningDomains = ["lessonSessions", "lessonStepErrors", "lessonErrorHistory", "lessonAttempts", "completedLessons", "missionProgress", "missionsDone", "achievements", "bossesDefeated", "daily", "diagnostics", "activity", "forecastHistory", "hintLevels"];
    for (const key of learningDomains) {
      if (learningAvailable && changed(key)) domains[key] = snapshot[key];
    }
    if (learningAvailable && Array.isArray(snapshot.deletedLessonSessions) && snapshot.deletedLessonSessions.length) {
      domains.deletedLessonSessions = snapshot.deletedLessonSessions;
    }
    if (learningAvailable && Array.isArray(snapshot.deletedLessonStepErrors) && snapshot.deletedLessonStepErrors.length) {
      domains.deletedLessonStepErrors = snapshot.deletedLessonStepErrors;
    }
    if (Object.keys(domains).length) await request("patch", "/api/state-domains", { domains });
    if (Array.isArray(snapshot.deletedLessonSessions)) {
      const deleted = new Set(snapshot.deletedLessonSessions);
      this.deletedLessonSessions = this.deletedLessonSessions.filter((lessonId) => !deleted.has(lessonId));
      delete snapshot.deletedLessonSessions;
    }
    if (Array.isArray(snapshot.deletedLessonStepErrors)) {
      const deleted = new Set(snapshot.deletedLessonStepErrors);
      this.deletedLessonStepErrors = this.deletedLessonStepErrors.filter((key) => !deleted.has(key));
      delete snapshot.deletedLessonStepErrors;
    }
    this.lastSyncedState = JSON.parse(JSON.stringify(snapshot));
    return { ok: true, stateVersion: version };
  },

  async _saveSnapshot(snapshot) {
    try {
      return await this._saveDomains(snapshot);
    } catch (error) {
      if (!error || error.status !== 409) throw error;
      const prevAccount = this.accountId;
      const liveAtConflict = JSON.parse(JSON.stringify(this.state || {}));
      await this.load(snapshot.subject);
      // Смена аккаунта посреди сейва (logout/login в другой вкладке этого
      // браузера): локальный снапшот принадлежит прежнему аккаунту — мержить
      // его в новый нельзя, иначе события/ошибки/достижения/XP старого
      // аккаунта физически запишутся в новый. Серверный снимок уже свежий —
      // принимаем его как есть, без мержа и без повторной отправки.
      if (this.accountId !== prevAccount) {
        this.emit("stateconflict", { accountChanged: true });
        return { ok: true, stateVersion: this.state.stateVersion, accountChanged: true };
      }
      const fresh = this.state;
      const rebased = this.mergeConflictState(this.mergeConflictState(fresh, snapshot), liveAtConflict);
      const result = await this._saveDomains(rebased);
      this.state = rebased;
      this.emit("stateconflict", { merged: true });
      return result;
    }
  },

  save() {
    if (!this.state || !this.ready) return Promise.resolve();
    this.pendingSave = this.pendingSave
      .catch(() => {})
      .then(() => {
        const snapshot = JSON.parse(JSON.stringify(this.state));
        // Снапшот всегда помечен предметом — сервер пишет строго в его строки.
        snapshot.subject = this.subject || snapshot.subject || currentSubjectId();
        snapshot.deletedLessonSessions = [...this.deletedLessonSessions];
        snapshot.deletedLessonStepErrors = [...this.deletedLessonStepErrors];
        // Нечего писать — пропускаем сеть целиком. lastSyncedState обновляется
        // после каждого успеха и каждой загрузки, поэтому совпадение снимков
        // означает, что сервер уже в том же состоянии. Главный выигрыш — смена
        // предмета без новых ответов: switchSubject ждёт save() до самого
        // POST /api/subject, а цепочка доменных записей — это пачка
        // последовательных round-trip'ов (попытки, каждый навык, настройки…).
        if (!snapshot.deletedLessonSessions.length) delete snapshot.deletedLessonSessions;
        if (!snapshot.deletedLessonStepErrors.length) delete snapshot.deletedLessonStepErrors;
        if (this.lastSyncedState
            && !this.deletedLessonSessions.length
            && !this.deletedLessonStepErrors.length
            && JSON.stringify(snapshot) === JSON.stringify(this.lastSyncedState)) {
          return false;
        }
        return this.requestLeaderSave(snapshot).then(() => true);
      })
      .then((saved) => { this.persistenceError = null; if (saved) this._noteOwnSave(); })
      .catch((error) => {
        this.persistenceError = error;
        this.emit("persistenceerror", error);
      });
    return this.pendingSave;
  },

  // Ключ маяка свой на предмет: вкладки разных предметов друг другу не указ.
  pingKey(subject) { return "ege_core_state_ping:" + (subject || currentSubjectId()); },

  // Успешно сохранились: фиксируем момент и будим соседние вкладки.
  // Только localStorage (без DOM/window) — безопасно для node-тестов.
  _noteOwnSave() {
    this.lastSyncTs = Date.now();
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(this.pingKey(this.subject),
          JSON.stringify({ subject: this.subject || currentSubjectId(), ts: this.lastSyncTs }));
      }
    } catch (_) {}
  },

  // Чистое решение «чужой ли маяк новее нас» — без чтения хранилищ,
  // покрывается node-тестом напрямую.
  shouldRefreshForPing(ping) {
    if (!ping || typeof ping !== "object") return false;
    if (ping.subject !== (this.subject || currentSubjectId())) return false;
    return (Number(ping.ts) || 0) > (this.lastSyncTs || 0);
  },

  // Другая вкладка сохранилась: подтягиваем свежее состояние с сервера.
  // Во время активной тренировки/урока состояние не подменяем из-под
  // сессии — откладываем до следующей навигации (см. render в app.js),
  // иначе ответы текущей сессии ушли бы в чужой снапшот.
  // Возвращает "reloaded" | "deferred" | "none".
  async checkExternalUpdate() {
    if (!this.ready || !this.state) return "none";
    let ping = null;
    try {
      if (typeof localStorage === "undefined") return "none";
      const raw = localStorage.getItem(this.pingKey(this.subject));
      ping = raw ? JSON.parse(raw) : null;
    } catch (_) { return "none"; }
    if (!this.shouldRefreshForPing(ping)) return "none";
    const busy = (typeof Session !== "undefined" && Session && Session.cur)
      || (typeof Lesson !== "undefined" && Lesson && Lesson.cur);
    if (busy) {
      this.pendingExternalUpdate = true;
      try { this.emit("externalupdate-pending"); } catch (_) {}
      return "deferred";
    }
    await this.load();
    this.pendingExternalUpdate = false;
    try { this.emit("externalupdate"); } catch (_) {}
    return "reloaded";
  },

  // Переключение предмета: сервер возвращает лёгкий каталог (summary) +
  // состояние нового предмета, клиент полностью заменяет текущие (без мержа)
  // и перерисовывается. Детали (тексты заданий, шаги уроков) догружаются
  // лениво через ensureDetails. Несохранённые изменения текущего предмета
  // сначала дописываем.
  async switchSubject(subjectId) {
    if (!subjectId) return this.state;
    // Единственная истина о загруженном каталоге — DataAPI.currentSubject().
    // Store.subject мутирует раньше (applyOnboarding ставит его до смены),
    // поэтому сравнение только с ним тихо пропускает POST и оставляет
    // старый каталог на экране («возвращает старый профиль»). No-op —
    // только когда предмет уже и в состоянии, и в каталоге.
    const catalogSubject = (typeof DataAPI !== "undefined" && DataAPI.currentSubject)
      ? DataAPI.currentSubject() : null;
    if (subjectId === this.subject && (!catalogSubject || subjectId === catalogSubject)) return this.state;
    await this.save();
    await this.pendingSave.catch(() => {});
    const payload = await this.requestLeaderAction("switch-subject", { subject: subjectId });
    if (this.isTabLeader || !this.tabChannel) this._applyBootstrap(payload);
    this.emit("subjectchange", this.subject);
    return this.state;
  },

  reset() {
    this.state = this.defaultState();
    this.accountId = null;
    this.isAdmin = false;
    if (!this.ready) return Promise.resolve();
    this.pendingSave = this.pendingSave
      .catch(() => {})
      .then(() => this.requestLeaderAction("reset"))
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

  // После register/login/logout сервер перевыпускает сессию (или минтит
  // нового гостя) — перечитываем bootstrap: обычный load подтянет новый
  // аккаунт целиком, вручную ничего мержить не нужно. Сменившийся accountId
  // требует переинициализации tab-leader: канал и лок имеют scope от
  // accountId, иначе вкладки нового аккаунта встали бы в чужой координатор.
  async refreshAfterAuth() {
    const prevAccount = this.accountId;
    await this.load();
    if (this.accountId !== prevAccount && this.tabLeaderReady) {
      this.releaseTabLeadership();
      this.tabLeaderReady = false;
      this.isTabLeader = false;
      this.leaderTabId = null;
      this.leaderSeenAt = 0;
      await this.initTabLeader();
    }
    this.emit("authchanged");
    return this.accountId !== prevAccount;
  },

  /* ------- events ------- */

  on(evt, fn) { (this.listeners[evt] = this.listeners[evt] || []).push(fn); },
  emit(evt, data) { (this.listeners[evt] || []).forEach((fn) => fn(data)); },
};

/* ============================================================
   Уровни: xp для перехода n → n+1 = 400 + 120·n
   ============================================================ */

function xpForLevel(n) { return 400 + 120 * (n - 1); }

/* ============================================================
   ЕДИНАЯ формула XP за практику (зеркалится в server.py derive_stats).
   Разделены сущности:
   - попытка (посещение задания): минимум, не зависит от результата;
   - верный ответ: бонус, зависит от сложности и уровня подсказки;
   - закрытие ошибки: +15 за факт;
   - milestone за уровень: разовый бонус при переходе.
   Сложность задания — целое 1..5 из каталога.
   ============================================================ */
const XP_ATTEMPT_BASE = 6;         // минимум за любую попытку
const XP_ATTEMPT_PER_DIFF = 2;     // +2 за каждую звезду сложности
const XP_CORRECT_BASE = 10;        // базовый бонус за верный ответ
const XP_CORRECT_PER_DIFF = 5;     // +5 за звезду
const XP_ERROR_RESOLVED = 15;      // закрытие ранее допущенной ошибки
const XP_LEVEL_MILESTONE = 50;     // разовый бонус за достижение нового уровня

const MINOR_SLOW_SEC = 180; // единый порог с PRACTICE_LONG_SECONDS: дольше — мини-ошибка «время»

// Вид ошибки: 'major' — задание реально не решено (неверный ответ, пропуск,
// просмотр решения), 'minor' — решено, но неидеально. Записи без kind
// (старые данные, чужая вкладка, сервер до миграции) — всегда major.
function errorKindOf(e) {
  return e && e.kind === "minor" ? "minor" : "major";
}

// Неидеальное решение — кандидат в мини-ошибки. Единый источник истины с
// practiceAttemptQuality(): те же сигналы (подсказки, неверные попытки,
// время) и тот же порог времени. quality < 1 <=> imperfect != null.
function imperfectReason(task, hintLevel, wrongAttempts, seconds) {
  if ((Number(hintLevel) || 0) > 0) return "hint";
  if ((Number(wrongAttempts) || 0) > 0) return "attempts";
  const sec = Number(seconds) || 0;
  if (Number.isFinite(sec) && sec > PRACTICE_LONG_SECONDS) return "time";
  return null;
}

// Полный XP за попытку по заданию с учётом подсказки и повтора.
// alreadyMastered: задание уже было решено верно раньше.
// hintLevel: 0 — сам, 1 — подсказка, 2 — разбор, 3 — показан ответ (не верно).
function attemptXp(task, correct, hintLevel, alreadyMastered) {
  const diff = Math.max(1, Math.min(5, Number(task && task.diff) || 1));
  const attempt = XP_ATTEMPT_BASE + diff * XP_ATTEMPT_PER_DIFF;
  if (!correct || hintLevel >= 3) return { attempt, correctBonus: 0, total: attempt };
  if (alreadyMastered) return { attempt, correctBonus: 0, total: attempt }; // повтор: только за посещение
  let bonus = XP_CORRECT_BASE + diff * XP_CORRECT_PER_DIFF;
  if (hintLevel === 1) bonus = Math.round(bonus * 0.6);      // подсказка снижает бонус
  else if (hintLevel >= 2) bonus = Math.round(bonus * 0.3);  // разбор — сильнее
  return { attempt, correctBonus: bonus, total: attempt + bonus };
}

function levelInfo() {
  let xp = Math.max(0, Number(Store.state && Store.state.xp) || 0);
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
  // XP is a fact about a real learning action.  An empty/locked subject has
  // no action to reward; in particular, merely selecting it or rendering an
  // empty daily card must not manufacture progress.
  if (!Store.state || !subjectLearningAvailable()) return 0;
  amount = Math.max(0, Number(amount) || 0);
  if (!amount) return 0;
  const before = levelInfo().level;
  Store.state.xp += amount;
  const after = levelInfo().level;
  todayActivity().xp += amount;
  Store.save();
  if (after > before) {
    // Разовый бонус за каждый достигнутый уровень. Начисляем рекурсивно,
    // чтобы несколько подряд повышений тоже дали бонус за каждый уровень.
    for (let lv = before + 1; lv <= after; lv++) {
      addTimeline(`Новый уровень — Level ${lv}`);
      Store.state.xp += XP_LEVEL_MILESTONE;
      todayActivity().xp += XP_LEVEL_MILESTONE;
    }
    Store.save();
    Store.emit("levelup", { from: before, to: after, milestone: XP_LEVEL_MILESTONE * (after - before) });
  }
  Store.emit("xp", { amount, reason });
  return amount;
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
  const empty = { solved: 0, correct: 0, xp: 0 };
  if (!Store.state || !subjectLearningAvailable()) return empty;
  if (!Store.state.activity || typeof Store.state.activity !== "object") Store.state.activity = {};
  const key = todayStr();
  if (!Store.state.activity[key]) Store.state.activity[key] = { ...empty };
  return Store.state.activity[key];
}

function touchStreak() {
  const s = Store.state;
  if (!s || !subjectLearningAvailable()) return;
  const today = todayStr();
  if (s.lastActiveDate === today) return;
  s.streak = s.lastActiveDate === yesterdayStr() ? s.streak + 1 : 1;
  s.lastActiveDate = today;
  if (s.streak > 1) addTimeline(`Серия: ${s.streak} дн. подряд`);
}

/* ============================================================
   Навыки
   ============================================================ */

/* Освоение темы: теория (макс. 40) + практика (макс. 60).
   Теория: завершённый урок даёт полную долю; открытый, но незавершённый —
   пропорциональную (пройденные шаги / все шаги). Повторное открытие уже
   пройденного урока ничего не добавляет, сумма обрезана весом 40.
   Практика: у каждого доступного задания темы равная доля (60/N, где N —
   число решаемых заданий банка). Доля засчитывается сразу, как только
   задание решено верно, — многократное прохождение не требуется. Качество
   решения снижает долю (подсказки, долгое выполнение), но одна небольшая
   ошибка не обнуляет прогресс. Зачёт идемпотентен: лучшее решение каждого
   задания учитывается один раз, повторы сверх 60 не дают. */

/* Качество одного решения 0..1: только верный ответ без показанного решения
   даёт долю. Одна подсказка — небольшая скидка, разбор — заметная, неверные
   попытки до верного ответа — лёгкая скидка, долгое выполнение (>3 мин на
   задание) — лёгкий штраф. Неверный ответ и пропуск доли не дают (задание
   просто остаётся незакрытым, а не «минусует»). Единый источник истины для
   практики и мини-ошибок: quality < 1 <=> imperfectReason() != null. */
const PRACTICE_HINT1_QUALITY = 0.7;  // верный ответ с одной подсказкой
const PRACTICE_HINT2_QUALITY = 0.4;  // верный ответ с разбором (2 уровень)
const PRACTICE_ATTEMPTS_FACTOR = 0.85; // верный ответ после неверных попыток
const PRACTICE_LONG_SECONDS = 180;   // дольше — признак затруднений (3 мин)
const PRACTICE_LONG_FACTOR = 0.9;    // умеренный штраф за долгое выполнение

function practiceAttemptQuality(attempt) {
  if (!attempt || !attempt.correct) return 0;
  const hintLevel = Number(attempt.hintLevel) || 0;
  if (hintLevel >= 3) return 0; // показанный ответ засчитывается как нерешение
  let quality = hintLevel >= 2 ? PRACTICE_HINT2_QUALITY
    : hintLevel === 1 ? PRACTICE_HINT1_QUALITY : 1;
  if ((Number(attempt.wrongAttempts) || 0) > 0) quality *= PRACTICE_ATTEMPTS_FACTOR;
  const seconds = Number(attempt.seconds) || 0;
  if (seconds > PRACTICE_LONG_SECONDS) quality *= PRACTICE_LONG_FACTOR;
  return quality;
}

/* Полный банк практики навыка (реально решаемые задания, без требующих
   отсутствующего официального рисунка), стабильный порядок по id. Одно место,
   откуда сессии берут состав практики, — поэтому показ всегда полный. */
function practiceTaskIdsForSkill(skillId) {
  return DataAPI.practiceTasksBySkill(skillId).slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((task) => task.id);
}

/* Состав тренировки по миссии — все задания её темы, а не урезанная тройка
   из каталога. Старые записи missionProgress остаются валидны: задания
   каталога идут префиксом полного списка в том же порядке, поэтому позиция
   продолжения указывает на первое ещё не виденное задание. */
function missionPracticeIds(mission) {
  if (!mission || !subjectLearningAvailable()) return [];
  const full = practiceTaskIdsForSkill(mission.skill || mission.skillId);
  if (full.length) return full;
  // Старый mission.tasks допускается только если каждый ID реально
  // принадлежит доступному банку текущего предмета.  Сырой список без
  // каталога не превращаем в выдуманную практику.
  return Array.isArray(mission.tasks)
    ? mission.tasks.map((id) => typeof id === "object" ? (id.id || id.taskId) : id)
      .filter((id) => DataAPI.taskForAccess && DataAPI.taskForAccess(id)
        && String(DataAPI.taskForAccess(id).skill || DataAPI.taskForAccess(id).skillId) === String(mission.skill || mission.skillId))
    : [];
}

function missionPracticeCount(mission) {
  return missionPracticeIds(mission).length;
}

/* Теория 0..40: сумма долей уроков (завершён — 1, открыт — шаги/всего). */
function skillTheoryProgress(skillId) {
  if (!skillIsAccessible(skillId)) return 0;
  const lessons = DataAPI.lessonsBySkill(skillId);
  if (!lessons.length) return 0;
  let done = 0;
  const state = Store.state || {};
  const completed = safeObject(state.completedLessons);
  const sessions = safeObject(state.lessonSessions);
  for (const lesson of lessons) {
    if (completed[lesson.id]) { done += 1; continue; }
    const session = sessions[lesson.id];
    if (!session) continue;
    const total = DataAPI.lessonStepsCount(lesson);
    if (total > 0) done += Math.min(1, Math.max(0, (Number(session.idx) || 0) / total));
  }
  return Math.min(40, (done / lessons.length) * 40);
}

/* Практика: сумма лучших качеств по заданиям банка / N * вес. Без истории
   попыток — оценка по сводным счётчикам (тот же смысл: покрытие × точность),
   чтобы старые данные и внешние источники не давали ноль там, где работа была. */
function skillPracticeDetail(skillId) {
  if (!skillIsAccessible(skillId)) return { value: 0, weight: 0, bankSize: 0, distinctSolved: 0, qualitySum: 0 };
  const lessons = DataAPI.lessonsBySkill(skillId);
  const practiceWeight = lessons.length ? 60 : 100;
  const bank = DataAPI.practiceTasksBySkill(skillId);
  const bankSize = bank.length;
  if (!bankSize) return { value: 0, weight: practiceWeight, bankSize: 0, distinctSolved: 0, qualitySum: 0 };
  const inBank = new Set(bank.map((task) => dataIdValue(task.id)));
  const best = new Map();
  let hasHistory = false;
  const state = Store.state || {};
  for (const attempt of safeArray(state.taskAttempts)) {
    if (!attempt || dataIdValue(attempt.skill) !== dataIdValue(skillId)) continue;
    hasHistory = true;
    if (!inBank.has(dataIdValue(attempt.taskId))) continue;
    const quality = practiceAttemptQuality(attempt);
    const taskId = dataIdValue(attempt.taskId);
    if (quality > (best.get(taskId) || 0)) best.set(taskId, quality);
  }
  if (!hasHistory) {
    const stats = safeObject(state.skillStats && state.skillStats[skillId]);
    const accuracy = stats.solved ? Number(stats.correct) / Number(stats.solved) : 0;
    const solved = Math.max(0, Number(stats.solved) || 0);
    const value = Math.min(1, solved / bankSize) * accuracy * practiceWeight;
    return { value, weight: practiceWeight, bankSize, distinctSolved: 0, qualitySum: 0 };
  }
  let qualitySum = 0;
  for (const quality of best.values()) qualitySum += quality;
  const distinctSolved = best.size;
  const value = Math.min(practiceWeight, (qualitySum / bankSize) * practiceWeight);
  return { value, weight: practiceWeight, bankSize, distinctSolved, qualitySum };
}

function skillPracticeProgress(skillId) {
  return skillPracticeDetail(skillId).value;
}

function skillProgress(skillId) {
  const skill = skillIsAccessible(skillId) ? DataAPI.skill(skillId) : null;
  if (!skill) return 0;
  const theory = skillTheoryProgress(skillId);
  const practice = skillPracticeProgress(skillId);
  return Math.round(Math.min(100, theory + practice));
}

function skillProgressBreakdown(skillId) {
  const skill = skillIsAccessible(skillId) ? DataAPI.skill(skillId) : null;
  if (!skill) return { total: 0, theory: 0, practice: 0, lessonDone: 0, lessonTotal: 0, solved: 0, correct: 0, accuracy: 0 };
  const stats = safeObject(Store.state && Store.state.skillStats && Store.state.skillStats[skillId]);
  const lessons = DataAPI.lessonsBySkill(skillId);
  const completed = safeObject(Store.state && Store.state.completedLessons);
  const lessonDone = lessons.filter((lesson) => !!completed[lesson.id]).length;
  const accuracy = stats.solved ? stats.correct / stats.solved : 0;
  const theory = skillTheoryProgress(skillId);
  const practice = skillPracticeProgress(skillId);
  return { total: Math.round(Math.min(100, theory + practice)), theory: Math.round(theory), practice: Math.round(practice), lessonDone, lessonTotal: lessons.length, solved: stats.solved, correct: stats.correct, accuracy: Math.round(accuracy * 100) };
}

/* Сколько ещё верных решений нужно до целевого освоения (дефолт 90):
   -1 — одними новыми решениями не дотянуть (осталось мало незакрытых
   заданий — нужен повтор с лучшим качеством). Считается по той же формуле
   60/N, поэтому честно для любого размера банка. */
function practiceSolvesToTarget(skillId, target = 90) {
  const detail = skillPracticeDetail(skillId);
  const need = target - skillTheoryProgress(skillId) - detail.value;
  if (need <= 0) return 0;
  if (!detail.bankSize) return -1;
  const perTask = detail.weight / detail.bankSize;
  const remaining = Math.max(0, detail.bankSize - detail.distinctSolved);
  if (remaining * perTask < need) return -1;
  return Math.ceil(need / perTask);
}

function catProgress(catId) {
  if (typeof DataAPI.isTopicLocked === "function" && DataAPI.isTopicLocked(catId)) return 0;
  const wanted = typeof DataAPI._id === "function" ? DataAPI._id(catId) : String(catId || "");
  const skills = DataAPI.availableSkills().filter((s) => {
    const id = typeof DataAPI._skillCategoryId === "function" ? DataAPI._skillCategoryId(s) : (s.cat || s.topic || s.topicId);
    return String(id || "") === wanted;
  });
  if (!skills.length) return 0;
  return Math.round(skills.reduce((a, s) => a + skillProgress(s.id), 0) / skills.length);
}

/* ВРЕМЕННО закрытые темы профиля/базы — старый совместимый fallback.
   Новая блокировка всегда приходит из реестра предмета/темы, поэтому новый
   предмет не требует правки клиентского кода.  Объект намеренно имеет
   совместимый метод has(), которым пользуется существующий UI. */
const LEGACY_TEMP_LOCKED_SKILL_IDS = new Set(["n09_derivative", "b07_functions", "b09_grid"]);
const TEMP_LOCKED_SKILLS = {
  has(id) {
    const key = String(id || "");
    if (LEGACY_TEMP_LOCKED_SKILL_IDS.has(key)) return true;
    try {
      const skill = DataAPI.skill(key);
      return !!(skill && DataAPI.isSkillLocked && DataAPI.isSkillLocked(skill));
    } catch (_) { return false; }
  },
};

/* not-started | weak | in-progress | completed | mastered
   Topics are intentionally all available unless the registry marks them
   locked. The order in the path is a visual curriculum hint, not an access
   gate for an available topic. */
function skillStatus(skill) {
  if (!skill || !skillIsAccessible(skill.id) || TEMP_LOCKED_SKILLS.has(skill.id)) return "locked";
  const p = skillProgress(skill.id);
  const state = Store.state || {};
  const stats = safeObject(state.skillStats && state.skillStats[skill.id]);
  const solved = Number(stats.solved) || 0;
  if (p >= 90) return "mastered";
  if (p >= 70) return "completed";
  /* «Слабое место» — низкий прогресс при плохой точности. Тема, по которой
     мало, но стабильно верных ответов (в т.ч. одна верная диагностика) —
     просто «в процессе», а не проблема. */
  if (p < 35 && solved > 0 && Number(stats.correct) / solved < 0.6) return "weak";
  // Тему вообще не трогали: ни ответов, ни закрытого урока, ни открытого —
  // это не "слабое место" и не "в процессе", а честное "не начата".
  const lessons = DataAPI.lessonsBySkill(skill.id);
  const completed = safeObject(state.completedLessons);
  const sessions = safeObject(state.lessonSessions);
  const touchedLesson = lessons.some((l) => completed[l.id] || sessions[l.id]);
  if (solved === 0 && !touchedLesson) return "not-started";
  return "in-progress";
}

function openErrorCount(skillId) {
  if (!skillIsAccessible(skillId)) return 0;
  return safeArray(Store.state && Store.state.errors).reduce((n, e) => n + (!e.resolved && String(e.skill) === String(skillId) ? 1 : 0), 0);
}

/* «Требует внимания» — только реальные проблемы: открытые ошибки или плохая
   точность по теме, с которой уже работали. Тема, по которой ответы
   стабильно верные (в т.ч. одна верная диагностика), и тема, которую вообще
   не трогали, — не слабые места: низкий процент освоения сам по себе
   проблемой не является, это просто «ещё мало занимались». */
function skillNeedsAttention(skillId) {
  if (!skillIsAccessible(skillId)) return false;
  if (openErrorCount(skillId) > 0) return true;
  const stats = safeObject(Store.state && Store.state.skillStats && Store.state.skillStats[skillId]);
  if (!stats.solved) return false;
  return stats.correct / stats.solved < 0.6;
}

/* Задания в taskAttempts лежат в порядке unshift (новые первыми), поэтому
   цикл можно остановить на первой же записи старше окна. */
function recentlyPracticedSkillIds(withinMs) {
  const cutoff = Date.now() - withinMs;
  const ids = new Set();
  for (const a of safeArray(Store.state && Store.state.taskAttempts)) {
    if (Number(a.ts || 0) < cutoff) break;
    if (a && skillIsAccessible(a.skill)) ids.add(String(a.skill));
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
  const skills = (DataAPI.availableSkills ? DataAPI.availableSkills() : DataAPI.skills()).filter((s) => !TEMP_LOCKED_SKILLS.has(s.id));
  if (!skills.length) return null;
  const recent = opts.avoidRecentMs ? recentlyPracticedSkillIds(opts.avoidRecentMs) : null;
  const pool = recent ? skills.filter((s) => !recent.has(s.id)) : skills;
  const candidates = pool.length ? pool : skills;
  let worst = null;
  for (const s of candidates) {
    if (!skillIsAccessible(s.id) || TEMP_LOCKED_SKILLS.has(s.id)) continue;
    if (!worst) { worst = s; continue; }
    const a = skillProgress(s.id), b = skillProgress(worst.id);
    if (a < b) { worst = s; continue; }
    if (a > b) continue;
    // Равный прогресс: предпочитаем навык, по которому уже есть реальный
    // сигнал (ошибки, попытки), а не просто первый в каталоге — иначе на
    // старте (всё 0%) «слабейшим» всегда становится случайный первый навык.
    const aErr = openErrorCount(s.id), bErr = openErrorCount(worst.id);
    if (aErr !== bErr) { if (aErr > bErr) worst = s; continue; }
    const stateStats = safeObject(Store.state && Store.state.skillStats);
    const aSolved = Number(stateStats[s.id] && stateStats[s.id].solved) || 0;
    const bSolved = Number(stateStats[worst.id] && stateStats[worst.id].solved) || 0;
    if (aSolved > bSolved) worst = s;
  }
  return worst;
}

/* Последний незавершённый урок (по времени начала) — самое дешёвое
   следующее действие: доучить то, что уже начато, а не открывать новое. */
function mostRecentOpenLesson() {
  const sessions = safeObject(Store.state && Store.state.lessonSessions);
  let best = null;
  for (const lessonId of Object.keys(sessions)) {
    const lesson = DataAPI.lessonForAccess ? DataAPI.lessonForAccess(lessonId) : DataAPI.lesson(lessonId);
    if (!lesson) continue; // урок мог быть удалён/заблокирован после обновления
    const session = safeObject(sessions[lessonId]);
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
   Прогноз балла по фактическому прогрессу и истории ответов.
   Честная цепочка: освоение тем → взвешенное среднее → первичные
   баллы (0–32) → тестовая шкала ЕГЭ-2026. Никакого «базового»
   минимума за ноль знаний и никакой фиксированной вилки.
   ============================================================ */

/* Вес навыка = его цена в первичных баллах ЕГЭ-2026: часть 1 — по 1,
   часть 2 — по спецификации ФИПИ (13:2, 14:3, 15:2, 16:2, 17:3,
   18:4, 19:4; задание 19 покрывают два навыка — параметр и числа,
   по 2 каждый). Сумма всех весов = 32. */
const SKILL_EGE_WEIGHTS = {
  n01_planimetry: 1, n02_vectors: 1, n03_stereometry: 1, n04_probability: 1,
  n05_prob_theorems: 1, n06_random_var: 1, n07_equations: 1, n08_expressions: 1,
  n09_derivative: 1, n10_applied: 1, n11_word_problems: 1, n12_functions: 1,
  n14_trig_eq: 2, n15_stereometry: 3, n13_financial: 2, n18_planimetry: 2,
  n16_inequality: 3, n17_optimization: 4, n19_parameter: 2, n20_numbers: 2,
};
const TOTAL_EGE_PRIMARY = 32;

/* Шкала перевода первичных баллов в тестовые (ЕГЭ-2026, профиль).
   Значения 2, 16, 19 в опубликованной шкале пропущены — взяты
   линейной интерполяцией между соседями (помечены *). */
const PRIMARY_TO_TEST = [
  0, 6, 12, 17, 22, 27, 34, 40, 46, 52, 58, 64, 70, 72, 74, 76, 78,
  80, 82, 84, 86, 88, 90, 92, 94, 95, 96, 97, 98, 99, 100, 100, 100,
];

/* Затухание старых попыток: вес = exp(-возраст_дней / 45).
   Период полураспада ~31 день: ответ месяц назад весит вдвое меньше
   сегодняшнего, ответ двухмесячной давности — вчетверо. */
const FORECAST_DECAY_DAYS = 45;
/* Полное доверие практике — от 12 свежих попыток; дальше насыщение:
   10 лёгких подряд уже не дают «мастера», нужен объём посвежее. */
const FORECAST_FULL_VOLUME = 12;
/* Диагностический ответ — холодный экзаменационный образец: без подсказок,
   тренировочного контекста и повторов. Один верный диагностический ответ
   несёт больше свидетельства, чем рутинная попытка, поэтому в объёме прогноза
   засчитывается с этим весом. Без этого вклад диагностики (~1 попытка на
   навык против насыщения 12) тонул в округлении, и прогноз после онбординга
   с любыми верными ответами показывал 0 баллов. Диагностическая попытка
   опознаётся по паре taskId+ts из домена diagnostics — практика по тому же
   заданию ей не засчитывается. */
const FORECAST_DIAGNOSTIC_WEIGHT = 2;

function skillEgeWeight(skillId) {
  // Веса — конфиг текущего предмета (каталог: forecast.weights). Встроенный
  // профильный fallback оставлен только для старых payload без реестра;
  // новый предмет без собственного forecast не получает случайный вес.
  const skill = DataAPI.skill(skillId);
  if (!skill || !skillIsAccessible(skillId)) return 0;
  const cfg = (typeof DataAPI !== "undefined" && DataAPI.forecastConfig && DataAPI.forecastConfig()) || null;
  const weights = cfg && cfg.weights && typeof cfg.weights === "object" ? cfg.weights : null;
  if (weights && Object.prototype.hasOwnProperty.call(weights, skillId)) {
    const value = Number(weights[skillId]);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }
  if (cfg) return 0; // не переносим part1/part2 эвристику на другой предмет
  if (!(typeof DataAPI.isLegacySubject === "function" && DataAPI.isLegacySubject())) return 0;
  const legacyWeights = SKILL_EGE_WEIGHTS;
  if (Object.prototype.hasOwnProperty.call(legacyWeights, String(skillId))) return Number(legacyWeights[skillId]) || 0;
  return String(skill.cat || "") === "part2" ? 2 : 1;
}

function forecastScale() {
  const cfg = (typeof DataAPI !== "undefined" && DataAPI.forecastConfig && DataAPI.forecastConfig()) || null;
  if (cfg && Array.isArray(cfg.scale) && cfg.scale.length) return cfg.scale;
  return (typeof DataAPI.isLegacySubject === "function" && DataAPI.isLegacySubject()) ? PRIMARY_TO_TEST : [];
}

function forecastTotal() {
  const cfg = (typeof DataAPI !== "undefined" && DataAPI.forecastConfig && DataAPI.forecastConfig()) || null;
  if (cfg && Number(cfg.total) > 0) return Number(cfg.total);
  return (typeof DataAPI.isLegacySubject === "function" && DataAPI.isLegacySubject()) ? TOTAL_EGE_PRIMARY : 0;
}

function forecastConfigAvailable() {
  // Пустой/locked предмет или предмет без реального контента не получает
  // нулевой «прогноз»: это отсутствие данных, а не результат 0. Для старого
  // raw-каталога профиля сохраняем встроенный fallback ради совместимости.
  if (typeof DataAPI === "undefined" || !DataAPI.ready()) return false;
  if (typeof DataAPI.isSubjectLocked === "function" && DataAPI.isSubjectLocked()) return false;
  if (typeof DataAPI.hasLearningContent === "function" && !DataAPI.hasLearningContent()) return false;
  if (typeof DataAPI.forecastConfig === "function" && DataAPI.forecastConfig()) return true;
  return typeof DataAPI.isLegacySubject === "function" && DataAPI.isLegacySubject();
}

/* Освоение темы глазами прогноза: та же шкала 0–100, что у
   skillProgress (40 теория + 60 практика), но практика считается по
   затухающим по давности попыткам, а не за всё время. Если живых
   попыток нет (старые аккаунты, тестовые фикстуры) — откат к
   суммарной статистике, чтобы не показывать ноль там, где работа была. */
function forecastSkillMastery(skillId, now) {
  const skill = skillIsAccessible(skillId) ? DataAPI.skill(skillId) : null;
  if (!skill) return 0;
  const state = Store.state || {};
  const completed = safeObject(state.completedLessons);
  const lessons = DataAPI.lessonsBySkill(skillId);
  const lessonDone = lessons.filter((lesson) => !!completed[lesson.id]).length;
  const theoryWeight = lessons.length ? 40 : 0;
  const practiceWeight = 100 - theoryWeight;
  const theory = lessons.length ? (lessonDone / lessons.length) * theoryWeight : 0;

  const ts = Number(now) || Date.now();
  const diagKeys = new Set();
  for (const d of safeArray(state.diagnostics)) {
    if (d && d.taskId) diagKeys.add(`${d.taskId}|${Number(d.ts) || 0}`);
  }
  let vol = 0, good = 0, seen = false;
  for (const a of safeArray(state.taskAttempts)) {
    if (!a || dataIdValue(a.skill) !== dataIdValue(skillId)) continue;
    seen = true;
    const ageDays = Math.max(0, (ts - (Number(a.ts) || 0)) / 86400000);
    const w = Math.exp(-ageDays / FORECAST_DECAY_DAYS);
    const dw = diagKeys.has(`${a.taskId}|${Number(a.ts) || 0}`) ? FORECAST_DIAGNOSTIC_WEIGHT : 1;
    vol += dw * w;
    if (a.correct) good += dw * w;
  }
  let accuracy, volume;
  if (seen) {
    accuracy = vol > 0 ? good / vol : 0;
    volume = vol;
  } else {
    const stats = safeObject(state.skillStats && state.skillStats[skillId]);
    accuracy = stats.solved ? Number(stats.correct) / Number(stats.solved) : 0;
    volume = Number(stats.solved) || 0;
  }
  const factor = Math.min(1, volume / FORECAST_FULL_VOLUME);
  const practice = factor * accuracy * practiceWeight;
  return Math.round(Math.min(100, theory + practice));
}

function forecast() {
  if (!forecastConfigAvailable()) return { low: 0, high: 0, mid: 0, primary: 0, mastery: 0, hw: 0, empty: true };
  const scale = forecastScale(), total = forecastTotal();
  const skills = (DataAPI.availableSkills ? DataAPI.availableSkills() : DataAPI.skills())
    .filter((s) => skillEgeWeight(s.id) > 0);
  if (!skills.length) return { low: 0, high: 0, mid: 0, primary: 0, mastery: 0, hw: 0, empty: true };
  const now = Date.now();
  const state = Store.state || {};
  const attemptedSkills = new Set(safeArray(state.taskAttempts).map((a) => a && a.skill).filter(Boolean));
  let wSum = 0, wMastery = 0, covered = 0;
  const masteryById = {};
  for (const s of skills) {
    const w = skillEgeWeight(s.id);
    const m = forecastSkillMastery(s.id, now);
    masteryById[s.id] = m;
    wSum += w;
    wMastery += w * m;
    const lessons = DataAPI.lessonsBySkill(s.id);
    const hasLesson = lessons.some((l) => !!safeObject(state.completedLessons)[l.id]);
    if (hasLesson || masteryById[s.id] >= 25 || attemptedSkills.has(s.id)) covered++;
  }
  const mastery = wSum ? wMastery / wSum : 0;
  const primary = (mastery / 100) * total;
  const mid = scale[Math.max(0, Math.min(scale.length - 1, Math.round(primary)))] ?? 0;
  /* Живой диапазон: мало данных — широко (±12), всё покрыто — узко (±3). */
  const hw = 12 - Math.round((9 * covered) / skills.length);
  return {
    low: Math.max(0, mid - hw),
    // Потолок диапазона — максимум шкалы предмета (профиль: 100, база: 21),
    // иначе сильному ученику базы показало бы «18–24» при максимуме 21.
    high: Math.min(scale[scale.length - 1] ?? 100, mid + hw),
    mid,
    primary: Math.round(primary * 10) / 10,
    mastery: Math.round(mastery * 10) / 10,
    hw,
  };
}

/* «Что даст +N»: какой прирост тестового балла принесёт полное
   закрытие каждой темы. Считается через ту же цепочку
   (взвешенное среднее → первичные → шкала), поэтому вес второй
   части честно выше, чем первой. */
function forecastTopGains(n = 3) {
  if (!forecastConfigAvailable()) return [];
  const scale = forecastScale(), total = forecastTotal();
  const skills = (DataAPI.availableSkills ? DataAPI.availableSkills() : DataAPI.skills())
    .filter((s) => skillEgeWeight(s.id) > 0);
  if (!skills.length) return [];
  const now = Date.now();
  const base = forecast();
  let wSum = 0, wMastery = 0;
  const masteryById = {};
  for (const s of skills) {
    const w = skillEgeWeight(s.id);
    const m = forecastSkillMastery(s.id, now);
    masteryById[s.id] = m;
    wSum += w;
    wMastery += w * m;
  }
  if (!wSum) return [];
  const gains = [];
  for (const s of skills) {
    const m = masteryById[s.id];
    if (m >= 100) continue;
    const w = skillEgeWeight(s.id);
    const mastery = (wMastery + w * (100 - m)) / wSum;
    const primary = (mastery / 100) * total;
    const test = scale[Math.max(0, Math.min(scale.length - 1, Math.round(primary)))] ?? 0;
    const gain = test - base.mid;
    if (gain > 0) gains.push({ skillId: s.id, name: s.name, gain });
  }
  return gains.sort((a, b) => b.gain - a.gain).slice(0, Math.max(0, n));
}

/* Снимок обновляется в течение текущего дня, а дни прошлого остаются
   фактической историей. Никакой синтетической линии на графике нет. */
function recordForecastSnapshot() {
  if (!Store.state || !forecastConfigAvailable()) return null;
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
  if (!Store.state || !forecastConfigAvailable()) return [];
  const from = new Date(Date.now() - (days - 1) * 86400000);
  const cutoff = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, "0")}-${String(from.getDate()).padStart(2, "0")}`;
  return safeArray(Store.state.forecastHistory).filter((x) => x && x.date >= cutoff).sort((a, b) => a.date.localeCompare(b.date));
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
  // Задачи с несколькими верными вариантами (например, «запишите какой-нибудь
  // один набор»): поле accept перечисляет все допустимые ответы из условия.
  // Без него поведение прежнее — задания профиля его не несут.
  const candidates = [expected, ...((Array.isArray(task.accept) ? task.accept : []).map(String))];
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
    return candidates.some((cand) => sameValue(cand, inputParts[0]));
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
  return safeArray(Store.state && Store.state.dailyHistory);
}

function dailyTaskIdsForDate(date) {
  const item = dailyHistory().find((entry) => entry.date === date);
  return item && Array.isArray(item.taskIds) ? item.taskIds : [];
}

function dailyCandidateScore(task, historyIds, now) {
  const state = Store.state || {};
  const stats = safeObject(state.skillStats && state.skillStats[task.skill]);
  const attempts = safeArray(state.taskAttempts).filter((item) => item && String(item.taskId) === String(task.id));
  const recentAttempts = attempts.filter((item) => now - Number(item.ts || 0) < 14 * 86400000);
  const recentErrors = safeArray(state.errors).filter((item) => item && String(item.taskId) === String(task.id) && !item.resolved).length;
  const accuracy = stats.solved ? stats.correct / stats.solved : 0;
  const mastery = skillProgress(task.skill);
  const coldStart = !state.totalSolved && !safeArray(state.taskAttempts).length && !safeArray(state.errors).length;
  let score = 0;
  score += recentErrors * 8;
  score += Math.max(0, 1 - accuracy) * 5;
  score += Math.max(0, 3 - Math.min(3, recentAttempts.length)) * 2;
  // A new user gets approachable tasks; an active user gets a modest
  // difficulty lift while weak skills and unresolved errors stay first.
  score += coldStart ? (4 - task.diff) * 2 : task.diff * 0.6;
  score += Math.max(0, 100 - mastery) * 0.04;
  if (historyIds.has(dataIdValue(task.id))) score -= 18;
  if (recentAttempts[0] && now - Number(recentAttempts[0].ts || 0) < 86400000) score -= 12;
  return score;
}

function selectDailyTaskIds(date) {
  if (!subjectLearningAvailable()) return [];
  const daily = DataAPI.daily();
  const target = Math.max(0, Math.floor(Number(daily.target) || 0));
  if (!target) return [];
  const pool = DataAPI.practiceTasks().filter((task) => task && task.id && task.skill);
  if (!pool.length) return [];
  const historyIds = new Set(dailyHistory().flatMap((entry) => safeArray(entry && entry.taskIds).map(dataIdValue)));
  const now = Date.now();
  const ranked = pool.map((task) => ({ task, score: dailyCandidateScore(task, historyIds, now) }))
    .sort((a, b) => b.score - a.score || String(a.task.id).localeCompare(String(b.task.id)));
  const selected = ranked.filter((item) => !historyIds.has(dataIdValue(item.task.id))).slice(0, target).map((item) => item.task.id);
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
  if (!subjectLearningAvailable()) {
    // Не создаём даже пустую запись Daily для locked/empty предмета.
    Store.state.daily = { date: null, solved: 0, done: false, taskIds: [] };
    Store.state.dailyHistory = [];
    return;
  }
  const date = dailyDateKey();
  const state = Store.state;
  state.daily = safeObject(state.daily);
  state.daily.taskIds = safeArray(state.daily.taskIds).filter((id) => DataAPI.taskForAccess && DataAPI.taskForAccess(id));
  if (state.daily.date === date && state.daily.taskIds.length) {
    if (!Array.isArray(state.daily.countedTaskIds)) {
      const selected = new Set(state.daily.taskIds.map(String));
      state.daily.countedTaskIds = Array.from(new Set(safeArray(state.taskAttempts)
        .filter((attempt) => attempt && attempt.correct && dateKeyForTimestamp(attempt.ts) === date && selected.has(String(attempt.taskId)))
        .map((attempt) => String(attempt.taskId))));
      state.daily.solved = Math.max(Number(state.daily.solved) || 0, state.daily.countedTaskIds.length);
    }
    return;
  }
  const existing = dailyHistory().find((entry) => entry && entry.date === date);
  if (existing && Array.isArray(existing.taskIds) && existing.taskIds.length) {
    const current = state.daily.date === date ? state.daily : {};
    state.daily = Object.assign({ date, solved: 0, done: false, taskIds: [] }, existing, current);
    state.daily.taskIds = state.daily.taskIds.filter((id) => DataAPI.taskForAccess && DataAPI.taskForAccess(id));
    if (!state.daily.taskIds.length) {
      state.daily = { date, solved: 0, done: false, taskIds: [] };
      return;
    }
    const selected = new Set(state.daily.taskIds.map(String));
    const counted = new Set(safeArray(state.taskAttempts)
      .filter((attempt) => attempt && attempt.correct && dateKeyForTimestamp(attempt.ts) === date && selected.has(String(attempt.taskId)))
      .map((attempt) => String(attempt.taskId)));
    state.daily.countedTaskIds = Array.from(counted);
    state.daily.solved = Math.max(Number(state.daily.solved) || 0, counted.size);
    existing.solved = state.daily.solved;
    existing.done = !!state.daily.done;
    existing.countedTaskIds = state.daily.countedTaskIds;
    state.daily.done = state.daily.solved >= state.daily.taskIds.length;
    return;
  }
  const selectedIds = selectDailyTaskIds(date);
  if (!selectedIds.length) {
    state.daily = { date, solved: 0, done: false, taskIds: [] };
    state.dailyHistory = dailyHistory().filter((entry) => !entry || entry.date !== date);
    return;
  }
  state.daily = { date, solved: 0, done: false, taskIds: selectedIds };
  state.dailyHistory = dailyHistory().filter((entry) => !entry || entry.date !== date);
  state.dailyHistory.unshift(state.daily);
  state.dailyHistory = state.dailyHistory.slice(0, 30);
  Store.save();
}

function dailyTaskIds() {
  ensureDailyChallenge();
  return safeArray(Store.state && Store.state.daily && Store.state.daily.taskIds);
}

/* ============================================================
   Запись результата ответа — центральная точка игровой логики
   hintLevel: 0 — без помощи, 1 — подсказка, 2 — разбор,
   3 — ответ показан (задание считается нерешённым)
   wrongAttempts — неверные попытки до верного ответа в этой сессии
   (счётчик Session.attempts); 0 по умолчанию для старых вызовов.
   Верное, но неидеальное решение (подсказка/попытки/время) фиксируется
   мини-ошибкой (kind 'minor', upsert по task_id — без дублей), а чистое
   повторное решение закрывает её обычным путём. Полная ошибка (major)
   закрывается любым верным ответом, как раньше.
   ============================================================ */

function recordAnswer(task, correct, hintLevel, seconds, closesTaskId, wrongAttempts) {
  const s = Store.state;
  const taskRef = task && typeof task === "object" ? task.id : task;
  const canonical = task && DataAPI.taskForAccess ? DataAPI.taskForAccess(taskRef) : null;
  if (!s || !canonical || !subjectLearningAvailable()) return 0;
  task = canonical;
  const skillId = String(task.skill || task.skillId || "");
  if (!skillId || !skillIsAccessible(skillId)) return 0;
  hintLevel = Math.max(0, Math.min(3, Number(hintLevel) || 0));
  wrongAttempts = Math.max(0, Number(wrongAttempts) || 0);
  seconds = Math.max(0, Number(seconds) || 0);
  if (hintLevel >= 3) correct = false; // посмотрел ответ = не решил сам
  s.taskAttempts = safeArray(s.taskAttempts);
  s.errors = safeArray(s.errors);
  s.skillStats = safeObject(s.skillStats);
  s.hintLevels = safeObject({ 1: 0, 2: 0, 3: 0, ...s.hintLevels });
  touchStreak();

  // Задание уже решалось верно раньше: за XP «решение задания» больше не
  // платим (иначе один и тот же ответ можно сдавать повторно бесконечно),
  // но если это закрывает открытую ошибку — тот бонус отдельный (см. ниже).
  const alreadyMastered = correct && s.taskAttempts.some((a) => a && String(a.taskId) === String(task.id) && a.correct);

  s.taskAttempts.unshift({
    id: newEntityId(),
    taskId: task.id,
    skill: skillId,
    correct: !!correct,
    hintLevel,
    wrongAttempts: correct ? wrongAttempts : 0,
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

  const st = s.skillStats[skillId] || (s.skillStats[skillId] = { progress: 0, solved: 0, correct: 0, timeSec: 0 });
  st.solved++;
  st.timeSec += seconds || 0;

  const act = todayActivity();
  act.solved++;

  let xp = 0;
  let xpBreakdown = { attempt: 0, correctBonus: 0, errorResolved: 0 };
  if (correct) {
    s.totalCorrect++;
    st.correct++;
    act.correct++;
    s.correctSeries++;
    s.bestSeries = Math.max(s.bestSeries, s.correctSeries);
    const parts = attemptXp(task, true, hintLevel, alreadyMastered);
    xp = parts.total;
    xpBreakdown = { attempt: parts.attempt, correctBonus: parts.correctBonus, errorResolved: 0 };
    st.progress = skillProgress(skillId);

    /* закрытие ошибки: по этому заданию или по исходному заданию,
       которое оно заменяет в повторении (умное повторение) */
    /* В умном повторении приоритет у исходной ошибки. Это важно, когда
       похожее задание само тоже было в списке ошибок: один ответ должен
       закрыть именно тот пункт, для которого он был подобран. */
    /* Полная ошибка закрывается любым верным ответом (как раньше), а
       мини-ошибка — только качественным: неидеальное решение оставляет её
       открытой до чистого прохода. */
    const imperfect = imperfectReason(task, hintLevel, wrongAttempts, seconds);
    const err = (closesTaskId ? s.errors.find((e) => e && String(e.taskId) === String(closesTaskId) && !e.resolved) : null)
      || s.errors.find((e) => e && String(e.taskId) === String(task.id) && !e.resolved);
    if (err && (errorKindOf(err) === "major" || !imperfect)) {
      err.resolved = true;
      s.errorsResolved++;
      xp += XP_ERROR_RESOLVED;
      xpBreakdown.errorResolved += XP_ERROR_RESOLVED;
      addTimeline(`Закрыта ошибка: ${task.sub}`);
    } else if (err) {
      err.ts = Date.now();
    }
    // Решено, но неидеально — мини-ошибка. Upsert по task_id: если открытая
    // запись уже есть, дубль не создаём. Качественное повторное решение
    // закроет её обычным путём выше.
    if (imperfect && !s.errors.some((e) => e && String(e.taskId) === String(task.id) && !e.resolved)) {
      s.errors.unshift({ clientId: newEntityId(), taskId: task.id, skill: skillId, sub: task.sub, ts: Date.now(), resolved: false, kind: "minor" });
    }
  } else {
    s.correctSeries = 0;
    // За сам факт попытки платим минимум — практика никогда не даёт +0 XP.
    xp = attemptXp(task, false, hintLevel, false).total;
    xpBreakdown = { attempt: xp, correctBonus: 0, errorResolved: 0 };
    // Неверный ответ остаётся сигналом для повторения, но не отнимает уже
    // заработанный прогресс: ошибка — нормальная часть обучения.
    // Upsert по task_id: повторный провал не плодит дубли одного задания, а
    // открытая мини-ошибка апгрейдится до полной.
    const open = s.errors.find((e) => e && String(e.taskId) === String(task.id) && !e.resolved);
    if (!open) {
      s.errors.unshift({ clientId: newEntityId(), taskId: task.id, skill: skillId, sub: task.sub, ts: Date.now(), resolved: false, kind: "major" });
    } else if (errorKindOf(open) === "minor") {
      open.kind = "major";
      open.ts = Date.now();
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
  s.daily = safeObject(s.daily);
  const countedIds = safeArray(s.daily.countedTaskIds);
  if (correct && !s.daily.done && selectedIds.some((id) => String(id) === String(task.id)) && !countedIds.some((id) => String(id) === String(task.id))) {
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
  Store.emit("answer", { task, correct, xp, xpBreakdown });
  // Разбивка доступна сессии синхронно, без подписки на событие.
  Store._lastXpBreakdown = xpBreakdown;
  return xp;
}

/* ============================================================
   Ошибки шагов уроков → профиль навыков
   ============================================================ */

function recordLessonStepError(lessonId, stepId, skillId, errorType = "Неуточнённая ошибка") {
  const s = Store.state;
  const lesson = DataAPI.lessonForAccess ? DataAPI.lessonForAccess(lessonId) : DataAPI.lesson(lessonId);
  const canonicalSkill = String((lesson && (lesson.skill || lesson.skillId)) || skillId || "");
  if (!s || !subjectLearningAvailable() || !lesson || !skillIsAccessible(canonicalSkill)) return false;
  if (skillId && String(skillId) !== canonicalSkill) return false;
  const key = `${lessonId}:${stepId}`;
  s.lessonStepErrors = safeObject(s.lessonStepErrors);
  s.lessonErrorHistory = safeArray(s.lessonErrorHistory);
  const cur = s.lessonStepErrors[key] || { count: 0, skill: canonicalSkill, ts: 0, types: {} };
  cur.count = (Number(cur.count) || 0) + 1;
  cur.skill = canonicalSkill;
  cur.ts = Date.now();
  cur.types = safeObject(cur.types);
  cur.types[errorType] = (Number(cur.types[errorType]) || 0) + 1;
  s.lessonStepErrors[key] = cur;
  // Это история существующего механизма ошибок, а не отдельная система оценки.
  s.lessonErrorHistory.unshift({ id: newEntityId(), lessonId, stepId, skill: canonicalSkill, type: errorType, ts: cur.ts });
  s.lessonErrorHistory = s.lessonErrorHistory.slice(0, 200);
  // Ошибка нужна для персонального повторения, а не как штраф к прогрессу.
  recordForecastSnapshot();
  Store.save();
  return true;
}

function clearLessonStepError(lessonId, stepId) {
  if (!Store.state) return false;
  const key = `${lessonId}:${stepId}`;
  Store.state.lessonStepErrors = safeObject(Store.state.lessonStepErrors);
  if (!(key in Store.state.lessonStepErrors)) return false;
  delete Store.state.lessonStepErrors[key];
  if (!Store.deletedLessonStepErrors.includes(key)) Store.deletedLessonStepErrors.push(key);
  Store.save();
  return true;
}

function lessonStepErrorsBySkill(skillId) {
  if (!skillIsAccessible(skillId)) return [];
  return Object.entries(safeObject(Store.state && Store.state.lessonStepErrors))
    .filter(([, v]) => v && String(v.skill) === String(skillId))
    .map(([key, v]) => ({ key, ...v }));
}

function completeLesson(lesson, inputXp, result = {}) {
  const s = Store.state;
  const lessonRef = lesson && typeof lesson === "object" ? lesson.id : lesson;
  const canonical = DataAPI.lessonForAccess ? DataAPI.lessonForAccess(lessonRef) : DataAPI.lesson(lessonRef);
  if (!s || !canonical || !subjectLearningAvailable() || !skillIsAccessible(canonical.skill || canonical.skillId)) {
    return { firstCompletion: false, totalXp: 0, baseXp: 0, stepsXp: 0 };
  }
  lesson = canonical;
  result = safeObject(result);
  const lessonId = String(lesson.id);
  const skillId = String(lesson.skill || lesson.skillId || "");
  s.completedLessons = safeObject(s.completedLessons);
  s.lessonAttempts = safeArray(s.lessonAttempts);
  const firstCompletion = !s.completedLessons[lessonId];
  touchStreak();

  if (!firstCompletion) {
    s.lessonAttempts.unshift({
      id: newEntityId(),
      lessonId,
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
    return { firstCompletion, totalXp: 0, baseXp: 0, stepsXp: 0 };
  }

  // Награда за урок = базовая за тему (из каталога) + XP за шаги. Флаг
  // firstCompletion в lessonAttempts больше не несёт нагрузки анти-фарма:
  // сервер derive_stats считает по completedLessons, которое нельзя
  // подделать повторной отправкой (PK user_id+lesson_id).
  const baseXp = Math.max(0, Number(lesson.xp) || 0);
  const stepsXp = Math.max(0, Number(inputXp) || 0);
  const totalXp = baseXp + stepsXp;
  s.completedLessons[lessonId] = { ts: Date.now() };
  s.lessonAttempts.unshift({
    id: newEntityId(),
    lessonId,
    completed: true,
    firstCompletion: true,
    xp: totalXp,
    wrongAttempts: Number(result.wrongAttempts) || 0,
    durationSec: Number(result.durationSec) || 0,
    ts: Date.now(),
  });
  s.lessonAttempts = s.lessonAttempts.slice(0, 1000);
  addXp(totalXp, "lesson");
  const st = s.skillStats[skillId] || (s.skillStats[skillId] = { progress: 0, solved: 0, correct: 0, timeSec: 0 });
  st.progress = skillProgress(skillId);
  recordForecastSnapshot();
  addTimeline(`Урок пройден: «${lesson.title}»`);
  Store.save();
  checkAchievements();
  return { firstCompletion, totalXp, baseXp, stepsXp };
}

/* ============================================================
   Миссии / боссы
   ============================================================ */

function missionProgress(mission) {
  if (!mission || !Store.state) return 0;
  const canonical = DataAPI.missionForAccess ? DataAPI.missionForAccess(mission.id || mission) : DataAPI.mission(mission.id);
  if (!canonical) return 0;
  return Math.max(0, Number(Store.state.missionProgress && Store.state.missionProgress[canonical.id]) || 0);
}

function completeMission(mission) {
  const missionRef = mission && typeof mission === "object" ? mission.id : mission;
  const canonical = DataAPI.missionForAccess ? DataAPI.missionForAccess(missionRef) : DataAPI.mission(missionRef);
  if (!canonical || !Store.state || !subjectLearningAvailable() || !missionPracticeIds(canonical).length) return false;
  Store.state.missionsDone = safeObject(Store.state.missionsDone);
  if (Store.state.missionsDone[canonical.id]) return false;
  Store.state.missionsDone[canonical.id] = { ts: Date.now() };
  addTimeline(`Миссия завершена: «${canonical.title || "Тренировка"}»`);
  addXp(canonical.xp, "mission");
  Store.emit("missiondone", canonical);
  Store.save();
  return true;
}

function bossUnlocked(boss) {
  const canonical = DataAPI.bosses().find((item) => String(item.id) === String(boss && (boss.id || boss)));
  if (!canonical || !subjectLearningAvailable()) return false;
  const cat = String(canonical.cat || canonical.category || "");
  return !!cat && !DataAPI.isTopicLocked(cat) && catProgress(cat) >= Math.max(0, Number(canonical.unlockAt) || 0);
}

function bossDefeated(boss) {
  return !!(Store.state && safeArray(Store.state.bossesDefeated).some((id) => String(id) === String(boss && (boss.id || boss))));
}

function defeatBoss(boss) {
  const canonical = DataAPI.bosses().find((item) => String(item.id) === String(boss && (boss.id || boss)));
  if (!canonical || !Store.state || !bossUnlocked(canonical) || bossDefeated(canonical)) return false;
  Store.state.bossesDefeated = safeArray(Store.state.bossesDefeated);
  Store.state.skillStats = safeObject(Store.state.skillStats);
  Store.state.bossesDefeated.push(canonical.id);
  addTimeline(`Босс повержен: ${String(canonical.title || "Босс").replace("БОСС: ", "")}`);
  addXp(canonical.xp, "boss");
  /* рывок навыков ветки */
  const cat = String(canonical.cat || canonical.category || "");
  for (const s of DataAPI.availableSkills().filter((x) => String(DataAPI._skillCategoryId(x)) === cat)) {
    const st = Store.state.skillStats[s.id] || (Store.state.skillStats[s.id] = { progress: 0, solved: 0, correct: 0, timeSec: 0 });
    st.progress = skillProgress(s.id);
  }
  recordForecastSnapshot();
  Store.save();
  checkAchievements();
  return true;
}

/* ============================================================
   Достижения
   ============================================================ */

function achievementUnlocked(id) {
  return !!(Store.state && Store.state.achievements && Store.state.achievements[id]);
}

function unlockAchievement(id) {
  const a = DataAPI.achievements().find((x) => String(x.id) === String(id));
  if (!a || achievementUnlocked(id) || !Store.state) return false;
  Store.state.achievements = safeObject(Store.state.achievements);
  Store.state.achievements[id] = { ts: Date.now() };
  addTimeline(`Достижение: «${a.name || id}»`);
  Store.save();
  Store.emit("achievement", a);
  return true;
}

function checkAchievements() {
  const s = Store.state;
  if (!s || !subjectLearningAvailable()) return;
  const hasAchievement = (id) => DataAPI.achievements().some((a) => String(a.id) === String(id));
  // totalSolved counts every attempt; badges explicitly tied to correct
  // answers are checked against totalCorrect, as before.
  if (s.totalCorrect >= 1) unlockAchievement("first-solve");
  if (s.totalCorrect >= 100) unlockAchievement("hundred");
  if (s.correctSeries >= 20) unlockAchievement("series20");
  if (s.errorsResolved >= 10) unlockAchievement("comeback");
  if (s.streak >= 7) unlockAchievement("streak7");
  if (safeArray(s.bossesDefeated).length >= 1) unlockAchievement("boss1");
  // Subject-specific mastery badges are opt-in: an achievement id absent
  // from this subject's registry is never created just because a profile
  // catalog happened to define it.
  const all = DataAPI.availableSkills();
  if (hasAchievement("basic_master") && all.length
      && Math.round(all.reduce((a, sk) => a + skillProgress(sk.id), 0) / all.length) >= 80) {
    unlockAchievement("basic_master");
  }
  if (hasAchievement("part1_master") && catProgress("part1") >= 80) unlockAchievement("part1_master");
}

function addTimeline(text) {
  // Timeline — производная от реальных учебных действий. Выбор locked
  // предмета не должен оставлять локальную «историю», которая выглядит как
  // пройденнаяactivity, но никогда не сохраняется сервером.
  if (!Store.state || !subjectLearningAvailable()) return;
  Store.state.timeline = safeArray(Store.state.timeline);
  Store.state.timeline.unshift({ id: newEntityId(), ts: Date.now(), text });
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
  const s = Store.state || {};
  const skill = DataAPI.skill(skillId);
  if (!skill || !skillIsAccessible(skillId)) return null;
  const stats = safeObject(s.skillStats && s.skillStats[skillId]);
  const now = Date.now();
  const cutoff = now - NEXTSTEP_FATIGUE_WINDOW_MS;
  let recent = 0, recentCorrect = 0, lastTs = 0;
  for (const a of safeArray(s.taskAttempts)) {
    if (!a || String(a.skill) !== String(skillId)) continue;
    const ts = Number(a.ts) || 0;
    if (ts > lastTs) lastTs = ts;
    if (ts >= cutoff) { recent++; if (a.correct) recentCorrect++; }
  }
  const lessons = DataAPI.lessonsBySkill(skillId);
  const lesson = lessons[0] || null;
  const completed = safeObject(s.completedLessons);
  const sessions = safeObject(s.lessonSessions);
  const lessonDone = lessons.length > 0 && lessons.every((l) => !!completed[l.id]);
  const solved = Math.max(0, Number(stats.solved) || 0);
  const correct = Math.max(0, Number(stats.correct) || 0);
  const diagnosticMisses = safeArray(s.diagnostics).filter((d) => {
    const task = DataAPI.task(d && d.taskId);
    return task && String(task.skill || task.skillId) === String(skillId) && !d.correct;
  }).length;
  const mission = DataAPI.missions().find((m) => String(m.skill) === String(skillId) && missionPracticeIds(m).length) || null;
  return {
    progress: skillProgress(skillId),
    solved,
    accuracy: solved ? correct / solved : null,
    recent,
    recentAccuracy: recent ? recentCorrect / recent : null,
    fatigued: recent >= NEXTSTEP_FATIGUE_TASKS,
    ageMs: lastTs ? now - lastTs : Infinity,
    openErrors: openErrorCount(skillId),
    stepErrors: lessonStepErrorsBySkill(skillId).length,
    lesson,
    lessonDone,
    lessonOpen: lessons.some((l) => sessions[l.id]),
    diagnosticMisses,
    mission,
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
  // Пустой/locked предмет или реестр без доступного контента: рекомендовать
  // нечего — экран показывает заглушку, а не действие с нулевым XP.
  if (!Store.state || !subjectLearningAvailable()) return [];
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
      reason: `Урок уже начат и сохранён на шаге ${Math.min((openLesson.session.idx || 0) + 1, DataAPI.lessonStepsCount(openLesson.lesson))} из ${DataAPI.lessonStepsCount(openLesson.lesson)} — закончить начатое дешевле всего.`,
      score: 92,
    });
  }

  /* Снимки по всем навыкам — основа остальных кандидатов. */
  const snaps = {};
  for (const sk of (DataAPI.availableSkills ? DataAPI.availableSkills() : DataAPI.skills())) {
    const snapshot = skillSnapshot(sk.id);
    if (snapshot) snaps[sk.id] = snapshot;
  }
  const mentionedSkills = () => Object.keys(snaps).filter((id) => mentioned.has(id));

  /* 2. Повторение слабых мест: накопленные открытые ошибки — самый
     конкретный сигнал пробела. Свежие ошибки «на горячую» не гоняем по
     кругу: если их навык только что интенсивно тренировался и всё равно
     проседает, полезнее вернуться к теории (кандидат ниже). */
  const openErrors = safeArray(s.errors).filter((e) => e && !e.resolved && snaps[e.skill]);
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
    const pool = (DataAPI.availableSkills ? DataAPI.availableSkills() : DataAPI.skills()).filter((sk) => {
      const snap = snaps[sk.id];
      if (!snap || !snap.lesson || mentioned.has(sk.id)) return false;
      if (!snap.lessonDone) return true;
      // Пол пройденного урока — 40 теории, зазор 15 очков практики поверх.
      return snap.progress < 55 && snap.accuracy !== null && snap.accuracy < 0.5;
    });
    const weakTheory = pool.filter((sk) => {
      const snap = snaps[sk.id];
      return (snap.solved === 0 && snap.progress < 35)
        || (snap.accuracy !== null && snap.accuracy < 0.5 && snap.progress < 60)
        || (snap.fatigued && snap.recentAccuracy !== null && snap.recentAccuracy < 0.5)
        || (snap.lessonDone && snap.progress < 55 && snap.accuracy !== null && snap.accuracy < 0.5);
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
    const pool = (DataAPI.availableSkills ? DataAPI.availableSkills() : DataAPI.skills()).filter((sk) => {
      const snap = snaps[sk.id];
      return snap && snap.mission && !mentioned.has(sk.id) && snap.progress < 90;
    });
    const target = weakestOf(pool);
    if (target) {
      const snap = snaps[target.id];
      mentioned.add(target.id);
      const prog = snap.mission ? missionProgress(snap.mission) : 0;
      const missionTotal = snap.mission ? missionPracticeCount(snap.mission) : 0;
      const started = snap.mission && prog > 0 && missionTotal > 0 && prog < missionTotal;
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
      const lessonRecord = snap.lesson && safeObject(s.completedLessons)[snap.lesson.id];
       const lessonTs = lessonRecord ? Number(lessonRecord.ts) || 0 : 0;
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
          ? `Продолжить тренировку по теме «${target.name}» — ${prog}/${missionTotal}`
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
    const progressValues = Object.values(snaps).map((snap) => snap.progress);
    const minProgress = progressValues.length ? Math.min(...progressValues) : 0;
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
        reason: `Ветка «${(DataAPI.category(bestBoss.cat) || {}).name || "предмета"}» прокачана до ${catProgress(bestBoss.cat)}% — босс покажет, держится ли результат на смешанных заданиях.`,
        score: bestBossScore,
      });
    }
  }

  /* 6. Ежедневная подборка: стимул держать ритм, ниже работы над пробелами. */
  ensureDailyChallenge();
  const dailyIds = dailyTaskIds();
  if (dailyIds.length && !s.daily.done) {
    const goal = dailyIds.length;
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
    const progressValues = Object.values(snaps).map((snap) => snap.progress);
    const minProgress = progressValues.length ? Math.min(...progressValues) : 0;
    const catOrder = {};
    DataAPI.categories().forEach((c, i) => { catOrder[c.id] = i; });
    const nextTopic = (DataAPI.availableSkills ? DataAPI.availableSkills() : DataAPI.skills())
      .filter((sk) => snaps[sk.id] && snaps[sk.id].lesson && !snaps[sk.id].lessonDone && !snaps[sk.id].lessonOpen && !mentioned.has(sk.id))
      .sort((a, b) => {
        const ac = DataAPI._skillCategoryId ? DataAPI._skillCategoryId(a) : (a.cat || "");
        const bc = DataAPI._skillCategoryId ? DataAPI._skillCategoryId(b) : (b.cat || "");
        return (Number(catOrder[ac] ?? 0) - Number(catOrder[bc] ?? 0)) || (Number(a.order) || 0) - (Number(b.order) || 0);
      })[0];
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

function applyOnboarding(subject, selfLevel, goalId, diagnosticResults, name) {
  const s = Store.state;
  if (!s) return;
  /* Предмет — первая характеристика профиля; неизвестный id не отправляет
     нас обратно в профиль. */
  const current = typeof DataAPI !== "undefined" && DataAPI.currentSubject ? DataAPI.currentSubject() : Store.subject;
  const requested = subject ? String(subject) : "";
  const subj = requested && typeof DataAPI.subjectInfo === "function" && DataAPI.subjectInfo(requested)
    ? requested : String(current || "profile_math");
  Store.subject = subj;
  s.subject = subj;

  const learningAvailable = subjectLearningAvailable();
  const results = learningAvailable ? safeArray(diagnosticResults) : [];
  /* Самооценка — настройка профиля, а не искусственный прогресс. */
  s.skillStats = learningAvailable ? safeObject(s.skillStats) : {};
  if (learningAvailable) {
    for (const sk of DataAPI.availableSkills()) s.skillStats[sk.id] = { progress: 0, solved: 0, correct: 0, timeSec: 0 };
  }
  s.taskAttempts = learningAvailable ? safeArray(s.taskAttempts) : [];
  s.diagnostics = learningAvailable ? safeArray(s.diagnostics) : [];
  s.errors = learningAvailable ? safeArray(s.errors) : [];
  s.daily = { date: null, solved: 0, done: false, taskIds: [] };
  s.dailyHistory = [];

  for (const r of results) {
    const task = r && DataAPI.taskForAccess ? DataAPI.taskForAccess(r.taskId) : null;
    if (!task) continue;
    const skillId = String(task.skill || task.skillId || "");
    if (!skillIsAccessible(skillId)) continue;
    const st = s.skillStats[skillId] || (s.skillStats[skillId] = { progress: 0, solved: 0, correct: 0, timeSec: 0 });
    const diagnosticTs = Date.now();
    st.solved++;
    if (r.correct) st.correct++;
    st.progress = skillProgress(skillId);
    s.totalSolved = (Number(s.totalSolved) || 0) + 1;
    if (r.correct) s.totalCorrect = (Number(s.totalCorrect) || 0) + 1;
    s.taskAttempts.unshift({ id: newEntityId(), taskId: task.id, skill: skillId, correct: !!r.correct, hintLevel: 0, seconds: 0, closesTaskId: null, ts: diagnosticTs });
    s.diagnostics.unshift({ id: newEntityId(), taskId: task.id, correct: !!r.correct, ts: diagnosticTs });
    const activity = todayActivity();
    activity.solved++;
    if (r.correct) activity.correct++;
  }
  s.taskAttempts = s.taskAttempts.slice(0, 5000);
  if (!learningAvailable) {
    // Не оставляем в пустом/locked предмете наследованные агрегаты от
    // другого subject: это именно отдельное состояние, а не витрина.
    s.xp = 0;
    s.xpAdjustments = [];
    s.totalSolved = 0;
    s.totalCorrect = 0;
    s.totalTimeSec = 0;
    s.hintsUsed = 0;
    s.hintLevels = { 1: 0, 2: 0, 3: 0 };
    s.correctSeries = 0;
    s.bestSeries = 0;
    s.errorsResolved = 0;
    s.streak = 0;
    s.lastActiveDate = null;
    s.lessonStepErrors = {};
    s.lessonErrorHistory = [];
    s.lessonSessions = {};
    s.completedLessons = {};
    s.lessonAttempts = [];
    s.missionsDone = {};
    s.missionProgress = {};
    s.bossesDefeated = [];
    s.achievements = {};
    s.forecastHistory = [];
    s.timeline = [];
    s.activity = {};
  }
  s.selfLevel = selfLevel || null;
  // Ориентир по баллам храним только там, где для предмета есть шкала целей:
  // иначе сервер отклоняет всю настройку и регистрация не сохраняется.
  const goals = typeof DataAPI !== "undefined" && DataAPI.goals ? DataAPI.goals() : [];
  s.goal = goals.some((goal) => String(goal.id) === String(goalId)) ? goalId : null;
  const cleanedName = String(name || "").trim().replace(/\s+/g, " ").slice(0, 60);
  s.name = cleanedName || null;
  s.onboarded = true;
  s.xp = learningAvailable ? 0 : 0;
  const subjInfo = DataAPI.subjectInfo ? DataAPI.subjectInfo(subj) : null;
  if (learningAvailable) {
    recordForecastSnapshot();
    addTimeline("Пройдена диагностика, профиль навыков построен");
  } else {
    // Пустой/locked предмет: диагностики, прогноза и XP нет — только факт выбора.
    addTimeline(`Выбран предмет «${(subjInfo && (subjInfo.title || subjInfo.name)) || subj}»: материалы готовятся`);
  }
  Store.save();
  if (learningAvailable) checkAchievements();
}

/* Пользователь отказался от стартового теста. Это завершает обязательный
   экран для ТЕКУЩЕГО предмета, но не выдумывает ответы и не обнуляет уже
   накопленные данные. Имя остаётся общим для аккаунта, а selfLevel/goal
   можно определить позже или оставить пустыми. */
function completeOnboardingWithoutTest(subject, name) {
  const s = Store.state;
  if (!s) return;
  const current = typeof DataAPI !== "undefined" && DataAPI.currentSubject ? DataAPI.currentSubject() : Store.subject;
  const requested = subject ? String(subject) : "";
  const subj = requested && typeof DataAPI.subjectInfo === "function" && DataAPI.subjectInfo(requested)
    ? requested : String(current || "profile_math");
  Store.subject = subj;
  s.subject = subj;
  const cleanedName = String(name || "").trim().replace(/\s+/g, " ").slice(0, 60);
  if (cleanedName) s.name = cleanedName;
  s.onboarded = true;
  Store.save();
}
