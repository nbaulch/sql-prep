/* SQL Screen Prep: runs entirely in the browser.
 *
 * DuckDB (compiled to WebAssembly) is loaded from a CDN; the lending data
 * ships in app/data.js; lessons and problems ship in app/content.js.
 * Progress lives in this browser's localStorage (export it from Progress).
 */
(function () {
  "use strict";

  const DUCKDB_URL = "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.32.0/+esm";
  const TABLES = ["merchants", "borrowers", "applications", "loans", "installments", "payments", "loan_month", "merchant_terms"];
  const STORE_KEY = "sqlprep.v1";
  const MAX_ROWS_SHOWN = 200;
  const COURSE = window.COURSE;

  const $ = (sel, el = document) => el.querySelector(sel);
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "html") el.innerHTML = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmtInt = (n) => n.toLocaleString("en-US");

  /* ------------------------------------------------------------------ */
  /* progress                                                            */
  /* ------------------------------------------------------------------ */

  const Store = {
    state: { items: {}, lessons: {}, mocks: [], last: null },
    load() {
      try {
        const raw = localStorage.getItem(STORE_KEY);
        if (raw) this.state = Object.assign(this.state, JSON.parse(raw));
      } catch (e) { /* storage unavailable: run without saving */ }
    },
    save() {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(this.state)); } catch (e) { /* ignore */ }
    },
    item(id) {
      return (this.state.items[id] ||= { status: "new", attempts: 0, hints: 0, revealed: false });
    },
    update(id, patch) {
      Object.assign(this.item(id), patch);
      this.save();
    },
    solved(id) { return this.state.items[id]?.status === "solved"; },
  };

  /* ------------------------------------------------------------------ */
  /* database                                                            */
  /* ------------------------------------------------------------------ */

  const DB = {
    conn: null,
    ready: null,
    queue: Promise.resolve(),

    init() {
      this.ready = (async () => {
        setStatus("loading", "Loading database…");
        const duckdb = await import(DUCKDB_URL);
        const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
        const workerUrl = URL.createObjectURL(
          new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }));
        const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(workerUrl));
        await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
        URL.revokeObjectURL(workerUrl);
        this.db = db;
        this.conn = await db.connect();
        await this.loadData();
        setStatus("ready", "Database ready");
      })().catch((e) => {
        console.error(e);
        setStatus("error", "Database failed to load: check your internet connection and reload");
        throw e;
      });
      return this.ready;
    },

    async loadData() {
      for (const t of TABLES) {
        const bin = atob(window.COURSE_DATA[t]);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        await this.db.registerFileBuffer(`${t}.parquet`, bytes);
        await this.conn.query(`CREATE OR REPLACE TABLE ${t} AS SELECT * FROM '${t}.parquet'`);
      }
    },

    async reset() {
      await this.ready;
      await this.serial(() => this.loadData());
    },

    // DuckDB connections run one query at a time; serialize callers.
    serial(fn) {
      const p = this.queue.then(fn, fn);
      this.queue = p.catch(() => {});
      return p;
    },

    async raw(sql) {
      const res = await this.conn.query(sql);
      return res.toArray().map((r) => r.toJSON());
    },

    /* Run a learner query and return display-ready rows.
     * The query is materialized into a temp table so that every column can
     * be converted to a plain JS value (DECIMAL/BIGINT -> number,
     * dates -> ISO strings). */
    async run(sql) {
      await this.ready;
      const clean = cleanSql(sql);
      return this.serial(async () => {
        const t0 = performance.now();
        await this.conn.query(`CREATE OR REPLACE TEMP TABLE __result AS\n${clean}`);
        const ms = performance.now() - t0;
        const desc = await this.raw(`DESCRIBE __result`);
        const cols = desc.map((d) => d.column_name);
        const types = desc.map((d) => d.column_type);
        const sel = desc.map((d) => {
          const c = quoteIdent(d.column_name);
          const ty = d.column_type.toUpperCase();
          let expr;
          if (/^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|REAL|DECIMAL)/.test(ty)) expr = `CAST(${c} AS DOUBLE)`;
          else if (ty === "BOOLEAN") expr = c;
          else if (ty === "DATE") expr = `strftime(${c}, '%Y-%m-%d')`;
          else if (ty.startsWith("TIMESTAMP")) expr = `strftime(${c}, '%Y-%m-%d %H:%M:%S')`;
          else expr = `CAST(${c} AS VARCHAR)`;
          return `${expr} AS ${quoteIdent("c" + cols.indexOf(d.column_name))}`;
        });
        const rows = (await this.raw(`SELECT ${sel.join(", ")} FROM __result`))
          .map((r) => cols.map((_, i) => r["c" + i] ?? null));
        await this.conn.query(`DROP TABLE IF EXISTS __result`);
        return { cols, types, rows, ms };
      });
    },
  };

  function quoteIdent(name) { return '"' + String(name).replace(/"/g, '""') + '"'; }

  /* Strip trailing semicolons/comments; reject multiple statements. */
  function cleanSql(sql) {
    let s = sql.replace(/\s+$/, "");
    // remove trailing line comments and semicolons repeatedly
    for (;;) {
      const before = s;
      s = s.replace(/(^|\n)[ \t]*--[^\n]*$/, "").replace(/\s+$/, "").replace(/;+$/, "").replace(/\s+$/, "");
      if (s === before) break;
    }
    const noStrings = s.replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*/g, "");
    if (!noStrings.replace(/\/\*[\s\S]*?\*\//g, "").trim()) throw new Error("The editor is empty: write a query first.");
    if (noStrings.includes(";")) throw new Error("Run one statement at a time (remove the extra semicolon).");
    return s + "\n";
  }

  function setStatus(kind, label) {
    const el = $("#dbStatus");
    el.className = "db-status " + kind;
    $(".label", el).textContent = label;
  }

  /* ------------------------------------------------------------------ */
  /* answer checking                                                     */
  /* ------------------------------------------------------------------ */

  function normCell(v) {
    if (typeof v === "string") return v.replace(/ 00:00:00$/, "");
    return v;
  }

  function cellKey(v, digits) {
    if (v === null) return "\u0000NULL";
    if (typeof v === "number") {
      const r = Number(v.toFixed(digits));
      return "n:" + (Object.is(r, -0) ? 0 : r).toFixed(digits);
    }
    return typeof v + ":" + String(normCell(v));
  }

  function cellEq(a, b, digits) {
    if (a === null || b === null) return a === b;
    if (typeof a === "number" && typeof b === "number") {
      const d = Math.abs(a - b);
      return d <= 0.5 * Math.pow(10, -digits) + 1e-9 || d <= 1e-9 * Math.max(Math.abs(a), Math.abs(b));
    }
    return String(normCell(a)) === String(normCell(b));
  }

  const rowKey = (row, digits) => row.map((v) => cellKey(v, digits)).join("\u0001");
  const rowEq = (a, b, digits) => a.length === b.length && a.every((v, i) => cellEq(v, b[i], digits));

  function compareResults(mine, want, opts) {
    const digits = opts.digits ?? 2;
    const notes = [];
    let rows = mine.rows;
    let cols = mine.cols;

    // If the column names match as a set but in another order, line them up.
    const lc = (a) => a.map((c) => c.toLowerCase());
    const sameNameSet = cols.length === want.cols.length &&
      lc(cols).slice().sort().join("|") === lc(want.cols).slice().sort().join("|");
    if (sameNameSet && lc(cols).join("|") !== lc(want.cols).join("|")) {
      const idx = lc(want.cols).map((c) => lc(cols).indexOf(c));
      rows = rows.map((r) => idx.map((i) => r[i]));
      cols = idx.map((i) => cols[i]);
    }

    if (cols.length !== want.cols.length) {
      return {
        ok: false,
        title: `Your result has ${cols.length} column${cols.length === 1 ? "" : "s"}; the answer has ${want.cols.length}.`,
        detail: `Expected columns: <code>${want.cols.map(esc).join("</code>, <code>")}</code>`,
      };
    }

    const nameMismatch = lc(cols).join("|") !== lc(want.cols).join("|");
    if (nameMismatch) notes.push(`Values are compared by position. The expected column names are <code>${want.cols.map(esc).join("</code>, <code>")}</code>.`);

    const sortRows = (rs) => rs.map((r) => [rowKey(r, digits), r]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map((x) => x[1]);

    const sameCount = rows.length === want.rows.length;
    const mineSorted = sortRows(rows);
    const wantSorted = sortRows(want.rows);
    const sameBag = sameCount && mineSorted.every((r, i) => rowEq(r, wantSorted[i], digits));

    if (sameBag) {
      if (opts.ordered && !rows.every((r, i) => rowEq(r, want.rows[i], digits))) {
        return { ok: false, title: "Right rows, wrong order.", detail: "The question asks for a specific sort order: check your ORDER BY (and the tie-breaker).", notes };
      }
      return { ok: true, notes };
    }

    // Build a diff on rounded keys.
    const count = (rs) => rs.reduce((m, r) => m.set(rowKey(r, digits), (m.get(rowKey(r, digits)) || 0) + 1), new Map());
    const mc = count(rows), wc = count(want.rows);
    const missing = [], extra = [];
    const seen = new Map();
    for (const r of want.rows) {
      const k = rowKey(r, digits);
      seen.set(k, (seen.get(k) || 0) + 1);
      if (seen.get(k) > (mc.get(k) || 0) && missing.length < 5) missing.push(r);
    }
    seen.clear();
    for (const r of rows) {
      const k = rowKey(r, digits);
      seen.set(k, (seen.get(k) || 0) + 1);
      if (seen.get(k) > (wc.get(k) || 0) && extra.length < 5) extra.push(r);
    }

    let title, detail = "";
    if (!sameCount) {
      title = `You returned ${fmtInt(rows.length)} row${rows.length === 1 ? "" : "s"}; the answer has ${fmtInt(want.rows.length)}.`;
      if (rows.length > want.rows.length) {
        const dupes = rows.length - new Set(rows.map((r) => rowKey(r, digits))).size;
        detail = dupes > 0
          ? `Too many rows, and ${fmtInt(dupes)} of yours are exact duplicates. Did a join fan out, or did duplicates in the source survive?`
          : "Too many rows. Check the grain: what should one row represent? A join can multiply rows, and a missing filter or GROUP BY column can too.";
      } else {
        detail = "Too few rows. An INNER JOIN drops rows with no match, WHERE drops rows where the condition is NULL, and an over-strict filter drops the rest.";
      }
    } else {
      title = "Right number of rows, but some values differ.";
      detail = "Compare the rows below. Common causes: NULL handling, integer division, a filter in the wrong place, or counting duplicates.";
    }
    return { ok: false, title, detail, missing, extra, cols: want.cols, notes };
  }

  /* ------------------------------------------------------------------ */
  /* rendering helpers                                                   */
  /* ------------------------------------------------------------------ */

  marked.setOptions({ gfm: true, breaks: false });

  function md(text) {
    const div = h("div", { class: "prose" });
    div.innerHTML = marked.parse(text || "");
    enhanceCode(div);
    return div;
  }

  // ```sql blocks become runnable editors; everything else is highlighted.
  function enhanceCode(root) {
    root.querySelectorAll("pre > code").forEach((code) => {
      const pre = code.parentElement;
      const lang = (code.className.match(/language-(\w+)/) || [])[1] || "";
      const text = code.textContent.replace(/\n$/, "");
      if (lang === "sql") {
        pre.replaceWith(runner({ sql: text }).el);
      } else {
        const out = h("pre", { class: "static" });
        const mode = lang === "r" ? "r" : lang === "sqlstatic" ? "text/x-sql" : null;
        if (mode && window.CodeMirror?.runMode) {
          CodeMirror.runMode(text, mode, out);
          out.querySelectorAll("[class*='cm-']").forEach((s) => {
            [...s.classList].filter((c) => c.startsWith("cm-")).forEach((c) => s.classList.add("tok-" + c.slice(3)));
          });
        } else out.textContent = text;
        pre.replaceWith(out);
      }
    });
  }

  function resultTable(res) {
    const wrap = h("div");
    const table = h("table", { class: "result" });
    table.append(h("thead", {}, h("tr", {}, res.cols.map((c) => h("th", {}, c)))));
    const tb = h("tbody");
    for (const r of res.rows.slice(0, MAX_ROWS_SHOWN)) {
      tb.append(h("tr", {}, r.map((v) => {
        if (v === null) return h("td", { class: "null" }, "NULL");
        if (typeof v === "number") return h("td", { class: "num" }, fmtNum(v));
        return h("td", {}, String(v));
      })));
    }
    table.append(tb);
    wrap.append(table);
    return wrap;
  }

  function fmtNum(v) {
    if (Number.isInteger(v)) return String(v);
    const s = v.toPrecision(12);
    return String(Number(s));
  }

  function editor(host, value, onRun, onCheck) {
    const cm = CodeMirror(host, {
      value,
      mode: "text/x-sql",
      lineNumbers: true,
      matchBrackets: true,
      indentUnit: 2,
      tabSize: 2,
      indentWithTabs: false,
      lineWrapping: false,
      viewportMargin: Infinity,
      extraKeys: {
        "Ctrl-Enter": () => onRun(),
        "Cmd-Enter": () => onRun(),
        "Shift-Ctrl-Enter": () => onCheck && onCheck(),
        "Shift-Cmd-Enter": () => onCheck && onCheck(),
        Tab: (cm) => cm.replaceSelection("  "),
        "Ctrl-/": (cm) => toggleComment(cm),
        "Cmd-/": (cm) => toggleComment(cm),
      },
    });
    return cm;
  }

  function toggleComment(cm) {
    const from = cm.getCursor("from").line, to = cm.getCursor("to").line;
    const lines = [];
    for (let i = from; i <= to; i++) lines.push(cm.getLine(i));
    const allCommented = lines.every((l) => /^\s*--/.test(l) || !l.trim());
    cm.operation(() => {
      for (let i = from; i <= to; i++) {
        const l = cm.getLine(i);
        const nl = allCommented ? l.replace(/^(\s*)-- ?/, "$1") : l.replace(/^(\s*)/, "$1-- ");
        cm.replaceRange(nl, { line: i, ch: 0 }, { line: i, ch: l.length });
      }
    });
  }

  /* A query editor with a Run button and a result area. */
  function runner({ sql, onCheck, onChange, extraButtons = [], checkLabel }) {
    const host = h("div");
    const result = h("div", { class: "result-wrap" });
    const foot = h("div");
    const meta = h("span", { class: "meta" });
    let cm;
    const doRun = async () => {
      runBtn.disabled = true;
      meta.textContent = "running…";
      try {
        const res = await DB.run(cm.getValue());
        showResult(res);
      } catch (e) {
        showError(e);
      } finally {
        runBtn.disabled = false;
      }
    };
    const showResult = (res) => {
      result.replaceChildren(resultTable(res));
      const shown = Math.min(res.rows.length, MAX_ROWS_SHOWN);
      foot.replaceChildren(h("div", { class: "result-foot" },
        `${fmtInt(res.rows.length)} row${res.rows.length === 1 ? "" : "s"}` +
        (shown < res.rows.length ? ` (showing first ${shown})` : "") +
        ` · ${res.cols.length} column${res.cols.length === 1 ? "" : "s"}`));
      meta.textContent = `${Math.max(1, Math.round(res.ms))} ms`;
    };
    const showError = (e) => {
      result.replaceChildren();
      foot.replaceChildren(h("div", { class: "error-box" }, prettyError(e)));
      meta.textContent = "";
    };
    const runBtn = h("button", { class: "btn btn-primary", onclick: doRun, title: "Ctrl+Enter" }, "Run ", h("span", { class: "kbd" }, "Ctrl+↵"));
    const resetBtn = h("button", { class: "btn btn-ghost", onclick: () => { cm.setValue(sql); }, title: "Restore the original query" }, "Reset");
    const checkBtn = onCheck ? h("button", { class: "btn btn-good", onclick: () => onCheck(cm.getValue()), title: "Ctrl+Shift+Enter" }, checkLabel || "Check answer") : null;
    const bar = h("div", { class: "runner-bar" }, runBtn, checkBtn, ...extraButtons, h("span", { class: "spacer" }), meta, resetBtn);
    const el = h("div", { class: "runner" }, host, bar, result, foot);
    cm = editor(host, sql, doRun, onCheck ? () => onCheck(cm.getValue()) : null);
    if (onChange) cm.on("change", () => onChange(cm.getValue()));
    requestAnimationFrame(() => cm.refresh());
    return { el, cm, run: doRun, showResult, showError, clear: () => { result.replaceChildren(); foot.replaceChildren(); } };
  }

  function prettyError(e) {
    let msg = String(e && e.message ? e.message : e);
    // the learner's query starts on line 2 of what we sent; renumber
    msg = msg.replace(/LINE (\d+):/g, (_, n) => `LINE ${Math.max(1, n - 1)}:`);
    msg = msg.replace(/CREATE OR REPLACE TEMP TABLE __result AS\s*/g, "");
    return msg;
  }

  function callout(kind, title, text) {
    const labels = { rlens: "If you know dplyr", pitfall: "Pitfall", note: "Note", interview: "In the interview", dialect: "Dialect check", bridge: "From economics and bank risk" };
    const label = labels[kind] + (title ? ": " + title : "");
    return h("div", { class: "callout " + kind },
      h("div", { class: "callout-title" }, label),
      h("div", { class: "callout-body" }, ...md(text).childNodes));
  }

  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove("show"), 2200);
  }

  /* ------------------------------------------------------------------ */
  /* exercise and problem cards                                          */
  /* ------------------------------------------------------------------ */

  const KIND_LABEL = { write: "Write", fix: "Fix the bug", fill: "Fill in", predict: "Predict" };

  const expectedCache = new Map();
  async function expectedFor(item) {
    if (!expectedCache.has(item.id)) expectedCache.set(item.id, DB.run(item.solution));
    return expectedCache.get(item.id);
  }

  /* Interactive exercise (lesson) or problem (bank / mock).
   * mode: "learn" (hints + solution available) or "mock" (no feedback). */
  /* bare: interview-style card with Check but no hints, no solution, no reveal. */
  function exerciseCard(item, { mode = "learn", onSolved, heading, hideId = false, bare = false } = {}) {
    const st = mode === "mock" ? { status: "new" } : Store.item(item.id);
    const card = h("div", { class: "card" + (st.status === "solved" ? " solved" : "") });
    const badge = h("span", { class: "badge " + (st.status === "solved" ? "done" : item.kind) },
      st.status === "solved" ? "Solved" : KIND_LABEL[item.kind] || "Write");
    const head = h("div", { class: "card-head" }, badge, heading ? h("strong", {}, heading) : null, hideId ? null : h("span", { class: "card-id" }, item.id));
    const body = h("div", { class: "card-body" });
    const feedback = h("div", { class: "feedback" });
    const hintsBox = h("div");
    const revealBox = h("div", { class: "reveal" });

    if (item.type !== "problem" || mode === "learn") body.append(md(item.prompt));

    let hintsShown = 0;
    const hintBtn = h("button", { class: "btn btn-ghost", onclick: () => showHint() }, "Hint");
    const solBtn = h("button", { class: "btn btn-ghost", onclick: () => reveal(true) }, "Solution");
    const updateHintBtn = () => {
      hintBtn.textContent = item.hints.length ? `Hint ${Math.min(hintsShown + 1, item.hints.length)}/${item.hints.length}` : "No hints";
      hintBtn.disabled = hintsShown >= item.hints.length;
    };
    const showHint = () => {
      if (hintsShown >= item.hints.length) return;
      hintsBox.append(h("div", { class: "hint" }, ...md(item.hints[hintsShown]).childNodes));
      hintsShown++;
      Store.update(item.id, { hints: Math.max(Store.item(item.id).hints, hintsShown) });
      updateHintBtn();
    };
    updateHintBtn();

    const draft = st.draft != null ? st.draft : item.starter || (item.type === "problem" ? "-- Write your query here\n" : "");
    let saveT;
    const r = runner({
      sql: draft,
      onCheck: mode === "mock" ? null : (sql) => check(sql),
      onChange: mode === "mock" ? null : (v) => { clearTimeout(saveT); saveT = setTimeout(() => Store.update(item.id, { draft: v }), 400); },
      extraButtons: mode === "mock" || bare ? [] : [hintBtn, solBtn],
    });
    // the Reset button restores the starter, not the saved draft
    $(".runner-bar .btn-ghost:last-child", r.el).onclick = () => r.cm.setValue(item.starter || "");
    body.append(r.el, feedback, hintsBox, revealBox);
    card.append(head, body);

    async function check(sql) {
      feedback.className = "feedback info";
      feedback.textContent = "Checking…";
      let mine;
      try {
        mine = await DB.run(sql);
        r.showResult(mine);
      } catch (e) {
        r.showError(e);
        feedback.className = "feedback bad";
        feedback.innerHTML = "<strong>Your query didn't run.</strong> Read the error under the editor: DuckDB usually names the column or the word it choked on.";
        Store.update(item.id, { attempts: Store.item(item.id).attempts + 1, status: Store.solved(item.id) ? "solved" : "attempted",
          lastResult: "query error: " + String(e.message || e).split("\n")[0] });
        return;
      }
      const want = await expectedFor(item);
      const cmp = compareResults(mine, want, item);
      const wasSolved = Store.solved(item.id);
      Store.update(item.id, {
        attempts: Store.item(item.id).attempts + 1,
        status: cmp.ok || wasSolved ? "solved" : "attempted",
        solvedAt: cmp.ok && !wasSolved ? new Date().toISOString() : Store.item(item.id).solvedAt,
        lastResult: cmp.ok ? "correct" : cmp.title,
      });
      renderFeedback(cmp);
      if (cmp.ok) {
        card.classList.add("solved");
        badge.className = "badge done";
        badge.textContent = "Solved";
        if (!bare) reveal(false);
        if (onSolved) onSolved();
        refreshNav();
      }
    }

    function renderFeedback(cmp) {
      feedback.replaceChildren();
      if (cmp.ok) {
        feedback.className = "feedback good";
        feedback.append(h("strong", {}, "Correct."), bare ? "" : " Compare your query with the reference solution below.");
        for (const n of cmp.notes || []) feedback.append(h("div", { class: "small", html: n }));
        return;
      }
      feedback.className = "feedback bad";
      feedback.append(h("div", {}, h("strong", {}, cmp.title)));
      if (cmp.detail) feedback.append(h("div", { html: cmp.detail }));
      for (const n of cmp.notes || []) feedback.append(h("div", { class: "small", html: n }));
      const sample = (label, rows) => {
        if (!rows || !rows.length) return;
        feedback.append(h("div", { class: "diff-label" }, label));
        feedback.append(resultTable({ cols: cmp.cols, rows }));
      };
      sample("Expected rows missing from your result (up to 5):", cmp.missing);
      sample("Rows in your result that shouldn't be there (up to 5):", cmp.extra);
    }

    function reveal(confirmFirst) {
      if (revealBox.childElementCount) return;
      if (confirmFirst && !Store.solved(item.id) &&
          !confirm("Show the solution? Try a hint first if you haven't: struggling a little is where the learning happens.")) return;
      if (confirmFirst) Store.update(item.id, { revealed: true });
      revealBox.append(h("div", { class: "reveal-title" }, "Reference solution"));
      const sol = h("div", { class: "prose" });
      sol.innerHTML = "<pre><code class='language-sqlstatic'></code></pre>";
      $("code", sol).textContent = item.solution;
      enhanceCode(sol);
      revealBox.append(sol);
      item.alts.forEach((a, i) => {
        revealBox.append(h("div", { class: "reveal-title" }, item.alts.length > 1 ? `Another way (${i + 1})` : "Another way"));
        const d = h("div", { class: "prose" });
        d.innerHTML = "<pre><code class='language-sqlstatic'></code></pre>";
        $("code", d).textContent = a;
        enhanceCode(d);
        revealBox.append(d);
      });
      if (item.explain) {
        revealBox.append(h("div", { class: "reveal-title" }, "Why it works"));
        revealBox.append(md(item.explain));
      }
    }

    if (st.status === "solved" && mode === "learn" && !bare) reveal(false);
    return { el: card, cm: r.cm, getSql: () => r.cm.getValue() };
  }

  function predictCard(item) {
    const st = Store.item(item.id);
    const card = h("div", { class: "card" + (st.status === "solved" ? " solved" : "") });
    const badge = h("span", { class: "badge predict" }, "Predict");
    card.append(h("div", { class: "card-head" }, badge, h("span", { class: "card-id" }, item.id)));
    const body = h("div", { class: "card-body" });
    body.append(md(item.prompt));
    if (item.sql) {
      const code = h("div", { class: "prose" });
      code.innerHTML = "<pre><code class='language-sqlstatic'></code></pre>";
      $("code", code).textContent = item.sql;
      enhanceCode(code);
      body.append(code);
    }
    const opts = h("div", { class: "options" });
    const after = h("div");
    const answered = st.answer != null;
    item.options.forEach((o, i) => {
      const b = h("button", { class: "option", onclick: () => choose(i) }, ...md(o.text).firstChild.childNodes);
      opts.append(b);
    });
    body.append(opts, after);
    card.append(body);

    function choose(i, silent) {
      [...opts.children].forEach((b, j) => {
        b.disabled = true;
        if (item.options[j].correct) b.classList.add("right");
        else if (j === i) b.classList.add("wrong");
      });
      const right = item.options[i].correct;
      if (!silent) {
        Store.update(item.id, { answer: i, status: "solved", firstTry: Store.item(item.id).answer == null ? right : Store.item(item.id).firstTry });
        refreshNav();
      }
      card.classList.add("solved");
      after.replaceChildren(
        h("div", { class: "feedback " + (right ? "good" : "bad") }, h("strong", {}, right ? "Right." : "Not quite."), item.sql ? " Run the query to see for yourself." : ""),
        item.sql ? runner({ sql: item.sql }).el : "",
        item.explain ? md(item.explain) : "");
    }
    if (answered) choose(st.answer, true);
    return card;
  }

  /* collect (optional) gathers handles for the "copy my answers" summary. */
  function renderBlocks(blocks, container, collect) {
    for (const b of blocks) {
      if (b.type === "md") container.append(...md(b.text).childNodes);
      else if (b.type === "exercise") {
        const c = exerciseCard(b);
        container.append(c.el);
        if (collect) collect.push({ kind: "exercise", item: b, getText: c.getSql });
      } else if (b.type === "predict") {
        container.append(predictCard(b));
        if (collect) collect.push({ kind: "predict", item: b });
      } else if (b.type === "chart") container.append(chartBlock(b));
      else if (b.type === "explain") {
        const c = explainCard(b);
        container.append(c.el);
        if (collect) collect.push({ kind: "explain", item: b, getText: c.getText });
      } else if (b.type === "scratch") {
        const c = scratchCard(b);
        container.append(c.el);
        if (collect) collect.push({ kind: "scratch", item: b, getText: c.getSql });
      } else if (b.type === "cards") container.append(cardsBlock(b));
      else container.append(callout(b.type, b.title, b.text));
    }
  }

  /* ------------------------------------------------------------------ */
  /* credit track: charts, written answers, scratch pads, flashcards     */
  /* ------------------------------------------------------------------ */

  const CHART_URL = "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js";
  let chartLib = null;
  function loadChartLib() {
    chartLib ||= new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = CHART_URL;
      s.onload = () => resolve(window.Chart);
      s.onerror = () => { chartLib = null; reject(new Error("the chart library didn't load (check your connection)")); };
      document.head.append(s);
    });
    return chartLib;
  }
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function chartConfig(b, res) {
    const col = (name) => {
      const i = res.cols.indexOf(name);
      if (i < 0) throw new Error(`the query has no column "${name}"`);
      return i;
    };
    const xi = col(b.x);
    const palette = ["--accent", "--bad", "--good", "--warn", "--interview", "--r", "--muted"].map(cssVar);
    let labels, datasets;
    if (b.series) {
      const si = col(b.series), yi = col(b.y[0]);
      labels = [...new Set(res.rows.map((r) => r[xi]))];
      const groups = [...new Set(res.rows.map((r) => r[si]))];
      datasets = groups.map((g) => {
        const m = new Map(res.rows.filter((r) => r[si] === g).map((r) => [r[xi], r[yi]]));
        return { label: String(g), data: labels.map((l) => (m.has(l) ? m.get(l) : null)) };
      });
    } else {
      labels = res.rows.map((r) => r[xi]);
      datasets = b.y.map((y) => ({ label: y, data: res.rows.map((r) => r[col(y)]) }));
    }
    datasets.forEach((d, k) => Object.assign(d, {
      borderColor: palette[k % palette.length], backgroundColor: palette[k % palette.length],
      pointRadius: b.chart === "bar" ? 0 : 2, borderWidth: 2, tension: 0.15,
    }));
    const muted = cssVar("--muted"), grid = cssVar("--border");
    const fmt = (v) => (v == null ? "–" : b.percent
      ? (v * 100).toFixed(Math.abs(v) < 0.1 ? 1 : 0) + "%"
      : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString("en-US") : String(Math.round(v * 100) / 100));
    return {
      type: b.chart === "bar" ? "bar" : "line",
      data: { labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: {
          legend: { display: datasets.length > 1, labels: { color: muted, boxWidth: 12 } },
          tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${fmt(ctx.parsed.y)}` } },
        },
        scales: {
          x: { stacked: !!b.stacked, ticks: { color: muted, maxRotation: 0, autoSkipPadding: 12 }, grid: { color: grid } },
          y: { stacked: !!b.stacked, beginAtZero: true, ticks: { color: muted, callback: (v) => fmt(v) }, grid: { color: grid } },
        },
      },
    };
  }

  function chartBlock(b) {
    const wrap = h("div", { class: "chart-canvas" });
    const status = h("div", { class: "muted small" }, "Drawing chart…");
    const fig = h("figure", { class: "chart-card" }, b.title ? h("div", { class: "chart-title" }, b.title) : null, wrap, status);
    if (b.caption) fig.append(h("figcaption", {}, ...md(b.caption).childNodes));
    let chart;
    const draw = async (sql) => {
      try {
        const [Chart, res] = await Promise.all([loadChartLib(), DB.run(sql)]);
        const cfg = chartConfig(b, res);
        if (chart) chart.destroy();
        const canvas = h("canvas");
        wrap.replaceChildren(canvas);
        chart = new Chart(canvas, cfg);
        status.textContent = "";
      } catch (e) {
        status.textContent = "Couldn't draw the chart: " + (e.message || e);
      }
    };
    const details = h("details", { class: "chart-query" }, h("summary", {}, "See or edit the query behind this chart"));
    let r;
    details.addEventListener("toggle", () => {
      if (!details.open || r) return;
      r = runner({ sql: b.sql, extraButtons: [h("button", { class: "btn", onclick: () => draw(r.cm.getValue()) }, "Redraw chart")] });
      details.append(r.el);
    });
    fig.append(details);
    draw(b.sql);
    return fig;
  }

  function explainCard(b) {
    const st = Store.item(b.id);
    const card = h("div", { class: "card explain-card" + (st.text ? " solved" : "") });
    const badge = h("span", { class: "badge explain" }, "Explain");
    card.append(h("div", { class: "card-head" }, badge, h("span", { class: "card-id" }, b.id)));
    const body = h("div", { class: "card-body" });
    const ta = h("textarea", { class: "explain-input", rows: 5, placeholder: "Write it the way you'd say it to an interviewer…" });
    ta.value = st.text || "";
    const saved = h("span", { class: "meta" });
    const modelBox = h("div", { class: "reveal" });
    let t;
    ta.addEventListener("input", () => {
      saved.textContent = "";
      clearTimeout(t);
      t = setTimeout(() => {
        Store.update(b.id, { text: ta.value, status: ta.value.trim() ? "solved" : "new" });
        card.classList.toggle("solved", !!ta.value.trim());
        saved.textContent = "saved";
        refreshNav();
      }, 500);
    });
    const showModel = (ask) => {
      if (modelBox.childElementCount) return;
      if (ask && ta.value.trim().length < 40 &&
          !confirm("Write your own answer first? Comparing after you've committed to an answer is what makes it stick.")) return;
      modelBox.append(h("div", { class: "reveal-title" }, "A strong answer"), md(b.model));
      Store.update(b.id, { modelShown: true });
    };
    const bar = h("div", { class: "runner-bar" },
      b.model ? h("button", { class: "btn btn-ghost", onclick: () => showModel(true) }, "Compare with a strong answer") : null,
      h("span", { class: "spacer" }), saved);
    body.append(md(b.prompt), ta, bar, modelBox);
    card.append(body);
    if (st.modelShown && b.model) showModel(false);
    return { el: card, getText: () => ta.value };
  }

  function scratchCard(b) {
    const st = Store.item(b.id);
    const card = h("div", { class: "card" + (st.draft ? " solved" : "") });
    card.append(h("div", { class: "card-head" }, h("span", { class: "badge scratch" }, "Your analysis"), h("span", { class: "card-id" }, b.id)));
    const body = h("div", { class: "card-body" });
    let t;
    const r = runner({
      sql: st.draft != null ? st.draft : b.starter || "-- your query\n",
      onChange: (v) => {
        clearTimeout(t);
        t = setTimeout(() => { Store.update(b.id, { draft: v, status: v.trim() ? "solved" : "new" }); card.classList.add("solved"); }, 400);
      },
    });
    $(".runner-bar .btn-ghost:last-child", r.el).onclick = () => r.cm.setValue(b.starter || "");
    body.append(md(b.prompt), r.el);
    card.append(body);
    return { el: card, getSql: () => r.cm.getValue() };
  }

  /* Flashcards: shown at the end of a chapter, and scheduled for spaced review. */
  const REVIEW_DAYS = [1, 3, 7, 14, 30];
  const localDay = (offset = 0) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const allCards = () => COURSE.credit.flatMap((c, i) => c.blocks.filter((b) => b.type === "cards")
    .flatMap((b) => b.cards.map((card) => ({ ...card, chapter: c, n: i + 1 }))));
  function enrolCards(chapter) {
    const deck = (Store.state.deck ||= {});
    let added = 0;
    for (const b of chapter.blocks) if (b.type === "cards") for (const c of b.cards) {
      if (!deck[c.id]) { deck[c.id] = { box: 0, due: localDay(1) }; added++; }
    }
    if (added) Store.save();
  }
  const dueCards = () => {
    const deck = Store.state.deck || {}, today = localDay();
    return allCards().filter((c) => deck[c.id] && deck[c.id].due <= today);
  };

  function cardsBlock(b) {
    const box = h("div", { class: "cards-block" },
      h("div", { class: "cards-title" }, "Key ideas: test yourself"),
      h("p", { class: "small muted" }, "Say each answer out loud before you open it. These cards join your review deck and come back on a schedule (1, 3, 7, 14, 30 days)."));
    for (const c of b.cards) {
      box.append(h("details", { class: "flashcard" }, h("summary", {}, c.q), h("div", { class: "flashcard-a" }, ...md(c.a).childNodes)));
    }
    return box;
  }

  /* ------------------------------------------------------------------ */
  /* pages                                                               */
  /* ------------------------------------------------------------------ */

  const lessonItems = (l) => l.blocks.filter((b) => b.type === "exercise" || b.type === "predict");
  const answerItems = (l) => l.blocks.filter((b) => ["exercise", "predict", "explain", "scratch"].includes(b.type));
  const lessonDone = (l) => {
    const items = lessonItems(l);
    return Store.state.lessons[l.id] || (items.length > 0 && items.every((b) => Store.solved(b.id)));
  };
  const TIER_NAME = { 1: "Warm-up", 2: "Core", 3: "Windows & dates", 4: "Risk scenarios" };

  function pageHome() {
    const page = h("div", { class: "page prose" });
    const solvedP = COURSE.problems.filter((p) => Store.solved(p.id)).length;
    const doneL = COURSE.lessons.filter(lessonDone).length;
    const next = COURSE.lessons.find((l) => !lessonDone(l));
    page.append(
      h("div", { class: "lesson-head" },
        h("div", { class: "eyebrow" }, "SQL for analysts who think in dplyr"),
        h("h1", {}, "SQL Screen Prep"),
        h("p", { class: "summary" }, "Relearn SQL from the ground up on a realistic consumer-lending dataset, then practise the way a fintech analytics screen will test you.")),
      h("div", { class: "stat-row" },
        stat(`${doneL}/${COURSE.lessons.length}`, "lessons complete", doneL / COURSE.lessons.length),
        stat(`${solvedP}/${COURSE.problems.length}`, "problems solved", solvedP / COURSE.problems.length),
        stat(String(Store.state.mocks.length), "mock screens taken")),
      next ? h("p", {}, h("a", { class: "btn btn-primary", href: `#/lesson/${next.id}` }, Store.state.last ? "Continue: " : "Start: ", next.title, " →")) : h("p", {}, h("a", { class: "btn btn-primary", href: "#/mock" }, "Take a mock screen →")),
      COURSE.credit.length ? h("div", { class: "callout interview" }, h("div", { class: "callout-title" }, "Credit analytics track"),
        h("div", { class: "callout-body" }, h("p", {}, "Eleven chapters on how a consumer lender makes and loses money, with charts on this data, written exercises, case drills and spaced review. ",
          h("a", { href: "#/credit" }, "Open the overview →")))) : null,
    );
    const home = COURSE.reference.find((r) => r.id === "00-start-here");
    if (home) renderBlocks(home.blocks, page);
    return page;
  }

  function stat(v, l, frac) {
    return h("div", { class: "stat" }, h("div", { class: "v" }, v), h("div", { class: "l" }, l),
      frac != null ? h("div", { class: "bar" }, h("span", { style: `width:${Math.round(frac * 100)}%` })) : null);
  }

  function pageLesson(id) {
    const idx = COURSE.lessons.findIndex((l) => l.id === id);
    const l = COURSE.lessons[idx];
    if (!l) return notFound();
    Store.state.last = location.hash;
    Store.save();
    const page = h("div", { class: "page" });
    const body = h("div", { class: "prose" });
    page.append(h("div", { class: "lesson-head" },
      h("div", { class: "eyebrow" }, `Lesson ${idx} · about ${l.minutes} min`),
      h("h1", {}, l.title),
      l.summary ? h("p", { class: "summary" }, l.summary) : null));
    renderBlocks(l.blocks, body);
    page.append(body);
    const drills = COURSE.drills.filter((d) => [].concat(d.lesson).includes(l.id));
    if (drills.length) {
      page.append(h("div", { class: "callout note" },
        h("div", { class: "callout-title" }, "More practice"),
        h("div", { class: "callout-body" },
          h("p", {}, "Drill this lesson until it's automatic: ",
            ...drills.flatMap((d, i) => [i ? ", " : "", h("a", { href: `#/drill/${d.id}` }, d.title)]),
            ` (${drills.reduce((n, d) => n + lessonItems(d).length, 0)} exercises).`))));
    }
    const prev = COURSE.lessons[idx - 1], next = COURSE.lessons[idx + 1];
    const doneBtn = h("button", {
      class: "btn " + (Store.state.lessons[l.id] ? "btn-good" : ""),
      onclick: () => {
        Store.state.lessons[l.id] = !Store.state.lessons[l.id];
        Store.save();
        doneBtn.className = "btn " + (Store.state.lessons[l.id] ? "btn-good" : "");
        doneBtn.textContent = Store.state.lessons[l.id] ? "✓ Lesson complete" : "Mark lesson complete";
        refreshNav();
      },
    }, Store.state.lessons[l.id] ? "✓ Lesson complete" : "Mark lesson complete");
    page.append(h("div", { class: "lesson-nav" },
      prev ? h("a", { class: "btn", href: `#/lesson/${prev.id}` }, "← ", prev.title) : h("span"),
      doneBtn,
      next ? h("a", { class: "btn btn-primary", href: `#/lesson/${next.id}` }, next.title, " →")
        : h("a", { class: "btn btn-primary", href: "#/problems" }, "Problem bank →")));
    return page;
  }

  function pageDrill(id) {
    const idx = COURSE.drills.findIndex((d) => d.id === id);
    const d = COURSE.drills[idx];
    if (!d) return notFound();
    Store.state.last = location.hash;
    Store.save();
    const items = lessonItems(d);
    const solved = items.filter((b) => Store.solved(b.id)).length;
    const lessons = COURSE.lessons.filter((l) => [].concat(d.lesson).includes(l.id));
    const page = h("div", { class: "page" });
    const body = h("div", { class: "prose" });
    page.append(h("div", { class: "lesson-head" },
      h("div", { class: "eyebrow" }, `Drills · ${items.length} exercises · ${solved} solved`),
      h("h1", {}, d.title),
      d.summary ? h("p", { class: "summary" }, d.summary) : null,
      lessons.length ? h("p", { class: "small muted" }, "Goes with ",
        ...lessons.flatMap((l, i) => [i ? ", " : "", h("a", { href: `#/lesson/${l.id}` }, l.title)]), ".") : null));
    renderBlocks(d.blocks, body);
    page.append(body);
    const prev = COURSE.drills[idx - 1], next = COURSE.drills[idx + 1];
    page.append(h("div", { class: "lesson-nav" },
      prev ? h("a", { class: "btn", href: `#/drill/${prev.id}` }, "← ", prev.title) : h("span"),
      next ? h("a", { class: "btn btn-primary", href: `#/drill/${next.id}` }, next.title, " →")
        : h("a", { class: "btn btn-primary", href: "#/problems" }, "Problem bank →")));
    return page;
  }

  /* Daily sets: five drills, then a plain-text summary to send for review. */
  const latestDaily = () => COURSE.daily[COURSE.daily.length - 1];

  function pageDaily(id) {
    const set = id ? COURSE.daily.find((d) => d.id === id) : latestDaily();
    if (!set) return notFound();
    const items = lessonItems(set);
    const solved = items.filter((b) => Store.solved(b.id)).length;
    const page = h("div", { class: "page" });
    const body = h("div", { class: "prose" });
    page.append(h("div", { class: "lesson-head" },
      h("div", { class: "eyebrow" }, `Daily set · ${set.date || set.id} · ${solved}/${items.length} solved`),
      h("h1", {}, set.title),
      set.summary ? h("p", { class: "summary" }, set.summary) : null));
    const cards = [];
    for (const b of set.blocks) {
      if (b.type === "md") body.append(...md(b.text).childNodes);
      else if (b.type === "exercise") {
        const c = exerciseCard(b, { heading: `${set.interview ? "Question" : "Drill"} ${cards.length + 1}`, hideId: true, bare: !!set.interview });
        cards.push({ item: b, card: c });
        body.append(c.el);
      } else if (b.type === "predict") body.append(predictCard(b));
      else body.append(callout(b.type, b.title, b.text));
    }
    page.append(body);

    const out = h("textarea", { class: "daily-out", readonly: true, rows: 12, placeholder: "Your results appear here." });
    const copyBtn = h("button", {
      class: "btn btn-primary",
      onclick: async () => {
        out.value = dailySummary(set, cards);
        out.style.display = "block";
        try {
          await navigator.clipboard.writeText(out.value);
          toast("Copied: paste it into a message to Claude");
        } catch (e) {
          out.focus();
          out.select();
          toast("Select the text below and copy it");
        }
      },
    }, "Copy results");
    page.append(h("div", { class: "callout note" },
      h("div", { class: "callout-title" }, "Done? Send it for review"),
      h("div", { class: "callout-body" },
        h("p", {}, "Check each drill first (unsolved ones are fine: send your best attempt). Then copy the results and send them, or a photo of them."),
        h("p", {}, copyBtn), out)));

    const others = COURSE.daily.filter((d) => d !== set).reverse();
    if (others.length) {
      page.append(h("div", { class: "small muted", style: "margin-top:24px" }, "Earlier sets: ",
        ...others.flatMap((d, i) => [i ? " · " : "", h("a", { href: `#/daily/${d.id}` }, `${d.title} (${d.date || d.id})`)])));
    }
    return page;
  }

  function dailySummary(set, cards) {
    const lines = [`DAILY SET ${set.id}: ${set.title}`, `Copied ${new Date().toLocaleString()}`, ""];
    cards.forEach(({ item, card }, i) => {
      const st = Store.item(item.id);
      const sql = card.getSql().trim();
      lines.push(
        `[${i + 1}] ${item.id}: ${st.status === "solved" ? "SOLVED" : st.status === "attempted" ? "NOT SOLVED" : "NOT ATTEMPTED"}` +
        ` · ${st.attempts} check${st.attempts === 1 ? "" : "s"} · ${st.hints} hint${st.hints === 1 ? "" : "s"}` +
        (st.revealed ? " · solution revealed" : ""),
        `Last check: ${st.lastResult || "never checked"}`,
        "```sql", sql || "-- (empty)", "```", "");
    });
    return lines.join("\n");
  }

  /* ------------------------------------------------------------------ */
  /* credit analytics pages                                              */
  /* ------------------------------------------------------------------ */

  const chapterDone = (c) => !!Store.state.lessons["credit:" + c.id];

  function answersSummary(title, collected) {
    const lines = [title, `Copied ${new Date().toLocaleString()}`, ""];
    collected.forEach(({ kind, item, getText }, i) => {
      const st = Store.item(item.id);
      if (kind === "predict") {
        const ans = st.answer != null ? item.options[st.answer] : null;
        lines.push(`[${i + 1}] ${item.id} (predict): ${ans ? (ans.correct ? "right" : "wrong") + (st.firstTry === false ? ", not first try" : "") : "not answered"}`, "");
        return;
      }
      const text = (getText ? getText() : "").trim();
      if (kind === "explain") {
        lines.push(`[${i + 1}] ${item.id} (explain)${st.modelShown ? " · compared with strong answer" : ""}`, text || "(blank)", "");
      } else if (kind === "scratch") {
        lines.push(`[${i + 1}] ${item.id} (analysis SQL)`, "```sql", text || "-- (empty)", "```", "");
      } else {
        lines.push(`[${i + 1}] ${item.id}: ${st.status === "solved" ? "SOLVED" : st.status === "attempted" ? "NOT SOLVED" : "NOT ATTEMPTED"}` +
          ` · ${st.attempts || 0} checks · ${st.hints || 0} hints` + (st.revealed ? " · solution revealed" : ""),
          `Last check: ${st.lastResult || "never checked"}`, "```sql", text || "-- (empty)", "```", "");
      }
    });
    return lines.join("\n");
  }

  function copyPanel(title, collected, blurb) {
    const out = h("textarea", { class: "daily-out", readonly: true, rows: 12 });
    const btn = h("button", {
      class: "btn btn-primary",
      onclick: async () => {
        out.value = answersSummary(title, collected);
        out.style.display = "block";
        try { await navigator.clipboard.writeText(out.value); toast("Copied: paste it into a message to Claude"); }
        catch (e) { out.focus(); out.select(); toast("Select the text below and copy it"); }
      },
    }, "Copy my answers");
    return h("div", { class: "callout note" },
      h("div", { class: "callout-title" }, "Send it for review"),
      h("div", { class: "callout-body" }, h("p", {}, blurb), h("p", {}, btn), out));
  }

  function pageCreditHome() {
    const page = h("div", { class: "page prose" });
    const intro = COURSE.prep.find((x) => x.id === "00-credit-start");
    page.append(h("div", { class: "lesson-head" },
      h("div", { class: "eyebrow" }, "Credit analytics"),
      h("h1", {}, intro ? intro.title : "Credit analytics"),
      intro && intro.summary ? h("p", { class: "summary" }, intro.summary) : null));
    const done = COURSE.credit.filter(chapterDone).length;
    const due = dueCards().length;
    page.append(h("div", { class: "stat-row" },
      stat(`${done}/${COURSE.credit.length}`, "chapters complete", COURSE.credit.length ? done / COURSE.credit.length : 0),
      stat(String(due), "cards due for review"),
      stat(`${COURSE.cases.filter((c) => answerItems(c).some((b) => Store.item(b.id).text || Store.item(b.id).draft)).length}/${COURSE.cases.length}`, "case drills started")));
    const next = COURSE.credit.find((c) => !chapterDone(c));
    page.append(h("p", {},
      due ? h("a", { class: "btn btn-primary", href: "#/review" }, `Review ${due} card${due === 1 ? "" : "s"} first →`) : null, " ",
      next ? h("a", { class: due ? "btn" : "btn btn-primary", href: `#/credit/${next.id}` }, "Continue: ", next.title, " →") : null));
    if (intro) renderBlocks(intro.blocks, page);
    const t = h("table", { class: "plist" });
    COURSE.credit.forEach((c, i) => t.append(h("tr", {},
      h("td", { class: "status" }, chapterDone(c) ? "✓" : ""),
      h("td", {}, h("a", { href: `#/credit/${c.id}` }, `${i + 1}. ${c.title}`)),
      h("td", { class: "muted small" }, c.part ? `${c.part} · ` : "", `${c.minutes} min`))));
    page.append(h("h2", {}, "Chapters"), t);
    return page;
  }

  function pageChapter(id) {
    const idx = COURSE.credit.findIndex((c) => c.id === id);
    const c = COURSE.credit[idx];
    if (!c) return notFound();
    Store.state.last = location.hash;
    enrolCards(c);
    const page = h("div", { class: "page" });
    const body = h("div", { class: "prose" });
    page.append(h("div", { class: "lesson-head" },
      h("div", { class: "eyebrow" }, `Credit analytics · Chapter ${idx + 1}${c.part ? " · " + c.part : ""} · about ${c.minutes} min`),
      h("h1", {}, c.title),
      c.summary ? h("p", { class: "summary" }, c.summary) : null));
    const collected = [];
    renderBlocks(c.blocks, body, collected);
    page.append(body);
    if (collected.length) page.append(copyPanel(`CHAPTER ${idx + 1}: ${c.title}`, collected,
      "When you've finished the chapter, copy your answers (SQL, predictions and written answers) and send them. I'll review the reasoning, not just the results."));
    const prev = COURSE.credit[idx - 1], next = COURSE.credit[idx + 1];
    const doneBtn = h("button", {
      class: "btn " + (chapterDone(c) ? "btn-good" : ""),
      onclick: () => {
        Store.state.lessons["credit:" + c.id] = !chapterDone(c);
        Store.save();
        doneBtn.className = "btn " + (chapterDone(c) ? "btn-good" : "");
        doneBtn.textContent = chapterDone(c) ? "✓ Chapter complete" : "Mark chapter complete";
        refreshNav();
      },
    }, chapterDone(c) ? "✓ Chapter complete" : "Mark chapter complete");
    page.append(h("div", { class: "lesson-nav" },
      prev ? h("a", { class: "btn", href: `#/credit/${prev.id}` }, "← ", prev.title) : h("a", { class: "btn", href: "#/credit" }, "← Overview"),
      doneBtn,
      next ? h("a", { class: "btn btn-primary", href: `#/credit/${next.id}` }, next.title, " →")
        : h("a", { class: "btn btn-primary", href: "#/cases" }, "Case drills →")));
    return page;
  }

  function pageCases() {
    const page = h("div", { class: "page prose" });
    page.append(h("div", { class: "lesson-head" }, h("div", { class: "eyebrow" }, "Credit analytics"), h("h1", {}, "Case drills"),
      h("p", { class: "summary" }, "Business questions on the lending data: structure first, then evidence, then a recommendation. About 30 minutes each. The live rounds have no SQL, so treat each query as the data you'd ask the interviewer for, and practise saying the numbers out loud. For pure pen-and-paper practice, use Paper cases.")));
    const t = h("table", { class: "plist" });
    COURSE.cases.forEach((c, i) => {
      const started = answerItems(c).some((b) => Store.item(b.id).text || Store.item(b.id).draft);
      t.append(h("tr", {}, h("td", { class: "status" }, started ? "•" : ""),
        h("td", {}, h("a", { href: `#/case/${c.id}` }, `${i + 1}. ${c.title}`)),
        h("td", { class: "muted small" }, c.summary || "")));
    });
    page.append(t);
    return page;
  }

  function pageCase(id) {
    const idx = COURSE.cases.findIndex((c) => c.id === id);
    const c = COURSE.cases[idx];
    if (!c) return notFound();
    Store.state.last = location.hash;
    const page = h("div", { class: "page" });
    const body = h("div", { class: "prose" });
    page.append(h("div", { class: "lesson-head" },
      h("div", { class: "eyebrow" }, `Case drill ${idx + 1} · about ${c.minutes} min`),
      h("h1", {}, c.title)));
    const collected = [];
    renderBlocks(c.blocks, body, collected);
    page.append(body, copyPanel(`CASE ${idx + 1}: ${c.title}`, collected,
      "Copy your structure, queries and recommendation, and send them. I'll review it the way a hiring manager would."));
    const next = COURSE.cases[idx + 1];
    page.append(h("div", { class: "lesson-nav" }, h("a", { class: "btn", href: "#/cases" }, "← All cases"), h("span"),
      next ? h("a", { class: "btn btn-primary", href: `#/case/${next.id}` }, next.title, " →") : h("span")));
    return page;
  }

  function pagePrep(id) {
    const r = COURSE.prep.find((x) => x.id === id);
    if (!r) return notFound();
    const page = h("div", { class: "page" });
    const body = h("div", { class: "prose" });
    page.append(h("div", { class: "lesson-head" }, h("div", { class: "eyebrow" }, "Interview prep"), h("h1", {}, r.title),
      r.summary ? h("p", { class: "summary" }, r.summary) : null));
    const collected = [];
    renderBlocks(r.blocks, body, collected);
    page.append(body);
    if (collected.length) page.append(copyPanel(r.title.toUpperCase(), collected, "Copy what you wrote and send it for review."));
    return page;
  }

  function pageReview() {
    const page = h("div", { class: "page prose" });
    page.append(h("div", { class: "lesson-head" }, h("div", { class: "eyebrow" }, "Credit analytics"), h("h1", {}, "Review"),
      h("p", { class: "summary" }, "Short, spaced recall of earlier chapters. Cards join the deck when you open a chapter and come back after 1, 3, 7, 14 and 30 days; a miss sends a card back to the start.")));
    const stage = h("div");
    page.append(stage);
    const deck = (Store.state.deck ||= {});
    const startSession = (cards, scheduled) => {
      const queue = [...cards];
      let shown = 0, right = 0;
      const missedOnce = new Set();
      const next = () => {
        if (!queue.length) {
          stage.replaceChildren(h("div", { class: "feedback good" }, h("strong", {}, "Done. "),
            `${right} of ${shown} recalled first time.`, scheduled ? " Come back tomorrow for the next due cards." : ""),
          h("p", {}, h("a", { class: "btn", href: "#/credit" }, "Back to the overview")));
          refreshNav();
          return;
        }
        const c = queue.shift();
        const answer = h("div", { class: "flashcard-a", style: "display:none" }, ...md(c.a).childNodes);
        const grade = (ok) => {
          if (!missedOnce.has(c.id)) { shown++; if (ok) right++; }
          if (scheduled && !missedOnce.has(c.id)) {
            const st = deck[c.id] || { box: 0 };
            const box = ok ? Math.min(st.box + 1, REVIEW_DAYS.length - 1) : 0;
            deck[c.id] = { box, due: localDay(ok ? REVIEW_DAYS[box] : 1) };
            Store.save();
          }
          if (!ok) { missedOnce.add(c.id); queue.push(c); }
          next();
        };
        const buttons = h("div", { class: "runner-bar", style: "display:none" },
          h("button", { class: "btn btn-good", onclick: () => grade(true) }, "I knew it"),
          h("button", { class: "btn", onclick: () => grade(false) }, "Not quite"));
        stage.replaceChildren(h("div", { class: "card review-card" },
          h("div", { class: "card-head" }, h("span", { class: "badge explain" }, `Chapter ${c.n}`), h("span", { class: "card-id" }, `${queue.length} left`)),
          h("div", { class: "card-body" },
            h("div", { class: "review-q" }, ...md(c.q).childNodes),
            h("p", { class: "small muted" }, "Answer out loud first."),
            h("button", { class: "btn btn-primary", onclick: (e) => { answer.style.display = ""; buttons.style.display = ""; e.target.remove(); } }, "Show answer"),
            answer, buttons)));
      };
      next();
    };
    const due = dueCards();
    const enrolled = allCards().filter((c) => deck[c.id]);
    const byChapter = COURSE.credit.filter((ch) => enrolled.some((c) => c.chapter === ch));
    stage.append(
      h("p", {}, due.length ? `${due.length} card${due.length === 1 ? "" : "s"} due today.` :
        enrolled.length ? "Nothing due today. Practising a chapter below doesn't change its schedule." : "No cards yet: open a chapter to add its cards."),
      due.length ? h("p", {}, h("button", { class: "btn btn-primary", onclick: () => startSession(due.sort(() => Math.random() - 0.5), true) }, "Start review")) : null,
      byChapter.length ? h("h2", {}, "Practise a chapter") : null,
      ...byChapter.map((ch) => h("p", {}, h("button", { class: "btn", onclick: () => startSession(enrolled.filter((c) => c.chapter === ch), false) },
        `${COURSE.credit.indexOf(ch) + 1}. ${ch.title}`))));
    return page;
  }

  async function downloadTable(t) {
    try {
      await DB.ready;
      await DB.serial(() => DB.conn.query(`COPY ${t} TO '${t}.csv' (HEADER, DELIMITER ',')`));
      const buf = await DB.db.copyFileToBuffer(`${t}.csv`);
      const a = h("a", { href: URL.createObjectURL(new Blob([buf], { type: "text/csv" })), download: `${t}.csv` });
      document.body.append(a);
      a.click();
      a.remove();
    } catch (e) {
      alert("Couldn't export: " + (e.message || e));
    }
  }

  function pageProblems() {
    const page = h("div", { class: "page prose" });
    page.append(h("h1", {}, "Problem bank"),
      h("p", { class: "summary muted" }, "Interview-style questions in four tiers. Each one is checked against the reference answer. Treat the minutes as a target, not a limit: in a live screen you'd be talking while you type."));
    for (const tier of [1, 2, 3, 4]) {
      const ps = COURSE.problems.filter((p) => p.tier === tier);
      if (!ps.length) continue;
      const solved = ps.filter((p) => Store.solved(p.id)).length;
      page.append(h("h2", {}, `Tier ${tier}: ${TIER_NAME[tier]} `, h("span", { class: "muted small" }, `${solved}/${ps.length} solved`)));
      const t = h("table", { class: "plist" });
      for (const p of ps) {
        const st = Store.state.items[p.id];
        t.append(h("tr", {},
          h("td", { class: "status" }, st?.status === "solved" ? "✓" : st?.status === "attempted" ? h("span", { class: "muted" }, "•") : ""),
          h("td", {}, h("a", { href: `#/problem/${p.id}` }, p.title), h("div", {}, p.topics.map((x) => h("span", { class: "topic" }, x)))),
          h("td", { class: "muted small", style: "white-space:nowrap;text-align:right" }, `~${p.minutes} min`)));
      }
      page.append(t);
    }
    return page;
  }

  function pageProblem(id) {
    const p = COURSE.problems.find((x) => x.id === id);
    if (!p) return notFound();
    Store.state.last = location.hash;
    Store.save();
    const page = h("div", { class: "page" });
    page.append(h("div", { class: "lesson-head" },
      h("div", { class: "eyebrow" }, `Tier ${p.tier} · ${TIER_NAME[p.tier]} · ~${p.minutes} min`),
      h("h1", {}, p.title)));
    const meta = h("div", { class: "problem-meta" }, p.topics.map((x) => h("span", { class: "topic" }, x)));
    page.append(meta);
    const prose = h("div", { class: "prose" });
    prose.append(...md(p.prompt).childNodes);
    if (p.columns) prose.append(h("p", {}, h("strong", {}, "Return: ")), ...md(p.columns).childNodes);
    if (p.clarify) {
      prose.append(h("details", { class: "clarify" },
        h("summary", {}, "Before writing: what would you ask the interviewer? (open after you've thought about it)"),
        ...md(p.clarify).childNodes));
    }
    page.append(prose);
    page.append(exerciseCard({ ...p, prompt: "" }, { mode: "learn" }).el);
    const i = COURSE.problems.indexOf(p);
    const prev = COURSE.problems[i - 1], next = COURSE.problems[i + 1];
    page.append(h("div", { class: "lesson-nav" },
      prev ? h("a", { class: "btn", href: `#/problem/${prev.id}` }, "← ", prev.title) : h("span"),
      h("a", { class: "btn btn-ghost", href: "#/problems" }, "All problems"),
      next ? h("a", { class: "btn btn-primary", href: `#/problem/${next.id}` }, next.title, " →") : h("span")));
    return page;
  }

  function pageReference(id) {
    const r = COURSE.reference.find((x) => x.id === id);
    if (!r) return notFound();
    const page = h("div", { class: "page prose" });
    page.append(h("h1", {}, r.title));
    renderBlocks(r.blocks, page);
    return page;
  }

  /* ---------------- mock screen ---------------- */

  let mockTimer = null;

  function pageMock() {
    const page = h("div", { class: "page prose" });
    const active = Store.state.activeMock;
    if (active) return mockRunning(active);
    page.append(h("h1", {}, "Mock screen"),
      h("p", { class: "summary muted" }, "Simulates a timed SQL screen: a few problems you haven't solved, mixed across topics, no hints, no checking until you hand in. Talk out loud as you work; it's part of the test."));
    const pick = (minutes, plan) => h("button", { class: "tile", style: "text-align:left;cursor:pointer;font:inherit", onclick: () => startMock(minutes, plan) },
      h("div", { class: "t-title" }, `${minutes} minutes`),
      h("div", { class: "t-meta" }, plan.map((t) => `Tier ${t}`).join(" · ")));
    page.append(h("div", { class: "grid" },
      pick(30, [2, 3, 3]),
      pick(45, [2, 3, 3, 4]),
      pick(60, [2, 3, 4, 4])));
    if (Store.state.mocks.length) {
      page.append(h("h2", {}, "Past attempts"));
      const t = h("table", { class: "plist" });
      for (const m of Store.state.mocks.slice().reverse()) {
        t.append(h("tr", {},
          h("td", {}, new Date(m.started).toLocaleString()),
          h("td", {}, `${m.score}/${m.problems.length} correct`),
          h("td", {}, `${Math.round(m.usedSec / 60)} of ${m.minutes} min`),
          h("td", {}, m.problems.map((id) => h("a", { href: `#/problem/${id}`, style: "margin-right:8px" }, id)))));
      }
      page.append(t);
    }
    return page;
  }

  function startMock(minutes, plan) {
    const used = new Set();
    const problems = [];
    for (const tier of plan) {
      const pool = COURSE.problems.filter((p) => p.tier === tier && !used.has(p.id));
      const fresh = pool.filter((p) => !Store.solved(p.id) && !Store.item(p.id).revealed);
      const from = fresh.length ? fresh : pool;
      if (!from.length) continue;
      const p = from[Math.floor(Math.random() * from.length)];
      used.add(p.id);
      problems.push(p.id);
    }
    Store.state.activeMock = { minutes, problems, started: Date.now(), drafts: {} };
    Store.save();
    route();
  }

  function mockRunning(m) {
    const page = h("div", { class: "page" });
    const clock = h("span", { class: "clock" });
    const tabs = h("div", { class: "tabs" });
    const area = h("div");
    const finish = h("button", { class: "btn btn-primary", onclick: () => { if (confirm("Hand in now?")) gradeMock(); } }, "Hand in");
    page.append(h("div", { class: "timer" }, clock, tabs, h("span", { style: "flex:1" }), finish), area);

    const cards = m.problems.map((id, i) => {
      const p = COURSE.problems.find((x) => x.id === id);
      const wrap = h("div", { style: i ? "display:none" : "" });
      const prose = h("div", { class: "prose" });
      prose.append(h("h2", { style: "margin-top:0" }, `Question ${i + 1}`), ...md(p.prompt).childNodes);
      if (p.columns) prose.append(h("p", {}, h("strong", {}, "Return: ")), ...md(p.columns).childNodes);
      const item = { ...p, id: "mock:" + p.id, prompt: "", hints: [], starter: m.drafts[p.id] || "-- Question " + (i + 1) + "\n" };
      const card = exerciseCard(item, { mode: "mock" });
      card.cm.on("change", () => { m.drafts[p.id] = card.cm.getValue(); Store.save(); });
      wrap.append(prose, card.el);
      area.append(wrap);
      tabs.append(h("button", { class: "tab" + (i ? "" : " active"), onclick: (ev) => {
        [...area.children].forEach((c, j) => (c.style.display = j === i ? "" : "none"));
        [...tabs.children].forEach((t, j) => t.classList.toggle("active", j === i));
        card.cm.refresh();
      } }, `Q${i + 1}`));
      return { p, card };
    });

    const tick = () => {
      const left = m.minutes * 60 - Math.floor((Date.now() - m.started) / 1000);
      if (left <= 0) { clearInterval(mockTimer); toast("Time's up."); gradeMock(); return; }
      clock.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
      clock.classList.toggle("low", left < 300);
    };
    clearInterval(mockTimer);
    mockTimer = setInterval(tick, 1000);
    tick();
    page._cards = cards;
    return page;
  }

  async function gradeMock() {
    clearInterval(mockTimer);
    const m = Store.state.activeMock;
    if (!m) return;
    const results = [];
    for (const id of m.problems) {
      const p = COURSE.problems.find((x) => x.id === id);
      const sql = m.drafts[id] || "";
      let ok = false, why = "No answer";
      try {
        const mine = await DB.run(sql);
        const cmp = compareResults(mine, await expectedFor(p), p);
        ok = cmp.ok;
        why = ok ? "Correct" : cmp.title;
      } catch (e) {
        if (sql.trim() && !/^\s*--[^\n]*\s*$/.test(sql)) why = "Error: " + prettyError(e).split("\n")[0];
      }
      if (ok && !Store.solved(id)) Store.update(id, { status: "solved", solvedAt: new Date().toISOString() });
      Store.update(id, { draft: sql });
      results.push({ id, ok, why });
    }
    const usedSec = Math.min(m.minutes * 60, Math.round((Date.now() - m.started) / 1000));
    Store.state.mocks.push({ started: m.started, minutes: m.minutes, problems: m.problems, score: results.filter((r) => r.ok).length, usedSec, results });
    delete Store.state.activeMock;
    Store.save();
    refreshNav();
    const page = h("div", { class: "page prose" });
    page.append(h("h1", {}, "Mock results"),
      h("div", { class: "stat-row" }, stat(`${results.filter((r) => r.ok).length}/${results.length}`, "correct"), stat(`${Math.round(usedSec / 60)} min`, `of ${m.minutes}`)));
    const t = h("table", { class: "plist" });
    results.forEach((r, i) => {
      const p = COURSE.problems.find((x) => x.id === r.id);
      t.append(h("tr", {}, h("td", { class: "status" }, r.ok ? "✓" : "✗"),
        h("td", {}, h("a", { href: `#/problem/${r.id}` }, `Q${i + 1}. ${p.title}`), h("div", { class: "muted small" }, r.why))));
    });
    page.append(t, h("p", { class: "muted" }, "Open each problem to compare with the reference solution. Your mock answer is loaded in its editor. Redo misses tomorrow, from a blank editor."));
    $("#main").replaceChildren(page);
  }

  /* ---------------- progress ---------------- */

  function pageProgress() {
    const page = h("div", { class: "page prose" });
    page.append(h("h1", {}, "Progress"));
    const t = h("table", { class: "plist" });
    for (const [i, l] of COURSE.lessons.entries()) {
      const items = lessonItems(l);
      const done = items.filter((b) => Store.solved(b.id)).length;
      t.append(h("tr", {}, h("td", { class: "status" }, lessonDone(l) ? "✓" : ""),
        h("td", {}, h("a", { href: `#/lesson/${l.id}` }, `${i}. ${l.title}`)),
        h("td", { class: "muted small" }, `${done}/${items.length} exercises`)));
    }
    page.append(h("h2", {}, "Lessons"), t);
    const td = h("table", { class: "plist" });
    for (const d of COURSE.drills) {
      const items = lessonItems(d);
      const done = items.filter((b) => Store.solved(b.id)).length;
      td.append(h("tr", {}, h("td", { class: "status" }, done === items.length ? "✓" : ""),
        h("td", {}, h("a", { href: `#/drill/${d.id}` }, d.title)),
        h("td", { class: "muted small" }, `${done}/${items.length} exercises`)));
    }
    if (COURSE.drills.length) page.append(h("h2", {}, "Drills"), td);
    const struggled = Object.entries(Store.state.items)
      .filter(([id, s]) => !id.startsWith("mock:") && (s.revealed || s.attempts >= 3 || (s.status !== "solved" && s.attempts > 0)))
      .map(([id]) => id);
    if (struggled.length) {
      page.append(h("h2", {}, "Worth redoing"),
        h("p", { class: "muted" }, "Items where you revealed the solution, needed 3+ attempts, or haven't solved yet. Redo them from a blank editor a day later: that's when it sticks."));
      const ul = h("ul");
      for (const id of struggled) {
        const p = COURSE.problems.find((x) => x.id === id);
        const l = COURSE.lessons.find((x) => x.blocks.some((b) => b.id === id));
        const d = COURSE.drills.find((x) => x.blocks.some((b) => b.id === id));
        const href = p ? `#/problem/${id}` : l ? `#/lesson/${l.id}` : d ? `#/drill/${d.id}` : null;
        if (href) ul.append(h("li", {}, h("a", { href }, p ? p.title : `${(l || d).title}: ${id}`)));
      }
      page.append(ul);
    }
    page.append(h("h2", {}, "Save or move your progress"),
      h("p", {}, "Progress is stored in this browser only. Export it to a file to back it up or carry it to another computer."),
      h("p", {},
        h("button", { class: "btn", onclick: exportProgress }, "Export progress"), " ",
        h("label", { class: "btn" }, "Import progress", h("input", { type: "file", accept: ".json", style: "display:none", onchange: importProgress })), " ",
        h("button", { class: "btn btn-ghost", onclick: () => { if (confirm("Erase all progress in this browser?")) { localStorage.removeItem(STORE_KEY); location.reload(); } } }, "Reset everything")),
      h("h2", {}, "Download the data"),
      h("p", {}, "Each table as a CSV file, for working in R or another tool (e.g. the mock take-home)."),
      h("p", {}, ...TABLES.flatMap((t) => [h("button", { class: "btn", onclick: () => downloadTable(t) }, t), " "])),
      h("h2", {}, "Database"),
      h("p", {}, "If you changed or dropped a table while experimenting, reload the original data."),
      h("p", {}, h("button", { class: "btn", onclick: async () => { await DB.reset(); toast("Data reloaded"); } }, "Reload data")));
    return page;
  }

  function exportProgress() {
    const blob = new Blob([JSON.stringify(Store.state, null, 1)], { type: "application/json" });
    const a = h("a", { href: URL.createObjectURL(blob), download: `sql-prep-progress-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a);
    a.click();
    a.remove();
  }

  function importProgress(ev) {
    const f = ev.target.files[0];
    if (!f) return;
    f.text().then((txt) => {
      const data = JSON.parse(txt);
      if (!data.items) throw new Error("not a progress file");
      Store.state = Object.assign({ items: {}, lessons: {}, mocks: [] }, data);
      Store.save();
      toast("Progress imported");
      route();
      refreshNav();
    }).catch((e) => alert("Couldn't import: " + e.message));
  }

  function notFound() {
    return h("div", { class: "page" }, h("h1", {}, "Not found"), h("p", {}, h("a", { href: "#/" }, "Home")));
  }

  /* ------------------------------------------------------------------ */
  /* navigation and schema                                               */
  /* ------------------------------------------------------------------ */

  function refreshNav() {
    const nav = $("#sidebar");
    const cur = location.hash || "#/";
    const link = (href, label, extra) => h("a", { class: "nav-link" + (cur === href ? " active" : ""), href }, label, extra);
    const sec = (title, ...links) => h("div", { class: "nav-section" }, h("div", { class: "nav-head" }, title), ...links);
    const refs = COURSE.reference.filter((r) => r.id !== "00-start-here");
    const solvedP = COURSE.problems.filter((p) => Store.solved(p.id)).length;
    nav.replaceChildren(
      sec("Course", link("#/", "Start here")),
      sec("Lessons", ...COURSE.lessons.map((l, i) => link(`#/lesson/${l.id}`,
        [h("span", { class: "nav-num" }, String(i)), l.title],
        lessonDone(l) ? h("span", { class: "nav-check" }, "✓") : h("span", { class: "nav-meta" }, `${l.minutes}m`)))),
      sec("Drills", ...COURSE.drills.map((d) => {
        const items = lessonItems(d);
        const done = items.filter((b) => Store.solved(b.id)).length;
        return link(`#/drill/${d.id}`, d.title, h("span", { class: done === items.length ? "nav-check" : "nav-meta" }, done === items.length ? "✓" : `${done}/${items.length}`));
      })),
      sec("Practice",
        latestDaily() ? link("#/daily", "Daily set", (() => {
          const items = lessonItems(latestDaily());
          const done = items.filter((b) => Store.solved(b.id)).length;
          return h("span", { class: done === items.length ? "nav-check" : "nav-meta" }, done === items.length ? "✓" : `${done}/${items.length}`);
        })()) : null,
        link("#/problems", "Problem bank", h("span", { class: "nav-meta" }, `${solvedP}/${COURSE.problems.length}`)),
        link("#/mock", Store.state.activeMock ? "Mock screen (in progress)" : "Mock screen")),
      COURSE.credit.length ? sec("Credit analytics",
        link("#/credit", "Overview"),
        ...COURSE.credit.map((c, i) => link(`#/credit/${c.id}`, [h("span", { class: "nav-num" }, String(i + 1)), c.title],
          chapterDone(c) ? h("span", { class: "nav-check" }, "✓") : h("span", { class: "nav-meta" }, `${c.minutes}m`))),
        link("#/review", "Review", (() => { const n = dueCards().length; return n ? h("span", { class: "nav-due" }, `${n} due`) : null; })()),
        COURSE.cases.length ? link("#/cases", "Case drills", h("span", { class: "nav-meta" }, String(COURSE.cases.length))) : null,
        ...COURSE.prep.filter((r) => r.id !== "00-credit-start").map((r) => link(`#/prep/${r.id}`, r.title))) : null,
      sec("Reference", ...refs.map((r) => link(`#/ref/${r.id}`, r.title))),
      sec("You", link("#/progress", "Progress & backup")));
  }

  const SCHEMA_NOTES = {
    merchants: "one row per merchant",
    borrowers: "one row per borrower account",
    applications: "one row per credit application",
    loans: "one row per loan",
    installments: "one row per scheduled payment (loan_id + installment_number)",
    payments: "one row per payment attempt (supposedly)",
    loan_month: "one row per loan per month-end while open (loan_id + as_of_date)",
    merchant_terms: "one row per merchant: illustrative fee rates",
  };

  async function renderSchema() {
    const el = $("#schema");
    el.replaceChildren(h("div", { class: "muted" }, "Loading…"));
    await DB.ready;
    const parts = [h("div", { class: "small muted", style: "margin-bottom:12px" }, "Data as of 2025-12-31. Full notes: ", h("a", { href: "#/ref/01-the-data" }, "The data"), ".")];
    for (const t of TABLES) {
      const cols = await DB.serial(() => DB.raw(`DESCRIBE ${t}`));
      const n = (await DB.serial(() => DB.raw(`SELECT count(*)::INTEGER AS n FROM ${t}`)))[0].n;
      parts.push(h("div", { class: "schema-table" },
        h("h3", {}, t, h("span", { class: "muted small", style: "font-weight:400" }, `  ${fmtInt(n)} rows`)),
        h("div", { class: "grain" }, SCHEMA_NOTES[t]),
        h("table", { class: "schema-cols" }, cols.map((c) => h("tr", {},
          h("td", { class: /_id$|installment_number|as_of_date/.test(c.column_name) ? "key" : "" }, c.column_name),
          h("td", {}, c.column_type.toLowerCase()))))));
    }
    el.replaceChildren(...parts);
  }

  /* ------------------------------------------------------------------ */
  /* router                                                              */
  /* ------------------------------------------------------------------ */

  function route() {
    clearInterval(mockTimer);
    const [, kind, id] = (location.hash || "#/").split("/");
    let page;
    if (!kind) page = pageHome();
    else if (kind === "lesson") page = pageLesson(id);
    else if (kind === "drill") page = pageDrill(id);
    else if (kind === "daily") page = pageDaily(id);
    else if (kind === "credit") page = id ? pageChapter(id) : pageCreditHome();
    else if (kind === "case") page = pageCase(id);
    else if (kind === "cases") page = pageCases();
    else if (kind === "prep") page = pagePrep(id);
    else if (kind === "review") page = pageReview();
    else if (kind === "problems") page = pageProblems();
    else if (kind === "problem") page = pageProblem(id);
    else if (kind === "mock") page = pageMock();
    else if (kind === "progress") page = pageProgress();
    else if (kind === "ref") page = pageReference(id);
    else page = notFound();
    $("#main").replaceChildren(page);
    refreshNav();
    $("#sidebar").classList.remove("open");
    window.scrollTo(0, 0);
  }

  function boot() {
    if (COURSE) { COURSE.drills ||= []; COURSE.daily ||= []; COURSE.credit ||= []; COURSE.cases ||= []; COURSE.prep ||= []; }
    if (!COURSE || !window.COURSE_DATA) {
      document.body.innerHTML = "<p style='padding:2em'>Course files are missing (app/content.js, app/data.js).</p>";
      return;
    }
    Store.load();
    DB.init().catch(() => {});
    window.addEventListener("hashchange", route);
    $("#navToggle").onclick = () => $("#sidebar").classList.toggle("open");
    $("#schemaBtn").onclick = () => {
      const s = $("#schema");
      s.classList.toggle("open");
      s.setAttribute("aria-hidden", !s.classList.contains("open"));
      if (s.classList.contains("open") && !s.dataset.loaded) { s.dataset.loaded = "1"; renderSchema(); }
    };
    route();
  }

  // exposed for automated tests
  window.__sqlprep = { DB, compareResults, Store };

  boot();
})();
