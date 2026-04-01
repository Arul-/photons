# GitHub PR Notifier Workflow Monitors GitHub PRs and sends notifications to Slack This workflow demonstrates:

Multi-MCP orchestration (GitHub + Slack) - Generator pattern for progress updates - State management via filesystem MCP

> **2 tools** · Workflow Photon · v1.18.0 · MIT

**Platform Features:** `generator` `streaming` `channels`

## ⚙️ Configuration

No configuration required.




## 🔧 Tools


### `monitor` ⚡

Monitor a repository for new PRs and notify Slack


| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `owner` | string | Yes | Repository owner |
| `repo` | string | Yes | Repository name |
| `channel` | string | Yes | Slack channel to notify |
| `labels` | string[] | No | Optional: only notify for PRs with these labels |





---


### `summary` ⚡

Get a summary of open PRs across multiple repos


| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repos` | string[] | Yes | Array of owner/repo strings |





---





## 🏗️ Architecture

```mermaid
flowchart TD
    subgraph github_pr_notifier["📦 Github Pr Notifier"]
        START([▶ Start])
        N0[📢 Checking PRs for ${params.o...]
        START --> N0
        N1[⏳ progress]
        N0 --> N1
        N2[⏳ progress]
        N1 --> N2
        N3[📢 Notifying: PR #${pr.number}]
        N2 --> N3
        N4[📝 log]
        N3 --> N4
        N5[⏳ progress]
        N4 --> N5
        N6[⏳ progress]
        N5 --> N6
        N7[📢 Checking ${owner}/${repo}]
        N6 --> N7
        N8[⏳ progress]
        N7 --> N8
        SUCCESS([✅ Success])
        N8 --> SUCCESS
    end
```


## 📥 Usage

```bash
# Install from marketplace
photon add github-pr-notifier

# Get MCP config for your client
photon info github-pr-notifier --mcp
```

## 📦 Dependencies

No external dependencies.

---

MIT · v1.18.0
