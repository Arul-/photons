import { Photon } from '@portel/photon-core';

/**
 * Claw — orchestrates WhatsApp ↔ Claude agent pipeline.
 *
 * Wires photons together:
 *   whatsapp → message-router → agent-runner → whatsapp
 *
 * Prerequisites:
 *   1. Run `photon whatsapp connect` once to authenticate
 *   2. Register groups via `photon claw register --jid ... --name ... --folder ... --trigger ...`
 *   3. Run `photon claw start` to begin the pipeline
 *
 * @version 1.0.0
 * @icon 🦞
 * @tags orchestrator, whatsapp, agent, claw
 * @stateful
 */
export default class Claw extends Photon {
  private running = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private processing = false;
  private sessionMap: Record<string, string> = {}; // groupFolder → sessionId
  private lastHealth: { ok: boolean; whatsapp: string; runner: string; checkedAt: string } | null = null;

  protected settings = {
    /** Message polling interval in milliseconds */
    pollIntervalMs: 2000,
    /** Heartbeat interval in milliseconds (health checks) */
    heartbeatIntervalMs: 30000,
    /** Auto-resume pipeline after daemon restart */
    autoResume: true,
  };

  async onInitialize(ctx?: { reason?: string; oldInstance?: any }): Promise<void> {
    // Hot-reload: transfer running state from old instance
    if (ctx?.reason === 'hot-reload' && ctx.oldInstance) {
      const old = ctx.oldInstance;
      this.running = old.running || false;
      this.sessionMap = old.sessionMap || {};
      this.lastHealth = old.lastHealth || null;
      this.processing = old.processing || false;

      // Transfer timers — null them on old instance so they aren't double-cleared
      if (old.pollTimer) {
        this.pollTimer = old.pollTimer;
        old.pollTimer = null;
      }
      if (old.heartbeatTimer) {
        this.heartbeatTimer = old.heartbeatTimer;
        old.heartbeatTimer = null;
      }

      this.emit({ type: 'hot_reload_transferred', running: this.running });
      return;
    }

    // Normal startup
    const saved = await this.memory.get<Record<string, string>>('sessionMap');
    if (saved) this.sessionMap = saved;

    // Auto-resume if pipeline was running before daemon restart.
    // Wait briefly for WhatsApp to auto-connect from saved credentials.
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
      setTimeout(() => tryResume(), 2000);
    }
  }

  async onShutdown(ctx?: { reason?: string }): Promise<void> {
    // During hot-reload, DON'T clear timers — the new instance will take them over
    if (ctx?.reason === 'hot-reload') {
      return;
    }

    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    this.running = false;
  }

  // Cross-photon calls via this.call()
  private bridge = {
    connect: () => this.call('whatsapp.connect', {}),
    disconnect: () => this.call('whatsapp.disconnect', {}),
    send: (params: { jid: string; text: string }) => this.call('whatsapp.send', params),
    status: () => this.call('whatsapp.status', {}),
    pending: () => this.call('whatsapp.pending', {}),
    typing: (params: { jid: string; typing: boolean }) => this.call('whatsapp.typing', params),
  };
  private router = {
    register: (params: any) => this.call('message-router.register', params),
    unregister: (params: any) => this.call('message-router.unregister', params),
    route: (params: any) => this.call('message-router.route', params),
    groups: () => this.call('message-router.groups', {}),
  };
  private runner = {
    run: (params: any) => this.call('agent-runner.run', params),
    status: () => this.call('agent-runner.status', {}),
  };

  /**
   * Start the pipeline: verify WhatsApp connection, begin polling for messages.
   * WhatsApp must be connected first via `photon whatsapp connect`.
   */
  async start(): Promise<{ status: string; phone?: string; groups?: number }> {
    if (this.running) return { status: 'already running' };

    // 1. Check WhatsApp connection
    const waStatus = await this.bridge.status();
    if (waStatus.status !== 'connected') {
      throw new Error(
        `WhatsApp is not connected (status: ${waStatus.status}). ` +
        `Run 'photon whatsapp connect' first to authenticate.`
      );
    }

    // 2. Check we have registered groups
    const groups = await this.router.groups();

    // 3. Start polling for messages
    this.running = true;
    await this.memory.set('running', true);
    this.pollTimer = setInterval(() => {
      this._pollMessages().catch((err) => {
        this.emit({ type: 'poll_error', error: err.message });
      });
    }, this.settings.pollIntervalMs);

    // 4. Start heartbeat for health monitoring and recovery
    this.heartbeatTimer = setInterval(() => {
      this._heartbeat().catch(() => {});
    }, this.settings.heartbeatIntervalMs);

    this.emit({ type: 'started', phone: waStatus.phone, groups: groups.length });
    return {
      status: 'started',
      phone: waStatus.phone,
      groups: groups.length,
    };
  }

  /**
   * Stop the pipeline.
   */
  async stop(): Promise<{ status: string }> {
    if (!this.running) return { status: 'not running' };

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.running = false;
    await this.memory.set('running', false);
    await this.memory.set('sessionMap', this.sessionMap);

    this.emit({ type: 'stopped' });
    return { status: 'stopped' };
  }

  /**
   * Register a WhatsApp group for agent routing.
   * @param jid WhatsApp JID {@example "123456789@g.us"}
   * @param name Display name {@example "Dev Team"}
   * @param folder Group folder name for agent context {@example "dev-team"}
   * @param trigger Trigger pattern {@example "@bot"}
   * @param requiresTrigger Only route messages with trigger (default: true)
   */
  async register(params: {
    jid: string;
    name: string;
    folder: string;
    trigger: string;
    requiresTrigger?: boolean;
  }): Promise<any> {
    return this.router.register(params);
  }

  /**
   * Remove a group from routing.
   * @param jid WhatsApp JID to unregister {@example "123456789@g.us"}
   */
  async unregister(params: { jid: string }): Promise<any> {
    return this.router.unregister(params);
  }

  /**
   * Show latest health check result.
   * @readOnly
   * @format json
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
    // Run a fresh check if no cached result
    if (!this.lastHealth) {
      await this._heartbeat();
    }
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
   * @format json
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

    const [whatsapp, runnerStatus, groups] = await Promise.all([
      safe(() => this.bridge.status(), { status: 'unknown' }),
      safe(() => this.runner.status(), { active: [], queued: 0 }),
      safe(() => this.router.groups(), []),
    ]);

    return { running: this.running, whatsapp, runner: runnerStatus, groups };
  }

  // ─── Internal ──────────────────────────────────────────────────

  private async _heartbeat(): Promise<void> {
    if (!this.running) return;

    const checkedAt = new Date().toISOString();
    let waStatus = 'unknown';
    let runnerStatus = 'unknown';
    let ok = true;

    // Check WhatsApp
    try {
      const wa = await this.bridge.status();
      waStatus = wa.status;
      if (wa.status !== 'connected') {
        ok = false;
        this.emit({ type: 'heartbeat_warn', component: 'whatsapp', status: wa.status });
        // Attempt reconnect
        this.bridge.connect().catch(() => {});
      }
    } catch {
      ok = false;
      waStatus = 'unreachable';
    }

    // Check agent runner
    try {
      const runner = await this.runner.status();
      runnerStatus = `active:${runner.active?.length ?? 0},queued:${runner.queued ?? 0}`;
    } catch {
      ok = false;
      runnerStatus = 'unreachable';
    }

    this.lastHealth = { ok, whatsapp: waStatus, runner: runnerStatus, checkedAt };

    this.emit({
      type: 'heartbeat',
      ok,
      whatsapp: waStatus,
      runner: runnerStatus,
      checkedAt,
    });
  }

  private async _pollMessages(): Promise<void> {
    if (!this.running || this.processing) return;
    this.processing = true;

    try {
      const messages: Array<{ chatJid: string; message: any }> = await this.bridge.pending();
      if (!messages || messages.length === 0) return;

      for (const event of messages) {
        await this._handleMessage(event).catch((err) => {
          this.emit({ type: 'handle_error', chatJid: event.chatJid, error: err.message });
        });
      }
    } finally {
      this.processing = false;
    }
  }

  private async _handleMessage(event: {
    chatJid: string;
    message: { sender: string; senderName: string; content: string; fromMe: boolean; timestamp: string };
  }): Promise<void> {
    const msg = event.message;

    // Route the message
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

    // Show typing indicator
    await this.bridge.typing({ jid: event.chatJid, typing: true }).catch(() => {});

    // Execute via agent runner
    const result = await this.runner.run({
      groupFolder: decision.folder,
      prompt: decision.formattedContext,
      chatJid: event.chatJid,
      sessionId: this.sessionMap[decision.folder],
    });

    // Track session for continuity
    if (result.sessionId) {
      this.sessionMap[decision.folder] = result.sessionId;
      await this.memory.set('sessionMap', this.sessionMap);
    }

    // Send reply
    if (result.status === 'success' && result.output) {
      await this.bridge.send({ jid: event.chatJid, text: result.output });
      this.emit({
        type: 'replied',
        jid: event.chatJid,
        folder: decision.folder,
        duration: result.duration,
        outputLength: result.output.length,
      });
    } else if (result.error) {
      this.emit({
        type: 'error',
        source: 'agent-runner',
        folder: decision.folder,
        error: result.error,
      });
    }
  }
}
