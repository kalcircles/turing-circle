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
  var FILES = {};   // uploaded files other than the main .py: name -> Uint8Array

  /* ---- metric -------------------------------------------------------------
   * config.json "metric": "mse" (default, lower is better) or "r2" (higher is
   * better). Scores are stored as test_score/train_score; boards written
   * before the metric was configurable used test_mse and baseline.mse.
   */
  var METRICS = {
    mse: { label: "MSE", higher: false, fmt: function (v) { return v.toPrecision(4); } },
    r2:  { label: "R\u00b2", higher: true, fmt: function (v) { return (Math.abs(v) < 5e-4 ? 0 : v).toFixed(3); } }
  };
  function metric() { return METRICS[cfg.metric] || METRICS.mse; }
  function scoreOf(e) { return Number(e.test_score != null ? e.test_score : e.test_mse); }
  function baseOf(b) { return Number(b.score != null ? b.score : b.mse); }
  // true when a beats b
  function beats(a, b) { return metric().higher ? a > b : a < b; }
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
      for (var j = 0; j < head.length; j++) {
        // numbers stay numbers; categorical cells ("teacher", "yes") stay strings
        var v = (parts[j] || "").trim(), n = Number(v);
        row[head[j]] = v !== "" && isFinite(n) ? n : v;
      }
      rows.push(row);
    }
    return { head: head, rows: rows };
  }

  // Pull the configured feature columns and target out of a parsed CSV.
  // One feature -> a flat array. Several -> an array of rows. With
  // input: "dict", each row is an object keyed by column name instead, and an
  // empty feature list means every column except the target.
  function extract(csv, features, target) {
    if (cfg.input === "dict" && !features.length) {
      features = csv.head.filter(function (h) { return h !== target; });
    }
    var missing = features.concat(target).filter(function (c) {
      return csv.head.indexOf(c) === -1;
    });
    if (missing.length) {
      throw new Error("Column(s) missing from the data file: " + missing.join(", ") +
                      ". Found: " + csv.head.join(", "));
    }
    var X = csv.rows.map(function (r) {
      if (cfg.input === "dict") {
        var d = {};
        features.forEach(function (f) { d[f] = r[f]; });
        return d;
      }
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
    "import numpy as np, os, sys, shutil",
    "_SUB = '/home/pyodide/submission'",
    "class _NoneReturn(Exception):",
    "    pass",
    "def _score(metric, p, y):",
    "    p, y = np.asarray(p, dtype=float), np.asarray(y, dtype=float)",
    "    sse = float(np.sum((p - y) ** 2))",
    "    if metric == 'r2':",
    "        # the usual R^2 (as sklearn's r2_score): 1 - SS_res / SS_tot, with",
    "        # SS_tot about the mean of the same set being scored",
    "        return 1.0 - sse / float(np.sum((y - y.mean()) ** 2))",
    "    return sse / len(y)",
    "def _apply(f, X):",
    "    if isinstance(X, list):",
    "        vals = [f(dict(row)) for row in X]",
    "        if any(v is None for v in vals):",
    "            raise _NoneReturn()",
    "        return np.array([float(np.asarray(v, dtype=float).ravel()[0]) for v in vals])",
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
    "def _stage(files):",
    "    # uploaded files land in a fresh folder that is also the working",
    "    # directory, so np.load('weights.npy') and 'import helpers' just work",
    "    # step out first: the last run left us inside _SUB, and the",
    "    # filesystem will not remove the current directory",
    "    os.chdir('/')",
    "    shutil.rmtree(_SUB, ignore_errors=True)",
    "    os.makedirs(_SUB, exist_ok=True)",
    "    for nm, data in files.items():",
    "        with open(os.path.join(_SUB, nm), 'wb') as fh:",
    "            fh.write(data.to_bytes() if hasattr(data, 'to_bytes') else bytes(data))",
    "    for m in [m for m, mod in sys.modules.items()",
    "              if (getattr(mod, '__file__', None) or '').startswith(_SUB)]:",
    "        del sys.modules[m]",
    "    if _SUB not in sys.path:",
    "        sys.path.insert(0, _SUB)",
    "    os.chdir(_SUB)",
    "def _run(code, fname, names, X_train, y_train, X_test, y_test, expose, files, metric):",
    "    _stage(files)",
    "    ns = {'np': np, 'numpy': np, '__name__': '__main__'}",
    "    if expose:",
    "        ns['X_train'], ns['y_train'] = X_train, y_train",
    "        if not isinstance(X_train, list):",
    "            for i, nm in enumerate(names[0]):",
    "                ns[nm + '_train'] = X_train if X_train.ndim == 1 else X_train[:, i]",
    "        ns[names[1] + '_train'] = y_train",
    "    exec(code, ns)",
    "    if fname not in ns or not callable(ns[fname]):",
    "        raise ValueError('Your code must define a function called ' + fname +",
    "                         ', e.g.  def ' + fname + '(...): ...')",
    "    f = ns[fname]",
    "    try:",
    "        p_tr, p_te = _apply(f, X_train), _apply(f, X_test)",
    "    except _NoneReturn:",
    "        raise ValueError(fname + ' returned None, so there is nothing to score yet. Write your model in place of the \\'return None\\' line - there is a commented-out example just above it.') from None",
    "    if not (np.all(np.isfinite(p_tr)) and np.all(np.isfinite(p_te))):",
    "        raise ValueError('Your function returned inf or nan. Check for division by zero or overflow.')",
    "    return [_score(metric, p_tr, y_train), _score(metric, p_te, y_test)]"
  ].join("\n");

  /* ---- UI ---------------------------------------------------------------- */

  function shell() {
    var fname = cfg.function_name || "f";
    var args = cfg.arg_name || (cfg.features || ["x"]).join(", ");
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

        '<div class="step"><h3><span class="num">2</span>Your ' + (cfg.uploads ? 'model' : 'function') + '</h3>' +
          (cfg.uploads
            ? '<p class="hint">Fit in your own notebook, save the fitted numbers to a file ' +
              '(e.g. <code>np.save("weights.npy", phi)</code>), and upload them together with ' +
              'a <code>.py</code> file that defines <code>' + esc(fname) + '(' + esc(args) + ')</code>. ' +
              'Your files sit in the working directory, so <code>np.load("weights.npy")</code> ' +
              'finds them. <code>np</code> (numpy) is available; the training data is not. ' +
              'Only <code>' + esc(fname) + '</code> is called.</p>' +
              '<input type="file" id="files" multiple>' +
              '<ul class="files" id="filelist"></ul>' +
              '<p class="hint">Your <code>.py</code> file appears below, where you can still edit it. ' +
              'Or skip the upload and write the code in the box.</p>'
            : '<p class="hint">Define <code>' + esc(fname) + '(' + esc(args) + ')</code>, ' +
              'already fitted: this page reports a model, it is not where you build one. ' +
              'Do the fitting in your own notebook and paste the finished function in, with ' +
              'its numbers written out. <code>np</code> (numpy) is available; the training ' +
              'data is not. Only <code>' + esc(fname) + '</code> is called, so define as many ' +
              'other functions as you like.</p>') +
          '<textarea id="code" spellcheck="false"></textarea>' +
          '<p class="status" id="pystatus">Loading Python&hellip;</p></div>' +

        '<div class="step"><h3><span class="num">3</span>Score</h3>' +
          '<button id="run" disabled>Score and submit</button>' +
          '<p class="status" id="runstatus"></p><div class="error" id="err"></div>' +
          '<div class="result" id="result">' +
            '<div class="scores">' +
              '<div class="score"><div class="k">Train ' + metric().label + '</div><div class="v" id="mtrain">&mdash;</div></div>' +
              '<div class="score"><div class="k">Test ' + metric().label + '</div><div class="v" id="mtest">&mdash;</div></div>' +
            '</div>' +
            '<p class="hint" id="subhint"></p>' +
          '</div></div>' +

        '<h2>Leaderboard</h2>' +
        '<p class="hint">Updates automatically a minute or so after a submission.</p>' +
        '<table id="board"><thead><tr><th>#</th><th>Name</th>' +
          '<th class="num">Test ' + metric().label + '</th>' +
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
    wireUploads();
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
        cfg.input === "dict"
          ? "X_train = list(_Xtr); X_test = list(_Xte)"
          : "X_train = np.array(_Xtr, dtype=float); X_test = np.array(_Xte, dtype=float)",
        "y_train = np.array(_ytr, dtype=float); y_test = np.array(_yte, dtype=float)"
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
      // hide the previous scores, so a failed run cannot show stale numbers
      $("result").classList.remove("show");
      try {
        pyodide.globals.set("_code", $("code").value);
        pyodide.globals.set("_fname", cfg.function_name || "f");
        pyodide.globals.set("_expose", !!cfg.expose_training_data);
        var bytes = {};
        for (var k in FILES) bytes[k] = FILES[k];
        pyodide.globals.set("_files", pyodide.toPy(bytes));
        pyodide.globals.set("_metric", cfg.metric || "mse");
        var out = pyodide.runPython(
          "_run(_code, _fname, _names, X_train, y_train, X_test, y_test, _expose, _files, _metric)").toJs();
        var mtr = out[0], mte = out[1];

        $("mtrain").textContent = metric().fmt(mtr);
        $("mtest").textContent = metric().fmt(mte);

        lastResult = { name: name, code: $("code").value, files: packFiles(),
                       train_score: mtr, test_score: mte, at: new Date().toISOString() };
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

  /* ---- uploads ------------------------------------------------------------
   * The site is static, so nothing is uploaded anywhere: files are read in the
   * browser, written into Pyodide's in-memory filesystem when scoring, and
   * carried into the submission issue as text (base64 for binary files such
   * as .npy), so the leaderboard keeps everything needed to re-run an entry.
   */
  var TEXT_EXT = /\.(py|json|csv|tsv|txt)$/i;

  function uploadLimit() {
    return ((cfg.uploads && cfg.uploads.max_kb) || 100) * 1024;
  }

  function wireUploads() {
    var input = $("files");
    if (!input) return;
    input.onchange = async function () {
      $("err").textContent = "";
      var picked = Array.prototype.slice.call(input.files), got = {}, total = 0;
      for (var i = 0; i < picked.length; i++) {
        var nm = picked[i].name;
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(nm)) {
          $("err").textContent = "Rename " + nm + ": use letters, digits, '.', '_' or '-' only.";
          input.value = ""; return;
        }
        got[nm] = new Uint8Array(await picked[i].arrayBuffer());
        total += got[nm].length;
      }
      if (total > uploadLimit()) {
        $("err").textContent = "Those files add up to " + Math.round(total / 1024) +
          " KB; the limit is " + Math.round(uploadLimit() / 1024) + " KB. A linear " +
          "model's weights should be tiny - upload only what " +
          (cfg.function_name || "f") + " needs.";
        input.value = ""; return;
      }
      // The .py that defines the scored function goes in the editor; any
      // other .py stays a file, importable from it.
      var fname = cfg.function_name || "f", main = null;
      var pys = Object.keys(got).filter(function (n) { return /\.py$/i.test(n); });
      var defines = new RegExp("^def\\s+" + fname + "\\s*\\(", "m");
      pys.forEach(function (n) {
        if (!main && defines.test(new TextDecoder().decode(got[n]))) main = n;
      });
      if (!main && pys.length === 1) main = pys[0];
      if (main) {
        $("code").value = new TextDecoder().decode(got[main]);
        delete got[main];
      }
      FILES = got;
      $("filelist").innerHTML =
        (main ? "<li><code>" + esc(main) + "</code> &mdash; loaded into the editor below</li>" : "") +
        Object.keys(FILES).map(function (n) {
          return "<li><code>" + esc(n) + "</code> &mdash; " + FILES[n].length + " bytes</li>";
        }).join("");
    };
  }

  function b64(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  // {"weights.npy": {"b64": "..."}, "cols.json": {"text": "..."}}, or "" if none.
  function packFiles() {
    var names = Object.keys(FILES);
    if (!names.length) return "";
    var out = {};
    names.forEach(function (n) {
      var text = null;
      if (TEXT_EXT.test(n)) {
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(FILES[n]); }
        catch (e) { text = null; }
      }
      out[n] = text !== null ? { text: text } : { b64: b64(FILES[n]) };
    });
    return JSON.stringify(out);
  }

  // A pre-filled GitHub issue. The Action in .github/workflows parses it and
  // commits to leaderboard.json, so nobody has to approve anything.
  function issueURL(r) {
    var sub = cfg.submit || {};
    var q = { template: sub.template || "bakeoff-submission.yml",
              title: "Bake-off submission: " + r.name,
              name: r.name, bakeoff: slug(),
              "test-score": String(r.test_score), "train-score": String(r.train_score),
              code: r.code };
    if (r.files) q.files = r.files;
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
      hint.innerHTML = "Scored. Your submission is too long to pass to GitHub through a link, " +
        "so open <a href='" + manualURL() + "' target='_blank' rel='noopener'>a submission " +
        "issue</a> and fill it in yourself: your name, <code>" + esc(slug()) + "</code> as the " +
        "bake-off, the two scores above, your code" +
        (r.files ? ", and the text below in <em>Files</em>." +
          "<textarea readonly class='blob' onclick='this.select()'>" + esc(r.files) + "</textarea>"
          : ".");
      return;
    }
    // A named, sized window rather than a tab: the GitHub form comes up over
    // the page and closes again, instead of navigating away from it. The name
    // means a second submission reuses the same window.
    //
    // Deliberately no "noopener" here. window.open returns null whenever that
    // token is passed, which makes it impossible to tell success from a
    // blocked pop-up. The destination is a fixed https://github.com/ URL, so
    // there is nothing untrusted to protect the opener from.
    var win = window.open(url, "bakeoff-submit",
                          "width=860,height=780,resizable=yes,scrollbars=yes");
    pollBoard();
    hint.innerHTML = win
      ? "A GitHub window has opened with your submission filled in. Press " +
        "<em>Create</em> there, then come back: the board below updates by itself."
      : "Scored, but your browser blocked the pop-up. " +
        "<a href='" + url.replace(/'/g, "%27") + "' target='_blank' rel='noopener'>" +
        "Open your submission here</a> and press <em>Create</em>.";
    if (win) { try { win.focus(); } catch (e) {} }
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
      return metric().higher ? scoreOf(b) - scoreOf(a) : scoreOf(a) - scoreOf(b);
    });

    var tb = $("board").querySelector("tbody");
    tb.innerHTML = "";
    var rank = 0, placed = false;
    var base = official.baseline || cfg.baseline;

    function add(e, isBase) {
      var tr = document.createElement("tr");
      tr.className = isBase ? "baseline" : "";
      var v = isBase ? baseOf(base) : scoreOf(e);
      tr.innerHTML = "<td>" + (isBase ? "—" : String(++rank)) + "</td>" +
        "<td>" + esc(isBase ? (base.label || base.name || "baseline") : e.name) + "</td>" +
        "<td class='num'>" + metric().fmt(v) + "</td>";
      tb.appendChild(tr);
    }
    for (var i = 0; i < rows.length; i++) {
      if (!placed && base && beats(baseOf(base), scoreOf(rows[i]))) { add(base, true); placed = true; }
      add(rows[i], false);
    }
    if (!placed && base) add(base, true);
  }

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) renderBoard();
  });

  boot();
})();
