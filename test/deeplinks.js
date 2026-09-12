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

// labels cover catalog types
const lblCheck = vm.runInContext(`["ACTION","EXPLANATION","FEEDBACK","FOCUS","INDEPENDENT_TASK","HINT","TRANSITION","VALIDATION"].map((k) => k + "=" + (typeof LESSON_STEP_LABELS[k] === "string" && !/[A-Za-z]/.test(LESSON_STEP_LABELS[k])))`, sandbox);
for (const s of lblCheck) t('label ' + s.split('=')[0], s.endsWith('=true'));
console.log(fails ? fails + ' FAILURES' : 'ALL ROUTER OK');
process.exit(fails ? 1 : 0);
