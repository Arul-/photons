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
 * WhatsApp Bridge — live WhatsApp connection via Baileys.
 *
 * Manages authentication, message delivery, and group metadata.
 * Emits inbound messages as events so other photons (e.g. message-router)
 * can subscribe and act on them.
 *
 * @version 1.0.0
 * @icon 💬
 * @tags whatsapp, messaging, bridge, nanoclaw
 * @stateful
 * @dependencies @whiskeysockets/baileys@^7.0.0-rc.9, pino@^9.0.0
 */
export default class WhatsAppBridge extends Photon {
  private sock: WASocket | null = null;
  private connected = false;
  private qrPending = false;
  private phoneNumber = '';
  private reconnectAttempts = 0;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private knownGroups: Record<string, string> = {}; // jid → name
  private _lastQR: string | null = null;

  private get authDir(): string {
    const base = process.env.PHOTON_WHATSAPP_AUTHDIR
      || path.join(os.homedir(), '.photon', 'whatsapp-bridge', 'auth');
    fs.mkdirSync(base, { recursive: true });
    return base;
  }

  /**
   * Connect to WhatsApp. Shows QR code if authentication is needed,
   * then resolves once connected.
   */
  async *connect() {
    if (this.connected) {
      return { status: 'already_connected', phone: this.phoneNumber };
    }

    yield { emit: 'status', message: 'Fetching WhatsApp protocol version...' };

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();

    yield { emit: 'status', message: 'Initializing socket...' };

    // Promise that resolves on first meaningful event: QR, open, or close
    let resolveOutcome!: (value: { type: 'qr'; code: string } | { type: 'open' } | { type: 'error'; reason: string }) => void;
    const outcome = new Promise<{ type: 'qr'; code: string } | { type: 'open' } | { type: 'error'; reason: string }>(
      resolve => { resolveOutcome = resolve; },
    );

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

    // One-shot listener for this connect flow
    const onUpdate = (update: any) => {
      if (update.qr) resolveOutcome({ type: 'qr', code: update.qr });
      else if (update.connection === 'open') resolveOutcome({ type: 'open' });
      else if (update.connection === 'close') {
        const reason = (update.lastDisconnect?.error as any)?.output?.statusCode;
        resolveOutcome({ type: 'error', reason: String(reason || 'unknown') });
      }
    };
    this.sock.ev.on('connection.update', onUpdate);

    const first = await outcome;

    if (first.type === 'error') {
      throw new Error(`Connection failed: ${first.reason}`);
    }

    if (first.type === 'qr') {
      this.qrPending = true;
      this._lastQR = first.code;
      yield { emit: 'qr', value: first.code, message: 'Scan with WhatsApp → Linked Devices → Link a Device' };

      yield { emit: 'status', message: 'Waiting for QR scan...' };
      const connected = await new Promise<boolean>(resolve => {
        const timeout = setTimeout(() => resolve(false), 120_000);
        const handler = (update: any) => {
          if (update.connection === 'open') {
            clearTimeout(timeout);
            this.sock?.ev.off('connection.update', handler);
            resolve(true);
          } else if (update.connection === 'close') {
            clearTimeout(timeout);
            this.sock?.ev.off('connection.update', handler);
            resolve(false);
          }
        };
        this.sock?.ev.on('connection.update', handler);
      });

      if (!connected) {
        throw new Error('QR scan timed out or connection failed');
      }
    }

    yield { emit: 'toast', message: 'WhatsApp connected!', type: 'success' };
    return { status: 'connected', phone: this.phoneNumber };
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
   * @format json
   */
  async status(): Promise<{
    status: 'connected' | 'disconnected' | 'qr_pending';
    phone: string;
    queuedMessages: number;
    reconnectAttempts: number;
  }> {
    return {
      status: this.connected ? 'connected' : this.qrPending ? 'qr_pending' : 'disconnected',
      phone: this.phoneNumber,
      queuedMessages: this.outgoingQueue.length,
      reconnectAttempts: this.reconnectAttempts,
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
        const shouldReconnect = reason !== DisconnectReason.loggedOut;

        this.emit({ type: 'disconnected', reason });

        if (shouldReconnect) {
          this.reconnectAttempts++;
          const delay = Math.min(1000 * 2 ** Math.min(this.reconnectAttempts - 1, 6), 120_000);
          setTimeout(() => this._reconnect().catch(() => {}), delay);
        }
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

        // Emit inbound message for message-router to consume
        this.emit({
          type: 'message',
          chatJid,
          message: {
            id: msg.key.id || '',
            chatJid,
            sender,
            senderName,
            content,
            timestamp,
            fromMe,
          },
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
