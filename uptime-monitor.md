# Uptime Monitor Workflow Monitors website availability and sends alerts This workflow demonstrates:

HTTP health checks via fetch - Multi-channel notifications (Slack + optional Telegram) - State persistence for incident tracking

> **3 tools** · Workflow Photon · v1.18.0 · MIT

**Platform Features:** `generator` `elicitation` `streaming` `channels`

## ⚙️ Configuration

No configuration required.




## 🔧 Tools


### `check` ⚡

Check multiple URLs and alert on failures


| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `urls` | string[] | Yes | URLs to monitor |
| `channel` | string | Yes | Slack channel for alerts |
| `timeout` | number | No | Request timeout in ms |





---


### `setup` ⚡

Interactive setup to configure monitoring





---


### `stats`

Get uptime statistics from historical data





---





## 🏗️ Architecture

```mermaid
flowchart TD
    subgraph uptime_monitor["📦 Uptime Monitor"]
        START([▶ Start])
        N0[📢 Checking ${params.urls.leng...]
        START --> N0
        N1[📢 Checking: ${url}]
        N0 --> N1
        N2[📝 log]
        N1 --> N2
        N3[📝 log]
        N2 --> N3
        N4[📝 log]
        N3 --> N4
        N5[📝 log]
        N4 --> N5
        N6[⏳ progress]
        N5 --> N6
        N7[⏳ progress]
        N6 --> N7
        N8{✏️ text}
        N7 --> N8
        N9{✏️ text}
        N8 --> N9
        N10{🙋 confirm}
        N9 --> N10
        N11([❌ Cancelled])
        N10 -->|No| N11
        N10 -->|Yes| N12
        N12[Continue]
        SUCCESS([✅ Success])
        N12 --> SUCCESS
    end
```


## 📥 Usage

```bash
# Install from marketplace
photon add uptime-monitor

# Get MCP config for your client
photon info uptime-monitor --mcp
```

## 📦 Dependencies

No external dependencies.

---

MIT · v1.18.0
