import { Photon } from '@portel/photon-core';

/**
 * Chat — browser-based messaging channel for testing claw pipelines.
 *
 * Wire-compatible with WhatsApp/Telegram channel interface.
 * No external dependencies — runs entirely in-process.
 *
 * @version 1.0.0
 * @icon 💬
 * @tags channel, chat, testing
 * @stateful
 * @noworker
 * @ui chat ./chat/ui/chat.html
 */
export default class Chat extends Photon {
  /** Group registry — auto-persisted by @stateful. */
  chatGroups: Record<string, { name: string; messages: Message[]; createdAt: string }> = {};

  protected settings = {
    defaultGroup: 'General',
  };

  /** @title Connect */
  async connect() {
    if (!Object.keys(this.chatGroups).length) {
      this._addGroup(this.settings.defaultGroup);
    }
    return { status: 'connected', message: 'Chat channel ready' };
  }

  /** @title Status @readOnly */
  async status() {
    return { status: 'connected', groups: Object.keys(this.chatGroups).length };
  }

  /** @title Groups @readOnly */
  async groups() {
    return Object.entries(this.chatGroups).map(([id, g]) => ({ name: g.name, chatId: id }));
  }

  /** @title Create Group @param name Group name */
  async create(params: { name: string }) {
    const id = this._addGroup(params.name);
    return { id, name: params.name };
  }

  /** @title Send @param chat Group name or ID @param text Message text */
  async send(params: { chat: string; text: string }) {
    const [, group] = this._resolve(params.chat);
    const msg = this._msg(params.text, 'Agent', true);
    group.messages.push(msg);
    return { queued: false, messageId: msg.id };
  }

  /**
   * Inject a user message — fires to claw subscribers.
   * @title Say
   * @param chat Group name or ID
   * @param text Message text
   * @param sender Sender name {@default "User"}
   * @audience user
   */
  async say(params: { chat: string; text: string; sender?: string }) {
    const [id, group] = this._resolve(params.chat);
    const msg = this._msg(params.text, params.sender || 'User', false);
    group.messages.push(msg);
    this._dispatch(id, {
      messageId: msg.id, sender: msg.sender, senderName: msg.senderName,
      content: msg.content, fromMe: false, timestamp: msg.timestamp, type: 'text',
    }, group.name);
    return { delivered: true, messageId: msg.id };
  }

  /** @title Messages @readOnly @audience user @param chat Group name or ID @param limit {@default 50} */
  async messages(params: { chat: string; limit?: number }) {
    const [, group] = this._resolve(params.chat);
    return group.messages.slice(-(params.limit || 50));
  }

  /** @title Edit @internal */
  async edit(params: { chat: string; messageId: string; text: string }) {
    const [, group] = this._resolve(params.chat);
    const msg = group.messages.find(m => m.id === params.messageId);
    if (msg) { msg.content = params.text; msg.editedAt = new Date().toISOString(); }
  }

  /** @internal */ async typing() {}
  /** @internal */ async media(params: { chat: string; url: string; type: string; caption?: string }) {
    const [, group] = this._resolve(params.chat);
    const msg = this._msg(params.caption || `[${params.type}]`, 'Agent', true);
    group.messages.push(msg);
    return { messageId: msg.id };
  }

  // ─── Private ───

  private _addGroup(name: string): string {
    const id = this._id('chat');
    this.chatGroups[id] = { name, messages: [], createdAt: new Date().toISOString() };
    this.emit({ type: 'group_created', name, id });
    return id;
  }

  private _resolve(nameOrId: string): [string, typeof this.chatGroups[string]] {
    if (this.chatGroups[nameOrId]) return [nameOrId, this.chatGroups[nameOrId]];
    const q = nameOrId.toLowerCase();
    for (const [id, g] of Object.entries(this.chatGroups)) {
      if (g.name.toLowerCase().includes(q)) return [id, g];
    }
    throw new Error(`Group not found: ${nameOrId}`);
  }

  private _msg(text: string, sender: string, fromMe: boolean): Message {
    return {
      id: this._id('msg'), sender: sender.toLowerCase().replace(/\s+/g, '_'),
      senderName: sender, content: text, timestamp: new Date().toISOString(), fromMe, type: 'text',
    };
  }

  private _id(prefix: string) {
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }
}

interface Message {
  id: string; sender: string; senderName: string; content: string;
  timestamp: string; fromMe: boolean; type: string;
  media?: { mimetype?: string; caption?: string }; editedAt?: string;
}
