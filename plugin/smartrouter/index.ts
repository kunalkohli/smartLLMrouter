/**
 * Smart Router — the OpenCode plugin behind `smartrouter/auto`.
 *
 * You pick ONE model in OpenCode's picker: `Smart Router (auto)`. This plugin:
 *   1. registers a fake provider "smartrouter" with a single model "auto",
 *   2. spawns an in-process HTTP proxy on 127.0.0.1 that the provider points at,
 *   3. stamps every proxied request with the session / agent / kind, and routes:
 *
 *        plan agent ........................ → planner model (passthrough)
 *        first build-agent request .......  → one Jev call (Typesafe System One)
 *                                             → tier composed in code → routed model
 *        later build-agent requests ......  → cached decision for the session
 *        kind = title | generate ......... → aux flash model
 *        kind = compaction ...............  → aux mid model
 *
 * Keys are read from the environment via `env:VARNAME` config indirection.
 * No key ever appears in this file or in any committed config.
 */

import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { Readable } from "node:stream"
import { Model, Plugin, Provider } from "@opencode/plugin"

/* ------------------------------------------------------------------ config */

type Ref = string // "<endpoint>/<model>" — endpoint: "openai" | "go"

const DEFAULTS = {
  planner: "openai/gpt-6-astra",
  fallbackPlanner: "go/gpt-6-luna",
  tiers: { flash: "go/glm-5.3-flash", mid: "go/gpt-6-luna", top: "openai/gpt-6-astra" },
  tierFallback: { flash: "go/longcat-2.5-free", mid: "go/gpt-5.6-luna", top: "go/qwen3.8-max" },
  aux: { title: "go/glm-5.3-flash", compaction: "go/gpt-6-luna" },
  keys: { go: "env:OPENCODE_GO_API_KEY", openai: "env:OPENAI_API_KEY" },
  typesafeKey: "env:TYPESAFE_API_KEY",
  autoSwitchAt: 0.8,
  announce: true,
  port: 0,
}

const ENDPOINTS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  go: "https://opencode.ai/inference/go/openai/v1",
}

const KEY_ENV: Record<string, string> = { openai: "OPENAI_API_KEY", go: "OPENCODE_GO_API_KEY" }

/** `env:NAME` → process.env lookup; literal passes through. */
function resolve(value: unknown, env = process.env): string | null {
  if (typeof value === "string" && value.startsWith("env:")) return (env[value.slice(4)] as string) ?? null
  return typeof value === "string" && value.length > 0 ? value : null
}

/** "openai/gpt-6-astra" → { endpoint: "openai", model: "gpt-6-astra" } */
function parseRef(ref: Ref) {
  const [endpoint, ...rest] = ref.split("/")
  return { endpoint, model: rest.join("/") }
}

function loadConfig(directory: string) {
  let file: any = {}
  const p = path.join(directory, ".opencode", "smartrouter.json")
  try {
    if (fs.existsSync(p)) file = JSON.parse(fs.readFileSync(p, "utf8"))
  } catch (e) {
    console.error("[smartrouter] failed to read", p, "— using defaults:", String(e))
  }
  delete file["//"]
  return {
    ...DEFAULTS,
    ...file,
    tiers: { ...DEFAULTS.tiers, ...(file.tiers ?? {}) },
    tierFallback: { ...DEFAULTS.tierFallback, ...(file.tierFallback ?? {}) },
    aux: { ...DEFAULTS.aux, ...(file.aux ?? {}) },
    keys: { ...DEFAULTS.keys, ...(file.keys ?? {}) },
  }
}

/* ------------------------------------------------- Jev (System One) tiering */

const QUESTIONS = {
  tier: {
    type: "choice",
    instructions: "Which execution model tier is the cheapest SUFFICIENT for this plan",
    criteria: {
      flash: "Trivial or mechanical change: single file, no schema/config, no auth/money paths",
      mid: "Standard feature work: several files with ordinary judgment, contained blast radius",
      top: "Architectural, cross-system, or risky: schemas, infra, security, many modules, open-ended unknowns",
    },
  },
  complexity: {
    type: "score",
    instructions: "How much engineering judgment does this plan require (not how much typing)",
    criteria: ["mechanical, the change is obvious", "ordinary feature judgment", "needs senior judgment: tradeoffs or unknowns"],
  },
  blast_radius: {
    type: "score",
    instructions: "How wide is the area the change touches",
    criteria: ["one or two files", "a handful of files in one area", "many modules, schema, or deployment config"],
  },
  novelty: {
    type: "score",
    instructions: "How much is this a repeat pattern vs new",
    criteria: ["done a hundred times in this codebase", "some parts are new here", "mostly new design work"],
  },
  touches_infra: { type: "noul", instructions: "The plan touches infra, schema, deployments, or background jobs" },
  touches_security: { type: "noul", instructions: "The plan touches auth, secrets, payments, or personal data" },
}

async function classify(state: string, typesafeKey: string) {
  const res = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { Authorization: `Bearer ${typesafeKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "jev-latest", state, questions: QUESTIONS }),
    // keep the router tax tiny; a timeout here must never wedge the session
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`typesafe ${res.status} ${await res.text().catch(() => "")}`.slice(0, 200))
  return res.json()
}

/** Pure code: typed answers → tier. Hard overrides + weighted score + confidence. */
function compose(a: any, policy: { autoSwitchAt: number }) {
  const norm = (s: number, levels: number) => s / Math.max(1, levels - 1)
  const weighted =
    0.35 * norm(a?.complexity?.score ?? 0, 3) +
    0.35 * norm(a?.blast_radius?.score ?? 0, 3) +
    0.3 * norm(a?.novelty?.score ?? 0, 3)

  let tier: "flash" | "mid" | "top" = weighted < 0.34 ? "flash" : weighted < 0.72 ? "mid" : "top"

  const guardedBy: string[] = []
  const noul = (k: string) => (a?.[k]?.noul ?? 0) as number
  for (const [flag, label] of [
    ["touches_infra", "infra → ≥ mid"],
    ["touches_security", "security → ≥ mid"],
  ] as const) {
    if (noul(flag) > 0.65 && tier === "flash") {
      tier = "mid"
      guardedBy.push(label)
    }
    if (noul(flag) > 0.85 && tier !== "top") {
      tier = "top"
      guardedBy.push(label.replace("≥", "→"))
    }
  }

  const confidences = [a?.tier?.confidence, a?.complexity?.confidence, a?.blast_radius?.confidence, a?.novelty?.confidence].filter(
    (c): c is number => typeof c === "number",
  )
  const confidence = confidences.length ? confidences.reduce((s, c) => s + c, 0) / confidences.length : 0
  return { tier, confidence, weighted, guardedBy, autoSwitch: confidence >= policy.autoSwitchAt }
}

/* ------------------------------------------------------------ plan digest */

/** Distill the finished plan (last assistant message ± last user message) from an OpenAI-format body. */
function digest(body: any) {
  const text = (c: any): string =>
    typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p?.text ?? p?.content ?? "").join(" ") : ""
  const msgs = Array.isArray(body?.messages) ? body.messages : []
  let lastUser = "", lastAssistant = ""
  for (const m of msgs) {
    if (m?.role === "user") lastUser = text(m.content)
    if (m?.role === "assistant") lastAssistant = text(m.content)
  }
  const plan = (lastAssistant || lastUser).slice(-4000)
  return `Plan digest:\n${plan}`
}

/* ------------------------------------------------------------------ plugin */

export default Plugin.define({
  id: "smartrouter",
  setup: async (ctx: any) => {
  const log = (...a: unknown[]) => console.log("[smartrouter]", ...a)
  const directory: string = ctx?.location?.directory ?? ctx?.directory ?? process.cwd()
  const cfg = loadConfig(directory)
  const keys = {
    go: resolve(cfg.keys.go),
    openai: resolve(cfg.keys.openai),
    typesafe: resolve(cfg.typesafeKey),
  }

  /** sessionID → routed decision */
  const decisions = new Map<string, { tier: string; model: Ref; confidence: number; autoSwitch: boolean; guardedBy: string[] }>()
  const warned = new Set<string>()
  const warnOnce = (id: string, msg: string) => {
    if (!warned.has(id)) {
      warned.add(id)
      log(msg)
    }
  }

  const plannerRef = () => (keys.openai ? cfg.planner : cfg.fallbackPlanner)

  /** tier → ref, honoring endpoint-key availability via tierFallback */
  function tierRef(tier: "flash" | "mid" | "top"): Ref {
    for (const ref of [cfg.tiers[tier], cfg.tierFallback[tier]]) {
      const { endpoint } = parseRef(ref)
      if (keys[endpoint as keyof typeof keys]) return ref
    }
    warnOnce("tierkey", `no key available for tier "${tier}" — falling back to planner target`)
    return plannerRef()
  }

  async function announce(sessionID: string, d: { tier: string; model: Ref; confidence: number; autoSwitch: boolean; guardedBy: string[] }) {
    if (!cfg.announce) return
    const text =
      `🧠 Smart Router → ${d.tier.toUpperCase()} · ${d.model} (confidence ${d.confidence.toFixed(2)})` +
      (d.autoSwitch ? " — auto-switched for this session" : " — low confidence: say “re-route” or “use a stronger model” to override") +
      (d.guardedBy.length ? ` · overrides: ${d.guardedBy.join(", ")}` : "")
    try {
      await ctx.session.synthetic({ sessionID, text })
    } catch {
      try {
        await ctx.session.synthetic(sessionID, text)
      } catch {
        /* silent — announcements are cosmetic */
      }
    }
  }

  /** One Jev call on the first build-agent request of a session; result cached. */
  async function decideBuild(sessionID: string, body: any) {
    if (!keys.typesafe) {
      warnOnce("jev", "no TYPESAFE_API_KEY — Jev routing disabled; build traffic passes through to the planner target")
      return null
    }
    const t0 = Date.now()
    try {
      const resp = await classify(digest(body), keys.typesafe)
      const d = compose(resp.answers, { autoSwitchAt: cfg.autoSwitchAt })
      const decision = {
        tier: d.tier,
        model: tierRef(d.tier),
        confidence: d.confidence,
        autoSwitch: d.autoSwitch,
        guardedBy: d.guardedBy,
      }
      if (sessionID) {
        decisions.set(sessionID, decision)
        try {
          await ctx?.storage?.set?.(`smartrouter/decision/${sessionID}`, decision)
        } catch {}
      }
      if (sessionID) await announce(sessionID, decision)
      log(
        `session=${sessionID?.slice(0, 8) ?? "?"} tier=${d.tier} → ${decision.model} conf=${d.confidence.toFixed(2)} ` +
          `${d.autoSwitch ? "auto" : "low-conf"} ${(Date.now() - t0).toFixed(0)}ms`,
      )
      return decision
    } catch (e) {
      log("Jev classify failed — build passes through to planner target:", String((e as Error)?.message ?? e))
      return null
    }
  }

  /** Per-request routing decision. Unstamped requests (hook unavailable) → planner passthrough. */
  async function routeFor(sessionID: string | null, kind: string | null, agent: string | null, body: any) {
    if (!kind && !agent) return { ref: plannerRef(), phase: "unstamped" }
    if (kind === "title" || kind === "generate") return { ref: cfg.aux.title, phase: "aux" }
    if (kind === "compaction") return { ref: cfg.aux.compaction, phase: "aux" }
    if (agent === "plan") return { ref: plannerRef(), phase: keys.openai ? "plan" : "plan-fallback" }
    // build agent
    const cached = sessionID ? decisions.get(sessionID) : undefined
    if (cached) return { ref: cached.model, phase: "build-cached" }
    const d = await decideBuild(sessionID ?? "", body)
    if (d) return { ref: d.model, phase: "build-routed" }
    return { ref: plannerRef(), phase: "build-passthrough" }
  }

  /* --------------------------------------------- in-process routing proxy */

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1")
      const suffix = url.pathname.replace(/^\/v1\//, "").replace(/^\//, "")

      if (req.method === "GET" && /(^|\/)models?$/.test(suffix)) {
        const payload = { object: "list", data: [{ id: "auto", object: "model", owned_by: "smart-router" }] }
        res.writeHead(200, { "content-type": "application/json" })
        return res.end(JSON.stringify(payload))
      }

      if (req.method !== "POST") {
        res.writeHead(404, { "content-type": "application/json" })
        return res.end(JSON.stringify({ error: { message: `Smart Router: unsupported ${req.method} ${url.pathname}`, type: "smartrouter_unsupported" } }))
      }

      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const raw = Buffer.concat(chunks)
      const sid = req.headers["x-sr-session"]?.toString() ?? null
      const agent = req.headers["x-sr-agent"]?.toString() ?? null
      const kind = req.headers["x-sr-kind"]?.toString() ?? null

      let body: any = null
      try {
        body = raw.length ? JSON.parse(raw.toString()) : null
      } catch {}

      const { ref, phase } = await routeFor(sid, kind, agent, body)
      const { endpoint, model } = parseRef(ref)
      const base = ENDPOINTS[endpoint]
      const key = keys[endpoint as keyof typeof keys]

      if (!base || !key) {
        const msg = `Smart Router: no reachable backend for "${ref}" — set ${base ? "" : "the endpoint for "}${base ? KEY_ENV[endpoint] ?? endpoint : endpoint} in the OpenCode environment`
        log(msg)
        res.writeHead(503, { "content-type": "application/json" })
        return res.end(JSON.stringify({ error: { message: msg, type: "smartrouter_config" } }))
      }

      let payload = raw.toString()
      try {
        const j = body ?? {}
        j.model = model
        payload = JSON.stringify(j)
      } catch {}

      const t0 = Date.now()
      const upstream = await fetch(`${base}/${suffix}`, {
        method: "POST",
        headers: {
          "content-type": req.headers["content-type"] ?? "application/json",
          authorization: `Bearer ${key}`,
          accept: req.headers["accept"] ?? "application/json",
          "accept-encoding": "identity", // stream raw; avoid double-decoding SSE
          "user-agent": "smartrouter/0.1",
          ...(sid ? { "x-opencode-session": sid } : {}),
        },
        body: payload,
      })

      log(`${phase} ${sid?.slice(0, 8) ?? "?"} → ${ref} ${upstream.status} ${(Date.now() - t0).toFixed(0)}ms`)

      const headers: Record<string, string> = {}
      upstream.headers.forEach((v, k) => {
        headers[k] = v
      })
      delete headers["content-encoding"] // fetch streams decoded bytes
      delete headers["transfer-encoding"]
      res.writeHead(upstream.status, headers)
      if (upstream.body) return Readable.fromWeb(upstream.body as any).pipe(res)
      res.end()
    } catch (e) {
      log("proxy error:", String((e as Error)?.message ?? e))
      try {
        res.writeHead(502, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: { message: `Smart Router proxy error: ${String((e as Error)?.message ?? e)}`, type: "smartrouter_proxy" } }))
      } catch {
        /* headers already sent mid-stream */
      }
    }
  })

  const port: number = await new Promise((resolvePort, reject) => {
    server.once("error", reject)
    server.listen(cfg.port, "127.0.0.1", () => resolvePort((server.address() as { port: number }).port))
  })

  /* ------------------------------------- fake provider: smartrouter/auto */

  const providerID = Provider.ID.make("smartrouter")
  await ctx.provider.transform((editor: any) => {
    editor.add({
      info: {
        ...Provider.Info.empty(providerID),
        name: "Smart Router",
        activation: "enabled",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${port}/v1` },
      },
      models: [
        {
          ...Model.Info.default(providerID, Model.ID.make("auto")),
          name: "Smart Router (auto)",
        },
      ],
    })
  })

  /* ---------------------------------- per-request context via http hook */

  try {
    await ctx.session.hook(
      "http.request",
      (event: any) => {
        try {
          if (event?.sessionID) event.request.headers.set("x-sr-session", event.sessionID)
          if (event?.kind) event.request.headers.set("x-sr-kind", event.kind)
          if (event?.agent) event.request.headers.set("x-sr-agent", event.agent)
        } catch {}
      },
      { providerID },
    )
  } catch (e) {
    log("warning: could not register http.request hook — all traffic passes through to the planner target:", String((e as Error)?.message ?? e))
  }

  log(
    `up — smartrouter/auto → http://127.0.0.1:${port}/v1 · planner=${cfg.planner} · ` +
      `go key=${keys.go ? "✓" : "✗"} openai key=${keys.openai ? "✓" : "✗"} typesafe key=${keys.typesafe ? "✓" : "✗"}`,
  )

  return () => server.close()
  },
})
