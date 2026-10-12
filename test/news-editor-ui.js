#!/usr/bin/env node
/* Редактор новостей админки в живом Chromium: кнопки-переключатели,
 * подсветка активной кнопки, выход из цитаты пустым Enter, H2-тумблер,
 * ссылка/разделитель/колонки, отсутствие кнопки «Очистить».
 *
 * Тестирует НАСТОЯЩИЙ код из js/admin.js (срез по маркерам
 * newsEditorToolbarHTML..newsToLocalInput + стабы esc/toast/A).
 * Требует playwright-core и Chromium (EGE_CHROME). Без них — код 2.
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright-core");

const ROOT = path.resolve(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "js/admin.js"), "utf-8");
const start = src.indexOf("function newsEditorToolbarHTML()");
const end = src.indexOf("function newsToLocalInput(ms)");
if (start < 0 || end < 0 || end <= start) { console.error("маркеры редактора не найдены"); process.exit(1); }
const edSrc = src.slice(start, end);
if (/data-ed=\\"clear"/.test(edSrc)) { console.error("FAIL: кнопка Очистить вернулась"); process.exit(1); }

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
  let pw = null;
  try { pw = require("playwright-core"); } catch (e) {
    console.error("SKIP: нужен playwright-core (npm i playwright-core) и Chromium (EGE_CHROME)");
    process.exit(2);
  }
  void pw;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<div class="a-editor"><div id="tb"></div><div id="area" contenteditable="true" style="min-height:100px"></div></div>
<script>
var A = {};
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}
function toast(){}
</script>
<script>${edSrc}</script>
<script>
document.getElementById("tb").outerHTML = newsEditorToolbarHTML();
var area = document.getElementById("area");
newsEditorBindToolbar(area);
window.__area = area;
</script>
</body></html>`;
  const f = path.join(os.tmpdir(), "ege-news-ed-harness.html");
  fs.writeFileSync(f, html);
  const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  try {
    await page.goto("file://" + f);
    await page.waitForFunction(() => !!window.__area);

    t("нет кнопки Очистить", await page.$('[data-ed="clear"]') === null);

    await page.evaluate(() => {
      const a = window.__area; a.innerHTML = "<p>hello world</p>"; a.focus();
      const r = document.createRange(); r.selectNodeContents(a.querySelector("p").firstChild);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    });
    await page.click('[data-ed="italic"]');
    let h = await page.evaluate(() => window.__area.innerHTML);
    t("курсив вкл", /<i>hello world<\/i>/.test(h), h);
    await page.click('[data-ed="italic"]');
    h = await page.evaluate(() => window.__area.innerHTML);
    t("курсив выкл повторным кликом", !/<i>|<em>/.test(h), h);

    await page.evaluate(() => {
      const a = window.__area; a.innerHTML = "<p><b>жирно</b> обычн</p>"; a.focus();
      const t0 = a.querySelector("b").firstChild;
      const r = document.createRange(); r.setStart(t0, 2); r.collapse(true);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      document.dispatchEvent(new Event("selectionchange"));
    });
    await page.waitForTimeout(100);
    t("кнопка Ж подсвечена в жирном",
      await page.evaluate(() => document.querySelector('[data-ed="bold"]').classList.contains("on")));

    await page.evaluate(() => {
      const a = window.__area; a.innerHTML = "<p>цитата</p>"; a.focus();
      const t0 = a.querySelector("p").firstChild;
      const r = document.createRange(); r.selectNodeContents(t0);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    });
    await page.click('[data-ed="quote"]');
    h = await page.evaluate(() => window.__area.innerHTML);
    t("цитата вкл", /<blockquote>/.test(h), h);
    await page.click('[data-ed="quote"]');
    h = await page.evaluate(() => window.__area.innerHTML);
    t("цитата выкл повторным кликом", !/<blockquote>/.test(h), h);

    await page.evaluate(() => {
      const a = window.__area; a.innerHTML = "<blockquote>мысль</blockquote>"; a.focus();
      const bq = a.querySelector("blockquote");
      const r = document.createRange(); r.selectNodeContents(bq); r.collapse(false);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    });
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    const st = await page.evaluate(() => {
      const a = window.__area;
      const sel = window.getSelection();
      let inBQ = false, n = sel.anchorNode;
      while (n && n !== a) { if (n.tagName === "BLOCKQUOTE") inBQ = true; n = n.parentElement; }
      return { html: a.innerHTML, inBQ };
    });
    t("пустой Enter выходит из цитаты", st.inBQ === false && /<blockquote>/.test(st.html), JSON.stringify(st));

    await page.evaluate(() => {
      const a = window.__area; a.innerHTML = "<p>заг</p>"; a.focus();
      const t0 = a.querySelector("p").firstChild;
      const r = document.createRange(); r.selectNodeContents(t0);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    });
    await page.click('[data-ed="h2"]');
    h = await page.evaluate(() => window.__area.innerHTML);
    t("H2 вкл", /<h2>/.test(h), h);
    await page.click('[data-ed="h2"]');
    h = await page.evaluate(() => window.__area.innerHTML);
    t("H2 выкл повторным кликом", !/<h2>/.test(h), h);

    await page.evaluate(() => { window.prompt = () => "https://egeeasy.ru/news"; });
    await page.evaluate(() => {
      const a = window.__area; a.innerHTML = "<p>тут</p>"; a.focus();
      const t0 = a.querySelector("p").firstChild;
      const r = document.createRange(); r.selectNodeContents(t0);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    });
    await page.click('[data-ed="link"]');
    h = await page.evaluate(() => window.__area.innerHTML);
    t("ссылка вставлена", /<a href="https:\/\/egeeasy\.ru\/news"/.test(h), h);
    await page.click('[data-ed="hr"]');
    h = await page.evaluate(() => window.__area.innerHTML);
    t("разделитель вставлен без мусора", /<hr>/.test(h) && !/id="null"/.test(h), h.slice(0, 160));
    await page.click('[data-ed="cols"]');
    h = await page.evaluate(() => window.__area.innerHTML);
    t("колонки вставлены", /news-cols/.test(h) && /news-col/.test(h), h.slice(0, 200));
  } finally {
    await browser.close();
  }
  console.log(fails.length ? `EDITOR FAIL (${fails.length}): ${fails.join(", ")}` : "EDITOR OK");
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
