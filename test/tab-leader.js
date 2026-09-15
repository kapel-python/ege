/* Multi-tab leader regression for the real Store code.
   Runs two isolated VM tabs with shared fake BroadcastChannel/navigator.locks. */
const fs = require("fs");
const vm = require("vm");
const catalog = JSON.parse(fs.readFileSync("server/catalog.json", "utf8"));
const dataSrc = fs.readFileSync("js/data.js", "utf8");
const stateSrc = fs.readFileSync("js/state.js", "utf8");
let fails = 0;
const t = (name, ok) => { console.log((ok ? "ok  " : "FAIL") + " " + name); if (!ok) fails++; };

const channels = new Map();
class FakeBroadcastChannel {
  constructor(name) { this.name = name; this.onmessage = null; this.closed = false; (channels.get(name) || channels.set(name, new Set()).get(name)).add(this); }
  postMessage(data) { for (const peer of channels.get(this.name) || []) if (peer !== this && !peer.closed && peer.onmessage) queueMicrotask(() => peer.onmessage({ data })); }
  close() { this.closed = true; (channels.get(this.name) || new Set()).delete(this); }
}
const locks = new Map();
const navigator = { locks: { request(name, options, callback) {
  if (options && options.ifAvailable && locks.has(name)) return Promise.resolve(callback(null));
  const lock = { name }; locks.set(name, lock);
  return Promise.resolve(callback(lock)).finally(() => locks.delete(name));
} } };
const pause = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function makeTab(label) {
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
  store.load = async () => store.state;
  store._saveSnapshot = async (snapshot) => {
    store.saved = (store.saved || 0) + 1;
    snapshot.stateVersion = (snapshot.stateVersion || 1) + 1;
    store.state = JSON.parse(JSON.stringify(snapshot));
    return { ok: true, stateVersion: snapshot.stateVersion, by: label };
  };
  return { context, store };
}

(async () => {
  const a = makeTab("A");
  const b = makeTab("B");
  const c = makeTab("C");
  await a.store.initTabLeader();
  await b.store.initTabLeader();
  await c.store.initTabLeader();
  await pause(15);
  t("ровно одна из трёх вкладок стала лидером", Number(a.store.isTabLeader) + Number(b.store.isTabLeader) + Number(c.store.isTabLeader) === 1);
  const leader = a.store.isTabLeader ? a.store : (b.store.isTabLeader ? b.store : c.store);
  const followers = [a.store, b.store, c.store].filter((store) => store !== leader);
  const follower = followers[0];
  const secondFollower = followers[1];
  follower.state.taskAttempts = [{ taskId: "n01_p1", skill: "n01_planimetry", correct: true, ts: 1 }];
  await follower.save();
  await pause(15);
  t("сохранение вторичной вкладки выполнил только лидер", leader.saved === 1 && !follower.saved);
  t("подтверждённое состояние дошло до вторичной вкладки", follower.state.taskAttempts.some((x) => x.taskId === "n01_p1"));
  t("подтверждённое состояние дошло до третьей вкладки", secondFollower.state.taskAttempts.some((x) => x.taskId === "n01_p1"));
  // Главная вкладка меняет профиль после последней синхронизации follower;
  // его следующий save не должен откатить это старым снапшотом.
  leader.state.name = "свежее имя лидера";
  follower.lastSyncedState = JSON.parse(JSON.stringify(follower.state));
  follower.state.lessonSessions = { lesson_n07_exponential: { idx: 1 } };
  await follower.save();
  await pause(15);
  t("дельта вторичной вкладки не откатывает свежий профиль лидера", leader.state.name === "свежее имя лидера");
  t("дельта вторичной вкладки сохраняет её черновик урока", !!leader.state.lessonSessions.lesson_n07_exponential);
  // Быстрые действия в двух вторичных вкладках не должны создавать параллельный
  // PUT: главный writer ставит их в очередь и объединяет оба события.
  follower.state.taskAttempts = [...follower.state.taskAttempts, { taskId: "n01_p2", skill: "n01_planimetry", correct: true, ts: 2 }];
  secondFollower.state.taskAttempts = [...secondFollower.state.taskAttempts, { taskId: "n01_p3", skill: "n01_planimetry", correct: true, ts: 3 }];
  await Promise.all([follower.save(), secondFollower.save()]);
  await pause(15);
  t("быстрые сохранения вторичных вкладок обработаны последовательным лидером", leader.saved === 4);
  t("очередь лидера сохранила оба быстрых события", leader.state.taskAttempts.some((x) => x.taskId === "n01_p2") && leader.state.taskAttempts.some((x) => x.taskId === "n01_p3"));
  leader.releaseTabLeadership();
  await pause(30);
  follower._tryBecomeTabLeader();
  secondFollower._tryBecomeTabLeader();
  await pause(30);
  t("после закрытия лидера ровно одна оставшаяся вкладка захватывает lock", Number(follower.isTabLeader) + Number(secondFollower.isTabLeader) === 1);
  follower.releaseTabLeadership();
  secondFollower.releaseTabLeadership();
  console.log(fails ? `\n${fails} FAILURES` : "\nALL OK");
  process.exit(fails ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
