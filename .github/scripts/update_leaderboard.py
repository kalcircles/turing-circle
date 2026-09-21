"""Append one bake-off submission to its leaderboard.

Reads the issue body from the environment (never from the command line, so a
submission cannot inject shell), parses the GitHub issue-form sections, and
rewrites the leaderboard for the named bake-off.

Exits non-zero with a message on the first thing that looks wrong, so a
malformed submission fails the Action rather than corrupting the board.
"""
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


def number(fields, key, required=True):
    raw = fields.get(key, "").strip()
    if raw in ("", "_No response_"):
        if required:
            fail(f"'{key}' is missing.")
        return None
    try:
        v = float(raw)
    except ValueError:
        fail(f"'{key}' is not a number: {raw!r}")
    if v != v or v in (float("inf"), float("-inf")) or v < 0:
        fail(f"'{key}' is not a usable score: {raw!r}")
    return v


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

    name = " ".join(f.get("name", "").split())[:MAX_NAME]
    if not name:
        fail("'name' is missing.")

    code = f.get("code", "")
    # the form renders the textarea inside a ```python fence
    fence = re.match(r"^```[a-zA-Z]*\n(.*)\n```$", code, re.S)
    if fence:
        code = fence.group(1)
    if not code.strip():
        fail("'code' is missing.")
    if len(code) > MAX_CODE:
        fail(f"'code' is too long ({len(code)} characters, limit {MAX_CODE}).")

    entry = {
        "name": name,
        "test_mse": number(f, "test mse"),
        "train_mse": number(f, "train mse", required=False),
        "code": code,
        "github_user": author,
        "issue": int(issue) if issue.isdigit() else None,
    }

    board = json.loads(board_path.read_text())
    entries = board.setdefault("entries", [])

    # one entry per person: a resubmission replaces the old row
    entries[:] = [e for e in entries if e.get("issue") != entry["issue"]]
    prev = next((e for e in entries if e.get("github_user")
                 and e["github_user"] == author), None)
    if prev:
        entries.remove(prev)
        print(f"replacing earlier entry from @{author} "
              f"(was {prev.get('test_mse')})")

    entries.append(entry)
    entries.sort(key=lambda e: e["test_mse"])
    board_path.write_text(json.dumps(board, indent=2) + "\n")

    rank = entries.index(entry) + 1
    print(f"{name}: test MSE {entry['test_mse']:.4g}, rank {rank} of {len(entries)}")
    with open(os.environ.get("GITHUB_OUTPUT", os.devnull), "a") as fh:
        fh.write(f"summary={name} scored {entry['test_mse']:.4g} "
                 f"— rank {rank} of {len(entries)}\n")


if __name__ == "__main__":
    main()
