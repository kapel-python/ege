#!/usr/bin/env python3
"""Спот-пересчёт ответов банка по скачанным файлам (независимые_checker'ы).

Покрытие: inf17 ×5, inf24 ×4, inf26 ×3, inf27 ×3 задачи (6 файлов),
inf09 ×4, inf22 ×3. Эталон — answer каталога. Независимая реализация
(не копия кода из решений банка); расхождение = FAIL + разбор вручную.

    python3 tools/verify_inf_files.py
"""
from __future__ import annotations

import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "tools" / "out" / "inf_raw"
MANIFEST = ROOT / "tools" / "out" / "inf_files.json"
CATALOG = ROOT / "server" / "catalog_informatics.json"

FAILS: list[str] = []


def raw_path(src_id: str, k: int = 0) -> Path:
    m = json.loads(MANIFEST.read_text(encoding="utf-8"))
    return RAW / m[src_id]["files"][k]["file"]


def catalog_answer(task_id: str) -> str:
    d = json.loads(CATALOG.read_text(encoding="utf-8"))
    t = next(x for x in d["tasks"] if x["id"] == task_id)
    return re.sub(r"\s+", " ", t["answer"]).strip()


def check(name: str, got, want: str):
    got_s = re.sub(r"\s+", " ", str(got)).strip()
    ok = got_s == want
    print(("ok  " if ok else "FAIL") + f" {name}: got={got_s} want={want}")
    if not ok:
        FAILS.append(name)


def ints_txt(path: Path, skip_first: bool = False) -> list[int]:
    lines = path.read_text(encoding="utf-8").split()
    if skip_first:
        lines = lines[1:]
    return [int(x) for x in lines]


# ---------- ods / xlsx (stdlib) ----------
ODS_NS = {"table": "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
          "office": "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
          "text": "urn:oasis:names:tc:opendocument:xmlns:text:1.0"}


def ods_rows(path: Path) -> list[list[float]]:
    # Разреженный разбор: листы источника содержат повторы пустых ячеек
    # (number-columns-repeated="16384", строк — десятки тысяч). Раскрывать
    # их в списки нельзя — только ведущие значащие ячейки, пустые хвосты
    # отбрасываем, полностью пустые строки пропускаем.
    z = zipfile.ZipFile(path)
    root = ET.fromstring(z.read("content.xml"))
    T = "{urn:oasis:names:tc:opendocument:xmlns:table:1.0}"
    O = "{urn:oasis:names:tc:opendocument:xmlns:office:1.0}"
    rows = []
    for tr in root.iter(T + "table-row"):
        cells: list = []
        for tc in tr.findall(T + "table-cell"):
            rep = int(tc.get(T + "number-columns-repeated", "1"))
            v = tc.get(O + "value")
            if v is None:
                t = "".join(tc.itertext()).strip()
                if t != "":
                    try:
                        v = float(t.replace(",", "."))
                    except ValueError:
                        v = t
            else:
                try:
                    v = float(v)
                except ValueError:
                    pass
            if v is None:
                continue  # пустые ячейки не материализуем
            cells.append(v)
            if rep > 1 and v is not None:
                cells.extend([v] * min(rep - 1, 64 - len(cells)))
                if len(cells) >= 64:
                    break
        if cells:
            rows.append(cells[:64])
    return rows


def xlsx_rows(path: Path) -> list[list]:
    z = zipfile.ZipFile(path)
    strings: list[str] = []
    if "xl/sharedStrings.xml" in z.namelist():
        sr = ET.fromstring(z.read("xl/sharedStrings.xml"))
        for si in sr.iter("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t"):
            pass
        for si in sr.findall("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}si"):
            strings.append("".join(si.itertext()))
    NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    sheet = [n for n in z.namelist() if n.startswith("xl/worksheets/sheet")][0]
    root = ET.fromstring(z.read(sheet))
    rows = []
    for tr in root.iter(NS + "row"):
        cells: dict[int, object] = {}
        for c in tr.iter(NS + "c"):
            ref = c.get("r", "A1")
            col = 0
            for ch in ref:
                if ch.isalpha():
                    col = col * 26 + (ord(ch.upper()) - 64)
                else:
                    break
            col -= 1
            tp = c.get("t", "")
            v = c.findtext(NS + "v")
            if tp == "s" and v is not None:
                cells[col] = strings[int(v)]
            elif tp == "inlineStr":
                cells[col] = "".join(c.itertext())
            elif v is not None:
                try:
                    cells[col] = float(v)
                except ValueError:
                    cells[col] = v
        if cells:
            width = max(cells) + 1
            rows.append([cells.get(i) for i in range(width)])
    return rows


def num_row(cells, n: int):
    vals = [c for c in cells if isinstance(c, (int, float))]
    if len(vals) != n:
        return None
    out = []
    for v in vals:
        if float(v) != int(float(v)):
            return None
        out.append(int(float(v)))
    return out


# ---------- inf17 ----------
def v17_p1():
    a = ints_txt(raw_path("87408"))
    m99 = min(x for x in a if x > 0 and x % 100 == 99)
    ss = [a[i] + a[i + 1] + a[i + 2] for i in range(len(a) - 2)
          if sum(1 for x in (a[i], a[i + 1], a[i + 2]) if 100 <= abs(x) <= 999) >= 2
          and a[i] + a[i + 1] + a[i + 2] >= m99]
    check("inf17_p1", f"{len(ss)} {min(ss)}", catalog_answer("inf17_p1"))


def v17_p2():
    a = ints_txt(raw_path("92221"))
    k27 = sum(1 for x in a if x % 27 == 0)
    ss = [a[i] + a[i + 1] for i in range(len(a) - 1)
          if (a[i] < 0 or a[i + 1] < 0) and a[i] + a[i + 1] > k27]
    check("inf17_p2", f"{len(ss)} {max(ss)}", catalog_answer("inf17_p2"))


def v17_p3():
    a = ints_txt(raw_path("51986"))
    cand = [x for x in a if str(x)[-1] == "5"]
    mini = min(cand)
    ss = [a[i] ** 2 + a[i + 1] ** 2 for i in range(len(a) - 1)
          if str(min(a[i], a[i + 1]))[-1] == "5" and a[i] ** 2 + a[i + 1] ** 2 < mini ** 2]
    check("inf17_p3", f"{len(ss)} {max(ss)}", catalog_answer("inf17_p3"))


def v17_p4():
    a = ints_txt(raw_path("59785"))
    m13 = max(x for x in a if abs(x) % 100 == 13)
    ss = [a[i] + a[i + 1] + a[i + 2] for i in range(len(a) - 2)
          if sum(1 for x in (a[i], a[i + 1], a[i + 2]) if 100 <= abs(x) <= 999) == 2
          and a[i] + a[i + 1] + a[i + 2] < m13]
    check("inf17_p4", f"{len(ss)} {min(ss)}", catalog_answer("inf17_p4"))


def v17_p5():
    a = ints_txt(raw_path("85730"))
    m14 = max(x for x in a if abs(x) % 100 == 14)
    ss = [a[i] + a[i + 1] + a[i + 2] for i in range(len(a) - 2)
          if a[i] >= 0 and a[i + 1] >= 0 and a[i + 2] >= 0
          and a[i] + a[i + 1] + a[i + 2] <= m14]
    check("inf17_p5", f"{len(ss)} {max(ss)}", catalog_answer("inf17_p5"))


# ---------- inf24 ----------
def v24_p1():
    s = raw_path("76692").read_text(encoding="utf-8")
    best = -10 ** 18
    for m in re.finditer(r"C", s):
        # правильная сумма начинается непосредственно после C
        j = m.start() + 1
        if j < len(s) and s[j].isdigit():
            cur = 0
            k = j
            while k < len(s) and s[k].isdigit():
                cur = cur * 10 + int(s[k])
                k += 1
            best = max(best, cur)
            while k < len(s) and s[k] in "+-" and k + 1 < len(s) and s[k + 1].isdigit():
                op = s[k]
                k += 1
                nxt = 0
                while k < len(s) and s[k].isdigit():
                    nxt = nxt * 10 + int(s[k])
                    k += 1
                cur = cur + nxt if op == "+" else cur - nxt
                best = max(best, cur)
    check("inf24_p1", best, catalog_answer("inf24_p1"))


def v24_p2():
    s = raw_path("63073").read_text(encoding="utf-8").strip()
    best, left, cC, cD = 0, 0, 0, 0
    for right, ch in enumerate(s):
        cC += ch == "C"
        cD += ch == "D"
        while cC > 2 or cD > 2:
            cC -= s[left] == "C"
            cD -= s[left] == "D"
            left += 1
        best = max(best, right - left + 1)
    check("inf24_p2", best, catalog_answer("inf24_p2"))


def v24_p3():
    s = raw_path("33769").read_text(encoding="utf-8").strip()
    from collections import Counter
    c = Counter(s[i + 2] for i in range(len(s) - 2) if s[i] == s[i + 1])
    ans = max(sorted(c), key=lambda k: c[k])
    check("inf24_p3", ans, catalog_answer("inf24_p3"))


def v24_p5():
    s = raw_path("81808").read_text(encoding="utf-8")
    if "\n" in s:
        s = s.split("\n")[0]
    parts = s.strip().split("Y")
    dl = [len(x) for x in parts]
    kol = [x.count("2025") for x in parts]
    best = 0
    for i in range(len(dl) - 80):
        if sum(kol[i:i + 81]) >= 90:
            best = max(best, sum(dl[i:i + 81]) + 80)
    check("inf24_p5", best, catalog_answer("inf24_p5"))


# ---------- inf26 ----------
def v26_p1():
    nums = ints_txt(raw_path("75290"))
    pts = sorted(set(zip(nums[1::2], nums[2::2])))
    rows: dict[int, list[int]] = {}
    for r, c in pts:
        rows.setdefault(r, []).append(c)
    ans = []
    for r, cols in rows.items():
        k = sum(1 for i, c in enumerate(cols)
                if (i == 0 or c - cols[i - 1] > 1000) and (i == len(cols) - 1 or cols[i + 1] - c > 1000))
        ans.append((k, r))
    ans.sort()
    check("inf26_p1", f"{ans[-1][0]} {ans[-1][1]}", catalog_answer("inf26_p1"))


def nesting(path: Path, diff: int):
    nums = ints_txt(path)
    cubes = sorted(nums[1:], reverse=True)
    blocks = 0
    longest = 0
    while cubes:
        blocks += 1
        outer = cubes.pop(0)
        size = 1
        rest = []
        for c in cubes:
            if outer - c >= diff:
                size += 1
                outer = c
            else:
                rest.append(c)
        cubes = rest
        longest = max(longest, size)
    return blocks, longest


def v26_p2():
    check("inf26_p2", "%d %d" % nesting(raw_path("48447"), 5), catalog_answer("inf26_p2"))


def v26_p3():
    check("inf26_p3", "%d %d" % nesting(raw_path("48474"), 7), catalog_answer("inf26_p3"))


# ---------- inf27 ----------
def f27(path: Path) -> list[list[int]]:
    lines = path.read_text(encoding="utf-8").splitlines()
    return [list(map(int, ln.split())) for ln in lines[1:] if ln.strip()]


def v27_p2():
    for k, want_file in ((0, "A"), (1, "B")):
        triples = f27(raw_path("33199", k))
        NEG = -10 ** 30
        dp = {(0, 0): 0}
        for x, y, z in triples:
            ndp = {}
            import itertools
            for (p1, p2), s3 in dp.items():
                for g1, g2, g3 in itertools.permutations((x, y, z)):
                    key = ((p1 + g1) & 1, (p2 + g2) & 1)
                    ndp[key] = max(ndp.get(key, NEG), s3 + g3)
            dp = ndp
        ans = max((s for (p1, p2), s in dp.items() if p1 == 0 and p2 == 1), default=NEG)
        want = catalog_answer("inf27_p2").split()[k]
        check(f"inf27_p2-{want_file}", ans, want)


def v27_p4():
    txt = raw_path("61407", 0).read_text(encoding="utf-8").split()
    k, n, a = int(txt[0]), int(txt[1]), list(map(int, txt[2:2 + int(txt[1])]))
    from collections import Counter
    top = Counter(sorted(a, reverse=True)[:3])
    back = float("-inf")
    m = float("-inf")
    for i in range(2 * k, n):
        back = max(back, a[i - 2 * k])
        third = max(x for x in top if top[x] - (a[i] == x) - (back == x) > 0)
        m = max(m, back + third + a[i])
    check("inf27_p4-A", int(m), catalog_answer("inf27_p4").split()[0])
    txt = raw_path("61407", 1).read_text(encoding="utf-8").split()
    k, n, a = int(txt[0]), int(txt[1]), list(map(int, txt[2:2 + int(txt[1])]))
    top = Counter(sorted(a, reverse=True)[:3])
    back = float("-inf")
    m = float("-inf")
    for i in range(2 * k, n):
        back = max(back, a[i - 2 * k])
        third = max(x for x in top if top[x] - (a[i] == x) - (back == x) > 0)
        m = max(m, back + third + a[i])
    check("inf27_p4-B", int(m), catalog_answer("inf27_p4").split()[1])


def v27_p7():
    for k, tag in ((0, "A"), (1, "B")):
        nums = ints_txt(raw_path("64957", k), skip_first=True)
        best3: list[list[int]] = [[] for _ in range(105)]
        for x in nums:
            r = x % 105
            best3[r].append(x)
            best3[r].sort(reverse=True)
            del best3[r][3:]
        best = -1
        for r1 in range(105):
            for r2 in range(105):
                r3 = (210 - r1 - r2) % 105
                idx = sorted([r1, r2, r3])
                if len(set(idx)) == 3:
                    if best3[r1] and best3[r2] and best3[r3]:
                        best = max(best, best3[r1][0] + best3[r2][0] + best3[r3][0])
                elif r1 == r2 == r3:
                    if len(best3[r1]) >= 3:
                        best = max(best, sum(best3[r1][:3]))
                else:
                    solo = idx[0] if idx[0] != idx[1] else idx[2]
                    pair = idx[1]
                    if best3[solo] and len(best3[pair]) >= 2:
                        best = max(best, best3[solo][0] + best3[pair][0] + best3[pair][1])
        check(f"inf27_p7-{tag}", best, catalog_answer("inf27_p7").split()[k])


# ---------- inf09 ----------
def v09(src: str, task: str, n: int, pred):
    vals = []
    for cells in ods_rows(raw_path(src)):
        r = num_row(cells, n)
        if r is not None:
            vals.append(r)
    check(task, pred(vals), catalog_answer(task))


def v09_p1():
    def pred(rows):
        for r in rows:
            from collections import Counter
            c = Counter(r)
            tri = [x for x in r if c[x] == 3]
            dva = [x for x in r if c[x] == 2]
            sng = [x for x in r if c[x] == 1]
            if len(tri) == 3 and len(dva) == 2 and len(sng) == 2 \
                    and min(min(tri), min(dva)) >= sum(sng):
                return abs(min(min(tri), min(dva)))
        return "none"
    v09("85722", "inf09_p1", 7, pred)


def v09_p2():
    def pred(rows):
        k = 0
        for r in rows:
            from collections import Counter
            c = Counter(r)
            tri = [x for x in r if c[x] == 3]
            sng = [x for x in r if c[x] == 1]
            if len(tri) == 3 and len(sng) == 3 and (set(tri).pop() >= sum(sng) / 3):
                k += 1
        return k
    v09("69914", "inf09_p2", 6, pred)


def v09_p3():
    def pred(rows):
        k = 0
        for r in rows:
            if len(set(r)) == 5:
                from collections import Counter
                c = Counter(r)
                pair = [x for x in r if c[x] == 2]
                if len(pair) == 2 and sum(pair) < (sum(r) - sum(pair)) / 4:
                    k += 1
        return k
    v09("59834", "inf09_p3", 6, pred)


def v09_p4():
    def pred(rows):
        k = 0
        for r in rows:
            mean = sum(r) / len(r)
            ce = sum(1 for x in r if x > mean and x % 2 == 0)
            co = sum(1 for x in r if x > mean and x % 2 == 1)
            se = sum(x for x in r if x % 2 == 0)
            so = sum(x for x in r if x % 2 == 1)
            if ce > co and se < so:
                k += 1
        return k
    v09("76677", "inf09_p4", 8, pred)


# ---------- inf22 ----------
def v22_p1():
    rows = xlsx_rows(raw_path("75286"))
    procs = {}
    for cells in rows[1:]:
        if len(cells) < 3 or cells[0] is None:
            continue
        pid = int(cells[0])
        dur = int(cells[1])
        dep = str(cells[2]).strip() if cells[2] is not None else "0"
        if dep in ("0", "0.0", ""):
            prov = []
        else:
            prov = [int(float(x)) for x in re.split(r"[,;]", dep) if x.strip() != ""]
        procs[pid] = (dur, prov)
    import heapq
    done: dict[int, int] = {}
    running: list[tuple[int, int]] = []  # (end, pid)
    queue: list[int] = []
    queued = set()
    t = 0
    remaining = set(procs)
    while remaining or running:
        for pid in sorted(remaining):
            dur, prov = procs[pid]
            if all(p in done and done[p] <= t for p in prov) and pid not in queued:
                queue.append(pid)
                queued.add(pid)
        queue.sort()
        while queue and len(running) < 3:
            pid = queue.pop(0)
            heapq.heappush(running, (t + procs[pid][0], pid))
            remaining.discard(pid)
        if running:
            t = running[0][0]
            while running and running[0][0] <= t:
                end, pid = heapq.heappop(running)
                done[pid] = end
        elif remaining:
            t += 1
    check("inf22_p1", max(done.values()), catalog_answer("inf22_p1"))


def v22_p2():
    rows = xlsx_rows(raw_path("81488")) if raw_path("81488").suffix == ".xlsx" \
        else ods_rows(raw_path("81488"))
    recs = []
    for cells in rows[1:]:
        if len(cells) < 2 or cells[0] is None:
            continue
        pid = int(float(cells[0]))
        dur = int(float(cells[1]))
        dep = "" if len(cells) < 3 or cells[2] is None else str(cells[2]).strip()
        if dep in ("0", "0.0", ""):
            prov = []
        else:
            prov = [int(float(x)) for x in re.split(r"[,;]", dep) if x.strip() != ""]
        recs.append((pid, dur, prov))
    end: dict[int, int] = {}
    start: dict[int, int] = {}
    for pid, dur, prov in sorted(recs):
        s = max([end[p] for p in prov], default=0)
        start[pid] = s
        end[pid] = s + dur
    # Школьное чтение диаграммы Ганта: вертикальная линия t=14 пересекает
    # бары как замкнутые отрезки [s, e] (процесс 20 идёт 9–14 и касается).
    at14 = sum(1 for pid in start if start[pid] <= 14 <= end[pid])
    check("inf22_p2", at14, catalog_answer("inf22_p2"))


def v22_p3():
    rows = xlsx_rows(raw_path("48470")) if raw_path("48470").suffix == ".xlsx" \
        else ods_rows(raw_path("48470"))
    recs = []
    for cells in rows[1:]:
        if len(cells) < 2 or cells[0] is None:
            continue
        pid = int(float(cells[0]))
        dur = int(float(cells[1]))
        dep = "" if len(cells) < 3 or cells[2] is None else str(cells[2]).strip()
        if dep in ("0", "0.0", ""):
            prov = []
        else:
            prov = [int(float(x)) for x in re.split(r"[,;]", dep) if x.strip() != ""]
        recs.append((pid, dur, prov))
    end: dict[int, int] = {}
    for pid, dur, prov in sorted(recs):
        end[pid] = dur + (5 + max(end[p] for p in prov) if prov else 0)
    check("inf22_p3", max(end.values()), catalog_answer("inf22_p3"))


def main() -> int:
    v17_p1()
    v17_p2()
    v17_p3()
    v17_p4()
    v17_p5()
    v24_p1()
    v24_p2()
    v24_p3()
    v24_p5()
    v26_p1()
    v26_p2()
    v26_p3()
    v27_p2()
    v27_p4()
    v27_p7()
    v09_p1()
    v09_p2()
    v09_p3()
    v09_p4()
    v22_p1()
    v22_p2()
    v22_p3()
    print("VERIFY " + ("OK" if not FAILS else f"FAILURES={FAILS}"))
    return 1 if FAILS else 0


if __name__ == "__main__":
    raise SystemExit(main())
