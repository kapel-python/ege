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

/* ---- 3b. currentRoute must ignore the return-parameter tail ----
   Живой баг: сервер возвращает человека из Google на #/subject, а при
   ошибке — на #/login?error=state. Хвост «?…» — это ПАРАМЕТРЫ, а не часть
   имени раздела, но currentRoute() резал только по «/», поэтому маршрут
   получался «login?error=state», ни один экран не совпадал, и render()
   падал в dashboard. Там неонбордившийся человек видел онбординг — то есть
   возврат из внешнего входа выглядел как «вход не сработал». */
{
  const loc = { hash: '' };
  const sb = { location: loc, console };
  vm.createContext(sb);
  vm.runInContext(block(app, 'function currentRoute('), sb);
  const cases = [
    ['#/dashboard', 'dashboard'],
    ['#/login', 'login'],
    ['#/login?error=state', 'login'],
    ['#/subject', 'subject'],
    ['#/login?error=conflict&x=1', 'login'],
    ['#/lesson/abc', 'lesson'],
    ['#/lesson/abc?from=path', 'lesson'],
    ['', 'dashboard'],
    ['#/', 'dashboard'],
  ];
  for (const [hash, want] of cases) {
    loc.hash = hash;
    t(`currentRoute(${JSON.stringify(hash)}) === ${want}`, sb.currentRoute() === want,
      `got ${JSON.stringify(sb.currentRoute())}`);
  }
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

/* ---- 6. auth-срез нельзя терять при перезаписи ----
   Живой баг: в профиле есть пересчёт по /api/auth/session, который
   переписывал Store.auth парой {registered, email}. Флаги providers,
   googleEnabled и hasPassword при этом исчезали, и кнопка «Войти через
   Google» пропадала с экранов входа и регистрации — при том, что настройка
   на сервере была в порядке. Присваивания многострочные, поэтому режем их
   по «;», а не по строкам. */
{
  const state = fs.readFileSync('js/state.js', 'utf8');
  const FIELDS = ['providers', 'googleEnabled', 'hasPassword'];
  t('в Store.auth по умолчанию есть все признаки',
    FIELDS.every((f) => state.includes(f + ':')));

  const writes = (src, re) => {
    const out = [];
    for (const m of src.matchAll(re)) {
      let i = m.index, depth = 0, seen = false;
      for (; i < src.length; i++) {
        const ch = src[i];
        if (ch === '{') { depth++; seen = true; }
        else if (ch === '}') { depth--; if (seen && depth === 0) { i++; break; } }
      }
      out.push(src.slice(m.index, i));
    }
    return out;
  };
  const appW = writes(app, /(?:Store|this)\.auth\s*=\s*\{/g);
  t('в app.js один писатель Store.auth (пересчёт профиля)', appW.length === 1,
    `найдено ${appW.length}`);
  t('пересчёт профиля сохраняет остальные поля (...cur)',
    !!appW[0] && /\.\.\.cur/.test(appW[0]), (appW[0] || '').slice(0, 60));
  for (const f of FIELDS) {
    t(`писатель в app.js не выбрасывает ${f}`,
      !appW[0] || new RegExp(f).test(appW[0]) || /\.\.\.cur/.test(appW[0]));
  }

  const stateW = writes(state, /this\.auth\s*=\s*[\{a-z]/g);
  t('в state.js два писателя auth-среза', stateW.length === 2, `найдено ${stateW.length}`);
  for (const w of stateW) {
    const keepsAll = FIELDS.every((f) => w.includes(f)) || /\.\.\.this\.auth/.test(w);
    t(`писатель в state.js сохраняет все признаки: ${w.slice(0, 34)}…`, keepsAll);
  }

  // Кнопка входа обязана зависеть от googleEnabled, а не от registered:
  // registered гаснет после отвязки единственного способа входа.
  const signIn = block(app, 'function googleSignInHTML(');
  t('кнопка «Войти через Google» рисуется по googleEnabled',
    !!signIn && /Store\.auth\.googleEnabled/.test(signIn) && !/Store\.auth\.registered/.test(signIn));
  const row = block(app, 'function googleRowHTML(');
  t('блок в профиле показывается по наличию аккаунта, а не registered',
    !!row && /Store\.accountId && auth\.googleEnabled/.test(row) && !/auth\.registered &&/.test(row));
}

console.log(fails ? fails + ' FAILURES' : 'ALL ROUTE-HARDENING OK');
process.exit(fails ? 1 : 0);
