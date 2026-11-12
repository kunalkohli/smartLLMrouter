/**
 * Opt-in classifier-only evaluation. Never invokes an executor or edits a task.
 * Reads a Jev key from TYPESAFE_API_KEY or TYPESAFE_API_KEY_FILE; prints no key,
 * plan or prompt. --live-session reads a private plan in memory only.
 */
import { readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { BUILD_MODELS, classifyBuild, ROUTING_RUBRIC } from "../plugin/smartrouter/jev.ts"
import type { Candidate, Decision } from "../plugin/smartrouter/jev.ts"
import { planDigest } from "../plugin/smartrouter/native-planner.ts"
import { ROUTING_CASES } from "../test/fixtures/routing-cases.ts"
import type { RoutingCase } from "../test/fixtures/routing-cases.ts"

const flag = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }

async function main() {
  const key = process.env.TYPESAFE_API_KEY || (process.env.TYPESAFE_API_KEY_FILE ? readFileSync(process.env.TYPESAFE_API_KEY_FILE, "utf8").trim() : "")
  if (!key) throw new Error("Set TYPESAFE_API_KEY or TYPESAFE_API_KEY_FILE for this opt-in evaluation")
  const baselineFile = flag("--baseline")
  const baseline = baselineFile ? (await import(pathToFileURL(resolve(baselineFile)).href)).classifyBuild as typeof classifyBuild : undefined
  const candidates: Candidate[] = Object.entries(BUILD_MODELS).map(([key, ref]) => ({ key, ref, family: ref.startsWith("openai/") ? "openai" : "free" }))
  const cases: RoutingCase[] = [...ROUTING_CASES]
  const sessionID = flag("--live-session")
  if (sessionID) {
    if (!/^ses_[A-Za-z0-9]+$/.test(sessionID)) throw new Error("Invalid session ID")
    const context = JSON.parse(execFileSync("opencode", ["api", "get", `/api/session/${sessionID}/context`], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })).data
    const request = context.filter((m: any) => m.type === "user").at(-1)?.text ?? "Implement the finished plan"
    cases.push({ name: "private-live-plan", state: planDigest(context, request), expectedFamily: "free", allowedModels: [BUILD_MODELS.glm] })
  }
  const only = flag("--case")
  const selected = only ? cases.filter((c) => c.name === only) : cases
  if (!selected.length) throw new Error("No matching evaluation case")
  const results: Record<string, number> = { baseline: 0, [ROUTING_RUBRIC]: 0 }
  for (const c of selected) {
    for (const [version, classify] of [...(baseline ? [["baseline", baseline] as const] : []), [ROUTING_RUBRIC, classifyBuild] as const]) {
      const d: Decision = await classify(c.state, key, candidates)
      const matched = d.family === c.expectedFamily && c.allowedModels.includes(d.model)
      if (matched) results[version]++
      console.log(JSON.stringify({ case: c.name, rubric: version, model: d.model, family: d.family,
        familyConfidence: d.answers.family.confidence,
        modelConfidence: (d.family === "free" ? d.answers.free_model : d.answers.openai_model)?.confidence,
        gateConfidence: d.confidence, approvalRequired: d.confidence < 0.8, guardedBy: d.guardedBy,
        infra: d.answers.touches_infra.noul, security: d.answers.touches_security.noul,
        latencyMs: d.latencyMs, matchesDesiredRoute: matched }))
    }
  }
  console.log(JSON.stringify({ summary: "Desired-label matches only, not measured executor quality or calibration", cases: selected.length, matches: results }))
  if (results[ROUTING_RUBRIC] !== selected.length) process.exitCode = 1
}

main().catch(() => {
  // No arbitrary upstream error text or sensitive inputs in terminal output.
  console.error("Classifier evaluation failed. Check the Jev credential, connectivity, case name and optional baseline/session inputs.")
  process.exitCode = 1
})
