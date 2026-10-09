#!/usr/bin/env node
/* Живая проверка трёх багов карточки подтверждения в ИИ.
 *
 * 1) В карточке шага не должно быть сырого имени инструмента (`update_profile`).
 * 2) После «Применить» композер остаётся заблокированным («Стоп» на месте,
 *    поле не принимает текст), пока сервер думает.
 * 3) Карточка, ждущая подтверждения, не сворачивается сама.
 *
 * Требует playwright-core и Chromium (EGE_CHROME). Без них — код 2 с инструкцией.
 */
const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.resolve(__dirname, "..");
let chromium = null;
try { ({ chromium } = require("playwright-core")); } catch (_) {}
if (!chromium) {
  console.error("SKIP: нужен playwright-core (npm i playwright-core) и Chromium (EGE_CHROME)");
  process.exit(2);
}
let failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " | " + detail : ""}`);
}

/* ---- Мок провайдера: ход с действием + медленный ответ на confirm ---- */
const AGENT_SRC = fs.readFileSync(path.join(ROOT, "server", "agent.py"), "utf8");

/* ---- Поднимаем живой сервер на временной БД тем же приёмом, что и тесты ---- */
const { spawn } = require("child_process");
const os = require("os");

// Подтверждение с задержкой — отдельный серверный трюк: включаем его через
// переменную окружения, которую читает мок-провайдер в тесте.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ege-confirm-"));
const dbPath = path.join(tmp, "ege.sqlite3");

const bootScript = `
import importlib.util, os, sys, threading, time, json
os.environ["EGE_DB_PATH"] = ${JSON.stringify(dbPath)}
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

state = {"n": 0, "confirm_delay": float(os.environ.get("EGE_TEST_CONFIRM_DELAY", "2.5"))}

def tool_name(t):
    if not isinstance(t, dict):
        return ""
    fn = t.get("function")
    return (fn or {}).get("name") if isinstance(fn, dict) else t.get("name")

def mock_chat(messages, tools, **kw):
    state["n"] += 1
    names = [tool_name(t) for t in (tools or [])]
    # Первый ход (ученик просит сменить цель) — вызов действия.
    if "update_profile" in names and not state.get("acted"):
        state["acted"] = True
        return {"text": None, "tool_calls": [{"id": "a1", "name": "update_profile",
                                             "arguments": {"goal": "g95"}}]}
    # Ход после подтверждения: сервер применяет действие и зовёт модель.
    return {"text": "Готово, поставил цель 95+.", "tool_calls": []}

def slow_chat(messages, tools, **kw):
    time.sleep(state["confirm_delay"])   # сервер «думает»
    return mock_chat(messages, tools, **kw)

def mock_plain(messages, **kw):
    state["n"] += 1
    return "Готово, поставил цель 95+."

ai.chat_with_tools = slow_chat
ai.chat = mock_plain
ai.reset_ai_rate()

httpd = srv.create_http_server("127.0.0.1", 0)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
print("PORT", httpd.server_address[1], flush=True)
while True: time.sleep(3600)
`;
// Сервер живёт ВЕСЬ прогон, поэтому spawn (не spawnSync: тот убьёт его по
// таймауту) и порт читаем из его stdout.
function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", ["-c", bootScript], {
      env: { ...process.env, EGE_TEST_CONFIRM_DELAY: process.env.EGE_TEST_CONFIRM_DELAY || "2.5" },
    });
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

/* ---- Заявка профиля + создание чата ---- */
// BASE заполняется после старта сервера; req() читает его по ссылке.
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
  // Профиль → сессия.
  const claim = await req("/api/profile/claim",
    { subject: "profile_math", onboarded: true, name: "Тест-Подтверждение" });
  const jar = (claim.setCookie || []).map((c) => c.split(";")[0]).join("; ");
  check("профиль заявлен, кука выдана", claim.status === 200 && !!jar, String(claim.status));

  const th = await req("/api/agent/threads", {}, jar);
  const tid = th.payload && th.payload.thread && th.payload.thread.id;
  check("чат создан", th.status === 200 && !!tid, String(th.status));

  // Chromium ищем сами: путь к нему у playwright-core разный от версии к
  // версии (chrome-linux vs chrome-linux64), а EGE_CHROME задаётся руками.
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
  const exe = findChrome();
  if (!exe) { console.error("SKIP: нет Chromium (EGE_CHROME)"); process.exit(2); }
  console.log("Chromium: " + exe);

  const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
  // Куки и localStorage сессии — до загрузки сайта.
  // Токен urlsafe и знак "=" вполне может содержать, поэтому режем по ПЕРВОМУ
  // "=" (split("=")[1] молча отдавал обрезанное значение).
  const sessionRaw = (jar.split("; ").find((c) => c.startsWith("ege_session=")) || "")
    .slice("ege_session=".length);
  if (!sessionRaw) { console.error("нет куки ege_session"); process.exit(2); }
  await page.context().addCookies([{ name: "ege_session", value: sessionRaw,
    domain: "127.0.0.1", path: "/" }]);
  await page.addInitScript(() => {
    try { localStorage.setItem("ege_subject", "profile_math"); } catch (_) {}
  });

  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e && e.message || e)));

  // Открываем раздел ИИ и бьём вопрос, который вызывает действие.
  await page.goto(BASE + "/dashboard#/ai", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".agent__composer textarea, .agent__input", { timeout: 20000 });
  const sel = (await page.$(".agent__composer textarea")) ? ".agent__composer textarea" : ".agent__input";
  await page.fill(sel, "поменяй мою цель на 95+ баллов");
  await page.click(sel);
  await page.keyboard.press("Enter");

  // Ждём карточку с кнопкой «Применить».
  try {
    await page.waitForSelector(".agent__step button:has-text('Применить')", { timeout: 60000 });
  } catch (e) {
    const dump = await page.evaluate(() => ({
      url: location.href,
      live: ((document.querySelector(".agent__live") || {}).textContent || "").slice(0, 500),
      steps: document.querySelectorAll(".agent__step").length,
      cards: document.querySelectorAll(".agent__ai").length,
      input: !!document.querySelector(".agent__composer textarea, .agent__input"),
      stop: !!document.querySelector(".agent__stop"),
      err: (document.querySelector(".agent__err, .dlg__err") || {}).textContent || "",
    }));
    console.log("ДИАГНОСТИКА:", JSON.stringify(dump, null, 1));
    await page.screenshot({ path: path.join(ROOT, "screenshots", "agent-confirm-debug.png"), fullPage: true });
    throw e;
  }
  await page.waitForTimeout(1200);

  // Проверяем ВИДИМУЮ часть шага, без свёрнутого «Подробнее»: там технические
  // детали (аргументы, результат) и упоминание инструмента законно — это
  // «Подробнее» для того и существует. Регрессия была в подписи, которую
  // человек читает не открывая ничего.
  const stepText = await page.$eval(".agent__step", (n) => {
    const clone = n.cloneNode(true);
    const det = clone.querySelector(".agent__step-detail");
    if (det && det.parentNode) det.parentNode.removeChild(det);
    return clone.textContent || "";
  });
  check("1) в видимой части шага НЕТ сырого update_profile",
    !/update_profile/.test(stepText), stepText.slice(0, 140));
  check("1) подпись шага человеческая", /Меняю профиль|95/.test(stepText), stepText.slice(0, 140));

  // 3) карточка не сворачивается сама: ждём заметно дольше анимации (~4 с).
  await page.waitForTimeout(9000);
  const stillOpen = await page.$eval(".agent__step button:has-text('Применить')",
    (n) => !!n && n.offsetParent !== null);
  const traceOpen = await page.$eval(".agent__trace", (n) => n.classList.contains("open"));
  check("3) через 9 с карточка с «Применить» всё ещё раскрыта",
    !!stillOpen && traceOpen, `кнопка видна=${!!stillOpen}, лента открыта=${traceOpen}`);

  // 2) жмём «Применить» и сразу смотрим композер.
  await page.click(".agent__step button:has-text('Применить')");
  await page.waitForTimeout(700);           // сервер ещё думает (задержка 2.5 с)
  const busy = await page.evaluate(() => ({
    stopHidden: !!(document.querySelector(".agent__stop") || {}).hidden,
    composerBusy: !!(document.querySelector(".agent__composer") || {}).classList
      && document.querySelector(".agent__composer").classList.contains("busy"),
    placeholder: ((document.querySelector(".agent__composer textarea") || {}).placeholder) || "",
    sendDisabled: !!(document.querySelector(".agent__send") || {}).disabled,
  }));
  check("2) «Стоп» на месте, пока сервер думает", busy.stopHidden === false, JSON.stringify(busy));
  check("2) композер помечен занятым", busy.composerBusy === true, JSON.stringify(busy));
  check("2) поле говорит, что ИИ отвечает",
    /отвечает|пишет/.test(busy.placeholder), JSON.stringify(busy));
  check("2) отправка заблокирована", busy.sendDisabled === true, JSON.stringify(busy));

  // Пробуем отправить сообщение во время подтверждения — не должно уйти.
  const before = await page.evaluate(() => document.querySelectorAll(".agent__msg-user").length);
  await page.fill(sel, "а пока скажи ещё кое-что");
  await page.click(sel);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => document.querySelectorAll(".agent__msg-user").length);
  check("2) сообщение во время подтверждения НЕ отправляется",
    after === before, `${before} -> ${after}`);

  // Ждём завершения подтверждения — композер должен разблокироваться.
  await page.waitForTimeout(4000);
  const afterDone = await page.evaluate(() => ({
    stopHidden: !!(document.querySelector(".agent__stop") || {}).hidden,
    composerBusy: !!document.querySelector(".agent__composer")
      && document.querySelector(".agent__composer").classList.contains("busy"),
  }));
  check("2) после ответа композер снова свободен",
    afterDone.stopHidden === true && afterDone.composerBusy === false, JSON.stringify(afterDone));

  const applied = await page.$$eval(".agent__step", (ns) => ns.map((n) => n.textContent || ""));
  check("3) применённый шаг остался на экране и помечен",
    applied.some((t) => /95/.test(t)), applied.join(" | ").slice(0, 160));
  check("нет ошибок в консоли страницы", errors.length === 0, errors.join(" / "));

  await page.screenshot({ path: path.join(ROOT, "screenshots", "agent-confirm.png"), fullPage: false });
  await browser.close();
  try { srv.proc.kill(); } catch (_) {}
  console.log(`\n${failures ? "FAILURES: " + failures : "ALL OK"}: ${checks} проверок ` +
    `(подтверждение намеренно медленное: ${process.env.EGE_TEST_CONFIRM_DELAY || "2.5"} с)`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ОШИБКА:", e && e.stack || e); process.exit(2); });
process.on("exit", () => { try { srv && srv.proc && srv.proc.kill(); } catch (_) {} });
