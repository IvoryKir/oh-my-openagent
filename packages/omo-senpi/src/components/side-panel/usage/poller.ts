import {
  CLAUDE_PROVIDER,
  CLAUDE_USAGE_URL,
  CODEX_PROVIDER,
  CODEX_USAGE_URL,
  USAGE_MAX_BACKOFF_MS,
} from "../constants"
import type { PanelTimerHandle, PanelTimers } from "../types"
import { resolveUsageCredential, type PanelUsageCredential } from "./accounts"
import {
  claimProviders,
  mergeUsageResults,
  providersDue,
  readUsageCache,
  writeUsageCache,
  type UsagePollTarget,
} from "./cache"
import { describeUsageError, UsageHttpError, type UsageFetch } from "./http"
import { codexAccountId, parseClaudeUsage, parseCodexUsage } from "./parse"
import type { PanelUsageEntry, PanelUsageProviderKey, PanelUsageSnapshot } from "./types"

/** The credential files, already parsed. Injected so tests never touch a home directory. */
export interface UsageCredentialSource {
  readonly auth: unknown
  readonly pool: unknown
}

export interface UsagePollerDeps {
  readonly fetch: UsageFetch
  readonly readCredentials: () => UsageCredentialSource
  readonly cachePath: string
  /** `side_panel.usage_poll_seconds`, already in milliseconds. */
  readonly pollMs: number
  readonly now: () => number
  readonly timers: PanelTimers
  /** Called when the numbers on screen would change. */
  readonly onChange: () => void
  readonly logger?: { debug?(message: string, details?: unknown): void }
}

export interface UsagePoller {
  snapshot(): PanelUsageSnapshot
  start(): void
  stop(): void
  /** One pass, awaited. The lifecycle uses it through the timer; tests call it directly. */
  pollOnce(): Promise<void>
}

interface ProviderPlan {
  readonly key: PanelUsageProviderKey
  readonly provider: string
  readonly credential: PanelUsageCredential | undefined
  /** The provider appears in auth.json at all. One nobody signed into is skipped in silence. */
  readonly configured: boolean
}

const PROVIDERS: readonly { readonly key: PanelUsageProviderKey; readonly provider: string }[] = [
  { key: "claude", provider: CLAUDE_PROVIDER },
  { key: "codex", provider: CODEX_PROVIDER },
]

/**
 * Polls subscription usage into a machine-wide cache and republishes it to the column.
 *
 * Everything expensive is a decision made against that shared cache rather than against this
 * session's memory, so a second window costs nothing: it reads the same numbers, honours the
 * same backoff, and skips a fetch another session already announced.
 */
export function createUsagePoller(deps: UsagePollerDeps): UsagePoller {
  let snapshot: PanelUsageSnapshot = {}
  let serialized = "{}"
  let timer: PanelTimerHandle | undefined
  let running = false
  let stopped = false

  const publish = (next: PanelUsageSnapshot): void => {
    const encoded = stableStringify(next)
    if (encoded === serialized) return
    serialized = encoded
    snapshot = next
    deps.onChange()
  }

  const plans = (): readonly ProviderPlan[] => {
    const { auth, pool } = deps.readCredentials()
    const now = deps.now()
    return PROVIDERS.map(({ key, provider }) => ({
      key,
      provider,
      credential: resolveUsageCredential(auth, pool, provider, now),
      configured: hasProvider(auth, provider),
    }))
  }

  const readProvider = async (plan: ProviderPlan): Promise<PanelUsageEntry> => {
    const credential = plan.credential
    if (credential === undefined) {
      // A provider the user is signed into but whose token is unusable is worth saying out
      // loud; one they never configured is not, and never reaches this branch.
      return { error: "auth stale - run /login", retryAt: deps.now() + 5 * deps.pollMs }
    }
    try {
      const entry = await fetchProvider(deps.fetch, plan.key, credential.access, deps.now())
      return {
        ...entry,
        ...(credential.account === undefined ? {} : { account: credential.account }),
        ...(credential.pinnedAccount === undefined ? {} : { pinnedAccount: credential.pinnedAccount }),
        accountState: credential.state,
      }
    } catch (error) {
      return {
        error: describeUsageError(error),
        retryAt: deps.now() + backoffFor(error, deps.pollMs),
        ...(credential.account === undefined ? {} : { account: credential.account }),
      }
    }
  }

  const pollOnce = async (): Promise<void> => {
    if (running || stopped) return
    running = true
    try {
      const cached = readUsageCache(deps.cachePath)
      publish(snapshotOf(cached))

      const planned = plans().filter((plan) => plan.credential !== undefined || plan.configured)
      const targets: readonly UsagePollTarget[] = planned.map((plan) => ({
        key: plan.key,
        pollMs: deps.pollMs,
        ...(plan.credential?.account === undefined ? {} : { account: plan.credential.account }),
      }))
      const due = providersDue(cached, targets, deps.now())
      if (due.length === 0) return

      writeUsageCache(deps.cachePath, claimProviders(cached, due, deps.now()))
      const results = await Promise.all(
        planned
          .filter((plan) => due.includes(plan.key))
          .map(async (plan) => ({ key: plan.key, entry: await readProvider(plan) })),
      )
      // Re-read before merging: a sibling session may have written its own results while this
      // one was waiting on the network, and last-writer-wins should not mean last-writer-erases.
      const merged = mergeUsageResults(readUsageCache(deps.cachePath), results, due)
      writeUsageCache(deps.cachePath, merged)
      publish(snapshotOf(merged))
    } catch (error) {
      deps.logger?.debug?.("omo-senpi side panel: usage poll failed", { error: String(error) })
    } finally {
      running = false
    }
  }

  const arm = (): void => {
    if (stopped || timer !== undefined) return
    timer = deps.timers.set(() => {
      timer = undefined
      void pollOnce().finally(arm)
    }, deps.pollMs)
  }

  return {
    snapshot: () => snapshot,
    start(): void {
      stopped = false
      publish(snapshotOf(readUsageCache(deps.cachePath)))
      void pollOnce().finally(arm)
    },
    stop(): void {
      stopped = true
      if (timer === undefined) return
      deps.timers.clear(timer)
      timer = undefined
    },
    pollOnce,
  }
}

async function fetchProvider(
  fetchJson: UsageFetch,
  key: PanelUsageProviderKey,
  token: string,
  now: number,
): Promise<PanelUsageEntry> {
  if (key === "claude") {
    const payload = await fetchJson(CLAUDE_USAGE_URL, { Authorization: `Bearer ${token}`, Accept: "application/json" })
    return parseClaudeUsage(payload, now)
  }
  const accountId = codexAccountId(token)
  const payload = await fetchJson(CODEX_USAGE_URL, {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    ...(accountId === undefined ? {} : { "ChatGPT-Account-Id": accountId }),
  })
  return parseCodexUsage(payload, now)
}

/**
 * A 429 can arrive with `retry-after: 0`, meaning "this window is about to roll" - waiting
 * minutes on that would hide a recovery, so only an explicit positive header earns a long wait.
 */
function backoffFor(error: unknown, pollMs: number): number {
  const http = error instanceof UsageHttpError ? error : undefined
  const requested = http?.retryAfterMs ?? (http?.status === 429 ? pollMs : 2 * pollMs)
  return Math.min(requested, USAGE_MAX_BACKOFF_MS)
}

function snapshotOf(cache: PanelUsageSnapshot): PanelUsageSnapshot {
  return {
    ...(cache.claude === undefined ? {} : { claude: cache.claude }),
    ...(cache.codex === undefined ? {} : { codex: cache.codex }),
  }
}

/**
 * Key order survives neither the cache round-trip nor a merge, so a plain `JSON.stringify`
 * comparison reported new numbers on every poll and repainted the column for nothing.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (typeof value !== "object" || value === null) return JSON.stringify(value) ?? "null"
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`
}

function hasProvider(auth: unknown, provider: string): boolean {
  if (typeof auth !== "object" || auth === null || Array.isArray(auth)) return false
  return Object.hasOwn(auth, provider)
}
