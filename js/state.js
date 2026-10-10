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

/* Сопровождающий снимок предмет всегда сверяем с уже загруженным каталогом.
   Нельзя подставлять сюда Store.subject как запасной источник: расхождение
   Store/catalog — именно тот случай, который должен закрываться до записи. */
function assertSubjectCatalog(subject) {
  const requested = String(subject || "").trim();
  let catalogSubject = "";
  try {
    if (typeof DataAPI !== "undefined" && typeof DataAPI.currentSubject === "function") {
      catalogSubject = String(DataAPI.currentSubject() || "").trim();
    }
  } catch (_) {}
  if (!requested || !catalogSubject || requested !== catalogSubject) {
    const error = new Error(
      requested && catalogSubject
        ? `Предмет «${requested}» не совпадает с загруженным каталогом «${catalogSubject}»`
        : "Не удалось подтвердить предмет для сохранения"
    );
    error.code = "SUBJECT_CATALOG_MISMATCH";
    error.subject = requested;
    error.catalogSubject = catalogSubject;
    throw error;
  }
  return requested;
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
  // null = гостя в базе ещё нет (онбординг не пройден). Это нормальное
  // состояние, а не поломка: локальные ключи и канал вкладок уже умеют
  // работать в области "pending-account".
  accountId: null,
  // Auth-срез текущего аккаунта из bootstrap: гость или зарегистрированный
  // пользователь (registered + email). Только для отображения в UI — никаких
  // решений на его основе, идентичность всегда определяется сервером по куке.
  // providers — внешние способы входа ("google"); googleEnabled — настроен ли
  // вход через Google на сервере: без него кнопка входа не рисуется вовсе,
  // и клиенту не нужно знать ни про ключи, ни про провайдера.
  auth: { registered: false, email: null, providers: [], googleEnabled: false, hasPassword: false },
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
  // Один и тот же сбой не должен превращать очередь сохранений в поток
  // одинаковых toast. Новый сигнал появится после успешного save либо после
  // действительно другого типа ошибки.
  persistenceErrorNotifiedKey: null,
  // Заявка «онбординг пройден» уже в полёте: гость до онбординга не имеет
  // серверного профиля, и первая же запись в базу (попытка из диагностики,
  // таймлайн, настройки профиля) обязана сначала его завести. Один
  // промис на заявку — чтобы пачка доменных запросов не породила пачку
  // одинаковых (сервер идемпотентен, но лишние round-trip'ы не нужны).
  claimPromise: null,
  // Момент последней сверки с сервером (load или собственный save).
  // Другая вкладка после save пишет в localStorage маяк с accountId,
  // writer и stateVersion. Увидев более новую версию, подтягиваем состояние
  // с сервера; timestamp-only или уже применённый сигнал игнорируем.
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
  // Account ID, под который последний раз поднимались канал и лок вкладок.
  // У гостя до онбординга это null, поэтому первая заявка профиля меняет
  // область — и её надо пересоздать (но не посреди сохранения, см.
  // rescopeTabLeader).
  leaderScopeAccount: null,
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
      errors: [], // {taskId, skill, sub, ts, resolved, resolvedAt, kind: 'major'|'minor'}
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
      } catch (e) {
        // A ban is not a fallback case: rethrow immediately so the global
        // blocked modal shows instead of masking it behind a second request.
        if (e && (e.code === "ACCOUNT_BLOCKED"
            || (e.payload && (e.payload.code === "ACCOUNT_BLOCKED" || e.payload.blocked === true)))) throw e;
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
      const accountFieldPresent = Object.prototype.hasOwnProperty.call(boot, "accountId");
      const incomingAccountId = accountFieldPresent ? (boot.accountId || null) : this.accountId;
      const accountChanged = accountFieldPresent && incomingAccountId !== this.accountId;
      this.accountId = incomingAccountId;
      const auth = boot.auth;
      // Старый ответ POST /api/subject может не содержать auth: при том же
      // accountId сохраняем известную сессию, но при смене accountId отсутствие
      // auth fail-closed — иначе UI старого аккаунта утекает в новый.
      this.auth = auth && typeof auth === "object"
        ? { registered: !!auth.registered, email: auth.email || null,
            providers: Array.isArray(auth.providers) ? auth.providers.map(String) : [],
            googleEnabled: auth.googleEnabled === true,
            hasPassword: auth.hasPassword === true }
        : (accountChanged
          ? { registered: false, email: null, providers: [], googleEnabled: false, hasPassword: false }
          : (this.auth || { registered: false, email: null, providers: [], googleEnabled: false, hasPassword: false }));
      // Признак «вход через Google настроен» едет отдельным полем bootstrap и
      // доживает смену аккаунта: при смене он сбрасывается, при обычном
      // refresh — сохраняется (иначе кнопка входа мигала бы на каждом
      // обновлении вкладки).
      if (auth && typeof auth === "object" && auth.googleEnabled === true) {
        this.auth.googleEnabled = true;
      }
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
      const defaultSkillStats = Object.fromEntries(
        Object.entries(defaults.skillStats || {}).map(([id, value]) => [id, { ...value }])
      );
      const parsed = statePayload;
      this.state = Object.assign(defaults, parsed);
      this.state.subject = this.subject;
      this.state.version = defaults.version;

      const learningAvailable = subjectLearningAvailable();
      const preserveLearningState = learningAvailable || (!catalogDescribed && DataAPI.isLegacySubject());
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
        ? Object.fromEntries(Object.entries(defaultSkillStats).map(([id, value]) => [id, { ...value }]))
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
      this.state.forecastHistory = preserveLearningState && forecastConfigAvailable()
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
      const availableGoals = typeof DataAPI.goals === "function" ? DataAPI.goals() : [];
      if (!availableGoals.length || !availableGoals.some((goal) => String(goal.id) === String(this.state.goal))) {
        this.state.goal = null;
      }
      // Журнал ручных XP-начислений тоже является learning-данными; locked
      // предмет не должен даже временно показывать чужой/старый журнал.
      this.state.xpAdjustments = preserveLearningState ? safeArray(parsed.xpAdjustments) : [];

      this.lastSyncedState = JSON.parse(JSON.stringify(this.state));
      this.ready = true;
      this.lastSyncTs = Date.now();
      this.pendingExternalUpdate = false;
      this.persistenceError = null;
      this.persistenceErrorNotifiedKey = null;
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
    this.leaderScopeAccount = this.accountId || null;
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
    let request;
    try {
      request = navigator.locks.request(this.tabLockName || "ege-core-state-leader-v1", { ifAvailable: true }, async (lock) => {
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
      });
    } catch (_) {
      // Синхронный бросок locks.request (экзотика) не должен вечно
      // блокировать выборы: иначе вкладка никогда не станет лидером и
      // каждый save будет умирать с тостом «Не удалось сохранить прогресс».
      this.leaderAcquireInFlight = false;
      return;
    }
    request.catch(() => { this.leaderAcquireInFlight = false; });
  },

  // Свежий heartbeat лидера (тот же порог 2500 мс, что у heartbeat-таймера).
  _leaderSeenFresh() {
    try {
      return Number(this.leaderSeenAt) > 0 && Date.now() - Number(this.leaderSeenAt) < 2500;
    } catch (_) {
      return false;
    }
  },

  // Короткое ожидание собственного лидерства. Нужно для холодного старта:
  // канал уже создан, а lock ещё не захвачен — слать save/action-request
  // некому (свои сообщения игнорируются, другой вкладки может не быть),
  // и без ожидания первый save умирал бы по 5-секундному таймауту с тостом.
  // true — пишем напрямую (стали лидером / канала нет); false — шлём запрос
  // лидеру (появился живой лидер либо время вышло — best effort). Не бросает.
  _awaitLeadership(timeoutMs = 2000) {
    if (this.isTabLeader || !this.tabChannel) return Promise.resolve(true);
    try { this._tryBecomeTabLeader(); } catch (_) {}
    const limit = Math.max(0, Number(timeoutMs) || 0);
    const start = Date.now();
    return new Promise((resolve) => {
      const check = () => {
        try {
          if (this.isTabLeader || !this.tabChannel) return resolve(true);
          // Пока ждали, объявился живой лидер — дальше не ждём, шлём запрос.
          if (this._leaderSeenFresh()) return resolve(false);
          if (Date.now() - start >= limit) return resolve(false);
        } catch (_) {
          return resolve(false);
        }
        setTimeout(check, 50);
      };
      check();
    });
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
      assertSubjectCatalog(incoming.subject);
      if (this.subject) assertSubjectCatalog(this.subject);
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

  // Прямой путь лидера (или одиночной вкладки без канала).
  _runLeaderActionDirect(action, data = {}) {
    if (action === "switch-subject") return ApiClient.post("/api/subject", { subject: data.subject });
    if (action === "reset") return ApiClient.delete("/api/state");
    return Promise.reject(new Error("Неизвестное действие вкладки"));
  },

  requestLeaderAction(action, data = {}) {
    if (this.isTabLeader || !this.tabChannel) return this._runLeaderActionDirect(action, data);
    if (this._leaderSeenFresh()) return this._sendActionRequest(action, data);
    return this._awaitLeadership(2000).then((direct) => {
      if (direct && (this.isTabLeader || !this.tabChannel)) return this._runLeaderActionDirect(action, data);
      return this._sendActionRequest(action, data);
    });
  },

  _sendActionRequest(action, data = {}, isRetry = false) {
    const requestId = `${this.tabId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.leaderRequests[requestId]) return;
        delete this.leaderRequests[requestId];
        this._awaitLeadership(1500).then((direct) => {
          if (direct && (this.isTabLeader || !this.tabChannel)) {
            resolve(this._runLeaderActionDirect(action, data));
            return;
          }
          if (!isRetry) {
            resolve(this._sendActionRequest(action, data, true));
            return;
          }
          try { this._tryBecomeTabLeader(); } catch (_) {}
          reject(new Error("Главная вкладка недоступна: попробуй сохранить ещё раз"));
        });
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
    // Лидер недавно объявлялся — обычный путь ведомой вкладки, без задержек.
    if (this._leaderSeenFresh()) return this._sendSaveRequest(snapshot);
    // Лидера не видно: холодный старт (lock ещё не захвачен) или умершая
    // главная вкладка. Сначала пробуем забрать lock себе — в одиночной
    // вкладке это миллисекунды, и save идёт напрямую без 5-секундного
    // ожидания и тоста «Не удалось сохранить прогресс».
    return this._awaitLeadership(2000).then((direct) => {
      if (direct && (this.isTabLeader || !this.tabChannel)) return this._saveSnapshot(snapshot);
      return this._sendSaveRequest(snapshot);
    });
  },

  _sendSaveRequest(snapshot, isRetry = false) {
    const requestId = `${this.tabId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.leaderRequests[requestId]) return;
        delete this.leaderRequests[requestId];
        // Лидер мог умереть или, наоборот, только что появиться прямо во
        // время ожидания: прежде чем падать с тостом — пробуем забрать lock
        // себе (прямой save) или повторяем запрос один раз, если лидер
        // только что объявился. Настоящие сетевые/серверные ошибки этим
        // не маскируются: они приходят ответом save-result и тостят как раньше.
        this._awaitLeadership(1500).then((direct) => {
          if (direct && (this.isTabLeader || !this.tabChannel)) {
            resolve(this._saveSnapshot(snapshot));
            return;
          }
          if (!isRetry) {
            resolve(this._sendSaveRequest(snapshot, true));
            return;
          }
          try { this._tryBecomeTabLeader(); } catch (_) {}
          reject(new Error("Главная вкладка недоступна: попробуй сохранить ещё раз"));
        });
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
    /* Ошибка — не append-only факт, а сущность с монотонным состоянием.
       Обычный unique() оставлял первую (свежую) открытую копию и мог
       откатить локально уже закрытую ошибку. Сливаем копии по clientId/id,
       сохраняя resolved=true и major-kind независимо от порядка сторон. */
    const errorKey = (item) => {
      if (!item || typeof item !== "object") return `json:${JSON.stringify(item)}`;
      for (const key of ["clientId", "id"]) {
        const value = item[key];
        if (typeof value === "string" && value) return `id:${value}`;
        if (typeof value === "number" && Number.isFinite(value)) return `id:${value}`;
      }
      return `natural:${item.taskId || ""}:${item.ts ?? ""}`;
    };
    const mergeError = (left, right) => {
      const a = left || {};
      const b = right || {};
      const kind = (errorKindOf(a) === "major" || errorKindOf(b) === "major") ? "major" : "minor";
      return {
        ...a,
        id: a.id ?? b.id,
        clientId: a.clientId || b.clientId,
        taskId: a.taskId ?? b.taskId,
        skill: a.skill ?? b.skill,
        sub: a.sub ?? b.sub,
        ts: a.ts ?? b.ts,
        resolved: !!a.resolved || !!b.resolved,
        resolvedAt: Math.max(Number(a.resolvedAt) || 0, Number(b.resolvedAt) || 0) || undefined,
        kind,
      };
    };
    const errors = [];
    const errorIndexes = new Map();
    for (const error of [...(fresh.errors || []), ...(local.errors || [])]) {
      if (!error) continue;
      const key = errorKey(error);
      if (errorIndexes.has(key)) {
        const index = errorIndexes.get(key);
        errors[index] = mergeError(errors[index], error);
      } else {
        errorIndexes.set(key, errors.length);
        errors.push({ ...error });
      }
    }
    merged.errors = errors;
    for (const key of ["taskAttempts", "lessonAttempts", "lessonErrorHistory", "diagnostics", "dailyHistory", "timeline"]) {
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

  // Гость, который прошёл онбординг, только в этот момент получает серверный
  // профиль: до этого в базе нет ни строки, ни сессии, ни cookie, поэтому
  // «зашёл на лендинг» и «начал готовиться» не оставляют следа, а ученик в
  // дашборде появляется в базе всегда. Заявка идемпотентна на сервере, так что
  // потерянный ответ и повтор ничего не удваивают.
  async claimServerProfile(snapshot) {
    const subject = String(snapshot && snapshot.subject || "").trim();
    const payload = {
      subject,
      onboarded: true,
      name: snapshot.name == null ? null : String(snapshot.name),
      selfLevel: snapshot.selfLevel == null ? null : snapshot.selfLevel,
      goal: snapshot.goal == null ? null : snapshot.goal,
    };
    const result = await ApiClient.post("/api/profile/claim", payload);
    if (!result || typeof result !== "object" || !result.accountId) {
      throw new Error("Сервер не заявил профиль");
    }
    this.accountId = result.accountId;
    const user = result.user && typeof result.user === "object" ? result.user : {};
    this.auth = { registered: !!user.registered, email: user.email || null,
      providers: Array.isArray(user.providers) ? user.providers.map(String) : this.auth.providers,
      googleEnabled: this.auth.googleEnabled === true,
      hasPassword: user.hasPassword === true };
    this.isAdmin = result.isAdmin === true;
    return result;
  },

  async _saveDomains(snapshot) {
    const subject = String(snapshot && snapshot.subject || "").trim();
    assertSubjectCatalog(subject);
    if (this.subject) assertSubjectCatalog(this.subject);
    // Гость, который онбординг ещё не прошёл: серверного профиля нет и
    // записывать некуда. Локальные данные копятся в памяти до заявки — в сеть
    // не ходим и тост не показываем. lastSyncedState НЕ подтягиваем: иначе
    // набранное до онбординга (попытка, daily) посчиталось бы отправленным и
    // не ушло бы в первой же записи после заявки.
    if (!this.accountId && !(snapshot && snapshot.onboarded)) {
      return { ok: true, stateVersion: snapshot.stateVersion, guest: true };
    }
    const base = this.lastSyncedState || {};
    let version = snapshot.stateVersion;
    // Первая запись от гостя обязана начинаться с заявки профиля. Иначе сервер
    // честно ответит 401 GUEST_PENDING (записывать некуда) и данные ученика,
    // набранные при регистрации, потерялись бы. accountId == null — это ровно
    // «в базе меня ещё нет»; у кого профиль уже есть, заявки не будет вовсе.
    // Если кука не сохранилась (блок cookie) — accountId локально есть, а
    // сервер гостя не узнаёт: следующий запрос вернёт 401 GUEST_PENDING.
    // Тогда сбрасываем accountId и заявляем профиль заново один раз, иначе
    // все будущие сейвы вечно падают без повторной заявки.
    const ensureClaim = async () => {
      if (!this.accountId && snapshot && snapshot.onboarded) {
        if (!this.claimPromise) {
          this.claimPromise = this.claimServerProfile(snapshot)
            .finally(() => { this.claimPromise = null; });
        }
        await this.claimPromise;
      }
    };
    await ensureClaim();
    const isGuestPending = (e) => Number(e && e.status) === 401
      && ((e && e.code) === "GUEST_PENDING" || (e && e.payload && e.payload.code) === "GUEST_PENDING");
    const request = async (method, path, body, retried = false) => {
      // Каталог может смениться между доменными запросами. Проверяем перед
      // каждым POST/PATCH, чтобы очередной запрос не ушёл уже по чужому id.
      assertSubjectCatalog(subject);
      if (this.subject) assertSubjectCatalog(this.subject);
      const payload = { subject, expectedVersion: version, ...body };
      let result;
      try {
        result = await ApiClient[method](path, payload);
      } catch (e) {
        // Кука не сохранилась, а accountId уже выставлен: сервер видит гостя.
        // Один раз сбрасываемся и заявляем профиль заново — иначе все будущие
        // сейвы вечно падают с GUEST_PENDING без повторной заявки.
        if (!retried && snapshot && snapshot.onboarded && isGuestPending(e)) {
          this.accountId = null;
          this.claimPromise = null;
          await ensureClaim();
          // Сервер уже применил профиль в claim: версия могла вырасти —
          // перечитываем состояние, чтобы expectedVersion сошёлся.
          try {
            await this.load(subject);
            version = (this.state && this.state.stateVersion) || version;
            snapshot.stateVersion = version;
          } catch (_) {}
          return request(method, path, body, true);
        }
        throw e;
      }
      assertSubjectCatalog(subject);
      if (this.subject) assertSubjectCatalog(this.subject);
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
    assertSubjectCatalog(subject);
    if (this.subject) assertSubjectCatalog(this.subject);
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

  reportPersistenceError(error) {
    this.persistenceError = error;
    const status = Number(error && error.status) || 0;
    const payloadCode = error && error.payload && error.payload.code ? error.payload.code : "";
    const code = error && error.code ? error.code : payloadCode;
    const message = error && error.message ? error.message : String(error || "unknown");
    const key = `${status}:${String(code || "")}:${message}`;
    if (key === this.persistenceErrorNotifiedKey) return false;
    this.persistenceErrorNotifiedKey = key;
    try { this.emit("persistenceerror", error); } catch (_) {}
    return true;
  },

  save() {
    if (!this.state || !this.ready) return Promise.resolve();
    this.pendingSave = this.pendingSave
      .catch(() => {})
      .then(() => {
        const snapshot = JSON.parse(JSON.stringify(this.state));
        const stateSubject = String(snapshot.subject || "").trim();
        const storeSubject = String(this.subject || "").trim();
        const subject = storeSubject || stateSubject || currentSubjectId();
        // Не позволяем save() переименовать чужой снимок в текущий предмет.
        assertSubjectCatalog(subject);
        if (stateSubject) assertSubjectCatalog(stateSubject);
        // Снапшот всегда помечен предметом — сервер пишет строго в его строки.
        snapshot.subject = subject;
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
      .then((saved) => {
        this.persistenceError = null;
        this.persistenceErrorNotifiedKey = null;
        if (saved) this._noteOwnSave();
        // Первая заявка профиля (онбординг гостя) сменила accountId — область
        // вкладок обновляем здесь, уже с пустой очередью сохранений.
        return this.rescopeTabLeader();
      })
      .catch((error) => {
        this.reportPersistenceError(error);
      });
    return this.pendingSave;
  },

  // Ключ маяка свой на аккаунт и предмет: вкладки разных профилей или
  // предметов друг другу не указ. Версионная схема v2 исключает старые
  // timestamp-only маяки, которые нельзя надёжно отличить от собственного save.
  pingKey(subject) {
    const account = encodeURIComponent(String(this.accountId || "pending-account"));
    return "ege_core_state_ping:" + account + ":" + (subject || currentSubjectId());
  },

  // Успешно сохранились: фиксируем момент, версию и writer и будим соседние
  // вкладки. Только localStorage (без DOM/window) — безопасно для node-тестов.
  _noteOwnSave() {
    this.lastSyncTs = Date.now();
    try {
      if (typeof localStorage !== "undefined") {
        const subject = this.subject || currentSubjectId();
        localStorage.setItem(this.pingKey(subject), JSON.stringify({
          v: 2,
          accountId: this.accountId || null,
          writer: this.tabId,
          subject,
          stateVersion: Math.max(1, Number(this.state && this.state.stateVersion) || 1),
          ts: this.lastSyncTs,
        }));
      }
    } catch (_) {}
  },

  // Свежий маяк означает только более новую серверную версию этого же
  // аккаунта и предмета, сохранённую другой вкладкой. Свой writer и уже применённая версия
  // отбрасываются, поэтому BroadcastChannel + localStorage не создают повтор.
  shouldRefreshForPing(ping) {
    if (!ping || typeof ping !== "object" || ping.v !== 2) return false;
    if (ping.subject !== (this.subject || currentSubjectId())) return false;
    const pingAccount = ping.accountId == null ? null : String(ping.accountId);
    const currentAccount = this.accountId == null ? null : String(this.accountId);
    if (pingAccount !== currentAccount) return false;
    if (ping.writer && ping.writer === this.tabId) return false;
    if (!Number.isInteger(ping.stateVersion) || ping.stateVersion < 1) return false;
    const currentVersion = Math.max(1, Number(this.state && this.state.stateVersion) || 1);
    if (ping.stateVersion <= currentVersion) return false;
    return (Number(ping.ts) || 0) > (this.lastSyncTs || 0);
  },

  // Другая вкладка сохранилась: подтягиваем свежее состояние с сервера.
  // Во время активной тренировки/урока состояние не подменяем из-под
  // сессии — откладываем до следующей навигации (см. render в app.js),
  // иначе ответы текущей сессии ушли бы в чужой снапшот.
  // Возвращает "reloaded" | "deferred" | "none".
  async checkExternalUpdate(force = false) {
    if (!this.ready || !this.state) return "none";
    let ping = null;
    try {
      if (typeof localStorage !== "undefined") {
        const raw = localStorage.getItem(this.pingKey(this.subject));
        ping = raw ? JSON.parse(raw) : null;
      }
    } catch (_) {
      if (!force) return "none";
    }
    let hasFreshPing = this.shouldRefreshForPing(ping);
    if (!force && !hasFreshPing) return "none";
    // focus/visibility срабатывают чаще обычного storage-события. Не делаем
    // сетевой reload на каждом переключении окна, но при возврате в уже
    // открытую вкладку всё равно сверяем состояние с сервером: другая
    // устройство/вкладка могла закрыть ошибки без localStorage-маяка.
    if (force) {
      const now = Date.now();
      if (this.lastForcedExternalCheckAt && now - this.lastForcedExternalCheckAt < 5000) return "none";
      this.lastForcedExternalCheckAt = now;
    }
    const busy = (typeof Session !== "undefined" && Session && Session.cur)
      || (typeof Lesson !== "undefined" && Lesson && Lesson.cur);
    let dirty = this.lastSyncedState
      && JSON.stringify(this.state) !== JSON.stringify(this.lastSyncedState);
    // Фокус может прийти ровно между локальным ответом и его сохранением.
    // Дожидаемся очереди save и только затем решаем, можно ли заменить state
    // серверным снимком; несохранённый ответ не должен исчезнуть.
    if (dirty && this.pendingSave) {
      await this.pendingSave.catch(() => {});
      dirty = this.lastSyncedState
        && JSON.stringify(this.state) !== JSON.stringify(this.lastSyncedState);
    }
    // Пока ждали локальную очередь, тот же ping мог уже примениться через
    // BroadcastChannel или текущий save. Пересчитываем по новой stateVersion,
    // чтобы не откладывать уже закрытое обновление.
    hasFreshPing = this.shouldRefreshForPing(ping);
    if (busy || dirty) {
      // Само по себе событие focus не доказывает, что данные изменились в
      // другой вкладке. Без более свежего маяка это обычная незавершённая
      // тренировка/локальный ответ текущей вкладки: не создаём ложное
      // отложенное обновление. Позже следующая проверка всё равно сверит
      // сервер, когда вкладка освободится.
      if (!hasFreshPing) return "none";
      const wasPending = this.pendingExternalUpdate;
      this.pendingExternalUpdate = true;
      if (!wasPending) {
        try { this.emit("externalupdate-pending"); } catch (_) {}
      }
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
      // the next request reads the current session — a guest after a reset has
      // no profile again until onboarding is finished, and an account that
      // survives gets its own fresh Account ID.
      .then(() => this.load())
      .then(() => this.rescopeTabLeader())
      .catch((error) => {
        this.reportPersistenceError(error);
      });
    return this.pendingSave;
  },

  // Канал и лок вкладок scope от accountId: вкладки разных профилей не должны
  // попадать в один координатор. У гостя до онбординга scope — «pending-account»,
  // поэтому первая заявка профиля его меняет. Пересоздавать канал прямо посреди
  // сохранения нельзя (главная вкладка держит лок и очередь сейвов), поэтому
  // область обновляется следующим save(), когда очередь уже пуста.
  rescopeTabLeader() {
    if (!this.tabLeaderReady) return Promise.resolve(false);
    const current = this.accountId || null;
    if (this.leaderScopeAccount === current) return Promise.resolve(false);
    this.leaderScopeAccount = current;
    this.releaseTabLeadership();
    this.tabLeaderReady = false;
    this.isTabLeader = false;
    this.leaderTabId = null;
    this.leaderSeenAt = 0;
    return this.initTabLeader().then(() => true);
  },

  // После register/login/logout сервер перевыпускает сессию (или оставляет
  // гостя без профиля) — перечитываем bootstrap: обычный load подтянет новый
  // аккаунт целиком, вручную ничего мержить не нужно. Сменившийся accountId
  // требует переинициализации tab-leader (см. rescopeTabLeader): канал и лок
  // имеют scope от accountId, иначе вкладки нового аккаунта встали бы в чужой
  // координатор.
  async refreshAfterAuth() {
    const prevAccount = this.accountId;
    await this.load();
    await this.rescopeTabLeader();
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

/* Когда ошибка была закрыта. Для текущей сессии recordAnswer сразу ставит
   resolvedAt, а после перезагрузки восстанавливаем время из подтверждающей
   попытки: прямой ответ по taskId либо ответ с closesTaskId в умном
   повторении. Это нужно истории «Закрытые»: ошибка может быть создана давно,
   но закрыта только что и обязана попасть в начало ограниченного списка. */
function errorResolutionTimestamp(error, attempts) {
  if (!error) return 0;
  const createdAt = Math.max(0, Number(error.ts) || 0);
  let resolvedAt = Math.max(0, Number(error.resolvedAt) || 0);
  for (const attempt of safeArray(attempts)) {
    if (!attempt || !attempt.correct || Number(attempt.hintLevel) >= 3) continue;
    const direct = String(attempt.taskId) === String(error.taskId);
    const review = attempt.closesTaskId && String(attempt.closesTaskId) === String(error.taskId);
    if (!direct && !review) continue;
    const ts = Math.max(0, Number(attempt.ts) || 0);
    // Ответ раньше ошибки не мог её закрыть (например, старая правильная
    // попытка по этому же заданию).
    if (ts >= createdAt && ts > resolvedAt) resolvedAt = ts;
  }
  return resolvedAt || createdAt;
}

function resolvedErrorsForDisplay(errors, attempts, limit = 8) {
  const max = Math.max(0, Number(limit) || 0);
  return safeArray(errors)
    .map((error, index) => ({ error, index, resolvedAt: errorResolutionTimestamp(error, attempts) }))
    .filter((item) => item.error && item.error.resolved)
    .sort((a, b) => b.resolvedAt - a.resolvedAt || a.index - b.index)
    .slice(0, max)
    .map((item) => item.error);
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

/* ============================================================
   Гибкая шкала XP за проверенное сочинение (задание 27, задачи
   типа long_text). Зеркало server.py essay_xp: сервер пересчитывает
   XP из попыток в derive_stats и не доверяет клиентским числам,
   поэтому обе стороны делят ровно эту формулу, а балл сервер берёт
   из своих essay_submissions (статус 'ready'), а не из попытки.
   Линейно от балла AI-проверки 0–22: 22 ≈ 500 XP (долгая работа),
   0 — минимум 100 XP за саму работу, ниже 100 никогда.
   Повтор того же задания — уже mastered: только минимум за посещение
   (та же защита от повторов, что у обычных заданий).
   ============================================================ */
const ESSAY_SCORE_MAX = 22; // максимум AI-проверки задания 27
const ESSAY_XP_MIN = 100;   // минимум за проверенное сочинение — за саму работу
const ESSAY_XP_MAX = 500;   // идеальные 22 балла

function essayXp(score) {
  const s = Math.max(0, Math.min(ESSAY_SCORE_MAX, Number(score)));
  if (!Number.isFinite(s)) return ESSAY_XP_MIN;
  return ESSAY_XP_MIN + Math.round((ESSAY_XP_MAX - ESSAY_XP_MIN) * s / ESSAY_SCORE_MAX);
}

// Задача-сочинение: тот же признак, что isLongTextTask в js/app.js.
function isEssayTask(task) {
  return !!task && (task.type === "long_text" || task.answerType === "long_text");
}

/* ============================================================
   CTA «привяжи аккаунт» для гостя с прогрессом.
   Гость после онбординга — полноценный аккаунт этого браузера, но без
   email/пароля вход с другого устройства невозможен. Считаем ОСМЫСЛЕННЫЕ
   Учёбные шаги считаются (новое верное решение = 1, первое прохождение
   урока = 3, завершённая миссия = 3, побеждённый босс = 4 — повторные
   верные ответы по уже освоенному заданию шагом не считаются) и ровно
   ОДИН раз, на пороге 8, показываем на экране результата просьбу привязать
   аккаунт. Кто хотел — зарегистрируется сразу; напоминать повторно —
   только бесить тех, кто осознанно не привязал и продолжает заниматься.
   ============================================================ */
const GUEST_CTA_LS_KEY = "ege_guest_cta_v1";
const GUEST_SAVE_CTA_MILESTONE = 8;
const GUEST_STEP_LESSON = 3;
const GUEST_STEP_MISSION = 3;
const GUEST_STEP_BOSS = 4;

function isGuestWithProgress() {
  try { return !!(Store && Store.accountId && !(Store.auth && Store.auth.registered)); }
  catch (_) { return false; }
}

function guestCtaRead() {
  try {
    const data = JSON.parse(localStorage.getItem(GUEST_CTA_LS_KEY) || "{}");
    return data && typeof data === "object" ? data : {};
  } catch (_) { return {}; }
}

function guestCtaWrite(data) {
  try { localStorage.setItem(GUEST_CTA_LS_KEY, JSON.stringify(data || {})); } catch (_) {}
}

function bumpGuestSteps(amount) {
  if (!isGuestWithProgress() || !(Number(amount) > 0)) return;
  const data = guestCtaRead();
  data.steps = Math.min(100000, (Number(data.steps) || 0) + Number(amount));
  guestCtaWrite(data);
}

/* Порог, достигнутый, но ещё не показанный (0 — показывать нечего). */
function guestSaveCtaPending() {
  if (!isGuestWithProgress()) return 0;
  const data = guestCtaRead();
  const steps = Number(data.steps) || 0;
  const shown = safeArray(data.shown).map(Number);
  return steps >= GUEST_SAVE_CTA_MILESTONE && !shown.includes(GUEST_SAVE_CTA_MILESTONE) ? GUEST_SAVE_CTA_MILESTONE : 0;
}

/* Блок для экранов результата. Пустая строка — порог не достигнут или
   аккаунт уже привязан. Показывается ровно один раз: порог отмечается
   показанным сразу же, поэтому после закрытия блок больше не вернётся. */
function guestSaveCtaHTML() {
  const pending = guestSaveCtaPending();
  if (!pending) return "";
  const data = guestCtaRead();
  const shown = new Set(safeArray(data.shown).map(Number));
  shown.add(pending);
  data.shown = [...shown];
  guestCtaWrite(data);
  const s = Store.state || {};
  const solved = Math.max(0, Number(s.totalSolved) || 0);
  const lessons = Object.keys(safeObject(s.completedLessons)).length;
  const what = solved
    ? `У тебя уже решено ${solved} ${plural(solved, "задание", "задания", "заданий")}${lessons ? ` и пройдено ${lessons} ${plural(lessons, "урок", "урока", "уроков")}` : ""}`
    : lessons ? `У тебя уже пройдено ${lessons} ${plural(lessons, "урок", "урока", "уроков")}` : "Ты уже занимаешься";
  return `<div style="margin:22px auto 0;max-width:640px;padding:14px 16px;border:1px solid var(--card-border,rgba(255,255,255,.12));border-radius:14px;background:var(--surface-2,#10141c);display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;text-align:left;font-size:13.5px;color:var(--text-2,var(--text))">
    <div style="min-width:220px;flex:1"><b style="color:var(--text,var(--text))">Аккаунт не привязан.</b> ${what}. Пока ты занимаешься в этом браузере — всё сохраняется, но войти с другого устройства не получится.</div>
    <button class="btn btn--primary btn--sm" type="button" onclick="go('register')">Войти или зарегистрироваться</button>
  </div>`;
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

function dayBeforeYesterdayStr() {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Moscow" }));
  d.setDate(d.getDate() - 2);
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
  if (s.lastActiveDate === yesterdayStr()) {
    s.streak = (Number(s.streak) || 0) + 1;
  } else if (s.lastActiveDate === dayBeforeYesterdayStr() && (Number(s.streak) || 0) >= 2) {
    // Оттайка замороженной серии: вчера пропущен, позавчера цепочка была
    // >= 2 (порог — STREAK_FROZEN_MIN_DAYS в server.py). Сервер при записи
    // простит пропуск автомостом, локально продолжаем сразу верным числом,
    // чтобы счётчик и таймлайн не мигали единицей до перезагрузки.
    s.streak = (Number(s.streak) || 0) + 1;
  } else {
    s.streak = 1;
  }
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
  if (!skillIsAccessible(skillId)) return [];
  return DataAPI.practiceTasksBySkill(skillId).slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }))
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
    if (!skillIsAccessible(s)) return false;
    const id = typeof DataAPI._skillCategoryId === "function" ? DataAPI._skillCategoryId(s) : (s.cat || s.topic || s.topicId);
    return String(id || "") === wanted;
  });
  if (!skills.length) return 0;
  return Math.round(skills.reduce((a, s) => a + skillProgress(s.id), 0) / skills.length);
}

/* Раньше здесь лежали ВРЕМЕННО закрытые темы (n09 профиля, №7/№9 базы):
   весь их банк требовал официальных рисунков, которых не было в сборке.
   Чертежи восстановлены средствами MathVisual, плюс добавлены текстовые
   аналоги открытого банка — у всех трёх тем есть задания, уроки и миссии,
   серверный /api/status честно показывает их доступными. Ручной список
   опустошён: блокировка теперь полностью автоматическая — из реестра
   предмета/темы (см. DataAPI.isSkillLocked ниже) и из фактического наличия
   контента (topicHasLearningContent в app.js). Пустая тема без урока
   и заданий по-прежнему закроется сама, без правки клиентского кода.
   Объект оставлен ради совместимого метода has(), которым пользуется UI. */
const LEGACY_TEMP_LOCKED_SKILL_IDS = new Set([]);
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

/* Последний незавершённый урок (по времени последнего касания) — самое
   дешёвое следующее действие: доучить то, что уже начато, а не открывать
   новое. У старых записей без ts берётся startTs: до появления ts это
   единственная метка времени сессии. */
function mostRecentOpenLesson() {
  const sessions = safeObject(Store.state && Store.state.lessonSessions);
  let best = null, bestTs = -1;
  for (const lessonId of Object.keys(sessions)) {
    const lesson = DataAPI.lessonForAccess ? DataAPI.lessonForAccess(lessonId) : DataAPI.lesson(lessonId);
    if (!lesson) continue; // урок мог быть удалён/заблокирован после обновления
    const session = safeObject(sessions[lessonId]);
    const ts = Number(session.ts) || Number(session.startTs) || 0;
    if (!best || ts > bestTs) { best = { lessonId, session, lesson }; bestTs = ts; }
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
   баллы → тестовая шкала, заданные конфигом текущего предмета.
   Никакого «базового» минимума за ноль знаний и никакой фиксированной вилки.
   ============================================================ */

/* Затухание старых попыток: вес = exp(-возраст_дней / 45).
   Период полураспада ~31 день: ответ месяц назад весит вдвое меньше
   сегодняшнего, ответ двухмесячной давности — вчетверо. */
const FORECAST_DECAY_DAYS = 45;
/* Полное доверие практике — от 12 свежих попыток; дальше насыщение:
   10 лёгких подряд уже не дают «мастера», нужен объём посвежее. */
const FORECAST_FULL_VOLUME = 12;
/* Ошибки забываются быстрее знаний: неверная попытка затухает за 14 дней
   (полураспад ~10), верная — за 45. Свежие данные от асимметрии не меняются,
   старые ошибки перестают душить точность через пару недель, а не полтора
   месяца. */
const FORECAST_FORGIVE_DAYS = 14;
/* Вес попытки с подсказкой — тем же коэффициентом, что режет награду
   в attemptXp: подсказка — свидетельство слабее (0.6), разбор — ещё слабее
   (0.3). Индекс — уровень подсказки 0–3 (3 = показан ответ). */
const FORECAST_HINT_WEIGHTS = [1, 0.6, 0.3, 0.3];
/* Диагностический ответ — холодный экзаменационный образец: без подсказок,
   тренировочного контекста и повторов. Один верный диагностический ответ
   несёт больше свидетельства, чем рутинная попытка, поэтому в объёме прогноза
   засчитывается с этим весом. Без этого вклад диагностики (~1 попытка на
   навык против насыщения 12) тонул в округлении, и прогноз после онбординга
   с любыми верными ответами показывал 0 баллов. Диагностическая попытка
   опознаётся по паре taskId+ts из домена diagnostics — практика по тому же
   заданию ей не засчитывается. */
const FORECAST_DIAGNOSTIC_WEIGHT = 2;
/* Порог показа прогноза: раньше него числа нет вообще — вместо «0 баллов»
   честная плашка «пройди больше тем и практики». Пока темы не тронуты, они
   тянут взвешенное среднее вниз, и число после первой диагностики выглядит
   приговором, а не ориентиром. Порог низкий намеренно: 1–2 урока и 3 темы
   с данными — это «первые шаги», после которых число уже можно показать,
   но только с пометкой «предварительный» и широкой вилкой (см. ниже). */
const FORECAST_READY_LESSON_SHARE = 0.05;
const FORECAST_READY_TOPIC_SHARE = 0.1;
const FORECAST_READY_MIN_LESSONS = 1;
const FORECAST_READY_MIN_TOPICS = 3;

function getForecastConfig() {
  try {
    if (typeof DataAPI === "undefined" || typeof DataAPI.forecastConfig !== "function") return null;
    const cfg = DataAPI.forecastConfig();
    return cfg && typeof cfg === "object" && !Array.isArray(cfg) ? cfg : null;
  } catch (_) {
    return null;
  }
}

/* Без полного конфига прогноз считается отсутствующим, а не реконструируется. */
function forecastConfigIsUsable(cfg) {
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return false;
  const weights = cfg.weights;
  const scale = cfg.scale;
  const total = Number(cfg.total);
  return !!weights && typeof weights === "object" && !Array.isArray(weights)
    && Object.keys(weights).length > 0
    && Array.isArray(scale) && scale.length > 0
    && scale.every((value) => Number.isFinite(value))
    && Number.isInteger(total) && total > 0 && scale.length === total + 1;
}

function skillEgeWeight(skillId) {
  const id = dataIdValue(skillId && typeof skillId === "object" ? skillId.id : skillId);
  if (!id || !skillIsAccessible(id)) return 0;
  const skill = DataAPI.skill(id);
  if (!skill || !skillIsAccessible(id)) return 0;
  const cfg = getForecastConfig();
  if (!forecastConfigIsUsable(cfg)) return 0;
  const weights = cfg.weights;
  if (weights && Object.prototype.hasOwnProperty.call(weights, id)) {
    const value = Number(weights[id]);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }
  return 0;
}

function forecastScale() {
  const cfg = getForecastConfig();
  return forecastConfigIsUsable(cfg) ? cfg.scale : [];
}

function forecastTotal() {
  const cfg = getForecastConfig();
  return forecastConfigIsUsable(cfg) ? Number(cfg.total) : 0;
}

function forecastConfigAvailable() {
  // Пустой/locked предмет или предмет без полноценного конфигура не получает
  // нулевой «прогноз»: это отсутствие данных, а не результат 0.
  if (typeof DataAPI === "undefined" || typeof DataAPI.ready !== "function" || !DataAPI.ready()) return false;
  if (typeof DataAPI.isSubjectLocked === "function" && DataAPI.isSubjectLocked()) return false;
  if (typeof DataAPI.hasLearningContent === "function" && !DataAPI.hasLearningContent()) return false;
  return forecastConfigIsUsable(getForecastConfig());
}

/* Что осталось до показа прогноза: сколько уроков и взвешенных тем с данными
   нужно и сколько уже есть. Пока порог не набран, число не показываем нигде —
   ни на дашборде, ни в статистике, ни в снимке истории. */
function forecastReadiness(covered, totalTopics) {
  const lessons = (typeof DataAPI !== "undefined" && typeof DataAPI.lessons === "function")
    ? safeArray(DataAPI.lessons()) : [];
  const completed = safeObject((Store.state || {}).completedLessons);
  const totalLessons = lessons.length;
  const doneLessons = totalLessons ? lessons.filter((l) => l && completed[l.id]).length : 0;
  const needLessons = totalLessons
    ? Math.max(FORECAST_READY_MIN_LESSONS, Math.ceil(totalLessons * FORECAST_READY_LESSON_SHARE))
    : 0;
  const needTopics = totalTopics
    ? Math.max(FORECAST_READY_MIN_TOPICS, Math.ceil(totalTopics * FORECAST_READY_TOPIC_SHARE))
    : 0;
  return {
    ready: doneLessons >= needLessons && covered >= needTopics,
    doneLessons, needLessons, totalLessons,
    covered, needTopics, totalTopics,
  };
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
    // Прощение: ошибки забываются быстрее знаний (полураспад ~10 дней
    // против ~31): исправившийся ученик не тащит старую ошибку полтора
    // месяца. Свежие данные от этого не меняются вообще.
    const w = Math.exp(-ageDays / (a.correct ? FORECAST_DECAY_DAYS : FORECAST_FORGIVE_DAYS));
    const dw = diagKeys.has(`${a.taskId}|${Number(a.ts) || 0}`) ? FORECAST_DIAGNOSTIC_WEIGHT : 1;
    // Подсказка: свидетельство слабее — тем же коэффициентом, что режет
    // награду в attemptXp (0.6/0.3). Сложность: звёзды задания напрямую.
    const hw = Array.isArray(FORECAST_HINT_WEIGHTS)
      ? (FORECAST_HINT_WEIGHTS[Math.max(0, Math.min(3, Number(a.hintLevel) || 0))] ?? 1) : 1;
    let diff = 1;
    try {
      const t = (typeof DataAPI !== "undefined" && DataAPI.task) ? DataAPI.task(a.taskId) : null;
      diff = Math.max(1, Math.min(5, Number(t && t.diff) || 1));
    } catch (_) { diff = 1; }
    const weight = dw * hw * diff * w;
    vol += weight;
    if (a.correct) good += weight;
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
  if (!scale.length || !(total > 0)) return { low: 0, high: 0, mid: 0, primary: 0, mastery: 0, hw: 0, empty: true };
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
  const readiness = forecastReadiness(covered, skills.length);
  if (!readiness.ready) {
    // Мало данных: числа нет, есть честная плашка с прогрессом до порога.
    return {
      low: 0, high: 0, mid: 0, primary: 0, mastery: 0, hw: 0,
      empty: true, premature: true,
      doneLessons: readiness.doneLessons, needLessons: readiness.needLessons,
      totalLessons: readiness.totalLessons, covered: readiness.covered,
      needTopics: readiness.needTopics, totalTopics: readiness.totalTopics,
    };
  }
  const mastery = wSum ? wMastery / wSum : 0;
  const primary = (mastery / 100) * total;
  const mid = scale[Math.max(0, Math.min(scale.length - 1, Math.round(primary)))] ?? 0;
  /* Живой диапазон: мало данных — широко (±12), всё покрыто — узко (±3). */
  const hw = 12 - Math.round((9 * covered) / skills.length);
  return {
    low: Math.max(0, mid - hw),
    // Потолок диапазона берём только из шкалы текущего предмета.
    high: Math.min(scale[scale.length - 1], mid + hw),
    mid,
    primary: Math.round(primary * 10) / 10,
    mastery: Math.round(mastery * 10) / 10,
    hw,
  };
}

/* «Что даст +N»: какой прирост тестового балла принесёт полное
   закрытие каждой темы. Считается через ту же цепочку
   (взвешенное среднее → первичные → шкала), поэтому вклад тем
   определяется конфигом текущего предмета. Сочинение в этот список
   попадает только для готовых (см. essayReadyForGains ниже): его вес
   22 из 50 иначе всегда побеждал бы, и новичок видел бы «Закрой
   сочинение — будет +43» в первый же день. */
const ESSAY_READY_MASTERY = 50;

/* Навыки сочинений: хотя бы одно задание long_text. Пусто — в предмете
   сочинений нет и гейтить нечего. */
function essaySkillIds(skills) {
  const out = [];
  for (const s of skills) {
    const sid = s && String(s.id || s.skillId || "");
    if (!sid || out.includes(sid)) continue;
    let tasks = [];
    try { tasks = (typeof DataAPI !== "undefined" && DataAPI.tasksBySkill) ? DataAPI.tasksBySkill(sid) : []; } catch (_) { tasks = []; }
    if (safeArray(tasks).some(isEssayTask)) out.push(sid);
  }
  return out;
}

/* Готовность к подсказке про сочинение: тестовая часть освоена хотя бы
   наполовину (среднее освоение неэссеистических тем ≥ 50) либо сочинение
   уже пробовали писать — тогда это осознанный путь. Само сочинение
   доступно как раньше (Путь, рекомендации); здесь речь только про
   агрессивную кнопку «что даст больше всего». */
function essayReadyForGains(skills, masteryById) {
  const essay = essaySkillIds(skills);
  if (!essay.length) return { ready: true, essay };
  const attempted = new Set(safeArray(Store.state && Store.state.taskAttempts)
    .map((a) => a && String(a.skill || a.skillId || "")).filter(Boolean));
  if (essay.some((id) => attempted.has(id))) return { ready: true, essay };
  let ew = 0, ewm = 0;
  for (const s of skills) {
    const sid = String(s.id);
    if (essay.includes(sid)) continue;
    const w = skillEgeWeight(sid);
    ew += w;
    ewm += w * (Number(masteryById[sid]) || 0);
  }
  return { ready: ew > 0 && ewm / ew >= ESSAY_READY_MASTERY, essay };
}

function forecastTopGains(n = 3) {  if (!forecastConfigAvailable()) return [];
  const scale = forecastScale(), total = forecastTotal();
  if (!scale.length || !(total > 0)) return [];
  const skills = (DataAPI.availableSkills ? DataAPI.availableSkills() : DataAPI.skills())
    .filter((s) => skillEgeWeight(s.id) > 0);
  if (!skills.length) return [];
  const now = Date.now();
  const base = forecast();
  if (base.empty) return [];
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
  const essayGate = essayReadyForGains(skills, masteryById);
  const gains = [];
  for (const s of skills) {
    const sid = String(s.id);
    if (!essayGate.ready && essayGate.essay.includes(sid)) continue;
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
  if (value.empty) return null;
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
  // Снимки хранятся под московской датой (todayStr), поэтому и срез окна
  // считаем по ней же (dateKeyForTimestamp), а не по локальной дате браузера:
  // иначе вдали от Москвы крайние дни выпадали бы из окна на сутки раньше.
  const cutoff = dateKeyForTimestamp(Date.now() - (days - 1) * 86400000);
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
   Длинные текстовые ответы (итоговое сочинение): общий с сервером
   (server.py, ESSAY_WORD_RE) алгоритм подсчёта слов. Слово —
   непрерывный блок букв/цифр (кириллица, латиница), внутри которого
   допустимы дефис/апостроф без пробелов. Пунктуация и переносы строк
   словами не считаются. Минимум — обязательная серверная проверка;
   здесь он же используется только для живого счётчика и блокировки
   кнопки отправки.
   ============================================================ */

const ESSAY_MIN_WORDS = 150;
const ESSAY_WORD_RE = /[0-9A-Za-zА-Яа-яЁё]+(?:['’\-–][0-9A-Za-zА-Яа-яЁё]+)*/g;

function countWords(text) {
  const matches = String(text == null ? "" : text).match(ESSAY_WORD_RE);
  return matches ? matches.length : 0;
}

/* ============================================================
   Задания-«таблицы соответствия»: ответ — цифра под каждой буквой
   (А, Б, В, Г, Д), как в бланке ЕГЭ. Буквы берём из самого текста
   задания: явный список «(АБВГ)»/«(ABCD)» или метки строк «А) …».
   Включаем только настоящие соответствия: в тексте должно быть
   «соответствие» (или «под каждой буквой/точкой»), иначе мультивыбор
   («укажите варианты»), физика с «(RC)» и русский с «(НЕ)» ошибочно
   попали бы в таблицу. Если структура не распознана — пустой список,
   и экран задания остаётся с обычным полем ввода.
   ============================================================ */
const MATCHING_ANSWER_RE = /соответстви|соотнеси|под каждой буквой|под каждой точкой/i;
const MATCHING_CYR = "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ";
const MATCHING_LAT = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/* Явный список букв-подписей должен быть строго подряд от А/A: «АБВГ»,
   «ABCD». Тогда «(RC)», «(НЕ)», «(ПО)» отсеиваются сами собой. */
function isConsecutiveLetterList(seq) {
  const s = String(seq || "");
  if (s.length < 2) return false;
  const base = MATCHING_CYR.includes(s[0]) ? MATCHING_CYR
    : MATCHING_LAT.includes(s[0]) ? MATCHING_LAT : "";
  if (!base) return false;
  for (let i = 0; i < s.length; i++) if (base.indexOf(s[i]) !== i) return false;
  return true;
}

function matchingAnswerLetters(task) {
  if (!task || task.type !== "short_answer") return [];
  const answer = String(task.answer || "").trim();
  if (!/^\d{2,8}$/.test(answer)) return [];
  const text = String(task.text || "");
  if (!MATCHING_ANSWER_RE.test(text)) return [];
  // Явный список букв: «(АБВГ)», «(ABCD)», «в порядке АБВ» (биология) или
  // «соответствующем буквам: А Б В» (письма через пробелы — задания-таблицы).
  const explicit = text.match(/\(([А-ЯA-Z]{2,8})\)/)
    || text.match(/в порядке\s+([А-ЯA-Z]{2,8})/)
    || text.match(/буквам:\s*([А-ЯA-Z](?:\s+[А-ЯA-Z])+)/);
  if (explicit) {
    const seq = explicit[1].replace(/\s+/g, "");
    if (seq.length === answer.length && isConsecutiveLetterList(seq)) {
      return seq.split("");
    }
  }
  // Метки строк «А) …», «A) …».
  const labels = [];
  const re = /(?:^|\n)\s*([А-ЯA-Z])\)\s/g;
  let m;
  while ((m = re.exec(text)) !== null) labels.push(m[1]);
  if (labels.length === answer.length) return labels;
  // Метки в скобках «______ (А)» (заполнение таблиц): в тексте идут не по
  // порядку, а ответ записывают в алфавитном — сортируем.
  const paren = [];
  const parenRe = /\(([А-ЯA-Z])\)/g;
  while ((m = parenRe.exec(text)) !== null) {
    if (!paren.includes(m[1])) paren.push(m[1]);
  }
  if (paren.length === answer.length && answer.length >= 2) return paren.slice().sort();
  return [];
}

/* ============================================================
   Проверка ответов
   ============================================================ */

function normalizeAnswer(str) {
  return String(str).trim().toLowerCase().replace(/\s+/g, "").replace(/ё/g, "е").replace(/,/g, ".").replace(/[−–—]/g, "-");
}

/* Задания, где ответ — строка цифр, а не число: набор выбранных номеров
   («выберите верные суждения, запишите цифры, под которыми они указаны»),
   последовательность («установите последовательность») и коды соответствия
   («1432», «для каждой величины»). Для всех них запятая, точка с запятой,
   пробел и точка — разделитель цифр, а не десятичная запятая: «2,4,5» и
   «2 4 5» равны «245», а «1.2.4.3» — «1243». Порядок важен только у
   последовательностей и кодов; у набора номеров ответ — множество. */
const DIGIT_SEQUENCE_TEXT_RE =
  /установите\s+(?:правильную\s+)?последовательность|расположите\s+в\s+(?:правильном\s+)?порядке|(?:запишите|восстановите)\s+последовательность|для\s+каждой\s+(?:величин|ячейк)|заполните\s+пустые\s+ячейк/i;

const MULTISELECT_TASK_RE = /укажите\s+(?:все\s+)?варианты|выберите\s+(?:все\s+)?(?:варианты|номера|ответы)|номера\s+ответов/i;
/* Формулировки набора из живых банков (общество, русский, биология): «запишите
   цифры, под которыми они указаны», «укажите цифру(-ы), на месте которой…»,
   «выберите верные суждения», «найдите в приведённом списке». Все они просят
   выбрать номера, а не задать порядок. */
const DIGIT_SET_TASK_RE = /под\s+котор\S*\s+(?:они\s+)?указан|(?:запишите|укажите)\s+в\s+ответ\s+(?:цифр|номера)|укажите\s+(?:все\s+)?цифр|на\s+месте\s+котор\S*\s+(?:пишется|должн)|(?:выберите|выпишите)\s+(?:верные|правильные|все)?\s*(?:суждени|утверждени|варианты|номера|ответы|признаки|позиции|термины)|(?:найдите|укажите)\s+в\s+(?:приведён|приведен|данн|указанн)\S*\s*(?:ниже\s*)?(?:списке|перечне)|(?:запишите|укажите|выпишите|напишите)\s+(?:их\s+)?номера|напишите\s+номер|(?:один\s+)?набор\s+номеров/i;

function isDigitSequenceTask(task) {
  if (!task) return false;
  const answer = String(task.answer ?? "").trim();
  if (!/^\d{2,8}$/.test(answer)) return false;
  if (/(цифр|последовательност)/i.test(String(task.valueType || ""))) return true;
  const text = String(task.text || "");
  if (DIGIT_SEQUENCE_TEXT_RE.test(text)) return true;
  if (DIGIT_SET_TASK_RE.test(text)) return true;
  return matchingAnswerLetters(task).length > 0;
}

/* Настоящий мультивыбор («укажите варианты ответов, в которых…»): ответ —
   НАБОР номеров, а не последовательность. В бланке ЕГЭ их пишут по
   возрастанию, но записанный в порядке находки набор — тот же ответ,
   поэтому порядок не важен. Соответствия (буква→цифра) и позиционные коды
   сюда не попадают: у них порядок смысловой, их отсекают matchingAnswerLetters
   и DIGIT_SEQUENCE_TEXT_RE.

   Метку valueType здесь намеренно НЕ смотрим: у наборов базовой математики
   (b08: «запишите номера выбранных утверждений») проставлена авто-метка
   «последовательность цифр», и по ней верный ответ в другом порядке
   отвергался. Формулировка задания главнее метки. */
function isMultiSelectTask(task) {
  if (!task) return false;
  const answer = String(task.answer ?? "").trim();
  if (!/^\d{2,8}$/.test(answer)) return false;
  if (matchingAnswerLetters(task).length > 0) return false;
  const text = String(task.text || "");
  if (DIGIT_SEQUENCE_TEXT_RE.test(text)) return false;
  return MULTISELECT_TASK_RE.test(text) || DIGIT_SET_TASK_RE.test(text);
}

/* Чистая последовательность цифр без разделителей (порядок важен). */
function digitSequenceValue(value) {
  return String(value ?? "").replace(/[^\d]/g, "");
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
  // Набор цифр проверяем как строку: разделители между цифрами (запятая,
  // точка с запятой, пробел, точка) не должны ломать верный ответ — «2,4,5»
  // и «2 4 5» равны «245». У последовательностей и кодов соответствия порядок
  // смысловой, а у мультивыбора ответ — множество, и порядок не важен.
  if (isDigitSequenceTask(task)) {
    const wanted = [task.answer, ...((Array.isArray(task.accept) ? task.accept : []).map(String))]
      .map(digitSequenceValue).filter(Boolean);
    const got = digitSequenceValue(input);
    if (!got) return false;
    if (isMultiSelectTask(task)) {
      const asSet = (s) => s.split("").sort().join("");
      return wanted.map(asSet).includes(asSet(got));
    }
    return wanted.includes(got);
  }
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
    // Пустой ввод не равен ничему — в том числе нулю. Без этой строки
    // Number("") === 0 засчитывало верный ответ заданиям с эталоном «0».
    if (!a || !b) return false;
    if (a === b) return true;
    const na = numericAnswer(a), nb = numericAnswer(b);
    if (Number.isFinite(na) && Number.isFinite(nb) && Math.abs(na - nb) < 1e-6) return true;
    // Словесный ответ: дефис, тире и пробел — один разделитель, поэтому
    // «официально деловой» = «официально-деловой» = «официально–деловой».
    if (/[a-zа-яё]/i.test(a) && /[a-zа-яё]/i.test(b)) {
      const loose = (s) => s.replace(/[\s\-–—−]+/g, "");
      if (loose(a) === loose(b)) return true;
    }
    return false;
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

/* ============================================================
   Ежедневная подборка

   Подборка — не лотерея и не «первые N заданий каталога», а набор под
   конкретного ученика: как миссии и «что делать сейчас», она смотрит на
   открытые ошибки, точность и освоение тем. При этом одна и та же дата
   всегда даёт один и тот же набор: сид дня (московская дата + аккаунт)
   детерминированно перемешивает темы с равной необходимостью, поэтому
   подборка меняется ровно в полноцу по МСК, а не на каждом рендере.
   ============================================================ */

/* Стабильный 32-битный хеш строки (FNV-1a): один и тот же текст всегда
   даёт одно и то же «случайное» число. От него нужен детерминизм, а не
   стойкость, поэтому простой хеш здесь лучше Math.random. */
function dailyHash(text) {
  let h = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/* Насколько теме сейчас нужна работа — те же сигналы, что у миссий и
   рекомендаций: открытые ошибки весят больше всего, за ними точность,
   нехватка освоения и совсем нетронутая тема. Тема, которую только что
   интенсивно тренировали, сегодня уходит вниз: иначе подборка повторяет
   только что сделанное вместо того, чтобы двигать дальше. */
function dailySkillNeed(skillId) {
  const state = Store.state || {};
  const stats = safeObject(state.skillStats && state.skillStats[skillId]);
  const solved = Math.max(0, Number(stats.solved) || 0);
  const accuracy = solved ? Number(stats.correct) / solved : null;
  let need = openErrorCount(skillId) * 12;
  need += accuracy === null ? 6 : Math.max(0, 1 - accuracy) * 8;
  need += Math.max(0, 100 - skillProgress(skillId)) * 0.05;
  if (!solved) need += 4;
  const recentCutoff = Date.now() - 2 * 3600 * 1000;
  let recent = 0;
  for (const a of safeArray(state.taskAttempts)) {
    if (!a || String(a.skill) !== String(skillId)) continue;
    if ((Number(a.ts) || 0) >= recentCutoff) recent++;
  }
  if (recent >= 4) need -= 6;
  return need;
}

/* Очередь заданий темы для повторяющихся проходов: сперва то, чего
   ученик ещё не решал, затем то, что давно не открывал. Сид дня
   разводит задания, по которым истории нет вовсе, — иначе у любого
   нового ученика первым всегда оказывался бы один и тот же номер. */
function rotatedTaskBank(skillId, seedText) {
  const bank = DataAPI.practiceTasksBySkill(skillId)
    .filter((task) => task && task.id && !isEssayTask(task));
  if (!bank.length) return [];
  const solved = new Set();
  const lastSeen = {};
  for (const a of safeArray((Store.state || {}).taskAttempts)) {
    if (!a || String(a.skill) !== String(skillId)) continue;
    const id = dataIdValue(a.taskId);
    if (!id) continue;
    lastSeen[id] = Math.max(Number(lastSeen[id]) || 0, Number(a.ts) || 0);
    if (a.correct) solved.add(id);
  }
  return bank.slice().sort((a, b) => {
    const ia = dataIdValue(a.id), ib = dataIdValue(b.id);
    if (solved.has(ia) !== solved.has(ib)) return solved.has(ia) ? 1 : -1;
    const ta = lastSeen[ia] || 0, tb = lastSeen[ib] || 0;
    if (ta !== tb) return ta - tb;
    const ha = dailyHash(seedText + "|" + ia), hb = dailyHash(seedText + "|" + ib);
    return ha - hb || ia.localeCompare(ib);
  });
}

/* Слабость темы 0..∞: открытые ошибки, низкая точность, нехватка
   освоения. Тот же смысл, что у skillSnapshot/слабых мест в «что делать
   сейчас», — подборка и боссы смотрят на те же сигналы, что и миссии. */
function skillWeakness(skillId, state) {
  const s = state || Store.state || {};
  const stats = safeObject(s.skillStats && s.skillStats[skillId]);
  const accuracy = stats.solved ? Number(stats.correct) / Number(stats.solved) : 0;
  return openErrorCount(skillId) * 8
    + Math.max(0, 1 - accuracy) * 5
    + Math.max(0, 100 - skillProgress(skillId)) * 0.04;
}

function selectDailyTaskIds(date) {
  if (!subjectLearningAvailable()) return [];
  const daily = DataAPI.daily();
  const target = Math.max(0, Math.floor(Number(daily.target) || 0));
  if (!target) return [];
  /* Сочинения (long_text) в подборку не берём: это отдельный поток — одно
     сочинение за визит, редактор и ИИ-проверка вместо карточки ответа. */
  const pool = DataAPI.practiceTasks().filter((task) => task && task.id && task.skill && !isEssayTask(task));
  if (!pool.length) return [];

  const dayKey = String(date || dailyDateKey());
  /* Сид дня: московская дата + аккаунт + предмет. Разные ученики получают
     разную подборку, один ученик — одну и ту же весь день. */
  const seed = `daily|${dayKey}|${String(Store.accountId || "")}|${currentSubjectId()}`;

  /* Задания, которые уже были в подборке за последние две недели: повтор
     подряд обесценивает день, поэтому внутри темы они уходят в конец. */
  const dayStart = Date.parse(dayKey);
  const recentDaily = new Set();
  if (Number.isFinite(dayStart)) {
    for (const entry of dailyHistory()) {
      if (!entry || !entry.date) continue;
      const entryDay = Date.parse(entry.date);
      if (!Number.isFinite(entryDay) || entryDay < dayStart - 13 * 86400000) continue;
      for (const id of safeArray(entry.taskIds)) recentDaily.add(dataIdValue(id));
    }
  }

  const bySkill = {};
  for (const task of pool) (bySkill[task.skill] = bySkill[task.skill] || []).push(task);

  /* Необходимость темы считаем один раз на выборку: иначе компаратор
     сортировки пересчитывал бы её на каждое сравнение. */
  const needById = {};
  for (const skillId of Object.keys(bySkill)) needById[skillId] = dailySkillNeed(skillId);

  const orderedSkills = Object.keys(bySkill).sort((a, b) => {
    const need = (needById[b] || 0) - (needById[a] || 0);
    if (need) return need;
    const hash = dailyHash(seed + "|skill|" + a) - dailyHash(seed + "|skill|" + b);
    return hash || String(a).localeCompare(String(b));
  });

  /* Очередь каждой темы: сперва нерешённое и давно не виденное, в самом
     конце — то, что уже было в подборке последних двух недель. */
  const queues = {};
  for (const skillId of orderedSkills) queues[skillId] = rotatedTaskBank(skillId, seed);

  /* Один день — широкий охват: сперва по одному заданию из самых «нужных»
     тем. Если тем не хватило (узкий предмет), следующие круги добирают
     задания из тех же тем по очереди. */
  const maxPerSkill = Math.max(1, Math.ceil(target / 2));
  const picked = [];
  const used = new Set();
  const perSkill = {};
  for (let round = 0; picked.length < target; round++) {
    const before = picked.length;
    for (const skillId of orderedSkills) {
      if (picked.length >= target) break;
      const limit = round === 0 ? Math.min(maxPerSkill, queues[skillId].length) : queues[skillId].length;
      if ((perSkill[skillId] || 0) >= limit) continue;
      const next = queues[skillId].find((task) => !used.has(dataIdValue(task.id))
        && (round > 0 || !recentDaily.has(dataIdValue(task.id))));
      if (!next) continue;
      picked.push(next.id);
      used.add(dataIdValue(next.id));
      perSkill[skillId] = (perSkill[skillId] || 0) + 1;
    }
    // Больше нечего добавить: банк предмета исчерпан.
    if (picked.length === before) break;
  }
  return picked;
}

/* «Смешанное испытание»: набор под ученика, а не первые N тем каталога.
   Раньше повторный запуск всегда давал одни и те же задания — первые count
   навыков по порядку и самый первый task в каждом. Теперь темы с открытыми
   ошибками и низкой точностью идут первыми, а внутри темы задание ротируется:
   нерешённые и давно не решённые раньше свежих, поэтому следующий запуск
   берёт следующие задания, а не повторяет прошлые. Одна тема — одно задание
   за круг, чтобы охват оставался широким.

   Необязательные аргументы нужны боссам: pool ограничивает набор веткой
   босса, seedText разводит задания, по которым истории нет вовсе (сид дня),
   чтобы у каждого нового ученика слепок ветки не начинался с одного и того
   же номера. */
function mixedTrialTaskIds(count, pool, seedText) {
  const total = Math.max(0, Math.floor(Number(count) || 0));
  if (!total || !subjectLearningAvailable()) return [];
  /* Без сочинений: смешанное испытание — быстрая проверка коротких ответов,
     сочинение живёт в своём потоке (одно за визит, редактор, ИИ-проверка). */
  const source = Array.isArray(pool) && pool.length ? pool : DataAPI.practiceTasks();
  const playable = source.filter((task) => task && task.id && task.skill && !isEssayTask(task));
  if (!playable.length) return [];
  const ordered = playable.slice().sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  const bySkill = {};
  for (const task of ordered) (bySkill[task.skill] = bySkill[task.skill] || []).push(task);
  const state = Store.state || {};
  const lastAttemptAt = {};
  for (const attempt of safeArray(state.taskAttempts)) {
    if (!attempt || !attempt.taskId) continue;
    const key = String(attempt.taskId);
    lastAttemptAt[key] = Math.max(Number(lastAttemptAt[key]) || 0, Number(attempt.ts) || 0);
  }
  const skillOrder = DataAPI.skills().map((sk) => sk.id).filter((id) => bySkill[id]);
  const rankedSkills = skillOrder.slice().sort((a, b) => skillWeakness(b) - skillWeakness(a) || skillOrder.indexOf(a) - skillOrder.indexOf(b));
  const picked = [];
  for (let round = 0; picked.length < total && round < 10; round++) {
    for (const skillId of rankedSkills) {
      if (picked.length >= total) break;
      const bank = (bySkill[skillId] || []).slice().sort((a, b) => {
        const ta = lastAttemptAt[String(a.id)] || 0;
        const tb = lastAttemptAt[String(b.id)] || 0;
        if (ta !== tb) return ta - tb;
        if (seedText) {
          const ha = dailyHash(seedText + "|task|" + String(a.id));
          const hb = dailyHash(seedText + "|task|" + String(b.id));
          if (ha !== hb) return ha - hb;
        }
        return String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
      });
      const next = bank[round];
      if (next) picked.push(next);
    }
  }
  return picked.map((task) => task.id);
}

/* Набор босса: смешанные задания его ветки. Раньше босс каждый раз брал
   самый первый номер каждой темы — «Пройти снова» возвращало тот же слепок,
   и часть тем ветки (номеров за пределами первых size навыков) в испытании
   не встречалась вовсе. Теперь темы ветки идут по слабости, задание внутри
   темы ротируется (нерешённое и давно не виденное впереди), а сид дня
   разводит стартовый набор между учениками и между днями. */
function bossTaskIds(boss) {
  const canonical = DataAPI.bosses().find((item) => String(item.id) === String(boss && (boss.id || boss)));
  if (!canonical || !subjectLearningAvailable()) return [];
  const cat = String(canonical.cat || canonical.category || "");
  if (!cat) return [];
  const pool = DataAPI.practiceTasks().filter((task) => {
    if (!task || !task.id || !task.skill || isEssayTask(task)) return false;
    const skill = DataAPI.skill(task.skill);
    return !!skill && String(DataAPI._skillCategoryId(skill)) === cat;
  });
  const size = Math.max(1, Math.floor(Number(canonical.size) || 0));
  const seed = `boss|${dailyDateKey()}|${String(Store.accountId || "")}|${canonical.id}`;
  return mixedTrialTaskIds(size, pool, seed);
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
      /* Записи дня больше не существует в каталоге (контент обновился):
         мусорная строка не должна блокировать пересборку — убираем её,
         следующий вызов возьмёт свежий набор, а не пустой день. */
      state.daily = { date, solved: 0, done: false, taskIds: [] };
      state.dailyHistory = dailyHistory().filter((entry) => !entry || entry.date !== date);
      Store.save();
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

function recordAnswer(task, correct, hintLevel, seconds, closesTaskId, wrongAttempts, essayScore) {
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
    // Проверенное сочинение: балл AI известен только с готовым результатом
    // (essayRunChecks передаёт его сюда) — XP идёт по гибкой шкале essayXp,
    // а не по фиксу attemptXp. Без балла (не должно случаться в UI) — обычный
    // путь; повтор того же задания — только минимум за посещение.
    let parts;
    if (isEssayTask(task) && !alreadyMastered && Number.isFinite(Number(essayScore))) {
      const total = essayXp(essayScore);
      const base = attemptXp(task, true, hintLevel, true).attempt;
      parts = { attempt: base, correctBonus: total - base, total };
    } else {
      parts = attemptXp(task, true, hintLevel, alreadyMastered);
    }
    xp = parts.total;
    xpBreakdown = { attempt: parts.attempt, correctBonus: parts.correctBonus, errorResolved: 0 };
    st.progress = skillProgress(skillId);
    // Осмысленный шаг гостя: впервые освоенное задание (повторы не считаются).
    if (!alreadyMastered) bumpGuestSteps(1);

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
      const closedKind = errorKindOf(err);
      err.resolved = true;
      err.resolvedAt = Date.now();
      s.errorsResolved++;
      xp += XP_ERROR_RESOLVED;
      xpBreakdown.errorResolved += XP_ERROR_RESOLVED;
      // Мини-ошибка — это не провал, а закрепление: верное решение с
      // подсказкой, которое довели до чистого. Разные слова и в ленте.
      addTimeline(closedKind === "minor" ? `Закреплено: ${task.sub}` : `Закрыта ошибка: ${task.sub}`);
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
  if (firstCompletion) bumpGuestSteps(GUEST_STEP_LESSON);
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
  bumpGuestSteps(GUEST_STEP_MISSION);
  Store.emit("missiondone", canonical);
  Store.save();
  return true;
}

/* Босс открывается, когда ветка пройдена до порога из каталога. Порог
   достижим обычным путем: 40% — это ровно столько, сколько даёт полный
   набор уроков ветки, поэтому босс обязан требовать меньше — иначе до него
   не добраться никому, кто не решил всё разом. */
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
  Store.state.bossesDefeated.push(canonical.id);
  addTimeline(`Босс повержен: ${String(canonical.title || "Босс").replace("БОСС: ", "")}`);
  addXp(canonical.xp, "boss");
  bumpGuestSteps(GUEST_STEP_BOSS);
  /* Рывка навыков ветки здесь нет и быть не может: освоение считается из
     реально решённых заданий и пройденных уроков, а не из флага «босс
     повержен». Раньше цикл ниже переписывал skillStats.progress тем же
     значением, что и так вычисляется, а экран результата обещал «+6% к
     навыкам ветки» — обещание, которого не происходило. Награда босса —
     XP, достижение и честный рост ветки за решённые в испытании задания
     (его показывает screenSession/sessionFinish). */
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
  // пройденная activity, но никогда не сохраняется сервером.
  if (!Store.state || !subjectLearningAvailable()) return;
  Store.state.timeline = safeArray(Store.state.timeline);
  Store.state.timeline.unshift({ id: newEntityId(), ts: Date.now(), text });
  if (Store.state.timeline.length > 40) Store.state.timeline.length = 40;
}

/* ============================================================
   Рекомендации (rule-based)

   Приоритет одного «что делать дальше» построен на двух правилах.
   Первое — закончить начатое: любая незавершённая активность (открытый
   урок, миссия с прогрессом, частичная ежедневная подборка) стоит выше
   любого нового шага, а среди начатых первым идёт то, к чему позже
   прикасались (startedTs). Качество не учитывается: завершение — это
   факт, а не оценка.
   Второе — для остального стоимость и полезность действия, а не
   произвольный порядок проверок:
   1) накопленные открытые ошибки — конкретный, проверенный сигнал слабости;
   2) самый слабый навык — но не тот, что только что интенсивно тренировали
      (иначе рекомендация зацикливается на бессмысленном повторе);
   3) испытания — босс, если открыт, иначе Daily Challenge, если не закрыт.
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
    lastTs,
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
   открытых ошибок, больше промахов диагностики, больше решено.
   Снимки берутся из переданной карты (посчитаны один раз вызывателем),
   а не пересчитываются на каждое сравнение: иначе движок на каждом
   рендере дашборда сканировал бы всю историю попыток по квадрату. */
function weakestOf(pool, snaps) {
  let worst = null, worstSnap = null;
  for (const sk of pool) {
    const snap = (snaps && snaps[sk.id]) || skillSnapshot(sk.id);
    if (!snap) continue;
    if (!worst) { worst = sk; worstSnap = snap; continue; }
    const a = snap, b = worstSnap;
    if (a.progress !== b.progress) { if (a.progress < b.progress) { worst = sk; worstSnap = snap; } continue; }
    if (a.openErrors !== b.openErrors) { if (a.openErrors > b.openErrors) { worst = sk; worstSnap = snap; } continue; }
    if (a.diagnosticMisses !== b.diagnosticMisses) { if (a.diagnosticMisses > b.diagnosticMisses) { worst = sk; worstSnap = snap; } continue; }
    if (a.solved !== b.solved) { if (a.solved > b.solved) { worst = sk; worstSnap = snap; } }
  }
  return worst;
}

function candidateSkillId(cand) {
  const p = (cand && cand.payload) || {};
  if (p.skillId) return String(p.skillId);
  const lesson = p.lessonId ? DataAPI.lesson(p.lessonId) : null;
  return lesson && lesson.skill ? String(lesson.skill) : "";
}

/* Начатые кандидаты (startedTs > 0) всегда выше новых, между собой — по
   убыванию свежести последнего шага. Урок, начатый позже миссии, вытесняет
   её; миссия, к которой вернулись после урока, — наоборот. */
function startedFirst(a, b) {
  const at = Number(a && a.startedTs) || 0;
  const bt = Number(b && b.startedTs) || 0;
  if (!at && !bt) return 0;
  if (!at) return 1;
  if (!bt) return -1;
  return bt - at;
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
      cta: "Продолжить",
      text: `Продолжить урок «${openLesson.lesson.title}»`,
      reason: `Урок уже начат и сохранён на шаге ${Math.min((openLesson.session.idx || 0) + 1, DataAPI.lessonStepsCount(openLesson.lesson))} из ${DataAPI.lessonStepsCount(openLesson.lesson)} — доучить начатое проще всего.`,
      score: 92,
      startedTs: Number(openLesson.session.ts) || Number(openLesson.session.startTs) || 0,
    });
  }

  /* Снимки по всем навыкам — основа остальных кандидатов. */
  const snaps = {};
  for (const sk of (DataAPI.availableSkills ? DataAPI.availableSkills() : DataAPI.skills())) {
    const snapshot = skillSnapshot(sk.id);
    if (snapshot) snaps[sk.id] = snapshot;
  }
  const mentionedSkills = () => Object.keys(snaps).filter((id) => mentioned.has(id));

  /* 1b. Продолжить начатую тренировку. Урок — не единственная «начатая»
     активность: миссия с прогрессом уже сохранена в состоянии. Завершение
     начатого важнее любого нового шага, поэтому кандидат создаётся и при
     высоком освоении, и когда урок этой же темы уже представлен: финальная
     сортировка по startedTs сама решит, что из начатого свежее. Бросать
     работу на половине хуже, чем начать новое. */
  {
    const doneMissions = safeObject(s.missionsDone);
    for (const sk of (DataAPI.availableSkills ? DataAPI.availableSkills() : DataAPI.skills())) {
      const snap = snaps[sk.id];
      if (!snap || !snap.mission) continue;
      const mission = snap.mission;
      if (doneMissions[mission.id]) continue;
      const total = missionPracticeCount(mission);
      const prog = missionProgress(mission);
      if (!(total > 0 && prog > 0 && prog < total)) continue;
      mentioned.add(sk.id);
      push({
        action: "practice",
        payload: { missionId: mission.id, skillId: sk.id },
        route: "#/training", icon: "target",
        cta: "Продолжить",
        text: `Продолжить тренировку по теме «${sk.name}» — ${prog}/${total}`,
        reason: `Тренировка по «${sk.name}» уже начата — закончить её проще, чем начинать новое.`,
        score: 88,
        startedTs: snap.lastTs || 0,
      });
    }
  }

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
      cta: "Повторить",
      text: `Повторить слабые места — на разбор ${openErrors.length}`,
      reason: openErrors.length >= 3
        ? `Накопилось несколько незакрытых пунктов — их повторение даст больше, чем новая тема.`
        : `Незакрытый пункт со временем забывается — закрой его, пока контекст свежий.`,
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
        cta: repeatAfterFail ? "Повторить" : (untouched ? "Начать" : "Вернуться"),
        text: repeatAfterFail
          ? `Повторить урок «${snap.lesson.title}» — тема «${weakTheory.name}» так и не освоена`
          : `${untouched ? "Начать урок" : "Вернуться к уроку"} «${snap.lesson.title}» — тема «${weakTheory.name}»`,
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
     Незавершённая миссия — бонус: дешевле закончить начатое.
     Два случая НЕ дают кандидата вовсе, а не «со штрафом»: по теме
     с непройденным уроком сначала нужен урок (иначе «потренируйся»
     вытесняет «изучи», а подпись советовала бы не делать то, что делает
     кнопка), а перетренированную тему без начатой миссии полезнее
     отпустить — её представляет урок/ошибки/смена фокуса. Начатая
     миссия в обоих случаях остаётся: бросать работу на середине хуже. */
  {
    const pool = (DataAPI.availableSkills ? DataAPI.availableSkills() : DataAPI.skills()).filter((sk) => {
      const snap = snaps[sk.id];
      if (!snap || !snap.mission || mentioned.has(sk.id) || snap.progress >= 90) return false;
      const prog = missionProgress(snap.mission);
      const total = missionPracticeCount(snap.mission);
      const started = prog > 0 && total > 0 && prog < total;
      if (started) return true;
      // Теория раньше практики (см. выше).
      if (snap.lesson && !snap.lessonDone
        && (snap.solved === 0 || (snap.accuracy !== null && snap.accuracy < 0.5))) return false;
      // Пауза вместо зубрёжки (см. выше).
      if (snap.fatigued) return false;
      return true;
    });
    const target = weakestOf(pool, snaps);
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
      /* Урок не пройден, но попытки были удачными (например, чистая
         диагностика): практиковаться можно, но теория всё равно раньше —
         штраф держит такой кандидат ниже нетронутого урока. Подпись при
         этом честная: она не отправляет «сначала в теорию» с кнопки
         практики, а говорит про закрепление. */
      const theoryPending = !started && !!snap.lesson && !snap.lessonDone;
      if (theoryPending) score -= 20;
      /* Закрепление свежего: урок пройден совсем недавно — короткая
         тренировка сразу после теории закрепляет её лучше всего. */
      const lessonRecord = snap.lesson && safeObject(s.completedLessons)[snap.lesson.id];
       const lessonTs = lessonRecord ? Number(lessonRecord.ts) || 0 : 0;
      const justLearned = lessonTs && Date.now() - lessonTs < 2 * 3600 * 1000;
      if (justLearned && !snap.fatigued) score += 12;
      push({
        action: "practice",
        payload: { missionId: snap.mission.id, skillId: target.id },
        route: "#/training", icon: "target",
        cta: started ? "Продолжить" : "Тренироваться",
        text: started
          ? `Продолжить тренировку по теме «${target.name}» — ${prog}/${missionTotal}`
          : theoryPending
            ? `Закрепить тему «${target.name}» — база есть, урока ещё не было`
            : `Потренировать тему «${target.name}» — самое слабое место`,
        reason: started
          ? `Тренировка по «${target.name}» уже начата — закончить её сейчас проще всего.`
          : theoryPending
            ? `Урок по «${target.name}» ещё не пройден, но раньше ты отвечал верно — короткая серия закрепит тему, теория подождёт.`
            : snap.solved === 0
              ? `По теме «${target.name}» ещё не было практики (${snap.progress}%) — начни с короткой серии.`
              : (snap.ageMs < NEXTSTEP_RECENT_MS
                ? `«${target.name}» — самый отстающий навык (${snap.progress}%) — короткая серия закрепит результат.`
                : `«${target.name}» — самый отстающий навык (${snap.progress}%), и его давно не тренировали.`),
        score,
      });
    }
  }

  /* 4b. Сочинение по тексту (задание 27): у темы сочинений нет ни урока,
     ни миссии, поэтому секции 3–4 её никогда не выбирают — без отдельной
     секции самый весомый навык русского (22 из 50 первичных баллов) был
     бы невидим движку, а низкий прогресс по нему вечно давил бы
     «новую тему» и боссов через общий минимум. Сигналы те же, что
     у практики: освоение, свежесть, утомление. Исполнение — визитом
     startEssayPractice (одно сочинение), а не миссией. */
  {
    const pool = (DataAPI.availableSkills ? DataAPI.availableSkills() : DataAPI.skills()).filter((sk) => {
      const snap = snaps[sk.id];
      if (!snap || mentioned.has(sk.id) || snap.progress >= 90) return false;
      if (snap.mission || snap.lesson) return false;
      const bank = DataAPI.practiceTasksBySkill(sk.id);
      if (!(bank.length > 0 && bank.some((t) => t && (t.type === "long_text" || t.answerType === "long_text")))) return false;
      /* Совсем новому ученику (ни одного урока) первым шагом нужен урок,
         а не сочинение на 150+ слов: как и «теория раньше практики» выше. */
      if (snap.solved === 0 && Object.keys(safeObject(s.completedLessons)).length === 0) return false;
      return true;
    });
    const target = weakestOf(pool, snaps);
    if (target) {
      const snap = snaps[target.id];
      mentioned.add(target.id);
      let score = 56 + (100 - snap.progress) * 0.3;
      if (snap.ageMs < NEXTSTEP_RECENT_MS) {
        score -= (snap.recentAccuracy !== null && snap.recentAccuracy < 0.5) ? 22 : 10;
      }
      if (snap.fatigued) score -= 35;
      const untouched = snap.solved === 0;
      push({
        action: "essay",
        payload: { skillId: target.id },
        route: "#/training", icon: "pen",
        cta: "Написать",
        text: untouched
          ? `Написать сочинение по тексту — задание 27`
          : `Потренировать сочинение — задание 27 (${snap.progress}%)`,
        reason: untouched
          ? `Сочинение даёт 22 из 50 первичных баллов — почти половину экзамена. Первый текст лучше написать сейчас, а не откладывать.`
          : `Задание 27 — самое весомое в экзамене, а освоение пока ${snap.progress}% — одно сочинение сейчас даст больше всего.`,
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
        cta: "Сразиться",
        text: `Пройти босса: ${String(bestBoss.title || "итоговое испытание").replace(/^БОСС:\s*/, "")}`,
        reason: `Ветка «${(DataAPI.category(bestBoss.cat) || {}).name || "предмета"}» прокачана до ${catProgress(bestBoss.cat)}% — босс покажет, держится ли результат на смешанных заданиях.`,
        score: bestBossScore,
      });
    }
  }

  /* 6. Ежедневная подборка: стимул держать ритм, ниже работы над пробелами.
     Частично решённая — уже начатое дело: startedTs поднимает её выше
     любого нового шага (см. startedFirst). */
  ensureDailyChallenge();
  const dailyIds = dailyTaskIds();
  if (dailyIds.length && !s.daily.done) {
    const goal = dailyIds.length;
    const partial = Math.min(s.daily.solved || 0, goal) > 0;
    let dailyTs = 0;
    if (partial) {
      const inDaily = new Set([...dailyIds, ...safeArray(s.daily.countedTaskIds)].map(String));
      for (const a of safeArray(s.taskAttempts)) {
        if (inDaily.has(String(a.taskId))) dailyTs = Math.max(dailyTs, Number(a.ts) || 0);
      }
    }
    push({
      action: "daily",
      payload: {},
      route: "#/trials", icon: "zap",
      cta: partial ? "Закончить" : "Решить",
      text: partial ? `Закончить ежедневную подборку — ${Math.min(s.daily.solved, goal)}/${goal}` : "Решить ежедневную подборку",
      reason: partial
        ? `Подборка почти закрыта — один заход, и день засчитан.`
        : `Короткая подборка из ${goal} заданий поддержит ритм и серию дней.`,
      score: partial ? 52 : 40,
      startedTs: dailyTs,
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
        cta: "Открыть",
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
      cta: "Начать",
      text: "Пройти смешанное испытание",
      reason: `Слабых мест нет — проверка общей формы на заданиях из разных тем не даст застояться.`,
      score: 30,
    });
  }

  const priority = { "finish-lesson": 0, "lesson": 1, "errors-review": 2, "practice": 3, "essay": 3, "boss": 4, "daily": 5, "mixed": 6 };
  cands.sort((a, b) => startedFirst(a, b) || b.score - a.score || priority[a.action] - priority[b.action]);
  /* Один навык — один кандидат. Правило нужно, когда «начатых» действий
     одной темы несколько (например, открытый урок и начатая миссия):
     после сортировки первым идёт самое свежее, а более раннее не должно
     дублировать ту же тему отдельной подписью. */
  const seenSkills = new Set();
  return cands.filter((c) => {
    const sid = candidateSkillId(c);
    if (!sid) return true;
    if (seenSkills.has(sid)) return false;
    seenSkills.add(sid);
    return true;
  });
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

function guardOnboardingSubject(state, subject) {
  try {
    assertSubjectCatalog(subject);
    if (state && state.subject) assertSubjectCatalog(state.subject);
    if (Store.subject) assertSubjectCatalog(Store.subject);
  } catch (error) {
    Store.reportPersistenceError(error);
    return false;
  }
  return true;
}

function applyOnboarding(subject, selfLevel, goalId, diagnosticResults, name) {
  const s = Store.state;
  if (!s) return;
  /* Предмет — первая характеристика профиля; неизвестный id не отправляет
     нас обратно в профиль. */
  const current = typeof DataAPI !== "undefined" && DataAPI.currentSubject ? DataAPI.currentSubject() : Store.subject;
  const requested = subject ? String(subject) : "";
  const subj = requested && typeof DataAPI.subjectInfo === "function" && DataAPI.subjectInfo(requested)
    ? requested : String(current || "profile_math");
  // Onboarding не переключает каталог сам. До любой мутации проверяем, что
  // выбранный предмет и уже загруженный каталог — одна и та же идентичность.
  if (!guardOnboardingSubject(s, subj)) return false;
  Store.subject = subj;
  s.subject = subj;
  // Предмет выбран явно (онбординг): чужая SEO-ссылка дальше спросит
  // модалкой, а не переключит молча.
  try {
    if (typeof markSubjectExplicit === "function") markSubjectExplicit(subj);
  } catch (_) {}

  const learningAvailable = subjectLearningAvailable();
  if (!forecastConfigAvailable()) s.forecastHistory = [];
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
  if (!guardOnboardingSubject(s, subj)) return false;
  Store.subject = subj;
  s.subject = subj;
  // Тот же явный выбор предмета (онбординг без теста) — см. applyOnboarding.
  try {
    if (typeof markSubjectExplicit === "function") markSubjectExplicit(subj);
  } catch (_) {}
  const cleanedName = String(name || "").trim().replace(/\s+/g, " ").slice(0, 60);
  if (cleanedName) s.name = cleanedName;
  s.onboarded = true;
  Store.save();
}
