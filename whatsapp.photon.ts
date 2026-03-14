import fs from 'fs';
import os from 'os';
import path from 'path';
import pino from 'pino';

import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  WASocket,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

import { Photon } from '@portel/photon-core';

// Logger is initialized lazily to respect the settings.debug flag.
// Use 'fatal' instead of 'silent' — Baileys internally checks logger.level
// and some code paths bypass 'silent' by writing to child loggers.
const silentLogger = pino({ level: 'fatal' });
const debugLogger = pino({ level: 'debug' });

/** Max age for queued messages before they're dropped on flush (1 hour) */
const MESSAGE_TTL_MS = 60 * 60 * 1000;

/** @deprecated Use this.storage('media') instead — kept for backward compat fallback */
const LEGACY_MEDIA_DIR = path.join(os.homedir(), '.photon', 'data', 'whatsapp', 'media');

/**
 * WhatsApp — live WhatsApp connection via Baileys.
 *
 * Manages authentication, message delivery, and group metadata.
 * Buffers inbound messages for polling by orchestrators (e.g. claw).
 *
 * @version 1.0.0
 * @icon 💬
 * @tags whatsapp, messaging, nanoclaw
 * @stateful
 * @dependencies @whiskeysockets/baileys@^7.0.0-rc.9, pino@^9.0.0
 * @ui dashboard ./ui/dashboard.html
 */
export default class WhatsApp extends Photon {
  protected settings = {
    /** Enable verbose debug logging */
    debug: false,
    /** Max reconnect attempts before giving up */
    maxReconnectAttempts: 10,
  };

  private sock: WASocket | null = null;
  private connected = false;
  private qrPending = false;
  private phoneNumber = '';
  private reconnectAttempts = 0;
  /** Tracks successful connections to avoid resetting backoff on flapping */
  private _lastConnectedAt = 0;
  /** Minimum interval between successful connections before resetting backoff (5 min) */
  private readonly _stableConnectionMs = 5 * 60 * 1000;
  /** Whether initial group sync has been done this session */
  private _groupsSynced = false;
  private outgoingQueue: Array<{ jid: string; text: string; queuedAt: number }> = [];
  private flushing = false;
  private knownGroups: Record<string, string> = {}; // jid → name
  private _groupNameIndex: Map<string, string> = new Map(); // lowercase name → jid (reverse index)
  private _lastQR: string | null = null;
  private _connectPromise: Promise<any> | null = null;
  private _destroyed = false;
  private _pendingMessages: Array<{ chatJid: string; message: InboundMessage }> = [];
  private _eventListeners: Array<{
    event: string;
    fn: (data: any) => void;
    filter?: { group?: string; jid?: string; trigger?: string; fromMe?: boolean };
    resolvedJid?: string; // cached JID from group name lookup
  }> = [];

  /** Pass a custom auth directory, or leave empty to use this.storage('auth') */
  constructor(private _authDir: string = '') {
    super();
  }

  private get authDir(): string {
    if (this._authDir) return this._authDir;
    // Use new storage API if available (runtime-injected _photonFilePath)
    if (this._photonFilePath) return this.storage('auth');
    // Legacy fallback for older runtimes
    return path.join(os.homedir(), '.photon', 'data', 'whatsapp', 'auth');
  }

  private get mediaDir(): string {
    if (this._photonFilePath) return this.storage('media');
    return LEGACY_MEDIA_DIR;
  }

  private get _logger() {
    return this.settings.debug ? debugLogger : silentLogger;
  }

  async onInitialize(ctx?: { reason?: string; oldInstance?: any }): Promise<void> {
    fs.mkdirSync(this.mediaDir, { recursive: true });
    // Hot-reload: take over the socket from the old instance instead of reconnecting.
    // This avoids destroying the WhatsApp session (which could trigger 440 bans).
    if (ctx?.reason === 'hot-reload' && ctx.oldInstance) {
      const old = ctx.oldInstance;
      // Transfer state regardless of connection status
      this.sock = old.sock || null;
      this.connected = old.connected || false;
      this.phoneNumber = old.phoneNumber || '';
      this.knownGroups = old.knownGroups || {};
      this.outgoingQueue = old.outgoingQueue || [];
      this._pendingMessages = old._pendingMessages || [];
      this._eventListeners = old._eventListeners || [];
      this._lastQR = old._lastQR || null;
      this._connectPromise = old._connectPromise || null;
      this.reconnectAttempts = old.reconnectAttempts || 0;
      this._lastConnectedAt = old._lastConnectedAt || 0;
      this._groupsSynced = old._groupsSynced || false;
      this._rebuildGroupIndex();

      // Mark old instance as destroyed so its stale timers don't interfere
      old._destroyed = true;
      old.connected = false;
      old._connectPromise = null;
      // Don't null old.sock — we transferred it, and we need to re-wire events below

      // Re-wire socket events on this new instance (old handlers are bound to old instance)
      if (this.sock) {
        this.sock.ev.removeAllListeners('connection.update');
        this.sock.ev.removeAllListeners('messages.upsert');
        // saveCreds is already wired and doesn't reference 'this', so leave it
        const { saveCreds } = await useMultiFileAuthState(this.authDir);
        this._wireSocketEvents(saveCreds);
      }
      // Now null the old socket ref
      old.sock = null;

      if (this.connected) {
        this.emit({ type: 'hot_reload_transferred', phone: this.phoneNumber });
      }
      return; // Don't auto-connect — preserve current state
    }

    // Normal startup: auto-connect if we have saved credentials
    const credsFile = path.join(this.authDir, 'creds.json');
    if (fs.existsSync(credsFile)) {
      this.connect().catch((err) => {
        this.emit({ type: 'auto_connect_failed', error: err.message });
      });
    }
  }

  async onShutdown(ctx?: { reason?: string }): Promise<void> {
    // During hot-reload, DON'T close the socket — the new instance will take it over.
    // Only close on real shutdown (daemon stop, unload, etc.)
    if (ctx?.reason === 'hot-reload') {
      this.emit({ type: 'hot_reload_preserving_socket' });
      return;
    }

    this.connected = false;
    this.sock?.end(undefined);
    this.sock = null;
  }

  /**
   * Connect to WhatsApp.
   *
   * If already authenticated, connects immediately.
   * If not, returns a QR code to scan. The connection completes
   * asynchronously — call status() to check when it's ready.
   *
   * @title Connect to WhatsApp
   * @openWorld
   * @format qr
   */
  async connect(): Promise<{
    status: 'already_connected' | 'connected' | 'qr_pending';
    phone?: string;
    qr?: string;
    message?: string;
  }> {
    if (this.connected) {
      return { status: 'already_connected' as const, phone: this.phoneNumber, message: `Already connected as +${this.phoneNumber}. No action needed.` };
    }
    // Deduplicate concurrent connect() calls — return same promise
    if (this._connectPromise) {
      return this._connectPromise;
    }
    this._connectPromise = this._doConnect();
    return this._connectPromise;
  }

  private async _doConnect(): Promise<any> {
    try {
      const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
      const { version } = await fetchLatestBaileysVersion();

      this.sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, this._logger),
        },
        printQRInTerminal: false,
        browser: Browsers.macOS('Desktop'),
        logger: this._logger,
      });

      // Wire persistent event handlers (messages, creds, reconnect)
      this._wireSocketEvents(saveCreds);

      // Wait for first meaningful event: QR, open, or close
      const first = await new Promise<
        { type: 'qr'; code: string } | { type: 'open' } | { type: 'error'; reason: string }
      >((resolve) => {
        const onUpdate = (update: any) => {
          if (update.qr) {
            this.sock?.ev.off('connection.update', onUpdate);
            resolve({ type: 'qr', code: update.qr });
          } else if (update.connection === 'open') {
            this.sock?.ev.off('connection.update', onUpdate);
            resolve({ type: 'open' });
          } else if (update.connection === 'close') {
            this.sock?.ev.off('connection.update', onUpdate);
            const reason = (update.lastDisconnect?.error as any)?.output?.statusCode;
            resolve({ type: 'error', reason: String(reason || 'unknown') });
          }
        };
        this.sock!.ev.on('connection.update', onUpdate);
      });

      if (first.type === 'error') {
        const code = Number(first.reason);
        // Session invalid — clear stale credentials and retry to get a fresh QR
        if (code === 440 || code === 401) {
          this._clearAuth();
          this.sock?.end(undefined);
          this.sock = null;
          this.emit({ type: 'session_expired', reason: code, message: 'Stale session cleared. Reconnecting for fresh QR...' });
          // Retry once — will now get a QR since credentials are gone
          return this.connect();
        }
        throw new Error(`Connection failed: ${first.reason}`);
      }

      if (first.type === 'open') {
        // Had saved credentials — connected immediately
        return { status: 'connected', phone: this.phoneNumber };
      }

      // QR needed — return it immediately, connection completes async
      // _wireSocketEvents already handles connection.open → sets connected + phone
      this.qrPending = true;
      this._lastQR = first.code;
      return {
        status: 'qr_pending',
        qr: first.code,
        message: 'Scan with WhatsApp → Linked Devices → Link a Device, then call status() to verify.',
      };
    } finally {
      this._connectPromise = null;
    }
  }

  /**
   * Disconnect from WhatsApp gracefully.
   *
   * @title Disconnect
   * @destructive
   * @openWorld
   */
  async disconnect(): Promise<void> {
    this.connected = false;
    this.sock?.end(undefined);
    this.sock = null;
    this.emit({ type: 'disconnected' });
  }

  /**
   * Send a message to a WhatsApp chat.
   * Accepts a group name, phone number, or raw JID.
   * Queues automatically if currently disconnected.
   *
   * @title Send Message
   * @openWorld
   * @param chat Group name, phone number, or JID {@choice-from groups.name} {@example "Arul and Lura"}
   * @param text Message text to send
   */
  async send(params: { chat: string; text: string }): Promise<{ queued: boolean; key?: MessageKey }> {
    const jid = await this._resolveJid(params.chat);
    const text = markdownToWa(params.text);

    if (!this.connected || !this.sock) {
      this.outgoingQueue.push({ jid, text, queuedAt: Date.now() });
      return { queued: true };
    }

    try {
      const sent = await this.sock.sendMessage(jid, { text });
      return { queued: false, key: sent?.key as MessageKey };
    } catch (err: any) {
      this.emit({ type: 'error', source: 'send', error: err.message });
      this.outgoingQueue.push({ jid, text, queuedAt: Date.now() });
      return { queued: true };
    }
  }

  /**
   * Edit a previously sent message in-place.
   * Only works on messages sent by this bot.
   * The JID is derived from the message key — no chat param needed.
   *
   * @title Edit Message
   * @openWorld
   * @param key Message key returned from send()
   * @param text New message text
   */
  async edit(params: { key: MessageKey; text: string }): Promise<void> {
    if (!this.connected || !this.sock) {
      throw new Error('Not connected. Call connect() first.');
    }
    const jid = params.key.remoteJid;
    if (!jid) throw new Error('Message key missing remoteJid');
    const text = markdownToWa(params.text);
    await this.sock.sendMessage(jid, { text, edit: params.key });
  }

  /**
   * Reply to a specific message in a WhatsApp chat.
   * The reply appears threaded/quoted in WhatsApp.
   *
   * @title Reply to Message
   * @openWorld
   * @param chat Group name, phone number, or JID {@choice-from groups.name}
   * @param text Reply text
   * @param quotedId Message ID to reply to (from inbound message's messageId field)
   */
  async reply(params: { chat: string; text: string; quotedId: string }): Promise<void> {
    if (!this.connected || !this.sock) {
      throw new Error('Not connected. Call connect() first.');
    }

    const jid = await this._resolveJid(params.chat);
    const text = markdownToWa(params.text);
    await this.sock.sendMessage(jid, { text }, {
      quoted: {
        key: { remoteJid: jid, id: params.quotedId },
        message: { conversation: '' },
      } as any,
    });
  }

  /**
   * React to a message with an emoji.
   * Send an empty emoji string to remove a reaction.
   *
   * @title React to Message
   * @openWorld
   * @param chat Group name, phone number, or JID {@choice-from groups.name}
   * @param messageId Message ID to react to
   * @param emoji Emoji to react with (e.g. "👍"), or empty string to remove {@example "👍"}
   */
  async react(params: { chat: string; messageId: string; emoji: string }): Promise<void> {
    if (!this.connected || !this.sock) {
      throw new Error('Not connected. Call connect() first.');
    }

    const jid = await this._resolveJid(params.chat);
    await this.sock.sendMessage(jid, {
      react: {
        text: params.emoji,
        key: { remoteJid: jid, id: params.messageId },
      },
    });
  }

  /**
   * Send media (image, video, audio, or document) to a WhatsApp chat.
   * Accepts a URL or local file path as the source.
   *
   * @title Send Media
   * @openWorld
   * @param chat Group name, phone number, or JID {@choice-from groups.name}
   * @param url URL or local file path of the media
   * @param type Media type {@choice image, video, audio, document}
   * @param caption Optional caption for the media
   * @param filename Optional filename (used for document type)
   */
  async media(params: {
    chat: string;
    url: string;
    type: 'image' | 'video' | 'audio' | 'document';
    caption?: string;
    filename?: string;
  }): Promise<void> {
    if (!this.connected || !this.sock) {
      throw new Error('Not connected. Call connect() first.');
    }

    const jid = await this._resolveJid(params.chat);
    const { url, type, caption, filename } = params;

    // Determine if source is a local file or a URL
    const isLocal = !url.startsWith('http://') && !url.startsWith('https://');
    const source = isLocal ? await fs.promises.readFile(url) : { url };

    const msgPayload: Record<string, any> = {};
    switch (type) {
      case 'image':
        msgPayload.image = source;
        if (caption) msgPayload.caption = caption;
        break;
      case 'video':
        msgPayload.video = source;
        if (caption) msgPayload.caption = caption;
        break;
      case 'audio':
        msgPayload.audio = source;
        msgPayload.mimetype = 'audio/mpeg';
        break;
      case 'document':
        msgPayload.document = source;
        msgPayload.mimetype = 'application/octet-stream';
        if (filename) msgPayload.fileName = filename;
        if (caption) msgPayload.caption = caption;
        break;
    }

    await this.sock.sendMessage(jid, msgPayload);
  }

  /**
   * Return the current connection status.
   *
   * @title Status
   * @readOnly
   * @closedWorld
   * @ui dashboard
   */
  async status(): Promise<{
    status: 'connected' | 'disconnected' | 'qr_pending';
    phone: string;
    queuedMessages: number;
    reconnectAttempts: number;
    qr?: string;
  }> {
    return {
      status: this.connected ? 'connected' : this.qrPending ? 'qr_pending' : 'disconnected',
      phone: this.phoneNumber,
      queuedMessages: this.outgoingQueue.length,
      reconnectAttempts: this.reconnectAttempts,
      ...(this._lastQR ? { qr: this._lastQR } : {}),
    };
  }

  /**
   * List all known WhatsApp groups.
   *
   * @title List Groups
   * @readOnly
   * @openWorld
   * @format table
   */
  async groups(): Promise<Array<{ jid: string; name: string }>> {
    if (!this.connected || !this.sock) {
      throw new Error('Not connected. Call connect() first.');
    }

    try {
      const fetched = await this.sock.groupFetchAllParticipating();
      for (const [jid, meta] of Object.entries(fetched)) {
        if (meta.subject) this.knownGroups[jid] = meta.subject;
      }
      this._rebuildGroupIndex();
    } catch (err: any) {
      this.emit({ type: 'error', source: 'groups', error: err.message });
      // Fall through to return cached groups
    }

    return Object.entries(this.knownGroups).map(([jid, name]) => ({ jid, name }));
  }

  /**
   * Return and clear buffered inbound messages since last call.
   * Used by orchestrators (e.g. claw) to poll for new messages.
   *
   * @title Pending Messages
   * @closedWorld
   * @format json
   */
  async pending(): Promise<Array<{ chatJid: string; message: InboundMessage }>> {
    const messages = this._pendingMessages.splice(0);
    return messages;
  }

  /**
   * Generate a group invite link.
   *
   * @title Group Invite Link
   * @readOnly
   * @openWorld
   * @param chat Group name or JID {@choice-from groups.name}
   */
  async invite(params: { chat: string }): Promise<{ link: string }> {
    if (!this.connected || !this.sock) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const jid = await this._resolveJid(params.chat);
      const code = await this.sock.groupInviteCode(jid);
      return { link: `https://chat.whatsapp.com/${code}` };
    } catch (err: any) {
      this.emit({ type: 'error', source: 'invite', error: err.message });
      throw err;
    }
  }

  /**
   * List members of a group with their roles.
   *
   * @title Group Members
   * @readOnly
   * @openWorld
   * @format table
   * @param chat Group name or JID {@choice-from groups.name}
   */
  async members(params: { chat: string }): Promise<Array<{ jid: string; admin: string }>> {
    if (!this.connected || !this.sock) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const jid = await this._resolveJid(params.chat);
      const meta = await this.sock.groupMetadata(jid);
      return meta.participants.map((p: any) => ({
        jid: p.id,
        admin: p.admin || 'member',
      }));
    } catch (err: any) {
      this.emit({ type: 'error', source: 'members', error: err.message });
      throw err;
    }
  }

  /**
   * Group admin operations: add, remove, promote, or demote members.
   *
   * @title Group Admin
   * @destructive
   * @openWorld
   * @param chat Group name or JID {@choice-from groups.name}
   * @param action Admin action to perform {@choice add, remove, promote, demote}
   * @param members Array of member JIDs to act on
   */
  async admin(params: {
    chat: string;
    action: 'add' | 'remove' | 'promote' | 'demote';
    members: string[];
  }): Promise<void> {
    if (!this.connected || !this.sock) {
      throw new Error('Not connected. Call connect() first.');
    }

    const jid = await this._resolveJid(params.chat);
    await this.sock.groupParticipantsUpdate(jid, params.members, params.action);
  }

  /**
   * Subscribe to events with optional filtering.
   * @internal
   *
   * @example
   * // All messages
   * whatsapp.on('message', handler)
   *
   * // Specific group by name (fuzzy match) with trigger
   * whatsapp.on('message', handler, { group: 'Arul and Lura', trigger: '@' })
   *
   * // By JID directly
   * whatsapp.on('message', handler, { jid: '120363406704631066@g.us' })
   */
  on(event: string, fn: (data: any) => void, filter?: { group?: string; jid?: string; trigger?: string; fromMe?: boolean }): void {
    const entry: typeof this._eventListeners[0] = { event, fn, filter };

    // Resolve group name → JID eagerly if groups are already known
    if (filter?.group) {
      const query = filter.group.toLowerCase();
      const jid = this._groupNameIndex.get(query)
        || [...this._groupNameIndex.entries()].find(([name]) => name.includes(query))?.[1];
      if (jid) entry.resolvedJid = jid;
    }

    // If a JID- or group-name-filtered listener for this event already exists, replace it.
    // This prevents stale handlers accumulating across claw restarts where the
    // new instance has no reference to the old handler functions.
    if (filter?.jid || filter?.group) {
      const idx = this._eventListeners.findIndex(e =>
        e.event === event &&
        ((filter.jid && e.filter?.jid === filter.jid) ||
         (filter.group && e.filter?.group === filter.group))
      );
      if (idx !== -1) this._eventListeners.splice(idx, 1);
    }

    this._eventListeners.push(entry);
  }

  /**
   * Unsubscribe from events.
   * @internal
   */
  off(event: string, fn: (data: any) => void): void {
    const idx = this._eventListeners.findIndex(e => e.event === event && e.fn === fn);
    if (idx !== -1) this._eventListeners.splice(idx, 1);
  }

  /**
   * Set typing indicator for a chat.
   *
   * @title Set Typing Indicator
   * @openWorld
   * @param chat Group name, phone number, or JID {@choice-from groups.name}
   * @param typing True to show composing, false to clear
   */
  async typing(params: { chat: string; typing: boolean }): Promise<void> {
    if (!this.connected || !this.sock) return;
    const jid = await this._resolveJid(params.chat).catch(() => null);
    if (!jid) return;
    const status = params.typing ? 'composing' : 'paused';
    await this.sock.sendPresenceUpdate(status, jid).catch((err: any) => {
      this.emit({ type: 'error', source: 'typing', error: err.message });
    });
  }

  // ─── Group Management ──────────────────────────────────────────

  /**
   * Audit all groups — lists every group with participant count, creation date, and description.
   * Useful for finding large, dead, or forgotten groups.
   *
   * @title Audit Groups
   * @readOnly
   * @openWorld
   * @format table
   * @param sort Sort by: 'size' (most members), 'name', or 'created' {@choice size, name, created} {@default size}
   * @param minMembers Only show groups with at least this many members {@min 0} {@default 0}
   */
  async audit(params: { sort?: string; minMembers?: number } = {}): Promise<Array<{
    name: string;
    jid: string;
    members: number;
    admins: number;
    description: string;
    created: string;
    ephemeral: string;
  }>> {
    if (!this.connected || !this.sock) throw new Error('Not connected');

    const fetched = await this.sock.groupFetchAllParticipating();
    const results = Object.entries(fetched).map(([jid, meta]: [string, any]) => {
      const participants = meta.participants || [];
      return {
        name: meta.subject || jid,
        jid,
        members: participants.length,
        admins: participants.filter((p: any) => p.admin === 'admin' || p.admin === 'superadmin').length,
        description: (meta.desc || '').slice(0, 100),
        created: meta.creation ? new Date(meta.creation * 1000).toISOString().split('T')[0] : 'unknown',
        ephemeral: meta.ephemeralDuration ? `${meta.ephemeralDuration / 86400}d` : 'off',
      };
    });

    const min = params.minMembers ?? 0;
    const filtered = results.filter(g => g.members >= min);

    const sort = params.sort || 'size';
    if (sort === 'size') filtered.sort((a, b) => b.members - a.members);
    else if (sort === 'name') filtered.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === 'created') filtered.sort((a, b) => a.created.localeCompare(b.created));

    return filtered;
  }

  /**
   * Leave a WhatsApp group.
   *
   * @title Leave Group
   * @destructive
   * @openWorld
   * @param chat Group name or JID {@choice-from groups.name}
   */
  async leave(params: { chat: string }): Promise<{ left: string }> {
    if (!this.connected || !this.sock) throw new Error('Not connected');
    const jid = await this._resolveJid(params.chat);
    await this.sock.groupLeave(jid);
    // Remove from known groups
    delete this.knownGroups[jid];
    this._rebuildGroupIndex();
    return { left: jid };
  }

  /**
   * Rename a WhatsApp group.
   *
   * @title Rename Group
   * @openWorld
   * @param chat Group name or JID {@choice-from groups.name}
   * @param name New group name {@example "Project Alpha"}
   */
  async rename(params: { chat: string; name: string }): Promise<void> {
    if (!this.connected || !this.sock) throw new Error('Not connected');
    const jid = await this._resolveJid(params.chat);
    await this.sock.groupUpdateSubject(jid, params.name);
    this.knownGroups[jid] = params.name;
    this._rebuildGroupIndex();
  }

  /**
   * Set or clear a group's description.
   *
   * @title Set Group Description
   * @openWorld
   * @param chat Group name or JID {@choice-from groups.name}
   * @param description New description (empty to clear)
   */
  async describe(params: { chat: string; description: string }): Promise<void> {
    if (!this.connected || !this.sock) throw new Error('Not connected');
    const jid = await this._resolveJid(params.chat);
    await this.sock.groupUpdateDescription(jid, params.description || undefined);
  }

  /**
   * Toggle disappearing messages for a group.
   *
   * @title Disappearing Messages
   * @openWorld
   * @param chat Group name or JID {@choice-from groups.name}
   * @param duration Duration: 'off', '24h', '7d', '90d' {@choice off, 24h, 7d, 90d} {@default off}
   */
  async ephemeral(params: { chat: string; duration: string }): Promise<void> {
    if (!this.connected || !this.sock) throw new Error('Not connected');
    const jid = await this._resolveJid(params.chat);
    const durations: Record<string, number> = {
      'off': 0,
      '24h': 86400,
      '7d': 604800,
      '90d': 7776000,
    };
    const seconds = durations[params.duration] ?? 0;
    await this.sock.groupToggleEphemeral(jid, seconds);
  }

  /**
   * View and manage pending join requests for a group.
   *
   * @title Join Requests
   * @openWorld
   * @format table
   * @param chat Group name or JID {@choice-from groups.name}
   */
  async requests(params: { chat: string }): Promise<Array<{ jid: string; phone: string }>> {
    if (!this.connected || !this.sock) throw new Error('Not connected');
    const jid = await this._resolveJid(params.chat);
    const pending = await this.sock.groupRequestParticipantsList(jid);
    return (pending || []).map((p: any) => ({
      jid: p.jid,
      phone: '+' + p.jid.split('@')[0],
    }));
  }

  /**
   * Approve or reject pending join requests for a group.
   *
   * @title Handle Join Request
   * @openWorld
   * @param chat Group name or JID {@choice-from groups.name}
   * @param members JIDs of requesters to handle
   * @param action Approve or reject {@choice approve, reject}
   */
  async handle(params: { chat: string; members: string[]; action: 'approve' | 'reject' }): Promise<void> {
    if (!this.connected || !this.sock) throw new Error('Not connected');
    const jid = await this._resolveJid(params.chat);
    await this.sock.groupRequestParticipantsUpdate(jid, params.members, params.action);
  }

  /**
   * Lock or unlock group settings.
   * Locked = only admins can edit group info. Announcement = only admins can send messages.
   *
   * @title Group Settings
   * @openWorld
   * @param chat Group name or JID {@choice-from groups.name}
   * @param setting Setting to apply {@choice announcement, not_announcement, locked, unlocked}
   */
  async restrict(params: { chat: string; setting: string }): Promise<void> {
    if (!this.connected || !this.sock) throw new Error('Not connected');
    const jid = await this._resolveJid(params.chat);
    await this.sock.groupSettingUpdate(jid, params.setting as any);
  }

  // ─── Chat Organization ────────────────────────────────────────

  /**
   * Mute or unmute a chat.
   *
   * @title Mute Chat
   * @openWorld
   * @param chat Group name, phone number, or JID {@choice-from groups.name}
   * @param duration Mute duration: '8h', '1w', 'forever', or 'off' to unmute {@choice 8h, 1w, forever, off}
   */
  async mute(params: { chat: string; duration: string }): Promise<void> {
    if (!this.connected || !this.sock) throw new Error('Not connected');
    const jid = await this._resolveJid(params.chat);
    const durations: Record<string, number | null> = {
      'off': null,
      '8h': Date.now() + 8 * 3600 * 1000,
      '1w': Date.now() + 7 * 86400 * 1000,
      'forever': -1,
    };
    const mute = durations[params.duration] ?? null;
    await this.sock.chatModify({ mute }, jid);
  }

  /**
   * Archive or unarchive a chat.
   *
   * @title Archive Chat
   * @openWorld
   * @param chat Group name, phone number, or JID {@choice-from groups.name}
   * @param archive True to archive, false to unarchive {@default true}
   */
  async archive(params: { chat: string; archive?: boolean }): Promise<void> {
    if (!this.connected || !this.sock) throw new Error('Not connected');
    const jid = await this._resolveJid(params.chat);
    await this.sock.chatModify({ archive: params.archive !== false }, jid);
  }

  /**
   * Pin or unpin a chat.
   *
   * @title Pin Chat
   * @openWorld
   * @param chat Group name, phone number, or JID {@choice-from groups.name}
   * @param pin True to pin, false to unpin {@default true}
   */
  async pin(params: { chat: string; pin?: boolean }): Promise<void> {
    if (!this.connected || !this.sock) throw new Error('Not connected');
    const jid = await this._resolveJid(params.chat);
    await this.sock.chatModify({ pin: params.pin !== false }, jid);
  }

  /**
   * Mark a chat as read or unread.
   *
   * @title Mark Read
   * @openWorld
   * @param chat Group name, phone number, or JID {@choice-from groups.name}
   * @param read True to mark read, false to mark unread {@default true}
   */
  async read(params: { chat: string; read?: boolean }): Promise<void> {
    if (!this.connected || !this.sock) throw new Error('Not connected');
    const jid = await this._resolveJid(params.chat);
    await this.sock.chatModify({ markRead: params.read !== false }, jid);
  }

  // ─── Contact Utilities ────────────────────────────────────────

  /**
   * Check if phone numbers exist on WhatsApp.
   * Returns which numbers are registered and their JIDs.
   *
   * @title Lookup Numbers
   * @readOnly
   * @openWorld
   * @format table
   * @param numbers Phone numbers to check (with country code) {@example ["+60123456789", "+1234567890"]}
   */
  async lookup(params: { numbers: string[] }): Promise<Array<{ number: string; exists: boolean; jid: string | null }>> {
    if (!this.connected || !this.sock) throw new Error('Not connected');
    const results = await this.sock.onWhatsApp(...params.numbers.map(n => n.replace(/\D/g, '')));
    return params.numbers.map(num => {
      const clean = num.replace(/\D/g, '');
      const match = results.find((r: any) => r.jid?.startsWith(clean) || clean.endsWith(r.jid?.split('@')[0] || ''));
      return {
        number: num,
        exists: match?.exists ?? false,
        jid: match?.jid ?? null,
      };
    });
  }

  /**
   * Block a contact.
   *
   * @title Block Contact
   * @destructive
   * @openWorld
   * @param contact Phone number or JID to block {@example "+60123456789"}
   */
  async block(params: { contact: string }): Promise<void> {
    if (!this.connected || !this.sock) throw new Error('Not connected');
    const jid = await this._resolveJid(params.contact);
    await this.sock.updateBlockStatus(jid, 'block');
  }

  /**
   * Unblock a contact.
   *
   * @title Unblock Contact
   * @openWorld
   * @param contact Phone number or JID to unblock {@example "+60123456789"}
   */
  async unblock(params: { contact: string }): Promise<void> {
    if (!this.connected || !this.sock) throw new Error('Not connected');
    const jid = await this._resolveJid(params.contact);
    await this.sock.updateBlockStatus(jid, 'unblock');
  }

  /**
   * List all blocked contacts.
   *
   * @title Blocked List
   * @readOnly
   * @openWorld
   * @format table
   */
  async blocked(): Promise<Array<{ jid: string; phone: string }>> {
    if (!this.connected || !this.sock) throw new Error('Not connected');
    const list = await this.sock.fetchBlocklist();
    return (list || []).map((jid: string) => ({
      jid,
      phone: '+' + jid.split('@')[0],
    }));
  }

  // ─── Privacy ──────────────────────────────────────────────────

  /**
   * View current privacy settings.
   *
   * @title Privacy Settings
   * @readOnly
   * @openWorld
   * @format card
   */
  async privacy(): Promise<Record<string, string>> {
    if (!this.connected || !this.sock) throw new Error('Not connected');
    const settings = await this.sock.fetchPrivacySettings(true);
    // Flatten to human-readable keys
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(settings)) {
      const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      result[label] = String(value);
    }
    return result;
  }

  /**
   * Update a privacy setting.
   *
   * @title Update Privacy
   * @openWorld
   * @param setting Which setting to change {@choice lastSeen, online, profilePicture, status, readReceipts, groupsAdd}
   * @param value New value {@choice all, contacts, none, match_last_seen}
   */
  async setPrivacy(params: { setting: string; value: string }): Promise<void> {
    if (!this.connected || !this.sock) throw new Error('Not connected');
    const methods: Record<string, (v: any) => Promise<void>> = {
      lastSeen: (v) => this.sock!.updateLastSeenPrivacy(v),
      online: (v) => this.sock!.updateOnlinePrivacy(v),
      profilePicture: (v) => this.sock!.updateProfilePicturePrivacy(v),
      status: (v) => this.sock!.updateStatusPrivacy(v),
      readReceipts: (v) => this.sock!.updateReadReceiptsPrivacy(v),
      groupsAdd: (v) => this.sock!.updateGroupsAddPrivacy(v),
    };
    const fn = methods[params.setting];
    if (!fn) throw new Error(`Unknown setting: ${params.setting}. Valid: ${Object.keys(methods).join(', ')}`);
    await fn(params.value);
  }

  /**
   * Update your profile status message.
   *
   * @title Set Status
   * @openWorld
   * @param text New status text {@example "Available"}
   */
  async setStatus(params: { text: string }): Promise<void> {
    if (!this.connected || !this.sock) throw new Error('Not connected');
    await this.sock.updateProfileStatus(params.text);
  }

  // ─── Internal ──────────────────────────────────────────────────

  private _rebuildGroupIndex(): void {
    this._groupNameIndex.clear();
    for (const [jid, name] of Object.entries(this.knownGroups)) {
      this._groupNameIndex.set(name.toLowerCase(), jid);
    }
  }

  /** Resolve a human-readable chat identifier to a WhatsApp JID.
   * - Already a JID (contains '@')  → passthrough
   * - Phone number (digits/+/spaces) → NNN@s.whatsapp.net
   * - Group name                     → fuzzy lookup via _groupNameIndex (lazy-syncs if empty)
   */
  private async _resolveJid(chat: string): Promise<string> {
    if (chat.includes('@')) return chat;
    if (/^\+?[\d\s\-()+]+$/.test(chat)) return `${chat.replace(/\D/g, '')}@s.whatsapp.net`;
    // Group name — lazy sync if index not populated yet
    if (this._groupNameIndex.size === 0 && this.connected) await this._syncGroups();
    const query = chat.toLowerCase();
    const jid = this._groupNameIndex.get(query)
      || [...this._groupNameIndex.entries()].find(([name]) => name.includes(query))?.[1];
    if (!jid) throw new Error(`No group matching "${chat}". Call groups() to see available groups.`);
    return jid;
  }

  /** Download media from a Baileys message and attach the file path to the InboundMessage */
  private async _downloadMedia(msg: any, inbound: InboundMessage): Promise<void> {
    const ext = this._mimeToExt(inbound.media?.mimetype || '');
    const filename = `${inbound.messageId}${ext}`;
    const filePath = path.join(this.mediaDir, filename);

    // Skip if already downloaded (e.g. from a retry)
    if (fs.existsSync(filePath)) {
      inbound.filePath = filePath;
      return;
    }

    const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
      logger: this._logger,
      reuploadRequest: this.sock!.updateMediaMessage,
    });

    await fs.promises.writeFile(filePath, buffer);
    inbound.filePath = filePath;
  }

  /** Map common MIME types to file extensions */
  private _mimeToExt(mime: string): string {
    const map: Record<string, string> = {
      'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
      'video/mp4': '.mp4', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a',
      'application/pdf': '.pdf', 'application/octet-stream': '.bin',
    };
    return map[mime] || `.${mime.split('/')[1] || 'bin'}`;
  }

  private _wireSocketEvents(saveCreds: () => Promise<void>): void {
    if (!this.sock) return;

    this.sock.ev.on('connection.update', (update) => {
      if (this._destroyed) return; // Old instance after hot-reload — ignore
      const { connection, lastDisconnect } = update;

      if (connection === 'close') {
        this.connected = false;
        this.qrPending = false;
        const reason = (lastDisconnect?.error as any)?.output?.statusCode;

        this.emit({ type: 'disconnected', reason });

        // 440 = session replaced, 401 = unauthorized, loggedOut = explicit logout
        // These mean credentials are invalid — clear them and stop retrying.
        const isSessionDead =
          reason === DisconnectReason.loggedOut ||
          reason === 440 ||
          reason === 401;

        if (isSessionDead) {
          this._clearAuth();
          this.reconnectAttempts = 0;
          this.emit({ type: 'session_expired', reason, message: 'Credentials cleared. Call connect() to re-authenticate with QR.' });
          return;
        }

        // 503 = rate limited — use longer backoff
        const isRateLimited = reason === 503;

        // Cap reconnect attempts to avoid infinite retry storms
        if (this.reconnectAttempts >= this.settings.maxReconnectAttempts) {
          this.emit({ type: 'reconnect_exhausted', attempts: this.reconnectAttempts });
          this.reconnectAttempts = 0;
          return;
        }

        this.reconnectAttempts++;
        const baseDelay = isRateLimited ? 30_000 : 5_000; // 5s minimum (was 1s)
        const delay = Math.min(baseDelay * 2 ** Math.min(this.reconnectAttempts - 1, 5), 120_000);
        setTimeout(() => this._reconnect().catch((err: any) => {
          this.emit({ type: 'error', source: 'reconnect', error: err.message });
        }), delay);
      } else if (connection === 'open') {
        this.connected = true;
        this.qrPending = false;

        // Only reset backoff if connection was stable (not flapping)
        const now = Date.now();
        if (now - this._lastConnectedAt > this._stableConnectionMs) {
          this.reconnectAttempts = 0;
        }
        this._lastConnectedAt = now;

        if (this.sock?.user) {
          this.phoneNumber = this.sock.user.id.split(':')[0];
        }

        this._lastQR = null;
        this.emit({ type: 'connected', phone: this.phoneNumber });
        this._flushQueue().catch((err: any) => {
          this.emit({ type: 'error', source: 'flush_queue', error: err.message });
        });
        // Only sync groups once per session — avoids repeated sync notifications on phone
        if (!this._groupsSynced) {
          this._groupsSynced = true;
          this._syncGroups().catch((err: any) => {
            this.emit({ type: 'error', source: 'sync_groups', error: err.message });
          });
        }
        // Skip presence update on reconnects — reduces phone notifications
        if (this.reconnectAttempts === 0) {
          this.sock?.sendPresenceUpdate('available').catch((err: any) => {
            this.emit({ type: 'error', source: 'presence', error: err.message });
          });
        }
      }
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        if (!msg.message) continue;
        const rawJid = msg.key.remoteJid;
        if (!rawJid || rawJid === 'status@broadcast') continue;

        const chatJid = rawJid;
        const sender = msg.key.participant || msg.key.remoteJid || '';
        const senderName = msg.pushName || sender.split('@')[0];
        const ts = Number(msg.messageTimestamp);
        const timestamp = ts > 0 ? new Date(ts * 1000).toISOString() : new Date().toISOString();
        const fromMe = msg.key.fromMe || false;
        const messageId = msg.key.id || '';

        const inbound = this._extractMessage(msg.message, {
          messageId, chatJid, sender, senderName, timestamp, fromMe,
        });

        // Download media for supported types (non-blocking — attach path when ready)
        if (inbound.media && ['image', 'video', 'audio', 'document', 'sticker'].includes(inbound.type)) {
          this._downloadMedia(msg, inbound).catch((err: any) => {
            this.emit({ type: 'error', source: 'media_download', error: err.message });
          });
        }

        // Buffer for polling via pending()
        this._pendingMessages.push({ chatJid, message: inbound });
        // Cap buffer to prevent unbounded growth
        if (this._pendingMessages.length > 1000) {
          this._pendingMessages.splice(0, this._pendingMessages.length - 1000);
        }

        // Notify direct listeners (e.g. claw via this.whatsapp.on('message', ...))
        for (const entry of this._eventListeners) {
          if (entry.event !== 'message') continue;
          const f = entry.filter;
          if (f) {
            // JID filter (direct or resolved from group name)
            if (f.jid && f.jid !== chatJid) continue;
            if (f.group) {
              // Lazy-resolve group name if not yet resolved
              if (!entry.resolvedJid) {
                const query = f.group.toLowerCase();
                const jid = this._groupNameIndex.get(query)
                  || [...this._groupNameIndex.entries()].find(([name]) => name.includes(query))?.[1];
                if (jid) entry.resolvedJid = jid;
              }
              if (entry.resolvedJid && entry.resolvedJid !== chatJid) continue;
            }
            if (f.trigger && !inbound.content.includes(f.trigger)) continue;
            if (f.fromMe !== undefined && f.fromMe !== fromMe) continue;
          }
          try {
            entry.fn({ chatJid, message: inbound });
          } catch (err: any) {
            this.emit({ type: 'error', source: 'event_listener', error: err.message });
          }
        }

        // Emit on channel — framework auto-prefixes with photon name ('whatsapp:messages')
        this.emit({
          channel: 'messages',
          type: 'message',
          chatJid,
          message: inbound,
        });
      }
    });
  }

  /** Extract rich message fields from a Baileys message object */
  private _extractMessage(
    message: any,
    base: { messageId: string; chatJid: string; sender: string; senderName: string; timestamp: string; fromMe: boolean },
  ): InboundMessage {
    const m = message;
    const result: InboundMessage = {
      messageId: base.messageId,
      chatJid: base.chatJid,
      sender: base.sender,
      senderName: base.senderName,
      content: '',
      timestamp: base.timestamp,
      fromMe: base.fromMe,
      type: 'unknown',
    };

    // Text messages
    if (m.conversation) {
      result.type = 'text';
      result.content = m.conversation;
    } else if (m.extendedTextMessage) {
      result.type = 'text';
      result.content = m.extendedTextMessage.text || '';
      // Check for quoted message
      const ctx = m.extendedTextMessage.contextInfo;
      if (ctx?.quotedMessage) {
        result.quotedMessage = {
          id: ctx.stanzaId || '',
          content: ctx.quotedMessage.conversation || ctx.quotedMessage.extendedTextMessage?.text || '',
          sender: ctx.participant || '',
        };
      }
    }
    // Image
    else if (m.imageMessage) {
      result.type = 'image';
      result.content = m.imageMessage.caption || '';
      result.media = {
        mimetype: m.imageMessage.mimetype || 'image/jpeg',
        caption: m.imageMessage.caption,
      };
    }
    // Video
    else if (m.videoMessage) {
      result.type = 'video';
      result.content = m.videoMessage.caption || '';
      result.media = {
        mimetype: m.videoMessage.mimetype || 'video/mp4',
        caption: m.videoMessage.caption,
        seconds: m.videoMessage.seconds,
      };
    }
    // Audio
    else if (m.audioMessage) {
      result.type = 'audio';
      result.media = {
        mimetype: m.audioMessage.mimetype || 'audio/ogg',
        seconds: m.audioMessage.seconds,
      };
    }
    // Document
    else if (m.documentMessage) {
      result.type = 'document';
      result.content = m.documentMessage.caption || '';
      result.media = {
        mimetype: m.documentMessage.mimetype || 'application/octet-stream',
        caption: m.documentMessage.caption,
        filename: m.documentMessage.fileName,
      };
    }
    // Sticker
    else if (m.stickerMessage) {
      result.type = 'sticker';
      result.media = {
        mimetype: m.stickerMessage.mimetype || 'image/webp',
      };
    }
    // Reaction
    else if (m.reactionMessage) {
      result.type = 'reaction';
      result.content = m.reactionMessage.text || '';
      result.reaction = {
        emoji: m.reactionMessage.text || '',
        targetMessageId: m.reactionMessage.key?.id || '',
      };
    }
    // Location
    else if (m.locationMessage) {
      result.type = 'location';
      result.content = m.locationMessage.name || m.locationMessage.address || '';
      result.location = {
        lat: m.locationMessage.degreesLatitude,
        lng: m.locationMessage.degreesLongitude,
        name: m.locationMessage.name,
      };
    }
    // Live location
    else if (m.liveLocationMessage) {
      result.type = 'location';
      result.content = m.liveLocationMessage.caption || '';
      result.location = {
        lat: m.liveLocationMessage.degreesLatitude,
        lng: m.liveLocationMessage.degreesLongitude,
      };
    }
    // Contact
    else if (m.contactMessage) {
      result.type = 'contact';
      result.content = m.contactMessage.displayName || '';
    }
    // Poll
    else if (m.pollCreationMessage || m.pollCreationMessageV3) {
      const poll = m.pollCreationMessage || m.pollCreationMessageV3;
      result.type = 'poll';
      result.content = poll.name || '';
    }
    // Protocol messages (deletes, edits) — emit but don't drop silently
    else if (m.protocolMessage) {
      result.type = 'unknown';
      result.content = '';
    }

    // Convert WhatsApp formatting → Markdown for all text content
    if (result.content) {
      result.content = waToMarkdown(result.content);
    }

    return result;
  }

  private async _reconnect(): Promise<void> {
    if (this._destroyed) return; // Old instance after hot-reload — don't reconnect
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, this._logger),
      },
      printQRInTerminal: false,
      browser: Browsers.macOS('Desktop'),
      logger: this._logger,
    });

    this._wireSocketEvents(saveCreds);
  }

  private async _flushQueue(): Promise<void> {
    if (this.flushing || !this.outgoingQueue.length || !this.sock) return;
    this.flushing = true;
    try {
      const now = Date.now();
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        // Drop stale messages older than TTL
        if (item.queuedAt && now - item.queuedAt > MESSAGE_TTL_MS) {
          this.emit({ type: 'message_expired', jid: item.jid, age: now - item.queuedAt });
          continue;
        }
        await this.sock.sendMessage(item.jid, { text: item.text });
      }
    } finally {
      this.flushing = false;
    }
  }

  private _clearAuth(): void {
    try {
      const entries = fs.readdirSync(this.authDir);
      for (const entry of entries) {
        fs.rmSync(path.join(this.authDir, entry), { recursive: true, force: true });
      }
      this.emit({ type: 'auth_cleared' });
    } catch (err: any) {
      this.emit({ type: 'error', source: 'clear_auth', error: err.message });
    }
  }

  private async _syncGroups(): Promise<void> {
    if (!this.sock) return;
    try {
      const groups = await this.sock.groupFetchAllParticipating();
      for (const [jid, meta] of Object.entries(groups)) {
        if (meta.subject) this.knownGroups[jid] = meta.subject;
      }
      this._rebuildGroupIndex();
    } catch (err: any) {
      this.emit({ type: 'error', source: 'sync_groups', error: err.message });
    }
  }
}

// ─── Types ─────────────────────────────────────────────────────────

interface MessageKey {
  remoteJid?: string | null;
  fromMe?: boolean | null;
  id?: string | null;
}

interface InboundMessage {
  messageId: string;
  chatJid: string;
  sender: string;
  senderName: string;
  content: string;
  timestamp: string;
  fromMe: boolean;
  type: 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'reaction' | 'location' | 'contact' | 'poll' | 'unknown';
  media?: { mimetype: string; caption?: string; filename?: string; seconds?: number };
  reaction?: { emoji: string; targetMessageId: string };
  location?: { lat: number; lng: number; name?: string };
  quotedMessage?: { id: string; content: string; sender: string };
  filePath?: string;
}

// ─── WhatsApp ↔ Markdown Formatting ────────────────────────────────

/**
 * Convert WhatsApp formatting to standard Markdown.
 * WhatsApp: *bold*  _italic_  ~strikethrough~  ```code```  `mono`
 * Markdown: **bold** _italic_ ~~strikethrough~~ ```code```  `mono`
 */
function waToMarkdown(text: string): string {
  // Preserve code blocks (``` ... ```) — same in both formats
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

  // *bold* → **bold** (but not ** which is already markdown)
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
