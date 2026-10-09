/* Тесты разбора заданий-«таблиц соответствия» (matchingAnswerLetters).
   Таблица включается только для настоящих соответствий: в тексте есть
   «соответствие»/«под каждой буквой», а буквы берутся из списка «(АБВГ)»/
   «(ABCD)» или из меток строк «А) …». Мультивыбор («укажите варианты»),
   физика с «(RC)» и русский с «(НЕ)»/«(ПО)» в таблицу попадать НЕ должны. */
const fs = require("fs");
const src = fs.readFileSync("js/state.js", "utf8");
const ru = JSON.parse(fs.readFileSync("server/catalog_russian.json", "utf8"));
const basic = JSON.parse(fs.readFileSync("server/catalog_basic.json", "utf8"));
const soc = JSON.parse(fs.readFileSync("server/catalog_society.json", "utf8"));
const bio = JSON.parse(fs.readFileSync("server/catalog_biology.json", "utf8"));
const prof = JSON.parse(fs.readFileSync("server/catalog.json", "utf8"));
const taskOf = (catalog, id) => catalog.tasks.find((t) => t.id === id);

const testBody = async () => {
  let fails = 0;
  const t = (name, cond, extra) => { console.log((cond ? "ok   " : "FAIL ") + name + (cond || !extra ? "" : " | " + extra)); if (!cond) fails++; };
  const letters = (cat, id) => matchingAnswerLetters(taskOf(cat, id)).join("");

  /* 1. Настоящие соответствия: буквы А–Д. */
  t("№22: буквы А–Д", ["r22_1", "r22_2", "r22_3", "r22_4", "r22_5"].every((id) => letters(ru, id) === "АБВГД"));
  t("№8: буквы А–Д", letters(ru, "r08_1") === "АБВГД", letters(ru, "r08_1"));
  t("обществознание: буквы А–Д", letters(soc, "soc03_p1") === "АБВГД" && letters(soc, "soc15_p1") === "АБВГД");
  t("биология «в порядке АБВ»: буквы АБВ", letters(bio, "bio06_p1") === "АБВ" && letters(bio, "bio10_p1") === "АБВ" && letters(bio, "bio14_p1") === "АБВ" && letters(bio, "bio19_p1") === "АБВ");
  t("база: явный список (АБВГ)", letters(basic, "b02_p1") === "АБВГ", letters(basic, "b02_p1"));
  t("база: явный список (ABCD)", letters(basic, "b18_p1") === "ABCD", letters(basic, "b18_p1"));

  /* 2. Ложные срабатывания отсеяны: не соответствия. */
  t("русский «укажите варианты» (НЕ): без таблицы", letters(ru, "r13_3") === "", letters(ru, "r13_3"));
  t("русский «оба слова слитно» (ПО): без таблицы", letters(ru, "r14_2") === "", letters(ru, "r14_2"));
  t("физика с формулой (RC): без таблицы", letters(prof, "n10_a2") === "", letters(prof, "n10_a2"));
  t("мультивыбор r09: без таблицы", letters(ru, "r09_1") === "", letters(ru, "r09_1"));

  /* 3. Защита от чужого типа/ответа. */
  t("не short_answer: пусто", matchingAnswerLetters({ type: "long_text", answer: "12", text: "Установите соответствие" }).length === 0);
  t("ответ не цифры: пусто", matchingAnswerLetters({ type: "short_answer", answer: "АБ", text: "А) x\nБ) y" }).length === 0);
  t("список не от А: пусто", matchingAnswerLetters({ type: "short_answer", answer: "12", text: "Установите соответствие (БВ)" }).length === 0);

  console.log(fails ? `\n${fails} FAILURES` : "\nALL OK");
  process.exit(fails ? 1 : 0);
};
eval(src + `\n;(${testBody.toString()})();`);
