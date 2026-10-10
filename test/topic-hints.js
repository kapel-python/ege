/* Универсальные подсказки темы. В банках ЕГЭ подсказки задач — шаблоны
   формата ответа («перечитай формулировку: номера ответов»), поэтому в
   практике/миссиях/боссах/«ежедневке»/повторении берём содержательные
   подсказки темы (skill.metadata.hints), если они заданы, иначе — прежнюю
   лестницу задания. Шаги уроков не затронуты: у них свои точные подсказки. */
const fs = require("fs");
const src = fs.readFileSync("js/state.js", "utf8");
const appSrc = fs.readFileSync("js/app.js", "utf8");
const extract = (name) => appSrc.match(new RegExp("function " + name + "\\([\\s\\S]*?\\n}"))[0];

const stubs = `
var DataAPI = { _skills: {}, skill: function (id) { return this._skills[id] || null; } };
function mathText(s) { return String(s == null ? "" : s); }
`;

const harness = stubs + extract("hintLevelsFor") + "\n" + extract("topicHintLevels") + "\n";

const testBody = () => {
  let fails = 0;
  const t = (name, cond, extra) => {
    console.log((cond ? "ok   " : "FAIL ") + name + (cond || !extra ? "" : " | " + extra));
    if (!cond) fails++;
  };

  const genericHints = [
    "Перечитай формулировку: она прямо говорит, что записывать — номера ответов.",
    "Отметь все подходящие варианты, а не первый найденный.",
    "Запиши номера по возрастанию, без пробелов.",
  ];
  const topicHints = ["тема-1", "тема-2", "тема-3"];

  // 1. Тема с подсказками перебивает шаблон формы задания.
  DataAPI._skills = { r22: { id: "r22", metadata: { hints: topicHints } } };
  const task = { id: "r22_1", skill: "r22", hints: genericHints };
  t("тема с подсказками: набор темы", topicHintLevels(task).join("|") === topicHints.join("|"));

  // 2. Тема без подсказок — прежняя лестница задания.
  DataAPI._skills = { r01: { id: "r01", metadata: { kind: "topic" } } };
  const task2 = { id: "r01_1", skill: "r01", hints: genericHints };
  t("тема без подсказок: шаблон задания", topicHintLevels(task2).join("|") === genericHints.join("|"));

  // 3. Тема неизвестна/скилл отсутствует — не падаем, берём подсказки задания.
  DataAPI._skills = {};
  t("неизвестная тема: подсказки задания", topicHintLevels(task).join("|") === genericHints.join("|"));

  // 4. Задание без hints и без темы — честный запасной шаг (не пусто).
  const bare = topicHintLevels({ id: "x", hint: "Вернись к условию.", solution: "Разбор." });
  t("запасной шаг: три непустые подсказки", bare.length === 3 && bare.every((h) => String(h).trim().length > 0), JSON.stringify(bare));

  // 5. Тема с менее чем тремя подсказками не считается «универсальной».
  DataAPI._skills = { r09: { id: "r09", metadata: { hints: ["одна"] } } };
  t("меньше трёх подсказок темы — шаблон задания", topicHintLevels({ skill: "r09", hints: genericHints }).join("|") === genericHints.join("|"));

  // 6. Практика обязана ходить через тему, а не голый hintLevelsFor.
  const callSites = (appSrc.match(/= topicHintLevels\(t\)/g) || []).length;
  t("практика использует подсказки темы (2 вызова)", callSites === 2, "вызовов: " + callSites);

  // 7. Каталог: у темы №22 действительно три содержательных подсказки.
  const catalog = JSON.parse(fs.readFileSync("server/catalog_russian.json", "utf8"));
  const r22 = (catalog.skills || []).find((s) => s.id === "r22");
  const catHints = r22 && r22.metadata && r22.metadata.hints;
  t("каталог: тема №22 — три подсказки", Array.isArray(catHints) && catHints.length === 3, JSON.stringify(catHints));
  t("каталог: подсказки темы не шаблон формата",
    Array.isArray(catHints) && !/Перечитай формулировку/.test(catHints[0]));

  console.log(fails ? `\n${fails} FAILURES` : "\nALL OK");
  process.exit(fails ? 1 : 0);
};

eval(src + "\n" + harness + `\n;(${testBody.toString()})();`);