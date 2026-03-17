import { Photon } from '@portel/photon-core';

/**
 * Chat — browser-based messaging channel for testing claw pipelines.
 *
 * Provides the same channel interface as WhatsApp/Telegram photons
 * (groups, on/off, send, typing, status) but runs entirely in the
 * browser with no external dependencies. Create groups, send messages,
 * and test the full agent ↔ mentor pipeline locally.
 *
 * @version 1.0.0
 * @icon 💬
 * @tags channel, chat, testing
 * @stateful
 * @noworker
 * @ui chat ./chat/ui/chat.html
 */
export default class Chat extends Photon {
  private _groups: Map<string, ChatGroup> = new Map();
  private _handlers: Array<{ event: string; fn: (msg: any) => void; filter?: any }> = [];
  private _connected = false;

  // ─── Channel Interface (wire-compatible with WhatsApp/Telegram) ───

  /**
   * Connect the chat channel.
   *
   * @title Connect
   */
  async connect(): Promise<{ status: string; message: string }> {
    this._connected = true;

    // Restore persisted groups
    const saved = await this.memory.get<Record<string, { name: string; createdAt: string }>>('groups');
    if (saved) {
      for (const [id, g] of Object.entries(saved)) {
        if (!this._groups.has(id)) {
          this._groups.set(id, { id, name: g.name, messages: [], createdAt: g.createdAt });
        }
      }
    }

    this.emit({ type: 'connected' });
    return { status: 'connected', message: 'Chat channel ready' };
  }

  /**
   * Channel status.
   *
   * @title Status
   * @readOnly
   */
  async status(): Promise<{ status: string; groups: number }> {
    return {
      status: this._connected ? 'connected' : 'disconnected',
      groups: this._groups.size,
    };
  }

  /**
   * List all chat groups.
   *
   * @title Groups
   * @readOnly
   */
  async groups(): Promise<Array<{ name: string; chatId: string }>> {
    return Array.from(this._groups.values()).map(g => ({
      name: g.name,
      chatId: g.id,
    }));
  }

  /**
   * Create a new chat group.
   *
   * @title Create Group
   * @param name Group name
   */
  async create(params: { name: string }): Promise<{ id: string; name: string }> {
    const id = 'chat_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const group: ChatGroup = {
      id,
      name: params.name,
      messages: [],
      createdAt: new Date().toISOString(),
    };
    this._groups.set(id, group);
    await this._persistGroups();
    this.emit({ type: 'group_created', name: params.name, id });
    return { id, name: params.name };
  }

  /**
   * Send a message to a chat group.
   *
   * @title Send
   * @param chat Group name or ID
   * @param text Message text
   */
  async send(params: { chat: string; text: string }): Promise<{ queued: boolean; messageId: string }> {
    const group = this._findGroup(params.chat);
    if (!group) throw new Error(`Group not found: ${params.chat}`);

    const messageId = 'msg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const msg: ChatMessage = {
      id: messageId,
      sender: '__agent__',
      senderName: 'Agent',
      content: params.text,
      timestamp: new Date().toISOString(),
      fromMe: true,
      type: 'text',
    };

    group.messages.push(msg);
    this.emit({ type: 'message_sent', group: group.name, messageId });
    return { queued: false, messageId };
  }

  /**
   * Edit a previously sent message.
   *
   * @title Edit
   * @internal
   * @param chat Group name or ID
   * @param messageId Message ID to edit
   * @param text New text
   */
  async edit(params: { chat: string; messageId: string; text: string }): Promise<void> {
    const group = this._findGroup(params.chat);
    if (!group) throw new Error(`Group not found: ${params.chat}`);

    const msg = group.messages.find(m => m.id === params.messageId);
    if (msg) {
      msg.content = params.text;
      msg.editedAt = new Date().toISOString();
    }
  }

  /**
   * Show typing indicator (no-op for chat, kept for interface compatibility).
   *
   * @internal
   */
  async typing(params: { chat: string; typing: boolean }): Promise<void> {
    const group = this._findGroup(params.chat);
    if (group) {
      this.emit({ type: 'typing', group: group.name, typing: params.typing });
    }
  }

  /**
   * Send media (stores as a message with media metadata).
   *
   * @internal
   */
  async media(params: { chat: string; url: string; type: string; caption?: string }): Promise<{ messageId: string }> {
    const group = this._findGroup(params.chat);
    if (!group) throw new Error(`Group not found: ${params.chat}`);

    const messageId = 'msg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    group.messages.push({
      id: messageId,
      sender: '__agent__',
      senderName: 'Agent',
      content: params.caption || `[${params.type}: ${params.url}]`,
      timestamp: new Date().toISOString(),
      fromMe: true,
      type: params.type as any,
      media: { mimetype: params.type, caption: params.caption },
    });
    return { messageId };
  }

  /**
   * Inject a user message into a group — fires the message event so claw picks it up.
   *
   * @title Say
   * @param chat Group name or ID
   * @param text Message text
   * @param sender Sender name {@default "User"}
   * @audience user
   */
  async say(params: { chat: string; text: string; sender?: string }): Promise<{ delivered: boolean; messageId: string }> {
    const group = this._findGroup(params.chat);
    if (!group) throw new Error(`Group not found: ${params.chat}`);

    const senderName = params.sender || 'User';
    const messageId = 'msg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const msg: ChatMessage = {
      id: messageId,
      sender: senderName.toLowerCase().replace(/\s+/g, '_'),
      senderName,
      content: params.text,
      timestamp: new Date().toISOString(),
      fromMe: false,
      type: 'text',
    };

    group.messages.push(msg);

    // Fire to all matching handlers (this is what claw subscribes to via .on())
    const event = {
      chatId: group.id,
      message: {
        messageId,
        sender: msg.sender,
        senderName: msg.senderName,
        content: msg.content,
        fromMe: false,
        timestamp: msg.timestamp,
        type: 'text',
      },
    };

    for (const h of this._handlers) {
      if (h.event !== 'message') continue;
      if (this._matchesFilter(h.filter, group, msg)) {
        try { h.fn(event); } catch { /* handler error */ }
      }
    }

    this.emit({ type: 'message_received', group: group.name, messageId, sender: senderName });
    return { delivered: true, messageId };
  }

  /**
   * Get message history for a group.
   *
   * @title Messages
   * @readOnly
   * @audience user
   * @param chat Group name or ID
   * @param limit Max messages to return {@default 50}
   */
  async messages(params: { chat: string; limit?: number }): Promise<ChatMessage[]> {
    const group = this._findGroup(params.chat);
    if (!group) throw new Error(`Group not found: ${params.chat}`);
    const limit = params.limit || 50;
    return group.messages.slice(-limit);
  }

  // ─── Event Interface (.on / .off — called by claw) ───

  /**
   * Subscribe to message events with optional filtering.
   * @internal
   */
  on(event: string, handler: (msg: any) => void, filter?: any): void {
    this._handlers.push({ event, fn: handler, filter });
  }

  /**
   * Unsubscribe from events.
   * @internal
   */
  off(event: string, fn: (msg: any) => void): void {
    this._handlers = this._handlers.filter(h => !(h.event === event && h.fn === fn));
  }

  // ─── Private Helpers ───

  private _findGroup(nameOrId: string): ChatGroup | undefined {
    // Try exact ID match first
    if (this._groups.has(nameOrId)) return this._groups.get(nameOrId);
    // Fuzzy name match
    const lower = nameOrId.toLowerCase();
    for (const g of this._groups.values()) {
      if (g.name.toLowerCase().includes(lower) || g.id === nameOrId) return g;
    }
    return undefined;
  }

  private _matchesFilter(filter: any, group: ChatGroup, msg: ChatMessage): boolean {
    if (!filter) return true;
    if (filter.group) {
      const fg = filter.group.toLowerCase();
      if (!group.name.toLowerCase().includes(fg) && group.id !== filter.group) return false;
    }
    if (filter.chatId && group.id !== filter.chatId) return false;
    if (filter.trigger && !msg.content.includes(filter.trigger)) return false;
    if (filter.fromMe !== undefined && msg.fromMe !== filter.fromMe) return false;
    return true;
  }

  private async _persistGroups(): Promise<void> {
    const data: Record<string, { name: string; createdAt: string }> = {};
    for (const [id, g] of this._groups) {
      data[id] = { name: g.name, createdAt: g.createdAt };
    }
    await this.memory.set('groups', data);
  }
}

// ─── Types ───

interface ChatGroup {
  id: string;
  name: string;
  messages: ChatMessage[];
  createdAt: string;
}

interface ChatMessage {
  id: string;
  sender: string;
  senderName: string;
  content: string;
  timestamp: string;
  fromMe: boolean;
  type: 'text' | 'image' | 'video' | 'audio' | 'document';
  media?: { mimetype?: string; caption?: string };
  editedAt?: string;
}
