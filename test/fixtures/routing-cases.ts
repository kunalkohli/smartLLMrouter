/** Desired routing hypotheses, not evidence of executor success or calibrated accuracy. */
export type RoutingCase = { name: string; state: string; expectedFamily: "free" | "openai"; allowedModels: string[] }

export const ROUTING_CASES: RoutingCase[] = [
  {
    name: "read-only-market-dashboard",
    state: "Plan: Build a read-only stock/ETF prototype with HTML/CSS/JS. A watchlist, ticker search, a chart using an existing library, common time-range controls, quote timestamps, light/dark mode and localStorage preferences. Use real public market data through a thin backend that reads the provider API key from an environment variable. Support multiple exchanges using provider documentation. No user accounts, trading, payments, portfolio records, custom financial calculations, databases, migrations or production deployment changes. Several ordinary files and tests; use conventional patterns.",
    expectedFamily: "free", allowedModels: ["opencode/glm-5.3-flash-free"],
  },
  {
    name: "mock-admin-dashboard",
    state: "Plan: Create a React/TypeScript prototype with an established component library: three pages, a searchable/filterable table, a chart, a detail panel, responsive styling, theme preference in localStorage and ordinary component tests. Use fixture/mock data only. No accounts, permissions, backend, database or infrastructure. Implement in several files with familiar library patterns.",
    expectedFamily: "free", allowedModels: ["opencode/glm-5.3-flash-free"],
  },
  {
    name: "documentation-spelling",
    state: "Plan: Change the spelling recieve to receive in README.md. One known line, no executable code, settings, dependencies or tests. Verify the diff is only that word.",
    expectedFamily: "free", allowedModels: ["opencode/longcat-2.5-free"],
  },
  {
    name: "contained-data-transform-refactor",
    state: "Plan: Refactor a contained CSV-to-JSON transformation utility to split parsing from normalization, preserve the existing algorithm and output contract, remove duplicated branches, and add a few clear unit tests. The approach and expected outputs are already specified. No new UI, security, database, deployment or unfamiliar design work.",
    expectedFamily: "free", allowedModels: ["opencode/deepseek-v4.1-flash-free"],
  },
  {
    name: "hard-production-debugging",
    state: "Plan: Diagnose an intermittent concurrency defect in a production data aggregation engine. Root cause remains unknown; the bug appears only under load and involves competing cancellation/retry paths and lock ordering. Design a deterministic reproducer, identify the race, reason through invariants, make a bounded fix in the existing architecture and add stress/regression tests. No authentication, schema, deployment or infrastructure changes. This is difficult root-cause analysis, not assembling an ordinary app.",
    expectedFamily: "openai", allowedModels: ["openai/gpt-6.1-terra", "openai/gpt-6.1-sol"],
  },
  {
    name: "authentication-and-financial-execution",
    state: "Plan: Implement multi-tenant broker OAuth linking with encrypted refresh-token storage, credential rotation and revocation, tenant authorization checks, and real order placement. Handle retry-safe financial execution and audit trails. Migrate persistent account/token schemas with a safe rollback. This changes authorization boundaries and moves real funds; it is not read-only public market data.",
    expectedFamily: "openai", allowedModels: ["openai/gpt-6.1-sol"],
  },
]
