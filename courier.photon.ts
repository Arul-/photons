import fs from 'fs';
import path from 'path';

import { Photon } from '@portel/photon-core';

/** Max inbox age before cleanup (7 days) */
const INBOX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Courier — scheduled message delivery proxy for channel photons.
 *
 * Wraps channel subscriptions (Telegram, WhatsApp, etc.) with a persistent
 * inbox and clock-aligned delivery schedules. Subscribers who want real-time
 * delivery should subscribe to the channel directly — courier is for batched,
 * scheduled delivery.
 *
 * @version 1.0.0
 * @icon 📬
 * @tags delivery, scheduling, channels
 * @stateful
 * @photon telegram telegram
 * @photon whatsapp whatsapp
 */
export default class Courier extends Photon {
  private declare telegram: any;
  private declare whatsapp: any;

  protected settings = {
    /** Inbox retention in days */
    retentionDays: 7,
  };

  /** Active subscriptions keyed by channel:group */
  private _subscriptions: Map<string, Subscription> = new Map();
  /** Timer handles for scheduled delivery */
  private _timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** Channel health: last message received timestamp */
  private _channelHeartbeat: Map<string, number> = new Map();

  private get inboxDir(): string {
    if (this._photonFilePath) return this.storage('inbox');
    return path.join(require('os').homedir(), '.photon', 'data', 'courier', 'inbox');
  }

  private get cursorsPath(): string {
    return path.join(this.inboxDir, 'cursors.json');
  }

  private _inboxPathFor(channel: string): string {
    return path.join(this.inboxDir, `${channel}.jsonl`);
  }

  // ─── Lifecycle ─────────────────────────────────────────────────

  async onInitialize(ctx?: any): Promise<void> {
    if (ctx?.reason === 'hot-reload' && ctx.oldInstance) {
      const old = ctx.oldInstance as any;
      // Clear old timers
      for (const timer of (old._timers?.values() || [])) clearTimeout(timer);
      // Transfer subscriptions and re-register
      this._subscriptions = old._subscriptions || new Map();
      for (const [id, sub] of this._subscriptions) {
        this._registerChannelListener(id, sub);
        if (sub.schedule) this._startSchedule(id, sub);
      }
      return;
    }
    fs.mkdirSync(this.inboxDir, { recursive: true });
  }

  async onShutdown(ctx?: any): Promise<void> {
    if (ctx?.reason === 'hot-reload') return;
    for (const timer of this._timers.values()) clearTimeout(timer);
    this._timers.clear();
    // Unsubscribe from all channels
    for (const [id, sub] of this._subscriptions) {
      if (sub._channelOff) sub._channelOff();
    }
  }

  // ─── Public API ────────────────────────────────────────────────

  /**
   * Subscribe to a channel with durable delivery.
   * Messages are persisted to a disk-backed inbox. With a schedule,
   * they're delivered in batches at clock-aligned times. Without a
   * schedule, they're delivered immediately but still persisted —
   * use drain() after restart to catch up on missed messages.
   *
   * The subscription key is derived from channel + group automatically.
   *
   * @title Subscribe
   * @param channel Channel name {@choice telegram, whatsapp}
   * @param group Group name or chat ID
   * @param schedule Delivery schedule (omit for real-time) {@choice @5m, @15m, @30m, @hourly, @daily}
   * @param trigger Trigger substring filter
   * @param ack Auto-acknowledgment message for scheduled groups (use {time} for next delivery time)
   * @param handler Callback for message delivery
   */
  async subscribe(params: {
    channel: string;
    group: string;
    schedule?: string;
    trigger?: string;
    ack?: string;
    handler?: (messages: InboxEntry[]) => void;
  }): Promise<{ status: string; mode: string; nextDelivery?: string }> {
    const { channel, group, schedule, trigger, ack, handler } = params;
    const ch = this._resolveChannel(channel);
    if (!ch) throw new Error(`Unknown channel: ${channel}. Available: telegram, whatsapp`);

    const id = `${channel}:${group}`;

    // Remove existing subscription with same key
    if (this._subscriptions.has(id)) {
      await this.unsubscribe({ channel, group });
    }

    const sub: Subscription = {
      channel,
      group,
      schedule,
      trigger,
      ack,
      handler,
      createdAt: Date.now(),
    };

    this._subscriptions.set(id, sub);

    // Subscribe to the underlying channel — messages go to inbox
    this._registerChannelListener(id, sub);

    // Start aligned delivery schedule if specified
    if (schedule) {
      this._startSchedule(id, sub);
      const nextMs = _nextAlignedTime(_parseSchedule(schedule));
      return {
        status: 'subscribed',
        mode: 'scheduled',
        nextDelivery: new Date(nextMs).toISOString(),
      };
    }

    return { status: 'subscribed', mode: 'realtime' };
  }

  /**
   * Remove a subscription and stop scheduled delivery.
   *
   * @title Unsubscribe
   * @param channel Channel name {@choice telegram, whatsapp}
   * @param group Group name or chat ID
   */
  async unsubscribe(params: { channel: string; group: string }): Promise<void> {
    const id = `${params.channel}:${params.group}`;
    const sub = this._subscriptions.get(id);
    if (!sub) return;

    // Stop timer
    const timer = this._timers.get(id);
    if (timer) clearTimeout(timer);
    this._timers.delete(id);

    // Unsubscribe from channel
    if (sub._channelOff) sub._channelOff();

    this._subscriptions.delete(id);
  }

  /**
   * Read pending messages for a group without waiting for the schedule.
   * Advances the cursor — messages won't be delivered again.
   *
   * @title Drain
   * @readOnly
   * @param channel Channel name {@choice telegram, whatsapp}
   * @param group Group name or chat ID
   * @format json
   */
  async drain(params: { channel: string; group: string }): Promise<Array<InboxEntry>> {
    const id = `${params.channel}:${params.group}`;
    const sub = this._subscriptions.get(id);
    if (!sub) return [];
    return this._deliverBatch(id, sub);
  }

  /**
   * List active subscriptions and their status.
   *
   * @title Subscriptions
   * @readOnly
   * @format table
   */
  async subscriptions(): Promise<Array<{
    channel: string;
    group: string;
    mode: string;
    schedule?: string;
    trigger?: string;
    inboxCount: number;
    nextDelivery?: string;
  }>> {
    const result = [];
    for (const [id, sub] of this._subscriptions) {
      const cursor = this._loadCursor(id);
      const inbox = this._readInboxFrom(sub.channel, cursor);
      const filtered = this._filterForSubscriber(inbox, sub);
      const entry: any = {
        channel: sub.channel,
        group: sub.group,
        mode: sub.schedule ? 'scheduled' : 'realtime',
        schedule: sub.schedule,
        trigger: sub.trigger,
        inboxCount: filtered.length,
      };
      if (sub.schedule) {
        entry.nextDelivery = new Date(_nextAlignedTime(_parseSchedule(sub.schedule))).toISOString();
      }
      result.push(entry);
    }
    return result;
  }

  /**
   * Courier status overview.
   *
   * @title Status
   * @readOnly
   */
  async status(): Promise<{
    subscriptions: number;
    channels: Record<string, { status: string; lastActivity: string | null; inboxSize: number }>;
  }> {
    const channelNames = new Set<string>();
    for (const sub of this._subscriptions.values()) channelNames.add(sub.channel);

    const channels: Record<string, { status: string; lastActivity: string | null; inboxSize: number }> = {};
    for (const name of channelNames) {
      const lastSeen = this._channelHeartbeat.get(name);
      const ch = this._resolveChannel(name);
      let chStatus = 'unknown';
      if (ch) {
        try {
          const s = await ch.status();
          chStatus = s.status || s.connected ? 'connected' : 'disconnected';
        } catch { chStatus = 'unreachable'; }
      }

      let inboxSize = 0;
      try {
        const p = this._inboxPathFor(name);
        if (fs.existsSync(p)) {
          inboxSize = fs.readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).length;
        }
      } catch { /* */ }

      channels[name] = {
        status: chStatus,
        lastActivity: lastSeen ? new Date(lastSeen).toISOString() : null,
        inboxSize,
      };
    }

    return { subscriptions: this._subscriptions.size, channels };
  }

  // ─── Internal: Channel Subscription ────────────────────────────

  private _resolveChannel(name: string): any {
    if (name === 'telegram') return this.telegram;
    if (name === 'whatsapp') return this.whatsapp;
    return null;
  }


  /** Subscribe to the underlying channel, routing messages to inbox */
  private _registerChannelListener(id: string, sub: Subscription): void {
    const ch = this._resolveChannel(sub.channel);
    if (!ch) return;

    const handler = (data: any) => {
      // Normalize: WhatsApp uses chatJid, Telegram uses chatId
      const chatId = data.chatId || data.chatJid || data.jid || '';
      const entry: InboxEntry = {
        chatId,
        message: data.message,
        receivedAt: Date.now(),
      };

      // Track channel heartbeat
      this._channelHeartbeat.set(sub.channel, Date.now());

      // Always persist to inbox (durable delivery guarantee)
      this._appendToInbox(sub.channel, entry);

      if (sub.schedule) {
        // Scheduled mode: auto-ack if configured
        if (sub.ack && !entry.message.fromMe) {
          const nextMs = _nextAlignedTime(_parseSchedule(sub.schedule));
          const timeStr = _formatRelativeTime(nextMs);
          const ackText = sub.ack.replace('{time}', timeStr);
          this._sendAck(sub.channel, chatId, ackText, entry.message.messageId);
        }
      } else if (sub.handler) {
        // Real-time mode: deliver immediately + advance cursor
        sub.handler([entry]);
        this._advanceCursor(id, entry.receivedAt);
      }
    };

    const filter: any = {};
    if (sub.group) filter.group = sub.group;
    if (sub.trigger) filter.trigger = sub.trigger;

    ch.on('message', handler, Object.keys(filter).length > 0 ? filter : undefined);

    // Store cleanup function
    sub._channelOff = () => ch.off('message', handler);
  }

  /** Send an auto-acknowledgment back through the channel */
  private _sendAck(channel: string, chatId: string, text: string, replyToId?: string): void {
    const ch = this._resolveChannel(channel);
    if (!ch) return;
    // Use reply if possible, fall back to send
    const sendFn = replyToId && ch.reply
      ? () => ch.reply({ chat: chatId, text, messageId: Number(replyToId) })
      : () => ch.send({ chat: chatId, text });
    sendFn().catch(() => {
      // Non-fatal — ack is best-effort
    });
  }

  // ─── Internal: Persistent Inbox ────────────────────────────────

  /** Append a message to the channel's inbox JSONL file */
  private _appendToInbox(channel: string, entry: InboxEntry): void {
    try {
      fs.mkdirSync(this.inboxDir, { recursive: true });
      const line = JSON.stringify(entry) + '\n';
      fs.appendFileSync(this._inboxPathFor(channel), line);
    } catch {
      // Non-fatal — message lost from inbox but was still delivered to any real-time subscribers
    }
  }

  /** Read inbox entries from a channel starting after a cursor timestamp */
  private _readInboxFrom(channel: string, cursorTimestamp: number): InboxEntry[] {
    const p = this._inboxPathFor(channel);
    try {
      if (!fs.existsSync(p)) return [];
      const lines = fs.readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean);
      const entries: InboxEntry[] = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as InboxEntry;
          if (entry.receivedAt > cursorTimestamp) entries.push(entry);
        } catch { /* skip malformed lines */ }
      }
      return entries;
    } catch { return []; }
  }

  /** Filter inbox entries that match a subscriber's filters */
  private _filterForSubscriber(entries: InboxEntry[], sub: Subscription): InboxEntry[] {
    return entries.filter(e => {
      if (sub.group) {
        // Numeric ID → exact match
        if (/^-?\d+$/.test(sub.group)) {
          if (e.chatId !== sub.group) return false;
        }
        // Name match would need resolution — for now pass through
        // (channel's on() filter already handles this)
      }
      if (sub.trigger && !e.message.content?.includes(sub.trigger)) return false;
      return true;
    });
  }

  // ─── Internal: Cursors ─────────────────────────────────────────

  private _loadCursors(): Record<string, number> {
    try {
      if (fs.existsSync(this.cursorsPath)) {
        return JSON.parse(fs.readFileSync(this.cursorsPath, 'utf-8'));
      }
    } catch { /* corrupted */ }
    return {};
  }

  private _saveCursors(cursors: Record<string, number>): void {
    try {
      const tmp = this.cursorsPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cursors));
      fs.renameSync(tmp, this.cursorsPath);
    } catch { /* non-fatal */ }
  }

  private _loadCursor(subscriberId: string): number {
    const cursors = this._loadCursors();
    return cursors[subscriberId] || 0;
  }

  private _advanceCursor(subscriberId: string, timestamp: number): void {
    const cursors = this._loadCursors();
    cursors[subscriberId] = timestamp;
    this._saveCursors(cursors);
  }

  // ─── Internal: Scheduled Delivery ──────────────────────────────

  /** Start clock-aligned delivery schedule for a subscriber */
  private _startSchedule(id: string, sub: Subscription): void {
    if (!sub.schedule) return;
    const intervalMs = _parseSchedule(sub.schedule);
    const nextFire = _nextAlignedTime(intervalMs);
    const delay = nextFire - Date.now();

    const fire = () => {
      const batch = this._deliverBatch(id, sub);
      if (batch.length > 0) {
        // Deliver via handler if provided
        if (sub.handler) sub.handler(batch);
        this.emit({ type: 'delivered', subscriberId: id, count: batch.length });
      }
      // Schedule next aligned tick
      const next = _nextAlignedTime(intervalMs);
      const nextDelay = next - Date.now();
      this._timers.set(id, setTimeout(fire, Math.max(nextDelay, 1000)));
    };

    this._timers.set(id, setTimeout(fire, Math.max(delay, 1000)));
  }

  /** Read, filter, deliver, and advance cursor for a subscriber */
  private _deliverBatch(id: string, sub: Subscription): InboxEntry[] {
    const cursor = this._loadCursor(id);
    const inbox = this._readInboxFrom(sub.channel, cursor);
    const batch = this._filterForSubscriber(inbox, sub);

    if (batch.length === 0) return [];

    // Advance cursor to latest message timestamp
    const latest = Math.max(...batch.map(e => e.receivedAt));
    this._advanceCursor(id, latest);

    return batch;
  }

  // ─── Internal: Cleanup ─────────────────────────────────────────

  /**
   * Clean up old inbox entries that all subscribers have consumed.
   * Called periodically or manually.
   *
   * @title Cleanup
   * @internal
   */
  async cleanup(): Promise<{ removed: number }> {
    const cursors = this._loadCursors();
    const channels = new Set<string>();
    for (const sub of this._subscriptions.values()) channels.add(sub.channel);

    let removed = 0;
    const cutoff = Date.now() - (this.settings.retentionDays * 24 * 60 * 60 * 1000);

    for (const channel of channels) {
      const p = this._inboxPathFor(channel);
      try {
        if (!fs.existsSync(p)) continue;
        const lines = fs.readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean);
        const kept: string[] = [];

        // Find the minimum cursor for this channel's subscribers
        let minCursor = Infinity;
        for (const [id, sub] of this._subscriptions) {
          if (sub.channel === channel) {
            minCursor = Math.min(minCursor, cursors[id] || 0);
          }
        }

        for (const line of lines) {
          try {
            const entry = JSON.parse(line) as InboxEntry;
            // Keep if: newer than cutoff OR not yet consumed by all subscribers
            if (entry.receivedAt > cutoff || entry.receivedAt > minCursor) {
              kept.push(line);
            } else {
              removed++;
            }
          } catch { /* drop malformed */ removed++; }
        }

        if (kept.length < lines.length) {
          fs.writeFileSync(p, kept.join('\n') + (kept.length > 0 ? '\n' : ''));
        }
      } catch { /* non-fatal */ }
    }

    return { removed };
  }
}

// ─── Types ──────────────────────────────────────────────────────────

interface Subscription {
  channel: string;
  group: string;
  schedule?: string;
  trigger?: string;
  /** Auto-ack message template (use {time} for next delivery) */
  ack?: string;
  handler?: (messages: InboxEntry[]) => void;
  createdAt: number;
  _channelOff?: () => void;
}

interface InboxEntry {
  chatId: string;
  message: any;
  receivedAt: number;
}

// ─── Schedule Utilities ─────────────────────────────────────────────

/** Parse schedule shorthand to milliseconds */
function _parseSchedule(schedule: string): number {
  const shorthands: Record<string, number> = {
    '@minutely': 60_000,
    '@5m': 5 * 60_000,
    '@15m': 15 * 60_000,
    '@30m': 30 * 60_000,
    '@hourly': 60 * 60_000,
    '@daily': 24 * 60 * 60_000,
  };
  if (shorthands[schedule]) return shorthands[schedule];

  const match = schedule.match(/^(\d+)(s|m|h)$/);
  if (match) {
    const n = parseInt(match[1], 10);
    const unit = match[2];
    if (unit === 's') return n * 1000;
    if (unit === 'm') return n * 60_000;
    if (unit === 'h') return n * 60 * 60_000;
  }

  return 60 * 60_000; // default: 1 hour
}

/** Calculate next clock-aligned fire time for an interval */
function _nextAlignedTime(intervalMs: number): number {
  const now = Date.now();
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  const elapsed = now - midnight;
  const intervals = Math.ceil(elapsed / intervalMs);
  return midnight + intervals * intervalMs;
}

/** Format a future timestamp as a human-readable relative/absolute time */
function _formatRelativeTime(ms: number): string {
  const diff = ms - Date.now();
  if (diff < 60_000) return 'in less than a minute';
  if (diff < 60 * 60_000) {
    const mins = Math.round(diff / 60_000);
    return `in ${mins} minute${mins === 1 ? '' : 's'}`;
  }
  // Show clock time for longer durations
  const d = new Date(ms);
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `at ${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}
