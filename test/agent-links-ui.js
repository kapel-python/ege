#!/usr/bin/env node
/* Живая проверка ссылок в ответе наставника: markdown-ссылка и голый адрес
 * должны стать синей плашкой фирменного стиля, внешняя — открываться в новой
 * вкладке с rel=noopener, внутренняя — нет, опасная схема — вырезаться.
 *
 * Требует playwright-core и Chromium (EGE_CHROME, ищется сам).
 */
const path = require("path");
const fs = require("fs");
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
  for (const d of fs.readdirSync(root)) {
    for (const rel of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
      const p = path.join(root, d, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

const HTML = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<link rel="stylesheet" href="FILECSS">
<style>:root{--bg:#e9edf4;--surface:#fff;--accent:#6d7cff;--accent-ink:#4a5be0;--text:#1b2233;}</style></head><body>
<div id="live"></div>
<script src="FILEMARKED"></script>
<script src="FILEPURIFY"></script>
<script src="FILESPA"></script>
</body></html>`;

/* Вырезаем нужные куски из agent-spa.js: разметку ответа + печать по словам. */
function extract() {
  const src = fs.readFileSync(path.join(__dirname, "..", "js", "agent-spa.js"), "utf8");
  const cut = (start, end) => {
    const a = src.indexOf(start);
    const b = src.indexOf(end, a + start.length);
    if (a < 0 || b < 0) throw new Error("не найден блок: " + start);
    return src.slice(a, b);
  };
  const links = cut("  var SAFE_SCHEME", "  /* Печать готового DOM");
  const md = cut("  function mdBlocks", "  /* ---------- ссылки в ответе");
  const typed = cut("  function buildTypedDom", "  function buildTyped(");
  const el = `  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }`;
  return [el, links, md, typed].join("\n");
}

(async () => {
  const exe = findChrome();
  if (!exe) { console.error("SKIP: нет Chromium (EGE_CHROME)"); process.exit(2); }
  const root = path.join(__dirname, "..");
  const tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "ege-links-"));
  const css = path.join(root, "css", "agent.css");
  const html = HTML
    .replace("FILECSS", "file://" + css)
    .replace("FILEMARKED", "file://" + path.join(root, "vendor", "md", "marked.min.js"))
    .replace("FILEPURIFY", "file://" + path.join(root, "vendor", "md", "purify.min.js"))
    .replace("FILESPA", "file://" + path.join(root, "js", "agent-spa.js") + "?x=" + Date.now());
  const page = path.join(tmp, "index.html");
  fs.writeFileSync(page, html);
  // рядом с файлом нужен сам agent-spa.js, подключаем инлайном нужные куски
  fs.writeFileSync(page, html.replace(/<script src="FILE[^>]*><\/script>/g, ""));

  const inline = `
<script src="file://${path.join(root, "vendor", "md", "marked.min.js")}"></script>
<script src="file://${path.join(root, "vendor", "md", "purify.min.js")}"></script>
<script>${extract()}
window.mdBlocks = mdBlocks; window.buildTypedDom = buildTypedDom;</script>`;
  fs.writeFileSync(page, html.replace("</body>", inline + "</body>"));

  const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
  const p = await browser.newPage({ viewport: { width: 420, height: 700 } });
  await p.goto("file://" + page, { waitUntil: "load" });

  const out = await p.evaluate(() => {
    const text = [
      "Первоисточник — [ФИПИ](https://fipi.ru).",
      "Подпись со служебным словом: [открыть материалы ФИПИ](https://fipi.ru/ege).",
      "Подпись с хвостом: [разбор темы — подробнее тут](https://ege.example/razbor).",
      "Название со словом внутри: [оценка сочинения ФИПИ](https://fipi.ru/criteria).",
      "Голый адрес тоже ссылка: https://obrazovaka.sdamgia.ru/problem?id=1234",
      "Внутренняя: [МОЙ ПРОФИЛЬ](/dashboard#/profile).",
      "Опасная: [клик](javascript:alert(1))",
      "Курсив *вот так* и **жирный** работают.",
    ].join("\n\n");
    const blocks = window.mdBlocks(text);
    const live = document.getElementById("live");
    blocks.forEach((b) => live.appendChild(b));
    const typed = window.buildTypedDom(live);
    const links = Array.prototype.slice.call(live.querySelectorAll("a"));
    const css = getComputedStyle(links[0]);
    return {
      links: links.map((a) => ({
        href: a.getAttribute("href"),
        target: a.getAttribute("target"),
        rel: a.getAttribute("rel"),
        cls: a.className,
        text: a.textContent,
        // Что реально ВИДИТ человек: text-transform в computedStyle отражает
        // подпись после капитализации, а textContent остаётся исходным.
        shown: getComputedStyle(a).textTransform,
      })),
      linkCount: links.length,
      typedCount: typed.length,
      style: {
        display: css.display,
        color: css.color,
        border: css.borderTopWidth,
        radius: css.borderTopLeftRadius,
        padding: css.paddingLeft,
        weight: css.fontWeight,
        underline: css.textDecorationLine,
      },
      mdBlocks: blocks.length,
      italic: !!live.querySelector("em"),
      bold: !!live.querySelector("strong"),
    };
  });

  const byHref = (h) => out.links.find((a) => a.href === h) || {};
  const md = byHref("https://fipi.ru");
  const noisePrefix = byHref("https://fipi.ru/ege");
  const noiseSuffix = byHref("https://ege.example/razbor");
  const bare = byHref("https://obrazovaka.sdamgia.ru/problem?id=1234");
  const internal = byHref("/dashboard#/profile");
  const inner = byHref("https://fipi.ru/criteria");
  const bad = out.links.find((a) => !a.href && a.text) || {};

  check("markdown-ссылка стала плашкой фирменного стиля",
    md.cls === "agent__link" && out.style.display === "inline-block"
    && out.style.radius !== "0px" && out.style.border !== "0px"
    && out.style.weight !== "400", JSON.stringify(out.style));
  check("цвет текста — фирменный синий --accent-ink (контраст ≥ AA)",
    out.style.color === "rgb(74, 91, 224)", out.style.color);
  check("ссылка не подчёркнута (плашка, а не текст веба)",
    out.style.underline === "none", out.style.underline);
  check("внешняя ссылка открывается в новой вкладке и безопасно",
    md.href === "https://fipi.ru" && md.target === "_blank"
    && /noopener/.test(md.rel || ""), JSON.stringify(md));
  check("голый адрес тоже стал ссылкой",
    bare.href === "https://obrazovaka.sdamgia.ru/problem?id=1234" && /agent__link/.test(bare.cls || ""),
    JSON.stringify(bare));
  check("внутренняя ссылка без новой вкладки и помечена пунктиром",
    internal.href === "/dashboard#/profile" && !internal.target
    && /agent__link--int/.test(internal.cls || ""), JSON.stringify(internal));
  check("опасная схема вырезана, но текст остался",
    !bad.href && bad.text === "клик", JSON.stringify(bad));
  check("в подписи нет служебных слов «сайт/перейти» — только название",
    out.links.every((a) => !/\b(сайт|страница|перейти|открыть|ссылка)\b/i.test(a.text || "")),
    JSON.stringify(out.links.map((a) => a.text)));
  check("служебное слово В НАЧАЛЕ подписи убрано — осталось название",
    String(noisePrefix.text).toUpperCase() === "МАТЕРИАЛЫ ФИПИ" && noisePrefix.href === "https://fipi.ru/ege",
    JSON.stringify(noisePrefix));
  check("служебные слова В КОНЦЕ подписи убраны",
    String(noiseSuffix.text).toUpperCase() === "РАЗБОР ТЕМЫ", JSON.stringify(noiseSuffix));
  check("слово ВНУТРИ названия не вырезано (это часть названия, а не шум)",
    String(inner.text).toUpperCase() === "ОЦЕНКА СОЧИНЕНИЯ ФИПИ",
    `подпись: ${inner.text}`);
  check("в подписи нет служебных слов «сайт/перейти» — только название",
    md.shown === "uppercase", md.shown);
  check("сырой длинный адрес НЕ капиталится (иначе нечитаем)",
    bare.shown === "none" && /agent__link--raw/.test(bare.cls || ""),
    JSON.stringify({ shown: bare.shown, cls: bare.cls }));
  check("внутренняя ссылка тоже заглавными",
    internal.shown === "uppercase", internal.shown);
  check("ссылка печатается ЦЕЛИКОМ, а не по словам",
    out.typedCount > 0, `элементов печати: ${out.typedCount}`);
  check("остальная разметка не сломалась",
    out.italic && out.bold, `курсив=${out.italic}, жирный=${out.bold}`);

  await p.screenshot({ path: path.join(root, "screenshots", "agent-links.png"), fullPage: true });
  await browser.close();
  console.log(`\n${failures ? "FAILURES: " + failures : "ALL OK"}: ${checks} проверок`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ОШИБКА:", e && e.stack || e); process.exit(2); });