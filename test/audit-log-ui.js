#!/usr/bin/env node
/* Регресс раздела «Журнал» в админке: лента вместо сырой таблицы.
 *
 * Живой сервер на temp-БД и свободном порте, прод не трогается. Пользователи
 * заводятся настоящим claim, записи журнала — прямым INSERT через python3
 * (того же формата, что пишет admin_audit), дальше всё глазами браузера:
 *
 *   A1 все 30 записей рисуются карточками, сырых кодов нет, у каждой
 *      человеческая расшифровка ("+100 XP", "Plus на месяц", "№ 42"...);
 *   A2 вкладки фильтруют по смыслу (Входы/Пользователи/Подписка/
 *      Провайдеры/Обращения), счётчик "N из M" честный;
 *   A3 поиск сужает ленту; неизвестное действие бэкенда видно сырым кодом
 *      только во «Всех», а не пустотой;
 *   A4 группировка по дням (Сегодня/Вчера/дата);
 *   A5 ноль ошибок консоли, мобильный вид рисуется.
 *
 * Запуск: node test/audit-log-ui.js
 * Нужен playwright-core и Chromium; путь можно задать EGE_CHROME.
 */
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

let chromium;
try {
  ({ chromium } = require("playwright-core"));
} catch (_) {
  console.error("SKIP: нужен playwright-core. Установи: npm i playwright-core");
  process.exit(2);
}

const ROOT = path.resolve(__dirname, "..");
const SERVER = path.join(ROOT, "server", "server.py");
const ADMIN_PASSWORD = "ui-audit-test-admin-pw";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ege-audit-ui-"));
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
  const salt = "d".repeat(32);
  const dk = require("crypto").pbkdf2Sync(ADMIN_PASSWORD, Buffer.from(salt, "hex"), 1000, 32, "sha256");
  const env = {
    ...process.env,
    EGE_DB_PATH: DB,
    EGE_PORT: String(PORT),
    EGE_HOST: "127.0.0.1",
    EGE_QUIET: "1",
    EGE_DISABLE_SYSTEMD: "1",
    EGE_PID_FILE: path.join(TMP, "server.pid"),
    EGE_LOCK_FILE: path.join(TMP, "server.lock"),
    EGE_ADMIN_PASSWORD_HASH: `pbkdf2_sha256$1000$${salt}$${dk.toString("hex")}`,
  };
  const proc = spawn("python3", ["-u", SERVER], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  for (let i = 0; i < 100; i++) {
    await sleep(200);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`).then((x) => x.json());
      if (r.ok) { BASE = `http://127.0.0.1:${PORT}`; return proc; }
    } catch (_) { /* ещё не поднялся */ }
  }
  proc.kill();
  throw new Error("сервер не поднялся");
}

function seedAudit(rows) {
  // Таблица чистится целиком: вход через форму тоже пишет admin-login, и его
  // место в id-порядке ломало бы слитность групп дней. Сид детерминирован.
  const script = `
import json, sqlite3, sys
db, payload = sys.argv[1], sys.argv[2]
rows = json.loads(payload)
conn = sqlite3.connect(db, timeout=10)
conn.execute("PRAGMA busy_timeout=10000")
conn.execute("DELETE FROM admin_audit")
conn.executemany("INSERT INTO admin_audit(actor_user_id, action, target_user_id, detail, created_at) VALUES (?,?,?,?,?)", rows)
conn.commit()
conn.close()
`;
  execFileSync("python3", ["-c", script, DB, JSON.stringify(rows)], { stdio: "pipe" });
}

async function main() {
  const chrome = findChrome();
  if (!chrome) { console.error("SKIP: Chromium не найден (EGE_CHROME)"); process.exit(2); }
  const proc = await startServer();
  const browser = await chromium.launch({ executablePath: chrome });
  try {
    // --- два пользователя настоящим claim ---
    const ua = await browser.newPage();
    const ub = await browser.newPage();
    const claim = async (page, name) => {
      await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" });
      return page.evaluate(async (n) => {
        const r = await fetch("/api/profile/claim", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subject: "profile_math", onboarded: true, name: n, selfLevel: "base" }),
        });
        return r.json();
      }, name);
    };
    const ca = await claim(ua, "Аудит А");
    const cb = await claim(ub, "Аудит Б");
    t("пользователи заведены claim", !!ca.accountId && !!cb.accountId);
    await ua.close();
    await ub.close();

    // --- вход в админку через форму ---
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    // Предсуществующий шум, не наш: шрифт Google режется CSP (так на проде
    // и в других UI-тестах), а 401 — проба сессии гостем при загрузке.
    const KNOWN_NOISE = ["fonts.googleapis.com", "401 (Unauthorized)"];
    const noisy = (text) => KNOWN_NOISE.some((s) => text.includes(s));
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error" && !noisy(m.text())) errors.push(m.text()); });
    await page.goto(`${BASE}/admin`, { waitUntil: "domcontentloaded" });
    await page.fill("#pwInput", ADMIN_PASSWORD);
    await page.click("#loginBtn");
    await page.waitForSelector(".admin-app", { timeout: 15000 });

    const ids = await page.evaluate(async () => {
      const s = await (await fetch("/api/admin/session")).json();
      const u = await (await fetch("/api/admin/users")).json();
      const byAcct = {};
      for (const p of u.users) byAcct[p.accountId] = p.id;
      return { adminId: s.user.id, users: byAcct };
    });
    const A = ids.users[ca.accountId], B = ids.users[cb.accountId];
    t("id пользователей известны", !!A && !!B && !!ids.adminId);

    // --- 29 записей журнала прошлого и настоящего ---
    // Метки привязаны к полудню дней (а не к now-N): иначе прогон около
    // полуночи разложил бы «вчерашние» строки по разным суткам. Порядок
    // вставки — по возрастанию времени: сервер отдаёт id-DESC, и только
    // тогда группы дней идут слитно, как в жизни (время монотонно с id).
    const now = Date.now(), DAY = 86400000;
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const T0 = dayStart.getTime();
    const tToday = T0 + 12 * 3600e3, tYest = T0 - 12 * 3600e3, tOld = T0 - 2 * DAY - 12 * 3600e3;
    const future = now + 30 * DAY;
    const rows = [
      [ids.adminId, "delete-user", null, "zz99xx", String(tOld)],
      [ids.adminId, "providers.judge", null, "gptunnel → closerouter", String(tOld)],
      [ids.adminId, "admin-login-expired", A, "AA11BB22 127.0.0.1", String(tYest)],
      [ids.adminId, "grant-xp", B, "-50 опечатка в разборе", String(tYest)],
      [ids.adminId, "admin-login-pending", A, "3C2F7C58 127.0.0.1", String(tToday)],
      [ids.adminId, "admin-login-approved", A, "3C2F7C58 127.0.0.1", String(tToday)],
      [ids.adminId, "admin-login-denied", B, "9A1B2C3D 10.0.0.5", String(tToday)],
      [ids.adminId, "admin-login-cancelled", B, "", String(tToday)],
      [ids.adminId, "admin-logout", A, "", String(tToday)],
      [ids.adminId, "grant-xp", A, "+100 за урок", String(tToday)],
      [ids.adminId, "reset", A, "all-progress", String(tToday)],
      [ids.adminId, "reset", B, "streak", String(tToday)],
      [ids.adminId, "update-profile", A, '{"name": "Иван", "selfLevel": "base", "goal": "g80"}', String(tToday)],
      [ids.adminId, "block-user", B, "1d спам", String(tToday)],
      [ids.adminId, "unblock-user", B, "", String(tToday)],
      [ids.adminId, "ai-limit", A, "limit=5 remaining=3 agent: limit=10 remaining=7", String(tToday)],
      [ids.adminId, "subscription-grant", A, `month until ${future}`, String(tToday)],
      [ids.adminId, "subscription-revoke", A, "", String(tToday)],
      [ids.adminId, "subscription-refund", A, "payment=AbC123xYz9 19900", String(tToday)],
      [ids.adminId, "subscription-waitlist-grant", null, "month x12", String(tToday)],
      [ids.adminId, "ai-provider-create", null, "mygw", String(tToday)],
      [ids.adminId, "ai-provider-slots", null, '{"high": "closerouter", "medium": "gptunnel"}', String(tToday)],
      [ids.adminId, "ai-provider-reset", null, "mygw [Plus]", String(tToday)],
      [ids.adminId, "ai-provider-models", null, '{"high": "m1", "medium": "m2", "low": "m3"}', String(tToday)],
      [ids.adminId, "ai-provider-apply", null, "mygw", String(tToday)],
      [ids.adminId, "ai-provider-update", null, "closerouter", String(tToday)],
      [ids.adminId, "ai-provider-delete", null, "oldgw", String(tToday)],
      [ids.adminId, "support-read", null, "message 42", String(tToday)],
      [ids.adminId, "future-action-xyz", null, "сырьё из будущего", String(tToday)],
    ];
    seedAudit(rows);

    section("A1 лента без сырых кодов");
    await page.goto(`${BASE}/admin#/audit`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".a-audit", { timeout: 15000 });
    const cards = await page.$$(".a-audit");
    t("карточек 29", cards.length === 29, cards.length);
    const allText = await page.$eval("#auditList", (el) => el.innerText);
    for (const raw of ["subscription-grant", "subscription-revoke", "subscription-refund",
      "ai-provider-apply", "ai-provider-update", "ai-provider-delete", "ai-provider-slots",
      "ai-provider-models", "ai-provider-reset", "ai-provider-create", "providers.judge",
      "admin-login-pending", "grant-xp", "support-read", "update-profile", "block-user",
      "unblock-user", "delete-user", "ai-limit"]) {
      if (allText.includes(raw)) { t(`сырого кода нет: ${raw}`, false, "найден в ленте"); break; }
    }
    t("сырых кодов нет", !["subscription-grant", "ai-provider-apply", "providers.judge",
      "admin-login-pending", "grant-xp", "support-read"].some((s) => allText.includes(s)));
    for (const human of ["+100 XP", "-50 XP", "весь прогресс", "Plus на месяц", "199,00 ₽",
      "обращение № 42", "код 3C2F-7C58", "mygw", "судья: gptunnel → closerouter",
      "1 день", "сырьё", "× 12 человек", "Сочинения — лимит 5, остаток 3"]) {
      t(`расшифровка видна: ${human}`, allText.includes(human), "нет в ленте");
    }

    section("A2 вкладки");
    const tabCount = async (label) => {
      await page.getByRole("button", { name: label, exact: true }).click();
      await sleep(150);
      return page.$$(".a-audit");
    };
    t("Входы: 6", (await tabCount("Входы")).length === 6);
    t("Пользователи: 9", (await tabCount("Пользователи")).length === 9);
    t("Подписка: 4", (await tabCount("Подписка")).length === 4);
    t("Провайдеры: 8", (await tabCount("Провайдеры")).length === 8);
    t("Обращения: 1", (await tabCount("Обращения")).length === 1);
    await page.getByRole("button", { name: "Все", exact: true }).click();
    await sleep(150);
    const countText = await page.$eval("#auditCount", (el) => el.textContent);
    t("счётчик «29 из 29»", countText.includes("29"), countText);

    section("A3 поиск и неизвестное действие");
    await page.fill("#auditSearch", "спам");
    await sleep(200);
    t("поиск «спам» → 1", (await page.$$(".a-audit")).length === 1);
    await page.fill("#auditSearch", "mygw");
    await sleep(200);
    t("поиск «mygw» → 3", (await page.$$(".a-audit")).length === 3);
    await page.fill("#auditSearch", "");
    await sleep(200);
    const allAgain = await page.$eval("#auditList", (el) => el.innerText);
    t("сырой код будущего виден во «Всех»", allAgain.includes("future-action-xyz"));
    await page.getByRole("button", { name: "Подписка", exact: true }).click();
    await sleep(150);
    const plusText = await page.$eval("#auditList", (el) => el.innerText);
    t("в «Подписке» чужого нет", !plusText.includes("future-action-xyz"));

    section("A4 группы по дням + мобильный вид");
    await page.getByRole("button", { name: "Все", exact: true }).click();
    await sleep(150);
    const groups = await page.$$(".a-msg-group__head .a-chip");
    const groupLabels = [];
    for (const g of groups) groupLabels.push(await g.innerText());
    t("групп три (Сегодня/Вчера/дата)", groupLabels.length === 3, groupLabels.join("|"));
    t("есть «Сегодня» и «Вчера»", groupLabels.includes("Сегодня") && groupLabels.includes("Вчера"));
    const mob = await browser.newPage({ viewport: { width: 390, height: 780 } });
    mob.on("pageerror", (e) => errors.push("mob:" + String(e)));
    await mob.goto(`${BASE}/admin#/audit`, { waitUntil: "domcontentloaded" });
    // Форма входа появляется после асинхронной пробы сессии: мгновенный
    // mob.$("#pwInput") без ожидания — гонка, страница ещё пустая.
    await mob.waitForSelector("#pwInput, .admin-app", { timeout: 15000 });
    // Мобильная страница без сессии — форма входа; входим и проверяем ленту.
    if (await mob.$("#pwInput")) {
      await mob.fill("#pwInput", ADMIN_PASSWORD);
      await mob.click("#loginBtn");
      await mob.waitForSelector(".admin-app", { timeout: 15000 });
      await mob.goto(`${BASE}/admin#/audit`, { waitUntil: "domcontentloaded" });
    }
    await mob.waitForSelector(".a-audit", { timeout: 15000 });
    t("мобильная лента рисуется (29 + вход с телефона)", (await mob.$$(".a-audit")).length === 30);
    await mob.close();

    t("ноль ошибок консоли", errors.length === 0, errors.slice(0, 3).join(" / "));
    await page.close();
    await browser.close();
  } finally {
    proc.kill();
  }
  console.log(`\n${failed === 0 ? "ALL OK" : `FAILURES: ${failed}`}: ${passed + failed} проверок`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
