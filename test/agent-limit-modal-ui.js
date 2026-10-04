#!/usr/bin/env node
/* Автопоказ окна исчерпания лимита ИИ (живой Chromium).
 *
 * Как только ход обнулил квоту и допечатался последний текст ответа —
 * появляется ровно то же окно, что по клику на круг («Ходы закончились»),
 * а не раньше (не поверх недопечатанного ответа) и не просто так
 * (перезагрузка при нуле модалку сама не открывает).
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

// Квота 1: один простой ход (1 запрос к ИИ) обнуляет её целиком.
const BOOT = `
import importlib.util, os, threading, time
os.environ["EGE_DB_PATH"] = ${JSON.stringify(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ege-limitmodal-")), "ege.sqlite3"))}
os.environ["EGE_DISABLE_SYSTEMD"] = "1"
os.environ["EGE_TRUSTED_PROXY"] = "1"
os.environ["EGE_AGENT_QUOTA_MAX"] = "1"
os.environ["EGE_AI_RATE_MAX"] = "1000"
os.environ["EGE_AI_NET_RATE_MAX"] = "1000"
spec = importlib.util.spec_from_file_location("srv", ${JSON.stringify(path.join(ROOT, "server", "server.py"))})
srv = importlib.util.module_from_spec(spec); spec.loader.exec_module(srv)
ai, agent = srv._AI, srv._AGENT
conn = srv.connect(); srv.install_catalog(conn); conn.close()
WORDS = "раз два три четыре пять шесть семь восемь девять десять"
TEXT = " ".join((WORDS + " ") * 6).split()[:60]
TEXT = " ".join(TEXT)
def mock_chat(messages, tools, **kw):
    return {"text": TEXT, "tool_calls": []}
def mock_plain(messages, **kw):
    return TEXT
ai.chat_with_tools = mock_chat
ai.chat = mock_plain
ai.reset_ai_rate()
httpd = srv.create_http_server("127.0.0.1", 0)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
print("PORT", httpd.server_address[1], flush=True)
while True: time.sleep(3600)
`;

function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", ["-c", BOOT], { env: { ...process.env } });
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

const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
const dlgText = () => {
  const d = document.querySelector(".dlg-backdrop .dlg");
  return d ? d.textContent : "";
};

(async () => {
  const exe = findChrome();
  if (!exe) { console.error("SKIP: нет Chromium (EGE_CHROME)"); process.exit(2); }
  const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
  try {
    const srv = await startServer();
    BASE = `http://127.0.0.1:${srv.port}`;
    const claim = await raw("POST", "/api/profile/claim",
      { subject: "profile_math", onboarded: true, name: "Тест-Лимит" }, "");
    const jar = (claim.setCookie || []).map((c) => c.split(";")[0]).join("; ");
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

    // Сэмплируем печать и модалку: порядок обязан быть «сначала допечатал».
    await page.evaluate(() => {
      window.__samples = [];
      window.__sampler = setInterval(() => {
        window.__samples.push({
          typing: document.querySelectorAll(".agent__ww:not(.is-in)").length,
          modal: document.querySelectorAll(".dlg-backdrop .dlg").length,
        });
      }, 100);
    });
    await page.fill(sel, "вопрос про лимит");
    await page.keyboard.press("Enter");
    // Ждём именно модалку (.dlg), а не текст «Ходы закончились»: он же живёт
    // в плейсхолдере поля и появляется раньше, вместе с нулём на кольце.
    await page.waitForSelector(".dlg-backdrop .dlg", { timeout: 45000 });
    const probe = await page.evaluate(() => {
      clearInterval(window.__sampler);
      const samples = window.__samples || [];
      const modalIdx = samples.findIndex((s) => s.modal > 0);
      // Последний сэмпл с недопечатанными словами: модалка обязана быть
      // строго позже него (иначе она вылезла поверх недописанного ответа).
      let lastTypingIdx = -1;
      samples.forEach((s, i) => { if (s.typing > 0) lastTypingIdx = i; });
      return {
        samples: samples.length,
        sawTyping: samples.some((s) => s.typing > 0),
        modalIdx, lastTypingIdx,
        autoText: (document.querySelector(".dlg-backdrop .dlg") || {}).textContent || "",
        answer: (document.querySelector(".agent__answer, .agent__md") || {}).textContent || "",
        ringZero: !!(document.querySelector("#agent-quota.zero")),
      };
    });
    check("модалка «Ходы закончились» появилась сама", /Ходы закончились/.test(probe.autoText),
      probe.autoText.slice(0, 80));
    check("печать реально шла (окно не выскочило мгновенно)", probe.sawTyping,
      `сэмплов: ${probe.samples}`);
    check("модалка — после допечатки, а не поверх неё",
      probe.modalIdx >= 0 && probe.lastTypingIdx >= 0 && probe.modalIdx > probe.lastTypingIdx,
      `последнее недопечатанное на сэмпле ${probe.lastTypingIdx}, модалка на ${probe.modalIdx}`);
    check("ответ на экране целиком", probe.answer.length > 100,
      `знаков: ${probe.answer.length}`);
    check("кольцо красное (класс zero)", probe.ringZero);
    check("без JS-ошибок", errors.length === 0, errors.slice(0, 2).join(" | "));

    // То же окно, что по клику на круг: тексты совпадают один в один.
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".dlg-backdrop .dlg"), null, { timeout: 5000 });
    await page.click("#agent-quota");
    await page.waitForSelector(".dlg-backdrop .dlg", { timeout: 10000 });
    const clickText = await page.evaluate(() => ((document.querySelector(".dlg-backdrop .dlg") || {}).textContent || ""));
    check("авто-окно = окно по клику (тот же текст)", norm(clickText) === norm(probe.autoText),
      norm(clickText).slice(0, 120));
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".dlg-backdrop .dlg"), null, { timeout: 5000 });

    // Перезагрузка при нуле сама окно НЕ открывает: триггер — только
    // только что допечатанный ход, а не состояние «0».
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".agent__composer textarea, .agent__input", { timeout: 20000 });
    await page.waitForTimeout(4000);
    const afterReload = await page.evaluate(() => ({
      modal: document.querySelectorAll(".dlg-backdrop .dlg").length,
      ringZero: !!(document.querySelector("#agent-quota.zero")),
    }));
    check("перезагрузка при нуле модалку сама не открывает", afterReload.modal === 0,
      `модалок: ${afterReload.modal}`);
    check("кольцо после перезагрузки красное", afterReload.ringZero);
    check("и после перезагрузки без JS-ошибок", errors.length === 0, errors.slice(0, 2).join(" | "));

    await page.close();
    srv.proc.kill();
  } catch (e) {
    console.error("ОШИБКА ХАРНЕССА:", (e && e.message) || e);
    process.exit(2);
  }
  await browser.close();
  console.log(`\n${failures ? "FAILURES: " + failures : "ALL OK"}: ${checks} проверок`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ОШИБКА:", (e && e.stack) || e); process.exit(2); });
