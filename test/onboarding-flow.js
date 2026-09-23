/* Онбординг и дисциплина выбора предмета при входе — без браузера.
   Читает исходник js/app.js и проверяет:
   1. STEPS без welcome: ровно 6 шагов, первый stepSubject, метода stepWelcome нет.
   2. Переходы: pickSubject (готовый предмет -> шаг 1, пустой -> шаг 5),
      nextDiag (счётчик + шаг 4 в конце), next (инкремент + запрет на шаге 3).
      Статика + живое исполнение объекта Onboarding со стабами.
   3. pendingSubjectChoice: выставляется только в submitLogin, чистится
      в logoutAccount / revokeDeviceSession / chooseLoginSubject (+ sessionStorage);
      submitRegister его не трогает и сессии не чистит (тот же профиль).
   Любой возврат welcome или сдвиг индексов роняет тест. */
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "js", "app.js"), "utf8");
let fails = 0;
const t = (name, cond, extra = "") => {
  console.log((cond ? "ok  " : "FAIL") + " " + name + (cond ? "" : " — " + extra));
  if (!cond) fails++;
};

/* Тело функции/объекта по балансу скобок: startIdx — индекс открывающей "{" */
function braceBody(text, startIdx) {
  let depth = 0;
  let i = startIdx;
  for (; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(startIdx + 1, i);
    }
  }
  return null;
}
function fnBody(source, sig) {
  const idx = source.indexOf(sig);
  if (idx < 0) return null;
  const open = source.indexOf("{", idx);
  if (open < 0) return null;
  return braceBody(source, open);
}

/* ---------- 1. STEPS без welcome ---------- */
const stepsBody = fnBody(src, "STEPS()");
t("STEPS найден", !!stepsBody);
const stepsMatch = stepsBody && stepsBody.match(/return\s*\[([^\]]*)\]/);
const steps = stepsMatch
  ? stepsMatch[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean)
  : [];
const EXPECTED = ["stepSubject", "stepLevel", "stepGoal", "stepDiagnostic", "stepResult", "stepName"];
t("STEPS: ровно 6 шагов", steps.length === 6, JSON.stringify(steps));
t("STEPS: первый шаг — stepSubject", steps[0] === "stepSubject", JSON.stringify(steps));
t("STEPS: точный порядок без welcome", JSON.stringify(steps) === JSON.stringify(EXPECTED), JSON.stringify(steps));
t("нет метода stepWelcome", !/stepWelcome\s*\(/.test(src), "stepWelcome вернулся");

/* ---------- 2. Переходы (статика) ---------- */
const pickBody = fnBody(src, "pickSubject(v) {");
t("pickSubject найден", !!pickBody);
t("pickSubject: готовый предмет -> шаг 1, пустой -> шаг 5",
  !!pickBody && /this\.step\s*=\s*ready\s*\?\s*1\s*:\s*5/.test(pickBody),
  (pickBody || "").slice(0, 200));
const nextDiagBody = fnBody(src, "nextDiag() {");
t("nextDiag найден", !!nextDiagBody);
t("nextDiag: счётчик растёт", !!nextDiagBody && /this\.diagIdx\+\+/.test(nextDiagBody));
t("nextDiag: конец диагностики -> шаг 4 (итог)",
  !!nextDiagBody && /this\.step\s*=\s*4/.test(nextDiagBody));
const nextBody = fnBody(src, "next() {");
t("next найден", !!nextBody);
t("next: запрет перескока через диагностику (шаг 3)",
  !!nextBody && /if\s*\(\s*this\.step\s*===\s*3\s*\)\s*return/.test(nextBody));
t("next: обычный инкремент шага", !!nextBody && /this\.step\+\+/.test(nextBody));

/* ---------- 2b. Переходы (живое исполнение со стабами) ----------
   Тела четырёх методов собираем в тестовый объект через new Function:
   DataAPI приходит параметром фабрики, render глушим. Шаблонные строки
   остальных шагов онбординга сюда не попадают, браузера не нужно. */
(function liveOnboarding() {
  const grab = (sig) => fnBody(src, sig);
  const bSteps = grab("STEPS() {");
  const bPick = grab("pickSubject(v) {");
  const bNextDiag = grab("nextDiag() {");
  const bNext = grab("next() {");
  t("методы извлекаются целиком", !!(bSteps && bPick && bNextDiag && bNext));
  if (!(bSteps && bPick && bNextDiag && bNext)) return;
  /* pickSubject переключает каталог через Store.switchSubject (промис) и
     только потом выставляет шаг. Стаб исполняет .then синхронно, чтобы тест
     остался без браузера и без ожидания микрозадач. */
  const storeStub = { switchSubject: () => ({ catch() { return this; }, then(fn) { fn(); return this; } }) };
  const makeOb = (api) => new Function("DataAPI", "Store",
    `"use strict"; return ({ step: 0, diagIdx: 0, subject: null, name: null, render(){}, finish(){}, ` +
    `STEPS() {${bSteps}}, pickSubject(v) {${bPick}}, ` +
    `nextDiag() {${bNextDiag}}, next() {${bNext}} });`)(api, storeStub);
  const readyAPI = {
    subjectInfo: () => ({ status: "ready" }),
    diagnosticTasks: () => ["d1", "d2", "d3", "d4", "d5"],
  };
  const emptyAPI = {
    subjectInfo: () => ({ status: "soon" }),
    diagnosticTasks: () => [],
  };
  let ob = null;
  try { ob = makeOb(readyAPI); }
  catch (e) { t("методы исполняются без браузера", false, String(e)); return; }
  t("STEPS живой: 6 шагов, первый stepSubject",
    JSON.stringify(ob.STEPS()) === JSON.stringify(EXPECTED), JSON.stringify(ob.STEPS()));
  ob = makeOb(readyAPI);
  ob.pickSubject("math");
  t("pickSubject живой: готовый предмет -> шаг 1", ob.step === 1, `step=${ob.step}`);
  ob = makeOb(emptyAPI);
  ob.pickSubject("chem");
  t("pickSubject живой: пустой предмет -> шаг 5 (имя)", ob.step === 5, `step=${ob.step}`);
  ob = makeOb(readyAPI);
  ob.step = 1;
  ob.next();
  t("next живой: 1 -> 2", ob.step === 2, `step=${ob.step}`);
  ob.step = 3;
  ob.next();
  t("next живой: шаг 3 не перескакивает диагностику", ob.step === 3, `step=${ob.step}`);
  ob.step = 3; ob.diagIdx = 0;
  ob.nextDiag();
  t("nextDiag живой: счётчик растёт без смены шага",
    ob.diagIdx === 1 && ob.step === 3, `idx=${ob.diagIdx} step=${ob.step}`);
  ob.step = 3; ob.diagIdx = 4;
  ob.nextDiag();
  t("nextDiag живой: последнее задание -> шаг 4 (итог)",
    ob.diagIdx === 5 && ob.step === 4, `idx=${ob.diagIdx} step=${ob.step}`);
})();

/* ---------- 3. Дисциплина pendingSubjectChoice ---------- */
t("флаг объявлен выключенным", /let\s+pendingSubjectChoice\s*=\s*false/.test(src));
const loginBody = fnBody(src, "async function submitLogin(");
const registerBody = fnBody(src, "async function submitRegister(");
const logoutBody = fnBody(src, "async function logoutAccount(");
const revokeBody = fnBody(src, "async function revokeDeviceSession(");
const chooseBody = fnBody(src, "async function chooseLoginSubject(");
const setTrue = src.match(/pendingSubjectChoice\s*=\s*true/g) || [];
const bootBody = fnBody(src, "function bootstrapApp(");
t("флаг включается только входом и восстановлением пикера после перезагрузки",
  setTrue.length === 2
    && !!loginBody && /pendingSubjectChoice\s*=\s*true/.test(loginBody)
    && !!bootBody && /pendingSubjectChoice\s*=\s*true/.test(bootBody)
    && /sessionStorage\.getItem\("ege_login_subject_pending"\)/.test(bootBody),
  `найдено ${setTrue.length}`);
t("submitLogin найден", !!loginBody);
t("флаг включается именно в submitLogin",
  !!loginBody && /pendingSubjectChoice\s*=\s*true/.test(loginBody));
t("submitLogin дублирует флаг в sessionStorage",
  !!loginBody && /sessionStorage\.setItem\("ege_login_subject_pending"/.test(loginBody));
t("submitLogin сбрасывает чужую сессию/урок/слепок до смены",
  !!loginBody && /Session\.cur\s*=\s*null/.test(loginBody)
    && /Lesson\.cur\s*=\s*null/.test(loginBody)
    && /localStorage\.removeItem\("ege_core_session"\)/.test(loginBody));
for (const [name, body] of [["logoutAccount", logoutBody], ["revokeDeviceSession", revokeBody], ["chooseLoginSubject", chooseBody]]) {
  t(`${name} найден`, !!body);
  t(`${name} гасит флаг и sessionStorage-дубль`,
    !!body && /pendingSubjectChoice\s*=\s*false/.test(body)
      && /sessionStorage\.removeItem\("ege_login_subject_pending"\)/.test(body));
}
t("submitRegister найден", !!registerBody);
t("submitRegister не трогает флаг выбора предмета",
  !!registerBody && !/pendingSubjectChoice/.test(registerBody));
t("submitRegister не чистит сессии (тот же профиль продолжается)",
  !!registerBody && !/Session\.cur\s*=\s*null/.test(registerBody)
    && !/Lesson\.cur\s*=\s*null/.test(registerBody)
    && !/ege_core_session/.test(registerBody));
t("render уводит на выбор предмета пока флаг висит",
  /if\s*\(pendingSubjectChoice/.test(src));
t("перезагрузка посреди пикера восстанавливает флаг из sessionStorage",
  /sessionStorage\.getItem\("ege_login_subject_pending"\)/.test(src));

console.log(fails ? `\n${fails} FAILURES` : "\nALL OK");
process.exit(fails ? 1 : 0);
