/* Admin panel integration tests.
   Проверяют реальную защиту admin API на живом сервере: сессии, cookie,
   привязку к аккаунту, действия, журнал. Запуск: node test/admin.js
   (сервер должен слушать BASE, по умолчанию http://127.0.0.1:2026). */
const BASE = process.env.EGE_TEST_BASE || "http://127.0.0.1:2026";
const PASSWORD = process.env.EGE_TEST_ADMIN_PASSWORD || "Tema2009!";

let fails = 0;
const t = (name, cond, extra = "") => {
  console.log((cond ? "ok  " : "FAIL") + " " + name + (cond || !extra ? "" : " — " + extra));
  if (!cond) fails++;
};

/* Мини cookie-jar: собираем Set-Cookie и подставляем в следующие запросы. */
function jar() {
  const store = new Map();
  return {
    absorb(res) {
      for (const raw of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
        const [pair] = raw.split(";");
        const i = pair.indexOf("=");
        store.set(pair.slice(0, i), pair.slice(i + 1));
      }
      return this;
    },
    header() {
      return [...store.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    get(name) { return store.get(name); },
    set(name, value) { store.set(name, value); },
    delete(name) { store.delete(name); },
    attrs(name) { return store.get(name); },
  };
}

async function req(path, { method = "GET", body = null, cookies = "" } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (cookies) headers.Cookie = cookies;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
  return res;
}

async function json(res) { try { return await res.json(); } catch { return {}; } }

const test = async () => {
  // Аккаунты, созданные этим прогоном; удаляются в конце через killer-сессию,
  // чтобы тест не засорял реальную БД.
  const createdAccounts = [];

  /* ---- 1. Аноним и обычный пользователь не имеет доступа к admin API ---- */
  {
    const anon = jar();
    let res = await req("/api/admin/overview", { cookies: anon.header() });
    anon.absorb(res);
    t("admin API без сессии: 401", res.status === 401, `got ${res.status}`);
    // Тот же «обычный пользователь» (у него уже есть ege_session) — всё ещё 401.
    res = await req("/api/bootstrap", { cookies: anon.header() });
    anon.absorb(res);
    createdAccounts.push((await json(res)).accountId);
    t("обычный пользователь после bootstrap существует", res.status === 200);
    res = await req("/api/admin/overview", { cookies: anon.header() });
    t("обычный пользователь не получает admin API: 401", res.status === 401, `got ${res.status}`);
    res = await req("/api/admin/users", { cookies: anon.header() });
    t("список пользователей без admin-сессии: 401", res.status === 401, `got ${res.status}`);
    res = await req("/api/admin/session", { cookies: anon.header() });
    t("проба сессии без пароля: 401 + admin:false", res.status === 401 && (await json(res)).admin === false);

    // Подделанная cookie не помогает.
    anon.set("ege_admin", "forged-token-12345");
    res = await req("/api/admin/overview", { cookies: anon.header() });
    t("подделанная ege_admin cookie отклоняется: 401", res.status === 401, `got ${res.status}`);
  }

  /* ---- 2. Неверный пароль не открывает доступ ---- */
  {
    const j = jar();
    let res = await req("/api/bootstrap", { cookies: j.header() });
    j.absorb(res);
    createdAccounts.push((await json(res)).accountId);
    res = await req("/api/admin/login", { method: "POST", body: { password: "wrong-password" }, cookies: j.header() });
    j.absorb(res);
    t("неверный пароль: 401", res.status === 401, `got ${res.status}`);
    t("неверный пароль не ставит ege_admin cookie", !j.get("ege_admin"));
    res = await req("/api/admin/overview", { cookies: j.header() });
    t("после неверного пароля admin API закрыт: 401", res.status === 401, `got ${res.status}`);
    res = await req("/api/admin/login", { method: "POST", body: {}, cookies: j.header() });
    t("пустой пароль: 400", res.status === 400, `got ${res.status}`);
  }

  /* ---- 3. Верный пароль создаёт сессию; cookie HttpOnly ---- */
  const adminJar = jar();
  let accountId = null;
  let adminCookieHeader = null;
  {
    let res = await req("/api/bootstrap", { cookies: adminJar.header() });
    adminJar.absorb(res);
    const boot = await json(res);
    accountId = boot.accountId;
    createdAccounts.push(accountId);
    t("тестовый аккаунт создан", !!accountId, accountId);

    res = await req("/api/admin/login", { method: "POST", body: { password: PASSWORD }, cookies: adminJar.header() });
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    adminCookieHeader = setCookies.find((c) => c.startsWith("ege_admin=")) || "";
    adminJar.absorb(res);
    const body = await json(res);
    t("верный пароль: 200 + ok", res.status === 200 && body.ok === true, JSON.stringify(body));
    t("admin cookie HttpOnly", /HttpOnly/i.test(adminCookieHeader), adminCookieHeader);
    t("admin cookie SameSite=Lax", /SameSite=Lax/i.test(adminCookieHeader), adminCookieHeader);
    t("admin cookie Max-Age = 30 дней", /Max-Age=2592000\b/.test(adminCookieHeader), adminCookieHeader);
    t("admin cookie привязана к сессии того же аккаунта", !!adminJar.get("ege_session"));
    t("expiresAt ≈ +30 дней", Math.abs(body.expiresAt - Date.now() - 30 * 86400 * 1000) < 60 * 1000);

    res = await req("/api/admin/session", { cookies: adminJar.header() });
    const sess = await json(res);
    t("проба сессии после входа: admin:true, тот же аккаунт", res.status === 200 && sess.admin === true && sess.user.accountId === accountId);

    res = await req("/api/admin/overview", { cookies: adminJar.header() });
    t("обзор доступен с сессией: 200", res.status === 200, `got ${res.status}`);
    const overview = await json(res);
    t("обзор содержит реальные агрегаты", overview.users && overview.users.total >= 1 && Array.isArray(overview.activity) && overview.activity.length === 14);
    const { execFileSync } = await import("node:child_process");
    const dbTasks = Number(execFileSync("python3", ["-c",
      "import sqlite3;print(sqlite3.connect('/root/ege/server/ege.sqlite3').execute('SELECT COUNT(*) FROM tasks').fetchone()[0])",
    ], { encoding: "utf8" }).trim());
    t("обзор: счётчик задач совпадает с БД", overview.catalog.tasks === dbTasks, `${overview.catalog.tasks} vs ${dbTasks}`);
    t("системный блок: аптайм и размер БД", overview.system.uptimeSec >= 0 && overview.system.dbSizeBytes > 0);
  }

  /* ---- 4. «Обновление страницы»: повторные запросы с той же cookie без пароля ---- */
  {
    const res = await req("/api/admin/session", { cookies: adminJar.header() });
    t("повторный заход без пароля: сессия жива", res.status === 200 && (await json(res)).admin === true);
    const res2 = await req("/api/admin/users", { cookies: adminJar.header() });
    const list = await json(res2);
    t("список пользователей: 200 и содержит наш аккаунт", res2.status === 200 && list.users.some((u) => u.accountId === accountId));
  }

  /* ---- 5. Истёкшая сессия отклоняется ---- */
  {
    // Заводим вторую сессию и искусственно старим её прямо в БД.
    const j2 = jar();
    let res = await req("/api/bootstrap", { cookies: j2.header() });
    j2.absorb(res);
    createdAccounts.push((await json(res)).accountId);
    res = await req("/api/admin/login", { method: "POST", body: { password: PASSWORD }, cookies: j2.header() });
    j2.absorb(res);
    t("вторая сессия создана", res.status === 200);
    const { execFileSync: exec2 } = await import("node:child_process");
    const token = j2.get("ege_admin");
    exec2("python3", ["-c",
      "import sqlite3, sys\n" +
      "con = sqlite3.connect('/root/ege/server/ege.sqlite3')\n" +
      "con.execute('UPDATE admin_sessions SET expires_at = 1 WHERE token = ?', (sys.argv[1],))\n" +
      "con.commit()", token]);
    res = await req("/api/admin/overview", { cookies: j2.header() });
    t("истёкшая admin-сессия отклоняется: 401", res.status === 401, `got ${res.status}`);
    res = await req("/api/admin/session", { cookies: j2.header() });
    t("истёкшая сессия: admin:false", res.status === 401 && (await json(res)).admin === false);
    // Повторный вход работает.
    res = await req("/api/admin/login", { method: "POST", body: { password: PASSWORD }, cookies: j2.header() });
    j2.absorb(res);
    t("после истечения срока новый вход работает", res.status === 200);
  }

  /* ---- 6. Cookie одного аккаунта не даёт доступ другому ---- */
  {
    const j3 = jar();
    let res = await req("/api/bootstrap", { cookies: j3.header() });
    j3.absorb(res);
    createdAccounts.push((await json(res)).accountId);
    // Чужая ege_admin cookie + своя ege_session = нет доступа.
    j3.set("ege_admin", adminJar.get("ege_admin"));
    res = await req("/api/admin/overview", { cookies: j3.header() });
    t("скопированная admin cookie у другого аккаунта: 401", res.status === 401, `got ${res.status}`);
    res = await req("/api/admin/session", { cookies: j3.header() });
    t("другой аккаунт с чужой admin cookie: admin:false", res.status === 401 && (await json(res)).admin === false);
  }

  /* ---- 7. Действия: профиль, XP, сбросы, аудит ---- */
  {
    // Профиль своего тестового аккаунта.
    let res = await req(`/api/admin/users/${accountId}/profile`, { method: "PUT", body: { name: "Тест Админов", selfLevel: "base", goal: "g80" }, cookies: adminJar.header() });
    let body = await json(res);
    t("редактирование профиля: 200", res.status === 200 && body.name === "Тест Админов", JSON.stringify(body));
    res = await req(`/api/admin/users/${accountId}/profile`, { method: "PUT", body: { selfLevel: "bogus" }, cookies: adminJar.header() });
    t("невалидный selfLevel отклоняется: 400", res.status === 400, `got ${res.status}`);
    res = await req(`/api/admin/users/${accountId}/profile`, { method: "PUT", body: { goal: "g999" }, cookies: adminJar.header() });
    t("невалидная цель отклоняется: 400", res.status === 400, `got ${res.status}`);

    // XP.
    res = await req(`/api/admin/users/${accountId}`, { cookies: adminJar.header() });
    const before = (await json(res)).user.stats.xp;
    res = await req(`/api/admin/users/${accountId}/xp`, { method: "POST", body: { amount: 120, reason: "тест-грант" }, cookies: adminJar.header() });
    body = await json(res);
    t("грант XP: +120 к балансу", res.status === 200 && body.xp === before + 120, JSON.stringify(body));
    res = await req(`/api/admin/users/${accountId}/xp`, { method: "POST", body: { amount: -20, reason: "тест-списание" }, cookies: adminJar.header() });
    body = await json(res);
    t("списание XP: -20", res.status === 200 && body.xp === before + 100, JSON.stringify(body));
    res = await req(`/api/admin/users/${accountId}/xp`, { method: "POST", body: { amount: 0 }, cookies: adminJar.header() });
    t("нулевой грант отклоняется: 400", res.status === 400, `got ${res.status}`);

    // Журнал аудита фиксирует действия.
    res = await req("/api/admin/audit", { cookies: adminJar.header() });
    const audit = (await json(res)).entries;
    t("журнал содержит grant-xp и update-profile", audit.some((e) => e.action === "grant-xp") && audit.some((e) => e.action === "update-profile"));

    // Сброс streak (безопасный).
    res = await req(`/api/admin/users/${accountId}/reset`, { method: "POST", body: { target: "streak" }, cookies: adminJar.header() });
    t("сброс streak: 200", res.status === 200 && (await json(res)).ok === true, `got ${res.status}`);
    res = await req(`/api/admin/users/${accountId}/reset`, { method: "POST", body: { target: "bogus" }, cookies: adminJar.header() });
    t("неизвестный сброс отклоняется: 400", res.status === 400, `got ${res.status}`);

    // Поиск по Account ID и внутреннему id.
    res = await req(`/api/admin/users/${accountId}`, { cookies: adminJar.header() });
    const byAccount = (await json(res)).user;
    res = await req(`/api/admin/users/${byAccount.id}`, { cookies: adminJar.header() });
    const byId = (await json(res)).user;
    t("карточка находится и по Account ID, и по внутреннему id", byAccount.id === byId.id);
    res = await req("/api/admin/users/zzzzzz", { cookies: adminJar.header() });
    t("несуществующий аккаунт: 404", res.status === 404, `got ${res.status}`);

    // Удаление себя запрещено.
    res = await req(`/api/admin/users/${accountId}/delete`, { method: "POST", body: {}, cookies: adminJar.header() });
    t("удаление собственного аккаунта запрещено: 400", res.status === 400, `got ${res.status}`);

    // Полный сброс прогресса тестового аккаунта (в конце).
    res = await req(`/api/admin/users/${accountId}/reset`, { method: "POST", body: { target: "all-progress" }, cookies: adminJar.header() });
    t("полный сброс прогресса: 200", res.status === 200, `got ${res.status}`);
    res = await req(`/api/admin/users/${accountId}`, { cookies: adminJar.header() });
    const after = (await json(res)).user;
    t("после полного сброса XP=0, решено=0, онбординг сброшен", after.stats.xp === 0 && after.stats.totalSolved === 0 && after.onboarded === false);
  }

  /* ---- 8. Logout: сессия умирает, cookie очищается ---- */
  {
    let res = await req("/api/admin/logout", { method: "POST", body: {}, cookies: adminJar.header() });
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    const cleared = setCookies.find((c) => c.startsWith("ege_admin=;")) || "";
    t("logout: 200", res.status === 200);
    t("logout очищает cookie (Max-Age=0)", /Max-Age=0/.test(cleared), cleared);
    res = await req("/api/admin/overview", { cookies: adminJar.header() });
    t("после logout старый токен не работает: 401", res.status === 401, `got ${res.status}`);
  }

  /* ---- 9. Страница /admin отдаётся и не содержит пароль ---- */
  {
    const res = await fetch(BASE + "/admin");
    const html = await res.text();
    t("GET /admin: 200, HTML", res.status === 200 && html.includes("<!doctype html>"));
    t("страница не содержит пароль в открытом виде", !html.includes(PASSWORD));
    const jsRes = await fetch(BASE + "/js/admin.js");
    const js = await jsRes.text();
    t("js/admin.js отдаётся", jsRes.status === 200 && js.length > 1000);
    t("в admin.js нет пароля и нет хардкода токенов", !js.includes(PASSWORD) && !/ege_admin\s*=\s*["'][A-Za-z0-9]/.test(js));
    // Серверный код тоже не хранит пароль (только хэш).
    const { readFileSync } = await import("node:fs");
    const serverSrc = readFileSync("server/server.py", "utf8");
    t("server.py не содержит пароль в открытом виде", !serverSrc.includes(PASSWORD));
    t("server.py хранит PBKDF2-хэш", serverSrc.includes("pbkdf2_sha256$"));
  }

  /* ---- 10. Удаление аккаунта каскадно убирает его admin-сессию ---- */
  {
    // Новый «владелец» + новый админ-аккаунт, который его удалит.
    const victim = jar();
    let res = await req("/api/bootstrap", { cookies: victim.header() });
    victim.absorb(res);
    const victimId = (await json(res)).accountId;
    res = await req("/api/admin/login", { method: "POST", body: { password: PASSWORD }, cookies: victim.header() });
    victim.absorb(res);
    t("сессия жертвы создана", res.status === 200);

    const killer = jar();
    res = await req("/api/bootstrap", { cookies: killer.header() });
    killer.absorb(res);
    res = await req("/api/admin/login", { method: "POST", body: { password: PASSWORD }, cookies: killer.header() });
    killer.absorb(res);
    res = await req(`/api/admin/users/${victimId}/delete`, { method: "POST", body: {}, cookies: killer.header() });
    t("удаление чужого аккаунта админом: 200", res.status === 200, `got ${res.status}`);
    res = await req("/api/admin/session", { cookies: victim.header() });
    t("admin-сессия удалённого аккаунта больше не действует", res.status === 401 && (await json(res)).admin === false);
    res = await req(`/api/admin/users/${victimId}`, { cookies: killer.header() });
    t("удалённый аккаунт не находится: 404", res.status === 404, `got ${res.status}`);
    // Самоочистка: killer удаляет все аккаунты, созданные этим прогоном.
    let removed = 0;
    for (const acc of createdAccounts.filter(Boolean)) {
      const del = await req(`/api/admin/users/${acc}/delete`, { method: "POST", body: {}, cookies: killer.header() });
      if (del.status === 200 || del.status === 404) removed++;
    }
    t("тестовые аккаунты удалены", removed === createdAccounts.filter(Boolean).length,
      `${removed}/${createdAccounts.filter(Boolean).length}`);
  }

  console.log(fails === 0 ? "\nВСЕ ADMIN-ТЕСТЫ ПРОЙДЕНЫ" : `\n${fails} ПРОВАЛОВ`);
  process.exit(fails ? 1 : 0);
};

test().catch((e) => { console.error("Test run crashed:", e); process.exit(1); });
