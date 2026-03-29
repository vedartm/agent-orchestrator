# Code Quality Audit Report — Split 5: Integrations & Notifiers

## Executive Summary
- **Overall Score**: 588/1000
- **Maintainability Verdict**: Requires Refactoring
- **Primary Strengths**: Well-structured plugin architecture with consistent interfaces; good webhook signature verification using timing-safe comparisons; comprehensive test suites across SCM and tracker plugins; clean TypeScript usage with proper type definitions; Result<T,E> pattern for error handling in openclaw-plugin
- **Critical Weaknesses**: Pervasive code duplication across plugin families (retry logic, event formatting, discussion parsing); missing timeout and retry logic in Slack and Webhook notifiers; silent error suppression in multiple catch blocks; O(n²) deduplication in openclaw-plugin; 742-line monolithic React Native screen; hardcoded internal IP address in mobile app; inconsistent input sanitization in openclaw-plugin CLI args

---

## File/Component Scores

### SCM Plugins

| File/Path | Score /100 | Assessment |
|-----------|------------|------------|
| `packages/plugins/scm-github/src/index.ts` | 68 | Feature-rich but high complexity (1041 lines); duplicated event parsing; silent error suppression in detectPR; redundant API calls in getMergeability |
| `packages/plugins/scm-gitlab/src/index.ts` | 65 | Solid GitLab integration with self-hosted support; tripled discussion-parsing logic across getReviews/getPendingComments/getAutomatedComments; hardcoded pagination (per_page=100); epoch date defaults misleading |
| `packages/plugins/scm-gitlab/src/glab-utils.ts` | 82 | Clean utility module; proper execFile usage (no shell injection); good error wrapping with cause chain |

### Tracker Plugins

| File/Path | Score /100 | Assessment |
|-----------|------------|------------|
| `packages/plugins/tracker-linear/src/index.ts` | 62 | Dual transport abstraction is well-designed; updateIssue makes 4-6 sequential API calls per update; no-op catch handlers suppress promise rejections; workflow states fetched every single update without caching |
| `packages/plugins/tracker-github/src/index.ts` | 72 | Clean CLI wrapper with version-aware degradation for stateReason; labels .join(",") doesn't escape commas; assumes gh CLI always available without validation |
| `packages/plugins/tracker-gitlab/src/index.ts` | 74 | Compact and focused; good self-hosted hostname handling; updates labels without validating they exist; weak hostname validation |

### Notifier Plugins

| File/Path | Score /100 | Assessment |
|-----------|------------|------------|
| `packages/plugins/notifier-discord/src/index.ts` | 78 | Best retry implementation in the notifier family; respects Retry-After header; exponential backoff with AbortController timeout; truncates descriptions to 4096 chars |
| `packages/plugins/notifier-slack/src/index.ts` | 52 | No retry logic at all — transient 503/429 errors fail immediately; no timeout on fetch; no URL validation; no message length enforcement |
| `packages/plugins/notifier-composio/src/index.ts` | 60 | Unified SDK approach is clever; promise leakage on timeout (background promise continues); no timeout on SDK dynamic import; complex Promise.race could be simplified |
| `packages/plugins/notifier-webhook/src/index.ts` | 70 | Clean retry logic with retryable vs permanent error distinction; no timeout on fetch calls; good serialization approach |
| `packages/plugins/notifier-openclaw/src/index.ts` | 72 | Good auth error detection with actionable messages; token resolution chain well-designed; console spam on every retry attempt |
| `packages/plugins/notifier-desktop/src/index.ts` | 75 | Simple and focused; proper AppleScript escaping; silent failures on unsupported platforms; no timeout on OS notification commands |

### Mobile App

| File/Path | Score /100 | Assessment |
|-----------|------------|------------|
| `packages/mobile/src/context/BackendContext.tsx` | 48 | Hardcoded `http://192.168.1.1:3000` default URL exposes internal network; WS URL auto-derived without validation; AsyncStorage on Android is world-readable |
| `packages/mobile/src/screens/SessionDetailScreen.tsx` | 42 | 742-line monolithic component handling 5+ concerns; missing useMemo/useCallback; message injection risk via comment.body interpolation; multiple inline functions causing re-renders |
| `packages/mobile/src/screens/HomeScreen.tsx` | 58 | sortSessions called on every render without memoization; headerRight recreated each render; FlatList renderItem creates inline component |
| `packages/mobile/src/types/index.ts` | 62 | 66-line getAttentionLevel with deeply nested conditionals; good type definitions otherwise; ATTENTION_COLORS well-structured |
| `packages/mobile/src/terminal/terminal-html.ts` | 50 | Global try-catch blocks with silent error suppression (3 locations); XDA handler vulnerable to CSI injection; JSON.parse from bridge without validation; reconnect without max retry limit |
| `packages/mobile/src/hooks/useSession.ts` | 68 | Good generation counter pattern for race condition prevention; fixed 5s polling without backoff; continues polling even with no active sessions |
| `packages/mobile/src/hooks/useSessions.ts` | 66 | Same polling pattern duplicated from useSession; no smart polling or exponential backoff |
| `packages/mobile/src/hooks/useSessionNotifications.ts` | 60 | Notification state tracking duplicated with backgroundTask.ts; NOTIFY_STATE_KEY in AsyncStorage never pruned |
| `packages/mobile/src/notifications/backgroundTask.ts` | 55 | Silent error suppression in catch block; no logging of failure reasons; notification logic duplicated with useSessionNotifications |
| `packages/mobile/src/screens/SettingsScreen.tsx` | 65 | Only checks protocol prefix for URL validation; weak regex for project/issue IDs |
| `packages/mobile/src/screens/OrchestratorScreen.tsx` | 64 | getZoneCounts iterates all sessions on every render without memoization |
| `packages/mobile/src/components/SessionCard.tsx` | 72 | Clean component; calls getAttentionLevel per render without caching |
| `packages/mobile/src/components/AttentionBadge.tsx` | 80 | Simple, focused component |
| `packages/mobile/src/components/StatBar.tsx` | 78 | Clean implementation |
| `packages/mobile/src/navigation/RootNavigator.tsx` | 76 | Standard navigation setup |

### OpenClaw Plugin

| File/Path | Score /100 | Assessment |
|-----------|------------|------------|
| `openclaw-plugin/index.ts` | 58 | 1456-line monolith with 14 tool handlers, hooks, and background services; O(n²) deduplication via findIndex; sanitizeCliArg defined twice; labels parameter not sanitized; blocking sync operations in hook execution; good Result pattern but "Failed to X" repeated 20+ times |
| `openclaw-plugin/index.test.ts` | 45 | Only 5 tests covering helper functions; 700+ lines of command handlers and 400+ lines of tool handlers completely untested |

---

## Detailed Findings

### Complexity & Duplication

**Cross-Plugin Duplication (Systemic — Penalty: -150)**

1. **Retry Logic Triplicated Across Notifiers**
   - `notifier-discord/src/index.ts:94-156` — Exponential backoff with rate-limit handling
   - `notifier-webhook/src/index.ts:42-84` — Similar backoff without rate-limit
   - `notifier-openclaw/src/index.ts:52-126` — Similar pattern with auth error detection
   - `notifier-slack/src/index.ts` — **Missing entirely**
   - Impact: Each plugin reimplements the same pattern; bugs fixed in one won't propagate to others

2. **Discussion Parsing Tripled in GitLab SCM**
   - `scm-gitlab/src/index.ts:635-659` (getReviews)
   - `scm-gitlab/src/index.ts:676-702` (getPendingComments)
   - `scm-gitlab/src/index.ts:704-730` (getAutomatedComments)
   - 67 lines of near-identical logic: fetch discussions → iterate notes → extract author/body/position → filter by bot/human
   - Changes must be replicated in three places

3. **Webhook Event Parsing in GitHub SCM**
   - `scm-github/src/index.ts:266-432` — 6+ event type handlers with identical structural patterns
   - Each handler: extract payload fields → construct event object → return typed result
   - Should use event handler map or strategy pattern

4. **Prompt Generation in Trackers**
   - `tracker-linear/src/index.ts:343-376` — Build lines array with labels, priority, description
   - `tracker-github/src/index.ts:182-204` — Build lines array with labels, description
   - `tracker-gitlab/src/index.ts:91-113` — Build lines array with labels, description
   - 95% identical logic across three plugins

5. **Polling Hook Logic in Mobile**
   - `mobile/src/hooks/useSession.ts:47-57` and `useSessions.ts:44-84` — Identical interval/AppState patterns
   - `mobile/src/hooks/useSessionNotifications.ts:30-59` and `notifications/backgroundTask.ts:41-58` — Duplicated notification level checking

6. **Tool Error Result Pattern in OpenClaw Plugin**
   - `openclaw-plugin/index.ts` — `{ content: [{ type: "text", text: "Failed to X" }], isError: true }` pattern repeated 20+ times across 14 tool handlers
   - `sanitizeCliArg` function defined at line 104 and again at line 702

**High-Complexity Functions**

| Function | File | Lines | Cyclomatic Complexity | Issue |
|----------|------|-------|----------------------|-------|
| `getMergeability()` | scm-github/src/index.ts | 940-1021 | 10+ | 7 distinct blocker checks, multiple API calls |
| `parseGitLabWebhookEvent()` | scm-gitlab/src/index.ts | 192-345 | 8+ | 154 lines, 5 event types, nested to 5 levels |
| `updateIssue()` | tracker-linear/src/index.ts | 432-571 | 8+ | 4-6 sequential GraphQL calls, conditional mutation chains |
| `getAttentionLevel()` | mobile/src/types/index.ts | 144-209 | 8+ | 66 lines of deeply nested conditionals for session state |
| `SessionDetailScreen` | mobile/src/screens/SessionDetailScreen.tsx | 1-392 | 10+ | 742-line monolith managing 5+ orthogonal concerns |
| `buildLiveContext()` | openclaw-plugin/index.ts | 559-598 | 6 | Blocking sync calls to external services during hook |
| `createDirectTransport()` | tracker-linear/src/index.ts | 54-123 | 6 | Manual Promise/timeout/buffer handling |

---

### Style & Convention Adherence

**Consistent Patterns (Good)**
- All plugins follow the `{ manifest, create } satisfies PluginModule<T>` pattern
- camelCase for variables/functions, PascalCase for types/components, UPPER_CASE for constants
- `parse*`, `map*`, `extract*`, `is*` naming prefixes for utility functions
- All async functions clearly marked

**Inconsistencies**

1. **Single-Letter Loop Variables**
   - `scm-gitlab/src/index.ts:642` — `d` for discussion, `s` for state, `a` for approval
   - `scm-github/src/index.ts` — `c` for check in filter callbacks
   - More descriptive names would aid readability

2. **Error Message Formatting**
   - SCM GitHub: Some include context (`"Failed to fetch CI checks"`), some don't
   - SCM GitLab: `"detectPR: failed for branch"` vs `"detectPR for branch"` — inconsistent
   - OpenClaw: 20+ variations of `"Failed to X:\n${result.error}"` without structured format
   - Trackers: Error wrapping varies (Linear wraps with cause, GitHub truncates to 3 args)

3. **Magic Strings Scattered**
   - `scm-github/src/index.ts:228-232` — Webhook defaults (`"/api/webhooks/github"`, `"x-hub-signature-256"`)
   - `mobile/src/screens/*.tsx` — Color values (`"#161b22"`) hardcoded 20+ times
   - `mobile/src/types/index.ts:34` — `"idle"`, `"sending"`, `"sent"`, `"error"` as string literal types instead of enum

4. **BOT_AUTHORS Maintenance**
   - Both `scm-github/src/index.ts:40-51` and `scm-gitlab/src/index.ts:37-46` maintain independent hardcoded bot lists
   - Should be shared or configurable

5. **MR vs PR Terminology**
   - GitLab SCM uses `PRInfo` type but the underlying API concept is "Merge Request"
   - Internal comments mix "MR" and "PR" references

---

### Readability & Maintainability

**Monolithic Files**
- `openclaw-plugin/index.ts` — 1456 lines handling hooks, commands, tools, and background services in a single file
- `scm-github/src/index.ts` — 1041 lines with 18 SCM methods in one factory function
- `scm-gitlab/src/index.ts` — 830 lines with similar structure
- `mobile/src/screens/SessionDetailScreen.tsx` — 742 lines rendering session details, PR info, CI checks, comments, message input, keyboard handling

**Factory Function Pattern**
- `createGitHubSCM()`, `createGitLabSCM()`, `createLinearTracker()`, etc. all return object literals with many methods
- No class hierarchy or shared base implementation despite significant overlap
- Makes cross-cutting concerns (logging, caching, error handling) harder to add

**Hardcoded Defaults Without Constants**
- `scm-github/src/index.ts:64` — 30s timeout as inline number
- `scm-github/src/index.ts:63` — 10MB maxBuffer as inline expression
- `scm-gitlab/src/index.ts:371` — `per_page=100` inline in URL string
- `tracker-github/src/index.ts:28` — 10MB maxBuffer, 30s timeout inline
- `openclaw-plugin/index.ts:80` — 15s default timeout inline

---

### Performance Anti-patterns

**Redundant API Calls**

1. **GitHub SCM: Duplicate CI Fetch in getMergeability**
   - `scm-github/src/index.ts:940-1021` — Calls `getCISummary()` which internally calls `getCIChecks()`, plus separate calls for reviews and pending comments
   - No result caching between method calls on the same PR

2. **GitHub SCM: Dual API Strategy Without Caching**
   - `scm-github/src/index.ts:641-679` — Tries `pr checks` first, falls back to `statusCheckRollup` GraphQL
   - Each `getCIChecks()` invocation may make 2 API requests
   - Version detection not cached across calls

3. **GitLab SCM: Triple fetchDiscussions**
   - `scm-gitlab/src/index.ts:635,677,705` — Three methods independently call `fetchDiscussions()` for the same MR
   - No caching layer; same 100-item response fetched three times

4. **Linear Tracker: Sequential Mutation Chain**
   - `tracker-linear/src/index.ts:432-571` — updateIssue makes up to 6 sequential GraphQL calls:
     - Resolve identifier → fetch workflow states → update issue → find user → update assignee → manage labels
   - Workflow states and label lists could be cached per team

**O(n²) Algorithms**

5. **OpenClaw Plugin: Issue Deduplication**
   - `openclaw-plugin/index.ts:422-427` — Uses `.filter()` with `.findIndex()` for dedup: O(n²)
   - With 30 issues × 5 repos = 150 items → 22,500 comparisons
   - Should use Set or Map for O(n)

**Missing Timeouts**

6. **Slack Notifier: No Timeout**
   - `notifier-slack/src/index.ts:121` — `fetch()` with no AbortController or timeout
   - Could hang indefinitely on unresponsive webhook server

7. **Webhook Notifier: No Timeout**
   - `notifier-webhook/src/index.ts:53` — Same issue, fetch with no timeout

**React Native Performance**

8. **Mobile: Missing Memoization**
   - `mobile/src/screens/HomeScreen.tsx:23-32` — `sortSessions()` creates new sorted array every render
   - `mobile/src/screens/SessionDetailScreen.tsx:191-192` — Filter operations on every render
   - `mobile/src/screens/OrchestratorScreen.tsx:27-34` — `getZoneCounts()` iterates all sessions per render
   - `mobile/src/screens/SessionDetailScreen.tsx:138-162` — Handlers recreated without useCallback

9. **Mobile: Fixed Polling Without Intelligence**
   - `mobile/src/hooks/useSession.ts` and `useSessions.ts` — 5-second fixed interval regardless of app state, session count, or network conditions
   - No exponential backoff or idle detection

10. **OpenClaw: Blocking Hook Execution**
    - `openclaw-plugin/index.ts:559-598` — `buildLiveContext()` makes synchronous CLI calls (15s + 10s timeouts) during prompt build hook
    - Blocks user interaction for up to 25 seconds

---

### Security & Error Handling

**Security Issues**

1. **Hardcoded Internal IP (CRITICAL)**
   - `mobile/src/context/BackendContext.tsx:7` — `const DEFAULT_URL = "http://192.168.1.1:3000"`
   - Exposes internal network topology; should use env var or be removed

2. **AsyncStorage for Sensitive URLs (HIGH)**
   - `mobile/src/context/BackendContext.tsx:59,65` — Backend and WS URLs in AsyncStorage
   - Android AsyncStorage is world-readable by default

3. **Message Injection via Comment Body (HIGH)**
   - `mobile/src/screens/SessionDetailScreen.tsx:154` — Direct string interpolation of `comment.body` into prompt message
   - Malicious PR comment could inject arbitrary instruction text

4. **Unsanitized Labels Parameter (MEDIUM)**
   - `openclaw-plugin/index.ts:392` — `options.labels` passed directly to CLI args without sanitizeCliArg
   - Could inject CLI flags like `--allow-dangerous-thing`

5. **Unsanitized PR Parameter (MEDIUM)**
   - `openclaw-plugin/index.ts:1275` — `params.pr` passed to args without sanitization

6. **WebSocket URL Auto-Derivation (MEDIUM)**
   - `mobile/src/context/BackendContext.tsx:28-35` — Derives WS URL from any hostname with hardcoded port 14801
   - If backend URL is user-controlled (Settings screen), could connect to arbitrary WS servers

7. **Terminal JSON Bridge Without Validation (MEDIUM)**
   - `mobile/src/terminal/terminal-html.ts:163` — `JSON.parse(raw)` from React Native bridge without schema validation

8. **XDA Handler CSI Injection (MEDIUM)**
   - `mobile/src/terminal/terminal-html.ts:153-156` — Responds with hardcoded XTerm identity; no input validation on CSI sequences

9. **Environment Variable Secret via Config Name (LOW)**
   - `scm-github/src/index.ts:481` — `process.env[secretName]` where secretName comes from ProjectConfig
   - If config is user-controlled, could probe env vars

10. **GraphQL Response Assumed Structure (LOW)**
    - `scm-github/src/index.ts:808-831` — Deep nesting access on GraphQL response without null guards
    - `tracker-linear/src/index.ts:310` — `data.issue.state.type` could fail if state is null

**Silent Error Suppression**

| Location | Pattern | Risk |
|----------|---------|------|
| `scm-github/src/index.ts:541-542` | `catch { return null; }` in detectPR | Masks network failures |
| `scm-github/src/index.ts:689-694` | Empty catch in getCISummary | Incorrect "failing" status if API down |
| `scm-gitlab/src/index.ts:590-601` | Nested try-catch in getCISummary | Inner catch swallows errors |
| `scm-gitlab/src/index.ts:634-659` | Discussion fetch error silently skipped | Reviews returned without discussion data |
| `tracker-linear/src/index.ts:186-187` | `catch(() => {})` on promise race loser | Hides timeout debugging info |
| `mobile/src/terminal/terminal-html.ts:82,121,166` | `catch (e) { /* ignore */ }` (3 locations) | All terminal errors silently swallowed |
| `mobile/src/notifications/backgroundTask.ts:66-68` | Returns Failed without logging reason | Background failures invisible |
| `openclaw-plugin/index.ts:271,349` | Returns empty/null on config read failure | Silent degradation |

**Missing Error Differentiation**

- `scm-github/src/index.ts:541-542` — detectPR catches all errors identically: network failure, invalid repo format, and missing CLI tool all return `null`
- `scm-gitlab/src/index.ts:500-502` — Same pattern: returns null with a console.warn but no error type distinction
- `tracker-github/src/index.ts:33` — Error message truncates to first 3 CLI args, losing context

---

## Final Verdict

The Integrations & Notifiers split contains **well-architected plugin boundaries** with a consistent interface pattern across SCM, tracker, and notifier families. The TypeScript usage is solid, webhook signature verification is cryptographically sound, and test coverage is good for the SCM and tracker plugins.

However, the codebase suffers from **systemic duplication** — retry logic, event formatting, discussion parsing, and prompt generation are independently reimplemented across plugins rather than extracted to shared utilities. This creates a maintenance burden where bug fixes in one plugin don't propagate to others.

The **mobile app** is the weakest area, with security concerns (hardcoded IP, world-readable AsyncStorage, message injection), performance issues (missing memoization, fixed-interval polling), and a 742-line monolithic screen component. It also has **no test files**.

The **openclaw-plugin** packs 1456 lines into a single file with 14 tool handlers, hooks, and background services. While the Result pattern is good, the O(n²) dedup, inconsistent input sanitization, and blocking synchronous hook execution need attention.

The **Slack notifier** stands out as the most fragile notifier — it has no retry logic, no timeout, and no URL validation, making it unreliable under transient failures.

**Major refactoring is recommended** to extract shared utilities (retry, event formatting, polling), decompose monolithic files, add missing timeouts/retries to Slack and Webhook notifiers, and address mobile app security concerns. The plugin interface pattern is sound and should be preserved.

**Score Calculation:**
- Weighted file score average: ~63/100 → 630 base
- Systemic duplication penalty: -150
- Missing retry/timeout in notifiers: -50
- Mobile security concerns: -75
- Silent error suppression pattern: -50
- O(n²) algorithm + blocking hooks: -25
- Good test coverage (SCM/trackers): +58
- Good plugin architecture: +50
- Sound webhook security: +50
- **Raw total: 438, adjusted with strengths: 588/1000**
