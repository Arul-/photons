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

*...and 30+ more — see documentation*

---

# Single File, Full Stack

\`\`\`typescript
export default class Todo {
  private items = [];

  /** @format table @readOnly */
  list() { return this.items; }

  /** @destructive */
  clear() { this.items = []; }
}
\`\`\`

**One file. Three interfaces. Zero config.**

| Surface | Command |
|---------|---------|
| CLI | \`photon cli todo list\` |
| MCP Server | STDIO or SSE — any AI client connects |
| Web UI | \`photon beam\` → auto-generated forms & rendering |

Same class. Same methods. Three completely different surfaces.
No server setup. No route definitions. No frontend code.

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

**Five behaviors. Zero lines of implementation.**

The runtime wraps your method in a middleware pipeline:

\`timeout → retry → circuit breaker → cache → fallback\`

You write the happy path. Tags handle everything else.

---

# State That Survives

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

| Capability | How |
|-----------|-----|
| Persisted to disk | Kill the process, restart — state is there |
| Shared across clients | CLI, Beam, MCP all see the same instance |
| Key-value store | \`this.memory.set()\` for complex data |
| Named instances | Multiple isolated copies of one photon |

No database. No setup. Add \`@stateful\` and state just works.

---

# Composition

\`\`\`typescript
/**
 * @photon billing billing-photon
 * @mcp github anthropics/mcp-server-github
 * @dependencies axios@^1.0.0
 */
export default class Dashboard {
  constructor(private billing: any, private github: any) {}

  async overview() {
    const revenue = await this.billing.summary();
    const issues = await this.github.listIssues();
    return { revenue, openIssues: issues.length };
  }
}
\`\`\`

**Constructor injection resolves everything:**

| Tag | Resolved To |
|-----|------------|
| \`@photon\` | Loaded from marketplace, wired as instance |
| \`@mcp\` | MCP server connected, proxied as object |
| \`@dependencies\` | npm packages installed on first run |
| \`@cli\` | System tool — blocks load if missing |

---

# Human + Agent, Same Surface

\`\`\`typescript
/** @readOnly */
inventory() { ... }       // auto-approved

/** @destructive */
delete({ id }) { ... }    // confirmation required

/** @audience user */
dashboard() { ... }        // human eyes only

/** @audience assistant */
context() { ... }          // agent eyes only
\`\`\`

**No \`@audience\`? Both see it. Specify one? Exclusive.**

| Tag | Beam (Human) | MCP (Agent) |
|-----|-------------|-------------|
| \`@readOnly\` | Instant result | Auto-approved |
| \`@destructive\` | Confirm dialog | Approval required |
| \`@locked\` | Waits for turn | Serialized access |
| \`@audience user\` | Sees the result | Result hidden |
| \`@audience assistant\` | Result hidden | Sees the result |

One annotation. Two audiences. Full control over who sees what.

---

# Real-Time Streaming

\`\`\`typescript
async *deploy() {
  yield 'Building...';
  await build();
  yield 'Testing...';
  await test();
  return 'Deployed';
}
\`\`\`

**Three real-time primitives:**

| Primitive | What It Does |
|-----------|-------------|
| \`yield\` | Stream progress — each yield is a live update |
| \`this.render()\` | Push formatted output mid-execution |
| \`this.emit()\` | Fire named events to all connected clients |

| Surface | How It Arrives |
|---------|---------------|
| CLI | Printed line by line as it streams |
| Beam | Live progress bar / re-rendered UI |
| MCP | SSE notification stream |
| AG-UI | Mapped to standard event types |

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

\`\`\`
Standard MCP:
  Server → Raw JSON → Client must parse, transform, render

Photon:
  Server → Runtime → Typed Data → Auto UI
              ↓
    middleware · state · events · formats · safety
\`\`\`

**Between your code and the client, the runtime provides:**

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
