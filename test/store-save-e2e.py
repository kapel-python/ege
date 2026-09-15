#!/usr/bin/env python3
"""End-to-end proof that the real Store.save uses domain APIs, not /api/state."""
from __future__ import annotations

import importlib.util
import os
import subprocess
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "server" / "server.py"


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    spec = importlib.util.spec_from_file_location("ege_store_e2e", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    with tempfile.TemporaryDirectory(prefix="ege-store-e2e-") as tmp:
        db_path = Path(tmp) / "ege.sqlite3"
        server = load_server(db_path)
        conn = server.connect()
        try:
            server.install_catalog(conn)
        finally:
            conn.close()
        httpd = server.create_http_server("127.0.0.1", 0)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        probe = ROOT / "test" / "store-save-e2e-probe.js"
        probe.write_text(r'''
const fs = require("fs"), vm = require("vm");
const base = process.argv[2];
const src = fs.readFileSync("js/data.js", "utf8") + "\n" + fs.readFileSync("js/state.js", "utf8");
const calls = [];
let cookie = "";
async function fetchWithJar(path, options = {}) {
  calls.push([options.method || "GET", path]);
  const res = await fetch(base + path, { ...options, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(options.headers || {}) } });
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (set.length) cookie = set.map((x) => x.split(";")[0]).join("; ");
  return res;
}
const context = { console, JSON, Math, Date, Promise, Set, Map, Object, Array, Number, String, Boolean,
  setTimeout, clearTimeout, setInterval, clearInterval, fetch: fetchWithJar };
vm.createContext(context);
vm.runInContext(src + "\nthis.Store=Store; this.DataAPI=DataAPI; this.ApiClient=ApiClient;", context);
(async () => {
  const boot = await (await fetchWithJar("/api/bootstrap")).json();
  context.Store._applyBootstrap(boot);
  context.Store.ready = true;
  context.Store.state.taskAttempts.unshift({ taskId: "n01_p1", skill: "n01_planimetry", correct: true, hintLevel: 0, seconds: 4, ts: 1700000000000 });
  await context.Store.save();
  const after = await (await fetchWithJar("/api/bootstrap")).json();
  const legacy = calls.some(([method, path]) => method === "PUT" && path === "/api/state");
  const domain = calls.some(([method, path]) => method === "POST" && path === "/api/events/attempts");
  const saved = after.state.taskAttempts.some((x) => x.taskId === "n01_p1");
  if (!domain || legacy || !saved) throw new Error(JSON.stringify({ calls, domain, legacy, saved }));
  console.log("Store E2E OK: domain endpoint used; legacy PUT absent; attempt persisted");
})().catch((error) => { console.error(error); process.exit(1); });
''', encoding="utf-8")
        try:
            result = subprocess.run(["node", str(probe), base], cwd=ROOT, text=True, capture_output=True, timeout=60)
            assert result.returncode == 0, result.stdout + result.stderr
            print(result.stdout.strip())
        finally:
            probe.unlink(missing_ok=True)
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    main()
