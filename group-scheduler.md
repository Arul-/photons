# Group Scheduler

Dynamic scheduled tasks for WhatsApp groups. Each task runs a prompt against a group context on a cron schedule.

## Tools

| Tool | Description |
|------|-------------|
| `schedule` | Create a new scheduled task |
| `unschedule` | Cancel and remove a task |
| `pause` | Pause without removing |
| `resume` | Resume a paused task |
| `tasks` | List tasks (optionally by group) |
| `run` | Manually fire a task now |

## Usage

```bash
# Daily standup summary at 9am
photon cli group-scheduler schedule \
  --groupFolder dev-team \
  --chatJid "123@g.us" \
  --prompt "Summarise yesterday's discussion and list open action items" \
  --cron "0 9 * * 1-5" \
  --name "daily-standup"

# List all tasks
photon cli group-scheduler tasks

# Pause during holidays
photon cli group-scheduler pause --taskId task-123
```

## Events

When a task's cron fires, the scheduler emits:

```json
{
  "type": "task:fire",
  "taskId": "task-...",
  "groupFolder": "dev-team",
  "chatJid": "123@g.us",
  "prompt": "Summarise yesterday's discussion...",
  "contextMode": "group",
  "firedAt": "2026-03-10T09:00:00.000Z"
}
```

The agent runner subscribes to these events, executes the prompt against the group context, and sends the result back via `whatsapp-bridge.send()`.

## Composition

```
group-scheduler  →  agent-runner  →  whatsapp-bridge
  (cron fires)       (execute)        (send reply)
```

## Persistence

Task definitions are persisted via `this.memory`. The underlying cron execution uses `this.schedule` from photon-core, which persists to `~/.photon/schedules/`.
