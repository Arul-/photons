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

  // Group registry — persisted via this.memory
  private registry: Record<string, RegisteredGroup> = {}; // jid → group
  // Message handlers — one per registered group
  private handlers: Map<string, (msg: any) => void> = new Map(); // jid → handler
  // Message log per folder for context building
  private messageLog: Record<string, MessageEntry[]> = {};
  private readonly MAX_LOG = 200;

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
    const saved = await this.memory.get<Record<string, RegisteredGroup>>('registry');
    if (saved) this.registry = saved;

    const savedSessions = await this.memory.get<Record<string, string>>('sessionMap');
    if (savedSessions) this.sessionMap = savedSessions;

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
    this._unsubscribeAll();
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    this.running = false;
  }

  /**
   * Start the pipeline: verify WhatsApp connection, subscribe to registered groups.
   * WhatsApp must be connected first via `photon whatsapp connect`.
   */
  async start(): Promise<{ status: string; phone?: string; groups?: number }> {
    if (this.running) return { status: 'already running' };

    // Wait for WhatsApp to connect
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

    this.running = true;
    await this.memory.set('running', true);

    // Subscribe to each registered group
    this._subscribeAll();

    // Heartbeat for health monitoring
    this.heartbeatTimer = setInterval(() => {
      this._heartbeat().catch(() => {});
    }, this.settings.heartbeatIntervalMs);

    const groupCount = Object.keys(this.registry).length;
    this.emit({ type: 'started', phone: waStatus.phone, groups: groupCount });
    return { status: 'started', phone: waStatus.phone, groups: groupCount };
  }

  /**
   * Stop the pipeline.
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
  }): Promise<RegisteredGroup> {
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

    const group: RegisteredGroup = {
      jid: match.jid,
      name: match.name,
      folder: params.folder,
      trigger: params.trigger,
      requiresTrigger: params.requiresTrigger ?? true,
      addedAt: new Date().toISOString(),
    };

    this.registry[match.jid] = group;
    await this.memory.set('registry', this.registry);

    // Subscribe immediately if running
    if (this.running) {
      this._subscribeGroup(group);
    }

    this.emit({ type: 'registered', group });
    return group;
  }

  /**
   * Remove a group from routing.
   * @param group WhatsApp group name or JID to unregister {@example "Learn CS"}
   */
  async unregister(params: { group: string }): Promise<{ removed: boolean }> {
    const query = params.group.toLowerCase();
    const jid = Object.values(this.registry).find(
      g => g.name.toLowerCase().includes(query) || g.jid === params.group
    )?.jid;

    if (!jid) throw new Error(`No group matching "${params.group}"`);

    // Unsubscribe handler
    const handler = this.handlers.get(jid);
    if (handler) {
      this.whatsapp.off('message', handler);
      this.handlers.delete(jid);
    }

    delete this.registry[jid];
    await this.memory.set('registry', this.registry);
    this.emit({ type: 'unregistered', jid });
    return { removed: true };
  }

  /**
   * List available WhatsApp groups for registration.
   * @readOnly
   * @format table
   */
  async groups(): Promise<Array<{ jid: string; name: string; registered: boolean }>> {
    const waGroups = await this.whatsapp.groups();
    const registeredJids = new Set(Object.keys(this.registry));

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
    groups: RegisteredGroup[];
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
      groups: Object.values(this.registry),
    };
  }

  // ─── Internal ──────────────────────────────────────────────────

  private _subscribeAll(): void {
    for (const group of Object.values(this.registry)) {
      this._subscribeGroup(group);
    }
  }

  private _subscribeGroup(group: RegisteredGroup): void {
    // Remove existing handler for this group if any
    const existing = this.handlers.get(group.jid);
    if (existing) this.whatsapp.off('message', existing);

    const handler = (msg: any) => {
      if (!this.running) return;
      this._handleMessage(group, msg).catch((err) => {
        this.emit({ type: 'handle_error', chatJid: msg.chatJid, error: err.message });
      });
    };

    // Use .on() with group + trigger filter
    const filter: any = { jid: group.jid };
    if (group.requiresTrigger) {
      filter.trigger = group.trigger;
    }
    this.whatsapp.on('message', handler, filter);
    this.handlers.set(group.jid, handler);
  }

  private _unsubscribeAll(): void {
    for (const [jid, handler] of this.handlers) {
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

  private async _handleMessage(group: RegisteredGroup, event: {
    chatJid: string;
    message: {
      sender: string; senderName: string; content: string; fromMe: boolean; timestamp: string;
      type?: string; filePath?: string; media?: { mimetype?: string; caption?: string };
    };
  }): Promise<void> {
    const msg = event.message;

    // Skip own messages when no trigger required (prevents loops)
    if (!group.requiresTrigger && msg.fromMe) return;

    // Convert WhatsApp formatting → Markdown before passing to agent
    const mdContent = waToMarkdown(msg.content);

    // Log the message for context
    const entry: MessageEntry = {
      sender: msg.senderName,
      content: mdContent,
      timestamp: msg.timestamp,
      fromMe: msg.fromMe,
    };
    if (!this.messageLog[group.folder]) this.messageLog[group.folder] = [];
    const log = this.messageLog[group.folder];
    log.push(entry);
    if (log.length > this.MAX_LOG) log.splice(0, log.length - this.MAX_LOG);

    // Build context from recent messages (include media metadata)
    const context = this._formatContext(log.slice(-20), msg);

    this.emit({
      type: 'routing',
      jid: event.chatJid,
      folder: group.folder,
      textPreview: msg.content.slice(0, 80),
      messageType: msg.type || 'text',
    });

    // Quick ACK so the user knows the message was received (not part of agent context)
    const acks = ['Noted, on it.', 'Got it, thinking...', 'On it.', 'Noted.', 'Working on it...'];
    const ack = acks[Math.floor(Math.random() * acks.length)];
    await this.whatsapp.send({ jid: event.chatJid, text: ack }).catch(() => {});

    // Keep typing indicator alive during agent processing (WhatsApp expires it after ~25s)
    await this.whatsapp.typing({ jid: event.chatJid, typing: true }).catch(() => {});
    const typingInterval = setInterval(() => {
      this.whatsapp.typing({ jid: event.chatJid, typing: true }).catch(() => {});
    }, 20_000);

    // If incoming message has a media file, make it accessible to the agent
    const addDirs: string[] = [];
    if (msg.filePath) {
      const mediaDir = msg.filePath.substring(0, msg.filePath.lastIndexOf('/'));
      addDirs.push(mediaDir);
    }

    let result: any;
    try {
      result = await this.runner.run({
        groupFolder: group.folder,
        prompt: context,
        chatJid: event.chatJid,
        sessionId: this.sessionMap[group.folder],
        ...(addDirs.length > 0 ? { addDirs } : {}),
      });
    } finally {
      clearInterval(typingInterval);
      this.whatsapp.typing({ jid: event.chatJid, typing: false }).catch(() => {});
    }

    if (result.sessionId) {
      this.sessionMap[group.folder] = result.sessionId;
      await this.memory.set('sessionMap', this.sessionMap);
    }

    if (result.status === 'success' && result.output) {
      await this._sendAgentResponse(event.chatJid, result.output, group.folder, result.duration);
    } else if (result.error) {
      this.emit({ type: 'error', source: 'agent-runner', folder: group.folder, error: result.error });
    }
  }

  /** Send agent response, detecting and sending media files inline */
  private async _sendAgentResponse(jid: string, output: string, folder: string, duration: number): Promise<void> {
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

    // Convert Markdown → WhatsApp formatting and send text portion
    if (textOutput.trim()) {
      await this.whatsapp.send({ jid, text: markdownToWa(textOutput.trim()) });
    }

    // Send each media file
    for (const media of mediaFiles) {
      try {
        await this.whatsapp.media({
          jid,
          url: media.path,
          type: media.type,
          caption: media.caption || undefined,
        });
      } catch (err: any) {
        this.emit({ type: 'error', source: 'media_send', folder, error: err.message, path: media.path });
        // Fallback: send the path as text so the user knows something was generated
        await this.whatsapp.send({ jid, text: `[Media file: ${media.path}]` }).catch(() => {});
      }
    }

    this.emit({
      type: 'replied',
      jid,
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

// ─── WhatsApp ↔ Markdown Formatting ────────────────────────────────

/**
 * Convert WhatsApp formatting to standard Markdown.
 * WhatsApp: *bold*  _italic_  ~strikethrough~  ```code```  `mono`
 * Markdown: **bold** _italic_ ~~strikethrough~~ ```code```  `mono`
 */
function waToMarkdown(text: string): string {
  // Preserve code blocks (``` ... ```) — they're the same in both formats
  const codeBlocks: string[] = [];
  let result = text.replace(/```[\s\S]*?```/g, (m) => {
    codeBlocks.push(m);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // Preserve inline code (` ... `) — same in both formats
  const inlineCode: string[] = [];
  result = result.replace(/`[^`]+`/g, (m) => {
    inlineCode.push(m);
    return `\x00IC${inlineCode.length - 1}\x00`;
  });

  // ~strike~ → ~~strike~~
  result = result.replace(/(?<!\~)\~(?!\~)([^\~]+?)(?<!\~)\~(?!\~)/g, '~~$1~~');

  // *bold* → **bold** (but not inside words, and not _italic_)
  // Match *text* at word boundaries, avoiding ** which is already markdown
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '**$1**');

  // _italic_ stays the same (valid in both)

  // Restore inline code and code blocks
  result = result.replace(/\x00IC(\d+)\x00/g, (_, i) => inlineCode[Number(i)]);
  result = result.replace(/\x00CB(\d+)\x00/g, (_, i) => codeBlocks[Number(i)]);

  return result;
}

/**
 * Convert standard Markdown to WhatsApp formatting.
 * Markdown: **bold** __bold__ *italic* _italic_ ~~strike~~ [text](url) # headers
 * WhatsApp: *bold*  *bold*   _italic_ _italic_ ~strike~   text (url)  *header*
 */
function markdownToWa(text: string): string {
  // Preserve code blocks
  const codeBlocks: string[] = [];
  let result = text.replace(/```[\s\S]*?```/g, (m) => {
    codeBlocks.push(m);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // Preserve inline code
  const inlineCode: string[] = [];
  result = result.replace(/`[^`]+`/g, (m) => {
    inlineCode.push(m);
    return `\x00IC${inlineCode.length - 1}\x00`;
  });

  // Headers: ## Header → *Header*
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

  // Links: [text](url) → text (url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

  // **bold** or __bold__ → *bold* (do this before italic)
  result = result.replace(/\*\*(.+?)\*\*/g, '*$1*');
  result = result.replace(/__(.+?)__/g, '*$1*');

  // ~~strike~~ → ~strike~
  result = result.replace(/~~(.+?)~~/g, '~$1~');

  // Unordered lists: - item or * item → • item
  result = result.replace(/^[\-\*]\s+/gm, '• ');

  // Horizontal rules
  result = result.replace(/^-{3,}$/gm, '───');
  result = result.replace(/^\*{3,}$/gm, '───');

  // Restore inline code and code blocks
  result = result.replace(/\x00IC(\d+)\x00/g, (_, i) => inlineCode[Number(i)]);
  result = result.replace(/\x00CB(\d+)\x00/g, (_, i) => codeBlocks[Number(i)]);

  return result;
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
  sender: string;
  content: string;
  timestamp: string;
  fromMe?: boolean;
}
