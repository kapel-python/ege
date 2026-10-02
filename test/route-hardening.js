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

/* ---- 7. Отказ явной привязки Google: окно в профиле, а не тихий вход ----
   Живой случай: человек нажал «Привязать Google» и выбрал адрес, который уже
   привязан к ЧУЖОМУ профилю. Сервер отдавал error=conflict, но уводил на
   #/login?error=…, где залогиненный человек видит «Вы уже вошли» — то есть
   причина съедалась молча (а ветка «личность уже привязана» и вовсе сажала
   его в чужой аккаунт). Здесь контракт: причина едет в профиль, там окно в
   общем стиле .dlg, и параметры возврата снимаются ровно один раз. */
{
  const server = fs.readFileSync('server/server.py', 'utf8');

  // Сервер: гейт ДО обычного повторного входа (порядок и был дырой).
  const finish = block(server, 'def finish_google_login(');
  const takenAt = finish.indexOf('error=taken');
  const loginIntoAt = finish.indexOf('self.finish_login_into(');
  t('сервер знает про отказ «аккаунт занят» (error=taken)', takenAt >= 0);
  t('гейт занятого аккаунта стоит ДО обычного входа по уже привязанной личности',
    takenAt >= 0 && loginIntoAt > takenAt, `taken=${takenAt} login=${loginIntoAt}`);
  t('отказ привязки возвращает в профиль, а не на экран входа',
    /refusal_route = "profile" if intent == "link"/.test(finish)
    && finish.includes('oauth_return_url(self, refusal_route, "error=taken")')
    && finish.includes('oauth_return_url(self, refusal_route, "error=conflict")'));
  t('отказ привязки не трогает ни аккаунт, ни привязки (нет записи до возврата)',
    takenAt >= 0 && !/link_auth_identity\([^)]*\)[\s\S]{0,400}error=taken/.test(finish));

  // Клиент: у отказа есть и текст, и маршрут.
  const refusals = app.slice(app.indexOf('const GOOGLE_LINK_REFUSALS = {'),
    app.indexOf('\n};', app.indexOf('const GOOGLE_LINK_REFUSALS = {')) + 2);
  for (const key of ['taken', 'conflict']) {
    t(`есть текст отказа ${key}`, new RegExp(`\\b${key}:\\s*\\{`).test(refusals));
    t(`отказ ${key} объясняет, что аккаунт уже занят`,
      new RegExp(`${key}:[\\s\\S]*?already|${key}:[\\s\\S]*?уже`).test(refusals)
      && refusals.includes('Этот аккаунт уже занят'));
  }
  t('тексты отказов не обещают переключение на другой аккаунт',
    !/переключ(им|аем|ить) тебя на/.test(refusals) && !/войд(ём|и) в другой аккаунт/.test(refusals));

  const route = block(app, 'function routeGoogleReturn(');
  t('отказ привязки уводит в профиль, а не на экран входа',
    /GOOGLE_LINK_REFUSALS\[error\]/.test(route) && route.includes('#/profile?error='));
  // Признак — accountId (есть сессия), а НЕ registered: после отвязки
  // единственного входа registered=false, хотя человек всё ещё залогинен, и
  // проверка по registered уводила отказ на экран входа.
  t('гейт отказа — наличие сессии (accountId), а не registered',
    /Store\.accountId/.test(route) && !/Store\.auth && Store\.auth\.registered/.test(route));
  t('уже в профиле — хэш не переписывают (иначе нет события и модалка не встанет)',
    /уже в профиле/i.test(route) && /if \(currentRoute\(\) === "profile"\) return;/.test(route));
  t('без сессии чужой хвост чистят, а не пугают формой входа',
    /clearHashQuery\(\);/.test(route) && /без сессии/i.test(route));

  // Экран входа отказы привязки не показывает никогда: залогиненного уводит
  // обратно в профиль, разлогиненному полосу не рисует.
  const login = block(app, 'function screenLogin(');
  t('экран входа уводит залогиненного с отказом привязки обратно в профиль',
    /GOOGLE_LINK_REFUSALS\[errorReason\]/.test(login) && login.includes('#/profile?error='));
  t('экран входа не рисует полосу под отказ привязки',
    /!GOOGLE_LINK_REFUSALS\[errorReason\]/.test(login));

  const refusal = block(app, 'function showGoogleLinkRefusal(');
  t('отказ показывается один раз (параметры возврата снимаются)',
    refusal.indexOf('hashQueryValue("error")') >= 0
    && refusal.indexOf('clearHashQuery()') > refusal.indexOf('if (!refusal) return false;')
    && refusal.indexOf('clearHashQuery()') < refusal.indexOf('openInfoDialog('));
  t('неизвестная причина не открывает окно', /if \(!refusal\) return false;/.test(refusal));
  t('профиль зовёт показ отказа', /showGoogleLinkRefusal\(\)/.test(block(app, 'function screenProfile(')));

  // Окно — общий .dlg-стиль (тот же контейнер и та же кнопка закрытия), а не
  // своя разметка: единый вид здесь и есть требование.
  const info = block(app, 'function openInfoDialog(');
  t('справочное окно живёт в общем контейнере диалогов',
    /deviceModalRoot\(\)/.test(info) && /closeDeviceModal\(\)/.test(info));
  t('справочное окно в том же классе .dlg и закрывается по Esc',
    /class="dlg"/.test(info) && /deviceModalEscHandler/.test(info));
  t('у справочного окна одна кнопка «Понятно»',
    /dlg__actions--single/.test(info) && /o\.closeText \|\| "Понятно"/.test(info));

  // Профиль залогиненного без способа входа — не «гость»: после отвязки
  // единственного Google аккаунт и сессия живы, и показывать «Гостевой
  // профиль» значит убедить человека, что аккаунт пропал (живой случай:
  // почта «пропала», кнопка «Привязать Google» исчезла после перезагрузки).
  const account = block(app, 'function accountAuthHTML(');
  t('профиль различает гостя и залогиненного без способа входа',
    /Store\.accountId && auth\.email/.test(account));
  t('состояние без способа входа показывает почту, а не «Гостевой профиль»',
    /chip--warn/.test(account) && /нет способа входа/.test(account)
    && /auth-status__email/.test(account));
  t('кнопка «Привязать Google» живёт и в этом состоянии (перезагрузка её не съедает)',
    (account.match(/google-row-holder/g) || []).length >= 2);
  t('гостю по-прежнему предлагают войти/зарегистрироваться',
    /Гостевой профиль/.test(account) && /Войти или зарегистрироваться/.test(account));

  // Кнопка выхода видна любому залогиненному (раньше при registered=false её
  // не было вовсе), а текст честен про отсутствие пути назад.
  const profile = block(app, 'function screenProfile(');
  t('кнопка выхода видна по наличию сессии, а не registered',
    /\$\{Store\.accountId \?/.test(profile));
  const askLogout = block(app, 'function askLogoutAccount(');
  t('выход без способа входа честно предупреждает, что назад не зайти',
    /noEntry/.test(askLogout) && /нет способа входа/.test(askLogout));

  // Сервер не прячет свою же почту: bootstrap-срез обязан совпадать с
  // /api/auth/session, иначе сверка клиента делает лишний render и гасит окно.
  const statePayload = block(server, 'def auth_state_payload(');
  t('bootstrap-срез отдаёт почту и без registered',
    /"email": row\["email"\] if row else None/.test(statePayload)
    && !/if registered else None/.test(statePayload));
}

console.log(fails ? fails + ' FAILURES' : 'ALL ROUTE-HARDENING OK');
process.exit(fails ? 1 : 0);
