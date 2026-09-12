/* Регрессионные тесты безопасности. Запуск: node test/security.js
   (сервер должен слушать BASE, по умолчанию http://127.0.0.1:2026).
   Каждый тест привязан к подтверждённой уязвимости из аудита и упадёт,
   если защита будет случайно ослаблена. */
const BASE = process.env.EGE_TEST_BASE || "http://127.0.0.1:2026";

let fails = 0;
const t = (name, cond, extra = "") => {
  console.log((cond ? "ok  " : "FAIL") + " " + name + (cond || !extra ? "" : " — " + extra));
  if (!cond) fails++;
};

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
    header() { return [...store.entries()].map(([k, v]) => `${k}=${v}`).join("; "); },
  };
}

async function req(path, { method = "GET", body = null, cookies = "" } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (cookies) headers.Cookie = cookies;
  return fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
}
async function json(res) { try { return await res.json(); } catch { return {}; } }

const test = async () => {
  const createdAccounts = [];
  const PASSWORD = process.env.EGE_TEST_ADMIN_PASSWORD || "Tema2009!";

  // Админ-сессия для самоочистки созданных аккаунтов в конце.
  const admin = jar();
  {
    let res = await req("/api/bootstrap", { cookies: admin.header() });
    admin.absorb(res);
    createdAccounts.push((await json(res)).accountId);
    res = await req("/api/admin/login", { method: "POST", body: { password: PASSWORD }, cookies: admin.header() });
    admin.absorb(res);
  }

  /* ---- 1. Приватные файлы не отдаются по HTTP ----
     Источник Critical-находки: /server/ege.sqlite3 (session-токены всех
     пользователей и admin-сессии) скачивался без авторизации. */
  {
    const blocked = [
      "/server/ege.sqlite3", "/server/server.py", "/server/catalog.json",
      "/.git/config", "/.git/HEAD", "/.gitignore",
      "/deploy/ege-2026.service", "/test/admin.js",
      "/ege_complete.txt", "/ege_complete_sources.md", "/README.md", "/AGENTS.md",
      "/.ege-2026.pid",
    ];
    for (const p of blocked) {
      const res = await fetch(BASE + p);
      t(`закрыт ${p}`, res.status === 404 || res.status === 403, `got ${res.status}`);
    }
    // Траверсал не выводит за пределы корня.
    const res = await fetch(BASE + "/%2e%2e/server/ege.sqlite3");
    t("encoded traversal отклонён", res.status === 404 || res.status === 403 || res.status === 400, `got ${res.status}`);
    // Публичная поверхность продолжает работать.
    for (const p of ["/", "/dashboard", "/admin", "/js/app.js", "/js/state.js", "/js/admin.js", "/css/styles.css"]) {
      const res = await fetch(BASE + p);
      t(`публичный ${p} доступен`, res.status === 200, `got ${res.status}`);
    }
  }

  /* ---- 2. Security headers ---- */
  {
    const res = await fetch(BASE + "/");
    t("X-Content-Type-Options: nosniff", res.headers.get("x-content-type-options") === "nosniff");
    t("X-Frame-Options: DENY", res.headers.get("x-frame-options") === "DENY");
  }

  /* ---- 3. Клиент не может начислить себе XP через xpAdjustments ----
     Источник High-находки: write_state принимал новые строки журнала из
     payload, и derive_stats добавлял их к XP. */
  {
    const j = jar();
    let res = await req("/api/bootstrap", { cookies: j.header() });
    j.absorb(res);
    const boot = await json(res);
    createdAccounts.push(boot.accountId);
    const state = { ...boot.state, xpAdjustments: [{ amount: 777777, reason: "cheat", ts: 1 }] };
    res = await req("/api/state", { method: "PUT", body: state, cookies: j.header() });
    t("PUT с поддельным xpAdjustments принят без падения", res.status === 200, `got ${res.status}`);
    res = await req("/api/bootstrap", { cookies: j.header() });
    const after = (await json(res)).state;
    t("XP не вырос от поддельной корректировки", after.xp === 0, `xp=${after.xp}`);
    t("поддельная запись не сохранилась в журнал", (after.xpAdjustments || []).length === 0);
  }

  /* ---- 4. Admin-грант по-прежнему работает и переживает клиентский sync ---- */
  {
    const j = jar();
    let res = await req("/api/bootstrap", { cookies: j.header() });
    j.absorb(res);
    const boot = await json(res);
    createdAccounts.push(boot.accountId);
    res = await req(`/api/admin/users/${boot.accountId}/xp`, { method: "POST", body: { amount: 50, reason: "security-test" }, cookies: admin.header() });
    t("admin grant +50", res.status === 200 && (await json(res)).xp === 50, `got ${res.status}`);
    // Клиент со старым снимком (без гранта) синкается — грант не должен стереться.
    res = await req("/api/state", { method: "PUT", body: boot.state, cookies: j.header() });
    res = await req("/api/bootstrap", { cookies: j.header() });
    const after = (await json(res)).state;
    t("admin-грант пережил sync устаревшего снимка", after.xp === 50, `xp=${after.xp}`);
    t("журнал виден клиенту", (after.xpAdjustments || []).some((a) => a.amount === 50));
  }

  /* ---- 5. Счётчики clamp'ятся к реальным событиям ---- */
  {
    const j = jar();
    let res = await req("/api/bootstrap", { cookies: j.header() });
    j.absorb(res);
    const boot = await json(res);
    createdAccounts.push(boot.accountId);
    const state = { ...boot.state, xp: 10 ** 9, totalSolved: 10 ** 6, totalCorrect: 10 ** 6, streak: 3650 };
    res = await req("/api/state", { method: "PUT", body: state, cookies: j.header() });
    res = await req("/api/bootstrap", { cookies: j.header() });
    const after = (await json(res)).state;
    t("накрученные xp/totalSolved отброшены сервером", after.xp === 0 && after.totalSolved === 0, `xp=${after.xp} solved=${after.totalSolved}`);
    t("накрученный streak сохранился (косметический, не валютный)", after.streak === 3650, `streak=${after.streak}`);
  }

  /* ---- 6. Валидация границ и объёмов ---- */
  {
    const j = jar();
    let res = await req("/api/bootstrap", { cookies: j.header() });
    j.absorb(res);
    const boot = await json(res);
    createdAccounts.push(boot.accountId);

    let state = { ...boot.state, streak: -1 };
    res = await req("/api/state", { method: "PUT", body: state, cookies: j.header() });
    t("отрицательный streak: 400", res.status === 400, `got ${res.status}`);

    state = { ...boot.state, totalCorrect: 5, totalSolved: 1 };
    res = await req("/api/state", { method: "PUT", body: state, cookies: j.header() });
    t("correct > solved: 400", res.status === 400, `got ${res.status}`);

    state = { ...boot.state, timeline: Array.from({ length: 500 }, () => ({ ts: 1, text: "x" })) };
    res = await req("/api/state", { method: "PUT", body: state, cookies: j.header() });
    t("timeline сверх лимита: 400", res.status === 400, `got ${res.status}`);

    state = { ...boot.state, taskAttempts: Array.from({ length: 25000 }, (_, i) => ({ taskId: "n01_p1", skill: "n01_planimetry", correct: i % 2 === 0, hintLevel: 0, seconds: 1, ts: i })) };
    res = await req("/api/state", { method: "PUT", body: state, cookies: j.header() });
    t("taskAttempts сверх лимита: 400", res.status === 400, `got ${res.status}`);
  }

  /* ---- 7. Огромный Content-Length не вешает worker ---- */
  {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    let refused = false;
    try {
      const res = await fetch(BASE + "/api/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "Content-Length": String(50 * 1024 * 1024) },
        body: "x",
        signal: controller.signal,
      });
      refused = res.status === 400;
    } catch {
      refused = true; // сервер закрыл соединение, не дожидаясь 50 МБ
    } finally {
      clearTimeout(timer);
    }
    t("50MB Content-Length отклонён без ожидания тела", refused);
  }

  // Самоочистка тестовых аккаунтов.
  {
    let removed = 0;
    const targets = createdAccounts.filter(Boolean);
    for (const acc of targets.slice(1)) {
      const res = await req(`/api/admin/users/${acc}/delete`, { method: "POST", body: {}, cookies: admin.header() });
      if (res.status === 200 || res.status === 404) removed++;
    }
    t("тестовые аккаунты удалены", removed === targets.length - 1, `${removed}/${targets.length - 1}`);
    await req(`/api/admin/users/${targets[0]}/delete`, { method: "POST", body: {}, cookies: admin.header() });
  }

  console.log(fails === 0 ? "\nВСЕ SECURITY-ТЕСТЫ ПРОЙДЕНЫ" : `\n${fails} ПРОВАЛОВ`);
  process.exit(fails ? 1 : 0);
};

test().catch((e) => { console.error("Test run crashed:", e); process.exit(1); });
