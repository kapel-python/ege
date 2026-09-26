const fs = require('fs');
const vm = require('vm');

let fails = 0;
const t = (name, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + name); if (!cond) fails++; };

function block(src, marker) {
  const i = src.indexOf(marker);
  if (i < 0) throw new Error('not found: ' + marker);
  let depth = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) break; }
  }
  return src.slice(i, j + 1);
}

const app = fs.readFileSync('js/app.js', 'utf8');
const admin = fs.readFileSync('js/admin.js', 'utf8');
const result = fs.readFileSync('ege-result.html', 'utf8');

/* ---- 1. icon('info') must not fall back to the crosshair ---- */
{
  const iconsSrc = app.slice(app.indexOf('const ICONS = {'), app.indexOf('};', app.indexOf('const ICONS = {')) + 2);
  const sb = { console };
  vm.createContext(sb);
  vm.runInContext(
    iconsSrc + '\nfunction icon(n){return (ICONS[n] || ICONS.target).replace("<svg ", \'<svg width="1em" \');}' +
    '\nthis.__icons = ICONS; this.__icon = icon;', sb);
  t('ICONS has an info key', typeof sb.__icons.info === 'string');
  t("icon('info') is not the target fallback", sb.__icon('info') !== sb.__icon('target'));
  t("icon('info') is real svg", sb.__icon('info').includes('<svg'));
  t('icon fallback still works for junk', sb.__icon('nope-xyz') === sb.__icon('target'));
}

/* ---- 2. renderTask must stop the previous interval ---- */
{
  const body = block(app, 'function renderTask(root)');
  const stopAt = body.indexOf('Session.stopTimer()');
  const setAt = body.indexOf('Session.timerInt = setInterval');
  t('renderTask stops the old timer', stopAt >= 0);
  t('renderTask stop happens before the new setInterval',
    stopAt >= 0 && setAt > stopAt, `stop=${stopAt} set=${setAt}`);
  t('renderTask installs exactly one interval',
    (body.match(/setInterval/g) || []).length === 1);
}

/* ---- 3. routeParam must survive a malformed hash ---- */
{
  const loc = { hash: '' };
  const sb = { location: loc, console };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(block(app, 'function routeParam('), sb);

  loc.hash = '#/lesson/abc';
  t('normal param still decodes', sb.routeParam() === 'abc');
  loc.hash = '#/lesson/%D1%82%D0%B5%D1%81%D1%82';
  t('percent-encoded param decodes', sb.routeParam() === 'тест');
  loc.hash = '#/lesson/%';
  let threw = null;
  try { sb.routeParam(); } catch (e) { threw = e; }
  t('bare % does not throw', threw === null, String(threw));
  loc.hash = '#/lesson/%E0%A4%A';
  threw = null;
  try { sb.routeParam(); } catch (e) { threw = e; }
  t('truncated escape does not throw', threw === null, String(threw));
  loc.hash = '#/lesson/%ZZ';
  threw = null;
  try { sb.routeParam(); } catch (e) { threw = e; }
  t('non-hex escape does not throw', threw === null, String(threw));
  loc.hash = '#/lesson/%';
  t('malformed param degrades to empty', sb.routeParam() === '');
  loc.hash = '#/dashboard';
  t('no-slash param still empty', sb.routeParam() === '');
}

/* ---- 4. admin safeDecode ---- */
{
  const sb = { console };
  vm.createContext(sb);
  vm.runInContext(block(admin, 'function safeDecode('), sb);
  t('safeDecode passes valid input', sb.safeDecode('%D0%B0') === 'а');
  t('safeDecode survives bare %', sb.safeDecode('%') === '');
  t('safeDecode survives bad escape', sb.safeDecode('%E0%A4%A') === '');
  t('safeDecode keeps plain text', sb.safeDecode('user-42') === 'user-42');
  t('admin.js uses safeDecode at the call site', admin.includes('screenUser(safeDecode(route.param))'));
}

/* ---- 5. esc() in ege-result.html must be attribute-safe ---- */
{
  const sb = { console };
  vm.createContext(sb);
  vm.runInContext(block(result, 'const ESC_MAP =') + '\n' + block(result, 'function esc('), sb);
  const cases = [
    ['<script>', '&lt;script&gt;'],
    ['a&b', 'a&amp;b'],
    ['say "hi"', 'say &quot;hi&quot;'],
    ["it's", 'it&#39;s'],
    ['"><img src=x onerror=alert(1)>', '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;'],
    [null, ''],
    [undefined, ''],
    [0, '0'],
  ];
  for (const [input, want] of cases) {
    const got = sb.esc(input);
    t(`esc(${JSON.stringify(input)})`, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  }
  t('esc never emits a raw double quote', !sb.esc('a"b').includes('"'));
  t('esc never emits a raw apostrophe', !sb.esc("a'b").includes("'"));
  t('esc is used in a data-id attribute', /data-id="\$\{esc\(/.test(result));
}

console.log(fails ? fails + ' FAILURES' : 'ALL ROUTE-HARDENING OK');
process.exit(fails ? 1 : 0);
