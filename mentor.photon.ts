import fs from 'fs';
import path from 'path';

import { Photon } from '@portel/photon-core';

/**
 * Mentor — reviews agent journals, evolves personas, manages skills.
 *
 * The "3am agent" that makes other agents better over time. Reads an agent's
 * journal entries, conversation history, and current persona, then proposes
 * improvements. All changes are git-committed for auditability.
 *
 * Can be triggered by: cron schedule, manual invocation, conversation threshold,
 * or skill gap detection.
 *
 * @version 1.0.0
 * @icon 🧙
 * @tags mentor, evolution, persona, memory, skills
 * @stateful
 * @photon router agent-router
 */
export default class Mentor extends Photon {
  constructor(private router: any) {
    super();
  }

  protected settings = {
    /** Base directory for agent data */
    agentsDir: path.join(process.env.HOME || '', '.photon', 'data', 'claw', 'agents'),
    /** Default LLM agent for analysis */
    agent: 'claude',
    /** Max conversations before auto-compact triggers */
    compactThreshold: 20,
    /** Max conversation entries to keep after compaction */
    maxConversations: 3,
  };

  // ─── Public Methods ─────────────────────────────────────────────

  /**
   * List all agents with their current state.
   *
   * @title List Agents
   * @format table
   */
  async agents(): Promise<Array<{ name: string; conversations: number; journalToday: number; proposals: number; personaSize: number }>> {
    const agentsDir = this.settings.agentsDir;
    if (!fs.existsSync(agentsDir)) return [];

    const dirs = fs.readdirSync(agentsDir).filter(d => {
      const full = path.join(agentsDir, d);
      return fs.statSync(full).isDirectory() && !d.startsWith('.');
    });

    return dirs.map(name => {
      const dir = path.join(agentsDir, name);
      const convCount = this._countConversations(dir);
      const journalCount = this._countTodayJournal(dir);
      const proposalCount = this._countProposals(dir);
      const personaSize = this._fileSize(path.join(dir, 'persona.md'));
      return { name, conversations: convCount, journalToday: journalCount, proposals: proposalCount, personaSize };
    });
  }

  /**
   * Full mentor review: analyze journal + conversations, propose persona/skill changes.
   *
   * @title Review Agent
   * @param agent Agent directory name {@example "arul_and_lura"}
   */
  async review(params: { agent: string }): Promise<{ journalEntries: number; proposalsCreated: number; compacted: boolean }> {
    const agentDir = this._resolveAgent(params.agent);
    const name = path.basename(agentDir);

    // 1. Read current state
    const persona = this._readFile(path.join(agentDir, 'persona.md'));
    const journal = this._readRecentJournal(agentDir, 7); // last 7 days
    const memory = this._readMemoryBuckets(agentDir);
    const conversations = this._readFile(path.join(agentDir, 'memory', 'conversation.md'));

    if (!journal.length && !conversations.trim()) {
      return { journalEntries: 0, proposalsCreated: 0, compacted: false };
    }

    // 2. Compact if needed
    const convCount = this._countConversations(agentDir);
    let compacted = false;
    if (convCount > this.settings.compactThreshold) {
      await this.compact({ agent: params.agent });
      compacted = true;
    }

    // 3. Analyze journal + conversations for persona improvements
    const journalBlock = journal.map(e =>
      `[${e.timestamp}] User: "${e.userMessage}" → Agent thought: "${e.thought}"`
    ).join('\n');

    if (!journalBlock && !conversations.trim()) {
      return { journalEntries: journal.length, proposalsCreated: 0, compacted };
    }

    const analysisPrompt = `You are a mentor analyzing an AI agent's performance. Review the agent's journal (inner thoughts) and recent conversations, then propose specific improvements.

CURRENT PERSONA:
${persona || '(no persona defined)'}

EXISTING MEMORY:
${memory}

JOURNAL ENTRIES (agent's inner thoughts from recent interactions):
${journalBlock || '(no journal entries)'}

RECENT CONVERSATIONS:
${conversations || '(no recent conversations)'}

INSTRUCTIONS:
Analyze the above and identify concrete improvements. For each, create a proposal in this format:

<proposal name="short-descriptive-name" type="persona|skill|memory">
<reason>Why this change is needed — cite specific journal entries or conversations</reason>
<change>The exact change to make (for persona: the text to add/modify; for skill: the skill name; for memory: the fact to add)</change>
<auto>true|false</auto>
</proposal>

Types:
- persona: Changes to the agent's personality, style, knowledge, or behavior
- skill: Skills the agent needs but doesn't have
- memory: Facts that should be in memory but aren't

Set auto=true for low-risk style tweaks. Set auto=false for skill additions or significant persona changes.

If there are no improvements to suggest, respond with: <no-proposals/>

Be specific and actionable. Do not propose vague improvements.`;

    const result = await this.router.run({
      groupFolder: '_mentor-review',
      prompt: analysisPrompt,
      agent: this.settings.agent,
    });

    if (result.status !== 'success' || !result.output) {
      this.emit({ type: 'review_failed', agent: name, error: result.error || 'no output' });
      return { journalEntries: journal.length, proposalsCreated: 0, compacted };
    }

    // 4. Parse and save proposals
    const proposals = this._parseProposals(result.output);
    let created = 0;

    for (const proposal of proposals) {
      if (proposal.auto) {
        // Auto-apply low-risk changes
        await this._applyProposal(agentDir, proposal);
        this.emit({ type: 'auto_applied', agent: name, proposal: proposal.name, proposalType: proposal.type });
      } else {
        // Save for user approval
        this._saveProposal(agentDir, proposal);
        created++;
        this.emit({ type: 'proposal_created', agent: name, proposal: proposal.name, proposalType: proposal.type });
      }
    }

    this._gitCommit(agentDir, `review: analyzed ${journal.length} journal entries, ${created} proposals created`);

    return { journalEntries: journal.length, proposalsCreated: created, compacted };
  }

  /**
   * Compact conversation history into bucketed memory files.
   *
   * @title Compact Memory
   * @param agent Agent directory name {@example "arul_and_lura"}
   */
  async compact(params: { agent: string }): Promise<{ compacted: number; decisions: number; preferences: number; rules: number }> {
    const agentDir = this._resolveAgent(params.agent);
    const name = path.basename(agentDir);
    const memoryDir = path.join(agentDir, 'memory');

    if (!fs.existsSync(memoryDir)) {
      return { compacted: 0, decisions: 0, preferences: 0, rules: 0 };
    }

    const convPath = path.join(memoryDir, 'conversation.md');
    let convContent = '';
    try { convContent = fs.readFileSync(convPath, 'utf-8'); } catch { /* empty */ }

    if (!convContent.trim() || convContent.split(/^## /m).filter(s => s.trim()).length <= 1) {
      return { compacted: 0, decisions: 0, preferences: 0, rules: 0 };
    }

    // Read existing buckets
    const existingBuckets: Record<string, string> = {};
    for (const bucket of ['decisions.md', 'preferences.md', 'rules.md']) {
      try {
        existingBuckets[bucket] = fs.readFileSync(path.join(memoryDir, bucket), 'utf-8');
      } catch {
        existingBuckets[bucket] = '';
      }
    }

    const compactPrompt = `You are a memory compaction system. Analyze the conversation history below and extract durable facts into three categories.

EXISTING MEMORY (do not duplicate — update or skip if already captured):
<decisions>
${existingBuckets['decisions.md']}
</decisions>
<preferences>
${existingBuckets['preferences.md']}
</preferences>
<rules>
${existingBuckets['rules.md']}
</rules>

CONVERSATION HISTORY TO PROCESS:
${convContent}

INSTRUCTIONS:
1. Extract NEW facts only — skip anything already in existing memory
2. Update existing facts if the conversation contradicts or refines them
3. Categorize each fact:
   - DECISION: Something that was decided and acted upon
   - PREFERENCE: How the user likes things done
   - RULE: A constraint or guideline
4. Ignore exploratory questions, casual chat, and clarification exchanges
5. Each fact should be one line, starting with "- "

Respond in EXACTLY this format (include all three sections even if empty):
<decisions>
- fact one
</decisions>
<preferences>
- fact one
</preferences>
<rules>
- fact one
</rules>`;

    const result = await this.router.run({
      groupFolder: '_mentor-compact',
      prompt: compactPrompt,
      agent: this.settings.agent,
    });

    if (result.status !== 'success' || !result.output) {
      throw new Error('Compaction failed: ' + (result.error || 'no output'));
    }

    const output = result.output;
    const counts = { decisions: 0, preferences: 0, rules: 0 };

    for (const [bucket, key] of [['decisions.md', 'decisions'], ['preferences.md', 'preferences'], ['rules.md', 'rules']] as const) {
      const match = output.match(new RegExp(`<${key}>([\\s\\S]*?)</${key}>`));
      if (!match) continue;

      const newFacts = match[1].trim().split('\n').filter((l: string) => l.trim().startsWith('- '));
      if (newFacts.length === 0) continue;

      counts[key] = newFacts.length;

      const bucketPath = path.join(memoryDir, bucket);
      const existing = existingBuckets[bucket] || `# ${key.charAt(0).toUpperCase() + key.slice(1)}\n\n`;
      const updated = existing.trimEnd() + '\n' + newFacts.join('\n') + '\n';
      fs.writeFileSync(bucketPath, updated);
    }

    // Trim conversation.md
    this._trimConversations(convPath);

    const total = counts.decisions + counts.preferences + counts.rules;
    this._gitCommit(agentDir, `compact: extracted ${total} facts (${counts.decisions}d/${counts.preferences}p/${counts.rules}r)`);
    this.emit({ type: 'compacted', agent: name, ...counts, total });

    return { compacted: total, ...counts };
  }

  /**
   * List pending proposals for an agent.
   *
   * @title Pending Proposals
   * @param agent Agent directory name {@example "arul_and_lura"}
   * @format table
   */
  async proposals(params: { agent: string }): Promise<Array<{ name: string; type: string; reason: string }>> {
    const agentDir = this._resolveAgent(params.agent);
    const proposalsDir = path.join(agentDir, 'proposals');
    if (!fs.existsSync(proposalsDir)) return [];

    const files = fs.readdirSync(proposalsDir).filter(f => f.endsWith('.md'));
    return files.map(f => {
      const content = fs.readFileSync(path.join(proposalsDir, f), 'utf-8');
      const nameMatch = f.replace('.md', '');
      const typeMatch = content.match(/Type:\s*(\w+)/);
      const reasonMatch = content.match(/## Reason\n([\s\S]*?)(?=\n## |$)/);
      return {
        name: nameMatch,
        type: typeMatch?.[1] || 'unknown',
        reason: (reasonMatch?.[1] || '').trim().slice(0, 200),
      };
    });
  }

  /**
   * Approve a pending proposal.
   *
   * @title Approve Proposal
   * @param agent Agent directory name {@example "arul_and_lura"}
   * @param proposal Proposal name {@example "prefer-concise-responses"}
   */
  async approve(params: { agent: string; proposal: string }): Promise<{ applied: boolean; type: string }> {
    const agentDir = this._resolveAgent(params.agent);
    const proposalPath = path.join(agentDir, 'proposals', `${params.proposal}.md`);

    if (!fs.existsSync(proposalPath)) {
      throw new Error(`Proposal not found: ${params.proposal}`);
    }

    const content = fs.readFileSync(proposalPath, 'utf-8');
    const proposal = this._parseProposalFile(params.proposal, content);

    await this._applyProposal(agentDir, proposal);

    // Remove from proposals
    fs.unlinkSync(proposalPath);

    this._gitCommit(agentDir, `approve: applied proposal "${params.proposal}" (${proposal.type})`);
    this.emit({ type: 'proposal_approved', agent: path.basename(agentDir), proposal: params.proposal });

    return { applied: true, type: proposal.type };
  }

  /**
   * Reject a pending proposal.
   *
   * @title Reject Proposal
   * @param agent Agent directory name {@example "arul_and_lura"}
   * @param proposal Proposal name {@example "add-vision-skill"}
   */
  async reject(params: { agent: string; proposal: string }): Promise<{ rejected: boolean }> {
    const agentDir = this._resolveAgent(params.agent);
    const proposalPath = path.join(agentDir, 'proposals', `${params.proposal}.md`);

    if (!fs.existsSync(proposalPath)) {
      throw new Error(`Proposal not found: ${params.proposal}`);
    }

    fs.unlinkSync(proposalPath);
    this._gitCommit(agentDir, `reject: declined proposal "${params.proposal}"`);
    this.emit({ type: 'proposal_rejected', agent: path.basename(agentDir), proposal: params.proposal });

    return { rejected: true };
  }

  /**
   * Show an agent's journal entries for a date range.
   *
   * @title Read Journal
   * @param agent Agent directory name {@example "arul_and_lura"}
   * @param days Number of days to look back {@example 7}
   */
  async journal(params: { agent: string; days?: number }): Promise<Array<{ timestamp: string; userMessage: string; thought: string }>> {
    const agentDir = this._resolveAgent(params.agent);
    return this._readRecentJournal(agentDir, params.days || 7);
  }

  /**
   * Show an agent's current persona.
   *
   * @title View Persona
   * @param agent Agent directory name {@example "arul_and_lura"}
   */
  async persona(params: { agent: string }): Promise<{ persona: string; skills: string[] }> {
    const agentDir = this._resolveAgent(params.agent);
    const personaContent = this._readFile(path.join(agentDir, 'persona.md'));
    const skills = this._readSkills(agentDir);
    return { persona: personaContent || '(no persona defined)', skills };
  }

  /**
   * Directly edit an agent's persona.
   *
   * @title Edit Persona
   * @param agent Agent directory name {@example "arul_and_lura"}
   * @param content New persona content {@example "You are Lura, a concise assistant who prefers direct answers."}
   */
  async setPersona(params: { agent: string; content: string }): Promise<{ updated: boolean }> {
    const agentDir = this._resolveAgent(params.agent);
    const personaPath = path.join(agentDir, 'persona.md');
    fs.writeFileSync(personaPath, `# Persona\n\n${params.content}\n`);
    this._gitCommit(agentDir, 'persona: manually updated');
    return { updated: true };
  }

  /**
   * Add a skill to an agent.
   *
   * @title Add Skill
   * @param agent Agent directory name {@example "arul_and_lura"}
   * @param skill Skill name or path {@example "image-analysis"}
   */
  async addSkill(params: { agent: string; skill: string }): Promise<{ added: boolean; skills: string[] }> {
    const agentDir = this._resolveAgent(params.agent);
    const skills = this._readSkills(agentDir);

    if (skills.includes(params.skill)) {
      return { added: false, skills };
    }

    skills.push(params.skill);
    this._writeSkills(agentDir, skills);
    this._gitCommit(agentDir, `skill: added "${params.skill}"`);

    return { added: true, skills };
  }

  /**
   * Remove a skill from an agent.
   *
   * @title Remove Skill
   * @param agent Agent directory name {@example "arul_and_lura"}
   * @param skill Skill name {@example "image-analysis"}
   */
  async removeSkill(params: { agent: string; skill: string }): Promise<{ removed: boolean; skills: string[] }> {
    const agentDir = this._resolveAgent(params.agent);
    const skills = this._readSkills(agentDir);

    const idx = skills.indexOf(params.skill);
    if (idx === -1) {
      return { removed: false, skills };
    }

    skills.splice(idx, 1);
    this._writeSkills(agentDir, skills);
    this._gitCommit(agentDir, `skill: removed "${params.skill}"`);

    return { removed: true, skills };
  }

  /**
   * Show git history of an agent's evolution.
   *
   * @title Evolution History
   * @param agent Agent directory name {@example "arul_and_lura"}
   * @param count Number of commits to show {@example 20}
   * @format table
   */
  async history(params: { agent: string; count?: number }): Promise<Array<{ hash: string; date: string; message: string }>> {
    const agentDir = this._resolveAgent(params.agent);
    const gitDir = path.join(agentDir, '.git');
    if (!fs.existsSync(gitDir)) return [];

    try {
      const { execFileSync } = require('child_process');
      const limit = params.count || 20;
      const log = execFileSync('git', ['log', `--max-count=${limit}`, '--format=%h|%ai|%s'], { cwd: agentDir, encoding: 'utf-8' });
      return log.trim().split('\n').filter((l: string) => l).map((line: string) => {
        const [hash, date, ...msgParts] = line.split('|');
        return { hash, date, message: msgParts.join('|') };
      });
    } catch {
      return [];
    }
  }

  // ─── Private Helpers ────────────────────────────────────────────

  private _resolveAgent(nameOrPath: string): string {
    // If it's already an absolute path
    if (path.isAbsolute(nameOrPath) && fs.existsSync(nameOrPath)) {
      return nameOrPath;
    }

    // Try direct match
    const direct = path.join(this.settings.agentsDir, nameOrPath);
    if (fs.existsSync(direct)) return direct;

    // Try sanitized match
    const sanitized = nameOrPath.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    const sanitizedPath = path.join(this.settings.agentsDir, sanitized);
    if (fs.existsSync(sanitizedPath)) return sanitizedPath;

    // Fuzzy match
    if (fs.existsSync(this.settings.agentsDir)) {
      const dirs = fs.readdirSync(this.settings.agentsDir);
      const match = dirs.find(d => d.toLowerCase().includes(nameOrPath.toLowerCase()));
      if (match) return path.join(this.settings.agentsDir, match);
    }

    throw new Error(`Agent not found: ${nameOrPath}`);
  }

  private _readFile(filePath: string): string {
    try { return fs.readFileSync(filePath, 'utf-8'); } catch { return ''; }
  }

  private _fileSize(filePath: string): number {
    try { return fs.statSync(filePath).size; } catch { return 0; }
  }

  private _countConversations(agentDir: string): number {
    const convPath = path.join(agentDir, 'memory', 'conversation.md');
    try {
      const content = fs.readFileSync(convPath, 'utf-8');
      return Math.max(0, content.split(/^## /m).filter(s => s.trim()).length - 1);
    } catch { return 0; }
  }

  private _countTodayJournal(agentDir: string): number {
    const today = new Date().toISOString().slice(0, 10);
    const journalPath = path.join(agentDir, 'journal', `${today}.jsonl`);
    try {
      const content = fs.readFileSync(journalPath, 'utf-8');
      return content.trim().split('\n').filter(l => l.trim()).length;
    } catch { return 0; }
  }

  private _countProposals(agentDir: string): number {
    const proposalsDir = path.join(agentDir, 'proposals');
    try {
      return fs.readdirSync(proposalsDir).filter(f => f.endsWith('.md')).length;
    } catch { return 0; }
  }

  private _readRecentJournal(agentDir: string, days: number): Array<{ timestamp: string; sender: string; userMessage: string; thought: string }> {
    const journalDir = path.join(agentDir, 'journal');
    if (!fs.existsSync(journalDir)) return [];

    const entries: Array<{ timestamp: string; sender: string; userMessage: string; thought: string }> = [];
    const now = new Date();

    for (let i = 0; i < days; i++) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().slice(0, 10);
      const filePath = path.join(journalDir, `${dateStr}.jsonl`);

      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        for (const line of content.trim().split('\n')) {
          if (!line.trim()) continue;
          try {
            entries.push(JSON.parse(line));
          } catch { /* skip malformed */ }
        }
      } catch { /* no journal for this date */ }
    }

    return entries;
  }

  private _readMemoryBuckets(agentDir: string): string {
    const parts: string[] = [];
    for (const bucket of ['decisions.md', 'preferences.md', 'rules.md']) {
      const content = this._readFile(path.join(agentDir, 'memory', bucket));
      const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#'));
      if (lines.length > 0) parts.push(content.trim());
    }
    return parts.join('\n\n---\n\n') || '(no memory yet)';
  }

  private _readSkills(agentDir: string): string[] {
    const skillsPath = path.join(agentDir, 'skills.json');
    try {
      return JSON.parse(fs.readFileSync(skillsPath, 'utf-8'));
    } catch { return []; }
  }

  private _writeSkills(agentDir: string, skills: string[]): void {
    fs.writeFileSync(path.join(agentDir, 'skills.json'), JSON.stringify(skills, null, 2) + '\n');
  }

  private _trimConversations(convPath: string): void {
    try {
      const content = fs.readFileSync(convPath, 'utf-8');
      const sections = content.split(/^## /m).filter(s => s.trim());
      const max = this.settings.maxConversations;
      if (sections.length <= max + 1) return;

      const title = '# Conversation History\n\n';
      const kept = sections.slice(-max).map(s => `## ${s}`).join('');
      fs.writeFileSync(convPath, title + kept);
    } catch { /* ok */ }
  }

  private _parseProposals(output: string): Array<{ name: string; type: string; reason: string; change: string; auto: boolean }> {
    const proposals: Array<{ name: string; type: string; reason: string; change: string; auto: boolean }> = [];
    const proposalPattern = /<proposal\s+name="([^"]+)"\s+type="([^"]+)">([\s\S]*?)<\/proposal>/g;

    let match: RegExpExecArray | null;
    while ((match = proposalPattern.exec(output)) !== null) {
      const [, name, type, body] = match;
      const reasonMatch = body.match(/<reason>([\s\S]*?)<\/reason>/);
      const changeMatch = body.match(/<change>([\s\S]*?)<\/change>/);
      const autoMatch = body.match(/<auto>(true|false)<\/auto>/);

      proposals.push({
        name: name.trim(),
        type: type.trim(),
        reason: (reasonMatch?.[1] || '').trim(),
        change: (changeMatch?.[1] || '').trim(),
        auto: autoMatch?.[1] === 'true',
      });
    }

    return proposals;
  }

  private _saveProposal(agentDir: string, proposal: { name: string; type: string; reason: string; change: string }): void {
    const proposalsDir = path.join(agentDir, 'proposals');
    fs.mkdirSync(proposalsDir, { recursive: true });

    const fileName = proposal.name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
    const content = `# Proposal: ${proposal.name}

Type: ${proposal.type}
Created: ${new Date().toISOString()}

## Reason
${proposal.reason}

## Proposed Change
${proposal.change}
`;
    fs.writeFileSync(path.join(proposalsDir, `${fileName}.md`), content);
  }

  private _parseProposalFile(name: string, content: string): { name: string; type: string; reason: string; change: string; auto: boolean } {
    const typeMatch = content.match(/Type:\s*(\w+)/);
    const reasonMatch = content.match(/## Reason\n([\s\S]*?)(?=\n## )/);
    const changeMatch = content.match(/## Proposed Change\n([\s\S]*?)$/);

    return {
      name,
      type: typeMatch?.[1] || 'persona',
      reason: (reasonMatch?.[1] || '').trim(),
      change: (changeMatch?.[1] || '').trim(),
      auto: false,
    };
  }

  private async _applyProposal(agentDir: string, proposal: { name: string; type: string; change: string }): Promise<void> {
    switch (proposal.type) {
      case 'persona': {
        const personaPath = path.join(agentDir, 'persona.md');
        const existing = this._readFile(personaPath);
        const updated = existing.trimEnd() + '\n\n' + proposal.change + '\n';
        fs.writeFileSync(personaPath, updated);
        break;
      }
      case 'skill': {
        const skills = this._readSkills(agentDir);
        if (!skills.includes(proposal.change)) {
          skills.push(proposal.change);
          this._writeSkills(agentDir, skills);
        }
        break;
      }
      case 'memory': {
        // Add to decisions.md by default
        const decisionsPath = path.join(agentDir, 'memory', 'decisions.md');
        const existing = this._readFile(decisionsPath) || '# Decisions\n\n';
        const updated = existing.trimEnd() + '\n- ' + proposal.change + '\n';
        fs.writeFileSync(decisionsPath, updated);
        break;
      }
    }
  }

  private _gitCommit(agentDir: string, message: string): void {
    try {
      const { execFileSync } = require('child_process');
      if (!fs.existsSync(path.join(agentDir, '.git'))) return;
      execFileSync('git', ['add', '-A'], { cwd: agentDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', message], { cwd: agentDir, stdio: 'ignore' });
    } catch { /* nothing to commit or git unavailable */ }
  }
}
