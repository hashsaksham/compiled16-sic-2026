# Tripwire — Master Document

**Event:** c0mpiled-16 @ UCSD, Saturday Oct 24 2026 · **Track:** Unsupervised
**One-liner:** *A circuit breaker for AI agents.* Change one line (the API base URL) and every autonomous agent you run is watched step by step: Tripwire notices when it is looping, oscillating, retrying the same error, lying about being done, or burning money too fast — and it steps in on an escalating ladder: **nudge → downgrade → pause for a human → kill**, then writes a post-mortem.

This document is the single source of truth. Every build agent works from it. If code and this doc disagree, fix one of them on purpose.

---

## 1. The problem

Teams are starting to let agents run for hours (coding agents, research agents, ops agents, browser agents). The failure mode is not "the agent crashes" — it's that the agent **keeps going while making no progress**:

| Failure | What it looks like | Cost |
|---|---|---|
| Tool loop | Calls `search("acme q3 revenue")` 40 times with the same args | Tokens × 40, no result |
| Error retry loop | `deploy()` → "permission denied" → `deploy()` → same error… | Wasted hours, often rate-limit bans |
| Oscillation | Edit file → revert → edit → revert (A-B-A-B) | Infinite, invisible in logs |
| Context bloat | Each step re-reads huge files; input tokens grow every step | Bill grows quadratically |
| Fake done | Says "Task complete!" then keeps calling tools | Confusing, costly |
| Budget blowout | Fine behaviour, but on track to spend 10× what the task is worth | Surprise invoice |

Today the only safeguards are a hard `max_steps` and a monthly spend cap — both blunt, both after the damage. Nobody watches the *behaviour*. The track asks for exactly this: agents that *"recognize when they are stuck, repeating themselves, spending too much, or should stop."*

## 2. The solution

Tripwire is a **drop-in proxy** between any agent and its LLM provider.

```
 agent (any framework)  ──►  Tripwire proxy  ──►  LLM provider (Anthropic / mock)
        ▲                         │
        └── normal responses,     ├── detectors analyse every step
            or nudged/            ├── policy decides an intervention
            downgraded/paused/    ├── live dashboard (SSE)
            graceful-stop         └── post-mortem report per run
```

Why a proxy (the key design bet):
- **Zero code change.** `Anthropic(base_url="http://localhost:8787/r/my-run")`. Works with any SDK or framework that lets you set a base URL — which is nearly all of them. This is the scalability story.
- **Sees the whole truth.** Every prompt, every tool call, every tool result (they come back in the next request), every token count.
- **Can act, not just alert.** Because it sits in the request path it can rewrite the system prompt (nudge), swap the model (downgrade), hold the request (pause), or answer instead of the model (graceful kill — the agent receives a normal `end_turn` message and exits cleanly).

### What makes it different (innovation)
1. **Behavioural detection, not just counters** — 7 detectors over the step history (repetition, oscillation, repeated errors, semantic loops, context bloat, fake-done, budget forecast).
2. **Escalation ladder** — try the cheapest fix first. A nudge often un-sticks the agent (we demo this); only persistent problems escalate.
3. **Graceful kill** — instead of a 4xx that crashes the agent, Tripwire returns a valid assistant message explaining why it stopped, so the agent's own loop ends and logs a reason.
4. **Money-saved accounting** — every kill reports projected waste avoided.

### Real-world impact
Any company running agents unattended: fewer runaway bills, fewer stuck jobs discovered hours later, a human is pulled in only when needed (pause), and every incident has a post-mortem.

## 3. Constraints

- Build window: 1:30 PM – 6:30 PM PT (we plan for ~2–3 focused hours). No pre-existing code.
- No hardware. Laptop only.
- Must demo reliably with **no network/API key** → we ship a deterministic **mock LLM** upstream. Real Anthropic upstream is supported when `ANTHROPIC_API_KEY` is set.
- Python 3.14, `uv` venv at `.venv`. Node not used (dashboard is vanilla HTML/JS, no build step).
- Must disclose AI tool usage (Claude Code with parallel sub-agents — see §11).

## 4. Dependencies

| Dependency | Why | Where |
|---|---|---|
| fastapi, uvicorn | HTTP server for proxy, API, dashboard, mock | `server/`, `demo/mock_upstream.py` |
| httpx | Forwarding requests upstream (async) | `server/upstream.py` |
| anthropic (SDK) | Demo agents use the *real* SDK with a changed base_url — proves drop-in | `demo/` |
| pytest | Detector/policy unit tests | `tests/` |
| No JS deps | Dashboard is plain HTML/CSS/JS with EventSource | `dashboard/` |

Install: `uv venv .venv && uv pip install --python .venv/bin/python fastapi uvicorn httpx anthropic pytest`

## 5. Architecture & file ownership

```
server/
  models.py      shared dataclasses (contract)              OWNER: lead (frozen)
  pricing.py     model → $/token table, cost()              OWNER: Agent B
  detectors.py   analyze(run) -> list[Signal]               OWNER: Agent B
  policy.py      decide(run, signals) -> Decision           OWNER: Agent B
  store.py       in-memory runs + event bus (SSE fan-out)   OWNER: Agent A
  upstream.py    forward to Anthropic or mock               OWNER: Agent A
  app.py         FastAPI: proxy + API + static dashboard    OWNER: Agent A
  report.py      post-mortem markdown                       OWNER: Agent A
dashboard/
  index.html, app.js, style.css                             OWNER: Agent C
demo/
  mock_upstream.py   fake Anthropic Messages API (port 8788) OWNER: Agent D
  agent.py           generic tool-use agent using anthropic SDK  OWNER: Agent D
  run_demo.py        launches 5 scenario agents concurrently    OWNER: Agent D
tests/
  test_detectors.py, test_policy.py   OWNER: Agent B
  test_e2e.py                          OWNER: Agent D
scripts/
  start.sh   starts mock + tripwire; demo.sh runs scenarios   OWNER: Agent D
docs/
  MASTER.md (this), DONKEY.md (plain-English)                 OWNER: lead / Agent E
```

Agents edit only files they own. Need a change elsewhere → note it in your final report.

## 6. Contracts (must match exactly)

### 6.1 Data model
Defined in `server/models.py` — `ToolCall`, `ToolResult`, `Step`, `Signal`, `Decision`, `RunState`. `RunState.summary()` is the Run JSON shape for the API/dashboard.

### 6.2 Proxy endpoints (Anthropic Messages format, non-streaming)
- `POST /r/{run_id}/v1/messages` — preferred; run id lives in the base URL.
- `POST /v1/messages` — run id from header `X-Tripwire-Run` (default `"default"`).
- Optional headers: `X-Tripwire-Name`, `X-Tripwire-Goal`, `X-Tripwire-Budget` (USD float). Defaults: name=run_id, budget=`TRIPWIRE_DEFAULT_BUDGET` (1.00).
- Auth headers (`x-api-key`, `authorization`, `anthropic-version`, `anthropic-beta`) pass through. If upstream is real Anthropic and the request has no key, use env `ANTHROPIC_API_KEY`.
- `stream: true` → v1: force `stream=false` upstream is NOT allowed (SDK expects SSE). Return HTTP 400 `{"error":"tripwire v1 supports stream=false only"}`. (Stretch: streaming.)

**Per-request algorithm (app.py):**
1. Get or create `RunState`. Update `last_seen`, `model` (first time).
2. If status is `killed` → return synthetic stop response immediately.
3. Ingest tool results: the last `user` message's `tool_result` blocks → `ToolResult` list attached to the previous step (`content_hash = stable_hash(content)`, `is_error = block.is_error or text startswith "Error"`).
4. Re-run `detectors.analyze(run)` and `policy.decide(run, signals)` now that tool results are known. Store `run.signals`, `run.stuck_score`; append an `analysis` event `{stuck_score, signals}`.
5. Apply decision:
   - `nudge`: append `"\n\n[TRIPWIRE SUPERVISOR NOTICE] " + nudge_text` to the `system` field (string → concatenate; list of blocks → add a text block; missing → set). Status `nudged`, `nudges_sent += 1`, `steps_since_nudge = 0`.
   - `downgrade`: set `run.downgrade_to`; status `downgraded`.
   - `pause`: status `paused`; await an `asyncio.Event` up to `TRIPWIRE_PAUSE_TIMEOUT` (default 45 s). Human `approve`/`resume` → continue; `run.level` stays at `LEVEL_PAUSE` and `steps_since_nudge` resets to 0, so the agent gets 2 more steps and is killed if still stuck (see policy); `kill` or timeout → kill.
   - `kill`: status `killed`, set `kill_reason`, compute `saved_usd`, return synthetic stop.
   - Always: if `run.downgrade_to` set, overwrite `body["model"]`.
   - Record the decision in an `intervention` event if action != none.
6. Forward to upstream (`TRIPWIRE_UPSTREAM`, default `http://localhost:8788`). Upstream error → pass status + body through unchanged.
7. Parse response → new `Step` (usage tokens, cost via `pricing.cost(model, in, out)`, text blocks joined, `tool_use` blocks → `ToolCall`s, `stop_reason`, `intervention` = decision dict if any). Append. If `stop_reason == "end_turn"` and no tool calls → status `completed`.
8. Publish `step` event + `run_update`. Return upstream response body unchanged.

**Synthetic stop response:**
```json
{"id":"msg_tripwire_<run>_<n>","type":"message","role":"assistant","model":"<model>",
 "content":[{"type":"text","text":"[TRIPWIRE] This run was stopped by the Tripwire supervisor: <reason>. Stop working and report this to the user."}],
 "stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}
```

**saved_usd** = `max(0, burn_per_step(5) * (TRIPWIRE_ASSUMED_HORIZON - steps))`, horizon default 100 steps. Labelled on the UI as "projected waste avoided".

### 6.3 Dashboard API
| Method | Path | Returns |
|---|---|---|
| GET | `/` | `dashboard/index.html` (static files mounted at `/static`) |
| GET | `/api/runs` | `[Run summary]` newest first |
| GET | `/api/runs/{id}` | `{run: summary, steps: [Step.to_dict()], events: [...]}` |
| GET | `/api/stats` | `{runs_total, runs_active, runs_killed, runs_completed, nudges_sent, recovered_after_nudge, spent_usd, saved_usd}` |
| GET | `/api/stream` | SSE. Each message `data: {"type": T, "run_id": id, "ts": t, "data": {...}}` with T ∈ `run_update` (data = summary), `step` (data = Step dict), `signal`/`analysis` (`{stuck_score, signals}`), `intervention` (Decision dict), `stats` (stats dict). Send `: ping` every 15 s. |
| POST | `/api/runs/{id}/action` | body `{"action": "pause"\|"resume"\|"approve"\|"kill"\|"reset"}` → summary. `pause` forces a pause on next request; `reset` sets level 0 and clears pending. |
| GET | `/api/runs/{id}/report` | `text/markdown` post-mortem |
| POST | `/api/reset` | clears all runs (demo convenience) |

`recovered_after_nudge` = runs with nudges_sent > 0 and status `completed`.

### 6.4 Detector interface (`server/detectors.py`)
`analyze(run: RunState) -> list[Signal]` — pure, no I/O, fast (<5 ms for 200 steps). Detectors:

| detector id | Rule (defaults) | severity |
|---|---|---|
| `repeat_tool_call` | same `ToolCall.hash` ≥3 times in last 8 steps | 0.5 at 3, 0.8 at 4, 1.0 at ≥5 |
| `repeat_error` | same error `content_hash` (is_error) ≥3 times in last 8 steps | 0.6 at 3, 0.9 at ≥4 |
| `oscillation` | sequence of per-step tool-call signatures in last 8 steps has a cycle of period 2–3 repeated ≥2 full times (e.g. A B A B), and the elements are not all identical | 0.7, 0.9 if ≥3 repeats |
| `semantic_loop` | Jaccard similarity of word-3-gram shingles between assistant texts; ≥3 of last 5 step texts pairwise > 0.8 (ignore texts < 40 chars) | 0.6 |
| `context_bloat` | input tokens strictly increased for last 5 steps AND last step input > 3× the 5th-from-last | 0.4 |
| `done_but_continuing` | a step text matches /task (is )?(complete|done|finished)|all done|successfully completed/i AND that step or a later one still has tool calls | 0.5 |
| `budget` | spent ≥ 100% budget → 1.0; projected (spent + burn_per_step×10) ≥ 100% → 0.7; spent ≥ 80% → 0.5 | as listed |

Each `Signal.message` must be a full, human sentence suitable to show the model in a nudge, e.g. *"You have called search_web with identical arguments 4 times in the last 8 steps and received the same result."*

### 6.5 Policy interface (`server/policy.py`)
`decide(run: RunState, signals: list[Signal]) -> Decision` — pure, may mutate nothing (app.py applies). Rules:
- `score = max(severity)` (0 if none).
- Budget hard stop: any `budget` signal with severity 1.0 → `kill`.
- Budget forecast 0.7 and not yet downgraded → `downgrade` to `cheaper_model(run.model)` (from pricing); if already downgraded → no further action for forecast alone.
- Behavioural score ≥ 0.5 and `nudges_sent == 0` → `nudge` with text = bullet list of signal messages + "Step back. Do not repeat the same action. Either try a materially different approach or stop and report what is blocking you."
- Behavioural score ≥ 0.5 and already nudged and `steps_since_nudge ≥ 2` → escalate: if `run.level < LEVEL_PAUSE` → `pause`; if `run.level ≥ LEVEL_PAUSE` (human already approved once and it's still stuck) → `kill`.
- Score ≥ 0.95 and `steps_since_nudge ≥ 4` → `kill` regardless.
- Otherwise `none`.
- After a nudge, if the next 2 analyses have score < 0.5, the run is "recovered" (app sets status back to `running`).
- `Decision.level` = level of the chosen action; app sets `run.level = max(run.level, decision.level)`.

### 6.6 Pricing (`server/pricing.py`)
`PRICES = {model: (usd_per_mtok_in, usd_per_mtok_out)}`; `cost(model, in_tok, out_tok) -> float`; `cheaper_model(model) -> str`. Include `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `mock-large` (15/75), `mock-small` (1/5); unknown model → (3, 15). Prices are **configurable estimates**, marked as such in code.

### 6.7 Mock upstream (`demo/mock_upstream.py`, port 8788)
`POST /v1/messages` returns Anthropic-shaped messages. Behaviour is chosen by `SCENARIO: <name>` in the system prompt; deterministic, driven by how many assistant turns exist in `messages`. Simulated latency 0.6–0.9 s. Usage: input_tokens ≈ 1500 + 400×turn (spender: 20000×(turn+1)), output_tokens ≈ 150. Model echoed from request.

| scenario | Behaviour | Expected Tripwire outcome |
|---|---|---|
| `good` | 6 different tool calls (research → write → test), then end_turn "Done: report written." | completed, no interventions (no false positives) |
| `looper` | Always `search_web {"q": "acme corp q3 2026 revenue"}`; ignores nudges | nudge → pause → (timeout or human) kill |
| `oscillator` | Alternates `write_file {path:"config.yaml", content:"mode: fast"}` / `write_file {..."mode: safe"}`; once the system prompt contains `TRIPWIRE SUPERVISOR NOTICE`, says "You're right — I'll stop flip-flopping and pick 'safe' with a comment explaining the tradeoff." then 1 different tool call, then end_turn | nudge → **recovers** → completed |
| `retrier` | Always `deploy {"env":"prod"}` (tool returns permission error); after nudge, still retries | nudge → pause → kill |
| `spender` | Varied, legit tool calls but huge, growing input tokens on `mock-large` | budget forecast → downgrade to `mock-small` → hard budget → kill |

### 6.8 Demo agent (`demo/agent.py`)
Uses `anthropic.Anthropic(base_url=f"{TRIPWIRE}/r/{run_id}", api_key=..., default_headers={X-Tripwire-Name, X-Tripwire-Goal, X-Tripwire-Budget})`. Generic loop: send messages + tool definitions, execute tool_use blocks with local fake tools (`search_web` → "No results found.", `deploy` → is_error "Error: permission denied for role ci-bot", `write_file` → "ok", `read_file`, `run_tests` → "12 passed", etc.), append tool_results, repeat until `end_turn` or 60 steps. Text starting with `[TRIPWIRE]` → print and exit 0. `run_demo.py` starts the 5 scenarios concurrently (threads), staggered 1.5 s, budgets: spender $0.60, others $1.00.

## 7. Configuration (env)
| var | default |
|---|---|
| `TRIPWIRE_PORT` | 8787 |
| `TRIPWIRE_UPSTREAM` | `http://localhost:8788` (mock); `https://api.anthropic.com` for real |
| `TRIPWIRE_DEFAULT_BUDGET` | 1.00 |
| `TRIPWIRE_PAUSE_TIMEOUT` | 45 |
| `TRIPWIRE_ASSUMED_HORIZON` | 100 |

## 8. Phases, tasks and test checklists

### Phase 0 — Ideation & contracts (lead) ✅
Tasks: choose track; define problem; write this doc; freeze `models.py`; set up venv + git.
- [x] Track chosen (Unsupervised) and justified against judging criteria
- [x] `server/models.py` imports cleanly: `.venv/bin/python -c "import server.models"`
- [x] Dependencies install in `.venv`
- [x] Every module has exactly one owner

### Phase 1 — Detection brain (Agent B): pricing, detectors, policy, unit tests
Tasks: implement §6.4–6.6; write table-driven tests building `RunState`s by hand.
- [x] `pytest tests/test_detectors.py tests/test_policy.py` passes
- [x] Each of the 7 detectors has a positive test AND a negative test (no false positive on a healthy varied run)
- [x] A healthy 10-step varied run yields zero signals
- [x] 4 identical tool calls → `repeat_tool_call` severity 0.8
- [x] A B A B → `oscillation`; A A A A → not oscillation (that's repeat)
- [x] Budget 100% → policy `kill`; forecast → `downgrade` once only
- [x] First stuck → `nudge`; still stuck 2 steps later → `pause`; after human approve & still stuck → `kill`
- [x] `analyze` on 200 steps < 5 ms

### Phase 2 — Proxy & API (Agent A): store, upstream, app, report
Tasks: implement §6.2–6.3 and §7.
- [x] `uvicorn server.app:app --port 8787` boots
- [x] Request via `/r/x/v1/messages` with mock upstream returns the upstream body unchanged when no intervention
- [x] Tool results in the next request attach to the previous step
- [x] Nudge text appears in the system prompt forwarded upstream (verify via mock logs)
- [x] Downgrade rewrites `model`
- [x] Pause holds the request; `POST /api/runs/x/action {"action":"approve"}` releases it; timeout kills
- [x] Killed run returns synthetic `end_turn` message on every later request
- [x] `/api/stream` emits `run_update`, `step`, `analysis`, `intervention`, `stats`
- [x] `/api/runs/{id}/report` returns readable markdown with timeline, signals, cost, saved
- [x] `stream: true` → 400 with clear message

### Phase 3 — Dashboard (Agent C)
Tasks: single-page live mission-control view per §6.3.
- [x] Opens at `http://localhost:8787/` with no console errors
- [x] Header stats: active runs, total spent, **projected waste avoided** (big), nudges, recovered
- [x] One card per run: name, goal, status pill (colour per status), spend-vs-budget bar, stuck-score sparkline, current signals, model (shows downgrade), step count
- [x] Live event feed (newest top) with human-readable lines ("🟡 Nudged *looper*: called search_web 4× with same args")
- [x] Paused run shows prominent **Approve / Kill** buttons that call the action API
- [x] Clicking a card opens a step timeline drawer (tool calls, errors, interventions) + "View report"
- [x] Reconnects SSE automatically; works after `/api/reset`
- [x] Readable on a projector (large type, dark theme, high contrast)

### Phase 4 — Mock world & demo agents (Agent D)
Tasks: §6.7, §6.8, `scripts/start.sh`, `scripts/demo.sh`, `tests/test_e2e.py`.
- [x] `scripts/start.sh` launches mock (8788) + Tripwire (8787)
- [x] `scripts/demo.sh` runs all 5 scenarios, finishes in < 3 minutes
- [x] Outcomes match the table in §6.7 (good=completed, oscillator=recovered, looper/retrier=killed after pause, spender=downgraded then killed)
- [x] Agents exit cleanly on `[TRIPWIRE]` (no stack traces)
- [x] `test_e2e.py` starts both servers on random ports and asserts the 5 outcomes (pause timeout shortened to 3 s via env)

### Phase 5 — Integration, polish, real-model run (lead)
- [x] Full demo runs end-to-end 3 times in a row with identical outcomes
- [ ] With `ANTHROPIC_API_KEY` + `TRIPWIRE_UPSTREAM=https://api.anthropic.com`, a real Claude agent given an impossible task is caught (optional, if key available)
- [x] README with 60-second quick start
- [x] DONKEY.md updated to reflect final state

### Phase 6 — Submission & pitch (lead)
- [ ] 2-minute demo script (§10) rehearsed
- [x] AI-tools disclosure written (§11)
- [ ] Submitted before 6:30 PM

## 9. Risks & mitigations
| Risk | Mitigation |
|---|---|
| No API key / flaky wifi at venue | Deterministic mock upstream is the default |
| False positives annoy users | Healthy `good` scenario must produce zero signals; nudge before anything harsh; human approves pauses |
| Streaming not supported | Explicit 400 in v1; stretch goal |
| Agent crashes on interruption | Graceful synthetic `end_turn` instead of HTTP errors |
| Pause blocks forever | Timeout → kill |

## 10. Demo script (2 min)
1. (15 s) Problem: "Agents now run for hours. When they get stuck, they don't crash — they loop, and you pay."
2. (15 s) Show the one-line change: `base_url="http://localhost:8787/r/my-run"`.
3. (60 s) `scripts/demo.sh` → dashboard: `good` sails through untouched; `oscillator` gets nudged and **recovers on its own**; `looper` nudged, still stuck → **paused, phone-style Approve/Kill** → we hit Kill; `spender` auto-downgraded to a cheaper model, then stopped at budget; waste-avoided counter climbs.
4. (15 s) Open a post-mortem report.
5. (15 s) Scale: works with any agent framework that takes a base URL; hosted version = one URL for a whole company's agents; next: streaming, OpenAI format, Slack/SMS escalation.

## 11. AI tools disclosure
Built with **Claude Code** (Opus 5.5). Approach: the lead agent wrote this master spec and froze the shared data contract (`models.py`) first, then launched **four parallel sub-agents** with strict file ownership (detection brain, proxy/API, dashboard, mock world + demo), each with its own test checklist from §8. The lead integrated, ran end-to-end tests, and maintained the docs. Distinctive: contract-first parallelism (no merge conflicts by construction), and a deterministic mock LLM so the whole system is testable without network.

## 12. Progress log
- 15:06 Phase 0 done: idea locked, contracts frozen, env ready.
- ~15:10 Phases 1–4 launched in parallel (4 build agents + 1 docs agent), strict file ownership.
- Phase 1 done: 47 detector/policy tests pass. Resolved: approve keeps `run.level = LEVEL_PAUSE` (so still-stuck → kill); the ≥0.95 kill rule only applies after a nudge; highest-level decision wins when several rules fire.
- Phase 2 done: every Phase 2 checklist item verified. Extra event types: created, signal, recovered, resumed, human_action, killed, completed, error, reset. Added `GET /api/health`.
- Phase 3 done: dashboard tested against a fake API, then the real server.
- Phase 4 done: e2e passes (6 tests). **Deviation from §6.7:** non-spender mock usage is 800+200×turn input / 80 output tokens (not 1500+400×turn / 150). The spec numbers tripped an unwanted budget-forecast downgrade on $1 runs. Spender input = 1500(t+1)+250t².
- Phase 5: live integration on :8787/:8788, browser-tested. Outcomes: good completed (0 nudges), oscillator nudged→recovered→completed, looper paused→**killed by human from dashboard**, retrier paused→timeout kill, spender mock-large→mock-small→budget kill at step 15. Total spent $1.20, projected waste avoided $9.38. Full suite: 53 passed. Fixed: uvicorn `--timeout-graceful-shutdown 2` so open SSE streams don't block restarts.
- Remaining: optional real-Claude run (needs `ANTHROPIC_API_KEY`), rehearse pitch, submit form (human, at venue).
