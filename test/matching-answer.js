/* Тесты разбора заданий-«таблиц соответствия» (matchingAnswerLetters /
   isMatchingAnswerTask). Пока в интерфейсе включено только для №22 русского,
   но сам разбор букв общий: явный список «(АБВГ)» или метки строк «А) …».
   Если структура не распознана — пустой список, экран остаётся с обычным
   полем ввода (мультивыбор и «укажите варианты» не должны попадать в таблицу). */
const fs = require("fs");
const src = fs.readFileSync("js/state.js", "utf8");
const ru = JSON.parse(fs.readFileSync("server/catalog_russian.json", "utf8"));
const basic = JSON.parse(fs.readFileSync("server/catalog_basic.json", "utf8"));
const taskOf = (catalog, id) => catalog.tasks.find((t) => t.id === id);

const testBody = async () => {
  let fails = 0;
  const t = (name, cond, extra) => { console.log((cond ? "ok   " : "FAIL ") + name + (cond || !extra ? "" : " | " + extra)); if (!cond) fails++; };

  /* 1. №22: буквы А–Д, длина = длине ответа. */
  const r22 = ["r22_1", "r22_2", "r22_3", "r22_4", "r22_5"].map((id) => taskOf(ru, id));
  t("№22: у всех заданий распознаны 5 букв",
    r22.every((x) => matchingAnswerLetters(x).join("") === "АБВГД"),
    r22.map((x) => matchingAnswerLetters(x).join("")).join(" | "));

  /* 2. В интерфейсе — только №22 (другие скиллы не включаем). */
  t("включено только для №22", isMatchingAnswerTask(taskOf(ru, "r22_1")) === true);
  t("другие задания не включаются",
    isMatchingAnswerTask(taskOf(ru, "r09_1")) === false
    && isMatchingAnswerTask(taskOf(basic, "b02_p1")) === false
    && isMatchingAnswerTask({ skill: "r01" }) === false);

  /* 3. Разбор букв общий: явный список «(АБВГ)» / «(ABCD)». */
  t("явный список (АБВГ)", matchingAnswerLetters(taskOf(basic, "b02_p1")).join("") === "АБВГ",
    matchingAnswerLetters(taskOf(basic, "b02_p1")).join(""));
  t("явный список (ABCD)", matchingAnswerLetters(taskOf(basic, "b18_p1")).join("") === "ABCD",
    matchingAnswerLetters(taskOf(basic, "b18_p1")).join(""));

  /* 4. Мультивыбор и «укажите варианты» не превращаются в таблицу. */
  const r09 = taskOf(ru, "r09_1");
  t("мультивыбор r09: без буквенной таблицы", matchingAnswerLetters(r09).length === 0,
    matchingAnswerLetters(r09).join(""));

  /* 5. Защита от чужого типа/ответа. */
  t("не short_answer: пусто", matchingAnswerLetters({ type: "long_text", answer: "12", text: "А) x" }).length === 0);
  t("ответ не цифры: пусто", matchingAnswerLetters({ type: "short_answer", answer: "АБ", text: "А) x\nБ) y" }).length === 0);

  console.log(fails ? `\n${fails} FAILURES` : "\nALL OK");
  process.exit(fails ? 1 : 0);
};
eval(src + `\n;(${testBody.toString()})();`);
