/* css/dlg.css — общий базовый CSS, который подключается ПОСЛЕ основного CSS
   страницы (index.html: styles.css → dlg.css). Поэтому он не имеет права
   объявлять «чужие» классы с ненулевой специфичностью: `.btn` из dlg.css
   (0-1-0) позже `.btn` из styles.css и потому перебивал в приложении
   .btn--sm / .btn--lg / .theme-toggle. Именно так кнопка смены темы в шапке
   осталась кликабельной, но невидимой: .btn-овский `padding: 10px 18px`
   съедал `.theme-toggle { padding: 0 }`, иконка сжималась в 0 px, а
   border-color из .btn--ghost возвращался к transparent.
   Инвариант: всё, что не .dlg*, в dlg.css живёт только внутри :where(). */
const fs = require("fs");

let fails = 0;
const t = (name, cond, extra) => {
  console.log((cond ? "ok   " : "FAIL ") + name + (extra ? " — " + extra : ""));
  if (!cond) fails++;
};

const dlg = fs.readFileSync("css/dlg.css", "utf8");
const styles = fs.readFileSync("css/styles.css", "utf8");
const index = fs.readFileSync("index.html", "utf8");

/* --- 1. dlg.css не перебивает страницу-хозяина: чужие классы только в :where() --- */
const dlgSrc = dlg.replace(/\/\*[\s\S]*?\*\//g, " ");
const selectors = [];
const ruleRe = /([^{}]+)\{([^{}]*)\}/g;   // вложенных правил внутри @media тут нет
let m;
while ((m = ruleRe.exec(dlgSrc)) !== null) {
  const prelude = m[1].trim();
  if (prelude.startsWith("@") || /^(from|to|\d+%)$/.test(prelude)) continue;   // @keyframes/@media
  for (const raw of prelude.split(",")) {
    const sel = raw.replace(/\s+/g, " ").trim();
    if (sel) selectors.push(sel);
  }
}
t("в dlg.css есть правила кнопок", selectors.some((s) => s.includes("btn")), `${selectors.length} селекторов`);

// Чужой класс (не .dlg*) допустим только внутри :where() (специфичность 0)
// либо под предком .dlg*: иначе dlg.css перебивает страницу-хозяина.
const isForeign = (sel) => {
  const compounds = sel.split(/\s*[>+~]\s*|\s+/).filter(Boolean);
  return compounds.some((comp, i) => {
    const names = [...comp.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((x) => x[1]);
    if (!names.length) return false;
    const foreign = names.filter((n) => !n.startsWith("dlg"));
    if (!foreign.length) return false;
    const before = compounds.slice(0, i).join(" ");
    return !/\.dlg[A-Za-z0-9_-]*/.test(before);
  });
};
const foreign = selectors.filter((sel) => isForeign(sel.replace(/:where\([^)]*\)/g, " ")));
t("в dlg.css нет чужих классов вне :where() и вне .dlg*-контейнера", foreign.length === 0, foreign.join(" | "));
t("namespaced override .dlg .chip остался (перенос длинных слов в окне)",
  selectors.includes(".dlg .chip"));
t("namespaced override .dlg__actions--single .btn остался",
  selectors.includes(".dlg__actions--single .btn"));

const buttonRules = selectors.filter((s) => /\.btn/.test(s) && !/\.dlg/.test(s));
t("правила кнопок в dlg.css обёрнуты в :where()", buttonRules.every((s) => s.startsWith(":where(")), buttonRules.join(" | "));
t("базовый .btn в dlg.css остался (страницы вне SPA)", buttonRules.includes(":where(.btn)"));

/* --- 2. сам хост отдаёт модификаторы, которые нельзя терять --- */
t("styles.css задаёт базовый .btn", /^\.btn \{/m.test(styles));
t("styles.css задаёт .btn--sm с меньшим padding", /\.btn--sm \{ padding: 6px 12px;/.test(styles));
t("styles.css задаёт .btn--lg с большим padding", /\.btn--lg \{ padding: 13px 26px;/.test(styles));
t("styles.css задаёт .theme-toggle без padding", /\.theme-toggle \{[\s\S]*?padding: 0;/.test(styles));

/* --- 3. dlg.css подключается после основного CSS (иначе инвариант не нужен) --- */
const iStyles = index.indexOf("css/styles.css");
const iDlg = index.indexOf("css/dlg.css");
t("index.html подключает dlg.css после styles.css", iStyles > 0 && iDlg > iStyles);
t("версия dlg.css в index.html и ege-result.html одна",
  /css\/dlg\.css\?v=\d+/.test(index)
  && index.match(/css\/dlg\.css\?v=(\d+)/)[1] === fs.readFileSync("ege-result.html", "utf8").match(/css\/dlg\.css\?v=(\d+)/)[1]);

console.log(fails ? `\n${fails} FAILURES` : "\nALL OK");
process.exit(fails ? 1 : 0);
