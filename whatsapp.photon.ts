import fs from 'fs';
import os from 'os';
import path from 'path';
import pino from 'pino';

import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  WASocket,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

import { Photon } from '@portel/photon-core';

const logger = pino({ level: process.env.PHOTON_WA_DEBUG ? 'debug' : 'silent' });

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
 */
export default class WhatsApp extends Photon {
  private sock: WASocket | null = null;
  private connected = false;
  private qrPending = false;
  private phoneNumber = '';
  private reconnectAttempts = 0;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private knownGroups: Record<string, string> = {}; // jid → name
  private _lastQR: string | null = null;
  private _pendingMessages: Array<{ chatJid: string; message: InboundMessage }> = [];

  private get authDir(): string {
    const base = process.env.PHOTON_WHATSAPP_AUTHDIR
      || path.join(os.homedir(), '.photon', 'whatsapp', 'auth');
    fs.mkdirSync(base, { recursive: true });
    return base;
  }

  async onInitialize(ctx?: { reason?: string; oldInstance?: any }): Promise<void> {
    // Hot-reload: take over the socket from the old instance instead of reconnecting.
    // This avoids destroying the WhatsApp session (which could trigger 440 bans).
    if (ctx?.reason === 'hot-reload' && ctx.oldInstance) {
      const old = ctx.oldInstance;
      if (old.sock && old.connected) {
        this.sock = old.sock;
        this.connected = old.connected;
        this.phoneNumber = old.phoneNumber || '';
        this.knownGroups = old.knownGroups || {};
        this.outgoingQueue = old.outgoingQueue || [];
        this._pendingMessages = old._pendingMessages || [];
        this._lastQR = old._lastQR || null;
        this.reconnectAttempts = 0;

        // Null out old instance's socket reference so it can't interfere
        old.sock = null;
        old.connected = false;

        this.emit({ type: 'hot_reload_transferred', phone: this.phoneNumber });
        return;
      }
      // Old instance wasn't connected — fall through to normal auto-connect
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
   * @format qr
   */
  async connect(): Promise<{
    status: 'already_connected' | 'connected' | 'qr_pending';
    phone?: string;
    qr?: string;
    message?: string;
  }> {
    if (this.connected) {
      return { status: 'already_connected', phone: this.phoneNumber };
    }

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      browser: Browsers.macOS('Chrome'),
      logger,
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
  }

  /**
   * Disconnect from WhatsApp gracefully.
   */
  async disconnect(): Promise<{ status: string }> {
    this.connected = false;
    this.sock?.end(undefined);
    this.sock = null;
    this.emit({ type: 'disconnected' });
    return { status: 'disconnected' };
  }

  /**
   * Send a message to a WhatsApp JID.
   * Queues automatically if currently disconnected.
   * @param jid WhatsApp JID — group (@g.us) or contact (@s.whatsapp.net) {@example "12345678901@s.whatsapp.net"}
   * @param text Message text to send
   */
  async send(params: { jid: string; text: string }): Promise<{ queued: boolean }> {
    const { jid, text } = params;

    if (!this.connected || !this.sock) {
      this.outgoingQueue.push({ jid, text });
      return { queued: true };
    }

    try {
      await this.sock.sendMessage(jid, { text });
      return { queued: false };
    } catch {
      this.outgoingQueue.push({ jid, text });
      return { queued: true };
    }
  }

  /**
   * Return the current connection status.
   * @readOnly
   * @format kv
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
   * @readOnly
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
    } catch {
      // Fall through to return cached groups
    }

    return Object.entries(this.knownGroups).map(([jid, name]) => ({ jid, name }));
  }

  /**
   * Return and clear buffered inbound messages since last call.
   * Used by orchestrators (e.g. claw) to poll for new messages.
   * @readOnly
   * @format json
   */
  async pending(): Promise<Array<{ chatJid: string; message: InboundMessage }>> {
    const messages = this._pendingMessages.splice(0);
    return messages;
  }

  /**
   * Set typing indicator for a chat.
   * @param jid WhatsApp JID
   * @param typing Whether the bot is typing
   */
  async typing(params: { jid: string; typing: boolean }): Promise<void> {
    if (!this.connected || !this.sock) return;
    const status = params.typing ? 'composing' : 'paused';
    await this.sock.sendPresenceUpdate(status, params.jid).catch(() => {});
  }

  // ─── Internal ──────────────────────────────────────────────────

  private _wireSocketEvents(saveCreds: () => Promise<void>): void {
    if (!this.sock) return;

    this.sock.ev.on('connection.update', (update) => {
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
        if (this.reconnectAttempts >= 10) {
          this.emit({ type: 'reconnect_exhausted', attempts: this.reconnectAttempts });
          this.reconnectAttempts = 0;
          return;
        }

        this.reconnectAttempts++;
        const baseDelay = isRateLimited ? 30_000 : 1000;
        const delay = Math.min(baseDelay * 2 ** Math.min(this.reconnectAttempts - 1, 6), 120_000);
        setTimeout(() => this._reconnect().catch(() => {}), delay);
      } else if (connection === 'open') {
        this.connected = true;
        this.qrPending = false;
        this.reconnectAttempts = 0;

        if (this.sock?.user) {
          this.phoneNumber = this.sock.user.id.split(':')[0];
        }

        this._lastQR = null;
        this.emit({ type: 'connected', phone: this.phoneNumber });
        this._flushQueue().catch(() => {});
        this._syncGroups().catch(() => {});
        this.sock?.sendPresenceUpdate('available').catch(() => {});
      }
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        if (!msg.message) continue;
        const rawJid = msg.key.remoteJid;
        if (!rawJid || rawJid === 'status@broadcast') continue;

        const content =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption ||
          '';

        if (!content) continue;

        const chatJid = rawJid;
        const sender = msg.key.participant || msg.key.remoteJid || '';
        const senderName = msg.pushName || sender.split('@')[0];
        const timestamp = new Date(Number(msg.messageTimestamp) * 1000).toISOString();
        const fromMe = msg.key.fromMe || false;

        const inbound: InboundMessage = {
          id: msg.key.id || '',
          chatJid,
          sender,
          senderName,
          content,
          timestamp,
          fromMe,
        };

        // Buffer for polling via pending()
        this._pendingMessages.push({ chatJid, message: inbound });
        // Cap buffer to prevent unbounded growth
        if (this._pendingMessages.length > 1000) {
          this._pendingMessages.splice(0, this._pendingMessages.length - 1000);
        }

        // Also emit on channel for future pub/sub consumers
        this.emit({
          channel: 'whatsapp:messages',
          type: 'message',
          chatJid,
          message: inbound,
        });
      }
    });
  }

  private async _reconnect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      browser: Browsers.macOS('Chrome'),
      logger,
    });

    this._wireSocketEvents(saveCreds);
  }

  private async _flushQueue(): Promise<void> {
    if (this.flushing || !this.outgoingQueue.length || !this.sock) return;
    this.flushing = true;
    try {
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
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
    } catch {
      // Auth dir may not exist
    }
  }

  private async _syncGroups(): Promise<void> {
    if (!this.sock) return;
    try {
      const groups = await this.sock.groupFetchAllParticipating();
      for (const [jid, meta] of Object.entries(groups)) {
        if (meta.subject) this.knownGroups[jid] = meta.subject;
      }
    } catch {}
  }
}

// ─── Types ─────────────────────────────────────────────────────────

interface InboundMessage {
  id: string;
  chatJid: string;
  sender: string;
  senderName: string;
  content: string;
  timestamp: string;
  fromMe: boolean;
}
