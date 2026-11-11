# Smart Router (smartLLMrouter)

**Pick one model in OpenCode. Every session pays less.**

Smart Router turns your coding agent's model selector into a cost lever. Instead of choosing between your expensive planner and a cheap-but-shaky executor, you select a single model — **Smart Router** — and it quietly builds with the cheapest model that is *"good enough"* for the specific task in front of it, on a per-session basis.

> **Current default: subscription-backed Astra (pre-Jev stage).** Select **Smart Router (auto)** under **OpenAI** (`openai/smartrouter-auto`). The native alias sends `gpt-6-astra` using your existing ChatGPT OAuth sign-in and plan allowance. Plan and Build stay on Astra for now; **no Jev calls, API-key fallback, or Go fallback**. Auxiliary requests stay within OpenCode's native provider handling. The tier-routing flow below is the target design, not yet implemented for native subscription mode.

![Pencil-drawn Smart Router architecture: the working subscription-backed Astra path and planned Jev, confidence gate, tier routing, caching, and measurement](docs/model-router-pencil.png)


> **Editable pencil drawing:** [`docs/model-router-pencil.svg`](docs/model-router-pencil.svg). Solid lines show the working native Astra path; dashed lines show the next stages. The [original interactive prototype diagram](docs/model-router.html) is retained as historical design context.

## Why

Agentic coding bills are dominated by the **build loop** — tool calls, file reads, edits, hundreds of turns. Most sessions don't need the strongest model for that loop; most *do* need it for planning and for the occasional architectural task.

So the decision "which model for this session?" is worth real money — and it's a **classification** question, not a reasoning question:

| Routing an LLM to decide | Routing with a System One classifier (Jev) |
|---|---|
| ~$0.014 per decision (LLM call) | **≈$0.00003 per decision** |
| seconds of latency | **~0.1 s** |
| free-form rationale you must parse | typed answer + probabilities + **calibrated confidence** |

The router tax should be ~0.1% of what it saves — a slower, pricier router would eat its own savings.

## Full workflow (target design)

1. **Plan** — select Smart Router, then use plan mode. The current native alias uses Astra through your existing OpenCode OpenAI sign-in, without an independently authenticated proxy.
2. **Classify** — when the plan is done, one Jev call answers typed questions in parallel against the plan digest + repo signals: *exec tier* (choice), *complexity / blast radius / novelty* (three rubric scores), *touches infra / touches security* (boolean checks).
3. **Compose** — pure code turns those answers into a tier: weighted scores, hard overrides (infra/security never route below mid), and a **confidence gate** — high confidence auto-switches, low confidence asks you first.
4. **Build** — the session executes the plan on the routed tier.
5. **Measure** — every decision and token count is logged; a report compares real cost against an "always-top" counterfactual.

## Model tiers

Smart Router routes between the models you connect — e.g. OpenAI models, **GLM-5.3-Flash** ($0.15/$0.50 per 1M) and the free OpenCode Go models:

| Tier | Example | Typical job |
|---|---|---|
| flash | GLM-5.3-Flash, LongCat 2.5 Free | typos, one-file tweaks, boilerplate |
| mid | GPT-6 Luna, GPT-5.5 | features, multi-file changes, tests |
| top | GPT-6 Astra | architecture, migrations, infra/security |

## Early proof (prototype classifier run)

Three sample plans, one Jev call each, tier composed in code:

| Plan | Routed tier | Confidence | Decision cost* | Latency |
|---|---|---|---|---|
| Docs typo | **flash (free tier)** | 0.93 | ≈$0.00003 | 149 ms |
| UI feature | **mid** | 0.82 | ≈$0.00003 | 84 ms |
| Auth + infra | **top** | 0.93 | ≈$0.00003 | 67 ms |

**3/3 correctly separated** — and any of these decisions costs less than one tool call from a GPT-6-class model.

## Roadmap

Rollout order (not PR numbers):

1. **OpenCode setting / pre-Jev:** native **Smart Router (auto)** alias → Astra → existing OpenAI OAuth allowance. Plan and Build both use Astra; the legacy API proxy remains opt-in only.
2. **Jev flow:** classify the finished plan once, compose a tier, and gate on confidence. Jev remains a separate classifier service.
3. **Post-Jev routing:** execute on an eligible connected model and cache the decision for the session. Native cross-provider routing is still a design constraint to solve; the alias alone does not enable it.
4. **Measure and harden:** telemetry, allowance/cost comparisons, failure escalation, additional provider families, and router-library extraction.

## Install and test (native subscription mode)

1. **Clone the repo:** `git clone https://github.com/kunalkohli/smartLLMrouter`
2. **Load the plugin** into any OpenCode workspace — symlink it:
   `ln -s <repo-path>/plugin/smartrouter .opencode/plugins/smartrouter`
   …or reference the path in `opencode.jsonc`: `"plugins": ["<repo-path>/plugin/smartrouter"]`
3. **Connect OpenAI** with `/connect` → **OpenAI** → **Sign in with ChatGPT**, if not already connected. Native mode requires OAuth and refuses API-key connections. Usage still counts against your subscription limits.
4. **Configure** (optional): `cp config/smartrouter.example.json .opencode/smartrouter.json`. The default is `"mode": "native"` and `"planner": "openai/gpt-6-astra"`. No key files or environment variables are needed. The tier/key settings are ignored in this mode.
5. In `/models`, select **Smart Router (auto)** under **OpenAI** (`openai/smartrouter-auto`). If upgrading from the proxy prototype, cancel its retries and reselect this new entry; old sessions selecting `smartrouter/auto` do not migrate automatically. Config/plugin edits reload automatically; use `/reload` if needed, not a service restart.
6. In **Plan**, send: **“Reply with exactly PLAN_OK. Do not use tools.”** The response should come from Astra. The picker and assistant records keep the Smart Router identity; the alias's native `modelID` is `gpt-6-astra`.
7. Switch to **Build** and send: **“Reply with exactly BUILD_OK. Do not use tools.”** This also uses Astra in the pre-Jev stage. No tier announcement is expected yet.

Native routing uses an alias with `modelID: "gpt-6-astra"` under the existing OpenAI provider, with a `model.request` guard that requires OAuth on every dispatch. OpenCode's native provider, OAuth refresh, request hooks, transport, and usage accounting remain in control. The plugin never extracts or forwards your saved tokens itself. If sign-in or Astra is unavailable, it stops rather than falling back to a separately billed backend. The alias shows no per-token API cost; usage still consumes your plan allowance.

### Legacy API proxy (explicit opt-in; separately billed)

The earlier Jev/tier-routing prototype is retained behind `"mode": "api-proxy"`. It registers the old `smartrouter/auto` entry and **does not use ChatGPT subscription allowances**. Only use it if you explicitly want API-key billing:

1. Set `"mode": "api-proxy"` in `.opencode/smartrouter.json`.
2. Export keys into the environment OpenCode runs in:
   - `OPENCODE_GO_API_KEY` — OpenCode Go models (GLM-5.3-Flash, GPT-6 Luna, the free tier)
   - `OPENAI_API_KEY` — your top planner; *without it planning runs on Go and logs the fallback once*
   - `TYPESAFE_API_KEY` — Jev classifier; *without it builds pass through to the planner and nothing routes*
3. In `/models`, pick the **Smart Router** provider's `smartrouter/auto` entry. Plan as usual; the first build request attempts Jev classification and tier routing.

### Tests

With Node.js 22.18+ (built-in TypeScript support), run:

```sh
node --test test/native-planner.test.ts
```

## Security

- Native mode checks connection metadata only; OpenCode owns your OAuth secrets and subscription requests. It refuses API-key fallback.
- Legacy proxy keys are read from environment indirection (`TYPESAFE_API_KEY`, `OPENCODE_GO_API_KEY`, …). Nothing is ever written into the repo, and `.gitignore` blocks common secret-file patterns.
- Config values support `env:VARNAME` indirection, so no key ever needs to exist in a file you might commit — **including this repo's own sample configs, which ship as `env:` placeholders**.
- Get a Jev key at `console.typesafe.ai/keys` (TypeSafe AI console).

## License

MIT — see [LICENSE](LICENSE).
