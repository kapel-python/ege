/* Чертежи решений под разбором. Живой факт: «см. рис. N» / «Рис. N» в
   solution — настоящие чертежи источника (task.solutionAssets), клиент
   больше не режет inline-ссылки, когда рисунки есть, а дорисовывает фигуры
   с подписями Рис. 1..N. Без рисунков поведение прежнее (режем всё).
   Старый клиент поле solutionAssets игнорирует — контракт не рвём. */
const fs = require("fs");
const appSrc = fs.readFileSync("js/app.js", "utf8");
const extract = (name) => appSrc.match(new RegExp("function " + name + "\\([\\s\\S]*?\\n}"))[0];

const registry = {
  "math-sol141309": { src: "assets/math/math-sol141309.png?v=1", width: 535, height: 540, ratio: 1, alt: "Рисунок к решению" },
  "math-sol141308": { src: "assets/math/math-sol141308.png?v=2", width: 471, height: 471, ratio: 1 },
};
let DataAPI = { visualAsset: (id) => registry[id] || null };
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }
function mathText(s) { return String(s == null ? "" : s); }
function icon() { return "<svg></svg>"; }

eval(extract("stripMissingFigures") + "\n" + extract("solutionFiguresHtml"));

let fails = 0;
const t = (name, cond, extra) => {
  console.log((cond ? "ok   " : "FAIL ") + name + (cond || !extra ? "" : " | " + extra));
  if (!cond) fails++;
};

// Совместимость: два аргумента работают как раньше.
t("без рисунков: одиночные Рис. N режутся",
  stripMissingFigures("Ход.\nРис. 1\nРис. 2\nКонец.", false) === "Ход.\n\nКонец.");
t("без рисунков: inline (см. рис. 1) режется",
  stripMissingFigures("Проведем (см. рис. 1), тогда ок.", false) === "Проведем , тогда ок." ||
  !stripMissingFigures("Проведем (см. рис. 1), тогда ок.", false).includes("рис"));
t("без рисунков: при чертеже условия рис. 1 живёт, рис. 2 режется", (() => {
  const s = stripMissingFigures("Чертеж (см. рис. 1) и (см. рис. 2) ок.", true);
  return s.includes("рис. 1") && !s.includes("рис. 2");
})());

// С рисунками решения: подписи-строки уходят под фигуры, ссылки живут.
t("с рисунками: одиночные Рис. N режутся (их заменят фигуры)", (() => {
  const s = stripMissingFigures("Ход.\nРис. 1\nРис. 2\nКонец.", false, true);
  return !/^Рис\./m.test(s) && s.includes("Ход.") && s.includes("Конец.");
})());
t("с рисунками: inline (см. рис. 1) сохраняется", (() => {
  const s = stripMissingFigures("Проведем (см. рис. 1), тогда ок.", false, true);
  return s.includes("(см. рис. 1)");
})());
t("с рисунками: ссылки живут и при чертеже условия", (() => {
  const s = stripMissingFigures("Чертеж (см. рис. 1) и (см. рис. 2) ок.", true, true);
  return s.includes("рис. 1") && s.includes("рис. 2");
})());

// Рендер фигур решения.
t("фигуры: два рисунка с подписями Рис. 1/2", (() => {
  const h = solutionFiguresHtml({ solutionAssets: ["math-sol141309", "math-sol141308"] });
  return h.includes("math-sol141309.png") && h.includes("math-sol141308.png") &&
    h.includes("Рис. 1") && h.includes("Рис. 2") && (h.match(/<figure/g) || []).length === 2;
})());
t("фигуры: неизвестный id пропускается молча", (() => {
  const h = solutionFiguresHtml({ solutionAssets: ["math-sol000000", "math-sol141309"] });
  return !h.includes("math-sol000000") && h.includes("Рис. 1") && (h.match(/<figure/g) || []).length === 1;
})());
t("фигуры: без поля — пусто (старый клиент/задание без рисунков)", (() =>
  solutionFiguresHtml({}) === "" && solutionFiguresHtml(null) === "" &&
  solutionFiguresHtml({ solutionAssets: [] }) === "")());
t("фигуры: упавший реестр не роняет рендер", (() => {
  const keep = DataAPI;
  DataAPI = { visualAsset: () => { throw new Error("down"); } };
  let h = "";
  try { h = solutionFiguresHtml({ solutionAssets: ["math-sol141309"] }); } catch (e) { h = "THREW"; }
  DataAPI = keep;
  return h === "";
})());

console.log(fails === 0 ? "SOLUTION-FIGURES-UI OK" : `SOLUTION-FIGURES-UI FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
