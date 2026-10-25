/* Tripwire dashboard — vanilla JS, no deps, no build step.
 * Data: GET /api/runs, /api/stats, /api/history, /api/health on load, then SSE /api/stream
 * (docs/MASTER.md §6.3). One setInterval(1000) drives every timer on the page.
 *
 * Design rule: colour means something. Only the 4 operations (Nudge, Downgrade, Pause, Stop)
 * and the good outcomes (Finished, Recovered) are coloured; everything else is greyscale.
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------- the 4 operations
  const OPS = {
    nudge: { n: 1, name: "Nudge", meaning: "warned the agent it's stuck",
      long: "Adds a short warning to the agent's instructions so it can fix itself." },
    downgrade: { n: 2, name: "Downgrade", meaning: "switched to a cheaper model",
      long: "Moves the agent to a cheaper AI model so a struggling run costs less." },
    pause: { n: 3, name: "Pause", meaning: "waiting for you to decide",
      long: "Holds the agent until you click Approve or Stop. Stops it automatically if nobody decides." },
    stop: { n: 4, name: "Stop", meaning: "ended the run",
      long: "Ends the run gracefully: the agent gets a normal reply telling it to stop and why." },
  };
  const OP_ORDER = ["nudge", "downgrade", "pause", "stop"];
  const opKey = (a) => (a === "kill" ? "stop" : OPS[a] ? a : null);
  const OUTCOME = { finished: "Finished", recovered: "Recovered" };

  const DETECTOR_LABEL = {
    repeat_tool_call: "repeating the same call",
    oscillation: "going back and forth",
    repeat_error: "same error again and again",
    semantic_loop: "saying the same thing over",
    context_bloat: "prompt growing too big",
    done_but_continuing: "said done but kept going",
    budget: "on track to overspend",
  };

  // ---------------------------------------------------------------- state
  const LS = {
    get(k, d) { try { const v = localStorage.getItem("tw." + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("tw." + k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } },
  };
  const S = {
    runs: new Map(),        // id -> summary
    applied: new Map(),     // id -> {nudge: ts, downgrade: ts, pause: ts, stop: ts}
    stats: null,
    history: [],            // newest first
    histUnseen: 0,
    drawerId: null,
    drawerTab: "timeline",
    es: null, retry: 0, hadError: false,
    pauseTimeout: 180,
    pageStart: Date.now(),
    view: LS.get("view", "runs"),
    filter: LS.get("filter", "all"),
    sort: LS.get("sort", "status"),
    q: "",
    showDone: false,
    hf: { chip: "all", run: "", q: "" },
    histLimit: 200,
    freshIds: new Set(),
  };
  const TERMINAL = new Set(["killed", "completed"]);
  const COLLAPSE_DONE_OVER = 12; // in "All", hide finished/stopped runs behind a toggle beyond this many
  const FILTERS = {
    all: () => true,
    needs: (r) => r.status === "paused",
    running: (r) => !TERMINAL.has(r.status) && r.status !== "paused",
    finished: (r) => r.status === "completed",
    stopped: (r) => r.status === "killed",
  };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const el = {
    rows: $("#rows"), runsEmpty: $("#runs-empty"), needs: $("#needs"),
    hist: $("#hist"), histEmpty: $("#hist-empty"), histCount: $("#hist-count"), histNew: $("#hist-new"),
    histRun: $("#hist-run"), histQ: $("#hist-q"), histShown: $("#hist-shown"), hchips: $("#hchips"),
    conn: $("#conn"), reset: $("#reset-btn"), session: $("#session-time"), legend: $("#legend"), help: $("#help-btn"),
    drawer: $("#drawer"), backdrop: $("#drawer-backdrop"), drawerBody: $("#drawer-body"),
    drawerName: $("#drawer-name"), drawerGoal: $("#drawer-goal"),
    drawerSummary: $("#drawer-summary"), drawerRaw: $("#drawer-raw"), toast: $("#toast"),
  };

  // ---------------------------------------------------------------- utils
  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  const num = (v, d) => (typeof v === "number" && isFinite(v) ? v : (d || 0));
  function money(v) {
    v = num(v);
    if (v !== 0 && Math.abs(v) < 0.01) return "$" + v.toFixed(3);
    if (Math.abs(v) >= 1000) return "$" + v.toLocaleString(undefined, { maximumFractionDigits: 0 });
    return "$" + v.toFixed(2);
  }
  function compact(n) {
    n = num(n);
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k";
    return String(n);
  }
  const toDate = (ts) => (ts ? new Date(ts > 1e12 ? ts : ts * 1000) : new Date());
  const clock = (ts) => toDate(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  function dayLabel(ts) {
    const d = toDate(ts), now = new Date();
    const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((start(now) - start(d)) / 86400000);
    if (diff === 0) return "Today";
    if (diff === 1) return "Yesterday";
    return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
  }
  function dur(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(s).padStart(2, "0");
  }
  function trunc(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
  function argsStr(a) {
    if (a == null) return "";
    try { return typeof a !== "object" ? String(a) : Object.keys(a).map((k) => k + "=" + JSON.stringify(a[k])).join(", "); }
    catch (e) { return String(a); }
  }
  // Users see "stop", never "kill".
  const plain = (s) => String(s == null ? "" : s)
    .replace(/\bkilled\b/g, "stopped").replace(/\bKilled\b/g, "Stopped")
    .replace(/\bkilling\b/g, "stopping").replace(/\bkill\b/g, "stop").replace(/\bKill\b/g, "Stop");
  // "repeat_error: Your calls…" -> {tag: "same error again and again", text: "Your calls…"}
  function prettyReason(reason) {
    let r = String(reason || "").trim(), tag = "";
    r = r.replace(/^killed by human( from dashboard| while paused)?\s*/i, "")
      .replace(/^paused for human review and no response within [\d.]+s\s*/i, "")
      .replace(/^\((.*)\)$/s, "$1");
    const m2 = r.match(/^(still stuck after (?:a nudge|human approval)[^:]*):\s*(?:([a-z]+(?:_[a-z]+)+):\s*)?(.*)$/is);
    if (m2) { tag = m2[1].replace(/, needs a human/i, "") + (m2[2] && DETECTOR_LABEL[m2[2]] ? " · " + DETECTOR_LABEL[m2[2]] : ""); r = m2[3]; }
    const m = r.match(/^([a-z]+(?:_[a-z]+)+|budget|oscillation):\s*(.*)$/s);
    if (m) { tag = DETECTOR_LABEL[m[1]] || m[1].replace(/_/g, " "); r = m[2]; }
    r = plain(r);
    if (r) r = r[0].toUpperCase() + r.slice(1);
    if (tag) tag = tag[0].toUpperCase() + tag.slice(1);
    return { tag, text: r };
  }
  const runName = (id) => { const r = S.runs.get(id); return (r && (r.name || r.id)) || id || "agent"; };

  async function api(path, opts) {
    const res = await fetch(path, Object.assign({ headers: { "Content-Type": "application/json" } }, opts || {}));
    if (!res.ok) {
      let msg = res.status + " " + res.statusText;
      try { const t = await res.text(); if (t) msg += " — " + trunc(t, 140); } catch (e) { /* ignore */ }
      throw new Error(msg);
    }
    const ct = res.headers.get("content-type") || "";
    return ct.includes("json") ? res.json() : res.text();
  }

  let toastTimer = null;
  function toast(msg, bad) {
    el.toast.textContent = msg;
    el.toast.className = "toast" + (bad ? " bad" : "");
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 3200);
  }

  // Two-click confirmation for destructive buttons (no blocking browser dialogs).
  function armed(btn, confirmText, fn) {
    if (btn._armed) {
      clearTimeout(btn._armed); btn._armed = null;
      btn.textContent = btn._orig; btn.classList.remove("confirm");
      fn(); return;
    }
    btn._orig = btn.textContent;
    btn.textContent = confirmText;
    btn.classList.add("confirm");
    btn._armed = setTimeout(() => { btn._armed = null; btn.textContent = btn._orig; btn.classList.remove("confirm"); }, 3500);
  }

  // A small coloured label. kind: nudge|downgrade|pause|stop|finished|recovered|human|neutral
  const chip = (kind, label, tip) => '<span class="chip c-' + kind + '"' + (tip ? ' title="' + esc(tip) + '"' : "") + "><i></i>" + esc(label) + "</span>";
  const opChip = (k) => chip(k, OPS[k].name, OPS[k].name + ": " + OPS[k].meaning);

  // ---------------------------------------------------------------- legend popover
  function renderLegend() {
    $("#legend-list").innerHTML = OP_ORDER.map((k, i) => {
      const o = OPS[k];
      const long = k === "pause" ? "Holds the agent until you click Approve or Stop. Stops it automatically after " + dur(S.pauseTimeout) + " if nobody decides." : o.long;
      return '<li><span class="lg-n">' + (i + 1) + "</span>" + opChip(k) + '<span><b class="lg-mean">' + esc(o.meaning) + '</b><span class="muted">' + esc(long) + "</span></span></li>";
    }).join("");
  }
  function setLegend(open) {
    el.legend.hidden = !open;
    el.help.setAttribute("aria-expanded", String(open));
    el.help.classList.toggle("on", open);
    LS.set("legend", open);
  }
  el.help.addEventListener("click", (e) => { e.stopPropagation(); setLegend(el.legend.hidden); });
  $("#legend-close").addEventListener("click", () => setLegend(false));
  document.addEventListener("click", (e) => { if (!el.legend.hidden && !el.legend.contains(e.target) && e.target !== el.help) setLegend(false); });

  // ---------------------------------------------------------------- applied operations per run
  function markApplied(id, op, ts) {
    if (!id || !op) return;
    let a = S.applied.get(id);
    if (!a) { a = {}; S.applied.set(id, a); }
    if (!a[op] || (ts && ts < a[op])) a[op] = ts || Date.now() / 1000;
  }
  function absorbEvent(e) {
    if (!e || !e.run_id) return;
    const r = S.runs.get(e.run_id);
    if (r && num(e.ts) && num(r.created_at) && e.ts < r.created_at - 1) return; // an older run with the same id
    const d = e.data || {};
    if (e.type === "intervention") {
      markApplied(e.run_id, opKey(d.action), e.ts);
      const k = opKey(d.action);
      if (k) { const a = S.applied.get(e.run_id); a._why = a._why || {}; if (!a._why[k]) a._why[k] = d.reason || ""; }
    } else if (e.type === "killed" || (e.type === "human_action" && d.action === "kill")) markApplied(e.run_id, "stop", e.ts);
  }
  function appliedFor(r) {
    const a = Object.assign({}, S.applied.get(r.id) || {});
    if (num(r.nudges_sent) > 0 && !a.nudge) a.nudge = -1;
    if (r.original_model && r.model && r.original_model !== r.model && !a.downgrade) a.downgrade = -1;
    if (r.status === "paused" && !a.pause) a.pause = -1;
    if (r.status === "killed" && !a.stop) a.stop = -1;
    const la = r.last_action && opKey(r.last_action.action);
    if (la && !a[la]) a[la] = num(r.last_action.ts, -1);
    return a;
  }

  // What a run is doing, in plain English. short = list row, head/why = drawer.
  function stateOf(r) {
    const a = appliedFor(r);
    const la = r.last_action || null;
    const lr = la ? prettyReason(la.reason) : { tag: "", text: "" };
    const nudged = num(r.nudges_sent) > 0 || !!a.nudge;
    const signals = Array.isArray(r.signals) ? r.signals.slice().sort((x, y) => num(y.severity) - num(x.severity)) : [];
    switch (r.status) {
      case "paused":
        return { kind: "pause", op: "pause", short: "Paused — waiting for you" + (lr.tag ? " · " + lr.tag.toLowerCase() : ""),
          head: "Paused: waiting for your decision.", why: lr.text, tag: lr.tag };
      case "killed": {
        const kr = String(r.kill_reason || "");
        const p = prettyReason(kr || (la && la.reason) || "");
        const byYou = /^killed by human/i.test(kr), timeout = /no response within/i.test(kr);
        const short = byYou ? "Stopped by you" : timeout ? "Stopped: nobody decided in time" : "Stopped by Tripwire" + (p.tag ? " · " + p.tag.toLowerCase() : p.text ? " · " + trunc(p.text.split(/[:.]/)[0], 48).toLowerCase() : "");
        const head = byYou ? "Stopped: you ended the run." : timeout ? "Stopped: nobody decided in time, so Tripwire ended the run." : "Stopped: Tripwire ended the run.";
        return { kind: "stop", op: "stop", short, head, why: p.text, tag: timeout ? "Pause timed out" : p.tag, saved: num(r.saved_usd) };
      }
      case "downgraded":
        return { kind: "downgrade", op: "downgrade", short: "Downgraded to " + (r.model || "a cheaper model") + (lr.tag ? " · " + lr.tag.toLowerCase() : ""),
          head: "Downgraded: switched to the cheaper model " + (r.model || "") + ".", why: lr.text, tag: lr.tag };
      case "nudged":
        return { kind: "nudge", op: "nudge", short: "Nudged — watching if it recovers" + (lr.tag ? " · " + lr.tag.toLowerCase() : ""),
          head: "Nudged: warned the agent it's stuck. Watching whether it recovers.", why: lr.text, tag: lr.tag };
      case "completed":
        if (nudged) return { kind: "recovered", outcome: "recovered", short: "Nudged, recovered and finished", head: "Nudged, then recovered on its own and finished.", why: "No human was needed." };
        if (a.downgrade) return { kind: "finished", outcome: "finished", short: "Finished on the cheaper model", head: "Finished on the cheaper model.", why: "Downgraded to save money, then completed." };
        if (a.pause) return { kind: "finished", outcome: "finished", short: "Finished after your approval", head: "Finished after you approved it.", why: "" };
        return { kind: "finished", outcome: "finished", short: "Finished normally", head: "Finished normally, no help needed.", why: "" };
      default:
        if (a.pause) return { kind: "neutral", short: "Running — approved by you", head: "Running again after your approval.", why: "If it gets stuck again, Tripwire will stop it." };
        if (nudged) return { kind: "recovered", outcome: "recovered", short: "Nudged, recovered — running", head: "Nudged, then recovered on its own. Running normally.", why: lr.text ? "It was: " + lr.text : "" };
        if (signals.length) {
          const t = DETECTOR_LABEL[signals[0].detector] || "something looks off";
          return { kind: "neutral", short: "Running · watching: " + t, head: "Running. Keeping an eye on something.", why: signals[0].message || "", tag: t[0].toUpperCase() + t.slice(1) };
        }
        return { kind: "neutral", short: "Running normally", head: "Running normally. No problems spotted.", why: "" };
    }
  }

  // 4 small dots: filled = used, ringed = happening now, hollow = not used.
  function ladderDots(r, st) {
    const a = appliedFor(r);
    return '<span class="ladder" aria-label="Escalation ladder">' + OP_ORDER.map((k) => {
      const o = OPS[k];
      const cls = st.op === k && !TERMINAL.has(r.status) ? "now" : a[k] ? "used" : "";
      const tip = o.name + (cls === "now" ? ": happening now" : a[k] ? ": used" + (a[k] > 0 ? " at " + clock(a[k]) : "") : ": not used") + " (" + o.meaning + ")";
      return '<i class="ld c-' + k + (cls ? " " + cls : "") + '" title="' + esc(tip) + '"></i>';
    }).join("") + "</span>";
  }

  // ---------------------------------------------------------------- runs list
  function upsertRun(sum) {
    if (!sum || !sum.id) return;
    const prev = S.runs.get(sum.id);
    if (prev && num(prev.created_at) && num(sum.created_at) && sum.created_at > prev.created_at + 1) S.applied.delete(sum.id); // new run, same id
    S.runs.set(sum.id, sum);
    scheduleRender();
    if (S.drawerId === sum.id) renderDrawerHead(sum);
  }

  let renderPending = false;
  function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    // setTimeout (not requestAnimationFrame) so a background tab still stays current.
    setTimeout(() => { renderPending = false; renderRuns(); renderNeeds(); renderSummary(); updateRunOptions(); }, 60);
  }

  const PRIORITY = { paused: 0, nudged: 1, downgraded: 1, running: 2, killed: 3, completed: 3 };
  function sortRuns(list) {
    const by = {
      status: (a, b) => (num(PRIORITY[a.status], 2) - num(PRIORITY[b.status], 2)) || (num(b.created_at) - num(a.created_at)),
      newest: (a, b) => num(b.created_at) - num(a.created_at),
      cost: (a, b) => num(b.spent_usd) - num(a.spent_usd),
      stuck: (a, b) => num(b.stuck_score) - num(a.stuck_score) || num(b.level) - num(a.level),
      name: (a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)),
    }[S.sort] || ((a, b) => 0);
    return list.sort(by);
  }

  function counts() {
    const c = { all: 0, needs: 0, running: 0, finished: 0, stopped: 0 };
    S.runs.forEach((r) => Object.keys(FILTERS).forEach((k) => { if (FILTERS[k](r)) c[k]++; }));
    return c;
  }

  function rowCache(id) {
    let n = el.rows.querySelector('.row[data-id="' + CSS.escape(id) + '"]');
    if (!n) {
      n = document.createElement("div");
      n.className = "row";
      n.dataset.id = id;
      n.setAttribute("role", "row");
      n.tabIndex = 0;
    }
    return n;
  }

  function renderRuns() {
    if (!FILTERS[S.filter]) S.filter = "all";
    const c = counts();
    $$("[data-count]").forEach((b) => { b.textContent = c[b.dataset.count]; });
    $$(".ftab").forEach((t) => { const on = t.dataset.filter === S.filter; t.classList.toggle("active", on); t.setAttribute("aria-selected", String(on)); });
    $(".ftab-needs").classList.toggle("has", c.needs > 0);
    $("#runs-count").textContent = c.all;

    const q = S.q;
    let list = Array.from(S.runs.values()).filter((r) => FILTERS[S.filter](r));
    if (q) list = list.filter((r) => [r.name, r.id, r.goal].join(" ").toLowerCase().includes(q));
    sortRuns(list);

    // In "All", once there are many, tuck finished/stopped runs behind a toggle so live work stays visible.
    let hiddenDone = 0;
    if (S.filter === "all" && !q && !S.showDone) {
      const done = list.filter((r) => TERMINAL.has(r.status));
      if (done.length > COLLAPSE_DONE_OVER && done.length < list.length) {
        hiddenDone = done.length;
        list = list.filter((r) => !TERMINAL.has(r.status));
      }
    }

    const want = list.map((r) => {
      const n = rowCache(r.id);
      const html = rowHTML(r);
      if (n._html !== html) { n.innerHTML = html; n._html = html; }
      n.className = "row k-" + stateOf(r).kind + (r.status === "paused" ? " is-paused" : "") + (TERMINAL.has(r.status) ? " is-done" : "");
      return n;
    });
    const have = Array.from(el.rows.children);
    if (want.length !== have.length || want.some((n, i) => n !== have[i])) {
      el.rows.replaceChildren(...want);
    }
    let more = $(".row-more");
    if (hiddenDone || (S.showDone && S.filter === "all" && !q && Array.from(S.runs.values()).filter((r) => TERMINAL.has(r.status)).length > COLLAPSE_DONE_OVER)) {
      if (!more) { more = document.createElement("button"); more.type = "button"; more.className = "row-more"; }
      more.textContent = hiddenDone ? "Show " + hiddenDone + " finished and stopped runs" : "Hide finished and stopped runs";
      more.title = hiddenDone ? "They are hidden to keep the list short" : "";
      el.rows.after(more);
    } else if (more) more.remove();

    tickNode(el.rows, Date.now() / 1000);

    const empty = el.runsEmpty;
    if (!S.runs.size) {
      empty.innerHTML = '<b>No agents connected yet</b><span>Point any agent at Tripwire by changing its API base URL:</span>' +
        '<code class="code">Anthropic(base_url="' + esc(location.origin) + '/r/&lt;run-id&gt;")</code>' +
        '<span>or start the demo with <code>python -m demo.run_demo</code>. Agents will appear here as they work.</span>';
      empty.hidden = false;
    } else if (!list.length && !hiddenDone) {
      const msg = q ? ["No runs match “" + S.q + "”", "Try a different name, or clear the search."] : {
        needs: ["Nothing needs you right now", "When Tripwire pauses an agent it appears at the top with Approve and Stop buttons and a countdown."],
        running: ["No agents are running", "Everything has finished. See Finished, Stopped or History for what happened."],
        finished: ["Nothing has finished yet", "Runs that complete their task show up here."],
        stopped: ["Nothing has been stopped", "Runs ended by Tripwire or by you show up here."],
      }[S.filter] || ["Nothing here", ""];
      empty.innerHTML = "<b>" + esc(msg[0]) + "</b><span>" + esc(msg[1]) + "</span>";
      empty.hidden = false;
    } else empty.hidden = true;
    $(".table").hidden = !list.length && !hiddenDone;
  }
  document.addEventListener("click", (e) => {
    if (e.target.closest(".row-more")) { S.showDone = !S.showDone; renderRuns(); }
  });

  function rowHTML(r) {
    const st = stateOf(r);
    const spent = num(r.spent_usd), budget = num(r.budget_usd, 1);
    const pct = budget > 0 ? Math.min(100, (spent / budget) * 100) : 0;
    const step = st.op ? opChip(st.op) : st.outcome ? chip(st.outcome, OUTCOME[st.outcome], st.outcome === "recovered" ? "Recovered: fixed itself after a nudge" : "Finished: completed its task") : '<span class="muted">—</span>';
    const why = st.why ? st.short + " — " + st.why : st.short;
    return (
      '<span class="sdot c-' + st.kind + '" title="' + esc(st.head) + '"></span>' +
      '<span class="name" title="' + esc((r.name || r.id) + (r.goal ? " — Goal: " + r.goal : "")) + '">' + esc(r.name || r.id) + "</span>" +
      '<span class="now" title="' + esc(why) + '">' + esc(st.short) + "</span>" +
      '<span class="step">' + step + "</span>" +
      '<span class="lad">' + ladderDots(r, st) + "</span>" +
      '<span class="spend" title="' + esc(money(spent) + " spent of a " + money(budget) + " budget (" + Math.round(pct) + "%)") + '">' +
      '<span class="mono">' + money(spent) + ' <span class="muted">/ ' + money(budget) + '</span></span><span class="bar' + (pct >= 90 ? " hot" : "") + '"><i style="width:' + pct.toFixed(1) + '%"></i></span></span>' +
      '<span class="time mono r" data-elapsed title="' + (TERMINAL.has(r.status) ? "Total run time" : "Running for") + '">0:00</span>' +
      '<span class="steps mono r" title="Model calls made">' + num(r.steps) + "</span>"
    );
  }

  el.rows.addEventListener("click", (ev) => { const row = ev.target.closest(".row[data-id]"); if (row) openDrawer(row.dataset.id); });
  el.rows.addEventListener("keydown", (ev) => {
    if ((ev.key === "Enter" || ev.key === " ") && ev.target.matches(".row[data-id]")) { ev.preventDefault(); openDrawer(ev.target.dataset.id); }
  });
  $$(".ftab").forEach((t) => t.addEventListener("click", () => { S.filter = t.dataset.filter; LS.set("filter", S.filter); renderRuns(); }));
  let rq = null;
  $("#run-q").addEventListener("input", (e) => { clearTimeout(rq); rq = setTimeout(() => { S.q = e.target.value.trim().toLowerCase(); renderRuns(); }, 120); });
  const sortSel = $("#run-sort");
  sortSel.value = S.sort;
  sortSel.addEventListener("change", () => { S.sort = sortSel.value; LS.set("sort", S.sort); renderRuns(); });

  // ---------------------------------------------------------------- needs you (the only loud thing)
  function renderNeeds() {
    const p = Array.from(S.runs.values()).filter((r) => r.status === "paused").sort((a, b) => num(a.pause_deadline, Infinity) - num(b.pause_deadline, Infinity));
    document.title = (p.length ? "(" + p.length + ") need" + (p.length === 1 ? "s" : "") + " you · " : "") + "Tripwire";
    $("#sum-needs").textContent = p.length;
    $("#sum-needs-wrap").classList.toggle("on", p.length > 0);
    if (!p.length) {
      el.needs.className = "needs clear";
      el.needs.innerHTML = S.runs.size ? '<span class="clear-msg" title="No agent is waiting for a decision">✓ All clear — nothing needs your decision</span>' : "";
      el.needs.hidden = !S.runs.size;
      return;
    }
    el.needs.hidden = false;
    el.needs.className = "needs";
    const key = p.map((r) => r.id + ":" + r.pause_deadline + ":" + (r.last_action && r.last_action.ts)).join("|");
    if (el.needs._key !== key) {
      el.needs._key = key;
      el.needs.innerHTML = '<div class="needs-title">' + chip("pause", "Pause") + " <b>" + (p.length === 1 ? "1 agent is" : p.length + " agents are") +
        " waiting for your decision</b><span class=\"muted\"> — approve to let it continue, or stop it. If you do nothing, Tripwire stops it.</span></div>" +
        p.map((r) => {
          const why = prettyReason(r.last_action && r.last_action.reason);
          return '<div class="need" data-id="' + esc(r.id) + '" data-deadline="' + num(r.pause_deadline) + '">' +
            '<button class="need-name" type="button" title="Open details for ' + esc(r.name || r.id) + '">' + esc(r.name || r.id) + "</button>" +
            '<span class="need-why" title="' + esc(why.text) + '">' + esc([why.tag, why.text].filter(Boolean).join(": ") || "Paused for review") + "</span>" +
            '<span class="cd" title="Time left before Tripwire stops this agent automatically"><span class="cd-label">Auto-stops in</span> <b class="mono" data-cd-text>–:––</b><span class="cd-bar"><i></i></span></span>' +
            '<span class="need-btns"><button class="btn btn-approve" data-act="approve" type="button" title="Let the agent continue. If it gets stuck again it will be stopped.">Approve</button>' +
            '<button class="btn btn-stop" data-act="kill" type="button" title="End this run now">Stop</button></span></div>';
        }).join("");
    }
    tickNode(el.needs, Date.now() / 1000);
  }
  el.needs.addEventListener("click", (ev) => {
    const row = ev.target.closest(".need"); if (!row) return;
    const btn = ev.target.closest("button[data-act]");
    if (btn) { doAction(row.dataset.id, btn.dataset.act, btn); return; }
    if (ev.target.closest(".need-name")) openDrawer(row.dataset.id);
  });

  // ---------------------------------------------------------------- summary line
  function renderSummary() {
    const runs = Array.from(S.runs.values());
    const st = Object.assign({
      runs_active: runs.filter((r) => !TERMINAL.has(r.status)).length,
      spent_usd: runs.reduce((a, r) => a + num(r.spent_usd), 0),
      saved_usd: runs.reduce((a, r) => a + num(r.saved_usd), 0),
    }, S.stats || {});
    $("#sum-active").textContent = num(st.runs_active);
    $("#sum-spent").textContent = money(st.spent_usd);
    $("#sum-saved").textContent = money(st.saved_usd);
  }
  let statsTimer = null;
  function refreshStatsSoon() {
    clearTimeout(statsTimer);
    statsTimer = setTimeout(() => {
      api("/api/stats").then((st) => { if (st && typeof st === "object") { S.stats = st; renderSummary(); } }).catch(() => {});
    }, 400);
  }

  // ---------------------------------------------------------------- timers (one interval drives all)
  function setCountdown(node, deadline, now) {
    const left = deadline > 0 ? Math.max(0, deadline - now) : 0;
    const txt = deadline > 0 ? dur(Math.ceil(left)) : "–:––";
    $$("[data-cd-text]", node).forEach((t) => { t.textContent = txt; });
    node.classList.toggle("urgent", deadline > 0 && left < 10);
    const bar = $(".cd-bar i", node);
    if (bar) bar.style.width = (deadline > 0 ? Math.max(0, Math.min(1, left / Math.max(1, S.pauseTimeout))) * 100 : 0).toFixed(1) + "%";
  }
  function tickNode(root, now) {
    $$("[data-deadline]", root).forEach((n) => setCountdown(n, num(parseFloat(n.dataset.deadline)), now));
    $$("[data-elapsed]", root).forEach((n) => {
      const host = n.closest("[data-id]");
      const r = host && S.runs.get(host.dataset.id);
      if (!r) return;
      const end = TERMINAL.has(r.status) ? num(r.last_seen, now) : now;
      n.textContent = dur(end - num(r.created_at, now));
    });
  }
  function tick() {
    el.session.textContent = dur((Date.now() - S.pageStart) / 1000);
    const now = Date.now() / 1000;
    tickNode(el.rows, now);
    tickNode(el.needs, now);
    tickNode(el.drawerSummary, now);
  }
  setInterval(tick, 1000);

  // ---------------------------------------------------------------- history (also the live feed)
  // describe(e) -> {cat, title (HTML), detail (HTML), nudge}
  function describe(e) {
    const d = e.data || {};
    const who = "<b>" + esc(e.run_name || runName(e.run_id)) + "</b>";
    switch (e.type) {
      case "intervention": {
        const k = opKey(d.action);
        if (!k) return { cat: "neutral", label: esc(d.action), title: who, detail: "" };
        const p = prettyReason(d.reason);
        const extra = k === "downgrade" && d.downgrade_model ? " (" + esc(d.downgrade_model) + ")" : "";
        return { cat: k, label: OPS[k].name, title: who + " — " + OPS[k].meaning + extra,
          detail: (p.tag ? esc(p.tag) + ". " : "") + esc(p.text), nudge: d.nudge_text || "" };
      }
      case "human_action": {
        const a = d.action;
        const t = { approve: "approved — it continues", resume: "resumed", kill: "stopped by you", pause: "you asked to pause it at its next step", reset: "you reset its ladder" }[a] || esc(plain(a));
        return { cat: a === "kill" ? "stop" : a === "pause" ? "pause" : "human", label: "You", title: who + " " + t, detail: "" };
      }
      case "resumed":
        return { cat: "human", label: "Resumed", title: who + " resumed after your decision", detail: "" };
      case "recovered":
        return { cat: "recovered", label: "Recovered", title: who + " looks fine again after " + (num(d.after_nudges) === 1 ? "a nudge" : num(d.after_nudges) + " nudges"), detail: "" };
      case "completed":
        return { cat: "finished", label: "Finished", title: who + " completed its task", detail: num(d.steps, num(e.step)) + " steps · " + money(num(d.spent_usd, num(e.spent_usd))) };
      case "killed": {
        const by = d.by === "human" ? "by you" : d.by === "timeout" ? "— nobody decided in time" : "by Tripwire";
        const p = prettyReason(d.reason);
        return { cat: "stopped", label: "Stopped", title: who + " ended " + by,
          detail: [esc(p.text || p.tag), num(d.saved_usd) > 0 ? money(d.saved_usd) + " projected waste avoided" : ""].filter(Boolean).join(" · ") };
      }
      case "created":
        return { cat: "neutral", label: "Started", title: who + " started", detail: d.goal ? "Goal: " + esc(d.goal) : "" };
      default:
        return { cat: "neutral", label: esc(plain(e.type)), title: who, detail: "" };
    }
  }
  const CAT_CHIP = { nudge: "nudge", downgrade: "downgrade", pause: "pause", stop: "stop", stopped: "stop", finished: "finished", recovered: "recovered", human: "neutral", neutral: "neutral" };

  const HCHIPS = [
    ["all", "All", "Every saved event"],
    ["nudge", "Nudge", "Times Tripwire warned an agent it was stuck"],
    ["downgrade", "Downgrade", "Times Tripwire switched an agent to a cheaper model"],
    ["pause", "Pause", "Times an agent was held for your decision"],
    ["stop", "Stop", "Times Tripwire (or you) stopped a run"],
    ["recovered", "Recovered", "Agents that fixed themselves after a nudge"],
    ["finished", "Finished", "Agents that completed their task"],
    ["stopped", "Stopped", "Runs that ended because they were stopped"],
    ["human", "Your actions", "Approve, Stop and Pause clicks"],
  ];
  function renderHChips() {
    el.hchips.innerHTML = HCHIPS.map((c) => {
      const k = c[0];
      const dot = k === "all" || k === "human" ? "" : "<i class=\"dot c-" + (CAT_CHIP[k] || k) + "\"></i>";
      return '<button type="button" class="ftab' + (S.hf.chip === k ? " active" : "") + '" data-hchip="' + k + '" title="' + esc(c[2]) + '">' + dot + c[1] + "</button>";
    }).join("");
  }
  el.hchips.addEventListener("click", (e) => {
    const b = e.target.closest("[data-hchip]"); if (!b) return;
    S.hf.chip = b.dataset.hchip; S.histLimit = 200; renderHChips(); renderHistory();
  });
  el.histRun.addEventListener("change", () => { S.hf.run = el.histRun.value; S.histLimit = 200; renderHistory(); });
  let qTimer = null;
  el.histQ.addEventListener("input", () => { clearTimeout(qTimer); qTimer = setTimeout(() => { S.hf.q = el.histQ.value.trim().toLowerCase(); S.histLimit = 200; renderHistory(); }, 150); });

  function xOf(e) { return e._x || (e._x = describe(e)); }
  function filteredHistory(keepDup) {
    const q = S.hf.q, c = S.hf.chip;
    // A stop logs both the decision ("intervention: kill" or your Stop click) and "killed"; show one line (the "killed" one).
    const killedAt = new Map();
    S.history.forEach((e) => { if (e.type === "killed") (killedAt.get(e.run_id) || killedAt.set(e.run_id, []).get(e.run_id)).push(num(e.ts)); });
    const dupKill = (e) => ((e.type === "intervention" && opKey((e.data || {}).action) === "stop") || (e.type === "human_action" && (e.data || {}).action === "kill")) &&
      (killedAt.get(e.run_id) || []).some((t) => Math.abs(t - num(e.ts)) < 3);
    return S.history.filter((e) => {
      if (S.hf.run && e.run_id !== S.hf.run) return false;
      if (!keepDup && dupKill(e)) return false;
      const x = xOf(e);
      if (c !== "all" && x.cat !== c && !(c === "stop" && x.cat === "stopped")) return false;
      if (q) {
        const hay = e._hay || (e._hay = [e.run_name, e.run_id, x.label, x.title, x.detail, e.type].join(" ").replace(/<[^>]+>/g, "").toLowerCase());
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }
  function renderHistory() {
    if (S.view !== "history") {
      const f = S.hf; S.hf = { chip: "all", run: "", q: "" };
      el.histCount.textContent = filteredHistory().length;
      S.hf = f;
      return;
    }
    const list = filteredHistory();
    if (S.hf.chip === "all" && !S.hf.run && !S.hf.q) el.histCount.textContent = list.length;
    const shown = list.slice(0, S.histLimit);
    const filtered = S.hf.chip !== "all" || S.hf.run || S.hf.q;
    el.histShown.textContent = filtered ? list.length + " matching events" : list.length + " saved events";
    let html = "", lastDay = "";
    shown.forEach((e, i) => {
      const day = dayLabel(e.ts);
      if (day !== lastDay) { html += '<li class="hday">' + esc(day) + "</li>"; lastDay = day; }
      const x = xOf(e);
      html += '<li class="hrow' + (S.freshIds.has(e) ? " fresh" : "") + '" data-i="' + i + '" title="Open this agent\'s details">' +
        '<span class="when mono">' + clock(e.ts) + "</span>" +
        '<span class="hchip">' + chip(CAT_CHIP[x.cat] || "neutral", x.label) + "</span>" +
        '<span class="htext"><span class="htitle">' + x.title + "</span>" +
        (x.detail ? '<span class="hdetail">' + x.detail + "</span>" : "") +
        (x.nudge ? '<details class="nudge-text"><summary>Note sent to the agent</summary><pre>' + esc(x.nudge) + "</pre></details>" : "") + "</span></li>";
    });
    if (list.length > shown.length) html += '<li class="hmore"><button class="btn btn-quiet" type="button" data-more>Show ' + Math.min(200, list.length - shown.length) + " more</button></li>";
    el.hist.innerHTML = html;
    el.hist._list = shown;
    el.histEmpty.hidden = !!shown.length;
    if (!shown.length) {
      el.histEmpty.innerHTML = S.history.length
        ? '<b>No events match</b><span>Try another filter, or <a href="#" data-hreset>show everything</a>.</span>'
        : "<b>No history yet</b><span>Everything Tripwire does is saved here, newest first, and kept across resets and restarts.</span>";
    }
  }
  el.hist.addEventListener("click", (ev) => {
    if (ev.target.closest("[data-more]")) { S.histLimit += 200; renderHistory(); return; }
    if (ev.target.closest("details")) return;
    const li = ev.target.closest("[data-i]"); if (!li) return;
    const e = (el.hist._list || [])[+li.dataset.i];
    if (e) openFromEntry(e.run_id, e.ts);
  });
  el.histEmpty.addEventListener("click", (ev) => {
    if (!ev.target.closest("[data-hreset]")) return;
    ev.preventDefault();
    S.hf = { chip: "all", run: "", q: "" }; el.histQ.value = ""; el.histRun.value = ""; renderHChips(); renderHistory();
  });

  function openFromEntry(runId, ts) {
    const r = S.runs.get(runId);
    if (!r) { toast((runId || "That agent") + " is no longer on the board (cleared by a reset). Its record stays in History."); return; }
    if (ts && num(r.created_at) && ts < r.created_at - 1) { toast("That was an earlier run named " + (r.name || runId) + ", since cleared. Its record stays in History."); return; }
    openDrawer(runId);
  }

  function updateRunOptions() {
    const ids = new Map();
    S.history.forEach((e) => { if (e.run_id && !ids.has(e.run_id)) ids.set(e.run_id, e.run_name || e.run_id); });
    S.runs.forEach((r) => { if (!ids.has(r.id)) ids.set(r.id, r.name || r.id); });
    const key = Array.from(ids.keys()).sort().join("|");
    if (el.histRun._key === key) return;
    el.histRun._key = key;
    const cur = S.hf.run;
    el.histRun.innerHTML = '<option value="">All agents</option>' + Array.from(ids.entries()).sort((a, b) => String(a[1]).localeCompare(String(b[1])))
      .map((p) => '<option value="' + esc(p[0]) + '">' + esc(p[1]) + "</option>").join("");
    el.histRun.value = ids.has(cur) ? cur : "";
    S.hf.run = el.histRun.value;
  }

  let histRenderPending = false;
  function addHistory(entry) {
    if (!entry || !entry.type) return;
    S.history.unshift(entry);
    if (S.history.length > 5000) S.history.length = 5000;
    S.freshIds.add(entry);
    setTimeout(() => { S.freshIds.delete(entry); }, 4000);
    absorbEvent(entry);
    if (S.runs.has(entry.run_id)) scheduleRender();
    if (S.view !== "history") { S.histUnseen++; el.histNew.textContent = "+" + S.histUnseen; el.histNew.hidden = false; }
    if (!histRenderPending) {
      histRenderPending = true;
      setTimeout(() => { histRenderPending = false; updateRunOptions(); renderHistory(); }, 200);
    }
  }
  async function loadHistory() {
    try {
      const h = await api("/api/history?limit=5000");
      S.history = Array.isArray(h) ? h : [];
      S.history.forEach(absorbEvent);
      updateRunOptions();
      renderHistory();
      scheduleRender();
    } catch (e) { console.warn("tripwire: history load failed", e); }
  }

  function download(name, mime, text) {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const stamp = () => new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  const clean = (e) => ({ type: e.type, run_id: e.run_id, run_name: e.run_name, ts: e.ts, time: toDate(e.ts).toISOString(), step: e.step, spent_usd: e.spent_usd, data: e.data });
  $("#exp-json").addEventListener("click", () => {
    const list = filteredHistory(true);
    if (!list.length) { toast("Nothing to export with the current filters"); return; }
    download("tripwire-history-" + stamp() + ".json", "application/json", JSON.stringify(list.map(clean), null, 2));
    toast("Exported " + list.length + " events as JSON");
  });
  $("#exp-csv").addEventListener("click", () => {
    const list = filteredHistory(true);
    if (!list.length) { toast("Nothing to export with the current filters"); return; }
    const cols = ["time", "run_id", "run_name", "event", "operation", "summary", "reason", "step", "spent_usd", "saved_usd"];
    const q = (v) => { v = v == null ? "" : String(v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const rows = list.map((e) => {
      const x = xOf(e), d = e.data || {};
      const op = e.type === "intervention" ? (OPS[opKey(d.action)] || {}).name || d.action : e.type === "human_action" ? "you: " + plain(d.action) : "";
      return [toDate(e.ts).toISOString(), e.run_id, e.run_name, e.type === "killed" ? "stopped" : e.type, op,
        (x.label + ": " + x.title).replace(/<[^>]+>/g, ""), plain(d.reason || ""), e.step, e.spent_usd, d.saved_usd].map(q).join(",");
    });
    download("tripwire-history-" + stamp() + ".csv", "text/csv", cols.join(",") + "\n" + rows.join("\n") + "\n");
    toast("Exported " + list.length + " events as CSV");
  });
  $("#hist-clear").addEventListener("click", (ev) => {
    if (!S.history.length) { toast("History is already empty"); return; }
    armed(ev.currentTarget, "Delete " + S.history.length + " events?", async () => {
      try { await api("/api/history", { method: "DELETE" }); onHistoryCleared(); toast("History cleared"); }
      catch (e) { toast("Could not clear history: " + e.message, true); }
    });
  });
  function onHistoryCleared() { S.history = []; S.histUnseen = 0; el.histNew.hidden = true; updateRunOptions(); renderHistory(); }

  // ---------------------------------------------------------------- main view tabs
  function setView(v) {
    S.view = v === "history" ? "history" : "runs"; LS.set("view", S.view);
    $$(".view-tab").forEach((t) => { const on = t.dataset.view === S.view; t.classList.toggle("active", on); t.setAttribute("aria-selected", String(on)); });
    $$(".view").forEach((p) => { p.hidden = p.dataset.pane !== S.view; });
    if (S.view === "history") { S.histUnseen = 0; el.histNew.hidden = true; renderHChips(); renderHistory(); }
  }
  $$(".view-tab").forEach((t) => t.addEventListener("click", () => setView(t.dataset.view)));

  // ---------------------------------------------------------------- SSE
  function setConn(state) {
    el.conn.className = "conn " + state;
    $("span", el.conn).textContent = state === "live" ? "live" : state === "down" ? "reconnecting" : "connecting";
    el.conn.title = state === "live" ? "Connected: updates arrive instantly" : "Not connected right now; retrying";
    $("#live-ind").classList.toggle("off", state !== "live");
  }
  function connect() {
    if (S.es) { try { S.es.close(); } catch (e) { /* ignore */ } }
    setConn(S.retry ? "down" : "connecting");
    let es;
    try { es = new EventSource("/api/stream"); } catch (e) { scheduleReconnect(); return; }
    S.es = es;
    es.onopen = () => {
      setConn("live");
      if (S.hadError) { S.hadError = false; loadInitial(true); loadHistory(); }
      S.retry = 0;
    };
    es.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      try { handle(msg); } catch (e) { console.warn("tripwire: bad event", e, msg); }
    };
    es.onerror = () => {
      S.hadError = true;
      setConn("down");
      if (es.readyState === EventSource.CLOSED) scheduleReconnect();
    };
  }
  function scheduleReconnect() {
    S.retry = Math.min(S.retry + 1, 6);
    setTimeout(connect, Math.min(10000, 500 * Math.pow(2, S.retry - 1)));
  }

  function handle(msg) {
    if (!msg || typeof msg !== "object") return;
    const id = msg.run_id, data = msg.data || {}, ts = msg.ts;
    switch (msg.type) {
      case "run_update": upsertRun(Object.assign({ id: id }, data)); refreshStatsSoon(); break;
      case "history": addHistory(data); break;
      case "history_cleared": onHistoryCleared(); break;
      case "step":
        if (id && !S.runs.has(id)) loadRun(id);
        if (S.drawerId === id && S.drawerTab === "timeline") refreshDrawerSoon();
        break;
      case "intervention":
        markApplied(id, opKey(data.action), ts);
        if (S.drawerId === id) refreshDrawerSoon();
        break;
      case "stats":
        if (data && typeof data === "object") {
          if (num(data.runs_total, -1) === 0 && S.runs.size) wipe();
          S.stats = data; renderSummary();
        }
        break;
      case "reset": wipe(); break;
      default: break;
    }
  }

  function loadRun(id) {
    api("/api/runs/" + encodeURIComponent(id)).then((d) => { if (d && d.run) { upsertRun(d.run); (d.events || []).forEach((e) => absorbEvent(Object.assign({ run_id: id }, e))); } }).catch(() => {});
  }

  async function loadInitial(resync) {
    try {
      const [runs, stats, health] = await Promise.all([api("/api/runs"), api("/api/stats").catch(() => null), api("/api/health").catch(() => null)]);
      if (health && num(health.pause_timeout) > 0) { S.pauseTimeout = health.pause_timeout; renderLegend(); }
      if (health && health.public) { const c = $("#hist-clear"); if (c) c.hidden = true; }
      const list = Array.isArray(runs) ? runs : [];
      if (resync) {
        const keep = new Set(list.map((r) => r.id));
        Array.from(S.runs.keys()).forEach((k) => { if (!keep.has(k)) S.runs.delete(k); });
      }
      list.forEach((r) => { if (r && r.id) S.runs.set(r.id, r); });
      S.stats = stats && typeof stats === "object" ? stats : null;
      scheduleRender();
    } catch (e) {
      console.warn("tripwire: initial load failed", e);
      scheduleRender();
    }
  }

  function wipe() {
    S.runs.clear(); S.applied.clear(); S.stats = null; S.showDone = false;
    el.rows.replaceChildren();
    closeDrawer();
    scheduleRender();
  }

  // ---------------------------------------------------------------- actions
  async function doAction(id, action, btn) {
    if (btn) btn.disabled = true;
    try {
      const sum = await api("/api/runs/" + encodeURIComponent(id) + "/action", { method: "POST", body: JSON.stringify({ action }) });
      if (sum && sum.id) upsertRun(sum);
      toast({
        approve: "Approved " + runName(id) + ". It will continue.",
        kill: "Stopped " + runName(id) + ".",
        pause: "Pause requested: " + runName(id) + " will hold at its next step.",
        resume: "Resumed " + runName(id) + ".",
      }[action] || action);
      refreshStatsSoon();
    } catch (e) {
      toast("That didn't work: " + e.message, true);
    } finally {
      if (btn && btn.isConnected) btn.disabled = false;
    }
  }

  $("#demo-btn").addEventListener("click", async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    try {
      await api("/api/demo", { method: "POST", body: "{}" });
      wipe();
      await loadInitial(true);
      toast("Demo started: 5 example agents. Two will need your decision in about 15 seconds.");
    } catch (e) {
      toast(/409/.test(e.message) ? "A demo is already running. Wait for it to finish." : "Could not start the demo: " + e.message, true);
    } finally {
      setTimeout(() => { if (btn.isConnected) btn.disabled = false; }, 3000);
    }
  });

  el.reset.addEventListener("click", () => armed(el.reset, "Click again to reset", async () => {
    try {
      await api("/api/reset", { method: "POST", body: "{}" });
      wipe();
      await loadInitial(true);
      toast("Demo reset: all runs cleared. History is kept.");
    } catch (e) { toast("Reset failed: " + e.message, true); }
  }));

  // ---------------------------------------------------------------- drawer
  function openDrawer(id) {
    S.drawerId = id;
    S.drawerTab = "timeline";
    setTabs();
    el.drawer.classList.add("open");
    el.drawer.setAttribute("aria-hidden", "false");
    el.backdrop.hidden = false;
    el.drawerRaw.href = "/api/runs/" + encodeURIComponent(id) + "/report";
    const r = S.runs.get(id);
    if (r) renderDrawerHead(r);
    el.drawerBody.innerHTML = '<div class="muted pad">Loading steps…</div>';
    loadDrawer();
  }
  function closeDrawer() {
    S.drawerId = null;
    el.drawer.classList.remove("open");
    el.drawer.setAttribute("aria-hidden", "true");
    el.backdrop.hidden = true;
  }
  $("#drawer-close").addEventListener("click", closeDrawer);
  el.backdrop.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!el.legend.hidden) setLegend(false); else if (S.drawerId) closeDrawer();
  });
  $$(".dtab[data-tab]").forEach((t) => t.addEventListener("click", () => {
    if (!S.drawerId) return;
    S.drawerTab = t.dataset.tab; setTabs();
    el.drawerBody.innerHTML = '<div class="muted pad">Loading…</div>';
    loadDrawer();
  }));
  function setTabs() { $$(".dtab[data-tab]").forEach((t) => t.classList.toggle("active", t.dataset.tab === S.drawerTab)); }

  function renderDrawerHead(r) {
    const st = stateOf(r);
    const status = r.status;
    const a = appliedFor(r);
    const why = (S.applied.get(r.id) || {})._why || {};
    el.drawerName.textContent = r.name || r.id;
    el.drawerGoal.textContent = r.goal ? "Goal: " + r.goal : "";
    const downgraded = r.original_model && r.model && r.original_model !== r.model;
    const stepChip = st.op ? opChip(st.op) : st.outcome ? chip(st.outcome, OUTCOME[st.outcome]) : chip("neutral", "Running");

    let html = '<div class="d-now">' + stepChip + '<div><div class="d-head">' + esc(st.head) + "</div>" +
      (st.tag ? '<div class="muted small">' + esc(st.tag) + "</div>" : "") +
      (st.why ? '<div class="d-why">' + esc(st.why) + "</div>" : "") +
      (st.saved > 0 ? '<div class="d-saved">' + money(st.saved) + " projected waste avoided</div>" : "") + "</div></div>";

    if (status === "paused") {
      html += '<div class="need d-need" data-id="' + esc(r.id) + '" data-deadline="' + num(r.pause_deadline) + '">' +
        '<span class="cd" title="Time left before Tripwire stops this agent automatically"><span class="cd-label">Auto-stops in</span> <b class="mono" data-cd-text>–:––</b><span class="cd-bar"><i></i></span></span>' +
        '<span class="need-btns"><button class="btn btn-approve" data-act="approve" type="button" title="Let the agent continue">Approve</button>' +
        '<button class="btn btn-stop" data-act="kill" type="button" title="End this run now">Stop</button></span></div>';
    }

    const maxN = Math.max(0, ...OP_ORDER.filter((k) => a[k]).map((k) => OPS[k].n));
    html += '<ol class="d-ladder">' + OP_ORDER.map((k) => {
      const o = OPS[k];
      const used = !!a[k], skipped = !used && o.n < maxN;
      const state = st.op === k && !TERMINAL.has(status) ? "Happening now" : used ? "Used" + (a[k] > 0 ? " at " + clock(a[k]) : "") : skipped ? "Skipped" : "Not used";
      const reason = used && why[k] ? prettyReason(why[k]) : null;
      return '<li class="' + (used ? "used" : "") + '">' + '<i class="ld c-' + k + (used ? " used" : "") + (st.op === k && !TERMINAL.has(status) ? " now" : "") + '"></i>' +
        '<span class="d-op">' + o.name + '</span><span class="muted small">' + state + "</span>" +
        (reason && (reason.text || reason.tag) ? '<span class="d-reason" title="' + esc(reason.text) + '">' + esc(reason.tag || reason.text) + "</span>" : '<span class="d-reason muted">' + esc(o.meaning) + "</span>") + "</li>";
    }).join("") + "</ol>";

    const signals = Array.isArray(r.signals) ? r.signals.slice().sort((x, y) => num(y.severity) - num(x.severity)) : [];
    if (signals.length && !TERMINAL.has(status)) {
      html += '<div class="d-signals"><div class="muted small">What Tripwire is noticing</div>' +
        signals.slice(0, 3).map((s) => '<div class="d-sig" title="Severity ' + num(s.severity).toFixed(2) + ' of 1">' + esc(s.message || s.detector) + "</div>").join("") + "</div>";
    }

    html += '<div class="d-meta">' +
      '<span title="How long this run has been going">Time <b class="mono" data-elapsed>0:00</b></span>' +
      '<span title="Money spent out of budget">Spent <b class="mono">' + money(r.spent_usd) + " / " + money(r.budget_usd) + "</b></span>" +
      '<span title="Model calls made">Steps <b class="mono">' + num(r.steps) + "</b></span>" +
      '<span title="AI model in use">Model <b class="mono">' + (downgraded ? esc(r.original_model) + " → " + esc(r.model) : esc(r.model || "—")) + "</b></span>" +
      '<span title="Tokens in + out">Tokens <b class="mono">' + compact(num(r.input_tokens) + num(r.output_tokens)) + "</b></span>" +
      '<span title="How stuck it looks: 0 = fine, 1 = completely stuck">Stuck <b class="mono">' + num(r.stuck_score).toFixed(2) + "</b></span>" +
      "</div>";
    if (!TERMINAL.has(status) && status !== "paused") {
      html += '<div class="d-acts"><button class="btn" data-act="pause" type="button" title="Hold this agent at its next step until you decide">Pause</button>' +
        (stopArmed(r.id) ? '<button class="btn btn-danger confirm" data-act="kill" type="button" title="Click again to end this run now">Click again to stop</button></div>'
          : '<button class="btn btn-danger" data-act="kill" type="button" title="End this run now (asks you to click twice)">Stop</button></div>');
    }
    el.drawerSummary.innerHTML = html;
    el.drawerSummary.dataset.id = r.id;
    tickNode(el.drawerSummary, Date.now() / 1000);
  }
  el.drawerSummary.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-act]");
    if (!btn || !S.drawerId) return;
    const id = S.drawerId, r = S.runs.get(id);
    // Stopping a run that is still working needs a second click; decisions on a paused run don't.
    // The armed state lives outside the DOM because the drawer re-renders on every step.
    if (btn.dataset.act === "kill" && r && r.status !== "paused") {
      if (stopArmed(id)) { S.stopArm = null; doAction(id, "kill", btn); return; }
      S.stopArm = { id, until: Date.now() + 4000 };
      renderDrawerHead(r);
      setTimeout(() => { if (S.stopArm && S.stopArm.id === id && Date.now() >= S.stopArm.until) { S.stopArm = null; const cur = S.runs.get(id); if (cur && S.drawerId === id) renderDrawerHead(cur); } }, 4100);
      return;
    }
    doAction(id, btn.dataset.act, btn);
  });
  function stopArmed(id) { return !!(S.stopArm && S.stopArm.id === id && Date.now() < S.stopArm.until); }

  let drawerTimer = null;
  function refreshDrawerSoon() { clearTimeout(drawerTimer); drawerTimer = setTimeout(loadDrawer, 350); }

  async function loadDrawer() {
    const id = S.drawerId;
    if (!id) return;
    const tab = S.drawerTab;
    const keepScroll = el.drawerBody.scrollTop;
    try {
      if (tab === "timeline") {
        const d = await api("/api/runs/" + encodeURIComponent(id));
        if (S.drawerId !== id || S.drawerTab !== tab) return;
        if (d && d.run) {
          (d.events || []).forEach((e) => absorbEvent(Object.assign({ run_id: id }, e)));
          S.runs.set(id, Object.assign({}, S.runs.get(id) || {}, d.run));
          renderDrawerHead(S.runs.get(id));
        }
        el.drawerBody.innerHTML = timelineHTML(d || {});
      } else {
        const md = await api("/api/runs/" + encodeURIComponent(id) + "/report");
        if (S.drawerId !== id || S.drawerTab !== tab) return;
        const text = typeof md === "string" ? md : (md && (md.markdown || md.report)) || JSON.stringify(md, null, 2);
        el.drawerBody.innerHTML = '<div class="md">' + mdToHtml(text) + "</div>";
      }
      el.drawerBody.scrollTop = keepScroll;
    } catch (e) {
      if (S.drawerId === id) el.drawerBody.innerHTML = '<div class="err pad">Could not load: ' + esc(e.message) + "</div>";
    }
  }

  function timelineHTML(d) {
    const steps = Array.isArray(d.steps) ? d.steps : [];
    const run = d.run || {};
    if (!steps.length) return '<div class="muted pad">No steps yet. They appear here as the agent works.</div>';
    const items = steps.map((s) => {
      const calls = Array.isArray(s.tool_calls) ? s.tool_calls : [];
      const results = Array.isArray(s.tool_results) ? s.tool_results : [];
      const byId = {};
      results.forEach((r) => { if (r && r.tool_use_id) byId[r.tool_use_id] = r; });
      const hasErr = results.some((r) => r && r.is_error);
      const k = s.intervention && opKey(s.intervention.action);
      let html = "";
      if (k) {
        const iv = s.intervention, p = prettyReason(iv.reason);
        html += '<div class="tl-int">' + opChip(k) + '<div><span>' + OPS[k].meaning + (iv.downgrade_model ? " (" + esc(iv.downgrade_model) + ")" : "") + "</span>" +
          (p.text ? '<div class="muted small">' + (p.tag ? esc(p.tag) + ". " : "") + esc(p.text) + "</div>" : "") +
          (iv.nudge_text ? '<details class="nudge-text"><summary>Note sent to the agent</summary><pre>' + esc(iv.nudge_text) + "</pre></details>" : "") + "</div></div>";
      }
      const text = s.text_preview != null ? s.text_preview : s.text;
      html += '<div class="tl-card"><div class="tl-head mono"><span>' + esc(s.model || "") + " · " + clock(s.ts) + "</span><span>" +
        compact(s.input_tokens) + " in / " + compact(s.output_tokens) + " out · " + money(s.cost_usd) + "</span></div>";
      if (text) html += '<div class="tl-text">' + esc(trunc(text, 600)) + "</div>";
      const used = new Set();
      calls.forEach((c) => {
        if (!c) return;
        html += '<div class="tl-call mono"><span class="fn">' + esc(c.name || "tool") + "</span>(" + esc(trunc(argsStr(c.args), 300)) + ")</div>";
        const r = byId[c.id];
        if (r) { used.add(c.id); html += resultHTML(r); }
      });
      results.forEach((r) => { if (r && !used.has(r.tool_use_id)) html += resultHTML(r); });
      html += "</div>";
      return '<li class="tl-item' + (hasErr ? " has-error" : "") + '"><span class="tl-num mono" title="Step number">' + esc(s.index != null ? s.index : "") + "</span>" + html + "</li>";
    }).join("");
    let end = "";
    if (run.status === "killed") end = '<div class="tl-end">' + chip("stop", "Stopped") + " " + esc(prettyReason(run.kill_reason).text || "") + "</div>";
    else if (run.status === "completed") end = '<div class="tl-end">' + chip("finished", "Finished") + "</div>";
    return '<ol class="tl">' + items + "</ol>" + end;
  }
  function resultHTML(r) {
    return '<div class="tl-res mono' + (r.is_error ? " is-error" : "") + '">↳ ' + (r.is_error ? "error: " : "") + esc(trunc(r.preview || "(empty)", 240)) + "</div>";
  }

  // ---------------------------------------------------------------- tiny markdown
  function inlineMd(s) {
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return "\u0000" + (codes.length - 1) + "\u0000"; });
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^_]+)__/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) => /^(https?:|\/|#)/.test(u) ? '<a href="' + u + '" target="_blank" rel="noopener">' + t + "</a>" : m);
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => "<code>" + codes[+i] + "</code>");
  }
  function mdToHtml(src) {
    const lines = esc(String(src || "")).replace(/\r\n?/g, "\n").split("\n");
    let out = "", i = 0, para = [];
    const flush = () => { if (para.length) { out += "<p>" + para.map(inlineMd).join("<br>") + "</p>"; para = []; } };
    const cells = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    while (i < lines.length) {
      const l = lines[i];
      if (/^```/.test(l)) {
        flush(); const buf = []; i++;
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
        i++; out += "<pre><code>" + buf.join("\n") + "</code></pre>"; continue;
      }
      let m;
      if ((m = l.match(/^(#{1,6})\s+(.*)$/))) { flush(); const n = Math.min(4, m[1].length); out += "<h" + n + ">" + inlineMd(m[2]) + "</h" + n + ">"; i++; continue; }
      if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(l)) { flush(); out += "<hr>"; i++; continue; }
      if (/^\s*\|/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        flush();
        const head = cells(l); i += 2;
        let t = "<table><thead><tr>" + head.map((c) => "<th>" + inlineMd(c) + "</th>").join("") + "</tr></thead><tbody>";
        while (i < lines.length && /^\s*\|/.test(lines[i])) { t += "<tr>" + cells(lines[i]).map((c) => "<td>" + inlineMd(c) + "</td>").join("") + "</tr>"; i++; }
        out += '<div class="tbl">' + t + "</tbody></table></div>"; continue;
      }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
        flush();
        const ordered = /^\s*\d+[.)]/.test(l);
        let t = ordered ? "<ol>" : "<ul>";
        while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
          const item = lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, "");
          t += "<li" + (/^\s{2,}/.test(lines[i]) ? ' style="margin-left:1.2em"' : "") + ">" + inlineMd(item) + "</li>"; i++;
        }
        out += t + (ordered ? "</ol>" : "</ul>"); continue;
      }
      if (/^&gt;\s?/.test(l)) {
        flush(); const buf = [];
        while (i < lines.length && /^&gt;\s?/.test(lines[i])) buf.push(lines[i++].replace(/^&gt;\s?/, ""));
        out += "<blockquote>" + inlineMd(buf.join(" ")) + "</blockquote>"; continue;
      }
      if (!l.trim()) { flush(); i++; continue; }
      para.push(l.trim()); i++;
    }
    flush();
    return out;
  }

  // ---------------------------------------------------------------- boot
  renderLegend();
  if (LS.get("legend", false)) setLegend(true);
  renderHChips();
  setView(S.view);
  tick();
  Promise.all([loadInitial(false), loadHistory()]).then(connect);
  setInterval(() => { if (S.es && S.es.readyState === EventSource.OPEN) refreshStatsSoon(); }, 15000);
})();
