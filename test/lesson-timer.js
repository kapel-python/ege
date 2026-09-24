/* Регрессия активного времени урока: календарная пауза не должна попадать
   в durationSec, а повторные resume/pause не должны удваивать интервал. */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "js", "app.js"), "utf8");
const start = src.indexOf("const LESSON_CLOCK_MAX_GAP_MS =");
const end = src.indexOf("\nfunction resumeLessonClock", start);
if (start < 0 || end < 0) throw new Error("LessonClock block not found");

let now = 1_000;
const context = {
  Date: { now: () => now },
  Math,
  Number,
  setInterval: () => 101,
  clearInterval: () => {},
  currentRoute: () => "lesson",
  document: { hidden: false, visibilityState: "visible" },
};
vm.createContext(context);
vm.runInContext(src.slice(start, end) + "\nthis.LessonClock = LessonClock;", context);
const clock = context.LessonClock;

let fails = 0;
const t = (name, condition, detail = "") => {
  console.log((condition ? "ok  " : "FAIL") + " " + name + (condition ? "" : " — " + detail));
  if (!condition) fails++;
};

const lesson = { activeMs: 0, activeSince: 1_000, timerId: null };
clock.sync(lesson, 6_000);
t("активные секунды начисляются", lesson.activeMs === 5_000, String(lesson.activeMs));

now = 1_000 + 2 * 60 * 60 * 1000;
clock.sync(lesson, now);
t("многочасовая пауза отбрасывается safeguard-ом", lesson.activeMs === 5_000, String(lesson.activeMs));

clock.pause(lesson);
t("pause обнуляет текущий сегмент", lesson.activeSince === null && lesson.timerId === null);

const resumed = { activeMs: 8_000, activeSince: null, timerId: null };
clock.start(resumed);
const firstSince = resumed.activeSince;
clock.start(resumed);
t("повторный resume не создаёт второй сегмент", resumed.activeSince === firstSince && resumed.timerId === 101);

context.document.hidden = true;
clock.pause(resumed);
t("pause после скрытия страницы не начисляет время", resumed.activeSince === null && resumed.activeMs === 8_000);

console.log(fails ? `\n${fails} FAILURES` : "\nALL OK");
process.exit(fails ? 1 : 0);
