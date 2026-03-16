import fs from 'fs';
import path from 'path';

import { Photon } from '@portel/photon-core';

/**
 * Claw — orchestrates messaging ↔ Claude agent pipeline.
 *
 * Subscribe to WhatsApp and Telegram groups, route messages to an agent runner,
 * and send responses back. Uses channel .on() for event-driven
 * message handling with group and trigger filtering.
 *
 * @version 4.0.0
 * @icon 🦞
 * @tags orchestrator, whatsapp, telegram, agent, claw
 * @stateful
 * @noworker
 * @photon whatsapp ./whatsapp.photon.ts
 * @photon telegram ./telegram.photon.ts
 * @photon router ./agent-router.photon.ts
 * @photon courier ./courier.photon.ts
 * @ui dashboard ./ui/dashboard.html
 */
export default class Claw extends Photon {
  private running = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private sessionMap: Record<string, string> = {}; // folder → sessionId
  private lastHealth: { ok: boolean; whatsapp: string; telegram: string; runner: string; checkedAt: string } | null = null;
  private autoResumeTimer: ReturnType<typeof setTimeout> | null = null;

  // Group registry — persisted via this.memory, keyed by canonical group name
  private registry: Record<string, GroupConfig> = {};
  // Message handlers — one per registered group, keyed by group name
  private handlers: Map<string, (msg: any) => void> = new Map();
  // Message log per group name for context building
  private messageLog: Record<string, MessageEntry[]> = {};

  // Per-agent processing queues with configurable concurrency
  private _agentQueues: Map<string, QueueItem[]> = new Map();
  private _agentWake: Map<string, (() => void)> = new Map();
  private _agentActive: Map<string, number> = new Map();
  private _agentLoops: Set<string> = new Set();   // which agents have a running loop

  constructor(
    private whatsapp: any,
    private telegram: any,
    private router: any,
    private courier: any,
  ) {
    super();
  }

  protected settings = {
    /** Heartbeat interval in milliseconds (health checks) */
    heartbeatIntervalMs: 30000,
    /** Auto-resume pipeline after daemon restart */
    autoResume: true,
    /** Max messages kept per group for agent context */
    maxMessageLog: 200,
    /** Name prefix the agent uses when sending messages (e.g. "Lura: ..."). Also acts as loop-prevention sentinel. */
    agentName: 'Lura',
    /** Max recent conversations to keep in conversation.md before compaction */
    maxConversations: 3,
    /** Cron schedule for memory compaction (default: 3am daily) */
    compactCron: '0 3 * * *',
    /** Max concurrent tasks per agent type. Agents not listed default to 1. */
    agentConcurrency: { claude: 2, gemini: 2, aider: 1, opencode: 1, auto: 1 } as Record<string, number>,
  };

  async onInitialize(ctx?: { reason?: string; oldInstance?: any }): Promise<void> {
    if (ctx?.reason === 'hot-reload' && ctx.oldInstance) {
      const old = ctx.oldInstance;
      this.running = old.running || false;
      this.sessionMap = old.sessionMap || {};
      this.lastHealth = old.lastHealth || null;
      this.registry = old.registry || {};
      this.messageLog = old.messageLog || {};
      this.handlers = old.handlers || new Map();
      this._agentQueues = old._agentQueues || new Map();

      if (old.heartbeatTimer) {
        this.heartbeatTimer = old.heartbeatTimer;
        old.heartbeatTimer = null;
      }

      // Stop old processing loops and restart ours
      for (const agent of (old._agentLoops || new Set())) {
        old._agentLoops.delete(agent);
        const wake = old._agentWake?.get(agent);
        if (wake) wake();
      }
      if (this.running) this._startAllLoops();

      old.handlers = null;
      this.emit({ type: 'hot_reload_transferred', running: this.running });
      return;
    }

    // Normal startup — restore persisted state
    const saved = await this.memory.get<Record<string, GroupConfig>>('registry');
    if (saved) {
      // Migrate: existing entries without channel default to 'whatsapp'
      for (const config of Object.values(saved)) {
        if (!config.channel) config.channel = 'whatsapp';
      }
      this.registry = saved;
    }

    const savedSessions = await this.memory.get<Record<string, string>>('sessionMap');
    if (savedSessions) this.sessionMap = savedSessions;


    // Schedule memory compaction
    if (Object.keys(this.registry).length > 0) {
      this._scheduleCompaction().catch(() => {});
    }

    const wasRunning = await this.memory.get<boolean>('running');
    if (wasRunning && this.settings.autoResume) {
      const tryResume = async (attempts = 0): Promise<void> => {
        try {
          for await (const _ of this.start()) { /* yield values are UI-only */ }
          this.emit({ type: 'auto_resumed' });
        } catch {
          if (attempts < 5) {
            setTimeout(() => tryResume(attempts + 1), 3000);
          } else {
            this.emit({ type: 'auto_resume_failed', message: 'No channels connected after retries' });
          }
        }
      };
      this.autoResumeTimer = setTimeout(() => tryResume(), 2000);
    }
  }

  async onShutdown(ctx?: { reason?: string }): Promise<void> {
    if (ctx?.reason === 'hot-reload') return;
    this._unsubscribeAll();
    this._stopAllLoops();
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    this.running = false;
  }

  /**
   * Claw Pipeline Dashboard
   * @ui dashboard
   */
  async main() {
    return this.status();
  }

  /**
   * Start the pipeline: verify channel connections, subscribe to registered groups.
   * Streams progress while waiting for channels to connect.
   *
   * @title Start Pipeline
   * @openWorld
   */
  async *start() {
    if (this.running) {
      return 'Already running';
    }

    // ── Check WhatsApp ──
    yield { emit: 'status', message: 'Checking WhatsApp connection...' };

    let waStatus = await this.whatsapp.status();

    if (waStatus.status !== 'connected') {
      let skipWait = false;
      if (waStatus.status === 'disconnected') {
        yield { emit: 'status', message: 'WhatsApp disconnected — quick connect attempt...' };
        try {
          // Timeout connect() after 10s — Baileys init can be slow with no auth
          const connectResult = await Promise.race([
            this.whatsapp.connect(),
            new Promise<{ status: string }>((_, reject) =>
              setTimeout(() => reject(new Error('timeout')), 10_000)
            ),
          ]);
          if (connectResult.status === 'qr_pending') {
            yield { emit: 'status', message: 'WhatsApp needs QR. Run `photon whatsapp connect` to scan.' };
            skipWait = true;
          }
        } catch {
          skipWait = true;
        }
      } else {
        skipWait = true; // Unknown/other state — don't wait
      }

      // Only poll-wait if WhatsApp has credentials and might be reconnecting
      if (!skipWait && waStatus.status !== 'connected') {
        const maxWaitMs = 30_000; // 30s max — don't block Telegram
        const started = Date.now();
        while (Date.now() - started < maxWaitMs) {
          await new Promise(r => setTimeout(r, 3000));
          waStatus = await this.whatsapp.status();
          if (waStatus.status === 'connected') break;
          const elapsed = Math.round((Date.now() - started) / 1000);
          yield { emit: 'status', message: `Waiting for WhatsApp... ${elapsed}s (${waStatus.status})` };
        }
      }

      if (waStatus.status !== 'connected') {
        yield { emit: 'status', message: `WhatsApp not connected (${waStatus.status}) — Telegram-only groups will still work.` };
      }
    }

    if (waStatus.status === 'connected') {
      yield { emit: 'status', message: `WhatsApp connected (${waStatus.phone})` };

      // Auto-seed each WhatsApp group's allowlist with own number if not yet set
      if (waStatus.phone) {
        const ownPhone = waStatus.phone.replace(/\D/g, '');
        let changed = false;
        for (const config of Object.values(this.registry)) {
          if (config.channel === 'whatsapp' && config.allowedSenders.length === 0) {
            config.allowedSenders = [ownPhone];
            changed = true;
          }
        }
        if (changed) await this.memory.set('registry', this.registry);
      }
    }

    // ── Check Telegram ──
    yield { emit: 'status', message: 'Checking Telegram connection...' };
    let tgStatus = await this.telegram.status().catch(() => ({ status: 'unavailable' }));

    if (tgStatus.status !== 'connected') {
      yield { emit: 'status', message: `Telegram not connected (${tgStatus.status}) — WhatsApp-only groups will still work.` };
    } else {
      yield { emit: 'status', message: `Telegram connected (@${tgStatus.username})` };
    }

    // At least one channel must be available
    if (waStatus.status !== 'connected' && tgStatus.status !== 'connected') {
      return 'No channels connected. Connect WhatsApp (`photon whatsapp connect`) or Telegram (`photon telegram connect`) first.';
    }

    yield { emit: 'status', message: 'Subscribing to groups...' };

    this.running = true;
    await this.memory.set('running', true);

    this._startAllLoops();
    this._subscribeAll();

    // Drain pending messages that arrived while claw was stopped
    await this._drainPending();

    this.heartbeatTimer = setInterval(() => {
      this._heartbeat().catch(() => {});
    }, this.settings.heartbeatIntervalMs);

    const groupCount = Object.keys(this.registry).length;
    const channels: string[] = [];
    if (waStatus.status === 'connected') channels.push(`WhatsApp (${waStatus.phone})`);
    if (tgStatus.status === 'connected') channels.push(`Telegram (@${tgStatus.username})`);

    this.emit({ type: 'started', channels, groups: groupCount });
    yield { emit: 'toast', message: `Pipeline started — ${groupCount} group(s) on ${channels.join(', ')}`, type: 'success' };
    return `Started. Channels: ${channels.join(', ')}, groups: ${groupCount}`;
  }

  /**
   * Stop the pipeline.
   *
   * @title Stop Pipeline
   * @destructive
   */
  async stop(): Promise<{ status: string }> {
    if (this.autoResumeTimer) { clearTimeout(this.autoResumeTimer); this.autoResumeTimer = null; }

    if (!this.running) {
      await this.memory.set('running', false);
      return { status: 'not running' };
    }

    this._unsubscribeAll();
    this._stopAllLoops();
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    this.running = false;
    await this.memory.set('running', false);
    await this.memory.set('sessionMap', this.sessionMap);

    this.emit({ type: 'stopped' });
    return { status: 'stopped' };
  }

  /**
   * Register a group or chat for agent routing.
   * Searches both WhatsApp and Telegram for a matching group name.
   *
   * @title Register Group
   * @openWorld
   * @param group Group or chat name (partial match) {@example "Learn CS"}
   * @param trigger Trigger word to activate the agent (empty = participant mode) {@example "@"}
   * @param folders Folder names the agent can access — first is the primary context folder {@example ["lura", "photon"]}
   * @param channel Force a specific channel ('whatsapp'|'telegram') — auto-detected if omitted {@choice whatsapp, telegram}
   * @param requiresTrigger Only route messages containing the trigger (default: true when trigger is non-empty)
   * @param systemPrompt System prompt prepended to every agent run for this group {@example "You are Lura, a concise personal assistant."}
   * @param agent Agent to use for this group ('claude'|'gemini'|'aider'|'opencode'|'auto') {@example "claude"}
   * @param schedule Delivery schedule via courier (omit for real-time) {@choice @5m, @15m, @30m, @hourly, @daily}
   */
  async register(params: {
    group: string;
    trigger: string;
    folders: string[];
    channel?: 'whatsapp' | 'telegram';
    requiresTrigger?: boolean;
    systemPrompt?: string;
    agent?: string;
    schedule?: string;
  }): Promise<{ name: string } & GroupConfig> {
    const query = params.group.toLowerCase();
    let matchName: string | null = null;
    let matchChannel: 'whatsapp' | 'telegram' = 'whatsapp';

    // If channel is forced, only search that channel
    if (params.channel === 'telegram') {
      const tgChats = await this.telegram.groups().catch(() => []);
      const match = tgChats.find((g: any) =>
        (g.name || '').toLowerCase().includes(query) || g.chatId === params.group
      );
      if (match) {
        matchName = match.name;
      } else if (/^-?\d+$/.test(params.group)) {
        // Allow registering by raw numeric chat ID even if not yet discovered
        // (Telegram bot discovers chats from incoming messages, so first registration
        // often uses the chat ID directly before any messages are received)
        matchName = params.group; // Use chat ID as name until discovered
      } else {
        throw new Error(
          `No Telegram chat matching "${params.group}". Use the numeric chat ID, or send a message in the chat first so the bot discovers it.`
        );
      }
      matchChannel = 'telegram';
    } else if (params.channel === 'whatsapp') {
      const waGroups = await this.whatsapp.groups();
      const match = waGroups.find((g: any) =>
        g.name.toLowerCase().includes(query) || g.jid === params.group
      );
      if (!match) {
        throw new Error(
          `No WhatsApp group matching "${params.group}". Run 'photon whatsapp groups' to see available groups.`
        );
      }
      matchName = match.name;
      matchChannel = 'whatsapp';
    } else {
      // Auto-detect: search WhatsApp first, then Telegram
      const waGroups = await this.whatsapp.groups().catch(() => []);
      const waMatch = waGroups.find((g: any) =>
        g.name.toLowerCase().includes(query) || g.jid === params.group
      );
      if (waMatch) {
        matchName = waMatch.name;
        matchChannel = 'whatsapp';
      } else {
        const tgChats = await this.telegram.groups().catch(() => []);
        const tgMatch = tgChats.find((g: any) =>
          (g.name || '').toLowerCase().includes(query) || g.chatId === params.group
        );
        if (tgMatch) {
          matchName = tgMatch.name;
          matchChannel = 'telegram';
        } else if (/^-?\d+$/.test(params.group)) {
          // Numeric ID that's not in WhatsApp — assume Telegram
          matchName = params.group;
          matchChannel = 'telegram';
        }
      }
    }

    if (!matchName) {
      throw new Error(
        `No group matching "${params.group}" on any channel. Check 'photon whatsapp groups' or 'photon telegram groups'.`
      );
    }

    const config: GroupConfig = {
      trigger: params.trigger,
      requiresTrigger: params.requiresTrigger ?? (params.trigger.length > 0),
      folders: params.folders,
      addedAt: new Date().toISOString(),
      allowedSenders: [],
      systemPrompt: params.systemPrompt ?? '',
      agent: params.agent ?? 'claude',
      channel: matchChannel,
      schedule: params.schedule,
    };

    this.registry[matchName] = config;
    await this.memory.set('registry', this.registry);

    // Subscribe immediately if running
    if (this.running) {
      this._subscribeGroup(matchName, config);
    }

    this.emit({ type: 'registered', name: matchName, channel: matchChannel, config });
    return { name: matchName, ...config };
  }

  /**
   * Remove a group from routing.
   *
   * @title Unregister Group
   * @destructive
   * @param group Group name (partial match) {@example "Learn CS"}
   */
  async unregister(params: { group: string }): Promise<void> {
    const query = params.group.toLowerCase();
    const name = Object.keys(this.registry).find(k => k.toLowerCase().includes(query));

    if (!name) throw new Error(`No group matching "${params.group}"`);

    const config = this.registry[name];

    // Unsubscribe: direct handler or courier
    if (config.schedule) {
      await this.courier.unsubscribe({
        channel: config.channel || 'whatsapp',
        group: name,
      }).catch(() => {});
    } else {
      const handler = this.handlers.get(name);
      if (handler) {
        const ch = this._channelFor(config);
        ch.off('message', handler);
        this.handlers.delete(name);
      }
    }

    delete this.registry[name];
    await this.memory.set('registry', this.registry);
    this.emit({ type: 'unregistered', name });
  }

  /**
   * Update configuration for a registered group.
   * Only provided fields are changed; omitted fields stay as-is.
   *
   * @title Configure Group
   * @param group Group name (partial match) {@example "Arul and Lura"}
   * @param trigger New trigger word (empty string = participant mode) {@example "@"}
   * @param folders New folder list {@example ["lura", "photon"]}
   * @param requiresTrigger Override trigger requirement
   * @param systemPrompt System prompt for this group's agent {@example "You are Lura, a concise personal assistant."}
   * @param agent Switch to a different agent ('claude'|'gemini'|'aider'|'opencode'|'auto') {@example "gemini"}
   * @param schedule Delivery schedule via courier (empty string to remove, omit to keep) {@choice @5m, @15m, @30m, @hourly, @daily}
   */
  async configure(params: {
    group: string;
    trigger?: string;
    folders?: string[];
    requiresTrigger?: boolean;
    systemPrompt?: string;
    agent?: string;
    schedule?: string;
  }): Promise<{ name: string } & GroupConfig> {
    const query = params.group.toLowerCase();
    const name = Object.keys(this.registry).find(k => k.toLowerCase().includes(query));
    if (!name) throw new Error(`No registered group matching "${params.group}"`);

    const config = this.registry[name];
    if (params.trigger !== undefined) {
      config.trigger = params.trigger;
      // Re-derive requiresTrigger from trigger unless explicitly overridden
      if (params.requiresTrigger === undefined) {
        config.requiresTrigger = params.trigger.length > 0;
      }
    }
    if (params.requiresTrigger !== undefined) config.requiresTrigger = params.requiresTrigger;
    if (params.folders !== undefined) config.folders = params.folders;
    if (params.systemPrompt !== undefined) config.systemPrompt = params.systemPrompt;
    if (params.agent !== undefined) config.agent = params.agent;
    if (params.schedule !== undefined) config.schedule = params.schedule || undefined;

    await this.memory.set('registry', this.registry);

    // Re-subscribe with updated filter if pipeline is running
    if (this.running) this._subscribeGroup(name, config);

    this.emit({ type: 'configured', name, config });
    return { name, ...config };
  }

  /**
   * List allowed senders for a group. Empty = all senders allowed.
   * Auto-seeded with your own number when claw starts.
   *
   * @title Senders
   * @readOnly
   * @closedWorld
   * @format table
   * @param group Group name (partial match) {@example "Arul and Lura"}
   */
  async senders(params: { group: string }): Promise<Array<{ phone: string }>> {
    const config = this._findConfig(params.group);
    return config.allowedSenders.map(phone => ({ phone }));
  }

  /**
   * Add a phone number to a group's allowed senders list.
   *
   * @title Allow Sender
   * @param group Group name (partial match) {@example "Arul and Lura"}
   * @param phone Phone number to allow {@example "+60123456789"}
   */
  async allow(params: { group: string; phone: string }): Promise<{ allowed: string[] }> {
    const config = this._findConfig(params.group);
    const normalized = params.phone.replace(/\D/g, '');
    if (!config.allowedSenders.includes(normalized)) {
      config.allowedSenders.push(normalized);
      await this.memory.set('registry', this.registry);
    }
    return { allowed: config.allowedSenders };
  }

  /**
   * Remove a phone number from a group's allowed senders list.
   * At least one sender must remain.
   *
   * @title Deny Sender
   * @destructive
   * @param group Group name (partial match) {@example "Arul and Lura"}
   * @param phone Phone number to remove {@example "+60123456789"}
   */
  async deny(params: { group: string; phone: string }): Promise<{ allowed: string[] }> {
    const config = this._findConfig(params.group);
    const normalized = params.phone.replace(/\D/g, '');
    const updated = config.allowedSenders.filter(s => s !== normalized);
    if (updated.length === 0) throw new Error('Cannot remove the last allowed sender. Add another first.');
    config.allowedSenders = updated;
    await this.memory.set('registry', this.registry);
    return { allowed: config.allowedSenders };
  }

  /**
   * View recent message history for a group.
   *
   * @title History
   * @readOnly
   * @closedWorld
   * @format table
   * @param group Group name (partial match) {@example "Arul and Lura"}
   * @param limit Number of recent messages to show (default: 20)
   */
  async history(params: { group: string; limit?: number }): Promise<MessageEntry[]> {
    const query = params.group.toLowerCase();
    const name = Object.keys(this.messageLog).find(k => k.toLowerCase().includes(query));
    if (!name) throw new Error(`No message history for group matching "${params.group}"`);
    const log = this.messageLog[name];
    return log.slice(-(params.limit ?? 20));
  }

  /**
   * Clear the agent session for a group, forcing fresh context on next message.
   *
   * @title Reset Session
   * @destructive
   * @param group Group name (partial match) {@example "Arul and Lura"}
   */
  async reset(params: { group: string }): Promise<void> {
    const query = params.group.toLowerCase();
    const name = Object.keys(this.registry).find(k => k.toLowerCase().includes(query));
    if (!name) throw new Error(`No registered group matching "${params.group}"`);
    const config = this.registry[name];
    delete this.sessionMap[config.folders[0]]; // legacy bare key
    delete this.sessionMap[`${config.agent}:${config.folders[0]}`];
    await this.memory.set('sessionMap', this.sessionMap);
    this.emit({ type: 'session_reset', group: name });
  }

  /**
   * Clear the in-memory message log for a group.
   *
   * @title Clear Log
   * @destructive
   * @param group Group name (partial match) {@example "Arul and Lura"}
   */
  async clear(params: { group: string }): Promise<void> {
    const query = params.group.toLowerCase();
    const name = Object.keys(this.messageLog).find(k => k.toLowerCase().includes(query));
    if (!name) throw new Error(`No message log for group matching "${params.group}"`);
    this.messageLog[name] = [];
    this.emit({ type: 'log_cleared', group: name });
  }

  /**
   * Schedule a recurring or one-time agent run for a group.
   * Uses cron syntax or @daily / @hourly / @weekly / @monthly shorthands.
   *
   * @title Schedule Task
   * @openWorld
   * @param group Group name (partial match) {@example "Arul and Lura"}
   * @param prompt Prompt to send to the agent {@example "Summarise today's messages"}
   * @param cron Cron expression or shorthand {@example "0 9 * * *"}
   * @param name Optional task name for later reference {@example "morning-summary"}
   */
  async task(params: { group: string; prompt: string; cron: string; name?: string }): Promise<{ id: string; name: string; cron: string }> {
    const query = params.group.toLowerCase();
    const groupName = Object.keys(this.registry).find(k => k.toLowerCase().includes(query));
    if (!groupName) throw new Error(`No registered group matching "${params.group}"`);
    const config = this.registry[groupName];

    const taskName = params.name ?? `${groupName}-task`;
    const existing = await this.schedule.getByName(taskName).catch(() => null);
    if (existing) await this.schedule.cancel(existing.id);

    const scheduled = await this.schedule.create({
      name: taskName,
      schedule: params.cron,
      method: '_runScheduled',
      params: { groupName, primaryFolder: config.folders[0], prompt: params.prompt },
    });

    return { id: scheduled.id, name: taskName, cron: params.cron };
  }

  /**
   * Cancel a scheduled task by name.
   *
   * @title Cancel Task
   * @destructive
   * @param name Task name {@example "morning-summary"}
   */
  async cancel(params: { name: string }): Promise<void> {
    const task = await this.schedule.getByName(params.name);
    if (!task) throw new Error(`No scheduled task named "${params.name}"`);
    await this.schedule.cancel(task.id);
  }

  /**
   * List all scheduled tasks.
   *
   * @title Scheduled Tasks
   * @readOnly
   * @closedWorld
   * @format table
   */
  async tasks(): Promise<Array<{ id: string; name: string; schedule: string; group: string; nextRun: string | null; status: string }>> {
    const all = await this.schedule.list('active');
    return all.map((t: any) => ({
      id: t.id,
      name: t.name,
      schedule: t.schedule,
      group: t.params?.groupName ?? '',
      nextRun: t.nextRun ?? null,
      status: t.status,
    }));
  }

  /**
   * List available groups from all connected channels.
   *
   * @title List Groups
   * @readOnly
   * @openWorld
   * @format table
   */
  async groups(): Promise<Array<{ name: string; channel: string; registered: boolean; folders?: string[]; trigger?: string }>> {
    const results: Array<{ name: string; channel: string; registered: boolean; folders?: string[]; trigger?: string }> = [];

    const waGroups = await this.whatsapp.groups().catch(() => []);
    for (const g of waGroups) {
      const config = this.registry[g.name];
      results.push({
        name: g.name,
        channel: 'whatsapp',
        registered: !!config,
        ...(config ? { folders: config.folders, trigger: config.trigger } : {}),
      });
    }

    const tgChats = await this.telegram.groups().catch(() => []);
    for (const g of tgChats) {
      const config = this.registry[g.name];
      results.push({
        name: g.name,
        channel: 'telegram',
        registered: !!config,
        ...(config ? { folders: config.folders, trigger: config.trigger } : {}),
      });
    }

    return results;
  }

  /**
   * Show latest health check result.
   *
   * @title Health
   * @readOnly
   * @openWorld
   * @format card
   */
  async health(): Promise<{
    ok: boolean;
    running: boolean;
    whatsapp: string;
    telegram: string;
    runner: string;
    checkedAt: string | null;
  }> {
    if (!this.running) {
      return { ok: false, running: false, whatsapp: 'unknown', telegram: 'unknown', runner: 'unknown', checkedAt: null };
    }
    if (!this.lastHealth) await this._heartbeat();
    return {
      ok: this.lastHealth?.ok ?? false,
      running: this.running,
      whatsapp: this.lastHealth?.whatsapp ?? 'unknown',
      telegram: this.lastHealth?.telegram ?? 'unknown',
      runner: this.lastHealth?.runner ?? 'unknown',
      checkedAt: this.lastHealth?.checkedAt ?? null,
    };
  }

  /**
   * Show pipeline status.
   *
   * @title Status
   * @readOnly
   * @openWorld
   * @ui dashboard
   */
  async status(): Promise<{
    running: boolean;
    whatsapp: any;
    telegram: any;
    runner: any;
    courier: any;
    queue: Record<string, { depth: number; active: number; concurrency: number }>;
    groups: Array<{ name: string } & GroupConfig>;
  }> {
    const safe = async (fn: () => Promise<any>, fallback: any = null) => {
      try { return await fn(); } catch { return fallback; }
    };

    const [whatsapp, telegramStatus, runnerStatus, courierStatus] = await Promise.all([
      safe(() => this.whatsapp.status(), { status: 'unknown' }),
      safe(() => this.telegram.status(), { status: 'unknown' }),
      safe(() => this.router.status(), { totalActive: 0, totalQueued: 0 }),
      safe(() => this.courier.status(), { subscriptions: 0, inboxSizes: {} }),
    ]);

    return {
      running: this.running,
      whatsapp,
      telegram: telegramStatus,
      runner: runnerStatus,
      courier: courierStatus,
      queue: this._getQueueStatus(),
      groups: Object.entries(this.registry).map(([name, cfg]) => ({ name, ...cfg })),
    };
  }

  // ─── Internal ──────────────────────────────────────────────────

  private _findConfig(query: string): GroupConfig {
    const key = Object.keys(this.registry).find(k => k.toLowerCase().includes(query.toLowerCase()));
    if (!key) throw new Error(`No registered group matching "${query}"`);
    return this.registry[key];
  }

  /** Called by the scheduler — runs an agent prompt and sends result to the group */
  async _runScheduled(params: { groupName: string; primaryFolder: string; prompt: string }): Promise<void> {
    if (!this.running) return;
    const { groupName, primaryFolder, prompt } = params;
    const config = this.registry[groupName];
    if (!config) return;

    this.emit({ type: 'scheduled_run', group: groupName, folder: primaryFolder });

    const sessionKey = `${config.agent}:${primaryFolder}`;
    const sessionId = this.sessionMap[sessionKey] ?? (config.agent === 'claude' ? this.sessionMap[primaryFolder] : undefined);

    // Build memory-augmented system prompt for scheduled runs
    let systemPrompt = config.systemPrompt || '';
    const memoryCtx = await this._buildMemoryPrompt(primaryFolder);
    if (memoryCtx) {
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${memoryCtx}` : memoryCtx;
    }

    const result = await this.router.run({
      groupFolder: primaryFolder,
      prompt,
      agent: config.agent,
      sessionId,
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(config.folders.slice(1).length > 0 ? { addDirs: config.folders.slice(1) } : {}),
    });

    if (result.sessionId) {
      this.sessionMap[`${config.agent}:${primaryFolder}`] = result.sessionId;
      await this.memory.set('sessionMap', this.sessionMap);
    }

    if (result.status === 'success' && result.output) {
      // Append scheduled run to conversation log
      this._appendConversation(primaryFolder, `[Scheduled] ${prompt}`, result.output, 'System').catch(() => {});
      await this._sendAgentResponse(groupName, config, result.output, primaryFolder, result.duration);
    }
  }

  private _subscribeAll(): void {
    for (const [name, config] of Object.entries(this.registry)) {
      this._subscribeGroup(name, config);
    }
  }

  /** Drain pending messages from all channels — catches messages that arrived while stopped */
  private async _drainPending(): Promise<void> {
    const channels = new Set<string>();
    for (const config of Object.values(this.registry)) {
      channels.add(config.channel || 'whatsapp');
    }

    for (const channelName of channels) {
      const ch = channelName === 'telegram' ? this.telegram : this.whatsapp;
      try {
        const pending = await ch.pending();
        if (!pending || pending.length === 0) continue;

        this.emit({ type: 'draining', channel: channelName, count: pending.length });

        for (const { chatId, message } of pending) {
          // Find matching group config for this chatId
          for (const [name, config] of Object.entries(this.registry)) {
            if ((config.channel || 'whatsapp') !== channelName) continue;

            // Match by numeric chatId or resolved name
            const isMatch = /^-?\d+$/.test(name)
              ? name === chatId
              : true; // Non-numeric names matched by the listener, but for drain we check all

            if (!isMatch) continue;

            // Apply trigger filter
            if (config.requiresTrigger && config.trigger && !message.content.includes(config.trigger)) continue;

            this._handleMessage(name, config, { chatId, message }).catch((err) => {
              this.emit({ type: 'drain_error', group: name, error: err.message });
            });
            break; // One group match per message
          }
        }
      } catch {
        // Channel might not be connected — skip
      }
    }
  }

  /** Get the channel photon instance for a group config */
  private _channelFor(config: GroupConfig): any {
    return config.channel === 'telegram' ? this.telegram : this.whatsapp;
  }

  private _subscribeGroup(name: string, config: GroupConfig): void {
    // Remove existing direct handler if any
    const existing = this.handlers.get(name);
    if (existing) {
      const ch = this._channelFor(config);
      ch.off('message', existing);
      this.handlers.delete(name);
    }

    // Remove existing courier subscription if any (handles mode switching)
    this.courier.unsubscribe({
      channel: config.channel || 'whatsapp',
      group: name,
    }).catch(() => {});

    if (config.schedule) {
      // ── Scheduled delivery via Courier ──
      this.courier.subscribe({
        channel: config.channel || 'whatsapp',
        group: name,
        schedule: config.schedule,
        trigger: config.requiresTrigger ? config.trigger : undefined,
        ack: 'Got it, will process {time}',
        handler: (batch: any[]) => {
          this._enqueue({ groupName: name, config, batch });
        },
      }).catch((err: any) => {
        this.emit({ type: 'courier_subscribe_error', group: name, error: err.message });
      });
    } else {
      // ── Real-time: direct channel subscription → enqueue ──
      const ch = this._channelFor(config);
      const handler = (msg: any) => {
        if (!this.running) return;
        this._enqueue({ groupName: name, config, event: msg });
      };

      const filter: any = { group: name };
      if (config.requiresTrigger) filter.trigger = config.trigger;
      ch.on('message', handler, filter);
      this.handlers.set(name, handler);
    }
  }

  private _unsubscribeAll(): void {
    // Unsubscribe direct channel handlers
    for (const [name, handler] of this.handlers.entries()) {
      const config = this.registry[name];
      if (config) {
        const ch = this._channelFor(config);
        ch.off('message', handler);
      }
    }
    this.handlers.clear();

    // Unsubscribe courier-managed groups
    for (const [name, config] of Object.entries(this.registry)) {
      if (config.schedule) {
        this.courier.unsubscribe({
          channel: config.channel || 'whatsapp',
          group: name,
        }).catch(() => {});
      }
    }
  }

  // ─── Per-Agent Processing Queues ────────────────────────────────

  private _enqueue(item: QueueItem): void {
    const agent = item.config.agent || 'claude';
    if (!this._agentQueues.has(agent)) this._agentQueues.set(agent, []);
    this._agentQueues.get(agent)!.push(item);

    // Ensure this agent has a running loop
    this._ensureAgentLoop(agent);

    // Wake the loop if it's idle
    const wake = this._agentWake.get(agent);
    if (wake) {
      this._agentWake.delete(agent);
      wake();
    }
  }

  /** Start loops for all known agent types in the registry */
  private _startAllLoops(): void {
    const agents = new Set<string>();
    for (const config of Object.values(this.registry)) {
      agents.add(config.agent || 'claude');
    }
    // Always ensure at least the default agents
    agents.add('claude');
    for (const agent of agents) {
      this._ensureAgentLoop(agent);
    }
  }

  /** Stop all agent loops */
  private _stopAllLoops(): void {
    for (const agent of [...this._agentLoops]) {
      this._agentLoops.delete(agent);
      const wake = this._agentWake.get(agent);
      if (wake) {
        this._agentWake.delete(agent);
        wake();
      }
    }
  }

  /** Ensure a processing loop is running for the given agent */
  private _ensureAgentLoop(agent: string): void {
    if (this._agentLoops.has(agent)) return;
    this._agentLoops.add(agent);
    if (!this._agentActive.has(agent)) this._agentActive.set(agent, 0);

    const maxConcurrency = this.settings.agentConcurrency[agent] ?? 1;

    const loop = async () => {
      while (this._agentLoops.has(agent)) {
        const queue = this._agentQueues.get(agent);

        // Wait if queue is empty or we're at max concurrency
        if (!queue || queue.length === 0 || (this._agentActive.get(agent) || 0) >= maxConcurrency) {
          await new Promise<void>(resolve => { this._agentWake.set(agent, resolve); });
          if (!this._agentLoops.has(agent)) break;
          continue;
        }

        // Dispatch up to (maxConcurrency - active) items concurrently
        const active = this._agentActive.get(agent) || 0;
        const slotsAvailable = maxConcurrency - active;
        const toDispatch = queue.splice(0, slotsAvailable);

        for (const item of toDispatch) {
          this._agentActive.set(agent, (this._agentActive.get(agent) || 0) + 1);
          this._processItem(agent, item);  // fire-and-forget, managed by active count
        }
      }
    };

    loop().catch(() => { this._agentLoops.delete(agent); });
  }

  /** Process a single queue item, decrementing active count and waking the loop when done */
  private async _processItem(agent: string, item: QueueItem): Promise<void> {
    try {
      if (item.batch && item.batch.length > 0) {
        await this._handleBatch(item.groupName, item.config, item.batch);
      } else if (item.event) {
        await this._handleMessage(item.groupName, item.config, item.event);
      }
    } catch (err: any) {
      this.emit({ type: 'handle_error', group: item.groupName, error: err.message });
    } finally {
      const current = this._agentActive.get(agent) || 1;
      this._agentActive.set(agent, current - 1);

      // Wake the loop so it can dispatch more items
      const wake = this._agentWake.get(agent);
      if (wake) {
        this._agentWake.delete(agent);
        wake();
      }
    }
  }

  private _getQueueStatus(): Record<string, { depth: number; active: number; concurrency: number }> {
    const result: Record<string, { depth: number; active: number; concurrency: number }> = {};
    const agents = new Set([...this._agentQueues.keys(), ...this._agentActive.keys()]);
    for (const agent of agents) {
      const depth = this._agentQueues.get(agent)?.length || 0;
      const active = this._agentActive.get(agent) || 0;
      if (depth > 0 || active > 0) {
        result[agent] = {
          depth,
          active,
          concurrency: this.settings.agentConcurrency[agent] ?? 1,
        };
      }
    }
    return result;
  }

  /** Handle a batch of messages from courier scheduled delivery */
  private async _handleBatch(name: string, config: GroupConfig, batch: any[]): Promise<void> {
    const ch = this._channelFor(config);
    const primaryFolder = config.folders[0];

    // Log all batch messages
    for (const entry of batch) {
      const msg = entry.message;
      if (!this.messageLog[name]) this.messageLog[name] = [];
      this.messageLog[name].push({
        sender: msg.senderName || msg.sender || 'Unknown',
        content: msg.content || '',
        timestamp: msg.timestamp || new Date(entry.receivedAt).toISOString(),
        fromMe: msg.fromMe,
      });
    }

    // Trim log
    const log = this.messageLog[name];
    if (log && log.length > this.settings.maxMessageLog) {
      log.splice(0, log.length - this.settings.maxMessageLog);
    }

    // Build combined context from the batch
    const batchMessages = batch.map(entry => {
      const msg = entry.message;
      return `<message sender="${this._esc(msg.senderName || msg.sender || 'Unknown')}" time="${msg.timestamp || new Date(entry.receivedAt).toISOString()}">${this._esc(msg.content || '')}</message>`;
    });

    const context = `<batch count="${batch.length}">\n${batchMessages.join('\n')}\n</batch>\n\n<instruction>You received ${batch.length} message(s) that were batched for scheduled delivery (${config.schedule}). Respond to the conversation as a whole — provide a single cohesive response addressing the key points.</instruction>`;

    this.emit({
      type: 'routing_batch',
      group: name,
      channel: config.channel,
      count: batch.length,
      schedule: config.schedule,
    });

    // Send typing + process
    await ch.typing({ chat: name, typing: true }).catch(() => {});

    const sessionKey = `${config.agent}:${primaryFolder}`;
    const sessionId = this.sessionMap[sessionKey] ?? (config.agent === 'claude' ? this.sessionMap[primaryFolder] : undefined);

    let systemPrompt = config.systemPrompt || '';
    this._ensureMemoryDir(primaryFolder);
    const memoryCtx = await this._buildMemoryPrompt(primaryFolder);
    if (memoryCtx) {
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${memoryCtx}` : memoryCtx;
    }

    let result: any;
    try {
      result = await this.router.run({
        groupFolder: primaryFolder,
        prompt: context,
        agent: config.agent,
        sessionId,
        ...(systemPrompt ? { systemPrompt } : {}),
        ...(config.folders.slice(1).length > 0 ? { addDirs: config.folders.slice(1) } : {}),
      });
    } finally {
      ch.typing({ chat: name, typing: false }).catch(() => {});
    }

    if (result.sessionId) {
      this.sessionMap[`${config.agent}:${primaryFolder}`] = result.sessionId;
      await this.memory.set('sessionMap', this.sessionMap);
    }

    if (result.status === 'success' && result.output) {
      const batchSummary = batch.map(e => e.message?.content || '').join(' | ').slice(0, 200);
      this._appendConversation(primaryFolder, `[Batch x${batch.length}] ${batchSummary}`, result.output, 'Batch').catch(() => {});
      await this._sendAgentResponse(name, config, result.output, primaryFolder, result.duration);
    } else if (result.error) {
      this.emit({ type: 'error', source: 'agent-runner', group: name, error: result.error });
    }
  }

  private async _heartbeat(): Promise<void> {
    if (!this.running) return;

    const checkedAt = new Date().toISOString();
    let waStatus = 'unknown';
    let tgStatus = 'unknown';
    let runnerStatus = 'unknown';
    let ok = true;

    try {
      const wa = await this.whatsapp.status();
      waStatus = wa.status;
      if (wa.status !== 'connected') {
        // Only warn if there are WhatsApp groups registered
        const hasWaGroups = Object.values(this.registry).some(c => c.channel === 'whatsapp');
        if (hasWaGroups) {
          ok = false;
          this.emit({ type: 'heartbeat_warn', component: 'whatsapp', status: wa.status });
        }
      }
    } catch {
      waStatus = 'unreachable';
    }

    try {
      const tg = await this.telegram.status();
      tgStatus = tg.status;
      if (tg.status !== 'connected') {
        const hasTgGroups = Object.values(this.registry).some(c => c.channel === 'telegram');
        if (hasTgGroups) {
          ok = false;
          this.emit({ type: 'heartbeat_warn', component: 'telegram', status: tg.status });
        }
      }
    } catch {
      tgStatus = 'unreachable';
    }

    try {
      const r = await this.router.status();
      runnerStatus = `active:${r.totalActive ?? 0},queued:${r.totalQueued ?? 0}`;
    } catch {
      ok = false;
      runnerStatus = 'unreachable';
    }

    this.lastHealth = { ok, whatsapp: waStatus, telegram: tgStatus, runner: runnerStatus, checkedAt };
    this.emit({ type: 'heartbeat', ok, whatsapp: waStatus, telegram: tgStatus, runner: runnerStatus, checkedAt });

    // Detect group renames
    await this._detectRenames().catch(() => {});
  }

  /** Detect group/channel renames by comparing current names against registry keys.
   *  Channel photons maintain id→name mappings. We fetch the current group list
   *  and build an id→name map, then check if any registered name's underlying ID
   *  now points to a different name. */
  private async _detectRenames(): Promise<void> {
    // Build id→name maps per channel
    const idToName: Record<string, Map<string, string>> = {
      telegram: new Map(),
      whatsapp: new Map(),
    };
    const nameToId: Record<string, Map<string, string>> = {
      telegram: new Map(),
      whatsapp: new Map(),
    };

    const tgChats = await this.telegram.groups().catch(() => []);
    for (const g of tgChats) {
      const id = String(g.chatId || '');
      const name = g.name || '';
      if (id && name) {
        idToName.telegram.set(id, name);
        nameToId.telegram.set(name.toLowerCase(), id);
      }
    }

    const waGroups = await this.whatsapp.groups().catch(() => []);
    for (const g of waGroups) {
      const id = g.jid || '';
      const name = g.name || '';
      if (id && name) {
        idToName.whatsapp.set(id, name);
        nameToId.whatsapp.set(name.toLowerCase(), id);
      }
    }

    // Check each registered group
    const renames: Array<{ oldName: string; newName: string; config: GroupConfig }> = [];

    for (const [regName, config] of Object.entries(this.registry)) {
      const ch = config.channel || 'whatsapp';

      // Skip numeric ID registrations (Telegram chat IDs used as names)
      if (/^-?\d+$/.test(regName)) continue;

      // Check if this name still exists
      const existingId = nameToId[ch]?.get(regName.toLowerCase());
      if (existingId) continue; // Name still valid, no rename

      // Name is gone — try to find the ID that was previously associated with this name
      // by checking if any current name's ID resolves to a group we know about
      // Heuristic: look through all IDs and see if one has a new name that isn't in our registry
      for (const [id, currentName] of (idToName[ch] || new Map())) {
        // If this current name is already registered, skip
        if (this.registry[currentName]) continue;

        // This ID has a name that's not in our registry — could be a rename
        // Confirm by checking if the channel's listener filters still reference our old name
        // The channel photons auto-patch filters on rename, so if we find an unregistered name
        // on the same channel where a registered name disappeared, it's very likely a rename
        // Additional confirmation: only one name disappeared and one appeared
        renames.push({ oldName: regName, newName: currentName, config });
        break; // One rename per missing name
      }
    }

    // Apply renames
    for (const { oldName, newName, config } of renames) {
      await this._applyRename(oldName, newName, config);
    }
  }

  /** Apply a group rename across all internal state */
  private async _applyRename(oldName: string, newName: string, config: GroupConfig): Promise<void> {
    // Move registry entry
    this.registry[newName] = config;
    delete this.registry[oldName];

    // Move handler
    const handler = this.handlers.get(oldName);
    if (handler) {
      this.handlers.set(newName, handler);
      this.handlers.delete(oldName);
    }

    // Move message log
    if (this.messageLog[oldName]) {
      this.messageLog[newName] = this.messageLog[oldName];
      delete this.messageLog[oldName];
    }

    // Update queued items across all agent queues
    for (const queue of this._agentQueues.values()) {
      for (const item of queue) {
        if (item.groupName === oldName) item.groupName = newName;
      }
    }

    // Re-subscribe through courier if scheduled
    if (config.schedule) {
      await this.courier.unsubscribe({
        channel: config.channel || 'whatsapp',
        group: oldName,
      }).catch(() => {});
      this._subscribeGroup(newName, config);
    }

    // Persist
    await this.memory.set('registry', this.registry);

    this.emit({ type: 'group:renamed', oldName, newName, channel: config.channel });
  }

  private async _handleMessage(name: string, config: GroupConfig, event: {
    chatJid?: string;
    chatId?: string;
    message: {
      sender: string; senderName: string; content: string; fromMe: boolean; timestamp: string;
      type?: string; filePath?: string; media?: { mimetype?: string; caption?: string };
    };
  }): Promise<void> {
    const msg = event.message;
    const ch = this._channelFor(config);
    const primaryFolder = config.folders[0];
    const agentPrefix = `${this.settings.agentName}: `;

    // Always skip agent's own responses to prevent loops
    if (msg.fromMe && msg.content.startsWith(agentPrefix)) return;

    // Sender allowlist: when non-empty, only route messages from allowed senders
    if (config.allowedSenders.length > 0 && !msg.fromMe) {
      const senderPhone = msg.sender.replace(/[^0-9]/g, '');
      if (!config.allowedSenders.some(s => senderPhone.endsWith(s) || s.endsWith(senderPhone))) return;
    }

    // Log the message for context, keyed by group name
    const entry: MessageEntry = {
      sender: msg.senderName,
      content: msg.content,
      timestamp: msg.timestamp,
      fromMe: msg.fromMe,
    };
    if (!this.messageLog[name]) this.messageLog[name] = [];
    const log = this.messageLog[name];
    log.push(entry);
    if (log.length > this.settings.maxMessageLog) log.splice(0, log.length - this.settings.maxMessageLog);

    const context = this._formatContext(log.slice(-20), msg);

    this.emit({
      type: 'routing',
      group: name,
      channel: config.channel,
      folders: config.folders,
      textPreview: msg.content.slice(0, 80),
      messageType: msg.type || 'text',
    });

    // Quick ACK so the user knows the message was received
    const acks = ['Noted, on it.', 'Got it, thinking...', 'On it.', 'Noted.', 'Working on it...'];
    const ackResult = await ch.send({ chat: name, text: acks[Math.floor(Math.random() * acks.length)] }).catch(() => null);
    // WhatsApp returns key for edit-in-place, Telegram returns messageId
    const ackKey = ackResult?.key ?? null;
    const ackMessageId = ackResult?.messageId ?? null;

    // Keep typing indicator alive during agent processing
    await ch.typing({ chat: name, typing: true }).catch(() => {});
    const typingInterval = setInterval(() => {
      ch.typing({ chat: name, typing: true }).catch(() => {});
    }, config.channel === 'telegram' ? 4_000 : 20_000); // Telegram typing expires after ~5s

    // Collect addDirs: extra config folders + media dir from attachment
    const addDirs: string[] = config.folders.slice(1);
    if (msg.filePath) {
      const mediaDir = msg.filePath.substring(0, msg.filePath.lastIndexOf('/'));
      if (!addDirs.includes(mediaDir)) addDirs.push(mediaDir);
    }

    const sessionKey = `${config.agent}:${primaryFolder}`;
    const sessionId = this.sessionMap[sessionKey] ?? (config.agent === 'claude' ? this.sessionMap[primaryFolder] : undefined);

    // Build memory-augmented system prompt
    let systemPrompt = config.systemPrompt || '';
    this._ensureMemoryDir(primaryFolder);
    const memoryCtx = await this._buildMemoryPrompt(primaryFolder);
    if (memoryCtx) {
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${memoryCtx}` : memoryCtx;
    }

    let result: any;
    try {
      result = await this.router.run({
        groupFolder: primaryFolder,
        prompt: context,
        chatJid: event.chatJid || event.chatId,
        agent: config.agent,
        sessionId,
        ...(systemPrompt ? { systemPrompt } : {}),
        ...(addDirs.length > 0 ? { addDirs } : {}),
      });
    } finally {
      clearInterval(typingInterval);
      ch.typing({ chat: name, typing: false }).catch(() => {});
    }

    if (result.sessionId) {
      this.sessionMap[`${config.agent}:${primaryFolder}`] = result.sessionId;
      await this.memory.set('sessionMap', this.sessionMap);
    }

    if (result.status === 'success' && result.output) {
      // Append conversation round-trip to memory (non-blocking)
      this._appendConversation(primaryFolder, msg.content, result.output, msg.senderName).catch((err) => {
        this.emit({ type: 'memory_error', group: name, error: err.message });
      });
      await this._sendAgentResponse(name, config, result.output, primaryFolder, result.duration, ackKey, ackMessageId);
    } else if (result.error) {
      this.emit({ type: 'error', source: 'agent-runner', group: name, error: result.error });
    }
  }

  /** Send agent response, editing the ACK message in-place if possible */
  private async _sendAgentResponse(chat: string, config: GroupConfig, output: string, folder: string, duration: number, ackKey?: any, ackMessageId?: number | null): Promise<void> {
    const ch = this._channelFor(config);

    // Detect media file references in the output:
    // Patterns: ![alt](path) or bare file paths ending in image/video extensions
    const mediaPattern = /!\[([^\]]*)\]\(([^)]+)\)/g;
    const filePathPattern = /(?:^|\s)(\/[^\s]+\.(?:jpg|jpeg|png|gif|webp|mp4|pdf|mp3|ogg|m4a))/gi;

    let textOutput = output;
    const mediaFiles: Array<{ path: string; caption: string; type: 'image' | 'video' | 'audio' | 'document' }> = [];

    // Extract markdown image references
    let match: RegExpExecArray | null;
    while ((match = mediaPattern.exec(output)) !== null) {
      const [fullMatch, alt, filePath] = match;
      const type = this._detectMediaType(filePath);
      if (type) {
        mediaFiles.push({ path: filePath, caption: alt, type });
        textOutput = textOutput.replace(fullMatch, '').trim();
      }
    }

    // Extract bare file paths (only if no markdown images found)
    if (mediaFiles.length === 0) {
      while ((match = filePathPattern.exec(output)) !== null) {
        const filePath = match[1];
        const type = this._detectMediaType(filePath);
        if (type) {
          mediaFiles.push({ path: filePath, caption: '', type });
          textOutput = textOutput.replace(filePath, '').trim();
        }
      }
    }

    // Send text portion — edit the ACK in-place if possible, else send fresh
    if (textOutput.trim()) {
      const prefixed = `${this.settings.agentName}: ${textOutput.trim()}`;

      if (config.channel === 'whatsapp' && ackKey) {
        // WhatsApp: edit via message key
        await ch.edit({ key: ackKey, text: prefixed }).catch(async () => {
          await ch.send({ chat, text: prefixed });
        });
      } else if (config.channel === 'telegram' && ackMessageId) {
        // Telegram: edit via message ID
        await ch.edit({ chat, messageId: ackMessageId, text: prefixed }).catch(async () => {
          await ch.send({ chat, text: prefixed });
        });
      } else {
        await ch.send({ chat, text: prefixed });
      }
    }

    // Send each media file
    for (const media of mediaFiles) {
      try {
        await ch.media({
          chat,
          url: media.path,
          type: media.type,
          caption: media.caption || undefined,
        });
      } catch (err: any) {
        this.emit({ type: 'error', source: 'media_send', folder, error: err.message, path: media.path });
        await ch.send({ chat, text: `[Media file: ${media.path}]` }).catch(() => {});
      }
    }

    this.emit({
      type: 'replied',
      group: chat,
      channel: config.channel,
      folder,
      duration,
      outputLength: output.length,
      mediaCount: mediaFiles.length,
    });
  }

  private _detectMediaType(filePath: string): 'image' | 'video' | 'audio' | 'document' | null {
    const ext = filePath.split('.').pop()?.toLowerCase();
    if (!ext) return null;
    if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) return 'image';
    if (['mp4', 'mov', 'avi'].includes(ext)) return 'video';
    if (['mp3', 'ogg', 'm4a', 'wav'].includes(ext)) return 'audio';
    if (['pdf', 'doc', 'docx', 'xls', 'xlsx'].includes(ext)) return 'document';
    return null;
  }

  private _formatContext(messages: MessageEntry[], currentMsg?: {
    type?: string; filePath?: string; media?: { mimetype?: string; caption?: string };
  }): string {
    const lines = messages.map(m =>
      `<message sender="${this._esc(m.sender)}" time="${m.timestamp}">${this._esc(m.content)}</message>`
    );

    let context = `<messages>\n${lines.join('\n')}\n</messages>`;

    // Append media context for the current message if it has a file
    if (currentMsg?.filePath && currentMsg?.type && currentMsg.type !== 'text') {
      context += `\n\n<attached-media type="${currentMsg.type}" path="${this._esc(currentMsg.filePath)}"`;
      if (currentMsg.media?.mimetype) context += ` mimetype="${this._esc(currentMsg.media.mimetype)}"`;
      if (currentMsg.media?.caption) context += ` caption="${this._esc(currentMsg.media.caption)}"`;
      context += ` />\n<instruction>The user sent a ${currentMsg.type} file. You can read it at the path above using the Read tool. If it's an image, you can view it directly. Respond to the media content.</instruction>`;
    }

    return context;
  }

  private _esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ─── Memory System ──────────────────────────────────────────────

  /** Get the memory directory path for a group folder */
  private _memoryDir(groupFolder: string): string {
    // Memory lives inside the group's working directory
    const baseDir = path.join(process.env.HOME || '', 'Projects');
    return path.join(baseDir, groupFolder, 'memory');
  }

  /** Ensure memory directory and seed empty bucket files */
  private _ensureMemoryDir(groupFolder: string): string {
    const dir = this._memoryDir(groupFolder);
    fs.mkdirSync(dir, { recursive: true });

    const buckets = ['decisions.md', 'preferences.md', 'rules.md'];
    for (const bucket of buckets) {
      const filePath = path.join(dir, bucket);
      if (!fs.existsSync(filePath)) {
        const title = bucket.replace('.md', '');
        fs.writeFileSync(filePath, `# ${title.charAt(0).toUpperCase() + title.slice(1)}\n\n`);
      }
    }

    // Ensure conversation.md exists
    const convPath = path.join(dir, 'conversation.md');
    if (!fs.existsSync(convPath)) {
      fs.writeFileSync(convPath, '# Conversation History\n\n');
    }

    return dir;
  }

  /** Append a completed round-trip (user query + agent response) to conversation.md and log.jsonl */
  private async _appendConversation(
    groupFolder: string,
    userMessage: string,
    agentResponse: string,
    senderName: string,
  ): Promise<void> {
    const dir = this._ensureMemoryDir(groupFolder);
    const timestamp = new Date().toISOString();
    const dateStr = new Date().toLocaleString();

    // Append to conversation.md
    const convPath = path.join(dir, 'conversation.md');
    const entry = `## ${dateStr}\n**${senderName}:** ${userMessage}\n**Agent:** ${agentResponse}\n\n`;
    await fs.promises.appendFile(convPath, entry);

    // Append to log.jsonl (one JSON object per line)
    const logPath = path.join(dir, 'log.jsonl');
    const logEntry = JSON.stringify({
      timestamp,
      sender: senderName,
      user: userMessage.slice(0, 1000),
      agent: agentResponse.slice(0, 2000),
    }) + '\n';
    await fs.promises.appendFile(logPath, logEntry);

    // Enforce conversation limit — keep last N conversations
    await this._trimConversations(convPath);
  }

  /** Keep only the last maxConversations entries in conversation.md */
  private async _trimConversations(convPath: string): Promise<void> {
    const content = await fs.promises.readFile(convPath, 'utf-8');
    const sections = content.split(/^## /m).filter(s => s.trim());
    const max = this.settings.maxConversations;

    if (sections.length <= max + 1) return; // +1 for the title section

    // Keep the title line and the last N conversation sections
    const title = '# Conversation History\n\n';
    const kept = sections.slice(-max).map(s => `## ${s}`).join('');
    await fs.promises.writeFile(convPath, title + kept);
  }

  /** Read memory files and build a memory context block for the agent */
  private async _buildMemoryPrompt(groupFolder: string): Promise<string> {
    const dir = this._memoryDir(groupFolder);
    if (!fs.existsSync(dir)) return '';

    const parts: string[] = [];

    // Read bucket files — only include non-empty ones
    for (const bucket of ['decisions.md', 'preferences.md', 'rules.md']) {
      const filePath = path.join(dir, bucket);
      try {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        // Skip if only has the title line
        const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#'));
        if (lines.length > 0) {
          parts.push(content.trim());
        }
      } catch { /* file doesn't exist yet */ }
    }

    // Read conversation.md
    const convPath = path.join(dir, 'conversation.md');
    try {
      const conv = await fs.promises.readFile(convPath, 'utf-8');
      const lines = conv.split('\n').filter(l => l.trim() && !l.startsWith('#'));
      if (lines.length > 0) {
        parts.push(conv.trim());
      }
    } catch { /* no conversations yet */ }

    if (parts.length === 0) return '';

    return `<memory>\n${parts.join('\n\n---\n\n')}\n</memory>\n\nThe above is your persistent memory from previous conversations. Use it for context. The memory/ directory also contains a log.jsonl file with the full raw history — grep it if you need older details.`;
  }

  /**
   * Compact conversation history into bucketed memory files.
   * Reads conversation.md and log.jsonl, uses an LLM to categorize facts,
   * and writes to decisions.md, preferences.md, rules.md.
   *
   * @title Compact Memory
   * @param group Group name (partial match) {@example "Arul and Lura"}
   */
  async compact(params: { group: string }): Promise<{ compacted: number; decisions: number; preferences: number; rules: number }> {
    const query = params.group.toLowerCase();
    const name = Object.keys(this.registry).find(k => k.toLowerCase().includes(query));
    if (!name) throw new Error(`No registered group matching "${params.group}"`);

    const config = this.registry[name];
    const primaryFolder = config.folders[0];
    const dir = this._memoryDir(primaryFolder);

    if (!fs.existsSync(dir)) {
      return { compacted: 0, decisions: 0, preferences: 0, rules: 0 };
    }

    // Read current conversation.md
    const convPath = path.join(dir, 'conversation.md');
    let convContent = '';
    try { convContent = await fs.promises.readFile(convPath, 'utf-8'); } catch { /* empty */ }

    if (!convContent.trim() || convContent.split(/^## /m).filter(s => s.trim()).length <= 1) {
      return { compacted: 0, decisions: 0, preferences: 0, rules: 0 };
    }

    // Read existing buckets for deduplication context
    const existingBuckets: Record<string, string> = {};
    for (const bucket of ['decisions.md', 'preferences.md', 'rules.md']) {
      try {
        existingBuckets[bucket] = await fs.promises.readFile(path.join(dir, bucket), 'utf-8');
      } catch {
        existingBuckets[bucket] = '';
      }
    }

    // Use the router to categorize — any LLM works
    const compactPrompt = `You are a memory compaction system. Analyze the conversation history below and extract durable facts into three categories.

EXISTING MEMORY (do not duplicate — update or skip if already captured):
<decisions>
${existingBuckets['decisions.md']}
</decisions>
<preferences>
${existingBuckets['preferences.md']}
</preferences>
<rules>
${existingBuckets['rules.md']}
</rules>

CONVERSATION HISTORY TO PROCESS:
${convContent}

INSTRUCTIONS:
1. Extract NEW facts only — skip anything already in existing memory
2. Update existing facts if the conversation contradicts or refines them
3. Categorize each fact:
   - DECISION: Something that was decided and acted upon (e.g., "Use GitHub OAuth, not Google")
   - PREFERENCE: How the user likes things done (e.g., "Prefers terse responses")
   - RULE: A constraint or guideline (e.g., "Never mock the database in tests")
4. Ignore exploratory questions, casual chat, and clarification exchanges
5. Each fact should be one line, starting with "- "

Respond in EXACTLY this format (include all three sections even if empty):
<decisions>
- fact one
- fact two
</decisions>
<preferences>
- fact one
</preferences>
<rules>
- fact one
</rules>`;

    const result = await this.router.run({
      groupFolder: '_memory-compact',
      prompt: compactPrompt,
      agent: config.agent,
    });

    if (result.status !== 'success' || !result.output) {
      throw new Error('Compaction failed: ' + (result.error || 'no output'));
    }

    // Parse the categorized output
    const output = result.output;
    const counts = { decisions: 0, preferences: 0, rules: 0 };

    for (const [bucket, key] of [['decisions.md', 'decisions'], ['preferences.md', 'preferences'], ['rules.md', 'rules']] as const) {
      const match = output.match(new RegExp(`<${key}>([\\s\\S]*?)</${key}>`));
      if (!match) continue;

      const newFacts = match[1].trim().split('\n').filter((l: string) => l.trim().startsWith('- '));
      if (newFacts.length === 0) continue;

      counts[key] = newFacts.length;

      // Append new facts to the bucket file
      const bucketPath = path.join(dir, bucket);
      const existing = existingBuckets[bucket] || `# ${key.charAt(0).toUpperCase() + key.slice(1)}\n\n`;
      const updated = existing.trimEnd() + '\n' + newFacts.join('\n') + '\n';
      await fs.promises.writeFile(bucketPath, updated);
    }

    // Reset conversation.md — keep only the header
    await fs.promises.writeFile(convPath, '# Conversation History\n\n');

    const total = counts.decisions + counts.preferences + counts.rules;
    this.emit({ type: 'compacted', group: name, folder: primaryFolder, ...counts, total });

    return { compacted: total, ...counts };
  }

  /** Schedule memory compaction for all memory-enabled groups */
  private async _scheduleCompaction(): Promise<void> {
    const taskName = 'memory-compact-all';
    const existing = await this.schedule.getByName(taskName).catch(() => null);
    if (existing) return; // Already scheduled

    await this.schedule.create({
      name: taskName,
      schedule: this.settings.compactCron,
      method: '_compactAll',
      params: {},
    });
  }

  /** Internal: compact all memory-enabled groups (called by scheduler) */
  async _compactAll(): Promise<void> {
    for (const [name] of Object.entries(this.registry)) {
      try {
        await this.compact({ group: name });
      } catch (err: any) {
        this.emit({ type: 'compact_error', group: name, error: err.message });
      }
    }
  }
}

// ─── Types ─────────────────────────────────────────────────────────

interface GroupConfig {
  trigger: string;
  requiresTrigger: boolean;
  folders: string[];
  addedAt: string;
  /** Allowed sender phone numbers (digits only). Empty = allow all. */
  allowedSenders: string[];
  /** System prompt prepended to every agent run for this group. */
  systemPrompt: string;
  /** Agent to use: 'claude' | 'gemini' | 'aider' | 'opencode' | 'auto' */
  agent: string;
  /** Channel this group belongs to: 'whatsapp' | 'telegram' */
  channel: 'whatsapp' | 'telegram';
  /** Delivery schedule via courier (e.g. '@30m', '@hourly'). Omit for real-time. */
  schedule?: string;
}

interface MessageEntry {
  sender: string;
  content: string;
  timestamp: string;
  fromMe?: boolean;
}

interface QueueItem {
  groupName: string;
  config: GroupConfig;
  event?: any;       // single message from direct channel subscription
  batch?: any[];     // batch of messages from courier scheduled delivery
}
