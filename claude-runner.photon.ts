import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { Photon } from '@portel/photon-core';

/**
 * Claude Runner — executes Claude agents locally per group folder.
 *
 * Each group gets an isolated working directory with its own CLAUDE.md
 * for persistent memory. Spawns `claude -p` as a subprocess with the
 * group folder as cwd. Manages concurrency so multiple groups don't
 * overwhelm the system. Includes conversation memory injection for
 * groups without a live session.
 *
 * @version 1.0.0
 * @icon 🤖
 * @tags agent, claude, runner
 * @stateful
 */
export default class ClaudeRunner extends Photon {
  private activeRuns = new Map<string, RunState>();
  private queue: QueuedRun[] = [];

  protected settings = {
    /** Base directory for group folders. Each group gets a subfolder here. */
    baseDir: path.join(os.homedir(), 'Projects'),
    /** Maximum concurrent agent runs */
    maxConcurrent: 3,
    /** Comma-separated whitelist of tools Claude can use (empty = all tools) */
    allowedTools: '',
    /** Claude model to use (e.g. sonnet, opus, haiku) */
    model: '',
    /** Additional directories Claude can access (comma-separated) */
    addDirs: '',
    /** Number of past conversations to keep per group for memory injection */
    conversationHistorySize: 50,
  };

  /**
   * Run a prompt against a group's context using Claude.
   * Returns the agent's text response.
   *
   * @title Run Agent
   * @openWorld
   * @param groupFolder Group folder name {@example "dev-team"}
   * @param prompt The prompt to send to Claude {@example "Summarise the discussion"}
   * @param chatJid Chat JID for result routing (passed through in events)
   * @param sessionId Optional session ID for conversation continuity
   * @param systemPrompt Optional extra system context prepended to the group's CLAUDE.md
   * @param addDirs Additional directories Claude can access (e.g. media download dirs)
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
    const { groupFolder, prompt, chatJid, sessionId, systemPrompt } = params;

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

    return this._execute(groupDir, groupFolder, prompt, chatJid, sessionId, systemPrompt, params.addDirs);
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
   * List all group folders with their CLAUDE.md content summary.
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
    sessionId?: string,
    systemPrompt?: string,
    addDirs?: string[],
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
      // Build memory context once — used if no session or if session is stale
      const memCtx = sessionId ? '' : await this._buildMemoryContext(groupFolder, prompt);
      const promptWithMemory = memCtx ? `${memCtx}\n\n${prompt}` : prompt;

      let result = await this._spawnClaude(groupDir, groupFolder, promptWithMemory, sessionId, systemPrompt, runState, addDirs);

      // If resume failed (stale session), retry with memory-injected prompt
      if (result.status === 'error' && sessionId && result.error?.includes('No conversation found')) {
        const retryPrompt = memCtx ? `${memCtx}\n\n${prompt}` : prompt;
        result = await this._spawnClaude(groupDir, groupFolder, retryPrompt, undefined, systemPrompt, runState, addDirs);
      }

      // Store conversation for future memory injection (awaited so next call sees it)
      if (result.status === 'success' && result.output) {
        await this._storeConversation(groupFolder, prompt, result.output).catch(() => { /* non-fatal */ });
      }

      const logFile = path.join(groupDir, 'logs', `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      fs.promises.writeFile(logFile, JSON.stringify({
        prompt: prompt.slice(0, 500),
        result: result.output?.slice(0, 1000),
        status: result.status,
        duration: result.duration,
        timestamp: startedAt,
      }, null, 2)).catch(() => { /* log failure is non-fatal */ });

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

      this.emit({
        type: 'error',
        groupFolder,
        chatJid,
        error: err.message,
      });

      return result;
    } finally {
      this.activeRuns.delete(groupFolder);
      this._drainQueue();
    }
  }

  private _spawnClaude(
    groupDir: string,
    groupFolder: string,
    prompt: string,
    sessionId?: string,
    systemPrompt?: string,
    runState?: RunState,
    addDirs?: string[],
  ): Promise<RunResult> {
    return new Promise((resolve) => {
      const startTime = Date.now();

      let fullPrompt = prompt;
      if (systemPrompt) {
        fullPrompt = `${systemPrompt}\n\n---\n\n${prompt}`;
      }

      const args = ['-p', fullPrompt, '--output-format', 'json'];
      args.push('--dangerously-skip-permissions');
      if (this.settings.allowedTools) {
        args.push('--allowedTools', this.settings.allowedTools);
      }
      if (this.settings.model) {
        args.push('--model', this.settings.model);
      }
      if (this.settings.addDirs) {
        for (const dir of this.settings.addDirs.split(',').map(d => d.trim()).filter(Boolean)) {
          args.push('--add-dir', dir);
        }
      }
      if (addDirs) {
        for (const dir of addDirs) {
          const resolved = path.isAbsolute(dir) ? dir : path.join(this.settings.baseDir, dir);
          args.push('--add-dir', resolved);
        }
      }
      if (sessionId) {
        args.push('--resume', sessionId);
      }

      const env: Record<string, string> = { ...process.env as Record<string, string> };
      delete env.CLAUDECODE;

      const proc = spawn('claude', args, {
        cwd: groupDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
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

        let output = stdout.trim();
        try {
          const parsed = JSON.parse(output);
          output = parsed.result || parsed.content || output;
          const newSessionId = parsed.session_id || parsed.sessionId;
          resolve({
            status: 'success',
            output,
            duration,
            groupFolder,
            sessionId: newSessionId,
          });
        } catch {
          resolve({
            status: 'success',
            output,
            duration,
            groupFolder,
          });
        }
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
      this._execute(
        groupDir,
        params.groupFolder,
        params.prompt,
        params.chatJid,
        params.sessionId,
        params.systemPrompt,
        params.addDirs,
      ).then(resolve).catch(reject);
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

    // Recency: last 3 entries always included
    const recentCount = Math.min(3, history.length);
    const recentStart = history.length - recentCount;
    const recent = history.slice(recentStart);

    // Relevance: score earlier entries by keyword overlap, take top 3
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
