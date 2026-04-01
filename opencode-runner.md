# Opencode Runner

OpenCode Runner — executes OpenCode AI coding agents per group folder. Spawns `opencode` as a subprocess in the group folder. Injects conversation memory from previous runs since OpenCode has no native session continuity. Manages concurrency across groups.

> **4 tools** · API Photon · v1.0.0 · MIT

**Platform Features:** `stateful`

## ⚙️ Configuration

No configuration required.




## 🔧 Tools


### `run`

Run a prompt against a group's context using OpenCode. Returns the agent's text response.


| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `groupFolder` | string | Yes | Group folder name (e.g. `"dev-team"`) |
| `prompt` | string | Yes | The prompt to send to OpenCode (e.g. `"Fix the failing tests"`) |
| `chatJid` | string | No | Chat JID for result routing (passed through in events) |
| `systemPrompt` | string | No | Optional system context prepended to the prompt |
| `agent` | string | No | Agent name (ignored — satisfies router contract) |





---


### `status`

Check what's currently running and queued.





---


### `kill`

Kill a running agent for a group.


| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `groupFolder` | string | Yes | Group folder to kill |





---


### `groups`

List all group folders managed by this runner.





---





## 🏗️ Architecture

```mermaid
flowchart LR
    subgraph opencode_runner["📦 Opencode Runner"]
        direction TB
        PHOTON((🎯))
        T0[▶️ run]
        PHOTON --> T0
        T1[🔧 status]
        PHOTON --> T1
        T2[🔧 kill]
        PHOTON --> T2
        T3[🔧 groups]
        PHOTON --> T3
    end
```


## 📥 Usage

```bash
# Install from marketplace
photon add opencode-runner

# Get MCP config for your client
photon info opencode-runner --mcp
```

## 📦 Dependencies

No external dependencies.

---

MIT · v1.0.0
