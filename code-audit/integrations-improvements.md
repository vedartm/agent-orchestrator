# Refactoring Improvements Roadmap — Split 5: Integrations & Notifiers

---

## Critical Refactors

### Refactor: Extract Shared Retry-with-Backoff Utility
- **Location**: `notifier-discord/src/index.ts:94-156`, `notifier-webhook/src/index.ts:42-84`, `notifier-openclaw/src/index.ts:52-126`, `notifier-slack/src/index.ts` (missing)
- **Problem**: Three notifier plugins independently implement exponential backoff retry loops with slightly different features (rate-limit handling, auth detection, retryable status checks). The Slack notifier has no retry logic at all — any transient 503 or 429 response causes immediate failure.
- **Impact**: Bug fixes or improvements (e.g., adding jitter) must be replicated in 3+ places. Slack is unreliable under normal transient failure conditions. Webhook notifier also lacks timeout, risking indefinite hangs.
- **Suggested Approach**: Create a shared utility in `@composio/ao-core/utils`:
  ```typescript
  export async function fetchWithRetry(
    url: string,
    init: RequestInit,
    options: {
      retries?: number;       // default 3
      baseDelayMs?: number;   // default 1000
      timeoutMs?: number;     // default 10000
      isRetryable?: (status: number) => boolean;
      onRateLimit?: (retryAfterMs: number) => void;
    }
  ): Promise<Response>
  ```
  All four notifiers (Discord, Slack, Webhook, OpenClaw) should use this. Discord can pass its rate-limit handler; OpenClaw can pass its auth-error short-circuit. Slack and Webhook get retry + timeout for free.

---

### Refactor: Add Timeout to Slack and Webhook Notifiers
- **Location**: `notifier-slack/src/index.ts:121-125`, `notifier-webhook/src/index.ts:53-60`
- **Problem**: Both plugins call `fetch()` without any `AbortController` or timeout. If the target server is unresponsive, the orchestrator's notification pipeline hangs indefinitely.
- **Impact**: A single slow webhook endpoint can block the entire notification flow. In production, this could cause cascading delays.
- **Suggested Approach**: Add `AbortSignal.timeout(10_000)` to the fetch call (matching Discord's pattern). If the shared retry utility above is adopted, this comes built-in:
  ```typescript
  // notifier-slack/src/index.ts — postToWebhook
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  ```

---

### Refactor: Fix Hardcoded Internal IP in Mobile App
- **Location**: `packages/mobile/src/context/BackendContext.tsx:7`
- **Problem**: `const DEFAULT_URL = "http://192.168.1.1:3000"` hardcodes a private network IP address. This exposes internal network topology, won't work for most users, and is a security concern in a distributed package.
- **Impact**: Any user running the mobile app for the first time connects to an arbitrary internal IP. On Android, the backend URL stored in AsyncStorage is world-readable.
- **Suggested Approach**: Remove the hardcoded default entirely. Force users to configure the backend URL on first launch via the Settings screen. Show a setup wizard or empty state if no URL is configured:
  ```typescript
  const DEFAULT_URL = ""; // or undefined — force explicit configuration
  ```
  Additionally, consider using `react-native-encrypted-storage` instead of `AsyncStorage` for backend/WS URLs on Android.

---

### Refactor: Decompose SessionDetailScreen
- **Location**: `packages/mobile/src/screens/SessionDetailScreen.tsx:1-392` (742 lines total)
- **Problem**: This component manages session polling, keyboard height, 3 different message sending flows, conditional PR/CI/comment rendering, 5+ action button states, and a text input — all in one file. Missing `useMemo`/`useCallback` causes unnecessary re-renders on every state change.
- **Impact**: Poor render performance on lower-end mobile devices. High cognitive complexity makes modifications risky. No separation of concerns for testing.
- **Suggested Approach**: Split into focused components:
  - `SessionHeader` — Title, status badge, action buttons
  - `SessionAlerts` — Alert banners for attention states
  - `SessionPRInfo` — PR details, CI checks, review status
  - `SessionComments` — Unresolved comments list with fix actions
  - `SessionMessageInput` — Text input with keyboard handling
  - Wrap expensive computations (`failedChecks`, `unresolvedComments`) in `useMemo`
  - Wrap handlers (`handleSend`, `handleAskFixCI`, `handleAskFixComment`) in `useCallback`

---

### Refactor: Sanitize All CLI Arguments in OpenClaw Plugin
- **Location**: `openclaw-plugin/index.ts:392` (labels), `openclaw-plugin/index.ts:1275` (PR param)
- **Problem**: `sanitizeCliArg()` is defined (line 104) and used in 26 locations, but `options.labels` at line 392 and `params.pr` at line 1275 bypass it. A crafted labels value like `"--exec=malicious"` could inject CLI flags into `gh` commands via `execFileSync`.
- **Impact**: CLI argument injection through user-supplied tool parameters. While `execFile` (not `exec`) prevents shell injection, flag injection can still alter command behavior.
- **Suggested Approach**: Apply `sanitizeCliArg()` consistently:
  ```typescript
  // line 392 — fetchIssues
  if (options.labels) args.push("--label", sanitizeCliArg(options.labels));

  // line 1275 — ao_session_claim_pr tool
  args.push("--pr", sanitizeCliArg(params.pr));
  ```
  Also remove the duplicate `sanitizeArg` definition at line 702 and import the module-level function.

---

### Refactor: Fix Message Injection Risk in Mobile PR Comment Handling
- **Location**: `packages/mobile/src/screens/SessionDetailScreen.tsx:150-162`
- **Problem**: PR comment body is directly interpolated into a prompt message without escaping:
  ```typescript
  `Please address this review comment:\n\nFile: ${comment.path}\nComment: ${comment.body}\n\nComment URL: ${comment.url}...`
  ```
  A malicious PR comment could inject instructions that the AI agent interprets as user commands.
- **Impact**: Prompt injection via PR comments — an attacker could craft a comment body that alters the agent's behavior.
- **Suggested Approach**: Wrap user-generated content in clear delimiters and add a system note:
  ```typescript
  `Please address this review comment:\n\nFile: ${comment.path}\n\n<review-comment>\n${comment.body}\n</review-comment>\n\nComment URL: ${comment.url}`
  ```
  The delimiters make it clear to the model where user-generated content begins and ends.

---

## Medium Priority Improvements

### Refactor: Extract Discussion Parsing Helper in GitLab SCM
- **Location**: `packages/plugins/scm-gitlab/src/index.ts:635-659`, `676-702`, `704-730`
- **Problem**: Three methods (`getReviews`, `getPendingComments`, `getAutomatedComments`) contain 67 lines of near-identical discussion iteration logic — fetch discussions, iterate notes, check `d.notes[0]`, extract author/body/position.
- **Impact**: Changes to discussion handling (e.g., pagination support, error handling) must be replicated in three places.
- **Suggested Approach**: Extract a shared helper:
  ```typescript
  function iterateDiscussionNotes(
    discussions: GitLabDiscussion[],
    filter: (note: GitLabNote, author: string) => boolean,
  ): Array<{ note: GitLabNote; author: string }> {
    const results = [];
    for (const d of discussions) {
      const note = d.notes?.[0];
      if (!note) continue;
      const author = note.author?.username ?? "";
      if (filter(note, author)) results.push({ note, author });
    }
    return results;
  }
  ```
  Then each method uses the helper with its specific filter predicate.

---

### Refactor: Cache Discussion Results in GitLab SCM
- **Location**: `packages/plugins/scm-gitlab/src/index.ts:635,677,705` — three independent `fetchDiscussions()` calls
- **Problem**: `getReviews()`, `getPendingComments()`, and `getAutomatedComments()` each call `fetchDiscussions()` independently for the same MR. When `getMergeability()` invokes multiple review methods, the same API response is fetched three times.
- **Impact**: 3x unnecessary API calls per merge readiness check; adds latency and risks rate limiting.
- **Suggested Approach**: Add a simple per-invocation cache:
  ```typescript
  function createDiscussionCache() {
    const cache = new Map<string, GitLabDiscussion[]>();
    return async (pr: PRInfo, hostname: string | undefined, context: Context) => {
      const key = `${pr.owner}/${pr.repo}!${pr.number}`;
      if (!cache.has(key)) cache.set(key, await fetchDiscussions(pr, hostname, context));
      return cache.get(key)!;
    };
  }
  ```
  Create the cache in `createGitLabSCM()` scope so it's shared across methods but not leaked globally.

---

### Refactor: Consolidate Tracker Prompt Generation
- **Location**: `tracker-linear/src/index.ts:343-376`, `tracker-github/src/index.ts:182-204`, `tracker-gitlab/src/index.ts:91-113`
- **Problem**: All three trackers implement nearly identical `generatePrompt()` logic: build an array of lines from issue title, labels, description, and optional priority.
- **Impact**: Style changes to prompt formatting must be applied in three places.
- **Suggested Approach**: Add a shared `formatIssuePrompt(issue: Issue, options?: { priority?: string }): string` utility to `@composio/ao-core` that all three trackers call. Each tracker only needs to add tracker-specific fields (e.g., Linear's priority mapping).

---

### Refactor: Reduce Linear updateIssue API Call Chain
- **Location**: `packages/plugins/tracker-linear/src/index.ts:432-571`
- **Problem**: A single `updateIssue()` call can make 4-6 sequential GraphQL requests: resolve identifier, fetch workflow states, update issue state, lookup user by name, update assignee, fetch/update labels. Workflow states and label definitions are fetched fresh on every update.
- **Impact**: O(n) API calls per update; noticeable latency for bulk operations; wastes Linear API quota.
- **Suggested Approach**:
  1. Cache workflow states per team (they change rarely): `Map<teamId, WorkflowState[]>` with 5-minute TTL
  2. Cache label definitions similarly
  3. Skip identifier resolution when the input is already a UUID (check format)
  4. Batch mutation fields into fewer GraphQL calls where the API supports it

---

### Refactor: Fix O(n²) Issue Deduplication in OpenClaw Plugin
- **Location**: `openclaw-plugin/index.ts:422-427`
- **Problem**: Uses `.filter()` with `.findIndex()` for deduplication — O(n²) complexity. With 30 issues per repo across 5 repos, this means 22,500+ comparisons.
- **Impact**: Noticeable slowdown (100-500ms) on projects with many repos and issues.
- **Suggested Approach**: Use a Set for O(n) dedup:
  ```typescript
  const seen = new Set<string>();
  const unique = allIssues.filter((issue) => {
    const id = getIssueIdentity(issue);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  ```

---

### Refactor: Decompose OpenClaw Plugin Into Modules
- **Location**: `openclaw-plugin/index.ts` (1456 lines)
- **Problem**: A single file contains hooks (lines 546-683), 13 slash command handlers (lines 689-861), 14 tool registrations (lines 867-1341), and 2 background services (lines 1354-1455). This makes navigation, testing, and code review difficult.
- **Impact**: High cognitive load; test file only covers helper functions, leaving 1100+ lines of handlers untested.
- **Suggested Approach**: Split into modules:
  - `helpers.ts` — sanitizeCliArg, resolveAoConfigPath, YAML parsing, fetchIssues
  - `hooks.ts` — buildLiveContext, onMessageReceived, onBeforePromptBuild
  - `commands.ts` — Slash command handler
  - `tools.ts` — Tool registrations
  - `services.ts` — Health monitor, board scanner
  - `index.ts` — Plugin entry point wiring modules together

---

### Refactor: Add Pagination Support to GitLab SCM Discussion Fetching
- **Location**: `packages/plugins/scm-gitlab/src/index.ts:371`
- **Problem**: `fetchDiscussions()` uses `?per_page=100` with no pagination handling. MRs with more than 100 discussion threads silently truncate results.
- **Impact**: Large MRs lose review comments, pending comments, and automated feedback beyond the first 100 discussions.
- **Suggested Approach**: Implement link-header pagination or loop until empty response:
  ```typescript
  async function fetchAllDiscussions(pr, hostname, context) {
    const all = [];
    let page = 1;
    while (true) {
      const raw = await glab(["api", `${mrApiPath(pr)}/discussions?per_page=100&page=${page}`], hostname);
      const batch = parseJSON(raw, []);
      if (batch.length === 0) break;
      all.push(...batch);
      page++;
    }
    return all;
  }
  ```

---

### Refactor: Extract Shared Polling Hook for Mobile App
- **Location**: `packages/mobile/src/hooks/useSession.ts:47-57`, `packages/mobile/src/hooks/useSessions.ts:44-84`
- **Problem**: Both hooks independently implement identical polling logic: `setInterval`/`clearInterval`, AppState listener for foreground/background transitions, and a generation counter for race condition prevention.
- **Impact**: Bug fixes (e.g., adding exponential backoff or idle detection) must be duplicated.
- **Suggested Approach**: Create a shared `usePoll()` hook:
  ```typescript
  function usePoll(fetchFn: () => Promise<void>, intervalMs: number) {
    // Encapsulates: interval management, AppState listener, generation counter, cleanup
  }
  ```
  Both `useSession` and `useSessions` delegate to `usePoll` with their specific fetch functions.

---

### Refactor: Consolidate Notification Logic in Mobile App
- **Location**: `packages/mobile/src/hooks/useSessionNotifications.ts:30-59`, `packages/mobile/src/notifications/backgroundTask.ts:41-58`
- **Problem**: Notification level checking and cooldown logic is duplicated between the foreground hook and the background task.
- **Impact**: Changes to notification policy must be applied in two places; risk of divergent behavior between foreground and background notifications.
- **Suggested Approach**: Extract to `notifications/shouldNotify.ts`:
  ```typescript
  export function shouldNotify(
    session: Session,
    lastNotified: Record<string, number>,
    cooldownMs: number
  ): boolean
  ```
  Both the hook and background task import and use this function.

---

### Refactor: Use Webhook Event Handler Map in GitHub SCM
- **Location**: `packages/plugins/scm-github/src/index.ts:266-432`
- **Problem**: `parseGitHubWebhookEvent()` uses 6+ sequential `if (rawEventType === "...")` blocks, each constructing a similar event object with slight field variations. This is verbose and error-prone.
- **Impact**: Adding new event types requires adding another large if-block. The function is 167 lines.
- **Suggested Approach**: Use an event handler map:
  ```typescript
  const eventParsers: Record<string, (payload, config) => WebhookEvent | null> = {
    pull_request: parsePullRequestEvent,
    pull_request_review: parsePullRequestReviewEvent,
    check_suite: parseCheckSuiteEvent,
    // ...
  };

  function parseGitHubWebhookEvent(request, payload, config) {
    const parser = eventParsers[rawEventType];
    if (!parser) return null;
    return parser(payload, config);
  }
  ```

---

### Refactor: Add URL Validation to Slack Notifier
- **Location**: `packages/plugins/notifier-slack/src/index.ts:138-142`
- **Problem**: The Slack notifier accepts any string as a webhook URL without validation. Discord validates with a regex; Webhook and OpenClaw use `validateUrl()`. Slack does neither.
- **Impact**: Invalid URLs (wrong scheme, malformed) cause cryptic fetch errors instead of clear configuration warnings.
- **Suggested Approach**: Add the same `validateUrl()` call that other notifiers use in the `create()` function.

---

## Nice-to-Have Enhancements

### Enhancement: Add Structured Logging Across SCM Plugins
- **Location**: `scm-github/src/index.ts` (no logging), `scm-gitlab/src/index.ts` (console.warn only)
- **Description**: Neither SCM plugin has structured logging for API calls, response times, or error context. Debugging production issues requires reproducing them locally.
- **Benefit**: Faster incident resolution; ability to trace webhook processing through delivery IDs; visibility into API call patterns and latencies.
- **Suggested Approach**: Accept a `Logger` interface in `createGitHubSCM()`/`createGitLabSCM()` config and log API calls with context (PR number, method, duration). Use debug-level for API calls, warn for failures with fallback, error for unrecoverable issues.

---

### Enhancement: Make BOT_AUTHORS Configurable
- **Location**: `scm-github/src/index.ts:40-51`, `scm-gitlab/src/index.ts:37-46`
- **Description**: Both SCM plugins maintain independent hardcoded bot username lists. Organizations using custom bots not in the list see bot comments mixed with human reviews.
- **Benefit**: Organizations can add their custom CI bots without code changes.
- **Suggested Approach**: Accept an optional `additionalBotAuthors: string[]` in ProjectConfig that gets merged with the default set. Share the base list between GitHub and GitLab plugins.

---

### Enhancement: Add Memoization to Mobile getAttentionLevel
- **Location**: `packages/mobile/src/types/index.ts:144-209`
- **Description**: This 66-line function with deeply nested conditionals is called per session per render in multiple components (HomeScreen sorting, SessionCard, OrchestratorScreen zone counting). The result only changes when session state changes.
- **Benefit**: Eliminates redundant computation; clearer session state derivation.
- **Suggested Approach**: Compute `attentionLevel` once when session data is received (in the hook or context) and store it as a property on the session object. Components read the cached value instead of recomputing.

---

### Enhancement: Add Smart Polling to Mobile Hooks
- **Location**: `packages/mobile/src/hooks/useSession.ts`, `packages/mobile/src/hooks/useSessions.ts`
- **Description**: Fixed 5-second polling continues regardless of session activity, network conditions, or app foreground state. This wastes battery and bandwidth.
- **Benefit**: Reduced battery drain; lower server load; better UX on slow networks.
- **Suggested Approach**: Implement adaptive polling:
  - Active sessions: 3-5s interval
  - Idle sessions (no recent activity): 15-30s interval
  - App backgrounded: pause polling entirely (background task handles notifications)
  - Network error: exponential backoff up to 60s

---

### Enhancement: Replace Epoch Date Defaults in GitLab SCM
- **Location**: `packages/plugins/scm-gitlab/src/index.ts:63,65,631`
- **Description**: `parseDate()` and approval timestamps default to `new Date(0)` (January 1, 1970). This is semantically incorrect — it implies the event happened in 1970 rather than at an unknown time.
- **Benefit**: Downstream consumers can distinguish "unknown time" from "ancient time"; cleaner data semantics.
- **Suggested Approach**: Return `null` or `undefined` for unknown timestamps and let consumers handle the absence explicitly.

---

### Enhancement: Improve OpenClaw Plugin Test Coverage
- **Location**: `openclaw-plugin/index.test.ts` (124 lines, 5 tests)
- **Description**: Only helper functions (YAML parsing, fetchIssues, mergeStringLists) are tested. The 13 slash command handlers (170 lines), 14 tool handlers (475 lines), hook logic, and background services are entirely untested.
- **Benefit**: Catch regressions in command/tool behavior; validate error paths; enable safe refactoring.
- **Suggested Approach**: Add test suites for:
  - Command handler: mock `tryRunAo`/`tryRunGh` and test each subcommand
  - Tool handlers: mock CLI calls and verify parameter mapping
  - Hook behavior: test `isWorkRelated()` with edge cases, `buildLiveContext()` with mock data
  - Background services: test board scanner dedup logic

---

### Enhancement: Add Composio SDK Load Timeout
- **Location**: `packages/plugins/notifier-composio/src/index.ts:52-78`
- **Description**: `loadComposioSDK()` uses a dynamic `import()` that could hang if the module resolution is slow or blocked. The timeout only wraps the subsequent API call, not the SDK loading itself.
- **Benefit**: Prevents indefinite hangs during plugin initialization.
- **Suggested Approach**: Wrap the dynamic import in a `Promise.race` with a 10-second timeout:
  ```typescript
  const sdk = await Promise.race([
    import("composio-core"),
    rejectAfter(10_000, "Composio SDK load timed out"),
  ]);
  ```

---

### Enhancement: Add React Error Boundary to Mobile App
- **Location**: `packages/mobile/` (no error boundary found)
- **Description**: There is no React error boundary wrapping the app or individual screens. An unhandled render error in any component crashes the entire app.
- **Benefit**: Graceful degradation — show error screen with retry option instead of crashing.
- **Suggested Approach**: Add an `ErrorBoundary` component wrapping `RootNavigator` that catches render errors, logs them, and shows a "Something went wrong" screen with a retry button.

---

### Enhancement: Prune Stale Notification State in Mobile
- **Location**: `packages/mobile/src/hooks/useSessionNotifications.ts:61`
- **Description**: `NOTIFY_STATE_KEY` in AsyncStorage accumulates entries for every session that ever triggered a notification but is never pruned. Over time, this grows unbounded.
- **Benefit**: Prevents AsyncStorage bloat; ensures correct notification behavior for session IDs that are reused.
- **Suggested Approach**: When fetching sessions, remove notification state entries for session IDs that no longer exist. Run this cleanup on app foreground transition.

---

### Enhancement: Make OpenClaw buildLiveContext Async with Caching
- **Location**: `openclaw-plugin/index.ts:559-598`
- **Description**: `buildLiveContext()` makes synchronous CLI calls (up to 25s combined timeout) during the prompt build hook, blocking user interaction. The same data is fetched fresh on every work-related message.
- **Benefit**: Non-blocking prompt builds; reduced CLI call frequency; better UX.
- **Suggested Approach**:
  1. Make `buildLiveContext` async and use the hook's async support
  2. Cache results with a 30-second TTL
  3. Return cached data immediately if available, refresh in background
  4. Add an overall timeout (5s) so the hook never blocks for more than 5 seconds
