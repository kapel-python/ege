#!/usr/bin/env node
/* Кнопка «Поделиться» на ege-result.html: место, модалка, публичная копия.

Живой сервер на temp-БД и свободном порте, живой Chromium, прод не трогается.
Готовую проверку сеем напрямую движком (store_essay_check + evaluation —
тем же путём, что модельный pipeline; сам pipeline покрыт test/essay-pipeline.py).

Покрывает:
  S1 у владельца под перепроверкой видна ghost-кнопка «Поделиться
     результатом» (не вторая синяя, не у таблетки);
  S2 клик создаёт ссылку: модалка с полем /s/<token>, кнопкой копирования,
     «Готово» и «Удалить ссылку» — БЕЗ крестика, закрытия по фону и Esc
     (ссылку легко потерять, а доступ останется открытым);
  S3 повторный клик — уже «Моя ссылка» с тем же токеном (создания нет);
  S4 гость по /s/<token> видит тот же отчёт, но без перепроверки, шаринга
     и с пометкой «Публичная ссылка»;
  S5 отзыв из модалки закрывает доступ сразу (гость — 404), окно
     предлагает создать заново;
  S6 ноль ошибок консоли на всех экранах.

Запуск: node test/essay-share-ui.js
Нужен playwright-core и Chromium; путь можно задать EGE_CHROME.
Без playwright-core — код 2 с инструкцией (как у остальных *-ui.js).
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
const ADMIN_PASSWORD = "ui-share-test-admin-pw";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ege-share-ui-"));
const DB = path.join(TMP, "ege.sqlite3");
const PORT = 23100 + Math.floor(Math.random() * 1500);
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
      for (const rel of [["chrome-linux", "chrome"], ["chrome-linux64", "chrome"],
                         ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"]]) {
        const p = path.join(root, dir, ...rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
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

/* Готовая проверка тем же движком, что кладёт её в pipeline: запись
   essay_checks + evaluation ready. Модели здесь нет — она покрыта
   test/essay-pipeline.py, здесь важна только готовая строка в базе. */
function seedReadyScript() {
  return `
import os, importlib.util
os.environ["EGE_DB_PATH"] = ${JSON.stringify(DB)}
spec = importlib.util.spec_from_file_location("ege_share_seed", ${JSON.stringify(SERVER)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
conn = m.connect()
m.ensure_essay_schema(conn)
uid = conn.execute("SELECT id FROM users ORDER BY id LIMIT 1").fetchone()[0]
row = conn.execute("SELECT client_id, text FROM essay_submissions WHERE user_id=?", (uid,)).fetchone()
maxes = [("K1", 1), ("K2", 3), ("K3", 2), ("K4", 1), ("K5", 2), ("K6", 1),
         ("K7", 3), ("K8", 3), ("K9", 3), ("K10", 3)]
crit = [{"id": c, "name": "K" + c[1:], "score": x if x <= 1 else x - 1,
         "max_score": x, "comment": "Комментарий к " + c + "."} for c, x in maxes]
res = {"total_score": 999, "max_score": 999, "short_verdict": "Хорошая работа.",
       "criteria": crit, "what_to_improve": ["Проверить логику"], "recommendation": "Так держать."}
m.store_essay_check(conn, int(uid), "russian", row["text"], "test", res, task_id="re27_1")
conn.commit()
m.save_essay_evaluation(conn, int(uid), "russian", {"clientId": row["client_id"], "status": "ready"})
conn.commit()
print("SEEDED", uid)
`;
}

function seedReady() {
  return new Promise((resolve, reject) => {
    const p = spawn("python3", ["-c", seedReadyScript()], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => (code === 0 && /SEEDED/.test(out) ? resolve() : reject(new Error(`seed failed: ${err.slice(-400)}`))));
  });
}

const ESSAY_TEXT = Array(200).fill("слово").join(" ");

async function main() {
  const proc = await startServer();
  const exe = findChrome();
  if (!exe) {
    proc.kill("SIGKILL");
    console.error("SKIP: Chromium не найден. Укажи EGE_CHROME=/path/to/chrome");
    process.exit(2);
  }
  const browser = await chromium.launch({ executablePath: exe });
  try {
    const ctx = await browser.newContext();
    const errors = [];
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(String((e && e.message) || e)));

    section("S1 кнопка у владельца");
    await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" });
    const claimed = await page.evaluate(async ({ base, essayText }) => {
      const post = async (u, b) => {
        const r = await fetch(base + u, { method: "POST",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
        return { status: r.status, body: await r.json().catch(() => ({})) };
      };
      const c = await post("/api/profile/claim", { subject: "russian", onboarded: true, name: "UI" });
      await post("/api/subject", { subject: "russian" });
      const s = await post("/api/essays", { subject: "russian", taskId: "re27_1",
        skill: "russian_essay_source", text: essayText, id: "ui-share-1" });
      return { claimed: c.status, submitted: s.status, sub: s.body };
    }, { base: BASE, essayText: ESSAY_TEXT });
    t("онбординг и отправка", claimed.claimed === 200 && claimed.submitted === 200,
      JSON.stringify(claimed).slice(0, 160));
    const clientId = claimed.sub.clientId;
    await seedReady();
    await page.goto(`${BASE}/ege-result.html?subject=russian&clientId=${encodeURIComponent(clientId)}`,
      { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#scoreValue", { timeout: 20000 });
    const btn = await page.$("#shareWrap:not([hidden]) #shareBtn");
    t("кнопка видна под перепроверкой", !!btn);
    const label = btn ? await btn.textContent() : "";
    t("подпись по умолчанию «Поделиться результатом»", /Поделиться результатом/.test(label || ""), (label || "").trim());
    const btnClass = btn ? await btn.getAttribute("class") : "";
    t("кнопка ghost, не вторая синяя", /share-btn/.test(btnClass || "") && !/retry-btn/.test(btnClass || ""));

    section("S2 создание и незакрываемое окно");
    await btn.click();
    await page.waitForSelector("#shareLinkInput", { timeout: 15000 });
    const linkVal = await page.$eval("#shareLinkInput", (el) => el.value);
    const m = /\/s\/([A-Za-z0-9]{10})$/.exec(linkVal || "");
    t("в поле абсолютная ссылка /s/<token>", !!m && /^http/.test(linkVal || ""), linkVal);
    const token = m ? m[1] : "";
    t("токен 10 знаков, не цифры", /^[A-Za-z0-9]{10}$/.test(token) && !/^\d+$/.test(token), token);
    t("крестика нет", (await page.$(".dlg .dlg__close")) === null);
    await page.mouse.click(30, 30);
    await sleep(300);
    t("тап по фону не закрывает", (await page.$("#shareLinkInput")) !== null);
    await page.keyboard.press("Escape");
    await sleep(300);
    t("Esc не закрывает", (await page.$("#shareLinkInput")) !== null);
    t("есть «Удалить ссылку»", (await page.$("#shareDanger .share-danger-btn")) !== null);
    // Копирование: в headless буфер может отсутствовать — тогда поле
    // выделяется для ручной копии; главное — без ошибок и с фидбеком/фокусом.
    await page.click(".share-copy-btn");
    await sleep(400);
    const copied = await page.evaluate(() => ({
      label: (document.getElementById("shareCopyLabel") || {}).textContent || "",
      noteHidden: (document.getElementById("shareCopied") || {}).hidden !== false,
      activeIsInput: document.activeElement && document.activeElement.id === "shareLinkInput",
    }));
    t("копирование: фидбек или выделение поля",
      /Скопировано/.test(copied.label) || copied.activeIsInput === true, JSON.stringify(copied));
    await page.click(".dlg__actions .btn--soft");
    await sleep(300);
    t("«Готово» закрывает", (await page.$("#shareLinkInput")) === null);
    const label2 = await page.$eval("#shareBtnLabel", (el) => el.textContent);
    t("кнопка стала «Моя ссылка»", /Моя ссылка/.test(label2 || ""), (label2 || "").trim());

    section("S3 повторное открытие без создания");
    let created = 0;
    page.on("response", (r) => {
      if (r.url().includes("/api/essays/share") && r.request().method() === "POST") created++;
    });
    await page.click("#shareBtn");
    await page.waitForSelector("#shareLinkInput", { timeout: 15000 });
    await sleep(500);
    const linkVal2 = await page.$eval("#shareLinkInput", (el) => el.value);
    t("тот же токен, POST не уходил", linkVal2 === linkVal && created === 0, `${linkVal2} vs ${linkVal}`);
    await page.click(".dlg__actions .btn--soft");
    await sleep(300);

    section("S4 публичный просмотр гостем");
    const guestCtx = await browser.newContext();
    const guest = await guestCtx.newPage();
    guest.on("pageerror", (e) => errors.push("guest: " + String((e && e.message) || e)));
    await guest.goto(`${BASE}/s/${token}`, { waitUntil: "domcontentloaded" });
    await guest.waitForSelector("#scoreValue", { timeout: 20000 });
    // Итог анимируется animateCount 1400мс: читаем после конца анимации.
    await guest.waitForFunction(() => {
      const el = document.getElementById("scoreValue");
      return el && el.textContent.trim() === "15";
    }, null, { timeout: 20000 });
    const gScore = await guest.$eval("#scoreValue", (el) => el.textContent);
    t("гость видит тот же отчёт", (gScore || "").trim() === "15", gScore);
    t("баннер публичной ссылки виден", (await guest.$("#sharePublicBanner:not([hidden])")) !== null);
    t("перепроверки у гостя нет", await guest.evaluate(() => {
      const el = document.getElementById("recheckWrap");
      return !el || el.hidden;
    }));
    t("шаринга чужой работы нет", await guest.evaluate(() => {
      const el = document.getElementById("shareWrap");
      return !el || el.hidden;
    }));

    section("S5 отзыв закрывает доступ");
    await page.click("#shareBtn");
    await page.waitForSelector("#shareDanger .share-danger-btn", { timeout: 15000 });
    await page.click("#shareDanger .share-danger-btn");
    await sleep(300);
    t("удаление в два шага (подтверждение)", (await page.$("#shareConfirmRow:not([hidden])")) !== null);
    await page.click("#shareRevokeBtn");
    await page.waitForFunction(() => {
      const el = document.querySelector(".dlg-device__name");
      return el && /удалена/i.test(el.textContent || "");
    }, null, { timeout: 15000 });
    const revokedTitle = await page.$eval(".dlg-device__name", (el) => el.textContent);
    t("окно «Ссылка удалена»", /удалена/i.test(revokedTitle || ""), (revokedTitle || "").trim());
    await guest.goto(`${BASE}/s/${token}`, { waitUntil: "domcontentloaded" });
    await guest.waitForSelector("#errorText", { timeout: 20000 });
    const errText = await guest.$eval("#errorText", (el) => el.textContent);
    t("старая ссылка — честная 404", /чужую ссылку|не показываем|устарела/.test(errText || ""), (errText || "").slice(0, 80));
    // «Создать заново» — новая ссылка работает.
    await page.click(".dlg__actions .retry-btn");
    await page.waitForSelector("#shareLinkInput", { timeout: 15000 });
    const linkVal3 = await page.$eval("#shareLinkInput", (el) => el.value);
    t("заново — новый токен", linkVal3 !== linkVal && /\/s\/[A-Za-z0-9]{10}$/.test(linkVal3), linkVal3);
    const token3 = /\/s\/([A-Za-z0-9]{10})$/.exec(linkVal3)[1];
    await guest.goto(`${BASE}/s/${token3}`, { waitUntil: "domcontentloaded" });
    await guest.waitForSelector("#scoreValue", { timeout: 20000 });
    t("новая ссылка открывается", true);

    section("S6 консоль чиста");
    t("ноль ошибок консоли", errors.length === 0, errors.slice(0, 3).join(" | "));

    await guestCtx.close();
    await ctx.close();
  } finally {
    await browser.close();
    proc.kill("SIGKILL");
  }
  console.log(`\n${passed}/${passed + failed} passed`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
