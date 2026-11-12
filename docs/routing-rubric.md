# Routing rubric: routine-feature-v2

The router chooses the cheapest model Jev judges sufficient for **execution after planning**, not the strongest model available. This is a routing heuristic, not a validated capability benchmark.

## What changed

The original family question described free work as small/mechanical and OpenAI work as substantial features requiring reliable judgment. Those categories overlapped: an ordinary multi-file prototype could fit both. The model choice also described DeepSeek broadly as contained coding work, making the GLM/UI preference unclear.

The revised question block makes these distinctions explicit:

- **Ordinary implementation can be free:** a new app or several files, search/autocomplete, watchlists, chart-library integration, localStorage, theme controls, conventional tests, and a thin read-only data proxy.
- **Domain is not risk:** displaying public financial data is not trading, payment processing, or storing private financial records. Explicitly excluded future features are not counted.
- **Standard key use is not security-system redesign:** reading an existing provider key from a server-side environment variable is distinguished from implementing credential storage/rotation, authorization boundaries, secret exposure, or financial execution.
- **Actual difficult work still qualifies for OpenAI:** hard root-cause analysis, non-routine integration/business rules, bespoke algorithms/concurrency, unfamiliar cross-system design, and high-risk production changes.
- **Free-model preferences are explicit:** GLM for conventional interactive app/UI assembly; LongCat for mechanical/minimal work; DeepSeek for contained code-centric fixes/refactors/transformations. These are configurable routing preferences, not measured rankings.
- **Terra/Sol remains conditional:** choosing Terra as the OpenAI subtype does not mean the family must be OpenAI. Existing risk guards and the 0.80 approval threshold are unchanged. Astra remains forbidden in Build.

## Classifier-only comparison

One observed pass over six public synthetic cases and one private live plan:

| Case | Original rubric | Revised rubric |
|---|---|---|
| Read-only market dashboard + ordinary env-backed proxy | DeepSeek Free, gate 0.08 | GLM Free, gate 1.00 |
| Mock admin dashboard | DeepSeek Free, gate 0.48 | GLM Free, gate 1.00 |
| Documentation spelling | LongCat Free, gate 0.96 | LongCat Free, gate 1.00 |
| Contained data-transform refactor | DeepSeek Free, gate 0.88 | DeepSeek Free, gate 0.98 |
| Difficult production concurrency debugging | Sol, gate 1.00 | Sol, gate 0.24 — approval required |
| Auth + real financial execution/migration | Sol, gate 0.99 | Sol, gate 0.96 |
| Private live prototype plan | Terra, gate 0.32 | GLM Free, gate 0.96 |

**These are single-pass classification observations, not executor success rates, correctness probabilities, or evidence of calibrated confidence.** The dashboard labels encode a GLM routing preference; the original DeepSeek choices were also free. The private plan and watchlist are not included in this repository. No task was executed by this evaluation.

## Reproduce or extend

The public desired-routing cases are in [`test/fixtures/routing-cases.ts`](../test/fixtures/routing-cases.ts). Running unit tests makes no real API calls. The following evaluation is **opt-in and uses billable Jev calls only**; it does not invoke any build model:

```sh
TYPESAFE_API_KEY_FILE=/private/path/to/jev.key node scripts/evaluate-router.ts
```

- `--case read-only-market-dashboard` evaluates a single public case.
- `--baseline /private/path/to/trusted-baseline-jev.ts` compares a trusted local snapshot exporting `classifyBuild`. Do not load untrusted modules.
- `--live-session ses_your_session_id` additionally reads that session's finished Plan and instruction through the local OpenCode API, in memory only. It prints routing metadata, never the plan, watchlist, key, or prompt. Its GLM expectation is an explicit hypothesis for routine prototype work, not a general expectation for arbitrary sessions.

The script uses the default candidate allowlist for classifier comparison; it is not a provider-connectivity test. It does not change active sessions or their cached decisions.

## Existing sessions

New decisions record `rubricVersion: "routine-feature-v2"`; notices and `/smartrouter-status` show the version. Existing unversioned decisions are labeled legacy and are **not automatically invalidated**. To test the new rubric, start a new router session, or explicitly run `/smartrouter-reset` and then send the next Build instruction. This incurs one new Jev decision.
