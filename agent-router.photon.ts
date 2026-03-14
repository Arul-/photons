import { Photon } from '@portel/photon-core';

/**
 * Agent Router — smart proxy that delegates to the right runner.
 *
 * Implements the same run() interface as individual runners. Routes
 * based on the explicit `agent` parameter, or auto-classifies the
 * prompt when autoClassify is enabled. Falls back to defaultAgent
 * when no agent is specified and autoClassify is off.
 *
 * @version 1.0.0
 * @icon 🔀
 * @tags agent, router, orchestrator
 * @stateful
 * @photon claude ./claude-runner.photon.ts
 * @photon gemini ./gemini-runner.photon.ts
 * @photon aider ./aider-runner.photon.ts
 * @photon opencode ./opencode-runner.photon.ts
 * @ui dashboard ./ui/dashboard.html
 */
export default class AgentRouter extends Photon {
  constructor(
    private claude: any,
    private gemini: any,
    private aider: any,
    private opencode: any,
  ) {
    super();
  }

  protected settings = {
    /** Default agent when none specified and auto-classification is disabled */
    defaultAgent: 'claude',
    /** Enable auto-classification of prompts to pick the best agent */
    autoClassify: false,
  };

  /**
   * Agent Router Dashboard — view all agent statuses and routing config.
   *
   * @title Agent Router
   * @ui dashboard
   * @readOnly
   * @closedWorld
   */
  async main(): Promise<{
    claude: any;
    gemini: any;
    aider: any;
    opencode: any;
    totalActive: number;
    totalQueued: number;
  }> {
    return this.status();
  }

  /**
   * Route a prompt to the appropriate agent runner.
   * Uses the explicit `agent` param, auto-classifies if enabled,
   * or falls back to the defaultAgent setting.
   *
   * @title Run Agent
   * @openWorld
   * @param groupFolder Group folder name {@example "dev-team"}
   * @param prompt The prompt to route {@example "Refactor the auth module"}
   * @param agent Explicit agent ('claude'|'gemini'|'aider'|'opencode'|'auto') {@example "claude"}
   * @param chatJid Chat JID for result routing (passed through)
   * @param sessionId Session ID for conversation continuity (Claude only)
   * @param systemPrompt Optional system context
   * @param addDirs Additional directories to expose
   */
  async run(params: {
    groupFolder: string;
    prompt: string;
    agent?: string;
    chatJid?: string;
    sessionId?: string;
    systemPrompt?: string;
    addDirs?: string[];
  }): Promise<RunResult> {
    const agentName = params.agent || this.settings.defaultAgent;

    if (agentName !== 'auto') {
      return this._delegate(agentName, params);
    }

    if (this.settings.autoClassify) {
      const classified = await this._classify(params.prompt);
      this.emit({ type: 'classified', prompt: params.prompt.slice(0, 100), agent: classified });
      return this._delegate(classified, params);
    }

    return this._delegate(this.settings.defaultAgent, params);
  }

  /**
   * Aggregate status from all runners.
   *
   * @title Status
   * @readOnly
   * @closedWorld
   */
  async status(): Promise<{
    claude: any;
    gemini: any;
    aider: any;
    opencode: any;
    totalActive: number;
    totalQueued: number;
  }> {
    const [c, g, a, o] = await Promise.all([
      this.claude.status().catch(() => ({ active: [], queued: 0 })),
      this.gemini.status().catch(() => ({ active: [], queued: 0 })),
      this.aider.status().catch(() => ({ active: [], queued: 0 })),
      this.opencode.status().catch(() => ({ active: [], queued: 0 })),
    ]);
    return {
      claude: c,
      gemini: g,
      aider: a,
      opencode: o,
      totalActive: [...(c.active ?? []), ...(g.active ?? []), ...(a.active ?? []), ...(o.active ?? [])].length,
      totalQueued: (c.queued ?? 0) + (g.queued ?? 0) + (a.queued ?? 0) + (o.queued ?? 0),
    };
  }

  /**
   * Kill a running agent — tries each runner until the group is found.
   *
   * @title Kill Agent
   * @destructive
   * @closedWorld
   * @param groupFolder Group folder to kill
   */
  async kill(params: { groupFolder: string }): Promise<void> {
    for (const runner of [this.claude, this.gemini, this.aider, this.opencode]) {
      try {
        await runner.kill(params);
        return;
      } catch { /* not in this runner, try next */ }
    }
    throw new Error(`No active run for group: ${params.groupFolder}`);
  }

  /**
   * Union of all runners' group folders (deduped by folder name).
   *
   * @title List Groups
   * @readOnly
   * @closedWorld
   * @format table
   */
  async groups(): Promise<Array<{ folder: string; hasClaudeMd: boolean; lastRun: string | null }>> {
    const [c, g, a, o] = await Promise.all([
      this.claude.groups().catch(() => [] as any[]),
      this.gemini.groups().catch(() => [] as any[]),
      this.aider.groups().catch(() => [] as any[]),
      this.opencode.groups().catch(() => [] as any[]),
    ]);

    const seen = new Map<string, any>();
    for (const entry of [...c, ...g, ...a, ...o]) {
      const existing = seen.get(entry.folder);
      if (!existing || (entry.lastRun && (!existing.lastRun || entry.lastRun > existing.lastRun))) {
        seen.set(entry.folder, entry);
      }
    }
    return Array.from(seen.values());
  }

  // ─── Internal ──────────────────────────────────────────────────

  private _delegate(agent: string, params: any): Promise<RunResult> {
    const runners: Record<string, any> = {
      claude: this.claude,
      gemini: this.gemini,
      aider: this.aider,
      opencode: this.opencode,
    };
    const runner = runners[agent] ?? this.claude;
    return runner.run(params);
  }

  private async _classify(prompt: string): Promise<string> {
    const classifyPrompt = `Classify this task. Reply with ONLY one word: claude, gemini, aider, or opencode.
- claude: general coding, debugging, complex reasoning, file editing
- gemini: research, broad knowledge questions, large context analysis
- aider: targeted code edits to specific files, refactoring
- opencode: general coding with non-Anthropic models

Task: ${prompt.slice(0, 300)}`;

    const result = await this.claude.run({
      groupFolder: '_router',
      prompt: classifyPrompt,
    });

    const agent = result.output?.trim().toLowerCase() ?? '';
    const valid = ['claude', 'gemini', 'aider', 'opencode'];
    return valid.includes(agent) ? agent : 'claude';
  }
}

// ─── Types ─────────────────────────────────────────────────────────

interface RunResult {
  status: 'success' | 'error';
  output: string | null;
  error?: string;
  duration: number;
  groupFolder: string;
  sessionId?: string;
}
