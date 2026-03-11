import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { Photon } from '@portel/photon-core';

/**
 * Agent Runner — executes Claude agents locally per WhatsApp group.
 *
 * Each group gets an isolated working directory with its own CLAUDE.md
 * for persistent memory. Spawns `claude -p` as a subprocess with the
 * group folder as cwd. Manages concurrency so multiple groups don't
 * overwhelm the system.
 *
 * @version 1.0.0
 * @icon 🤖
 * @tags agent, claude, runner, nanoclaw
 * @stateful
 */
export default class AgentRunner extends Photon {
  private activeRuns = new Map<string, RunState>();
  private queue: QueuedRun[] = [];
  private baseDir = '';

  protected settings = {
    /** Base directory for group folders. Each group gets a subfolder here. */
    baseDir: path.join(os.homedir(), 'Projects'),
    /** Maximum concurrent agent runs */
    maxConcurrent: 3,
    /** Comma-separated whitelist of tools Claude can use (empty = all tools) */
    allowedTools: '',
    /** Claude model to use (e.g. sonnet, opus, haiku) */
    model: '',
  };

  async onInitialize(): Promise<void> {
    this.baseDir = this.settings.baseDir;
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  /**
   * Run a prompt against a group's context using Claude.
   * Returns the agent's text response.
   * @param groupFolder Group folder name {@example "dev-team"}
   * @param prompt The prompt to send to Claude {@example "Summarise the discussion"}
   * @param chatJid Chat JID for result routing (passed through in events)
   * @param sessionId Optional session ID for conversation continuity
   * @param systemPrompt Optional extra system context prepended to the group's CLAUDE.md
   */
  async run(params: {
    groupFolder: string;
    prompt: string;
    chatJid?: string;
    sessionId?: string;
    systemPrompt?: string;
  }): Promise<RunResult> {
    const { groupFolder, prompt, chatJid, sessionId, systemPrompt } = params;

    // Ensure group directory exists with CLAUDE.md
    const groupDir = this._ensureGroupDir(groupFolder);

    // If at capacity, queue it
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

    return this._execute(groupDir, groupFolder, prompt, chatJid, sessionId, systemPrompt);
  }

  /**
   * Check what's currently running and queued.
   * @readOnly
   * @format json
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
   * @param groupFolder Group folder to kill
   */
  async kill(params: { groupFolder: string }): Promise<{ killed: boolean }> {
    const state = this.activeRuns.get(params.groupFolder);
    if (!state?.proc) return { killed: false };

    state.proc.kill('SIGTERM');
    // Give it 5s, then force kill
    setTimeout(() => {
      if (state.proc && !state.proc.killed) {
        state.proc.kill('SIGKILL');
      }
    }, 5000);

    return { killed: true };
  }

  /**
   * Set the maximum number of concurrent agent runs.
   * @param max Maximum concurrent runs {@example 5}
   */
  async concurrency(params: { max: number }): Promise<{ maxConcurrent: number }> {
    this.settings.maxConcurrent = Math.max(1, params.max);
    this._drainQueue();
    return { maxConcurrent: this.settings.maxConcurrent };
  }

  /**
   * List all group folders with their CLAUDE.md content summary.
   * @readOnly
   * @format table
   */
  async groups(): Promise<Array<{ folder: string; hasClaudeMd: boolean; lastRun: string | null }>> {
    if (!fs.existsSync(this.baseDir)) return [];

    const folders = fs.readdirSync(this.baseDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => {
        const claudeMd = path.join(this.baseDir, d.name, 'CLAUDE.md');
        const logsDir = path.join(this.baseDir, d.name, 'logs');
        let lastRun: string | null = null;
        if (fs.existsSync(logsDir)) {
          const logs = fs.readdirSync(logsDir).sort().reverse();
          if (logs.length > 0) {
            const stat = fs.statSync(path.join(logsDir, logs[0]));
            lastRun = stat.mtime.toISOString();
          }
        }
        return {
          folder: d.name,
          hasClaudeMd: fs.existsSync(claudeMd),
          lastRun,
        };
      });

    return folders;
  }

  // ─── Internal ──────────────────────────────────────────────────

  private _ensureGroupDir(groupFolder: string): string {
    const groupDir = path.join(this.baseDir, groupFolder);
    fs.mkdirSync(groupDir, { recursive: true });
    fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

    // Create CLAUDE.md if it doesn't exist
    const claudeMd = path.join(groupDir, 'CLAUDE.md');
    if (!fs.existsSync(claudeMd)) {
      fs.writeFileSync(claudeMd, [
        `# ${groupFolder}`,
        '',
        'This is the memory file for this group. The agent will read this on every invocation.',
        'Add persistent context, rules, or preferences here.',
        '',
      ].join('\n'));
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
      const result = await this._spawnClaude(groupDir, groupFolder, prompt, sessionId, systemPrompt, runState);

      // Log the run
      const logFile = path.join(groupDir, 'logs', `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      fs.writeFileSync(logFile, JSON.stringify({
        prompt: prompt.slice(0, 500),
        result: result.output?.slice(0, 1000),
        status: result.status,
        duration: result.duration,
        timestamp: startedAt,
      }, null, 2));

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
  ): Promise<RunResult> {
    return new Promise((resolve) => {
      const startTime = Date.now();

      // Build the full prompt with optional system context
      let fullPrompt = prompt;
      if (systemPrompt) {
        fullPrompt = `${systemPrompt}\n\n---\n\n${prompt}`;
      }

      const args = ['-p', fullPrompt, '--output-format', 'json'];
      if (this.settings.allowedTools) {
        args.push('--allowedTools', this.settings.allowedTools);
      }
      if (this.settings.model) {
        args.push('--model', this.settings.model);
      }
      if (sessionId) {
        args.push('--resume', sessionId);
      }

      const env: Record<string, string> = { ...process.env as Record<string, string> };
      // Remove CLAUDECODE to allow nested calls
      delete env.CLAUDECODE;

      const proc = spawn('claude', args, {
        cwd: groupDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });

      if (runState) runState.proc = proc;

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

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

        // Parse JSON output from claude -p --output-format json
        let output = stdout.trim();
        try {
          const parsed = JSON.parse(output);
          output = parsed.result || parsed.content || output;
          // Extract session ID for continuity
          const newSessionId = parsed.session_id || parsed.sessionId;
          resolve({
            status: 'success',
            output,
            duration,
            groupFolder,
            sessionId: newSessionId,
          });
        } catch {
          // Plain text fallback
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
      ).then(resolve).catch(reject);
    }
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
