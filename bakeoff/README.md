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
3. Reset `<new-slug>/leaderboard.json` to `{"entries": []}` plus a baseline
   and, for anything but MSE, the `metric`.
4. Add one entry to `bakeoffs.json`.

No code changes. The stub `index.html` is copied unmodified.

## config.json

| field | meaning |
|---|---|
| `title`, `subtitle` | page headings |
| `function_name` | what the student must define, e.g. `f` |
| `features` | CSV column(s) passed to the function, e.g. `["T"]`; with `input: "dict"`, `[]` means every column but the target |
| `input` | omit for arrays (below); `"dict"` calls the function once per row with a dict keyed by column name, categorical cells as strings |
| `arg_name` | how the argument is named on the page, e.g. `student`; defaults to the feature names |
| `uploads` | omit for paste-only; `{"max_kb": 100}` adds a file upload (see below) |
| `target` | CSV column being predicted, e.g. `"C"` |
| `data.train`, `data.test` | paths relative to the bake-off folder |
| `metric` | `"mse"` (default, lower is better) or `"r2"` (higher is better); put the same value in `leaderboard.json` as `"metric"` |
| `baseline.score` | the number on the board, in the bake-off's metric; omit for no baseline (`baseline.mse` still works) |
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

## Metrics

`mse` is the mean squared error on each set. `r2` is the usual coefficient of
determination, as sklearn's `r2_score`: `1 - SS_res / SS_tot`, with `SS_tot`
taken about the mean of the set being scored. So a constant prediction at the
*training* mean scores exactly 0 on train and slightly below 0 on test. Boards
sort best-first either way; entries store `test_score` and `train_score`.

## Uploads

With `uploads` set, the page takes files as well as pasted code: typically a
`model.py` defining the scored function, plus the fitted weights it reads
(`weights.npy`, a `.json` of column choices, ...). Pages is static, so nothing
leaves the browser until submission:

- The `.py` that defines `function_name` is loaded into the editor (still
  editable). Every other file is written into Pyodide's in-memory filesystem,
  in a folder that is the working directory and on `sys.path`, so
  `np.load("weights.npy")` and `import helpers` both work.
- On submission the files ride along in the issue's **Files** field as JSON,
  `{"name": {"text": ...}}` or `{"name": {"b64": ...}}` for binary files, and
  the Action stores them in the entry next to the code. If the whole thing is
  too long for a link (~7000 characters) the page shows the Files text to
  paste by hand.

`max_kb` caps the total upload. A linear model's weights are a few hundred
bytes; the cap is there so nobody pastes a 5 MB blob into an issue.

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
and the submitted score is client-side. Each entry carries its code and uploaded
files, so re-run the top entries to check:

    python .github/scripts/rerun_entry.py student-grade      # every entry
    python .github/scripts/rerun_entry.py student-grade 1    # just rank 1

It executes the submitted code on your machine, so read it first. If a future bake-off needs a genuinely hidden test set,
the labels have to move off GitHub Pages, which cannot keep a secret.
