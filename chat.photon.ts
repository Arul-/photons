import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { Photon } from '@portel/photon-core';

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff']);
const PASSTHROUGH_EXTS = new Set(['.pdf', '.txt', '.md', '.csv', '.json', '.xml', '.html', '.log']);

/**
 * Chat — browser-based messaging channel for testing claw pipelines.
 *
 * Wire-compatible with WhatsApp/Telegram channel interface.
 * Each group = separate instance (auto-persisted by @stateful).
 * Default instance acts as router.
 *
 * @version 1.0.0
 * @icon 💬
 * @tags channel, chat, testing
 * @dependencies sharp
 * @stateful
 * @noworker
 * @ui chat ./chat/ui/chat.html
 */
export default class Chat extends Photon {
  /** Group name — set when instance is created. */
  name = '';
  /** Messages — auto-persisted per instance by @stateful. */
  messages: Message[] = [];

  protected settings = { defaultGroup: 'General' };

  /** In-memory index: lowercase group name → instance name. Rebuilt on connect, updated on create. */
  private _nameIndex = new Map<string, string>();
  /** Tracks which instance names have had handlers registered via on(). */
  private _handlerInstances = new Set<string>();

  /** @title Connect */
  async connect() {
    await this._rebuildIndex();
    if (this._nameIndex.size === 0) await this._createGroup(this.settings.defaultGroup);
    return { status: 'connected', message: 'Chat channel ready' };
  }

  /** @title Status @readOnly */
  async status() {
    return { status: 'connected', groups: this._nameIndex.size };
  }

  /** @title Groups @readOnly */
  async groups() {
    const result: { name: string; chatId: string }[] = [];
    for (const [, instName] of this._nameIndex) {
      result.push({ name: instName, chatId: instName });
    }
    return result;
  }

  /** @title Create Group @param name Group name */
  async create(params: { name: string }) {
    await this._createGroup(params.name);
    return { id: params.name, name: params.name };
  }

  /** @title Send @param chat Group name or ID @param text Message text */
  async send(params: { chat: string; text: string }) {
    const target = await this._target(params.chat);
    const msg = this._msg(params.text, 'Agent', true);
    target.messages.push(msg);
    return { queued: false, messageId: msg.id };
  }

  /**
   * Inject a user message — fires to claw subscribers.
   * @title Say
   * @param chat Group name or ID
   * @param text Message text
   * @param sender Sender name {@default "User"}
   * @param attachments File paths (images, PDFs, text files — max 5)
   * @audience user
   */
  async say(params: { chat: string; text: string; sender?: string; attachments?: string[] }) {
    const target = await this._target(params.chat);
    const files = (params.attachments || []).slice(0, 5);

    // Copy to our storage + compress images (never modify source files)
    const processed = await this._processAttachments(files);
    const type = this._detectType(processed);

    const msg = this._msg(
      params.text || (processed.length ? `[${type}]` : ''),
      params.sender || 'User', false, type,
      processed.length ? { mimetype: this._guessMime(processed[0]) } : undefined,
      processed,
    );
    target.messages.push(msg);
    this._fire(target, params.chat, {
      messageId: msg.id, sender: msg.sender, senderName: msg.senderName,
      content: msg.content, fromMe: false, timestamp: msg.timestamp,
      type: msg.type,
      ...(msg.filePath ? { filePath: msg.filePath } : {}),
      ...(msg.media ? { media: msg.media } : {}),
      ...(msg.attachments ? { images: msg.attachments } : {}),
    }, target.name);
    return { delivered: true, messageId: msg.id, files: processed.length };
  }

  /** @title Messages @readOnly @audience user @param chat Group name or ID @param limit {@default 50} */
  async messages(params: { chat: string; limit?: number }) {
    const target = await this._target(params.chat);
    return target.messages.slice(-(params.limit || 50));
  }

  /**
   * Subscribe to messages — routes handler to the target group's instance.
   * @internal
   */
  async on(event: string, fn: (data: any) => void, filter?: any) {
    if (filter?.group) {
      const instName = this._resolveInstanceName(filter.group);
      const target = await (this as any).instance(instName);
      target._eventListeners.push({ event, fn, filter });
      this._handlerInstances.add(instName);
    } else {
      (this as any)._eventListeners?.push({ event, fn, filter });
    }
  }

  /**
   * Unsubscribe — searches router and all group instances that have handlers.
   * @internal
   */
  async off(event: string, fn: (data: any) => void) {
    const selfListeners = (this as any)._eventListeners;
    if (selfListeners) {
      const idx = selfListeners.findIndex((e: any) => e.event === event && e.fn === fn);
      if (idx !== -1) { selfListeners.splice(idx, 1); return; }
    }
    for (const instName of this._handlerInstances) {
      try {
        const inst = await (this as any).instance(instName);
        const listeners = inst._eventListeners;
        if (!listeners) continue;
        const idx = listeners.findIndex((e: any) => e.event === event && e.fn === fn);
        if (idx !== -1) { listeners.splice(idx, 1); return; }
      } catch { /* instance may have been removed */ }
    }
  }

  /** @title Edit @internal */
  async edit(params: { chat: string; messageId: string; text: string }) {
    const target = await this._target(params.chat);
    const msg = target.messages.find((m: Message) => m.id === params.messageId);
    if (msg) { msg.content = params.text; msg.editedAt = new Date().toISOString(); }
  }

  /** @internal */ async typing() {}
  /** @internal */ async media(params: { chat: string; url: string; type: string; caption?: string }) {
    const target = await this._target(params.chat);
    const msg = this._msg(params.caption || `[${params.type}]`, 'Agent', true);
    target.messages.push(msg);
    return { messageId: msg.id };
  }

  // ─── Private ───

  private async _rebuildIndex(): Promise<void> {
    this._nameIndex.clear();
    for await (const entry of this.allInstances()) {
      if (entry.name === 'default' || !entry.state?.name) continue;
      this._nameIndex.set(entry.state.name.toLowerCase(), entry.name);
    }
  }

  private async _createGroup(name: string): Promise<void> {
    const inst = await (this as any).instance(name);
    inst.name = name;
    this._nameIndex.set(name.toLowerCase(), name);
    this.emit({ type: 'group_created', name, id: name });
  }

  private _resolveInstanceName(nameOrId: string): string {
    const lower = nameOrId.toLowerCase();
    if (this._nameIndex.has(lower)) return this._nameIndex.get(lower)!;
    for (const instName of this._nameIndex.values()) {
      if (instName === nameOrId) return instName;
    }
    for (const [name, instName] of this._nameIndex) {
      if (name.includes(lower)) return instName;
    }
    return nameOrId;
  }

  private async _target(nameOrId: string): Promise<any> {
    const instName = this._resolveInstanceName(nameOrId);
    if (!this._nameIndex.has(instName.toLowerCase())) {
      await this._rebuildIndex();
      const retry = this._resolveInstanceName(nameOrId);
      if (!this._nameIndex.has(retry.toLowerCase())) {
        throw new Error(`Group not found: ${nameOrId}`);
      }
      return (this as any).instance(retry);
    }
    return (this as any).instance(instName);
  }

  /**
   * Copy files to our storage dir, compressing images.
   * Never modifies source files — always works on copies.
   */
  private async _processAttachments(paths: string[]): Promise<string[]> {
    const storageDir = this.storage('attachments');
    if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });

    const results: string[] = [];
    for (const src of paths) {
      if (!fs.existsSync(src)) continue;
      const ext = path.extname(src).toLowerCase();
      const basename = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

      if (IMAGE_EXTS.has(ext)) {
        // Copy + compress image
        const destPath = path.join(storageDir, `${basename}.jpg`);
        try {
          const stat = fs.statSync(src);
          if (stat.size < 512 * 1024) {
            // Small image — just copy as-is
            const copyPath = path.join(storageDir, `${basename}${ext}`);
            await fs.promises.copyFile(src, copyPath);
            results.push(copyPath);
          } else {
            // Compress: resize to max 2048px, JPEG quality 80
            const compressed = await sharp(src)
              .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: 80 })
              .toBuffer();
            await fs.promises.writeFile(destPath, compressed);
            results.push(destPath);
          }
        } catch {
          // Compression failed — copy original
          const copyPath = path.join(storageDir, `${basename}${ext}`);
          await fs.promises.copyFile(src, copyPath);
          results.push(copyPath);
        }
      } else if (PASSTHROUGH_EXTS.has(ext)) {
        // Copy text/PDF files as-is
        const destPath = path.join(storageDir, `${basename}${ext}`);
        await fs.promises.copyFile(src, destPath);
        results.push(destPath);
      }
      // Unsupported extensions are silently skipped
    }
    return results;
  }

  /** Detect the primary attachment type from processed file paths. */
  private _detectType(paths: string[]): string {
    if (!paths.length) return 'text';
    const ext = path.extname(paths[0]).toLowerCase();
    if (IMAGE_EXTS.has(ext) || ext === '.jpg') return 'image';
    if (ext === '.pdf') return 'document';
    return 'document';
  }

  /** Guess MIME type from file extension. */
  private _guessMime(filePath: string): string {
    const map: Record<string, string> = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
      '.webp': 'image/webp', '.gif': 'image/gif', '.pdf': 'application/pdf',
      '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
      '.json': 'application/json', '.xml': 'application/xml', '.html': 'text/html',
    };
    return map[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  }

  /** Dispatch to target instance's event listeners. */
  private _fire(target: any, chatId: string, message: any, groupName?: string) {
    if (target._dispatch) {
      target._dispatch(chatId, message, groupName);
    } else {
      this._dispatch(chatId, message, groupName);
    }
  }

  private _msg(
    text: string, sender: string, fromMe: boolean,
    type: string = 'text', media?: Message['media'], attachments?: string[],
  ): Message {
    return {
      id: `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      sender: sender.toLowerCase().replace(/\s+/g, '_'),
      senderName: sender, content: text, timestamp: new Date().toISOString(), fromMe, type,
      ...(media ? { media } : {}),
      ...(attachments?.length ? { filePath: attachments[0], attachments } : {}),
    };
  }
}

interface Message {
  id: string; sender: string; senderName: string; content: string;
  timestamp: string; fromMe: boolean; type: string;
  media?: { mimetype?: string; caption?: string }; editedAt?: string;
  filePath?: string; attachments?: string[];
}
