# Agent Runner

Executes Claude agents locally per WhatsApp group. No containers — just `claude -p` with a scoped working directory.

## How It Works

Each group gets a folder under `~/.photon/agent-runner/groups/<folder>/`:
```
~/.photon/agent-runner/groups/
├── dev-team/
│   ├── CLAUDE.md      ← persistent memory for this group
│   └── logs/          ← run history
├── family/
│   ├── CLAUDE.md
│   └── logs/
└── main/
    ├── CLAUDE.md
    └── logs/
```

When `run()` is called, it spawns `claude -p "<prompt>" --output-format json` with `cwd` set to the group folder. Claude reads the group's `CLAUDE.md` for context and preferences.

## Tools

| Tool | Description |
|------|-------------|
| `run` | Execute a prompt against a group's context |
| `status` | Active runs + queue depth |
| `kill` | Kill a running agent |
| `concurrency` | Set max concurrent runs (default: 3) |
| `groups` | List group folders with last run time |

## Events

```
{ type: 'started', groupFolder, chatJid, activeCount }
{ type: 'completed', groupFolder, chatJid, status, duration, outputLength }
{ type: 'error', groupFolder, chatJid, error }
{ type: 'queued', groupFolder, position, activeCount }
```

## Full Pipeline

```
whatsapp-bridge  →  message-router  →  agent-runner  →  whatsapp-bridge
  (message in)       (route)            (claude -p)      (send reply)
                                             ↑
                  group-scheduler ────────────┘
                    (cron fires)
```

The orchestrator that wires these together:

```typescript
import { photon } from '@portel/photon-core';

const bridge  = await photon('./whatsapp-bridge.photon.ts');
const router  = await photon('./message-router.photon.ts');
const runner  = await photon('./agent-runner.photon.ts');

// Wire: bridge emits messages → router decides → runner executes → bridge sends reply
// (event wiring via onEvent or manual polling)
```
