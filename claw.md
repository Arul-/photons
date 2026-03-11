# Claw

Orchestrates the full WhatsApp ↔ Claude agent pipeline by wiring four photons together.

## Architecture

```
whatsapp-bridge  →  message-router  →  agent-runner  →  whatsapp-bridge
  (message in)       (route)            (claude -p)      (send reply)
                                             ↑
                  group-scheduler ────────────┘
                    (cron fires)
```

## Tools

| Tool | Description |
|------|-------------|
| `start` | Connect WhatsApp, wire events, begin routing |
| `stop` | Disconnect and persist state |
| `register` | Register a group for agent routing |
| `unregister` | Remove a group from routing |
| `schedule` | Create a cron task for a group |
| `status` | Pipeline status: connection, runs, groups, tasks |

## Quick Start

```bash
# Start the pipeline
photon cli claw start

# Register a group
photon cli claw register \
  --jid "123@g.us" \
  --name "Dev Team" \
  --folder "dev-team" \
  --trigger "@bot"

# Schedule a daily standup
photon cli claw schedule \
  --groupFolder "dev-team" \
  --chatJid "123@g.us" \
  --prompt "Summarise yesterday's discussion and list open action items" \
  --cron "0 9 * * 1-5" \
  --name "daily-standup"

# Check status
photon cli claw status
```

## Programmatic Usage

```typescript
import { photon } from '@portel/photon-core';

const claw = await photon('./claw.photon.ts', {
  onEvent: (event) => console.log(event),
});

await claw.start();
await claw.register({ jid: '123@g.us', name: 'Dev Team', folder: 'dev-team', trigger: '@bot' });
```

## Events

```
{ type: 'started' }
{ type: 'stopped' }
{ type: 'routing', jid, folder, textPreview }
{ type: 'replied', jid, folder, duration, outputLength }
{ type: 'task:executing', taskId, groupFolder }
{ type: 'task:completed', taskId, groupFolder, duration }
{ type: 'task:failed', taskId, groupFolder, error }
{ type: 'error', source, error }
```

## Session Continuity

The orchestrator tracks Claude session IDs per group folder. When a message arrives, the previous session is resumed via `--resume sessionId`, giving Claude conversational continuity within each group. Session IDs persist across restarts via `this.memory`.

## Migrating from Claw

If you're switching from the original claw system, run the import script to bring over all your data:

```bash
# Preview what will be imported
tsx claw-import.ts --dry-run

# Run the import
tsx claw-import.ts

# Or specify a custom claw directory
tsx claw-import.ts --claw-dir /path/to/claw
```

The import script transfers:
- **WhatsApp auth** — symlinked (no duplication of ~125MB of session files)
- **Registered groups** — JIDs, triggers, folder mappings
- **Session IDs** — for Claude conversation continuity
- **Group folders** — CLAUDE.md, logs, and any custom files per group
- **Message history** — last 50 messages per chat for context
- **Scheduled tasks** — active cron tasks

After importing, just `photon cli claw start` — no QR scan needed, all groups ready.

## Dependencies

All four photons are loaded via `@photon` constructor injection:
- `whatsapp-bridge.photon.ts` — WhatsApp connection
- `message-router.photon.ts` — group registry + trigger matching
- `agent-runner.photon.ts` — Claude subprocess execution
- `group-scheduler.photon.ts` — cron task scheduling
