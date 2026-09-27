#!/usr/bin/env node
/* Визуальная проверка практики итогового сочинения (headless Chromium).

   Живой сервер поднимается на temp-БД и свободном порте, прод не трогается.
   Сценарии: пустой редактор, 149 слов (кнопка заблокирована), 150 слов
   (минимум выполнен), длинное сочинение, одиночный визит без счётчиков
   (есть «Взять другое», нет «Пропустить»), отправка -> единый лоадер ->
   либо итоговый экран с кнопкой разбора (есть AI-ключ), либо честная
   ошибка без XP (ключа нет), повторный визит — следующее сочинение.
   Скриншоты: desktop 1280 и mobile 390, light и dark -> screenshots/.

   Запуск: node test/essay-visual.js
   Нужен playwright-core (NODE_PATH) и Chromium; путь можно задать EGE_CHROME.
   Код 2 — SKIP (нет playwright-core), как у admin-inbox-ui.js.
*/
const { spawn } = require("child_process");
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
const SHOTS = path.join(ROOT, "screenshots");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ege-essay-visual-"));
const DB = path.join(TMP, "ege.sqlite3");
const PORT = 21000 + Math.floor(Math.random() * 3000);
const BASE = `http://127.0.0.1:${PORT}`;

let failed = 0, passed = 0;
const t = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`); };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  if (process.env.EGE_CHROME && fs.existsSync(process.env.EGE_CHROME)) return process.env.EGE_CHROME;
  const root = path.join(os.homedir(), ".cache", "ms-playwright");
  if (fs.existsSync(root)) {
    for (const dir of fs.readdirSync(root)) {
      for (const rel of [["chrome-linux64", "chrome"], ["chrome-linux", "chrome"]]) {
        const p = path.join(root, dir, ...rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

async function startServer() {
  const proc = spawn("python3", ["-u", SERVER], {
    env: {
      ...process.env,
      EGE_DB_PATH: DB,
      EGE_PORT: String(PORT),
      EGE_DISABLE_SYSTEMD: "1",
      EGE_PID_FILE: path.join(TMP, "ege.pid"),
      EGE_LOCK_FILE: path.join(TMP, "ege.lock"),
      EGE_QUIET: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let err = "";
  proc.stderr.on("data", (d) => { err += d; });
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return proc;
    } catch (_) { /* ещё не поднялся */ }
    await sleep(250);
  }
  throw new Error("сервер не поднялся: " + err.slice(-500));
}

/* Осмысленный русский текст примерно на n слов. */
function essayText(n) {
  const sentence = "Счастливым можно считать человека, который нашёл дело по душе и сохранил верных друзей рядом. ";
  const words = sentence.trim().split(" ");
  const out = [];
  while (out.length < n) out.push(...words);
  return out.slice(0, n).join(" ");
}

async function openRussianPractice(page) {
  await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof Store !== "undefined" && Store.ready === true, null, { timeout: 30000 });
  // Гость становится учеником заявкой (сессионная кука), предмет при этом
  // запоминается сервером — гостевой echo-вариант POST /api/subject после
  // перезагрузки не держится.
  await page.evaluate(async () => {
    const res = await fetch("/api/profile/claim", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: "russian", onboarded: true, name: "Визуал" }),
    });
    if (!res.ok) throw new Error("claim " + res.status);
  });
  await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof Store !== "undefined" && Store.ready === true
    && Store.state && Store.state.subject === "russian", null, { timeout: 30000 });
  // Вход в практику — настоящим путём (Путь → тема → Практика): один визит —
  // одно сочинение, следующее — следующим визитом.
  await page.evaluate(() => { startSkillPractice("russian_essay_source"); });
  await page.waitForSelector("#essayInput", { timeout: 30000 });
  await sleep(600); // таймер дорисовался
}

async function shot(page, name) {
  const file = path.join(SHOTS, name);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`  shot ${name}`);
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await startServer();
  const exe = findChrome();
  if (!exe) { console.error("SKIP: Chromium не найден (EGE_CHROME)"); process.exit(2); }
  const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
  const overflow = async (page, label) => {
    const metrics = await page.evaluate(() => ({
      sw: document.scrollingElement.scrollWidth, iw: window.innerWidth,
    }));
    t(`NO horizontal overflow (${label})`, metrics.sw <= metrics.iw + 1,
      `scrollWidth=${metrics.sw} innerWidth=${metrics.iw}`);
  };

  try {
    // ---------- DESKTOP LIGHT ----------
    let ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    let page = await ctx.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    await openRussianPractice(page);

    await shot(page, "essay-empty-desktop-light.png");
    t("empty: submit disabled", await page.$eval("#essaySubmitBtn", (b) => b.disabled));
    t("empty: counter 0/150", (await page.$eval("#essayCount", (e) => e.textContent)).includes("0 / 150"));
    // Один визит — одно сочинение: счётчика N/8 нет, «Пропустить» заменено
    // на «Взять другое».
    t("single: нет счётчика N/8", await page.$(".session-head__progress") === null);
    t("single: есть «Взять другое», нет «Пропустить»", await page.evaluate(() => {
      const h = document.getElementById("screen").innerHTML;
      return h.includes("essayTakeAnother()") && !h.includes("sessionSkip()");
    }));

    await page.fill("#essayInput", essayText(149));
    await sleep(200);
    await shot(page, "essay-149-desktop-light.png");
    t("149: submit disabled", await page.$eval("#essaySubmitBtn", (b) => b.disabled));
    t("149: «ещё 1» в счётчике", (await page.$eval("#essayCount", (e) => e.textContent)).includes("ещё 1"));

    await page.fill("#essayInput", essayText(150));
    await sleep(200);
    await shot(page, "essay-150-desktop-light.png");
    t("150: submit enabled", await page.$eval("#essaySubmitBtn", (b) => !b.disabled));
    t("150: «минимум выполнен»", (await page.$eval("#essayCount", (e) => e.textContent)).includes("минимум выполнен"));

    await page.fill("#essayInput", essayText(400));
    await sleep(200);
    await shot(page, "essay-long-desktop-light.png");
    await overflow(page, "desktop long");

    // Отправка -> pipeline: единый лоадер с текстами проверки, затем либо
    // итоговый экран с кнопкой разбора (есть AI-ключ: один визит — одно
    // сочинение, зелёного блока с навигацией больше нет), либо честная
    // ошибка без XP (ключа нет). В обоих случаях — никаких mock-баллов
    // и висящих спиннеров.
    await page.click("#essaySubmitBtn");
    await page.waitForSelector("#screen .ege-loader", { timeout: 15000 });
    const loaderSub = await page.$eval("#screen [data-loader-sub]", (e) => e.textContent);
    t("pipeline: единый лоадер с текстом проверки",
      /Подсчитываю баллы|Проверяю сочинение|Анализирую критерии|Собираю результат|Готовлю отчёт/.test(loaderSub), loaderSub);
    await page.waitForSelector("#screen .result-wrap, #feedbackSlot .feedback--bad", { timeout: 180000 });
    const finished = await page.$("#screen .result-wrap");
    if (finished) {
      const finText = await page.$eval("#screen .result-wrap", (e) => e.textContent);
      t("finish: итоговый экран сразу после проверки",
        finText.includes("ТРЕНИРОВКА ЗАВЕРШЕНА"), finText.slice(0, 120));
      t("finish: кнопка разбора сочинения",
        finText.includes("Разбор сочинения"), finText.slice(0, 200));
      await shot(page, "essay-finish-desktop-light.png");
      // Кнопка ведёт на ege-result.html с реальными данными этого submission.
      await page.click("#screen .result-wrap .btn--primary");
      await page.waitForURL("**/ege-result.html**", { timeout: 15000 });
      await page.waitForSelector("#resultState:not([hidden])", { timeout: 15000 });
      await sleep(2200); // animateCount шаблона: читаем финальное значение
      const critCount = await page.$$eval(".crit-card", (els) => els.length);
      const scoreMax = await page.$eval("#scoreMax", (e) => e.textContent);
      t("result: 10 реальных критериев на 22", critCount === 10 && scoreMax.includes("22"),
        `cards=${critCount} max=${scoreMax}`);
      await shot(page, "essay-result-desktop-light.png");
      // Назад — в тренировку (финиш подменил адрес), новый вход в практику —
      // следующее сочинение: первое визитом закрыто и не блокирует.
      await page.goBack();
      await page.evaluate(() => { startSkillPractice("russian_essay_source"); });
      await page.waitForFunction(
        () => typeof Session !== "undefined" && Session.cur && Session.cur.taskIds[0] === "re27_2",
        null, { timeout: 15000 });
      await page.waitForSelector("#essayInput", { timeout: 30000 });
      t("next visit: второе сочинение, первое не блокирует вход", true);
      await shot(page, "essay-second-desktop-light.png");
    } else {
      const errText = await page.$eval("#feedbackSlot .feedback--bad", (e) => e.textContent);
      t("fail: честная ошибка без XP и без висящего loading",
        /не удалась|недоступна|не сформирован/i.test(errText) && errText.includes("Попробовать снова"),
        errText.slice(0, 140));
      // Неудача: дубль отправки спрятан, единственное действие — повтор.
      t("fail: одна кнопка повтора вместо двух отправок", await page.evaluate(() => {
        const w = document.querySelector(".essay-editor__submit");
        const fb = document.getElementById("feedbackSlot").innerHTML;
        return !!w && w.style.display === "none"
          && fb.includes("Попробовать снова") && !fb.includes("Отправить сочинение");
      }));
      await shot(page, "essay-feedback-desktop-light.png");
    }

    t("no page errors (desktop light)", pageErrors.length === 0, pageErrors.join(" | "));
    await ctx.close();

    // ---------- DESKTOP DARK ----------
    ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await ctx.newPage();
    await page.addInitScript(() => {
      try { localStorage.setItem("ege_core_theme", "dark"); } catch (_) {}
    });
    await openRussianPractice(page);
    await shot(page, "essay-empty-desktop-dark.png");
    await page.fill("#essayInput", essayText(173));
    await sleep(200);
    await shot(page, "essay-173-desktop-dark.png");
    await ctx.close();

    // ---------- MOBILE LIGHT ----------
    ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    page = await ctx.newPage();
    await openRussianPractice(page);
    await shot(page, "essay-empty-mobile-light.png");
    await page.fill("#essayInput", essayText(149));
    await sleep(200);
    await shot(page, "essay-149-mobile-light.png");
    await page.fill("#essayInput", essayText(200));
    await sleep(200);
    await shot(page, "essay-200-mobile-light.png");
    await overflow(page, "mobile long");
    await page.click("#essaySubmitBtn");
    await page.waitForSelector("#screen .ege-loader", { timeout: 15000 });
    await page.waitForSelector("#screen .result-wrap, #feedbackSlot .feedback--bad", { timeout: 180000 });
    const doneSel = await page.$("#screen .result-wrap")
      ? "#screen .result-wrap .btn--primary"
      : "#feedbackSlot .feedback--bad .btn--primary";
    await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (el) el.scrollIntoView({ block: "nearest" });
    }, doneSel);
    await sleep(400);
    await shot(page, "essay-feedback-mobile-light.png");
    // Кнопка результата/повтора доступна без закрытия клавиатурой: она вне textarea.
    t("mobile: result button visible after pipeline", await page.$eval(doneSel, (b) => {
      const r = b.getBoundingClientRect();
      return r.bottom <= window.innerHeight && r.width > 0;
    }));
    await ctx.close();

    // ---------- MOBILE DARK ----------
    ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    page = await ctx.newPage();
    await page.addInitScript(() => {
      try { localStorage.setItem("ege_core_theme", "dark"); } catch (_) {}
    });
    await openRussianPractice(page);
    await shot(page, "essay-empty-mobile-dark.png");
    await ctx.close();
  } finally {
    await browser.close();
    server.kill("SIGTERM");
  }

  console.log(`\n${failed ? failed + " FAILURES" : "ALL OK"}: ${passed} checks`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
