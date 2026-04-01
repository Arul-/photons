# Rss To Slack

RSS to Slack Workflow Monitors RSS feeds and posts new items to Slack This demonstrates: 1. Using `@mcp` to declare MCP dependencies 2. Generator pattern with yield for interactive workflows 3. Multi-MCP orchestration in a single Photon

> **2 tools** · Workflow Photon · v1.18.0 · MIT

**Platform Features:** `generator` `elicitation` `streaming` `channels`

## ⚙️ Configuration

No configuration required.




## 🔧 Tools


### `monitor` ⚡

Monitor an RSS feed and post new items to Slack Uses generators to emit progress updates





---


### `setup` ⚡

Interactive setup - asks user for configuration





---





## 🏗️ Architecture

```mermaid
flowchart TD
    subgraph rss_to_slack["📦 Rss To Slack"]
        START([▶ Start])
        N0[📢 Fetching RSS feed: ${params...]
        START --> N0
        N1[⏳ progress]
        N0 --> N1
        N2[⏳ progress]
        N1 --> N2
        N3[📢 Posting: ${item.title}]
        N2 --> N3
        N4[📝 log]
        N3 --> N4
        N5[⏳ progress]
        N4 --> N5
        N6[⏳ progress]
        N5 --> N6
        N7{✏️ text}
        N6 --> N7
        N8{✏️ text}
        N7 --> N8
        N9{🙋 confirm}
        N8 --> N9
        N10([❌ Cancelled])
        N9 -->|No| N10
        N9 -->|Yes| N11
        N11[Continue]
        SUCCESS([✅ Success])
        N11 --> SUCCESS
    end
```


## 📥 Usage

```bash
# Install from marketplace
photon add rss-to-slack

# Get MCP config for your client
photon info rss-to-slack --mcp
```

## 📦 Dependencies

No external dependencies.

---

MIT · v1.18.0
