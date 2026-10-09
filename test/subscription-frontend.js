/* Фронт подписки Plus сквозняком: публичная страница, карточка профиля,
   окно управления и покупка (mock-провайдер). Флоу покупки: кнопка →
   окно-подтверждение .dlg (тариф/сумма, счёт только после «Оплатить»),
   в mock-стенде без ссылки шлюза — честная ошибка (окна «скоро» и кнопок
   «Напомнить» в интерфейсе нет). Отмены и возврата в интерфейсе
   нет — только статус, срок и история (тест проверяет и отсутствие текстов).
   Самодостаточен: поднимает свой temp-сервер (test/subscription-frontend-server.py,
   прод не трогает), гоняет живой Chromium, в конце кладёт сервер.
   Требует playwright-core и Chromium (как остальные браузерные suites).
   Запуск: node test/subscription-frontend.js */
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright-core");

const SHOTS = (() => { try { fs.mkdirSync("/tmp/opencode", { recursive: true }); return "/tmp/opencode"; } catch (_) { return os.tmpdir(); } })();

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [path.join(__dirname, "subscription-frontend-server.py")],
      { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} reject(new Error("сервер не поднялся")); }, 30000);
    child.stdout.on("data", (d) => {
      out += String(d);
      const m = out.match(/PORT=(\d+)/);
      if (m) { clearTimeout(timer); resolve({ child, base: "http://127.0.0.1:" + m[1] }); }
    });
    child.stderr.on("data", () => {});
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("exit", () => { clearTimeout(timer); reject(new Error("сервер упал на старте: " + out.slice(-300))); });
  });
}

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? "PASS " : "FAIL ") + name + (detail ? " | " + detail : ""));
  if (!cond) failures++;
}

(async () => {
  const { child, base: BASE } = await startServer();
  const shot = (n) => path.join(SHOTS, n);
  let browser = null;
  try {
  const browser0 = await chromium.launch();
  browser = browser0;
  const errors = [];
  let promoNegativeChecked = false;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  ctx.on("page", (p) => {
    p.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
    p.on("pageerror", (e) => errors.push("pageerror: " + String(e && e.message || e)));
  });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + String(e && e.message || e)));

  // --- 1. публичная страница гостю ---
  await page.goto(BASE + "/subscription", { waitUntil: "domcontentloaded" });
  check("h1 про Plus", (await page.textContent("h1")).includes("в своём темпе"));
  const body = await page.textContent("body");
  check("нет техвитрины", !body.includes("Что происходит после") && !body.includes("Как подписка выглядит"));
  check("ни «скоро», ни «напомнить» в DOM", !body.includes("Оплата пока недоступна") && !body.includes("Напомнить о запуске"));
  await page.screenshot({ path: shot("sub-public.png") });

  // переключатель периода
  await page.click('[data-billing="year"]');
  await page.waitForFunction(() => document.getElementById("priceNum").textContent === "1590");
  check("год -> 1590", true);
  const saveVisible = await page.isVisible("#priceSave");
  check("плашка выгоды видна", saveVisible);
  await page.click('[data-billing="month"]');
  await page.waitForFunction(() => document.getElementById("priceNum").textContent === "199");
  check("месяц -> 199", true);

  // FAQ
  await page.click(".faq__item:first-child .faq__q");
  check("FAQ раскрывается", await page.isVisible(".faq__item:first-child .faq__a p"));

  // гость жмёт купить -> профиль (онбординг)
  await page.waitForSelector('body[data-sub="guest"]', { timeout: 10000 });
  await Promise.all([
    page.waitForURL(/\/dashboard#\/profile/, { waitUntil: "commit" }),
    page.click("#ctaBtn"),
  ]);
  check("гость уехал в профиль", true);

  // гость на странице управления — приглашение войти, а не 401
  await page.goto(BASE + "/subscription/manage", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#guestCard:not([hidden])", { timeout: 10000 });
  check("manage гостю: приглашение войти", (await page.textContent("#guestCard")).includes("Сначала войди"));

  // --- 2. онбординг прямо из контекста страницы ---
  const claim = await page.evaluate(async () => {
    const r = await fetch("/api/profile/claim", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: "profile_math", onboarded: true, name: "Тест", selfLevel: "base", goal: "g60" }),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  });
  check("claim 200", claim.status === 200, claim.status);
  await page.goto(BASE + "/dashboard#/profile", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#sub-card .sub-card", { timeout: 15000 });
  const cardFree = await page.textContent("#sub-card");
  check("карточка free: короткая, с покупкой, без лимитов",
    cardFree.includes("Оформить Plus") && !cardFree.includes("Страница тарифа")
    && !cardFree.includes("проверок в день") && !cardFree.includes("ходов ИИ"));
  check("карточка — ссылка на управление",
    (await page.getAttribute("#sub-card .sub-card", "href")) === "/subscription/manage");
  await page.screenshot({ path: shot("sub-profile-free.png") });

  // клик по карточке ведёт на страницу управления
  await Promise.all([
    page.waitForURL(/\/subscription\/manage/, { waitUntil: "commit" }),
    page.click("#sub-card .sub-card"),
  ]);
  check("карточка ведёт на manage", true);

  // страница управления у бесплатного: кольца, история пуста, покупка — через .dlg
  await page.waitForSelector("#content:not([hidden])", { timeout: 15000 });
  const mgFree = await page.textContent("#content");
  check("manage free: кольца и пустая история",
    mgFree.includes("Проверок сочинений") && mgFree.includes("Платежей пока нет"));
  await page.click('#actionsRow [data-act="buy"]');
  await page.waitForSelector("#pay-modal-root .dlg", { timeout: 10000 });
  const dlgFree = await page.textContent("#pay-modal-root");
  check("manage confirm-dlg: тариф и сумма",
    dlgFree.includes("Оформить Plus") && dlgFree.includes("199"));
  check("в окне оплаты видна комиссия 7%",
    dlgFree.includes("Комиссия") && dlgFree.includes("7%"));
  await page.keyboard.press("Escape");

  // период на manage выбирается: free может взять год, а не только месяц
  check("manage free: сегмент периода виден, по умолчанию месяц",
    await page.locator("#periodPick").isVisible()
    && await page.locator('#periodPick [data-period="month"]').evaluate((el) => el.classList.contains("is-on")));
  await page.click('#periodPick [data-period="year"]');
  await page.click('#actionsRow [data-act="buy"]');
  await page.waitForSelector("#pay-modal-root .dlg", { timeout: 10000 });
  const dlgYear = (await page.textContent("#pay-modal-root")).replace(/\u00a0/g, " ");
  check("выбор года доходит до счёта (1590 ₽ и «год»)",
    dlgYear.includes("год") && dlgYear.includes("1 590"), dlgYear.replace(/\s+/g, " ").slice(0, 120));
  await page.keyboard.press("Escape");
  await page.click('#periodPick [data-period="month"]');
  check("возврат на месяц", await page.locator('#periodPick [data-period="month"]').evaluate((el) => el.classList.contains("is-on")));

  // Мобильная раскладка промокода: «Применить» — под полем и на всю ширину,
  // а не одинокой кнопкой слева после переноса.
  await page.setViewportSize({ width: 390, height: 780 });
  await page.click('#actionsRow [data-act="buy"]');
  await page.waitForSelector("#payPromo", { timeout: 10000 });
  const promoBoxes = await page.evaluate(() => {
    const a = document.querySelector("#pay-modal-root [data-apply]").getBoundingClientRect();
    const i = document.querySelector("#payPromo").getBoundingClientRect();
    return { aTop: a.top, aLeft: a.left, aWidth: a.width, iBottom: i.bottom, iLeft: i.left, iWidth: i.width };
  });
  check("мобильный промокод: кнопка под полем и на всю ширину",
    promoBoxes.aTop >= promoBoxes.iBottom - 1
    && Math.abs(promoBoxes.aWidth - promoBoxes.iWidth) < 2
    && Math.abs(promoBoxes.aLeft - promoBoxes.iLeft) < 2,
    JSON.stringify(promoBoxes));
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForSelector("#pay-modal-root .dlg", { state: "detached", timeout: 10000 });

  // --- 2b. залогиненный free жмёт купить на тарифе -> confirm, в mock — честная ошибка ---
  await page.goto(BASE + "/subscription", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('body[data-sub="free"]', { timeout: 10000 });
  await page.click("#ctaBtn");
  await page.waitForSelector("#pay-modal-root .dlg", { timeout: 10000 });
  check("тариф confirm-dlg", (await page.textContent("#pay-modal-root")).includes("К оплате"));
  await page.click("#pay-modal-root [data-pay]");
  await page.waitForFunction(() => {
    const d = document.getElementById("pay-modal-root");
    return d && /Не получилось создать счёт/.test(d.textContent);
  }, { timeout: 15000 });
  check("mock без ссылки: честная ошибка, не редирект", true);
  await page.keyboard.press("Escape");

  // --- 2b2. публичная страница: free + висящий счёт ---------------------
  // Кнопка покупки ОСТАЁТСЯ на месте (клик ведёт на manage, где баннер
  // счёта предложит завершить или отменить), рядом — заметка о счёте.
  // Прятать кнопку нельзя: ghost прыгает на её место и выглядит как
  // подмена «Оформить Plus» на «Попробовать бесплатно».
  const pendRef = await page.evaluate(async () => {
    const hist = await (await fetch("/api/subscription/payments?limit=10")).json();
    const p = ((hist && hist.payments) || []).find((x) => x && x.status === "pending");
    return p ? (p.publicId || p.id) : null;
  });
  check("счёт от шага 2b висит", !!pendRef);
  await page.goto(BASE + "/subscription", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body.getAttribute("data-sub") === "free", { timeout: 10000 });
  await page.waitForFunction(() => {
    const b = document.getElementById("ctaBtn");
    const n = document.getElementById("pendingNote");
    return b && b.style.display !== "none" && n && !n.hidden;
  }, { timeout: 10000 });
  check("free + висящий счёт: кнопка на месте, рядом заметка", true);
  await Promise.all([
    page.waitForURL(/\/subscription\/manage/, { waitUntil: "commit" }),
    page.click("#ctaBtn"),
  ]);
  check("клик по «Оформить» при счёте ведёт на manage", true);
  await page.evaluate(async (ref) => {
    await fetch("/api/subscription/payments/cancel", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentId: ref }),
    });
  }, pendRef);
  await page.goto(BASE + "/subscription", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const n = document.getElementById("pendingNote");
    return n && n.hidden;
  }, { timeout: 10000 });
  check("после отмены счёта заметка ушла", true);

  // --- 2c. промокод: «Применить» считает скидку ДО создания счёта ---
  const promoMade = await (async () => {
    const login = await fetch(BASE + "/api/admin/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "e2e-admin" }),
    });
    /* Логин ставит НЕСКОЛЬКО кук (сессия, админ, устройство): нужны все —
       на `set-cookie` в одиночном заголовке Node отдаёт только первую. */
    const raw = typeof login.headers.getSetCookie === "function"
      ? login.headers.getSetCookie()
      : [login.headers.get("set-cookie")];
    const cookie = raw.map((c) => String(c || "").split(";")[0]).filter(Boolean).join("; ");
    const made = await fetch(BASE + "/api/admin/subscription/promos", {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ action: "create", code: "E2E20", kind: "percent", value: 20 }),
    });
    const made100 = await fetch(BASE + "/api/admin/subscription/promos", {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ action: "create", code: "E2E100", kind: "percent", value: 100 }),
    });
    return { login: login.status, create: made.status, create100: made100.status };
  })();
  check("промокод для сценария создан",
    promoMade.login === 200 && promoMade.create === 200 && promoMade.create100 === 200,
    JSON.stringify(promoMade));

  await page.click("#ctaBtn");
  await page.waitForSelector("#pay-modal-root .dlg", { timeout: 10000 });
  await page.fill("#payPromo", "e2e20");
  await page.click("#pay-modal-root [data-apply]");
  await page.waitForFunction(() => {
    const s = document.getElementById("payPromoState");
    return s && !s.hidden && /применён/.test(s.textContent);
  }, { timeout: 15000 });
  const amountApplied = (await page.textContent("#payAmount")).trim();
  const dlgApplied = (await page.textContent("#pay-modal-root")).replace(/\s+/g, " ");
  check("«Применить»: код применён, скидка и новая сумма",
    amountApplied === "159 ₽" && dlgApplied.includes("−40 ₽")
    && dlgApplied.includes("Оплатить 159 ₽"), `${amountApplied} | ${dlgApplied.slice(0, 140)}`);

  // Правка кода после применения сбрасывает скидку — сумма не «залипает».
  await page.fill("#payPromo", "E2E21");
  await page.waitForFunction(() => (document.getElementById("payAmount") || {}).textContent === "199 ₽",
    { timeout: 10000 });
  check("правка кода сбрасывает скидку", true);

  // Неверный код: честная ошибка у поля, цена базовая, счёт не создаётся.
  await page.fill("#payPromo", "NOSUCH");
  await page.click("#pay-modal-root [data-apply]");
  await page.waitForFunction(() => {
    const s = document.getElementById("payPromoState");
    return s && !s.hidden && /не найден/i.test(s.textContent);
  }, { timeout: 15000 });
  const amountBad = (await page.textContent("#payAmount")).trim();
  check("неверный код: ошибка у поля, цена базовая",
    amountBad === "199 ₽", amountBad);

  // 100% код: счёта и шлюза нет — сумма 0, комиссия скрыта, кнопка «Активировать».
  await page.fill("#payPromo", "E2E100");
  await page.click("#pay-modal-root [data-apply]");
  await page.waitForFunction(() => {
    const b = document.querySelector("#pay-modal-root [data-pay]");
    return b && /Активировать Plus/.test(b.textContent);
  }, { timeout: 15000 });
  const zeroState = await page.evaluate(() => ({
    amount: (document.getElementById("payAmount") || {}).textContent || "",
    feeHidden: document.getElementById("payFeeRow").hidden === true,
  }));
  check("100% код: сумма 0 и комиссия скрыта",
    zeroState.amount.trim() === "0 ₽" && zeroState.feeHidden, JSON.stringify(zeroState));

  // Единственный ожидаемый 4xx прогона: Chrome печатает его в консоль
  // (иногда двумя строками) — при финальной проверке вырезается, остальные
  // сетевые ошибки по-прежнему валят тест.
  promoNegativeChecked = true;
  await page.keyboard.press("Escape");

  // --- 3. mock-покупка настоящим API-путём ---
  const bought = await page.evaluate(async () => {
    const co = await (await fetch("/api/subscription/checkout", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ period: "month" }),
    })).json();
    const ok = await (await fetch("/api/subscription/confirm", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentId: co.paymentId }),
    })).json();
    /* Подчищаем pending от шага 2b: баннер «Счёт ждёт оплаты» теперь виден
       и при активном Plus (правило: висящий счёт сначала завершить или
       отменить), а дальше проверяем именно чистый экран управления Plus. */
    const hist = await (await fetch("/api/subscription/payments?limit=10")).json();
    for (const p of ((hist && hist.payments) || [])) {
      if (p && p.status === "pending") {
        await fetch("/api/subscription/payments/cancel", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paymentId: p.publicId || p.id }),
        });
      }
    }
    return { co, ok };
  });
  check("mock-покупка ok", bought.ok && bought.ok.ok === true, JSON.stringify(bought.ok).slice(0, 80));

  await page.goto(BASE + "/dashboard#/profile", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#sub-card .sub-card--plus", { timeout: 15000 });
  const cardPlus = await page.textContent("#sub-card");
  check("карточка plus: актив + срок", cardPlus.includes("Осталось") && cardPlus.includes("Управлять"));
  await page.screenshot({ path: shot("sub-profile-plus.png") });

  // страница управления у Plus: статус, кольца, чек
  await page.goto(BASE + "/subscription/manage", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#content:not([hidden])", { timeout: 15000 });
  await page.waitForSelector('#payHist .hist__row', { timeout: 15000 });
  let det = await page.textContent("#content");
  check("manage plus: срок и чек",
    det.includes("доступ до") && det.includes("199") && det.includes("оплачено")
    && det.includes("Проверок сочинений") && det.includes("Ходов ИИ"));
  await page.screenshot({ path: shot("sub-manage.png") });

  // отмены и возврата в интерфейсе нет — только статус, срок и история.
  // Проверяется буквально: ни текстов кнопок, ни модалки, ни слова «автопродление».
  det = await page.textContent("#content");
  check("manage plus: без отмены/возврата/автопродления",
    !det.includes("Отменить") && !det.includes("Вернуть продление")
    && !det.includes("Автопродление") && !det.includes("возврат")
    && (await page.locator('#actionsRow [data-act="ask-cancel"], #actionsRow [data-act="resume"], #cancelModal').count()) === 0);
  check("manage plus: плашка Plus без статусной таблетки",
    det.includes("Plus") && !det.includes("без продления") && !det.includes("Plus активен"));

  check("manage plus: период продления по умолчанию — текущий (месяц)",
    await page.locator("#periodPick").isVisible()
    && await page.locator('#periodPick [data-period="month"]').evaluate((el) => el.classList.contains("is-on")));

  // «Продлить Plus» у активного — окно-подтверждение, счёт не создаём
  await page.click('#actionsRow [data-act="buy"]');
  await page.waitForSelector("#pay-modal-root .dlg", { timeout: 10000 });
  check("plus confirm-dlg", (await page.textContent("#pay-modal-root")).includes("Продлить Plus") || (await page.textContent("#pay-modal-root")).includes("Оформить Plus"));
  await page.keyboard.press("Escape");
  await page.waitForSelector("#pay-modal-root .dlg", { state: "detached", timeout: 10000 });

  // --- 4. публичная страница залогиненным Plus ---
  await page.goto(BASE + "/subscription", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#activeBanner:visible", { timeout: 10000 });
  check("баннер Plus", true);
  const banner = await page.textContent("#activeBanner");
  check("баннер с лимитами", banner.includes("У тебя уже Plus") && banner.includes("проверок"));

  // --- 5. мобильная липкая панель ---
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto(BASE + "/subscription", { waitUntil: "domcontentloaded" });
  // Залогиненный Plus: баннер вместо кнопки, липкой панели нет.
  const mob = await ctx.newPage();
  mob.on("pageerror", (e) => errors.push("mob pageerror: " + String(e && e.message || e)));
  await mob.setViewportSize({ width: 390, height: 780 });
  await mob.goto(BASE + "/subscription", { waitUntil: "domcontentloaded" });
  check("buybar скрыт для Plus", await mob.isHidden("#buybar"));
  await mob.screenshot({ path: shot("sub-mobile.png"), fullPage: true });
  // Гость на телефоне: проскроллил мимо кнопки — панель выехала.
  const guestCtx = await browser.newContext({ viewport: { width: 390, height: 780 } });
  const guestMob = await guestCtx.newPage();
  guestMob.on("pageerror", (e) => errors.push("guest pageerror: " + String(e && e.message || e)));
  await guestMob.goto(BASE + "/subscription", { waitUntil: "domcontentloaded" });
  await guestMob.waitForSelector('body[data-sub="guest"]', { timeout: 10000 });
  await guestMob.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await guestMob.waitForSelector("#buybar.is-on", { timeout: 10000 });
  check("buybar виден гостю после скролла", true);

  // --- 6. ожидание, баннер и отмена незавершённого счёта ---
  // Всё на mock-стенде: опрос идёт в тот же confirm, внешних вызовов нет.
  const ctx6 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p6 = await ctx6.newPage();
  p6.on("pageerror", (e) => errors.push("p6 pageerror: " + String(e && e.message || e)));
  await p6.goto(BASE + "/subscription/manage", { waitUntil: "domcontentloaded" });
  await p6.evaluate(async () => {
    await fetch("/api/profile/claim", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: "profile_math", onboarded: true, name: "Ожидание", selfLevel: "base", goal: "g60" }),
    });
  });
  await p6.goto(BASE + "/subscription/manage", { waitUntil: "domcontentloaded" });
  await p6.waitForSelector("#content:not([hidden])", { timeout: 15000 });
  // покупка в mock: счёт создаётся, ссылки нет — честная ошибка, счёт висит
  await p6.click('#actionsRow [data-act="buy"]');
  await p6.waitForSelector("#pay-modal-root .dlg", { timeout: 10000 });
  await p6.click("#pay-modal-root [data-pay]");
  await p6.waitForFunction(() => {
    const d = document.getElementById("pay-modal-root");
    return d && /Не получилось создать счёт/.test(d.textContent);
  }, { timeout: 15000 });
  await p6.keyboard.press("Escape");
  await p6.goto(BASE + "/subscription/manage", { waitUntil: "domcontentloaded" });
  await p6.waitForSelector("#content:not([hidden])", { timeout: 15000 });
  await p6.waitForSelector(".pay-pending", { timeout: 10000 });
  check("баннер незавершённого счёта", (await p6.textContent(".pay-pending")).includes("Счёт ждёт оплаты"));
  check("пока счёт ждёт оплаты, кнопки покупки нет",
    await p6.locator('#actionsRow [data-act="buy"]').count() === 0
    && !(await p6.locator("#periodPick").isVisible())
    && (await p6.textContent("#actionsSub")).includes("ждёт оплаты"),
    await p6.textContent("#actionsSub"));
  // отмена своего pending — баннер уходит, покупка возвращается
  await p6.click(".pay-pending .btn:last-child");
  await p6.waitForFunction(() => !document.querySelector(".pay-pending"), { timeout: 10000 });
  check("отмена счёта убирает баннер", true);
  await p6.waitForSelector('#actionsRow [data-act="buy"]', { timeout: 15000 });
  check("после отмены кнопка покупки вернулась", true);
  // новый счёт + возврат ?pay=ok: ожидание тем же лоадером, mock-confirm сразу успех
  await p6.click('#actionsRow [data-act="buy"]');
  await p6.waitForSelector("#pay-modal-root .dlg", { timeout: 10000 });
  await p6.click("#pay-modal-root [data-pay]");
  await p6.waitForFunction(() => {
    const d = document.getElementById("pay-modal-root");
    return d && /Не получилось создать счёт/.test(d.textContent);
  }, { timeout: 15000 });
  await p6.keyboard.press("Escape");
  await p6.goto(BASE + "/subscription/manage?pay=ok", { waitUntil: "domcontentloaded" });
  await p6.waitForSelector("#payWait .ege-loader", { timeout: 10000 });
  check("ожидание тем же лоадером", true);
  await p6.waitForFunction(() => /Оплата прошла/.test(document.body.textContent), { timeout: 30000 });
  check("опрос дожал confirm до успеха", true);
  await p6.waitForFunction(() => {
    const pill = document.getElementById("statusPill");
    return pill && /Plus/.test(pill.textContent);
  }, { timeout: 15000 });
  check("Plus активен после ожидания", true);

  // --- активный Plus + висящий счёт: баннер виден, продления нет ----------
  // Регресс застревания: счёт прятался при активной подписке, а промокод
  // из-за него блокировался — отменить счёт было негде.
  await p6.evaluate(async () => {
    await fetch("/api/subscription/checkout", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ period: "month", idempotencyKey: "rest-" + Date.now() }),
    });
  });
  await p6.goto(BASE + "/subscription/manage", { waitUntil: "domcontentloaded" });
  await p6.waitForSelector(".pay-pending", { timeout: 15000 });
  check("активный Plus + висящий счёт: баннер виден", true);
  check("...продления нет и есть подсказка про счёт",
    await p6.locator('#actionsRow [data-act="buy"]').count() === 0
    && (await p6.textContent("#actionsSub")).includes("ждёт оплаты"),
    await p6.textContent("#actionsSub"));
  await p6.click(".pay-pending .btn:last-child");
  await p6.waitForFunction(() => !document.querySelector(".pay-pending"), { timeout: 10000 });
  await p6.waitForSelector('#actionsRow [data-act="buy"]', { timeout: 15000 });
  check("после отмены счёта продление вернулось",
    (await p6.textContent('#actionsRow [data-act="buy"]')).includes("Продлить"),
    await p6.textContent('#actionsRow [data-act="buy"]'));
  await ctx6.close();

  /* Неверный промокод (проверка 2c) намеренно даёт один 400 — Chromium
     печатает его консолью, иногда двумя строками. Вырезаем только его;
     любая другая сетевая ошибка остаётся провалом. */
  const realErrors = promoNegativeChecked
    ? errors.filter((m) => !/Failed to load resource.*status of 400/.test(m))
    : errors;
  check("консоль без ошибок", realErrors.length === 0, realErrors.slice(0, 3).join(" / "));
  console.log(failures === 0 ? "E2E ALL OK" : `E2E FAILURES=${failures}`);
  } finally {
    try { if (browser) await browser.close(); } catch (_) {}
    try { child.kill(); } catch (_) {}
  }
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error("E2E CRASH", e); process.exit(2); });
