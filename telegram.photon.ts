import fs from 'fs';
import path from 'path';
import os from 'os';

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
 * @stateful
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
    filter?: { group?: string; chatId?: string; trigger?: string; fromMe?: boolean; schedule?: string };
    resolvedChatId?: string;
    _timer?: ReturnType<typeof setInterval>;
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

      // Re-create scheduled timers (timer handles can't transfer across instances)
      for (const entry of old._eventListeners || []) {
        if (entry._timer) clearInterval(entry._timer);
      }
      for (const entry of this._eventListeners) {
        if (entry.filter?.schedule) {
          const intervalMs = _parseSchedule(entry.filter.schedule);
          entry._timer = setInterval(() => {
            if (!this._connected) return;
            this._fetchOnce().catch(() => {});
          }, intervalMs);
        }
      }

      this.emit({ type: 'hot_reload_transferred' });
      return;
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
    // Clear all scheduled timers
    for (const entry of this._eventListeners) {
      if (entry._timer) clearInterval(entry._timer);
    }
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

    // Activate polling if real-time subscribers are already waiting
    if (this._hasRealtimeSubscribers()) {
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
    queuedMessages: number;
    reconnectAttempts: number;
  }> {
    return {
      status: this._connected ? 'connected' : 'disconnected',
      polling: this._polling ? 'active' : 'idle',
      username: this._botUsername,
      subscribers: this._eventListeners.filter(e => e.event === 'message').length,
      queuedMessages: this.outgoingQueue.length,
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
   * If polling is idle (no real-time subscribers), does a one-shot fetch from Telegram.
   *
   * @title Pending Messages
   * @closedWorld
   * @format json
   */
  async pending(): Promise<Array<{ chatId: string; message: InboundMessage }>> {
    // If polling is active, just drain the buffer
    if (this._polling) {
      return this._pendingMessages.splice(0);
    }

    // One-shot fetch — grab whatever Telegram has queued
    if (this._connected) {
      await this._fetchOnce();
    }
    return this._pendingMessages.splice(0);
  }

  /**
   * Subscribe to events with optional filtering.
   * Activates long-polling when the first real-time subscriber registers.
   * Use `schedule` for periodic fetches instead of real-time polling.
   * @internal
   *
   * @example
   * // Real-time — activates long-polling
   * telegram.on('message', handler)
   *
   * // Specific group with trigger (real-time)
   * telegram.on('message', handler, { group: 'My Group', trigger: '@' })
   *
   * // Periodic fetch — checks every hour, no persistent connection
   * telegram.on('message', handler, { schedule: '@hourly' })
   */
  on(event: string, fn: (data: any) => void, filter?: { group?: string; chatId?: string; trigger?: string; fromMe?: boolean; schedule?: string }): void {
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
      if (idx !== -1) {
        // Clear timer if the old entry had one
        if (this._eventListeners[idx]._timer) clearInterval(this._eventListeners[idx]._timer);
        this._eventListeners.splice(idx, 1);
      }
    }

    // Set up scheduled fetch if requested
    if (filter?.schedule) {
      const intervalMs = _parseSchedule(filter.schedule);
      entry._timer = setInterval(() => {
        if (!this._connected) return;
        this._fetchOnce().catch(() => {});
      }, intervalMs);
      // Also do an immediate fetch
      if (this._connected) this._fetchOnce().catch(() => {});
    }

    this._eventListeners.push(entry);

    // Activate real-time polling if this is a real-time subscriber and we're connected
    if (!filter?.schedule && this._connected && !this._polling) {
      this._activatePolling();
    }
  }

  /**
   * Unsubscribe from events.
   * Deactivates polling when the last real-time subscriber leaves.
   * @internal
   */
  off(event: string, fn: (data: any) => void): void {
    const idx = this._eventListeners.findIndex(e => e.event === event && e.fn === fn);
    if (idx !== -1) {
      if (this._eventListeners[idx]._timer) clearInterval(this._eventListeners[idx]._timer);
      this._eventListeners.splice(idx, 1);
    }

    // Deactivate polling if no real-time subscribers remain
    if (this._polling && !this._hasRealtimeSubscribers()) {
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

  /** Check if any real-time (non-scheduled) subscribers exist */
  private _hasRealtimeSubscribers(): boolean {
    return this._eventListeners.some(e => e.event === 'message' && !e.filter?.schedule);
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
        this._handleUpdate(update);
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

  /** Send text with automatic chunking for long messages */
  private async _sendText(chatId: string, html: string, replyToMessageId?: number): Promise<any> {
    // Chunk at MAX_MESSAGE_LENGTH boundaries
    const chunks: string[] = [];
    let remaining = html;
    while (remaining.length > 0) {
      if (remaining.length <= MAX_MESSAGE_LENGTH) {
        chunks.push(remaining);
        break;
      }
      // Try to split at last newline within limit
      let splitAt = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
      if (splitAt <= 0) splitAt = MAX_MESSAGE_LENGTH;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).replace(/^\n/, '');
    }

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
        // HTML parse failure — retry as plain text
        if (err.message.includes("can't parse")) {
          delete payload.parse_mode;
          payload.text = chunks[i];
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

          this._handleUpdate(update);

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
  private _handleUpdate(update: any): void {
    const raw = update.message || update.channel_post || update.edited_message;
    if (!raw) return;

    const chat = raw.chat;
    const chatId = String(chat.id);
    const chatName = chat.title || chat.first_name || chat.username || chatId;

    // Update chat index
    if (!this.knownChats[chatId] || this.knownChats[chatId] !== chatName) {
      this.knownChats[chatId] = chatName;
      this._rebuildChatIndex();
    }

    // Build inbound message
    const from = raw.from || {};
    const fromMe = from.id === this._botId;
    const message = this._extractMessage(raw, chatId, fromMe);

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
  location?: { lat: number; lng: number; name?: string };
  quotedMessage?: { id: string; content: string; sender: string };
}

// ─── Formatting ─────────────────────────────────────────────────────

/** Convert Markdown to Telegram-safe HTML */
function _markdownToTelegramHtml(text: string): string {
  // Preserve code blocks first
  const codeBlocks: string[] = [];
  let result = text.replace(/```([\s\S]*?)```/g, (_, code) => {
    codeBlocks.push(code);
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

  // Bold: **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  result = result.replace(/__(.+?)__/g, '<b>$1</b>');

  // Italic: *text* or _text_ (single)
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>');
  result = result.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '<i>$1</i>');

  // Strikethrough: ~~text~~
  result = result.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Links: [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Headers: # text → bold
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

  // List items: - item → bullet
  result = result.replace(/^[-*]\s+/gm, '• ');

  // Restore inline code
  result = result.replace(/\x00INLINE(\d+)\x00/g, (_, i) =>
    `<code>${_escHtml(inlineCodes[Number(i)])}</code>`
  );

  // Restore code blocks
  result = result.replace(/\x00CODEBLOCK(\d+)\x00/g, (_, i) =>
    `<pre>${_escHtml(codeBlocks[Number(i)])}</pre>`
  );

  return result;
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

  // Parse "5m", "1h", "30s" etc.
  const match = schedule.match(/^(\d+)(s|m|h)$/);
  if (match) {
    const n = parseInt(match[1], 10);
    const unit = match[2];
    if (unit === 's') return n * 1000;
    if (unit === 'm') return n * 60_000;
    if (unit === 'h') return n * 60 * 60_000;
  }

  // Default: 1 hour
  return 60 * 60_000;
}
