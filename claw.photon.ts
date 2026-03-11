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
  private pollIntervalMs = 2000;
  private processing = false;
  private sessionMap: Record<string, string> = {}; // groupFolder → sessionId

  async onInitialize(): Promise<void> {
    const saved = await this.memory.get<Record<string, string>>('sessionMap');
    if (saved) this.sessionMap = saved;
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
    this.pollTimer = setInterval(() => {
      this._pollMessages().catch((err) => {
        this.emit({ type: 'poll_error', error: err.message });
      });
    }, this.pollIntervalMs);

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
    this.running = false;

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
