/* Демо адаптивной капчи: доверенный пользователь идёт без неё, бот — упирается.
 *
 * Запуск: node test/captcha-demo.js
 * Поднимает свой сервер на temp-БД (прод не трогает), открывает Chromium и:
 *  1. «доверенный»: обычное заполнение формы → 200, капчи нет, аккаунт создан;
 *  2. «бот»: заполняет скрытый honeypot (так делают автоматические фермы) →
 *     422 CAPTCHA_REQUIRED, картинка показана → скрипт вводит символы с неё
 *     (код берёт из debugCode перехваченного ответа — в проде этого поля нет,
 *     человек читает картинку глазами) → 200, аккаунт создан.
 * Скриншоты складывает в /tmp/opencode/captcha-demo/ и печатает их пути.
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright-core");

const SHOTS = "/tmp/opencode/captcha-demo";

const bootScript = `
import hashlib, importlib.util, os, tempfile, threading
from pathlib import Path
ROOT = Path(${JSON.stringify(process.cwd())})
tmp = tempfile.mkdtemp(prefix="ege-captcha-demo-")
os.environ["EGE_DB_PATH"] = str(Path(tmp) / "ege.sqlite3")
os.environ["EGE_DISABLE_SYSTEMD"] = "1"
os.environ["EGE_CAPTCHA_DEBUG"] = "1"
salt = "d" * 32
dk = hashlib.pbkdf2_hmac("sha256", b"demo-admin", bytes.fromhex(salt), 1000)
os.environ["EGE_ADMIN_PASSWORD_HASH"] = "pbkdf2_sha256$1000$" + salt + "$" + dk.hex()
spec = importlib.util.spec_from_file_location("ege_demo", str(ROOT / "server" / "server.py"))
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
conn = mod.connect()
try:
    mod.install_catalog(conn)
finally:
    conn.close()
httpd = mod.create_http_server("127.0.0.1", 0)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
print("PORT", httpd.server_address[1], flush=True)
threading.Event().wait()
`;

function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", ["-c", bootScript], { env: { ...process.env } });
    let buf = "";
    const to = setTimeout(() => { proc.kill(); reject(new Error("сервер не поднялся:\n" + buf)); }, 30000);
    proc.stdout.on("data", (c) => {
      buf += c;
      const m = buf.match(/PORT (\d+)/);
      if (m) { clearTimeout(to); resolve({ proc, port: m[1] }); }
    });
    proc.stderr.on("data", (c) => { buf += c; });
    proc.on("exit", (code) => { clearTimeout(to); reject(new Error("сервер умер, код " + code + ":\n" + buf)); });
  });
}

function findChrome() {
  if (process.env.EGE_CHROME && fs.existsSync(process.env.EGE_CHROME)) return process.env.EGE_CHROME;
  const root = path.join(process.env.HOME || "/root", ".cache", "ms-playwright");
  if (!fs.existsSync(root)) return null;
  for (const dir of fs.readdirSync(root)) {
    for (const rel of ["chrome-linux64/chrome", "chrome-linux/chrome",
                       "chrome-linux/headless_shell", "chrome-linux64/headless_shell"]) {
      const p = path.join(root, dir, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

(async () => {
  let fails = 0;
  const t = (name, cond, extra = "") => {
    console.log((cond ? "ok  " : "FAIL") + " " + name + (cond ? "" : " — " + extra));
    if (!cond) fails++;
  };
  fs.mkdirSync(SHOTS, { recursive: true });

  const { proc, port } = await startServer();
  const BASE = `http://127.0.0.1:${port}`;
  const exe = findChrome();
  if (!exe) { console.error("SKIP: нет Chromium"); proc.kill(); process.exit(2); }
  const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
  try {
    /* ---------- 1. Доверенный: обычная регистрация, капчи нет ---------- */
    const ctx1 = await browser.newContext({ viewport: { width: 430, height: 900 } });
    const p1 = await ctx1.newPage();
    await p1.goto(BASE + "/dashboard#/register", { waitUntil: "networkidle" });
    await p1.waitForSelector('form.auth-form input[name="email"]', { timeout: 15000 });
    await p1.fill('input[name="name"]', "Доверенный");
    await p1.fill('input[name="email"]', "trusted@example.com");
    await p1.fill('input[name="password"]', "secret-pass-1");
    const captchaVisibleBefore = await p1.evaluate(() => {
      const box = document.getElementById("auth-captcha");
      return !!box && !box.hidden;
    });
    t("доверенному капча заранее не показывается", captchaVisibleBefore === false);
    await p1.screenshot({ path: path.join(SHOTS, "1-trusted-form.png") });
    // Человек думает дольше 1.5 с — защита от скорости («rapid») его не трогает.
    await p1.waitForTimeout(2000);
    const [resp1] = await Promise.all([
      p1.waitForResponse((r) => r.url().includes("/api/auth/register") && r.request().method() === "POST", { timeout: 15000 }),
      p1.click("#auth-submit"),
    ]);
    t("доверенный: регистрация сразу 200 без капчи",
      resp1.status() === 200, "статус " + resp1.status());
    await p1.waitForURL(/#\/profile/, { timeout: 15000 });
    await p1.screenshot({ path: path.join(SHOTS, "2-trusted-profile.png") });
    t("доверенный: после регистрации — профиль", p1.url().includes("#/profile"), p1.url());
    await ctx1.close();

    /* ---------- 2. Бот: льёт в скрытое поле, получает капчу ---------- */
    const ctx2 = await browser.newContext({ viewport: { width: 430, height: 900 } });
    const p2 = await ctx2.newPage();
    await p2.goto(BASE + "/dashboard#/register", { waitUntil: "networkidle" });
    await p2.waitForSelector('form.auth-form input[name="email"]', { timeout: 15000 });
    await p2.fill('input[name="name"]', "Ферма");
    await p2.fill('input[name="email"]', "farm@example.com");
    await p2.fill('input[name="password"]', "secret-pass-1");
    // Бот заполняет ВСЕ поля, включая спрятанное от людей (honeypot).
    await p2.evaluate(() => {
      const hp = document.querySelector('input[name="website"]');
      if (hp) hp.value = "http://spam.example";
    });
    const [resp2] = await Promise.all([
      p2.waitForResponse((r) => r.url().includes("/api/auth/register") && r.request().method() === "POST", { timeout: 15000 }),
      p2.click("#auth-submit"),
    ]);
    const body2 = await resp2.json().catch(() => ({}));
    t("бот: первая заявка отклонена 422 CAPTCHA_REQUIRED",
      resp2.status() === 422 && body2.code === "CAPTCHA_REQUIRED", resp2.status() + " " + body2.code);
    await p2.waitForSelector("#auth-captcha:not([hidden])", { timeout: 10000 });
    const svgShown = await p2.evaluate(() => {
      const img = document.getElementById("auth-captcha-img");
      return !!img && img.innerHTML.includes("<svg");
    });
    t("бот: картинка капчи показана", svgShown);
    const errShown = await p2.evaluate(() => {
      const box = document.getElementById("auth-error");
      return !!box && box.classList.contains("is-visible") && /человек/.test(box.textContent || "");
    });
    t("бот: объяснение про человека показано", errShown);
    await p2.screenshot({ path: path.join(SHOTS, "3-bot-captcha.png") });

    // Человек читает символы глазами; скрипт берёт их из debugCode
    // перехваченного ответа (в проде этого поля нет — только картинка).
    const cid = body2.captcha && body2.captcha.id;
    const code = body2.captcha && body2.captcha.debugCode;
    t("челлендж с решением перехвачен", !!(cid && code));
    await p2.fill("#auth-captcha-input", String(code || "").toLowerCase());
    await p2.screenshot({ path: path.join(SHOTS, "4-bot-filled.png") });
    const [resp3] = await Promise.all([
      p2.waitForResponse((r) => r.url().includes("/api/auth/register") && r.request().method() === "POST", { timeout: 15000 }),
      p2.click("#auth-submit"),
    ]);
    t("бот после решения: регистрация 200", resp3.status() === 200, "статус " + resp3.status());
    await p2.waitForURL(/#\/profile/, { timeout: 15000 });
    await p2.screenshot({ path: path.join(SHOTS, "5-bot-profile.png") });
    t("бот после решения: тоже попадает в профиль", p2.url().includes("#/profile"), p2.url());
    await ctx2.close();
  } finally {
    await browser.close();
    proc.kill();
  }
  console.log("\nСкриншоты: " + SHOTS + "/");
  console.log(fails ? `\nFAILURES: ${fails}` : "\nDEMO OK");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("DEMO ERROR:", e); process.exit(2); });
