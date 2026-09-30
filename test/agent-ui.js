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
/* Подсказки ([data-ask]) отправляются без фокуса поля. Исключение — меню
   сообщения «Изменить и отправить»: там фокус сознательный, человек правит
   текст руками. Поэтому смотрим только на обработчик подсказок. */
check("подсказка не фокусирует поле ввода",
  !/data-ask[\s\S]{0,200}?\.focus\(/.test(spaCode));
check("ошибка хода — карточка с повтором", spaCode.includes("errorCard") && spaCode.includes("Попробовать снова"));
check("повтор идёт с force (обход кэша)", spaCode.includes("force: true"));
check("скелетон снимается и при AbortError", /AbortError[\s\S]{0,200}skel\.parentNode/.test(spaCode));
check("протухший тред чистится локально", spaCode.includes("THREAD_NOT_FOUND"));
check("AGENT_BUSY показывает retryAfter", spaCode.includes("retryAfter"));
/* Отказоустойчивость хода. Три места, где человек раньше упирался в стену:
   1) AGENT_BUSY был тупиком — кнопка повтора до освобождения слота давала тот
      же 400; теперь ждём retryAfter и повторяем сами (текст тот же — сервер
      отдаст кэш без жетона);
   2) повтор не должен спрашивать заново, если сервер УЖЕ посчитал ответ
      (после «Стоп» он считает ход до конца) — сперва спрашиваем тред;
   3) окно подхвата хода было 120 с, а серверский ход живёт до 90 с цикла плюс
      вызов финала: ответ приходил в обработчики прошлого монтажа и пропадал. */
check("AGENT_BUSY не тупик: повтор сам, по времени от сервера",
  spaCode.includes("retryWhenFree") && /retryWhenFree\(text, Math\.max/.test(spaCode)
  && spaCode.includes("повторю через"));
check("повтор не дублирует уже посчитанный ответ", spaCode.includes("turnAnswered"));
check("окно подхвата хода шире потолка хода на сервере",
  /REATTACH_MS = 300000/.test(spaCode) && !/startedAt > 120000/.test(spaCode));
check("после обрыва дожидаемся ответа, а не обновляемся вслепую",
  spaCode.includes("watchAnswer") && spaCode.includes("WATCH_TRIES")
  && !/setTimeout\(function \(\) \{ if \(!S\.busy/.test(spaCode));
check("размонтирование гасит асинхрон (mountGen)", spaCode.includes("mountGen"));
check("смена аккаунта сбрасывает треды", spaCode.includes("Store.accountId") || spaCode.includes("Store"));

/* --- CSS скоупирован, токены общие --- */
check("CSS под .agent", spaCss.includes(".agent"));
/* Своей темы у раздела нет и после правки читаемости: глобальные токены
   дизайн-системы он не заводит. Реагирует он на ТОТ ЖЕ data-theme, что и весь
   сайт, но переопределяет только свои --agent-ink-* внутри .agent. */
check("без своих глобальных токенов темы",
  !/:root\s*\{[^}]*--(bg|bg-2|text|text-2|muted|surface|surface-2|surface-3|accent|border|shadow)\s*:/.test(spaCss));
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
/* Ответ печатается приёмом лендинга ([data-type] в main.html, режим fade):
   слова проявляются на месте. Первая версия была по режиму mask (слово
   выезжает из-под обрезающей маски) и с курсором — маска резала глифы, а
   курсор вставал отдельной строкой под текстом и скакал высотой абзаца
   (экран дёргался в начале и в конце печати). */
check("ответ печатается по словам (buildTyped + printPara)",
  spaCode.includes("printPara") && spaCode.includes("buildTyped")
  && !spaCode.includes("agent__caret") && !spaCode.includes("agent__wm"));
check("markdown режется на блоки верхнего уровня (пустое будущее — один абзац)",
  /tmp\.childNodes/.test(spaCode) && /box\.appendChild\(node\)/.test(spaCode)
  && !/box\.innerHTML = html;\s*\n\s*return \[box\];/.test(spaCode));
check("markdown ответа — библиотеками (marked + DOMPurify), innerHTML только после санитайза",
  spaCode.includes("marked.parse") && spaCode.includes("DOMPurify.sanitize")
  && /\.innerHTML = html/.test(spaCode) && spaCode.includes('html = window.DOMPurify')
  && /vendor\/md\/marked\.min\.js/.test(indexHtml) && /vendor\/md\/purify\.min\.js/.test(indexHtml)
  && /\.agent__md strong/.test(spaCss));
/* Копирование ответа: Clipboard API + запасной путь execCommand (http/старые
   браузеры), тот же приём, что в app.js. */
check("копирование через Clipboard API с запасным путём",
  spaCode.includes("navigator.clipboard") && spaCode.includes("writeText")
  && spaCode.includes("execCommand") && spaCode.includes("isSecureContext"));
/* Меню по клику на сообщение: своё — скопировать/изменить/повторить,
   ответ — скопировать/повторить. Ответ копируется сырым markdown
   (data-answer), а не textContent отрендеренного HTML. */
check("меню сообщения по ДОЛГОМУ нажатию (pointerdown+500мс), не по клику",
  /ui\.feed\.addEventListener\("pointerdown"[\s\S]{0,900}?setTimeout\([\s\S]{0,300}?msgMenuFor/.test(spaCode)
  && spaCode.includes("contextmenu") && !/ui\.feed\.addEventListener\("click"[\s\S]{0,120}?msgMenuFor/.test(spaCode));
check("перегенерировать/изменить только у последней пары, копирование сырого markdown",
  spaCode.includes("openMsgMenu") && spaCode.includes("msgMenuFor")
  && spaCode.includes("agent__msg-user, .agent__answer")
  && spaCode.includes('card.setAttribute("data-answer"')
  && spaCode.includes("card.dataset.answer") && /\.agent__msgmenu\b/.test(spaCss));
check("действие только у последнего сообщения (lastUserBubble/lastAssistantCard/isLast)",
  spaCode.includes("lastUserBubble") && spaCode.includes("lastAssistantCard")
  && /var isLast =/.test(spaCode) && /if \(isLast\)/.test(spaCode));
check("перегенерировать и изменить идут через replaceLast (замена, не дубль)",
  /regenerate/.test(spaCode) && /replaceLast: true/.test(spaCode)
  && /payload\.replaceLast = true/.test(spaCode)
  && /if \(replaceLast\)/.test(spaCode));
check("заменяющий ход на неуспехе перечитывает ленту (turn.replaceLast)",
  /if \(turn\.replaceLast\) loadThreadMessages\(\)/.test(spaCode));
/* Черновик ученика: одна строка localStorage на аккаунт, переживает
   перезагрузку и смену чата; чистится при отправке. */
check("черновик ученика живёт в localStorage по аккаунту",
  spaCode.includes("ege_agent_draft:") && spaCode.includes("saveDraft")
  && spaCode.includes("restoreDraft") && /restoreDraft\(\);/.test(spaCode)
  && /localStorage\.removeItem\(draftKey\(\)\)/.test(spaCode));
check("слово печати проявляется, не выезжая из-под маски",
  /\.agent__ww \{[^}]*opacity: 0[^}]*transform: translateY\(3px\)/.test(spaCss)
  && /\.agent__ww\.is-in \{[^}]*opacity: 1/.test(spaCss)
  && !spaCss.includes("agent__wm") && !spaCss.includes("agent__caret"));
check("в печати ничего не меняет раскладку (нет курсора и высоты)",
  !/height:\s*1em/.test(spaCss.match(/\.agent__ww[\s\S]*?\}/)[0] || true)
  && !spaCode.includes("insertBefore(caret"));
check("текст не переписывается по кадрам (нет textContent в цикле печати)",
  !/textContent = words\.slice/.test(spaCode) && !/words\.slice\(0, n\)/.test(spaCode));
check("короткий ход тоже печатается", /if \(built\) \{[\s\S]{0,120}revealTurn/.test(spaCode)
  && /printPara\(p, alive/.test(spaCode));
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

/* --- загрузка и кэш раздела ---
   Три требования к первому входу и возврату: экранная анимация приложения
   держится до чата, пустой блок не показывается «на всякий случай», а на
   возврат в раздел данные приходят из кэша, а сеть только сверяет их. */
check("экранная анимация приложения, а не свой лоадер",
  spaCode.includes("loaderHTML") && spaCode.includes("function screenLoader")
  && spaCode.includes('screenLoader("Открываем чаты…")')
  && spaCode.includes('feedLoader("Читаем переписку…")'));
check("каркас строится после ответа списка, а не до",
  /screenLoader\("Открываем чаты…"\);\s*\n\s*loadThreads\(function first/.test(spaCode)
  && spaCode.includes("function mountFrame")
  && /if \(cacheHasThreads\(\)\) \{[\s\S]{0,80}mountFrame\(\);\s*\n\s*loadThreads\(\);/.test(spaCode));
check("пустой блок не показывается на всякий случай",
  !/renderCachedQuota\(\);\s*\n\s*syncInput\(\);\s*\n\s*syncViewport\(\);\s*\n\s*showEmpty\(true\)/.test(spaCode)
  && spaCode.includes("function paintMessages")
  && (spaCode.match(/showEmpty\(true\)/g) || []).length === 3);   // только по факту: пустое сообщение / нет чата / чат удалён
check("кэш раздела: список и переписка, привязан к аккаунту",
  spaCode.includes("cacheHasThreads") && spaCode.includes("cachedMessages")
  && spaCode.includes("cacheDrop") && spaCode.includes("MAX_CACHED_THREADS")
  && /acc !== S\.accountId[\s\S]{0,220}cacheDrop\(\)/.test(spaCode));
check("кэш рисуется сразу, сеть только сверяет (sameMessages не даёт лишней перерисовки)",
  spaCode.includes("sameMessages") && /if \(cached\) paintMessages\(cached\)/.test(spaCode)
  && /if \(!sameMessages\(cached, msgs\)\) paintMessages\(msgs\)/.test(spaCode));
check("изменившийся тред выбрасывается из кэша (ход, confirm, удаление)",
  (spaCode.match(/cacheForget\(/g) || []).length >= 4);
check("свой лоадер раздела не заведён — стили общие",
  spaCss.includes(".agent__boot") && !/ege-loader\s*\{[^}]*@keyframes/.test(spaCss));
/* Ширина общей анимации загрузки задана явно. Иначе на экране агента карточка
   прыгала: #screen здесь flex-колонка (.screen--agent), а предмет с auto-margin
   по кросс-оси не растягивается (align-self: stretch не действует) — бокс
   становился shrink-to-fit, то есть 155px вместо 340px, и подпись переносилась
   (замер: 340 → 155 → 340 за один вход в раздел). */
const loaderDecl = (read("css/styles.css").replace(/\/\*[\s\S]*?\*\//g, "")
  .match(/(?:^|\})\s*\.ege-loader\s*\{([^}]*)\}/) || [, ""])[1];
check("анимация загрузки не схлопывается в flex-экране (width: 100% + max-width: 340px)",
  /(^|;)\s*width:\s*100%/.test(loaderDecl) && /max-width:\s*340px/.test(loaderDecl)
  && /\.screen--agent \{[^}]*display: flex; flex-direction: column/.test(spaCss),
  loaderDecl.trim());

/* --- паритет с эталоном agent_preview.html ---
   Эталон — источник правды по вёрстке раздела: ритм ленты, ширина колонки,
   карточка поля с тенью, зелёная галочка шага, рейл с кнопкой во всю
   ширину. Расхождения с ним и были жалобой («галочка серая», «не так
   красиво»), поэтому они зафиксированы проверками. */
const previewCss = read("agent_preview.html").match(/<style>([\s\S]*?)<\/style>/)[1];
const norm = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
const previewN = norm(previewCss);
const rule = (css, sel) => {
  const m = norm(css).match(new RegExp("(?:^|\\})\\s*" + sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}"));
  return m ? m[1] : "";
};
const prop = (decl, name) => (decl.match(new RegExp("(?:^|;)\\s*" + name + ":([^;]*)")) || [, ""])[1].trim();
check("галочка шага зелёная и для чтения (как в эталоне)",
  !/\.agent__mark\.is-read/.test(spaCss) && /\.agent__mark \{[^}]*--success-soft/.test(spaCss)
  && /--success-ink/.test(rule(previewCss, ".tmark")), rule(spaCss, ".agent__mark"));
check("лента: отступы и ширина колонки как в эталоне",
  /\d+px 28px/.test(rule(spaCss, ".agent__feed")) && prop(rule(spaCss, ".agent__feed-inner"), "max-width") === "760px",
  rule(spaCss, ".agent__feed") + " | " + prop(rule(spaCss, ".agent__feed-inner"), "max-width"));
check("поле ввода — карточка 760px с тенью, зона с подложкой шапки",
  prop(rule(spaCss, ".agent__composer"), "max-width") === "760px"
  && prop(rule(spaCss, ".agent__composer"), "box-shadow") === "var(--card-shadow)"
  && prop(rule(spaCss, ".agent__composer-zone"), "background") === "var(--chrome-bg)"
  && /blur\(10px\)/.test(rule(spaCss, ".agent__composer-zone")));
check("рейл: заголовок своей строкой, «Новый чат» во всю ширину",
  /\.agent__threads-head \.section-title \{[^}]*margin: 0/.test(spaCss)
  && prop(rule(spaCss, ".agent__new"), "width") === "100%"
  && spaCode.includes("side.appendChild(newBtn)"));
check("у подсказок разные значки (эталон: галочка и вопрос)",
  spaCode.includes("ICON_TASKS") && spaCode.includes("ICON_HELP")
  && /\.agent__qr svg \{[^}]*var\(--accent-ink\)/.test(spaCss));
check("у карточек подсказок свои значки",
  /"Разберу твои решения по теме", "errors"/.test(spaCode)
  && /"Соберу задания под твой уровень", "compass"/.test(spaCode));

/* --- кнопки-продолжения под ответом ---
   Кнопки — это слова модели, а не форма: сервер режет служебный блок
   ```suggest и отдаёт готовые {label, ask} (label — любой текст, хоть
   «я умный»), ask — сам вопрос, он и уходит на сервер. Шаблонных подстановок
   нет нигде: нет блока — нет кнопок. Нажатие убирает кнопку (соседние уезжают
   на её место), фокус снимается руками. */
check("кнопки берутся из ответа сервера (suggests), а не из заглушек",
  spaCode.includes("normalizeSuggests") && spaCode.includes("res.data.suggests")
  && !spaCode.includes('"Хочу разбор"')
  && !/data-ask[\s\S]{0,80}"Разбери подробнее"/.test(spaCode));
check("шаблонных кнопок нет: ни запасника, ни подстановки по шагам",
  !spaCode.includes("SUGGEST_FALLBACK") && !spaCode.includes("suggestsFromSteps")
  && !spaCode.includes("FALLBACK_SUGGESTIONS") && !spaCode.includes("DEFAULT_SUGGESTIONS")
  && !spaCode.includes("default_suggestions"));
check("история показывает сохранённые кнопки модели (suggests из базы)",
  /var lastAnswer = -1;/.test(spaCode)
  && /flushSteps\(m\.content, m\.suggests\)/.test(spaCode)
  && /assistantCard\(g\.steps, g\.final, false, i === lastAnswer \? g\.suggests : \[\]\)/.test(spaCode));
/* --- порядок истории строго по ленте: раньше пузыри пользователя рисовались
   сразу по ходу цикла, а карточки ответов — пачкой после него, и при N ходах
   все вопросы сбивались в кучу наверх, а все ответы — вниз (живой баг:
   UUU…AAA… вместо UAUA…). Теперь группы идут в порядке сообщений из базы. */
check("история рисуется строго по порядку (вопросы не сбиваются наверх)",
  /groups\.push\(\{ kind: "answer"/.test(spaCode)
  && /groups\.push\(\{ kind: "user", text:/.test(spaCode)
  && /groups\.forEach\(function \(g, i\) \{[\s\S]{0,120}?if \(g\.kind === "user"\) userBubble/.test(spaCode)
  && !/msgs\.forEach\(function \(m\) \{[\s\S]{0,200}?userBubble\(m\.content/.test(spaCode));
/* --- открытие переписки встаёт в самый низ: раньше доводка была плавной и на
   длинной истории не доезжала (замер на прод-треде из 90 строк: dist=674px,
   «Скопировать» на 650px ниже края), а звали её ещё и на каждый пузырёк и
   карточку — анимация начиналась заново десятки раз. Теперь история рисуется
   молча, а низ держится settleBottom (мгновенный progWrite, пока лента не
   перестанет расти). */
check("открытие истории: рисуем молча, вниз — один раз, мгновенно",
  /var painting = false;/.test(spaCode)
  && /function userBubble\(text\)[\s\S]{0,220}?if \(!painting\) scrollDown\(true, true\);/.test(spaCode)
  && /function paintMessages\(msgs\) \{\s*painting = true;/.test(spaCode)
  && /painting = false;\s*showEmpty\(false\);\s*(?:\/\/[^\n]*\n\s*)*settleBottom\(\);/.test(spaCode)
  && /function settleBottom\(\)/.test(spaCode)
  && /progWrite\(ui\.feed\.scrollHeight\)/.test(spaCode)
  && /S\.follow && S\.stick && !S\.busy && dist\(\) > 1/.test(spaCode));
check("карточка истории не дёргает ленту плавным скроллом",
  !/if \(!animate\) \{[\s\S]{0,700}?scrollDown\(true, true\);\s*\}/.test(spaCode));
check("нет списка — нет кнопок (без дежурного набора)",
  /var asks = normalizeSuggests\(suggests\);\s*if \(built\) built\.suggests = asks;/.test(spaCode));
check("история с шагами тоже получает кнопки (раньше эта ветка их не рисовала)",
  /classList\.add\("done"\);\s*\}\);[\s\S]{0,220}?cardFooter\(card, null, asks\)/.test(spaJs));
check("нажатие убирает кнопку и сдвигает соседние",
  spaCode.includes("collapseAsk") && /is-gone/.test(spaCss)
  && /\.agent__qr\.is-gone \{[^}]*overflow: hidden/.test(spaCss)
  && /\.agent__qr\.is-gone \{[^}]*width/.test(spaCss));
check("фокус с кнопки снимается (обводка не остаётся висеть)",
  /b\.blur\(\)/.test(spaCode) && /\.agent__qr:focus \{ outline: none/.test(spaCss)
  && /\.agent__qr:focus-visible \{[^}]*outline: 2px solid/.test(spaCss));
check("кнопка не исчезает впустую, пока идёт ход",
  /b\.addEventListener\("click", function \(\) \{[^}]*if \(S\.busy\) return;[^}]*blur\(\)/.test(spaJs));

/* --- копирование ответа: своей кнопкой под ответом, а не в меню по
   удержанию. На телефоне меню надо дождаться, а кнопку видно сразу. --- */
check("кнопка «Скопировать» под ответом (все ответы, включая историю)",
  spaCode.includes("function addCopyRow") && spaCode.includes("agent__copy-row")
  && /var row = quickActions\(card, isAlive, asks\);\s*addCopyRow\(card\);/.test(spaCode)
  && /\.agent__copy \{[^}]*min-height: 36px/.test(spaCss));
check("копируется сырой markdown ответа (data-answer), кнопка подтверждает сама",
  /function addCopyRow\(card\) \{[^}]*answerText\(card\)/.test(spaJs)
  && spaCode.includes('lbl.textContent = "Скопировано"')
  && /\.agent__copy\.is-done/.test(spaCss));
check("в меню по удержанию копирование осталось только у СВОЕГО вопроса",
  /if \(isUser\) items\.push\(\{ label: "Скопировать"/.test(spaJs)
  && /if \(!items\.length\) return;/.test(spaJs));

/* --- блокировка композера держится до конца ВИДИМОГО хода ---
   Ответ приходит из сети целиком, а печать идёт ещё секунды: раньше флаг
   снимался по приходу ответа, и второе сообщение можно было отправить поверх
   недописанного (а «Стоп» исчезал после первого шага). Теперь флаг выводится
   из состояния: держит живой запрос (S.turn) или недопечатанный ответ
   (S.pendingBail). */
check("блокировка хода выводится из состояния, а не ставится руками",
  spaCode.includes("function turnHeld") && /S\.turn && !S\.turn\.dead && !S\.turn\.detached/.test(spaCode)
  && /\|\| !!S\.pendingBail/.test(spaCode)
  && !spaCode.includes("setBusy"));
check("печать ответа тоже держит композер (beginPrinting + syncBusy в actions)",
  spaCode.includes("function beginPrinting") && /beginPrinting\(\);\s*parkParagraph\(p\);/.test(spaCode)
  && /if \(S\.pendingBail === bail\) S\.pendingBail = null;\s*syncBusy\(\);/.test(spaCode));
check("«Стоп» работает на обоих этапах: обрыв запроса ИЛИ доигрывание печати",
  (spaJs.match(/ui\.stopBtn\.addEventListener\("click"[\s\S]{0,700}?if \(S\.pendingBail\) \{[\s\S]{0,160}?try \{ bail\(\); \} catch \(_\) \{\}/) || []).length === 1
  && (spaJs.match(/ui\.stopBtn\.addEventListener\("click"[\s\S]{0,700}?turn\.detached = true;/) || []).length === 1
  && /watchAnswer\(tid, text, WATCH_TRIES\)/.test(spaCode));
check("плейсхолдер различает «отвечает» и «пишет ответ»",
  spaCode.includes("Наставник пишет ответ…") && spaCode.includes("Наставник отвечает…"));

/* --- лента идёт вровень с печатью, а не прыгает в конец неготовости --- */
check("низ написанного — последнее проявившееся слово (followPrint)",
  spaCode.includes("function followPrint") && /followPrint\(words\[i\]\)/.test(spaCode)
  && /wr\.bottom - \(fr\.bottom - PRINT_GAP\)/.test(spaCode) && /if \(need <= 4\) return;/.test(spaCode)
  && /if \(!word \|\| !ui\.feed \|\| !S\.follow\) return;/.test(spaCode));
check("доводка плавная: слово двигает цель, rAF-цикл тянет (без рывка на слово)",
  spaCode.includes("function printGlideTick") && spaCode.includes("function progWrite")
  && /d \* 0\.22/.test(spaCode) && /if \(calm\(\)\) \{ progWrite/.test(spaCode)
  && !/ui\.feed\.scrollTop \+= Math\.min\(need/.test(spaCode)
  && !spaCode.includes("holdStick"));
check("цикл доводки один на ответ и глохнет при уходе человека",
  /if \(!S\.gliding \|\| S\.glideFeed !== ui\.feed\)/.test(spaCode)
  && /feed !== ui\.feed \|\| !S\.follow/.test(spaCode));
check("начало абзаца встаёт на линию печати, а не наверх и не в самый низ",
  spaCode.includes("function parkParagraph") && /parkParagraph\(p\);\s*printPara/.test(spaCode)
  && /targetTop = fr\.bottom - PRINT_GAP - Math\.min\(pr\.height, 28\)/.test(spaCode)
  && /if \(delta <= 4 && delta >= -160\) return;/.test(spaCode)
  && /printGlideTo\(ui\.feed\.scrollTop \+ delta\);/.test(spaCode)
  && !/card\.appendChild\(p\);\s*\/\/ Раскладка[\s\S]{0,200}?scrollDown\(false, true\);\s*printPara/.test(spaCode));
check("доводка сворачивания не спорит с первым абзацем (follow короче задержки write)",
  /follow\(350\);\s*later\(quiet \? 0 : 420, write\);/.test(spaCode));
check("финал хода встаёт ровно в низ: глайд гасится, дальше мгновенно (finishBottom)",
  /function finishBottom\(\)/.test(spaCode) && /glideStop\(\);\s*if \(S\.follow\) scrollDown\(true, false\);/.test(spaCode)
  && /syncBusy\(\);\s*finishBottom\(\);/.test(spaCode));
/* --- рука человека во время хода: вверх — дальше без него, к низу — снова
   вместе. Раньше holdStick() на каждое слово стирал волю человека: lock не
   истекал всю печать, и подняться было невозможно — сайт дёргал обратно. */
check("колесо/палец вверх во время хода отписывает от доводки",
  /ui\.feed\.addEventListener\("wheel"[\s\S]{0,160}?if \(S\.busy && e\.deltaY < 0\) S\.follow = false;/.test(spaJs)
  && /ui\.feed\.addEventListener\("touchmove"[\s\S]{0,320}?S\.follow = false;/.test(spaJs));
check("возврат к низу во время хода возобновляет следование",
  /if \(S\.busy && !S\.follow && dist\(\) < 120\) S\.follow = true;/.test(spaCode));
check("явный вопрос включает следование заново, тихий повтор — нет",
  /if \(!quiet\) \{ S\.follow = true; S\.printTarget = null; S\.progTop = null; \}/.test(spaCode));
check("bail останавливает доводку (иначе тянула бы назад)",
  (spaCode.match(/glideStop\(\);/g) || []).length >= 2);

/* --- меню чата на телефоне: вход видимый, плашка крупная, переворот вверх --- */
check("на телефоне «⋯» видна (вход в меню не только удержанием)",
  /@media \(max-width: 900px\)[\s\S]*?\.agent__more \{ display: grid; width: 44px; height: 44px/.test(spaCss)
  && !/@media \(max-width: 900px\)[\s\S]*?\.agent__more \{ display: none/.test(spaCss)
  && /\.agent__thread \{ padding-right: 52px/.test(spaCss));
check("меню чата на телефоне — широкая плашка с крупными пунктами",
  /\.agent__ctx \{\s*top: 100%; bottom: auto; transform: none; left: 8px; right: 8px/.test(spaCss)
  && /\.agent__ctx-item \{ min-height: 48px/.test(spaCss));
check("у нижних строк меню переворачивается вверх (openThreadMenu меряет)",
  /ctx\.classList\.remove\("up"\)/.test(spaCode)
  && /rowBox\.top \+ ctx\.offsetHeight > listBox\.bottom - 4/.test(spaCode)
  && /\.agent__ctx\.up \{ top: auto; bottom: 100%; \}/.test(spaCss));
check("удаление чата — корзиной, а не крестиком",
  /ctxItem\("Удалить чат", svgRaw\(TRASH_D/.test(spaJs));

/* --- пересборка экрана во время хода его не рвёт (регресс с прода 30.09) ---
   Симптом: nginx 499 -> «Нет соединения», повтор -> 400 AGENT_BUSY. Причина:
   screenAgent обнулял S.turn, и на СЛЕДУЮЩЕМ маунте abort-guard
   (`S.abort && !S.turn`) видел контроллер без хода и рвал живой запрос, а
   ответ уже никто не подхватывал (reattachTurn не находит хода). */
const screenAgentBody = (spaJs.match(/function screenAgent\(screenRoot\) \{[\s\S]*?\n  \}/) || [""])[0];
check("пересборка экрана не теряет живой ход (detached, а не S.turn = null)",
  /if \(S\.turn && !S\.turn\.dead\) S\.turn\.detached = true;/.test(screenAgentBody)
  && !/S\.turn = null;/.test(screenAgentBody), screenAgentBody.slice(0, 60));
check("смена чата закрывает ход только ЧУЖОГО треда (свой — доживает)",
  /var leaving = Number\(prev\) !== Number\(id\);/.test(spaCode)
  && /if \(leaving\) S\.turn = null;\s*else if \(S\.turn && !S\.turn\.dead\) S\.turn\.detached = true;/.test(spaCode));
check("abort-guard маунта на живой ходе не срабатывает (S.turn сохранён)",
  /ui = \{\};\s*\/\/ Летящий ход не рвём[\s\S]{0,200}?if \(S\.abort && \(!S\.turn \|\| S\.turn\.dead \|\| S\.abort !== S\.turn\.ctrl\)\)/.test(spaJs));

/* --- невидимый повтор сбоя сервера (клиент) --- */
check("сбой сервера повторяется невидимо (500/502/503)",
  spaCode.includes("retrySilently") && spaCode.includes("TURN_CLIENT_RETRIES")
  && /res\.status === 502/.test(spaCode) && spaCode.includes("quiet: true"));
check("невидимый повтор не рисует второй пузырёк и второй скелетон",
  /if \(quiet && ui\.live\)/.test(spaCode)
  && !/var skel = quiet \? null/.test(spaCode));
check("обрыв соединения тоже повторяется невидимо",
  /function online\(\)/.test(spaCode) && /S\.currentId != null && online\(\)/.test(spaCode)
  && /turn\.retries/.test(spaCode));
/* --- лента ведёт себя как в эталоне: плавно на резком прыжке и за растущим
   блоком, а человек, ушедший вверх, не вытаскивается силой --- */
check("плавная доводка на резком прыжке (не каждый кадр)",
  spaCode.includes("SMOOTH_FROM") && /scrollDown\(false, first\)/.test(spaCode)
  && /first = false/.test(spaCode));
check("разворот шагов доведёт ленту за блоком", /open && dist\(\) < 200/.test(spaCode));
check("ушедшего вверх не тащим (stick)", spaCode.includes("if (!force && !S.stick) return;")
  && spaCode.includes("stick = dist() < 120"));

/* --- читаемость текста чата (свои чернила раздела) ---
   Общие --text-2/--muted рассчитаны на белые карточки, а чат стоит на фоне
   приложения: в светлой теме серый текст шагов читался «пыльным» (6.1:1 и
   5.1:1), в тёмной --muted не дотягивал до AA (4.2:1). У раздела теперь свои
   два оттенка, и контраст считается тут по-настоящему — чтобы правка видимости
   не откатилась молча. */
const srgb = (h) => {
  const v = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
};
const contrast = (a, b) => {
  const [hi, lo] = [srgb(a), srgb(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const token = (css, name, selector) => {
  const re = new RegExp((selector || "") + "\\s*\\{[^}]*" + name + ":\\s*(#[0-9a-fA-F]{3,8})");
  const m = css.match(re);
  return m ? m[1].slice(0, 7) : null;
};
const stylesCss = read("css/styles.css");
const themes = [
  { name: "светлая", ink: "\\.agent", global: ":root", dark: false },
  { name: "тёмная", ink: '\\[data-theme="dark"\\]\\s+\\.agent', global: ':root\\[data-theme="dark"\\]', dark: true },
];
for (const t of themes) {
  for (const [ink, label] of [["--agent-ink-2", "пояснения"], ["--agent-ink-3", "мелкий текст"]]) {
    const hex = token(spaCss, ink, t.ink);
    const bg = token(stylesCss, "--bg", t.global);
    const surface = token(stylesCss, "--surface", t.global);
    const onBg = hex && bg ? contrast(hex, bg) : 0;
    const onSurface = hex && surface ? contrast(hex, surface) : 0;
    check(`${t.name}: ${label} (${ink}) AA 4.5 на фоне чата`,
      !!hex && onBg >= 4.5 && onSurface >= 4.5, `${hex} → ${onBg.toFixed(2)} / ${onSurface.toFixed(2)}`);
  }
}
/* Правка должна быть именно улучшением, а не ровно той же серостью: свои
   чернила обязаны быть контрастнее общих токенов, которые они заменили. */
for (const t of themes) {
  const ink3 = token(spaCss, "--agent-ink-3", t.ink);
  const oldMuted = token(stylesCss, "--muted", t.global);
  const bg = token(stylesCss, "--bg", t.global);
  const better = !!ink3 && !!oldMuted && contrast(ink3, bg) > contrast(oldMuted, bg);
  check(`${t.name}: мелкий текст контрастнее прежнего --muted`, better,
    `${ink3} vs ${oldMuted} на ${bg}`);
}
/* Чтобы где-то не вернулся общий серый (он и был причиной жалобы). */
check("общий серый в раздела не используется",
  !/var\(--muted\)/.test(spaCss) && !/var\(--text-2\)/.test(spaCss));
check("свои чернила объявлены под .agent и для тёмной темы",
  /\.agent\s*\{[^}]*--agent-ink-2:/.test(spaCss)
  && /\[data-theme="dark"\]\s+\.agent\s*\{[^}]*--agent-ink-2:/.test(spaCss));
/* Списки в ответе не должны слипаться в одну простыню. */
check("переводы строк в ответе сохраняются", /\.agent__answer \{[^}]*white-space: pre-line/.test(spaCss));
/* --- видимость текста в светлой теме: почему чистый цвет не помог ---
   Жалоба была «текст агента плохо видно в светлой теме», и правка ТОЛЬКО цвета
   её не сняла. Замер в живом браузере это объяснил: контраст ответа и так
   13.5:1 (то есть с запасом выше AA), а затемнение цвета двигает плотность
   знака на +0.04% — глазом ноль. Реальные рычаги другие:
   (1) grayscale-сглаживание на светлом фоне делает штрихи тоньше, чем цвет,
       поэтому в светлой теме нужно субпиксельное (auto), а в тёмной —
       наоборот antialiased (субпиксель даёт цветные каёмки);
   (2) кегль ответа: 16px против унаследованных 15px (+0.37% ink).
   Оба правила проверяются, чтобы правка не откатилась молча. */
const lightSmoothing = prop(rule(spaCss, ".agent"), "-webkit-font-smoothing");
const darkSmoothing = prop(rule(spaCss, ':root[data-theme="dark"] .agent'), "-webkit-font-smoothing");
check("в светлой теме у раздела субпиксельное сглаживание (штрихи не тоньше цвета)",
  lightSmoothing === "auto", `сейчас: ${lightSmoothing || "не задано"}`);
check("в тёмной теме сглаживание остаётся antialiased (без цветных каёмок)",
  darkSmoothing === "antialiased", `сейчас: ${darkSmoothing || "не задано"}`);
/* Ответ наставника — длинный текст для чтения; 15px на фоне приложения он
   читался мелким. Проверяем именно кегль ОТВЕТА, а не всего раздела. */
const answerSize = parseFloat(prop(rule(spaCss, ".agent__answer"), "font-size"));
check("ответ наставника не меньше 16px (кегль, а не цвет, делает его заметнее)",
  answerSize >= 16, `сейчас: ${answerSize || "не задан"}px`);
/* Общее правило темы на весь сайт не трогаем: правка видимости — локальная
   раздела, иначе менялся бы рендер всех экранов. */
check("сглаживание темы не менялось глобально (правка только в разделе)",
  /-webkit-font-smoothing:\s*antialiased/.test(stylesCss)
  && !/-webkit-font-smoothing:\s*auto/.test(stylesCss));
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
