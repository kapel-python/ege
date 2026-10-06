/* Холодный старт tab-лидера: save() сразу после initTabLeader, пока lock
   ещё не захвачен, не должен умирать по таймауту с «persistenceerror»
   (тост «Не удалось сохранить прогресс» у гостя из поиска ?seo_subject=).
   Одиночная вкладка забирает lock себе и пишет напрямую.

   Запуск: node test/tab-leader-coldstart.js */
const fs = require("fs");
const vm = require("vm");
const catalog = JSON.parse(fs.readFileSync("server/catalog.json", "utf8"));
const dataSrc = fs.readFileSync("js/data.js", "utf8");
const stateSrc = fs.readFileSync("js/state.js", "utf8");
let fails = 0;
const t = (name, ok, extra = "") => {
  console.log((ok ? "ok  " : "FAIL") + " " + name + (ok || !extra ? "" : " :: " + extra));
  if (!ok) fails++;
};

const channels = new Map();
class FakeBroadcastChannel {
  constructor(name) { this.name = name; this.onmessage = null; this.closed = false; (channels.get(name) || channels.set(name, new Set()).get(name)).add(this); }
  postMessage(data) { for (const peer of channels.get(this.name) || []) if (peer !== this && !peer.closed && peer.onmessage) queueMicrotask(() => peer.onmessage({ data })); }
  close() { this.closed = true; (channels.get(this.name) || new Set()).delete(this); }
}
// Lock с отложенным захватом: grant() вызывается тестом вручную.
let grantLock = null;
const navigator = { locks: { request(name, options, callback) {
  return new Promise((resolve) => { grantLock = () => resolve(callback({ name })); });
} } };
const pause = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function makeTab() {
  const context = {
    console, JSON, Math, Date, Promise, Set, Map, Object, Array, Number, String, Boolean,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    BroadcastChannel: FakeBroadcastChannel, navigator,
    requestIdleCallback: undefined,
  };
  vm.createContext(context);
  vm.runInContext(dataSrc + "\n" + stateSrc + "\nthis.Store=Store; this.DataAPI=DataAPI; this.ApiClient=ApiClient;", context);
  context.DataAPI.load(catalog);
  const store = context.Store;
  store.subject = "profile_math";
  store.state = store.defaultState();
  store.ready = true;
  store.saved = 0;
  store.persistErrors = [];
  store.on("persistenceerror", (e) => store.persistErrors.push(e));
  store._saveSnapshot = async (snapshot) => {
    store.saved++;
    store.state = JSON.parse(JSON.stringify(snapshot));
    return { ok: true, stateVersion: snapshot.stateVersion };
  };
  return store;
}

(async () => {
  // Сценарий: одиночная вкладка, lock выдаём через 100 мс после init.
  // save() уходит раньше захвата — до фикса он слал запрос в пустоту
  // и через 5 секунд падал с persistenceerror (тот самый тост у гостя).
  const store = makeTab();
  await store.initTabLeader();
  t("до захвата lock вкладка ещё не лидер", store.isTabLeader === false);
  store.state.taskAttempts = [{ taskId: "n01_p1", skill: "n01_planimetry", correct: true, ts: 1 }];
  const started = Date.now();
  const savePromise = store.save();
  await pause(100);
  grantLock();
  await savePromise;
  const elapsed = Date.now() - started;
  t("save холодного старта успешен", store.saved === 1, `saved=${store.saved}`);
  t("без persistenceerror (без тоста)", store.persistErrors.length === 0,
    store.persistErrors.map((e) => String((e && e.message) || e)).join("; "));
  t("без 5-секундного ожидания", elapsed < 4000, `${elapsed}ms`);
  t("вкладка стала лидером", store.isTabLeader === true);
  store.releaseTabLeadership();

  // Сценарий: lock не выдаётся вообще и лидера нет — save шлёт запрос,
  // никто не отвечает; после таймаута + ретрая save честно падает
  // (а не виснет). Ретрай занимает ~11.5с — проверяем только факт падения,
  // без измерения времени.
  const store2 = makeTab();
  grantLock = null;
  await store2.initTabLeader();
  store2.state.taskAttempts = [{ taskId: "n01_p1", skill: "n01_planimetry", correct: true, ts: 1 }];
  await store2.save();
  t("без лидера save падает с persistenceerror", store2.persistErrors.length === 1,
    `errors=${store2.persistErrors.length}`);
  store2.releaseTabLeadership();

  console.log(fails ? `\n${fails} FAILURES` : "\nALL OK");
  process.exit(fails ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
