#!/usr/bin/env node
/* Зеркало правил серии на клиенте (js/app.js): показ frozen/lost и роутинг
   клика по огоньку. Извлекаем настоящие исходники функций из app.js и
   гоняем их со стабами Store/todayStr — тестируется реальный код, не копия. */
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "js", "app.js"), "utf8");

let failures = 0, checks = 0;
function t(name, cond, detail) {
  checks++;
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " | " + detail : ""}`);
}

function extract(re, label) {
  const m = src.match(re);
  t(`исходник ${label} найден`, !!m);
  if (!m) throw new Error("missing " + label);
  return m[0];
}

const varFrozen = extract(/var STREAK_FROZEN_MIN_DAYS = \d+;/, "STREAK_FROZEN_MIN_DAYS");
const dayDiffSrc = extract(/function streakDayDiff\(a, b\) \{[\s\S]*?\n\}/, "streakDayDiff");
const statusSrc = extract(/function streakLocalStatus\(\) \{[\s\S]*?\n\}/, "streakLocalStatus");
const clickSrc = extract(/function onStreakChipClick\(\) \{[\s\S]*?\n\}/, "onStreakChipClick");

// Московское "сегодня" для теста — берём реальную дату, кейсы относительные.
function mskToday() {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Moscow" }));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const TODAY = mskToday();
function dayOff(n) {
  const d = new Date(TODAY + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

let Store = { state: {} };
function todayStr() { return TODAY; }
// eslint-disable-next-line no-unused-vars
let called = null;
function openStreakFrozenModal() { called = "frozen"; }
function openStreakRestoreModal() { called = "restore"; }
function openHelp() { called = "help"; }

eval(varFrozen + "\n" + dayDiffSrc + "\n" + statusSrc + "\n" + clickSrc);

function status(streak, lastActiveDate) {
  Store = { state: { streak, lastActiveDate } };
  return streakLocalStatus();
}
function click(streak, lastActiveDate) {
  Store = { state: { streak, lastActiveDate } };
  called = null;
  onStreakChipClick();
  return called;
}

// Активна: сегодня / вчера
let s = status(5, TODAY);
t("active сегодня", s.status === "active" && s.shown === 5, JSON.stringify(s));
s = status(5, dayOff(-1));
t("active вчера", s.status === "active" && s.shown === 5, JSON.stringify(s));
// Заморозка: позавчера + P>=2
s = status(7, dayOff(-2));
t("frozen позавчера", s.status === "frozen" && s.shown === 7, JSON.stringify(s));
// Потеря: 3+ дня назад
s = status(7, dayOff(-3));
t("lost 3 дня назад", s.status === "lost" && s.shown === 0 && s.frozenValue === 7, JSON.stringify(s));
s = status(7, dayOff(-10));
t("lost 10 дней назад", s.status === "lost" && s.shown === 0 && s.frozenValue === 7, JSON.stringify(s));
// P=1 не морозится
s = status(1, dayOff(-2));
t("P=1 не frozen", s.status === "lost" && s.frozenValue === 0, JSON.stringify(s));
// Пусто / мусор
s = status(0, null);
t("пусто = lost", s.status === "lost" && s.shown === 0 && s.frozenValue === 0, JSON.stringify(s));
s = status(4, "мусор");
t("битая дата = lost", s.status === "lost" && s.shown === 0, JSON.stringify(s));
// Клик: frozen -> окно заморозки, lost с прошлым -> восстановление, иначе помощь
t("клик frozen", click(7, dayOff(-2)) === "frozen");
t("клик lost", click(7, dayOff(-5)) === "restore");
t("клик active", click(7, TODAY) === "help");
t("клик P=1 lost", click(1, dayOff(-5)) === "help");
t("клик пусто", click(0, null) === "help");

// Врезка в чип: класс заморозки, хендлер, тайтлы
t("топбар: frozen-класс", src.includes("streak-chip--frozen"));
t("топбар: клик через onStreakChipClick", src.includes('onclick="onStreakChipClick()"'));
t("топбар: старый openHelp('streak') в чипе убран", !src.includes('onclick="openHelp(\'streak\')"'));
t("автопоказ: задержка 2с", src.includes("}, 2000);"));
t("автопоказ: только дашборд-условия", src.includes("maybeScheduleStreakFrozenModal"));
t("модалка заморозки через .dlg", src.includes("Серия заморожена"));
t("модалка восстановления: лимиты", src.includes("Восстановлений в этом месяце"));
t("модалка восстановления: disabled", src.includes('id="streakRestoreBtn"') && src.includes("disabled"));
t("CSS: frozen-переменные", fs.readFileSync(path.join(__dirname, "..", "css", "styles.css"), "utf8").includes("--streak-frozen-neon"));

// Локальный touchStreak (js/state.js) продолжает замороженную серию сразу
// верным числом, а не единицей: сервер простит пропуск автомостом при записи.
const stateSrc = fs.readFileSync(path.join(__dirname, "..", "js", "state.js"), "utf8");
t("touchStreak: оттайка", stateSrc.includes("dayBeforeYesterdayStr() && (Number(s.streak) || 0) >= 2"));
t("touchStreak: хелпер позавчера", stateSrc.includes("function dayBeforeYesterdayStr()"));
// Восстановление подставляет эффективную дату, иначе показ тут же вернулся бы к 0.
t("restore: displayDate", src.includes("res.displayDate || res.lastActiveDate"));

console.log(`\nchecks=${checks} failures=${failures}`);
process.exit(failures ? 1 : 0);
