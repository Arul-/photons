# Arul's Photon Collection

Personal photon marketplace — a curated collection of niche and personal-use photons.

These photons were moved out of the official photons repo to keep the main marketplace focused on broadly useful integrations.

## Photons

### Games

| Photon | Description |
|--------|-------------|
| `connect-four` | Play Connect Four against AI with distributed locks |

### Smart Home & IoT

| Photon | Description |
|--------|-------------|
| `google-tv` | Control Google TV and Android TV devices |
| `lg-remote` | Control LG WebOS TVs |
| `tuya-smart-light` | Control Tuya/Wipro/Smart Life WiFi bulbs |

### Personal Communications

| Photon | Description |
|--------|-------------|
| `discord` | Send messages and manage Discord via webhooks |
| `telegram` | Send messages via Telegram Bot API |

### Content

| Photon | Description |
|--------|-------------|
| `content-creator` | Content creation assistant |
| `social-formatter` | Format content for social media platforms |
| `rss-feed` | Read and parse RSS/Atom feeds |
| `rss-to-slack` | Monitor RSS feeds and post new items to Slack |

### Monitoring

| Photon | Description |
|--------|-------------|
| `uptime-monitor` | Monitor website availability and send alerts |
| `github-pr-notifier` | Monitor GitHub PRs and send notifications to Slack |

### Personal Knowledge Management

| Photon | Description |
|--------|-------------|
| `knowledge-graph` | Persistent knowledge graph with entities and relations |

### Niche

| Photon | Description |
|--------|-------------|
| `booking` | Time slot reservation with distributed locks |

## Setup

```bash
npm install
```

## Usage

Each photon is a standalone `.photon.ts` file with a matching `.md` documentation file. See individual docs for configuration and usage details.

## License

MIT

<!-- PHOTON_MARKETPLACE_START -->
# arul-photons

> **Singular focus. Precise target.**

**Photons** are single-file TypeScript MCP servers that supercharge AI assistants with focused capabilities. Each photon delivers ONE thing exceptionally well - from filesystem operations to cloud integrations.

Built on the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/introduction), photons are:
- 📦 **One-command install** via [Photon CLI](https://github.com/portel-dev/photon)
- 🎯 **Laser-focused** on singular capabilities
- ⚡ **Zero-config** with auto-dependency management
- 🔌 **Universal** - works with Claude Desktop, Claude Code, and any MCP client

## 📦 Available Photons

| Photon | Focus | Tools | Features |
|--------|-------|-------|----------|
| [**A2a Gateway**](a2a-gateway.md) | A2A Gateway (Google A2A Standard) Provides a networking layer for AI agents to discover each other. Manages "Agent Cards" (Digital Business Cards) for local agents. | 3 | 🎨🎨 |
| [**Agent Router**](agent-router.md) | Agent Router — smart proxy that delegates to the right runner. Implements the same run() interface as individual runners. Routes based on the explicit `agent` parameter, or auto-classifies the prompt when autoClassify is enabled. Falls back to defaultAgent when no agent is specified and autoClassify is off. | 5 | 🎨🎨 |
| [**Agent Runner**](agent-runner.md) | Agent Runner — executes Claude agents locally per WhatsApp group. Each group gets an isolated working directory with its own CLAUDE.md for persistent memory. Spawns `claude -p` as a subprocess with the group folder as cwd. Manages concurrency so multiple groups don't overwhelm the system. | 5 | 🎨🎨 |
| [**Aider Runner**](aider-runner.md) | Aider Runner — executes Aider AI coding assistant per group folder. Spawns `aider --message` as a subprocess in the group folder for targeted code edits and refactoring tasks. Injects conversation memory from previous runs. Manages concurrency across groups. | 4 | - |
| [**Bazaar**](bazaar.md) | P2P Bazaar — The Instant Help Market (Reputation Edition) | 0 | - |
| [**Chat**](chat.md) | Chat — browser-based messaging channel for testing claw pipelines. Wire-compatible with WhatsApp/Telegram channel interface. Groups stored as nested object — single instance per tenant. | 7 | 🎨📡 |
| [**Claude Runner**](claude-runner.md) | Claude Runner — executes Claude agents locally per group folder. Each group gets an isolated working directory with its own CLAUDE.md for persistent memory. Spawns `claude -p` as a subprocess with the group folder as cwd. Manages concurrency so multiple groups don't overwhelm the system. Includes conversation memory injection for groups without a live session. | 4 | - |
| [**Claw**](claw.md) | Claw — orchestrates messaging ↔ Claude agent pipeline. Subscribe to WhatsApp, Telegram, and Chat groups, route messages to an agent runner, and send responses back. Uses channel .on() for event-driven message handling with group and trigger filtering. | 21 | ⚡🎨⚡📡🎨 |
| [**Connect Four**](connect-four.md) | Play against AI with distributed locks Classic Connect Four game where you drop discs into columns trying to get four in a row. The AI opponent uses minimax with alpha-beta pruning to play strategically. Distributed locks ensure no two moves happen simultaneously - critical when multiple clients connect to the same game. | 7 | ⚡🎨📡 |
| [**Content Creator Photon AI-powered content research and publishing workflow. Demonstrates Photon composition**](content-creator.md) | depends on web.photon and social-formatter.photon Workflow: 1. Research: Search web for topics, fetch and summarize content 2. Write: AI generates article/post from research 3. Format: Convert to platform-specific formats 4. Publish: Post to selected social media (manual for now) | 4 | ⚡💬⚡ |
| [**Courier**](courier.md) | Max inbox age before cleanup (7 days) | 5 | 📡 |
| [**Data Sync Workflow**](data-sync.md) | Synchronizes data between sources | 3 | ⚡⚡ |
| [**Discord**](discord.md) | Send messages and manage Discord via webhooks Like n8n's Discord node - notifications, alerts, and automation Perfect for: - Alert notifications - Build/deploy notifications - Automated reports - Team notifications | 6 | - |
| [**Email**](email.md) | SMTP and IMAP email operations | 8 | - |
| [**Features**](features.md) | Photon Features Intent as metadata — one tag, automatic behavior. Each slide presents a capability. Each method proves it works. | 3 | - |
| [**Form Inbox**](form-inbox.md) | Webhook-powered form submission collector | 8 | 📡 |
| [**Gemini Runner**](gemini-runner.md) | Gemini Runner — executes Gemini CLI agents locally per group folder. Spawns `gemini -p` as a subprocess with the group folder as cwd. Injects conversation memory from previous runs since Gemini CLI has no native session continuity. Manages concurrency so multiple groups don't overwhelm the system. | 4 | - |
| [**Git Box**](git-box.md) | Mailbox-style Git interface, manage repos like an inbox | 56 | ⚡🎨💬 |
| [**GitHub PR Notifier Workflow Monitors GitHub PRs and sends notifications to Slack This workflow demonstrates:**](github-pr-notifier.md) | Multi-MCP orchestration (GitHub + Slack) - Generator pattern for progress updates - State management via filesystem MCP | 2 | ⚡⚡📡 |
| [**Google Calendar**](google-calendar.md) | Schedule and manage events | 9 | - |
| [**Google TV Remote**](google-tv.md) | Control Google TV and Android TV devices Provides comprehensive control of Google TV / Android TV devices via network. Uses the Android TV Remote protocol v2 (same as Google TV mobile app). Supports discovery, pairing, media control, app management, and more. Common use cases: - Control: "Turn off the TV", "Set volume to 50" - Media: "Play/pause the current content" - Apps: "Launch Netflix", "Open YouTube" - Navigation: "Press home", "Go back" Example: connect({ ip: "192.168.1.100" })  // Will prompt for pairing code if needed Configuration: - credentials_file: Path to store TV credentials (optional, default: "google-tv-credentials.json") Dependencies are auto-installed on first run. | 37 | ⚡💬⚡📡 |
| [**Group Scheduler**](group-scheduler.md) | Group Scheduler — dynamic scheduled tasks for WhatsApp groups. Each task runs a prompt against a group context on a cron schedule. When a task fires, it emits { type: 'task:fire' } — the agent runner (e.g. nanoclaw's container-runner) handles execution. Uses this.schedule for runtime-managed cron execution and this.memory to persist task definitions. | 7 | 🎨🎨 |
| [**Integration Demo**](integration-demo.md) | Integration Demo — Dependencies, Assets, Stateful Workflows | 5 | ⚡🎨 |
| [**Kanban**](kanban.md) | Kanban Board Photon Task management for humans and AI. Use named instances (`_use('project-name')`) for per-project boards. Perfect for project planning, AI working memory across sessions, and human-AI collaboration on shared tasks. | 19 | ⚡🎨📡 |
| [**Kitchen Sink**](kitchen-sink.md) | Kitchen Sink Photon Demonstrates every feature of the Photon runtime with meaningfully named functions. Use this as a reference for building your own photons. | 25 | ⚡🎨 |
| [**Knowledge Graph**](knowledge-graph.md) | P2P Knowledge Graph — Shared Research & Discovery Build and collaborate on a semantic knowledge graph. Features: Local graph storage, P2P sync, and AI-powered concept extraction. | 5 | 🎨 |
| [**LG Remote**](lg-remote.md) | Control LG WebOS TVs Provides comprehensive control of LG WebOS Smart TVs via network. Supports discovery, pairing, media control, app management, and more. Uses SSAP (Smart Service Access Protocol) over WebSocket. Common use cases: - Discovery: "Find LG TVs on my network" - Control: "Turn off the TV", "Set volume to 50" - Media: "Play/pause the current content" - Apps: "Launch Netflix", "Show running apps" Example: discover() then connect({ ip: "192.168.1.100" }) Configuration: - credentials_file: Path to store TV credentials (optional, default: "lg-tv-credentials.json") Dependencies are auto-installed on first run. | 27 | - |
| [**Lookout**](lookout.md) | Lookout — Local AI UI Inspector Sees your UI, finds issues, validates promises, and tests interactions. Runs Qwen3-VL locally on Apple Silicon via MLX — zero API cost, fully offline. | 9 | 🎨 |
| [**Matchmaker**](matchmaker.md) | P2P Matchmaker Infrastructure A lightweight MCP for managing P2P connection pools and availability. The Host AI uses these tools to register the user and discover peers. | 4 | 🎨🎨 |
| [**MCP Orchestrator**](mcp-orchestrator.md) | Combine multiple MCPs into powerful workflows | 10 | 🔌 |
| [**Mentor**](mentor.md) | Mentor — reviews agent journals, evolves personas, manages skills. The "3am agent" that makes other agents better over time. Reads an agent's journal entries, conversation history, and current persona, then proposes improvements. All changes are git-committed for auditability. Can be triggered by: cron schedule, manual invocation, conversation threshold, or skill gap detection. | 12 | - |
| [**Mesh Agent Ide**](mesh-agent-ide.md) | Mesh Agent IDE — Personality & Goal Configuration Customize the 'brains' of your local mesh agents. Define personalities, learning goals, and tool permissions. | 4 | 🎨🎨 |
| [**Mesh Dashboard**](mesh-dashboard.md) | Mesh Dashboard — The Live Heart of your P2P Economy Aggregates metrics, wealth, and reputation from across the Mesh. Your central command for monitoring mission performance and bazaar activity. | 2 | 🎨🎨 |
| [**Mesh Learning Bridge**](mesh-learning-bridge.md) | Mesh Learning Bridge — Agent-to-Agent Knowledge Protocol Allows AI agents to extract, store, and share semantic learnings from P2P missions. Builds a local knowledge base of successful patterns and skills. | 3 | 🎨🎨 |
| [**Mesh Marketplace**](mesh-marketplace.md) | Mesh Marketplace — Discover & Install Photons The central hub for expanding your local mesh ecosystem. Discover specialized agents, tools, and visual workspaces. | 4 | 🎨 |
| [**Mesh Orchestrator**](mesh-orchestrator.md) | Mesh Orchestrator — Autonomous Task Decomposition Breaks down complex objectives into discrete P2P Missions. Automatically broadcasts tasks to the Bazaar and tracks completion. | 4 | 🎨🎨 |
| [**Mesh Search**](mesh-search.md) | Mesh Search — Universal Discovery for your P2P History Find anything across your entire mesh: snapshots, missions, learnings, and agents. Features: Cross-memory scanning and AI-powered semantic search. | 3 | 🎨🎨 |
| [**Mesh Settings**](mesh-settings.md) | Mesh Control Center — Global Settings & Themes The central brain for your P2P Mesh identity and appearance. Manages shared profile, wallet status, and UI themes across all mesh photons. | 4 | 🎨 |
| [**Message Router**](message-router.md) | Message Router — routes inbound WhatsApp messages to Claude agents. Maintains a registry of groups/chats. When a message arrives via `route()`, it checks the trigger pattern and registered groups, then emits a routing decision for the agent runner to act on. Pair with whatsapp (poll its pending() method and call router.route() for each message). | 5 | - |
| [**Opencode Runner**](opencode-runner.md) | OpenCode Runner — executes OpenCode AI coding agents per group folder. Spawns `opencode` as a subprocess in the group folder. Injects conversation memory from previous runs since OpenCode has no native session continuity. Manages concurrency across groups. | 4 | - |
| [**Operator**](operator.md) | Operator — macOS computer-use photon Direct macOS interaction through Peekaboo with optional local-model planning. Designed as a desktop operator, separate from Lookout's web/visual QA role. | 3 | - |
| [**P2p Voice**](p2p-voice.md) | P2P Work Mesh (Artifacts & Presence) A universal marketplace for P2P services. Supports: Voice/Video Missions, Digital Asset Delivery, and Proof-of-Work. | 4 | 🎨 |
| [**Portfolio**](portfolio.md) | P2P Portfolio — The Visual Track Record Showcases collaboration snapshots and mission history. Helps you build trust and proof-of-work in the P2P Mesh. | 3 | 🎨 |
| [**Preferences Photon**](preferences.md) | MCP App with UI assets and settings | 7 | ⚡🎨💬⚡ |
| [**RSS Feed**](rss-feed.md) | Read and parse RSS/Atom feeds Like n8n's RSS Read node - monitor blogs, news, and content feeds Perfect for: - Content aggregation - News monitoring - Blog post notifications - Podcast feed parsing | 5 | - |
| [**Rss To Slack**](rss-to-slack.md) | RSS to Slack Workflow Monitors RSS feeds and posts new items to Slack This demonstrates: 1. Using `@mcp` to declare MCP dependencies 2. Generator pattern with yield for interactive workflows 3. Multi-MCP orchestration in a single Photon | 2 | ⚡💬⚡📡 |
| [**Truth Serum**](serum.md) | Forces unfiltered honesty, no hedging or diplomacy | 10 | - |
| [**Slides**](slides.md) | Slides — AI-Native Marp Presentation Tool Manages presentations using the Marp Markdown format. Supports real-time AI-controlled slide transitions and high-fidelity rendering. | 8 | 🎨 |
| [**Social Formatter**](social-formatter.md) | Social Media Formatter Takes markdown content and formats it optimally for different social media platforms. Each platform has different constraints (character limits, formatting support, etc.) | 4 | - |
| [**Spreadsheet**](spreadsheet.md) | Spreadsheet — CSV-backed spreadsheet with formulas A spreadsheet engine that works on plain CSV files. Formulas (=SUM, =AVG, etc.) are stored directly in CSV cells and evaluated at runtime. Named instances map to CSV files: `_use('budget')` → `budget.csv` in your spreadsheets folder. Pass a full path to open any CSV: `_use('/path/to/data.csv')`. | 37 | 🎨🎨 |
| [**Team Dashboard**](team-dashboard.md) | Team Dashboard Photon A TV/monitor-optimized dashboard that aggregates data from multiple photons to give the whole team visibility into project progress. Perfect for office displays, war rooms, or remote team syncs. | 20 | 🎨🎨 |
| [**Telegram**](telegram.md) | Max age for queued messages before they're dropped on flush (1 hour) | 12 | 📡 |
| [**Tuya Smart Light**](tuya-smart-light.md) | Control Tuya/Wipro/Smart Life WiFi bulbs Provides comprehensive control of Tuya-based smart lights via local network. Automatically syncs devices from Tuya Cloud and discovers them on local network. Common use cases: - Setup: "Configure Tuya Cloud credentials once" - List: "Show all my smart lights" - Control: "Turn on Living Room", "Set brightness to 50%" - Color: "Set color to red", "Set warm white" Example workflow: 1. setup({ client_id, client_secret, region }) - Configure Tuya Cloud (one-time) 2. list() - See all devices (auto-synced from cloud + local network) 3. on({ name: "Living Room" }) - Control by name or device_id Setup Guide for Tuya Cloud API: 1. Create account at https://iot.tuya.com/ 2. Create a new Cloud Project 3. Link your Smart Life app account (scan QR in "Me" tab) 4. Get Access ID (client_id) and Access Secret (client_secret) 5. Enable "Device Management" API permission 6. Wait ~10 minutes for permissions to activate 7. Run setup() once with your credentials All device data and credentials stored in ~/.photon/tuya-smart-light.json Dependencies are auto-installed on first run. | 9 | - |
| [**Uptime Monitor Workflow Monitors website availability and sends alerts This workflow demonstrates:**](uptime-monitor.md) | HTTP health checks via fetch - Multi-channel notifications (Slack + optional Telegram) - State persistence for incident tracking | 3 | ⚡💬⚡📡 |
| [**Webrtc Chat**](webrtc-chat.md) | WebRTC P2P Video Chat A peer-to-peer video, voice, and text chat application using WebRTC. Uses PeerJS for cloud signaling so no backend deployment is required. | 3 | 🎨 |
| [**Whatsapp**](whatsapp.md) | Max age for queued messages before they're dropped on flush (1 hour) | 35 | 🎨📡🎨 |
| [**Workspace**](workspace.md) | P2P Collaborative Workspace (with AI Assistant) | 1 | - |


**Total:** 57 photons ready to use

---

## 🚀 Quick Start

### 1. Install Photon

```bash
bun add -g @portel/photon
```

### 2. Add Any Photon

```bash
photon add filesystem
photon add git
photon add aws-s3
```

### 3. Use It

```bash
# Run as MCP server
photon mcp filesystem

# Get config for your MCP client
photon get filesystem --mcp
```

Output (paste directly into your MCP client config):
```json
{
  "mcpServers": {
    "filesystem": {
      "command": "photon",
      "args": ["mcp", "filesystem"]
    }
  }
}
```

Add the output to your MCP client's configuration. **Consult your client's documentation** for setup instructions.

**That's it!** Your AI assistant now has 57 focused tools at its fingertips.

---

## 🎨 Claude Code Integration

This marketplace is also available as a **Claude Code plugin**, enabling seamless installation of individual photons directly from Claude Code's plugin manager.

### Install as Claude Code Plugin

```bash
# In Claude Code, run:
/plugin marketplace add portel-dev/photons
```

Once added, you can install individual photons:

```bash
# Install specific photons you need
/plugin install filesystem@photons-marketplace
/plugin install git@photons-marketplace
/plugin install knowledge-graph@photons-marketplace
```

### Benefits of Claude Code Plugin

- **🎯 Granular Installation**: Install only the photons you need
- **🔄 Auto-Updates**: Plugin stays synced with marketplace
- **⚡ Zero Config**: Photon CLI auto-installs on first use
- **🛡️ Secure**: No credentials shared with AI (interactive setup available)
- **📦 Individual MCPs**: Each photon is a separate installable plugin

### How This Plugin Is Built

This marketplace doubles as a Claude Code plugin through automatic generation:

```bash
# Generate marketplace AND Claude Code plugin files
photon maker sync --claude-code
```

This single command:
1. Scans all `.photon.ts` files
2. Generates `.marketplace/photons.json` manifest
3. Creates `.claude-plugin/marketplace.json` for Claude Code
4. Generates documentation for each photon
5. Creates auto-install hooks for seamless setup

**Result**: One source of truth, two distribution channels (Photon CLI + Claude Code).

---

## ⚛️ What Are Photons?

**Photons** are laser-focused modules - each does ONE thing exceptionally well:
- 📁 **Filesystem** - File operations
- 🐙 **Git** - Repository management
- ☁️ **AWS S3** - Cloud storage
- 📅 **Google Calendar** - Calendar integration
- 🕐 **Time** - Timezone operations
- ... and more

Each photon delivers **singular focus** to a **precise target**.

**Key Features:**
- 🎯 Each photon does one thing perfectly
- 📦 57 production-ready photons available
- ⚡ Auto-installs dependencies
- 🔧 Works out of the box
- 📄 Single-file design (easy to fork and customize)

## 🎯 The Value Proposition

### Before Photon

For each MCP server:
1. Find and clone the repository
2. Install dependencies manually
3. Configure environment variables
4. Write MCP client config JSON by hand
5. Repeat for every server

### With Photon

```bash
# Install from marketplace
photon add filesystem

# Get MCP config
photon get filesystem --mcp
```

Output (paste directly into your MCP client config):
```json
{
  "mcpServers": {
    "filesystem": {
      "command": "photon",
      "args": ["mcp", "filesystem"]
    }
  }
}
```

**That's it.** No dependencies, no environment setup, no configuration files.

**Difference:**
- ✅ One CLI, one command
- ✅ Zero configuration
- ✅ Instant installation
- ✅ Auto-dependencies
- ✅ Consistent experience

## 💡 Use Cases

**For Claude Users:**
```bash
photon add filesystem git github-issues
photon get --mcp  # Get config for all three
```
Add to Claude Desktop → Now Claude can read files, manage repos, create issues

**For Teams:**
```bash
photon add postgres mongodb redis
photon get --mcp
```
Give Claude access to your data infrastructure

**For Developers:**
```bash
photon add docker git slack
photon get --mcp
```
Automate your workflow through AI

## 🔍 Browse & Search

```bash
# List all photons
photon get

# Search by keyword
photon search calendar

# View details
photon get google-calendar

# Upgrade all
photon upgrade
```

## 🏢 For Enterprises

Create your own marketplace:

```bash
# 1. Organize photons
mkdir company-photons && cd company-photons

# 2. Generate marketplace
photon maker sync

# 3. Share with team
git push origin main

# Team members use:
photon marketplace add company/photons
photon add your-internal-tool
```

---

**Built with singular focus. Deployed with precise targeting.**

Made with ⚛️ by [Portel](https://github.com/portel-dev)

<!-- PHOTON_MARKETPLACE_END -->
