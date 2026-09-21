# Bake-offs

A bake-off gives students a training set and a test set. They write a model,
submit it, and it is scored against both.

## Layout

    bakeoff/
      index.html      directory page, reads bakeoffs.json
      engine.js       shared scorer: builds the UI, runs Pyodide, renders the board
      bakeoff.css     shared styles
      bakeoffs.json   the list of bake-offs
      <slug>/
        index.html        stub, ~20 lines, loads ../engine.js
        config.json       everything specific to this bake-off
        leaderboard.json  official board, committed by the instructor
        data/train.csv
        data/test.csv

Nothing about a bake-off lives in shared code. The engine reads `config.json`
from whatever directory it is loaded in, so each bake-off is self-contained and
its data never mixes with another's.

## Adding a bake-off

1. `cp -r heat-capacity <new-slug>` and replace the two CSVs.
2. Edit `<new-slug>/config.json` (see the fields below).
3. Reset `<new-slug>/leaderboard.json` to `{"entries": []}` plus a baseline.
4. Add one entry to `bakeoffs.json`.

No code changes. The stub `index.html` is copied unmodified.

## config.json

| field | meaning |
|---|---|
| `title`, `subtitle` | page headings |
| `function_name` | what the student must define, e.g. `f` |
| `features` | CSV column(s) passed to the function, e.g. `["T"]` |
| `target` | CSV column being predicted, e.g. `"C"` |
| `data.train`, `data.test` | paths relative to the bake-off folder |
| `baseline.mse` | the number on the board; omit for no baseline |
| `baseline.label` | how the baseline is named on the leaderboard |
| `blurb`, `rules` | intro text and the rules list (HTML allowed) |
| `starter` | the code pre-filled in the textarea |
| `expose_training_data` | default `false`; `true` hands the training arrays to submitted code |

With one feature the student's function receives a 1-D array; with several it
receives an `(N x d)` array. Inside the box they get `np` and nothing else: the
page is for reporting a fitted model, not for building one, so the training data
is deliberately out of reach. Set `expose_training_data: true` in a bake-off's
config if you want `X_train`/`y_train` and the aliases named after the columns
(`T_train`, `C_train`, ...) handed to submitted code instead.

## Leaderboard

Automatic. A student presses **Submit to leaderboard**, GitHub opens with a
pre-filled submission issue, they press **Create**, and
`.github/workflows/bakeoff-leaderboard.yml` parses it, appends to that
bake-off's `leaderboard.json`, commits, comments the rank, and closes the
issue. Nobody approves anything. The board is live once Pages rebuilds.

Resubmitting replaces your earlier row rather than adding a second one, matched
on GitHub username.

Two repo settings have to be right, both org-owner only:

- Actions enabled for the repo.
- A label called `bakeoff` must exist in the repo. GitHub silently drops
  labels an issue template asks for but the repo does not have, which would
  otherwise make every submission skip the job.
- Settings -> Actions -> General -> Workflow permissions set to **Read and
  write**, or the job cannot commit the board.

`config.json` names the target repo under `submit.repo`, so a bake-off can point
somewhere else if it ever needs to. A malformed submission fails the Action, is
explained in a comment on the issue, and leaves the board untouched; editing the
issue retries it.

Anyone with a GitHub account can open a submission issue, so the board is open
to the internet in principle. Delete a row from `leaderboard.json` to remove it.

## Note on honesty

Scoring happens in the student's browser, so the test labels are downloadable
and the submitted score is client-side. The blob carries their code: re-run the
top entries to check. If a future bake-off needs a genuinely hidden test set,
the labels have to move off GitHub Pages, which cannot keep a secret.
