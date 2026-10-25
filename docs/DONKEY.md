# Tripwire: The Plain-English Version

*This is the simple-language twin of `MASTER.md`. Same project, same plan, no jargon. If the two ever disagree, `MASTER.md` wins, and someone should fix this file.*

---

## What we're doing right now

*Last updated by the lead. This section will be updated as we go.*

- **Phase 0 (the plan): done.** We picked our idea, wrote the master plan, agreed on the shared "data shapes" every part of the system uses, and set up the laptop.
- **Phases 1 to 4: done.** Four helper AI agents built their parts at the same time, each in its own files (like four painters, each in their own room):
  - The "brain" (warning signs + decision rules): 47 automatic checks, all passing.
  - The "middleman" (sits between the agent and the AI, plus the reports): every item on its checklist was tested.
  - The "control room" screen (live dashboard): works on a laptop, a projector and a phone.
  - The "practice world" (a fake AI + five demo characters): the full demo test passes.
- **Phase 5 (putting it together): done.** We ran the real system with the real screen. Every character ended the way we planned: *good* finished untouched, *oscillator* got a nudge and fixed itself, *looper* was paused and a human pressed **Kill** on the screen, *retrier* was paused and then stopped automatically when nobody answered, and *spender* was switched to a cheaper AI model and then stopped at its budget. Projected waste avoided: about $9.38, against $1.20 actually spent. All 53 automatic checks pass.
- **Real Claude test: done.** We gave the real Claude AI a job and told it "keep retrying, never give up", but the service it needed was broken. After three identical failures, Tripwire whispered a warning. Claude changed course and wrote an honest "I couldn't do this, here's why" report. It cost about 3 cents. The first try showed a mistake in Tripwire: it was still holding Claude's *old* failures against it after Claude had already changed course, a bit like a referee still punishing a player for a foul they stopped making. We fixed it so that after a warning, Tripwire only judges what the agent does *next*.
- **Dashboard made calmer: done.** The control-room screen now looks like a tidy to-do list instead of a wall of flashing boxes. Each agent is one row. A row of 4 little dots shows which of the 4 steps (Nudge, Downgrade, Pause, Stop) Tripwire has used. Agents waiting for you sit in an orange "Needs you" strip at the top, with a 3-minute countdown before they stop by themselves. A History tab keeps a permanent diary of everything Tripwire did. It stays even after a reset and can be exported. It was tested with 60 agents at once and still reads easily.
- **Still left (Phase 6):** practise the 2-minute demo and submit the form before 6:30 PM. That needs a person at the event. An optional extra is a run with the real Claude AI, which needs an API key.

---

## SUMMARY (read this if you read nothing else)

**The problem.** Companies are starting to let AI "agents" work on their own for hours. An agent is an AI that doesn't just answer one question. It works in a loop: think, use a tool (search the web, edit a file, run a program), look at the result, think again, and so on. When an agent gets stuck, it usually doesn't crash. It just keeps going: it searches for the same thing forty times, retries a broken step over and over, or flips a setting back and forth. Every one of those steps costs money. Today the only safety nets are "stop after N steps" and "stop when the monthly bill hits a limit". Both are blunt, and both kick in after the damage is done. Nobody is actually watching *how* the agent is behaving.

**What we built.** Tripwire is a supervisor that watches AI agents while they work and steps in when they go wrong. Think of a driving instructor sitting in the passenger seat with a second brake pedal. The learner drives. The instructor mostly just watches. If the learner starts doing something silly, the instructor first says something, then takes more control, and only slams the brake if it's really needed.

**How it works.** Every time an agent wants to talk to its AI model (like Claude), the message goes through Tripwire first. Tripwire is a **proxy**, which just means a middleman: like a receptionist who passes every letter along, but reads each one on the way. Because it sees every message, it can spot 7 warning signs (repeating itself, flip-flopping, hitting the same error, going in circles, getting bloated, saying "done" but not stopping, and spending too fast). When it sees trouble, it climbs a 4-step ladder:

1. **Nudge**: slip the agent a note saying "you seem stuck, try something different".
2. **Downgrade**: switch it to a cheaper AI model so it burns money more slowly.
3. **Pause**: freeze the agent and ask a human "should this keep going?"
4. **Kill**: stop it politely, so it ends cleanly instead of crashing.

After a run is stopped, Tripwire writes a short "what happened" report, called a post-mortem.

**How easy it is to use.** You change one line, the address your agent sends its messages to:

```
Anthropic(base_url="http://localhost:8787/r/my-run")
```

That's it. Nothing else in the agent changes. Almost every agent tool lets you set this address, so Tripwire works with almost any agent.

**Why it matters.** Fewer surprise bills. Fewer stuck jobs that someone discovers hours later. A human only gets pulled in when it's really needed. And every incident leaves behind a written record of what went wrong.

**How we'll show it.** On stage we run five pretend agents at the same time and watch them live on a dashboard:
- one healthy agent that Tripwire correctly leaves alone,
- one that flip-flops, gets nudged, and **fixes itself**,
- two that are hopelessly stuck, get nudged, then paused, then stopped,
- one that spends too fast, gets switched to a cheaper model, then gets stopped at its budget.

A big counter on screen shows how much money was saved.

**What makes it special.**
- It watches *behaviour*, not just counts.
- It tries the gentlest fix first, and the gentle fix often works.
- When it does stop an agent, it does it politely, so the agent shuts down cleanly instead of crashing.
- It tells you how much money it saved.
- It needs a one-line change to adopt.

---

## The big picture in one diagram

```text
   YOUR AGENT                  TRIPWIRE                     THE AI MODEL
 (does the work)          (the instructor with           (Claude, or our
                           the second brake pedal)        fake practice AI)

  "Here's my next   ───►   reads the message,     ───►   thinks and replies
   message"                checks for warning
                           signs, maybe adds a
                           note, swaps the model,
                           pauses, or stops it
                                 │
  gets a normal     ◄───   passes the reply back  ◄───   "Here's my answer"
  reply (or a              and updates the
  polite "stop")           live dashboard
                                 │
                                 ▼
                        DASHBOARD + REPORTS
                     (humans watch here, and can
                      press Approve or Kill)
```

---

## Why a middleman? (The key idea)

We could have built Tripwire as a plug-in you add to your agent's code. We didn't, on purpose. Here's why sitting in the middle is better:

- **No code changes.** Like getting your post redirected through a friend: you just change the address. The agent doesn't know or care.
- **It sees everything.** Every question the agent asks, every tool it uses, every result it gets back, and exactly how many words (and so how much money) each step costs.
- **It can act, not just warn.** A smoke alarm can only beep. Tripwire is more like a sprinkler system: because every message passes through it, it can change the message, slow things down, hold things, or answer on the AI's behalf.

A quick note on money: AI models charge by the **token**. A token is a small chunk of text, roughly three-quarters of a word. You pay for the tokens you send in (the "input") and the tokens the AI writes back (the "output"). Bigger messages cost more.

---

## The 7 warning signs (the "detectors")

A **detector** is a small rule that looks at the agent's recent history and asks one question, like "is it repeating itself?". Each one that fires gives a **severity** score from 0 (barely worth mentioning) to 1 (critical). Tripwire's overall "how stuck is this agent?" number, the **stuck score**, is simply the highest severity of any warning sign at that moment.

Each warning also comes with a plain sentence explaining what's wrong, written so it can be shown both to humans on the dashboard and to the agent itself in a nudge. For example: *"You have called search_web with identical arguments 4 times in the last 8 steps and received the same result."*

### 1. Repeating the same action (`repeat_tool_call`)
**The rule:** the exact same tool, with the exact same inputs, used 3 or more times in the last 8 steps.
**Everyday example:** you keep opening the fridge, looking in, and closing it, hoping something new will appear. It won't.
**How serious:** 3 times is a mild warning (0.5), 4 times is serious (0.8), 5 or more is critical (1.0).

### 2. Hitting the same wall (`repeat_error`)
**The rule:** the agent gets back the exact same error message 3 or more times in the last 8 steps.
**Everyday example:** typing the wrong PIN at a cash machine again and again. The machine keeps saying "wrong PIN", and eventually it eats your card. (With real services, this kind of retrying often gets you temporarily banned.)
**How serious:** 3 times is 0.6, 4 or more is 0.9.

### 3. Flip-flopping (`oscillation`)
**The rule:** in the last 8 steps, the agent's actions form a little repeating pattern, like A, B, A, B or A, B, C, A, B, C, and the pattern repeats at least twice. Doing the same single thing over and over (A, A, A, A) doesn't count here. That's warning sign number 1.
**Everyday example:** two people at a thermostat. One turns it up, the other turns it down, forever. Or a writer who changes a sentence, changes it back, changes it again, changes it back. In a normal activity log, this looks like busy work, so nobody notices.
**How serious:** 0.7, or 0.9 if the pattern repeats 3 or more times.

### 4. Saying the same thing in different words (`semantic_loop`)
**The rule:** the agent's written thoughts are almost the same, step after step. We compare short three-word phrases between messages. If 3 of the last 5 messages are more than 80% the same as each other, it fires. Very short messages (under 40 characters) are ignored, because short messages like "OK" naturally look alike.
**Everyday example:** a friend who's lost on the phone saying "I think I'm near the station... yeah I'm near the station somewhere... I reckon the station is close" without actually moving.
**How serious:** 0.6.

### 5. Getting bloated (`context_bloat`)
**The rule:** the amount of text the agent sends in has grown at every one of the last 5 steps, AND the latest step is more than 3 times the size of the one from 5 steps ago.
**Everyday example:** a student who re-reads the entire textbook from page one before answering each new homework question. Every question takes longer and costs more than the last.
**How serious:** 0.4. This is a gentle warning by itself. It's a "keep an eye on it", not an emergency.

### 6. Saying "done" but not stopping (`done_but_continuing`)
**The rule:** the agent writes something like "task complete", "all done", "finished" or "successfully completed", but then (in that step or a later one) carries on using tools.
**Everyday example:** a builder who says "all finished, here's the bill!" and then keeps hammering in the next room. Either the job isn't done, or the hammering is pointless. Either way, something's off.
**How serious:** 0.5.

### 7. Spending too fast (`budget`)
**The rule:** each run has a budget (default $1.00). We look at how much has been spent and how fast.
- If the run has already spent its whole budget: critical (1.0).
- If, at the current rate, the next 10 steps would go over budget: serious (0.7). This is a forecast.
- If it has spent 80% of the budget: a warning (0.5).

**Everyday example:** a taxi meter. You've got $20. If the meter says $20, you're out. If the meter is ticking so fast that you'll hit $20 in the next few minutes, you'd ask the driver to take a cheaper route. If it says $16, you start paying attention.

---

## The 4-step escalation ladder

Tripwire always tries the gentlest fix first, and only gets firmer if the problem doesn't go away. Think of how a good lifeguard handles a swimmer drifting out too far: first a whistle and a wave, then calling them in on the loudspeaker, then paddling out to them, and only as a last resort pulling them out of the water.

```text
   gentle                                                    firm
     │                                                         │
     ▼                                                         ▼
  ┌────────┐    ┌───────────┐    ┌──────────────┐    ┌──────────────┐
  │ NUDGE  │ ─► │ DOWNGRADE │ ─► │    PAUSE     │ ─► │     KILL     │
  │ a note │    │ cheaper   │    │ ask a human  │    │ stop it,     │
  │        │    │ model     │    │              │    │ politely     │
  └────────┘    └───────────┘    └──────────────┘    └──────────────┘
   level 1        level 2           level 3             level 4
```

### Step 1: Nudge
**What it does:** Tripwire adds a note to the agent's instructions (the "system prompt", which is the standing set of instructions the AI reads before every reply). The note starts with "[TRIPWIRE SUPERVISOR NOTICE]", lists the warning signs in plain sentences, and ends with: *step back, don't repeat yourself, either try something really different, or stop and say what's blocking you.*
**Analogy:** the driving instructor saying "you've gone round this roundabout three times now, take the next exit."
**Why it's first:** it's free, it doesn't interrupt anything, and it often works. Our demo shows an agent fixing itself after a single nudge.

### Step 2: Downgrade
**What it does:** Tripwire quietly swaps the agent onto a cheaper AI model for the rest of the run. Every later message is sent to the cheaper model.
**Analogy:** your teenager is racking up a huge phone bill, so you switch them to a cheaper plan. They can still use the phone, it just costs you less.
**When it's used:** this one is for money problems, not behaviour problems. It happens when the spending forecast says "you'll run out soon". It only happens once.

### Step 3: Pause
**What it does:** Tripwire holds the agent's next message and doesn't pass it on. The dashboard shows big **Approve** and **Kill** buttons. A human decides.
- **Approve** lets the agent carry on, and gives it a fresh chance.
- **Kill** stops it.
- If nobody answers within 3 minutes, Tripwire stops it anyway, so a forgotten pause can't block things forever.

**Analogy:** your bank texting you, "Did you just try to spend $900 in another country? Reply YES or NO." The payment waits until you answer.

### Step 4: Kill (the graceful stop)
**What it does:** Tripwire stops the run. But instead of slamming the door (sending back an error, which would make most agents crash with a messy error screen), it answers on the AI's behalf with a normal-looking reply that says: *"[TRIPWIRE] This run was stopped by the Tripwire supervisor: (reason). Stop working and report this to the user."* It also marks the message as "I'm finished", so the agent's own loop ends naturally and records why.
**Analogy:** instead of cutting the power to a factory machine mid-job (which can break it), you press its proper "shut down" button so it finishes cleanly.
**After a kill:** any later message from that agent gets the same polite stop, straight away. Tripwire also works out the **projected waste avoided**: roughly, "this agent was spending about $X per step, and if we'd let it run to 100 steps it would have spent this much more." That's the big money-saved number on the dashboard.

### How Tripwire decides which step to take

These are the decision rules (the **policy**), in plain words:

- **Out of money?** If the budget is fully spent, kill. No second chances.
- **About to run out?** If the forecast says it'll go over budget soon and it hasn't been downgraded yet, downgrade. If it's already been downgraded, the forecast alone doesn't trigger anything more.
- **Looks stuck (stuck score 0.5 or more) and never nudged?** Nudge.
- **Still stuck, already nudged, and it's had at least 2 steps to improve?** Pause and ask a human.
- **Still stuck even after a human said "carry on"?** Kill.
- **Critically stuck (0.95 or more) and it's had 4 steps since the nudge?** Kill, no matter what.
- **Otherwise:** do nothing. Let it work.
- **Recovery:** if, after a nudge, the next 2 checks come back fine, the agent counts as "recovered" and goes back to normal "running" status.

Tripwire remembers the highest step it has reached for each run. Only a human can wind it back down (with a "reset" button).

---

## The 5 demo characters

For the demo we don't use a real AI. We use a **fake AI** (we call it the "mock") that we wrote ourselves. It behaves the same way every single time, with no internet and no paid account needed. That way the demo can't be ruined by bad Wi-Fi. Each character is told which role to play through a hidden line in its instructions. All five run at the same time, starting a second and a half apart.

### 1. "Good": the model employee
**The story:** Good has a sensible task: research something, write a report, test it. It does six different things in a sensible order, then says "Done: report written." and stops.
**What the audience sees:** a card that stays calm and green the whole time. No warnings, no nudges, and it ends as "completed".
**Why it's in the demo:** to prove Tripwire doesn't cry wolf. A supervisor that bothers healthy agents is worse than none at all.

### 2. "Looper": the fridge-opener
**The story:** Looper wants Acme Corp's Q3 2026 revenue. It searches the web for exactly the same phrase. "No results found." It searches again. And again. Even when nudged, it ignores the note and keeps searching.
**What the audience sees:** the card's stuck score climbs. A yellow "Nudged" appears in the live feed. Looper keeps going. Then the card switches to **Paused** with big Approve and Kill buttons. We press **Kill** on stage. The card turns red and the money-saved counter jumps. (If nobody pressed anything, it would be killed after 3 minutes anyway.)

### 3. "Oscillator": the thermostat fighter
**The story:** Oscillator can't decide whether a setting in a file should be "fast" or "safe". It writes "fast". Then "safe". Then "fast". Then "safe". Then Tripwire nudges it. Oscillator reads the note and replies, more or less, "You're right, I'll stop flip-flopping. I'll pick 'safe' and add a comment explaining why." It does one different thing and finishes.
**What the audience sees:** a warning, a nudge, and then the stuck score drops back down. The card ends as **completed**, and the "recovered" counter goes up by one.
**Why it's in the demo:** this is our favourite moment. It shows the gentlest fix actually working. No human needed, nothing killed.

### 4. "Retrier": the wrong-PIN typer
**The story:** Retrier tries to deploy (publish) some software to the live site. It gets "Error: permission denied". It tries again. Same error. And again. A nudge doesn't help. It keeps retrying.
**What the audience sees:** the "same error again" warning lights up, then a nudge, then a pause, then a kill. Same pattern as Looper, but triggered by repeated errors instead of repeated searches.

### 5. "Spender": the big spender
**The story:** Spender is actually doing reasonable work, with varied, sensible actions. The problem is that it sends huge, growing amounts of text every step, on an expensive model. Its budget is only $0.60.
**What the audience sees:** the spend bar on its card fills fast. Tripwire forecasts it'll run out soon and switches it to the cheaper model. You can see the model name change on the card. It still keeps spending, hits its budget, and is stopped.
**Why it's in the demo:** it shows that Tripwire catches money problems even when the behaviour looks fine.

---

## The phases, one by one

The project is split into 7 phases (0 to 6). Each has a goal, a set of tasks, and a checklist of tests. A phase isn't "done" until every item on its checklist passes.

```text
 Phase 0        Phases 1, 2, 3, 4                 Phase 5           Phase 6
 the plan  ──►  built at the same time      ──►  put it together ──► demo and
 (done)         by four helpers:                  and polish          submit
                1 brain  2 middleman
                3 screen 4 practice world
```

---

### Phase 0: Ideas and agreements (lead) — DONE

**What we're trying to do:** decide what to build, write down the plan, and agree on the "shapes" of the information every part will share, before anyone writes any real code.

**Why:** we have four helpers building at the same time. If they don't agree up front on exactly what a "step", a "warning" or a "decision" looks like, their parts won't fit together. It's like agreeing on the size of a plug and socket before two factories start making them.

**What each piece does:**
- **Picking the track.** The hackathon has several themes ("tracks"). We chose "Unsupervised", which asks for agents that know when they're stuck, repeating themselves, spending too much, or should stop. That's exactly Tripwire.
- **The master plan** (`MASTER.md`). The single source of truth. Every helper works from it.
- **The shared shapes** (`server/models.py`). This file is "frozen": nobody changes it without updating the plan. It defines:
  - a **tool call** (which tool the agent used and with what inputs, plus a short fingerprint so we can quickly tell if two calls are identical),
  - a **tool result** (what came back, a fingerprint of it, and whether it was an error),
  - a **step** (one round trip to the AI: the model used, the tokens in and out, the cost, what the AI wrote, which tools it asked for, the results that came back, and any intervention applied),
  - a **signal** (one warning sign: which detector, how serious, a human sentence, and the evidence),
  - a **decision** (which ladder step to take and why, plus the nudge note or the cheaper model name if relevant),
  - a **run** (one agent's whole session: its name, goal, budget, status, all its steps, latest warnings, highest ladder level reached, stuck score, nudge count, any pending decision, any downgrade, its timeline of events, money saved, and why it was killed).
  - A run's status is always one of: running, nudged, downgraded, paused, killed, or completed.
- **The toolbox.** We set up a Python environment (a self-contained box of the exact tools this project needs) with: a web server kit (FastAPI and uvicorn), a tool for passing messages on (httpx), Anthropic's official Claude toolkit (the "SDK", which is the ready-made kit programmers use to talk to Claude), and a testing tool (pytest). The dashboard uses no extra kits at all, just plain web-page code.

**How we checked it works (all passed):**
- The track is chosen and we can explain why it fits the judging criteria.
- The shared-shapes file loads without errors.
- All the tools install properly.
- Every file has exactly one owner, so no two helpers edit the same file.

**What could go wrong:** if the shared shapes turn out to be missing something, a helper might be tempted to change them, which would break everyone else's work. Rule: helpers don't change shared files. They write the request in their final report, and the lead decides.

---

### Phase 1: The detection brain (Helper B) — IN PROGRESS

**What we're trying to do:** build the part that looks at an agent's history and decides "is something wrong, and what should we do about it?" This is three pieces: the price list, the 7 warning signs, and the decision rules (the ladder).

**Why:** this is the heart of Tripwire. Everything else just carries messages around and shows things on screen. This is the part that's actually clever.

**What each piece does:**
- **The price list** (`pricing.py`). A table of how much each AI model costs per million tokens in and out, a way to work out the cost of a step, and a "what's the next cheaper model?" lookup for downgrades. It includes the real Claude models (Opus, Sonnet, Haiku) and our two fake ones: "mock-large" (expensive: $15 in, $75 out per million tokens) and "mock-small" (cheap: $1 in, $5 out). Unknown models are assumed to cost $3 in, $15 out. These prices are clearly marked as estimates you can change.
- **The warning signs** (`detectors.py`). The 7 detectors described above. They take a run, look at it, and return a list of warnings. They must be:
  - **pure**: they only look, they never change anything or talk to the outside world (like a doctor reading an X-ray, not performing surgery),
  - **fast**: under 5 thousandths of a second, even for a run with 200 steps, because this check runs on every single message.
- **The decision rules** (`policy.py`). Takes the warnings and picks one ladder step (or "do nothing"). Like the detectors, it only decides. It doesn't act. The middleman (Phase 2) carries out the decision.
- **Tests.** Small, hand-built pretend runs ("here's a run where the agent searched the same thing 4 times") fed into the brain to check it gives the right answer.

**How we check it works (the checklist, in plain words):**
- **All the brain's tests pass.**
- **Every warning sign is tested both ways.** Each of the 7 has a test showing it *does* go off when it should, and a test showing it *doesn't* go off on a healthy, varied run. The second kind matters just as much: it proves no false alarms.
- **A healthy 10-step run produces zero warnings.** An agent doing ten different sensible things shouldn't trip anything.
- **4 identical actions give exactly the right score.** Doing the same thing 4 times should show "repeating" at 0.8 severity.
- **Flip-flopping is told apart from repeating.** A, B, A, B counts as flip-flopping. A, A, A, A does not (that's repeating, a different warning).
- **Money rules work.** Spending the full budget leads to a kill. The "about to run out" forecast leads to a downgrade, but only once.
- **The ladder climbs in the right order.** First time stuck: nudge. Still stuck 2 steps later: pause. Human approves, and it's *still* stuck: kill.
- **It's fast.** Checking a 200-step run takes under 5 thousandths of a second.

**What could go wrong:**
- **False alarms.** If the rules are too twitchy, healthy agents get nudged or stopped, and nobody would trust Tripwire. That's why every detector has a "should NOT fire" test, and why the "good" character exists.
- **Missed problems.** If the rules are too relaxed, stuck agents slip through. The "should fire" tests guard against this.
- **Mixing up warnings.** Repeating and flip-flopping look similar. If both fire for the same thing, the ladder might climb too fast. The A-A-A-A vs A-B-A-B test checks this.
- **Too slow.** If checking takes too long, every agent's message gets delayed. The speed test guards against this.

---

### Phase 2: The middleman and the control-room data (Helper A) — IN PROGRESS

**What we're trying to do:** build the part that actually sits between the agent and the AI. It receives every message, keeps track of each run, asks the brain what to do, carries out the decision, passes the message on, and records everything. It also supplies all the data the dashboard needs, and writes the reports.

**Why:** the brain can only think. This part has the hands. It's the instructor's actual foot on the second brake pedal.

**What each piece does:**
- **The memory and noticeboard** (`store.py`). Keeps every run in memory, and has a "noticeboard" that announces every change (new step, new warning, intervention) to anyone watching, like the dashboard.
- **The forwarder** (`upstream.py`). Passes messages on to the real AI (Anthropic's Claude) or to our fake practice AI, and brings the reply back. "Upstream" just means "the next stop along the line", which here is the AI model.
- **The main server** (`app.py`). Handles every incoming message and also serves the dashboard and its data.
- **The report writer** (`report.py`). Writes the post-mortem: a readable page with the timeline of what happened, which warnings fired, what it cost, and how much was saved.

**How the agent finds its run:** each agent includes a run name in the address, like `/r/my-run/...`, so Tripwire knows which run each message belongs to. (There's also a backup way, using a label on the message.) The agent can optionally attach a display name, a goal, and a budget. If not, the budget defaults to $1.00. Any passwords or keys the agent sends for the AI service are passed along untouched. If we're talking to real Claude and the agent didn't send a key, Tripwire uses the one set on the laptop.

**What happens to every single message, step by step:**
1. **Find or create the run.** Note the time and, the first time, which model it's using.
2. **Already killed?** Then send the polite stop straight back. Don't even bother the AI.
3. **Collect the tool results.** When an agent uses a tool, the result comes back inside its *next* message. Tripwire pulls those results out and attaches them to the previous step. That's how it learns "that search found nothing" or "that deploy failed". A result counts as an error if it's flagged as one, or if its text starts with "Error".
4. **Ask the brain.** Now that the results are known, run the 7 warning signs and the decision rules. Save the warnings and stuck score, and post them on the noticeboard.
5. **Carry out the decision:**
   - **Nudge:** add the "[TRIPWIRE SUPERVISOR NOTICE]" note to the agent's instructions, mark the run "nudged", count the nudge, and restart the "steps since nudge" counter.
   - **Downgrade:** remember the cheaper model and mark the run "downgraded".
   - **Pause:** mark the run "paused" and hold this message for up to 3 minutes while waiting for a human. Approve or resume lets it continue with a fresh chance. Kill, or no answer in time, means kill.
   - **Kill:** mark it "killed", record why, work out the money saved, and send the polite stop.
   - **Always:** if a cheaper model has been chosen, make sure this message goes to it.
   - Any action other than "do nothing" gets posted on the noticeboard.
6. **Pass the message on to the AI.** If the AI service itself has a problem, pass its error back unchanged. Tripwire shouldn't hide or change real errors.
7. **Read the reply and record a new step:** tokens used, cost, what the AI wrote, which tools it asked for, why it stopped, and any intervention applied. If the AI says "I'm finished" and asks for no tools, the run is marked "completed".
8. **Announce it and send the reply back** to the agent exactly as the AI sent it.

**What the dashboard can ask for:** a list of all runs (newest first), the full details of one run, overall totals (runs total, active, killed, completed, nudges sent, recovered after nudge, money spent, money saved), a live stream of updates, a way to press buttons (pause, resume, approve, kill, reset), the post-mortem report for a run, and a "clear everything" button for resetting between demos.

The **live stream** uses something called SSE ("server-sent events"). Think of it like a news ticker: the dashboard opens one connection and Tripwire keeps pushing updates down it as they happen, instead of the dashboard asking "anything new?" every second. Every 15 seconds Tripwire also sends a tiny "still here" ping so the connection doesn't go stale.

**How we check it works (the checklist, in plain words):**
- **The server starts** without errors.
- **It's invisible when nothing's wrong.** A message sent through Tripwire to the fake AI comes back exactly as the AI sent it, with nothing added or changed.
- **Tool results land in the right place.** Results arriving in the next message get attached to the step that asked for them.
- **The nudge really reaches the AI.** We check the fake AI's own log to confirm the supervisor note was in the instructions it received.
- **Downgrade really swaps the model.** The message arrives at the AI asking for the cheaper model.
- **Pause really holds, and the buttons really work.** A paused message waits. Pressing Approve releases it. Waiting too long kills it.
- **Killed stays killed.** Every later message from a killed run gets the polite stop.
- **The live stream sends all the kinds of updates:** run changes, new steps, analysis results, interventions, and totals.
- **The report is readable**, with a timeline, warnings, cost, and money saved.
- **"Streaming" mode is refused clearly.** Some agents ask for the AI's reply to arrive word by word ("streaming"). Version 1 doesn't support that, so instead of failing in a confusing way, Tripwire replies with a clear "tripwire v1 supports stream=false only" message.

**What could go wrong:**
- **Changing things it shouldn't.** If the middleman alters replies when nothing is wrong, it could break agents. The "invisible when nothing's wrong" test guards against this.
- **A pause that never ends.** If nobody presses a button, the agent would hang forever. The 3-minute timeout fixes this.
- **Crashing the agent on stop.** Sending an error instead of the polite stop would crash most agents. We always use the polite stop.
- **Streaming agents.** Many agents use streaming by default. For now we refuse clearly. Supporting it is a stretch goal.

---

### Phase 3: The control room screen (Helper C) — IN PROGRESS

**What we're trying to do:** build a single live web page, like a mission control screen, where you can watch every agent at once, see warnings as they happen, and press Approve or Kill.

**Why:** the judges need to *see* Tripwire working. And in real life, a human needs somewhere to watch and to answer pauses.

**What each piece does:**
- **Three plain files** (the page layout, the behaviour, and the styling). No extra kits or build steps, so there's less to break.
- **The header bar**: totals across all runs. Active runs, total spent, nudges sent, agents that recovered, and, in big type, **projected waste avoided**.
- **One card per agent** showing:
  - its name and goal,
  - a coloured status label (running, nudged, downgraded, paused, killed, completed),
  - a bar showing spending against budget,
  - a tiny line chart of the stuck score over time (a "sparkline"),
  - the current warnings,
  - the model in use (so you can see a downgrade happen),
  - how many steps it has taken.
- **The live feed**: a running list of events, newest at the top, written for humans, e.g. "🟡 Nudged *looper*: called search_web 4× with same args".
- **Pause buttons**: when an agent is paused, its card shows big **Approve** and **Kill** buttons, like a notification on your phone.
- **The detail drawer**: click a card to slide out a full timeline of that agent's steps (tools used, errors, interventions), plus a "View report" link.

**How we check it works (the checklist, in plain words):**
- **It opens cleanly** in the browser with no hidden errors.
- **The header shows all the totals**, with the money-saved number big and obvious.
- **Every card has everything listed above.**
- **The feed shows readable sentences**, newest first. Not raw computer data.
- **Paused agents get big Approve and Kill buttons**, and they actually work.
- **Clicking a card opens its timeline and report link.**
- **It reconnects by itself** if the live stream drops, and keeps working after we press "clear everything".
- **It's readable on a projector**: big text, dark background, strong contrast. Judges at the back of the room need to read it.

**What could go wrong:**
- **The live stream drops** (Wi-Fi blip, server restart) and the screen freezes. Fix: automatic reconnect.
- **Unreadable on the big screen.** Fix: large type, dark theme, high contrast.
- **Too much information.** Fix: short human sentences and clear colours rather than raw numbers everywhere.

---

### Phase 4: The practice world and demo characters (Helper D) — IN PROGRESS

**What we're trying to do:** build a safe, predictable world to test and show Tripwire in: a fake AI, a simple agent, the five characters, start-up scripts, and a full end-to-end test.

**Why:** a demo using a real AI depends on the internet, a paid account, and the AI behaving the same way every time (it won't). Our fake AI behaves identically every run, works offline, and costs nothing. It's like a flight simulator: pilots practise emergencies there, not in real planes.

**What each piece does:**
- **The fake AI** (`mock_upstream.py`, at address 8788). It answers in exactly the same format as the real Claude, so agents can't tell the difference. It reads a hidden "SCENARIO" line in the agent's instructions to know which character to play. Its behaviour depends only on how many turns the conversation has had, so it's identical every time. It waits 0.6 to 0.9 seconds before replying, to feel realistic. It reports realistic token counts: about 1,500 input tokens plus 400 more each turn (the Spender's are huge: 20,000 times the turn number), and about 150 output tokens.
- **The demo agent** (`agent.py`). A simple, generic agent built with Anthropic's real, official toolkit. The only change is the address it sends messages to. That's the point: it proves Tripwire is a true drop-in. It has pretend tools: web search always says "No results found", deploy always says "Error: permission denied for role ci-bot", writing a file says "ok", running tests says "12 passed", and so on. It loops until the AI says "finished" or it hits 60 steps. If it receives a message starting with "[TRIPWIRE]", it prints it and exits cleanly.
- **The demo launcher** (`run_demo.py`). Starts all five characters at once, 1.5 seconds apart. Spender gets a $0.60 budget, everyone else gets $1.00.
- **Start-up scripts.** One starts the fake AI and Tripwire together. The other runs the five-character demo.
- **The end-to-end test** (`test_e2e.py`). Starts everything from scratch and checks that all five characters end up exactly as expected.

**How we check it works (the checklist, in plain words):**
- **One command starts everything**: the fake AI (address 8788) and Tripwire (address 8787).
- **One command runs the full demo**, and it finishes in under 3 minutes.
- **Every character ends up where it should:** Good completed, Oscillator recovered, Looper and Retrier killed after a pause, Spender downgraded then killed.
- **Stopped agents exit cleanly**: no scary error screens when Tripwire stops them.
- **The end-to-end test passes.** It starts both servers on random free addresses (so it won't clash with anything else running), shortens the pause wait from 3 minutes to 3 seconds so the test doesn't take forever, and checks all five outcomes.

**What could go wrong:**
- **The fake AI isn't realistic enough**, so the demo "works" but real agents wouldn't. Fix: it uses exactly the real format, and the agent uses the real official toolkit.
- **Timing differences** between runs make results vary. Fix: the fake AI's behaviour depends only on turn count, never on timing or randomness.
- **The demo takes too long** for a 2-minute pitch. Fix: the under-3-minutes check, and the characters run in parallel.

---

### Phase 5: Putting it together and polishing (lead) — COMING NEXT

**What we're trying to do:** take the four separately built parts, plug them together, fix whatever doesn't fit, and make the whole thing solid.

**Why:** each part passing its own tests doesn't guarantee they work together. Like four people each building one wall of a shed: you only find out the corners don't meet when you stand them up.

**What each piece does:**
- **Integration:** running everything together and fixing mismatches.
- **A real-AI run** (optional): pointing Tripwire at the real Claude instead of the fake one, and giving a real agent a task it can't possibly complete, to show Tripwire catches real, not just scripted, stuck behaviour.
- **A README**: a quick-start guide so anyone can get Tripwire running in about 60 seconds.
- **Updating this document** to match what was actually built.

**How we check it works (the checklist, in plain words):**
- **The full demo runs 3 times in a row with identical results.** If it's not repeatable, it's not ready for a live audience.
- **A real Claude agent with an impossible task gets caught** (only if we have an API key available; it's a bonus, not a must).
- **A newcomer can start it in 60 seconds** using the README.
- **This plain-English doc matches the final version.**

**What could go wrong:**
- **Pieces don't fit** (e.g. the dashboard expects a field the server doesn't send). Fix: the frozen shared shapes from Phase 0 make this much less likely, and any mismatch gets fixed on purpose in one place.
- **Results vary between runs.** Fix: the three-runs-in-a-row check.
- **No API key or bad Wi-Fi at the venue.** Fix: the real-AI run is optional; the fake AI is the default.

---

### Phase 6: Submission and pitch (lead) — COMING NEXT

**What we're trying to do:** present Tripwire in 2 minutes and submit it on time.

**Why:** a great project that isn't explained well, or isn't submitted in time, doesn't count.

**The 2-minute pitch, in five parts:**
1. **The problem (15 seconds):** "Agents now run for hours. When they get stuck, they don't crash. They loop, and you pay."
2. **The one-line change (15 seconds):** show that you just change the address the agent sends messages to.
3. **The live demo (60 seconds):** run the five characters on the dashboard. Good sails through untouched. Oscillator gets nudged and fixes itself. Looper gets nudged, stays stuck, gets paused, and we press Kill. Spender is switched to a cheaper model, then stopped at its budget. The money-saved counter climbs.
4. **The report (15 seconds):** open a post-mortem to show the written record.
5. **The bigger picture (15 seconds):** it works with any agent tool that lets you set an address. A hosted version could be one address for a whole company's agents. Next steps: streaming support, support for OpenAI-style agents, and sending pause alerts to Slack or text message.

**The AI-tools disclosure:** the hackathon requires us to say how we used AI. We built Tripwire with Claude Code. The lead AI wrote the master plan and froze the shared shapes first, then launched four helper AIs in parallel, each owning separate files with its own checklist. The lead then put everything together, ran the full tests, and kept the docs up to date. What's distinctive: agreeing on the shapes first means no clashing edits by design, and the fake AI means the whole system can be tested without the internet.

**How we check it works (the checklist, in plain words):**
- **The 2-minute demo has been practised.**
- **The AI-tools disclosure is written.**
- **It's submitted before 6:30 PM.**

**What could go wrong:**
- **Running out of time.** Fix: the deadline is on the checklist, and the build was planned for 2 to 3 focused hours inside a 5-hour window.
- **The live demo misbehaves on stage.** Fix: the fake AI and the three-runs-in-a-row check.

---

## Risks and how we handle them (all in one place)

- **No internet or no API key at the venue** → the fake AI is the default, so the demo needs neither.
- **False alarms annoy people** → the healthy "Good" character must get zero warnings, we always nudge before doing anything harsh, and a human approves pauses.
- **Agents that use streaming** → refused with a clear message in version 1; support is a stretch goal.
- **Agents crashing when stopped** → the polite stop instead of an error.
- **A pause blocking forever** → after 3 minutes with no answer, the run is stopped.

---

## Settings you can change

These are adjustable without touching any code (they're set as "environment variables", which are just labelled settings on the computer):

- **Tripwire's address (port):** 8787 by default. A "port" is like a door number on the computer; different programs listen at different doors.
- **Where to send messages:** the fake AI at 8788 by default, or the real Anthropic service.
- **Default budget per run:** $1.00.
- **How long a pause waits for a human:** 3 minutes.
- **How many steps we assume a stuck run would have taken** (for the money-saved estimate): 100.

---

## Words you might hear

- **Agent:** an AI that works on its own in a loop (think, use a tool, look at the result, repeat) rather than answering one question.
- **API:** a way for one program to talk to another, like a restaurant menu: you can only order what's listed, in the agreed way, and the kitchen sends back the dish.
- **Base URL:** the address an agent sends its messages to. Changing it is the one-line change that plugs in Tripwire.
- **Budget:** the most money a single run is allowed to spend.
- **Contract / shared shapes:** the agreed format of the information that passes between parts, so separately built parts fit together.
- **Dashboard:** the live control-room web page.
- **Detector:** one warning-sign rule. Tripwire has 7.
- **Downgrade:** switching an agent to a cheaper AI model.
- **End-to-end test (e2e):** a test that runs the whole system together, start to finish, as a real user would.
- **End turn:** the AI's way of saying "I'm finished". Tripwire's polite stop uses this so agents shut down cleanly.
- **Escalation ladder:** nudge, then downgrade, then pause, then kill. Gentlest first.
- **Graceful kill / polite stop:** stopping an agent with a normal-looking "I'm finished" reply instead of an error, so it doesn't crash.
- **Kill:** stopping a run for good.
- **LLM (large language model):** the AI model itself, like Claude.
- **Mock / fake AI:** our pretend AI that answers in exactly the real format but behaves the same way every time and needs no internet.
- **Nudge:** a note Tripwire adds to the agent's instructions, telling it it seems stuck.
- **Oscillation:** flip-flopping between two or three actions (A, B, A, B).
- **Pause:** holding an agent's next message until a human presses Approve or Kill.
- **Policy:** the decision rules that pick a ladder step from the warnings.
- **Port:** a numbered "door" on a computer that a program listens at (Tripwire uses 8787, the fake AI 8788).
- **Post-mortem:** a short written report of what happened in a run and why it was stopped.
- **Projected waste avoided:** our estimate of the money a stopped agent would have wasted if it had carried on.
- **Proxy / middleman:** something that sits between two parties and passes messages along, reading them on the way.
- **Run:** one agent's whole working session, from start to finish.
- **SDK:** a ready-made toolkit programmers use to talk to a service (here, Anthropic's official toolkit for Claude).
- **Severity:** how serious a warning is, from 0 to 1.
- **Signal:** one warning that fired, with its severity and a plain-English sentence.
- **SSE (server-sent events):** a "news ticker" connection where the server keeps pushing updates to the dashboard.
- **Step:** one round trip: the agent sends a message to the AI and gets a reply.
- **Streaming:** getting the AI's reply word by word as it's written, instead of all at once. Not supported in version 1.
- **Stuck score:** the highest severity of any current warning; Tripwire's "how stuck is this agent?" number.
- **System prompt:** the standing instructions an AI reads before every reply. Nudges are added here.
- **Token:** a small chunk of text (roughly three-quarters of a word). AI services charge per token.
- **Tool / tool call:** an action the agent can take (search the web, write a file, deploy), and one use of it.
- **Tool result:** what came back from using a tool, such as search results or an error.
- **Upstream:** the next stop along the line; for Tripwire, that's the AI model.
