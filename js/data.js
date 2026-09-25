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

function dataRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function dataStringId(value) {
  return typeof value === "string" ? value.trim() : "";
}

function dataSubjectId(value) {
  const info = dataRecord(value);
  return info ? (dataId(info.id) || dataId(info.subjectId)) : "";
}

function dataSubjectInfoId(value) {
  const info = dataRecord(value);
  if (!info) return "";
  // A descriptor is authoritative only when it carries a real string id.
  // If an id key is present but malformed, do not silently replace it with a
  // different identifier; legacy subjectId-only descriptors remain accepted.
  return Object.prototype.hasOwnProperty.call(info, "id")
    ? dataStringId(info.id)
    : dataStringId(info.subjectId);
}

function dataExplicitSubjectLock(value) {
  const info = dataRecord(value);
  if (!info) return false;
  if (info.locked === true || info.comingSoon === true || info.coming_soon === true
      || info.available === false || info.enabled === false) return true;
  const explicitlyNotReady = (status) => {
    const raw = String(status || "").trim().toLowerCase();
    return !!raw && !dataStatusReady(raw);
  };
  if ([info.status, info.state, info.availability, info.access].some(explicitlyNotReady)) return true;
  const metadata = dataRecord(info.metadata);
  return !!metadata && (metadata.locked === true || metadata.comingSoon === true
    || metadata.coming_soon === true
    || [metadata.status, metadata.state, metadata.availability, metadata.access].some(explicitlyNotReady));
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
  // Индекс производных выборок (карты id -> объект, готовые списки).
  // Перестраивается лениво и сбрасывается при каждой смене каталога,
  // предмета или деталей: селекторы ниже обязаны читать только через _index().
  _indexCache: null,

  _invalidateIndex() { this._indexCache = null; },

  /* ----------------------------------------------------------------------
     Загрузка и нормализация каталога.
     ---------------------------------------------------------------------- */

  load(catalog) {
    if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
      throw new Error("Backend returned an invalid catalog");
    }

    const registry = catalog.registry && typeof catalog.registry === "object" ? catalog.registry : null;
    const subjectObject = dataRecord(catalog.subject);
    const explicitSubjectInfo = dataRecord(catalog.subjectInfo);
    const subjectInfo = explicitSubjectInfo || subjectObject;
    const rawSubjects = dataArray(
      catalog.subjects || catalog.subjectRegistry || (registry && (registry.subjects || registry))
    );

    // Identity is deliberately resolved from the payload's own descriptor
    // first.  A registry is only a fallback; its first entry must never win
    // over an object-form subject or an explicit subjectInfo.
    const subjectId = dataSubjectInfoId(subjectInfo)
      || dataSubjectId(subjectObject)
      || (typeof catalog.subject === "string" ? dataId(catalog.subject) : "")
      || dataId(catalog.subjectId)
      || dataId(rawSubjects[0]?.id || rawSubjects[0]?.subjectId)
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
    const syntheticInfo = {
      id: subjectId,
      title: subjectId === DATA_DEFAULT_SUBJECT ? "Профильная математика" : subjectId,
      short: subjectId === DATA_DEFAULT_SUBJECT ? "Профиль" : subjectId,
      status: syntheticStatus,
      forecast: null,
    };

    // These are the fields a registry-less payload may use to describe its
    // active subject.  Keep the synthetic defaults, then layer the descriptor
    // and the payload's own top-level fields over them.
    const topLevelInfo = {};
    for (const key of ["status", "locked", "comingSoon", "availability", "features", "short", "title", "description", "metadata"]) {
      if (Object.prototype.hasOwnProperty.call(catalog, key)) topLevelInfo[key] = catalog[key];
    }
    const registryInfo = rawSubjects.find((item) => dataId(item.id || item.subjectId) === subjectId);
    const activeInfo = { ...syntheticInfo };
    for (const source of [registryInfo, subjectObject, explicitSubjectInfo]) {
      const info = dataRecord(source);
      if (!info) continue;
      for (const [key, value] of Object.entries(info)) {
        if (value !== undefined) activeInfo[key] = value;
      }
    }
    for (const [key, value] of Object.entries(topLevelInfo)) {
      if (value !== undefined) activeInfo[key] = value;
    }
    activeInfo.id = subjectId;
    if (typeof activeInfo.title !== "string" || !activeInfo.title.trim()) activeInfo.title = syntheticInfo.title;
    if (typeof activeInfo.short !== "string" || !activeInfo.short.trim()) activeInfo.short = syntheticInfo.short;

    // A lock declaration is monotonic: a stale ready registry entry cannot
    // overwrite a lock carried by the active payload, its descriptor, or its
    // top-level fields.  Preserve a meaningful coming-soon status when there
    // is no conflict, but make a conflicting ready status explicitly locked.
    const lockSources = [registryInfo, subjectObject, explicitSubjectInfo, topLevelInfo, catalog];
    const hasExplicitLock = lockSources.some((source) => dataExplicitSubjectLock(source));
    const hasComingSoon = lockSources.some((source) => {
      const info = dataRecord(source);
      return !!info && (info.comingSoon === true || info.coming_soon === true);
    });
    if (hasExplicitLock) {
      activeInfo.locked = true;
      const status = String(activeInfo.status || activeInfo.state || "").trim().toLowerCase();
      if (!dataStatusLocked(status)) activeInfo.status = "locked";
      if (hasComingSoon) activeInfo.comingSoon = true;
    }

    const subjects = rawSubjects.length
      ? rawSubjects.map((item) => ({ ...item, id: dataId(item.id || item.subjectId) }))
      : [{ ...activeInfo, id: subjectId }];
    if (rawSubjects.length) {
      const activeIndex = subjects.findIndex((item) => dataId(item.id) === subjectId);
      if (activeIndex >= 0) {
        // Keep a registry-provided descriptor byte-for-byte compatible when
        // there is no stronger access declaration.  Only a monotonic lock
        // signal is layered onto it.
        const activeEntry = { ...subjects[activeIndex] };
        if (hasExplicitLock) {
          activeEntry.locked = true;
          const status = String(activeEntry.status || activeEntry.state || "").trim().toLowerCase();
          if (!dataStatusLocked(status)) activeEntry.status = "locked";
          if (hasComingSoon) activeEntry.comingSoon = true;
        }
        subjects[activeIndex] = activeEntry;
      }
    }

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
      this._subjects = [{ ...activeInfo, id: subjectId }];
    }
    // If a server sends a catalog for a subject not yet present in its
    // registry, retain a minimal entry.  This is important during a rolling
    // deployment: the new subject is still isolated and usable, rather than
    // being silently replaced by profile_math.
    if (!this._subjects.some((item) => dataId(item.id) === subjectId)) {
      this._subjects.push({ ...activeInfo, id: subjectId, status: dataStatus(activeInfo) || "locked" });
    }
    this._subject = subjectId;
    this._registryProvided = rawSubjects.length > 0;
    this._legacyCatalog = !this._registryProvided && subjectId === DATA_DEFAULT_SUBJECT;

    this._tasksFull = !tasks.some((task) => task && (task._stub || task.stub));
    this._lessonsFull = !lessons.some((lesson) => lesson && (lesson._meta || lesson.meta));
    this._invalidateIndex();

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
      this._invalidateIndex();
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
    this._invalidateIndex();
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
     Индекс производных выборок: все тяжёлые селекторы ниже — O(1)/O(n)
     вместо O(n²). Семантика побайтово та же, что у прямых сканирований выше:
     фильтры locked/available/subject продублированы 1:1, меняется только
     способ поиска (карты вместо линейных find в цикле).
     Ключ — identity коллекций каталога + текущий предмет: load/loadDetails
     сбрасывают кэш через _invalidateIndex(), смена предмета меняет subject.
     ---------------------------------------------------------------------- */
  _index() {
    const cat = this.catalog;
    const subject = dataId(this.currentSubject());
    const cached = this._indexCache;
    if (cached && cached.catalog === cat && cached.subject === subject
        && cat
        && cached.skillsSrc === cat.skills && cached.categoriesSrc === cat.categories
        && cached.tasksSrc === cat.tasks && cached.lessonsSrc === cat.lessons
        && cached.missionsSrc === cat.missions && cached.bossesSrc === cat.bosses) {
      return cached;
    }
    const subjectAvailable = !!cat && this.isSubjectAvailable();
    const info = this.subjectInfo();
    const features = info && info.features && typeof info.features === "object" ? info.features : {};
    const feat = {
      lessons: subjectAvailable && features.lessons !== false,
      practice: subjectAvailable && features.practice !== false,
      missions: subjectAvailable && (features.missions !== false) && features.practice !== false,
    };
    const skills = cat ? this._currentEntities(cat.skills) : [];
    const categories = cat ? this._currentEntities(cat.categories) : [];
    const categoryById = new Map();
    for (const c of categories) {
      const id = dataId(c.id);
      if (id && !categoryById.has(id)) categoryById.set(id, c);
    }
    const skillById = new Map();
    for (const s of skills) {
      const id = dataId(s.id);
      if (id && !skillById.has(id)) skillById.set(id, s);
    }
    // Карта locked 1:1 с isSkillLocked(): нет предмета/скилла — locked;
    // иначе locked скилла или его категории.
    const skillLocked = new Map();
    for (const s of skills) {
      const id = dataId(s.id);
      let locked = true;
      if (subjectAvailable) {
        const catId = dataSkillCategoryId(s);
        const catObj = catId ? categoryById.get(catId) : undefined;
        locked = dataEntityLocked(s) || dataEntityLocked(catObj);
      }
      skillLocked.set(id, locked);
    }
    const availableSkills = skills.filter((s) => skillLocked.get(dataId(s.id)) === false);
    const tasksAll = subjectAvailable && cat ? this._currentEntities(cat.tasks) : [];
    const taskById = new Map();
    for (const t of tasksAll) {
      const id = dataId(t.id);
      if (id && !taskById.has(id)) taskById.set(id, t);
    }
    const taskUsable = (t) => {
      if (!t || this.taskHasMissingVisual(t)) return false;
      return skillLocked.get(dataId(t.skill || t.skillId)) === false;
    };
    const practiceTasks = tasksAll.filter(taskUsable);
    const practiceBySkill = new Map();
    const tasksBySkillMap = new Map();
    for (const t of tasksAll) {
      const sid = dataId(t.skill || t.skillId);
      if (!sid) continue;
      if (!tasksBySkillMap.has(sid)) tasksBySkillMap.set(sid, []);
      tasksBySkillMap.get(sid).push(t);
    }
    for (const t of practiceTasks) {
      const sid = dataId(t.skill || t.skillId);
      if (!sid) continue;
      if (!practiceBySkill.has(sid)) practiceBySkill.set(sid, []);
      practiceBySkill.get(sid).push(t);
    }
    let lessons = [];
    if (feat.lessons && cat) {
      for (const lesson of this._currentEntities(cat.lessons)) {
        if (!lesson || typeof lesson !== "object") continue;
        const sid = dataId(lesson.skill || lesson.skillId);
        if (!sid || !skillById.has(sid) || skillLocked.get(sid) !== false) continue;
        if (this.lessonStepsCount(lesson) <= 0) continue;
        lessons.push(lesson);
      }
    }
    const lessonById = new Map();
    for (const l of lessons) {
      const id = dataId(l.id);
      if (id && !lessonById.has(id)) lessonById.set(id, l);
    }
    const lessonsBySkillMap = new Map();
    for (const l of lessons) {
      const sid = dataId(l.skill || l.skillId);
      if (!sid) continue;
      if (!lessonsBySkillMap.has(sid)) lessonsBySkillMap.set(sid, []);
      lessonsBySkillMap.get(sid).push(l);
    }
    let missions = [];
    if (feat.missions && cat) {
      for (const mission of this._currentEntities(cat.missions)) {
        if (!mission || typeof mission !== "object") continue;
        const skillId = dataId(mission.skill || mission.skillId);
        if (!skillId || skillLocked.get(skillId) !== false) continue;
        const ids = [];
        const seen = new Set();
        for (const raw of (Array.isArray(mission.tasks) ? mission.tasks : [])) {
          const id = dataId(raw && typeof raw === "object" ? (raw.id || raw.taskId) : raw);
          if (!id || seen.has(id)) continue;
          const task = taskById.get(id);
          if (!task || !taskUsable(task)) continue;
          seen.add(id);
          ids.push(id);
        }
        const hasBank = (practiceBySkill.get(skillId) || []).length > 0;
        if (!hasBank && !ids.length) continue;
        missions.push({ ...mission, skill: skillId, tasks: ids });
      }
    }
    const missionById = new Map();
    for (const m of missions) {
      const id = dataId(m.id);
      if (id && !missionById.has(id)) missionById.set(id, m);
    }
    let bosses = [];
    if (subjectAvailable && feat.practice && cat) {
      const skillsByCat = new Set();
      for (const s of availableSkills) {
        const c = dataSkillCategoryId(s);
        if (c) skillsByCat.add(c);
      }
      const practiceCats = new Set();
      for (const t of practiceTasks) {
        const sk = skillById.get(dataId(t.skill || t.skillId));
        const c = sk ? dataSkillCategoryId(sk) : "";
        if (c) practiceCats.add(c);
      }
      for (const boss of this._currentEntities(cat.bosses)) {
        if (!boss || typeof boss !== "object") continue;
        const bossCat = dataId(boss.cat || boss.category || boss.topicId || boss.topic_id);
        if (!bossCat) continue;
        const topic = categoryById.get(bossCat);
        if (!topic || dataEntityLocked(topic)) continue;
        if (!skillsByCat.has(bossCat) || !practiceCats.has(bossCat)) continue;
        bosses.push(boss);
      }
    }
    const idx = {
      catalog: cat, subject,
      skillsSrc: cat && cat.skills, categoriesSrc: cat && cat.categories,
      tasksSrc: cat && cat.tasks, lessonsSrc: cat && cat.lessons,
      missionsSrc: cat && cat.missions, bossesSrc: cat && cat.bosses,
      subjectAvailable, feat,
      skills, categories, categoryById, skillById, skillLocked, availableSkills,
      tasksAll, taskById, practiceTasks, practiceBySkill, tasksBySkillMap,
      lessons, lessonById, lessonsBySkillMap,
      missions, missionById, bosses,
    };
    this._indexCache = idx;
    return idx;
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
    const wanted = id ? dataId(id) : null;
    if (wanted && wanted !== dataId(this.currentSubject())) return this.availableSkills(wanted).length === 0;
    return this._index().availableSkills.length === 0;
  },
  // Есть ли реальный учебный контент, а не только запись реестра.
  hasLearningContent(id) {
    if (!this.ready() || !this.isSubjectAvailable(id)) return false;
    const wanted = id ? dataId(id) : null;
    if (wanted && wanted !== dataId(this.currentSubject())) {
      const skills = this.availableSkills(wanted);
      if (!skills.length) return false;
      return this.practiceTasks().length > 0
        || this.lessons().length > 0
        || this.missions().length > 0
        || this.diagnosticTasks().length > 0;
    }
    const idx = this._index();
    if (!idx.availableSkills.length) return false;
    if (idx.practiceTasks.length > 0 || idx.lessons.length > 0 || idx.missions.length > 0) return true;
    return this.diagnosticTasks().length > 0;
  },
  isLegacySubject(id) {
    const wanted = dataId(id || this.currentSubject());
    return wanted === DATA_DEFAULT_SUBJECT && this._legacyCatalog;
  },

  isTopicLocked(idOrTopic) {
    if (!this.isSubjectAvailable()) return true;
    if (idOrTopic && typeof idOrTopic === "object") return dataEntityLocked(idOrTopic);
    const wanted = dataId(idOrTopic);
    if (!wanted) return true;
    const topic = this._index().categoryById.get(wanted);
    if (!topic) return true;
    return dataEntityLocked(topic);
  },
  isSkillLocked(idOrSkill) {
    if (!this.isSubjectAvailable()) return true;
    if (idOrSkill && typeof idOrSkill === "object") {
      const catId = dataSkillCategoryId(idOrSkill);
      const idx = this._index();
      const catObj = catId ? idx.categoryById.get(catId) : undefined;
      if (dataEntityLocked(idOrSkill)) return true;
      return dataEntityLocked(catObj);
    }
    const wanted = dataId(idOrSkill);
    if (!wanted) return true;
    const locked = this._index().skillLocked.get(wanted);
    return locked !== false;
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
    return this._index().categories.slice();
  },
  topics() { return this.categories(); },
  skills() {
    if (!this.catalog) return [];
    // Do not hide a registered locked topic from the Path.  Learning systems
    // use availableSkills()/skillForAccess() and therefore still see no
    // playable content for it.
    return this._index().skills.slice();
  },
  availableSkills(id) {
    const wanted = id ? dataId(id) : null;
    const list = this._index().availableSkills;
    if (!wanted) return list.slice();
    return list.filter((skill) => dataId(skill.id) === wanted);
  },
  skill(id) {
    const wanted = dataId(id);
    const skill = wanted ? this._index().skillById.get(wanted) : undefined;
    if (!skill || !this.catalog || !this.isSubjectAvailable()) return skill || null;
    return skill;
  },
  category(id) {
    const wanted = dataId(id);
    return (wanted && this._index().categoryById.get(wanted)) || null;
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
    return this._index().tasksAll.slice();
  },
  task(id) {
    const wanted = dataId(id);
    const idx = this._index();
    const task = wanted ? idx.taskById.get(wanted) : undefined;
    if (!task || !idx.subjectAvailable) return null;
    // Direct task lookup is also an access boundary: stale local sessions
    // cannot reopen a task from a locked topic/subject by guessing its id.
    return idx.skillLocked.get(dataId(task.skill || task.skillId)) === false ? task : null;
  },
  taskHasMissingVisual(item) {
    return !!(item && item.visual && item.visual.required && !item.visual.assetId);
  },
  _taskBelongsToCurrent(task) {
    if (!task || typeof task !== "object") return false;
    const idx = this._index();
    if (!idx.subjectAvailable) return false;
    const sid = dataId(task.skill || task.skillId);
    return !!sid && idx.skillById.has(sid) && idx.skillLocked.get(sid) === false;
  },
  _skillLocked(id) {
    const wanted = dataId(id);
    const idx = this._index();
    if (!idx.subjectAvailable || !wanted || !idx.skillById.has(wanted)) return true;
    return idx.skillLocked.get(wanted) !== false;
  },
  _lessonBelongsToCurrent(lesson) {
    if (!lesson || typeof lesson !== "object") return false;
    const idx = this._index();
    if (!idx.subjectAvailable) return false;
    return idx.skillById.has(dataId(lesson.skill || lesson.skillId));
  },
  practiceTasks() {
    const idx = this._index();
    if (!idx.feat.practice) return [];
    return idx.practiceTasks.slice();
  },
  tasksBySkill(skillId) {
    const wanted = dataId(skillId);
    const idx = this._index();
    if (!wanted || !idx.skillById.has(wanted)) return [];
    return (idx.tasksBySkillMap.get(wanted) || []).slice();
  },
  practiceTasksBySkill(skillId) {
    const wanted = dataId(skillId);
    const idx = this._index();
    if (!wanted || idx.skillLocked.get(wanted) !== false) return [];
    return (idx.practiceBySkill.get(wanted) || []).slice();
  },
  missions() {
    const idx = this._index();
    if (!idx.feat.missions) return [];
    return idx.missions.slice();
  },
  mission(id) { return this._index().missionById.get(dataId(id)) || null; },
  lessons() {
    const idx = this._index();
    if (!idx.feat.lessons) return [];
    return idx.lessons.slice();
  },
  lesson(id) {
    return this._index().lessonById.get(dataId(id)) || null;
  },
  lessonsBySkill(skillId) {
    const wanted = dataId(skillId);
    const idx = this._index();
    if (!wanted || idx.skillLocked.get(wanted) !== false) return [];
    return (idx.lessonsBySkillMap.get(wanted) || []).slice();
  },
  bosses() {
    const idx = this._index();
    if (!idx.subjectAvailable || !idx.feat.practice) return [];
    return idx.bosses.slice();
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
        || !this._index().practiceTasks.length) {
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
      // Blocked account: distinct machine-readable code so the UI can tell a
      // ban apart from 401/403/expiry. Broadcast globally — an in-app ban can
      // arrive on ANY authenticated request, not just bootstrap.
      if (response.status === 403 && payload && (payload.code === "ACCOUNT_BLOCKED" || payload.blocked === true)) {
        error.code = "ACCOUNT_BLOCKED";
        try { window.__egeBlocked = payload; } catch (_) {}
        try { window.dispatchEvent(new CustomEvent("ege:account-blocked", { detail: payload })); } catch (_) {}
      }
      throw error;
    }
    // A successful response from a block-enforcing endpoint proves the account
    // is not blocked right now (expiry / unblock recovery). Public endpoints
    // (catalog, status, health) never check blocks, so they must not clear it.
    try {
      const enforcePaths = ["/api/bootstrap", "/api/bootstrap-lite", "/api/subjects",
        "/api/auth/session", "/api/auth/devices", "/api/subject"];
      if (window.__egeBlocked && typeof path === "string"
          && enforcePaths.some((p) => path === p || path.indexOf(p + "?") === 0)) {
        window.__egeBlocked = null;
        window.dispatchEvent(new CustomEvent("ege:account-unblocked"));
      }
    } catch (_) {}
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
