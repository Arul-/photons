import { Photon } from '@portel/photon-core';

/**
 * Message Router — routes inbound WhatsApp messages to Claude agents.
 *
 * Maintains a registry of groups/chats. When a message arrives via
 * `route()`, it checks the trigger pattern and registered groups, then
 * emits a routing decision for the agent runner to act on.
 *
 * Pair with whatsapp-bridge (subscribe to its 'message' events and
 * call router.route() for each one).
 *
 * @version 1.0.0
 * @icon 🔀
 * @tags routing, whatsapp, nanoclaw, agent
 * @stateful
 */
export default class MessageRouter extends Photon {
  // Persisted registry: jid → RegisteredGroup
  private registry: Record<string, RegisteredGroup> = {};
  // In-memory message log per group folder
  private messageLog: Record<string, MessageEntry[]> = {};
  private readonly MAX_LOG = 200;

  async onInitialize(): Promise<void> {
    const saved = await this.memory.get<Record<string, RegisteredGroup>>('registry');
    if (saved) this.registry = saved;

    // Load imported message history (from nanoclaw-import)
    const history = await this.memory.get<Record<string, any[]>>('messageHistory');
    if (history) {
      for (const [jid, messages] of Object.entries(history)) {
        const group = this.registry[jid];
        if (!group) continue;
        this.messageLog[group.folder] = messages.map(m => ({
          id: `imported-${m.timestamp}`,
          jid,
          sender: m.from,
          senderName: m.pushName || m.from,
          content: m.text,
          timestamp: new Date(m.timestamp * 1000).toISOString(),
          fromMe: m.fromMe,
        }));
      }
    }
  }

  /**
   * Register a group or chat for agent routing.
   * @param jid WhatsApp JID of the group/chat {@example "123456789@g.us"}
   * @param name Display name {@example "Dev Team"}
   * @param folder Filesystem folder name for group context {@example "dev-team"}
   * @param trigger Trigger word or pattern (regex string) {@example "@bot"}
   * @param requiresTrigger If true, only messages containing the trigger are routed (default: true for groups)
   */
  async register(params: {
    jid: string;
    name: string;
    folder: string;
    trigger: string;
    requiresTrigger?: boolean;
  }): Promise<RegisteredGroup> {
    const group: RegisteredGroup = {
      jid: params.jid,
      name: params.name,
      folder: params.folder,
      trigger: params.trigger,
      requiresTrigger: params.requiresTrigger ?? true,
      addedAt: new Date().toISOString(),
    };
    this.registry[params.jid] = group;
    await this.memory.set('registry', this.registry);
    this.emit({ type: 'registered', group });
    return group;
  }

  /**
   * Unregister a group or chat from routing.
   * @param jid WhatsApp JID to unregister
   */
  async unregister(params: { jid: string }): Promise<{ removed: boolean }> {
    const existed = !!this.registry[params.jid];
    if (existed) {
      delete this.registry[params.jid];
      await this.memory.set('registry', this.registry);
      this.emit({ type: 'unregistered', jid: params.jid });
    }
    return { removed: existed };
  }

  /**
   * Route an inbound message. Checks if the chat is registered and whether
   * the trigger pattern matches. Emits { type: 'routed' } or { type: 'ignored' }.
   * @param jid Chat JID the message came from
   * @param from Sender identifier
   * @param text Message text content
   * @param fromMe Whether the message was sent by the bot
   * @param pushName Sender display name
   * @param timestamp Unix timestamp of the message
   * @format json
   */
  async route(params: {
    jid: string;
    from: string;
    text: string;
    fromMe?: boolean;
    pushName?: string;
    timestamp: number;
  }): Promise<RoutingDecision> {
    const { jid, from, text, fromMe, pushName, timestamp } = params;
    const message: MessageEntry = {
      id: `${from}-${timestamp}`,
      jid,
      sender: from,
      senderName: pushName || from,
      content: text,
      timestamp: new Date(timestamp * 1000).toISOString(),
      fromMe,
    };

    // Skip own messages
    if (fromMe) {
      return this._ignore(jid, message, 'from_self');
    }

    const group = this.registry[jid];
    if (!group) {
      return this._ignore(jid, message, 'not_registered');
    }

    // Check trigger pattern
    if (group.requiresTrigger) {
      const trigger = new RegExp(group.trigger, 'i');
      if (!trigger.test(text)) {
        return this._ignore(jid, message, 'no_trigger');
      }
    }

    // Log the message
    if (!this.messageLog[group.folder]) this.messageLog[group.folder] = [];
    const log = this.messageLog[group.folder];
    log.push(message);
    if (log.length > this.MAX_LOG) log.splice(0, log.length - this.MAX_LOG);

    const decision: RoutingDecision = {
      action: 'route',
      jid,
      folder: group.folder,
      groupName: group.name,
      message,
      formattedContext: this._formatMessages(log.slice(-20)),
    };

    this.emit({ type: 'routed', ...decision });
    return decision;
  }

  /**
   * List all registered groups.
   * @readOnly
   * @format table
   */
  async groups(): Promise<RegisteredGroup[]> {
    return Object.values(this.registry);
  }

  /**
   * Get recent routed messages for a group.
   * @readOnly
   * @param folder Group folder name
   * @param limit Max messages to return (default: 50)
   * @format table
   */
  async history(params: { folder: string; limit?: number }): Promise<MessageEntry[]> {
    const log = this.messageLog[params.folder] || [];
    const limit = params.limit ?? 50;
    return log.slice(-limit);
  }

  // ─── Internal ──────────────────────────────────────────────────

  private _ignore(jid: string, message: any, reason: string): RoutingDecision {
    const decision: RoutingDecision = { action: 'ignore', jid, reason, message };
    this.emit({ type: 'ignored', jid, reason });
    return decision;
  }

  private _formatMessages(messages: MessageEntry[]): string {
    const lines = messages.map((m) =>
      `<message sender="${this._escape(m.senderName)}" time="${m.timestamp}">${this._escape(m.content)}</message>`,
    );
    return `<messages>\n${lines.join('\n')}\n</messages>`;
  }

  private _escape(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

// ─── Types ─────────────────────────────────────────────────────────

interface RegisteredGroup {
  jid: string;
  name: string;
  folder: string;
  trigger: string;
  requiresTrigger: boolean;
  addedAt: string;
}

interface MessageEntry {
  id: string;
  jid: string;
  sender: string;
  senderName: string;
  content: string;
  timestamp: string;
  fromMe?: boolean;
}

interface RoutingDecision {
  action: 'route' | 'ignore';
  jid: string;
  folder?: string;
  groupName?: string;
  message?: any;
  formattedContext?: string;
  reason?: string;
}
