#!/usr/bin/env python3
"""Нормализация сырых TeX-фрагментов в импортированных заданиях профиля.

Источник кладёт в alt формул то словесное описание, то сырой TeX
(\\overrightarrowa, \\cap, \\tfrac 15). Сырой TeX plain-текстом ученику —
мусор с бэкслешами. Детерминировано меняем команды на символы/слова.

Трогаем ТОЛЬКО задания с sourceId sdamgia-*: у официальных демо/банка
LaTeX в \\(...\\) осознанный, его рендерит KaTeX.

    python3 tools/normalize_math_tex.py --analyze
    python3 tools/normalize_math_tex.py
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "server" / "catalog.json"

# Точный регистр TeX-команд важен — словарь как есть.
SYMBOLS = {
    "approx": "≈", "cap": "∩", "cup": "∪", "cdot": "·", "times": "×",
    "ast": "*", "star": "★", "le": "≤", "ge": "≥", "ne": "≠", "pm": "±",
    "mp": "∓", "pi": "π", "infty": "∞", "in": "∈", "notin": "∉",
    "subset": "⊂", "supset": "⊃", "subseteq": "⊆", "supseteq": "⊇",
    "emptyset": "∅", "varnothing": "∅", "angle": "∠", "circ": "°",
    "degree": "°", "prime": "′", "forall": "∀", "exists": "∃",
    "Rightarrow": "⇒", "Leftarrow": "⇐", "Leftrightarrow": "⇔",
    "rightarrow": "→", "leftarrow": "←", "leftrightarrow": "↔",
    "mapsto": "↦", "equiv": "≡", "cong": "≅", "sim": "∼", "simeq": "≃",
    "propto": "∝", "perp": "⊥", "parallel": "∥", "mid": "|", "div": "÷",
    "oplus": "⊕", "otimes": "⊗", "odot": "⊙", "sum": "Σ", "prod": "Π",
    "int": "∫", "partial": "∂", "nabla": "∇", "aleph": "ℵ", "ell": "ℓ", "wp": "℘",
    "Re": "Re", "Im": "Im", "colon": ":", "ldots": "…", "cdots": "⋯",
    "vdots": "⋮", "ddots": "⋱", "surd": "√",
    "alpha": "α", "beta": "β", "gamma": "γ", "delta": "δ",
    "varepsilon": "ε", "epsilon": "ε", "zeta": "ζ", "eta": "η",
    "vartheta": "θ", "theta": "θ", "iota": "ι", "kappa": "κ",
    "lambda": "λ", "mu": "μ", "nu": "ν", "xi": "ξ",
    "rho": "ρ", "sigma": "σ", "tau": "τ", "upsilon": "υ",
    "varphi": "φ", "phi": "φ", "chi": "χ", "psi": "ψ", "omega": "ω",
    "Gamma": "Γ", "Delta": "Δ", "Theta": "Θ", "Lambda": "Λ", "Xi": "Ξ",
    "Pi": "Π", "Sigma": "Σ", "Phi": "Φ", "Psi": "Ψ", "Omega": "Ω",
}
WORDS = {
    "log": "log", "ln": "ln", "lg": "lg", "sin": "sin", "cos": "cos",
    "tan": "tan", "tg": "tg", "cot": "cot", "ctg": "ctg", "sec": "sec",
    "csc": "csc", "sinh": "sinh", "cosh": "cosh", "tanh": "tanh",
    "arcsin": "arcsin", "arccos": "arccos", "arctan": "arctan",
    "arctg": "arctg", "arcctg": "arcctg", "arccot": "arccot",
    "lim": "lim", "max": "max", "min": "min", "sup": "sup", "inf": "inf",
    "det": "det", "exp": "exp", "arg": "arg", "deg": "deg", "dim": "dim",
}
LEFT: list[tuple[re.Pattern, str]] = [
    # Конструкции с аргументами — первыми.
    (re.compile(r"\\tfrac\{([^}]*)\}\{([^}]*)\}"), r"(\1)/(\2)"),
    (re.compile(r"\\tfrac\s*([^\s])\s+([^\s]+)"), r"\1/\2"),
    (re.compile(r"\\tfrac\s*(\S)(\S)"), r"\1/\2"),
    (re.compile(r"\\[dc]frac([a-z])([a-z])(?![a-z])"), r"\1/\2"),
    (re.compile(r"\\[dc]frac([A-Za-z]+)"), ""),
    (re.compile(r"\\[dc]frac(?![a-zA-Z{])"), ""),
    (re.compile(r"\\leqslqnt(?![a-zA-Z])"), "≤"),
    (re.compile(r"\\angle([A-Z][A-Z0-9_]*)"), r"угол \1"),
    (re.compile(r"\\(?:algle|angke)(?![a-zA-Z])"), "угол"),
    (re.compile(r"\\a(?![a-zA-Z])"), "a"),
    (re.compile(r"\\abs\{([^}]*)\}"), r"|\1|"),
    (re.compile(r"\\abs([a-z])"), r"|\1|"),
    (re.compile(r"\\abs(?![a-zA-Z])"), "|"),
    (re.compile(r"\\bot([A-Z]+)"), r"⊥\1"),
    (re.compile(r"\\bot(?![a-zA-Z])"), "⊥"),
    (re.compile(r"\\perp([A-Z]+)"), r"⊥\1"),
    (re.compile(r"\\mathbb\s*([A-Za-z])"), r"\1"),
    (re.compile(r"\\mathbb(?![a-zA-Z])"), ""),
    (re.compile(r"\\textrm([а-яА-ЯёЁ]+)"), r"\1"),
    (re.compile(r"\\textrm(?![a-zA-Z])"), ""),
    (re.compile(r"\\mathrm(?![a-zA-Z])"), ""),
    (re.compile(r"\\mathcal\s*([A-Za-z])"), r"\1"),
    (re.compile(r"\\mathcal(?![a-zA-Z])"), ""),
    (re.compile(r"\\begin([a-z]+)"), ""),
    (re.compile(r"\\end([a-z]+)"), ""),
    (re.compile(r"\\not="), "≠"),
    (re.compile(r"\\setminus(?![a-zA-Z])"), "∖"),
    (re.compile(r"\\sgn(?![a-zA-Z])"), "sgn"),
    (re.compile(r"\\thinspace(?![a-zA-Z])"), " "),
    (re.compile(r"\\nbsp(?![a-zA-Z{])"), " "),
    (re.compile(r"\\to(?![a-zA-Z])"), "→"),
    (re.compile(r"\\dots(?![a-zA-Z])"), "…"),
    (re.compile(r"\\c[do][od][dt](?![a-zA-Z])"), "·"),
    (re.compile(r"\\(?:mathop|operatorname|mathclap)(?![a-zA-Z])"), ""),
    (re.compile(r"\\[dc]frac(?![a-zA-Z{])"), ""),
    (re.compile(r"\\vec\s*([a-zA-Z])"), r"вектор \1"),
    (re.compile(r"\\vec(?![a-zA-Z])"), "вектор"),
    (re.compile(r"\\overline\s*([A-Za-zА-Яа-яёЁ])"), r"\1"),
    (re.compile(r"\\overline([A-Za-zА-Яа-яёЁ]+)"), r"\1"),
    (re.compile(r"\\overline(?![a-zA-Z])"), ""),
    (re.compile(r"\\widehat([A-Z]+)"), r"угол \1"),
    (re.compile(r"\\widehat(?![a-zA-Z])"), ""),
    (re.compile(r"\\smile([A-Z]*)"), r"⌣\1"),
    (re.compile(r"\\frown([A-Z]*)"), r"⌢\1"),
    (re.compile(r"\\overset([A-Z]{2})"), r"|\1|"),
    (re.compile(r"\\overset(?![a-zA-Z])"), ""),
    (re.compile(r"\\mathbb\s*([A-Za-z])"), r"\1"),
    (re.compile(r"\\mathbb(?![a-zA-Z])"), ""),
    (re.compile(r"\\textrm([а-яА-ЯёЁ]+)"), r"\1"),
    (re.compile(r"\\textrm(?![a-zA-Z])"), ""),
    (re.compile(r"\\geqslant(?![a-zA-Z])"), "≥"),
    (re.compile(r"\\leqslant(?![a-zA-Z])"), "≤"),
    (re.compile(r"\\(?:d|c)?frac\s*\{\s*([^}]*)\}\s*\{\s*([^}]*)\}"), r"(\1)/(\2)"),
    (re.compile(r"\\sqrt\[([^\]]*)\]\{([^}]*)\}"), r"корень \1 из \2"),
    (re.compile(r"\\sqrt\{([^}]*)\}"), r"√(\1)"),
    (re.compile(r"\\sqrt(?![a-zA-Z])"), "√"),
    (re.compile(r"\\binom\{([^}]*)\}\{([^}]*)\}"), r"(\1;\2)"),
    (re.compile(r"\\(?:text|textrm|mathrm|mathbf|mathit|mathsf|mbox|boxed)\{([^}]*)\}"), r"\1"),
    (re.compile(r"\\overline\{([^}]*)\}"), r"\1"),
    (re.compile(r"\\underline\{([^}]*)\}"), r"\1"),
    (re.compile(r"\\over(?:rightarrow|leftarrow)\{([^}]*)\}"), r"вектор \1"),
    (re.compile(r"\\over(?:rightarrow|leftarrow)([a-zA-Z]+)"), r"вектор \1"),
    (re.compile(r"\\vec\{([^}]*)\}"), r"вектор \1"),
    (re.compile(r"\\vec([a-zA-Z])"), r"вектор \1"),
    (re.compile(r"\\(?:bar|dot|ddot|tilde|widetilde|hat|widehat|check|breve|acute|grave|mathring|cancel)\{([^}]*)\}"), r"\1"),
    (re.compile(r"\\begin\{[^}]*\}"), ""),
    (re.compile(r"\\end\{[^}]*\}"), ""),
    (re.compile(r"\\(?:left|right|big|Big|bigg|Bigg|displaystyle|limits|tag|label|mathop|underset|underbrace|overbrace|color\{[^}]*\})"), ""),
    (re.compile(r"\\(?:quad|qquad|enspace)"), " "),
    (re.compile(r"\\[\\,]"), " "),
    (re.compile(r"\\([,:;! ])"), r"\1"),
    (re.compile(r"\\([{}%$&#_])"), r"\1"),
    (re.compile(r"\\_"), "_"),
    (re.compile(r"\\/"), ""),
    # Остатки скобочных групп TeX после неудачного разбора: в обычном
    # русском тексте фигурных скобок не бывает.
    # Незакрытый \dfrac{... (SRE роняет вторую группу): словами как везде.
    (re.compile(r"\\[dc]?frac\s*\{"), "(дробь: "),
    (re.compile(r"\{"), "("),
    (re.compile(r"\}"), ")"),
]

UNKNOWN_RE = re.compile(r"\\([a-zA-Z]+)")


def normalize(text: str, unknown: set[str] | None = None) -> str:
    out = text or ""
    for rx, rep in LEFT:
        out = rx.sub(rep, out)
    for cmd, sym in {**SYMBOLS, **WORDS}.items():
        out = re.sub(r"\\" + cmd + r"(?![a-zA-Z])", sym, out)
    for m in UNKNOWN_RE.finditer(out):
        if unknown is not None:
            unknown.add(m.group(1))
    out = re.sub(r"[ \t]+", " ", out)
    out = re.sub(r"\(\s*", "(", out)
    out = re.sub(r"(\d)вектор", r"\1 вектор", out)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--analyze", action="store_true")
    args = ap.parse_args()

    data = json.loads(CATALOG.read_text(encoding="utf-8"))
    unknown: set[str] = set()
    touched = 0
    for t in data["tasks"]:
        if not (t.get("sourceId") or "").startswith("sdamgia-"):
            continue
        changed = False
        for field in ("text", "solution", "hint"):
            new = normalize(t.get(field) or "", unknown)
            if new != (t.get(field) or ""):
                changed = True
                if not args.analyze:
                    t[field] = new
        hints = t.get("hints")
        if isinstance(hints, list):
            new_hints = [normalize(h, unknown) for h in hints]
            if new_hints != hints:
                changed = True
                if not args.analyze:
                    t["hints"] = new_hints
        if changed:
            touched += 1

    print(f"заданий с сырым TeX затронуто: {touched}")
    left = sorted(unknown)
    print(f"неизвестных команд: {len(left)} {left[:20]}")
    if args.analyze:
        return 0
    CATALOG.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print("записано")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
