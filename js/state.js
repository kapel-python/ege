/* ============================================================
   ege easy — state & game logic
   Вся мутация прогресса идёт через этот модуль; UI только
   читает вычисляемые геттеры и подписывается на события.
   ============================================================ */

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

  /* ------- persistence ------- */

  defaultState() {
    const skills = {};
    for (const s of DataAPI.skills()) {
      skills[s.id] = { progress: 0, solved: 0, correct: 0, timeSec: 0 };
    }
    return {
      version: 4,
      stateVersion: 1,
      subject: Store.subject || (typeof DataAPI !== "undefined" && DataAPI.currentSubject && DataAPI.currentSubject()) || "profile_math",
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
      DataAPI.load(payload.catalog);
      this.accountId = payload.accountId || null;
      this.subject = (payload.state && payload.state.subject) || payload.catalog.subject || "profile_math";
      this.subjects = DataAPI.subjects();
      this.detailsPromise = null;
      const defaults = this.defaultState();
      const parsed = payload.state || {};
      this.state = Object.assign(defaults, parsed);
      this.state.subject = this.subject;
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
      this.lastSyncedState = JSON.parse(JSON.stringify(this.state));
      this.ready = true;
      this.lastSyncTs = Date.now();
      this.pendingExternalUpdate = false;
      ensureDailyChallenge();
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
    const qs = `?subject=${encodeURIComponent(this.subject || "profile_math")}`;
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
  mergeConflictState(fresh, local) {
    const merged = JSON.parse(JSON.stringify(fresh || {}));
    const unique = (items) => {
      const seen = new Set();
      return (items || []).filter((item) => {
        const key = JSON.stringify(item);
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

  async _saveSnapshot(snapshot) {
    snapshot.expectedVersion = snapshot.stateVersion;
    try {
      const result = await ApiClient.put("/api/state", snapshot);
      const nextVersion = result && result.stateVersion;
      if (Number.isInteger(nextVersion) && nextVersion > 0 && this.state && this.subject === snapshot.subject) {
        this.state.stateVersion = nextVersion;
        snapshot.stateVersion = nextVersion;
      }
      this.lastSyncedState = JSON.parse(JSON.stringify(snapshot));
      return result;
    } catch (error) {
      if (!error || error.status !== 409) throw error;
      // Reload first: no stale field is allowed to overwrite the state that
      // caused the conflict. Then merge only append/fact collections and retry
      // once against the version just read. Keep the live state too: a user may
      // have made another action while the conflicting request was in flight.
      const liveAtConflict = JSON.parse(JSON.stringify(this.state || {}));
      await this.load(snapshot.subject);
      const fresh = this.state;
      const rebased = this.mergeConflictState(this.mergeConflictState(fresh, snapshot), liveAtConflict);
      const result = await ApiClient.put("/api/state", {
        ...rebased,
        expectedVersion: rebased.stateVersion,
      });
      const nextVersion = result && result.stateVersion;
      if (Number.isInteger(nextVersion) && nextVersion > 0) rebased.stateVersion = nextVersion;
      this.state = rebased;
      this.lastSyncedState = JSON.parse(JSON.stringify(rebased));
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
        snapshot.subject = this.subject || snapshot.subject || "profile_math";
        return this.requestLeaderSave(snapshot);
      })
      .then(() => { this.persistenceError = null; this._noteOwnSave(); })
      .catch((error) => {
        this.persistenceError = error;
        this.emit("persistenceerror", error);
      });
    return this.pendingSave;
  },

  // Ключ маяка свой на предмет: вкладки разных предметов друг другу не указ.
  pingKey(subject) { return "ege_core_state_ping:" + (subject || "profile_math"); },

  // Успешно сохранились: фиксируем момент и будим соседние вкладки.
  // Только localStorage (без DOM/window) — безопасно для node-тестов.
  _noteOwnSave() {
    this.lastSyncTs = Date.now();
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(this.pingKey(this.subject),
          JSON.stringify({ subject: this.subject || "profile_math", ts: this.lastSyncTs }));
      }
    } catch (_) {}
  },

  // Чистое решение «чужой ли маяк новее нас» — без чтения хранилищ,
  // покрывается node-тестом напрямую.
  shouldRefreshForPing(ping) {
    if (!ping || typeof ping !== "object") return false;
    if (ping.subject !== (this.subject || "profile_math")) return false;
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

  // Переключение предмета: сервер возвращает каталог + состояние нового
  // предмета, клиент полностью заменяет текущие (без мержа) и перерисовывается.
  // Несохранённые изменения текущего предмета сначала дописываем.
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
  // Progress is mastery, not XP: theory is confirmed by a completed lesson
  // (40), practice grows from real answers and their accuracy (60, volume
  // capped at 10 answers). Topics without a lesson score 100 from practice.
  const theoryWeight = lessons.length ? 40 : 0;
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
  const theoryWeight = lessons.length ? 40 : 0;
  const practiceWeight = 100 - theoryWeight;
  const accuracy = stats.solved ? stats.correct / stats.solved : 0;
  const theory = lessons.length ? (lessonDone / lessons.length) * theoryWeight : 0;
  const practice = Math.min(1, stats.solved / 10) * accuracy * practiceWeight;
  return { total: Math.round(theory + practice), theory: Math.round(theory), practice: Math.round(practice), lessonDone, lessonTotal: lessons.length, solved: stats.solved, correct: stats.correct, accuracy: Math.round(accuracy * 100) };
}

function catProgress(catId) {
  const skills = DataAPI.skills().filter((s) => s.cat === catId);
  if (!skills.length) return 0;
  return Math.round(skills.reduce((a, s) => a + skillProgress(s.id), 0) / skills.length);
}

/* not-started | weak | in-progress | completed | mastered
   Topics are intentionally all available. The order in the path is a visual
   curriculum hint, not an access gate: every catalog topic can be practiced
   independently, including topics without a lesson. */
function skillStatus(skill) {
  const p = skillProgress(skill.id);
  const solved = (Store.state.skillStats[skill.id] || {}).solved || 0;
  if (p >= 90) return "mastered";
  if (p >= 70) return "completed";
  if (p < 35 && solved > 0) return "weak";
  // Тему вообще не трогали: ни ответов, ни закрытого урока, ни открытого —
  // это не "слабое место" и не "в процессе", а честное "не начата".
  const lessons = DataAPI.lessonsBySkill(skill.id);
  const touchedLesson = lessons.some((l) => Store.state.completedLessons[l.id]
    || (Store.state.lessonSessions && Store.state.lessonSessions[l.id]));
  if (solved === 0 && !touchedLesson) return "not-started";
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

function skillEgeWeight(skillId) {
  // Веса — конфиг текущего предмета (каталог: forecast.weights). Фолбэк —
  // встроенные константы профиля, чтобы старые пейлоады и тесты без
  // конфига считали как раньше.
  const cfg = (typeof DataAPI !== "undefined" && DataAPI.forecastConfig && DataAPI.forecastConfig()) || null;
  const weights = (cfg && cfg.weights) || SKILL_EGE_WEIGHTS;
  if (Object.prototype.hasOwnProperty.call(weights, skillId)) return weights[skillId];
  const skill = DataAPI.skill(skillId);
  if (!skill) return 0;
  return skill.cat === "part2" ? 2 : 1; // новый навык без веса: осторожная оценка
}

function forecastScale() {
  const cfg = (typeof DataAPI !== "undefined" && DataAPI.forecastConfig && DataAPI.forecastConfig()) || null;
  if (cfg && Array.isArray(cfg.scale) && cfg.scale.length) return cfg.scale;
  return PRIMARY_TO_TEST;
}

function forecastTotal() {
  const cfg = (typeof DataAPI !== "undefined" && DataAPI.forecastConfig && DataAPI.forecastConfig()) || null;
  if (cfg && Number(cfg.total) > 0) return Number(cfg.total);
  return TOTAL_EGE_PRIMARY;
}

function forecastConfigAvailable() {
  // Пустой предмет (база без контента): прогноза нет — экраны показывают
  // заглушку вместо нулей. Во всех остальных случаях считаем: по конфигу
  // предмета из каталога, а для legacy-пейлоадов без конфига (тесты) —
  // по встроенным константам профиля.
  if (typeof DataAPI !== "undefined" && DataAPI.isSubjectEmpty && DataAPI.isSubjectEmpty()) return false;
  return true;
}

/* Освоение темы глазами прогноза: та же шкала 0–100, что у
   skillProgress (40 теория + 60 практика), но практика считается по
   затухающим по давности попыткам, а не за всё время. Если живых
   попыток нет (старые аккаунты, тестовые фикстуры) — откат к
   суммарной статистике, чтобы не показывать ноль там, где работа была. */
function forecastSkillMastery(skillId, now) {
  const skill = DataAPI.skill(skillId);
  if (!skill) return 0;
  const lessons = DataAPI.lessonsBySkill(skillId);
  const lessonDone = lessons.filter((lesson) => !!Store.state.completedLessons[lesson.id]).length;
  const theoryWeight = lessons.length ? 40 : 0;
  const practiceWeight = 100 - theoryWeight;
  const theory = lessons.length ? (lessonDone / lessons.length) * theoryWeight : 0;

  const ts = Number(now) || Date.now();
  let vol = 0, good = 0, seen = false;
  for (const a of Store.state.taskAttempts) {
    if (!a || a.skill !== skillId) continue;
    seen = true;
    const ageDays = Math.max(0, (ts - (Number(a.ts) || 0)) / 86400000);
    const w = Math.exp(-ageDays / FORECAST_DECAY_DAYS);
    vol += w;
    if (a.correct) good += w;
  }
  let accuracy, volume;
  if (seen) {
    accuracy = vol > 0 ? good / vol : 0;
    volume = vol;
  } else {
    const stats = Store.state.skillStats[skillId] || { solved: 0, correct: 0 };
    accuracy = stats.solved ? stats.correct / stats.solved : 0;
    volume = stats.solved || 0;
  }
  const factor = Math.min(1, volume / FORECAST_FULL_VOLUME);
  const practice = factor * accuracy * practiceWeight;
  return Math.round(Math.min(100, theory + practice));
}

function forecast() {
  if (!forecastConfigAvailable()) return { low: 0, high: 0, mid: 0, primary: 0, mastery: 0, hw: 0, empty: true };
  const scale = forecastScale(), total = forecastTotal();
  const skills = DataAPI.skills().filter((s) => skillEgeWeight(s.id) > 0);
  if (!skills.length) return { low: 0, high: 0, mid: 0, primary: 0, mastery: 0, hw: 0, empty: true };
  const now = Date.now();
  let wSum = 0, wMastery = 0, covered = 0;
  const masteryById = {};
  for (const s of skills) {
    const w = skillEgeWeight(s.id);
    const m = forecastSkillMastery(s.id, now);
    masteryById[s.id] = m;
    wSum += w;
    wMastery += w * m;
    const lessons = DataAPI.lessonsBySkill(s.id);
    const hasLesson = lessons.some((l) => !!Store.state.completedLessons[l.id]);
    if (hasLesson || masteryById[s.id] >= 25) covered++;
  }
  const mastery = wSum ? wMastery / wSum : 0;
  const primary = (mastery / 100) * total;
  const mid = scale[Math.max(0, Math.min(scale.length - 1, Math.round(primary)))] ?? 0;
  /* Живой диапазон: мало данных — широко (±12), всё покрыто — узко (±3). */
  const hw = 12 - Math.round((9 * covered) / skills.length);
  return {
    low: Math.max(0, mid - hw),
    high: Math.min(100, mid + hw),
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
  const skills = DataAPI.skills().filter((s) => skillEgeWeight(s.id) > 0);
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
      xp += XP_ERROR_RESOLVED;
      xpBreakdown.errorResolved += XP_ERROR_RESOLVED;
      addTimeline(`Закрыта ошибка: ${task.sub}`);
    }
  } else {
    s.correctSeries = 0;
    // За сам факт попытки платим минимум — практика никогда не даёт +0 XP.
    xp = attemptXp(task, false, hintLevel, false).total;
    xpBreakdown = { attempt: xp, correctBonus: 0, errorResolved: 0 };
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
    return { firstCompletion, totalXp: 0, baseXp: 0, stepsXp: 0 };
  }

  // Награда за урок = базовая за тему (из каталога) + XP за шаги. Флаг
  // firstCompletion в lessonAttempts больше не несёт нагрузки анти-фарма:
  // сервер derive_stats считает по completedLessons, которое нельзя
  // подделать повторной отправкой (PK user_id+lesson_id).
  const baseXp = lesson.xp;
  const stepsXp = inputXp;
  const totalXp = baseXp + stepsXp;
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
  return { firstCompletion, totalXp, baseXp, stepsXp };
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
    addTimeline(`Босс повержен: ${boss.title.replace("БОСС: ", "")}`);
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
  // Пустой предмет: рекомендовать нечего — экран показывает заглушку.
  if (typeof DataAPI !== "undefined" && DataAPI.isSubjectEmpty && DataAPI.isSubjectEmpty()) return [];
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

function applyOnboarding(subject, selfLevel, goalId, diagnosticResults, name) {
  const s = Store.state;
  /* Предмет — первая характеристика профиля; уровень — отдельная
     характеристика внутри предмета, а не его заменитель. */
  const subj = (subject && typeof DataAPI !== "undefined" && DataAPI.subjectInfo && DataAPI.subjectInfo(subject))
    ? subject : "profile_math";
  Store.subject = subj;
  s.subject = subj;
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
  const subjInfo = (typeof DataAPI !== "undefined" && DataAPI.subjectInfo && DataAPI.subjectInfo(subj)) || null;
  const subjReady = !subjInfo || subjInfo.status === "ready";
  if (subjReady) {
    recordForecastSnapshot();
    addTimeline("Пройдена диагностика, профиль навыков построен");
  } else {
    // Пустой предмет: диагностики и прогноза нет — только факт выбора.
    addTimeline(`Выбран предмет «${subjInfo.title}»: материалы готовятся`);
  }
  Store.save();
  if (subjReady) checkAchievements();
}
