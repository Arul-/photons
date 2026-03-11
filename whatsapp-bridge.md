# WhatsApp Bridge

Live WhatsApp connection via Baileys. Manages authentication, message delivery, and group discovery.

## Setup

```bash
photon mcp whatsapp-bridge
```

Auth state is stored in `~/.photon/whatsapp-bridge/auth/`. On first run, `connect()` prints a QR code — scan it with WhatsApp on your phone.

## Tools

| Tool | Description |
|------|-------------|
| `connect` | Connect to WhatsApp (prints QR if needed) |
| `disconnect` | Gracefully disconnect |
| `send` | Send a message to a JID |
| `status` | Connection status + queued message count |
| `groups` | List all known groups with JIDs |
| `typing` | Set typing indicator |

## Events (via `@stateful`)

Subscribe to events from another photon or the agent runner:

```
{ type: 'connected', phone: '...' }
{ type: 'disconnected', reason: number }
{ type: 'qr', code: '...' }
{ type: 'message', chatJid, message: { id, sender, senderName, content, timestamp, fromMe } }
```

The `message` event is the key output — feed it into `message-router` to route to agents.

## Composing with message-router

```typescript
// In your agent runner / orchestrator:
import { photon } from '@portel/photon-core';

const bridge = await photon('./whatsapp-bridge.photon.ts', {
  onEvent: async (event) => {
    if (event.method === 'connect' && event.result?.type === 'message') {
      await router.route({ jid: event.result.chatJid, message: event.result.message });
    }
  }
});

await bridge.connect();
```

## Dependencies

- `@whiskeysockets/baileys` — WhatsApp Web protocol
- `qrcode-terminal` — QR code display
