# Claw

Claw — orchestrates messaging ↔ Claude agent pipeline. Subscribe to WhatsApp, Telegram, and Chat groups, route messages to an agent runner, and send responses back. Uses channel .on() for event-driven message handling with group and trigger filtering.

> **21 tools** · Workflow Photon · v4.0.0 · MIT

**Platform Features:** `generator` `custom-ui` `streaming` `stateful` `channels` `dashboard`

## ⚙️ Configuration


| Variable | Required | Type | Description |
|----------|----------|------|-------------|
| `CLAW_WHATSAPP` | Yes | any | No description available |
| `CLAW_TELEGRAM` | Yes | any | No description available |
| `CLAW_ROUTER` | Yes | any | No description available |
| `CLAW_COURIER` | Yes | any | No description available |
| `CLAW_CHAT` | Yes | any | No description available |
| `CLAW_MENTOR` | Yes | any | No description available |




## 📋 Quick Reference

| Method | Description |
|--------|-------------|
| `main` | Claw Pipeline Dashboard |
| `start` ⚡ | Start the pipeline: verify channel connections, subscribe to registered groups. |
| `stop` | Stop the pipeline. |
| `register` | Register a group or chat for agent routing. |
| `unregister` | Remove a group from routing. |
| `configure` | Update configuration for a registered group. |
| `senders` | List allowed senders for a group. |
| `allow` | Add a phone number to a group's allowed senders list. |
| `deny` | Remove a phone number from a group's allowed senders list. |
| `history` | View recent message history for a group. |
| `clear` | Clear the in-memory message log for a group. |
| `task` | Schedule a recurring or one-time agent run for a group. |
| `cancel` | Cancel a scheduled task by name. |
| `tasks` | List all scheduled tasks. |
| `inject` | Inject a synthetic message into the pipeline for E2E testing. |
| `groups` | List available groups from all connected channels. |
| `health` | Show latest health check result. |
| `status` | Show pipeline status. |
| `compact` | Compact conversation history into bucketed memory files. |
| `reset` | Start a new session — archives current conversation and resets context. |
| `skills` | View or manage skills for an agent group. |


## 🔧 Tools


### `main`

Claw Pipeline Dashboard





---


### `start` ⚡

Start the pipeline: verify channel connections, subscribe to registered groups. Streams progress while waiting for channels to connect.





---


### `stop`

Stop the pipeline.





---


### `register`

Register a group or chat for agent routing. Searches both WhatsApp and Telegram for a matching group name.


| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `group` | string | Yes | Group or chat name (partial match) (e.g. `"Learn CS"`) |
| `trigger` | string | Yes | Trigger word to activate the agent (empty = participant mode) (e.g. `"@"`) |
| `folders` | string[] | Yes | Folder names the agent can access — first is the primary context folder (e.g. `["lura", "photon"]`) |
| `channel` | 'whatsapp' | 'telegram' | 'chat' | No | Force a specific channel ('whatsapp'|'telegram'|'chat') — auto-detected if omitted [choice: whatsapp, telegram, chat] |
| `requiresTrigger` | boolean | No | Only route messages containing the trigger |
| `systemPrompt` | string | No | System prompt prepended to every agent run for this group (e.g. `"You are Lura, a concise personal assistant."`) |
| `agent` | string | No | Agent to use for this group ('claude'|'gemini'|'aider'|'opencode'|'auto') (e.g. `"claude"`) |
| `schedule` | string | No | Delivery schedule via courier (omit for real-time) [choice: @5m, @15m, @30m, @hourly, @daily] |





---


### `unregister`

Remove a group from routing.


| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `group` | string | Yes | Group name (partial match) (e.g. `"Learn CS"`) |





---


### `configure`

Update configuration for a registered group. Only provided fields are changed; omitted fields stay as-is.


| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `group` | string | Yes | Group name (partial match) (e.g. `"Arul and Lura"`) |
| `trigger` | string | No | New trigger word (empty string = participant mode) (e.g. `"@"`) |
| `folders` | string[] | No | New folder list (e.g. `["lura", "photon"]`) |
| `requiresTrigger` | boolean | No | Override trigger requirement |
| `systemPrompt` | string | No | System prompt for this group's agent (e.g. `"You are Lura, a concise personal assistant."`) |
| `agent` | string | No | Switch to a different agent ('claude'|'gemini'|'aider'|'opencode'|'auto') (e.g. `"gemini"`) |
| `schedule` | string | No | Delivery schedule via courier (empty string to remove, omit to keep) [choice: @5m, @15m, @30m, @hourly, @daily] |





---


### `senders`

List allowed senders for a group. Empty = all senders allowed. Auto-seeded with your own number when claw starts.


| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `group` | string | Yes | Group name (partial match) (e.g. `"Arul and Lura"`) |





---


### `allow`

Add a phone number to a group's allowed senders list.


| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `group` | string | Yes | Group name (partial match) (e.g. `"Arul and Lura"`) |
| `phone` | string | Yes | Phone number to allow (e.g. `"+60123456789"`) |





---


### `deny`

Remove a phone number from a group's allowed senders list. At least one sender must remain.


| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `group` | string | Yes | Group name (partial match) (e.g. `"Arul and Lura"`) |
| `phone` | string | Yes | Phone number to remove (e.g. `"+60123456789"`) |





---


### `history`

View recent message history for a group.


| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `group` | string | Yes | Group name (partial match) (e.g. `"Arul and Lura"`) |
| `limit` | number | No | Number of recent messages to show |





---


### `clear`

Clear the in-memory message log for a group.


| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `group` | string | Yes | Group name (partial match) (e.g. `"Arul and Lura"`) |





---


### `task`

Schedule a recurring or one-time agent run for a group. Uses cron syntax or


| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `group` | string | Yes | Group name (partial match) (e.g. `"Arul and Lura"`) |
| `prompt` | string | Yes | Prompt to send to the agent (e.g. `"Summarise today's messages"`) |
| `cron` | string | Yes | Cron expression or shorthand (e.g. `"0 9 * * *"`) |
| `name` | string | No | Optional task name for later reference (e.g. `"morning-summary"`) |





---


### `cancel`

Cancel a scheduled task by name.


| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Task name (e.g. `"morning-summary"`) |





---


### `tasks`

List all scheduled tasks.





---


### `inject`

Inject a synthetic message into the pipeline for E2E testing. The message goes through the full processing queue and the agent response is sent back through the actual channel — testing everything except the channel listener itself.


| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `group` | string | Yes | Group or chat name (partial match) (e.g. `"Arul"`) |
| `message` | string | Yes | The message text to inject (e.g. `"Summarise today's activity"`) |
| `sender` | string | No | Simulated sender name (e.g. `"Arul"`) |





---


### `groups`

List available groups from all connected channels.





---


### `health`

Show latest health check result.





---


### `status`

Show pipeline status.





---


### `compact`

Compact conversation history into bucketed memory files. Reads conversation.md and log.jsonl, uses an LLM to categorize facts, and writes to decisions.md, preferences.md, rules.md.


| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `group` | string | Yes | Group name (partial match) (e.g. `"Arul and Lura"`) |





---


### `reset`

Start a new session — archives current conversation and resets context. Memory (decisions, preferences, rules) persists. Only the conversational thread resets, like closing a chapter.


| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `group` | string | Yes | Group name (partial match) (e.g. `"Arul and Lura"`) |





---


### `skills`

View or manage skills for an agent group.


| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `group` | string | Yes | Group name (partial match) (e.g. `"Arul and Lura"`) |
| `action` | 'list' | 'add' | 'remove' | No | Action to perform [choice: list|add|remove] |
| `skill` | string | No | Skill name (for add/remove) |
| `description` | string | No | Skill description (for add) |
| `photon` | string | No | Photon backing this skill (for add, optional) |





---





## 🏗️ Architecture

```mermaid
flowchart TD
    subgraph claw["📦 Claw"]
        START([▶ Start])
        N0[📢 Checking WhatsApp connectio...]
        START --> N0
        N1[📢 WhatsApp disconnected — qui...]
        N0 --> N1
        N2[📢 WhatsApp needs QR. Run ]
        N1 --> N2
        N3[📢 Waiting for WhatsApp... ${e...]
        N2 --> N3
        N4[📢 WhatsApp not connected (${w...]
        N3 --> N4
        N5[📢 WhatsApp connected (${waSta...]
        N4 --> N5
        N6[📢 Checking Telegram connectio...]
        N5 --> N6
        N7[📢 Telegram not connected (${t...]
        N6 --> N7
        N8[📢 Telegram connected (@${tgSt...]
        N7 --> N8
        N9[📢 Chat channel connected (${c...]
        N8 --> N9
        N10[📢 Subscribing to groups...]
        N9 --> N10
        N11[🎉 Pipeline started — ${groupC...]
        N10 --> N11
        SUCCESS([✅ Success])
        N11 --> SUCCESS
    end
```


## 📥 Usage

```bash
# Install from marketplace
photon add claw

# Get MCP config for your client
photon info claw --mcp
```

## 📦 Dependencies

No external dependencies.

---

MIT · v4.0.0
