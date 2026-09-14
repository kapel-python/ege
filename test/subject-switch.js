/* Регрессия смены предмета (аккаунт 4ua6ss): switchSubject обязан сверить
   цель с загруженным каталогом (DataAPI.currentSubject), а не только с
   Store.subject — иначе applyOnboarding, ставящий Store.subject до смены,
   гасит POST /api/subject и экран остаётся на старом каталоге. */
const fs = require("fs");
const vm = require("vm");
const sandbox = { console, setTimeout, clearTimeout, __catalog: fs.readFileSync("server/catalog.json", "utf8") };
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync("js/data.js", "utf8") + "\n" + fs.readFileSync("js/state.js", "utf8"), sandbox, { filename: "bundle.js" });
const test = `
;(async () => {
  let fails = 0;
  const t = (name, cond) => { console.log((cond ? "ok  " : "FAIL") + " " + name); if (!cond) fails++; };
  const calls = [];
  ApiClient.get = async (path) => { calls.push(["GET", path]); return {}; };
  ApiClient.put = async (path) => { calls.push(["PUT", path]); return {}; };
  ApiClient.post = async (path, body) => {
    calls.push(["POST", path, body && body.subject]);
    return { ok: true, subject: body.subject,
      catalog: { tasks: [], skills: [], lessons: [], missions: [], subjects: DataAPI.subjects(), subject: body.subject },
      state: { subject: body.subject, onboarded: true, skillStats: {}, hintLevels: {} }, accountId: "test" };
  };
  // Каталог профиля загружен, а состояние уже переведено на базу (как делает applyOnboarding).
  DataAPI.load(JSON.parse(__catalog));
  Store.subject = "basic_math";
  Store.state = Store.defaultState();
  Store.state.subject = "basic_math";
  Store.ready = true;
  t("предусловие: каталог profile, Store.subject=basic (расхождение)",
    DataAPI.currentSubject() === "profile_math" && Store.subject === "basic_math");
  await Store.switchSubject("basic_math");
  t("switchSubject делает POST /api/subject при расхождении с каталогом",
    calls.some((c) => c[0] === "POST" && c[1] === "/api/subject" && c[2] === "basic_math"));
  t("каталог после смены — базовый", DataAPI.currentSubject() === "basic_math");
  calls.length = 0;
  await Store.switchSubject("basic_math");
  t("повторный вызов без расхождения — no-op", !calls.some((c) => c[0] === "POST"));
  if (fails) console.log(fails + " ПРОВАЛОВ"); else console.log("ALL OK");
  return fails;
})();
`;
vm.runInContext(test, sandbox).then(
  (fails) => process.exit(fails ? 1 : 0),
  (e) => { console.error("ERROR", e); process.exit(2); });
