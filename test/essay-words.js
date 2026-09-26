/* Паритет клиентского подсчёта слов (js/state.js countWords) с серверным
   алгоритмом (server.py ESSAY_WORD_RE). Ожидания продублированы из
   test/essay-submission.py — при смене алгоритма править ОБА файла. */
const fs = require("fs");
const vm = require("vm");

const catalog = { subject: "russian", subjects: [], categories: [], skills: [], tasks: [], lessons: [], missions: [], bosses: [], achievements: [], daily: {}, goals: [], diagnosticTasks: [], visualAssets: [], visualAudit: {} };
const sandbox = { console, catalog, setTimeout, clearTimeout };
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync("js/state.js", "utf8"), sandbox, { filename: "essay-words.js" });

const words = (n, w = "слово") => Array.from({ length: n }, () => w).join(" ");
const cases = [
  ["", 0], ["   ", 0], ["\n\t\n", 0], ["!!!", 0], ["…«»—()", 0],
  ["слово", 1], ["  слово  ", 1],
  ["Привет, мир!", 2],
  ["какой-то", 1], ["слово - слово", 2], ["слово — слово", 2],
  ["don't", 1], ["'кавычки'", 1], ["«два слова»", 2],
  ["один\nдва\tтри", 3],
  ["много   пробелов\tи\n\nпереносов", 4],
  [words(149), 149], [words(150), 150], [words(151), 151],
  ["12 34", 2], ["a1-b2", 1],
  [words(400), 400],
  ["Трудно или легко, на ваш взгляд, делать добро?", 8],
];

let fails = 0;
vm.runInContext("globalThis.results = [];", sandbox);
for (const [text, want] of cases) {
  sandbox.__text = text;
  const got = vm.runInContext("countWords(__text)", sandbox);
  const okCount = got === want;
  console.log(`${okCount ? "ok  " : "FAIL"} WORDS ${want}: ${JSON.stringify(text.slice(0, 30))}${okCount ? "" : ` (got ${got})`}`);
  if (!okCount) fails++;
}
vm.runInContext("globalThis.marks = { min: ESSAY_MIN_WORDS };", sandbox);
const minOk = sandbox.marks.min === 150;
console.log(`${minOk ? "ok  " : "FAIL"} ESSAY_MIN_WORDS === 150`);
if (!minOk) fails++;
console.log(fails ? `${fails} FAILURES` : "ALL OK");
process.exit(fails ? 1 : 0);
