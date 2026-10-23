/* Шапка и подвал с первого кадра (без догоняющего прыжка).
   Страницы со слотом [data-glass-header]/[data-ege-footer] обязаны
   подключать glass-header.js/footer.js СИНХРОННО (без defer), а сами файлы —
   монтироваться сразу при выполнении (mount вне readyState-ветки).
   Шапка-ссылка [data-glass-nav] внутри слота пересаживается в таблетку.
   Пульсирующих скелетонов каркаса нет осознанно (удалены: мельтешение
   в шапке и нижнем меню раздражало): слоты index.html пустые, рендер
   рисует настоящий хром сразу благодаря синхронному маунту.
   Запуск: node test/site-chrome.js (статика, без сервера). */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? "ok   " : "FAIL ") + name + (detail ? " | " + detail : ""));
  if (!cond) failures++;
}

const pages = fs.readdirSync(ROOT).filter((f) => f.endsWith(".html"));
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

let slotPages = 0;
for (const f of pages) {
  const html = read(f);
  if (html.includes("data-glass-header")) {
    slotPages++;
    check(`${f}: glass-header без defer`,
      /<script src="\/js\/glass-header\.js[^"]*"><\/script>/.test(html), "defer или нет тега");
    check(`${f}: без остатков site-header.css`,
      !html.includes("site-header.css"), "мёртвый CSS");
  }
  if (html.includes("data-ege-footer")) {
    check(`${f}: footer без defer`,
      /<script src="(\/)?js\/footer\.js[^"]*"><\/script>/.test(html), "defer или нет тега");
  }
}
check("слоты шапки вообще есть", slotPages > 0, String(slotPages));

for (const [file, fn] of [["js/glass-header.js", "mount"], ["js/footer.js", "mountStatic"]]) {
  const code = fs.readFileSync(path.join(ROOT, file), "utf8");
  check(`${file}: eager-монт при выполнении`,
    code.includes("try { " + fn + "(); } catch (_) {}"));
}

const index = read("index.html");
for (const id of ["sidebarNav", "topbar", "bottomnav"]) {
  check(`index.html: без скелетона в #${id}`,
    new RegExp(`id="${id}"[^>]*></(nav|header)>`).test(index));
}
const css = read("css/styles.css");
check("styles.css: без стилей chrome-skel",
  !css.includes(".chrome-skel") && !css.includes("skel-pulse"));

console.log(failures === 0 ? "ALL OK" : `FAILURES=${failures}`);
process.exit(failures === 0 ? 0 : 1);
