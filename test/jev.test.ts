import assert from "node:assert/strict"
import { test } from "node:test"
import { BUILD_MODELS, classifyBuild, composeDecision, formatDecision, questions } from "../plugin/smartrouter/jev.ts"
import type { Candidate } from "../plugin/smartrouter/jev.ts"

const candidates: Candidate[] = Object.entries(BUILD_MODELS).map(([key, ref]) => ({ key, ref, family: ref.startsWith("openai/") ? "openai" : "free" }))
const answers = () => ({ family: { choice: "free", confidence: 0.98 }, free_model: { choice: "glm", confidence: 0.95 }, openai_model: { choice: "terra", confidence: 0.91 }, touches_infra: { noul: 0.01 }, touches_security: { noul: 0.02 } })

test("one call contains both family and conditional model selections, excluding Astra", () => {
  const q = questions(candidates)
  assert.deepEqual(Object.keys(q.openai_model!.criteria), ["terra", "sol"])
  assert.deepEqual(Object.keys(q.free_model!.criteria), ["glm", "longcat", "deepseek"])
})

test("Jev selects a free model without an OpenAI subtype deciding the route", () => {
  const d = composeDecision(answers(), candidates)
  assert.equal(d.model, BUILD_MODELS.glm); assert.equal(d.confidence, 0.95)
})

test("risk guards promote to OpenAI; high risk uses Sol, never Astra", () => {
  const a = answers(); a.touches_infra.noul = 0.7
  assert.equal(composeDecision(a, candidates).model, BUILD_MODELS.terra)
  a.touches_security.noul = 0.95
  assert.equal(composeDecision(a, candidates).model, BUILD_MODELS.sol)
  a.touches_infra.noul = 0.96; a.touches_security.noul = 0.7
  assert.equal(composeDecision(a, candidates).model, BUILD_MODELS.sol)
})

test("risk guard without eligible OpenAI refuses a weaker free fallback", () => {
  const a = answers(); a.touches_security.noul = 0.95; delete (a as any).openai_model
  assert.throws(() => composeDecision(a, candidates.filter((c) => c.family === "free")), /Risk guard requires/)
})

test("malformed/out-of-range/unknown Jev choices cannot become a model reference", () => {
  for (const value of [null, {}, { ...answers(), family: { choice: "astra", confidence: 0.99 } }, { ...answers(), free_model: { choice: "glm", confidence: NaN } }, { ...answers(), touches_security: { noul: 2 } }]) {
    assert.throws(() => composeDecision(value, candidates), /Invalid Jev/)
  }
})

test("classifier makes exactly one bounded request and parses the structured result", async () => {
  let calls = 0
  const fakeFetch: typeof fetch = async (url, init) => {
    calls++; assert.equal(url, "https://api.typesafe.ai/v1/systemone")
    assert.equal(new Headers(init!.headers).get("Authorization"), "Bearer test-secret")
    const payload = JSON.parse(init!.body as string)
    assert.equal(payload.model, "jev-latest"); assert.equal(payload.state, "test plan")
    assert.ok(payload.questions.family); assert.ok(payload.questions.openai_model); assert.ok(init!.signal)
    return Response.json({ model: "jev-real", answers: answers() })
  }
  const d = await classifyBuild("test plan", "test-secret", candidates, fakeFetch)
  assert.equal(calls, 1); assert.equal(d.jevModel, "jev-real"); assert.equal(d.model, BUILD_MODELS.glm)
  assert.ok(!JSON.stringify(d).includes("test-secret"))
})

test("HTTP errors never echo upstream bodies or credentials", async () => {
  const fakeFetch: typeof fetch = async () => new Response("secret-test-data", { status: 401 })
  await assert.rejects(() => classifyBuild("test plan", "test-secret", candidates, fakeFetch), (error: Error) => {
    assert.match(error.message, /HTTP 401/); assert.doesNotMatch(error.message, /secret-test-data|test-secret/); return true
  })
})

test("free route labels the OpenAI answer conditional and keeps the gate unchanged", () => {
  const d = { ...composeDecision(answers(), candidates), jevModel: "jev-test", latencyMs: 1 }
  const text = formatDecision(d)
  assert.match(text, /OpenAI model \(Terra vs Sol\): Terra · confidence 0.91 — conditional, not used/)
  assert.match(text, /Free model: GLM · confidence 0.95\n/)
  assert.match(text, /Gate confidence: 0.95 · threshold 0.80 · automatic/)
})

test("risk overrides stay separate from the raw Jev choices", () => {
  const a = answers(); a.touches_security.noul = 0.95
  const d = { ...composeDecision(a, candidates), jevModel: "jev-test", latencyMs: 1 }
  const text = formatDecision(d)
  assert.match(text, /Family \(Free vs OpenAI\): Free · confidence 0.98/)
  assert.match(text, /OpenAI model \(Terra vs Sol\): Terra · confidence 0.91/)
  assert.match(text, /Risk override: touches_security → openai\/gpt-6.1-sol/)
  assert.match(text, /🧠 Jev → openai\/gpt-6.1-sol/)
})

test("an unavailable conditional branch is omitted rather than fabricated", () => {
  const onlyFree = candidates.filter((c) => c.family === "free")
  const d = { ...composeDecision(answers(), onlyFree), jevModel: "jev-test", latencyMs: 1 }
  assert.doesNotMatch(formatDecision(d), /OpenAI model \(Terra vs Sol\)/)
})
