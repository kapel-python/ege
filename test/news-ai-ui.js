#!/usr/bin/env node
/* ИИ-помощник холста новостей в живом Chromium: выбор задачи, запрос,
 * незакрываемый прогресс, вставка на пустой/занятый холст, ошибка и retry,
 * продолжение задачи после «перезагрузки» (sessionStorage + опрос того же job).
 *
 * Тестирует НАСТОЯЩИЙ код из js/admin.js (срезы по маркерам + стабы
 * esc/toast/navigate/renderLogin/AdminApi). openModal/closeModal — настоящие.
 * Требует playwright-core и Chromium (EGE_CHROME). Без них — код 2.
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright-core");

const ROOT = path.resolve(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "js/admin.js"), "utf-8");
function slice(a, b) {
  const i = src.indexOf(a), j = src.indexOf(b);
  if (i < 0 || j < 0 || j <= i) { console.error("маркер не найден: " + a.slice(0, 40)); process.exit(1); }
  return src.slice(i, j);
}
const modalSrc = slice("function openModal(html, onMount, opts)", "function bindUserActions");
const edSrc = slice("function newsEdCleanHtml(html)", "/* Пустой Enter в конце цитаты");
const aiSrc = slice("const NEWS_AI_PENDING_KEY", "function openNewsDelete");

const fails = [];
function t(name, cond, detail = "") {
  if (cond) console.log("  ok: " + name);
  else { console.log("  FAIL: " + name + " " + detail); fails.push(name); }
}

function findChrome() {
  if (process.env.EGE_CHROME && fs.existsSync(process.env.EGE_CHROME)) return process.env.EGE_CHROME;
  const root = path.join(os.homedir(), ".cache", "ms-playwright");
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
  const exe = findChrome();
  if (!exe) { console.error("SKIP: нужен playwright-core и Chromium (EGE_CHROME)"); process.exit(2); }
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<input id="cNewsTitle" value="">
<div id="cNewsBody" contenteditable="true"></div>
<div id="admin-modal-root"></div>
<script>
var A = { modalRoot: document.getElementById("admin-modal-root"), session: { user: { id: 1 } } };
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}
window.__toasts = [];
function toast(m){ window.__toasts.push(String(m)); }
window.__nav = null;
function navigate(p){ window.__nav = String(p); }
window.__login = 0;
function renderLogin(){ window.__login++; }
window.__posted = [];
window.__polls = 0;
window.__mode = "done";
var AdminApi = {
  async post(path, body){ window.__posted.push({ path, body }); return { ok: true, job: "job1", op: body.op }; },
  async get(path){
    if (String(path).includes("/ai/job1")) {
      window.__polls++;
      if (window.__mode === "error") return { job: "job1", op: "generate", status: "error", error: "Бум" };
      if (window.__polls >= 2) return { job: "job1", op: "generate", status: "done", title: "Т", bodyHtml: "<p>ИИ-текст</p>" };
      return { job: "job1", op: "generate", status: "running" };
    }
    return {};
  }
};
window.__newsAiFast = true;
</script>
<script>${modalSrc}</script>
<script>${edSrc}</script>
<script>${aiSrc}</script>
</body></html>`;
  const f = path.join(os.tmpdir(), "ege-news-ai-harness.html");
  fs.writeFileSync(f, html);
  const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  try {
    await page.goto("file://" + f);
    await page.waitForFunction(() => typeof openNewsAiSheet === "function");
    const txt = (sel) => page.evaluate((s) => document.querySelector(s).innerText, sel);

    // a) refine при пустом холсте — ошибка в том же окне.
    await page.evaluate(() => { openNewsAiSheet(); });
    await page.evaluate(() => {
      document.querySelector('input[name="fAiOp"][value="refine"]').checked = true;
    });
    await page.click("#mNext");
    t("refine пустого холста не пускает",
      (await txt("#admin-modal-root")).includes("На холсте пусто"));

    // b) generate: запрос -> прогресс (незакрываемый) -> вставка на пустой холст.
    await page.evaluate(() => {
      document.querySelector('input[name="fAiOp"][value="generate"]').checked = true;
    });
    await page.click("#mNext");
    t("окно запроса открылось", (await txt("#admin-modal-root")).includes("Что за новость"));
    await page.click("#mGo");
    t("пустой запрос не уходит", (await txt("#admin-modal-root")).includes("Напиши запрос"));
    await page.fill("#fAiPrompt", "напиши про запуск");
    await page.click("#mGo");
    await page.waitForSelector(".a-ai-load", { timeout: 3000 });
    t("прогресс незакрываемый",
      (await page.$(".a-ai-load .dlg__close, .a-ai-load .a-modal__close")) === null
      && (await page.$("#admin-modal-root .a-modal")) !== null);
    await page.waitForFunction(() => (document.getElementById("cNewsBody") || {}).innerHTML.includes("ИИ-текст"), { timeout: 8000 });
    t("текст ИИ вставлен на пустой холст",
      (await page.evaluate(() => document.getElementById("cNewsTitle").value)) === "Т");
    t("ключ pending потёрт",
      await page.evaluate(() => sessionStorage.getItem("ege_news_ai_pending") === null));
    t("тост об ИИ", (await page.evaluate(() => window.__toasts.join("|"))).includes("ИИ"));

    // c) занятый холст — подтверждение с превью, замена по кнопке.
    await page.evaluate(() => {
      window.__polls = 0; window.__toasts = [];
      document.getElementById("cNewsTitle").value = "Мой черновик";
      document.getElementById("cNewsBody").innerHTML = "<p>мой текст</p>";
      sessionStorage.removeItem("ege_news_ai_pending"); window.__newsAiJob = null;
      openNewsAiSheet();
    });
    await page.click("#mNext");
    await page.fill("#fAiPrompt", "ещё раз");
    await page.click("#mGo");
    await page.waitForFunction(() => (document.body.innerText || "").includes("Заменить текст холста"), { timeout: 8000 });
    t("превью перед заменой",
      (await txt("#admin-modal-root")).includes("ИИ-текст"));
    await page.click("#mReplace");
    t("замена применилась",
      (await page.evaluate(() => document.getElementById("cNewsBody").innerHTML)).includes("ИИ-текст"));

    // d) ошибка задачи — окно с retry, retry возвращает к выбору.
    await page.evaluate(() => {
      window.__polls = 0; window.__mode = "error"; window.__newsAiJob = null;
      document.getElementById("cNewsBody").innerHTML = "";
      openNewsAiSheet();
    });
    await page.click("#mNext");
    await page.fill("#fAiPrompt", "упади");
    await page.click("#mGo");
    await page.waitForFunction(() => (document.body.innerText || "").includes("Не получилось"), { timeout: 8000 });
    t("ошибка показана", (await txt("#admin-modal-root")).includes("Бум"));
    await page.click("#mRetry");
    t("retry ведёт к выбору",
      (await txt("#admin-modal-root")).includes("Написать с ИИ"));

    // e) «перезагрузка» посреди счёта: ключ в sessionStorage -> тот же job опрашивается.
    await page.evaluate(() => {
      window.__polls = 0; window.__mode = "done"; window.__newsAiJob = null;
      document.getElementById("admin-modal-root").innerHTML = "";
      document.getElementById("cNewsBody").innerHTML = "";
      sessionStorage.setItem("ege_news_ai_pending", JSON.stringify({ job: "job1", op: "generate", ts: Date.now() }));
      window.__posted = [];
      newsAiResumePending();
    });
    await page.waitForFunction(() => (document.getElementById("cNewsBody") || {}).innerHTML.includes("ИИ-текст"), { timeout: 8000 });
    t("resume продолжил тот же job",
      (await page.evaluate(() => window.__posted.length)) === 0
      && (await page.evaluate(() => window.__polls)) >= 2);
  } finally {
    await browser.close();
  }
  console.log(fails.length ? `AIUI FAIL (${fails.length}): ${fails.join(", ")}` : "AIUI OK");
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
