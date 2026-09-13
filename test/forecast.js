/* Сценарные тесты нового прогноза ЕГЭ (forecast / forecastTopGains).
   Грузятся настоящие js/data.js + js/state.js и настоящий каталог — без моков.
   Проверяется поведение: веса, шкала, давность, насыщение, вилка, топ-прирост. */
const fs = require("fs");
const src = fs.readFileSync("js/data.js", "utf8") + "\n" + fs.readFileSync("js/state.js", "utf8");
const testBody = async () => {
  let fails = 0;
  const t = (name, cond, extra) => {
    console.log((cond ? "ok   " : "FAIL ") + name + (cond || !extra ? "" : " | " + extra));
    if (!cond) fails++;
  };
  DataAPI.load(JSON.parse(fs.readFileSync("server/catalog.json", "utf8")));
  Store.ready = false;

  const now = Date.now();
  const HOUR = 3600 * 1000;
  const DAY = 24 * HOUR;
  const skills = DataAPI.skills();
  const lessonOf = (sid) => DataAPI.lessonsBySkill(sid)[0] || null;

  function strongSetup() {
    // Сильный ученик: уроки пройдены, свежие верные ответы по всем темам.
    Store.reset();
    for (const sk of skills) {
      const l = lessonOf(sk.id);
      if (l) Store.state.completedLessons[l.id] = { ts: now - 3 * DAY };
      Store.state.skillStats[sk.id] = { progress: 0, solved: 14, correct: 13, timeSec: 400 };
      for (let i = 0; i < 14; i++) {
        Store.state.taskAttempts.push({ taskId: `syn_${sk.id}_${i}`, skill: sk.id, correct: i !== 5, hintLevel: 0, seconds: 30, closesTaskId: null, ts: now - i * HOUR });
      }
    }
  }

  /* 1. Веса покрывают все навыки каталога и в сумме дают 32. */
  {
    const wSum = skills.reduce((a, s) => a + skillEgeWeight(s.id), 0);
    const uncovered = skills.filter((s) => !(s.id in SKILL_EGE_WEIGHTS)).map((s) => s.id);
    t("веса: сумма по каталогу = 32 первичных балла", wSum === 32, "sum=" + wSum);
    t("веса: все навыки каталога явно взвешены", uncovered.length === 0, uncovered.join(","));
    t("веса: вторая часть дороже первой", skillEgeWeight("n17_optimization") > skillEgeWeight("n01_planimetry"));
  }

  /* 2. Шкала перевода монотонна и совпадает с опубликованной. */
  {
    const mono = PRIMARY_TO_TEST.every((v, i, a) => i === 0 || v >= a[i - 1]);
    t("шкала: монотонна и длиной 33 (0–32)", mono && PRIMARY_TO_TEST.length === 33);
    t("шкала: 0→0, 5→27 (порог), 30→100", PRIMARY_TO_TEST[0] === 0 && PRIMARY_TO_TEST[5] === 27 && PRIMARY_TO_TEST[30] === 100);
  }

  /* 3. Новичок: низкий прогноз и широкая вилка. */
  Store.reset();
  {
    const f = forecast();
    t("новичок: прогноз низкий (mid ≤ 15)", f.mid <= 15, JSON.stringify(f));
    t("новичок: вилка честно максимально широкая (hw = 12)", f.hw === 12 && f.high - f.low === 12, JSON.stringify(f));
    t("новичок: low не уходит ниже нуля", f.low >= 0);
  }

  /* 4. Сильный ученик: высокий прогноз и узкая вилка. */
  strongSetup();
  {
    const f = forecast();
    t("сильный: прогноз высокий (mid ≥ 85)", f.mid >= 85, JSON.stringify(f));
    t("сильный: вилка узкая (≤ 8 баллов)", f.high - f.low <= 8, JSON.stringify(f));
    t("сильный: mid внутри вилки", f.low <= f.mid && f.mid <= f.high);
  }

  /* 5. Давность: свежие знания весят больше старых. */
  {
    const sid = skills[0].id;
    Store.reset();
    for (let i = 0; i < 10; i++) {
      Store.state.taskAttempts.push({ taskId: `old_${i}`, skill: sid, correct: true, hintLevel: 0, seconds: 20, closesTaskId: null, ts: now - 90 * DAY - i * HOUR });
    }
    const stale = forecastSkillMastery(sid, now);
    Store.reset();
    for (let i = 0; i < 10; i++) {
      Store.state.taskAttempts.push({ taskId: `new_${i}`, skill: sid, correct: true, hintLevel: 0, seconds: 20, closesTaskId: null, ts: now - i * HOUR });
    }
    const fresh = forecastSkillMastery(sid, now);
    t("давность: свежие ответы дают больше старых", fresh > stale, `fresh=${fresh} stale=${stale}`);
    t("давность: трёхмесячные ответы почти выцвели (≤ 20)", stale <= 20, `stale=${stale}`);
  }

  /* 6. Насыщение: 5 верных ≠ 12 верных (потолок «10 лёгких = мастер» убран). */
  {
    const sid = skills[1].id;
    const mk = (n, ts) => {
      Store.reset();
      for (let i = 0; i < n; i++) {
        Store.state.taskAttempts.push({ taskId: `v${n}_${i}`, skill: sid, correct: true, hintLevel: 0, seconds: 20, closesTaskId: null, ts: ts - i * 60000 });
      }
      return forecastSkillMastery(sid, ts);
    };
    const m5 = mk(5, now), m12 = mk(12, now), m30 = mk(30, now);
    t("насыщение: 12 верных > 5 верных", m12 > m5, `m5=${m5} m12=${m12}`);
    t("насыщение: 30 верных не выше 12 (потолок есть)", m30 === m12, `m12=${m12} m30=${m30}`);
  }

  /* 7. Точность важнее объёма: много ошибок = низкий прогноз по теме. */
  {
    const sid = skills[2].id;
    Store.reset();
    for (let i = 0; i < 14; i++) {
      Store.state.taskAttempts.push({ taskId: `acc_${i}`, skill: sid, correct: i % 4 === 0, hintLevel: 0, seconds: 20, closesTaskId: null, ts: now - i * 60000 });
    }
    const m = forecastSkillMastery(sid, now);
    t("точность: 25% верных не дают высокого освоения (≤ 30)", m <= 30, `m=${m}`);
  }

  /* 8. «Что даст +N»: слабая вторая часть ценнее слабой первой. */
  strongSetup();
  {
    const weak1 = skills.find((s) => skillEgeWeight(s.id) === 1).id;
    const weak2 = skills.find((s) => skillEgeWeight(s.id) === 4).id;
    for (const sid of [weak1, weak2]) {
      delete Store.state.completedLessons[(lessonOf(sid) || {}).id];
      Store.state.skillStats[sid] = { progress: 0, solved: 0, correct: 0, timeSec: 0 };
      Store.state.taskAttempts = Store.state.taskAttempts.filter((a) => a.skill !== sid);
    }
    const gains = forecastTopGains(5);
    const g1 = gains.find((g) => g.skillId === weak1);
    const g2 = gains.find((g) => g.skillId === weak2);
    t("топ-прирост: обе слабые темы в списке", !!(g1 && g2), JSON.stringify(gains.map((g) => [g.skillId, g.gain])));
    t("топ-прирост: вторая часть даёт больше первой", !!(g1 && g2 && g2.gain > g1.gain), `p1=${g1 && g1.gain} p2=${g2 && g2.gain}`);
    t("топ-прирост: освоенная тема не предлагается", !gains.some((g) => g.skillId === skills[3].id));
  }

  /* 9. Откат без живых попыток: суммарная статистика не превращается в ноль. */
  {
    Store.reset();
    const sid = skills[4].id;
    Store.state.skillStats[sid] = { progress: 0, solved: 14, correct: 12, timeSec: 300 };
    const m = forecastSkillMastery(sid, now);
    t("откат: статистика без попыток даёт ненулевое освоение", m > 40, `m=${m}`);
    const f = forecast();
    t("откат: общий прогноз считается и конечен", Number.isFinite(f.mid) && f.mid > 0, JSON.stringify(f));
  }

  /* 10. История и тренд совместимы с новым форматом. */
  {
    Store.reset();
    const snap = recordForecastSnapshot();
    t("снимок: пишется с конечным mid и датой", !!snap && Number.isFinite(snap.mid) && /^\d{4}-\d{2}-\d{2}$/.test(snap.date));
    // Старый снимок формата {date, low, high, mid} не ломает историю.
    Store.state.forecastHistory.push({ date: "2020-01-01", low: 20, high: 27, mid: 24 });
    const hist = forecastHistory(9999);
    t("история: старые снимки переживают новый формат", hist.some((x) => x.date === "2020-01-01") && hist.every((x) => Number.isFinite(x.mid)));
    const tr = forecastTrend(9999);
    t("тренд: дельта — число", tr && Number.isFinite(tr.delta), JSON.stringify(tr));
  }

  console.log(fails ? `\n${fails} FAILURES` : "\nALL OK");
  process.exit(fails ? 1 : 0);
};
eval(src + `\n;(${testBody.toString()})();`);
