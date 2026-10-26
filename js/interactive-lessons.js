/* ============================================================
   Интерактивные (визуальные) уроки — БЕТА.
   Отдельная сущность от классических пошаговых уроков (Lesson):
   классика живёт в каталоге сервера (DataAPI.lessonsBySkill),
   а визуальный урок — здесь, во фронте, и открывается по skillId
   через роут #/ilesson/<skillId>.

   Почему так:
   - кнопке в модалке темы не нужен lessonId из каталога — только skillId;
   - пока урока нет, роут всё равно существует и показывает красивую
     заглушку (а не модалку «недоступно»);
   - когда урок появится, достаточно добавить запись в ILessons.BY_SKILL —
     кнопка и роут подхватят её автоматически, без правок app.js.

   Как добавить новый визуальный урок (шаблон для всех тем):
   1. Скопируй INTERACTIVE_LESSON_TEMPLATE ниже.
   2. Заполни scenes: каждая сцена = { title, text, visual? }.
      visual — опционально: { kind: "svg"|"html", svg|html: "<...>" }.
      Никакого бэкенда не нужно, всё статично.
   3. Зарегистрируй: ILessons.BY_SKILL["<skillId>"] = твой объект.
      skillId — тот же id, что у темы (см. каталог: skill.id).
   4. Готово: кнопка «Интерактивный урок» в модалке темы и роут
      #/ilesson/<skillId> начнут рендерить урок вместо заглушки.

   Пример-заготовка под тригонометрию / историю — в конце файла
   (закомментирована, раскомментируй и заполни).
   ============================================================ */

const ILessons = {
  // skillId -> { title, subtitle?, scenes: [{ title?, text, visual? }] }
  BY_SKILL: {
    // Пока пусто: все темы показывают заглушку screenInteractiveLesson().
    // Пример: "n13_trig": { title: "...", scenes: [...] }
  },

  get(skillId) {
    const id = String(skillId == null ? "" : skillId).trim();
    if (!id) return null;
    const lesson = this.BY_SKILL[id];
    if (!lesson || typeof lesson !== "object") return null;
    const scenes = Array.isArray(lesson.scenes) ? lesson.scenes.filter((s) => s && typeof s === "object") : [];
    if (!scenes.length) return null;
    return { ...lesson, skillId: id, scenes };
  },

  has(skillId) {
    return !!this.get(skillId);
  },
};

/* Шаблон визуального урока — копируй на каждую новую тему.
   Держи сцены короткими: 1 идея = 1 сцена, 4–8 сцен на урок. */
const INTERACTIVE_LESSON_TEMPLATE = {
  skillId: "example_skill_id",
  title: "Название визуального урока",
  subtitle: "1–2 строки: что поймёт ученик за 5 минут",
  scenes: [
    {
      title: "Сцена 1: идея",
      text: "Короткий текст сцены. Без формул-простыней — одна мысль.",
      // visual: { kind: "html", html: "<div>...</div>" },
    },
    {
      title: "Сцена 2: визуал",
      text: "Здесь интерактив: картинка / SVG / слайдер.",
    },
  ],
};

/* --- Будущие примеры (тригонометрия, история): черновик структуры ---
   Раскомментируй и заполни, когда появятся материалы из папки проекта.

ILessons.BY_SKILL["trig_example"] = {
  title: "Тригонометрия: единичная окружность",
  subtitle: "Почему sin и cos — это просто координаты точки",
  scenes: [
    { title: "Окружность", text: "..." },
    { title: "Угол", text: "..." },
  ],
};
*/

/* Точка входа из модалки темы и из будущих списков.
   Закрывает модалку и ведёт на универсальный роут — сам роут решит,
   показать урок или заглушку. Отдельный параметр (skillId), а не lessonId:
   визуальный урок привязан к ТЕМЕ, а не к записи каталога. */
function openInteractiveLesson(skillId) {
  const id = String(skillId == null ? "" : skillId).trim();
  if (!id) return;
  try { if (typeof closeModal === "function") closeModal(); } catch (_) {}
  try {
    if (typeof go === "function") { go("ilesson", id); return; }
  } catch (_) {}
  try { location.hash = "#/ilesson/" + encodeURIComponent(id); } catch (_) {}
}
