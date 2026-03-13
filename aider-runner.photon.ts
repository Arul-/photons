import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { Photon } from '@portel/photon-core';

/**
 * Aider Runner — executes Aider AI coding assistant per group folder.
 *
 * Spawns `aider --message` as a subprocess in the group folder for
 * targeted code edits and refactoring tasks. Injects conversation
 * memory from previous runs. Manages concurrency across groups.
 *
 * @version 1.0.0
 * @icon 🔧
 * @tags agent, aider, runner
 * @stateful
 */
export default class AiderRunner extends Photon {
  private activeRuns = new Map<string, RunState>();
  private queue: QueuedRun[] = [];

  protected settings = {
    /** Base directory for group folders. Each group gets a subfolder here. */
    baseDir: path.join(os.homedir(), 'Projects'),
    /** Maximum concurrent agent runs */
    maxConcurrent: 2,
    /** AI model to use (empty = aider default) */
    model: '',
    /** Edit format for aider (empty = aider default, e.g. 'diff', 'whole') */
    editFormat: '',
    /** Whether aider should auto-commit changes */
    autoCommit: false,
    /** Number of past conversations to keep per group for memory injection */
    conversationHistorySize: 50,
  };

  /**
   * Run a coding task against a group's context using Aider.
   * Returns the agent's text response.
   *
   * @title Run Agent
   * @openWorld
   * @param groupFolder Group folder name {@example "dev-team"}
   * @param prompt The coding task to send to Aider {@example "Refactor the auth module"}
   * @param chatJid Chat JID for result routing (passed through in events)
   * @param systemPrompt Optional system context prepended to the prompt
   * @param agent Agent name (ignored — satisfies router contract)
   */
  async run(params: {
    groupFolder: string;
    prompt: string;
    chatJid?: string;
    sessionId?: string;
    systemPrompt?: string;
    addDirs?: string[];
    agent?: string;
  }): Promise<RunResult> {
    const { groupFolder, prompt, chatJid, systemPrompt } = params;

    const groupDir = this._ensureGroupDir(groupFolder);

    if (this.activeRuns.size >= this.settings.maxConcurrent) {
      return new Promise((resolve, reject) => {
        this.queue.push({ params, resolve, reject });
        this.emit({
          type: 'queued',
          groupFolder,
          position: this.queue.length,
          activeCount: this.activeRuns.size,
        });
      });
    }

    return this._execute(groupDir, groupFolder, prompt, chatJid, systemPrompt);
  }

  /**
   * Check what's currently running and queued.
   *
   * @title Status
   * @readOnly
   * @closedWorld
   * @format card
   */
  async status(): Promise<{
    active: Array<{ groupFolder: string; startedAt: string; pid: number | null }>;
    queued: number;
    maxConcurrent: number;
  }> {
    return {
      active: Array.from(this.activeRuns.entries()).map(([folder, state]) => ({
        groupFolder: folder,
        startedAt: state.startedAt,
        pid: state.proc?.pid ?? null,
      })),
      queued: this.queue.length,
      maxConcurrent: this.settings.maxConcurrent,
    };
  }

  /**
   * Kill a running agent for a group.
   *
   * @title Kill Agent
   * @destructive
   * @closedWorld
   * @param groupFolder Group folder to kill
   */
  async kill(params: { groupFolder: string }): Promise<void> {
    const state = this.activeRuns.get(params.groupFolder);
    if (!state?.proc) throw new Error(`No active run for group: ${params.groupFolder}`);

    state.proc.kill('SIGTERM');
    setTimeout(() => {
      if (state.proc && !state.proc.killed) {
        state.proc.kill('SIGKILL');
      }
    }, 5000);
  }

  /**
   * List all group folders managed by this runner.
   *
   * @title List Groups
   * @readOnly
   * @closedWorld
   * @format table
   */
  async groups(): Promise<Array<{ folder: string; hasClaudeMd: boolean; lastRun: string | null }>> {
    const baseDir = this.settings.baseDir;
    try {
      await fs.promises.access(baseDir);
    } catch {
      return [];
    }

    const entries = await fs.promises.readdir(baseDir, { withFileTypes: true });
    const results = await Promise.all(
      entries.filter(d => d.isDirectory()).map(async d => {
        const claudeMd = path.join(baseDir, d.name, 'CLAUDE.md');
        const logsDir = path.join(baseDir, d.name, 'logs');
        let lastRun: string | null = null;
        try {
          const logs = (await fs.promises.readdir(logsDir)).sort().reverse();
          if (logs.length > 0) {
            const stat = await fs.promises.stat(path.join(logsDir, logs[0]));
            lastRun = stat.mtime.toISOString();
          }
        } catch { /* no logs dir yet */ }
        let hasClaudeMd = false;
        try { await fs.promises.access(claudeMd); hasClaudeMd = true; } catch { /* missing */ }
        return { folder: d.name, hasClaudeMd, lastRun };
      })
    );

    return results;
  }

  // ─── Internal ──────────────────────────────────────────────────

  private _ensureGroupDir(groupFolder: string): string {
    const groupDir = path.isAbsolute(groupFolder) ? groupFolder : path.join(this.settings.baseDir, groupFolder);
    fs.mkdirSync(groupDir, { recursive: true });
    fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

    const claudeMd = path.join(groupDir, 'CLAUDE.md');
    if (!fs.existsSync(claudeMd)) {
      const content = [
        `# ${groupFolder}`,
        '',
        'This is the memory file for this group. The agent will read this on every invocation.',
        'Add persistent context, rules, or preferences here.',
        '',
      ].join('\n');
      fs.promises.writeFile(claudeMd, content).catch(() => { /* non-fatal */ });
    }

    return groupDir;
  }

  private async _execute(
    groupDir: string,
    groupFolder: string,
    prompt: string,
    chatJid?: string,
    systemPrompt?: string,
  ): Promise<RunResult> {
    const startedAt = new Date().toISOString();
    const runState: RunState = { proc: null, startedAt };
    this.activeRuns.set(groupFolder, runState);

    this.emit({
      type: 'started',
      groupFolder,
      chatJid,
      activeCount: this.activeRuns.size,
    });

    try {
      // Always inject memory — aider has no native session continuity
      const memCtx = await this._buildMemoryContext(groupFolder, prompt);
      const promptWithMemory = memCtx ? `${memCtx}\n\n${prompt}` : prompt;

      const result = await this._spawnAider(groupDir, groupFolder, promptWithMemory, systemPrompt, runState);

      if (result.status === 'success' && result.output) {
        this._storeConversation(groupFolder, prompt, result.output).catch(() => { /* non-fatal */ });
      }

      const logFile = path.join(groupDir, 'logs', `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      fs.promises.writeFile(logFile, JSON.stringify({
        prompt: prompt.slice(0, 500),
        result: result.output?.slice(0, 1000),
        status: result.status,
        duration: result.duration,
        timestamp: startedAt,
      }, null, 2)).catch(() => { /* non-fatal */ });

      this.emit({
        type: 'completed',
        groupFolder,
        chatJid,
        status: result.status,
        duration: result.duration,
        outputLength: result.output?.length ?? 0,
      });

      return result;
    } catch (err: any) {
      const result: RunResult = {
        status: 'error',
        output: null,
        error: err.message,
        duration: Date.now() - new Date(startedAt).getTime(),
        groupFolder,
      };
      this.emit({ type: 'error', groupFolder, chatJid, error: err.message });
      return result;
    } finally {
      this.activeRuns.delete(groupFolder);
      this._drainQueue();
    }
  }

  private _spawnAider(
    groupDir: string,
    groupFolder: string,
    prompt: string,
    systemPrompt?: string,
    runState?: RunState,
  ): Promise<RunResult> {
    return new Promise((resolve) => {
      const startTime = Date.now();

      let fullPrompt = prompt;
      if (systemPrompt) {
        fullPrompt = `${systemPrompt}\n\n---\n\n${prompt}`;
      }

      const args = ['--message', fullPrompt, '--yes'];
      if (this.settings.model) {
        args.push('--model', this.settings.model);
      }
      if (this.settings.editFormat) {
        args.push('--edit-format', this.settings.editFormat);
      }
      args.push(this.settings.autoCommit ? '--auto-commits' : '--no-auto-commits');

      const proc = spawn('aider', args, {
        cwd: groupDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env as Record<string, string>,
      });

      if (runState) runState.proc = proc;

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });
      proc.stdin.end();

      proc.on('close', (code) => {
        const duration = Date.now() - startTime;
        if (code !== 0) {
          resolve({
            status: 'error',
            output: null,
            error: stderr.slice(-500) || `Exit code ${code}`,
            duration,
            groupFolder,
          });
          return;
        }
        resolve({
          status: 'success',
          output: stdout.trim(),
          duration,
          groupFolder,
        });
      });

      proc.on('error', (err) => {
        resolve({
          status: 'error',
          output: null,
          error: `Spawn failed: ${err.message}`,
          duration: Date.now() - startTime,
          groupFolder,
        });
      });
    });
  }

  private _drainQueue(): void {
    while (this.queue.length > 0 && this.activeRuns.size < this.settings.maxConcurrent) {
      const next = this.queue.shift()!;
      const { params, resolve, reject } = next;
      const groupDir = this._ensureGroupDir(params.groupFolder);
      this._execute(groupDir, params.groupFolder, params.prompt, params.chatJid, params.systemPrompt)
        .then(resolve).catch(reject);
    }
  }

  // ─── Conversation Memory ────────────────────────────────────────

  private _extractKeywords(text: string): string[] {
    const stopwords = new Set([
      'the','a','an','and','or','but','in','on','at','to','for','of','with',
      'is','are','was','were','be','been','being','have','has','had','do','does','did',
      'will','would','could','should','may','might','shall','can','need','must',
      'this','that','these','those','it','its','they','them','their','we','our',
      'you','your','what','which','who','how','when','where','why','all','any',
      'each','some','not','from','by','about','into','through','during','before',
      'after','above','below','just','also','more','very','so','if','then','than',
    ]);

    const words = text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3 && !stopwords.has(w));

    const freq: Record<string, number> = {};
    for (const w of words) freq[w] = (freq[w] || 0) + 1;

    return Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([w]) => w);
  }

  private async _storeConversation(groupFolder: string, prompt: string, response: string): Promise<void> {
    const key = `conv:${groupFolder}`;
    const history: ConversationEntry[] = (await this.memory.get<ConversationEntry[]>(key)) ?? [];
    history.push({
      prompt: prompt.slice(0, 500),
      response: response.slice(0, 1000),
      timestamp: new Date().toISOString(),
      keywords: this._extractKeywords(prompt + ' ' + response),
    });
    const max = this.settings.conversationHistorySize;
    if (history.length > max) history.splice(0, history.length - max);
    await this.memory.set(key, history);
  }

  private async _buildMemoryContext(groupFolder: string, currentPrompt: string): Promise<string> {
    const key = `conv:${groupFolder}`;
    const history: ConversationEntry[] = (await this.memory.get<ConversationEntry[]>(key)) ?? [];
    if (history.length === 0) return '';

    const recentCount = Math.min(3, history.length);
    const recentStart = history.length - recentCount;
    const recent = history.slice(recentStart);

    const currentKeywords = new Set(this._extractKeywords(currentPrompt));
    const relevant = history
      .slice(0, recentStart)
      .map(entry => ({ entry, score: entry.keywords.filter(k => currentKeywords.has(k)).length }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(({ entry }) => entry);

    const selected = [...relevant, ...recent];
    if (selected.length === 0) return '';

    const xml = selected
      .map(e =>
        `  <conversation timestamp="${e.timestamp}">\n    <prompt>${e.prompt}</prompt>\n    <response>${e.response}</response>\n  </conversation>`
      )
      .join('\n');

    return `<previous-conversations>\n${xml}\n</previous-conversations>`;
  }
}

// ─── Types ─────────────────────────────────────────────────────────

interface RunState {
  proc: ReturnType<typeof spawn> | null;
  startedAt: string;
}

interface QueuedRun {
  params: {
    groupFolder: string;
    prompt: string;
    chatJid?: string;
    sessionId?: string;
    systemPrompt?: string;
    addDirs?: string[];
    agent?: string;
  };
  resolve: (result: RunResult) => void;
  reject: (err: Error) => void;
}

interface RunResult {
  status: 'success' | 'error';
  output: string | null;
  error?: string;
  duration: number;
  groupFolder: string;
  sessionId?: string;
}

interface ConversationEntry {
  prompt: string;
  response: string;
  timestamp: string;
  keywords: string[];
}
