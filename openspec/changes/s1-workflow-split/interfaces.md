# Interfaces — s1-workflow-split

## Exported Signatures

### tools/workflow-core.mjs
- `DIR: string`
- `FILE: string`
- `BUDGETS_FILE: string`
- `METRICS_FILE: string`
- `DEFAULT_BUDGETS: Record<string, number>`
- `BUDGET_WARN_RATIO: number`
- `BUDGET_WARN_DEFAULT_TOKENS: number`
- `BUDGET_WARN_DEFAULT_CALLS: number`
- `statePath(root: string): string`
- `budgetsPath(root: string): string`
- `isPlainObject(value: any): boolean`
- `loadBudgets(root: string): Record<string, number>`
- `load(root: string): TaskState | null`
- `save(root: string, st: TaskState): void`
- `refreshSnapshot(root: string): void`
- `assertWorkflowDirOwned(root: string): void`
- `appendMetric(root: string, record: MetricRecord): void`
- `readMetricsRaw(root: string): MetricRecord[]`
- `buildMetricRecord(st: TaskState): MetricRecord`
- `reconcileMetrics(root: string, options?: { lockHeld?: boolean }): MetricRecord | null`
- `loadMetrics(root: string): MetricRecord[]`
- `sleepSync(ms: number): void`
- `acquireLock(root: string, timeoutMs?: number, staleMs?: number): (() => void) | null`
- `withStateLock<T>(root: string, fn: () => T, options?: { timeoutMs?: number, staleMs?: number }): T | number`
- `cmdMetrics(root: string): number`
- `recordAbandonedLane(root: string, prev: TaskState, next: TaskState, reason: string): void`
- `logEvent(root: string, kind: string, text: string, extra?: Record<string, any>): void`

### tools/workflow-ci.mjs
- `resolveChangedFilesAgainstBase(root: string, baseRef: string): { ok: boolean, changedFiles?: string[], changedLines?: number, error?: string }`
- `validateCheckCiT1(root: string, flags: any, baseRef: string): number`
- `validateCheckCiGit(root: string, oracleRelForCommit: string, baseRef: string, relChangeScope?: string | null): number`
- `validateCheckCiOracleFiles(root: string, relChangeDir: string): { ok: boolean, error?: string }`
- `checkPushEvidence(root: string, flags: any): number`
- `checkQualityGates(root?: string, options?: any): { ok: boolean, violators: any[], errors: any[] }`
- `cmdCheckCi(root: string, flags?: any): number`
- `reviewAttempts(root: string, changeId: string): { repairs: number, retries: number, reReviews: number }`
- `cmdReviewRun(root: string, flags: any, positionals?: number): number`
- `cmdStageB(root: string, flags: any): number`
- `openspecDirProblems(root: string, a: any, fullPath: string): string[]`
- `openspecFileProblems(a: any, fullPath: string): string[]`
- `runOpenspecValidate(root: string, fullPath: string): string | null`
- `validateOpenspecArtifact(root: string, a: any, fullPath: string, invalid: string[]): void`
- `parsePlanTickets(tasksBody: string): Map<string, string[]>`
- `missingPlanDep(tickets: Map<string, string[]>): string | null`
- `planCycleFrom(tickets: Map<string, string[]>, id: string): string | null`
- `validatePlanCoverage(tasksBody: string): string | null`
- `validateManifestRows(body: string): string | null`

### tools/workflow.mjs
- Re-exports all public symbols from `workflow-core.mjs` and `workflow-ci.mjs` for 100% backward compatibility.
- `runWorkflowCli(argv?: string[], options?: any): number | Promise<number>`
