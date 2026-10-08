#!/usr/bin/env node
/* Регресс экрана «Подписка» в админке: блок «Поощрения» (замена листа
   ожидания) — живой Chromium на своём temp-сервере с mock-оплатой.
 *
 * Покрывает:
 *   S1 сводка и блок «Поощрения» рисуются (выдача + промокоды)
 *   S2 создание промокода через модалку: код/процент/лимит, строка списка
 *      с размером и использованиями, выключение и включение обратно
 *   S3 массовая выдача: счётчик получателей, подтверждение вводом числа
 *      (без ввода и с чужим числом кнопка мертва, с точным — жива),
 *      результат «Выдано», платёж виден в ленте
 *   S4 ноль необработанных ошибок страницы
 *
 * Запуск: node test/admin-subscription-ui.js
 * Нужен playwright-core и Chromium; путь можно задать EGE_CHROME.
 * Без playwright-core — код 2 с инструкцией (как у admin-providers-ui.js).
 */
const { spawn } = require("child_process");
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
const ADMIN_PASSWORD = "ui-subscription-test-admin-pw";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ege-admin-subs-"));
const DB = path.join(TMP, "ege.sqlite3");
const PORT = 24000 + Math.floor(Math.random() * 2000);
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
  const salt = "f".repeat(32);
  const dk = crypto.pbkdf2Sync(ADMIN_PASSWORD, Buffer.from(salt, "hex"), 210000, 32, "sha256");
  const env = {
    ...process.env,
    EGE_DB_PATH: DB,
    EGE_PORT: String(PORT),
    EGE_DISABLE_SYSTEMD: "1",
    EGE_PID_FILE: path.join(TMP, "pid"),
    EGE_LOCK_FILE: path.join(TMP, "lock"),
    EGE_QUIET: "1",
    EGE_SUBSCRIPTION_MOCK: "1",
    EGE_ADMIN_PASSWORD_HASH: `pbkdf2_sha256$210000$${salt}$${dk.toString("hex")}`,
  };
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

async function newPage(context) {
  const page = await context.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(String((e && e.message) || e)));
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

async function main() {
  const server = await startServer();
  let browser = null;
  try {
    // Пользователь для массовой выдачи — до входа в админку, обычным путём.
    const uRes = await fetch(BASE + "/api/profile/claim", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: "profile_math", onboarded: true, name: "Смоук",
                             selfLevel: "base", goal: "g60" }),
    });
    const uBody = await uRes.json().catch(() => ({}));
    t("пользователь для выдачи заведён", uRes.status === 200 && !!uBody.accountId,
      JSON.stringify(uBody).slice(0, 120));

    const chrome = findChrome();
    if (!chrome && !process.env.EGE_CHROME) {
      console.error("SKIP: Chromium не найден. Укажи EGE_CHROME=/path/to/chrome");
      return 2;
    }
    browser = await chromium.launch({ executablePath: chrome || undefined, headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const admin = await newPage(context);
    const loginStatus = await loginAdmin(admin);
    t("вход в админку", loginStatus === 200, String(loginStatus));

    // ---------------- S1: сводка и блок «Поощрения» -----------------------
    section("S1 раздел «Подписка»: блок «Поощрения»");
    await admin.goto(`${BASE}/admin#/subscription`, { waitUntil: "domcontentloaded" });
    await admin.reload({ waitUntil: "domcontentloaded" });
    await admin.waitForSelector("#bonusBtn", { timeout: 30000 });
    const bodyText = await admin.textContent("body");
    t("блок выдачи и промокодов на месте",
      await admin.locator("#bonusBtn").count() === 1
      && await admin.locator("#promoNewBtn").count() === 1
      && bodyText.includes("Промокоды")
      && !bodyText.includes("Лист ожидания"), "лист ожидания не должен остаться");

    // ---------------- S2: промокод через модалку ---------------------------
    section("S2 создание и переключение промокода");
    await admin.click("#promoNewBtn");
    await admin.waitForSelector("#fPromoCode", { timeout: 15000 });
    await admin.fill("#fPromoCode", "uitest25");
    await admin.fill("#fPromoValue", "25");
    await admin.fill("#fPromoMax", "2");
    await admin.click("#mDo");
    await admin.waitForFunction(() => document.body.textContent.includes("UITEST25"), null, { timeout: 20000 });
    const row = admin.locator(".a-payrow", { hasText: "UITEST25" });
    const rowText = await row.textContent();
    t("строка кода: размер и лимит использований",
      rowText.includes("−25%") && rowText.includes("/ 2"), rowText.replace(/\s+/g, " "));
    await row.locator("button").click();
    await admin.waitForFunction(() => {
      const el = [...document.querySelectorAll(".a-payrow")].find((r) => r.textContent.includes("UITEST25"));
      return el && el.textContent.includes("выкл");
    }, null, { timeout: 20000 });
    t("выключение кода", true);
    const offRow = admin.locator(".a-payrow", { hasText: "UITEST25" });
    await offRow.locator("button").click();
    await admin.waitForFunction(() => {
      const el = [...document.querySelectorAll(".a-payrow")].find((r) => r.textContent.includes("UITEST25"));
      return el && !el.textContent.includes("выкл");
    }, null, { timeout: 20000 });
    t("включение обратно", true);

    // ---------------- S3: массовая выдача ---------------------------------
    section("S3 массовая выдача с подтверждением числом");
    await admin.fill("#bonusRefs", uBody.accountId);
    await admin.waitForFunction(() => document.getElementById("bonusCount").textContent.includes("1"),
      null, { timeout: 10000 });
    await admin.click("#bonusBtn");
    await admin.waitForSelector("#fBonus", { timeout: 15000 });
    const noInputDead = await admin.locator("#mDo").isDisabled();
    await admin.fill("#fBonus", "99");
    const wrongDead = await admin.locator("#mDo").isDisabled();
    await admin.fill("#fBonus", "1");
    const exactAlive = !(await admin.locator("#mDo").isDisabled());
    t("без ввода и с чужим числом кнопка мертва, с точным — жива",
      noInputDead && wrongDead && exactAlive);
    await admin.click("#mDo");
    await admin.waitForFunction(() => document.body.textContent.includes("Выдано"), null, { timeout: 20000 });
    t("итог выдачи показан", true);
    await admin.click("#mOk");
    await admin.waitForFunction((acc) => {
      const el = [...document.querySelectorAll(".a-payrow")].find((r) => r.textContent.includes(acc));
      return !!el;
    }, uBody.accountId, { timeout: 20000 });
    t("платёж-грант виден в ленте последних платежей", true);

    // ---------------- S4: ошибки страницы ---------------------------------
    section("S4 ошибки страницы");
    t("ни одной необработанной ошибки", !admin.errors.length, admin.errors.join(" | "));

    return failed ? 1 : 0;
  } finally {
    try { if (browser) await browser.close(); } catch (_) {}
    try { server.kill("SIGKILL"); } catch (_) {}
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  }
}

main().then((code) => {
  console.log(`\n${failed ? "FAIL" : "OK"}: ${passed}/${passed + failed} браузерных проверок`);
  process.exit(code || 0);
}).catch((err) => {
  console.error("ошибка теста:", (err && err.stack) || err);
  process.exit(1);
});
