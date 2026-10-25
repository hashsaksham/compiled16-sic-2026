# Tripwire: 2-minute demo video

How to record it, plus the script to read while you do.

---

## Part 1: Get ready (10 minutes, before you hit record)

### Your Mac
- [ ] Turn on **Do Not Disturb**: Control Center (top-right) → Focus → Do Not Disturb. This stops pop-ups from showing up in the video.
- [ ] Close Slack, Messages, email, and any tabs with personal info.
- [ ] Plug in your charger. Use headphones with a mic, or sit in a quiet room close to the laptop.
- [ ] Set the screen to a normal size: System Settings → Displays → "Default".

### Tripwire
Open Terminal in the project folder and run:
```bash
scripts/start.sh
```
Then:
- [ ] Open **http://localhost:8787** in Chrome or Safari. Make the window full screen (green button). Zoom to 110–125% with **Cmd +** so text is readable on video.
- [ ] Click **Reset demo** on the dashboard so it starts empty.
- [ ] Open the **History** tab → **Clear history** (click twice) to remove old test events, then go back to **Runs**.
- [ ] In a second Terminal tab, type `scripts/demo.sh` but **don't press Enter yet**.
- [ ] Open `demo/agent.py` in your editor at **line 93** (the `base_url=` line). This is the "one-line change" shot.

### Do a dry run first
Run `scripts/demo.sh` once without recording so you know the timing (about 40 seconds of agent activity). Then **Reset demo** and **Clear history** again.

> Pauses now wait up to **3 minutes** for you. In the video, click **Approve** or **Stop** yourself after a few seconds; don't wait for the timer.

---

## Part 2: How to record (Mac)

**Simplest: built-in screen recording**
1. Press **Cmd + Shift + 5**.
2. In the toolbar choose **Record Entire Screen** (or "Record Selected Portion" around the browser).
3. Click **Options** → under *Microphone* choose your mic (e.g. "MacBook Pro Microphone" or your headset). Also tick **Show Mouse Clicks**.
4. Click **Record**. Talk while you click through the script below.
5. To stop: click the **⏹ stop button** in the menu bar (top of the screen), or press **Cmd + Ctrl + Esc**.
6. The video lands on your Desktop as a `.mov` file.

**Want your face in the corner? (optional)**
Open QuickTime Player → File → **New Movie Recording** → right-click the camera window → **Float on Top**. Shrink it to a corner, then record the screen as above. The floating camera is captured too.

**Trim it**
Open the `.mov` in QuickTime → **Edit → Trim** (Cmd + T) → drag the yellow handles to cut dead time at the start and end → Save. Keep it **under 2:00**.

**Too long?** Re-record. Two or three takes is normal. Or speed up the waiting part in iMovie (select clip → speedometer icon → 2×).

**Upload**
Upload to YouTube as **Unlisted** (or Google Drive / Loom with "anyone with the link can view") and paste the link into the submission form. Open the link in a private window to check that it plays.

---

## Part 3: The script (about 2:00)

Speak slowly. The **[brackets]** are what to do on screen while you say each part.

### 0:00–0:15 · The problem
**[Dashboard open, empty]**
> "AI agents now run for hours with nobody watching. When they get stuck, they don't crash. They loop. They retry the same failing call fifty times, flip-flop on decisions, or quietly burn through your budget. You find out from the invoice."

### 0:15–0:30 · The fix, in one line
**[Switch to the editor showing `base_url=` in demo/agent.py]**
> "Tripwire is a circuit breaker for AI agents. You change one line, the address your agent sends its AI requests to, and now every step goes through Tripwire. It works with any agent framework, with no other code changes."

### 0:30–1:25 · Live demo
**[Switch to the terminal, press Enter on `scripts/demo.sh`, then switch to the dashboard]**
> "Here are five agents running at once."

**[Point at the healthy agent finishing]**
> "This one is healthy. Tripwire leaves it completely alone. No false alarms."

**[Point at the oscillator getting a Nudge]**
> "This one keeps flipping a setting back and forth. Tripwire's first move is a **nudge**: it adds a short warning to the agent's instructions. The agent reads it, changes course, and finishes on its own."

**[Point at the spender getting a Downgrade]**
> "This one is doing real work but spending too fast. Tripwire **downgrades** it to a cheaper model, and stops it when the budget runs out."

**[Point at the orange "Needs you" strip at the top: looper, with its countdown]**
> "This one is truly stuck. It's retried the same search over and over and ignored the nudge. So Tripwire **pauses** it and asks me. It's holding the agent with a countdown."

**[Click Stop next to looper in the "Needs you" strip]**
> "I'll **stop** it. The agent gets a clean 'you've been stopped, here's why' message and shuts down gracefully. No crash."

### 1:25–1:45 · Proof it's real
**[Click the History tab: every nudge, downgrade, pause and stop listed in plain English. Then click the looper line to open its details → Post-mortem]**
> "Every intervention is saved in a history, and every run gets a post-mortem: what went wrong, what it cost, and how much waste we avoided."

> "We also ran it on real Claude, told to 'never give up' against a broken API. Tripwire nudged it once, it stopped retrying and wrote an honest failure report, for three cents."

### 1:45–2:00 · Why it matters
**[Back to the Runs tab: every agent on one calm row, with the 4-dot Nudge → Downgrade → Pause → Stop ladder]**
> "Nudge, downgrade, pause, stop: the cheapest fix first, and a human only when it's needed. One line to add, and it scales to every agent a company runs. That's Tripwire."

---

## Part 4: Submission text (copy-paste)

**Project:** Tripwire, a circuit breaker for AI agents
**Track:** Unsupervised

**Description:**
Tripwire is a drop-in supervisor for autonomous AI agents. You point an agent's API base URL at Tripwire (one line, any framework) and it watches every step for signs of trouble: repeated tool calls, repeated errors, flip-flopping, near-identical reasoning, ballooning context, claiming "done" while still working, and budget overrun. It responds in stages, cheapest fix first: **nudge** (a warning added to the agent's instructions), **downgrade** (cheaper model), **pause** (hold the agent until a human approves or stops it, with an auto-stop timer), and **stop** (a graceful final message so the agent exits cleanly). A live dashboard shows every agent, what's being done to it and why, with saved history and a post-mortem per run. Tested end to end with a deterministic mock and with real Claude: told never to give up against a broken API, it was nudged once, recovered, and reported honestly for $0.03.

**How we used AI coding tools:**
Built with Claude Code (Opus 5.5). The lead agent wrote the full spec and froze a shared data contract first, then ran four sub-agents in parallel with strict file ownership (detection engine, proxy/API, dashboard, mock world + demo), plus a docs agent. Each had its own test checklist; the lead integrated them, ran end-to-end and real-model tests, and fixed what they found (the real-Claude run exposed a false-positive bug, which was fixed with a regression test). Distinctive: contract-first parallelism (no merge conflicts by design) and a deterministic mock LLM, so the whole system is testable offline.

---

## Part 5: If something goes wrong while recording
| Problem | Fix |
|---|---|
| "Port is already in use" | `scripts/stop.sh`, then `scripts/start.sh` |
| Dashboard shows old runs | Click **Reset demo** |
| Nothing pauses | The looper pauses about 10–15 s in; wait a moment |
| Video over 2:00 | Cut the 1:25–1:45 section shorter, or speed up the waiting in iMovie |
| No sound in video | Cmd + Shift + 5 → Options → pick your microphone (it defaults to "None") |
