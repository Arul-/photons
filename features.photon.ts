/**
 * Photon Features
 *
 * Intent as metadata — one tag, automatic behavior.
 * Each slide presents a capability. Each method proves it works.
 *
 * @version 1.0.0
 * @icon 🔬
 * @stateful
 */
export default class Features {
  private visits: string[] = [];

  /**
   * Photon: Intent as Metadata
   * @format slides
   * @readOnly
   * @autorun
   */
  main() {
    return `
# Intent as Metadata

**Class-Level** — shape the photon

| Tag | What Happens |
|-----|-------------|
| \`@stateful\` | State persists to disk, survives restarts |
| \`@dependencies axios@^1.0\` | npm packages auto-installed on first run |
| \`@photon billing\` | Another photon injected as constructor param |
| \`@mcp github\` | MCP server wired into constructor |
| \`@auth required\` | Full OAuth 2.1, \`this.caller\` populated |

**Method-Level** — shape the tool

| Tag | What Happens |
|-----|-------------|
| \`@format table\` | Output auto-rendered (50+ formats) |
| \`@readOnly\` | Agent auto-approves — no user prompt |
| \`@destructive\` | Requires explicit confirmation |
| \`@cached 5m\` | Results memoized with TTL |
| \`@retryable 3 1s\` | Auto-retry on failure with backoff |
| \`@locked\` | Distributed mutex across processes |
| \`@scheduled 0 9 * * *\` | Cron job — runs without a client |

*...and 20+ more — see documentation*

---

# Single File, Full Stack

<!-- cols: 2 -->

\`\`\`typescript
export default class Todo {
  private items = [];

  /** @format table @readOnly */
  list() { return this.items; }

  /** @destructive */
  clear() { this.items = []; }
}
\`\`\`

|||

**One file. Three interfaces. Zero config.**

| Surface | Command |
|---------|---------|
| CLI | \`photon cli todo list\` |
| MCP Server | STDIO or SSE — any AI client |
| Web UI | \`photon beam\` → auto UI |

Same class. Same methods.
Three completely different surfaces.

No server setup. No route definitions.
No frontend code.

---

# Format-Driven Rendering

Change one word — the entire output transforms.

| Tag | Renders As |
|-----|-----------|
| \`@format table\` | Sortable, filterable data grid |
| \`@format chart:bar\` | Bar chart visualization |
| \`@format slides\` | Presentation deck *(you're in one)* |
| \`@format gauge\` | Real-time dial indicator |
| \`@format kanban\` | Drag-and-drop board |
| \`@format metric\` | KPI card with delta |
| \`@format steps\` | Pipeline progress tracker |
| \`@format mermaid\` | Diagrams rendered from text |
| \`@format dashboard\` | Multi-panel composite layout |

50+ formats. CLI gets a text fallback. Beam gets the full visual.
Same data. Every surface gets the right rendering.

---

# Resilience Without Code

<!-- cols: 2 -->

\`\`\`typescript
/**
 * @cached 5m
 * @retryable 3 1s
 * @timeout 30s
 * @circuitBreaker 5 30s
 * @fallback { status: 'unavailable' }
 */
status() {
  return fetch('https://api.example.com/health');
}
\`\`\`

|||

**Five behaviors. Zero implementation.**

The runtime wraps your method in a middleware pipeline:

\`timeout → retry → circuit breaker → cache → fallback\`

You write the happy path.
Tags handle everything else.

---

# State That Survives

<!-- cols: 2 -->

\`\`\`typescript
/** @stateful */
export default class Notes {
  private items: string[] = [];

  add({ text }) {
    this.items.push(text);
    return { total: this.items.length };
  }
}
\`\`\`

|||

| Capability | How |
|-----------|-----|
| Persisted to disk | Kill, restart — state is there |
| Shared across clients | CLI, Beam, MCP see the same data |
| Key-value store | \`this.memory.set()\` for complex data |
| Named instances | Multiple isolated copies |

No database. No setup.
Add \`@stateful\` and state just works.

---

# Composition

<!-- cols: 2 -->

\`\`\`typescript
/**
 * @photon billing billing-photon
 * @mcp github anthropics/mcp-server-github
 * @dependencies axios@^1.0.0
 */
export default class Dashboard {
  constructor(
    private billing: any,
    private github: any
  ) {}

  async overview() {
    const revenue = await this.billing.summary();
    const issues = await this.github.listIssues();
    return { revenue, openIssues: issues.length };
  }
}
\`\`\`

|||

**Constructor injection resolves everything:**

| Tag | Resolved To |
|-----|------------|
| \`@photon\` | Loaded from marketplace |
| \`@mcp\` | MCP server proxied as object |
| \`@dependencies\` | npm packages auto-installed |
| \`@cli\` | System tool — blocks if missing |

---

# Human + Agent, Same Surface

<!-- cols: 2 -->

\`\`\`typescript
/** @readOnly */
inventory() { ... }
// auto-approved

/** @destructive */
delete({ id }) { ... }
// confirmation required

/** @audience user */
dashboard() { ... }
// human eyes only

/** @audience assistant */
context() { ... }
// agent eyes only
\`\`\`

|||

**No \`@audience\`? Both see it. Specify one? Exclusive.**

| Tag | Human | Agent |
|-----|-------|-------|
| \`@readOnly\` | Instant | Auto-approved |
| \`@destructive\` | Confirm | Approval required |
| \`@locked\` | Waits | Serialized |
| \`@audience user\` | Sees it | Hidden |
| \`@audience assistant\` | Hidden | Sees it |

One annotation. Two audiences.
Full control over who sees what.

---

# Real-Time Streaming

<!-- cols: 2 -->

\`\`\`typescript
async *deploy() {
  yield 'Building...';
  await build();
  yield 'Testing...';
  await test();
  return 'Deployed';
}
\`\`\`

|||

**Three real-time primitives:**

| Primitive | What It Does |
|-----------|-------------|
| \`yield\` | Live update per step |
| \`this.render()\` | Push formatted output |
| \`this.emit()\` | Named events to all clients |

| Surface | How It Arrives |
|---------|---------------|
| CLI | Printed line by line |
| Beam | Live progress bar |
| MCP | SSE notification stream |
| AG-UI | Standard event types |

---

# Background & Scheduling

<!-- cols: 2 -->

\`\`\`typescript
/** @scheduled 0 9 * * 1-5 */
async dailyDigest() {
  const data = await this.gather();
  await this.memory.set('report', data);
}

/** @webhook stripe */
async handlePayment({ event }) {
  // POST /webhook/stripe → here
}

/** @async */
async generate({ quarter }) {
  // Returns task ID immediately
  // Client polls for completion
}
\`\`\`

|||

**The daemon runs jobs without a client.**

| Tag | What Happens |
|-----|-------------|
| \`@scheduled\` | Cron job — fires on time, every time |
| \`@webhook\` | HTTP POST endpoint auto-registered |
| \`@async\` | Returns task ID, runs in background |

No crontab. No separate worker process.
No webhook server to deploy.
Tags turn methods into infrastructure.

---

# Standards We Stand On

Every standard adopted is a door opened.

| Standard | What It Unlocks |
|----------|----------------|
| **MCP** (stdio + Streamable HTTP) | Claude Desktop, Cursor, Windsurf, any MCP client |
| **MCP Apps** (SEP-1865) | Custom UI rendering inside Claude Desktop, ChatGPT |
| **AG-UI Protocol** | CopilotKit, LangGraph, CrewAI, Google ADK integration |
| **A2A** (Agent-to-Agent) | Google A2A orchestrators, multi-agent discovery |
| **OAuth 2.1 + PKCE** | Google, GitHub, Microsoft — zero-config auth |
| **RFC 9728** | Protected Resource Metadata — standard OAuth discovery |
| **Server Cards** | \`/.well-known/mcp-server\` — discover without connecting |
| **Agent Cards** | \`/.well-known/agent.json\` — A2A agent discovery |
| **OpenTelemetry GenAI** | Jaeger, Zipkin, Datadog, Grafana — opt-in tracing |
| **JSON Patch** (RFC 6902) | Efficient state deltas for real-time sync |

**One photon. Discoverable by agents. Usable by humans.**
**Every protocol is a new surface your code runs on — for free.**

---

# The Runtime Layer

<!-- cols: 2 -->

\`\`\`
Standard MCP:
  Server → Raw JSON → Client
  (parse, transform, render)

Photon:
  Server → Runtime → Auto UI
              ↓
    middleware · state · events
    formats · safety · sync
\`\`\`

|||

**Between your code and the client:**

| Layer | Capability |
|-------|-----------|
| Middleware | 12 built-in phases from tags |
| State | Disk persistence + cross-client sync |
| Rendering | 50+ format types, auto-fallback |
| Isolation | Worker threads per photon |
| Daemon | Locks, pub/sub, cron, webhooks |
| Transport | CLI, STDIO, SSE, Unix socket |
| Distribution | Binary compilation to standalone |

**You write a class. Photon delivers a platform.**
`;
  }
}
