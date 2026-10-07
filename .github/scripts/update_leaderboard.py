"""Append one bake-off submission to its leaderboard.

Reads the issue body from the environment (never from the command line, so a
submission cannot inject shell), parses the GitHub issue-form sections, and
rewrites the leaderboard for the named bake-off.

Exits non-zero with a message on the first thing that looks wrong, so a
malformed submission fails the Action rather than corrupting the board.
"""
import base64
import binascii
import json
import os
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
BAKEOFFS = ROOT / "bakeoff"
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,40}$")
MAX_CODE = 20000
MAX_NAME = 60
MAX_FILES = 200000        # characters of the encoded Files field
FILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$")


def fail(msg):
    print(f"::error::{msg}")
    sys.exit(1)


def parse_form(body):
    """GitHub renders an issue form as '### Label\\n\\nvalue' blocks."""
    out, key, buf = {}, None, []
    for line in body.replace("\r\n", "\n").split("\n"):
        if line.startswith("### "):
            if key:
                out[key] = "\n".join(buf).strip()
            key, buf = line[4:].strip().lower(), []
        elif key:
            buf.append(line)
    if key:
        out[key] = "\n".join(buf).strip()
    return out


def number(fields, key, metric, required=True):
    # "test score" on the current form; "test mse" on issues opened before
    # the metric was configurable
    raw = fields.get(key + " score", fields.get(key + " mse", "")).strip()
    if raw in ("", "_No response_"):
        if required:
            fail(f"'{key} score' is missing.")
        return None
    try:
        v = float(raw)
    except ValueError:
        fail(f"'{key} score' is not a number: {raw!r}")
    bad = v < 0 if metric == "mse" else v > 1   # MSE >= 0, R^2 <= 1
    if v != v or v in (float("inf"), float("-inf")) or bad:
        fail(f"'{key} score' is not a usable {metric} score: {raw!r}")
    return v


def unfence(text):
    """The form renders textareas inside a ```lang fence; take it off."""
    fence = re.match(r"^```[a-zA-Z]*\n(.*)\n```$", text, re.S)
    return fence.group(1) if fence else text


def files_field(fields):
    """The uploaded files, as {name: {"text": ...} | {"b64": ...}}, or None."""
    raw = unfence(fields.get("files", "").strip()).strip()
    if raw in ("", "_No response_"):
        return None
    if len(raw) > MAX_FILES:
        fail(f"'files' is too long ({len(raw)} characters, limit {MAX_FILES}).")
    try:
        files = json.loads(raw)
    except json.JSONDecodeError as e:
        fail(f"'files' is not valid JSON: {e}")
    if not isinstance(files, dict):
        fail("'files' must be a JSON object of name -> contents.")
    for name, body in files.items():
        if not FILE_RE.match(name):
            fail(f"'files' has a bad file name: {name!r}")
        if not (isinstance(body, dict) and len(body) == 1 and
                isinstance(body.get("text", body.get("b64")), str)):
            fail(f"'files' entry {name!r} must be {{\"text\": ...}} or {{\"b64\": ...}}.")
        if "b64" in body:
            try:
                base64.b64decode(body["b64"], validate=True)
            except binascii.Error:
                fail(f"'files' entry {name!r} is not valid base64.")
    return files


def main():
    body = os.environ.get("ISSUE_BODY", "")
    author = os.environ.get("ISSUE_USER", "")
    issue = os.environ.get("ISSUE_NUMBER", "")
    if not body.strip():
        fail("The issue body is empty.")

    f = parse_form(body)

    slug = f.get("bake-off", "").strip()
    if not SLUG_RE.match(slug):
        fail(f"'bake-off' is not a valid slug: {slug!r}")
    board_path = BAKEOFFS / slug / "leaderboard.json"
    if not board_path.exists():
        fail(f"No such bake-off: {slug!r} (expected {board_path.relative_to(ROOT)})")

    cfg = json.loads((BAKEOFFS / slug / "config.json").read_text())
    metric = cfg.get("metric", "mse")
    if metric not in ("mse", "r2"):
        fail(f"{slug}/config.json has an unknown metric: {metric!r}")
    higher = metric == "r2"
    label = "R²" if higher else "MSE"

    name = " ".join(f.get("name", "").split())[:MAX_NAME]
    if not name:
        fail("'name' is missing.")

    code = unfence(f.get("code", ""))
    if not code.strip():
        fail("'code' is missing.")
    if len(code) > MAX_CODE:
        fail(f"'code' is too long ({len(code)} characters, limit {MAX_CODE}).")

    entry = {
        "name": name,
        "test_score": number(f, "test", metric),
        "train_score": number(f, "train", metric, required=False),
        "code": code,
        "files": files_field(f),
        "github_user": author,
        "issue": int(issue) if issue.isdigit() else None,
    }

    board = json.loads(board_path.read_text())
    board["metric"] = metric          # read by the directory page
    entries = board.setdefault("entries", [])

    # one entry per person: a resubmission replaces the old row
    entries[:] = [e for e in entries if e.get("issue") != entry["issue"]]
    prev = next((e for e in entries if e.get("github_user")
                 and e["github_user"] == author), None)
    if prev:
        entries.remove(prev)
        print(f"replacing earlier entry from @{author} "
              f"(was {prev.get('test_score', prev.get('test_mse'))})")

    entries.append(entry)
    def score(e):
        return e.get("test_score", e.get("test_mse"))
    entries.sort(key=score, reverse=higher)
    board_path.write_text(json.dumps(board, indent=2) + "\n")

    rank = entries.index(entry) + 1
    print(f"{name}: test {label} {entry['test_score']:.4g}, rank {rank} of {len(entries)}")
    with open(os.environ.get("GITHUB_OUTPUT", os.devnull), "a") as fh:
        fh.write(f"summary={name} scored {label} {entry['test_score']:.4g} "
                 f"— rank {rank} of {len(entries)}\n")


if __name__ == "__main__":
    main()
