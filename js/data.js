/* EGE CORE — client data service.
   The catalog is loaded from the backend. This module only keeps a short-lived
   read cache so rendering code can use the existing synchronous selectors; the
   source of truth is SQLite behind /api/bootstrap. */

const DataAPI = {
  catalog: null,
  _tasksFull: false,
  _lessonsFull: false,

  load(catalog) {
    if (!catalog || !Array.isArray(catalog.tasks) || !Array.isArray(catalog.skills)) {
      throw new Error("Backend returned an invalid catalog");
    }
    this.catalog = catalog;
    // Лёгкий bootstrap привозит заглушки задач (_stub) и мета уроков (_meta)
    // без текстов и шагов — считаем детали загруженными, только если их нет.
    this._tasksFull = !catalog.tasks.some((t) => t._stub);
    this._lessonsFull = !catalog.lessons.some((l) => l._meta);
    if (!Array.isArray(catalog.visualAssets)) catalog.visualAssets = [];
    if (!catalog.visualAudit) catalog.visualAudit = {};
  },

  // Ленивая догрузка полных задач/уроков поверх summary-каталога.
  // Существующие селекторы продолжают работать — меняется только содержимое.
  loadDetails({ tasks, lessons, visualAssets, visualAudit }) {
    if (!this.catalog) throw new Error("Catalog is not loaded");
    if (Array.isArray(tasks) && tasks.length) {
      this.catalog.tasks = tasks;
      this._tasksFull = true;
    }
    if (Array.isArray(lessons) && lessons.length) {
      this.catalog.lessons = lessons;
      this._lessonsFull = true;
    }
    if (Array.isArray(visualAssets)) this.catalog.visualAssets = visualAssets;
    if (visualAudit) this.catalog.visualAudit = visualAudit;
  },

  detailsReady() { return !!this.catalog && this._tasksFull && this._lessonsFull; },
  tasksReady() { return !!this.catalog && this._tasksFull; },
  lessonsReady() { return !!this.catalog && this._lessonsFull; },

  // Число шагов урока: у мета-заглушки шагов нет, только stepsCount.
  lessonStepsCount(lesson) {
    if (!lesson) return 0;
    if (Array.isArray(lesson.steps)) return lesson.steps.length;
    return Number(lesson.stepsCount) || 0;
  },

  ready() { return !!this.catalog; },
  categories() { return this.catalog?.categories || []; },
  skills() { return this.catalog?.skills || []; },
  skill(id) { return this.skills().find((item) => item.id === id); },
  category(id) { return this.categories().find((item) => item.id === id); },
  tasks() { return this.catalog?.tasks || []; },
  task(id) { return this.tasks().find((item) => item.id === id); },
  // A task whose statement depends on an official figure the project does not
  // have (visual.required with no assetId, see visualAudit) cannot actually
  // be solved — it must stay in the catalog for completeness/audits, but it
  // must never be handed to a student to attempt. This is the one predicate
  // every selection path below filters through.
  taskHasMissingVisual(item) { return !!(item && item.visual && item.visual.required && !item.visual.assetId); },
  practiceTasks() { return this.tasks().filter((item) => !this.taskHasMissingVisual(item)); },
  tasksBySkill(skillId) { return this.tasks().filter((item) => item.skill === skillId); },
  practiceTasksBySkill(skillId) { return this.practiceTasks().filter((item) => item.skill === skillId); },
  missions() {
    return (this.catalog?.missions || []).map((m) => (
      Array.isArray(m.tasks) ? { ...m, tasks: m.tasks.filter((id) => !this.taskHasMissingVisual(this.task(id))) } : m
    ));
  },
  mission(id) { return this.missions().find((item) => item.id === id); },
  lessons() { return this.catalog?.lessons || []; },
  lesson(id) { return this.lessons().find((item) => item.id === id); },
  lessonsBySkill(skillId) { return this.lessons().filter((item) => item.skill === skillId); },
  bosses() { return this.catalog?.bosses || []; },
  achievements() { return this.catalog?.achievements || []; },
  daily() { return this.catalog?.daily || { skill: "", target: 0, xp: 0, title: "" }; },
  goals() { return this.catalog?.goals || []; },
  diagnosticTasks() { return this.catalog?.diagnosticTasks || []; },
  visualAssets() { return this.catalog?.visualAssets || []; },
  visualAudit() { return this.catalog?.visualAudit || {}; },
  visualAsset(id) { return this.visualAssets().find((asset) => asset.id === id); },
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
    if (!response.ok) throw new Error(payload.error || `API ${response.status}`);
    return payload;
  },
  get(path) { return this.request(path); },
  put(path, body) { return this.request(path, { method: "PUT", body: JSON.stringify(body) }); },
  post(path, body) { return this.request(path, { method: "POST", body: JSON.stringify(body) }); },
  delete(path) { return this.request(path, { method: "DELETE" }); },
};
