import { Photon } from '@portel/photon-core';

/**
 * Claw — orchestrates WhatsApp ↔ Claude agent pipeline.
 *
 * Wires photons together:
 *   whatsapp → message-router → agent-runner → whatsapp
 *
 * Prerequisites:
 *   1. Run `photon whatsapp connect` once to authenticate
 *   2. Register groups via `photon claw register --group "Group Name" --folder ... --trigger ...`
 *   3. Run `photon claw start` to begin the pipeline
 *
 * @version 2.0.0
 * @icon 🦞
 * @tags orchestrator, whatsapp, agent, claw
 * @stateful
 * @photon whatsapp ./whatsapp.photon.ts
 * @photon router ./message-router.photon.ts
 * @photon runner ./agent-runner.photon.ts
 */
export default class Claw extends Photon {
  private running = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private sessionMap: Record<string, string> = {}; // groupFolder → sessionId
  private lastHealth: { ok: boolean; whatsapp: string; runner: string; checkedAt: string } | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private autoResumeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private whatsapp: any,
    private router: any,
    private runner: any,
  ) {
    super();
  }

  protected settings = {
    /** Heartbeat interval in milliseconds (health checks) */
    heartbeatIntervalMs: 30000,
    /** Auto-resume pipeline after daemon restart */
    autoResume: true,
  };

  async onInitialize(ctx?: { reason?: string; oldInstance?: any }): Promise<void> {
    if (ctx?.reason === 'hot-reload' && ctx.oldInstance) {
      const old = ctx.oldInstance;
      this.running = old.running || false;
      this.sessionMap = old.sessionMap || {};
      this.lastHealth = old.lastHealth || null;

      if (old.heartbeatTimer) {
        this.heartbeatTimer = old.heartbeatTimer;
        old.heartbeatTimer = null;
      }
      if (old.pollTimer) {
        this.pollTimer = old.pollTimer;
        old.pollTimer = null;
      }

      this.emit({ type: 'hot_reload_transferred', running: this.running });
      return;
    }

    // Normal startup
    const saved = await this.memory.get<Record<string, string>>('sessionMap');
    if (saved) this.sessionMap = saved;

    const wasRunning = await this.memory.get<boolean>('running');
    if (wasRunning && this.settings.autoResume) {
      const tryResume = async (attempts = 0): Promise<void> => {
        try {
          await this.start();
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

    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    this.running = false;
  }

  /**
   * Start the pipeline: verify WhatsApp connection, subscribe to messages.
   * WhatsApp must be connected first via `photon whatsapp connect`.
   */
  async start(): Promise<{ status: string; phone?: string; groups?: number }> {
    if (this.running) return { status: 'already running' };

    // Wait for WhatsApp to connect — auto-connects on startup, may need QR scan.
    // Timeout after 60 seconds with a clear message.
    let waStatus = await this.whatsapp.status();
    if (waStatus.status !== 'connected') {
      if (waStatus.status === 'disconnected') {
        try {
          const connectResult = await this.whatsapp.connect();
          if (connectResult.status === 'qr_pending') {
            return {
              status: 'qr_pending',
              message: 'WhatsApp needs QR authentication. Run `photon whatsapp connect` to scan the QR code, then run `claw start` again.',
            } as any;
          }
        } catch {
          // connect() may fail transiently — fall through to polling
        }
      }

      const maxWaitMs = 60_000;
      const started = Date.now();
      while (Date.now() - started < maxWaitMs) {
        await new Promise(r => setTimeout(r, 3000));
        waStatus = await this.whatsapp.status();
        if (waStatus.status === 'connected') break;
        const elapsed = Math.round((Date.now() - started) / 1000);
        this.emit({ type: 'status', message: `Waiting for WhatsApp... (${elapsed}s, status: ${waStatus.status})` });
      }

      if (waStatus.status !== 'connected') {
        return {
          status: 'timeout',
          message: `WhatsApp did not connect within 60s (status: ${waStatus.status}). Run \`photon whatsapp connect\` manually, then \`claw start\`.`,
        } as any;
      }
    }

    const groups = await this.router.groups();

    this.running = true;
    await this.memory.set('running', true);

    // Poll WhatsApp instance directly for new messages
    this.pollTimer = setInterval(async () => {
      if (!this.running) return;
      try {
        const messages = await this.whatsapp.pending();
        for (const msg of messages) {
          this._handleMessage(msg).catch((err) => {
            this.emit({ type: 'handle_error', chatJid: msg.chatJid, error: err.message });
          });
        }
      } catch (err: any) {
        this.emit({ type: 'poll_error', error: err.message });
      }
    }, 1000);

    // Heartbeat for health monitoring
    this.heartbeatTimer = setInterval(() => {
      this._heartbeat().catch(() => {});
    }, this.settings.heartbeatIntervalMs);

    this.emit({ type: 'started', phone: waStatus.phone, groups: groups.length });
    return { status: 'started', phone: waStatus.phone, groups: groups.length };
  }

  /**
   * Stop the pipeline.
   */
  async stop(): Promise<{ status: string }> {
    // Cancel pending autoResume even if not running yet (race with delayed resume)
    if (this.autoResumeTimer) { clearTimeout(this.autoResumeTimer); this.autoResumeTimer = null; }

    if (!this.running) {
      // Still persist running=false to prevent autoResume on next restart
      await this.memory.set('running', false);
      return { status: 'not running' };
    }

    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
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
   * @param group WhatsApp group name or partial match {@example "Learn CS"}
   * @param folder Group folder name for agent context {@example "learn-cs"}
   * @param trigger Trigger pattern {@example "@bot"}
   * @param requiresTrigger Only route messages with trigger (default: true)
   */
  async register(params: {
    group: string;
    folder: string;
    trigger: string;
    requiresTrigger?: boolean;
  }): Promise<any> {
    const groups = await this.whatsapp.groups();
    const query = params.group.toLowerCase();
    const match = groups.find((g: any) =>
      g.name.toLowerCase().includes(query) ||
      g.jid === params.group
    );
    if (!match) {
      throw new Error(
        `No group matching "${params.group}". ` +
        `Run 'photon whatsapp groups' to see available groups.`
      );
    }

    return this.router.register({
      jid: match.jid,
      name: match.name,
      folder: params.folder,
      trigger: params.trigger,
      requiresTrigger: params.requiresTrigger,
    });
  }

  /**
   * Remove a group from routing.
   * @param group WhatsApp group name or JID to unregister {@example "Learn CS"}
   */
  async unregister(params: { group: string }): Promise<any> {
    const groups = await this.whatsapp.groups();
    const query = params.group.toLowerCase();
    const match = groups.find((g: any) =>
      g.name.toLowerCase().includes(query) ||
      g.jid === params.group
    );
    if (!match) throw new Error(`No group matching "${params.group}"`);
    return this.router.unregister({ jid: match.jid });
  }

  /**
   * List available WhatsApp groups for registration.
   * @readOnly
   * @format table
   */
  async groups(): Promise<Array<{ jid: string; name: string; registered: boolean }>> {
    const waGroups = await this.whatsapp.groups();
    const registered = await this.router.groups();
    const registeredJids = new Set(registered.map((g: any) => g.jid));

    return waGroups.map((g: any) => ({
      jid: g.jid,
      name: g.name,
      registered: registeredJids.has(g.jid),
    }));
  }

  /**
   * Show latest health check result.
   * @readOnly
   * @format kv
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
   * @readOnly
   * @format kv
   */
  async status(): Promise<{
    running: boolean;
    whatsapp: any;
    runner: any;
    groups: any[];
  }> {
    const safe = async (fn: () => Promise<any>, fallback: any = null) => {
      try { return await fn(); } catch { return fallback; }
    };

    const [whatsapp, runnerStatus, routerGroups] = await Promise.all([
      safe(() => this.whatsapp.status(), { status: 'unknown' }),
      safe(() => this.runner.status(), { active: [], queued: 0 }),
      safe(() => this.router.groups(), []),
    ]);

    return { running: this.running, whatsapp, runner: runnerStatus, groups: routerGroups };
  }

  // ─── Internal ──────────────────────────────────────────────────

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
        this.whatsapp.connect().catch(() => {});
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

  private async _handleMessage(event: {
    chatJid: string;
    message: { sender: string; senderName: string; content: string; fromMe: boolean; timestamp: string };
  }): Promise<void> {
    const msg = event.message;

    const decision = await this.router.route({
      jid: event.chatJid,
      from: msg.sender,
      text: msg.content,
      fromMe: msg.fromMe,
      pushName: msg.senderName,
      timestamp: Math.floor(new Date(msg.timestamp).getTime() / 1000),
    });

    if (decision.action !== 'route') return;

    this.emit({
      type: 'routing',
      jid: event.chatJid,
      folder: decision.folder,
      textPreview: msg.content.slice(0, 80),
    });

    await this.whatsapp.typing({ jid: event.chatJid, typing: true }).catch(() => {});

    const result = await this.runner.run({
      groupFolder: decision.folder,
      prompt: decision.formattedContext,
      chatJid: event.chatJid,
      sessionId: this.sessionMap[decision.folder],
    });

    if (result.sessionId) {
      this.sessionMap[decision.folder] = result.sessionId;
      await this.memory.set('sessionMap', this.sessionMap);
    }

    if (result.status === 'success' && result.output) {
      await this.whatsapp.send({ jid: event.chatJid, text: result.output });
      this.emit({
        type: 'replied',
        jid: event.chatJid,
        folder: decision.folder,
        duration: result.duration,
        outputLength: result.output.length,
      });
    } else if (result.error) {
      this.emit({ type: 'error', source: 'agent-runner', folder: decision.folder, error: result.error });
    }
  }
}
