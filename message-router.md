# Message Router

Routes inbound WhatsApp messages to Claude agents based on registered groups and trigger patterns.

## Tools

| Tool | Description |
|------|-------------|
| `register` | Register a group/chat for agent routing |
| `unregister` | Remove a group from routing |
| `route` | Process an inbound message — returns routing decision |
| `groups` | List registered groups |
| `history` | Recent routed messages for a group |

## Registration

```bash
photon cli message-router register --jid "123@g.us" --name "Dev Team" --folder "dev-team" --trigger "@bot"
```

Groups persist across restarts via `this.memory`.

## Routing Logic

When `route()` is called with a message:
1. Skip if `fromMe`
2. Skip if JID not registered
3. Skip if `requiresTrigger=true` and message doesn't match the trigger pattern
4. Log to in-memory history
5. Return `{ action: 'route', folder, formattedContext }` and emit `{ type: 'routed' }`

The `formattedContext` is an XML-formatted message window (last 20 messages) ready to paste into a Claude prompt.

## Events

```
{ type: 'registered', group }
{ type: 'unregistered', jid }
{ type: 'routed', action, jid, folder, groupName, message, formattedContext }
{ type: 'ignored', jid, reason }   // reason: 'from_self' | 'not_registered' | 'no_trigger'
```

## Composition

Sits between `whatsapp-bridge` (source of messages) and the agent runner (consumer of routing decisions):

```
whatsapp-bridge  →  message-router  →  agent-runner
  (messages)          (routing)         (execution)
```
