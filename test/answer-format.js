/* Тесты терпимости проверки ответов к формату записи.
   Баг: `normalizeAnswer` менял запятую на точку (для дробей), из-за чего
   цифровой набор «2,4,5» не равнялся верному «245», а код соответствия
   «1,2,4,3» — «1243». Плюс слово с дефисом («официально-деловой») не
   принималось с пробелом или тире. Здесь фиксируем: наборы цифр сравниваются
   как строки с любыми разделителями, дроби и целые не сломаны, слова
   дефис/тире/пробел не различают. */
const fs = require("fs");
const src = fs.readFileSync("js/state.js", "utf8");
const basic = JSON.parse(fs.readFileSync("server/catalog_basic.json", "utf8"));
const ru = JSON.parse(fs.readFileSync("server/catalog_russian.json", "utf8"));
const taskOf = (catalog, id) => catalog.tasks.find((t) => t.id === id);

const testBody = async () => {
  let fails = 0;
  const t = (name, cond, extra) => { console.log((cond ? "ok   " : "FAIL ") + name + (cond || !extra ? "" : " | " + extra)); if (!cond) fails++; };

  /* 1. Набор цифр: разделители не ломают верный ответ, порядок важен. */
  const seq = (ans, vt) => ({ answer: ans, valueType: vt });
  t("набор цифр: «2,4,5» = «245»", checkAnswer(seq("245", "цифра"), "2,4,5"));
  t("набор цифр: пробелы", checkAnswer(seq("245", "цифра"), "2 4 5"));
  t("набор цифр: точки с запятой", checkAnswer(seq("245", "цифра"), "2;4;5"));
  t("набор цифр: точки", checkAnswer(seq("245", "цифра"), "2.4.5"));
  t("набор цифр: порядок важен — «425» неверно", !checkAnswer(seq("245", "цифра"), "425"));
  t("последовательность цифр: «1,4,3,2» = «1432»", checkAnswer(seq("1432", "последовательность цифр"), "1,4,3,2"));
  t("последовательность цифр: «1.4.3.2» = «1432»", checkAnswer(seq("1432", "последовательность цифр"), "1.4.3.2"));
  t("последовательность цифр: «1423» неверно", !checkAnswer(seq("1432", "последовательность цифр"), "1423"));

  /* 2. Настоящее соответствие из каталога (буквы А–Г) — набор цифр. */
  t("b02_p8: «1,4,3,2» верно", checkAnswer(taskOf(basic, "b02_p8"), "1,4,3,2"));
  t("b02_p8: «1432» верно", checkAnswer(taskOf(basic, "b02_p8"), "1432"));
  t("b02_p8: другой порядок неверно", !checkAnswer(taskOf(basic, "b02_p8"), "4321"));
  t("r22_1 (5 букв): «6,4,1,3,8» верно", checkAnswer(taskOf(ru, "r22_1"), "6,4,1,3,8"));

  /* 3. Дроби и целые не сломаны. */
  t("дробь «1,5» = «1.5»", checkAnswer({ answer: "1.5" }, "1,5"));
  t("дробь «1,5» ≠ целому «15»", !checkAnswer({ answer: "15", valueType: "целое число" }, "1,5"));
  t("целое «15» верно", checkAnswer({ answer: "15", valueType: "целое число" }, "15"));
  t("минус: «−3» = «-3»", checkAnswer({ answer: "-3" }, "−3"));

  /* 4. Слова: дефис, тире и пробел — один разделитель. */
  t("слово: «официально деловой» = «официально-деловой»", checkAnswer({ answer: "официально-деловой" }, "официально деловой"));
  t("слово: без дефиса", checkAnswer({ answer: "официально-деловой" }, "официальноделовой"));
  t("слово: en-dash", checkAnswer({ answer: "официально-деловой" }, "официально–деловой"));
  t("слово: em-dash", checkAnswer({ answer: "официально-деловой" }, "официально—деловой"));
  t("слово: другое слово неверно", !checkAnswer({ answer: "официально-деловой" }, "публицистический"));
  t("слово: регистр и пробелы не мешают", checkAnswer({ answer: "углубить" }, "  Углубить "));

  /* 5. Уравнения с несколькими корнями не сломаны. */
  const eq = { answer: "1, 2", type: "extended_answer" };
  t("корни: порядок неважен", checkAnswer(eq, "2, 1"));
  t("корни: неполный набор неверно", !checkAnswer(eq, "1"));
  t("корни: лишний корень неверно", !checkAnswer(eq, "1, 2, 3"));

  /* 6. Корпус: у каждого задания-набора свой ответ проходит, в т.ч. через
     запятые; чужой порядок (перестановка) — нет. */
  let corpus = 0, bad = 0;
  for (const cat of [basic, ru]) {
    for (const task of cat.tasks) {
      const vt = String(task.valueType || "");
      if (!/(цифр|последовательност)/i.test(vt)) continue;
      corpus++;
      const answer = String(task.answer);
      if (!checkAnswer(task, answer)) { bad++; console.log("FAIL corpus canonical", task.id); }
      const comma = answer.split("").join(",");
      if (!checkAnswer(task, comma)) { bad++; console.log("FAIL corpus comma", task.id); }
    }
  }
  t(`корпус: все ${corpus} цифровых заданий принимают свой ответ и запятые`, bad === 0, `${bad} проблем`);
  t("корпус: набрано достаточно заданий", corpus > 300, String(corpus));

  console.log(fails ? `\n${fails} FAILURES` : "\nALL OK");
  process.exit(fails ? 1 : 0);
};
eval(src + `\n;(${testBody.toString()})();`);