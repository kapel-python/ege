/* SEO smoke test: robots.txt, sitemap wiring, meta tags, icons/manifest.
   Static checks only (no server needed): node test/seo.js */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
let fails = 0;
const t = (name, cond, extra) => {
  console.log((cond ? "ok  " : "FAIL") + " " + name + (cond || !extra ? "" : " :: " + extra));
  if (!cond) fails++;
};
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

/* ---- robots.txt ---- */
t("robots.txt существует", exists("robots.txt"));
if (exists("robots.txt")) {
  const robots = read("robots.txt");
  t("robots.txt разрешает корень", /^Allow:\s*\/\$/m.test(robots));
  t("robots.txt закрывает /dashboard", /^Disallow:\s*\/dashboard/m.test(robots));
  t("robots.txt закрывает /admin", /^Disallow:\s*\/admin\b/m.test(robots));
  t("robots.txt закрывает /api/", /^Disallow:\s*\/api\//m.test(robots));
  t("robots.txt ссылается на sitemap абсолютным URL", /^Sitemap:\s*https:\/\/\S+\/sitemap\.xml/m.test(robots));
}

/* ---- llms.txt ---- */
t("llms.txt существует", exists("llms.txt"));

/* ---- icons / manifest / og ---- */
t("favicon.svg существует", exists("favicon.svg"));
t("site.webmanifest существует и валиден", (() => {
  try { JSON.parse(read("site.webmanifest")); return true; } catch (e) { return false; }
})());
for (const img of ["assets/seo/icon-192.png", "assets/seo/icon-512.png",
                   "assets/seo/apple-touch-icon.png", "assets/seo/og-image.png"]) {
  t(img + " существует и это PNG", exists(img) &&
    fs.readFileSync(path.join(ROOT, img)).subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
}

/* ---- main.html (лендинг — единственная индексируемая страница) ---- */
const landing = read("main.html");
t("лендинг: lang=ru", /<html[^>]*lang="ru"/.test(landing));
t("лендинг: ровно один h1", (landing.match(/<h1[\s>]/g) || []).length === 1);
t("лендинг: canonical абсолютный на прод-домен", /<link rel="canonical" href="https:\/\/egeeasy\.ru\/">/.test(landing));
t("лендинг: og:url и og:image абсолютные", /<meta property="og:url" content="https:\/\/egeeasy\.ru\/">/.test(landing) &&
  /<meta property="og:image" content="https:\/\/egeeasy\.ru\/assets\/seo\/og-image\.png">/.test(landing));
t("лендинг: meta robots index", /<meta name="robots" content="index/.test(landing));
t("лендинг: description 50+ символов", (() => {
  const m = landing.match(/<meta name="description" content="([^"]*)"/);
  return !!m && m[1].length >= 50;
})());
t("лендинг: Open Graph (type/title/image/url)", ["og:type", "og:title", "og:image", "og:url"]
  .every((p) => landing.includes('property="' + p + '"')));
t("лендинг: twitter card", landing.includes('name="twitter:card"'));
t("лендинг: JSON-LD с Course и FAQPage", landing.includes('application/ld+json') &&
  landing.includes('"@type":"Course"') && landing.includes('"FAQPage"'));
t("лендинг: theme-color", landing.includes('name="theme-color"'));
t("лендинг: manifest + apple-touch-icon", landing.includes('rel="manifest"') &&
  landing.includes('rel="apple-touch-icon"'));
t("лендинг: og:image существует в репо", (() => {
  const m = landing.match(/<meta property="og:image" content="https:\/\/egeeasy\.ru(\/[^"]*)"/);
  return !!m && exists(m[1].replace(/^\//, ""));
})());
t("лендинг: JSON-LD URL абсолютные", !landing.includes('"url":"/"') && landing.includes('"url":"https://egeeasy.ru/"'));
t("лендинг: декоративные svg скрыты от скринридеров",
  !/<svg(?![^>]*aria-hidden)/.test(landing.replace(/<script[\s\S]*?<\/script>/g, "")));

/* ---- index.html (приложение — не индексируется) ---- */
const app = read("index.html");
t("приложение: meta robots noindex", /<meta name="robots" content="noindex, nofollow">/.test(app));
t("приложение: canonical на /", /<link rel="canonical" href="\/">/.test(app));

/* ---- server.py wiring ---- */
const server = read("server/server.py");
t("сервер: allowlist публичных файлов", /PUBLIC_STATIC_FILES.*robots\.txt/.test(server));
t("сервер: robots.txt не отдаёт 404 (.txt allowlist)",
  /BLOCKED_STATIC_SUFFIXES and file_path\.name not in PUBLIC_STATIC_FILES/.test(server) ||
  /_is_blocked_static\(file_path\) and file_path\.name not in PUBLIC_STATIC_FILES/.test(server));
t("сервер: MIME для txt/xml/webmanifest/ico",
  ['".txt": "text/plain', '".xml": "application/xml', '".webmanifest": "application/manifest+json"', '".ico": "image/x-icon"']
    .every((s) => server.includes(s)));
t("сервер: динамический /sitemap.xml с абсолютными loc", server.includes('path == "/sitemap.xml"') &&
  server.includes("<loc>{base}/</loc>"));
t("сервер: sitemap только для лендинга (без /dashboard)", !/<loc>\{base\}\/dashboard/.test(server));
t("сервер: X-Robots-Tag noindex для API", (() => {
  const i = server.indexOf("no-store");
  return i > 0 && server.slice(i, i + 400).includes("X-Robots-Tag");
})());
t("сервер: X-Robots-Tag noindex для /dashboard, /admin и /contacts",
  server.includes('path in ("/dashboard", "/admin", "/contacts")') && server.includes('"X-Robots-Tag", "noindex, nofollow"'));
t("сервер: www-дубль клеится 301 на apex", server.includes('bare.startswith("www.")') &&
  server.includes('self.send_response(301)') && server.includes('"Location", "//" + apex'));
t("сервер: маршрут /about отдаёт about.html", server.includes('path == \'/about\'') &&
  server.includes('ROOT / "about.html"'));
t("сервер: несуществующие URL отдают фирменную 404", server.includes("serve_not_found_page") &&
  server.includes('ROOT / "404.html"') && exists("404.html") && exists("about.html"));

console.log(fails ? `\n${fails} FAILURES` : "\nALL OK");
process.exit(fails ? 1 : 0);
