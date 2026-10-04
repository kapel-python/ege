/* Фронт подписки Plus сквозняком: публичная страница, карточка профиля,
   окно управления, покупка и отмена/возврат (mock-провайдер).
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
  check("soon-модалка в DOM", body.includes("Оплата пока недоступна"));
  await page.screenshot({ path: shot("sub-public.png") });

  // переключатель периода
  await page.click('[data-billing="year"]');
  await page.waitForFunction(() => document.getElementById("priceNum").textContent === "990");
  check("год -> 990", true);
  const saveVisible = await page.isVisible("#priceSave");
  check("плашка выгоды видна", saveVisible);
  await page.click('[data-billing="month"]');
  await page.waitForFunction(() => document.getElementById("priceNum").textContent === "99");
  check("месяц -> 99", true);

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
    && !cardFree.includes("проверок в день") && !cardFree.includes("ходов наставника"));
  check("карточка — ссылка на управление",
    (await page.getAttribute("#sub-card .sub-card", "href")) === "/subscription/manage");
  await page.screenshot({ path: shot("sub-profile-free.png") });

  // клик по карточке ведёт на страницу управления
  await Promise.all([
    page.waitForURL(/\/subscription\/manage/, { waitUntil: "commit" }),
    page.click("#sub-card .sub-card"),
  ]);
  check("карточка ведёт на manage", true);

  // страница управления у бесплатного: кольца, история пуста, soon
  await page.waitForSelector("#content:not([hidden])", { timeout: 15000 });
  const mgFree = await page.textContent("#content");
  check("manage free: кольца и пустая история",
    mgFree.includes("Проверок сочинений") && mgFree.includes("Платежей пока нет"));
  await page.click('#actionsRow [data-act="soon"]');
  await page.waitForSelector("#soonModal.is-open");
  check("manage soon-модалка", (await page.textContent("#soonModal")).includes("Оплата пока недоступна"));
  await page.keyboard.press("Escape");

  // --- 2b. залогиненный free жмёт купить -> soon ---
  await page.goto(BASE + "/subscription", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('body[data-sub="free"]', { timeout: 10000 });
  await page.click("#ctaBtn");
  await page.waitForSelector("#soonModal.is-open");
  check("free soon-модалка на странице", (await page.textContent("#soonModal")).includes("Оплата пока недоступна"));
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
    det.includes("доступ до") && det.includes("99") && det.includes("оплачено")
    && det.includes("Проверок сочинений") && det.includes("Ходов наставника"));
  await page.screenshot({ path: shot("sub-manage.png") });

  // отмена продления
  await page.click('#actionsRow [data-act="ask-cancel"]');
  check("подтверждение отмены", await page.isVisible("#confirmSlot .confirm"));
  await page.click('#confirmSlot .confirm button:has-text("Да, отменить")');
  await page.waitForSelector('#statusPill:has-text("без продления")', { timeout: 10000 });
  check("отмена: без продления", true);

  // возврат продления
  await page.click('#actionsRow [data-act="resume"]');
  await page.waitForSelector('#statusPill:has-text("Plus активен")', { timeout: 10000 });
  check("resume: активна", true);

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

  check("консоль без ошибок", errors.length === 0, errors.slice(0, 3).join(" / "));
  console.log(failures === 0 ? "E2E ALL OK" : `E2E FAILURES=${failures}`);
  } finally {
    try { if (browser) await browser.close(); } catch (_) {}
    try { child.kill(); } catch (_) {}
  }
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error("E2E CRASH", e); process.exit(2); });
