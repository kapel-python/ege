/* Сценарные тесты нового прогноза ЕГЭ (forecast / forecastTopGains).
   Грузятся настоящие js/data.js + js/state.js и настоящий каталог — без моков.
   Проверяется поведение: веса, шкала, давность, насыщение, вилка, топ-прирост. */
const fs = require("fs");
const src = fs.readFileSync("js/data.js", "utf8") + "\n" + fs.readFileSync("js/state.js", "utf8");

/* Build the same public payload the server attaches to a ready subject. */
function serverLikePayload(subjectId, catalogFile) {
  const catalog = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
  const contracts = ["profile_math", "basic_math", "russian"].map((id) =>
    JSON.parse(fs.readFileSync(`server/subjects/${id}.json`, "utf8"))
  );
  const contract = contracts.find((item) => item.id === subjectId);
  if (!contract) throw new Error(`Unknown subject contract: ${subjectId}`);

  const publicInfo = (item) => ({
    id: item.id,
    title: item.title,
    short: item.short,
    description: item.description || "",
    status: item.status,
    locked: !!item.locked,
    comingSoon: !!item.comingSoon,
    availability: item.availability || item.status,
    forecast: item.forecast,
    features: item.features,
    ...(item.metadata ? { metadata: item.metadata } : {}),
  });

  return {
    ...catalog,
    subject: subjectId,
    subjects: contracts.map(publicInfo),
    subjectInfo: publicInfo(contract),
    forecast: contract.forecast,
  };
}

const testBody = async () => {
  let fails = 0;
  const t = (name, cond, extra) => {
    console.log((cond ? "ok   " : "FAIL ") + name + (cond || !extra ? "" : " | " + extra));
    if (!cond) fails++;
  };
  DataAPI.load(serverLikePayload("profile_math", "server/catalog.json"));
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

  /* 1. Веса покрывают все навыки каталога и в сумме дают 33 (спецификация ЕГЭ-2027: 20 заданий, max 33). */
  {
    const cfg = DataAPI.forecastConfig();
    const configured = cfg && cfg.weights && typeof cfg.weights === "object" ? cfg.weights : {};
    const wSum = skills.reduce((a, s) => a + skillEgeWeight(s.id), 0);
    const uncovered = skills.filter((s) => !Object.prototype.hasOwnProperty.call(configured, s.id)).map((s) => s.id);
    t("веса: сумма по каталогу = 33 первичных балла", wSum === 33, "sum=" + wSum);
    t("веса: все навыки каталога явно взвешены", uncovered.length === 0, uncovered.join(","));
    t("веса: вторая часть дороже первой", skillEgeWeight("n17_optimization") > skillEgeWeight("n01_planimetry"));
  }

  /* 2. Шкала перевода монотонна и совпадает с опубликованной. */
  {
    const scale = forecastScale();
    const mono = scale.every((v, i, a) => i === 0 || v >= a[i - 1]);
    t("шкала: монотонна и длиной 34 (0–33)", mono && scale.length === 34);
    t("шкала: 0→0, 5→27 (порог), 30→99, 31→100", scale[0] === 0 && scale[5] === 27 && scale[30] === 99 && scale[31] === 100);
  }

  /* 3. Новичок: прогноза нет — вместо числа плашка «пройди больше тем и практики». */
  Store.reset();
  {
    const f = forecast();
    t("новичок: прогноз скрыт до порога (premature)", f.empty === true && f.premature === true, JSON.stringify(f));
    t("новичок: прогресс до порога показан", f.needLessons > 0 && f.needTopics > 0 && f.doneLessons === 0 && f.covered === 0, JSON.stringify(f));
    t("новичок: числа нет вообще", f.mid === 0 && f.low === 0 && f.high === 0);
    t("новичок: снимок прогноза не пишется", recordForecastSnapshot() === null);
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
    t("откат: ниже порога общий прогноз скрыт, а не нулевой", f.premature === true, JSON.stringify(f));
  }

  /* 10. История и тренд совместимы с новым форматом. */
  {
    strongSetup();
    const snap = recordForecastSnapshot();
    t("снимок: пишется с конечным mid и датой", !!snap && Number.isFinite(snap.mid) && /^\d{4}-\d{2}-\d{2}$/.test(snap.date));
    // Старый снимок формата {date, low, high, mid} не ломает историю.
    Store.state.forecastHistory.push({ date: "2020-01-01", low: 20, high: 27, mid: 24 });
    const hist = forecastHistory(9999);
    t("история: старые снимки переживают новый формат", hist.some((x) => x.date === "2020-01-01") && hist.every((x) => Number.isFinite(x.mid)));
    const tr = forecastTrend(9999);
    t("тренд: дельта — число", tr && Number.isFinite(tr.delta), JSON.stringify(tr));
  }

  /* 11. Базовый предмет использует собственный активный конфиг. */
  {
    DataAPI.load(serverLikePayload("basic_math", "server/catalog_basic.json"));
    Store.ready = false;
    Store.reset();
    const scale = forecastScale();
    t("базовая математика: конфиг даёт total 21 и шкалу длиной 22",
      forecastTotal() === 21 && scale.length === 22,
      `total=${forecastTotal()} scaleLength=${scale.length}`);
  }

  /* 12. Русский язык: прогноз по шкале ФИПИ (тест 28 + сочинение 22 = 50). */
  {
    DataAPI.load(serverLikePayload("russian", "server/catalog_russian.json"));
    Store.ready = false;
    Store.reset();
    const cfg = DataAPI.forecastConfig();
    const configured = cfg && cfg.weights && typeof cfg.weights === "object" ? cfg.weights : {};
    const skillsRu = DataAPI.skills();
    const wSum = skillsRu.reduce((a, s) => a + skillEgeWeight(s.id), 0);
    const uncovered = skillsRu.filter((s) => !Object.prototype.hasOwnProperty.call(configured, s.id)).map((s) => s.id);
    t("русский: веса покрывают все 27 навыков и в сумме дают 50", wSum === 50 && uncovered.length === 0,
      "sum=" + wSum + " uncovered=" + uncovered.join(","));
    t("русский: двухбалльные — №8 и №22, сочинение — 22",
      skillEgeWeight("r08") === 2 && skillEgeWeight("r22") === 2
      && skillEgeWeight("russian_essay_source") === 22
      && skillEgeWeight("r01") === 1);
    const scale = forecastScale();
    const mono = scale.every((v, i, a) => i === 0 || v >= a[i - 1]);
    t("русский: шкала монотонна, длиной 51 (0–50)", mono && scale.length === 51);
    t("русский: 0→0, 8→20, 28→55 (потолок без сочинения), 50→100",
      scale[0] === 0 && scale[8] === 20 && scale[28] === 55 && scale[50] === 100);
    t("русский: total 50, конфиг доступен", forecastTotal() === 50 && forecastConfigAvailable() === true);
    const novice = forecast();
    t("русский: новичок — прогноз скрыт до порога", novice.premature === true, JSON.stringify(novice));
    for (const sk of skillsRu) {
      const l = (DataAPI.lessonsBySkill(sk.id)[0]) || null;
      if (l) Store.state.completedLessons[l.id] = { ts: now - 3 * DAY };
      Store.state.skillStats[sk.id] = { progress: 0, solved: 14, correct: 13, timeSec: 400 };
      for (let i = 0; i < 14; i++) {
        Store.state.taskAttempts.push({ taskId: `ru_${sk.id}_${i}`, skill: sk.id, correct: i !== 5, hintLevel: 0, seconds: 30, closesTaskId: null, ts: now - i * HOUR });
      }
    }
    const strong = forecast();
    t("русский: сильный ученик — высокий прогноз (mid ≥ 85)", strong.mid >= 85, JSON.stringify(strong));
    t("русский: mid внутри вилки", strong.low <= strong.mid && strong.mid <= strong.high);
  }

  /* 13. Подсказки, сложность, прощение: вес свидетельства, а не счётчик. */
  DataAPI.load(serverLikePayload("profile_math", "server/catalog.json"));
  Store.ready = false;
  {
    const sid = skills[5].id;
    const mkHint = (hint) => {
      Store.reset();
      for (let i = 0; i < 12; i++) {
        Store.state.taskAttempts.push({ taskId: `h${hint}_${i}`, skill: sid, correct: true, hintLevel: hint, seconds: 20, closesTaskId: null, ts: now - i * 60000 });
      }
      return forecastSkillMastery(sid, now);
    };
    const m0 = mkHint(0), m1 = mkHint(1);
    t("подсказка: свидетельство слабее (×0.6)", m1 < m0 && Math.abs(m1 - 0.6 * m0) < 1, `m0=${m0} m1=${m1}`);
  }
  {
    // n01 — задачи на 1 звезду, n19 — на 4: одинаковые 3 свежих верных.
    const mkDiff = (taskIds, sid) => {
      Store.reset();
      taskIds.slice(0, 3).forEach((tid, i) => {
        Store.state.taskAttempts.push({ taskId: tid, skill: sid, correct: true, hintLevel: 0, seconds: 20, closesTaskId: null, ts: now - i * 60000 });
      });
      return forecastSkillMastery(sid, now);
    };
    const m1 = mkDiff(["n01_p1", "n01_p2", "n01_p3"], "n01_planimetry");
    const m4 = mkDiff(["n19_p1", "n19_p2", "n19_p3"], "n19_parameter");
    t("сложность: 4 звезды весят впятеро (60 против 15)", m4 === 60 && m1 === 15, `m1=${m1} m4=${m4}`);
  }
  {
    // Прощение: 10 старых ошибок + 10 свежих верных ≈ 10 свежих верных.
    const sid = skills[6].id;
    Store.reset();
    for (let i = 0; i < 10; i++) {
      Store.state.taskAttempts.push({ taskId: `oldwrong_${i}`, skill: sid, correct: false, hintLevel: 0, seconds: 20, closesTaskId: null, ts: now - 30 * DAY - i * HOUR });
    }
    for (let i = 0; i < 10; i++) {
      Store.state.taskAttempts.push({ taskId: `freshok_${i}`, skill: sid, correct: true, hintLevel: 0, seconds: 20, closesTaskId: null, ts: now - i * HOUR });
    }
    const forgiven = forecastSkillMastery(sid, now);
    t("прощение: старые ошибки почти не душат (== 50, без прощения было бы 40)", forgiven === 50, `m=${forgiven}`);
    Store.reset();
    for (let i = 0; i < 10; i++) {
      Store.state.taskAttempts.push({ taskId: `clean_${i}`, skill: sid, correct: true, hintLevel: 0, seconds: 20, closesTaskId: null, ts: now - i * HOUR });
    }
    t("прощение: чистый след даёт столько же", forecastSkillMastery(sid, now) === 50);
  }

  /* 14. Порог показа: диагностика + один урок мало, доля уроков и тем открывает. */
  DataAPI.load(serverLikePayload("profile_math", "server/catalog.json"));
  Store.ready = false;
  Store.reset();
  {
    const weighted = DataAPI.skills().filter((s) => skillEgeWeight(s.id) > 0);
    const allLessons = DataAPI.lessons();
    const needL = Math.max(2, Math.ceil(allLessons.length * 0.2));
    const needT = Math.max(3, Math.ceil(weighted.length * 0.25));
    // Первые шаги: диагностика по трём темам и один урок.
    for (const sk of weighted.slice(0, 3)) {
      Store.state.taskAttempts.push({ taskId: `${sk.id}_p1`, skill: sk.id, correct: true, hintLevel: 0, seconds: 20, closesTaskId: null, ts: now });
    }
    if (allLessons[0]) Store.state.completedLessons[allLessons[0].id] = { ts: now };
    const early = forecast();
    t("порог: диагностика и один урок — прогноза ещё нет",
      early.premature === true && early.doneLessons < needL, JSON.stringify(early));
    // Набираем ровно порог: уроки и темы с данными.
    for (const l of allLessons.slice(0, needL)) Store.state.completedLessons[l.id] = { ts: now };
    for (const sk of weighted.slice(0, needT)) {
      Store.state.skillStats[sk.id] = { progress: 0, solved: 12, correct: 11, timeSec: 200 };
    }
    const opened = forecast();
    t("порог: уроки и темы набраны — прогноз появился",
      opened.premature !== true && opened.mid > 0 && Number.isFinite(opened.high),
      JSON.stringify(opened));
    t("порог: снимок прогноза теперь пишется", !!recordForecastSnapshot());
  }

  console.log(fails ? `\n${fails} FAILURES` : "\nALL OK");
  process.exit(fails ? 1 : 0);
};
eval(src + `\n;(${testBody.toString()})();`);
