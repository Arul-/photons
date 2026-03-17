import fs from 'fs';
import path from 'path';
import os from 'os';
import sharp from 'sharp';

import { Photon } from '@portel/photon-core';

/** Max age for queued messages before they're dropped on flush (1 hour) */
const MESSAGE_TTL_MS = 60 * 60 * 1000;

/** Telegram Bot API max message length */
const MAX_MESSAGE_LENGTH = 4096;

/**
 * Telegram — live Telegram bot connection via Bot API.
 *
 * Manages authentication, message delivery, and chat metadata.
 * Buffers inbound messages for polling by orchestrators (e.g. claw).
 *
 * @version 1.0.0
 * @icon 🤖
 * @tags telegram, messaging, nanoclaw
 * @dependencies sharp
 * @stateful
 * @noworker
 */
export default class Telegram extends Photon {
  protected settings = {
    /** Enable verbose debug logging */
    debug: false,
    /** Max reconnect attempts before giving up */
    maxReconnectAttempts: 10,
    /** Long-polling timeout in seconds (Telegram server holds connection this long) */
    pollingTimeoutSeconds: 30,
  };

  private _token = '';
  private _botId = 0;
  private _botUsername = '';
  private _polling = false;
  private _offset = 0;
  private _connected = false;
  private _reconnectAttempts = 0;
  private _lastConnectedAt = 0;
  private readonly _stableConnectionMs = 5 * 60 * 1000;
  private _destroyed = false;
  private _connectPromise: Promise<any> | null = null;
  private _pollAbort: AbortController | null = null;
  private _pendingMessages: Array<{ chatId: string; message: InboundMessage }> = [];
  private _eventListeners: Array<{
    event: string;
    fn: (data: any) => void;
    filter?: { group?: string; chatId?: string; trigger?: string; fromMe?: boolean };
    resolvedChatId?: string;
  }> = [];
  private knownChats: Record<string, string> = {}; // chatId → name
  private _chatNameIndex: Map<string, string> = new Map(); // lowercase name → chatId
  private outgoingQueue: Array<{ chatId: string; text: string; queuedAt: number }> = [];
  private flushing = false;
  /** Recently processed update IDs for deduplication after restart */
  private _processedIds: Set<number> = new Set();
  private readonly _maxProcessedIds = 500;

  private get authDir(): string {
    if (this._photonFilePath) return this.storage('auth');
    return path.join(os.homedir(), '.photon', 'data', 'telegram', 'auth');
  }

  private get tokenPath(): string {
    return path.join(this.authDir, 'token.json');
  }

  private get offsetPath(): string {
    return path.join(this.authDir, 'offset.json');
  }

  private get mediaDir(): string {
    const dir = this._photonFilePath
      ? this.storage('media')
      : path.join(os.homedir(), '.photon', 'data', 'telegram', 'media');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }


  // ─── Lifecycle Hooks ──────────────────────────────────────────

  async onInitialize(ctx?: any): Promise<void> {
    if (ctx?.reason === 'hot-reload' && ctx.oldInstance) {
      const old = ctx.oldInstance as any;
      old._destroyed = true;

      // Transfer state
      this._token = old._token;
      this._botId = old._botId;
      this._botUsername = old._botUsername;
      this._offset = old._offset;
      this._connected = old._connected;
      this._reconnectAttempts = old._reconnectAttempts;
      this._lastConnectedAt = old._lastConnectedAt;
      this._pendingMessages = old._pendingMessages || [];
      this._eventListeners = old._eventListeners || [];
      this.knownChats = old.knownChats || {};
      this.outgoingQueue = old.outgoingQueue || [];
      this._processedIds = old._processedIds || new Set();

      this._rebuildChatIndex();

      // Restart polling on the new instance if it was active
      if (old._polling) {
        old._polling = false;
        if (old._pollAbort) old._pollAbort.abort();
        this._polling = true;
        this._pollLoop();
      }

      this.emit({ type: 'hot_reload_transferred' });
      return;
    }

    // Restore persisted chat index
    const savedChats = await this.memory.get<Record<string, string>>('knownChats');
    if (savedChats) {
      this.knownChats = savedChats;
      this._rebuildChatIndex();
    }

    // Normal startup — auto-connect if token saved
    try {
      if (fs.existsSync(this.tokenPath)) {
        const data = JSON.parse(fs.readFileSync(this.tokenPath, 'utf-8'));
        if (data.token) {
          this.connect({ token: data.token }).catch((err) => {
            this.emit({ type: 'auto_connect_failed', error: err.message });
          });
        }
      }
    } catch {
      // No saved token — user needs to call connect()
    }
  }

  async onShutdown(ctx?: any): Promise<void> {
    if (ctx?.reason === 'hot-reload') return; // preserve state for new instance
    this._deactivatePolling();
    this._connected = false;
  }

  // ─── Connection ───────────────────────────────────────────────

  /**
   * Connect to Telegram with a bot token from BotFather.
   * Saves the token for automatic reconnection on restart.
   *
   * @title Connect
   * @openWorld
   * @param token Bot token from @BotFather {@example "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"}
   */
  async connect(params: { token: string }): Promise<{ status: string; username?: string; message?: string }> {
    if (this._connected) {
      return { status: 'already_connected', username: this._botUsername, message: `Already connected as @${this._botUsername}` };
    }

    // Deduplicate concurrent connect() calls
    if (this._connectPromise) return this._connectPromise;

    this._connectPromise = this._doConnect(params.token);
    try {
      return await this._connectPromise;
    } finally {
      this._connectPromise = null;
    }
  }

  private async _doConnect(token: string): Promise<{ status: string; username?: string; message?: string }> {
    this._token = token;

    // Verify token via getMe
    let me: any;
    try {
      me = await this._api('getMe');
    } catch (err: any) {
      this._token = '';
      throw new Error(`Invalid bot token: ${err.message}`);
    }

    this._botId = me.id;
    this._botUsername = me.username || '';

    // Save token
    fs.mkdirSync(this.authDir, { recursive: true });
    fs.writeFileSync(this.tokenPath, JSON.stringify({ token, botId: me.id, username: me.username }));

    this._connected = true;
    this._reconnectAttempts = 0;
    this._lastConnectedAt = Date.now();

    // Restore persisted offset so we pick up messages from where we left off
    if (this._offset === 0) {
      this._offset = this._loadPersistedOffset();
    }

    // Activate polling if subscribers are already waiting
    if (this._hasSubscribers()) {
      this._activatePolling();
    }

    // Flush any queued messages
    this._flushQueue();

    this.emit({ type: 'connected', username: this._botUsername });
    return { status: 'connected', username: this._botUsername, message: `Connected as @${this._botUsername}` };
  }

  /**
   * Disconnect from Telegram. Stops receiving messages.
   *
   * @title Disconnect
   * @destructive
   */
  async disconnect(): Promise<void> {
    this._deactivatePolling();
    this._connected = false;
    this.emit({ type: 'disconnected' });
  }

  /**
   * Connection and bot status.
   *
   * @title Status
   * @readOnly
   * @closedWorld
   */
  async status(): Promise<{
    status: string;
    polling: string;
    username: string;
    subscribers: number;
    queuedOutgoing: number;
    reconnectAttempts: number;
  }> {
    return {
      status: this._connected ? 'connected' : 'disconnected',
      polling: this._polling ? 'active' : 'idle',
      username: this._botUsername,
      subscribers: this._eventListeners.filter(e => e.event === 'message').length,
      queuedOutgoing: this.outgoingQueue.length,
      reconnectAttempts: this._reconnectAttempts,
    };
  }

  // ─── Messaging ────────────────────────────────────────────────

  /**
   * Send a text message to a chat.
   * Supports markdown formatting — converted to Telegram HTML automatically.
   *
   * @title Send Message
   * @openWorld
   * @param chat Chat name or ID {@choice-from groups.name}
   * @param text Message text (supports Markdown)
   */
  async send(params: { chat: string; text: string }): Promise<{ queued: boolean; messageId?: number }> {
    const chatId = this._resolveChat(params.chat);
    const html = _markdownToTelegramHtml(params.text);

    if (!this._connected) {
      this.outgoingQueue.push({ chatId, text: params.text, queuedAt: Date.now() });
      return { queued: true };
    }

    try {
      const result = await this._sendText(chatId, html);
      return { queued: false, messageId: result.message_id };
    } catch (err: any) {
      this.outgoingQueue.push({ chatId, text: params.text, queuedAt: Date.now() });
      this.emit({ type: 'error', source: 'send', error: err.message });
      return { queued: true };
    }
  }

  /**
   * Edit a previously sent message.
   *
   * @title Edit Message
   * @openWorld
   * @param chat Chat name or ID {@choice-from groups.name}
   * @param messageId Message ID to edit
   * @param text New text (supports Markdown)
   */
  async edit(params: { chat: string; messageId: number; text: string }): Promise<void> {
    if (!this._connected) throw new Error('Not connected. Call connect() first.');
    const chatId = this._resolveChat(params.chat);
    const html = _markdownToTelegramHtml(params.text);
    await this._api('editMessageText', {
      chat_id: chatId,
      message_id: params.messageId,
      text: html,
      parse_mode: 'HTML',
    });
  }

  /**
   * Reply to a specific message (quoted reply).
   *
   * @title Reply
   * @openWorld
   * @param chat Chat name or ID {@choice-from groups.name}
   * @param text Reply text (supports Markdown)
   * @param messageId Message ID to reply to
   */
  async reply(params: { chat: string; text: string; messageId: number }): Promise<{ messageId: number }> {
    if (!this._connected) throw new Error('Not connected. Call connect() first.');
    const chatId = this._resolveChat(params.chat);
    const html = _markdownToTelegramHtml(params.text);
    const result = await this._sendText(chatId, html, params.messageId);
    return { messageId: result.message_id };
  }

  /**
   * React to a message with an emoji.
   *
   * @title React
   * @openWorld
   * @param chat Chat name or ID {@choice-from groups.name}
   * @param messageId Message ID to react to
   * @param emoji Emoji to react with (empty string to remove) {@example "👍"}
   */
  async react(params: { chat: string; messageId: number; emoji: string }): Promise<void> {
    if (!this._connected) throw new Error('Not connected. Call connect() first.');
    const chatId = this._resolveChat(params.chat);
    const reaction = params.emoji
      ? [{ type: 'emoji', emoji: params.emoji }]
      : [];
    await this._api('setMessageReaction', {
      chat_id: chatId,
      message_id: params.messageId,
      reaction,
    });
  }

  /**
   * Send media (photo, video, audio, or document).
   *
   * @title Send Media
   * @openWorld
   * @param chat Chat name or ID {@choice-from groups.name}
   * @param url File URL or Telegram file_id
   * @param type Media type {@choice photo, video, audio, document}
   * @param caption Optional caption
   */
  async media(params: {
    chat: string;
    url: string;
    type: 'photo' | 'video' | 'audio' | 'document';
    caption?: string;
  }): Promise<{ messageId: number }> {
    if (!this._connected) throw new Error('Not connected. Call connect() first.');
    const chatId = this._resolveChat(params.chat);

    const methodMap: Record<string, { method: string; field: string }> = {
      photo: { method: 'sendPhoto', field: 'photo' },
      video: { method: 'sendVideo', field: 'video' },
      audio: { method: 'sendAudio', field: 'audio' },
      document: { method: 'sendDocument', field: 'document' },
    };

    const { method, field } = methodMap[params.type];
    const payload: any = { chat_id: chatId, [field]: params.url };
    if (params.caption) {
      payload.caption = _markdownToTelegramHtml(params.caption);
      payload.parse_mode = 'HTML';
    }

    const result = await this._api(method, payload);
    return { messageId: result.message_id };
  }

  /**
   * Set typing indicator for a chat.
   * Telegram typing indicators auto-expire after ~5 seconds.
   *
   * @title Set Typing
   * @openWorld
   * @param chat Chat name or ID {@choice-from groups.name}
   * @param typing True to show typing (false is a no-op — Telegram auto-expires)
   */
  async typing(params: { chat: string; typing: boolean }): Promise<void> {
    if (!this._connected || !params.typing) return;
    const chatId = this._resolveChat(params.chat);
    await this._api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch((err: any) => {
      this.emit({ type: 'error', source: 'typing', error: err.message });
    });
  }

  // ─── Polling / Events ─────────────────────────────────────────

  /**
   * Return and clear buffered inbound messages.
   * If polling is idle (no subscribers), does a one-shot fetch from Telegram first.
   *
   * @title Pending Messages
   * @closedWorld
   * @format json
   */
  async pending(): Promise<Array<{ chatId: string; message: InboundMessage }>> {
    if (!this._polling && this._connected) {
      await this._fetchOnce();
    }
    return this._pendingMessages.splice(0);
  }

  /**
   * Subscribe to events with optional filtering.
   * Activates long-polling when the first subscriber registers.
   * @internal
   *
   * @example
   * // All messages — activates long-polling
   * telegram.on('message', handler)
   *
   * // Specific group with trigger
   * telegram.on('message', handler, { group: 'My Group', trigger: '@' })
   *
   * // By chat ID directly
   * telegram.on('message', handler, { chatId: '-1001234567890' })
   */
  on(event: string, fn: (data: any) => void, filter?: { group?: string; chatId?: string; trigger?: string; fromMe?: boolean }): void {
    const entry: typeof this._eventListeners[0] = { event, fn, filter };

    // Resolve group name → chatId eagerly if chats are already known
    if (filter?.group) {
      if (/^-?\d+$/.test(filter.group)) {
        entry.resolvedChatId = filter.group;
      } else {
        const query = filter.group.toLowerCase();
        const id = this._chatNameIndex.get(query)
          || [...this._chatNameIndex.entries()].find(([name]) => name.includes(query))?.[1];
        if (id) entry.resolvedChatId = id;
      }
    }

    // Replace existing listener with same filter to prevent stale handler accumulation
    if (filter?.chatId || filter?.group) {
      const idx = this._eventListeners.findIndex(e =>
        e.event === event &&
        ((filter.chatId && e.filter?.chatId === filter.chatId) ||
         (filter.group && e.filter?.group === filter.group))
      );
      if (idx !== -1) this._eventListeners.splice(idx, 1);
    }

    this._eventListeners.push(entry);

    // Activate polling if this is the first subscriber and we're connected
    if (this._connected && !this._polling) {
      this._activatePolling();
    }
  }

  /**
   * Unsubscribe from events.
   * Deactivates polling when the last subscriber leaves.
   * @internal
   */
  off(event: string, fn: (data: any) => void): void {
    const idx = this._eventListeners.findIndex(e => e.event === event && e.fn === fn);
    if (idx !== -1) this._eventListeners.splice(idx, 1);

    // Deactivate polling if no subscribers remain
    if (this._polling && !this._hasSubscribers()) {
      this._deactivatePolling();
    }
  }

  // ─── Chat Management ──────────────────────────────────────────

  /**
   * List known chats (groups and DMs discovered from incoming messages).
   * Note: Telegram Bot API has no "list all chats" endpoint —
   * this index builds incrementally from received messages.
   *
   * @title List Chats
   * @readOnly
   * @openWorld
   * @format table
   */
  async groups(): Promise<Array<{ chatId: string; name: string }>> {
    // Read-through: if in-memory is empty, try restoring from disk
    if (Object.keys(this.knownChats).length === 0) {
      const saved = await this.memory.get<Record<string, string>>('knownChats');
      if (saved) {
        this.knownChats = saved;
        this._rebuildChatIndex();
      }
    }
    return Object.entries(this.knownChats).map(([chatId, name]) => ({ chatId, name }));
  }

  /**
   * Remove saved bot token and disconnect.
   * You'll need to call connect() again with a new token.
   *
   * @title Logout
   * @destructive
   */
  async logout(): Promise<void> {
    await this.disconnect();
    try { fs.unlinkSync(this.tokenPath); } catch { /* already gone */ }
    this._token = '';
    this._botId = 0;
    this._botUsername = '';
    this.emit({ type: 'logged_out' });
  }

  // ─── Offset Persistence ──────────────────────────────────────

  /** Persist current offset to disk (atomic write) */
  private _persistOffset(): void {
    try {
      const data = JSON.stringify({ offset: this._offset, botId: this._botId, updatedAt: Date.now() });
      const tmp = this.offsetPath + '.tmp';
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, this.offsetPath);
    } catch {
      // Non-fatal — worst case we re-process a few messages on restart
    }
  }

  /** Load persisted offset from disk, validating bot token matches */
  private _loadPersistedOffset(): number {
    try {
      if (!fs.existsSync(this.offsetPath)) return 0;
      const data = JSON.parse(fs.readFileSync(this.offsetPath, 'utf-8'));
      // Reject offset if bot ID changed (different bot token → different message stream)
      if (data.botId && data.botId !== this._botId) {
        this.emit({ type: 'offset_rejected', reason: 'bot_id_mismatch', storedBotId: data.botId, currentBotId: this._botId });
        return 0;
      }
      if (typeof data.offset === 'number' && data.offset > 0) {
        this.emit({ type: 'offset_restored', offset: data.offset });
        return data.offset;
      }
    } catch {
      // Corrupted file — start fresh
    }
    return 0;
  }

  // ─── Polling Control ─────────────────────────────────────────

  /** Check if any message subscribers exist */
  private _hasSubscribers(): boolean {
    return this._eventListeners.some(e => e.event === 'message');
  }

  /** Start long-polling (demand-driven — called when first real-time subscriber registers) */
  private _activatePolling(): void {
    if (this._polling) return;
    this._polling = true;
    this._pollLoop();
    this.emit({ type: 'polling_activated', subscribers: this._eventListeners.filter(e => e.event === 'message').length });
  }

  /** Stop long-polling and persist offset (called when last real-time subscriber leaves) */
  private _deactivatePolling(): void {
    if (!this._polling) return;
    this._polling = false;
    if (this._pollAbort) {
      this._pollAbort.abort();
      this._pollAbort = null;
    }
    if (this._offset > 0) this._persistOffset();
    this.emit({ type: 'polling_deactivated' });
  }

  /** One-shot fetch — single getUpdates call for scheduled/on-demand use */
  private async _fetchOnce(): Promise<void> {
    try {
      const updates = await this._api('getUpdates', {
        offset: this._offset,
        timeout: 0, // Don't long-poll — return immediately
        allowed_updates: ['message', 'edited_message', 'channel_post'],
      });

      for (const update of updates) {
        if (this._processedIds.has(update.update_id)) continue;
        await this._handleUpdate(update);
        this._processedIds.add(update.update_id);
        if (update.update_id >= this._offset) {
          this._offset = update.update_id + 1;
        }
      }

      if (updates.length > 0) this._persistOffset();
    } catch (err: any) {
      this.emit({ type: 'error', source: 'fetch_once', error: err.message });
    }
  }

  // ─── Internals ────────────────────────────────────────────────

  /** Core Telegram Bot API caller */
  private async _api(method: string, body?: any, signal?: AbortSignal): Promise<any> {
    const url = `https://api.telegram.org/bot${this._token}/${method}`;
    const opts: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    };
    if (body) opts.body = JSON.stringify(body);
    if (signal) opts.signal = signal;

    const response = await fetch(url, opts);
    const data = await response.json() as any;

    if (!data.ok) {
      throw new Error(`${method}: ${data.description || 'Unknown error'} (${data.error_code})`);
    }
    return data.result;
  }

  /** Send text with semantic chunking for long messages */
  private async _sendText(chatId: string, html: string, replyToMessageId?: number): Promise<any> {
    const chunks = _smartChunk(html, MAX_MESSAGE_LENGTH);

    let lastResult: any;
    for (let i = 0; i < chunks.length; i++) {
      const payload: any = {
        chat_id: chatId,
        text: chunks[i],
        parse_mode: 'HTML',
      };
      // Only quote the original on the first chunk
      if (i === 0 && replyToMessageId) {
        payload.reply_parameters = { message_id: replyToMessageId };
      }
      try {
        lastResult = await this._api('sendMessage', payload);
      } catch (err: any) {
        // HTML parse failure — retry as plain text, stripping tags
        if (err.message.includes("can't parse")) {
          delete payload.parse_mode;
          payload.text = chunks[i].replace(/<[^>]+>/g, '');
          lastResult = await this._api('sendMessage', payload);
        } else {
          throw err;
        }
      }
    }
    return lastResult;
  }

  /** Long-polling loop */
  private async _pollLoop(): Promise<void> {
    while (this._polling && !this._destroyed) {
      try {
        this._pollAbort = new AbortController();
        const updates = await this._api('getUpdates', {
          offset: this._offset,
          timeout: this.settings.pollingTimeoutSeconds,
          allowed_updates: ['message', 'edited_message', 'channel_post'],
        }, this._pollAbort.signal);

        if (this._destroyed) return;

        for (const update of updates) {
          // Dedup: skip updates we already processed before a restart
          if (this._processedIds.has(update.update_id)) continue;

          await this._handleUpdate(update);

          // Track processed ID for dedup
          this._processedIds.add(update.update_id);
          if (this._processedIds.size > this._maxProcessedIds) {
            // Evict oldest entries (smallest IDs)
            const ids = [...this._processedIds].sort((a, b) => a - b);
            for (let i = 0; i < ids.length - this._maxProcessedIds; i++) {
              this._processedIds.delete(ids[i]);
            }
          }

          // Advance offset past processed update
          if (update.update_id >= this._offset) {
            this._offset = update.update_id + 1;
          }
        }

        // Persist offset after processing the batch — if we crash before
        // next persist, we'll re-fetch from this offset and dedup
        if (updates.length > 0) {
          this._persistOffset();
        }

        // Successful poll — check if connection is stable enough to reset backoff
        if (Date.now() - this._lastConnectedAt >= this._stableConnectionMs) {
          this._reconnectAttempts = 0;
        }
        this._lastConnectedAt = Date.now();

      } catch (err: any) {
        if (this._destroyed || !this._polling) return;

        // Abort errors are expected during disconnect
        if (err.name === 'AbortError') return;

        this._reconnectAttempts++;
        this.emit({ type: 'error', source: 'polling', error: err.message, attempt: this._reconnectAttempts });

        if (this._reconnectAttempts >= this.settings.maxReconnectAttempts) {
          this._connected = false;
          this._polling = false;
          this.emit({ type: 'reconnect_exhausted', attempts: this._reconnectAttempts });
          return;
        }

        // Exponential backoff: min(5s * 2^attempt, 120s)
        const delay = Math.min(5000 * Math.pow(2, this._reconnectAttempts - 1), 120_000);
        if (this.settings.debug) {
          this.emit({ type: 'reconnect_backoff', delay, attempt: this._reconnectAttempts });
        }
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  /** Process a single Telegram update */
  private async _handleUpdate(update: any): Promise<void> {
    const raw = update.message || update.channel_post || update.edited_message;
    if (!raw) return;

    const chat = raw.chat;
    const chatId = String(chat.id);
    const chatName = chat.title || chat.first_name || chat.username || chatId;

    // Update chat index — detect renames
    const previousName = this.knownChats[chatId];
    if (previousName !== chatName) {
      this.knownChats[chatId] = chatName;
      this._rebuildChatIndex();
      this.memory.set('knownChats', this.knownChats).catch(() => {});

      if (previousName) {
        // Name changed on a known chat — notify subscribers
        this.emit({ type: 'group:renamed', chatId, oldName: previousName, newName: chatName });

        // Update listener filters that referenced the old name
        for (const entry of this._eventListeners) {
          if (entry.filter?.group && entry.filter.group.toLowerCase() === previousName.toLowerCase()) {
            entry.filter.group = chatName;
          }
        }
      }
    }

    // Build inbound message
    const from = raw.from || {};
    const fromMe = from.id === this._botId;
    const message = this._extractMessage(raw, chatId, fromMe);

    // Download media — await so filePath is set before dispatch to claw
    if (message.media && ['photo', 'video', 'audio', 'document', 'sticker'].includes(message.type)) {
      try {
        await this._downloadMedia(raw, message);
      } catch (err: any) {
        this.emit({ type: 'error', source: 'media_download', error: err.message });
      }
    }

    // Buffer for pending()
    if (this._pendingMessages.length < 1000) {
      this._pendingMessages.push({ chatId, message });
    }

    // Dispatch to registered listeners
    this._dispatchToListeners(chatId, message);

    // Emit on the messages channel
    this.emit({ channel: 'messages', type: 'message', chatId, message });
  }

  /** Extract structured message from Telegram update */
  private _extractMessage(raw: any, chatId: string, fromMe: boolean): InboundMessage {
    const from = raw.from || {};
    const senderName = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Unknown';

    let content = '';
    let type: InboundMessage['type'] = 'text';
    let media: InboundMessage['media'] | undefined;
    let location: InboundMessage['location'] | undefined;

    if (raw.text) {
      content = _telegramEntitiesToMarkdown(raw.text, raw.entities || []);
      type = 'text';
    } else if (raw.photo) {
      type = 'photo';
      content = raw.caption ? _telegramEntitiesToMarkdown(raw.caption, raw.caption_entities || []) : '[Photo]';
      media = { mimetype: 'image/jpeg', caption: raw.caption };
    } else if (raw.video) {
      type = 'video';
      content = raw.caption ? _telegramEntitiesToMarkdown(raw.caption, raw.caption_entities || []) : '[Video]';
      media = { mimetype: raw.video.mime_type, caption: raw.caption, seconds: raw.video.duration };
    } else if (raw.audio) {
      type = 'audio';
      content = raw.caption ? _telegramEntitiesToMarkdown(raw.caption, raw.caption_entities || []) : `[Audio: ${raw.audio.title || 'untitled'}]`;
      media = { mimetype: raw.audio.mime_type, caption: raw.caption, seconds: raw.audio.duration };
    } else if (raw.voice) {
      type = 'audio';
      content = '[Voice message]';
      media = { mimetype: raw.voice.mime_type, seconds: raw.voice.duration };
    } else if (raw.document) {
      type = 'document';
      content = raw.caption ? _telegramEntitiesToMarkdown(raw.caption, raw.caption_entities || []) : `[Document: ${raw.document.file_name || 'file'}]`;
      media = { mimetype: raw.document.mime_type, caption: raw.caption, filename: raw.document.file_name };
    } else if (raw.sticker) {
      type = 'sticker';
      content = raw.sticker.emoji || '[Sticker]';
    } else if (raw.location) {
      type = 'location';
      location = { lat: raw.location.latitude, lng: raw.location.longitude };
      content = `[Location: ${raw.location.latitude}, ${raw.location.longitude}]`;
    } else if (raw.contact) {
      type = 'contact';
      content = `[Contact: ${raw.contact.first_name} ${raw.contact.phone_number || ''}]`;
    } else if (raw.poll) {
      type = 'poll';
      content = `[Poll: ${raw.poll.question}]`;
    } else {
      type = 'unknown';
      content = '[Unsupported message type]';
    }

    // Build quoted message context
    let quotedMessage: InboundMessage['quotedMessage'] | undefined;
    if (raw.reply_to_message) {
      const q = raw.reply_to_message;
      quotedMessage = {
        id: String(q.message_id),
        content: q.text || q.caption || '',
        sender: q.from ? ([q.from.first_name, q.from.last_name].filter(Boolean).join(' ') || q.from.username || 'Unknown') : 'Unknown',
      };
    }

    return {
      messageId: String(raw.message_id),
      chatId,
      sender: String(from.id || ''),
      senderName,
      content,
      timestamp: new Date((raw.date || 0) * 1000).toISOString(),
      fromMe,
      type,
      ...(media ? { media } : {}),
      ...(location ? { location } : {}),
      ...(quotedMessage ? { quotedMessage } : {}),
    };
  }

  /** Download media file from Telegram and attach filePath to the message. */
  private async _downloadMedia(raw: any, inbound: InboundMessage): Promise<void> {
    // Extract file_id from the raw message — pick largest photo, or direct field
    let fileId: string | undefined;
    if (raw.photo && Array.isArray(raw.photo) && raw.photo.length > 0) {
      fileId = raw.photo[raw.photo.length - 1].file_id; // largest size
    } else if (raw.video?.file_id) {
      fileId = raw.video.file_id;
    } else if (raw.audio?.file_id) {
      fileId = raw.audio.file_id;
    } else if (raw.voice?.file_id) {
      fileId = raw.voice.file_id;
    } else if (raw.document?.file_id) {
      fileId = raw.document.file_id;
    } else if (raw.sticker?.file_id) {
      fileId = raw.sticker.file_id;
    }
    if (!fileId) return;

    const ext = this._mimeToExt(inbound.media?.mimetype || '');
    const localPath = path.join(this.mediaDir, `${inbound.messageId}${ext}`);

    // Skip if already downloaded
    if (fs.existsSync(localPath)) {
      inbound.filePath = localPath;
      return;
    }

    // Get file metadata from Telegram API
    const fileInfo = await this._api('getFile', { file_id: fileId });
    if (!fileInfo?.file_path) return;

    // Skip files larger than 20 MB to avoid blocking the message pipeline
    const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
    if (fileInfo.file_size && fileInfo.file_size > MAX_DOWNLOAD_BYTES) return;

    // Download the file
    const url = `https://api.telegram.org/file/bot${this._token}/${fileInfo.file_path}`;
    const response = await fetch(url);
    if (!response.ok) return;

    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.promises.writeFile(localPath, buffer);

    // Compress images for efficient LLM consumption
    if (['photo', 'sticker'].includes(inbound.type)) {
      inbound.filePath = await this._compressImage(localPath);
    } else {
      inbound.filePath = localPath;
    }
  }

  /**
   * Compress an image in-place: resize to max 2048px, JPEG quality 80.
   * Skips files already under 500 KB. Converts PNG/WebP to JPEG.
   * Returns the final file path (may change extension).
   */
  private async _compressImage(filePath: string): Promise<string> {
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.size < 512 * 1024) return filePath;

      const compressed = await sharp(filePath)
        .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();

      if (compressed.length < stat.size) {
        const jpgPath = filePath.replace(/\.\w+$/, '.jpg');
        await fs.promises.writeFile(jpgPath, compressed);
        if (jpgPath !== filePath) await fs.promises.unlink(filePath).catch(() => {});
        return jpgPath;
      }
    } catch { /* non-critical — keep the original */ }
    return filePath;
  }

  /** Map MIME types to file extensions */
  private _mimeToExt(mime: string): string {
    const map: Record<string, string> = {
      'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
      'video/mp4': '.mp4', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a',
      'application/pdf': '.pdf',
    };
    return map[mime] || `.${mime.split('/')[1] || 'bin'}`;
  }

  /** Dispatch message to registered .on() listeners with filter matching */
  private _dispatchToListeners(chatId: string, message: InboundMessage): void {
    for (const entry of this._eventListeners) {
      if (entry.event !== 'message') continue;

      const f = entry.filter;
      if (!f) {
        entry.fn({ chatId, message });
        continue;
      }

      // chatId filter (exact)
      if (f.chatId && f.chatId !== chatId) continue;

      // Group name filter (fuzzy, with lazy resolution)
      if (f.group) {
        // If the group filter is a numeric chat ID, match directly
        if (/^-?\d+$/.test(f.group)) {
          if (f.group !== chatId) continue;
        } else {
          if (!entry.resolvedChatId) {
            // Try to resolve now
            const query = f.group.toLowerCase();
            const id = this._chatNameIndex.get(query)
              || [...this._chatNameIndex.entries()].find(([name]) => name.includes(query))?.[1];
            if (id) entry.resolvedChatId = id;
          }
          if (entry.resolvedChatId && entry.resolvedChatId !== chatId) continue;
          if (!entry.resolvedChatId) continue; // still unresolved — skip
        }
      }

      // Trigger filter (substring match)
      if (f.trigger && !message.content.includes(f.trigger)) continue;

      // fromMe filter
      if (f.fromMe !== undefined && f.fromMe !== message.fromMe) continue;

      entry.fn({ chatId, message });
    }
  }

  /** Resolve chat name or ID to a chatId string */
  private _resolveChat(chat: string): string {
    // Already a numeric ID (positive for users, negative for groups/channels)
    if (/^-?\d+$/.test(chat)) return chat;

    // Fuzzy match against chat name index
    const query = chat.toLowerCase();
    const exact = this._chatNameIndex.get(query);
    if (exact) return exact;

    // Substring match
    for (const [name, id] of this._chatNameIndex) {
      if (name.includes(query)) return id;
    }

    throw new Error(
      `No chat matching "${chat}". The bot discovers chats from incoming messages — send a message in the target chat first, or use the numeric chat ID.`
    );
  }

  /** Rebuild the lowercase-name → chatId reverse index */
  private _rebuildChatIndex(): void {
    this._chatNameIndex.clear();
    for (const [id, name] of Object.entries(this.knownChats)) {
      this._chatNameIndex.set(name.toLowerCase(), id);
    }
  }

  /** Flush queued outgoing messages after reconnection */
  private async _flushQueue(): Promise<void> {
    if (this.flushing || !this._connected || this.outgoingQueue.length === 0) return;
    this.flushing = true;

    try {
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue[0];

        // Drop expired messages
        if (Date.now() - item.queuedAt > MESSAGE_TTL_MS) {
          this.outgoingQueue.shift();
          this.emit({ type: 'message_expired', chatId: item.chatId });
          continue;
        }

        const html = _markdownToTelegramHtml(item.text);
        await this._sendText(item.chatId, html);
        this.outgoingQueue.shift();
      }
    } catch (err: any) {
      this.emit({ type: 'error', source: 'flush', error: err.message });
    } finally {
      this.flushing = false;
    }
  }
}

// ─── Types ──────────────────────────────────────────────────────────

interface InboundMessage {
  messageId: string;
  chatId: string;
  sender: string;
  senderName: string;
  content: string;
  timestamp: string;
  fromMe: boolean;
  type: 'text' | 'photo' | 'video' | 'audio' | 'document' | 'sticker' | 'location' | 'contact' | 'poll' | 'unknown';
  media?: { mimetype?: string; caption?: string; filename?: string; seconds?: number };
  filePath?: string;
  location?: { lat: number; lng: number; name?: string };
  quotedMessage?: { id: string; content: string; sender: string };
}

// ─── Formatting ─────────────────────────────────────────────────────

/** Convert Markdown to Telegram-safe HTML */
function _markdownToTelegramHtml(text: string): string {
  // Preserve code blocks first (with optional language tag)
  const codeBlocks: string[] = [];
  let result = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const trimmed = code.replace(/\n$/, '');
    codeBlocks.push(lang
      ? `<pre><code class="language-${lang}">${_escHtml(trimmed)}</code></pre>`
      : `<pre>${_escHtml(trimmed)}</pre>`);
    return `\x00CODEBLOCK${codeBlocks.length - 1}\x00`;
  });

  // Preserve inline code
  const inlineCodes: string[] = [];
  result = result.replace(/`([^`]+)`/g, (_, code) => {
    inlineCodes.push(code);
    return `\x00INLINE${inlineCodes.length - 1}\x00`;
  });

  // Escape HTML entities in remaining text
  result = result.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Blockquotes: > text (multi-line, consecutive > lines merged)
  result = result.replace(/^(?:&gt;\s?.+\n?)+/gm, (block) => {
    const inner = block.replace(/^&gt;\s?/gm, '').replace(/\n$/, '');
    // Use expandable blockquote for long quotes (>3 lines)
    const lineCount = inner.split('\n').length;
    if (lineCount > 3) {
      return `<blockquote expandable>${inner}</blockquote>\n`;
    }
    return `<blockquote>${inner}</blockquote>\n`;
  });

  // Bold: **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  result = result.replace(/__(.+?)__/g, '<b>$1</b>');

  // Italic: *text* or _text_ (single)
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>');
  result = result.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '<i>$1</i>');

  // Strikethrough: ~~text~~
  result = result.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Underline: ==text== (custom, useful for emphasis hierarchy)
  result = result.replace(/==(.+?)==/g, '<u>$1</u>');

  // Links: [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Headers: # text → bold (## and deeper get smaller visual treatment)
  result = result.replace(/^#{1,2}\s+(.+)$/gm, '\n<b>$1</b>\n');
  result = result.replace(/^#{3,6}\s+(.+)$/gm, '<b>$1</b>');

  // Numbered lists: 1. item → keep number with dot
  result = result.replace(/^(\d+)\.\s+/gm, '$1. ');

  // Unordered list items: - item → bullet
  result = result.replace(/^[-*]\s+/gm, '• ');

  // Horizontal rules: --- or *** → visual separator
  result = result.replace(/^[-*]{3,}$/gm, '───────────────');

  // Restore inline code
  result = result.replace(/\x00INLINE(\d+)\x00/g, (_, i) =>
    `<code>${_escHtml(inlineCodes[Number(i)])}</code>`
  );

  // Restore code blocks (already HTML-escaped inside)
  result = result.replace(/\x00CODEBLOCK(\d+)\x00/g, (_, i) => codeBlocks[Number(i)]);

  // Markdown tables → formatted monospace (Telegram has no table support)
  // Mobile monospace wraps at ~35 chars, so use compact rendering
  result = result.replace(
    /(?:^[ \t]*\|.+\|[ \t]*\n)+/gm,
    (tableBlock) => {
      const rows = tableBlock.trim().split('\n').map(r =>
        r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
      );
      // Skip separator rows (---|---|---)
      const dataRows = rows.filter(r => !r.every(c => /^[-:]+$/.test(c)));
      if (dataRows.length === 0) return tableBlock;

      const colCount = Math.max(...dataRows.map(r => r.length));
      const widths = Array.from({ length: colCount }, (_, col) =>
        Math.max(...dataRows.map(r => (r[col] || '').length), 3)
      );
      const totalWidth = widths.reduce((a, b) => a + b, 0) + (colCount - 1) * 2;

      // If table fits in ~35 chars, render as aligned columns
      if (totalWidth <= 35) {
        const lines = dataRows.map(row => {
          const cells = Array.from({ length: colCount }, (_, col) =>
            (row[col] || '').padEnd(widths[col])
          );
          return cells.join(' │ ');
        });
        if (lines.length > 1) {
          const sep = widths.map(w => '─'.repeat(w)).join('─┼─');
          lines.splice(1, 0, sep);
        }
        return `<pre>${lines.join('\n')}</pre>\n`;
      }

      // Wide table → vertical card layout
      const headers = dataRows[0];
      const bodyRows = dataRows.slice(1);
      const cards = bodyRows.map(row =>
        headers.map((h, i) => `<b>${h}:</b> ${row[i] || '—'}`).join('\n')
      );
      return cards.join('\n\n') + '\n';
    }
  );

  // Clean up excessive blank lines
  result = result.replace(/\n{3,}/g, '\n\n');

  return result.trim();
}

/** Split HTML into chunks that respect semantic boundaries */
function _smartChunk(html: string, maxLen: number): string[] {
  if (html.length <= maxLen) return [html];

  const chunks: string[] = [];
  let remaining = html;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let splitAt = -1;
    const searchRange = remaining.slice(0, maxLen);

    // Priority 1: Split at paragraph boundary (double newline)
    const paraBreak = searchRange.lastIndexOf('\n\n');
    if (paraBreak > maxLen * 0.3) {
      splitAt = paraBreak;
    }

    // Priority 2: Split at single newline (but not inside <pre> blocks)
    if (splitAt === -1) {
      // Check if we're inside a <pre> block
      const lastPreOpen = searchRange.lastIndexOf('<pre');
      const lastPreClose = searchRange.lastIndexOf('</pre>');
      const insidePre = lastPreOpen > lastPreClose;

      if (insidePre) {
        // Try to split before the <pre> block
        splitAt = lastPreOpen > maxLen * 0.2 ? searchRange.lastIndexOf('\n', lastPreOpen) : -1;
        if (splitAt <= 0) {
          // Force close the pre, split, and reopen
          splitAt = searchRange.lastIndexOf('\n', maxLen - 10);
          if (splitAt > 0) {
            chunks.push(remaining.slice(0, splitAt) + '</pre>');
            remaining = '<pre>' + remaining.slice(splitAt).replace(/^\n/, '');
            continue;
          }
        }
      } else {
        splitAt = searchRange.lastIndexOf('\n');
      }
    }

    // Priority 3: Split at sentence boundary
    if (splitAt <= 0) {
      const sentenceEnd = searchRange.search(/[.!?]\s+(?=[A-Z])[^<]*$/);
      if (sentenceEnd > maxLen * 0.3) splitAt = sentenceEnd + 1;
    }

    // Priority 4: Hard break at max length
    if (splitAt <= 0) splitAt = maxLen;

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, '');
  }

  return chunks.filter(c => c.trim().length > 0);
}

/** Convert Telegram entities to Markdown */
function _telegramEntitiesToMarkdown(text: string, entities: any[]): string {
  if (!entities || entities.length === 0) return text;

  // Sort entities by offset (descending) so replacements don't shift positions
  const sorted = [...entities].sort((a, b) => b.offset - a.offset);

  let result = text;
  for (const e of sorted) {
    const start = e.offset;
    const end = e.offset + e.length;
    const inner = result.slice(start, end);

    let replacement = inner;
    switch (e.type) {
      case 'bold': replacement = `**${inner}**`; break;
      case 'italic': replacement = `_${inner}_`; break;
      case 'code': replacement = `\`${inner}\``; break;
      case 'pre': replacement = `\`\`\`\n${inner}\n\`\`\``; break;
      case 'strikethrough': replacement = `~~${inner}~~`; break;
      case 'text_link': replacement = `[${inner}](${e.url})`; break;
      case 'url': replacement = inner; break; // URLs are already plain text
      // Skip mention, hashtag, etc. — they're fine as-is
    }

    result = result.slice(0, start) + replacement + result.slice(end);
  }

  return result;
}

function _escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

