/* Учебный план: фронт (профиль + предпросмотр в ИИ).
   Без сервера: статические проверки контракта по коду (js/app.js,
   js/agent-spa.js, css/subscription.css) + юнит-проверки чистых функций:
   - agent-spa.js грузится в VM (приём из test/agent-ui.js), helpers
     planProposal/planDialog вызываются напрямую;
   - чистые помощники профиля (studyPlanDaysWord/studyPlanCloseHint/
     studyPlanPick/planCardHTML) извлекаются из js/app.js как есть и
     исполняются в песочнице без DOM.
   Запуск: node test/study-plan-ui.js */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let failures = 0;
const check = (name, cond, detail = "") => {
  if (!cond) failures += 1;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? ` | ${detail}` : ""}`);
};

const spaJs = read("js/agent-spa.js");
const appJs = read("js/app.js");
const planCss = read("css/subscription.css");

/* --- синтаксис --- */
for (const [name, src] of [["js/agent-spa.js", spaJs], ["js/app.js", appJs]]) {
  try { new vm.Script(src, { filename: name }); check(`syntax ${name}`, true); }
  catch (e) { check(`syntax ${name}`, false, String(e).slice(0, 160)); }
}

/* ================= A. «Показать план» в карточке подтверждения ================= */
check("A: третья кнопка «Показать план» рядом с Применить/Отмена",
  /"Показать план"/.test(spaJs) && /btn btn--ghost btn--sm/.test(spaJs));
check("A: кнопка только в ветке needs_confirm (не трогает dropped/applied)",
  /if \(st\.status === "needs_confirm"\)[\s\S]{0,1400}Показать план/.test(spaJs)
  && !/status === "dropped"[\s\S]{0,400}Показать план/.test(spaJs));
check("A: Применить/Отмена на месте и зовут confirmStep как раньше",
  /confirmStep\(st\.id, true, \[apply, cancel\]/.test(spaJs)
  && /confirmStep\(st\.id, false, \[apply, cancel\]/.test(spaJs));
check("A: шаг определяется как plan_apply по tool и по result/proposal.action",
  /function planProposalOf\(st\)/.test(spaJs)
  && /r\.action === "plan_apply"/.test(spaJs)
  && /p\.action === "plan_apply"/.test(spaJs)
  && /st\.tool === "plan_apply"/.test(spaJs));
check("A: предпросмотр — общий openInfoDialog с eyebrow «Учебный план»",
  /openInfoDialog\(\{ eyebrow: dlg\.eyebrow, title: dlg\.title, text: dlg\.text/.test(spaJs)
  && /eyebrow: "Учебный план"/.test(spaJs));
check("A: текст диалога — горизонт, периоды, темы, урок/задания (всё через esc)",
  /planProposalDialog/.test(spaJs)
  && /esc\(line\.name\)/.test(spaJs)
  && /esc\(line\.extra\)/.test(spaJs)
  && /esc\(label\)/.test(spaJs));
check("A: своих innerHTML-вставок нет (как требует test/agent-ui.js)",
  !/\.innerHTML\s*=\s*[^`]*\$\{/.test(spaJs.replace(/\/\/[^\n]*/g, ""))
  && !/\.innerHTML\s*\+=/.test(spaJs.replace(/\/\/[^\n]*/g, "")));

/* ================= B. Блок плана в профиле ================= */
const profIdx = appJs.indexOf("function screenProfile");
check("B: div #plan-card строго над #sub-card",
  profIdx >= 0
  && appJs.indexOf('<div id="plan-card">', profIdx) > profIdx
  && appJs.indexOf('<div id="plan-card">', profIdx) < appJs.indexOf('<div id="sub-card">', profIdx));
check("B: тихий fetch при отрисовке профиля (mountPlanCard рядом с Subscription.mountCard)",
  /Subscription\.mountCard\(\); \} catch/.test(appJs)
  && /mountPlanCard\(\);/.test(appJs)
  && /ApiClient\.get\("\/api\/plan"/.test(appJs));
check("B: гостю и при ошибке сети блок не рисуется, без тостов и console",
  /if \(!accountId\) \{ box\.innerHTML = ""/.test(appJs)
  && /\.catch\(\(\) => \{[\s\S]{0,260}?live\.innerHTML = ""/.test(appJs)
  && !/mountPlanCard[\s\S]{0,60}?toast\(/.test(appJs));
check("B: активный блок — заголовок, горизонт, прогресс «закрыто X из Y», тонкий бар",
  /Учебный план/.test(appJs)
  && /закрыто \${closed} из \${total}/.test(appJs)
  && /progressBar\(pct, "progress--thin"\)/.test(appJs));
check("B: текущая тема крупно + «Перейти» в практику + «Закрыть тему»",
  /plan-card__topic/.test(appJs)
  && /onclick="askPlanTopicGo\('/.test(appJs)
  && /onclick="askPlanTopicClose\('/.test(appJs));
check("B: серой кнопке — disabled и мелкая причина (hint из closeReasons)",
  /studyPlanCloseHint\(cur\)/.test(appJs)
  && /<button class="btn btn--ghost" type="button" disabled/.test(appJs)
  && /plan-card__hint/.test(appJs));
check("B: остальные открытые — компактно, закрытые — <details>«Пройденные (N)»",
  /Дальше в этом периоде/.test(appJs)
  && /<details class="plan-card__done"><summary>Пройденные \(\${pick\.done\.length}\)/.test(appJs));
check("B: клик в details не закрывает его (кнопки — в теле, не в summary)",
  /<summary>Пройденные[^<]*<\/summary>/.test(appJs)
  && /plan-card__done-body/.test(appJs));
check("B: закрытие — общий диалог (eyebrow + «Закрыть тему») и POST close",
  /eyebrow: "Учебный план"/.test(appJs)
  && /confirmText: "Закрыть тему"/.test(appJs)
  && /ApiClient\.post\("\/api\/plan\/topics\/close", \{ skillId, subject \}\)/.test(appJs));
check("B: ответ POST сразу перерисовывает блок (второго GET нет), успех — тостом",
  /planRenderState\(res\)/.test(appJs)
  && /toast\(esc\(beforeName/.test(appJs));
check("B: 409 LOCKED — тост с текстом сервера и перерисовка",
  /code === "LOCKED" \? "lock" : "info"/.test(appJs)
  && /if \(code\) mountPlanCard\(\);/.test(appJs));
check("B: «Весь план» — все периоды/темы/статусы + «Почему сейчас эта тема»",
  /onclick="openPlanFullDialog\(\)"/.test(appJs)
  && /p\.index > active\.currentIndex/.test(appJs)
  && /Почему сейчас эта тема/.test(appJs)
  && /✓<\/span>/.test(appJs));
check("B: без плана блок пуст, lastDone — компактной строкой",
  /Прошлый план «\${esc\(res\.lastDone\.title\)}» — выполнен/.test(appJs));
check("B: данные через esc, сырых вставок нет",
  /esc\(active\.title/.test(appJs) && /esc\(cur\.name/.test(appJs)
  && /esc\(hint\)/.test(appJs) && /esc\(msg\)/.test(appJs));
check("B: стили рядом со стилями #sub-card (css/subscription.css)",
  /\.plan-card \{/.test(planCss) && /\.plan-card__mark \{/.test(planCss));
check("B: кнопки ≥44px, строки ≥48px, телефон 390px влезает",
  /\.plan-card \.btn \{ min-height: 44px/.test(planCss)
  && /min-height: 48px/.test(planCss)
  && /@media \(max-width: 480px\)[\s\S]*?\.plan-card__actions \.btn/.test(planCss));
check("B: prefers-reduced-motion уважается",
  /prefers-reduced-motion: reduce\) \{\s*\n\s*\.plan-card \.progress__fill \{ transition: none/.test(planCss));
check("B: нет новых глобальных классов с общими именами",
  !/^\.(card|btn|progress|chip)\s*\{/m.test(planCss));

/* ================= юнит: agent-spa helpers в VM ================= */
const escReal = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let agentBox = null;
(function loadSpa() {
  const stubEl = () => ({
    children: [], childNodes: [], style: {}, dataset: {}, attributes: {},
    textContent: "", hidden: false, disabled: false, value: "",
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, getAttribute() { return null; },
    addEventListener() {}, removeEventListener() {},
    appendChild(c) { return c; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, focus() {},
    scrollTo() {}, scrollHeight: 0, scrollTop: 0, clientHeight: 0,
  });
  const store = new Map();
  const opened = [];
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {} },
    setTimeout: () => 0, clearTimeout() {},
    setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 0,
    matchMedia: () => ({ matches: false }),
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    location: { hash: "", search: "", href: "http://localhost/dashboard" },
    history: { replaceState() {} },
    navigator: {},
    toast() {}, esc: escReal, icon: () => "",
    go() {}, routeParam: () => "", Store: {},
    showAccountBlocked() {}, deviceModalRoot: () => null, closeDeviceModal() {},
    openInfoDialog: (o) => { opened.push(o); },
    openConfirmDialog() {}, openAiLimitModal() {},
    plural: (n, one, few) => (n % 10 === 1 && n % 100 !== 11 ? one : few),
    fetch: async () => ({ status: 200, json: async () => ({ ok: true, threads: [] }) }),
    document: {
      documentElement: stubEl(), body: stubEl(), activeElement: null,
      createElement: () => stubEl(), createElementNS: () => stubEl(),
      getElementById: () => null, querySelector: () => stubEl(),
      querySelectorAll: () => [], addEventListener() {}, removeEventListener() {},
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  try {
    vm.runInNewContext(spaJs, sandbox, { filename: "js/agent-spa.js" });
    agentBox = { AgentScreen: sandbox.AgentScreen, opened };
  } catch (e) {
    check("VM: agent-spa.js стартует на стабах", false, String((e && e.message) || e).slice(0, 200));
  }
})();
if (agentBox && agentBox.AgentScreen) {
  const { planProposal, planDialog, pendingStepState } = agentBox.AgentScreen;
  check("VM: planProposal/planDialog экспортированы", typeof planProposal === "function" && typeof planDialog === "function");
  const liveStep = { tool: "plan_apply", status: "needs_confirm",
    proposal: { action: "plan_apply", days: 7, title: "План на 7 дней", periods: [] } };
  const histStep = { tool: "plan_apply", status: "needs_confirm",
    result: { action: "plan_apply", days: 7, title: "План на 7 дней", periods: [] } };
  check("VM: живой шаг (proposal) распознаётся",
    planProposal(liveStep) && planProposal(liveStep).title === "План на 7 дней");
  check("VM: шаг истории (result) распознаётся",
    planProposal(histStep) && planProposal(histStep).days === 7);
  check("VM: чужой шаг (update_profile) — null",
    planProposal({ tool: "update_profile", result: { action: "x" } }) === null
    && planProposal(null) === null && planProposal({}) === null);
  // Живой баг: ход, вставший на подтверждение, переписывал ВСЕ шаги в
  // needs_confirm — карточка черновика (read/done) получала кнопки
  // «Применить/Отмена». Статус сервера теперь уважается как есть.
  check("VM: pendingStepState экспортирован", typeof pendingStepState === "function");
  if (typeof pendingStepState === "function") {
    check("VM: done-шаг остаётся done (без кнопок)",
      pendingStepState({ tool: "plan_draft", kind: "read", status: "done" }) === "done");
    check("VM: needs_confirm-шаг остаётся needs_confirm",
      pendingStepState({ tool: "plan_apply", kind: "action", status: "needs_confirm" }) === "needs_confirm");
    check("VM: без статуса — старое поведение (needs_confirm)",
      pendingStepState({ tool: "plan_apply" }) === "needs_confirm"
      && pendingStepState({}) === "needs_confirm" && pendingStepState(null) === "needs_confirm");
  }
  check("SRC: settleTurn маппит через pendingStepState, а не захардкоженный статус",
    /status:\s*pendingStepState\(s\)/.test(spaJs)
    && !/status:\s*"needs_confirm", proposal: s\.proposal/.test(spaJs));
  const evil = {
    action: "plan_apply", days: 7, title: "План <b>на</b> 7 дней & друзей",
    periods: [
      { index: 0, label: "Неделя 1 <script>", days: 7, topics: [
        { skillId: "n09_derivative", name: "Производная <img src=x onerror=1>", lessonId: "les1", taskIds: ["n09_p1", "n09_p2"] },
        { skillId: "n10_limit", name: "Предел", lessonId: null, taskIds: [] },
      ], topicIds: ["n09_derivative", "n10_limit"] },
    ],
  };
  const dlg = planDialog(evil);
  check("VM: диалог — eyebrow и title предложения",
    dlg.eyebrow === "Учебный план" && dlg.title === "План <b>на</b> 7 дней & друзей");
  check("VM: горизонт со склонением", /7 дней/.test(dlg.text));
  check("VM: периоды и темы поименно, урок/число заданий",
    /Неделя 1/.test(dlg.text) && /Производная/.test(dlg.text)
    && /урок · 2 задания/.test(dlg.text) && /без урока · 0 заданий/.test(dlg.text));
  check("VM: модельные строки экранированы (XSS)",
    !/<script>/.test(dlg.text) && !/<img/.test(dlg.text)
    && /&lt;script&gt;/.test(dlg.text) && /&lt;img/.test(dlg.text));
  // Заголовок едет сырым в поле title — его esc'ит сам openInfoDialog
  // (aria-label и dlg-device__name), как у всех остальных диалогов.
  check("VM: title — сырым в поле title (esc — дело openInfoDialog)",
    dlg.title === "План <b>на</b> 7 дней & друзей"
    && appJs.includes('<div class="dlg-device__name">${esc(title)}</div>'));
  for (const [days, word] of [[1, "1 день"], [2, "2 дня"], [5, "5 дней"], [7, "7 дней"], [11, "11 дней"], [21, "21 день"], [14, "14 дней"]]) {
    const t = planDialog({ action: "plan_apply", days, title: "П", periods: [] }).text;
    check(`VM: склонение дней (${days})`, t.includes(word), t.slice(0, 80));
  }
}

/* ================= юнит: чистые помощники профиля из js/app.js ================= */
function extractFn(src, name) {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error("нет функции " + name);
  let i = src.indexOf("{", start);
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error("не закрыта " + name);
}
let P = null;
try {
  const names = ["studyPlanDaysWord", "studyPlanTopicsWord", "studyPlanFmtDate",
    "studyPlanCloseHint", "studyPlanPick", "planPeriodLocked", "planGoChoice",
    "studyPlanPeriodEnd", "planRowHTML", "planLockedRowHTML", "planCardHTML"];
  const bundle = names.map((n) => extractFn(appJs, n)).join("\n");
  new vm.Script(bundle, { filename: "study-plan-pure.js" });
  const sandbox = {
    esc: escReal, icon: () => "", progressBar: (pct) => `<div class="progress"><div style="width:${pct}%"></div></div>`,
    console,
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(bundle + "\nglobalThis.__P = { studyPlanDaysWord, studyPlanTopicsWord, studyPlanFmtDate, studyPlanCloseHint, studyPlanPick, planPeriodLocked, planGoChoice, studyPlanPeriodEnd, planCardHTML, planLockedRowHTML };", sandbox);
  P = sandbox.__P;
  check("чистые функции профиля извлекаются и компилируются", true);
} catch (e) {
  check("чистые функции профиля извлекаются и компилируются", false, String((e && e.message) || e).slice(0, 200));
}
if (P) {
  for (const [n, want] of [[1, "день"], [2, "дня"], [4, "дня"], [5, "дней"], [7, "дней"],
      [11, "дней"], [12, "дней"], [14, "дней"], [21, "день"], [22, "дня"], [25, "дней"], [111, "дней"]]) {
    check(`дни: ${n} → ${want}`, P.studyPlanDaysWord(n) === want, P.studyPlanDaysWord(n));
  }
  for (const [n, want] of [[1, "тема"], [2, "темы"], [5, "тем"], [11, "тем"], [21, "тема"]]) {
    check(`темы: ${n} → ${want}`, P.studyPlanTopicsWord(n) === want, P.studyPlanTopicsWord(n));
  }
  check("closeHint: рано и не освоено — обе части",
    (() => { const h = P.studyPlanCloseHint({ closeable: false, closeReasons: [], availableAt: 1791604800000, mastery: 42 });
      return /Откроется .+ · /.test(h) && /освой тему — сейчас 42%/.test(h); })(),
    P.studyPlanCloseHint({ closeable: false, closeReasons: [], availableAt: 1791604800000, mastery: 42 }));
  check("closeHint: непройденный урок — первый и с бонусом",
    (() => { const h = P.studyPlanCloseHint({ closeable: false, closeReasons: [], availableAt: 1791604800000,
        mastery: 42, lessonId: "les1", lessonDone: false, lessonBonus: 40 });
      return h.indexOf("Пройди урок — сразу +40% · откроется ") === 0
        && /освой тему — сейчас 42%$/.test(h); })());
  check("closeHint: срок вышел, но не освоено — только освоение",
    P.studyPlanCloseHint({ closeable: false, closeReasons: ["time"], availableAt: 1, mastery: 10 }) === "Освой тему — сейчас 10%");
  check("closeHint: освоено, но рано — только дата",
    /^Откроется /.test(P.studyPlanCloseHint({ closeable: false, closeReasons: ["mastered"], availableAt: 1791604800000, mastery: 90 })));
  check("closeHint: закрываемой теме подсказки нет",
    P.studyPlanCloseHint({ closeable: true, closeReasons: ["time", "mastered"], mastery: 90 }) === "");
  const sample = (over = {}) => Object.assign({
    planId: 1, title: "План на 7 дней", days: 7, daysLabel: "7 дней",
    periods: [
      { index: 0, label: "Неделя 1", days: 7, topics: [
        { skillId: "n09_derivative", name: "Производная", lessonId: "les1", taskIds: ["n09_p1", "n09_p2"],
          state: "open", mastery: 42, mastered: false, closeable: false, closeReasons: [], availableAt: 1791604800000, allotDays: 4 },
        { skillId: "n10_limit", name: "Предел", lessonId: "les2", taskIds: ["n10_p1"],
          state: "open", mastery: 80, mastered: true, closeable: true, closeReasons: ["time", "mastered"], availableAt: 1, allotDays: 4 },
      ] },
      { index: 1, label: "Неделя 2", days: 7, topics: [
        { skillId: "n11_int", name: "Интеграл", lessonId: null, taskIds: [],
          state: "done", mastery: 95, mastered: true, closeable: false, closeReasons: [], availableAt: 1, allotDays: 7 },
      ] },
    ],
    currentIndex: 0, progress: { closed: 1, total: 3 }, completed: false,
  }, over);
  const pick = P.studyPlanPick(sample());
  check("pick: текущий период и первая открытая тема",
    pick && pick.period.label === "Неделя 1" && pick.current.skillId === "n09_derivative");
  check("pick: остальные открытые отдельно, закрытые — все",
    pick && pick.rest.length === 1 && pick.rest[0].skillId === "n10_limit"
    && pick.done.length === 1 && pick.done[0].skillId === "n11_int");
  check("pick: запасной путь без currentIndex — первый период с открытыми",
    (() => { const p = P.studyPlanPick(sample({ currentIndex: 99 })); return p && p.period.index === 0; })());
  check("pick: всё закрыто — null",
    P.studyPlanPick(sample({ currentIndex: null, periods: [{ index: 0, label: "Н", days: 7,
      topics: [{ skillId: "a", name: "А", state: "done" }] }] })) === null);
  const html = P.planCardHTML({ ok: true, subject: "profile_math", active: sample(), lastDone: null });
  check("card: заголовок, горизонт, прогресс",
    html.includes("План на 7 дней") && html.includes("7 дней") && html.includes("закрыто 1 из 3"));
  check("card: текущая тема крупно + Перейти + серая Закрыть с hint",
    html.includes("Производная") && html.includes("Освоение — 42%")
    && html.includes("askPlanTopicGo('n09_derivative')")
    && /<button class="btn btn--ghost" type="button" disabled/.test(html)
    && /plan-card__hint/.test(html) && /Откроется/.test(html));
  check("card: остальные открытые компактно, закрытые в details",
    html.includes("Дальше в этом периоде") && html.includes("Предел")
    && /<summary>Пройденные \(1\)<\/summary>/.test(html) && html.includes("Интеграл"));
  check("card: «Весь план» на месте", html.includes("openPlanFullDialog()"));
  check("card: дальше в периоде — серые строки с модалкой, не практика",
    html.includes("plan-card__row--locked") && html.includes("openPlanLockedDialog(")
    && !html.includes("Дальше в этом периоде</div><button class=\"plan-card__row\" type"));
  check("modal: разделители периодов и широкая модалка",
    /plan-dlg-period/.test(appJs) && /dlg--wide/.test(appJs) && /wide: true/.test(appJs));
  check("modal: чип «сейчас» только в текущем периоде",
    /p\.index === pick\.period\.index/.test(appJs));
  check("profile: предзагрузка подписки и плана до отрисовки",
    /route === "profile"/.test(appJs) && /Subscription\.prefetch\(\)/.test(appJs)
    && /planPrefetch\(\)/.test(appJs) && /Promise\.allSettled/.test(appJs));
  check("lock: серверный флаг бьёт индекс",
    P.planPeriodLocked({ currentIndex: 5 }, { index: 0, locked: true }) === true
    && P.planPeriodLocked({ currentIndex: 0 }, { index: 3, locked: false }) === false);
  check("lock: без флага — старый фолбэк по индексу",
    P.planPeriodLocked({ currentIndex: 0 }, { index: 1 }) === true
    && P.planPeriodLocked({ currentIndex: 1 }, { index: 1 }) === false);
  check("go: оба раздела → both, один → своё",
    P.planGoChoice({ lessonId: "l", taskIds: ["t"] }) === "both"
    && P.planGoChoice({ lessonId: "l", taskIds: [] }) === "theory"
    && P.planGoChoice({ taskIds: ["t"] }) === "practice"
    && P.planGoChoice({}) === "practice");
  check("periodEnd: конец считается от startsAt",
    P.studyPlanPeriodEnd({ startsAt: 1000000000000, periods: [{ index: 0, days: 7 }, { index: 1, days: 7 }] }, 1)
      === 1000000000000 + 14 * 86400000
    && P.studyPlanPeriodEnd(null, 0) === null);
  check("card: XSS в названии экранирован",
    P.planCardHTML({ ok: true, active: sample({ title: "<script>alert(1)</script>" }), lastDone: null })
      .includes("&lt;script&gt;"));
  const htmlOpen = P.planCardHTML({ ok: true, subject: "profile_math",
    active: sample({ periods: [Object.assign({}, sample().periods[0], { topics: [Object.assign({},
      sample().periods[0].topics[1], { skillId: "n10_limit" })] })] }), lastDone: null });
  check("card: закрываемая тема — активная кнопка без disabled",
    /onclick="askPlanTopicClose\('n10_limit'\)"/.test(htmlOpen)
    && !/<button class="btn btn--ghost" type="button" disabled/.test(htmlOpen));
  check("card: lastDone — компактная строка",
    P.planCardHTML({ ok: true, subject: "profile_math", active: null, lastDone: { title: "План на 7 дней", days: 7 } })
      .includes("Прошлый план «План на 7 дней» — выполнен"));
  check("card: без плана и без lastDone — пусто",
    P.planCardHTML({ ok: true, subject: "profile_math", active: null, lastDone: null }) === ""
    && P.planCardHTML(null) === "");
}

console.log(failures ? `\n${failures} FAILURES` : "\nALL OK");
process.exit(failures ? 1 : 0);
