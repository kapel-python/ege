#!/usr/bin/env python3
"""Сверка оборванных условий банка с живыми страницами сдамгии.
На выход: tools/out/cutcheck.json — для каждого кандидата живой текст
условия (с alt-подстановкой формул) + список картинок условия (tex/get_file).
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sdamgia_import as S

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "tools" / "out" / "cutcheck.json"

RX = re.compile(r'\s(как|равно|равна|равен|равны|равное|и|или|с|в|на|к|от|до|при|по|из|у|о|об|а|но|если|когда|пусть|найдите|докажите|определите|является|равняется)\s*$|: *$|\($|= *$|,\s*$', re.I)


def main() -> int:
    data = json.loads((ROOT / "server" / "catalog.json").read_text(encoding="utf-8"))
    cands = []
    for t in data["tasks"]:
        tx = (t.get("text") or "").strip()
        if RX.search(tx):
            cands.append(t)
    print(f"кандидатов: {len(cands)}")
    base = S.SUBJECTS["math"]
    out = []
    for n, t in enumerate(cands):
        pid = (t.get("sourceId") or "").replace("sdamgia-", "")
        rec = {"id": t["id"], "src_id": pid, "bank": (t.get("text") or "")[-120:],
               "visual": (t.get("visual") or {}).get("assetId"), "live": None, "imgs": [], "error": None}
        if not pid:
            rec["error"] = "no-source"
            out.append(rec)
            continue
        try:
            page = S.get(base, f"/problem?id={pid}")
            anchor = S.SOL_ANCHOR_RE.search(page)
            head = page[:anchor.start()] if anchor else page
            m = re.search(r'id="body\d+"[^>]*class="pbody"[^>]*>', head)
            seg = head[m.end():] if m else head
            tags = re.findall(r"<img\b[^>]*>", seg)
            for tag in tags:
                src = (re.search(r'src="([^"]*)"', tag) or [None, ""])[1]
                alt = (re.search(r'alt="([^"]*)"', tag) or [None, ""])[1]
                kind = "tex" if ('class="tex"' in tag or "/formula/" in src) else ("fig" if "get_file" in src else "other")
                rec["imgs"].append({"kind": kind, "alt": alt[:120]})
            raw = S.sub_formula_alt(seg)
            rec["live"] = S.strip_markup(raw)[-400:]
        except Exception as exc:  # noqa: BLE001
            rec["error"] = str(exc)[:120]
        out.append(rec)
        if (n + 1) % 25 == 0:
            print(f"  ... {n + 1}/{len(cands)}", flush=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print("written", OUT)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
