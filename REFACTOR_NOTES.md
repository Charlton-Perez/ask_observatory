# Refactor: regex intent-detection → model-driven tool use

## What changed and why

Previously the browser guessed what data the model would need (regexes in
`App.jsx` detecting dates, thresholds, ETCCDI terms…) and shipped pre-computed
slices plus a 145KB context blob with every question. Anything the regexes
didn't anticipate got no data, so complex questions failed silently.

Now the model drives its own data access through four composable tools,
executed **in the browser** against the already-parsed CSV. The dataset never
leaves the client; `/api/chat` is a stateless relay.

```
browser ── messages ──▶ /api/chat ──▶ model (with tool definitions)
browser ◀── content ────┘
  │  any tool_use blocks? execute locally (toolExecutor.js),
  │  append tool_results, call /api/chat again
  ▼
plain-text answer → rendered, with a "computed from the daily record" trail
```

## The four tools (src/toolExecutor.js)

| Tool | Covers | Caps |
|---|---|---|
| `aggregate` | mean/min/max/sum/count of any field, AND-filters, group by year/month/year_month/decade, `calendar_day` for "every 15 June" | 250 groups |
| `rank_days` | top-N days by any field, asc/desc, filters + scope | n ≤ 50 |
| `find_runs` | consecutive-day spells: heatwaves, dry spells, frost runs… returns longest runs, totals, per-decade counts | top_n ≤ 25 |
| `get_days` | raw rows for short windows ("what was 14 Oct 1987 like?") | 400 rows |

Errors are instructive ("Range covers 41,274 days — max 400… use aggregate
instead") so the model self-corrects rather than giving up. Extending coverage
means adding a primitive here + a schema in `api/chat.js` — not a new regex.

## File-by-file

- **`api/chat.js`** — rewritten. Holds the (much shorter) system prompt and
  tool schemas; relays Anthropic-format messages; returns `{content,
  stop_reason}`. Prompt caching (`cache_control`) on the system prompt caches
  the tools+system prefix across loop rounds and across questions.
  Provider router preserved: `anthropic` native; `openai`/`groq`/`mistral`/
  `ollama` via an OpenAI tools-format adapter; **`gemini` is text-only
  fallback for now** (its tool format differs; add an adapter if needed).
- **`src/toolExecutor.js`** — new, self-contained (no imports, Node-testable).
- **`src/App.jsx`** — rewritten. All regex detection deleted (~170 lines).
  Runs the tool loop (max 8 rounds, with a "wrap up now" nudge on the
  penultimate round), shows live "Computing: …" activity, and attaches the
  step trail to each answer. Sends a slim context (coverage + WMO normals +
  all-time extremes: ~12.5KB vs 145KB before).
- **`src/dataParser.js`** — one fix: trace rainfall (`'tr'`) now parses as
  0.0 mm instead of null. Previously ~80 days/year were silently dropped from
  every rainfall statistic (1995 had only 286 "valid" RR days). This also
  changes dry-spell results — trace days now count as dry (no measurable
  rain), per convention. `buildContext` is still used for the UI card and slim
  context; the old slice/extract helpers are now unused and can be deleted
  when convenient.
- **`src/App.module.css`** — appended `.activity`, `.steps`, `.stepChip`.
- **`scripts/test_executor.mjs`** — Node harness: `node scripts/test_executor.mjs`
  runs 16 checks against the real CSV (extremes, counts, runs, calendar-day
  probabilities, error paths).

## Behaviour & cost

- Simple questions: 1–2 model calls. Complex: typically 2–4. Each call is far
  smaller than before (slim context + compact tool results, cached prefix), so
  cost per question is similar or lower; latency is a little higher on complex
  questions but the activity line shows progress.
- Every number is code-computed. The chips under each answer double as an
  audit trail — nice for a public tool.
- Env vars unchanged: `MODEL_PROVIDER`, `MODEL_NAME`, `MODEL_BASE_URL`,
  `MODEL_API_KEY`/`ANTHROPIC_API_KEY`, `INVITE_TOKEN`, `VITE_INVITE_TOKEN`.
- Suggested model: keep `claude-haiku-4-5` as default; tool selection is the
  hard part, so if you see poor tool choices try `claude-sonnet-4-6`.

## Known limitations / next steps

- Multi-turn context replays only the visible text transcript, not prior tool
  exchanges (keeps payloads small; final answers carry the numbers).
- Cross-field derived stats (e.g. correlation Pmsl↔RR) aren't a primitive yet;
  the model can approximate via grouped aggregates, or add a `correlate` tool.
- A sandboxed "run custom JS in a Web Worker" escape-hatch tool is possible if
  the four primitives prove insufficient — ship without it first and collect
  failed questions.
