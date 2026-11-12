import { BUILD_MODELS, classifyBuild, formatDecision } from "./jev.ts"
import type { Candidate, Decision } from "./jev.ts"

export const NATIVE_PROVIDER = "openai"
export const NATIVE_MODEL = "smartrouter-auto"
export const NATIVE_NAME = "smartrouter - openai"
export type ModelRef = { providerID: string; id: string; variant?: string }
export type ModelInfo = ModelRef & {
  enabled?: boolean; modelID?: string
  capabilities?: { tools?: boolean }
  variants?: { id: string }[]
  cost?: { input: number; output: number; cache?: { read?: number; write?: number } }[]
  [key: string]: unknown
}
type SessionInfo = { id: string; agent?: string; parentID?: string; model?: ModelRef }
export type Message = { type?: string; agent?: string; content?: unknown; text?: string }
export type PromptEvent = { sessionID: string; prompt: { text: string } }
export type RequestEvent = { sessionID: string; agent: string; kind: string; model: ModelRef }
type Managed = {
  version: 3; lastModel: ModelRef; selectedVariant?: string
  decision?: Decision; approved?: boolean; announced?: boolean; failure?: string
}
type PermissionEvent = { action: string; effect: "allow" | "ask" | "deny" }

// Public plugin APIs only. No OAuth credential values are requested or copied.
export interface NativePlannerContext {
  model: {
    transform(callback: (editor: {
      get(providerID: string, modelID: string): ModelInfo | undefined
      update(providerID: string, modelID: string, update: (draft: Record<string, unknown>) => void): void
    }) => void): Promise<unknown>
    list(): Promise<readonly ModelInfo[] | { data: readonly ModelInfo[] }>
  }
  integration: { connection: { active(id: string): Promise<{ type: string; method?: string; status?: unknown } | undefined> } }
  session: {
    get(input: { sessionID: string }): Promise<SessionInfo | { data: SessionInfo }>
    context(input: { sessionID: string }): Promise<Message[] | { data: Message[] }>
    switchModel(input: { sessionID: string; model: ModelRef }): Promise<unknown>
    synthetic(input: { sessionID: string; text: string; description?: string; resume: false }): Promise<unknown>
    hook(name: "prompt", callback: (event: PromptEvent) => Promise<void>): Promise<unknown>
    hook(name: "model.request", callback: (event: RequestEvent) => Promise<void>): Promise<unknown>
  }
  permission: {
    hook(name: "evaluate", callback: (event: PermissionEvent) => void): Promise<unknown>
    assert(input: { sessionID: string; agent: string; action: string; resources: string[]; save: string[]; metadata: Record<string, unknown> }): Promise<void>
  }
  storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; remove(key: string): Promise<void> }
  command?: { transform(callback: (editor: { add(command: { name: string; description: string; execute(input: { sessionID: string }): Promise<void> }): void }) => void): Promise<unknown> }
}
export type NativeOptions = {
  getTypesafeKey?: () => string
  buildModels?: Record<string, string>
  autoSwitchAt?: number
  log?: (record: Record<string, unknown>) => Promise<void>
  classify?: typeof classifyBuild
}

const refOf = (ref: string): ModelRef => { const [providerID, ...rest] = ref.split("/"); return { providerID, id: rest.join("/") } }
const refText = (ref: ModelRef) => `${ref.providerID}/${ref.id}`
const alias = (ref?: ModelRef) => ref?.providerID === NATIVE_PROVIDER && ref.id === NATIVE_MODEL
const same = (a?: ModelRef, b?: ModelRef) => !!a && !!b && a.providerID === b.providerID && a.id === b.id
const stateKey = (sessionID: string) => `smartrouter/native/v3/${sessionID}`
const astra = (ref: ModelRef, models: readonly ModelInfo[]) => /astra/i.test(ref.id) || /astra/i.test(models.find((m) => same(m, ref))?.modelID ?? "")
// In-process plugin methods in 2.2.6 return domain values; HTTP clients wrap
// those values in {data}. Accept either at this boundary, never assume HTTP.
const dataOf = <T,>(value: T | { data: T }): T => value && typeof value === "object" && !Array.isArray(value) && "data" in value ? (value as { data: T }).data : value as T

function isZeroCost(model: ModelInfo) {
  return !!model.cost?.length && model.cost.every((c) => c.input === 0 && c.output === 0 && (c.cache?.read ?? 0) === 0 && (c.cache?.write ?? 0) === 0)
}

export function planDigest(messages: Message[], incoming: string) {
  const text = (value: unknown): string => typeof value === "string" ? value : Array.isArray(value) ? value.map((part) => part && typeof part === "object" && "text" in part ? String(part.text ?? "") : "").join("\n") : ""
  const assistant = messages.filter((m) => m.type === "assistant")
  const plan = assistant.filter((m) => m.agent === "plan").at(-1) ?? assistant.at(-1)
  return `Finished plan:\n${text(plan?.content).slice(-8000) || "No prior plan; classify the requested work below."}\n\nBuild request:\n${incoming.slice(-2000)}`
}

export async function setupNativePlanner(ctx: NativePlannerContext, planner = "openai/gpt-6-astra", options: NativeOptions = {}) {
  const plannerRef = refOf(planner)
  if (plannerRef.providerID !== NATIVE_PROVIDER || !plannerRef.id || plannerRef.id === NATIVE_MODEL) throw new Error("Smart Router native mode requires an OpenAI planner, such as openai/gpt-6-astra")
  const configured = options.buildModels ?? BUILD_MODELS
  const threshold = options.autoSwitchAt ?? 0.8
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error("Smart Router: autoSwitchAt must be between 0 and 1")
  for (const [key, value] of Object.entries(configured)) {
    const ref = refOf(value)
    if (/astra/i.test(value) || (ref.providerID === "openai" ? !["terra", "sol"].includes(key) || !ref.id.endsWith(`-${key}`) : ref.providerID !== "opencode" || !ref.id.endsWith("-free"))) {
      throw new Error(`Smart Router: forbidden build model "${value}". OpenAI Build allows Terra/Sol only; other builds must use OpenCode free models.`)
    }
  }
  const pending = new Map<string, Promise<void>>()
  const load = async (id: string): Promise<Managed | undefined> => {
    const value = await ctx.storage.get(stateKey(id)) as Managed | undefined
    return value?.version === 3 ? value : undefined
  }
  const save = (id: string, value: Managed) => ctx.storage.set(stateKey(id), value)
  const log = async (id: string, event: string, fields: Record<string, unknown>) => {
    try { await options.log?.({ at: new Date().toISOString(), sessionID: id, event, ...fields }) } catch {}
  }
  const oauth = async () => {
    const connection = await ctx.integration.connection.active(NATIVE_PROVIDER)
    return connection?.type === "credential" && connection.method === "oauth" && !connection.status
  }
  const requireOAuth = async () => {
    if (!await oauth()) throw new Error("Smart Router: sign in with ChatGPT under /connect → OpenAI. API-key fallback is disabled.")
  }
  const eligible = async (models: readonly ModelInfo[]): Promise<Candidate[]> => {
    const signedIn = await oauth()
    return Object.entries(configured).flatMap<Candidate>(([key, value]) => {
      const ref = refOf(value)
      const model = models.find((m) => same(m, ref))
      if (!model || model.enabled === false || !model.capabilities?.tools || astra(ref, models)) return []
      if (ref.providerID === "openai") return signedIn ? [{ key, ref: value, family: "openai" as const }] : []
      return isZeroCost(model) ? [{ key, ref: value, family: "free" as const }] : []
    })
  }

  await ctx.model.transform((editor) => {
    const source = editor.get(NATIVE_PROVIDER, plannerRef.id)
    if (!source || source.enabled === false) return
    editor.update(NATIVE_PROVIDER, NATIVE_MODEL, (draft) => {
      Object.assign(draft, source, { id: NATIVE_MODEL, modelID: source.modelID ?? plannerRef.id, name: NATIVE_NAME, cost: [] })
    })
  })
  await ctx.permission.hook("evaluate", (event) => {
    // This dedicated action is used ONLY for low-confidence routing. Even a
    // general allow rule must not silently bypass the confidence gate.
    if (event.action === "smartrouter.route" && event.effect !== "deny") event.effect = "ask"
  })

  const routePrompt = async (event: PromptEvent) => {
    const session = dataOf(await ctx.session.get({ sessionID: event.sessionID }))
    let managed = await load(event.sessionID)
    if (!alias(session.model) && (!managed || !same(session.model, managed.lastModel))) return
    if (!session.model) return
    managed ??= { version: 3, lastModel: session.model }
    if (alias(session.model)) managed.selectedVariant = session.model.variant
    if (session.agent === "plan") {
      await requireOAuth()
      const model = { providerID: NATIVE_PROVIDER, id: NATIVE_MODEL, ...(managed.selectedVariant ? { variant: managed.selectedVariant } : {}) }
      await ctx.session.switchModel({ sessionID: event.sessionID, model })
      managed.lastModel = model
      await save(event.sessionID, managed)
      return
    }
    if (managed.failure) throw new Error(`${managed.failure} Use /smartrouter-reset to retry classification. Astra will not be used for Build.`)
    const models = dataOf(await ctx.model.list())
    const candidates = await eligible(models)
    if (!managed.decision) {
      const messages = dataOf(await ctx.session.context({ sessionID: event.sessionID }))
      try {
        managed.decision = await (options.classify ?? classifyBuild)(planDigest(messages, event.prompt.text), options.getTypesafeKey?.() ?? "", candidates)
        await save(event.sessionID, managed)
        await log(event.sessionID, "jev.decision", { ...managed.decision, status: managed.decision.confidence >= threshold ? "ready" : "needs-confirmation" })
      } catch (error) {
        const message = error instanceof Error && /^(Smart Router:|Invalid Jev|Risk guard|Jev did not)/.test(error.message) ? error.message : "Smart Router: Jev classification failed. Build stopped; no Astra fallback."
        managed.failure = message
        await save(event.sessionID, managed)
        await log(event.sessionID, "jev.failed", { message })
        throw new Error(`${message} Use /smartrouter-reset to retry.`)
      }
    }
    const decision = managed.decision
    if (!candidates.some((candidate) => candidate.ref === decision.model) || /astra/i.test(decision.model)) throw new Error("Smart Router: the chosen build model is no longer eligible. Build stopped; no Astra or paid-API fallback.")
    if (decision.confidence < threshold && !managed.approved) {
      await ctx.permission.assert({ sessionID: event.sessionID, agent: session.agent ?? "build", action: "smartrouter.route", resources: [decision.model], save: [], metadata: {
        confidence: decision.confidence, reason: decision.reason,
        familyDecision: decision.answers.family,
        ...(decision.answers.openai_model ? { openaiDecision: decision.answers.openai_model } : {}),
        ...(decision.answers.free_model ? { freeDecision: decision.answers.free_model } : {}),
        summary: formatDecision(decision, threshold),
      } })
      managed.approved = true
      await save(event.sessionID, managed)
      await log(event.sessionID, "jev.confirmed", { model: decision.model, confidence: decision.confidence })
    }
    const target = refOf(decision.model)
    const targetInfo = models.find((model) => same(model, target))!
    if (managed.selectedVariant && targetInfo.variants?.some((v) => v.id === managed.selectedVariant)) target.variant = managed.selectedVariant
    // Prompt admission happens before native model resolution. Switching here
    // preserves each target provider's driver/auth and updates the real picker.
    await ctx.session.switchModel({ sessionID: event.sessionID, model: target })
    managed.lastModel = target
    await save(event.sessionID, managed)
    if (!managed.announced) {
      await ctx.session.synthetic({ sessionID: event.sessionID, resume: false, description: "Smart Router · Jev decision", text: formatDecision(decision, threshold, managed.approved) })
      managed.announced = true
      await save(event.sessionID, managed)
    }
  }
  await ctx.session.hook("prompt", async (event) => {
    // Serialize prompt retries/concurrent admissions: one Jev call per session.
    const previous = pending.get(event.sessionID) ?? Promise.resolve()
    const running = previous.catch(() => {}).then(() => routePrompt(event))
    pending.set(event.sessionID, running)
    try { await running } finally { if (pending.get(event.sessionID) === running) pending.delete(event.sessionID) }
  })

  await ctx.session.hook("model.request", async (event) => {
    const managed = await load(event.sessionID)
    const session = dataOf(await ctx.session.get({ sessionID: event.sessionID }))
    // Some runtimes report the wire model ID here, not the picker alias.
    // Scope by the session selection as well, so an alias cannot skip guards.
    if (!alias(event.model) && !alias(session.model) && (!managed || !same(session.model, managed.lastModel))) return
    const models = dataOf(await ctx.model.list())
    const phase = event.agent || session.agent || "build"
    if (phase !== "plan" && (astra(event.model, models) || alias(session.model))) {
      throw new Error("Smart Router: blocked Astra outside Plan. Submit your Build instruction again so Jev can route it before dispatch.")
    }
    if (alias(event.model) || alias(session.model)) {
      await requireOAuth()
      if (!models.some((model) => same(model, plannerRef) && model.enabled !== false)) throw new Error(`Smart Router: ${planner} is unavailable. No API or Go fallback was attempted.`)
    } else {
      const candidates = await eligible(models)
      const selected = models.find((m) => same(m, session.model))
      const actualMatches = same(event.model, session.model) || (event.model.providerID === session.model?.providerID && event.model.id === selected?.modelID)
      if (!managed?.decision || !session.model || !actualMatches || !candidates.some((c) => c.ref === refText(session.model!)) || (managed.decision.confidence < threshold && !managed.approved)) {
        throw new Error("Smart Router: no eligible approved build decision. Dispatch blocked; no Astra fallback.")
      }
    }
    await log(event.sessionID, "native.dispatch", { model: alias(session.model) ? planner : refText(session.model!), agent: phase, kind: event.kind, cached: !!managed?.decision })
  })

  await ctx.command?.transform((editor) => {
    editor.add({ name: "smartrouter-status", description: "Show the cached Jev decision and actual build model", async execute({ sessionID }) {
      const managed = await load(sessionID)
      const text = managed?.decision ? formatDecision(managed.decision, threshold, managed.approved) : managed?.failure ?? "No Jev decision yet. Jev runs on the first Build instruction after selecting Smart Router."
      await ctx.session.synthetic({ sessionID, text, description: "Smart Router status", resume: false })
    } })
    editor.add({ name: "smartrouter-reset", description: "Clear this session's routing decision; classify again on the next Build prompt", async execute({ sessionID }) {
      await ctx.storage.remove(stateKey(sessionID))
      await ctx.session.switchModel({ sessionID, model: { providerID: NATIVE_PROVIDER, id: NATIVE_MODEL } })
      await ctx.session.synthetic({ sessionID, text: "Smart Router decision reset. Your next Build instruction will run Jev again. Astra remains Plan-only.", description: "Smart Router reset", resume: false })
    } })
  })
}
