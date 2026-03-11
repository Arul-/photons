import { Photon } from '@portel/photon-core';

/**
 * Claw — orchestrates WhatsApp ↔ Claude agent pipeline.
 *
 * Wires four photons together:
 *   whatsapp-bridge → message-router → agent-runner → whatsapp-bridge
 *                                          ↑
 *                     group-scheduler ─────┘
 *
 * @version 1.0.0
 * @icon 🦞
 * @tags orchestrator, whatsapp, agent, claw
 * @stateful
 */
export default class Claw extends Photon {
  private running = false;
  private sessionMap: Record<string, string> = {}; // groupFolder → sessionId

  async onInitialize(): Promise<void> {
    const saved = await this.memory.get<Record<string, string>>('sessionMap');
    if (saved) this.sessionMap = saved;
  }

  // Cross-photon calls via this.call() — each photon loads independently
  private bridge = {
    connect: () => this.call('whatsapp-bridge.connect', {}),
    disconnect: () => this.call('whatsapp-bridge.disconnect', {}),
    send: (params: { jid: string; text: string }) => this.call('whatsapp-bridge.send', params),
    status: () => this.call('whatsapp-bridge.status', {}),
    typing: (params: { jid: string; typing: boolean }) => this.call('whatsapp-bridge.typing', params),
    onEvent: null as any, // wired via daemon events, not direct callback
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
  private scheduler = {
    schedule: (params: any) => this.call('group-scheduler.schedule', params),
    tasks: (params: any) => this.call('group-scheduler.tasks', params),
  };

  /**
   * Start the full pipeline: connect WhatsApp, wire events, begin routing.
   * Call this once after registering your groups.
   */
  async start(): Promise<{ status: string }> {
    if (this.running) return { status: 'already running' };

    // 1. Connect WhatsApp
    await this.bridge.connect();

    // Event wiring happens via daemon pub/sub:
    // whatsapp-bridge emits 'message' → claw subscribes → routes → runs → replies
    // For now, the handle/route methods are callable directly for testing.

    this.running = true;
    this.emit({ type: 'started' });
    return { status: 'started' };
  }

  /**
   * Stop the pipeline and disconnect WhatsApp.
   */
  async stop(): Promise<{ status: string }> {
    if (!this.running) return { status: 'not running' };

    await this.bridge.disconnect();
    this.running = false;

    // Persist session map for continuity on restart
    await this.memory.set('sessionMap', this.sessionMap);

    this.emit({ type: 'stopped' });
    return { status: 'stopped' };
  }

  /**
   * Register a WhatsApp group for agent routing.
   * @param jid WhatsApp JID {@example "123456789@g.us"}
   * @param name Display name {@example "Dev Team"}
   * @param folder Group folder name {@example "dev-team"}
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
   * Create a scheduled task for a group.
   * @param groupFolder Group folder name {@example "dev-team"}
   * @param chatJid WhatsApp JID {@example "123@g.us"}
   * @param prompt Prompt to run {@example "Summarise yesterday's discussion"}
   * @param cron Cron expression {@example "0 9 * * 1-5"}
   * @param name Task name {@example "daily-standup"}
   */
  async schedule(params: {
    groupFolder: string;
    chatJid: string;
    prompt: string;
    cron: string;
    name?: string;
  }): Promise<any> {
    return this.scheduler.schedule(params);
  }

  /**
   * Show pipeline status: WhatsApp connection, active runs, queued, scheduled tasks.
   * @readOnly
   * @format json
   */
  async status(): Promise<{
    running: boolean;
    whatsapp: any;
    runner: any;
    groups: any[];
    scheduledTasks: any[];
  }> {
    // Each call may fail if the target photon isn't loaded yet — catch gracefully
    const safe = async (fn: () => Promise<any>, fallback: any = null) => {
      try { return await fn(); } catch { return fallback; }
    };

    const [whatsapp, runnerStatus, groups, scheduledTasks] = await Promise.all([
      safe(() => this.bridge.status(), { status: 'unknown' }),
      safe(() => this.runner.status(), { active: [], queued: 0 }),
      safe(() => this.router.groups(), []),
      safe(() => this.scheduler.tasks({}), []),
    ]);

    return {
      running: this.running,
      whatsapp,
      runner: runnerStatus,
      groups,
      scheduledTasks,
    };
  }

  // ─── Internal ──────────────────────────────────────────────────

  private async _handleMessage(event: {
    chatJid: string;
    message: { sender: string; senderName: string; content: string; fromMe: boolean; timestamp: string };
  }): Promise<void> {
    const msg = event.message;
    // Route the message — map bridge event fields to router params
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
      textPreview: event.message.content.slice(0, 80),
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

  private async _handleScheduledTask(event: {
    taskId: string;
    groupFolder: string;
    chatJid: string;
    prompt: string;
  }): Promise<void> {
    this.emit({
      type: 'task:executing',
      taskId: event.taskId,
      groupFolder: event.groupFolder,
    });

    const result = await this.runner.run({
      groupFolder: event.groupFolder,
      prompt: event.prompt,
      chatJid: event.chatJid,
      systemPrompt: 'This is a scheduled task. Respond concisely.',
    });

    if (result.status === 'success' && result.output) {
      await this.bridge.send({ jid: event.chatJid, text: result.output });
      this.emit({
        type: 'task:completed',
        taskId: event.taskId,
        groupFolder: event.groupFolder,
        duration: result.duration,
      });
    } else {
      this.emit({
        type: 'task:failed',
        taskId: event.taskId,
        groupFolder: event.groupFolder,
        error: result.error,
      });
    }
  }
}
