#!/usr/bin/env node
/* Smoke интерактивных модулей уроков в живом Chromium: монтирование,
 * проход шагов 0→финал, drag по кругу, квиз, завершение, cleanup.
 * Тестирует НАСТОЯЩИЕ js/ilessons/*.js + css/ilessons/*.css и сцены из
 * server/catalog*.json (тот же контент, что едет с /api/catalog-ilessons).
 * Требует playwright-core и Chromium (EGE_CHROME). Без них — код 2.
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
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

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

const LESSONS = [
  { mod: "v-trig-01", catalog: "server/catalog.json", steps: 7 },
  { mod: "v-hist-01", catalog: "server/catalog_history.json", steps: 5 },
];

(async () => {
  const exe = findChrome();
  if (!exe) { console.error("SKIP: нужен playwright-core и Chromium (EGE_CHROME)"); process.exit(2); }
  let pw = null;
  try { pw = require("playwright-core"); } catch (e) {
    console.error("SKIP: нужен playwright-core и Chromium");
    process.exit(2);
  }
  const browser = await pw.chromium.launch({ executablePath: exe });
  try {
    for (const { mod, catalog, steps } of LESSONS) {
      const js = fs.readFileSync(path.join(ROOT, "js/ilessons", mod + ".js"), "utf8");
      const css = fs.readFileSync(path.join(ROOT, "css/ilessons", mod + ".css"), "utf8");
      const cat = JSON.parse(fs.readFileSync(path.join(ROOT, catalog), "utf8"));
      const entry = (cat.interactiveLessons || []).find((x) => x.id === mod);
      t(mod + ": entry in catalog", !!entry && entry.scenes.length === steps,
        entry ? String(entry.scenes.length) : "missing");
      if (!entry) continue;
      const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
      const errors = [];
      page.on("pageerror", (e) => errors.push("pageerror: " + (e && e.message)));
      page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
      const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), "ilesson-"));
      await page.setContent(`<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<style>:root{--bg:#fff;--surface:#fff;--surface-2:#f0f3f8;--surface-3:#e3e8f1;--text:#1b2233;--text-2:#4a5872;--muted:#57647e;--border:rgba(30,41,59,.13);--border-strong:rgba(30,41,59,.24);--accent:#4a5be0;--accent-soft:rgba(109,124,255,.16);--accent-ink:#4a5be0;--violet:#9a7bff;--success:#10b981;--success-soft:rgba(16,185,129,.18);--success-ink:#15803d;--danger-ink:#cf3333;--danger-soft:rgba(255,107,107,.16);--radius:14px;--radius-sm:10px;--card-shadow:none}</style>
<style>${css}</style></head>
<body><div id="app" class="ilesson-app"></div>
<script>
window.__calls = { finished: 0, practiced: 0 };
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}
</script>
<script>${js}</script>
<script>
window.__api = {
  el: document.getElementById("app"),
  ilesson: ${JSON.stringify(entry).replace(/</g, "\\u003c")},
  skillId: ${JSON.stringify(entry.skill)},
  done: false,
  finish: function () { window.__calls.finished++; },
  practice: function () { window.__calls.practiced++; },
  path: function () {},
  toast: function () {}, esc: esc,
  mathText: function (s) { return esc(s); },
  icon: function () { return ""; },
};
window.__cleanup = window.ILessonModules[${JSON.stringify(mod)}].mount(window.__api);
</script></body></html>`);
      await page.waitForTimeout(600);
      t(mod + ": mounted without js errors", errors.length === 0, errors.join(" | ").slice(0, 300));
      const hasApp = await page.$eval("#app", (el) => el.innerHTML.length);
      t(mod + ": app rendered", hasApp > 500, String(hasApp));
      const label0 = await page.textContent(".lesson-step-label").catch(() => "");
      t(mod + ": step 1 label", /Шаг 1 из \d+/.test(label0 || ""), label0);
      await page.screenshot({ path: path.join(shotDir, "step0.png") });

      // Шагаем Дальше до финала. У истории шаг эр (2-й) требует 6 нажатий —
      // пошаговый обход глав, как в демо: жмём, пока метка шага не сменится.
      const clickNext = async () => {
        const all = await page.$$("#app button");
        for (const b of all) {
          const txt = ((await b.textContent()) || "").trim();
          if (/^Дальше|^Далее/.test(txt)) { await b.click(); return true; }
        }
        return false;
      };
      const stepLabel = () => page.textContent(".lesson-step-label").catch(() => "");
      for (let i = 1; i < steps; i++) {
        let guard = 0;
        let label = await stepLabel();
        // Квиз триги — шаг 6: отвечаем до ухода на финал.
        if (mod === "v-trig-01" && /Шаг 6 из 7/.test(label || "")) {
          const qchips = await page.$$("#app .il-op button");
          t(mod + ": quiz chips present", qchips.length >= 2, String(qchips.length));
          if (qchips.length) {
            await qchips[0].click();
            await page.waitForTimeout(400);
            const marked = await page.$$eval("#app .il-op button", (els) =>
              els.map((e) => e.className).join("|"));
            const solved = await page.textContent("#app .il-ex").catch(() => "");
            t(mod + ": quiz answer marked", /il-good|il-bad/.test(marked), marked.slice(0, 120));
            t(mod + ": quiz explanation shown", (solved || "").length > 20, (solved || "").slice(0, 80));
          }
          label = await stepLabel();
        }
        // Квиз истории живёт на шаге 4: решаем его до ухода дальше.
        if (mod === "v-hist-01" && /Шаг 4 из 5/.test(label || "")) {
          const order = await page.$$eval("#app .il-ev[data-y]", (els) =>
            els.map((e) => e.getAttribute("data-y")).join(",")).catch(() => "");
          t(mod + ": quiz options present", (order.split(",").filter(Boolean).length || 0) >= 3, order);
          if (order) {
            const years = order.split(",").map(Number).sort((a, b) => a - b);
            for (const y of years) {
              await page.click(`#app .il-ev[data-y="${y}"]`).catch(() => {});
              await page.waitForTimeout(250);
            }
            const msg = await page.textContent("#app .il-msg").catch(() => "");
            t(mod + ": quiz round solved", /Идеально|Следующий раунд/.test(msg || ""), (msg || "").slice(0, 80));
          }
          label = await stepLabel();
        }
        let advanced = false;
        while (guard++ < 9) {
          if (!(await clickNext())) break;
          await page.waitForTimeout(500);
          const now = await stepLabel();
          if (now !== label) { advanced = true; break; }
        }
        t(mod + ": next to step " + (i + 1), advanced);
        if (!advanced) break;
      }
      const labelN = await page.textContent(".lesson-step-label").catch(() => "");
      t(mod + ": reached final step", new RegExp("Шаг " + steps + " из " + steps).test(labelN || ""), labelN);
      await page.screenshot({ path: path.join(shotDir, "final.png") });

      if (mod === "v-trig-01") {
        // Возврат на шаг круга (индекс 1): жмём Назад, пока метка не станет «Шаг 2».
        for (let bi = 0; bi < 6; bi++) {
          const lab = await stepLabel();
          if (/Шаг 2 из 7/.test(lab || "")) break;
          const bbs = await page.$$("#app button");
          let went = false;
          for (const b of bbs) {
            const txt = ((await b.textContent()) || "").trim();
            if (/Назад/.test(txt)) { await b.click(); await page.waitForTimeout(400); went = true; break; }
          }
          if (!went) break;
        }
        t(mod + ": back to circle step", /Шаг 2 из 7/.test((await stepLabel()) || ""));
        const before = await page.textContent("#app").catch(() => "");
        const sv = await page.$("#app svg");
        t(mod + ": svg present", !!sv);
        if (sv) {
          const box = await sv.boundingBox();
          if (box) {
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.down();
            await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.4, { steps: 8 });
            await page.mouse.up();
            await page.waitForTimeout(400);
          }
        }
        const after = await page.textContent("#app").catch(() => "");
        t(mod + ": drag does not crash", errors.length === 0, errors.join(" | ").slice(0, 300));
        t(mod + ": drag changes live values", before !== after);
        // Вертикальный свайп по блоку круга должен скроллить страницу
        // (touch-action: pan-y), а не вязнуть в движке точки.
        // Вьюпорт уже, чем контент — иначе скроллить нечего.
        await page.setViewportSize({ width: 420, height: 500 });
        await page.waitForTimeout(300);
        const cdp = await page.context().newCDPSession(page);
        const pt = await page.$eval("#app svg", (el) => {
          const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 80 };
        }).catch(() => null);
        if (pt) {
          const y0 = await page.evaluate(() => window.scrollY);
          await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: pt.x, y: pt.y, id: 1 }] });
          for (let k = 1; k <= 8; k++) {
            await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: pt.x, y: pt.y - k * 30, id: 1 }] });
            await page.waitForTimeout(30);
          }
          await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          await page.waitForTimeout(400);
          const y1 = await page.evaluate(() => window.scrollY);
          t(mod + ": vertical swipe scrolls page", y1 > y0 + 50, y0 + " -> " + y1);
          await cdp.detach().catch(() => {});
        } else {
          t(mod + ": vertical swipe scrolls page", false, "no svg point");
        }
        // Обратно на финал для проверки завершения.
        for (let fi = 0; fi < 6; fi++) {
          const lab = await stepLabel();
          if (/Шаг 7 из 7/.test(lab || "")) break;
          const fbs = await page.$$("#app button");
          let went = false;
          for (const b of fbs) {
            const txt = ((await b.textContent()) || "").trim();
            if (/^Дальше/.test(txt)) { await b.click(); await page.waitForTimeout(400); went = true; break; }
          }
          if (!went) break;
        }
        t(mod + ": back to finale", /Шаг 7 из 7/.test((await stepLabel()) || ""));
      }

      // Финал: кнопка «Готово» завершает урок (как в обычных уроках).
      const finBtns = await page.$$("#app button");
      let finClicked = false;
      for (const b of finBtns) {
        const txt = ((await b.textContent()) || "").trim();
        if (/^Готово/.test(txt)) { await b.click(); finClicked = true; break; }
      }
      t(mod + ": finish button works", finClicked);
      await page.waitForTimeout(300);
      const finCalls = await page.evaluate(() => window.__calls.finished);
      t(mod + ": finish recorded", finCalls >= 1, String(finCalls));
      // Cleanup без ошибок.
      await page.evaluate(() => { if (typeof window.__cleanup === "function") window.__cleanup(); });
      await page.waitForTimeout(300);
      t(mod + ": cleanup without errors", errors.length === 0, errors.join(" | ").slice(0, 300));
      console.log("  shots: " + shotDir);
      await page.close();
    }
  } finally {
    await browser.close();
  }
  console.log(fails.length ? fails.length + " FAILURES" : "ALL ILESSON MODULES SMOKE OK");
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error("FAIL harness " + (e && e.stack || e));
  process.exit(1);
});
