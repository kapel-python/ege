#!/usr/bin/env node
/* Регресс раздела «Провайдеры» в админке: карточки, детальная модалка,
   список моделей У ПРОВАЙДЕРА, проверка выбранной модели, применение и
   сброс к стандартным значениям — у встроенного и у своего провайдера.
 *
 * Живой сервер поднимается на temp-БД и свободном порте, прод не трогается.
 * Рядом поднимается ФЕЙКОВЫЙ OpenAI-шлюз (/v1/models + /v1/chat/completions):
 * список моделей и проверка модели обязаны идти к провайдеру, поэтому без
 * настоящего собеседника тут не проверить ничего.
 *
 * Покрывает:
 *   P1 раздел есть в сайдбаре и по прямому #/providers; у гостя и юзера —
 *      только форма входа, ноль запросов к /api/admin/providers*
 *   P2 карточки: встроенные + свой провайдер, статус, ключ-подсказка без ключа
 *   P3 клик по карточке открывает модалку деталей; клик по «Проверить» её НЕ
 *      открывает (иначе вложенная кнопка съедала бы клик)
 *   P4 список моделей приходит от провайдера, текущая модель первая
 *   P5 выбор модели из списка подставляется в поле; проверка выбранной модели
 *      отвечает живым запросом и показывает честный вердикт по каждой модели
 *   P6 применение меняет модель, карточка показывает «модель изменена»
 *   P7 сброс у СВОЕГО возвращает модель, с которой он был добавлен
 *   P8 сброс у ВСТРОЕННОГО возвращает модель из окружения сервера
 *   P9 кнопка сброса есть у обоих типов провайдеров
 *   P9c удаление в два шага (модалка + ввод ID) у своего и у встроенного,
 *      плашка удалённых и кнопка «Восстановить»
 *   P10 ключ провайдера не появляется в DOM/ответах
 *
 * Запуск: node test/admin-providers-ui.js
 * Нужен playwright-core и Chromium; путь можно задать EGE_CHROME.
 * Без playwright-core — код 2 с инструкцией (как у security.js).
 */
const { spawn, createServer } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

let chromium;
try {
  ({ chromium } = require("playwright-core"));
} catch (_) {
  console.error("SKIP: нужен playwright-core. Установи: npm i playwright-core");
  console.error("      и укажи Chromium: EGE_CHROME=/path/to/chrome");
  process.exit(2);
}

const ROOT = path.resolve(__dirname, "..");
const SERVER = path.join(ROOT, "server", "server.py");
const ADMIN_PASSWORD = "ui-providers-test-admin-pw";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ege-providers-ui-"));
const DB = path.join(TMP, "ege.sqlite3");
const PORT = 23000 + Math.floor(Math.random() * 2000);
const GATEWAY_PORT = PORT + 1;
let BASE = "";

let failed = 0, passed = 0;
const t = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`); }
};
const section = (s) => console.log(`\n=== ${s} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  if (process.env.EGE_CHROME && fs.existsSync(process.env.EGE_CHROME)) return process.env.EGE_CHROME;
  const roots = [path.join(os.homedir(), ".cache", "ms-playwright")];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root)) {
      for (const rel of [["chrome-linux64", "chrome"], ["chrome-linux", "chrome"],
                         ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"]]) {
        const p = path.join(root, dir, ...rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

/* Фейковый OpenAI-шлюз. Модели перечислены здесь, и именно их админка
   обязана показать: свой список id в клиенте означал бы угадывание. */
/* Четыре модели с РАЗНЫМИ исходами — иначе пинг всех моделей нечего проверять:
   alpha-pro работает, gamma-flash работает, beta-mini снята (404), delta-broken
   падает с 500. Ровно эти четыре ожидаются в результатах проверки. */
const GATEWAY_MODELS = ["alpha-pro", "beta-mini", "gamma-flash", "delta-broken"];
const GATEWAY_DEAD = { "beta-mini": 404, "delta-broken": 500 };
/* Задержки разные и НАМЕРЕННО разнесены: иначе сортировку «от самых быстрых»
   нечем проверять, а последовательная проверка не отличается от параллельной
   по времени. */
const GATEWAY_DELAY_MS = { "alpha-pro": 60, "gamma-flash": 300, "beta-mini": 120, "delta-broken": 120 };
function startGateway() {
  const srv = http.createServer((req, res) => {
    const send = (code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
      res.end(body);
    };
    if (req.method === "GET" && req.url === "/v1/models") {
      return send(200, { data: GATEWAY_MODELS.map((id) => ({ id })) });
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        let model = "";
        try { model = JSON.parse(raw || "{}").model || ""; } catch (_) {}
        const wait = GATEWAY_DELAY_MS[model] || 40;
        setTimeout(() => {
          const dead = GATEWAY_DEAD[model];
          if (dead) return send(dead, { error: { message: "model unavailable" } });
          return send(200, { choices: [{ message: { content: "привет" } }] });
        }, wait);
      });
      return undefined;
    }
    return send(404, { error: "not found" });
  });
  return new Promise((resolve) => srv.listen(GATEWAY_PORT, "127.0.0.1", () => resolve(srv)));
}

async function startServer() {
  const salt = "b".repeat(32);
  const dk = crypto.pbkdf2Sync(ADMIN_PASSWORD, Buffer.from(salt, "hex"), 210000, 32, "sha256");
  const env = {
    ...process.env,
    EGE_DB_PATH: DB,
    EGE_PORT: String(PORT),
    EGE_DISABLE_SYSTEMD: "1",
    EGE_PID_FILE: path.join(TMP, "server.pid"),
    EGE_LOCK_FILE: path.join(TMP, "server.lock"),
    EGE_QUIET: "1",
    EGE_ADMIN_PASSWORD_HASH: `pbkdf2_sha256$210000$${salt}$${dk.toString("hex")}`,
    // Стандартная модель встроенного ВИДНА в тесте: сброс обязан вернуть
    // именно её (значение из окружения), а не «последнее, что применили».
    EGE_AI_MODEL: "qwen3.8-flash",
    EGE_CLOSEROUTER_MODEL: "anthropic/claude-sonnet-5",
    EGE_CLOSEROUTER_API_KEY: "closerouter-env-key",
    EGE_AI_API_KEY: "gptunnel-env-key",
  };
  for (const k of ["EGE_AI_BASE_URL", "EGE_AI_API_KEY", "AI_API_KEY", "AI_BASE_URL"]) {
    if (k === "EGE_AI_API_KEY") continue;
    delete env[k];
  }
  const proc = spawn("python3", ["-u", SERVER], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout.on("data", () => {});
  proc.stderr.on("data", () => {});
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (r.ok) { BASE = `http://127.0.0.1:${PORT}`; return proc; }
    } catch (_) {}
    await sleep(250);
  }
  proc.kill("SIGKILL");
  throw new Error("сервер не поднялся");
}

async function api(pathname, opts = {}) {
  const res = await fetch(BASE + pathname, opts);
  let payload = null;
  try { payload = await res.json(); } catch (_) {}
  return { status: res.status, payload, headers: res.headers };
}

async function newPage(context) {
  const page = await context.newPage();
  page.errors = [];
  page.provCalls = [];
  page.on("pageerror", (e) => page.errors.push(String((e && e.message) || e)));
  page.on("request", (req) => {
    if (req.url().includes("/api/admin/providers")) page.provCalls.push(`${req.method()} ${req.url().replace(BASE, "")}`);
  });
  return page;
}

async function loginAdmin(page) {
  if (!page.url().startsWith(BASE)) await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  return page.evaluate(async (pw) => {
    await fetch("/api/bootstrap-lite", { credentials: "same-origin" });
    const r = await fetch("/api/admin/login", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw }),
    });
    return r.status;
  }, ADMIN_PASSWORD);
}

async function claimUser(page) {
  if (!page.url().startsWith(BASE)) await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  return page.evaluate(async () => {
    await fetch("/api/bootstrap-lite", { credentials: "same-origin" });
    const r = await fetch("/api/profile/claim", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: "profile_math", onboarded: true, selfLevel: "base", goal: "g60", name: "UI Юзер" }),
    });
    return r.status;
  });
}

const page_card_model = (page, id) => page.evaluate((wanted) => {
  const card = Array.from(document.querySelectorAll(".a-prov-card"))
    .find((c) => (c.querySelector(".a-prov-card__open")?.getAttribute("onclick") || "").includes(`/providers/${wanted}`));
  return card ? (card.querySelector(".a-prov-kv b")?.textContent || "") : null;
}, id);

/* Значение конкретной строки «подпись → значение» на карточке (например
   «Для ученика» → название модели): порядок строк меняется вместе с
   конфигурацией, поэтому ищем по подписи, а не по индексу. */
const page_card_text = (page, id, label) => page.evaluate(({ wanted, key }) => {
  const card = Array.from(document.querySelectorAll(".a-prov-card"))
    .find((c) => (c.querySelector(".a-prov-card__open")?.getAttribute("onclick") || "").includes(`/providers/${wanted}`));
  if (!card) return null;
  for (const row of card.querySelectorAll(".a-prov-kv")) {
    if ((row.querySelector("span")?.textContent || "").trim() === key) {
      return (row.querySelector("b")?.textContent || "").trim();
    }
  }
  return null;
}, { wanted: id, key: label });

/* Стандартные приоритеты обязаны быть ВИДНЫ, а не подразумеваться кодом:
   closerouter — высокий, gptunnel — средний. Пустые слоты означали «приоритет
   не задан» при том, что ротация всё равно шла closerouter → gptunnel. */
const slotLabels = (page) => page.evaluate(() =>
  Object.fromEntries(Array.from(document.querySelectorAll(".a-prov-card")).map((card) => [
    card.querySelector(".a-prov-card__open")?.getAttribute("onclick")?.match(/navigate\('\/providers\/([^']+)'\)/)?.[1] || "",
    (Array.from(card.querySelectorAll(".a-prov-id b")).map((b) => b.textContent.trim())[0]) || "",
  ])));

const provCards = (page) => page.evaluate(() =>
  Array.from(document.querySelectorAll(".a-prov-card")).map((card) => ({
    id: card.querySelector(".a-prov-card__open")?.getAttribute("onclick")?.match(/navigate\('\/providers\/([^']+)'\)/)?.[1] || "",
    title: card.querySelector(".a-prov-title")?.textContent || "",
    model: card.querySelector(".a-prov-kv b")?.textContent || "",
    chips: Array.from(card.querySelectorAll(".a-chip")).map((c) => c.textContent.trim()),
    warn: Array.from(card.querySelectorAll(".a-prov-warn")).map((w) => w.textContent.trim()),
  })));

/* Раздел всегда открывается С НОВОГО документа: переход только по hash при
   уже открытом /admin#/providers не перерисовывает панель, и карточки
   показывали бы данные ДО правки (ровно этот случай ловится в P8). */
async function openSection(page) {
  await page.goto(`${BASE}/admin#/providers`, { waitUntil: "domcontentloaded" });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".a-prov-card, .a-empty", { timeout: 30000 });
}

/* Скриншоты панели управления — только по EGE_SHOTS=1 (как в essay-visual.js):
   дизайн панели проверяется глазами, а не только вёрсткой по селекторам. */
const SHOTS = path.join(ROOT, "screenshots");
async function shot(page, name) {
  if (!process.env.EGE_SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name), fullPage: false });
  console.log(`  shot ${name}`);
}

(async function main() {
  const exe = findChrome();
  if (!exe) {
    console.error("SKIP: Chromium не найден. Укажи EGE_CHROME=/path/to/chrome");
    process.exit(2);
  }
  const gateway = await startGateway();
  const proc = await startServer();
  let browser = null;
  try {
    browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });

    // ---------------- P1: доступ и отсутствие раздела у не-админа ----------
    section("P1 раздел и доступ");
    const guestCtx = await browser.newContext();
    const guest = await newPage(guestCtx);
    await guest.goto(`${BASE}/admin#/providers`, { waitUntil: "domcontentloaded" });
    await guest.waitForSelector("#loginForm", { timeout: 30000 });
    await sleep(1200);
    t("гость видит форму входа, а не раздел",
      await guest.locator(".a-prov-card").count() === 0 && await guest.locator("#loginForm").count() === 1);
    t("гость не дёргает /api/admin/providers", !guest.provCalls.length, guest.provCalls.join(", "));

    const userCtx = await browser.newContext();
    const user = await newPage(userCtx);
    await claimUser(user);
    await user.goto(`${BASE}/admin#/providers`, { waitUntil: "domcontentloaded" });
    await user.waitForSelector("#loginForm", { timeout: 30000 });
    await sleep(1200);
    t("обычный юзер — тоже форма входа и ноль запросов раздела",
      await user.locator(".a-prov-card").count() === 0 && !user.provCalls.length, user.provCalls.join(", "));
    const guestDirect = await user.evaluate(async () => {
      const r = await fetch("/api/admin/providers", { credentials: "same-origin" });
      return r.status;
    });
    t("прямой запрос раздела без админ-сессии -> 401", guestDirect === 401, String(guestDirect));
    await guestCtx.close();
    await userCtx.close();

    // ---------------- свой провайдер через API (фейковый шлюз) -------------
    const adminCtx = await browser.newContext();
    const admin = await newPage(adminCtx);
    t("вход админа", (await loginAdmin(admin)) === 200);
    const created = await admin.evaluate(async (gw) => {
      const r = await fetch("/api/admin/providers", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "fakegw", title: "Фейковый шлюз",
          base_url: gw + "/v1", model: "alpha-pro",
          api_key: "fake-secret-key-1234", auth: "bearer",
        }),
      });
      return { status: r.status, body: await r.json() };
    }, `http://127.0.0.1:${GATEWAY_PORT}`);
    // Добавление мгновенное: сервер НЕ спрашивает шлюз. Иначе кнопка «Добавить»
    // ждала бы ответа провайдера (до 20 с на мёртвой модели) — ровно тогда,
    // когда проверять не нужно: проверка есть на странице провайдера.
    t("свой провайдер добавлен БЕЗ запроса к шлюзу",
      created.status === 200 && created.body.ok === true
      && !created.body.probe && !created.body.warning,
      JSON.stringify(created.body).slice(0, 200));

    // ---------------- P2: карточки ----------------------------------------
    section("P2 карточки провайдеров");
    await openSection(admin);
    const cards = await provCards(admin);
    const ids = cards.map((c) => c.id);
    t("все провайдеры на карточках (2 встроенных + свой)",
      ids.includes("closerouter") && ids.includes("gptunnel") && ids.includes("fakegw"), ids.join(", "));
    const fakeCard = cards.find((c) => c.id === "fakegw");
    t("на карточке видны модель, ключ-подсказка и чипы «свой»",
      fakeCard && fakeCard.model === "alpha-pro" && fakeCard.chips.includes("свой"),
      JSON.stringify(fakeCard));
    t("у встроенного чип «встроенный»", cards.find((c) => c.id === "closerouter")?.chips.includes("встроенный"));
    const bodyText = await admin.locator("#adminScreen").innerText();
    t("ключ провайдера не нарисован в разделе", !bodyText.includes("fake-secret-key-1234"));
    t("видна подсказка про ключ (хвост)", bodyText.includes("1234"), bodyText.slice(0, 120));

    // ---------------- P2b: приоритеты видны сразу, без догадок -------------
    section("P2b стандартные приоритеты по умолчанию");
    const slots = await slotLabels(admin);
    t("closerouter по умолчанию — высокий приоритет", slots.closerouter === "Высокий", JSON.stringify(slots));
    t("gptunnel по умолчанию — средний приоритет", slots.gptunnel === "Средний", JSON.stringify(slots));
    const queue = await admin.locator(".a-prov-order").innerText();
    t("в очереди CloseRouter первый, GPTunnel второй",
      /1\.\s*CloseRouter/.test(queue) && /2\.\s*GPTunnel/.test(queue), queue.replace(/\n/g, " "));
    const slotsApi = await admin.evaluate(async () => (await (await fetch("/api/admin/providers", { credentials: "same-origin" })).json()).slots);
    t("слоты записаны в конфиг (не подразумеваются кодом)",
      slotsApi.high === "closerouter" && slotsApi.medium === "gptunnel" && (slotsApi.low === null),
      JSON.stringify(slotsApi));
    // Свой провайдер с «Высоким» должен ЧЕСТНО забрать слот, а не оказаться
    // вторым претендентом на первый: ровно это и было смешиванием.
    await admin.evaluate(async (gw) => {
      await fetch("/api/admin/providers", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "topgw", title: "Верхний", base_url: gw + "/v1", model: "alpha-pro", api_key: "k2", slot: "high" }),
      });
    }, `http://127.0.0.1:${GATEWAY_PORT}`);
    await openSection(admin);
    const slots2 = await slotLabels(admin);
    t("свой провайдер с высоким приоритетом занял слот один",
      slots2.topgw === "Высокий" && !slots2.closerouter, JSON.stringify(slots2));
    const queue2 = await admin.locator(".a-prov-order").innerText();
    t("свой провайдер стал первым в очереди", /1\.\s*Верхний/.test(queue2), queue2.replace(/\n/g, " "));
    t("в очереди по-прежнему ровно по одному на слот",
      (queue2.match(/Высокий|Высок/g) || []).length <= 1, queue2.replace(/\n/g, " "));
    // Возвращаем стандартную раскладку, чтобы следующие сценарии шли по ней.
    await admin.evaluate(async () => {
      await fetch("/api/admin/providers/slots", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slots: { high: "closerouter", medium: "gptunnel", low: null } }),
      });
      await fetch("/api/admin/providers/topgw", { method: "DELETE", credentials: "same-origin" });
    });
    await openSection(admin);

    // ---------------- P3: открытие модалки --------------------------------
    section("P3 клик по карточке открывает деталь");
    const cardOf = (id) => `.a-prov-card:has(.a-prov-card__open[onclick*="/providers/${id}"])`;
    await admin.click(`${cardOf("fakegw")} .a-prov-card__open`);
    await admin.waitForSelector("#provDetailModel", { timeout: 15000 });
    t("панель управления открылась для своей карточки",
      (await admin.locator(".a-page-title").innerText()).includes("Фейковый шлюз"),
      await admin.locator(".a-page-title").innerText());
    t("в панели видно название для ученика",
      await admin.locator("#provDetailModelTitle").count() === 1);
    t("без названия страница честно предупреждает «нет названия»",
      (await admin.locator(".a-page-badges").innerText()).includes("нет названия"),
      await admin.locator(".a-page-badges").innerText());
    t("в панели сегмент приоритета (а не выпадающий список)",
      await admin.locator("#provSlotSeg .a-seg2__btn").count() === 4
      && await admin.locator("#provSlotSeg select").count() === 0);
    t("на открытой панели изменений нет — подсказки не кричат «не применено»",
      await admin.locator(".a-field__hint--dirty").count() === 0,
      await admin.locator(".a-field__hint").allTextContents());
    // Страница — не модалка: у неё своя шапка с состоянием, сетка в две колонки
    // и закреплённая панель действий (иначе «сохранить» приходилось бы искать
    // прокруткой до низа длинной страницы).
    t("это страница, а не модалка", await admin.evaluate(() => {
      const grid = document.querySelector(".a-page-grid");
      const modal = document.querySelector(".a-modal-backdrop");
      return !!grid && !modal && !!document.querySelector(".a-sticky-actions");
    }), "осталась модалка или нет сетки страницы");
    t("на странице две колонки (настройки и состояние)",
      await admin.evaluate(() => document.querySelectorAll(".a-page-col").length === 2));
    t("панель действий закреплена снизу", await admin.evaluate(() => {
      const el = document.querySelector(".a-sticky-actions");
      if (!el) return false;
      return getComputedStyle(el).position === "sticky";
    }), "кнопка сохранения не закреплена");
    // Клик по сегменту обязан менять подпись: тут была ошибка с несуществующей
    // константой — сегмент выглядел рабочим, а клик ронял обработчик.
    await admin.click("#provSlotSeg .a-seg2__btn[data-slot='low']");
    t("клик по сегменту приоритета отмечает его и обновляет подпись",
      await admin.locator("#provSlotSeg .a-seg2__btn--on").getAttribute("data-slot") === "low"
      && (await admin.locator("#provSlotNote").innerText()).includes("Низкий"),
      await admin.locator("#provSlotNote").innerText());
    await admin.click("#provSlotSeg .a-seg2__btn[data-slot='']");
    t("в панели текущая модель", await admin.inputValue("#provDetailModel") === "alpha-pro");
    t("кнопка сброса есть", await admin.locator("#provResetBtn").count() === 1);
    // Перезагрузка прямо на странице провайдера: список в памяти пуст, и без
    // молчаливой догрузки страница всегда показывала «Провайдер не найден».
    await admin.reload();
    await admin.waitForSelector("#provDetailModel", { timeout: 15000 });
    t("перезагрузка на странице провайдера не даёт «не найден»",
      (await admin.locator(".a-page-title").innerText()).includes("Фейковый шлюз")
      && await admin.locator("text=Провайдер не найден").count() === 0,
      await admin.locator(".a-page-title").innerText());
    await openSection(admin);
    const probeCallsBefore = admin.provCalls.length;
    await admin.click(`${cardOf("fakegw")} .a-prov-actions button`);
    await sleep(2500);
    t("клик по «Проверить» не открывает модалку (вложенная кнопка)",
      (await admin.locator("#provDetailModel").count()) === 0, admin.provCalls.slice(probeCallsBefore).join(", "));

    // ---------------- P4: список моделей у провайдера ---------------------
    section("P4 список моделей берётся у провайдера");
    await admin.click(`${cardOf("fakegw")} .a-prov-card__open`);
    await admin.waitForSelector("#provModelsBtn", { timeout: 15000 });
    await admin.click("#provModelsBtn");
    // Ждём именно строки списка: клик асинхронный, скелетон рисуется раньше
    // данных, и чтение «сразу после клика» давало пустой список.
    await admin.waitForFunction(() => document.querySelectorAll(".a-model").length > 0, null, { timeout: 25000 });
    const opts = await admin.evaluate(() =>
      Array.from(document.querySelectorAll(".a-model__name")).map((el) => el.textContent.trim()));
    t("в списке ровно модели провайдера",
      JSON.stringify(opts) === JSON.stringify(GATEWAY_MODELS), opts.join(" | "));
    t("нативного <select size> в списке нет (старый вид)",
      await admin.locator("#provModelSelect").count() === 0 && await admin.locator("#provModelList select").count() === 0);
    t("модель помечена чипом «сейчас»", (await admin.locator(".a-model--picked").innerText()).includes("сейчас"),
      await admin.locator(".a-model--picked").innerText());
    t("запрос списка ушёл провайдеру (/models), не за конфигом",
      admin.provCalls.some((c) => c.includes("/api/admin/providers/fakegw/models")), admin.provCalls.join(" | "));
    // Фильтр: у шлюзов бывает сотня моделей, прокрутка их вручную бессмысленна.
    await admin.fill("#provModelFilter", "gam");
    await sleep(200);
    t("в строке списка виден вердикт и подпись действия",
      await admin.locator(".a-model .a-model__pick, .a-model .a-chip").count() > 0);
    t("фильтр сузил список до одной модели",
      (await admin.locator(".a-model").count()) === 1
      && (await admin.locator(".a-model__name").first().innerText()).includes("gamma-flash"),
      String(await admin.locator(".a-model").count()));
    await admin.fill("#provModelFilter", "");
    await sleep(200);

    // ---------------- P5: проверка выбранной модели -----------------------
    section("P5 проверка выбранной модели");
    await admin.click(".a-model:has-text('gamma-flash')");
    t("выбор из списка подставился в поле модели", await admin.inputValue("#provDetailModel") === "gamma-flash");
    // Выбор модели — это правка поля, а не применение: панель обязана сказать,
    // что сервер ещё ничего не принял (иначе админ закрывает её, думая, что
    // настройка уже действует).
    t("выбор модели помечен как «не применено»",
      await admin.locator("#provModelHint.a-field__hint--dirty").count() === 1
      && (await admin.locator("#provModelHint").innerText()).includes("не применено"),
      await admin.locator("#provModelHint").innerText());
    await admin.click("#provModelProbeBtn");
    await admin.waitForSelector("#provModelProbeResult .a-prov-checkok", { timeout: 20000 });
    t("живая модель отвечает — зелёный вердикт с моделью",
      (await admin.locator("#provModelProbeResult").innerText()).includes("gamma-flash"));
    await sleep(3200); // троттлинг между пробами — это by design, ждём окно
    await admin.fill("#provDetailModel", "beta-mini");
    await admin.click("#provModelProbeBtn");
    await admin.waitForSelector("#provModelProbeResult .a-prov-checkbad", { timeout: 20000 });
    const badText = await admin.locator("#provModelProbeResult").innerText();
    t("недоступная модель честно помечена (не «применяй сразу»)", badText.includes("beta-mini") && badText.includes("не отвечает"), badText);

    // ---------------- P6: применение --------------------------------------
    section("P6 применение выбранной модели");
    await admin.fill("#provDetailModel", "gamma-flash");
    const applyCalls = [];
    admin.on("request", (rq) => { if (rq.url().includes("/apply")) applyCalls.push(Date.now()); });
    const saveT0 = Date.now();
    await admin.click("#provDetailApply");
    // Сохранение мгновенное: ждём, пока панель перестанет показывать
    // несохранённые изменения (сервер модель НЕ дёргает).
    await admin.waitForFunction(() => {
      const el = document.getElementById("provApplyState");
      return el && !el.textContent.includes("несохранённые");
    }, null, { timeout: 20000 });
    const saveMs = Date.now() - saveT0;
    t("сохранение мгновенное: сервер не дёргает модель",
      saveMs < 2500 && admin.provCalls.every((c) => !c.includes("/probe-model ")),
      `${saveMs} мс`);
    // После сохранения страница ОСТАЁТСЯ открытой: раньше общий «тихий»
    // рефреш списка пересобирал каркас и выбрасывал в список провайдеров,
    // стирая и вердикт, и напечатанные поля.
    t("после сохранения страница провайдера остаётся открытой",
      await admin.locator("#provDetailApply").count() === 1
      && await admin.locator(".a-prov-card").count() === 0,
      String(await admin.locator(".a-prov-card").count()));
    t("кнопка сохранения без слов «и проверить»",
      (await admin.locator("#provDetailApply").innerText()).trim() === "Сохранить",
      await admin.locator("#provDetailApply").innerText());
    // Карточки живут в СПИСКЕ — возвращаемся туда и проверяем, что сохранение
    // доехало до него (на странице карточек нет и быть не должно).
    await openSection(admin);
    await admin.waitForFunction((id) => {
      const card = Array.from(document.querySelectorAll(".a-prov-card"))
        .find((c) => (c.querySelector(".a-prov-card__open")?.getAttribute("onclick") || "").includes(`/providers/${id}`));
      return card && card.querySelector(".a-prov-kv b")?.textContent === "gamma-flash";
    }, "fakegw", { timeout: 20000 });
    t("карточка обновилась после применения", await page_card_model(admin, "fakegw") === "gamma-flash", await page_card_model(admin, "fakegw"));
    const afterApply = await provCards(admin);
    const applied = afterApply.find((c) => c.id === "fakegw");
    t("карточка показывает новую модель и чип «модель изменена»",
      applied && applied.model === "gamma-flash" && applied.chips.includes("модель изменена"),
      JSON.stringify(applied && { model: applied.model, chips: applied.chips }));
    // Панель после сохранения остаётся открытой (вердикт проверки виден), а
    // карточка под ней обновляется — закрываем, чтобы следующий сценарий
    // открыл панель заново.
    await openSection(admin);

    // ---------------- P6b: название для ученика + слот одной кнопкой --------
    section("P6b название модели и приоритет в одной панели");
    await admin.click(`${cardOf("fakegw")} .a-prov-card__open`);
    await admin.waitForSelector("#provDetailModelTitle", { timeout: 15000 });
    await admin.fill("#provDetailModelTitle", "топ модель");
    await admin.click("#provSlotSeg .a-seg2__btn[data-slot='medium']");
    await admin.click("#provDetailApply");
    // Поля обновляются ПОСЛЕ ответа сервера (список провайдеров перечитывается),
    // поэтому ждём, а не проверяем в тот же кадр.
    const savedHere = admin.waitForResponse((r) => r.url().includes("/apply") && r.status() === 200,
                                           { timeout: 20000 });
    await savedHere;
    const dirtyCleared = await admin.waitForFunction(
      () => document.querySelectorAll(".a-field__hint--dirty").length === 0,
      null, { timeout: 15000 }).then(() => true).catch(() => false);
    t("отметка «не применено» погасла после сохранения", dirtyCleared,
      await admin.locator("#provModelHint").innerText());
    await openSection(admin);
    // Сохранение и перерисовка карточек идут последовательно (вердикт рисуется
    // сразу, список — после ответа), поэтому ждём именно карточку.
    await admin.waitForFunction(() => {
      const card = Array.from(document.querySelectorAll(".a-prov-card"))
        .find((c) => (c.querySelector(".a-prov-card__open")?.getAttribute("onclick") || "").includes("/providers/fakegw"));
      return card && Array.from(card.querySelectorAll(".a-prov-kv"))
        .some((r) => (r.querySelector("span")?.textContent || "").trim() === "Для ученика"
          && (r.querySelector("b")?.textContent || "").trim() === "топ модель");
    }, null, { timeout: 30000 });
    const fake2 = (await provCards(admin)).find((c) => c.id === "fakegw");
    const titleOnCard = await page_card_text(admin, "fakegw", "Для ученика");
    const slot2 = await slotLabels(admin);
    t("название для ученика видно на карточке", titleOnCard === "топ модель", String(titleOnCard));
    t("после задания названия предупреждение с карточки ушло",
      !(await provCards(admin)).find((c) => c.id === "fakegw").chips.includes("нет названия"),
      JSON.stringify((await provCards(admin)).find((c) => c.id === "fakegw").chips));
    t("приоритет применился той же кнопкой (слот — средний)",
      slot2.fakegw === "Средний", JSON.stringify(slot2));
    const api2 = await admin.evaluate(async () => {
      const r = await fetch("/api/admin/providers", { credentials: "same-origin" });
      return (await r.json());
    });
    const card2 = api2.providers.find((p) => p.id === "fakegw");
    t("сервер отдаёт modelTitle и displayTitle из конфига, а не из кода",
      card2.modelTitle === "топ модель" && card2.displayTitle === "топ модель",
      JSON.stringify({ modelTitle: card2.modelTitle, displayTitle: card2.displayTitle }));
    await openSection(admin);

// ---------------- P7: сброс своего ------------------------------------
    section("P7 сброс своего провайдера");
    await admin.click(`${cardOf("fakegw")} .a-prov-card__open`);
    await admin.waitForSelector("#provResetBtn", { timeout: 15000 });
    admin.once("dialog", (d) => d.accept());
    await admin.click("#provResetBtn");
    await admin.waitForFunction(() => {
      const el = document.getElementById("provDetailModel");
      return el && el.value === "alpha-pro";
    }, null, { timeout: 20000 });
    t("сброс вернул модель, с которой провайдер был добавлен",
      await admin.inputValue("#provDetailModel") === "alpha-pro", await admin.inputValue("#provDetailModel"));
    t("сброс снял и название для ученика",
      await admin.inputValue("#provDetailModelTitle") === "", await admin.inputValue("#provDetailModelTitle"));

    // ---------------- P8/P9: сброс встроенного -----------------------------
    section("P8 сброс встроенного к значениям окружения");
    const applyStatus = await admin.evaluate(async () => {
      const r = await fetch("/api/admin/providers/closerouter/apply", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "anthropic/claude-3-5-haiku" }),
      });
      const b = await r.json().catch(() => ({}));
      return { status: r.status, model: (b.provider || {}).model, warning: b.warning || null, error: b.error || null };
    });
    t("применение модели встроенному провайдеру сохранилось",
      applyStatus.status === 200 && applyStatus.model === "anthropic/claude-3-5-haiku",
      JSON.stringify(applyStatus));
    await openSection(admin);
    const builtinCard = (await provCards(admin)).find((c) => c.id === "closerouter");
    t("после применения у встроенного чип «модель изменена»",
      builtinCard && builtinCard.chips.includes("модель изменена") && builtinCard.model === "anthropic/claude-3-5-haiku",
      JSON.stringify(builtinCard && { model: builtinCard.model, chips: builtinCard.chips }));
    await admin.click(`${cardOf("closerouter")} .a-prov-card__open`);
    await admin.waitForSelector("#provResetBtn", { timeout: 15000 });
    t("кнопка сброса есть и у встроенного провайдера", await admin.locator("#provResetBtn").count() === 1);
    t("на странице видна и текущая, и стандартная модель",
      (await admin.locator(".a-field__hint").first().innerText()).includes("anthropic/claude-sonnet-5"),
      await admin.locator(".a-field__hint").first().innerText());
    admin.once("dialog", (d) => d.accept());
    await admin.click("#provResetBtn");
    await admin.waitForFunction(() => {
      const el = document.getElementById("provDetailModel");
      return el && el.value === "anthropic/claude-sonnet-5";
    }, null, { timeout: 20000 });
    await openSection(admin);
    const builtinAfter = (await provCards(admin)).find((c) => c.id === "closerouter");
    t("сброс вернул модель ИЗ ОКРУЖЕНИЯ (деплой — источник истины)",
      builtinAfter && builtinAfter.model === "anthropic/claude-sonnet-5" && !builtinAfter.chips.includes("модель изменена"),
      JSON.stringify(builtinAfter && { model: builtinAfter.model, chips: builtinAfter.chips }));

    // ---------------- P9: пинг ВСЕХ МОДЕЛЕЙ провайдера --------------------
    section("P9 пинг всех моделей провайдера");
    await admin.click(`${cardOf("fakegw")} .a-prov-card__open`);
    await admin.waitForSelector("#provPingModelsBtn", { timeout: 15000 });
    t("в панели кнопка «Пинг всех моделей», а не «пинг всех провайдеров»",
      (await admin.locator("#provPingModelsBtn").innerText()).includes("моделей"),
      await admin.locator("#provPingModelsBtn").innerText());
    const t0 = Date.now();
    await admin.click("#provPingModelsBtn");
    // Строки появляются СРАЗУ: пока ответа нет, модель уже показана как
    // «проверяем» — пустой экран не отвечает на вопрос «идёт ли проверка».
    await admin.waitForSelector("#provModelPingResult .a-ping .a-rank", { timeout: 10000 });
    const firstRowMs = Date.now() - t0;
    const pendingSeen = await admin.evaluate(() =>
      document.querySelectorAll("#provModelPingResult .a-rank--wait").length);
    await admin.waitForSelector("#provPingRows .a-rank--ok", { timeout: 10000 });
    const firstOkMs = Date.now() - t0;
    // Ждём завершения: живой счётчик исчезает, блок получает класс done.
    await admin.waitForSelector("#provModelPingResult .a-ping--done", { timeout: 20000 });
    const pingMs = Date.now() - t0;
    t("живой пинг: строки видны до ответа (спиннер, а не пустой экран)",
      pendingSeen > 0, `строк в ожидании: ${pendingSeen}`);
    t("живой пинг: первая строка появляется сразу", firstRowMs < 3000, `${firstRowMs} мс`);
    t("живой пинг: первый живой ответ — до бюджета", firstOkMs < 10000, `${firstOkMs} мс`);
    t("живой пинг укладывается в бюджет с запасом", pingMs < 13000, `${pingMs} мс`);
    t("живой пинг показывает время и итог по завершении",
      (await admin.locator("#provModelPingResult .a-ping__head").innerText()).includes("ответили"),
      await admin.locator("#provModelPingResult .a-ping__head").innerText());
    const modelPings = await admin.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("#provModelPingResult .a-rank"));
      return rows.map((r) => ({
        model: r.querySelector(".a-rank__name")?.textContent || "",
        ok: r.classList.contains("a-rank--ok"),
        label: r.querySelector(".a-rank__ms")?.textContent || "",
        bar: !!r.querySelector(".a-rank__bar"),
      }));
    });
    t("проверены ВСЕ модели этого провайдера, а не один провайдер",
      modelPings.length === 4, JSON.stringify(modelPings.map((p) => p.model)));
    t("рабочие модели отмечены как доступные",
      modelPings.filter((p) => p.ok).map((p) => p.model).sort().join(",") === "alpha-pro,gamma-flash",
      JSON.stringify(modelPings.filter((p) => p.ok).map((p) => p.model)));
    t("у недоступных моделей показана ПРИЧИНА, а не просто «недоступна»",
      modelPings.filter((p) => !p.ok).every((p) => /\d{3}|Неверный|доступн/.test(p.label)),
      JSON.stringify(modelPings.filter((p) => !p.ok).map((p) => p.label)));
    t("у работающих моделей видна задержка в мс и полоса",
      modelPings.filter((p) => p.ok).every((p) => p.label.includes("мс") && p.bar),
      JSON.stringify(modelPings.filter((p) => p.ok).map((p) => p.label)));
    // Название модели — всегда целиком: раньше строка резалась после точки
    // (max-width + ellipsis), и было непонятно, что именно проверялось.
    t("название модели в рейтинге — целиком, без обрезки", await admin.evaluate(() => {
      const names = Array.from(document.querySelectorAll("#provModelPingResult .a-rank__name"));
      if (!names.length) return false;
      return names.every((el) => {
        const cs = getComputedStyle(el);
        return cs.textOverflow !== "ellipsis" && cs.whiteSpace === "normal"
          && el.scrollWidth <= el.clientWidth + 2;
      });
    }), await admin.evaluate(() => Array.from(document.querySelectorAll("#provModelPingResult .a-rank__name")).map((el) => {
      const cs = getComputedStyle(el);
      return `${el.textContent.trim()}|${cs.textOverflow}|${cs.whiteSpace}|${el.scrollWidth}x${el.clientWidth}`;
    }).join(" ; ")));
    t("сводка честно считает проверенные модели",
      (await admin.locator("#provModelPingResult .a-ping__head").innerText()).includes("2")
      && (await admin.locator("#provModelPingResult .a-ping__head").innerText()).includes("ответили"),
      await admin.locator("#provModelPingResult .a-ping__head").innerText());
    // Порядок «от самых быстрых к остальным»: живые идут первыми, и среди них
    // сначала те, что ответили быстрее.
    t("живые модели в результате идут первыми",
      modelPings[0].ok === true && modelPings[1].ok === true, JSON.stringify(modelPings.map((p) => p.ok)));
    const okOrder = modelPings.filter((p) => p.ok).map((p) => Number(String(p.label).replace(/\D/g, "")));
    t("среди живых — по возрастанию задержки",
      okOrder.every((v, i) => i === 0 || okOrder[i - 1] <= v), JSON.stringify(okOrder));
    t("недоступные — в конце списка",
      modelPings.slice(2).every((p) => !p.ok), JSON.stringify(modelPings.map((p) => p.ok)));
    t("проверка моделей идёт пачками, а не строго по очереди",
      pingMs < GATEWAY_MODELS.length * 400, `${pingMs} мс на ${GATEWAY_MODELS.length} модели`);
    // Клик по строке результата выбирает модель — зачем ещё искать в списке.
    await admin.click("#provModelPingResult .a-rank:has-text('gamma-flash')");
    t("клик по модели в результате выбрал её", await admin.inputValue("#provDetailModel") === "gamma-flash",
      await admin.inputValue("#provDetailModel"));
    t("и выбор из рейтинга тоже помечен как «не применено»",
      await admin.locator("#provModelHint.a-field__hint--dirty").count() === 1);
    t("вердикт пинга виден и в списке моделей (точки)",
      (await admin.locator(".a-model .a-dot").count()) >= 4,
      String(await admin.locator(".a-model .a-dot").count()));
    await shot(admin, "admin-providers-panel-light-ping.png");
    await admin.evaluate(() => { const b = document.querySelector(".a-pnl__body"); if (b) b.scrollTop = 0; });
    await sleep(200);
    await shot(admin, "admin-providers-panel-light.png");
    await openSection(admin);

    // ---------------- P8b: страница добавления провайдера ------------------
    section("P8b добавление провайдера — страница, не модалка");
    await openSection(admin);
    await admin.click("#provBody .a-card__head button:has-text('Добавить')");
    await admin.waitForSelector("#provBaseUrl", { timeout: 15000 });
    t("форма добавления открылась СТРАНИЦЕЙ (без модалки)",
      await admin.evaluate(() => !!document.querySelector(".a-page-grid")
        && !document.querySelector(".a-modal-backdrop")),
      "осталась модалка");
    t("на странице видны занятые слоты (подсказка не врёт)",
      (await admin.locator("#provNewSlotNote").innerText()).length > 0,
      await admin.locator("#provNewSlotNote").innerText());
    await shot(admin, "admin-providers-new-page.png");
    t("приоритет на странице добавления — сегмент, а не выпадающий список",
      await admin.locator("#provNewSlotSeg .a-seg2__btn").count() === 4
      && await admin.locator("#provNewSlotSeg select").count() === 0);
    await admin.click("#provNewSlotSeg .a-seg2__btn[data-slot='medium']");
    t("клик по сегменту обновляет подсказку",
      (await admin.locator("#provNewSlotNote").innerText()).includes("Средний"),
      await admin.locator("#provNewSlotNote").innerText());
    // Пустая форма — ошибка у поля, а не ответ API после нажатия.
    await admin.click("#provSave");
    t("пустая форма ругается у себя, не уходя на сервер",
      (await admin.locator("#provFormError").innerText()).includes("ID провайдера")
      && !admin.provCalls.some((c) => c.includes("POST /api/admin/providers ")),
      await admin.locator("#provFormError").innerText());
    const addT0 = Date.now();
    await admin.fill("#provId", "fastgw");
    await admin.fill("#provTitle", "Быстрый шлюз");
    await admin.fill("#provBaseUrl", `http://127.0.0.1:${GATEWAY_PORT}/v1`);
    await admin.fill("#provModel", "alpha-pro");
    await admin.fill("#provModelTitle", "очень быстрая модель");
    await admin.fill("#provKey", "fake-secret-key-1234");
    const addCalls = [];
    admin.on("request", (rq) => { if (rq.url().endsWith("/api/admin/providers") && rq.method() === "POST") addCalls.push(Date.now()); });
    await admin.click("#provSave");
    await admin.waitForFunction(() => location.hash.includes("providers/fastgw"), null, { timeout: 20000 });
    const addMs = Date.now() - addT0;
    t("добавление мгновенное: сервер не дёргает модель",
      addMs < 2500 && addCalls.length === 1, `${addMs} мс, запросов: ${addCalls.length}`);
    await admin.waitForSelector("#provDetailModel", { timeout: 15000 });
    t("после добавления сразу открылась страница нового провайдера",
      (await admin.inputValue("#provDetailModel")) === "alpha-pro"
      && (await admin.inputValue("#provDetailModelTitle")) === "очень быстрая модель",
      `${await admin.inputValue("#provDetailModel")} / ${await admin.inputValue("#provDetailModelTitle")}`);
    t("название для ученика сохранено при добавлении",
      await admin.locator(".a-field__hint--dirty").count() === 0,
      await admin.locator("#provTitleHint").innerText());

    // ---------------- P8c: шаблоны протокола + мышление + заголовки -------
    section("P8c шаблоны протокола и уровень мышления");
    // Форма добавления: сегмент шаблонов виден сразу, по умолчанию OpenAI.
    await openSection(admin);
    await admin.click("#provBody .a-card__head button:has-text('Добавить')");
    await admin.waitForSelector("#provBaseUrl", { timeout: 15000 });
    t("на странице добавления есть сегмент шаблонов (по умолчанию OpenAI)",
      await admin.locator("#provNewProtoSeg .a-seg2__btn").count() === 3
      && await admin.locator("#provNewProtoSeg .a-seg2__btn[data-proto='anthropic']").count() === 1
      && await admin.locator("#provNewProtoSeg .a-seg2__btn--on").getAttribute("data-proto") === "chat");
    t("мышление — сегмент из 5 (Стандарт по умолчанию), а не текст",
      await admin.locator("#provNewEffortSeg .a-seg2__btn").count() === 5
      && await admin.locator("#provNewEffortSeg .a-seg2__btn--on").getAttribute("data-effort") === "");
    t("у OpenAI-шаблона заголовки видны (шлются при любом шаблоне), подклейка видна",
      await admin.locator("#provNewHeaders").isVisible()
      && await admin.locator("#provMerge").isVisible());
    await admin.click("#provNewProtoSeg .a-seg2__btn[data-proto='responses']");
    t("шаблон Responses показывает заголовки и прячет подклейку",
      await admin.locator("#provNewHeaders").isVisible()
      && await admin.locator("#provMerge").isHidden());
    await admin.click("#provNewEffortSeg .a-seg2__btn[data-effort='high']");
    t("клик по мышлению обновляет подсказку",
      (await admin.locator("#provNewEffortNote").innerText()).includes("Высок"),
      await admin.locator("#provNewEffortNote").innerText());
    await shot(admin, "admin-providers-new-responses.png");
    // Черновик Responses против chat-only шлюза: обязан упасть на /responses
    // (404), а не пройти по chat-пути — иначе шаблон не переключает протокол.
    await admin.fill("#provBaseUrl", `http://127.0.0.1:${GATEWAY_PORT}/v1`);
    await admin.fill("#provModel", "alpha-pro");
    await admin.fill("#provKey", "fake-secret-key-1234");
    await admin.click("#provDraftBtn");
    await admin.waitForFunction(
      () => /можно добавлять|недоступна/.test(
        (document.querySelector("#provDraftResult") || {}).textContent || ""),
      null, { timeout: 20000 });
    t("черновик Responses проверяется своим протоколом (/responses → 404 шлюза)",
      (await admin.locator("#provDraftResult").innerText()).includes("404"),
      await admin.locator("#provDraftResult").innerText());
    await sleep(3500); // троттлинг черновиков — вторая проба только после паузы
    await admin.click("#provNewProtoSeg .a-seg2__btn[data-proto='chat']");
    await admin.click("#provDraftBtn");
    await admin.waitForFunction(
      () => (document.querySelector("#provDraftResult") || {}).textContent.includes("можно добавлять"),
      null, { timeout: 20000 });
    t("тот же черновик шаблоном OpenAI проверяется и проходит",
      (await admin.locator("#provDraftResult").innerText()).includes("можно добавлять"));

    // Страница провайдера: шаблон, мышление и заголовки сохраняются.
    await openSection(admin);
    await admin.click(".a-prov-card:has-text('Быстрый шлюз') .a-prov-card__open");
    await admin.waitForSelector("#provDetailModel", { timeout: 15000 });
    t("на странице свой провайдер видит шаблон (по умолчанию OpenAI)",
      await admin.locator("#provProtoSeg .a-seg2__btn").count() === 3
      && await admin.locator("#provProtoSeg .a-seg2__btn--on").getAttribute("data-proto") === "chat");
    await admin.click("#provProtoSeg .a-seg2__btn[data-proto='responses']");
    // Кнопки добавления заголовка — по тексту, id у неё нет.
    await admin.click("button:has-text('+ Заголовок')");
    const hrows = admin.locator("#provHeaders [data-hrow]");
    await hrows.last().locator("[data-hname]").fill("x-test");
    await hrows.last().locator("[data-hvalue]").fill("1");
    await admin.click("#provEffortSeg .a-seg2__btn[data-effort='high']");
    t("правка шаблона/мышления/заголовков зажигает «не сохранено»",
      (await admin.locator("#provApplyState").innerText()).includes("несохранённые"),
      await admin.locator("#provApplyState").innerText());
    await admin.click("#provDetailApply");
    await admin.waitForFunction(
      () => (document.querySelector("#provApplyState") || {}).textContent.trim() === "",
      null, { timeout: 20000 });
    const fastgw = await admin.evaluate(async () => {
      const r = await fetch("/api/admin/providers", { credentials: "same-origin" });
      const d = await r.json();
      return (d.providers || []).find((p) => p.id === "fastgw");
    });
    t("шаблон+мышление+заголовки доехали до сервера",
      fastgw && fastgw.protocol === "responses" && fastgw.reasoningEffort === "high"
      && fastgw.extraHeaders && fastgw.extraHeaders["x-test"] === "1",
      JSON.stringify({ p: fastgw && fastgw.protocol, e: fastgw && fastgw.reasoningEffort }));
    await admin.reload({ waitUntil: "domcontentloaded" });
    await admin.waitForSelector("#provDetailModel", { timeout: 15000 });
    t("после reload: чип Responses, заголовки на месте, подклейка скрыта",
      (await admin.locator(".a-page-badges").innerText()).includes("Responses")
      && await admin.locator("#provHeaders [data-hrow]").count() === 1
      && (await admin.locator("#provHeaders [data-hname]").inputValue()) === "x-test"
      && await admin.locator("#provMerge").isHidden());
    await shot(admin, "admin-providers-detail-responses.png");
    // Живая проверка: шлюз chat-only, на /responses отдаёт 404 — это ошибка
    // формата, поэтому модель проверяется по chat, а шаблон переключается сам.
    await admin.click("#provModelProbeBtn");
    await admin.waitForFunction(
      () => (document.querySelector("#provModelProbeResult") || {}).textContent.includes("Её можно применять"),
      null, { timeout: 30000 });
    t("проверка модели переключает шаблон на тот, которым модель ответила (404 на /responses — формат)",
      await admin.locator("#provProtoSeg .a-seg2__btn--on").getAttribute("data-proto") === "chat"
      && (await admin.locator("#provModelProbeResult").innerText()).includes("переключ"),
      await admin.locator("#provModelProbeResult").innerText());
    // Возвращаем как было: chat без заголовков в отправке (скрытые хранятся).
    await admin.click("#provProtoSeg .a-seg2__btn[data-proto='chat']");
    await admin.click("#provDetailApply");
    await admin.waitForFunction(
      () => (document.querySelector("#provApplyState") || {}).textContent.trim() === "",
      null, { timeout: 20000 });
    const fastgw2 = await admin.evaluate(async () => {
      const r = await fetch("/api/admin/providers", { credentials: "same-origin" });
      const d = await r.json();
      return (d.providers || []).find((p) => p.id === "fastgw");
    });
    t("возврат на chat не стирает скрытые заголовки",
      fastgw2 && fastgw2.protocol === "chat"
      && fastgw2.extraHeaders && fastgw2.extraHeaders["x-test"] === "1",
      JSON.stringify(fastgw2 && fastgw2.extraHeaders));

    // ---------------- P9b: проверка всех ПРОВАЙДЕРОВ (другая кнопка) ------
    section("P9b проверка всех провайдеров в разделе");
    await openSection(admin);
    await admin.click("#provProbeAllBtn");
    await admin.waitForSelector("#provPingAllResult .a-prov-ping", { timeout: 40000 });
    const pingRows = await admin.locator("#provPingAllResult .a-prov-ping").allTextContents();
    // Провайдеров стало 4: добавили «Быстрый шлюз» на странице выше.
    t("в разделе проверяются ПРОВАЙДЕРЫ: строка по каждому",
      pingRows.length === 4 && pingRows.some((s) => s.includes("Фейковый шлюз")), pingRows.join(" | "));
    t("у живого провайдера показана задержка в мс", /мс/.test(pingRows.join(" ")), pingRows.join(" | "));
    t("у недоступного показана причина, а не тишина",
      pingRows.some((s) => /доступен|401|Неверный/.test(s)), pingRows.join(" | "));

    // ---------------- P2c: направления free / Plus --------------------------
    section("P2c направления free и Plus: одинаковый функционал, разный конфиг");
    // Клон при старте детерминированно покрыт юнитом (ai-tiers.py): здесь —
    // изоляция мутаций сквозняком через UI. (Клон одноразовый: провайдер,
    // добавленный во free ПОСЛЕ первого чтения Plus, туда сам не приезжает —
    // направления независимы, иначе новый шлюз молча попал бы в ротацию Plus.)
    const tierIds = async (page, tier) => page.evaluate(async (t) => {
      const r = await fetch(`/api/admin/providers?tier=${t}`, { credentials: "same-origin" });
      const d = await r.json();
      return { ids: (d.providers || []).map((p) => p.id).sort(), judge: (d.essayJudge || {}).provider || null,
               slots: d.slots || {}, tier: d.tier || null };
    }, tier);
    const waitPlusTab = () => admin.waitForFunction(
      () => (document.querySelector("[aria-label='Направление маршрутизации'] .a-seg__btn--active") || {}).textContent === "Plus",
      null, { timeout: 15000 });
    const waitFreeTab = () => admin.waitForFunction(
      () => (document.querySelector("[aria-label='Направление маршрутизации'] .a-seg__btn--active") || {}).textContent === "Обычные",
      null, { timeout: 15000 });
    t("вкладки направлений видны, по умолчанию обычные",
      await admin.locator("[role='tablist'][aria-label='Направление маршрутизации'] button").count() === 2
      && await admin.evaluate(() => localStorage.getItem("ege_admin_prov_tier") !== "plus"));
    await admin.click("button[onclick=\"setProvTier('plus')\"]");
    await waitPlusTab();
    t("переключение на Plus обновляет список",
      (await admin.locator(".a-prov-card").count()) >= 1);
    // Добавление в Plus через форму: свой реестр, во free его нет.
    await admin.click("#provBody .a-card__head button:has-text('Добавить')");
    await admin.waitForSelector("#provBaseUrl", { timeout: 15000 });
    await admin.fill("#provId", "plusgw2");
    await admin.fill("#provBaseUrl", `http://127.0.0.1:${GATEWAY_PORT}/v1`);
    await admin.fill("#provModel", "alpha-pro");
    await admin.fill("#provKey", "plus-secret-1");
    await admin.click("#provSave");
    await admin.waitForFunction(() => location.hash.includes("providers/plusgw2"), null, { timeout: 20000 });
    await admin.waitForSelector("#provDetailModel", { timeout: 15000 });
    const plusView = await tierIds(admin, "plus");
    const freeView = await tierIds(admin, "free");
    t("созданный в Plus провайдер есть только в Plus",
      plusView.ids.includes("plusgw2") && !freeView.ids.includes("plusgw2"),
      JSON.stringify({ plus: plusView.ids, free: freeView.ids }));
    // Судья отдельно на направление: ставим в Plus через радио, free не двигается.
    await openSection(admin);
    await admin.click("button[onclick=\"setProvTier('plus')\"]");
    await waitPlusTab();
    await admin.click(".a-judge-opt input[type='radio'][value='plusgw2']");
    await admin.waitForFunction(async () => {
      const r = await fetch("/api/admin/providers?tier=plus", { credentials: "same-origin" });
      const d = await r.json();
      return ((d.essayJudge || {}).provider || "") === "plusgw2";
    }, null, { timeout: 20000 });
    const freeJudge = (await tierIds(admin, "free")).judge;
    t("судья Plus не двигает судью free",
      (await tierIds(admin, "plus")).judge === "plusgw2" && freeJudge !== "plusgw2",
      `free=${freeJudge}`);
    // Слот отдельно на направление: двигаем в Plus через селект карточки.
    await admin.selectOption(".a-prov-card:has(.a-prov-card__open[onclick*='/providers/plusgw2']) .a-prov-slot", "low");
    await sleep(800);
    const plusSlots = (await tierIds(admin, "plus")).slots;
    const freeSlots = (await tierIds(admin, "free")).slots;
    t("слот в Plus не двигает очередь free",
      plusSlots.low === "plusgw2" && freeSlots.low !== "plusgw2",
      JSON.stringify({ plus: plusSlots, free: freeSlots }));
    // Чистим за собой: удаление и снятие судьи идут с query/body-тиром.
    await admin.evaluate(async () => {
      await fetch("/api/admin/providers/plusgw2?tier=plus", { method: "DELETE", credentials: "same-origin" });
      await fetch("/api/admin/providers/judge", { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "", tier: "plus" }) });
    });
    const plusClean = await tierIds(admin, "plus");
    t("удаление в Plus не трогает free",
      !plusClean.ids.includes("plusgw2")
      && (await tierIds(admin, "free")).ids.includes("fastgw"));
    await admin.click("button[onclick=\"setProvTier('free')\"]");
    await waitFreeTab();
    t("возврат на free, тир пережил навигацию по localStorage",
      await admin.evaluate(() => localStorage.getItem("ege_admin_prov_tier")) === "free");

    // ---------------- P9c удаление в два шага + восстановление ------------
    section("P9c удаление встроенного и своего одинаково, в два шага");
    await admin.evaluate(async (gw) => {
      await fetch("/api/admin/providers", { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "delgw", title: "Шлюз на удаление",
          base_url: gw + "/v1", model: "alpha-pro", api_key: "k" }) });
    }, `http://127.0.0.1:${GATEWAY_PORT}`);
    await openSection(admin);
    const trashOf = (id) => `.a-prov-card:has(.a-prov-card__open[onclick*="/providers/${id}"]) button[onclick*="deleteProvider"]`;
    t("корзина есть и у встроенного, и у своего",
      await admin.locator(trashOf("closerouter")).count() === 1
      && await admin.locator(trashOf("delgw")).count() === 1);
    // Шаг 1: модалка с последствием, удаления ещё нет.
    await admin.click(trashOf("delgw"));
    await admin.waitForSelector(".a-modal-backdrop #mNext", { timeout: 15000 });
    t("шаг 1: модалка предупреждает, провайдер ещё на месте",
      (await admin.locator(".a-modal-backdrop").innerText()).includes("delgw")
      && await admin.locator(trashOf("delgw")).count() === 1);
    // Шаг 2: без ввода ID — отказ, с чужим ID — отказ, со своим — удаление.
    await admin.click("#mNext");
    await admin.waitForSelector(".a-modal-backdrop #fDelProv", { timeout: 15000 });
    await admin.click("#mDo");
    t("шаг 2 без ввода: отказ с подсказкой",
      (await admin.locator(".a-modal-backdrop").innerText()).includes("ID не совпадает"));
    await admin.fill("#fDelProv", "чужой");
    await admin.click("#mDo");
    t("шаг 2 с чужим ID: отказ",
      (await admin.locator(".a-modal-backdrop").innerText()).includes("ID не совпадает"));
    await admin.fill("#fDelProv", "delgw");
    await admin.click("#mDo");
    await admin.waitForFunction(() => !document.querySelector(".a-modal-backdrop"), null, { timeout: 20000 });
    await admin.waitForFunction(() => !document.querySelector(".a-prov-card__open[onclick*='/providers/delgw']"), null, { timeout: 20000 });
    t("свой удалён через модалку в два шага", true);
    // Встроенный — тем же путём, затем восстановление из списка.
    await admin.click(trashOf("closerouter"));
    await admin.waitForSelector(".a-modal-backdrop #mNext", { timeout: 15000 });
    t("встроенный: шаг 1 говорит про кнопку «Восстановить»",
      (await admin.locator(".a-modal-backdrop").innerText()).includes("Восстановить"));
    await admin.click("#mNext");
    await admin.waitForSelector(".a-modal-backdrop #fDelProv", { timeout: 15000 });
    await admin.fill("#fDelProv", "closerouter");
    await admin.click("#mDo");
    await admin.waitForFunction(() => !document.querySelector(".a-modal-backdrop"), null, { timeout: 20000 });
    await admin.waitForFunction(() => !document.querySelector(".a-prov-card__open[onclick*='/providers/closerouter']"), null, { timeout: 20000 });
    t("встроенный удалён тем же путём", true);
    t("появилась плашка удалённых с кнопкой восстановления",
      (await admin.locator("#provBody").innerText()).includes("Удалённые встроенные")
      && await admin.locator("#provBody button:has-text('Восстановить')").count() === 1);
    await admin.click("#provBody button:has-text('Восстановить')");
    await admin.waitForSelector(".a-prov-card__open[onclick*='/providers/closerouter']", { timeout: 20000 });
    t("встроенный восстановлен из списка", true);
    t("плашка удалённых исчезла",
      !(await admin.locator("#provBody").innerText()).includes("Удалённые встроенные"));

    // ---------------- ошибок в консоли нет --------------------------------
    section("P10 ошибок в консоли нет");
    t("ни одной необработанной ошибки на странице раздела", !admin.errors.length, admin.errors.join(" | "));

    // ---------------- панель на телефоне и в тёмной теме -------------------
    // Дизайн панели смотреть надо в обоих режимах: сегмент приоритета и
    // рейтинг моделей — новые элементы, у них нет проверенной вёрстки.
    if (process.env.EGE_SHOTS) {
      const mobCtx = await browser.newContext({ viewport: { width: 390, height: 780 } });
      const mob = await newPage(mobCtx);
      await loginAdmin(mob);
      // Второй свой провайдер на ТОТ Ж шлюз: пинг моделей троттлится на
      // провайдера (20 с), и повторный пинг того же fakegw в этом же прогоне
      // честно вернул бы 429 — это путало бы скриншот с проверкой вёрстки.
      const made = await mob.evaluate(async (gw) => {
        const r = await fetch("/api/admin/providers", {
          method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: "mobilgw", title: "Шлюз для телефона",
            base_url: gw + "/v1", model: "gamma-flash",
            api_key: "fake-secret-key-1234", auth: "bearer",
            model_title: "быстрая модель",
          }),
        });
        return r.status;
      }, `http://127.0.0.1:${GATEWAY_PORT}`);
      t("второй свой провайдер для мобильной вёрстки добавлен", made === 200, String(made));
      await openSection(mob);
      await mob.click(`${cardOf("mobilgw")} .a-prov-card__open`);
      await mob.waitForSelector("#provPingModelsBtn", { timeout: 15000 });
      await mob.click("#provPingModelsBtn");
      await mob.waitForSelector("#provModelPingResult .a-rank", { timeout: 40000 });
      await mob.locator("#provModelPingResult").scrollIntoViewIfNeeded();
      await sleep(250);
      await shot(mob, "admin-providers-panel-mobile.png");
      // Страница не должна ездить по горизонтали: раньше на телефоне это
      // делала модалка (двухколоночная сетка внутри узкого блока).
      t("на телефоне страница помещается по ширине", await mob.evaluate(() => {
        const doc = document.scrollingElement;
        return doc.scrollWidth <= window.innerWidth + 1;
      }), await mob.evaluate(() => `scrollWidth=${document.scrollingElement.scrollWidth} при ${window.innerWidth}`));
      t("на телефоне колонки страницы встают друг под друга", await mob.evaluate(() => {
        const cols = Array.from(document.querySelectorAll(".a-page-col"));
        if (cols.length < 2) return false;
        return cols[0].getBoundingClientRect().bottom <= cols[1].getBoundingClientRect().top + 2;
      }), "колонки остались в ряд");
      t("на телефоне сегмент приоритета в две колонки", await mob.evaluate(() => {
        const seg = document.getElementById("provSlotSeg");
        if (!seg) return false;
        const top = seg.getBoundingClientRect().top;
        return Array.from(seg.querySelectorAll(".a-seg2__btn"))
          .filter((b) => Math.abs(b.getBoundingClientRect().top - top) < 2).length === 2;
      }), "сегмент не перестроился в 2 колонки");
      // Кнопка сохранения должна быть доступна и на телефоне: панель действий
      // закреплена, поэтому её видно без прокрутки до низа длинной страницы.
      t("на телефоне кнопка сохранения в кадре", await mob.evaluate(() => {
        const el = document.getElementById("provDetailApply");
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight + 1;
      }), "кнопка сохранения за пределами экрана");
      await mob.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
      await sleep(300);
      await shot(mob, "admin-providers-panel-mobile-dark.png");
      await mobCtx.close();
    }

    await adminCtx.close();
  } finally {
    if (browser) await browser.close().catch(() => {});
    proc.kill("SIGKILL");
    gateway.close();
  }
  console.log(`\n${failed ? "FAIL" : "OK"}: ${passed}/${passed + failed} браузерных проверок`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error("ошибка теста:", err && err.stack || err);
  process.exit(1);
});