# context-tools — full reference

> This is the complete reference: every tool, hook, setting and measurement. For a quick start, see
> the [README](../README.md).

Code navigation and documentation hygiene for Claude Code and Codex.
Zero dependencies (only `node:` builtins), zero configuration, **generated on the spot** — never stale.

*[Leia em português →](reference.pt-BR.md)*

Every number in this document was **measured**, and each one says where from. None is an estimate.

Including the ones that make the tool look worse:

> **89.1% of a session's cost is context being loaded**, not the model generating an answer —
> but tool results are only 2% of that. Saving tokens through code navigation yields
> **1–3%**, not the 20% a quick calculation suggests.
> [How that was measured ↓](#the-token-saving-measured--and-it-is-small)

---

## The problem, measured

> **Where the numbers come from.** Internal measurements come from a single **reference workspace** —
> two repositories side by side, a backend (679 files) and a frontend (864), 1,543 in total, plus
> the history of 70 real agent sessions over them. It appears anonymized; the numbers are the ones
> measured. Parser accuracy is measured against **open-source projects**, named, so anyone can
> reproduce it.

Instrumentation of **66 real work sessions** on a 14 MB project:

| | |
|---|---|
| before the first edit | median of **24 calls** and **86 KB** read |
| where the bytes came from | **66.7% code**, 12.5% documentation |
| reads of the hot files | **55% were chained re-reads** — groping around |
| the most-read file | 577 reads across 38 sessions, **always by window, never whole** |

The cost is not reading the file. It is **finding where the thing is**, session after session — and
the same `grep`s repeated across sessions: knowledge derived, used, and thrown away.

## Core tools and diagnostics

| question | command |
|---|---|
| where is X defined? | `symbols.mjs <name> [<name>…]` |
| who uses X, and from which function? | `refs.mjs <name> [--all] [--json]` |
| what does this project look like? | `overview.mjs [--json] [--budget=N]` |
| what is at stake before I change X? | `impact.mjs <symbol-or-file> [--budget=N] [--json]` |
| how do I navigate this huge file? | `outline.mjs <file> [filter]` |
| what changes together with this file? | `coupling.mjs <file>` |
| why would a file trigger context-map review? | `explain.mjs --file <path> [--json]` |
| which uncovered files repeatedly change with mapped areas? | `map-suggestions.mjs [--json]` |
| is this documentation still true? | `audit-docs.mjs [--strict]` |
| **why is this code like this?** | `why.mjs <symbol>` |
| what does the next session need to know? | `handoff.mjs [--salvar]` |
| I reviewed this map/doc — record it | `ack.mjs <map-or-doc.md>` |
| how do I assemble a bounded evidence pack? | `context-pack.mjs <symbol-or-file> [--budget=N]` |
| which optional semantic providers are available? | `providers.mjs [--json] [--install-plan]` |
| how healthy and used is the local plugin? | `health.mjs [--days=30] [--audit] [--json]` |
| how much does the Codex Bash hook cost? | `npm run benchmark:pretool -- --samples=5` |
| how much does the Codex prompt audit cost? | `npm run benchmark:prompt-audit -- --samples=7` |

`health.mjs` summarizes bounded local usage metrics and mechanical freshness signals for context
maps and operational documentation. It runs locally; answers emitted by hooks do not prove that an
agent used them, and a matching source digest does not prove semantic correctness. It also groups
missed lookups by unsupported file extension and shows handler timing for recognized symbol
searches. It distinguishes direct `symbols` lookups resolved as symbols, files, or misses without
recording the query text. It also reports when the workspace snapshot fallback exceeded its safe
limit. Codex Stop attribution uses its local file-write journal; these health signals help prioritize
investigation but do not by themselves
justify a parser or prove that the agent used a result.

`explain.mjs --file <path>` shows how the Codex file-write journal (or Claude session baseline) and context-map fingerprints
classify one explicit file, plus operational documents that reference it. It is a read-only diagnostic;
`--json` is available for local scripts.
`map-suggestions.mjs` ranks uncovered files that repeatedly co-change with mapped sources in Git
history. These are review leads only: co-change does not prove shared meaning, and the command
never edits maps.

`benchmark:pretool` starts the Codex hook in fresh Node processes with synthetic Bash inputs. It
reports end-to-end time for an unrelated command, a text-regex search, and a symbol-like search;
it never executes or prints those commands. This is an on-demand diagnostic, so normal Bash calls
do not pay extra metric writes.

`benchmark:prompt-audit` measures the Codex `UserPromptSubmit` path against a temporary synthetic
project: an ordinary prompt, an explicitly named mapped file, and a bare basename that walks the
workspace. It reports initial, p50, and p95 process times without storing prompt text, project paths,
or timings. The normal hook does not write a metric for every prompt.

**`symbols`** returns the **definition**, not Grep's dozens of mentions. It accepts several names in
one call — the cost is building the index, not querying it, so 3 symbols in 3 calls used to cost
~1.4 s and in a batch cost a single query.

If the name is not a symbol but exists as a **file**, it says so instead of giving up. The file is
labeled as a FILE, never presented as a definition — sending `Read` to the wrong line is the error
the whole tool exists to prevent.

It also finds **configuration keys** (`sessionTimeoutMinutes`, `max_restarts`, `enableFallback`),
which previously could not be found at all. The rule is deliberately narrow — only an object literal
opened at the top of the file, only its direct children: in the reference workspace that yields
1,329 keys averaging 1.6 occurrences per name, while the broad rule would yield 75,454 and drown the
search. They appear labeled `key`, never as a definition, and rank **below** real symbols in results.

**`outline`** gives `line → symbol` for a single file (for `.md`, the sections). It replaces hunting
through 2 KB windows. Each symbol carries **where it ends**, not just where it starts: across 5,985
real symbols measured, the median is **16 lines** (p75 = 38) — whoever gets only the starting line
guesses 40 and reads ~2.5× more than needed.

**`coupling`** reads git history and **discovers** correlations nobody documented. In a real project
it found `controllers/orders.js ↔ services/paymentService.js` (100%, 7 commits) and the triad
`messaging.js + MessagingConnection + validators/messagingConnection` — none of them in any document.
It is pure git: it works in any language.

**`audit-docs`** finds rotten line pointers, symbols or files that no longer exist, invalid commit
hashes, and undated status claims.

**`ct`** is one entry point for all of the above: `ct.mjs <verb>` runs the same script with the same
arguments, in the same Node process (no second start-up). `ct.mjs help` lists the verbs. It exists for
the agent's sake: the skill used to repeat a full `node "<path>/scripts/x.mjs"` for every tool, text
paid each time the skill loads; with verbs the skill went from 16,873 to about 6,900 characters.

**`overview`** is the first-minute panorama, built only from the code and git: where the code is
concentrated, the files changed most in the last six months (marked when a map or `ai-context`
document already covers them), files too large to read whole, the strongest co-changes, the test
command and how much written knowledge exists. It writes nothing and interprets no domain. The
`SessionStart` note that an empty `ai-context/` already shows points to it — the case where the
project has no written knowledge yet and a mechanical panorama helps most.

**`refs`** answers the question that comes right after "where is it": **who uses it**. It reads the
same files as the index, drops comments and string literals with each language's own stripper (a
mention in an error message is not a use; those are counted apart, because a route held in a string
can still be one), leaves the definition out, and says **which function each use is in** — so the
answer already reads as "who calls it". Delphi forms are scanned too, because `OnClick =
BtnSaveClick` is the only place an event handler is wired. It is by name, not by type, and says so on
every answer: two symbols with the same name are not told apart, and a dynamic call is invisible.

**`impact`** is the briefing before a change. For a symbol or a file it puts together, under an
output budget, the uses from `refs`, what historically changes together with the definition file
(`coupling`, in the "changing THIS takes the other along" direction), the related tests and the
test command (`verify`), and the context maps and `ai-context` documents that cite the file —
saying whether the source they reviewed is still today's (by fingerprint) or unknown. Each section
says where it came from and what it cannot know; a section cut by the budget is announced.

**`why`** is the only one that does not ask about the state of the code, but about the **decisions**
that produced it — the question where reading more code does not help, because the answer is not
there. It uses `git log -L` over the symbol's line range (not the file: in a 14,000-line file the
file's history is nearly pure noise) and returns the commits that shaped it, with their rationale.
This is where an agent is most confidently wrong: it removes a guard that exists for a reason,
"simplifies" what was already simplified and broke, changes a threshold that was measured.

It costs ~1.3 s per query, which is why it is **on demand** — too expensive to become a hook. If the
history has nothing to say, it says so; and if git fails, it distinguishes "found nothing" from
"could not look" (a shallow clone is the common case, and the fix is `git fetch --unshallow`).

**`handoff`** exists because of the largest measured cost, and it is not a tool at all: **cost per
message grows 3.4× with session size**. It assembles what is mechanical — files touched since the
session started, maps covering that area — and leaves **blank** what exists only in the head of the
person who did the work: what was tried, what failed, which hypothesis still stands. Filling that in
by guesswork would produce a handoff that lies, and a lying handoff is worse than none.

It uses the index to say **which symbols** changed, not just which files — `src/service.js →
function second, class Engine, stop()`. In a 14,000-line file that is the difference between knowing
and not knowing where to resume. It costs ~130 ms because the index is already cached; without the
cache it would not be worth running in a hook. It also flags a **stale map**: the covered file
changed after `verified_at`, so reading it without checking means trusting old documentation.

A `Stop` hook warns when the session passes 200k of context — the point where cost per message has
already doubled on the measured curve — and **writes the handoff right then**, so it is ready when
you close. It warns **once per session**: whoever decided to keep going already decided, and
repeating brings no new information, it only teaches people to ignore the whole category. The file
is not silently rewritten afterwards (it would change under whoever is reading it) — `--salvar`
  updates on demand.

For Codex, the handoff records the normalized transcript metrics (input, cached input, output,
model context window, rate-limit data, and compactions) for future analysis, but it does **not**
reuse Claude's measured cost curve or emit a context/time warning at `Stop`. The handoff and
paste-ready prompt follow the same two-phase flow, and the user can still request them manually.

**The same warning asks the AGENT to fill in the volatile block** — not the human. That part is not
automatable without an LLM: "what was tried and failed" is not in git, it is in the head of whoever
did the work. But the agent already has the whole session in context, so for it the cost is one
turn. Depending on someone remembering meant betting the entire 19–27% gain on the memory of
whoever comes back — and the only auto-generated handoff that ever existed on disk had that block
**empty**. (Heuristic extraction was tried and discarded: detecting reversals by keyword was almost
entirely false positives.)

**Once the block is filled, the `Stop` hook hands over the paste-ready prompt by itself** — no
command to remember. It cannot do that alongside the warning: at that moment the volatile block has
just been generated empty, and that block is the only part that makes the prompt worth pasting.
`--prompt` still produces it on demand, and **prefers the already-saved file**: regenerating would
erase the block someone just filled in.

### The loop that was missing: did splitting the session pay off?

The plugin has been telling people to split since it existed, and until 2026-08-04 **nobody knew
whether splitting had worked**. A `SessionStart` hook closes the loop: it judges the pair (session
that closed expensive → session that followed it) and says whether it **won, tied, or lost**, and by
how much.

```
📊 The previous split PAID OFF: the session before it closed at 694k of context,
   and the one that followed was producing again after 49 messages (0.9x the typical
   52-message warm-up) — estimated saving ~21%.
   Estimate, not measurement: the message count is real, the % comes from the simulated curve.
```

It judges the **previous** pair, not the current one, and the reason is honesty: at the start of a
session its own warm-up has not happened yet, and judging what has not happened would be making
things up. No LLM, no network, once per session. And it **stays silent when there is no split to
judge** — a previous session that was not expensive was not "split", and a verdict about a split
that never happened would be noise wearing the costume of a measurement.

---

## The part that matters: it does not lie

A search tool that answers confidently and points at the wrong line is **worse than no tool** — the
error stays invisible and the cost is paid in silence. That is why every parser is checked against
**third-party production code**, not against examples written to pass.

The criterion is the same for all of them: for every indexed symbol, the reported line is read raw
from the file and must actually contain the declaration; and every symbol `grep` sees and the index
did not report is classified one by one.

| language | real corpus | files | symbols | wrong line |
|---|---|---:|---:|---:|
| Python | flask · requests · django | 3,047 | 45,985 | **0** |
| Go | cobra · gin · prometheus | 861 | 21,170 | **0** |
| Delphi/Pascal | HeidiSQL · Double Commander | 1,164 | 72,179 | **0** |
| Rust | rayon · a private desktop app | 219 | 5,778 | **0** |
| TypeScript | reference frontend · third-party project | 864 | 1,617 **types** | **0** |
| C# | Newtonsoft.Json · serilog · Dapper | 1,321 | 17,050 | **0** |
| Java | gson · commons-lang · jsoup | 1,098 | 22,584 | **0** |
| PHP | monolog · guzzle · Slim | 488 | 5,981 | **0** |

**≈ 9,000 files and 192,000 symbols**, twenty independent projects, two Pascal dialects.

For C#, Java and PHP (2026-10-09, shallow clones of each project's default branch) the check was the
same, plus a random sample of 100 symbols read by hand. Declarations the index does not report were
grouped by pattern instead of one by one: C# operator overloads (left out on purpose — nobody
searches for `operator +`), members of anonymous classes and of Java enum-constant bodies (local
code, like a method's inner variables), and commented-out code. Two real bugs came out of it before
release: a C# verbatim string starting with an escaped quote (`@"""…`) was read as a raw string and
hid every method after it, and Java type annotations (`public @Nullable String get(`) hid the
annotated method.

The TypeScript row measures only `interface`/`type`/`enum`, which was the gap under investigation;
the same parser ran over the 593 JS files of the reference backend to prove the other side — **0 new
symbols**, meaning `type: 'foo'` (an object property, common in JS) did not become a declaration.

### What that verification found

None of these bugs shows up in a synthetic test. All came from the real corpus:

- **Comments becoming definitions.** Pascal uses `{ }` and `(* *)`, and the parser only skipped
  `//`. Measured result: **168 ghost symbols**, and **84 names that existed ONLY inside comments** —
  querying any of them returned 100% garbage. The expensive case: `ContentGetValueW` answered
  `wdxplugin.pas:87` with exact file and line, pointing inside a `(* *)` block documenting Double
  Commander's plugin API. Documentation prose became a symbol called `function is`.
- **The same trap in Python, predicted and avoided.** A `"""…"""` docstring spans lines and the code
  example inside it is the dominant documentation style in Python: **92 ghost definitions** avoided
  across flask/django (an example `def index():` inside a route's docstring).
- **Grouped blocks in Go.** Without tracking nesting, the fields of a literal inside `var (…)`
  become declarations: `prometheus.GaugeOpts{ Name: …, Help: … }` produced `var Name` and `var Help`
  — **613 false symbols** in the corpus.
- **Invisible TypeScript types.** `interface`/`type`/`enum` were not entering the index: 1,592 types
  missing in the reference frontend alone. Worse than "not found" — since the search matches
  partially, asking for `Status` returned **`function StatusBadge` as if it were the answer**.

### And the worst of all, which was not a parser

File discovery returned only the convention folders that happened to exist (`src`, `lib`, `tests`,
`scripts`…). **One** of them existing was enough for the entire rest of the repository to vanish
from the index — silently, answering "does not exist" with confidence:

| repository | indexed | exists | invisible |
|---|---:|---:|---:|
| prometheus | **0** | 974 | **100%** |
| django | 2,026 | 2,970 | 32% |
| flask | 65 | 83 | 22% |

Prometheus has a `scripts/` folder; the real code lives in `tsdb/`, `discovery/`, `storage/`. The
tool read the build-scripts folder and concluded the project had no code.

Today it scans the root and lets the exclusion list prune (`node_modules`, `vendor`, `target`,
`dist`, `__pycache__`, `.venv`). **Measured cost of the fix: zero** — 1,752 ms before, 1,752 ms
after on the same workspace, because listing directories is 34 ms of the total; the real spend is
reading bytes.

The **same** flaw was in documentation discovery, and there it was worse: `docDirs` had no fallback
at all, so a repository without `docs/` returned an empty list and the audit looked at nothing.
Fixed alongside — in the reference repositories, **20 documents** that had never been audited
started being audited, among them `README.md`, `AGENTS.md` and `CLAUDE.md`: the files that instruct
the agent every session, precisely where rotten documentation costs the most.

> This README is living proof: until that revision it carried a "known limitation" about `coupling`
> swallowing git failures silently — **fixed long before**, and nobody noticed because no auditor
> read the README.

---

## The token saving, measured — and it is small

Tools like this usually promise to "save context". Here is the real number, and it does **not**
favor the promise: between **1% and 3% of a session's cost**, with an absolute ceiling of 3.6%.

Measured across **65 real work sessions** (28,422 messages), reading the `usage` Claude Code writes
to disk. The 3 sessions in which the plugin itself was built were excluded — cloning corpora and
mining transcripts does not represent normal development.

> **Correction on the record.** The first version of this section announced "20% less context". It
> was wrong, and the error was in the denominator: 20% is the share of groping around within the
> **volume of tool results** — but tool results are only **2% of everything that enters the cache**.
> Confusing the two inflated the gain by an order of magnitude. It stays here because the same
> mistake is easy to repeat.

### The cost is not the model thinking. It is the context being loaded.

| | tokens | share of cost |
|---|---:|---:|
| `cache_read` | 8,311 M | **62.7%** |
| `cache_creation` | 277 M | **26.1%** |
| `output` | 28.9 M | 10.9% |
| `input` | 3.4 M | 0.3% |

**89.1% of the cost is context**, not generation. That changes the yardstick: "reading less once"
does not help — what weighs is **carrying it forward**. A token entering at message 10 is re-read in
every message after it, so the same byte costs far more when it enters early.

### Where the context comes from

| tool | calls | volume | |
|---|---:|---:|---:|
| **Read** | 3,574 | 14.02 M chars | **69%** |
| Bash | 3,915 | 2.90 M | 14% |
| Grep | 1,626 | 1.70 M | 8% |
| Edit | 3,499 | 0.79 M | 4% |

### Inside Read, the waste is localized

| | volume | |
|---|---:|---|
| first read of the file | 7.75 M | unavoidable |
| **groping** — another window of an already-open file | **3.98 M** | **recoverable** |
| verification after editing | 2.18 M | legitimate |
| pure duplicate (same window) | 0.10 M | 0.7% — hygiene is already good |

Groping is **28% of Read volume** — 1,215 calls, averaging 3,278 chars. It is exactly the pattern
`outline` exists to cut: opening one window after another until you find the passage, when a
`line → symbol` map would have solved it on the first try.

### Why that still yields only 1–3% of the cost

Because **tool results are 2% of everything that enters the cache**. The entire visible content of
the transcript — reads, answers, reasoning, messages — adds up to 9.6 M tokens against **277 M of
`cache_creation`**. The other 97% is the system prompt, tool schemas, and prefix rewriting: a fixed
cost per request that **no navigation tool can reach**.

The calculation was done by counterfactual simulation over the real sessions, not by rule of three —
each avoided read yields `1.25×` (it never entered the cache) plus `0.1× × subsequent messages` (it
was not re-read), so position within the session matters:

| assumptions | net saving |
|---|---:|
| conservative (50% of groping avoidable, outline at 1,500 chars) | **1.0 – 1.3%** |
| central (70% avoidable) | **1.6 – 2.0%** |
| optimistic (100% avoidable) | **2.5 – 3.1%** |
| **absolute ceiling** (100% avoidable, outline for free) | **3.6%** |

The range covers chars-per-token from 3.2 to 4.0; the conclusion does not depend on that choice.

### What makes it worth it anyway

The return on `outline` is **5×** — every token spent on it avoids five. And in the champion file of
the measured workspace (a 14,249-line service, read **576 times across 38 sessions**):

| | cost |
|---|---:|
| one average groping re-read | 3,278 chars |
| full `outline` | 14,773 chars → pays for itself in 4 re-reads |
| filtered `outline` | **546 chars** → pays for itself on the first |

### The biggest cost lever is not a tool at all

The same measurement found something far larger than the 1–3%: **cost per message grows 3.4× with
session duration**, because every message re-reads the whole context.

| duration | msgs (med) | context (med) | cost/msg | prefix rewrites |
|---|---:|---:|---:|---:|
| 0–1 h | 105 | 119k | **16k** | **0** |
| 1–3 h | 224 | 273k | 32k (2.0×) | 2 |
| 3–6 h | 503 | 438k | 39k (2.5×) | 2 |
| 6–12 h | 658 | 494k | 45k (2.9×) | 4 |
| 12 h+ | 726 | 573k | **54k (3.4×)** | **5** |

A session under 1 h **never** rewrites the cached prefix. Above 12 h, five times — and each rewrite
writes 275k–445k tokens at once. The **33 sessions of 6 h+ consumed 83% of all measured cost**.

#### Those rewrites are NOT auto-compaction — hypothesis tested and discarded

It was the natural suspicion: if a long session rewrites 275k–445k tokens at once, maybe those
events *are* auto-compaction, and then "splitting" would be competing with a mechanism that already
exists. The transcript **declares** compaction in its own fields, so the two sets could be crossed
instead of guessed at. Across the same 70 sessions:

| | |
|---|---:|
| prefix rewrites detected | **243**, across 57 sessions |
| compactions **declared** | **4**, across 2 sessions |

Two orders of magnitude apart, and no correlation at all: the session with the most rewrites (16)
had **zero** compactions. They are distinct phenomena — a rewrite is the prefix cache dying and
being rewritten, not the context being summarized.

The side effect is more interesting than the original hypothesis: **auto-compaction almost never
happens in this corpus** (2 of 70 sessions). Sessions get expensive and *stay* expensive, with
nothing reclaiming the context — which strengthens the case for splitting rather than weakening it.

**What remains open, and why:** comparing the COST of splitting against the cost of compacting is
still inconclusive. With n=2 you cannot build a cost curve, and inventing one from two sessions
would be exactly the mistake this entire section exists to avoid.

The toll of splitting was measured, not assumed: the warm-up until the first edit costs **0.64×**
per message (the context is still small), and the cost/msg of short sessions **already includes**
their own warm-up. What is left is only the cost of repeating exploration:

| if short blocks cost | result |
|---|---:|
| 1.0× messages | saving of **58%** |
| 1.5× | 46% |
| 2.0× | **33%** |
| 3.4× | break-even |

**You can spend 3.4× more messages in short blocks and still break even.**

### The saving from splitting, simulated message by message

The 58% above is a **ceiling**, not an estimate: it assumes a short block costs 1.0× per message. The
real estimate came from counterfactual simulation over the **69 sessions** (1,460 M weighted units),
replicating each session's measured context growth and cutting when it crosses the threshold — every
cut pays the warm-up again, and `cache_creation` was held constant (in practice it would drop,
because short blocks barely rewrite the prefix; the calculation deliberately understates).

| cut above | repeated warm-up | cuts | saving |
|---|---|---:|---:|
| 200k | **1.0× (the handoff helps not at all)** | 301 | **19.3%** |
| 200k | 0.7× | 301 | **27.0%** |
| 200k | 0.5× | 301 | 32.2% |
| 300k | 1.0× | 236 | 19.1% |
| 400k | 1.0× | 202 | 15.6% |

Across the 37 sessions of 6 h+, which are 85% of the cost, the saving ranges from **22.6% to 30.1%**.

The row that matters is the first: **19.3% saving even assuming the handoff shortens nothing** of
the warm-up — exactly what the next section's measurement concluded. The gain comes from
*splitting*; the handoff only makes splitting practical for the person working. And it is cheap
enough not to change the math: fattening it from 557 to 8,000 tokens moves the saving from 27.0% to
26.1%.

**It is this plugin's largest measured lever** — an order of magnitude above the 1–3% from
navigation. What the plugin does here is concrete and small: the `Stop` hook warns when the session
crosses 200k (the point where cost per message has already doubled) and leaves the handoff ready on
disk. The user decides whether to close — the plugin splits no session on its own.

#### When splitting WINS, ties, and LOSES

The saving is not unconditional, and there is exactly one condition: **how much it costs to become
productive again after reopening.** Call that the *warm-up*. Across the 69 measured sessions, the
original warm-up — from "hi" to the first file edit — was **52 messages and ~16 minutes** (medians).
That is the unit of the table: `1.0×` means "reopening cost as much as the original start did".

| if reopening costs | in messages (approx.) | result |
|---|---|---:|
| 0.7× the original warm-up | ~36 | wins **27.0%** |
| 1.0× — redoes the whole start | ~52 | wins **19.2%** |
| 1.5× | ~78 | wins 6.3% |
| **1.75× — break-even** | **~91** | **ties** |
| 2.0× | ~104 | **loses 6.6%** |
| 3.0× | ~156 | **loses 32.5%** |

In plain terms: **you have roughly 90 messages of slack to pick the work back up.** Spend less than
that and you win; spend more and you would have been better off never closing the session. And the
fall is symmetric and fast — going past double the warm-up already costs more than the split saves.

This is why the **handoff's volatile block is not optional**. The automatic part (files, symbols,
maps) does not hold those 90 messages on its own: what holds them is "what was tried, what failed,
which hypothesis stands". Closing without filling it in is betting the entire gain on the memory of
whoever comes back.

> **The honesty of the calculation.** The table above assumes the work delivered is the same on both
> sides. Real rework — the new session redoing a decision the previous one had already made — enters
> here as a larger warm-up, and that is how 19% becomes −7%. We did not measure that frequency: it
> would require comparing delivered work, not cost, and a single user's sample is not enough for
> that.

### Injecting the handoff at SessionStart: measured and discarded

The next step seemed obvious: if splitting the session saves up to 58% and the handoff is what makes
restarting cheap, then `SessionStart` should **inject the previous session's handoff by itself**,
instead of depending on someone remembering to read it. Measured across **69 real transcripts**
(2026-06-15 to 2026-08-04), before writing a line of it. It did not survive.

**The ceiling is small.** The warm-up — everything up to the first edit — is **5.9% of session cost**
(median) and only **3.5% in 6 h+ sessions**, which carry 86% of the cost. The 58% in the table above
is the saving from **splitting**, not from the handoff: splitting one session into four pays three
extra warm-ups, ~7%, against ~58% saved. **The toll was already small — splitting already pays off
with no handoff at all.** The handoff is not what unlocks splitting.

**The mechanism does not work.** The warm-up is 74% `Read`+`Grep`, so in theory it would be
addressable. But the owner already writes a briefing by hand in the first prompt, and sometimes it
**names files** — a natural experiment for free. Unit: (session, file), for every file the previous
session edited, across the 40 continuation pairs (gap < 12 h and overlapping edits):

| | re-read before 1st edit | not re-read | rate |
|---|---:|---:|---:|
| named in 1st prompt | 25 | 30 | **45%** |
| not named | 68 | 893 | 7% |

The association is confounded — a file is named **because** it is the one about to be touched — so
this does not prove naming causes reading. It proves what is enough: **naming does not prevent
reading.** Which makes sense, and is the point: the model needs the *content*, and a filename is not
content. The mechanical block of the handoff (files + symbols) is precisely the part that can be
generated automatically — and precisely the part that shortens nothing.

**And it is not cheap.** With real data, the mechanical block would be **557 tokens** in the median
session (15 files edited) and **1,057** at p90 (41 files; the real maximum was 65). The entire
`SessionStart` costs **175** today. It would be 4–6× the fixed cost, paid by **every** session —
including the 30% that continue nothing.

**"The previous session" does not always exist.** The median gap between end and start is 0.1 h, so
a TTL would almost never be the problem. But **14 of 68 sessions started before the previous one
ended** — simultaneous windows. In 21% of cases, injecting "the previous handoff" would mean
injecting one from a window still running.

> **The defect the measurement found as a bonus.** While running `handoff.mjs` to take the
> measurement, it announced two files as "touched in this session" — last modified **20 h before the
> session opened**. The baseline stores HEAD, and `git diff <HEAD>` compares a commit against the
> *working tree*: all inherited dirt entered as new work, and would keep entering until someone
> committed. As a document someone reads, that is one line to ignore; **injected automatically, it
> would be a fixed lie in every session** — exactly the failure mode this plugin exists to avoid.
> Fixed (`SessionStart` records the `mtime` of existing dirt and the handoff subtracts it), and the
> same investigation found that the baseline was **never written** in a project without a `.claude/`
> folder: `writeFileSync` failed, `safe` swallowed it, and the feature was dead in silence.

**What is left.** Only the **volatile block** — and the evidence for it is n=1, not measurement. If
anything is ever injected, the design the numbers support is the minimum: only the volatile block,
only when filled in, only when the previous session actually closed. The mechanical block does not
enter.

> **Two savings of very different sizes — do not confuse them.** Navigating better (`symbols`,
> `outline`, `coupling`) yields **1–3%**, and that alone would not justify any tool; what justifies
> that side is **0 wrong lines across 9,000 files**, the **183 round-trips** the Grep hook would have
> cut, and the index being **13× faster** — the thesis there is not sending `Read` to the wrong
> place. The real saving is the other one: **splitting the session yields 19–27%**, an order of
> magnitude higher, and that is what the `Stop` warning plus the `handoff` exist to make practical.

---

## What the plugin charges

### Speed

Measured on Windows/NTFS, full rebuild × warm cache:

| project | files | no cache | with cache |
|---|---:|---:|---:|
| cobra | 36 | 92 ms | **19 ms** |
| flask | 83 | 145 ms | **26 ms** |
| reference backend | 679 | 963 ms | **77 ms** |
| reference frontend | 864 | 1,097 ms | **83 ms** |
| prometheus | 974 | 1,794 ms | **142 ms** |
| whole reference workspace | 1,543 | 1,752 ms | **130 ms** |

Where the time goes, in the 1,543-file workspace: **listing 34 ms · reading 17.5 MB from disk
~1,590 ms · parsing 160 ms.** The bottleneck is opening files, not interpreting code — and that is
what makes the cache viable, because `stat` costs ~30× less than `read`.

At large scale the degradation is **superlinear**: 1,517 files → 657 ms · 5,000 → 1,859 ms ·
20,000 → **17,809 ms** (with cache, 20,000 drops to ~1.2 s).

### Tokens

`SessionStart` is the only cost you pay without asking. Measured on the reference workspace:
**630 bytes, ~175 tokens** — about 5% of a single average file read, once per session. Up-to-date
maps are grouped into one line per repository; only stale ones get their own line, which is where
the file list changes the decision.

`Stop` warnings cost **zero when there is nothing to warn about**, and have a hash-based
anti-repetition lock: an identical warning does not repeat. Without it the condition would persist
after the answer and could sustain a loop burning tokens on its own.

### The cache cannot lie

It is discarded entirely when: a file changes (mtime **and** size), disappears, or appears; **the
parser changes** (a signature derived from `outline.mjs` itself — automatic, not depending on anyone
remembering to bump a number); the cache belongs to another project; or it is corrupted (then it
rebuilds, never errors). `--fresh` forces a rebuild. Six tests cover exactly those scenarios.

And before trusting the filesystem clock, it **measures**: it writes a probe on the project's own
partition (the OS temp folder may be a different volume) and, if mtime granularity is coarse, it
**refuses the cache** and says so in the output.

The output always reports the mode (`generated now` / `cache intact` / `cache + N re-read`) — in a
distributed plugin, users need to be able to distrust it.

---

## Languages

| extension | `symbols` (cross-file) | `outline` (single file) |
|---|---|---|
| `.js .jsx .ts .tsx .mjs .cjs` | ✅ | ✅ |
| `.py .pyi` | ✅ | ✅ |
| `.go` | ✅ | ✅ |
| `.rs` | ✅ | ✅ |
| `.cs` (C#) | ✅ | ✅ |
| `.java` | ✅ | ✅ |
| `.php` | ✅ | ✅ |
| `.pas .dpr .dpk .inc` (Delphi/Pascal) | ✅ | ✅ |
| `.dfm .fmx` (Delphi form) | — deliberately | ✅ |
| `.md` | — | ✅ (sections) |

`coupling` and `audit-docs` are **language-agnostic**: they work anywhere.

Each parser handles what breaks the intuition of someone coming from another language. **Pascal** is
case-insensitive and every method appears twice (declared in `interface`, defined in
`implementation`). **Rust** has `impl Foo` and `impl Trait for Foo`, and in both what you are looking
for is the type — and `fn` differs from `Fn` (a trait in a `where` clause) only by case. **Go** has
generic receivers (`func (b Bucket[BC]) String()`) and grouped blocks. **Python** has docstrings.
**C#, Java and PHP** share one engine that tracks braces: member declarations are only looked for
directly inside a type, so a call inside a method body can never become a definition, and a symbol
ends at the brace that closes it. Methods are labeled with their class (`Order.Confirm()`) and found
by the bare name.

`.dfm`/`.fmx` stay out of the cross-file index deliberately: component names (`Button1`, `Panel2`)
repeat in every form and would drown the search for real symbols.

### Adding a language is four steps

1. write the parser in `outline.mjs` and register the extension in `parserForExt`;
2. add the extension to `EXTENSOES_CODIGO` in `lib/roots.mjs` — the single source `CODE_RE` derives
   from; without it the file never even enters the scan;
3. **teach the new labels to `bareName`**, in `symbols.mjs`;
4. change the example extension in the two "unsupported language" tests.

Step 3 is the one that bites: without it the symbol enters the index by its label (`struct Session`)
but a query for the bare name (`Session`) does not find it — a failure that shows up in no parser
test, only in the end-to-end query. TypeScript and Rust both hit it. Step 4 has broken CI twice: the
example was `.rs`, became `.py`, and each failed on its own when that language was added.

### They all fail visibly

If they do not find something, they say so and send you to Grep. None returns empty dressed up as an
answer — a detector that fails "open" is worse than no detector.

And "0 indexable files" has **two** causes with different remedies: wrong folder (adjust `--root`)
or an entire project in a language the index does not read. It distinguishes the two and says which,
with the extensions it found and how many — because failing visibly is not enough if the diagnosis
sends the user down a dead end.

---

## Installation

### Global install or update (recommended)

```bash
npx --yes --package github:fcoluiz/context-tools context-tools-setup-all --global --yes
```

Installs or updates the latest release for every agent whose CLI is on the machine (Claude Code in
the `user` scope, Codex globally), without touching any project. Running it again updates: on
Claude it uses `claude plugin update` when the plugin is already installed; on Codex it re-adds the
marketplace at the new tag, which the Codex CLI requires to change versions. `--target=claude|codex`
limits it to one agent. The sections below describe the per-project and manual alternatives.

### As a plugin (recommended)

```bash
claude --plugin-dir /path/to/context-tools
```

Brings the tools **and the hooks**. It uses `${CLAUDE_PLUGIN_ROOT}`, so there is no absolute path to
adjust on any machine.

### Standalone (copied into the project)

```bash
node /path/to/context-tools/install.mjs /path/to/project
```

Copies the scripts into `<project>/.claude/scripts/` and registers the hooks using
`$CLAUDE_PROJECT_DIR`. Idempotent. `--dry-run` simulates, `--no-hooks` installs only the scripts.

It also creates `.claude/.gitignore` covering the state files (cache, locks, baseline) so they do
not pollute your `git status`. The root `.gitignore` is not touched: that one is yours.

### Claude and Codex from the same repository

This repository contains both integration layers and one shared Node.js core. Claude keeps its
existing `.claude-plugin/`, `hooks/hooks.json`, `.claude/` state, and `CLAUDE.md` behavior. Codex
uses `.codex-plugin/plugin.json`, `hooks/codex-hooks.json`, `.codex/` state, and `AGENTS.md`.
The two integrations share the scripts, but their hook adapters and generated state are isolated.

For a project that should support both agents, use the unified installer:

```bash
node /path/to/context-tools/install.mjs /path/to/project --target=both
```

`--target=claude` preserves the original installation, `--target=codex` installs only the Codex
layer, and `--target=auto` selects Codex when running in a Codex environment and otherwise
installs both layers. `--dry-run` and `--no-hooks` apply to either target. The Codex-only form is
also available as `node /path/to/context-tools/install-codex.mjs /path/to/project`.

The Codex standalone installation writes `.codex/scripts/`, `.agents/skills/context-tools/`, and
`.codex/.gitignore`; it never modifies `.claude/`. The Codex plugin provides the skill, metadata, and
lifecycle hooks through `hooks/codex-hooks.json`. Guided setup initializes project configuration
with `--mode=global`: no local scripts, skill or duplicate hooks. Standalone is an explicit choice
for environments without the global plugin. Plugin skills use `${PLUGIN_ROOT}/scripts/` directly.

```bash
node /path/to/context-tools/install-codex.mjs /path/to/project --mode=global
# standalone, when required:
node /path/to/context-tools/install-codex.mjs /path/to/project --mode=standalone
```

Without a project path, the installer uses cwd. Status distinguishes the two modes;
hook trust is reported as unknown until checked in Codex `/hooks`, never inferred from enablement.
Standalone Codex hook commands use a project-relative path, so locating the scripts does not
depend on Git or on a particular shell.
If `.claude/context-tools.json` already exists and `.codex/context-tools.json` does not, the first
Codex installation seeds the latter from the former; subsequent changes remain host-specific.

### Codex through the Git marketplace

The repository also carries a Codex repo marketplace at `.agents/plugins/marketplace.json`. Anyone can
configure that marketplace and install the tagged plugin from Codex:

```bash
codex plugin marketplace add fcoluiz/context-tools --ref v2.7.1
codex
/plugins
```

The marketplace source is pinned to the release tag. After installing, the setup prepares the project and you should start a new
Codex session. On the first machine, if Codex asks for trust, open `/hooks` and trust the
context-tools hooks once. This is the Codex distribution path; it does not alter Claude's marketplace
or install Claude's layer.

### Claude through a marketplace

The repository also carries a Claude Code plugin marketplace at `.claude-plugin/marketplace.json`.
Claude Code's CLI has non-interactive `plugin marketplace`/`plugin` subcommands that mirror the
Codex ones above:

```bash
claude plugin marketplace add fcoluiz/context-tools@v2.7.1 --scope project
claude plugin install context-tools@context-tools --scope project
```

Unlike Codex, Claude does not need a separate "trust the hooks" step: a plugin's hooks run
automatically once the plugin is enabled. This is the Claude distribution path; it does not alter
Codex's marketplace or install Codex's layer. `setup-claude.mjs` (below) automates both commands.

### One-command maintenance

After the plugin is available, the bundled setup utility can detect the current project automatically.
Three entry points share the same engine and accept the same commands
(`install`/`update`/`status`/`doctor`/`latest`/`configure`) and flags:

```bash
node /path/to/context-tools/setup-codex.mjs    # Codex only
node /path/to/context-tools/setup-claude.mjs   # Claude only
node /path/to/context-tools/setup.mjs          # choose the agent
```

`setup.mjs` is the unified entry point: pass `--target=claude`, `--target=codex`, or
`--target=both` to pick explicitly. Without `--target` it detects what the project already has
(`.codex`/`AGENTS.md` for Codex, `.claude`/`CLAUDE.md` for Claude); if it finds both or neither and
the terminal is interactive, it asks; non-interactively (`--yes` or no TTY) with nothing detected,
it installs both.

From a project directory, the utilities can be launched without knowing their installation path:

```bash
npx --yes --package github:fcoluiz/context-tools context-tools-setup         # Codex
npx --yes --package github:fcoluiz/context-tools context-tools-setup-claude  # Claude
npx --yes --package github:fcoluiz/context-tools context-tools-setup-all     # choose the agent
```

If Git cannot reach the repository, the launcher reports the failing step instead of closing
silently; fix the cause and run the same file again. On completion it reports success and a
guided launcher stays open until you press Enter.

For a guided local launcher, use the file matching the operating system:

- Windows: `setup.bat`.
- PowerShell: `setup.ps1`.
- Linux: `setup.sh`.
- macOS: double-click `setup.command`.

There is one launcher family, not one per agent: every launcher forwards its arguments to
`setup.mjs`, so `setup.bat --target=codex` installs only the Codex layer. Without `--target` the
launcher asks which agent to install, or detects it from the project.

Each launcher handles both installation and updates. When run from the plugin checkout it uses the
local utility; when distributed as only the launcher file it downloads the current utility through
`npx`. They ask for the project when not started inside one and pass all work to the same Node.js
setup utility. The launcher never stores credentials.
During workspace configuration, enter detected item numbers and/or additional relative or absolute
paths separated by commas; existing `extraRepos` entries are preserved.
On a new project, the launcher asks whether the `ai-context` should use Portuguese or English;
Portuguese is the default. Use `--lang=pt` or `--lang=en` to choose non-interactively. Existing
`ai-context` indexes keep their detected language.

It supports `install`, `update`, `status`, `doctor`, `latest`, and `configure`. It can update the
marketplace reference, reinstall the selected plugin version, bootstrap the current project, show
the current/latest versions, and configure `extraRepos` after confirmation. Run it from the project
directory; `--project <path>` is only needed when administering another project.

## The MCP server (optional)

`mcp-server.mjs` speaks the Model Context Protocol over stdio — JSON-RPC 2.0, one message per line —
with no dependency. It negotiates protocol versions 2025-06-18, 2025-03-26 and 2024-11-05, exposes only
tools (no resources, no prompts) and marks all five as read-only:

| tool | same as |
|---|---|
| `find_symbol` | `symbols.mjs <names…>` |
| `references` | `refs.mjs <name>` |
| `impact` | `impact.mjs <target> --budget=N` |
| `outline` | `outline.mjs <file> [filter]` — the path must be inside the project |
| `overview` | `overview.mjs` |

The project root is the server's working directory (the client starts it in the project), or
`CONTEXT_TOOLS_PROJECT_DIR`/`CLAUDE_PROJECT_DIR`. Nothing but protocol messages is written to stdout;
a failing tool returns `isError` with the reason and a pointer to text search, never an empty answer.

**Why it is optional.** The plugin already brings the tools to Claude Code and Codex through the skill
and the hooks, and every MCP tool definition is paid on every request of a client that loads it: about
2,000 characters (~500 tokens) here, with a ceiling under test. That is worth it for clients that have
no skill or hooks, not by default. `setup --mcp` copies the scripts to `~/.context-tools/runtime`
(the path stays the same across updates, unlike the plugin cache) and registers `node
<runtime>/scripts/mcp-server.mjs` with `claude mcp add --scope user|local` or `codex mcp add`. A later
setup run refreshes the copy when the server is registered; `--remove-mcp` unregisters it; `status`
shows whether it is registered.

## The hooks

| event | what it does | cost |
|---|---|---|
| `PreToolUse` (Grep / Bash) | answers before Claude Grep, a Claude `grep`/`rg` Bash command (hook `if` filter: no cost for other commands) or a Codex `rg`/`grep` command when the pattern is a symbol; notes the files it pointed to so `health.mjs` can report whether the agent used them (Claude) | only when it answers |
| `PostToolUse` (Grep / Bash) | after a Grep, or a `grep`/`rg` command, that returned line numbers: names the function, method or class each matched line falls in, with its line range and, when it fits, its declaration line (the parameters), from the outline of the files that matched (no index). Production files first, tests last; up to 20 files, and the files left out are named as not annotated — never cut silently. Grep shows `356: if (_maxDepth …` without the method around it; in the outcome benchmark an agent answered from that alone and named the wrong method | only when a matched file has a parser; at most 2,000 characters |
| `UserPromptSubmit` (Codex) | locally checks each explicitly named file against its own context-map fingerprint; emits context only for stale, uncovered, or unverifiable files | no model call; one local hook process per prompt |
| `Stop` | Claude warns when the session gets expensive and writes the handoff; Codex only records metrics | **once per session** |
| `Stop` | hands over the resume prompt, once the volatile block is filled in | once per session |
| `SessionStart` | lists context maps and flags the stale ones; shows a visible notice when action is needed | ~175 tokens |
| `SessionStart` | ensures the standard `ai-context` structure, points to its index, and announces first setup; while the index is the only document, says there is nothing to read yet instead of asking for it to be read | only when documentation is enabled |
| `SessionStart` | one line with the project's test command, what `npm test` actually runs, and how to run a single test file when the runner tells. In the outcome benchmark, agents spent 3–8 turns of a fix finding this out | ~30 tokens; silent when no test command is detectable or `verify.enabled` is false |
| `SessionStart` | says whether the last session split won, tied, or lost | only when there was a split |
| `SessionStart` | tells the user (not the agent) a newer release is out, with the update command; reads a cache, and refreshes it with a detached `git ls-remote --tags` when older than 24 h | only when a newer release exists; again after 7 days if not updated |
| `Stop` | Codex reviews only changed source files connected to maps and operational docs in this session; stale sibling sources remain in `health.mjs` | only for a new relevant finding; repeated sessions share a project-level pending claim |
| `Stop` | flags uncovered code when sibling files change together or the same source recurs across sessions; isolated candidates remain a health finding | only for grouped or recurring changes |
| `Stop` | reviews changed code without related `ai-context` under the same rule; stale existing documents remain immediate | only for relevant changes |
| `Stop` | warns if you edited A and did not touch B, which historically changes with it | only when it happens |
| `Stop` (Claude) | notes code edited after the last test run, with related tests and the test command | **once per session**; silent without a test setup |
| `Stop` | a session that only **read** code (no code edits) across at least 3 files in 2+ folders that no map or `ai-context` document covers gets one line suggesting the user ask for the flow to be recorded; offline, from the host's local transcript, never writes anything | **once per session**; reads only the transcript bytes added since the last `Stop` |

Every hook message goes through one deduplication point: the same (event, session, text) is
delivered once per 90 s, so a plugin plus a standalone copy — or a hook registered twice — does not
double the context. `CONTEXT_TOOLS_HOOK_DEDUPE=0` disables it.

### Protected paths and commands

There is deliberately no guard hook. A `PreToolUse` hook on every Edit and Bash call would cost a
Node start-up (~130 ms) per call in every project, and Claude Code already enforces this natively,
at zero cost, through `permissions` in `.claude/settings.json`:

```json
{ "permissions": { "deny": ["Edit(legacy/**)", "Bash(git push --force:*)"], "ask": ["Bash(git reset --hard:*)"] } }
```

When a handoff lists something that "must not be repeated or undone", turning it into one of these
rules makes it enforced instead of remembered.

### `PreToolUse` is the only point where the tool arrives on its own

The others are **pull**: someone has to remember to call them, and depending on habit is fragile.
`PreToolUse` inverts that into **push** — when the Grep pattern looks like a symbol
(`processIncomingMessage`, `parseA|parseB`), the definition arrives before Grep runs.

Sized against a workspace's real history (68 sessions, 15,612 tool calls): **649 of 1,633 Greps —
40% — search for something that looks like a symbol.** Intercepting `Read` of large files was also
evaluated and **discarded by measurement**: only 25 of 3,690 reads (1%) would be candidates, and it
does not pay for the cost of running on every read.

It was also **validated retroactively**, without waiting for usage: each of the 649 historical Greps
was replayed against the index and compared with what the agent did next.

| | |
|---|---|
| the hook would have answered | **309 (48% of 649)** |
| of those, it pointed at the file the agent opened in the next 6 calls | **183 (59%)** |

That is **183 of 1,633 Greps (11%)** where the right answer would have been available before the
search. The number is a **floor**: the index reflects today's code, so a symbol renamed or removed
since the Grep counts as "would not have answered". And it measures **availability of the answer**,
not guaranteed saving — whether the agent takes advantage of it, only usage can tell.

It **never blocks**: Grep runs regardless, this is extra context. And it stays quiet more than it
speaks — no hits, too many hits (Grep is better then), textual search with metacharacters, a name
too short, or if it already answered that in this session.

**What it costs, measured and unvarnished:** ~180 ms per Grep, of which **128 ms is Node's
startup** — the floor of any hook, which no optimization can reach. The heavy modules only load
after the pattern passes the "looks like a symbol" test, which gives back ~10 ms on the ~60% of
discarded Greps. In a project the index cannot read, those 180 ms are pure waste: whoever does not
want to pay removes the `PreToolUse` line from `settings.json` — the other tools keep working.

The legacy Claude map hook and global health checks use `HEAD`/`verified_at` to find source changes,
including commits made during a session. Codex uses a separate session attribution path for automatic
Stop review: it observes explicit file-write tool calls and validates their resulting hashes. This
distinction matters in a shared checkout, where a commit or working-tree diff cannot identify which
Codex window made an edit.

The detector hashes covered and referenced source files locally with SHA-256. After a legacy reference
passes its existing freshness check, its content becomes the local baseline: touching or copying a file
without changing its bytes no longer triggers review, and content changes that preserve the mtime are
detected. Reviews carry `source_fingerprints` for only the source files actually checked. The aggregate
`source_digest` is updated only when per-source metadata covers every current source; older stale siblings
remain visible in the global health report until reviewed. The hook itself never writes semantic content.
Reviews use a structured local queue identified by target and exact source revision, independent
of batch order and prompt text. New bytes can create a new revision; an empty report never proves
completion. Abandoned or unconfirmed reviews stay deferred without repeated automatic prompts.
Matching explicit review metadata completes a review. The queue stores local paths and hashes,
never source bodies or prompts.

`Stop` uses the current turn and latest confirmed writer. Resuming a chat starts a new epoch;
reverting to old bytes never restores old ownership. Overlapping edits are ambiguous. Bash is
supported only through an explicit `tracked-edit.mjs` manifest, with project/extraRepos path checks.
An idle Stop exits before discovering or hashing documentation references. Active collectors share
an invocation-scoped hash cache. Whole findings fit the prompt budget; larger manifests use
`review.mjs show`, never truncated JSON. Complete matching per-source metadata permits offline
aggregate digest synchronization without a model call or invented review date. Facts require inspection.

A newly uncovered source is kept out of automatic review until two sibling files change together or
the same source recurs in a different session within 90 days. The local health report still shows
uncovered files from the current session. Health metrics also show how many automatic-review prompts
were emitted and a rough character-based estimate for the hook instructions; this is not billed
model usage and excludes source reads, prior context, and model output.
A second Stop reports unresolved findings from this session without starting a loop.

The Codex `UserPromptSubmit` preflight reads the current prompt only in memory and looks for explicit
file paths or names. It hashes locally and makes no model or network request; it does not store prompt text.
When a named file is covered and current, it emits nothing even if a sibling source in that map is stale.
A stale, uncovered, or unverifiable target adds a short context note before work begins. Prompts without
explicit file names take the quiet path; the local hook process still has a small startup and filesystem cost.

### When the hook suggests a map (and why it stays so quiet)

It cannot tell "they forgot to map this" from "they decided not to map this", and the asymmetry
between the two errors is large:

> Failing to suggest a map costs one lost suggestion — you create it later, when you want to.
> Insisting on a file that will never be mapped teaches people to ignore the entire category, and
> then the **right** warnings disappear along with it.

So the default is **generous about staying quiet**, in three layers: built-in exclusions
(`*.config.*`, `*.test.*`, `*.d.ts`, `__mocks__/`, `*.generated.*`, and the plugin's own
`.claude/scripts/`), a relevance threshold (only suggests with **3+ unmapped files**, or **1 file of
200+ lines**), and `intentionallyUnmapped` as a manual escape hatch. The threshold costs at most 2
file reads: with 3+ candidates, it never reads anything.

---

## Configuration

None is required. It detects the root, the layout (single repo or multi-repo workspace), and
documentation folders. To depart from convention, `.claude/context-tools.json`:

```json
{
  "sourceDirs": ["packages/core/src", "packages/api/src"],
  "ignoreDirs": ["prototypes", "old-copies"],
  "coupling": { "since": "6 months ago", "minTogether": 3, "warnConfidence": 0.7 },
  "contextMaps": { "intentionallyUnmapped": ["scripts/legacy/"] },
  "claudeMdHint": false,
  "extraRepos": ["../AppConnection", "../shared"],
  "verify": { "command": "npm run test:unit", "testPatterns": ["make check"] }
}
```

`ignoreDirs` lists folder names to skip at any depth — copies, prototypes, local backups — on top of
the built-in list (`node_modules`, `dist`, `__history`, `__recovery`…). They leave the index, the
answer before `grep`, the context pack, documentation checks and the read-only session suggestion.
Names only, case-insensitive; entries with a path separator are ignored. Nothing is guessed: a
project's throwaway folders are declared here.

`verify.command` overrides the detected test command; `verify.testPatterns` adds commands that count
as a test run; `verify.enabled: false` turns the `Stop` note off.

### Operational documentation

Operational documentation is enabled by default. In a new project, the hook idempotently creates
only the standard skeleton; it never invents business rules:

```text
ai-context/
├── 00-index.md
├── features/
├── screens/
├── decisions/
├── integrations/
└── database/
```

Physical names follow `lang` (`pt` or `en`). Logical categories are fixed; only their physical
names and the index are localized. Disable the feature in a project with:

```json
{
  "documentation": {
    "enabled": false
  }
}
```

The root directory is configurable, but its internal structure is not:

```json
{
  "lang": "en",
  "updateCheck": true,
  "documentation": {
    "enabled": true,
    "autoInit": true,
    "captureHint": true,
    "root": "ai-context"
  }
}
```

`captureHint: false` turns off the read-only session suggestion. It is on by default because it only
shows a line to the user (Claude and Codex `systemMessage`); the agent is never told to act on it.

`updateCheck: false` (or `CONTEXT_TOOLS_UPDATE_CHECK=0` for every project) turns off the new-release
check, the only network call the hooks make. It is also off whenever `CI` is set.

Available commands:

```text
context-docs init
context-docs create --type feature --name customer-credit
context-docs status
context-docs audit
```

`init` and `create` create only structure or a template. The agent must investigate and fill in
semantic content. Existing documents are never overwritten, and `To map` is never automatically
promoted to a confirmed rule.

**`claudeMdHint`**: if the project already has a `CLAUDE.md`, the plugin appends to it — once,
never again — a short note suggesting `context-tools` be tried before spawning a broad
exploration subagent for "where is X defined" questions. It exists because Claude, by default,
tends to delegate open-ended searches to a subagent without considering whether an installed
skill would resolve it more cheaply — and a subagent returns only a synthesis, so even though
the `PreToolUse` hook fires inside subagents too, the information may never make it back.
`false` disables it; it never creates a `CLAUDE.md` the project didn't already have, only
appends to an existing one.

**`codexMdHint`**: the equivalent for an existing `AGENTS.md` when the hook runs in Codex. The
block is selected in Portuguese or English by observing the file itself; an explicit `lang` still
takes precedence. The text says that existing rules remain authoritative and uses the host's
navigation path (`.codex/scripts/`). `false` disables the edit.

**`extraRepos`**: include sibling repo(s) of the root in the index, even without their own
`.git` — for when the root has to stay a specific project (the parent workspace holds dozens of
other projects that don't matter here), so neither "reopen the session at the parent folder" nor
the automatic mixed-workspace fallback solves it. Paths are relative to the root, confined to
the subtree of the root's PARENT folder — `../neighbor` is accepted, `../../deeper` is refused
(the inverse of `sourceDirs` refusing to leave the project — here leaving is the point, but
bounded). With nothing configured, it's derived automatically from a VS Code `.code-workspace`
file (in the root or its parent) — an explicit `extraRepos: []` turns off that auto-detection. The
root project itself is always retained in the index, including a git-less root with explicit
`extraRepos`; the sibling list never replaces the project being analyzed.

**Language**: the library fallback is English. The guided installer writes Portuguese by default
for a new project; use `--lang=en` or `{ "lang": "en" }` (per project) to choose English.
`CONTEXT_TOOLS_LANG=pt` remains available for one-off runs. With no explicit choice, existing
indexes are detected and otherwise it falls back to English instead of breaking — a message in an unexpected language is annoying; an error in the
middle of a hook is worse.
For `CLAUDE.md` and `AGENTS.md` hints, the file's own language takes precedence when configuration
is not explicit, preventing English text from being inserted into a Portuguese project.

## Installed where it is of no use

A plugin can end up in a project without git, or in a language it does not read, or in an empty
folder. The rule is: **keep helping when it can, and do not get in the way when it cannot** — which
includes not breaking, not lying, and not charging much for nothing. Verified by building those
environments:

| situation | what happens |
|---|---|
| **no git** | `symbols` and `audit-docs` work (they only need the files). `why` still **says** there is no history and never fakes an answer — there is no substitute for "why is this line the way it is" without real commits. `coupling` uses session-attributed edits in Codex and the existing session snapshot in Claude. Both point at the fix: `git init` locally, no remote needed. Map freshness still falls back to file **mtime** instead of git diff; Codex Stop attribution uses its explicit file-write journal. See below |
| **unread language** (Ruby, C#…) | it says how many files it found, **which** extension, and that changing `--root` will **not** fix it — the cause is the language. Hooks silent |
| **empty folder / data only** | the configuration remedy, which is the correct one there. No noise |
| **host state directory not writable** | answers normally, just does not cache |
| **two sessions in the same repo** | atomic writes (temp + rename). Tested with 8 concurrent processes: all correct, cache intact |

None of that crashes or delays anything: in the worst case every script exits with status 0 in under
250 ms.

### The mtime fallback for map hooks, and why it stays honest

Without git, `verified_at` cannot be a commit-ish — there is nothing to resolve it against. So in a
repo with no `.git` anywhere, it is read as a **date** instead (`2026-08-01`, or a full ISO
timestamp): the map hook compares each covered file's mtime against that date, and against the
session's start time for the "you touched this, the map was not updated" warning. A file written
after `verified_at` (or after the session started) counts as changed.

This is a strictly weaker signal than `git diff`, and the tool says so **in the message itself**,
every time: a `touch` with no content change looks identical to a real edit, and a write that
happens to preserve the original mtime (rare — a `cp -p`, a restore from backup) would be missed.
Neither failure mode is silent — the footer names the trade-off, and it names the fix: `git init`
run locally, no remote required, fully reversible with `rm -rf .git`. `why` still refuses the
substitute entirely, because there is no mtime equivalent for "why is this line the way it is" —
that question needs actual commit history, not a single timestamp, and inventing one would violate
the rule this whole plugin exists to keep: never answer with confidence when the honest answer is
"cannot tell".

`coupling` takes the other path, because co-change correlation survives a coarser basket: without
git it swaps the commit for the whole **session** (every file touched between `SessionStart` and
`Stop`, recorded in the host's state directory — `.claude/` for Claude or `.codex/context-tools/`
for Codex) and runs the exact same confidence math on
top of it. It says so on every line — "no git repository", how many sessions are behind the number,
and below `minSessions` (5 by default) it answers "not enough data yet" instead of "no coupling
found", because those are different claims and only one of them is backed by a real measurement.

A small detail that became a test: the "I do not read that language" message **has already lied** —
Python and Go entered the index and the text kept listing only the old extensions, meaning the
diagnosis denied reading the language it had just started reading. The list is now generated from
the single source, and there is a test ensuring every supported extension appears. In a tool whose
thesis is "fail visibly", getting your own failure message wrong is the worst possible place.

## Knowledge left behind: `drift-check` and the health score

The hooks tell the person in the session. A team needs the same signal where changes are reviewed —
the pull request. `drift-check.mjs --base=<ref>` takes the files the diff `base...head` changed and
lists every context map and **live** `ai-context` document that cites one of them **without a recorded
review of the new content**. "Recorded review" means the per-source fingerprint `ack` writes into the
file itself: in CI there is no local cache, and a cache never proved that anyone looked. A map whose
text was edited in the same pull request but whose review was not recorded is reported too, with a
different reason, because editing prose is not the same as checking the source.

| exit code | meaning |
|---|---|
| 0 | nothing left behind, or findings without `--strict` |
| 1 | findings with `--strict` |
| 2 | the diff could not be computed (unknown ref, shallow clone, ref that looks like an option) |

Exit 2 exists because "could not look" passing as "nothing changed" is the failure this tool is built
to avoid. `--format=github` turns each finding into a pull-request annotation and appends a summary to
`GITHUB_STEP_SUMMARY`; the repository root ships a composite action that does exactly that.

`health.mjs` shows the same state as a number: the share of **verifiable** maps and documents whose
sources are unchanged since their review. Historical, manual and source-less documents are counted
apart rather than inflating the score, and "nothing verifiable" is reported as such, never as 100%.
Each `SessionStart` records one local sample of the maps' share (no paths, no names), so the report
can say whether written knowledge is improving or rotting.

## Security

The hooks inject text **directly into the model's context**, and much of that text comes from the
repository (the `area:` in frontmatter, folder names, paths git returns). In a cloned, contributed,
or dependency-sourced repo, that is **untrusted input** — and it was the root of four of the six
failures already fixed here:

- **arbitrary file write** via `verified_at: --output=…` (git interprets the option before the `--`)
  — fixed in two places; every value that reaches the command line before `--` goes through ref
  validation;
- **path traversal** via `sourceDirs: ["../neighbor"]`, which made the index read another project;
- **context flooding**: 9,000 characters in `area:` became 14× the size of the injected block;
- **control and ANSI characters** coming from the repo and reaching the context.

Every external call uses `execFileSync` with an argument array — never a shell: a path containing
`;` or `$(…)` is an argument, never a command. The index also **does not leave the repository**:
directory links (symlink or junction) are not followed, and a test creates a real link and proves
both sides.

The injected block explicitly states that names coming from the repository are **data, not
instructions**.

## Tests

```bash
npm test
```

The test suite has no dependencies (uses `node --test`) and runs on 3 operating systems × Node 18 and 22. It
cover each language's parsers, `bareName`, the map exclusions, the audit heuristics, the security
surface above and — most importantly — **the six scenarios in which the cache could lie**.

There is also a **recall** test: it lists the declaration patterns the index must find and fails by
naming the ones it missed. It is the metric that says whether a new parser regex is worth adding —
measuring before coding avoids bloating the parser with patterns nobody uses.

## The rule worth more than the tools

🚫 **Never write `file:line` in documentation.**

In a real audit, of the 13 `symbol @ file:line` references checked against the code, **none was
correct**. The worst was off by 2,861 lines. No symbol had disappeared — only the numbers rotted.

Cite the symbol; the line resolves on the spot with `symbols`/`outline`.

### The second rule, learned the expensive way

🚫 **Any list describing the same fact in two places is a bug waiting for a date.**

In a single day, **four** of them drifted in this repository — and all four failed silently, which is
the failure mode this whole plugin exists to prevent:

| the copy | what it caused |
|---|---|
| index extensions, repeated in `context-maps.mjs` | the "unmapped code" warning was **inert forever** in Delphi and Rust projects; then again in Python and Go |
| hooks, repeated across `hooks/hooks.json` and `install.mjs` | anyone installing **as a plugin** — the recommended path — got half the hooks |
| state files, repeated in `install.mjs` | incomplete `.gitignore`; you could commit a generated handoff without noticing |
| `.test.[jt]sx?` in the default filter | the filter was born blind to `.test.mjs`, the repository's own convention |

In all four cases, adding the missing item would have fixed the symptom and left the cause alive.
What survived was **deleting the copy** and deriving from the original: `EXTENSOES_CODIGO` in
`lib/roots.mjs`, `hooks/hooks.json`, `.claude/.gitignore`.

The practical rule: **a new single source requires a test that proves the derivation**, not one that
describes today's value. A test that repeats the list is the fifth copy.

---

## Known limitations

- **`symbols` sees top-level definitions, class methods, and first-level config keys** — it does not
  see local variables, nested properties, or database columns that are not declared in a `.sql`
  file (tables and columns from `CREATE TABLE`/`ALTER TABLE … ADD` are indexed). Measured, the blind spot is ~97,500
  identifiers in a 1,543-file workspace, and config keys cover 1,329 of them (1.4%) — chosen because
  they are the ones searched for across files, but **that is a hypothesis: we have no query log to
  prove it**. Closing the rest would require an AST, and then the cost is not performance but
  dependencies: "zero dependencies" here is a CI test that fails if anyone adds a package. In the
  cases it cannot see, it says so and sends you to Grep.
- **Ruby, Kotlin, Swift and others have no parser.** It is not difficulty, it is method: a new parser
  only lands with a real corpus to verify it points at the right line. Until then, `symbols`
  diagnoses the case instead of claiming the project is empty.
- **No test runs the plugin inside Claude Code itself** — the E2E tests run the scripts as processes,
  with the same JSON contract and exit codes, which is as close as possible without automating the
  agent.
- **Network filesystems and WSL have not been tested.** CI covers all three operating systems, but
  always on local disk — and it is precisely the `mtime` granularity of those environments that
  decides whether the cache can be used. The 20,000-file figure is simulated, not a real monorepo.
- **An external API identifier cited in a doc becomes a "ghost symbol"** in the audit. Existence is
  checked as text within the project's code, so a name that exists *somewhere else* cannot be
  distinguished. It errs toward accusing, which is the cheap side: the opposite would hide rotten
  docs.

## Out of scope — by design, not by omission

Solving each one would destroy precisely what gives the tool its value:

- **`audit-docs` does not validate technical claims in prose.** "Guard X runs before Y" would
  require an LLM call, breaking four properties at once: working offline, being deterministic,
  costing zero per run, and not inventing false positives.
- **Nothing bumps `verified_at` on its own.** It is the central guarantee of the map system.
- **The cache trusts mtime+size, never a content hash.** Hashing would require READING the file —
  exactly the cost the cache exists to avoid.

## Review queue / Fila local de revisão

```bash
node "${PLUGIN_ROOT}/scripts/review.mjs" status --json
node "${PLUGIN_ROOT}/scripts/review.mjs" show --id=ID --json
# After inspecting exact source versions / Após conferir as versões exatas:
node "${PLUGIN_ROOT}/scripts/review.mjs" ack --id=ID --revision=REVISION --reviewed
node "${PLUGIN_ROOT}/scripts/review.mjs" defer --id=ID --reason=insufficient-evidence
node "${PLUGIN_ROOT}/scripts/review.mjs" retry --id=ID
```

`ack --source=KEY` supports partial review. The helper preserves other fingerprints and prose,
rejects concurrent changes, and preserves UTF-8, BOM, Windows-1252 and UTF-16 encodings.
Documents accept `maintenance: live|historical|manual`; decisions default to historical.
`review_sources: ["./src/a.js"]` declares current references. Optional
`review_dependencies: [{"source":"./src/a.js","symbols":["function foo"]}]` uses exact outline
labels and portable `dependency_fingerprints`. Invalid or unsupported scopes fall back to whole-file
verification and appear in health. Explicit scopes are an author contract, not inferred semantics.
Use `tracked-edit.mjs manifest --file=PATH` to obtain a token, then execute
`node "${PLUGIN_ROOT}/scripts/tracked-edit.mjs" --context-tools-edit=TOKEN -- EXECUTABLE ARGUMENTS`.
Declare every possible target; the wrapper does not infer shell behavior or recode files.

---

## License

[MIT](../LICENSE) — Copyright (c) 2026 Luiz Nogueira.
