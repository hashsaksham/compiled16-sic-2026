/* Tripwire dashboard — vanilla JS, no deps.
 * Data: GET /api/runs + /api/stats on load, then SSE /api/stream (see docs/MASTER.md §6.3).
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------- state
  const S = {
    runs: new Map(),        // id -> summary
    firstModel: new Map(),  // id -> first model we ever saw for the run
    signalKey: new Map(),   // id -> key of last signal set (for feed de-dupe)
    stats: null,
    feed: [],
    drawerId: null,
    drawerTab: "timeline",
    es: null,
    retry: 0,
    hadError: false,
    shown: { saved: 0, spent: 0 },
  };
  const FEED_MAX = 120;
  const TERMINAL = new Set(["killed", "completed"]);
  const STATUS_LABEL = {
    running: "Running", nudged: "Nudged", downgraded: "Downgraded",
    paused: "Paused", killed: "Killed", completed: "Completed",
  };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const el = {
    runs: $("#runs"), empty: $("#empty"), feed: $("#feed"), feedEmpty: $("#feed-empty"),
    feedCount: $("#feed-count"), conn: $("#conn"), reset: $("#reset-btn"),
    drawer: $("#drawer"), backdrop: $("#drawer-backdrop"), drawerBody: $("#drawer-body"),
    drawerName: $("#drawer-name"), drawerPill: $("#drawer-pill"), drawerGoal: $("#drawer-goal"),
    drawerMeta: $("#drawer-meta"), drawerRaw: $("#drawer-raw"), toast: $("#toast"),
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
    if (v !== 0 && Math.abs(v) < 0.01) return "$" + v.toFixed(4);
    if (Math.abs(v) >= 1000) return "$" + v.toLocaleString(undefined, { maximumFractionDigits: 0 });
    return "$" + v.toFixed(2);
  }
  function compact(n) {
    n = num(n);
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k";
    return String(n);
  }
  function clock(ts) {
    const d = ts ? new Date(ts > 1e12 ? ts : ts * 1000) : new Date();
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  }
  function trunc(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
  function argsStr(a) {
    if (a == null) return "";
    try {
      if (typeof a !== "object") return String(a);
      const keys = Object.keys(a);
      if (!keys.length) return "";
      return keys.map((k) => k + "=" + JSON.stringify(a[k])).join(", ");
    } catch (e) { return String(a); }
  }
  const runName = (id) => { const r = S.runs.get(id); return (r && (r.name || r.id)) || id || "run"; };
  const safeStatus = (s) => (STATUS_LABEL[s] ? s : "running");

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
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2800);
  }

  // ---------------------------------------------------------------- runs
  function upsertRun(sum, opts) {
    if (!sum || !sum.id) return;
    const prev = S.runs.get(sum.id);
    if (!S.firstModel.has(sum.id) && sum.model) S.firstModel.set(sum.id, sum.model);
    S.runs.set(sum.id, sum);
    if (!(opts && opts.silent)) feedFromRunUpdate(prev, sum);
    renderCard(sum, prev);
    if (S.drawerId === sum.id) renderDrawerHead(sum);
  }

  // Needs-attention first: paused, then live runs, then finished; stable by start time within a group.
  const PRIORITY = { paused: 0, running: 1, nudged: 1, downgraded: 1, killed: 2, completed: 2 };
  function sortedRuns() {
    return Array.from(S.runs.values()).sort((a, b) =>
      (num(PRIORITY[a.status], 1) - num(PRIORITY[b.status], 1)) || (num(a.created_at) - num(b.created_at)));
  }
  function reorderCards() {
    const want = sortedRuns().map((r) => cardFor(r.id)).filter(Boolean);
    const have = Array.from(el.runs.children);
    if (want.length === have.length && want.every((c, i) => c === have[i])) return;
    want.forEach((c) => el.runs.appendChild(c));
  }

  function renderAllCards() {
    const ids = new Set(S.runs.keys());
    Array.from(el.runs.children).forEach((c) => { if (!ids.has(c.dataset.id)) c.remove(); });
    sortedRuns().forEach((r) => renderCard(r, null));
    reorderCards();
    toggleEmpty();
  }

  function toggleEmpty() {
    el.empty.hidden = S.runs.size > 0;
    el.runs.hidden = S.runs.size === 0;
  }

  function cardFor(id) {
    return el.runs.querySelector('.card[data-id="' + CSS.escape(id) + '"]');
  }

  function renderCard(r, prev) {
    let card = cardFor(r.id);
    if (!card) {
      card = document.createElement("article");
      card.className = "card";
      card.dataset.id = r.id;
      card.tabIndex = 0;
      // insert in created_at-desc order
      const list = sortedRuns();
      const idx = list.findIndex((x) => x.id === r.id);
      const next = list.slice(idx + 1).map((x) => cardFor(x.id)).find(Boolean);
      el.runs.insertBefore(card, next || null);
      toggleEmpty();
    }
    const status = safeStatus(r.status);
    const html = cardHTML(r, status);
    if (card._html === html && card.classList.contains("s-" + status)) return;
    card.className = "card s-" + status;
    card.innerHTML = html;
    card._html = html;
    if (prev && prev.status !== r.status) {
      reorderCards();
      void card.offsetWidth; // restart animation
      card.classList.add("flash");
    }
  }

  function cardHTML(r, status) {
    const spent = num(r.spent_usd), budget = num(r.budget_usd, 1);
    const pct = budget > 0 ? Math.min(100, (spent / budget) * 100) : 0;
    const barCls = pct >= 90 ? "hot" : pct >= 60 ? "warn" : "";
    const hist = Array.isArray(r.score_history) ? r.score_history : [];
    const score = num(r.stuck_score);
    const first = S.firstModel.get(r.id);
    const model = r.model || first || "—";
    const modelHTML = first && r.model && first !== r.model
      ? '<span class="model-down"><s>' + esc(first) + "</s> → <b>" + esc(r.model) + "</b></span>"
      : "<span><b>" + esc(model) + "</b></span>";
    const signals = Array.isArray(r.signals) ? r.signals.slice().sort((a, b) => num(b.severity) - num(a.severity)) : [];

    let middle = "";
    if (status === "killed") {
      middle = '<div class="outcome killed">🛑 ' + esc(r.kill_reason || "Stopped by Tripwire.") +
        (num(r.saved_usd) > 0 ? ' <span class="saved">· ' + money(r.saved_usd) + " waste avoided</span>" : "") + "</div>";
    } else if (status === "completed") {
      middle = '<div class="outcome completed">🏁 Completed in ' + num(r.steps) + " steps" +
        (num(r.nudges_sent) > 0 ? " — recovered after " + (r.nudges_sent === 1 ? "a nudge" : r.nudges_sent + " nudges") : "") + ".</div>";
    } else if (signals.length) {
      middle = '<ul class="signals">' + signals.slice(0, 2).map((s) => {
        const sev = num(s.severity);
        const cls = sev >= 0.8 ? "sev-high" : sev < 0.5 ? "sev-low" : "";
        return '<li class="signal ' + cls + '"><span class="sev">' + sev.toFixed(1) + '</span><span class="msg">' +
          esc(s.message || s.detector || "signal") + "</span></li>";
      }).join("") + (signals.length > 2 ? '<li class="healthy" style="margin:0">+' + (signals.length - 2) + " more</li>" : "") + "</ul>";
    } else {
      middle = '<div class="healthy">No issues detected</div>';
    }

    let actions = "";
    if (status === "paused") {
      middle += '<div class="paused-box"><div class="paused-q">⏸ Paused — waiting for a human decision</div>' +
        '<div class="paused-btns"><button class="btn btn-big btn-approve" data-act="approve" type="button">✓ Approve</button>' +
        '<button class="btn btn-big btn-kill" data-act="kill" type="button">✕ Kill</button></div></div>';
    } else if (!TERMINAL.has(status)) {
      actions = '<div class="card-actions"><button class="btn btn-sm" data-act="pause" type="button">Pause</button>' +
        '<button class="btn btn-sm btn-danger" data-act="kill" type="button">Kill</button></div>';
    }

    return (
      '<div class="card-head"><div class="card-title"><h3 class="card-name" title="' + esc(r.id) + '">' + esc(r.name || r.id) + "</h3>" +
      (r.goal ? '<div class="card-goal" title="' + esc(r.goal) + '">' + esc(r.goal) + "</div>" : "") + "</div>" +
      '<span class="pill s-' + status + '">' + STATUS_LABEL[status] + "</span></div>" +
      '<div class="card-row"><div><div class="mini-label">Spend vs budget<b>' + Math.round(pct) + "%</b></div>" +
      '<div class="spend-nums">' + money(spent) + " <span>/ " + money(budget) + "</span></div>" +
      '<div class="bar ' + barCls + '"><i style="width:' + pct.toFixed(1) + '%"></i></div></div>' +
      '<div><div class="mini-label"><span>Stuck<span class="hide-sm"> score</span></span><b style="color:' + scoreColor(score) + '">' + score.toFixed(2) + "</b></div>" +
      sparkline(hist, r.id) + "</div></div>" +
      middle +
      '<div class="card-foot"><div class="meta">' + modelHTML +
      "<span><b>" + num(r.steps) + "</b> steps</span>" +
      "<span><b>" + compact(num(r.input_tokens) + num(r.output_tokens)) + "</b> tok</span>" +
      (num(r.nudges_sent) ? "<span><b>" + r.nudges_sent + "</b> nudge" + (r.nudges_sent > 1 ? "s" : "") + "</span>" : "") +
      "</div>" + actions + "</div>"
    );
  }

  function scoreColor(v) {
    if (v >= 0.8) return "var(--red)";
    if (v >= 0.5) return "var(--amber)";
    if (v > 0) return "var(--blue)";
    return "var(--green)";
  }

  function sparkline(hist, key) {
    const W = 132, H = 44, pad = 4;
    const vals = hist.map((v) => Math.max(0, Math.min(1, num(v))));
    const y = (v) => pad + (1 - v) * (H - pad * 2);
    let body = '<line class="thr" x1="0" x2="' + W + '" y1="' + y(0.5) + '" y2="' + y(0.5) + '"/>';
    if (vals.length === 0) {
      body += '<line x1="0" x2="' + W + '" y1="' + y(0) + '" y2="' + y(0) + '" stroke="var(--faint)" stroke-width="1.5"/>';
    } else {
      const pts = vals.length === 1 ? [vals[0], vals[0]] : vals;
      const step = (W - pad * 2) / (pts.length - 1);
      const xy = pts.map((v, i) => [pad + i * step, y(v)]);
      const last = vals[vals.length - 1];
      const color = scoreColor(Math.max(last, 0));
      const line = xy.map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
      const area = "M" + xy[0][0].toFixed(1) + "," + (H - pad) + " L" + line.replace(/ /g, " L") +
        " L" + xy[xy.length - 1][0].toFixed(1) + "," + (H - pad) + " Z";
      const gid = "sg-" + String(key || "x").replace(/[^a-zA-Z0-9_-]/g, "_");
      body += '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + color +
        '" stop-opacity=".35"/><stop offset="1" stop-color="' + color + '" stop-opacity="0"/></linearGradient></defs>' +
        '<path d="' + area + '" fill="url(#' + gid + ')"/>' +
        '<polyline class="line" points="' + line + '" stroke="' + color + '"/>' +
        '<circle class="dot" r="3.5" cx="' + xy[xy.length - 1][0].toFixed(1) + '" cy="' + xy[xy.length - 1][1].toFixed(1) + '" fill="' + color + '"/>';
    }
    return '<svg class="spark" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" aria-hidden="true">' + body + "</svg>";
  }

  // ---------------------------------------------------------------- stats
  function localStats() {
    const runs = Array.from(S.runs.values());
    return {
      runs_total: runs.length,
      runs_active: runs.filter((r) => !TERMINAL.has(r.status)).length,
      runs_killed: runs.filter((r) => r.status === "killed").length,
      runs_completed: runs.filter((r) => r.status === "completed").length,
      nudges_sent: runs.reduce((a, r) => a + num(r.nudges_sent), 0),
      recovered_after_nudge: runs.filter((r) => num(r.nudges_sent) > 0 && r.status === "completed").length,
      spent_usd: runs.reduce((a, r) => a + num(r.spent_usd), 0),
      saved_usd: runs.reduce((a, r) => a + num(r.saved_usd), 0),
    };
  }

  function renderStats() {
    const st = Object.assign(localStats(), S.stats || {});
    $("#stat-active").textContent = num(st.runs_active);
    $("#stat-active-sub").textContent = num(st.runs_total) + " total";
    $("#stat-nudges").textContent = num(st.nudges_sent);
    $("#stat-killed-sub").textContent = num(st.runs_killed) + " killed";
    $("#stat-recovered").textContent = num(st.recovered_after_nudge);
    $("#stat-completed-sub").textContent = "after nudge · " + num(st.runs_completed) + " done";
    countTo("spent", $("#stat-spent"), num(st.spent_usd), 700);
    const savedEl = $("#stat-saved");
    if (num(st.saved_usd) > S.shown.saved + 1e-9) {
      const hero = savedEl.closest(".stat-hero");
      hero.classList.remove("bump"); void hero.offsetWidth; hero.classList.add("bump");
    }
    countTo("saved", savedEl, num(st.saved_usd), 1600);
  }

  const anims = {}, animTarget = {};
  function countTo(key, node, target, dur) {
    const from = S.shown[key] || 0;
    if (anims[key] && Math.abs(animTarget[key] - target) < 1e-9) return; // already heading there
    if (Math.abs(target - from) < 1e-9) { node.textContent = money(target); return; }
    if (anims[key]) cancelAnimationFrame(anims[key]);
    animTarget[key] = target;
    const t0 = performance.now();
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      const v = from + (target - from) * e;
      S.shown[key] = v;
      node.textContent = money(v);
      if (p < 1) anims[key] = requestAnimationFrame(tick);
      else { S.shown[key] = target; node.textContent = money(target); anims[key] = 0; }
    };
    anims[key] = requestAnimationFrame(tick);
  }

  let statsTimer = null;
  function refreshStatsSoon() {
    clearTimeout(statsTimer);
    statsTimer = setTimeout(() => {
      api("/api/stats").then((st) => { if (st && typeof st === "object") { S.stats = st; renderStats(); } }).catch(() => {});
    }, 400);
  }

  // ---------------------------------------------------------------- feed
  let feedAppend = false; // when true, pushFeed adds to the bottom (used to backfill history)
  function pushFeed(item) {
    if (feedAppend && S.feed.length >= FEED_MAX) return;
    if (feedAppend) S.feed.push(item); else S.feed.unshift(item);
    if (S.feed.length > FEED_MAX) S.feed.length = FEED_MAX;
    const li = document.createElement("li");
    li.className = "ev k-" + (item.kind || "info");
    li.innerHTML = '<span class="emo">' + item.emoji + '</span><span><span class="when">' + clock(item.ts) +
      '</span><span class="txt">' + item.html + "</span></span>";
    if (feedAppend) el.feed.appendChild(li); else el.feed.insertBefore(li, el.feed.firstChild);
    while (el.feed.children.length > FEED_MAX) el.feed.lastChild.remove();
    el.feedEmpty.hidden = true;
    el.feedCount.textContent = S.feed.length + " events";
  }
  function clearFeed() {
    S.feed = []; el.feed.innerHTML = ""; el.feedEmpty.hidden = false; el.feedCount.textContent = "";
  }

  const nameB = (id) => "<b>" + esc(runName(id)) + "</b>";

  function feedFromRunUpdate(prev, r) {
    const ts = r.last_seen;
    if (!prev) {
      pushFeed({ emoji: "🚀", kind: "info", ts, html: nameB(r.id) + " connected" + (r.goal ? ' <span class="dim">— ' + esc(trunc(r.goal, 70)) + "</span>" : "") });
      return;
    }
    if (prev.status === r.status) return;
    if (r.status === "completed") {
      const rec = num(r.nudges_sent) > 0;
      pushFeed({ emoji: rec ? "💚" : "🏁", kind: rec ? "good" : "done", ts,
        html: nameB(r.id) + (rec ? " completed after nudge — <b>recovered</b>" : " completed") +
          ' <span class="dim">(' + num(r.steps) + " steps, " + money(r.spent_usd) + ")</span>" });
    } else if (r.status === "killed") {
      pushFeed({ emoji: "🛑", kind: "kill", ts,
        html: nameB(r.id) + " stopped" + (num(r.saved_usd) > 0 ? " · <b>" + money(r.saved_usd) + "</b> projected waste avoided" : "") +
          (r.kill_reason ? ' <span class="dim">— ' + esc(trunc(r.kill_reason, 110)) + "</span>" : "") });
    } else if (r.status === "running" && prev.status === "nudged") {
      pushFeed({ emoji: "💚", kind: "good", ts, html: nameB(r.id) + " recovered after nudge — back to normal" });
    } else if (r.status === "running" && prev.status === "paused") {
      pushFeed({ emoji: "👍", kind: "good", ts, html: nameB(r.id) + " approved by a human — resuming" });
    }
  }

  function feedIntervention(id, d, ts) {
    if (!d || !d.action || d.action === "none") return;
    const reason = esc(trunc(d.reason || "", 140));
    const map = {
      nudge: ["🟡", "nudge", "Nudged " + nameB(id) + (reason ? ": " + reason : "")],
      downgrade: ["🔽", "downgrade", "Downgraded " + nameB(id) + (d.downgrade_model ? " to <code>" + esc(d.downgrade_model) + "</code>" : "") + (reason ? ": " + reason : "")],
      pause: ["⏸️", "pause", "Paused " + nameB(id) + " — <b>waiting for a human</b>" + (reason ? ' <span class="dim">' + reason + "</span>" : "")],
      kill: ["🔴", "kill", "Killed " + nameB(id) + (reason ? ": " + reason : "")],
    };
    const m = map[d.action] || ["⚡", "info", esc(d.action) + " " + nameB(id) + (reason ? ": " + reason : "")];
    pushFeed({ emoji: m[0], kind: m[1], ts, html: m[2] });
  }

  function feedAnalysis(id, data, ts) {
    const sigs = (data && Array.isArray(data.signals)) ? data.signals : [];
    const key = sigs.map((s) => s.detector).sort().join("|");
    const prevKey = S.signalKey.get(id);
    S.signalKey.set(id, key);
    if (prevKey === key || (prevKey === undefined && !key)) return;
    if (!sigs.length) {
      pushFeed({ emoji: "✅", kind: "good", ts, html: nameB(id) + " looks healthy again" });
      return;
    }
    const prevSet = new Set((prevKey || "").split("|"));
    const fresh = sigs.filter((s) => !prevSet.has(s.detector));
    const top = (fresh.length ? fresh : sigs).slice().sort((a, b) => num(b.severity) - num(a.severity))[0];
    pushFeed({ emoji: "⚠️", kind: "signal", ts,
      html: nameB(id) + ": " + esc(trunc(top.message || top.detector, 150)) +
        ' <span class="dim">(score ' + num(data.stuck_score, num(top.severity)).toFixed(2) + ")</span>" });
  }

  function feedStep(id, st, ts) {
    const calls = (st && Array.isArray(st.tool_calls)) ? st.tool_calls : [];
    if (!calls.length) return;
    const names = calls.map((c) => "<code>" + esc(c && c.name || "tool") + "</code>").join(" ");
    pushFeed({ emoji: "🔧", kind: "step", ts, html: esc(runName(id)) + " → " + names });
  }

  // ---------------------------------------------------------------- SSE
  function setConn(state) {
    el.conn.className = "conn conn-" + state;
    $("span", el.conn).textContent = state === "live" ? "live" : state === "down" ? "reconnecting" : "connecting";
  }

  function connect() {
    if (S.es) { try { S.es.close(); } catch (e) { /* ignore */ } }
    setConn(S.retry ? "down" : "connecting");
    let es;
    try { es = new EventSource("/api/stream"); } catch (e) { scheduleReconnect(); return; }
    S.es = es;
    es.onopen = () => {
      setConn("live");
      if (S.hadError) { S.hadError = false; loadInitial(true); }
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
      case "run_update":
        upsertRun(Object.assign({ id: id }, data));
        refreshStatsSoon();
        renderStats();
        break;
      case "step":
        if (id && !S.runs.has(id)) loadRun(id);
        if (data && data.model && id && !S.firstModel.has(id)) S.firstModel.set(id, data.model);
        feedStep(id, data, ts);
        if (S.drawerId === id && S.drawerTab === "timeline") refreshDrawerSoon();
        break;
      case "analysis":
      case "signal":
        feedAnalysis(id, data, ts);
        break;
      case "intervention":
        feedIntervention(id, data, ts);
        if (S.drawerId === id) refreshDrawerSoon();
        break;
      case "stats":
        if (data && typeof data === "object") {
          // Server was reset elsewhere (e.g. another tab or a script): drop stale runs.
          if (num(data.runs_total, -1) === 0 && S.runs.size) wipe();
          S.stats = data; renderStats();
        }
        break;
      case "reset":
        wipe();
        break;
      default:
        break;
    }
  }

  function loadRun(id) {
    api("/api/runs/" + encodeURIComponent(id)).then((d) => {
      if (d && d.run) {
        const st = Array.isArray(d.steps) ? d.steps : [];
        if (st[0] && st[0].model && !S.firstModel.has(id)) S.firstModel.set(id, st[0].model);
        upsertRun(d.run);
      }
    }).catch(() => {});
  }

  async function loadInitial(resync) {
    try {
      const [runs, stats] = await Promise.all([api("/api/runs"), api("/api/stats").catch(() => null)]);
      const list = Array.isArray(runs) ? runs : (runs && Array.isArray(runs.runs) ? runs.runs : []);
      if (resync) {
        const keep = new Set(list.map((r) => r.id));
        Array.from(S.runs.keys()).forEach((k) => { if (!keep.has(k)) S.runs.delete(k); });
      }
      list.forEach((r) => {
        if (!r || !r.id) return;
        if (!S.firstModel.has(r.id) && r.model) S.firstModel.set(r.id, r.model);
        S.runs.set(r.id, r);
        S.signalKey.set(r.id, (Array.isArray(r.signals) ? r.signals : []).map((s) => s.detector).sort().join("|"));
      });
      S.stats = stats && typeof stats === "object" ? stats : null;
      renderAllCards();
      renderStats();
      // Late join: fetch details to recover original models and backfill the feed with past interventions.
      if (!resync || !S.feed.length) seedFromDetails(list);
    } catch (e) {
      console.warn("tripwire: initial load failed", e);
      toggleEmpty();
    }
  }

  async function seedFromDetails(list) {
    const ids = list.filter((r) => r && r.id).map((r) => r.id).slice(0, 30);
    if (!ids.length) return;
    const details = await Promise.all(ids.map((id) => api("/api/runs/" + encodeURIComponent(id)).catch(() => null)));
    const past = [];
    details.forEach((d, i) => {
      if (!d) return;
      const id = ids[i];
      const st = Array.isArray(d.steps) ? d.steps : [];
      if (st[0] && st[0].model) {
        S.firstModel.set(id, st[0].model);
        const r = S.runs.get(id); if (r) renderCard(r, null);
      }
      (Array.isArray(d.events) ? d.events : []).forEach((e) => {
        if (e && e.type === "intervention" && e.data) past.push({ id, ts: num(e.ts, num(e.data.ts)), data: e.data });
      });
      const r = d.run || {};
      if (r.status === "killed" || r.status === "completed") past.push({ id, ts: num(r.last_seen) + 0.001, end: r });
    });
    // History goes below anything that arrived live meanwhile, newest first.
    feedAppend = true;
    try {
      past.sort((a, b) => b.ts - a.ts).slice(0, 40).forEach((p) => {
        if (p.end) feedFromRunUpdate({ status: "_" }, p.end);
        else feedIntervention(p.id, p.data, p.ts || null);
      });
    } finally { feedAppend = false; }
  }

  function wipe() {
    S.runs.clear(); S.firstModel.clear(); S.signalKey.clear(); S.stats = null;
    el.runs.innerHTML = "";
    clearFeed();
    closeDrawer();
    renderAllCards();
    renderStats();
  }

  // ---------------------------------------------------------------- actions
  async function doAction(id, action, btn) {
    if (btn) btn.disabled = true;
    try {
      const sum = await api("/api/runs/" + encodeURIComponent(id) + "/action", { method: "POST", body: JSON.stringify({ action }) });
      if (sum && sum.id) upsertRun(sum);
      const verb = { approve: "Approved", kill: "Kill sent to", pause: "Pause requested for", resume: "Resumed" }[action] || action;
      toast(verb + " " + runName(id));
      if (action === "pause") pushFeed({ emoji: "✋", kind: "pause", ts: null, html: "You requested a pause for " + nameB(id) + " (on next step)" });
      refreshStatsSoon();
    } catch (e) {
      toast("Action failed: " + e.message, true);
    } finally {
      if (btn && btn.isConnected) btn.disabled = false;
    }
  }

  el.runs.addEventListener("click", (ev) => {
    const card = ev.target.closest(".card");
    if (!card) return;
    const btn = ev.target.closest("button[data-act]");
    if (btn) { ev.stopPropagation(); doAction(card.dataset.id, btn.dataset.act, btn); return; }
    openDrawer(card.dataset.id);
  });
  el.runs.addEventListener("keydown", (ev) => {
    if ((ev.key === "Enter" || ev.key === " ") && ev.target.classList.contains("card")) {
      ev.preventDefault(); openDrawer(ev.target.dataset.id);
    }
  });

  let resetArmed = null;
  el.reset.addEventListener("click", async () => {
    if (!resetArmed) {
      el.reset.textContent = "Click to confirm";
      el.reset.classList.add("confirm");
      resetArmed = setTimeout(() => { resetArmed = null; el.reset.textContent = "Reset demo"; el.reset.classList.remove("confirm"); }, 3000);
      return;
    }
    clearTimeout(resetArmed); resetArmed = null;
    el.reset.textContent = "Reset demo"; el.reset.classList.remove("confirm");
    try {
      await api("/api/reset", { method: "POST", body: "{}" });
      wipe();
      await loadInitial(true);
      toast("Demo reset — all runs cleared");
    } catch (e) { toast("Reset failed: " + e.message, true); }
  });

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
    el.drawerBody.innerHTML = '<div class="loading">Loading steps…</div>';
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
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && S.drawerId) closeDrawer(); });
  document.querySelectorAll(".tab[data-tab]").forEach((t) => t.addEventListener("click", () => {
    if (!S.drawerId) return;
    S.drawerTab = t.dataset.tab; setTabs();
    el.drawerBody.innerHTML = '<div class="loading">Loading…</div>';
    loadDrawer();
  }));
  function setTabs() {
    document.querySelectorAll(".tab[data-tab]").forEach((t) => t.classList.toggle("active", t.dataset.tab === S.drawerTab));
  }

  function renderDrawerHead(r) {
    const status = safeStatus(r.status);
    el.drawerName.textContent = r.name || r.id;
    el.drawerPill.className = "pill s-" + status;
    el.drawerPill.textContent = STATUS_LABEL[status];
    el.drawerGoal.textContent = r.goal || "";
    const first = S.firstModel.get(r.id);
    const model = first && r.model && first !== r.model ? esc(first) + " → " + esc(r.model) : esc(r.model || first || "—");
    el.drawerMeta.innerHTML =
      "<span>id <b>" + esc(r.id) + "</b></span><span>model <b>" + model + "</b></span>" +
      "<span>spent <b>" + money(r.spent_usd) + " / " + money(r.budget_usd) + "</b></span>" +
      "<span><b>" + num(r.steps) + "</b> steps</span>" +
      (num(r.saved_usd) > 0 ? '<span>saved <b style="color:var(--green)">' + money(r.saved_usd) + "</b></span>" : "") +
      (status === "paused" ? '<div class="paused-btns drawer-acts"><button class="btn btn-big btn-approve" data-act="approve" type="button">✓ Approve</button>' +
        '<button class="btn btn-big btn-kill" data-act="kill" type="button">✕ Kill</button></div>' : "");
  }
  el.drawerMeta.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-act]");
    if (btn && S.drawerId) doAction(S.drawerId, btn.dataset.act, btn);
  });

  let drawerTimer = null;
  function refreshDrawerSoon() {
    clearTimeout(drawerTimer);
    drawerTimer = setTimeout(loadDrawer, 350);
  }

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
          const st = Array.isArray(d.steps) ? d.steps : [];
          if (st[0] && st[0].model && !S.firstModel.has(id)) S.firstModel.set(id, st[0].model);
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
      if (S.drawerId === id) el.drawerBody.innerHTML = '<div class="err">Could not load: ' + esc(e.message) + "</div>";
    }
  }

  function timelineHTML(d) {
    const steps = Array.isArray(d.steps) ? d.steps : [];
    const run = d.run || {};
    if (!steps.length) return '<div class="loading">No steps yet.</div>';
    const items = steps.map((s) => {
      const calls = Array.isArray(s.tool_calls) ? s.tool_calls : [];
      const results = Array.isArray(s.tool_results) ? s.tool_results : [];
      const byId = {};
      results.forEach((r) => { if (r && r.tool_use_id) byId[r.tool_use_id] = r; });
      const hasErr = results.some((r) => r && r.is_error);
      const iv = s.intervention && s.intervention.action && s.intervention.action !== "none" ? s.intervention : null;
      let html = "";
      if (iv) {
        const label = { nudge: "🟡 Nudge sent", downgrade: "🔽 Downgraded", pause: "⏸️ Paused for human", kill: "🔴 Killed" }[iv.action] || iv.action;
        html += '<div class="tl-int a-' + esc(iv.action) + '"><b>' + label + "</b>" +
          (iv.downgrade_model ? " → <code>" + esc(iv.downgrade_model) + "</code>" : "") +
          (iv.reason ? " — " + esc(iv.reason) : "") +
          (iv.nudge_text ? "<pre>" + esc(iv.nudge_text) + "</pre>" : "") + "</div>";
      }
      const text = s.text_preview != null ? s.text_preview : s.text;
      html += '<div class="tl-card"><div class="tl-head"><span>' + esc(s.model || "") + " · " + clock(s.ts) + "</span><span>" +
        compact(s.input_tokens) + " in / " + compact(s.output_tokens) + " out · " + money(s.cost_usd) +
        (s.stop_reason ? " · " + esc(s.stop_reason) : "") + "</span></div>";
      if (text) html += '<div class="tl-text">' + esc(trunc(text, 600)) + "</div>";
      const used = new Set();
      calls.forEach((c) => {
        if (!c) return;
        html += '<div class="tl-call"><span class="fn">' + esc(c.name || "tool") + '</span>(<span class="args">' + esc(trunc(argsStr(c.args), 300)) + "</span>)</div>";
        const r = byId[c.id];
        if (r) { used.add(c.id); html += resultHTML(r); }
      });
      results.forEach((r) => { if (r && !used.has(r.tool_use_id)) html += resultHTML(r); });
      html += "</div>";
      return '<li class="tl-item' + (hasErr ? " has-error" : "") + (iv ? " has-int" : "") + '"><span class="tl-num">' +
        esc(s.index != null ? s.index : "") + "</span>" + html + "</li>";
    }).join("");
    let end = "";
    if (run.status === "killed") end = '<div class="tl-end">🛑 Run stopped' + (run.kill_reason ? ": " + esc(run.kill_reason) : "") + "</div>";
    else if (run.status === "completed") end = '<div class="tl-end">🏁 Run completed</div>';
    return '<ol class="tl">' + items + "</ol>" + end;
  }
  function resultHTML(r) {
    return '<div class="tl-res' + (r.is_error ? " is-error" : "") + '"><span class="arrow">↳ </span>' +
      (r.is_error ? "error: " : "") + esc(trunc(r.preview || "(empty)", 240)) + "</div>";
  }

  // ---------------------------------------------------------------- tiny markdown
  function inlineMd(s) {
    // s is already HTML-escaped
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
        while (i < lines.length && /^\s*\|/.test(lines[i])) {
          t += "<tr>" + cells(lines[i]).map((c) => "<td>" + inlineMd(c) + "</td>").join("") + "</tr>"; i++;
        }
        out += '<div class="tbl">' + t + "</tbody></table></div>"; continue;
      }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
        flush();
        const ordered = /^\s*\d+[.)]/.test(l);
        let t = ordered ? "<ol>" : "<ul>";
        while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
          const item = lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, "");
          const indent = /^\s{2,}/.test(lines[i]);
          t += "<li" + (indent ? ' style="margin-left:1.2em"' : "") + ">" + inlineMd(item) + "</li>"; i++;
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
  $("#empty-url").textContent = /^https?:/.test(location.origin) ? location.origin : "http://localhost:8787";
  renderStats();
  loadInitial(false).then(connect);

  // Relative-time freshness: re-render stats occasionally in case events were missed.
  setInterval(() => { if (S.es && S.es.readyState === EventSource.OPEN) refreshStatsSoon(); }, 15000);
})();
