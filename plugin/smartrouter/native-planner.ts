/**
 * Pre-Jev stage: a native OpenAI alias, not an independently authenticated proxy.
 * OpenCode retains ownership of OAuth, refresh, transport, and subscription use.
 */
export const NATIVE_PROVIDER = "openai"
export const NATIVE_MODEL = "smartrouter-auto"

type ModelRef = { providerID: string; id: string; variant?: string }
type ModelInfo = ModelRef & { enabled?: boolean; modelID?: string; [key: string]: unknown }
type RequestEvent = {
  sessionID: string
  agent: string
  kind: string
  model: ModelRef
}

// Only the public plugin surface used here. No credential values are requested.
export interface NativePlannerContext {
  model: {
    transform(callback: (editor: {
      get(providerID: string, modelID: string): ModelInfo | undefined
      update(providerID: string, modelID: string, update: (draft: Record<string, unknown>) => void): void
    }) => void): Promise<unknown>
    list(): Promise<{ data: readonly ModelInfo[] }>
  }
  integration: {
    connection: {
      active(integrationID: string): Promise<{ type: string; method?: string; status?: unknown } | undefined>
    }
  }
  session: {
    hook(
      name: "model.request",
      callback: (event: RequestEvent) => Promise<void>,
      options: { providerID: string },
    ): Promise<unknown>
  }
  storage: { set(key: string, value: unknown): Promise<void> }
}

export async function setupNativePlanner(ctx: NativePlannerContext, planner = "openai/gpt-6-astra") {
  const [providerID, ...parts] = planner.split("/")
  const plannerID = parts.join("/")
  if (providerID !== NATIVE_PROVIDER || !plannerID || plannerID === NATIVE_MODEL) {
    throw new Error("Smart Router native mode requires an OpenAI planner, such as openai/gpt-6-astra")
  }

  await ctx.model.transform((editor) => {
    const source = editor.get(NATIVE_PROVIDER, plannerID)
    if (!source || source.enabled === false) return
    editor.update(NATIVE_PROVIDER, NATIVE_MODEL, (draft) => {
      Object.assign(draft, source, {
        id: NATIVE_MODEL,
        modelID: source.modelID ?? plannerID,
        name: "Smart Router (auto)",
        // This alias is OAuth-only. API list pricing does not represent an
        // incremental bill against a ChatGPT subscription allowance.
        cost: [],
      })
    })
  })

  await ctx.session.hook(
    "model.request",
    async (event) => {
      if (event.model.providerID !== NATIVE_PROVIDER || event.model.id !== NATIVE_MODEL) return

      // Check on every dispatch, not just setup: an account can be switched
      // while OpenCode runs. Never silently use an API key instead of a plan.
      const connection = await ctx.integration.connection.active(NATIVE_PROVIDER)
      if (connection?.type !== "credential" || connection.method !== "oauth" || connection.status) {
        throw new Error("Smart Router: sign in with ChatGPT under /connect → OpenAI. Native mode requires an active OAuth connection; API-key fallback is disabled.")
      }
      const { data: models } = await ctx.model.list()
      const target = models.find((model) => model.providerID === NATIVE_PROVIDER && model.id === plannerID)
      if (!target || target.enabled === false) {
        throw new Error(`Smart Router: ${planner} is unavailable on your connected account. No API or Go fallback was attempted.`)
      }

      // The alias's modelID already dispatches Astra. Do not switch the session
      // or edit its identity; all native OpenAI request hooks continue to run.

      // A secret-free receipt for verifying the path without inspecting tokens.
      // Observability must never prevent the native request from dispatching.
      try {
        await ctx.storage.set(`smartrouter/native/${event.sessionID}`, {
          selected: `${NATIVE_PROVIDER}/${NATIVE_MODEL}`,
          resolved: planner,
          agent: event.agent,
          kind: event.kind,
          authentication: "opencode-oauth",
          jev: "not-invoked",
        })
      } catch {}
    },
    { providerID: NATIVE_PROVIDER },
  )
}
