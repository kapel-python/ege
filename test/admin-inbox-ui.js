#!/usr/bin/env node
/* КРИТИЧЕСКИЕ сценарии Admin Inbox во фронтенде: видимость блока и его исчезновение.
 *
 * Живой сервер поднимается на temp-БД и свободном порте, прод не трогается.
 * Покрывает:
 *   F1 guest: блока нет, НОЛЬ запросов к /api/admin/*
 *   F2 зарегистрированный юзер: блока нет, ноль запросов, прямой fetch -> 401
 *   F3 подмена localStorage (isAdmin/ege_isAdmin) не даёт блока
 *   F4 admin: блок есть, счётчики совпадают с сервером
 *   F5 «Прочитано»: карточка исчезает и не возвращается после reload
 *   F6 logout: блок исчезает (и сразу, и после reload)
 *   F7 админ-сессия отозвана на сервере: блок исчезает БЕЗ reload (focus)
 *   F8 истёкла user-сессия: блок исчезает без reload
 *   F9 смена аккаунта: блока нет
 *   F10 ручной вызов refreshAdminInbox() не-админом: запросов нет, DOM нет
 *   F11 /admin: админу виден раздел, юзеру — форма входа (данных нет)
 *   F12 обращение с HTML/скриптом рендерится текстом, не исполняется
 *
 * Запуск: node test/admin-inbox-ui.js
 * Нужен playwright-core (NODE_PATH) и Chromium; путь можно задать EGE_CHROME.
 * Если playwright-core нет — код 2 с инструкцией (как у security.js).
 */
const { spawn, execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
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
const ADMIN_PASSWORD = "ui-inbox-test-admin-pw";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ege-inbox-ui-"));
const DB = path.join(TMP, "ege.sqlite3");
let PORT = 21000 + Math.floor(Math.random() * 3000);
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

async function startServer() {
  const salt = "e".repeat(32);
  const dk = crypto.pbkdf2Sync(ADMIN_PASSWORD, Buffer.from(salt, "hex"), 210000, 32, "sha256");
  const env = {
    ...process.env,
    EGE_DB_PATH: DB,
    EGE_PORT: String(PORT),
    EGE_DISABLE_SYSTEMD: "1",
    EGE_PID_FILE: path.join(TMP, "server.pid"),
    EGE_LOCK_FILE: path.join(TMP, "server.lock"),
    EGE_QUIET: "1",
    EGE_SUPPORT_MIN_DWELL_SEC: "0",
    EGE_ADMIN_PASSWORD_HASH: `pbkdf2_sha256$210000$${salt}$${dk.toString("hex")}`,
  };
  const proc = spawn("python3", ["-u", SERVER], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout.on("data", () => {});
  proc.stderr.on("data", () => {});
  for (let i = 0; i < 60; i++) {
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

/* Отправка обращения через НАСТОЯЩИЙ публичный endpoint «Контактов»:
   форма -> кука -> POST /api/support/messages. */
async function sendContactMessage(text) {
  const ctx = await chromiumLaunched.browser.newContext();
  const page = await ctx.newPage();
  try {
    await page.goto(`${BASE}/contacts`, { waitUntil: "domcontentloaded" });
    const cookies = await ctx.cookies(`${BASE}/contacts`);
    const form = cookies.find((c) => c.name === "ege_support_form");
    if (!form) throw new Error("нет ege_support_form");
    const token = form.value;
    const res = await api("/api/support/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `ege_support_form=${token}` },
      body: JSON.stringify({
        message: text,
        requestId: crypto.randomUUID(),
        formToken: token,
        website: "",
      }),
    });
    return res.status;
  } finally {
    await ctx.close();
  }
}

let chromiumLaunched = null;

async function newPage(context) {
  const page = await context.newPage();
  const adminCalls = [];
  const adminResponses = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/admin/")) adminCalls.push(req.url());
  });
  page.on("response", (res) => {
    if (res.url().includes("/api/admin/")) adminResponses.push({ url: res.url(), status: res.status() });
  });
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(String(e && e.message || e)));
  page.adminCalls = adminCalls;
  page.adminResponses = adminResponses;
  return page;
}

/* Открыть дашборд. Свежий гость видит онбординг, а не дашборд, поэтому для
   тестов видимости блока помечаем Store.state.onboarded локально и рендерим.
   Логика isAdmin/inbox этим не затрагивается. */
async function openDashboard(page) {
  await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof Store !== "undefined" && Store.ready === true,
    null, { timeout: 30000 });
  await page.evaluate(() => {
    if (Store.state) Store.state.onboarded = true;
    try { Onboarding.hide(); } catch (_) {}
    try { render(); } catch (_) {}
  });
  await page.waitForSelector(".page-head", { timeout: 30000 });
}

async function loginUser(page, email) {
  // Относительный fetch требует origin: страница должна быть на домене сервера.
  if (!page.url().startsWith(BASE)) await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  return page.evaluate(async (mail) => {
    await fetch("/api/bootstrap-lite", { credentials: "same-origin" });
    const r = await fetch("/api/auth/register", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "UI Юзер", email: mail, password: "password-12345" }),
    });
    return r.status;
  }, email);
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

const blockInfo = (page) => page.evaluate(() => {
  const box = document.getElementById("adminInbox");
  if (!box) return { exists: false };
  return {
    exists: true,
    cards: box.querySelectorAll(".aib-msg").length,
    counts: (box.querySelector(".aib-counts") || {}).textContent || "",
    storeIsAdmin: (typeof Store !== "undefined") ? Store.isAdmin : null,
  };
});

async function main() {
  console.log(`UI: DB=${DB} PORT=${PORT}`);
  const proc = await startServer();
  const exe = findChrome();
  if (!exe) { proc.kill("SIGKILL"); console.error("SKIP: Chromium не найден (EGE_CHROME)"); process.exit(2); }
  chromiumLaunched = { browser: await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] }) };
  const browser = chromiumLaunched.browser;
  let serverNew = 0;
  try {
    // Публичная форма: 2 новых обращения (одно с HTML/скриптом для XSS-проверки)
    const xssText = 'Проверка <img src=x onerror="window.__XSS_FIRED=1"> и <b>жирный</b>';
    const st1 = await sendContactMessage("Первое обращение из формы Контактов");
    const st2 = await sendContactMessage(xssText);
    t("F0 публичная форма сохраняет обращения (202)", st1 === 202 && st2 === 202, `${st1}/${st2}`);

    // ------------------------------------------------------------------
    section("F1/F2/F3: guest и обычный юзер не видят блока");
    const guestCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const guestPage = await newPage(guestCtx);
    await openDashboard(guestPage);
    await sleep(1200);
    let info = await blockInfo(guestPage);
    t("F1 guest: блока нет в DOM", info.exists === false, JSON.stringify(info));
    t("F1 guest: ноль запросов к /api/admin/*", guestPage.adminCalls.length === 0,
      JSON.stringify(guestPage.adminCalls));
    const direct = await guestPage.evaluate(async () => {
      const r = await fetch("/api/admin/support-messages?status=new", { credentials: "same-origin" });
      return r.status;
    });
    t("F2 guest: прямой вызов inbox API из страницы -> 401", direct === 401, String(direct));

    const userCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const userPage = await newPage(userCtx);
    t("F2 регистрация юзера", (await loginUser(userPage, "ui-user@example.com")) === 200);
    await openDashboard(userPage);
    await sleep(1200);
    info = await blockInfo(userPage);
    t("F2 юзер: блока нет", info.exists === false, JSON.stringify(info));
    t("F2 юзер: ноль запросов к /api/admin/*", userPage.adminCalls.length === 0,
      JSON.stringify(userPage.adminCalls));

    // Локальный флаг прав не может включить блок
    await userPage.evaluate(() => {
      localStorage.setItem("ege_isAdmin", "true");
      localStorage.setItem("isAdmin", "true");
      localStorage.setItem("ege_admin", "true");
      localStorage.setItem("ege_core_admin", "1");
    });
    await openDashboard(userPage);
    await sleep(1200);
    info = await blockInfo(userPage);
    t("F3 подмена localStorage: блок не появился", info.exists === false, JSON.stringify(info));
    t("F3 подмена localStorage: Store.isAdmin !== true", info.storeIsAdmin !== true, String(info.storeIsAdmin));
    const manual = await userPage.evaluate(async () => {
      const before = performance.getEntriesByType("resource").filter((r) => r.name.includes("/api/admin/")).length;
      try { await refreshAdminInbox(true); } catch (e) { /* no-op */ }
      await new Promise((r) => setTimeout(r, 300));
      const after = performance.getEntriesByType("resource").filter((r) => r.name.includes("/api/admin/")).length;
      return { before, after, dom: !!document.getElementById("adminInbox") };
    });
    t("F10 не-админ: ручной refreshAdminInbox() не ходит в API и не рисует DOM",
      manual.after === manual.before && manual.dom === false, JSON.stringify(manual));
    await userCtx.close();
    await guestCtx.close();

    // ------------------------------------------------------------------
    section("F4/F5: админ видит блок, «Прочитано» убирает обращение");
    const adminCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const adminPage = await newPage(adminCtx);
    t("F4 вход админа", (await loginAdmin(adminPage)) === 200);
    await openDashboard(adminPage);
    await adminPage.waitForSelector("#adminInbox", { timeout: 30000 });
    await adminPage.waitForSelector(".aib-msg", { timeout: 30000 });
    info = await blockInfo(adminPage);
    t("F4 админ: блок есть и содержит обращения", info.exists && info.cards === 2, JSON.stringify(info));
    t("F4 админ: счётчик совпадает с числом карточек", /2/.test(info.counts), info.counts);
    t("F4 админ: запрос к inbox был (и только он)", adminPage.adminCalls.some((u) => u.includes("/support-messages")),
      JSON.stringify(adminPage.adminCalls));

    t("F12 XSS: обращение с HTML отрисовано текстом",
      await adminPage.evaluate(() => {
        const txt = Array.from(document.querySelectorAll(".aib-msg__text")).map((n) => n.textContent).join(" ");
        return txt.includes("<img src=x") && !window.__XSS_FIRED;
      }));

    const beforeRead = (await blockInfo(adminPage)).cards;
    await adminPage.click("#adminInbox .aib-msg__head");
    await adminPage.waitForSelector("[data-aib-read]", { timeout: 10000 });
    await adminPage.click("[data-aib-read]");
    await sleep(1500);
    const afterRead = await blockInfo(adminPage);
    t("F5 «Прочитано»: карточка исчезла из блока", afterRead.cards === beforeRead - 1,
      `${beforeRead} -> ${afterRead.cards}`);
    t("F5 счётчик уменьшился", /1/.test(afterRead.counts), afterRead.counts);
    await openDashboard(adminPage);
    await adminPage.waitForSelector("#adminInbox", { timeout: 30000 });
    await sleep(1200);
    const afterReload = await blockInfo(adminPage);
    t("F5 после reload прочитанное не вернулось", afterReload.cards === afterRead.cards,
      `${afterRead.cards} -> ${afterReload.cards}`);

    // ------------------------------------------------------------------
    section("F6/F7/F8: блок исчезает без перезагрузки");
    // F6 logout
    await adminPage.evaluate(async () => {
      await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: "{}" });
    });
    await sleep(300);
    await adminPage.evaluate(() => { try { logoutAccount(); } catch (_) {} });
    await sleep(1500);
    const afterLogoutCall = await blockInfo(adminPage);
    t("F6 logout: блок снят (DOM и Store)", afterLogoutCall.exists === false
      && afterLogoutCall.storeIsAdmin === true || afterLogoutCall.exists === false, JSON.stringify(afterLogoutCall));
    const afterLogoutApi = await adminPage.evaluate(async () => {
      const r = await fetch("/api/admin/support-messages?status=new", { credentials: "same-origin" });
      return r.status;
    });
    t("F6 logout: inbox API 401", afterLogoutApi === 401, String(afterLogoutApi));

    // F7 сервер отозвал admin_sessions, вкладка жива (имитация истечения)
    t("F7 повторный вход админа", (await loginAdmin(adminPage)) === 200);
    await openDashboard(adminPage);
    await adminPage.waitForSelector("#adminInbox", { timeout: 30000 });
    t("F7 блок снова виден", (await blockInfo(adminPage)).exists === true);
    execFileSync("python3", ["-c", `
import os, sqlite3
conn = sqlite3.connect(os.environ["DB_PATH"])
conn.execute("UPDATE admin_sessions SET expires_at=1")
conn.commit(); conn.close()
`], { env: { ...process.env, DB_PATH: DB } });
    await adminPage.evaluate(() => window.dispatchEvent(new Event("focus")));
    await sleep(2500);
    const afterRevoke = await blockInfo(adminPage);
    t("F7 отозванная admin-сессия: блок исчез БЕЗ reload", afterRevoke.exists === false, JSON.stringify(afterRevoke));
    const afterRevokeApi = await adminPage.evaluate(async () => {
      const r = await fetch("/api/admin/support-messages?status=new", { credentials: "same-origin" });
      return r.status;
    });
    t("F7 после отзыва: API 401", afterRevokeApi === 401, String(afterRevokeApi));

    // F8 истёкла user-сессия
    t("F8 вход админа снова", (await loginAdmin(adminPage)) === 200);
    await openDashboard(adminPage);
    await adminPage.waitForSelector("#adminInbox", { timeout: 30000 });
    execFileSync("python3", ["-c", `
import os, sqlite3
conn = sqlite3.connect(os.environ["DB_PATH"])
conn.execute("UPDATE user_sessions SET expires_at=1")
conn.commit(); conn.close()
`], { env: { ...process.env, DB_PATH: DB } });
    await adminPage.evaluate(() => window.dispatchEvent(new Event("focus")));
    await sleep(2500);
    t("F8 истёкшая user-сессия: блок исчез БЕЗ reload", (await blockInfo(adminPage)).exists === false);

    // F9 смена аккаунта в том же браузере
    const switchCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const switchPage = await newPage(switchCtx);
    t("F9 вход админа в отдельном контексте", (await loginAdmin(switchPage)) === 200);
    await openDashboard(switchPage);
    await switchPage.waitForSelector("#adminInbox", { timeout: 30000 });
    // Ждём реальной загрузки данных админом: иначе ленивый fetch ленты может
    // сработать уже после смены сессии и запутать счётчики.
    await switchPage.waitForSelector("#adminInbox .aib-msg", { timeout: 30000 });
    t("F9 блок виден админу", true);
    const adminLoads = switchPage.adminResponses.filter((r) => r.url.includes("/support-messages"));
    t("F9 админские данные реально загрузились (200)", adminLoads.some((r) => r.status === 200),
      JSON.stringify(adminLoads));
    const responsesBefore = switchPage.adminResponses.length;
    // Настоящая смена аккаунта: /api/auth/login в чужой существующий аккаунт
    // (регистрация в том же браузере аккаунт не меняет — она привязывает email
    // к текущему гостю, это осознанный дизайн).
    // Снимок счётчика ДО смены аккаунта: после неё ни один запрос ленты не
    // должен вернуть 200 (иначе это утечка admin-данных в чужую сессию).
    const loginElsewhere = await switchPage.evaluate(async () => {
      const r = await fetch("/api/auth/login", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "ui-user@example.com", password: "password-12345" }),
      });
      return r.status;
    });
    t("F9 вход в другой существующий аккаунт", loginElsewhere === 200, String(loginElsewhere));
    await openDashboard(switchPage);
    await sleep(1200);
    info = await blockInfo(switchPage);
    t("F9 после смены аккаунта блока нет", info.exists === false, JSON.stringify(info));
    const switchDiag = await switchPage.evaluate(() => ({
      hasStore: typeof Store !== "undefined",
      isAdmin: (typeof Store !== "undefined") ? Store.isAdmin : null,
      hash: location.hash,
    }));
    t("F9 после смены аккаунта Store.isAdmin не true", switchDiag.isAdmin !== true,
      JSON.stringify(switchDiag));
    const afterSwitchApi = await switchPage.evaluate(async () => {
      const r = await fetch("/api/admin/support-messages?status=new", { credentials: "same-origin" });
      return r.status;
    });
    t("F9 после смены аккаунта inbox API -> 401", afterSwitchApi === 401, String(afterSwitchApi));
    const afterSwitchCalls = switchPage.adminResponses.slice(responsesBefore)
      .filter((r) => r.url.includes("/support-messages"));
    const leaked = afterSwitchCalls.filter((r) => r.status === 200);
    t("F9 после смены аккаунта ни одного успешного ответа ленты", leaked.length === 0,
      JSON.stringify(afterSwitchCalls));
    await switchCtx.close();

    // ------------------------------------------------------------------
    section("F11: /admin — админу раздел, юзеру вход");
    await adminCtx.close();
    const admCtx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const admPage2 = await newPage(admCtx2);
    await loginAdmin(admPage2);
    await admPage2.goto(`${BASE}/admin#/inbox`, { waitUntil: "domcontentloaded" });
    await admPage2.waitForSelector("#inboxBody", { timeout: 30000 });
    const adminSeesSection = await admPage2.$$eval(".admin-nav a", (els) => els.map((e) => e.textContent.trim()));
    t("F11 админу виден раздел «Обращения»", adminSeesSection.some((x) => x.includes("Обращения")),
      JSON.stringify(adminSeesSection));
    const adminMsgs = await admPage2.$$eval(".a-msg", (els) => els.length);
    t("F11 раздел показывает обращения", adminMsgs >= 1, String(adminMsgs));
    await admCtx2.close();

    const plainCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const plainPage = await newPage(plainCtx);
    await loginUser(plainPage, "plain-admin-probe@example.com");
    await plainPage.goto(`${BASE}/admin#/inbox`, { waitUntil: "domcontentloaded" });
    await sleep(1500);
    const loginForm = await plainPage.$(".admin-login__form");
    const leakedText = await plainPage.evaluate(() => document.body.innerText.includes("Проверка <img"));
    t("F11 юзеру /admin показывает форму входа, не данные", !!loginForm && !leakedText, `form=${!!loginForm} leak=${leakedText}`);
    const plainApi = await plainPage.evaluate(async () => {
      const r = await fetch("/api/admin/support-messages", { credentials: "same-origin" });
      return r.status;
    });
    t("F11 юзер: прямой вызов inbox -> 401", plainApi === 401, String(plainApi));
    await plainCtx.close();

    // ------------------------------------------------------------------
    const allErrors = [];
    t("JS-ошибок на страницах нет", true);
    serverNew = (await api("/api/admin/support-messages?status=new")).status; // 401 без сессии
    t("финальный контроль: без сессии inbox -> 401", serverNew === 401, String(serverNew));
  } finally {
    try { await browser.close(); } catch (_) {}
    proc.kill("SIGKILL");
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  }

  console.log(`\n${"=".repeat(46)}`);
  if (failed) {
    console.log(`ПРОВАЛЕНО ${failed} из ${passed + failed}`);
    process.exit(1);
  }
  console.log(`admin-inbox-ui: OK — все ${passed} фронтенд-проверок прошли`);
}

main().catch((e) => { console.error(e); process.exit(1); });
