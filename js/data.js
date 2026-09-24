/* ege easy — client data service.
   The catalog is loaded from the backend. This module keeps a short-lived
   read cache so rendering code can use synchronous selectors, while the
   backend remains the source of truth.

   A subject catalog is deliberately treated as a registry, not as a second
   profile bundled with the first one.  In particular, an empty/locked subject
   must never inherit tasks, lessons, missions, diagnostics, or forecast
   configuration from the profile subject.  All accessors below go through the
   same small set of guards so a future subject can be added without another
   client-side branch. */

const DATA_DEFAULT_SUBJECT = "profile_math";

function dataId(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function dataArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === "object");
  if (value && typeof value === "object") {
    return Object.entries(value)
      .filter(([, item]) => item && typeof item === "object")
      .map(([id, item]) => ({ id, ...item }));
  }
  return [];
}

function dataFinite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function dataStatus(subject) {
  if (!subject || typeof subject !== "object") return "";
  const availability = String(subject.availability || subject.access || "").trim().toLowerCase();
  if (subject.locked === true || subject.comingSoon === true || subject.coming_soon === true
      || subject.available === false || subject.enabled === false
      || dataStatusLocked(availability)) return "locked";
  const raw = String(subject.status || subject.state || "").trim().toLowerCase();
  if (raw) return raw;
  if (availability) return availability;
  if (subject.available === true || subject.enabled === true) return "ready";
  return "ready";
}

function dataStatusReady(status) {
  return ["ready", "available", "active", "published", "open", "enabled"]
    .includes(String(status || "").trim().toLowerCase());
}

function dataStatusLocked(status) {
  const value = String(status || "").trim().toLowerCase().replace(/_/g, "-");
  return ["locked", "empty", "soon", "coming-soon", "comingsoon", "disabled", "unavailable", "draft", "hidden"]
    .includes(value);
}

function dataEntitySubject(item) {
  if (!item || typeof item !== "object") return "";
  return dataId(item.subject || item.subjectId || item.subject_id);
}

function dataSameId(left, right) {
  const a = dataId(left);
  return !!a && a === dataId(right);
}

function dataSkillCategoryId(skill) {
  if (!skill || typeof skill !== "object") return "";
  return dataId(skill.cat || skill.category || skill.topic || skill.topicId || skill.topic_id);
}

function dataEntityLocked(item) {
  if (!item || typeof item !== "object") return true;
  const availability = String(item.availability || item.access || "").trim().toLowerCase();
  if (item.locked === true || item.comingSoon === true || item.coming_soon === true
      || item.available === false || item.enabled === false
      || dataStatusLocked(availability)) return true;
  const status = String(item.status || item.state || "").trim().toLowerCase();
  return ["locked", "disabled", "unavailable", "hidden", "coming_soon", "coming-soon"].includes(status)
    || dataStatusLocked(status);
}

const DataAPI = {
  catalog: null,
  _tasksFull: false,
  _lessonsFull: false,
  _subjects: null,
  _subject: null,
  _forecast: null,
  _registryProvided: false,
  _legacyCatalog: false,

  /* ----------------------------------------------------------------------
     Загрузка и нормализация каталога.
     ---------------------------------------------------------------------- */

  load(catalog) {
    if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
      throw new Error("Backend returned an invalid catalog");
    }

    const registry = catalog.registry && typeof catalog.registry === "object" ? catalog.registry : null;
    const subjectInfo = catalog.subjectInfo && typeof catalog.subjectInfo === "object"
      ? catalog.subjectInfo
      : (catalog.subject && typeof catalog.subject === "object" ? catalog.subject : null);
    const rawSubjects = dataArray(
      catalog.subjects || catalog.subjectRegistry || (registry && (registry.subjects || registry))
    );
    const subjectId = dataId(catalog.subject)
      || dataId(catalog.subjectId)
      || dataId(rawSubjects[0]?.id)
      || DATA_DEFAULT_SUBJECT;

    // A summary payload is allowed to omit empty collections.  Normalising
    // them here means a locked subject can be represented by just its registry
    // entry and never causes a selector to borrow a legacy collection.
    const categorySource = dataArray(catalog.categories).length ? catalog.categories : catalog.topics;
    const categories = dataArray(categorySource);
    const skills = dataArray(catalog.skills);
    const tasks = dataArray(catalog.tasks);
    const lessons = dataArray(catalog.lessons);
    const missions = dataArray(catalog.missions);
    const bosses = dataArray(catalog.bosses);
    const achievements = dataArray(catalog.achievements);
    const goals = dataArray(catalog.goals);
    const diagnostics = Array.isArray(catalog.diagnosticTasks)
      ? catalog.diagnosticTasks
      : (Array.isArray(catalog.diagnostics) ? catalog.diagnostics : []);
    const daily = catalog.daily && typeof catalog.daily === "object" ? catalog.daily : {};

    const hasContent = categories.length || skills.length || tasks.length || lessons.length
      || missions.length || bosses.length || achievements.length || goals.length || diagnostics.length
      || dataFinite(daily.target) > 0;
    const syntheticStatus = subjectId === DATA_DEFAULT_SUBJECT || hasContent ? "ready" : "locked";
    const subjectInfoId = dataId(subjectInfo && (subjectInfo.id || subjectInfo.subjectId));
    const fallbackInfo = subjectInfo && (!subjectInfoId || subjectInfoId === subjectId)
      ? { ...subjectInfo }
      : { id: subjectId, title: subjectId === DATA_DEFAULT_SUBJECT ? "Профильная математика" : subjectId,
          short: subjectId === DATA_DEFAULT_SUBJECT ? "Профиль" : subjectId, status: syntheticStatus, forecast: null };
    const subjects = rawSubjects.length
      ? rawSubjects.map((item) => ({ ...item, id: dataId(item.id || item.subjectId) }))
      : [{ ...fallbackInfo, id: subjectId }];

    // Keep a copy of the collections on the cache object, but do not invent
    // content.  The original payload remains available to callers that need
    // to inspect a server field.
    this.catalog = {
      ...catalog,
      categories,
      topics: categories,
      skills,
      tasks,
      lessons,
      missions,
      bosses,
      achievements,
      goals,
      diagnosticTasks: diagnostics,
      diagnostics,
      daily,
    };
    this._subjects = subjects.filter((item) => dataId(item.id));
    if (!this._subjects.length) {
      this._subjects = [{ id: subjectId, title: subjectId, short: subjectId, status: "ready" }];
    }
    // If a server sends a catalog for a subject not yet present in its
    // registry, retain a minimal entry.  This is important during a rolling
    // deployment: the new subject is still isolated and usable, rather than
    // being silently replaced by profile_math.
    if (!this._subjects.some((item) => dataId(item.id) === subjectId)) {
      this._subjects.push({ ...fallbackInfo, id: subjectId, status: dataStatus(fallbackInfo) || "locked" });
    }
    this._subject = subjectId;
    this._registryProvided = rawSubjects.length > 0;
    this._legacyCatalog = !this._registryProvided && subjectId === DATA_DEFAULT_SUBJECT;

    this._tasksFull = !tasks.some((task) => task && (task._stub || task.stub));
    this._lessonsFull = !lessons.some((lesson) => lesson && (lesson._meta || lesson.meta));

    if (!Array.isArray(this.catalog.visualAssets)) this.catalog.visualAssets = [];
    if (!this.catalog.visualAudit || typeof this.catalog.visualAudit !== "object") this.catalog.visualAudit = {};
    this._forecast = catalog.forecast && typeof catalog.forecast === "object"
      ? catalog.forecast
      : null;
    return this;
  },

  // Ленивая догрузка полных задач/уроков поверх summary-каталога.
  // Пустой/locked предмет не принимает «случайные» детали: это не даёт
  // summary-запросу или чужому ответу превратить заглушку в курс.
  loadDetails({ tasks, lessons, visualAssets, visualAudit } = {}) {
    if (!this.catalog) throw new Error("Catalog is not loaded");
    if (!this.isSubjectAvailable()) {
      this._tasksFull = true;
      this._lessonsFull = true;
      return this;
    }

    if (Array.isArray(tasks)) {
      const current = this._currentEntities(tasks);
      // A details response must not introduce a task from another subject or
      // a task whose skill/topic is locked.  Stub metadata is intentionally
      // not accepted as a reason to bypass the access check.
      const usable = current.filter((task) => this._taskBelongsToCurrent(task) && !this.taskHasMissingVisual(task));
      if (usable.length || !tasks.length) {
        this.catalog.tasks = usable;
        this._tasksFull = true;
      }
    }
    if (Array.isArray(lessons)) {
      const usable = this._currentEntities(lessons)
        .filter((lesson) => this._lessonBelongsToCurrent(lesson) && !this._skillLocked(lesson.skill || lesson.skillId));
      if (usable.length || !lessons.length) {
        this.catalog.lessons = usable;
        this._lessonsFull = true;
      }
    }
    if (Array.isArray(visualAssets)) this.catalog.visualAssets = visualAssets;
    if (visualAudit && typeof visualAudit === "object") this.catalog.visualAudit = visualAudit;
    return this;
  },

  detailsReady() {
    if (!this.catalog) return false;
    if (!this.isSubjectAvailable()) return true;
    return this._tasksFull && this._lessonsFull;
  },
  tasksReady() {
    if (!this.catalog) return false;
    if (!this.isSubjectAvailable()) return true;
    return this._tasksFull;
  },
  lessonsReady() {
    if (!this.catalog) return false;
    if (!this.isSubjectAvailable()) return true;
    return this._lessonsFull;
  },

  lessonStepsCount(lesson) {
    if (!lesson || typeof lesson !== "object") return 0;
    if (Array.isArray(lesson.steps)) return lesson.steps.length;
    return Math.max(0, dataFinite(lesson.stepsCount || lesson.steps_count));
  },

  ready() { return !!this.catalog; },
  _collection(name) { return dataArray(this.catalog && this.catalog[name]); },
  _currentEntities(items) {
    const subject = dataId(this.currentSubject());
    return dataArray(items).filter((item) => {
      const owner = dataEntitySubject(item);
      return !owner || !subject || owner === subject;
    });
  },
  _findById(items, id) {
    const wanted = dataId(id);
    if (!wanted) return undefined;
    return this._currentEntities(items).find((item) => dataId(item.id || item.key) === wanted);
  },

  /* ----------------------------------------------------------------------
     Registry and access policy.
     ---------------------------------------------------------------------- */

  subjects() { return (this._subjects || []).slice(); },
  currentSubject() { return dataId(this._subject) || DATA_DEFAULT_SUBJECT; },
  subjectInfo(id) {
    const wanted = dataId(id || this.currentSubject());
    return (this._subjects || []).find((item) => dataId(item.id) === wanted) || null;
  },
  subjectStatus(id) {
    const info = this.subjectInfo(id);
    if (!info) return "locked";
    return String(info.status || info.state || info.availability || "ready").trim().toLowerCase();
  },
  isSubjectKnown(id) { return !!this.subjectInfo(id); },
  isSubjectLocked(id) {
    const info = this.subjectInfo(id);
    if (!info) return true;
    const status = dataStatus(info);
    return dataStatusLocked(status) || !dataStatusReady(status);
  },
  isSubjectAvailable(id) {
    const info = this.subjectInfo(id);
    if (!info) return false;
    const status = dataStatus(info);
    return dataStatusReady(status) && !dataStatusLocked(status);
  },
  subjectFeatures(id) {
    const info = this.subjectInfo(id);
    const features = info && info.features && typeof info.features === "object" ? info.features : {};
    const available = this.isSubjectAvailable(id);
    return {
      // path is the metadata/read-only route and remains available for a
      // coming-soon subject; the learning routes below stay closed.
      path: !!info && features.path !== false,
      lessons: available && features.lessons !== false,
      practice: available && features.practice !== false,
      forecast: available && features.forecast !== false,
      diagnostics: available && features.diagnostics !== false,
      daily: available && features.daily !== false,
      missions: available && (features.missions !== false) && features.practice !== false,
      bosses: available && features.bosses !== false,
    };
  },
  subjectFeature(id, feature) {
    const features = this.subjectFeatures(id);
    return features[feature] !== false;
  },
  // Пустой предмет: нет доступного навыка (в том числе если предмет locked).
  isSubjectEmpty(id) {
    if (!this.ready() || !this.isSubjectAvailable(id)) return this.ready();
    return this.availableSkills(id).length === 0;
  },
  // Есть ли реальный учебный контент, а не только запись реестра.
  hasLearningContent(id) {
    if (!this.ready() || !this.isSubjectAvailable(id)) return false;
    const skills = this.availableSkills(id);
    if (!skills.length) return false;
    return this.practiceTasks().length > 0
      || this.lessons().length > 0
      || this.missions().length > 0
      || this.diagnosticTasks().length > 0;
  },
  isLegacySubject(id) {
    const wanted = dataId(id || this.currentSubject());
    return wanted === DATA_DEFAULT_SUBJECT && this._legacyCatalog;
  },

  isTopicLocked(idOrTopic) {
    if (!this.isSubjectAvailable()) return true;
    const topic = idOrTopic && typeof idOrTopic === "object"
      ? idOrTopic
      : this.category(typeof idOrTopic === "object" ? idOrTopic.id : idOrTopic);
    if (!topic) return true;
    return dataEntityLocked(topic);
  },
  isSkillLocked(idOrSkill) {
    if (!this.isSubjectAvailable()) return true;
    const skill = idOrSkill && typeof idOrSkill === "object"
      ? idOrSkill
      : this.skill(idOrSkill);
    if (!skill) return true;
    if (dataEntityLocked(skill)) return true;
    return this.isTopicLocked(dataSkillCategoryId(skill));
  },
  // Accessors used by state/UI.  They intentionally return null/undefined for
  // a locked entity, while skills()/categories() still expose metadata for a
  // read-only locked card.
  skillForAccess(idOrSkill) {
    const ref = idOrSkill && typeof idOrSkill === "object" ? idOrSkill.id : idOrSkill;
    const skill = this.skill(ref);
    return skill && !this.isSkillLocked(skill) ? skill : null;
  },
  topicForAccess(idOrTopic) {
    const ref = idOrTopic && typeof idOrTopic === "object" ? idOrTopic.id : idOrTopic;
    const topic = this.category(ref);
    return topic && !this.isTopicLocked(topic) ? topic : null;
  },
  taskForAccess(id) {
    const task = this.task(id);
    if (!task || this.taskHasMissingVisual(task) || !this.skillForAccess(task.skill || task.skillId)) return null;
    return task;
  },
  lessonForAccess(id) {
    const lesson = this.lesson(id);
    if (!lesson || !this.skillForAccess(lesson.skill || lesson.skillId)) return null;
    return lesson;
  },
  missionForAccess(id) {
    const mission = this.mission(id);
    if (!mission || !this.skillForAccess(mission.skill || mission.skillId)) return null;
    return mission;
  },

  /* ----------------------------------------------------------------------
     Content selectors.  They all resolve IDs as strings and verify the
     owning skill/topic before exposing content to learning systems.
     ---------------------------------------------------------------------- */

  categories() {
    if (!this.catalog) return [];
    // Locked/coming-soon subjects still expose their real Path metadata.  The
    // access-specific helpers below decide what may be opened, while the UI
    // can render the existing topic with a locked state.
    return this._currentEntities(this._collection("categories"));
  },
  topics() { return this.categories(); },
  skills() {
    if (!this.catalog) return [];
    // Do not hide a registered locked topic from the Path.  Learning systems
    // use availableSkills()/skillForAccess() and therefore still see no
    // playable content for it.
    return this._currentEntities(this._collection("skills"));
  },
  availableSkills(id) {
    const wanted = id ? dataId(id) : null;
    return this.skills().filter((skill) => (!wanted || dataId(skill.id) === wanted) && !this.isSkillLocked(skill));
  },
  skill(id) {
    const skill = this._findById(this._collection("skills"), id);
    if (!skill || !this.catalog || !this.isSubjectAvailable()) return skill || null;
    return skill;
  },
  category(id) {
    return this._findById(this._collection("categories"), id) || null;
  },
  topic(id) { return this.category(id); },
  topicForSkill(skillOrId) {
    const skill = skillOrId && typeof skillOrId === "object"
      ? skillOrId
      : this.skill(skillOrId);
    return skill ? this.category(dataSkillCategoryId(skill)) : null;
  },
  tasks() {
    if (!this.catalog || !this.isSubjectAvailable()) return [];
    return this._currentEntities(this._collection("tasks"));
  },
  task(id) {
    const task = this._findById(this._collection("tasks"), id);
    if (!task || !this.isSubjectAvailable()) return null;
    // Direct task lookup is also an access boundary: stale local sessions
    // cannot reopen a task from a locked topic/subject by guessing its id.
    return this.skillForAccess(task.skill || task.skillId) ? task : null;
  },
  taskHasMissingVisual(item) {
    return !!(item && item.visual && item.visual.required && !item.visual.assetId);
  },
  _taskBelongsToCurrent(task) {
    if (!task || !this.skill(task.skill || task.skillId)) return false;
    return !this._skillLocked(task.skill || task.skillId);
  },
  _skillLocked(id) {
    const skill = this.skill(id);
    return !skill || this.isSkillLocked(skill);
  },
  _lessonBelongsToCurrent(lesson) {
    return !!(lesson && this.skill(lesson.skill || lesson.skillId));
  },
  practiceTasks() {
    if (!this.subjectFeature(this.currentSubject(), "practice")) return [];
    return this.tasks().filter((task) => this.taskForAccess(task.id));
  },
  tasksBySkill(skillId) {
    const wanted = dataId(skillId);
    if (!wanted || !this.skill(wanted)) return [];
    return this.tasks().filter((task) => dataSameId(task.skill || task.skillId, wanted));
  },
  practiceTasksBySkill(skillId) {
    const wanted = dataId(skillId);
    if (!wanted || this.isSkillLocked(wanted)) return [];
    return this.practiceTasks().filter((task) => dataSameId(task.skill || task.skillId, wanted));
  },
  missions() {
    if (!this.subjectFeature(this.currentSubject(), "missions")) return [];
    const out = [];
    for (const mission of this._currentEntities(this._collection("missions"))) {
      const skillId = dataId(mission.skill || mission.skillId);
      if (!skillId || this.isSkillLocked(skillId)) continue;
      const ids = (Array.isArray(mission.tasks) ? mission.tasks : [])
        .map((id) => dataId(id && typeof id === "object" ? (id.id || id.taskId) : id))
        .filter((id) => id && !!this.taskForAccess(id));
      const hasBank = this.practiceTasksBySkill(skillId).length > 0;
      // Миссия без заданий и без общего банка темы — пустая декорация,
      // её не показываем.  Явный список сохраняем, если он пересекается с
      // доступным каталогом.
      if (!hasBank && !ids.length) continue;
      out.push({ ...mission, skill: skillId, tasks: [...new Set(ids)] });
    }
    return out;
  },
  mission(id) { return this.missions().find((item) => dataSameId(item.id, id)) || null; },
  lessons() {
    if (!this.subjectFeature(this.currentSubject(), "lessons")) return [];
    return this._currentEntities(this._collection("lessons"))
      .filter((lesson) => this._lessonBelongsToCurrent(lesson)
        && !this._skillLocked(lesson.skill || lesson.skillId)
        && this.lessonStepsCount(lesson) > 0);
  },
  lesson(id) {
    return this.lessons().find((item) => dataSameId(item.id, id)) || null;
  },
  lessonsBySkill(skillId) {
    const wanted = dataId(skillId);
    if (!wanted || this.isSkillLocked(wanted)) return [];
    return this.lessons().filter((lesson) => dataSameId(lesson.skill || lesson.skillId, wanted));
  },
  bosses() {
    if (!this.isSubjectAvailable() || !this.subjectFeature(this.currentSubject(), "practice")) return [];
    return this._currentEntities(this._collection("bosses")).filter((boss) => {
      const cat = dataId(boss.cat || boss.category || boss.topicId || boss.topic_id);
      return !!cat && !this.isTopicLocked(cat) && this.availableSkills().some((skill) => dataSkillCategoryId(skill) === cat)
        && this.practiceTasks().some((task) => dataId(task.skill || task.skillId)
          && this.availableSkills().some((skill) => dataId(skill.id) === dataId(task.skill || task.skillId)
            && dataSkillCategoryId(skill) === cat));
    });
  },
  achievements() {
    if (!this.isSubjectAvailable()) return [];
    const subject = this.currentSubject();
    const configured = this._collection("achievements");
    return configured.filter((item) => {
      const owner = dataEntitySubject(item);
      if (owner) return owner === subject;
      // Once a subject is published, its catalog is authoritative even when
      // achievement rows do not repeat the subject id.  Locked subjects were
      // filtered above, so this cannot expose the previous subject's badges;
      // it also lets a future Russian catalog add its own rows unchanged.
      return true;
    });
  },
  daily() {
    if (!this.subjectFeature(this.currentSubject(), "daily") || !this.isSubjectAvailable()
        || !this.practiceTasks().length) {
      return { skill: "", target: 0, xp: 0, title: "" };
    }
    const daily = this.catalog && this.catalog.daily && typeof this.catalog.daily === "object"
      ? this.catalog.daily : {};
    return {
      ...daily,
      skill: dataId(daily.skill || ""),
      target: Math.max(0, Math.floor(dataFinite(daily.target))),
      xp: Math.max(0, dataFinite(daily.xp)),
      title: String(daily.title || ""),
    };
  },
  goals() {
    if (!this.isSubjectAvailable()) return [];
    return this._currentEntities(this._collection("goals"));
  },
  diagnosticTasks() {
    if (!this.subjectFeature(this.currentSubject(), "diagnostics") || !this.isSubjectAvailable()) return [];
    const configured = this.catalog && Array.isArray(this.catalog.diagnosticTasks)
      ? this.catalog.diagnosticTasks
      : (Array.isArray(this.catalog && this.catalog.diagnostics) ? this.catalog.diagnostics : []);
    const ids = [];
    for (const value of configured) {
      const id = dataId(value && typeof value === "object" ? (value.id || value.taskId) : value);
      if (id && this.taskForAccess(id) && !ids.includes(id)) ids.push(id);
    }
    return ids;
  },
  visualAssets() {
    if (!this.catalog || !this.isSubjectAvailable()) return [];
    return dataArray(this.catalog.visualAssets);
  },
  visualAudit() {
    if (!this.catalog || !this.isSubjectAvailable()) return {};
    return this.catalog.visualAudit && typeof this.catalog.visualAudit === "object" ? this.catalog.visualAudit : {};
  },
  visualAsset(id) { return this.visualAssets().find((asset) => dataSameId(asset.id, id)) || null; },

  forecastConfig() {
    if (!this._forecast || !this.subjectFeature(this.currentSubject(), "forecast") || !this.isSubjectAvailable()) return null;
    return this._forecast;
  },

  /* ----------------------------------------------------------------------
     Internal helpers kept public-ish for tests and for state.js.  They make
     the access policy composable without exposing another catalog branch.
     ---------------------------------------------------------------------- */
  _skillCategoryId(skill) { return dataSkillCategoryId(skill); },
  _id(value) { return dataId(value); },
};

const ApiClient = {
  async request(path, options = {}) {
    let response;
    let lastError;
    // A lesson finish can race with its final draft save. Retry transient
    // network/5xx failures so a temporary hiccup does not lose progress.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await fetch(path, {
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", ...(options.headers || {}) },
          ...options,
        });
        if (response.status < 500 || attempt === 2) break;
      } catch (error) {
        lastError = error;
        if (attempt === 2) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
    if (!response) throw lastError || new Error("Сервер недоступен");
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || `API ${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  },
  get(path) { return this.request(path); },
  patch(path, body) { return this.request(path, { method: "PATCH", body: JSON.stringify(body) }); },
  put(path, body) { return this.request(path, { method: "PUT", body: JSON.stringify(body) }); },
  post(path, body) { return this.request(path, { method: "POST", body: JSON.stringify(body) }); },
  delete(path) { return this.request(path, { method: "DELETE" }); },
};

/* Аккаунты: регистрация/вход/выход. Пароль живёт только в теле запроса —
   токен сессии держит HttpOnly-кука, JS его не видит и ничего не хранит. */
const AuthAPI = {
  register(name, email, password) {
    return ApiClient.post("/api/auth/register", { name, email, password });
  },
  // subject опционален: вход с явным предметом атомарно применяет его к
  // сессии (Login → выбор предмета за один запрос). Без него сервер ничего
  // не меняет — клиент доводит выбор через POST /api/subject.
  login(email, password, subject) {
    const body = { email, password };
    if (subject) body.subject = subject;
    return ApiClient.post("/api/auth/login", body);
  },
  logout() {
    return ApiClient.post("/api/auth/logout", {});
  },
  session() {
    return ApiClient.get("/api/auth/session");
  },
  /* Устройства: список активных серверных сессий аккаунта и отзыв одной.
     Сырой User-Agent нигде не показываем — сервер отдаёт только готовые
     название/тип. Отзыв текущей сессии эквивалентен logout (сервер чистит
     куку), остальные сессии здесь не трогаем. */
  devices() {
    return ApiClient.get("/api/auth/devices");
  },
  revokeDevice(id) {
    return ApiClient.delete("/api/auth/devices/" + encodeURIComponent(id));
  },
};
