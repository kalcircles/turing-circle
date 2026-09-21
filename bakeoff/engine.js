/* Shared bake-off engine.
 *
 * Drop this into any bake-off folder via a stub index.html. The engine reads
 * config.json from its OWN directory, so each bake-off is self-contained:
 *
 *   bakeoff/
 *     engine.js  bakeoff.css  index.html  bakeoffs.json
 *     <slug>/
 *       index.html       <- stub, loads ../engine.js
 *       config.json      <- everything specific to this bake-off
 *       leaderboard.json <- official board, committed by the instructor
 *       data/train.csv  data/test.csv
 *
 * Adding a bake-off means copying the stub, writing config.json, dropping in
 * the data, and adding one line to bakeoffs.json. No code changes.
 */
(function () {
  "use strict";

  var cfg = null, pyodide = null, DATA = null, lastResult = null;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  };

  /* ---- CSV -------------------------------------------------------------- */

  function parseCSV(text) {
    var lines = text.trim().split(/\r?\n/);
    var head = lines[0].split(",").map(function (h) { return h.trim(); });
    var rows = [];
    for (var i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      var parts = lines[i].split(",");
      var row = {};
      for (var j = 0; j < head.length; j++) row[head[j]] = parseFloat(parts[j]);
      rows.push(row);
    }
    return { head: head, rows: rows };
  }

  // Pull the configured feature columns and target out of a parsed CSV.
  // One feature -> a flat array. Several -> an array of rows.
  function extract(csv, features, target) {
    var missing = features.concat(target).filter(function (c) {
      return csv.head.indexOf(c) === -1;
    });
    if (missing.length) {
      throw new Error("Column(s) missing from the data file: " + missing.join(", ") +
                      ". Found: " + csv.head.join(", "));
    }
    var X = csv.rows.map(function (r) {
      return features.length === 1 ? r[features[0]] : features.map(function (f) { return r[f]; });
    });
    var y = csv.rows.map(function (r) { return r[target]; });
    return { X: X, y: y };
  }

  /* ---- Python harness ---------------------------------------------------
   * Kept separate from student code so a broken f() cannot break the scorer.
   * Generic in the number of features: one feature gives f a 1-D array,
   * several give it an (N x d) array.
   */
  var HARNESS = [
    "import numpy as np",
    "class _NoneReturn(Exception):",
    "    pass",
    "def _mse(a, b):",
    "    return float(np.mean((np.asarray(a, dtype=float) - np.asarray(b, dtype=float)) ** 2))",
    "def _apply(f, X):",
    "    n = X.shape[0]",
    "    try:",
    "        raw = f(X)",
    "        if raw is None:",
    "            raise _NoneReturn()",
    "        out = np.asarray(raw, dtype=float).ravel()",
    "        if out.shape == (n,):",
    "            return out",
    "    except _NoneReturn:",
    "        raise",
    "    except Exception:",
    "        pass",
    "    vals = [f(float(v)) for v in X] if X.ndim == 1 else [f(row) for row in X]",
    "    if any(v is None for v in vals):",
    "        raise _NoneReturn()",
    "    return np.array([float(v) for v in vals], dtype=float)",
    "def _run(code, fname, names, X_train, y_train, X_test, y_test, expose):",
    "    ns = {'np': np, 'numpy': np}",
    "    if expose:",
    "        ns['X_train'], ns['y_train'] = X_train, y_train",
    "        for i, nm in enumerate(names[0]):",
    "            ns[nm + '_train'] = X_train if X_train.ndim == 1 else X_train[:, i]",
    "        ns[names[1] + '_train'] = y_train",
    "    exec(code, ns)",
    "    if fname not in ns or not callable(ns[fname]):",
    "        raise ValueError('Your code must define a function called ' + fname +",
    "                         ', e.g.  def ' + fname + '(...): ...')",
    "    f = ns[fname]",
    "    try:",
    "        p_tr, p_te = _apply(f, X_train), _apply(f, X_test)",
    "    except _NoneReturn:",
    "        raise ValueError(fname + ' returned None, so there is nothing to score yet. Write your model in place of the \\'return None\\' line - there is a commented-out example just above it.')",
    "    if not (np.all(np.isfinite(p_tr)) and np.all(np.isfinite(p_te))):",
    "        raise ValueError('Your function returned inf or nan. Check for division by zero or overflow.')",
    "    return [_mse(p_tr, y_train), _mse(p_te, y_test)]"
  ].join("\n");

  /* ---- UI ---------------------------------------------------------------- */

  function shell() {
    var fname = cfg.function_name || "f";
    var args = (cfg.features || ["x"]).join(", ");
    var rules = (cfg.rules || []).map(function (r) { return "<li>" + r + "</li>"; }).join("");

    document.body.innerHTML =
      '<header class="site-title">' +
        '<h1>' + esc(cfg.title) + '</h1>' +
        '<p>' + esc(cfg.subtitle || "") + '</p>' +
      '</header>' +
      '<div class="tool">' +
        '<p><a href="../">&larr; all bake-offs</a></p>' +
        '<p>' + (cfg.blurb || "") + ' Everything runs in your own browser &mdash; ' +
          'nothing is uploaded until you choose to submit.</p>' +
        (rules ? '<div class="rules"><strong>The rules that matter here</strong><ol>' + rules + '</ol></div>' : '') +

        '<h2>Score your model</h2>' +

        '<div class="step"><h3><span class="num">1</span>Your name</h3>' +
          '<input type="text" id="name" placeholder="e.g. Ada Lovelace" autocomplete="name"></div>' +

        '<div class="step"><h3><span class="num">2</span>Your function</h3>' +
          '<p class="hint">Define <code>' + esc(fname) + '(' + esc(args) + ')</code>, ' +
            'already fitted: this page reports a model, it is not where you build one. ' +
            'Do the fitting in your own notebook and paste the finished function in, with ' +
            'its numbers written out. <code>np</code> (numpy) is available; the training ' +
            'data is not. Only <code>' + esc(fname) + '</code> is called, so define as many ' +
            'other functions as you like.</p>' +
          '<textarea id="code" spellcheck="false"></textarea>' +
          '<p class="status" id="pystatus">Loading Python&hellip;</p></div>' +

        '<div class="step"><h3><span class="num">3</span>Score</h3>' +
          '<button id="run" disabled>Score and submit</button>' +
          '<p class="status" id="runstatus"></p><div class="error" id="err"></div>' +
          '<div class="result" id="result">' +
            '<div class="scores">' +
              '<div class="score"><div class="k">Train MSE</div><div class="v" id="mtrain">&mdash;</div></div>' +
              '<div class="score"><div class="k">Test MSE</div><div class="v" id="mtest">&mdash;</div></div>' +
            '</div>' +
            '<p class="hint" id="subhint"></p>' +
          '</div></div>' +

        '<h2>Leaderboard</h2>' +
        '<p class="hint">Updates automatically a minute or so after a submission.</p>' +
        '<table id="board"><thead><tr><th>#</th><th>Name</th>' +
          '<th class="num">Test MSE</th>' +
        '</tr></thead><tbody></tbody></table>' +
      '</div>';

    $("code").value = cfg.starter || "def " + fname + "(" + args + "):\n    return 0.0\n";
  }

  /* ---- boot -------------------------------------------------------------- */

  async function boot() {
    try {
      cfg = await fetch("config.json").then(function (r) {
        if (!r.ok) throw new Error("config.json not found (" + r.status + ")");
        return r.json();
      });
    } catch (e) {
      document.body.innerHTML = '<div class="tool"><p class="error">Could not load this ' +
        'bake-off: ' + esc(e.message) + '</p></div>';
      return;
    }
    document.title = cfg.title + " · Bake-off";
    shell();
    wire();
    renderBoard();

    try {
      var feats = cfg.features || [], target = cfg.target;
      var txt = await Promise.all([
        fetch(cfg.data.train).then(function (r) { return r.text(); }),
        fetch(cfg.data.test).then(function (r) { return r.text(); })
      ]);
      DATA = { train: extract(parseCSV(txt[0]), feats, target),
               test:  extract(parseCSV(txt[1]), feats, target) };

      $("pystatus").textContent = "Loading Python (about 10 MB, first time only)…";
      pyodide = await loadPyodide();
      await pyodide.loadPackage("numpy");
      pyodide.runPython(HARNESS);

      var g = pyodide.globals;
      g.set("_Xtr", pyodide.toPy(DATA.train.X)); g.set("_ytr", pyodide.toPy(DATA.train.y));
      g.set("_Xte", pyodide.toPy(DATA.test.X));  g.set("_yte", pyodide.toPy(DATA.test.y));
      pyodide.runPython([
        "import numpy as np",
        "X_train = np.array(_Xtr, dtype=float); y_train = np.array(_ytr, dtype=float)",
        "X_test  = np.array(_Xte, dtype=float); y_test  = np.array(_yte, dtype=float)"
      ].join("\n"));
      g.set("_names", pyodide.toPy([feats, target]));

      $("pystatus").textContent = "Ready. " + DATA.train.y.length + " training points, " +
        DATA.test.y.length + " test points.";
      $("run").disabled = false;
    } catch (e) {
      $("pystatus").textContent = "Could not start: " + (e.message || e);
    }
  }

  function wire() {
    $("run").onclick = async function () {
      $("err").textContent = "";
      var name = $("name").value.trim();
      if (!name) { $("err").textContent = "Enter your name first."; return; }

      $("run").disabled = true; $("runstatus").textContent = "Running…";
      try {
        pyodide.globals.set("_code", $("code").value);
        pyodide.globals.set("_fname", cfg.function_name || "f");
        pyodide.globals.set("_expose", !!cfg.expose_training_data);
        var out = pyodide.runPython(
          "_run(_code, _fname, _names, X_train, y_train, X_test, y_test, _expose)").toJs();
        var mtr = out[0], mte = out[1];

        $("mtrain").textContent = mtr.toPrecision(4);
        $("mtest").textContent = mte.toPrecision(4);

        lastResult = { name: name, code: $("code").value,
                       train_mse: mtr, test_mse: mte, at: new Date().toISOString() };
        $("result").classList.add("show");
        $("runstatus").textContent = "";
        handOff(lastResult);
      } catch (e) {
        $("runstatus").textContent = "";
        $("err").textContent = String(e.message || e).split("\n").slice(-12).join("\n");
      }
      $("run").disabled = false;
    };
  }

  // A pre-filled GitHub issue. The Action in .github/workflows parses it and
  // commits to leaderboard.json, so nobody has to approve anything.
  function issueURL(r) {
    var sub = cfg.submit || {};
    var q = { template: sub.template || "bakeoff-submission.yml",
              title: "Bake-off submission: " + r.name,
              name: r.name, bakeoff: slug(),
              "test-mse": String(r.test_mse), "train-mse": String(r.train_mse),
              code: r.code };
    var parts = [];
    for (var k in q) parts.push(k + "=" + encodeURIComponent(q[k]));
    return "https://github.com/" + (sub.repo || "") + "/issues/new?" + parts.join("&");
  }

  function manualURL() {
    var sub = cfg.submit || {};
    return "https://github.com/" + (sub.repo || "") + "/issues/new?template=" +
           (sub.template || "");
  }

  // Open GitHub with the submission filled in. Called straight from the click
  // handler with no await in between, so the browser still counts it as a user
  // gesture rather than an unsolicited pop-up.
  function handOff(r) {
    var url = issueURL(r), hint = $("subhint");
    if (url.length > 7000) {
      hint.innerHTML = "Scored. Your code is too long to pass to GitHub through a link, " +
        "so open <a href='" + manualURL() + "' target='_blank' rel='noopener'>a submission " +
        "issue</a> and paste it in yourself.";
      return;
    }
    var win = window.open(url, "_blank", "noopener");
    pollBoard();
    hint.innerHTML = win
      ? "GitHub has opened in a new tab with your submission filled in. Press " +
        "<em>Create</em> there and the board below updates by itself."
      : "Scored, but your browser blocked the new tab. " +
        "<a href='" + url.replace(/'/g, "%27") + "' target='_blank' rel='noopener'>" +
        "Open your submission here</a> and press <em>Create</em>.";
  }

  // The Action commits and Pages rebuilds a minute or so after a submission,
  // so check back a few times instead of asking people to reload.
  function pollBoard() {
    [15, 35, 60, 90, 130, 180].forEach(function (s) {
      setTimeout(renderBoard, s * 1000);
    });
  }

  function slug() {
    var parts = location.pathname.replace(/\/index\.html$/, "").split("/").filter(Boolean);
    return parts[parts.length - 1] || "bakeoff";
  }
  async function renderBoard() {
    var official = { entries: [] };
    try {
      official = await fetch("leaderboard.json?t=" + Date.now(), { cache: "no-store" })
        .then(function (r) { return r.json(); });
    }
    catch (e) { /* no board published yet */ }

    var rows = (official.entries || []).slice().sort(function (a, b) {
      return a.test_mse - b.test_mse;
    });

    var tb = $("board").querySelector("tbody");
    tb.innerHTML = "";
    var rank = 0, placed = false;
    var base = official.baseline || cfg.baseline;

    function add(e, isBase) {
      var tr = document.createElement("tr");
      tr.className = isBase ? "baseline" : "";
      var mse = Number(isBase ? base.mse : e.test_mse);
      tr.innerHTML = "<td>" + (isBase ? "—" : String(++rank)) + "</td>" +
        "<td>" + esc(isBase ? (base.label || base.name || "baseline") : e.name) + "</td>" +
        "<td class='num'>" + mse.toPrecision(4) + "</td>";
      tb.appendChild(tr);
    }
    for (var i = 0; i < rows.length; i++) {
      if (!placed && base && base.mse < rows[i].test_mse) { add(base, true); placed = true; }
      add(rows[i], false);
    }
    if (!placed && base) add(base, true);
  }

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) renderBoard();
  });

  boot();
})();
