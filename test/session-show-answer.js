/* «Показать решение» мёртвой сессии больше не оставляет. Живой баг: в
   миссии-соответствии кнопка обращалась к #answerInput, которого у задания-
   таблицы нет (цифры живут в клетках match-answer__cell), падала — при этом
   сессия уже была помечена отвеченной. В итоге решения на экране нет, а ни
   «Ответить», ни «Пропустить», ни повторное «Показать решение» не отвечают:
   остаётся только выйти из миссии. Проверяем оба типа области ответа,
   вырожденный DOM и защиту от задвоения результата. */
const fs = require("fs");
const appSrc = fs.readFileSync("js/app.js", "utf8");
const extract = (name) => appSrc.match(new RegExp("function " + name + "\\([\\s\\S]*?\\n}"))[0];

const harness = `
var Session = {
  cur: null,
  task() { return this.cur && this.cur.task; },
  stopTimer() {},
};
var Store = { _lastXpBreakdown: { attempt: 3, correctBonus: 0, errorResolved: 0 } };
function recordAnswer() { return 3; }
function sessionHideBackNav() {}
function sessionNextLabel() { return "Далее"; }
function icon() { return "<svg></svg>"; }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }
function mathText(s) { return String(s == null ? "" : s); }
function renderTopbar() {}
` + extract("sessionMatchCells") + "\n" + extract("sessionShowAnswer") + "\n";

const testBody = () => {
  let fails = 0;
  const t = (name, cond, extra) => {
    console.log((cond ? "ok   " : "FAIL ") + name + (cond || !extra ? "" : " | " + extra));
    if (!cond) fails++;
  };

  // Окружение: cells — клетки ответ-таблицы, по одному объекту на элемент DOM.
  const build = (opts) => {
    const cell = () => ({ value: "", disabled: false, classes: [], classList: null });
    const withList = (target) => {
      target.classList = { add: (c) => target.classes.push(c) };
      return target;
    };
    const cells = (opts.cells || []).map(() => withList(cell()));
    const els = {};
    const get = (id) => {
      if (id === "answerInput") {
        if (opts.input === false) return null;
        return els.answerInput = els.answerInput || withList({ value: "", disabled: false, classes: [] });
      }
      if (id === "submitBtn") {
        if (opts.submit === false) return null;
        return els.submitBtn = els.submitBtn || { display: "", style: {} };
      }
      if (id === "hintControl") {
        if (opts.control === false) return null;
        return els.hintControl = els.hintControl || { innerHTML: "" };
      }
      return els.feedbackSlot = els.feedbackSlot || { innerHTML: "" };
    };
    document = {
      getElementById: get,
      querySelectorAll: (sel) => (sel === "[data-match-cell]" ? cells : []),
    };
    return {
      cells,
      feedback: () => get("feedbackSlot").innerHTML,
      control: () => get("hintControl"),
    };
  };

  const start = (task) => {
    Session.cur = { task, answered: false, hintLevel: 0, hintsUsed: 0, results: [], gainedXp: 0, taskStartTs: Date.now() };
    return Session.cur;
  };

  // 1. Соответствие: раньше здесь всё и ломалось — нет #answerInput.
  {
    const env = build({ input: false, cells: [1, 1, 1, 1, 1] });
    const S = start({ id: "r22_1", skill: "r22", answer: "64138", solution: "Разбор по маркерам тропов." });
    sessionShowAnswer();
    t("соответствие: решение показано без падения", S.answered === true);
    t("соответствие: клетки заполнены верным кодом",
      env.cells.map((c) => c.value).join("") === "64138", env.cells.map((c) => c.value).join(""));
    t("соответствие: клетки заблокированы", env.cells.every((c) => c.disabled));
    t("соответствие: на экране ответ и разбор",
      /Ответ показан/.test(env.feedback()) && /Разбор/.test(env.feedback())
      && /Разбор по маркерам тропов/.test(env.feedback()), env.feedback().slice(0, 60));
    t("соответствие: доступен «Далее»", /sessionNext\(\)/.test(env.feedback()));
    t("соответствие: кнопка помощи убрана", /^\s*$/.test(env.control().innerHTML), env.control().innerHTML);
  }

  // 2. Обычное поле ввода: поведение прежнее.
  {
    const env = build({});
    const S = start({ id: "r04_5", skill: "r04", answer: "125", solution: "Ударение в прилагательных." });
    sessionShowAnswer();
    t("поле: решение показано", S.answered === true);
    t("поле: ответ вписан и заблокирован",
      document.getElementById("answerInput").value === "125" && document.getElementById("answerInput").disabled === true);
  }

  // 3. Вырожденный DOM: ни клеток, ни поля, ни кнопок — не должно убивать сессию.
  {
    const env = build({ input: false, submit: false, control: false });
    const S = start({ id: "x", answer: "12", solution: "Разбор." });
    let threw = null;
    try { sessionShowAnswer(); } catch (err) { threw = err; }
    t("пустой DOM: нет исключения", !threw, threw && threw.message);
    t("пустой DOM: решение показано и сессия отвечена", S.answered === true && /Разбор/.test(env.feedback()));
    t("пустой DOM: кнопка «Далее» на месте", /sessionNext\(\)/.test(env.feedback()));
  }

  // 4. Повторное нажатие не удваивает результат.
  {
    const env = build({ input: false, cells: [1, 1] });
    const S = start({ id: "r22_1", answer: "11", solution: "Разбор." });
    sessionShowAnswer();
    sessionShowAnswer();
    t("повторный вызов — без второго результата", S.results.length === 1, "results=" + S.results.length);
  }

  console.log(fails ? `\n${fails} FAILURES` : "\nALL OK");
  process.exit(fails ? 1 : 0);
};

eval(appSrc.length ? harness + `\n;(${testBody.toString()})();` : "");
