import assert from "node:assert/strict"
import { test } from "node:test"
import { setupNativePlanner, NATIVE_MODEL, planDigest } from "../plugin/smartrouter/native-planner.ts"
import type { ModelInfo, ModelRef, NativeOptions, NativePlannerContext } from "../plugin/smartrouter/native-planner.ts"
import { BUILD_MODELS, classifyBuild, composeDecision } from "../plugin/smartrouter/jev.ts"

const answer = (family = "openai", model = "terra", confidence = 0.95) => ({
  family: { choice: family, confidence }, free_model: { choice: family === "free" ? model : "glm", confidence },
  openai_model: { choice: family === "openai" ? model : "terra", confidence },
  touches_infra: { noul: 0.01 }, touches_security: { noul: 0.01 },
})

function fixture() {
  const model = (providerID: string, id: string): ModelInfo => ({ providerID, id, modelID: id, enabled: true,
    package: providerID === "openai" ? "@opencode/ai/providers/openai/responses" : "@opencode/ai/providers/openai-compatible",
    capabilities: { tools: true }, variants: providerID === "openai" ? [{ id: "high" }] : [],
    cost: [{ input: providerID === "openai" ? 10 : 0, output: providerID === "openai" ? 50 : 0 }],
  })
  const models = [model("openai", "gpt-6-astra"), ...Object.values(BUILD_MODELS).map((ref) => { const [provider, id] = ref.split("/"); return model(provider, id) })]
  const session = { id: "test-session", agent: "plan", model: { providerID: "openai", id: NATIVE_MODEL, variant: "high" } as ModelRef }
  const source = models[0]
  const storage = new Map<string, any>()
  const logs: any[] = [], announcements: any[] = [], switches: ModelRef[] = []
  const hooks: Record<string, (event: any) => any> = {}, commands: Record<string, any> = {}
  let connection: any = { type: "credential", method: "oauth" }
  let answers = answer(), calls = 0, approvals = 0, denied = false, classifyError: Error | undefined
  const ctx: NativePlannerContext = {
    model: {
      async transform(callback) { callback({ get: (provider, id) => models.find((m) => m.providerID === provider && m.id === id), update(provider, id, update) {
        const draft: any = {}; update(draft)
        const prior = models.findIndex((m) => m.providerID === provider && m.id === id)
        if (prior >= 0) models.splice(prior, 1)
        models.push(draft)
      } }) },
      async list() { return models },
    },
    integration: { connection: { async active(id) { assert.equal(id, "openai"); return connection } } },
    session: {
      async get() { return session },
      async context() { return [{ type: "assistant", agent: "plan", content: [{ type: "text", text: "Finished plan: change two UI files and add tests." }] }] },
      async switchModel({ model }) { switches.push(model); session.model = model },
      async synthetic(input) { assert.equal(input.resume, false); announcements.push(input) },
      async hook(name: string, callback: any) { hooks[name] = callback },
    },
    permission: {
      async hook(name, callback) { hooks[`permission.${name}`] = callback },
      async assert(input) {
        approvals++
        const event = { action: input.action, effect: "allow" }
        hooks["permission.evaluate"](event)
        assert.equal(event.effect, "ask")
        if (denied) throw new Error("user denied")
      },
    },
    storage: { async get(key) { return storage.get(key) }, async set(key, value) { storage.set(key, structuredClone(value)) }, async remove(key) { storage.delete(key) } },
    command: { async transform(callback) { callback({ add(command) { commands[command.name] = command } }) } },
  }
  const options: NativeOptions = {
    getTypesafeKey: () => "fake-test-key",
    async classify(state, key, candidates) {
      calls++; assert.match(state, /Finished plan/); assert.equal(key, "fake-test-key")
      if (classifyError) throw classifyError
      return { ...composeDecision(answers, candidates), jevModel: "jev-test", latencyMs: 5 }
    },
    async log(record) { logs.push(record) },
  }
  return {
    ctx, options, models, source, session, storage, logs, announcements, switches, commands,
    answers(value: typeof answers) { answers = value }, connection(value: any) { connection = value },
    deny() { denied = true }, fail(error: Error) { classifyError = error }, calls: () => calls, approvals: () => approvals,
    async setup(overrides: NativeOptions = {}) { await setupNativePlanner(ctx, undefined, { ...options, ...overrides }) },
    async prompt(agent = "build", text = "Implement the finished plan") { session.agent = agent; await hooks.prompt({ sessionID: session.id, prompt: { text } }) },
    async dispatch(agent = session.agent, model = session.model, kind = "primary") { await hooks["model.request"]({ sessionID: session.id, agent, model, kind }) },
    async command(name: string) { await commands[name].execute({ sessionID: session.id }) },
  }
}

test("Plan alias inherits Astra driver/capabilities/variants without mutating Astra", async () => {
  const f = fixture(); await f.setup()
  assert.deepEqual(f.models.find((m) => m.id === NATIVE_MODEL), { ...f.source, id: NATIVE_MODEL, name: "Smart Router (auto)", cost: [] })
  assert.deepEqual(f.source.cost, [{ input: 10, output: 50 }])
  await f.prompt("plan"); await f.dispatch()
  assert.equal(f.calls(), 0)
  assert.equal(f.session.model.id, NATIVE_MODEL)
})

for (const [family, key] of [["openai", "terra"], ["openai", "sol"], ["free", "glm"], ["free", "longcat"], ["free", "deepseek"]]) {
  test(`Build routes ${family}/${key} with a visible announcement and no Astra`, async () => {
    const f = fixture(); f.answers(answer(family, key)); await f.setup(); await f.prompt("plan"); await f.prompt()
    const expected = BUILD_MODELS[key as keyof typeof BUILD_MODELS]
    assert.equal(`${f.session.model.providerID}/${f.session.model.id}`, expected)
    await f.dispatch()
    assert.equal(f.calls(), 1)
    assert.equal(f.announcements.length, 1)
    assert.match(f.announcements[0].text, new RegExp(expected))
    assert.match(f.announcements[0].text, /confidence 0.95/)
    assert.equal(f.logs.filter((l) => l.event === "jev.decision").length, 1)
    assert.ok(f.logs.every((l) => !JSON.stringify(l).includes("fake-test-key")))
  })
}

test("preserves high reasoning only for a target that supports it", async () => {
  const openai = fixture(); await openai.setup(); await openai.prompt(); assert.equal(openai.session.model.variant, "high")
  const free = fixture(); free.answers(answer("free", "glm")); await free.setup(); await free.prompt(); assert.equal(free.session.model.variant, undefined)
})

test("subsequent build prompts and tool continuations reuse one durable decision", async () => {
  const f = fixture(); await f.setup(); await f.prompt(); await f.dispatch(); await f.prompt(); await f.dispatch()
  assert.equal(f.calls(), 1); assert.equal(f.announcements.length, 1)
  await f.setup(); await f.prompt(); await f.dispatch()
  assert.equal(f.calls(), 1); assert.equal(f.announcements.length, 1)
})

test("concurrent prompt admissions classify once", async () => {
  const f = fixture(); await f.setup(); await Promise.all([f.prompt(), f.prompt()]); assert.equal(f.calls(), 1)
})

test("returning to Plan restores Astra alias and high reasoning; returning to Build reuses Jev", async () => {
  const f = fixture(); f.answers(answer("free", "glm")); await f.setup(); await f.prompt(); await f.prompt("plan")
  assert.equal(f.session.model.id, NATIVE_MODEL); assert.equal(f.session.model.variant, "high")
  await f.dispatch(); await f.prompt("build"); assert.equal(f.calls(), 1); assert.equal(f.session.model.id, "glm-5.3-flash-free")
})

test("low confidence prompts for approval before switching or dispatching", async () => {
  const f = fixture(); f.answers(answer("openai", "terra", 0.6)); await f.setup(); await f.prompt()
  assert.equal(f.approvals(), 1); await f.dispatch(); await f.prompt(); assert.equal(f.approvals(), 1); assert.equal(f.calls(), 1)
})

test("denied confidence approval never switches to a build model", async () => {
  const f = fixture(); f.answers(answer("openai", "terra", 0.6)); f.deny(); await f.setup()
  await assert.rejects(() => f.prompt(), /user denied/)
  assert.equal(f.session.model.id, NATIVE_MODEL)
  await assert.rejects(() => f.dispatch("build"), /blocked Astra outside Plan/)
  assert.equal(f.announcements.length, 0)
})

for (const kind of ["primary", "title", "compaction", "generate"]) {
  test(`stale/unrouted Astra request is blocked in Build (${kind})`, async () => {
    const f = fixture(); await f.setup()
    await assert.rejects(() => f.dispatch("build", f.session.model, kind), /blocked Astra outside Plan/)
    assert.equal(f.calls(), 0)
  })
}

for (const connection of [undefined, { type: "env" }, { type: "credential", method: "key" }, { type: "credential", method: "oauth", status: { status: "needs_auth" } }]) {
  test(`Plan refuses non-OAuth/unhealthy connections: ${JSON.stringify(connection)}`, async () => {
    const f = fixture(); f.connection(connection); await f.setup(); await assert.rejects(() => f.prompt("plan"), /API-key fallback is disabled/)
  })
}

test("an OpenAI account switch to an API key blocks a cached OpenAI build", async () => {
  const f = fixture(); await f.setup(); await f.prompt(); f.connection({ type: "credential", method: "key" })
  await assert.rejects(() => f.dispatch(), /no eligible approved build decision/)
})

test("a keyless free build remains eligible without OpenAI OAuth", async () => {
  const f = fixture(); f.connection(undefined); f.answers(answer("free", "glm")); await f.setup(); await f.prompt(); await f.dispatch()
  assert.equal(f.session.model.id, "glm-5.3-flash-free")
})

test("free models with nonzero costs are not eligible", async () => {
  const f = fixture(); await f.setup()
  for (const model of f.models.filter((m) => m.providerID === "opencode")) model.cost = [{ input: 1, output: 0 }]
  f.answers(answer("free", "glm"))
  await assert.rejects(() => f.prompt(), /Invalid Jev family/)
  assert.equal(f.session.model.id, NATIVE_MODEL)
})

test("models without tool support never appear in Jev's candidate set", async () => {
  const f = fixture(); await f.setup()
  f.models.find((m) => m.id === "glm-5.3-flash-free")!.capabilities = { tools: false }
  f.answers(answer("free", "glm"))
  await assert.rejects(() => f.prompt(), /Invalid Jev free_model/)
})

test("unavailable chosen model stops rather than reclassifying or falling back", async () => {
  const f = fixture(); await f.setup(); await f.prompt()
  f.models.find((m) => m.id === "gpt-6.1-terra")!.enabled = false
  await assert.rejects(() => f.prompt(), /no longer eligible/); assert.equal(f.calls(), 1)
})

test("classifier failure is cached, never falls back, and reset explicitly retries", async () => {
  const f = fixture(); f.fail(new Error("untrusted upstream body fake-test-key")); await f.setup()
  await assert.rejects(() => f.prompt(), /Jev classification failed/)
  await assert.rejects(() => f.prompt(), /smartrouter-reset/)
  assert.equal(f.calls(), 1); assert.equal(f.session.model.id, NATIVE_MODEL)
  assert.ok(!JSON.stringify(f.logs).includes("fake-test-key"))
  await f.command("smartrouter-reset")
  await assert.rejects(() => f.prompt(), /Jev classification failed/); assert.equal(f.calls(), 2)
})

test("missing Jev key is an actionable error and sends no model request", async () => {
  const f = fixture(); await f.setup({ getTypesafeKey: () => "", classify: classifyBuild })
  await assert.rejects(() => f.prompt(), /TYPESAFE_API_KEY is missing/)
  await assert.rejects(() => f.dispatch("build"), /blocked Astra/)
})

test("status command exposes the actual cached decision", async () => {
  const f = fixture(); await f.setup(); await f.prompt(); await f.command("smartrouter-status")
  assert.match(f.announcements.at(-1).text, /gpt-6.1-terra/)
})

test("ordinary selections are left alone; explicit manual model changes are respected", async () => {
  const f = fixture(); await f.setup(); f.session.model = { providerID: "openai", id: "gpt-6.1-sol" }
  await f.prompt(); await f.dispatch(); assert.equal(f.calls(), 0)
  f.session.model = { providerID: "openai", id: NATIVE_MODEL }; await f.prompt(); assert.equal(f.calls(), 1)
  f.session.model = { providerID: "another", id: "manual" }; await f.prompt(); await f.dispatch(); assert.equal(f.calls(), 1)
})

test("forbidden Astra build configuration and recursive planners are rejected", async () => {
  const f = fixture()
  await assert.rejects(() => f.setup({ buildModels: { sol: "openai/gpt-6-astra" } }), /forbidden build model/)
  await assert.rejects(() => setupNativePlanner(f.ctx, "openai/smartrouter-auto"), /requires an OpenAI planner/)
  await assert.rejects(() => f.setup({ autoSwitchAt: NaN }), /autoSwitchAt/)
})

test("digest prefers the finished Plan over later Build chatter and preserves the instruction", () => {
  const digest = planDigest([{ type: "assistant", agent: "plan", content: "Actual finished plan" }, { type: "assistant", agent: "build", content: "Unrelated progress" }], "Implement now")
  assert.match(digest, /Actual finished plan/); assert.match(digest, /Implement now/); assert.doesNotMatch(digest, /Unrelated progress/)
})

test("also accepts HTTP-style envelopes at the plugin/client boundary", async () => {
  const f = fixture()
  const list = f.ctx.model.list, get = f.ctx.session.get, context = f.ctx.session.context
  f.ctx.model.list = async () => ({ data: await list() as ModelInfo[] })
  f.ctx.session.get = async (input) => ({ data: await get(input) as any })
  f.ctx.session.context = async (input) => ({ data: await context(input) as any })
  await f.setup(); await f.prompt("plan"); await f.prompt(); await f.dispatch()
  assert.equal(f.session.model.id, "gpt-6.1-terra")
})

test("wire model ID instead of alias cannot bypass the Plan-only guard", async () => {
  const f = fixture(); await f.setup()
  await assert.rejects(() => f.dispatch("build", { providerID: "openai", id: "gpt-6-astra" }), /blocked Astra outside Plan/)
})
