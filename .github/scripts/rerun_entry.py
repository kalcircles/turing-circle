"""Re-run a leaderboard entry locally and compare with the score it reported.

    python .github/scripts/rerun_entry.py student-grade          # every entry
    python .github/scripts/rerun_entry.py student-grade 1        # rank 1
    python .github/scripts/rerun_entry.py student-grade someuser # by GitHub user

Scores are computed in the student's browser, so this is how to check one.
The entry's uploaded files are written to a temporary folder that becomes the
working directory, exactly as on the page. Needs numpy. It runs the
submitted code, so it runs whatever a student wrote: read it first.
"""
import base64
import contextlib
import csv
import json
import os
import pathlib
import sys
import tempfile

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[2] / "bakeoff"


def load(path, cfg):
    rows = list(csv.DictReader(open(path)))

    def cell(v):
        try:
            n = float(v)
        except ValueError:
            return v.strip()
        return int(n) if n.is_integer() else n

    rows = [{k.strip(): cell(v) for k, v in r.items()} for r in rows]
    target = cfg["target"]
    y = np.array([float(r[target]) for r in rows])
    feats = cfg.get("features") or [c for c in rows[0] if c != target]
    if cfg.get("input") == "dict":
        return [{f: r[f] for f in feats} for r in rows], y
    X = np.array([[float(r[f]) for f in feats] for r in rows])
    return (X[:, 0] if len(feats) == 1 else X), y


def predict(f, X):
    if isinstance(X, list):
        return np.array([float(np.asarray(f(dict(r)), dtype=float).ravel()[0]) for r in X])
    try:
        out = np.asarray(f(X), dtype=float).ravel()
        if out.shape == (len(X),):
            return out
    except Exception:
        pass
    return np.array([float(f(float(v) if X.ndim == 1 else v)) for v in X])


def score(cfg, p, y):
    sse = float(np.sum((p - y) ** 2))
    if cfg.get("metric") == "r2":
        return 1.0 - sse / float(np.sum((y - y.mean()) ** 2))
    return sse / len(y)


def rerun(slug, entry, cfg):
    base = ROOT / slug
    Xtr, ytr = load(base / cfg["data"]["train"], cfg)
    Xte, yte = load(base / cfg["data"]["test"], cfg)
    with tempfile.TemporaryDirectory() as tmp:
        for name, body in (entry.get("files") or {}).items():
            data = (body["text"].encode() if "text" in body
                    else base64.b64decode(body["b64"]))
            (pathlib.Path(tmp) / pathlib.Path(name).name).write_bytes(data)
        sys.path.insert(0, tmp)
        try:
            with contextlib.chdir(tmp):
                ns = {"np": np, "numpy": np, "__name__": "__main__"}
                exec(entry["code"], ns)
                f = ns[cfg.get("function_name", "f")]
                tr = score(cfg, predict(f, Xtr), ytr)
                te = score(cfg, predict(f, Xte), yte)
        finally:
            sys.path.remove(tmp)
    reported = entry.get("test_score", entry.get("test_mse"))
    ok = abs(te - reported) <= 1e-6 * max(1.0, abs(te))
    print(f"{entry['name']:30s} reported {reported:.6g}  "
          f"re-run train {tr:.6g} test {te:.6g}  {'OK' if ok else 'MISMATCH'}")


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    slug, which = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else None)
    cfg = json.loads((ROOT / slug / "config.json").read_text())
    entries = sorted(json.loads((ROOT / slug / "leaderboard.json").read_text())
                     .get("entries", []), key=lambda e: e.get("test_score", e.get("test_mse")),
                     reverse=cfg.get("metric") == "r2")
    if which and which.isdigit():
        entries = entries[int(which) - 1:int(which)]
    elif which:
        entries = [e for e in entries if e.get("github_user") == which]
    if not entries:
        sys.exit("No matching entries.")
    for e in entries:
        try:
            rerun(slug, e, cfg)
        except Exception as err:
            print(f"{e['name']:30s} failed to re-run: {err!r}")


if __name__ == "__main__":
    main()
