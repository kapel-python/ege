/* Таблица-ответ в шагах-соответствиях урока (как в бланке ЕГЭ): цифра под
   каждой буквой. Проверяем распознавание соответствия (из банка и inline),
   отрисовку клеток по буквам и сбор ответа из клеток. Это чинит ту же
   путаницу с кодом, из-за которой падали шаги Дарьи (b02 s6 «1243»). */
const fs = require("fs");
const src = fs.readFileSync("js/state.js", "utf8");
const appSrc = fs.readFileSync("js/app.js", "utf8");
const extract = (name) => appSrc.match(new RegExp("function " + name + "\\([\\s\\S]*?\\n}"))[0];

/* Заглушки окружения и извлечённые функции сшиваем в один eval вместе со
   state.js, чтобы matchingAnswerLetters была настоящей. */
const stubs = `
var __cells = [];
var __TASKS = {};
var document = { querySelectorAll: function (sel) { return sel === "[data-lesson-match-cell]" ? __cells : []; } };
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }
function icon() { return "<svg></svg>"; }
function lessonTask(step) { return step && step.taskId && __TASKS[step.taskId] ? __TASKS[step.taskId] : null; }
`;
const harness = stubs
  + extract("lessonMatchingTask") + "\n"
  + extract("lessonMatchTableHtml") + "\n"
  + extract("lessonMatchValue") + "\n";

const testBody = () => {
  let fails = 0;
  const t = (name, cond, extra) => { console.log((cond ? "ok   " : "FAIL ") + name + (cond || !extra ? "" : " | " + extra)); if (!cond) fails++; };

  const inlineStep = {
    answer: "1243",
    text: "Соотнеси величины и значения.\nА) скорость\nБ) путь\nВ) время\nГ) ускорение",
  };
  const m1 = lessonMatchingTask(inlineStep);
  t("inline-код распознан как соответствие", !!m1 && m1.letters.join("") === "АБВГ", m1 && m1.letters.join(""));
  t("inline: ответ — набор цифр по буквам", !!m1 && m1.task.answer === "1243");
  t("код соответствия принимает «1,2,4,3»", checkAnswer(m1.task, "1,2,4,3"));
  t("код соответствия отвергает чужой порядок", !checkAnswer(m1.task, "1,2,3,4"));

  // Задание из банка: taskId ссылается на настоящее соответствие.
  __TASKS = { b02_p8: { type: "short_answer", answer: "1432", text: "Соотнеси величины.\nА) 1\nБ) 2\nВ) 3\nГ) 4" } };
  const m2 = lessonMatchingTask({ taskId: "b02_p8" });
  t("задание из банка распознано", !!m2 && m2.letters.join("") === "АБВГ", m2 && m2.letters.join(""));

  const plain = lessonMatchingTask({ answer: "42", text: "Чему равно значение выражения?" });
  t("обычный числовой шаг — не соответствие", plain === null);

  const html = lessonMatchTableHtml(["А", "Б", "В", "Г"], "12", false);
  t("таблица: четыре клетки по буквам", (html.match(/data-lesson-match-cell=/g) || []).length === 4);
  t("таблица: подписи букв", /<th scope="col">А<\/th>/.test(html) && /<th scope="col">Г<\/th>/.test(html));
  const htmlDone = lessonMatchTableHtml(["А", "Б"], "12", true);
  t("таблица: после решения клетки заблокированы", (htmlDone.match(/disabled/g) || []).length === 2, htmlDone);
  t("таблица: подсказка про бланк", /Впиши цифру под каждой буквой/.test(html));

  __cells = [{ value: "1" }, { value: "2" }, { value: "" }, { value: "4" }];
  t("сбор ответа из клеток", lessonMatchValue() === "124", lessonMatchValue());
  __cells = [{ value: "9" }, { value: "x8" }];
  t("сбор ответа: не-цифры отброшены, лишнее обрезано", lessonMatchValue() === "98", lessonMatchValue());

  console.log(fails ? `\n${fails} FAILURES` : "\nALL OK");
  process.exit(fails ? 1 : 0);
};

eval(src + "\n" + harness + `\n;(${testBody.toString()})();`);