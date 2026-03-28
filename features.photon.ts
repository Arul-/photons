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

One tag. Automatic behavior. Zero boilerplate.

**Class-Level** — shape the photon

| Tag | What Happens |
|-----|-------------|
| \`@stateful\` | State persists to disk, survives restarts |
| \`@dependencies axios@^1.0\` | npm packages auto-installed on first run |
| \`@photon billing\` | Another photon injected as constructor param |
| \`@mcp github\` | MCP server wired into constructor |
| \`@auth required\` | Full OAuth 2.1, \`this.caller\` populated |
| \`@ui dashboard\` | Custom HTML template linked to methods |
| \`@worker\` | Crash-isolated in its own thread |

**Method-Level** — shape the tool

| Tag | What Happens |
|-----|-------------|
| \`@format table\` | Output auto-rendered (50+ formats) |
| \`@readOnly\` | Agent auto-approves — no user prompt |
| \`@destructive\` | Requires explicit confirmation |
| \`@cached 5m\` | Results memoized with TTL |
| \`@retryable 3 1s\` | Auto-retry on failure with backoff |
| \`@timeout 30s\` | Hard execution limit |
| \`@locked\` | Distributed mutex across processes |
| \`@scheduled 0 0 * * *\` | Cron job — runs without a client |
| \`@webhook stripe\` | HTTP POST endpoint auto-registered |

*...and 20+ more — see documentation*

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
inventory() { ... }      // auto-approved

/** @destructive */
delete({ id }) { ... }   // confirmation required

/** @locked */
transfer({ to }) { ... } // one caller at a time

/** @auth required */
admin() { ... }           // OAuth, this.caller.id
\`\`\`

| Tag | Beam (Human) | MCP (Agent) |
|-----|-------------|-------------|
| \`@readOnly\` | Instant result | Auto-approved |
| \`@destructive\` | Confirm dialog | Approval required |
| \`@locked\` | Waits for turn | Serialized access |
| \`@auth\` | Browser SSO | MCP token flow |

One annotation. Two audiences. Consistent behavior.

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

**\`yield\` = live update. \`return\` = final result.**

| Surface | Behavior |
|---------|----------|
| CLI | Prints each yield as it arrives |
| Beam | Renders live progress bar |
| MCP | Streams via SSE notifications |
| AG-UI | Maps yields to standard events |

Plus: \`this.emit('event', data)\` pushes to all connected clients.

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
