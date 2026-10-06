/* РУЧНОЙ скрипт проверки окна «Цель достигнута». НЕ часть тестового gate.
 *
 * Как пользоваться (аккаунт 0xz2nx, сейчас прогноз ~7):
 *  1. Зайди на сайт под этим аккаунтом, открой любую внутреннюю страницу
 *     (дашборд, путь, тренировка, ошибки, ИИ, профиль).
 *  2. Открой консоль DevTools (F12 → Console), вставь ВЕСЬ этот файл, Enter.
 *  3. Скрипт сразу покажет текущие mid/цель, через 15 секунд искусственно
 *     поднимет прогноз до max(65, цель) и напишет «жди окно».
 *  4. В течение ~5 секунд сайт сам откроет модалку (его штатный опрос).
 *  5. Отмена до срабатывания: clearTimeout(window.__gcBoostTimer).
 *  6. Откат состояния: window.__gcBoostRestore() — вернёт skillStats,
 *     уроки и историю как было (флаг показа при этом НЕ снимается —
 *     для повторной проверки сотри ключ ege_goal_celebrated_v1:* в
 *     localStorage вручную).
 *
 * Безопасность: трогает только реальные id навыков/уроков из каталога
 * (внешние ключи целы), НЕ создаёт фальшивых попыток (XP и задания
 * не страдают), НЕ трогает activity/streak/время. Между бустом и откатом
 * сервер может успеть сохранить завышенный user_progress — откат следом
 * перезаписывает его обратно; строка forecast_history за сегодня
 * перезапишется следующим штатным снапшотом (ON CONFLICT по дате).
 */
(function () {
  "use strict";
  var need = ["Store", "DataAPI", "forecast", "recordForecastSnapshot", "currentSubjectId"];
  for (var k = 0; k < need.length; k++) {
    if (typeof window[need[k]] === "undefined") {
      console.error("[gc-boost] Нет " + need[k] + " — вставь скрипт на внутренней странице сайта (не на лендинге).");
      return;
    }
  }
  var subject = String(currentSubjectId());
  var gid = Store.state.goal;
  if (!gid) { console.error("[gc-boost] У аккаунта не выбрана цель — выбери её в профиле и повтори."); return; }
  var g = null, goals = DataAPI.goals() || [];
  for (var i = 0; i < goals.length; i++) {
    if (goals[i] && String(goals[i].id) === String(gid)) { g = goals[i]; break; }
  }
  if (!g) { console.error("[gc-boost] Цель " + gid + " не найдена в каталоге предмета."); return; }
  var dm = String(g.desc || "").match(/(\d+)\s*\+/), lm = String(g.label || "").match(/\d+/);
  var goalNum = dm ? Number(dm[1]) : (lm ? Number(lm[0]) : null);
  if (!Number.isFinite(goalNum)) { console.error("[gc-boost] Не parsed число цели."); return; }
  var target = Math.max(65, goalNum);
  var cur = forecast();
  console.log("[gc-boost] Предмет " + subject + ", цель " + goalNum + " (" + gid + "), текущий mid "
    + (cur && Number.isFinite(cur.mid) ? cur.mid : "?") + ", таргет " + target + ".");

  try { localStorage.removeItem("ege_goal_celebrated_v1:" + subject + ":" + gid); } catch (e) {}
  console.log("[gc-boost] Флаг показа снят. Буст через 15 секунд…");

  var left = 15;
  var cd = setInterval(function () {
    left -= 5;
    if (left > 0) console.log("[gc-boost] Осталось " + left + " с…");
    else clearInterval(cd);
  }, 5000);

  window.__gcBoostTimer = setTimeout(function () {
    var backup = {
      skillStats: JSON.parse(JSON.stringify(Store.state.skillStats || {})),
      completedLessons: JSON.parse(JSON.stringify(Store.state.completedLessons || {})),
      forecastHistory: (Store.state.forecastHistory || []).slice(),
    };
    window.__gcBoostBackup = backup;
    window.__gcBoostRestore = function () {
      Store.state.skillStats = JSON.parse(JSON.stringify(backup.skillStats));
      Store.state.completedLessons = JSON.parse(JSON.stringify(backup.completedLessons));
      Store.state.forecastHistory = backup.forecastHistory.slice();
      console.log("[gc-boost] Состояние откачено. Обнови страницу — цифры вернутся.");
    };

    try {
      var lessons = DataAPI.lessons() || [], nowMs = Date.now(), li;
      for (li = 0; li < lessons.length; li++) {
        if (lessons[li] && lessons[li].id && !Store.state.completedLessons[lessons[li].id]) {
          Store.state.completedLessons[lessons[li].id] = { ts: nowMs };
        }
      }
      var skills = DataAPI.skills() || [], steps = [[8, 7], [10, 9], [12, 11], [14, 13]], si, sj;
      var mid = (forecast() || {}).mid;
      for (si = 0; si < steps.length && !(mid >= target); si++) {
        for (sj = 0; sj < skills.length; sj++) {
          if (!skills[sj] || !skills[sj].id) continue;
          Store.state.skillStats[skills[sj].id] = { progress: 0, solved: steps[si][0], correct: steps[si][1], timeSec: 300 };
        }
        mid = (forecast() || {}).mid;
        console.log("[gc-boost] Шаг " + (si + 1) + ": mid = " + mid);
      }
      var snap = recordForecastSnapshot();
      console.log("[gc-boost] Снапшот записан (" + (snap && snap.date) + ", mid "
        + (snap && snap.mid) + "). Жди окно — сайт откроет его сам в течение ~5 секунд.");
    } catch (e) {
      console.error("[gc-boost] Ошибка буста:", e);
    }
  }, 15000);
})();
