import { Photon } from '@portel/photon-core';

/**
 * Claw — orchestrates WhatsApp ↔ Claude agent pipeline.
 *
 * Subscribe to WhatsApp groups, route messages to an agent runner,
 * and send responses back. Uses WhatsApp's .on() for event-driven
 * message handling with group and trigger filtering.
 *
 * @version 3.0.0
 * @icon 🦞
 * @tags orchestrator, whatsapp, agent, claw
 * @stateful
 * @photon whatsapp ./whatsapp.photon.ts
 * @photon runner ./agent-runner.photon.ts
 */
export default class Claw extends Photon {
  private running = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private sessionMap: Record<string, string> = {}; // folder → sessionId
  private lastHealth: { ok: boolean; whatsapp: string; runner: string; checkedAt: string } | null = null;
  private autoResumeTimer: ReturnType<typeof setTimeout> | null = null;

  // Group registry — persisted via this.memory, keyed by canonical group name
  private registry: Record<string, GroupConfig> = {};
  // Message handlers — one per registered group, keyed by group name
  private handlers: Map<string, (msg: any) => void> = new Map();
  // Message log per group name for context building
  private messageLog: Record<string, MessageEntry[]> = {};
  constructor(
    private whatsapp: any,
    private runner: any,
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

      if (old.heartbeatTimer) {
        this.heartbeatTimer = old.heartbeatTimer;
        old.heartbeatTimer = null;
      }

      old.handlers = null;
      this.emit({ type: 'hot_reload_transferred', running: this.running });
      return;
    }

    // Normal startup — restore persisted state
    const saved = await this.memory.get<Record<string, GroupConfig>>('registry');
    if (saved) this.registry = saved;

    const savedSessions = await this.memory.get<Record<string, string>>('sessionMap');
    if (savedSessions) this.sessionMap = savedSessions;


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
            this.emit({ type: 'auto_resume_failed', message: 'WhatsApp not connected after retries' });
          }
        }
      };
      this.autoResumeTimer = setTimeout(() => tryResume(), 2000);
    }
  }

  async onShutdown(ctx?: { reason?: string }): Promise<void> {
    if (ctx?.reason === 'hot-reload') return;
    this._unsubscribeAll();
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    this.running = false;
  }

  /**
   * Start the pipeline: verify WhatsApp connection, subscribe to registered groups.
   * Streams progress while waiting for WhatsApp to connect.
   *
   * @title Start Pipeline
   * @openWorld
   */
  async *start() {
    if (this.running) {
      return 'Already running';
    }

    yield { emit: 'status', message: 'Checking WhatsApp connection...' };

    let waStatus = await this.whatsapp.status();

    if (waStatus.status !== 'connected') {
      if (waStatus.status === 'disconnected') {
        yield { emit: 'status', message: 'WhatsApp disconnected — attempting to reconnect...' };
        try {
          const connectResult = await this.whatsapp.connect();
          if (connectResult.status === 'qr_pending') {
            return 'WhatsApp needs QR authentication. Run `photon whatsapp connect` to scan the QR code, then `claw start` again.';
          }
        } catch {
          // connect() may fail transiently — fall through to polling
        }
      }

      // Poll until connected — yield progress so the user sees what's happening
      const maxWaitMs = 120_000;
      const started = Date.now();
      while (Date.now() - started < maxWaitMs) {
        await new Promise(r => setTimeout(r, 3000));
        waStatus = await this.whatsapp.status();
        if (waStatus.status === 'connected') break;
        const elapsed = Math.round((Date.now() - started) / 1000);
        yield { emit: 'status', message: `Waiting for WhatsApp... ${elapsed}s (${waStatus.status})` };
      }

      if (waStatus.status !== 'connected') {
        return `WhatsApp did not connect within 120s (status: ${waStatus.status}). Run \`photon whatsapp connect\` manually, then \`claw start\`.`;
      }
    }

    yield { emit: 'status', message: `WhatsApp connected (${waStatus.phone}) — subscribing to groups...` };

    // Auto-seed each group's allowlist with own number if not yet set
    if (waStatus.phone) {
      const ownPhone = waStatus.phone.replace(/\D/g, '');
      let changed = false;
      for (const config of Object.values(this.registry)) {
        if (config.allowedSenders.length === 0) {
          config.allowedSenders = [ownPhone];
          changed = true;
        }
      }
      if (changed) await this.memory.set('registry', this.registry);
    }

    this.running = true;
    await this.memory.set('running', true);

    this._subscribeAll();

    this.heartbeatTimer = setInterval(() => {
      this._heartbeat().catch(() => {});
    }, this.settings.heartbeatIntervalMs);

    const groupCount = Object.keys(this.registry).length;
    this.emit({ type: 'started', phone: waStatus.phone, groups: groupCount });
    yield { emit: 'toast', message: `Pipeline started — ${groupCount} group(s) active`, type: 'success' };
    return `Started. Phone: ${waStatus.phone}, groups: ${groupCount}`;
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
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    this.running = false;
    await this.memory.set('running', false);
    await this.memory.set('sessionMap', this.sessionMap);

    this.emit({ type: 'stopped' });
    return { status: 'stopped' };
  }

  /**
   * Register a WhatsApp group for agent routing.
   * Fuzzy-matches the group name from your WhatsApp groups.
   *
   * @title Register Group
   * @openWorld
   * @param group WhatsApp group name or partial match {@example "Learn CS"}
   * @param trigger Trigger word to activate the agent (empty = participant mode) {@example "@"}
   * @param folders Folder names the agent can access — first is the primary context folder {@example ["lura", "photon"]}
   * @param requiresTrigger Only route messages containing the trigger (default: true when trigger is non-empty)
   * @param systemPrompt System prompt prepended to every agent run for this group {@example "You are Lura, a concise personal assistant."}
   */
  async register(params: {
    group: string;
    trigger: string;
    folders: string[];
    requiresTrigger?: boolean;
    systemPrompt?: string;
  }): Promise<{ name: string } & GroupConfig> {
    const waGroups = await this.whatsapp.groups();
    const query = params.group.toLowerCase();
    const match = waGroups.find((g: any) =>
      g.name.toLowerCase().includes(query) || g.jid === params.group
    );
    if (!match) {
      throw new Error(
        `No group matching "${params.group}". Run 'photon whatsapp groups' to see available groups.`
      );
    }

    const config: GroupConfig = {
      trigger: params.trigger,
      requiresTrigger: params.requiresTrigger ?? (params.trigger.length > 0),
      folders: params.folders,
      addedAt: new Date().toISOString(),
      allowedSenders: [],
      systemPrompt: params.systemPrompt ?? '',
    };

    this.registry[match.name] = config;
    await this.memory.set('registry', this.registry);

    // Subscribe immediately if running
    if (this.running) {
      this._subscribeGroup(match.name, config);
    }

    this.emit({ type: 'registered', name: match.name, config });
    return { name: match.name, ...config };
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

    const handler = this.handlers.get(name);
    if (handler) {
      this.whatsapp.off('message', handler);
      this.handlers.delete(name);
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
   */
  async configure(params: {
    group: string;
    trigger?: string;
    folders?: string[];
    requiresTrigger?: boolean;
    systemPrompt?: string;
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
    delete this.sessionMap[config.folders[0]];
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
   * List available WhatsApp groups for registration.
   *
   * @title List Groups
   * @readOnly
   * @openWorld
   * @format table
   */
  async groups(): Promise<Array<{ name: string; registered: boolean; folders?: string[]; trigger?: string }>> {
    const waGroups = await this.whatsapp.groups();
    return waGroups.map((g: any) => {
      const config = this.registry[g.name];
      return {
        name: g.name,
        registered: !!config,
        ...(config ? { folders: config.folders, trigger: config.trigger } : {}),
      };
    });
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
    runner: string;
    checkedAt: string | null;
  }> {
    if (!this.running) {
      return { ok: false, running: false, whatsapp: 'unknown', runner: 'unknown', checkedAt: null };
    }
    if (!this.lastHealth) await this._heartbeat();
    return {
      ok: this.lastHealth?.ok ?? false,
      running: this.running,
      whatsapp: this.lastHealth?.whatsapp ?? 'unknown',
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
   * @format card
   */
  async status(): Promise<{
    running: boolean;
    whatsapp: any;
    runner: any;
    groups: Array<{ name: string } & GroupConfig>;
  }> {
    const safe = async (fn: () => Promise<any>, fallback: any = null) => {
      try { return await fn(); } catch { return fallback; }
    };

    const [whatsapp, runnerStatus] = await Promise.all([
      safe(() => this.whatsapp.status(), { status: 'unknown' }),
      safe(() => this.runner.status(), { active: [], queued: 0 }),
    ]);

    return {
      running: this.running,
      whatsapp,
      runner: runnerStatus,
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

    const result = await this.runner.run({
      groupFolder: primaryFolder,
      prompt,
      sessionId: this.sessionMap[primaryFolder],
      ...(config.folders.slice(1).length > 0 ? { addDirs: config.folders.slice(1) } : {}),
    });

    if (result.sessionId) {
      this.sessionMap[primaryFolder] = result.sessionId;
      await this.memory.set('sessionMap', this.sessionMap);
    }

    if (result.status === 'success' && result.output) {
      await this._sendAgentResponse(groupName, result.output, primaryFolder, result.duration);
    }
  }

  private _subscribeAll(): void {
    for (const [name, config] of Object.entries(this.registry)) {
      this._subscribeGroup(name, config);
    }
  }

  private _subscribeGroup(name: string, config: GroupConfig): void {
    // Remove existing handler for this group if any
    const existing = this.handlers.get(name);
    if (existing) this.whatsapp.off('message', existing);

    const handler = (msg: any) => {
      if (!this.running) return;
      this._handleMessage(name, config, msg).catch((err) => {
        this.emit({ type: 'handle_error', group: name, error: err.message });
      });
    };

    const filter: any = { group: name };
    if (config.requiresTrigger) filter.trigger = config.trigger;
    this.whatsapp.on('message', handler, filter);
    this.handlers.set(name, handler);
  }

  private _unsubscribeAll(): void {
    for (const handler of this.handlers.values()) {
      this.whatsapp.off('message', handler);
    }
    this.handlers.clear();
  }

  private async _heartbeat(): Promise<void> {
    if (!this.running) return;

    const checkedAt = new Date().toISOString();
    let waStatus = 'unknown';
    let runnerStatus = 'unknown';
    let ok = true;

    try {
      const wa = await this.whatsapp.status();
      waStatus = wa.status;
      if (wa.status !== 'connected') {
        ok = false;
        this.emit({ type: 'heartbeat_warn', component: 'whatsapp', status: wa.status });
        // Don't call connect() here — WhatsApp photon handles its own reconnection.
        // Calling connect() from heartbeat causes socket races (concurrent connections).
      }
    } catch {
      ok = false;
      waStatus = 'unreachable';
    }

    try {
      const r = await this.runner.status();
      runnerStatus = `active:${r.active?.length ?? 0},queued:${r.queued ?? 0}`;
    } catch {
      ok = false;
      runnerStatus = 'unreachable';
    }

    this.lastHealth = { ok, whatsapp: waStatus, runner: runnerStatus, checkedAt };
    this.emit({ type: 'heartbeat', ok, whatsapp: waStatus, runner: runnerStatus, checkedAt });
  }

  private async _handleMessage(name: string, config: GroupConfig, event: {
    chatJid: string;
    message: {
      sender: string; senderName: string; content: string; fromMe: boolean; timestamp: string;
      type?: string; filePath?: string; media?: { mimetype?: string; caption?: string };
    };
  }): Promise<void> {
    const msg = event.message;
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
      folders: config.folders,
      textPreview: msg.content.slice(0, 80),
      messageType: msg.type || 'text',
    });

    // Quick ACK so the user knows the message was received
    const acks = ['Noted, on it.', 'Got it, thinking...', 'On it.', 'Noted.', 'Working on it...'];
    const ackResult = await this.whatsapp.send({ chat: name, text: acks[Math.floor(Math.random() * acks.length)] }).catch(() => null);
    const ackKey = ackResult?.key ?? null;

    // Keep typing indicator alive during agent processing (WhatsApp expires it after ~25s)
    await this.whatsapp.typing({ chat: name, typing: true }).catch(() => {});
    const typingInterval = setInterval(() => {
      this.whatsapp.typing({ chat: name, typing: true }).catch(() => {});
    }, 20_000);

    // Collect addDirs: extra config folders + media dir from attachment
    const addDirs: string[] = config.folders.slice(1);
    if (msg.filePath) {
      const mediaDir = msg.filePath.substring(0, msg.filePath.lastIndexOf('/'));
      if (!addDirs.includes(mediaDir)) addDirs.push(mediaDir);
    }

    let result: any;
    try {
      result = await this.runner.run({
        groupFolder: primaryFolder,
        prompt: context,
        chatJid: event.chatJid,
        sessionId: this.sessionMap[primaryFolder],
        ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
        ...(addDirs.length > 0 ? { addDirs } : {}),
      });
    } finally {
      clearInterval(typingInterval);
      this.whatsapp.typing({ chat: name, typing: false }).catch(() => {});
    }

    if (result.sessionId) {
      this.sessionMap[primaryFolder] = result.sessionId;
      await this.memory.set('sessionMap', this.sessionMap);
    }

    if (result.status === 'success' && result.output) {
      await this._sendAgentResponse(name, result.output, primaryFolder, result.duration, ackKey);
    } else if (result.error) {
      this.emit({ type: 'error', source: 'agent-runner', group: name, error: result.error });
    }
  }

  /** Send agent response, editing the ACK message in-place if possible */
  private async _sendAgentResponse(chat: string, output: string, folder: string, duration: number, ackKey?: any): Promise<void> {
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

    // Send text portion — edit the ACK in-place if we have its key, else send fresh
    if (textOutput.trim()) {
      const prefixed = `${this.settings.agentName}: ${textOutput.trim()}`;
      if (ackKey) {
        await this.whatsapp.edit({ key: ackKey, text: prefixed }).catch(async () => {
          // Fall back to a new message if edit fails (e.g. too old, unsupported client)
          await this.whatsapp.send({ chat, text: prefixed });
        });
        ackKey = null; // consumed — media attachments below go as separate messages
      } else {
        await this.whatsapp.send({ chat, text: prefixed });
      }
    }

    // Send each media file
    for (const media of mediaFiles) {
      try {
        await this.whatsapp.media({
          chat,
          url: media.path,
          type: media.type,
          caption: media.caption || undefined,
        });
      } catch (err: any) {
        this.emit({ type: 'error', source: 'media_send', folder, error: err.message, path: media.path });
        // Fallback: send the path as text so the user knows something was generated
        await this.whatsapp.send({ chat, text: `[Media file: ${media.path}]` }).catch(() => {});
      }
    }

    this.emit({
      type: 'replied',
      group: chat,
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
}

interface MessageEntry {
  sender: string;
  content: string;
  timestamp: string;
  fromMe?: boolean;
}
