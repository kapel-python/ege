const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync('js/app.js', 'utf8');

function extract(name, from = 0) {
  const i = src.indexOf(name, from);
  if (i < 0) throw new Error('not found: ' + name);
  // crude block extraction: from function start to matching close at col 0
  let depth = 0, j = src.indexOf('{', i), start = j;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) break; }
  }
  return src.slice(i, j + 1);
}

const loc = { hash: '' };
const sandbox = {
  location: loc,
  localStorage: { _m: {}, getItem(k) { return this._m[k] ?? null; }, setItem(k, v) { this._m[k] = v; }, removeItem(k) { delete this._m[k]; } },
  console,
};
sandbox.window = sandbox;
vm.createContext(sandbox);

const code = [
  extract('function go('),
  extract('function currentRoute('),
  extract('function hashQueryValue('),
  extract('function clearSeoSubjectParam('),
  extract('function routeParam('),
  extract('function answerFormatHint('),
  extract('function sessionMatchesRoute('),
  'const LESSON_STEP_LABELS = ' + src.slice(src.indexOf('const LESSON_STEP_LABELS = ') + 27, src.indexOf('};', src.indexOf('const LESSON_STEP_LABELS = ')) + 2),
].join('\n');
vm.runInContext(code, sandbox);

let fails = 0;
const t = (name, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + name); if (!cond) fails++; };

// router
sandbox.location.hash = '#/lesson/lesson_n03_stereometry';
t('route lesson', sandbox.currentRoute() === 'lesson');
t('param lesson id', sandbox.routeParam() === 'lesson_n03_stereometry');
sandbox.location.hash = '#/practice/m-n01_planimetry';
t('route practice', sandbox.currentRoute() === 'practice' && sandbox.routeParam() === 'm-n01_planimetry');
sandbox.location.hash = '#/dashboard';
t('empty param', sandbox.routeParam() === '');
sandbox.location.hash = '';
t('empty hash -> dashboard', sandbox.currentRoute() === 'dashboard');

// публичный вход из поиска: ?seo_subject= — не часть id/маршрута
sandbox.location.hash = '#/skill/r01?seo_subject=russian';
t('seo route stays skill', sandbox.currentRoute() === 'skill');
t('seo param strips seo_subject', sandbox.routeParam() === 'r01');
t('seo subject readable', sandbox.hashQueryValue('seo_subject') === 'russian');
sandbox.location.hash = '#/skill/r01?foo=1&seo_subject=biology';
t('seo subject after other params', sandbox.hashQueryValue('seo_subject') === 'biology');
t('seo param with other params', sandbox.routeParam() === 'r01');
sandbox.location.hash = '#/lesson/a%2Fb?seo_subject=x';
t('seo encoded slash survives', sandbox.routeParam() === 'a/b');
sandbox.location.hash = '#/skill/abc%3Fdef?seo_subject=russian';
t('seo encoded question survives', sandbox.routeParam() === 'abc?def');
sandbox.location.hash = '#/lesson/%';
t('seo broken escape -> empty', sandbox.routeParam() === '');
// clearSeoSubjectParam: сносит только seo_subject, чужие хвосты живут
sandbox.history = { _url: '', replaceState(a, b, u) { this._url = u; } };
sandbox.location.hash = '#/skill/r01?seo_subject=russian';
sandbox.clearSeoSubjectParam();
t('seo tail removed', sandbox.history._url === '#/skill/r01');
sandbox.location.hash = '#/skill/r01?error=x&seo_subject=russian';
sandbox.clearSeoSubjectParam();
t('foreign tail kept', sandbox.history._url === '#/skill/r01?error=x');
sandbox.location.hash = '#/skill/r01';
sandbox.history._url = 'untouched';
sandbox.clearSeoSubjectParam();
t('no tail -> no-op', sandbox.history._url === 'untouched');

// format hints
t('int', sandbox.answerFormatHint('12', 'целое число') === 'целое число');
t('degrees', sandbox.answerFormatHint('45', 'целое число (градусы)') === 'целое число (в градусах)');
t('fraction', sandbox.answerFormatHint('0,3', 'конечная десятичная дробь').includes('запятая'));
t('lesson decimal fallback', sandbox.answerFormatHint('2.7').includes('запятая'));
t('expression', sandbox.answerFormatHint('6x-2') === 'выражение');
t('unit', sandbox.answerFormatHint('625 Вт', 'число с единицей').includes('единицей'));

// session matching
t('mission match', sandbox.sessionMatchesRoute({ mode: 'mission', missionId: 'm1' }, 'practice', 'm1') === true);
t('mission mismatch', sandbox.sessionMatchesRoute({ mode: 'mission', missionId: 'm1' }, 'practice', 'm2') === false);
t('boss', sandbox.sessionMatchesRoute({ mode: 'boss', bossId: 'b1' }, 'boss', 'b1') === true);
t('daily', sandbox.sessionMatchesRoute({ mode: 'daily' }, 'daily', '') === true);

// глубокая ссылка ИИ на задание: #/practice/<mission>?task=<taskId> — та же
// миссия, сразу на нужном задании; без параметра всё как было
vm.runInContext([
  extract('function clearHashQueryKey('),
  extract('function applyTaskQueryJump('),
].join('\n'), sandbox);
sandbox.Session = { cur: null };
sandbox.DataAPI = { mission(id) { return id === 'm-n09' ? { id: 'm-n09', skill: 'n09' } : null; } };
sandbox.missionPracticeIds = (m) => (m && m.id === 'm-n09' ? ['n09_a1', 'n09_a2', 'n09_a5', 'n09_a9'] : []);
sandbox.persistSession = () => {};
sandbox.sessionCaptureTaskUi = () => {};
sandbox.Date = Date;
sandbox.location.hash = '#/practice/m-n09?task=n09_a5';
t('task param not part of id', sandbox.routeParam() === 'm-n09');
t('task param readable', sandbox.hashQueryValue('task') === 'n09_a5');
sandbox.Session.cur = { mode: 'mission', missionId: 'm-n09', taskIds: ['n09_a1', 'n09_a2', 'n09_a5'], offset: 0, total: 3, idx: 0, results: [{ taskId: 'n09_a1' }], taskUi: {} };
sandbox.location.hash = '#/practice/m-n09?task=n09_a5';
sandbox.history._url = '';
t('task jump within slice', sandbox.applyTaskQueryJump('practice') === true && sandbox.Session.cur.idx === 2);
t('task jump keeps results', sandbox.Session.cur.results.length === 1);
t('task param stripped after jump', sandbox.history._url === '#/practice/m-n09');
sandbox.Session.cur = { mode: 'mission', missionId: 'm-n09', taskIds: ['n09_a9'], offset: 3, total: 4, idx: 0, results: [], taskUi: {} };
sandbox.location.hash = '#/practice/m-n09?task=n09_a2';
t('task jump rebuilds from bank', sandbox.applyTaskQueryJump('practice') === true
  && sandbox.Session.cur.taskIds.join(',') === 'n09_a2,n09_a5,n09_a9'
  && sandbox.Session.cur.offset === 1 && sandbox.Session.cur.total === 4 && sandbox.Session.cur.idx === 0);
sandbox.Session.cur = { mode: 'mission', missionId: 'm-n09', taskIds: ['n09_a1'], offset: 0, total: 1, idx: 0, results: [], taskUi: {} };
sandbox.location.hash = '#/practice/m-n09?task=zzz_unknown';
t('task foreign ignored', sandbox.applyTaskQueryJump('practice') === false && sandbox.Session.cur.idx === 0);
sandbox.location.hash = '#/practice/m-n09';
t('task no param no-op', sandbox.applyTaskQueryJump('practice') === false);
sandbox.location.hash = '#/practice/m-n09?task=n09_a1&seo_subject=profile_math';
sandbox.history._url = '';
sandbox.applyTaskQueryJump('practice');
t('task keeps foreign tail', sandbox.history._url === '#/practice/m-n09?seo_subject=profile_math');

// labels cover catalog types
const lblCheck = vm.runInContext(`["ACTION","EXPLANATION","FEEDBACK","FOCUS","INDEPENDENT_TASK","HINT","TRANSITION","VALIDATION"].map((k) => k + "=" + (typeof LESSON_STEP_LABELS[k] === "string" && !/[A-Za-z]/.test(LESSON_STEP_LABELS[k])))`, sandbox);
for (const s of lblCheck) t('label ' + s.split('=')[0], s.endsWith('=true'));
console.log(fails ? fails + ' FAILURES' : 'ALL ROUTER OK');
process.exit(fails ? 1 : 0);
