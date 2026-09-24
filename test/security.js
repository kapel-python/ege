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
  const PASSWORD = process.env.EGE_TEST_ADMIN_PASSWORD;
  if (!PASSWORD) { console.error("EGE_TEST_ADMIN_PASSWORD is required (no default password in repo)"); process.exit(2); }

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
      "/README.md", "/AGENTS.md",
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
    const csp = res.headers.get("content-security-policy") || "";
    t("CSP блокирует object/frame", csp.includes("object-src 'none'") && csp.includes("frame-ancestors 'none'"), csp.slice(0, 80));
    t("Permissions-Policy режет датчики", (res.headers.get("permissions-policy") || "").includes("camera=()"));
    t("баннер сервера не светит версию", (res.headers.get("server") || "").indexOf("EGECore/1.0") === -1, res.headers.get("server"));
    const api = await req("/api/health");
    t("CSP на API тоже", (api.headers.get("content-security-policy") || "").includes("frame-ancestors 'none'"));
  }

  /* ---- 2b. Health и хвосты БД ---- */
  {
    const res = await req("/api/health");
    const body = await json(res);
    t("/api/health отвечает без авторизации", res.status === 200 && body.ok === true, `got ${res.status} ok=${body.ok}`);
    t("health показывает БД и бэкапы", body.db && body.db.integrity === "ok" && body.backup && typeof body.backup === "object", JSON.stringify(body.db));
    for (const p of ["/server/ege.sqlite3-wal", "/server/ege.sqlite3-shm", "/server/ege.sqlite3.bak", "/server/backups/manifest.json"]) {
      const r = await fetch(BASE + p);
      t(`закрыт ${p}`, r.status === 404 || r.status === 403, `got ${r.status}`);
    }
  }

  /* ---- 3. Полный снимок состояния отключён ----
     Прогресс больше не может удалить и пересобрать все таблицы одним PUT.
     Поддельные поля XP не имеют отдельного endpoint'а и не попадают в БД. */
  {
    const j = jar();
    let res = await req("/api/bootstrap", { cookies: j.header() });
    j.absorb(res);
    const boot = await json(res);
    createdAccounts.push(boot.accountId);
    res = await req("/api/state", { method: "PUT", body: { ...boot.state, xpAdjustments: [{ amount: 777777, reason: "cheat", ts: 1 }] }, cookies: j.header() });
    t("полный PUT состояния отключён", res.status === 410, `got ${res.status}`);
    res = await req("/api/bootstrap", { cookies: j.header() });
    const after = (await json(res)).state;
    t("поддельная корректировка XP не попала в журнал", (after.xpAdjustments || []).length === 0 && after.xp === 0, `xp=${after.xp}`);
  }

  /* ---- 4. Admin-грант переживает старый клиентский снимок ---- */
  {
    const j = jar();
    let res = await req("/api/bootstrap", { cookies: j.header() });
    j.absorb(res);
    const boot = await json(res);
    createdAccounts.push(boot.accountId);
    res = await req(`/api/admin/users/${boot.accountId}/xp`, { method: "POST", body: { amount: 50, reason: "security-test" }, cookies: admin.header() });
    t("admin grant +50", res.status === 200 && (await json(res)).xp === 50, `got ${res.status}`);
    // Старый клиент не может отправить snapshot и стереть grant.
    res = await req("/api/state", { method: "PUT", body: boot.state, cookies: j.header() });
    res = await req("/api/bootstrap", { cookies: j.header() });
    const after = (await json(res)).state;
    t("admin-грант пережил устаревший snapshot", res.status === 200 && after.xp === 50, `xp=${after.xp}`);
    t("журнал виден клиенту", (after.xpAdjustments || []).some((a) => a.amount === 50));
  }

  /* ---- 5. Домен attempts не доверяет агрегатам клиента ---- */
  {
    const j = jar();
    let res = await req("/api/bootstrap", { cookies: j.header() });
    j.absorb(res);
    const boot = await json(res);
    createdAccounts.push(boot.accountId);
    res = await req("/api/events/attempts", { method: "POST", body: {
      subject: boot.state.subject, expectedVersion: boot.state.stateVersion,
      // XP/totals здесь намеренно отсутствуют: событие определяет сервер.
      events: [{ taskId: "n01_p1", skill: "n01_planimetry", correct: true, hintLevel: 0, seconds: 1, ts: 1700000000000 }],
    }, cookies: j.header() });
    t("attempt event принят", res.status === 200, `got ${res.status}`);
    res = await req("/api/bootstrap", { cookies: j.header() });
    const after = (await json(res)).state;
    t("агрегаты вычислены из события, не из клиента", after.totalSolved === 1 && after.xp > 0, `xp=${after.xp} solved=${after.totalSolved}`);
  }

  /* ---- 6. Огромный Content-Length не вешает worker ---- */
  {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    let refused = false;
    try {
      const res = await fetch(BASE + "/api/events/attempts", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": String(50 * 1024 * 1024) },
        body: "x",
        signal: controller.signal,
      });
      refused = res.status === 400;
    } catch {
      refused = true;
    } finally {
      clearTimeout(timer);
    }
    t("50MB Content-Length отклонён без ожидания тела", refused);
  }

  /* ---- 7. Закрытие ошибки через другое задание (умное повторение) ----
     Связь закрытия хранится в append-only attempt.closesTaskId; resolved —
     отдельный PATCH конкретной сущности, без перезаписи истории. */
  {
    const mk = async () => {
      const j = jar();
      let res = await req("/api/bootstrap", { cookies: j.header() });
      j.absorb(res);
      const boot = await json(res);
      createdAccounts.push(boot.accountId);
      return { j, boot };
    };
    const saveReview = async (account, closeViaReview) => {
      let version = account.boot.state.stateVersion;
      const subject = account.boot.state.subject;
      let res = await req("/api/errors", { method: "POST", body: {
        subject, expectedVersion: version,
        error: { taskId: "n01_p1", skill: "n01_planimetry", sub: "t", ts: 1699999800000 },
      }, cookies: account.j.header() });
      const made = await json(res);
      if (res.status !== 200) return { res, made };
      version = made.stateVersion;
      const attempts = [
        { taskId: "n01_p1", skill: "n01_planimetry", correct: false, hintLevel: 0, seconds: 10, ts: 1699999900000 },
        { taskId: "n01_p2", skill: "n01_planimetry", correct: true, hintLevel: 0, seconds: 20,
          closesTaskId: closeViaReview ? "n01_p1" : null, ts: 1700000000000 },
      ];
      res = await req("/api/events/attempts", { method: "POST", body: { subject, expectedVersion: version, events: attempts }, cookies: account.j.header() });
      const attemptsSaved = await json(res);
      if (res.status !== 200) return { res, made: attemptsSaved };
      version = attemptsSaved.stateVersion;
      if (closeViaReview) {
        res = await req(`/api/errors/${made.error.id}`, { method: "PATCH", body: { subject, expectedVersion: version, resolved: true }, cookies: account.j.header() });
      }
      return { res, made };
    };
    const a = await mk();
    let saved = await saveReview(a, true);
    t("review-домены сохранены", saved.res.status === 200, `got ${saved.res.status}`);
    let res = await req("/api/bootstrap", { cookies: a.j.header() });
    const afterA = (await json(res)).state;
    t("review-закрытие засчитано в счётчик", afterA.errorsResolved === 1, `errorsResolved=${afterA.errorsResolved}`);
    t("закрытая через повторение ошибка видна в «Закрытых»", (afterA.errors || []).some((e) => e.taskId === "n01_p1" && e.resolved));
    const b = await mk();
    saved = await saveReview(b, false);
    res = await req("/api/bootstrap", { cookies: b.j.header() });
    const afterB = (await json(res)).state;
    t("review-закрытие оплачено ровно +15 XP", afterA.xp === afterB.xp + 15, `a.xp=${afterA.xp} b.xp=${afterB.xp}`);
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
