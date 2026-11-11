import assert from "node:assert/strict"
import { test } from "node:test"
import { setupNativePlanner, NATIVE_MODEL } from "../plugin/smartrouter/native-planner.ts"
import type { NativePlannerContext } from "../plugin/smartrouter/native-planner.ts"

function fixture() {
  const source = {
    providerID: "openai", id: "gpt-6-astra", modelID: "gpt-6-astra", enabled: true,
    name: "GPT-6 Astra", package: "@opencode/ai/providers/openai/responses",
    capabilities: { tools: true }, limit: { context: 272000, output: 128000 }, cost: [{ input: 10, output: 50 }],
    variants: [{ id: "high", settings: { reasoningEffort: "high" } }],
  }
  const alias: Record<string, unknown> = {}
  const receipts = new Map<string, unknown>()
  let connection: { type: string; method?: string; status?: unknown } | undefined = { type: "credential", method: "oauth" }
  let available = true
  let hook: Parameters<NativePlannerContext["session"]["hook"]>[1]
  let activeReads = 0
  const ctx: NativePlannerContext = {
    model: {
      async transform(callback) {
        callback({
          get: () => available ? source : undefined,
          update(providerID, modelID, update) {
            assert.equal(providerID, "openai")
            assert.equal(modelID, NATIVE_MODEL)
            update(alias)
          },
        })
      },
      async list() { return { data: available ? [source] : [] } },
    },
    integration: { connection: { async active(id) { assert.equal(id, "openai"); activeReads++; return connection } } },
    session: {
      async hook(name, callback, options) {
        assert.equal(name, "model.request")
        assert.deepEqual(options, { providerID: "openai" })
        hook = callback
      },
    },
    storage: { async set(key, value) { receipts.set(key, value) } },
  }
  return {
    ctx, source, alias, receipts,
    setConnection(value: typeof connection) { connection = value },
    unavailable() { available = false },
    activeReads: () => activeReads,
    async dispatch(agent = "plan", kind = "primary", model = { providerID: "openai", id: NATIVE_MODEL } as { providerID: string; id: string; variant?: string }) {
      const event = { sessionID: "test-session", agent, kind, model }
      await hook(event)
      return event
    },
  }
}

test("alias inherits Astra's native driver/capabilities/limits/variants, with subscription pricing", async () => {
  const f = fixture()
  await setupNativePlanner(f.ctx)
  assert.deepEqual(f.alias, { ...f.source, id: NATIVE_MODEL, name: "Smart Router (auto)", cost: [] })
  assert.deepEqual(f.source.cost, [{ input: 10, output: 50 }])
  assert.equal(f.source.id, "gpt-6-astra")
})

for (const [agent, kind] of [["plan", "primary"], ["build", "primary"], ["plan", "title"], ["build", "compaction"], ["build", "generate"]]) {
  test(`${agent}/${kind} resolves to native Astra, without Jev or Go`, async () => {
    const f = fixture()
    await setupNativePlanner(f.ctx)
    const event = await f.dispatch(agent, kind)
    assert.deepEqual(event.model, { providerID: "openai", id: NATIVE_MODEL })
    assert.equal(f.alias.modelID, "gpt-6-astra")
    assert.deepEqual(f.receipts.get("smartrouter/native/test-session"), {
      selected: "openai/smartrouter-auto", resolved: "openai/gpt-6-astra",
      agent, kind, authentication: "opencode-oauth", jev: "not-invoked",
    })
  })
}

test("keeps the selected reasoning variant", async () => {
  const f = fixture()
  await setupNativePlanner(f.ctx)
  const event = await f.dispatch("plan", "primary", { providerID: "openai", id: NATIVE_MODEL, variant: "high" })
  assert.equal(event.model.variant, "high")
})

test("leaves ordinary model selections and other providers alone", async () => {
  const f = fixture()
  await setupNativePlanner(f.ctx)
  for (const model of [{ providerID: "openai", id: "gpt-6-astra" }, { providerID: "another", id: NATIVE_MODEL }]) {
    assert.deepEqual((await f.dispatch("plan", "primary", model)).model, model)
  }
  assert.equal(f.activeReads(), 0)
  assert.equal(f.receipts.size, 0)
})

for (const connection of [undefined, { type: "env" }, { type: "credential", method: "key" }, { type: "credential", method: "external" }, { type: "credential", method: "oauth", status: { status: "needs_auth" } }]) {
  test(`rejects missing/non-OAuth/unhealthy connection: ${JSON.stringify(connection)}`, async () => {
    const f = fixture()
    f.setConnection(connection)
    await setupNativePlanner(f.ctx)
    await assert.rejects(() => f.dispatch(), /API-key fallback is disabled/)
    assert.equal(f.receipts.size, 0)
  })
}

test("checks auth again after an account switch", async () => {
  const f = fixture()
  await setupNativePlanner(f.ctx)
  await f.dispatch()
  f.setConnection({ type: "credential", method: "key" })
  await assert.rejects(() => f.dispatch(), /API-key fallback is disabled/)
  assert.equal(f.activeReads(), 2)
})

test("missing or disabled Astra never falls back to an API or Go model", async () => {
  const f = fixture()
  await setupNativePlanner(f.ctx)
  f.source.enabled = false
  await assert.rejects(() => f.dispatch(), /No API or Go fallback/)
  f.unavailable()
  await assert.rejects(() => f.dispatch(), /No API or Go fallback/)
})

test("does not publish an alias when Astra is unavailable", async () => {
  const f = fixture()
  f.unavailable()
  await setupNativePlanner(f.ctx)
  assert.deepEqual(f.alias, {})
})

test("receipt storage failures do not break native dispatch", async () => {
  const f = fixture()
  f.ctx.storage.set = async () => { throw new Error("storage unavailable") }
  await setupNativePlanner(f.ctx)
  assert.equal((await f.dispatch()).model.id, NATIVE_MODEL)
})

test("rejects cross-provider planners and recursive alias targets", async () => {
  const f = fixture()
  for (const planner of ["go/gpt-6-luna", "openai/", "openai/smartrouter-auto"]) {
    await assert.rejects(() => setupNativePlanner(f.ctx, planner), /requires an OpenAI planner/)
  }
})
