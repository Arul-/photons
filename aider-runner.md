# Aider Runner

Aider Runner — executes Aider AI coding assistant per group folder. Spawns `aider --message` as a subprocess in the group folder for targeted code edits and refactoring tasks. Injects conversation memory from previous runs. Manages concurrency across groups.

> **4 tools** · API Photon · v1.0.0 · MIT

**Platform Features:** `stateful`

## ⚙️ Configuration

No configuration required.




## 🔧 Tools


### `run`

Run a coding task against a group's context using Aider. Returns the agent's text response.


| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `groupFolder` | string | Yes | Group folder name (e.g. `"dev-team"`) |
| `prompt` | string | Yes | The coding task to send to Aider (e.g. `"Refactor the auth module"`) |
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
    subgraph aider_runner["📦 Aider Runner"]
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
photon add aider-runner

# Get MCP config for your client
photon info aider-runner --mcp
```

## 📦 Dependencies

No external dependencies.

---

MIT · v1.0.0
