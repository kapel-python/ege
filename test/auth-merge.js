/* Регрессия: 409-конфликт при смене аккаунта во второй вкладке.
   Сценарий: вкладка держит снимок аккаунта A; в другой вкладке logout->login
   в B перевыпускает сессию. Сейв вкладки-A получает 409, перечитывает
   bootstrap (уже B) и ОБЯЗАН принять серверный снимок как есть — мержить
   локальный снимок A в B нельзя: иначе события/ошибки/достижения/XP
   аккаунта A физически записываются в аккаунт B. */
const fs = require("fs");
const src = fs.readFileSync("js/data.js", "utf8") + "\n" + fs.readFileSync("js/state.js", "utf8");

const testBody = async () => {
  let fails = 0;
  const t = (name, cond, extra = "") => { console.log((cond ? "ok  " : "FAIL") + " " + name + (cond ? "" : " — " + extra)); if (!cond) fails++; };
  const catalog = JSON.parse(fs.readFileSync("server/catalog.json", "utf8"));
  DataAPI.load(catalog);
  Store.ready = true;
  Store.isTabLeader = true;
  Store.tabChannel = null;

  // --- локальный снимок вкладки, устаревшей на аккаунте A ---
  const stateA = Store.defaultState();
  stateA.stateVersion = 5;
  stateA.onboarded = true;
  stateA.name = "Пользователь A";
  stateA.diagnostics = [{ id: "diag-a-1", taskId: "t1", correct: true, ts: 1 }];
  stateA.achievements = { "ach-a": { ts: 2 } };
  stateA.taskAttempts = [{ id: "att-a-1", taskId: "t1", skill: "n01_planimetry", correct: true, hintLevel: 0, seconds: 10, ts: 3 }];
  stateA.timeline = [{ id: "tl-a-1", ts: 4, text: "MARKER-A" }];
  Store.state = stateA;
  Store.accountId = "acc-a";
  Store.subject = "profile_math";
  // Вкладка с несинхронизированной работой: база пустая — сейв реально уйдёт
  // на сервер и поймает 409 (так и воспроизводится гонка смены аккаунта).
  Store.lastSyncedState = Store.defaultState();

  // --- сервер теперь отдаёт аккаунт B; первый сейв падает с 409 ---
  const bodies = [];
  let firstAttempt = true;
  let conflicted = false;
  const markerLeak = (payload) => JSON.stringify(payload).includes("MARKER-A")
    || JSON.stringify(payload).includes("diag-a-1") || JSON.stringify(payload).includes("ach-a")
    || JSON.stringify(payload).includes("att-a-1");
  const conflictOnce = async () => {
    if (firstAttempt) { firstAttempt = false; conflicted = true; const e = new Error("conflict"); e.status = 409; throw e; }
    return { ok: true, stateVersion: 7 };
  };
  ApiClient.post = async (path, body) => { bodies.push(["POST", path, body]); return conflictOnce(); };
  ApiClient.patch = async (path, body) => { bodies.push(["PATCH", path, body]); return conflictOnce(); };
  ApiClient.get = async () => ({
    catalog,
    accountId: "acc-b",
    auth: { registered: true, email: "b@ex.com" },
    state: { ...Store.defaultState(), stateVersion: 6, name: "Пользователь B",
             timeline: [{ id: "tl-b-1", ts: 9, text: "MARKER-B" }] },
  });

  await Store.save();

  const idx = bodies.findIndex(([, , body]) => body && body.expectedVersion === 5);
  const afterConflict = bodies.slice(idx + 1); // всё, что ушло ПОСЛЕ 409
  const leaked = afterConflict.filter(([, , body]) => markerLeak(body));
  t("после 409 и смены аккаунта данные A больше никуда не уходят", leaked.length === 0,
    JSON.stringify(afterConflict).slice(0, 300));
  t("повторной отправки после смены аккаунта нет (только свежий reload)", afterConflict.length === 0,
    `${afterConflict.length} запросов`);
  t("Store принял серверный снимок B без остатков A",
    Store.accountId === "acc-b" && JSON.stringify(Store.state).includes("MARKER-B")
      && !JSON.stringify(Store.state).includes("MARKER-A"),
    `accountId=${Store.accountId}`);
  t("версия состояния = версии серверного снимка", Store.state.stateVersion === 6, `${Store.state.stateVersion}`);

  // --- контроль: без смены аккаунта мерж после 409 по-прежнему работает ---
  bodies.length = 0;
  firstAttempt = true;
  Store.accountId = "acc-a";
  const stateA2 = Store.defaultState();
  stateA2.stateVersion = 5;
  stateA2.diagnostics = [{ id: "diag-a-1", taskId: "t1", correct: true, ts: 1 }];
  Store.state = stateA2;
  Store.lastSyncedState = Store.defaultState();
  ApiClient.get = async () => ({
    catalog,
    accountId: "acc-a",
    auth: { registered: true, email: "a@ex.com" },
    state: { ...Store.defaultState(), stateVersion: 6,
             diagnostics: [{ id: "diag-srv-1", taskId: "t2", correct: false, ts: 8 }] },
  });
  await Store.save();
  const mergedOk = JSON.stringify(Store.state.diagnostics).includes("diag-a-1")
    && JSON.stringify(Store.state.diagnostics).includes("diag-srv-1");
  t("обычный 409 (тот же аккаунт) по-прежнему безопасно мержится", mergedOk,
    JSON.stringify(Store.state.diagnostics));

  console.log(fails ? `\n${fails} FAILURES` : "\nALL OK");
  process.exit(fails ? 1 : 0);
};
eval(src + `\n;(${testBody.toString()})();`);
