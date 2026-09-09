/* EGE CORE — client data service.
   The catalog is loaded from the backend. This module only keeps a short-lived
   read cache so rendering code can use the existing synchronous selectors; the
   source of truth is SQLite behind /api/bootstrap. */

const DataAPI = {
  catalog: null,

  load(catalog) {
    if (!catalog || !Array.isArray(catalog.tasks) || !Array.isArray(catalog.skills)) {
      throw new Error("Backend returned an invalid catalog");
    }
    this.catalog = catalog;
  },

  ready() { return !!this.catalog; },
  categories() { return this.catalog?.categories || []; },
  skills() { return this.catalog?.skills || []; },
  skill(id) { return this.skills().find((item) => item.id === id); },
  category(id) { return this.categories().find((item) => item.id === id); },
  tasks() { return this.catalog?.tasks || []; },
  task(id) { return this.tasks().find((item) => item.id === id); },
  tasksBySkill(skillId) { return this.tasks().filter((item) => item.skill === skillId); },
  missions() { return this.catalog?.missions || []; },
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
