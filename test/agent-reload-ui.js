#!/usr/bin/env node
/* Живая проверка возврата посреди хода ИИ (реальный сценарий, не синтетика).
 *
 * Уход из браузера (звонок) на ~минуту при длинном ходе и возврат:
 * 1) посреди хода — видны скелетон/шаги и «Стоп», а не пустота;
 * 2) после завершения — финал подтянут сам, без ручного refresh
 *    (скелетона нет, «Стоп» скрыт, кольцо квоты обновлено);
 * 3) Tanner: опрос чужого хода не крутится вечно после финала.
 *
 * Мок: ход в 2 вызова (~7 с: чтение, затем ответ). Reload — через 2 с
 * после отправки, т.е. гарантированно посреди хода.
 *
 * Требует playwright-core и Chromium (EGE_CHROME). Без них — код 2.
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");

const ROOT = path.resolve(__dirname, "..");
let chromium = null;
try { ({ chromium } = require("playwright-core")); } catch (_) {}
if (!chromium) {
  console.error("SKIP: нужен playwright-core и Chromium (EGE_CHROME)");
  process.exit(2);
}
let failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " | " + detail : ""}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ege-reload-"));
const dbPath = path.join(tmp, "ege.sqlite3");

const bootScript = `
import importlib.util, os, threading, time
os.environ["EGE_DB_PATH"] = ${JSON.stringify(dbPath)}
os.environ["EGE_DISABLE_SYSTEMD"] = "1"
os.environ["EGE_TRUSTED_PROXY"] = "1"
os.environ["EGE_AGENT_QUOTA_MAX"] = "500"
os.environ["EGE_AI_RATE_MAX"] = "1000"
spec = importlib.util.spec_from_file_location("srv", ${JSON.stringify(path.join(ROOT, "server", "server.py"))})
srv = importlib.util.module_from_spec(spec); spec.loader.exec_module(srv)
ai = srv._AI
def mock_chat(messages, tools, **kw):
    time.sleep(3.5)   # каждый вызов модели — медленно, как живой провайдер
    n = getattr(mock_chat, "n", 0) + 1
    mock_chat.n = n
    if n == 1:
        return {"text": "Сейчас посмотрю", "tool_calls": [{"id": "r1", "name": "fold_web", "arguments": {"op": "progress"}}]}
    return {"text": "Готово, прогресс посмотрел.", "tool_calls": []}
ai.chat_with_tools = mock_chat
ai.chat = lambda messages, **kw: "Готово."
ai.reset_ai_rate()
httpd = srv.create_http_server("127.0.0.1", 0)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
print("PORT", httpd.server_address[1], flush=True)
while True: time.sleep(3600)
`;
const { spawn } = require("child_process");
function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", ["-c", bootScript], { env: { ...process.env } });
    let buf = "";
    const to = setTimeout(() => reject(new Error("сервер не поднялся за 20 с:\n" + buf)), 20000);
    proc.stdout.on("data", (c) => {
      buf += c;
      const m = buf.match(/PORT (\d+)/);
      if (m) { clearTimeout(to); resolve({ proc, port: m[1] }); }
    });
    proc.stderr.on("data", (c) => { buf += c; });
    proc.on("exit", (code) => { clearTimeout(to); reject(new Error("сервер умер, код " + code + ":\n" + buf)); });
  });
}

let BASE = "";
function req(pathname, body, cookies) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { "X-Forwarded-For": "10.9.9.9", "Content-Type": "application/json" };
    if (data) headers["Content-Length"] = Buffer.byteLength(data);
    if (cookies) headers["Cookie"] = cookies;
    const r = http.request(BASE + pathname, { method: "POST", headers }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => {
        let payload = {};
        try { payload = JSON.parse(b || "{}"); } catch (_) {}
        resolve({ status: res.statusCode, payload, setCookie: res.headers["set-cookie"] || [] });
      });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  let srv = null;
  try { srv = await startServer(); } catch (e) { console.error(e.message); process.exit(2); }
  BASE = `http://127.0.0.1:${srv.port}`;
  const claim = await req("/api/profile/claim",
    { subject: "profile_math", onboarded: true, name: "Тест-Возврат" });
  const jar = (claim.setCookie || []).map((c) => c.split(";")[0]).join("; ");
  check("профиль заявлен, кука выдана", claim.status === 200 && !!jar, String(claim.status));

  function findChrome() {
    if (process.env.EGE_CHROME && fs.existsSync(process.env.EGE_CHROME)) return process.env.EGE_CHROME;
    const root = path.join(process.env.HOME || "/root", ".cache", "ms-playwright");
    if (!fs.existsSync(root)) return null;
    for (const dir of fs.readdirSync(root)) {
      for (const rel of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
        const p = path.join(root, dir, rel);
        if (fs.existsSync(p)) return p;
      }
    }
    return null;
  }
  const exe = findChrome();
  if (!exe) { console.error("SKIP: нет Chromium (EGE_CHROME)"); process.exit(2); }

  const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
  const sessionRaw = (jar.split("; ").find((c) => c.startsWith("ege_session=")) || "")
    .slice("ege_session=".length);
  await page.context().addCookies([{ name: "ege_session", value: sessionRaw,
    domain: "127.0.0.1", path: "/" }]);
  await page.addInitScript(() => {
    try { localStorage.setItem("ege_subject", "profile_math"); } catch (_) {}
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e && e.message || e)));

  await page.goto(BASE + "/dashboard#/ai", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".agent__composer textarea, .agent__input", { timeout: 20000 });
  const sel = (await page.$(".agent__composer textarea")) ? ".agent__composer textarea" : ".agent__input";
  await page.fill(sel, "как мой прогресс");
  await page.keyboard.press("Enter");
  // Ход ушёл (mock: 2 вызова по 3.5 с). Через 2 с — «уход из браузера».
  await page.waitForTimeout(2000);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".agent__composer textarea, .agent__input", { timeout: 20000 });

  // 1) Посреди хода: не пустота — скелетон/шаги и «Стоп».
  await page.waitForTimeout(2500);
  const mid = await page.evaluate(() => ({
    loader: !!document.querySelector(".agent__loader"),
    steps: document.querySelectorAll(".agent__step").length,
    stopHidden: !!(document.querySelector(".agent__stop") || {}).hidden,
    bubble: (document.querySelector(".agent__msg-user") || {}).textContent || "",
  }));
  check("1) возврат посреди хода — есть скелетон или шаги, а не пустота",
    mid.loader || mid.steps > 0, JSON.stringify(mid));
  check("1) «Стоп» на месте, пока считает", mid.stopHidden === false, JSON.stringify(mid));
  check("1) вопрос виден", /как мой прогресс/.test(mid.bubble), mid.bubble.slice(0, 60));

  // 2) Ждём завершения (mock ~7 с + запас): финал сам, без refresh.
  await page.waitForTimeout(12000);
  const done = await page.evaluate(() => ({
    loader: !!document.querySelector(".agent__loader"),
    answer: (document.querySelector(".agent__ai[data-answer]") || {}).textContent || "",
    answers: document.querySelectorAll(".agent__ai[data-answer]").length,
    stopHidden: !!(document.querySelector(".agent__stop") || {}).hidden,
    quota: (document.querySelector("#agent-quota") || {}).getAttribute("aria-label") || "",
  }));
  check("2) финал подтянулся сам (без ручного refresh)",
    /Готово, прогресс посмотрел/.test(done.answer), done.answer.slice(0, 80));
  check("2) скелетона больше нет", done.loader === false, String(done.loader));
  check("2) «Стоп» скрыт после завершения", done.stopHidden === true, String(done.stopHidden));
  check("2) кольцо квоты обновлено (потрачено 2: чтение + ответ)",
    /Осталось 498/.test(done.quota), done.quota);

  // 3) Опрос не крутится вечно: тишина в сети после финала.
  const traffic = await page.evaluate(() => new Promise((resolve) => {
    let n = 0;
    const orig = window.fetch.bind(window);
    window.fetch = function (...a) {
      if (String(a[0] || "").includes("/api/agent/threads/")) n++;
      return orig(...a);
    };
    setTimeout(() => resolve(n), 6000);
  }));
  check("3) после финала опрос треда остановлен", traffic === 0, `GET треда за 6 с: ${traffic}`);
  check("нет ошибок в консоли страницы", errors.length === 0, errors.join(" / "));

  await browser.close();
  try { srv.proc.kill(); } catch (_) {}
  console.log(`\n${failures ? "FAILURES: " + failures : "ALL OK"}: ${checks} проверок (reload посреди 7-секундного хода)`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ОШИБКА:", e && e.stack || e); process.exit(2); });
