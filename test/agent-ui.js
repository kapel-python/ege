/* ИИ-наставник как экран SPA (#/ai): шапка/сайдбар/тема/тосты/модалки общие,
   свой только контент чата (js/agent-spa.js + css/agent.css).
   API-контракт проверяет test/ai-agent.py, здесь — только клиентская интеграция. */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

let failures = 0;
const check = (name, cond, detail = "") => {
  if (!cond) failures += 1;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? ` | ${detail}` : ""}`);
};

const spaJs = read("js/agent-spa.js");
const spaCss = read("css/agent.css");
const appJs = read("js/app.js");
const indexHtml = read("index.html");
const agentHtml = read("agent.html");

/* --- старые отдельные файлы удалены --- */
check("нет отдельной страницы js/agent.js", !exists("js/agent.js"));
check("нет отдельного agent.css в корне", !exists("agent.css"));

/* --- проводка в SPA --- */
check("index.html тянет css/agent.css", indexHtml.includes("css/agent.css"));
check("index.html тянет js/agent-spa.js до app.js",
  indexHtml.includes("js/agent-spa.js") && indexHtml.indexOf("js/agent-spa.js") < indexHtml.indexOf("js/app.js"));
check("роут ai ведёт на screenAgent", /ai:\s*screenAgent/.test(appJs));
check("NAV: ИИ без внешнего href (без перезагрузки)",
  appJs.includes('{ route: "ai"') && !appJs.includes('href: "/agent"') && !appJs.includes("href: '/agent'"));
check("NAV: ИИ левее Профиля",
  appJs.indexOf('"ai"') > 0 && appJs.indexOf('"ai"') < appJs.indexOf('"profile"'));
check("заголовок вкладки для ai", appJs.includes('ai: "ИИ-наставник"'));
check("bottomnav включает ИИ", appJs.includes('"ai"') && appJs.includes("renderBottomNav"));

/* --- ничего своего: хром берётся у приложения --- */
const spaCode = spaJs.replace(/\/\/[^\n]*/g, "");
check("экран экспортирует screenAgent", /window\.screenAgent\s*=\s*screenAgent/.test(spaJs));
check("нет своей темы", !spaCode.includes("ege_core_theme") && !spaCode.includes("dataset.theme"));
check("нет своего топбара", !spaCode.includes("level-chip") && !spaCode.includes("streak-chip") && !spaCode.includes("renderTopContext"));
check("нет своего сайдбара навигации", !spaCode.includes("sitenav") && !spaCode.includes("bottomnav"));
check("тосты через общий toast()", spaCode.includes("toast(") && !spaCode.includes("toast-root"));
check("текст через textContent", spaCode.includes("textContent"));
check("нет innerHTML с сырыми строками",
  !/\.innerHTML\s*=\s*[^`]*\$\{/.test(spaCode) && !/\.innerHTML\s*\+=/.test(spaCode));
check("экранирование через esc()", spaCode.includes("esc("));
check("иконки через icon()", spaCode.includes("icon("));
check("модалка лимита на общей dlg-системе",
  spaCode.includes("deviceModalRoot") && spaCode.includes("dlg-backdrop") && spaCode.includes("dlg__close"));
check("модалка закрывается по Esc и возвращает фокус",
  spaCode.includes("limitEscHandler") && spaCode.includes("limitPrevFocus"));
check("бан через showAccountBlocked", spaCode.includes("showAccountBlocked"));

/* --- поведение чата (портировано из старой страницы) --- */
check("скелетоны loader", spaCode.includes("agent__loader"));
check("шаги с тогглом", spaCode.includes("agent__trace-toggle") && spaCode.includes("agent__step"));
check("раскрытие Подробнее", spaCode.includes("Подробнее"));
check("кнопки подтверждения", spaCode.includes("Применить") && spaCode.includes("Отмена")
  && spaCode.includes("needs_confirm") && spaCode.includes("confirmStep"));
check("confirm без даблклика", spaCode.includes("disabled = true"));
check("квота с plural", spaCode.includes("setQuota") && spaCode.includes("pluralQ"));
check("ноль показывает время возврата", spaCode.includes("resetInSec") && spaCode.includes("Возврат через"));
check("список тредов + Новый чат", spaCode.includes("agent__list") && spaCode.includes("Новый чат"));
check("тред из localStorage с ключом аккаунта", spaCode.includes("ege_agent_thread:"));
check("квота переживает перезагрузку", spaCode.includes("ege_agent_quota:"));
check("deep-link #/ai/<id>", spaCode.includes("routeParam") && spaCode.includes("#/ai/"));
check("смена треда не плодит историю (replaceState)", spaCode.includes("replaceState"));
check("Enter отправляет", spaCode.includes('"Enter"'));
check("Shift+Enter перенос", spaCode.includes("shiftKey"));
check("авто-рост textarea", spaCode.includes("scrollHeight"));
check("Стоп через AbortController", spaCode.includes("AbortController") && spaCode.includes("abort"));
check("один обработчик data-ask",
  (spaCode.match(/\[data-ask\]/g) || []).length === 1);
check("подсказка не фокусирует поле ввода", !spaCode.includes("input.focus") && !spaCode.includes("ui.input.focus"));
check("ошибка хода — карточка с повтором", spaCode.includes("errorCard") && spaCode.includes("Попробовать снова"));
check("повтор идёт с force (обход кэша)", spaCode.includes("force: true"));
check("скелетон снимается и при AbortError", /AbortError[\s\S]{0,200}skel\.parentNode/.test(spaCode));
check("протухший тред чистится локально", spaCode.includes("THREAD_NOT_FOUND"));
check("AGENT_BUSY показывает retryAfter", spaCode.includes("retryAfter"));
check("размонтирование гасит асинхрон (mountGen)", spaCode.includes("mountGen"));
check("смена аккаунта сбрасывает треды", spaCode.includes("Store.accountId") || spaCode.includes("Store"));

/* --- CSS скоупирован, токены общие --- */
check("CSS под .agent", spaCss.includes(".agent"));
check("без своих CSS-переменных темы", !spaCss.includes(":root"));
check("цвета/токены общие с SPA (var(--…))",
  spaCss.includes("var(--surface)") && spaCss.includes("var(--accent)") && spaCss.includes("var(--text)")
  && spaCss.includes("var(--btn-primary-bg)") && spaCss.includes("var(--danger-soft)"));
check("пузыри и шаги", spaCss.includes("agent__msg-user") && spaCss.includes("agent__step"));
check("мобильный drawer внутри экрана", spaCss.includes("nav-open"));
check("экран во всю ширину (.screen--agent из render)",
  spaCss.includes(".screen--agent") && spaCss.includes("max-width: none")
  && /classList\.toggle\("screen--agent", route === "ai"\)/.test(appJs));
check("пустой блок реально прячется ([hidden])", spaCss.includes(".agent__empty[hidden]"));
check("пустой блок прячется инлайном (без зависимости от CSS)",
  spaCode.includes('style.display = visible ? "" : "none"'));
check("шаги живого хода появляются по одному", spaCss.includes("agentRise") && spaCode.includes("reveal"));
/* Ход наставника: пустой шаг -> лоадер вырастает -> гаснет -> результат,
   потом лента сворачивается и ответ печатается по словам. */
check("шаг умеет переливаться по высоте (morph)", spaCode.includes("function morph") && spaCode.includes("stepFill"));
check("лоадер растёт в пустом шаге", spaCode.includes("agent__tbody") && spaCss.includes(".agent__tbody"));
check("лоадер гаснет перед результатом", spaCode.includes('classList.add("is-out")') && spaCss.includes(".agent__tbody.is-out"));
check("лента следует за растущим блоком (follow)", spaCode.includes("function follow") && spaCode.includes("follow("));
check("ответ печатается с курсором", spaCode.includes('classList.add("typing")') && spaCss.includes(".agent__answer.typing"));
check("сворачивание ленты после хода", spaCode.includes('classList.remove("open")') && spaCss.includes(".agent__ai.done .agent__trace-toggle"));
check("новый ход дорисовывает прерванный (bail)", spaCode.includes("pendingBail") && spaCode.includes("animGen"));
check("ход переживает размонтирование (S.turn + reattach)",
  spaCode.includes("reattachTurn") && spaCode.includes("settleTurn") && spaCode.includes("failTurn")
  && spaCode.includes("claimedBy"));
/* Клавиатура телефона: высоту держит CSS (колонка ровно в 100dvh), от focus
   требуется только освободить резерв под нижнее меню. Пин высоты в пикселях
   был причиной «поле съехало вверх и не вернулось». */
check("фокус не пинит высоту колонки в px", !spaCode.includes("lockMainHeight") && !spaCode.includes("unlockMainHeight"));
check("фокус освобождает резерв нижнего меню", spaCode.includes("--agent-bottom") && spaCode.includes("kb-open")
  && /documentElement\.style\.setProperty\("--agent-bottom"/.test(spaCode));
/* Раздел — единая поверхность без карточки: скроллится только лента, тулбар и
   композер прижаты к краям. Высоту держит flex + visualViewport, а не
   вычисленный вручную calc(100dvh - ...). */
check("карточки у области чата нет", !/box-shadow/.test(spaCss.match(/\.agent__main \{[^}]*\}/)[0])
  && !/border-radius/.test(spaCss.match(/\.agent__main \{[^}]*\}/)[0]));
check("область чата — колонка без фона", !/background/.test(spaCss.match(/\.agent__main \{[^}]*\}/)[0]));
check("тулбар и композер прижаты (flex: none)", /\.agent__toolbar \{[^}]*flex: none/.test(spaCss)
  && /\.agent__composer-zone \{[^}]*flex: none/.test(spaCss));
check("скроллится только лента", /\.agent__feed \{[^}]*overflow-y: auto/.test(spaCss));
/* Баг: на телефоне поле ввода уезжало под position:fixed нижнее меню, а верх
   упирался в край — страница скроллилась вместе с шапкой. Резерв под меню
   меряет app.js, высоту видимой области отдаёт visualViewport, страница на
   разделе агента не скроллится вовсе. */
check("резерв под фиксированное нижнее меню", spaCss.includes("var(--bottomnav-h")
  && /--bottomnav-h/.test(appJs) && /setProperty\("--bottomnav-h"/.test(appJs));
/* Колонка прижата к КРАЯМ окна, а не задана высотой: на телефоне 100dvh
   меньше layout viewport (от которого считают position:fixed), поэтому
   контейнер по высоте всегда оставался чуть выше низа экрана — и поле для
   ввода висело над нижним меню с зазором. bottom:0 привязывает низ к тому
   же краю, где стоит меню, так что зазор невозможен по построению. */
check("колонка прижата к краям окна (fixed + top/bottom, без высоты)",
  /\.app:has\(\.screen--agent\)\s*\{[^}]*position: fixed/.test(spaCss)
  && /\.app:has\(\.screen--agent\)\s*\{[^}]*bottom: var\(--agent-kb-inset, 0px\)/.test(spaCss)
  && !/height: var\(--vv-h/.test(spaCss) && !/height: var\(--agent-vh/.test(spaCss));
/* Баг: `.agent` оставался flex: 0 1 auto (по умолчанию), т.е. колонка брала
   высоту по контенту, а не по экрану. Низ экрана под ней оставался пустым, и
   поле для ввода висело над нижним меню с зазором в ~80px. Меняли резерв под
   меню (то на экране, то в композере) — не помогало, потому что расти было
   некому: резерву просто некуда было уйти. */
check("колонка агента тянется на всю высоту экрана (flex: 1)",
  /\.agent \{[^}]*flex: 1 1 auto/.test(spaCss));
/* Резерв под меню держит ЭКРАН, а не композер: колонка заканчивается ровно
   там, где начинается меню, поэтому под полем ввода нет пустой полосы.
   В композере тот же резерв был бы вторым, суммировался с экранным и снова
   отрывал поле от меню. */
check("резерв под меню на экране, а не в композере",
  /\.screen--agent \{[^}]*padding:[^;]*var\(--agent-bottom/.test(spaCss)
  && !/\.agent__composer-zone \{[^}]*bottomnav-h/.test(spaCss));
/* Единственное число от JS — насколько клавиатура перекрывает низ. */
check("отступ только на клавиатуру, с потолком и сбросом",
  /setProperty\("--agent-kb-inset"/.test(spaCode)
  && /removeProperty\("--agent-kb-inset"/.test(spaCode)
  && /Math\.min\(Math\.round\(gap\)/.test(spaCode));
check("страховка на resize/orientationchange (не только visualViewport)",
  /addEventListener\("resize", syncViewport\)/.test(spaCode)
  && /orientationchange/.test(spaCode));
/* Клавиатура меряется по visualViewport: без него (и без window.resize
   рядом) перекрытие снизу нечем было бы узнать. */
check("клавиатура меряется по visualViewport", spaCode.includes("visualViewport")
  && /visualViewport\.addEventListener\("resize"/.test(spaCode));
/* Мёртвых переменных нет: --vv-h/--agent-vh больше нигде не читаются и не
   ставятся (в коде их можно упоминать только в комментарии). */
check("нет осиротевших --vv-h/--agent-vh",
  !spaCode.includes("--vv-h") && !spaCss.includes("--vv-h") && !spaCode.includes("--agent-vh"));
/* Резерв под меню — по геометрии, а не по blur: окно лимита забирает фокус с
   поля, и blur-возврат резерва поднимал композер на всю высоту меню. */
check("blur не включает резерв под меню сам",
  !/blur[\s\S]{0,200}removeProperty\("--agent-bottom"\)/.test(spaCode)
  && spaCode.includes("settleKeyboard"));
/* Меню чата по долгому нажатию: удаление произвольного чата, а не открытого. */
check("меню чата по долгому нажатию", spaCode.includes("armLongPress") && spaCode.includes("agent__ctx"));
check("удаление произвольного чата", spaCode.includes("function deleteThread")
  && /wasCurrent/.test(spaCode));
check("меню чата закрывается по Esc и клику мимо",
  spaCode.includes("agentGlobalKey") && spaCode.includes("agentGlobalPointer")
  && /ui\.ctx = ctx/.test(spaCode) && /ui\.ctx = null/.test(spaCode));
check("drawer непрозрачный и выше нижнего меню",
  /\.agent__threads \{[^}]*background: var\(--surface\)/.test(spaCss.split("@media")[1] || "")
  && /z-index: 60/.test(spaCss.split("@media")[1] || ""));
check("страница на разделе агента не скроллится", spaCss.includes(".app:has(.screen--agent)"));
check("скроллится только лента", /\.agent__feed \{[^}]*overflow-y: auto/.test(spaCss)
  && /\.agent__toolbar \{[^}]*flex: none/.test(spaCss)
  && /\.agent__composer-zone \{[^}]*flex: none/.test(spaCss));
check("свой тред не абортит ход", spaCode.includes("Number(prev) !== Number(id)"));
check("футер скрыт на экране чата", read("js/footer.js").includes("ai: true"));

/* --- старый адрес /agent — редирект в SPA --- */
check("agent.html редиректит в SPA", agentHtml.includes("/dashboard#/ai"));
check("agent.html пробрасывает тред", agentHtml.includes("thread/"));
check("agent.html не тянет старые файлы", !agentHtml.includes("js/agent.js") && !agentHtml.includes('href="agent.css"'));

/* --- синтаксис --- */
for (const [name, src] of [["js/agent-spa.js", spaJs], ["js/app.js", appJs]]) {
  try { new vm.Script(src, { filename: name }); check(`syntax ${name}`, true); }
  catch (e) { check(`syntax ${name}`, false, String(e).slice(0, 160)); }
}

/* --- логика пустого состояния в реальной VM --- */
(function testEmptyVisible() {
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
    toast() {}, esc: (s) => String(s), icon: () => "",
    go() {}, routeParam: () => "", Store: {},
    showAccountBlocked() {}, deviceModalRoot: () => null, closeDeviceModal() {},
    fetch: async () => ({ status: 200, json: async () => ({ ok: true, threads: [] }) }),
    document: {
      documentElement: stubEl(),
      body: stubEl(),
      activeElement: null,
      createElement: () => stubEl(),
      createElementNS: () => stubEl(),
      getElementById: () => null,
      querySelector: () => stubEl(),
      querySelectorAll: () => [],
      addEventListener() {}, removeEventListener() {},
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  try {
    vm.runInNewContext(spaJs, sandbox, { filename: "js/agent-spa.js" });
    check("VM: screenAgent exported", typeof sandbox.screenAgent === "function");
    const st = sandbox.AgentScreen && sandbox.AgentScreen.state;
    check("VM: AgentScreen.state exported", !!st);
    const ev = sandbox.AgentScreen && sandbox.AgentScreen.emptyVisible;
    check("VM: emptyVisible exported", typeof ev === "function");
    if (typeof ev === "function") {
      check("VM: отправка прячет пустой блок", ev(false, true) === false && ev(false, false) === false);
      check("VM: явный показ", ev(true, true) === true);
      check("VM: авто-режим", ev(undefined, true) === false && ev(undefined, false) === true);
    }
  } catch (e) {
    check("VM: agent-spa.js стартует на стабах", false, String(e && e.message || e).slice(0, 200));
  }
})();

console.log(failures ? `\n${failures} FAILURES` : "\nALL OK");
process.exit(failures ? 1 : 0);
