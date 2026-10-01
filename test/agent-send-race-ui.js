#!/usr/bin/env node
/* Два живых бага отправки в ИИ-наставнике (проверено на живом экране).
 *
 * БАГ 1 «повторю через 60 с»: при «Изменить и отправить», пока сервер ещё
 * считает прошлый (остановленный) ход, клиент показывал модалку с глухим
 * отсчётом на весь TTL слота (до 95 с), а когда дожидался — отправлял
 * исправленный вопрос НОВЫМ сообщением (replaceLast терялся по пути):
 * рядом со старой парой вырастал дубль.
 * Фикс: повтор помнит replaceLast, а вместо глухого ожидания опрашивает
 * флаг busy треда и повторяет сразу, как сервер свободен.
 *
 * БАГ 2 «пустота вместо первого сообщения»: первое сообщение в новом чате
 * регулярно уходило в пустоту — GET треда, улетевший раньше send, возвращался
 * позже и сносил пузырёк, скелетон и карточку ошибки; при сбое модели
 * перезагрузка показывала вообще ничего (вопрос нигде не записан).
 * Фикс: поколение ленты feedGen — запоздавший GET не затирает свежую ленту.
 *
 * Требует playwright-core и Chromium (EGE_CHROME, ищется сам).
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
let chromium = null;
try { ({ chromium } = require("playwright-core")); } catch (_) {}
if (!chromium) { console.error("SKIP: нужен playwright-core"); process.exit(2); }

let failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " | " + detail : ""}`);
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

const BOOT = (mode) => `
import importlib.util, os, threading, time
os.environ["EGE_DB_PATH"] = ${JSON.stringify(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ege-sendrace-")), "ege.sqlite3"))}
os.environ["EGE_DISABLE_SYSTEMD"] = "1"
os.environ["EGE_TRUSTED_PROXY"] = "1"
os.environ["EGE_AGENT_QUOTA_MAX"] = "500"
os.environ["EGE_AGENT_QUOTA_WINDOW_SEC"] = "60"
os.environ["EGE_AI_RATE_MAX"] = "1000"
os.environ["EGE_AI_NET_RATE_MAX"] = "1000"
spec = importlib.util.spec_from_file_location("srv", ${JSON.stringify(path.join(ROOT, "server", "server.py"))})
srv = importlib.util.module_from_spec(spec); spec.loader.exec_module(srv)
ai, agent = srv._AI, srv._AGENT
conn = srv.connect(); srv.install_catalog(conn); conn.close()
state = {"n": 0}
MODE = ${JSON.stringify(mode)}
def mock_chat(messages, tools, **kw):
    state["n"] += 1
    if MODE == "fail":
        raise ai.AIUnavailable("провайдер недоступен")
    if MODE == "slow" and state["n"] == 1:
        time.sleep(6)   # первый ход долгий: его останавливают и правят
        return {"text": "Первый ответ готов.", "tool_calls": []}
    time.sleep(0.3)
    return {"text": "Второй ответ готов.", "tool_calls": []}
def mock_plain(messages, **kw):
    state["n"] += 1
    if MODE == "fail":
        raise ai.AIUnavailable("провайдер недоступен")
    return "Ответ готов."
ai.chat_with_tools = mock_chat
ai.chat = mock_plain
ai.reset_ai_rate()
httpd = srv.create_http_server("127.0.0.1", 0)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
print("PORT", httpd.server_address[1], flush=True)
while True: time.sleep(3600)
`;

function startServer(mode) {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", ["-c", BOOT(mode)], { env: { ...process.env } });
    let buf = "";
    const to = setTimeout(() => reject(new Error("сервер не поднялся:\n" + buf)), 20000);
    proc.stdout.on("data", (c) => {
      buf += c;
      const m = buf.match(/PORT (\d+)/);
      if (m) { clearTimeout(to); resolve({ proc, port: m[1] }); }
    });
    proc.stderr.on("data", (c) => { buf += c; });
    proc.on("exit", (code) => { clearTimeout(to); reject(new Error("сервер умер: " + code + "\n" + buf)); });
  });
}

let BASE = "";
function raw(method, pathname, body, cookies) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { "X-Forwarded-For": "10.9.9.9" };
    if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = Buffer.byteLength(data); }
    if (cookies) headers["Cookie"] = cookies;
    const r = http.request(BASE + pathname, { method, headers }, (res) => {
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

async function openAgent(browser, jar) {
  const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
  const sessionRaw = (jar.split("; ").find((c) => c.startsWith("ege_session=")) || "").slice("ege_session=".length);
  await page.context().addCookies([{ name: "ege_session", value: sessionRaw, domain: "127.0.0.1", path: "/" }]);
  await page.addInitScript(() => {
    try { localStorage.setItem("ege_subject", "profile_math"); } catch (_) {}
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String((e && e.message) || e)));
  await page.goto(BASE + "/dashboard#/ai", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".agent__composer textarea, .agent__input", { timeout: 20000 });
  const sel = (await page.$(".agent__composer textarea")) ? ".agent__composer textarea" : ".agent__input";
  return { page, sel, errors };
}

async function firstThreadId(jar) {
  const r = await raw("GET", "/api/agent/threads", null, jar);
  const list = (r.payload && (r.payload.threads || r.payload.list)) || [];
  return list.length ? list[0].id : null;
}

(async () => {
  const exe = findChrome();
  if (!exe) { console.error("SKIP: нет Chromium (EGE_CHROME)"); process.exit(2); }
  const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
  try {
    /* ============ БАГ 2: первое сообщение + быстрый сбой + поздний GET ============ */
    {
      const srv = await startServer("fail");
      BASE = `http://127.0.0.1:${srv.port}`;
      const claim = await raw("POST", "/api/profile/claim",
        { subject: "profile_math", onboarded: true, name: "Тест-Гонка" }, "");
      const jar = (claim.setCookie || []).map((c) => c.split(";")[0]).join("; ");
      const { page, sel, errors } = await openAgent(browser, jar);
      // Запоздавший GET треда — детерминированно: без задержки гонка
      // решается сетевым джиттером («иногда»), с ней — всегда проигрыш.
      await page.route("**/api/agent/threads/*", (route) => {
        if (route.request().method() !== "GET") return route.continue();
        setTimeout(() => route.continue(), 1500);
      });
      await page.fill(sel, "первый вопрос");
      await page.keyboard.press("Enter");
      // Три быстрых 503 (ход + 2 тихих повтора) укладываются в ~4 с;
      // поздний GET прилетает на 1.5 с — в разгар.
      await page.waitForTimeout(6000);
      const feed = await page.evaluate(() => ({
        bubbles: Array.prototype.map.call(
          document.querySelectorAll(".agent__msg-user"), (n) => n.textContent),
        errorBtns: Array.prototype.filter.call(
          document.querySelectorAll(".agent__ai button"), (b) => /Попробовать снова/.test(b.textContent)).length,
      }));
      check("БАГ2: вопрос остался в ленте после позднего GET (не снесён)",
        feed.bubbles.some((t) => t.includes("первый вопрос")),
        JSON.stringify(feed.bubbles).slice(0, 200));
      check("БАГ2: карточка ошибки тоже уцелела (её есть чем повторить)",
        feed.errorBtns >= 1, `кнопок «Попробовать снова»: ${feed.errorBtns}`);
      check("БАГ2: без JS-ошибок", errors.length === 0, errors.slice(0, 2).join(" | "));
      await page.unroute("**/api/agent/threads/*");
      await page.close();
      srv.proc.kill();
    }

    /* ============ БАГ 1: правка во время остановленного, но живого хода ============ */
    {
      const srv = await startServer("slow");
      BASE = `http://127.0.0.1:${srv.port}`;
      const claim = await raw("POST", "/api/profile/claim",
        { subject: "profile_math", onboarded: true, name: "Тест-Правка" }, "");
      const jar = (claim.setCookie || []).map((c) => c.split(";")[0]).join("; ");
      const { page, sel, errors } = await openAgent(browser, jar);
      await page.fill(sel, "вопрос один");
      await page.keyboard.press("Enter");
      await page.waitForSelector(".agent__loader", { timeout: 15000 });
      // Стоп: клиент отвязался, сервер считает дальше (слот занят ещё ~5 с).
      await page.click(".agent__stop");
      // «Изменить и отправить» по своему вопросу.
      await page.click(".agent__msg-user", { button: "right" });
      await page.waitForSelector(".agent__msgmenu", { timeout: 5000 });
      await page.getByText("Изменить и отправить").click();
      const inVal = await page.evaluate((s) => (document.querySelector(s) || {}).value || "", sel);
      check("БАГ1: правка положила текст обратно в поле", inVal.includes("вопрос один"), inVal.slice(0, 60));
      await page.fill(sel, inVal + " исправленный");
      const t0 = Date.now();
      await page.keyboard.press("Enter");
      // Сервер ещё считает — модалка законна, но она обязана ждать по флагу,
      // а не глухие 60–95 с, и помнить, что это ЗАМЕНА.
      try {
        await page.waitForSelector(".agent__ai button:has-text('Повторить сейчас')", { timeout: 15000 });
      } catch (_) {}
      const busyModal = await page.evaluate(() =>
        Array.prototype.some.call(document.querySelectorAll(".agent__ai"),
          (n) => /Сервер ещё считает/.test(n.textContent || "")));
      check("БАГ1: при живом ходе честно сказано «сервер ещё считает»", busyModal);
      // Ждём итог: повтор должен уйти СРАЗУ, как сервер освободился
      // (старый код ждал бы весь TTL ~95 с и ушёл бы дублем).
      await page.waitForFunction(() => {
        const users = document.querySelectorAll(".agent__msg-user");
        const last = users.length ? users[users.length - 1].textContent : "";
        return last.includes("исправленный")
          && Array.prototype.some.call(document.querySelectorAll(".agent__ai"),
            (n) => /Второй ответ готов/.test(n.textContent || ""));
      }, null, { timeout: 45000 });
      const spent = Math.round((Date.now() - t0) / 1000);
      check("БАГ1: повтор не ждал весь TTL (уложился в 40 с)", spent < 40, `ушло ${spent} с`);
      const bubbles = await page.evaluate(() =>
        Array.prototype.map.call(document.querySelectorAll(".agent__msg-user"), (n) => n.textContent));
      check("БАГ1: исправленный вопрос ОДИН (замена, не дубль)",
        bubbles.length === 1 && bubbles[0].includes("исправленный"),
        JSON.stringify(bubbles).slice(0, 160));
      const tid = await firstThreadId(jar);
      const th = await raw("GET", "/api/agent/threads/" + tid, null, jar);
      const roles = ((th.payload && th.payload.messages) || []).map((m) => m.role + (m.role === "user" ? ":" + (m.content || "") : ""));
      check("БАГ1: в базе одна пара (старая снесена заменой)",
        roles.length === 2 && roles[0].startsWith("user:") && roles[0].includes("исправленный") && roles[1] === "assistant",
        JSON.stringify(roles).slice(0, 200));
      check("БАГ1: без JS-ошибок", errors.length === 0, errors.slice(0, 2).join(" | "));
      await page.close();
      srv.proc.kill();
    }
  } catch (e) {
    console.error("ОШИБКА ХАРНЕССА:", (e && e.message) || e);
    process.exit(2);
  }
  await browser.close();
  console.log(`\n${failures ? "FAILURES: " + failures : "ALL OK"}: ${checks} проверок`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ОШИБКА:", (e && e.stack) || e); process.exit(2); });
