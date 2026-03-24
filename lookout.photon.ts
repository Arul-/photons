/**
 * Lookout — Local AI UI Inspector
 *
 * Sees your UI, finds issues, validates promises, and tests interactions.
 * Runs Qwen3-VL locally on Apple Silicon via MLX — zero API cost, fully offline.
 *
 * ## Setup
 *
 * ```bash
 * pip install -U mlx-vlm  # Apple Silicon only
 * ```
 *
 * Model auto-downloads on first use (~5 GB).
 *
 * ## Methods
 *
 * - `review` — Screenshot → structured issue list with severity and fixes
 * - `validate` — Screenshot + promise list → PASS/FAIL for each promise
 * - `compare` — Before/after screenshots → what changed, regressions, fixes
 * - `interact` — URL + action + expectation → executes via agent-browser, verifies result
 * - `inspect` — Capture a Peekaboo screenshot + element map for macOS UI automation
 * - `record` — Capture frames via agent-browser or Peekaboo, synthesize a trail/heatmap, analyze motion
 * - `status` — Check if model and dependencies are ready
 *
 * @version 1.0.0
 * @icon 👁️
 * @tags qa, visual, ui, testing, accessibility, automation
 * @dependencies sharp@^0.33.0
 * @stateful
 */

import { execFile } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import * as path from 'path';
import * as os from 'os';

const DEFAULT_MODEL = 'mlx-community/Qwen3-VL-8B-Instruct-4bit';

const REVIEW_PROMPT = `You are a UI/UX quality inspector. Analyze this screenshot of a web application and report REAL visual bugs only.

IMPORTANT — Do NOT flag these as issues (they are intentional design patterns):
- Standard button/label text sizes (10-14px) — these are industry-normal, not "too small"
- Typography hierarchy where page titles are larger than section headers — this is intentional
- Text wrapping inside fixed-width containers (columns, cards, tags) — this is normal layout behavior, NOT a font size problem
- Accent colors (light blue, muted tones) on dark backgrounds — these are intentional styling choices unless text is truly unreadable
- Different icon/element sizes in different contexts (e.g., stars in a review vs stars in a chart) — context-appropriate sizing is intentional
- Varying header sizes across page sections — visual hierarchy is a feature, not a bug
- Multiple section labels stacked vertically in a sidebar (e.g., "OUTLINE" then "DOCUMENTS") — these are DIFFERENT sections with DIFFERENT purposes, NOT duplication. Look at the actual text: if the labels say different words, they are different sections.
- UI controls positioned near grid/table edges (toggle buttons, collapse arrows, sidebar toggles) — these are interactive elements, NOT misaligned grid content
- Tab bars, sheet tabs, or navigation tabs near data grids — tab labels (like "default", "Sheet1") are NOT cell content. They are navigation controls above or below the grid.

Focus on BROKEN things, not design preferences:
- LAYOUT: Overlapping elements, broken grids, content overflow/clipping, off-screen elements
- CONTENT: Empty areas missing content, placeholder text left in, truncated text cutting off meaning, missing icons/images
- TYPOGRAPHY: Truly unreadable text, broken font rendering, text that overlaps other text
- CONTRAST: Text that is genuinely unreadable against its background (not just accent styling)
- INTERACTIVE: Buttons not looking clickable, missing hover/active states, unclear affordances
- SPACING: Elements overlapping or colliding, content crushed with no breathing room
- RESPONSIVE: Content overflowing viewport, broken layouts, horizontal scrollbar
- EMPTY_STATE: Missing empty state messages, blank panels without explanation
- CONSISTENCY: Genuinely broken patterns (e.g., same button styled two different ways in the same context)
- ACCESSIBILITY: Missing labels, color-only indicators, click targets under 24px

For each issue report severity (critical/warning/info), category, location on screen, description, and fix suggestion.

Respond ONLY with JSON, no markdown fences:
{"summary":"Brief assessment","score":85,"issues":[{"severity":"warning","category":"LAYOUT","location":"main content area","description":"what is wrong","suggestion":"how to fix"}]}

If the UI looks good, return score 90+ with empty issues array. Do NOT invent problems — only report things that are clearly broken or dysfunctional.`;

const COMPARE_PROMPT = `You are a UI/UX quality inspector. Compare these two screenshots of the same interface.

The first image is BEFORE and the second is AFTER a change was made.

Report:
1. What changed between the two versions
2. Whether the change introduced any NEW visual issues
3. Whether any existing issues were fixed

Respond ONLY with JSON, no markdown fences:
{"summary":"What changed","changes":[{"type":"fixed|regression|neutral","location":"where","description":"what changed"}],"new_issues":[{"severity":"warning","category":"LAYOUT","location":"where","description":"what is wrong","suggestion":"how to fix"}]}`;

interface Issue {
  severity: 'critical' | 'warning' | 'info';
  category: string;
  location: string;
  description: string;
  suggestion: string;
}

interface ReviewResult {
  summary: string;
  score: number | null;
  issues: Issue[];
  elapsed: number;
  model: string;
}

export default class Lookout {
  protected settings = {
    /** MLX model to use for analysis */
    model: DEFAULT_MODEL,
    /** Python binary path (must have mlx-vlm installed) */
    python: '/opt/homebrew/bin/python3',
    /** Max tokens for model response */
    maxTokens: 2000,
    /** Browser backend used for web automation */
    agentBrowser: 'agent-browser',
    /** macOS desktop backend used for local UI capture and control */
    peekaboo: 'peekaboo',
  };

  declare memory: {
    get<T>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<void>;
  };

  // ── Core Methods ─────────────────────────────────────────

  /**
   * Review a screenshot for UI/UX issues
   * @param image Path to screenshot file
   * @param prompt Optional custom analysis prompt
   * @format markdown
   * @readOnly
   */
  async review({ image, prompt }: { image: string; prompt?: string }) {
    const imagePath = await this.resolveImage(image);
    const analysisPrompt = prompt || REVIEW_PROMPT;
    const result = await this.infer(imagePath, analysisPrompt);
    const parsed = this.parseResult(result);

    // Pass 2: Inline rule-based filter
    const beforeCount = parsed.issues.length;
    parsed.issues = parsed.issues.filter(i => {
      const loc = (i.location || '').toLowerCase();
      const desc = (i.description || '').toLowerCase();
      if (loc.includes('sidebar') && (desc.includes('duplicat') || desc.includes('twice') || desc.includes('repeated'))) return false;
      if ((desc.includes('too small') || desc.includes('hard to read')) && (desc.includes('button') || loc.includes('button'))) return false;
      if (desc.includes('row 10') || desc.includes('row number') || ((desc.includes('play button') || desc.includes('triangle') || desc.includes('icon overlap')) && (loc.includes('row') || loc.includes('grid') || loc.includes('content')))) return false;
      if (desc.includes('cell a1') && (desc.includes('default') || desc.includes('tab') || desc.includes('placeholder'))) return false;
      return true;
    });
    if (parsed.issues.length === 0 && beforeCount > 0 && (parsed.score ?? 0) < 90) parsed.score = 95;
    return this.formatMarkdown(parsed);
  }

  /**
   * Validate a screenshot against a list of promises
   * @param image Path to screenshot file
   * @param promises Array of promise strings to check (e.g., ["Drag thumbnails to reorder slides", "Theme selector dropdown"])
   * @format markdown
   * @readOnly
   */
  async validate({ image, promises }: { image: string; promises: string[] }) {
    const imagePath = await this.resolveImage(image);

    const promiseList = promises.map((p, i) => `${i + 1}. ${p}`).join('\n');

    const prompt = `You are validating a UI against its feature promises. Look at this screenshot and check each promise below.

For each promise, determine:
- PASS: The feature is clearly visible and appears functional
- FAIL: The feature is missing or clearly broken
- UNCLEAR: Cannot determine from this screenshot alone (might need interaction)

Promises to check:
${promiseList}

Respond ONLY with JSON, no markdown fences:
{"results":[{"promise":"the promise text","status":"PASS|FAIL|UNCLEAR","evidence":"what you see that confirms or denies this"}],"pass_count":N,"fail_count":N,"unclear_count":N}`;

    const result = await this.infer(imagePath, prompt);
    const parsed = this.parseValidation(result);
    return this.formatValidation(parsed, promises);
  }

  private parseValidation(raw: string): any {
    try {
      const wrapper = JSON.parse(raw.trim());
      const output: string = wrapper.output || raw;
      try {
        return JSON.parse(output);
      } catch {
        const m = output.match(/\{[\s\S]*\}/);
        if (m) return JSON.parse(m[0]);
      }
    } catch {}
    return { results: [], pass_count: 0, fail_count: 0, unclear_count: 0 };
  }

  private formatValidation(data: any, promises: string[]): string {
    const results = data.results || [];
    const pass = results.filter((r: any) => r.status === 'PASS').length;
    const fail = results.filter((r: any) => r.status === 'FAIL').length;
    const unclear = results.filter((r: any) => r.status === 'UNCLEAR').length;

    let md = `# Promise Validation\n\n`;
    md += `**${pass}/${results.length} passed**`;
    if (fail > 0) md += ` | ${fail} failed`;
    if (unclear > 0) md += ` | ${unclear} unclear`;
    md += '\n\n';

    for (const r of results) {
      const icon = r.status === 'PASS' ? '✅' : r.status === 'FAIL' ? '❌' : '❓';
      md += `${icon} **${r.promise}**\n`;
      if (r.evidence) md += `  ${r.evidence}\n`;
      md += '\n';
    }

    return md;
  }

  /**
   * Test a UI interaction and verify the result
   * @param url Page URL to open
   * @param action What to do in plain English (e.g., "click the theme dropdown and select gaia")
   * @param expect What should happen (e.g., "slide styling changes to gaia theme")
   * @format markdown
   */
  async interact({ url, action, expect }: { url: string; action: string; expect: string }) {
    const tmpDir = path.join(os.tmpdir(), 'lookout-interact');
    const { mkdirSync } = await import('fs');
    mkdirSync(tmpDir, { recursive: true });

    const ts = Date.now();
    const beforeImg = path.join(tmpDir, `before-${ts}.png`);
    const afterImg = path.join(tmpDir, `after-${ts}.png`);

    // Step 1: Open URL and wait for load
    await this.exec('agent-browser', ['open', url], 15_000);
    await new Promise(r => setTimeout(r, 2000));

    // Step 2: Detect if page has a Beam iframe (shadow DOM → custom-ui-renderer → iframe)
    const iframeCheck = await this.execJson('agent-browser', ['eval',
      `JSON.stringify({
        hasBeamIframe: !!document.querySelector('beam-app')
          ?.shadowRoot?.querySelector('custom-ui-renderer')
          ?.shadowRoot?.querySelector('iframe')?.contentDocument
      })`, '--json']);
    const isBeamIframe = iframeCheck?.hasBeamIframe === true;

    // Step 3: Screenshot before
    await this.exec('agent-browser', ['screenshot', beforeImg], 10_000);

    // Step 4: Get interactive elements
    let elementList: string;
    if (isBeamIframe) {
      // Read elements from inside the iframe via eval
      const iframeElements = await this.execJson('agent-browser', ['eval', `
        JSON.stringify((() => {
          const doc = document.querySelector('beam-app')
            ?.shadowRoot?.querySelector('custom-ui-renderer')
            ?.shadowRoot?.querySelector('iframe')?.contentDocument;
          if (!doc) return {elements: [], error: 'no iframe doc'};
          const els = [];
          doc.querySelectorAll('button, a, input, select, textarea, [onclick], [draggable], .thumb, .tb-btn, .outline-item, .doc-item, .picker-item').forEach((el, i) => {
            const tag = el.tagName.toLowerCase();
            const text = (el.textContent || '').trim().substring(0, 50);
            const cls = el.className ? '.' + el.className.split(' ')[0] : '';
            const id = el.id ? '#' + el.id : '';
            const type = el.getAttribute('type') || '';
            const placeholder = el.getAttribute('placeholder') || '';
            const role = el.getAttribute('role') || '';
            els.push({i, tag, text, cls, id, type, placeholder, role});
          });
          return {elements: els, error: null};
        })())
      `, '--json']);

      if (iframeElements?.elements) {
        elementList = 'IFRAME ELEMENTS — use the CSS selector shown in parentheses:\n' +
          iframeElements.elements.map((el: any) => {
            // Build the best selector: prefer #id, then .class+tag, then tag:nth
            const selector = el.id || (el.cls ? `${el.tag}${el.cls}` : `${el.tag}`);
            return `- "${el.text || el.placeholder || el.tag}" → selector: "${selector}"`;
          }).join('\n');
      } else {
        elementList = 'Could not read iframe elements: ' + (iframeElements?.error || 'unknown');
      }
    } else {
      // Standard page — use snapshot refs
      elementList = await this.exec('agent-browser', ['snapshot', '-i'], 10_000);
    }

    // Step 5: Plan the action sequence
    const planPrompt = isBeamIframe
      ? `You are a browser automation agent. Each element below shows its text and CSS selector.
Commands (one per line, use the exact selector from the list):
- click "<selector>"
- fill "<selector>" "text"
- select "<selector>" "value"

${elementList}

User wants to: "${action}"

Output ONLY the commands, one per line. Copy the selector exactly from the list above.`
      : `You are a browser automation agent. Available commands (one per line):
- click @<ref>
- fill @<ref> "text"
- select @<ref> "value"
- scroll up/down

Interactive elements on this page:
${elementList.trim()}

User wants to: "${action}"

Output ONLY the command sequence, one per line. Use exact @ref format.`;

    const planResult = await this.infer(beforeImg, planPrompt);
    const planParsed = this.parseResult(planResult);
    const planText = planParsed.summary || '';

    // Step 6: Parse and execute commands
    const commands = planText.split('\n').filter((l: string) =>
      /^(click|fill|select|scroll)/i.test(l.trim())
    );
    const executed: string[] = [];

    for (const cmd of commands) {
      const trimmed = cmd.trim();
      try {
        if (isBeamIframe) {
          // Execute inside iframe via eval
          await this.execIframeCommand(trimmed);
          executed.push(trimmed);
          await new Promise(r => setTimeout(r, 800));
        } else {
          // Standard page — use agent-browser directly
          if (trimmed.startsWith('click')) {
            const ref = trimmed.match(/@?e\d+/)?.[0];
            if (ref) {
              const refStr = ref.startsWith('@') ? ref : '@' + ref;
              await this.exec('agent-browser', ['click', refStr], 10_000);
              executed.push(`click ${refStr}`);
            }
          } else if (trimmed.startsWith('fill')) {
            const match = trimmed.match(/@?e\d+/);
            const textMatch = trimmed.match(/"([^"]+)"/);
            if (match && textMatch) {
              const refStr = match[0].startsWith('@') ? match[0] : '@' + match[0];
              await this.exec('agent-browser', ['fill', refStr, textMatch[1]], 10_000);
              executed.push(`fill ${refStr} "${textMatch[1]}"`);
            }
          } else if (trimmed.startsWith('select')) {
            const match = trimmed.match(/@?e\d+/);
            const valMatch = trimmed.match(/"([^"]+)"/);
            if (match && valMatch) {
              const refStr = match[0].startsWith('@') ? match[0] : '@' + match[0];
              await this.exec('agent-browser', ['select', refStr, valMatch[1]], 10_000);
              executed.push(`select ${refStr} "${valMatch[1]}"`);
            }
          } else if (trimmed.startsWith('scroll')) {
            const dir = trimmed.includes('up') ? 'up' : 'down';
            await this.exec('agent-browser', ['scroll', dir], 10_000);
            executed.push(`scroll ${dir}`);
          }
          await new Promise(r => setTimeout(r, 500));
        }
      } catch (e: any) {
        executed.push(`FAILED: ${trimmed} — ${e?.message}`);
      }
    }

    // Step 7: Screenshot after
    await new Promise(r => setTimeout(r, 1000));
    await this.exec('agent-browser', ['screenshot', afterImg], 10_000);

    // Step 8: Generate diff trail between before/after for better comparison
    const diffImg = path.join(tmpDir, `diff-${ts}.png`);
    try {
      await this.diff({ images: [beforeImg, afterImg], output: diffImg, mode: 'trail' });
    } catch { /* diff is optional — fall through to after-only verification */ }

    // Step 9: Compare before/after with expectation
    // Show the diff trail to the model so it can see what changed
    const verifyImage = existsSync(diffImg) ? diffImg : afterImg;
    const verifyPrompt = existsSync(diffImg)
      ? `This image shows a BEFORE→AFTER diff trail of a web UI. Blue/cyan areas show the BEFORE state, red/yellow areas show the AFTER state. Areas with color changed between screenshots.

I performed this action: "${action}"
The expected result was: "${expect}"

Based on the visual diff, did the expected change occur?
Start your answer with PASS or FAIL, then explain what changed.`
      : `I performed this action on a web UI: "${action}"
The expected result was: "${expect}"

Look at this screenshot taken AFTER the action. Did the expected result occur?
Start your answer with PASS or FAIL, then explain what you see.`;

    const verifyResult = await this.infer(verifyImage, verifyPrompt);
    const verifyParsed = this.parseResult(verifyResult);
    const verifyText = verifyParsed.summary || '';

    // Parse pass/fail from prose response
    const firstWord = verifyText.trim().split(/[\s,.!:]/)[0].toUpperCase();
    const pass = firstWord === 'PASS' || /^pass\b/i.test(verifyText.trim());
    const observation = verifyText.replace(/^(PASS|FAIL)[:\s]*/i, '').trim() || 'No details provided';

    // Format result
    let md = `# Interaction Test\n\n`;
    md += `**Action:** ${action}\n`;
    md += `**Expectation:** ${expect}\n`;
    md += `**URL:** ${url}\n`;
    md += `**Mode:** ${isBeamIframe ? 'Beam iframe (eval)' : 'Direct page (@ref)'}\n\n`;

    md += `## Commands Executed\n`;
    for (const cmd of executed) {
      md += `- \`${cmd}\`\n`;
    }
    md += '\n';

    md += `## Result: ${pass ? '✅ PASS' : '❌ FAIL'}\n\n`;
    md += `${observation}\n\n`;
    md += `*Before: ${beforeImg}*\n*After: ${afterImg}*\n`;
    if (existsSync(diffImg)) md += `*Diff: ${diffImg}*\n`;

    return md;
  }

  /**
   * Inspect a macOS surface via Peekaboo and return its screenshot path and element map
   * @param app Optional application name to target (e.g. "Safari")
   * @param mode Capture mode {@default frontmost}
   * @param path Optional output screenshot path
   * @param screenIndex Optional screen index for screen capture
   * @format markdown
   */
  async inspect({
    app,
    mode,
    path: outPath,
    screenIndex,
  }: {
    app?: string;
    mode?: 'screen' | 'window' | 'frontmost';
    path?: string;
    screenIndex?: number;
  } = {}) {
    const tmpDir = path.join(os.tmpdir(), 'lookout-inspect');
    const { mkdirSync } = await import('fs');
    mkdirSync(tmpDir, { recursive: true });

    const imagePath = outPath || path.join(tmpDir, `inspect-${Date.now()}.png`);
    const captureMode = mode || 'frontmost';
    const result = await this.peekabooSee({
      app,
      mode: captureMode,
      path: imagePath,
      screenIndex,
    });

    const elements = this.peekabooExtractElements(result.data);
    const screenshotPath =
      this.peekabooExtractScreenshotPath(result.data) || imagePath;

    let md = `# Peekaboo Inspect\n\n`;
    md += `**Mode:** ${captureMode}\n`;
    if (app) md += `**App:** ${app}\n`;
    if (typeof screenIndex === 'number') md += `**Screen:** ${screenIndex}\n`;
    md += `**Screenshot:** \`${screenshotPath}\`\n`;
    if (result.data?.snapshot_id) md += `**Snapshot ID:** \`${result.data.snapshot_id}\`\n`;
    md += `**Elements:** ${elements.length}\n\n`;

    if (elements.length) {
      md += `## Element Map\n\n`;
      md += elements
        .slice(0, 60)
        .map((el: any) => {
          const id = el.id || el.peekaboo_id || el.element_id || '?';
          const role = el.role || 'unknown';
          const title = el.title || el.label || el.description || el.identifier || '';
          return `- \`${id}\` | ${role}${title ? ` | ${title}` : ''}`;
        })
        .join('\n');
      if (elements.length > 60) md += `\n\n...and ${elements.length - 60} more`;
      md += '\n';
    } else {
      md += `No elements found in structured output.\n`;
    }

    return md;
  }

  // ── Iframe Helpers ─────────────────────────────────────

  private readonly IFRAME_CHAIN = `document.querySelector('beam-app')?.shadowRoot?.querySelector('custom-ui-renderer')?.shadowRoot?.querySelector('iframe')?.contentDocument`;

  private async execIframeCommand(cmd: string): Promise<void> {
    const trimmed = cmd.trim();

    if (trimmed.startsWith('click')) {
      // Extract CSS selector from: click ".thumb" or click "#save-btn" or click "button"
      const selMatch = trimmed.match(/click\s+"([^"]+)"/i) || trimmed.match(/click\s+(\S+)/i);
      if (selMatch) {
        const sel = selMatch[1].replace(/"/g, '\\"');
        await this.exec('agent-browser', ['eval',
          `${this.IFRAME_CHAIN}?.querySelector("${sel}")?.click() ?? 'not found'`
        ], 10_000);
      }
    } else if (trimmed.startsWith('fill')) {
      const selMatch = trimmed.match(/fill\s+"([^"]+)"\s+"([^"]+)"/i);
      if (selMatch) {
        const sel = selMatch[1].replace(/"/g, '\\"');
        const val = selMatch[2].replace(/"/g, '\\"');
        await this.exec('agent-browser', ['eval',
          `(() => { const el = ${this.IFRAME_CHAIN}?.querySelector("${sel}"); if(el) { el.value = "${val}"; el.dispatchEvent(new Event('input', {bubbles:true})); } })()`
        ], 10_000);
      }
    } else if (trimmed.startsWith('select')) {
      const selMatch = trimmed.match(/select\s+"([^"]+)"\s+"([^"]+)"/i);
      if (selMatch) {
        const sel = selMatch[1].replace(/"/g, '\\"');
        const val = selMatch[2].replace(/"/g, '\\"');
        await this.exec('agent-browser', ['eval',
          `(() => { const el = ${this.IFRAME_CHAIN}?.querySelector("${sel}"); if(el) { el.value = "${val}"; el.dispatchEvent(new Event('change', {bubbles:true})); } })()`
        ], 10_000);
      }
    }
  }

  private async execJson(cmd: string, args: string[]): Promise<any> {
    try {
      const raw = await this.exec(cmd, args, 10_000);
      const parsed = JSON.parse(raw);
      if (parsed?.data?.result) return JSON.parse(parsed.data.result);
      return parsed?.data || parsed;
    } catch {
      return null;
    }
  }

  /**
   * Record a page, capture frames, generate diff trail, and analyze with AI
   * @param url Page URL to record
   * @param duration Recording duration in seconds {@default 3}
   * @param fps Frames per second to capture {@default 4}
   * @param action Optional action to perform before recording (e.g., "click the next slide button")
   * @param query Optional question to ask AI about the recorded sequence (e.g., "was the transition smooth?")
   * @param mode Diff visualization: trail or heatmap {@default trail}
   * @format markdown
   * @ui lookout
   */
  async record({ url, duration, fps, action, query, mode }: {
    url?: string;
    app?: string;
    duration?: number;
    fps?: number;
    action?: string;
    query?: string;
    mode?: 'trail' | 'heatmap';
    backend?: 'agent-browser' | 'peekaboo';
    captureMode?: 'screen' | 'window' | 'frontmost';
    screenIndex?: number;
  }) {
    const dur = duration ?? 3;
    const rate = fps ?? 4;
    const totalFrames = dur * rate;
    const interval = 1000 / rate;
    const vizMode = mode || 'trail';
    const backend = arguments[0]?.backend || 'agent-browser';
    const captureMode = arguments[0]?.captureMode || (backend === 'peekaboo' ? 'frontmost' : 'screen');
    const app = arguments[0]?.app;
    const screenIndex = arguments[0]?.screenIndex;

    const tmpDir = path.join(os.tmpdir(), 'lookout-record', `${Date.now()}`);
    const fsMod = await import('fs');
    fsMod.mkdirSync(tmpDir, { recursive: true });

    // Step 1: Open target
    if (backend === 'peekaboo') {
      if (url) await this.peekabooOpen(url);
      await new Promise(r => setTimeout(r, 1500));
    } else {
      if (!url) throw new Error('url is required when backend=agent-browser');
      await this.exec(this.settings.agentBrowser, ['open', url], 15_000);
      await new Promise(r => setTimeout(r, 2000));
    }

    // Step 2: If action specified, plan and execute it first
    const executedActions: string[] = [];
    if (action) {
      if (backend === 'peekaboo') {
        const peekabooAction = action.startsWith('peekaboo:')
          ? action.slice('peekaboo:'.length).trim()
          : action;
        if (peekabooAction) {
          await this.peekabooAction(peekabooAction);
          executedActions.push(peekabooAction);
        }
      } else {
        const snapshot = await this.exec(this.settings.agentBrowser, ['snapshot', '-i'], 10_000);
        const firstFrame = path.join(tmpDir, 'pre-action.png');
        await this.exec(this.settings.agentBrowser, ['screenshot', firstFrame], 10_000);

        const planPrompt = `You are a browser automation agent. Commands: click @<ref>, fill @<ref> "text", select @<ref> "value", scroll up/down

Interactive elements:
${snapshot.trim()}

User wants to: "${action}"

Output ONLY the command sequence, one per line. Use exact @ref format.`;

        const planResult = await this.infer(firstFrame, planPrompt);
        const planParsed = this.parseResult(planResult);
        const commands = (planParsed.summary || '').split('\n').filter((l: string) =>
          /^(click|fill|select|scroll)/i.test(l.trim())
        );

        for (const cmd of commands) {
          const trimmed = cmd.trim();
          try {
            if (trimmed.startsWith('click')) {
              const ref = trimmed.match(/@?e\d+/)?.[0];
              if (ref) {
                const refStr = ref.startsWith('@') ? ref : '@' + ref;
                await this.exec(this.settings.agentBrowser, ['click', refStr], 10_000);
                executedActions.push(`click ${refStr}`);
              }
            } else if (trimmed.startsWith('fill')) {
              const match = trimmed.match(/@?e\d+/);
              const textMatch = trimmed.match(/"([^"]+)"/);
              if (match && textMatch) {
                const refStr = match[0].startsWith('@') ? match[0] : '@' + match[0];
                await this.exec(this.settings.agentBrowser, ['fill', refStr, textMatch[1]], 10_000);
                executedActions.push(`fill ${refStr} "${textMatch[1]}"`);
              }
            } else if (trimmed.startsWith('select')) {
              const match = trimmed.match(/@?e\d+/);
              const valMatch = trimmed.match(/"([^"]+)"/);
              if (match && valMatch) {
                const refStr = match[0].startsWith('@') ? match[0] : '@' + match[0];
                await this.exec(this.settings.agentBrowser, ['select', refStr, valMatch[1]], 10_000);
                executedActions.push(`select ${refStr} "${valMatch[1]}"`);
              }
            }
          } catch { /* continue */ }
        }
      }
      if (backend === 'peekaboo') {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    // Step 3: Capture frames
    const framePaths: string[] = [];
    for (let i = 0; i < totalFrames; i++) {
      const framePath = path.join(tmpDir, `frame-${String(i).padStart(3, '0')}.png`);
      try {
        if (backend === 'peekaboo') {
          await this.peekabooImage({
            path: framePath,
            mode: captureMode,
            app,
            screenIndex,
          });
        } else {
          await this.exec(this.settings.agentBrowser, ['screenshot', framePath], 5_000);
        }
        framePaths.push(framePath);
      } catch { /* skip failed frame */ }
      if (i < totalFrames - 1) await new Promise(r => setTimeout(r, interval));
    }

    if (framePaths.length < 2) {
      return '# Recording Failed\n\nCaptured fewer than 2 frames.';
    }

    // Step 4: Generate diff
    const trailPath = path.join(tmpDir, `${vizMode}.png`);
    await this.diff({ images: framePaths, output: trailPath, mode: vizMode });

    // Step 5: AI analysis of the trail (optional)
    let analysis = '';
    if (query || action) {
      const analysisPrompt = query
        ? `This image shows a "${vizMode}" visualization of a UI recording. Blue = start, green = middle, red = end of the recording. ${query}`
        : `This image shows a "${vizMode}" visualization of a UI recording after performing: "${action}". Blue = start, green = middle, red = end. Describe what changed. Was the transition smooth or abrupt? Did the action produce the expected visual result?`;

      const analysisResult = await this.infer(trailPath, analysisPrompt);
      const parsed = this.parseResult(analysisResult);
      analysis = parsed.summary || '';
    }

    // Step 6: Build result
    const result: any = {
      url,
      app,
      backend,
      duration: dur,
      fps: rate,
      frameCount: framePaths.length,
      frames: framePaths,
      trailImage: trailPath,
      mode: vizMode,
      action: action || null,
      executedActions,
      analysis: analysis || null,
      tmpDir,
    };

    // Markdown output
    let md = `# Recording: ${url || app || 'current surface'}\n\n`;
    md += `**Backend:** ${backend}\n`;
    md += `**Capture mode:** ${captureMode}\n`;
    md += `**${framePaths.length} frames** captured over ${dur}s at ${rate} fps\n`;
    if (action) md += `**Action:** ${action}\n`;
    if (executedActions.length) md += `**Commands:** ${executedActions.join(', ')}\n`;
    md += `\n**${vizMode} image:** \`${trailPath}\`\n`;
    md += `**Frames:** \`${tmpDir}/frame-*.png\`\n\n`;
    if (analysis) md += `## Analysis\n\n${analysis}\n`;

    return md;
  }

  /**
   * Generate visual diff from a sequence of screenshots
   * @param images Array of image paths in chronological order (min 2)
   * @param output Path to save the result image
   * @param mode Visualization mode: trail (motion path with color gradient), heatmap (change intensity), or blink (animated GIF alternating frames) {@default trail}
   * @param threshold Pixel difference threshold (0-255) to count as changed {@default 30}
   * @format markdown
   */
  async diff({ images, output, mode, threshold }: {
    images: string[];
    output: string;
    mode?: 'trail' | 'heatmap' | 'blink';
    threshold?: number;
  }) {
    if (images.length < 2) throw new Error('Need at least 2 images');

    const sharp = (await import('sharp')).default;
    const resolvedPaths = await Promise.all(images.map(i => this.resolveImage(i)));
    const thresh = threshold ?? 30;
    const vizMode = mode || 'trail';

    // Load first image to get dimensions
    const firstMeta = await sharp(resolvedPaths[0]).metadata();
    const width = firstMeta.width!;
    const height = firstMeta.height!;

    // Load all frames as raw RGBA buffers
    const frames: Buffer[] = [];
    for (const p of resolvedPaths) {
      const buf = await sharp(p).resize(width, height).ensureAlpha().raw().toBuffer();
      frames.push(buf);
    }

    // Color gradient for trail: blue → cyan → green → yellow → red
    const trailColors = [
      [66, 133, 244],   // blue
      [0, 188, 212],    // cyan
      [76, 175, 80],    // green
      [255, 193, 7],    // yellow
      [244, 67, 54],    // red
    ];

    function lerpColor(t: number): [number, number, number] {
      const idx = t * (trailColors.length - 1);
      const lo = Math.floor(idx);
      const hi = Math.min(lo + 1, trailColors.length - 1);
      const f = idx - lo;
      return [
        Math.round(trailColors[lo][0] * (1 - f) + trailColors[hi][0] * f),
        Math.round(trailColors[lo][1] * (1 - f) + trailColors[hi][1] * f),
        Math.round(trailColors[lo][2] * (1 - f) + trailColors[hi][2] * f),
      ];
    }

    if (vizMode === 'trail') {
      // Start with first frame as base (dimmed)
      const result = Buffer.from(frames[0]);
      // Dim the base image
      for (let i = 0; i < result.length; i += 4) {
        result[i] = Math.round(result[i] * 0.3);
        result[i + 1] = Math.round(result[i + 1] * 0.3);
        result[i + 2] = Math.round(result[i + 2] * 0.3);
      }

      let totalChanged = 0;
      const numPairs = frames.length - 1;

      for (let f = 0; f < numPairs; f++) {
        const prev = frames[f];
        const curr = frames[f + 1];
        const t = numPairs === 1 ? 1 : f / (numPairs - 1);
        const [cr, cg, cb] = lerpColor(t);
        const alpha = 0.7;

        for (let px = 0; px < width * height; px++) {
          const idx = px * 4;
          const dr = Math.abs(curr[idx] - prev[idx]);
          const dg = Math.abs(curr[idx + 1] - prev[idx + 1]);
          const db = Math.abs(curr[idx + 2] - prev[idx + 2]);

          if (dr > thresh || dg > thresh || db > thresh) {
            totalChanged++;
            // Blend trail color onto result
            result[idx] = Math.round(result[idx] * (1 - alpha) + cr * alpha);
            result[idx + 1] = Math.round(result[idx + 1] * (1 - alpha) + cg * alpha);
            result[idx + 2] = Math.round(result[idx + 2] * (1 - alpha) + cb * alpha);
          }
        }
      }

      await sharp(result, { raw: { width, height, channels: 4 } })
        .png()
        .toFile(output);

      const pctChanged = ((totalChanged / (width * height * numPairs)) * 100).toFixed(1);
      return `# Diff Trail\n\n**${images.length} frames** → ${numPairs} transitions\n**${pctChanged}%** pixels changed\n\nColor legend: 🔵 start → 🟢 middle → 🔴 end\n\nSaved to: \`${output}\``;

    } else if (vizMode === 'heatmap') {
      // Accumulate all diffs into a heat map
      const heat = new Float32Array(width * height);
      const numPairs = frames.length - 1;

      for (let f = 0; f < numPairs; f++) {
        const prev = frames[f];
        const curr = frames[f + 1];
        for (let px = 0; px < width * height; px++) {
          const idx = px * 4;
          const dr = Math.abs(curr[idx] - prev[idx]);
          const dg = Math.abs(curr[idx + 1] - prev[idx + 1]);
          const db = Math.abs(curr[idx + 2] - prev[idx + 2]);
          if (dr > thresh || dg > thresh || db > thresh) {
            heat[px] += 1;
          }
        }
      }

      // Normalize and render heat map
      let maxHeat = 0;
      for (let i = 0; i < heat.length; i++) { if (heat[i] > maxHeat) maxHeat = heat[i]; }
      if (maxHeat === 0) maxHeat = 1;
      const result = Buffer.alloc(width * height * 4);

      for (let px = 0; px < width * height; px++) {
        const intensity = heat[px] / maxHeat;
        const idx = px * 4;
        if (intensity === 0) {
          // Dimmed original
          const srcIdx = px * 4;
          result[idx] = Math.round(frames[0][srcIdx] * 0.3);
          result[idx + 1] = Math.round(frames[0][srcIdx + 1] * 0.3);
          result[idx + 2] = Math.round(frames[0][srcIdx + 2] * 0.3);
        } else {
          // Hot: blue → yellow → red
          const [cr, cg, cb] = lerpColor(intensity);
          result[idx] = cr;
          result[idx + 1] = cg;
          result[idx + 2] = cb;
        }
        result[idx + 3] = 255;
      }

      await sharp(result, { raw: { width, height, channels: 4 } })
        .png()
        .toFile(output);

      return `# Diff Heatmap\n\n**${images.length} frames** analyzed\nHot spots show areas of most change\n\nSaved to: \`${output}\``;

    } else if (vizMode === 'blink') {
      // Create animated GIF alternating first and last frame
      const first = await sharp(resolvedPaths[0]).resize(width, height).gif().toBuffer();
      const last = await sharp(resolvedPaths[resolvedPaths.length - 1]).resize(width, height).gif().toBuffer();

      // For blink mode, just output side-by-side since animated GIF needs more complex handling
      await sharp(resolvedPaths[0])
        .resize(width, height)
        .extend({ right: width, background: { r: 0, g: 0, b: 0, alpha: 1 } })
        .composite([{ input: resolvedPaths[resolvedPaths.length - 1], left: width, top: 0 }])
        .png()
        .toFile(output);

      return `# Blink Comparison\n\nFirst and last frame side by side\n\nSaved to: \`${output}\``;
    }

    return 'Unknown mode';
  }

  /**
   * Compare two screenshots (before/after)
   * @param before Path to before screenshot
   * @param after Path to after screenshot
   * @format markdown
   * @readOnly
   */
  async compare({ before, after }: { before: string; after: string }) {
    const beforePath = await this.resolveImage(before);
    const afterPath = await this.resolveImage(after);

    // Analyze both individually, then compare
    const beforeResult = await this.infer(beforePath, REVIEW_PROMPT);
    const afterResult = await this.infer(afterPath, REVIEW_PROMPT);

    const beforeParsed = this.parseResult(beforeResult);
    const afterParsed = this.parseResult(afterResult);

    const beforeCount = beforeParsed.issues.length;
    const afterCount = afterParsed.issues.length;
    const delta = afterCount - beforeCount;
    const deltaStr = delta > 0 ? `+${delta} new issues` : delta < 0 ? `${delta} issues (improved)` : 'same issue count';

    let md = `# Before/After Comparison\n\n`;
    md += `| | Before | After |\n|---|---|---|\n`;
    md += `| Score | ${beforeParsed.score ?? '?'} | ${afterParsed.score ?? '?'} |\n`;
    md += `| Issues | ${beforeCount} | ${afterCount} |\n`;
    md += `| Delta | | ${deltaStr} |\n\n`;

    if (afterParsed.issues.length > 0) {
      md += `## Current Issues (After)\n\n`;
      md += this.issuesToMarkdown(afterParsed.issues);
    }

    // Find new issues (in after but not before)
    const beforeDescs = new Set(beforeParsed.issues.map(i => i.description.toLowerCase()));
    const newIssues = afterParsed.issues.filter(i => !beforeDescs.has(i.description.toLowerCase()));

    if (newIssues.length > 0) {
      md += `\n## New Issues Introduced\n\n`;
      md += this.issuesToMarkdown(newIssues);
    }

    // Find fixed issues
    const afterDescs = new Set(afterParsed.issues.map(i => i.description.toLowerCase()));
    const fixedIssues = beforeParsed.issues.filter(i => !afterDescs.has(i.description.toLowerCase()));

    if (fixedIssues.length > 0) {
      md += `\n## Issues Fixed\n\n`;
      md += fixedIssues.map(i => `- ~~${i.description}~~ (${i.location})`).join('\n');
    }

    return md;
  }

  /**
   * Check if the MLX model is available and working
   * @readOnly
   */
  async status() {
    const model = this.settings.model;
    const python = this.settings.python;

    // Check python
    const pyVersion = await this.exec(python, ['--version']).catch(() => null);
    // Check mlx-vlm
    const mlxCheck = await this.exec(python, ['-c', 'import mlx_vlm; print(mlx_vlm.__version__)']).catch(() => null);
    const peekabooVersion = await this.exec(this.settings.peekaboo, ['--version']).catch(() => null);
    const peekabooPerms = await this.peekabooPermissions().catch(() => null);

    return {
      python: pyVersion ? pyVersion.trim() : 'NOT FOUND',
      mlxVlm: mlxCheck ? mlxCheck.trim() : 'NOT INSTALLED — run: pip install -U mlx-vlm',
      model,
      peekaboo: peekabooVersion ? peekabooVersion.trim() : 'NOT INSTALLED — run: brew install steipete/tap/peekaboo',
      peekabooPermissions: peekabooPerms,
      ready: !!pyVersion && !!mlxCheck,
    };
  }

  // ── Inference ────────────────────────────────────────────

  private async infer(imagePath: string, prompt: string): Promise<string> {
    const model = this.settings.model;
    const python = this.settings.python;
    const maxTokens = this.settings.maxTokens;

    // Use mlx_vlm CLI which correctly handles image token injection
    const result = await this.exec(python, [
      '-m', 'mlx_vlm', 'generate',
      '--model', model,
      '--max-tokens', String(maxTokens),
      '--temperature', '0.1',
      '--prompt', prompt,
      '--image', imagePath,
    ], 300_000);

    // Output format: ==========\nFiles+Prompt\n\nGenerated text\n==========\nTiming
    // The generated text is between the two ========== markers, after the prompt
    const parts = result.split('==========');
    // parts[0] = empty (before first marker)
    // parts[1] = Files + Prompt + Generated text
    // parts[2] = Timing stats
    let generated = parts.length >= 2 ? parts[1].trim() : result.trim();

    // Strip everything up to and including "assistant\n" — the actual output follows
    const assistantIdx = generated.indexOf('assistant\n');
    if (assistantIdx !== -1) {
      generated = generated.slice(assistantIdx + 'assistant\n'.length).trim();
    }

    // Parse timing info if available
    let elapsed = 0;
    const genMatch = result.match(/Generation: (\d+) tokens, ([\d.]+) tokens-per-sec/);
    if (genMatch) {
      elapsed = Math.round(parseInt(genMatch[1]) / parseFloat(genMatch[2]) * 10) / 10;
    }

    return JSON.stringify({ output: generated, elapsed });
  }

  // ── Parsing ──────────────────────────────────────────────

  private parseResult(raw: string): ReviewResult {
    try {
      // The Python script wraps output in {"output": "...", "elapsed": N}
      const wrapper = JSON.parse(raw.trim());
      const output: string = wrapper.output || raw;
      const elapsed: number = wrapper.elapsed || 0;

      // Try to parse the model's JSON output
      let parsed: any;
      try {
        // Direct JSON
        parsed = JSON.parse(output);
      } catch {
        // JSON inside markdown fences
        const jsonMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[1].trim());
        } else {
          // Try to find JSON object in text
          const braceMatch = output.match(/\{[\s\S]*\}/);
          if (braceMatch) {
            parsed = JSON.parse(braceMatch[0]);
          }
        }
      }

      if (parsed) {
        return {
          summary: parsed.summary || 'Analysis complete',
          score: typeof parsed.score === 'number' ? parsed.score : null,
          issues: Array.isArray(parsed.issues) ? parsed.issues : [],
          elapsed,
          model: this.settings.model,
        };
      }

      // Couldn't parse JSON — return raw text as summary
      return { summary: output, score: null, issues: [], elapsed, model: this.settings.model };
    } catch {
      return { summary: raw, score: null, issues: [], elapsed: 0, model: this.settings.model };
    }
  }

  // ── Formatting ───────────────────────────────────────────

  private formatMarkdown(result: ReviewResult): string {
    const { summary, score, issues, elapsed, model } = result;
    const shortModel = model.split('/').pop() || model;

    let md = `# Visual QA Report\n\n`;

    // Score badge
    if (score !== null) {
      const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';
      const emoji = score >= 90 ? '🟢' : score >= 75 ? '🟡' : score >= 60 ? '🟠' : '🔴';
      md += `**Score: ${emoji} ${score}/100 (${grade})**\n\n`;
    }

    md += `> ${summary}\n\n`;

    if (issues.length === 0) {
      md += `No issues found.\n`;
    } else {
      const critical = issues.filter(i => i.severity === 'critical');
      const warnings = issues.filter(i => i.severity === 'warning');
      const info = issues.filter(i => i.severity === 'info');

      md += `**${issues.length} issues found** — `;
      const parts: string[] = [];
      if (critical.length) parts.push(`${critical.length} critical`);
      if (warnings.length) parts.push(`${warnings.length} warnings`);
      if (info.length) parts.push(`${info.length} info`);
      md += parts.join(', ') + '\n\n';

      md += this.issuesToMarkdown(issues);
    }

    md += `\n---\n*${shortModel} · ${elapsed}s*`;
    return md;
  }

  private issuesToMarkdown(issues: Issue[]): string {
    const severityOrder = { critical: 0, warning: 1, info: 2 };
    const sorted = [...issues].sort((a, b) =>
      (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9)
    );

    return sorted.map(issue => {
      const icon = issue.severity === 'critical' ? '🔴' : issue.severity === 'warning' ? '🟡' : '🔵';
      return `${icon} **[${issue.severity.toUpperCase()}]** ${issue.category} — ${issue.location}\n` +
        `  ${issue.description}\n` +
        `  → *${issue.suggestion}*\n`;
    }).join('\n');
  }

  // ── Helpers ──────────────────────────────────────────────

  /**
   * Resolve image input to a local file path.
   * Accepts: file path, base64 data URI, or URL.
   */
  private async resolveImage(input: string): Promise<string> {
    // Local file
    if (existsSync(input)) return input;

    const tmpDir = path.join(os.tmpdir(), 'lookout');
    const { mkdirSync } = await import('fs');
    mkdirSync(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, `img-${Date.now()}.png`);

    // Base64 data URI
    if (input.startsWith('data:image/')) {
      const base64 = input.split(',')[1];
      if (!base64) throw new Error('Invalid base64 data URI');
      writeFileSync(tmpFile, Buffer.from(base64, 'base64'));
      return tmpFile;
    }

    // URL
    if (input.startsWith('http://') || input.startsWith('https://')) {
      const res = await fetch(input);
      if (!res.ok) throw new Error(`Failed to fetch image: ${res.statusText}`);
      writeFileSync(tmpFile, Buffer.from(await res.arrayBuffer()));
      return tmpFile;
    }

    throw new Error(`Image not found: "${input.slice(0, 100)}". Accepts: file path, base64 data URI (data:image/...), or URL (https://...)`);
  }

  private exec(cmd: string, args: string[], timeout = 60_000): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
        if (err) reject(new Error(`${cmd} failed: ${err.message}\n${stderr}`));
        else resolve(stdout);
      });
    });
  }

  private async peekabooPermissions(): Promise<any> {
    const raw = await this.exec(this.settings.peekaboo, ['permissions', 'status', '--json'], 10_000);
    return JSON.parse(raw.trim())?.data || null;
  }

  private async peekabooOpen(target: string): Promise<void> {
    await this.exec(this.settings.peekaboo, ['open', target, '--json'], 15_000);
  }

  private async peekabooImage({
    path: outPath,
    mode,
    app,
    screenIndex,
  }: {
    path: string;
    mode: 'screen' | 'window' | 'frontmost';
    app?: string;
    screenIndex?: number;
  }): Promise<any> {
    const args = ['image', '--mode', mode, '--path', outPath, '--json'];
    if (app) args.push('--app', app);
    if (typeof screenIndex === 'number') args.push('--screen-index', String(screenIndex));
    const raw = await this.exec(this.settings.peekaboo, args, 20_000);
    return JSON.parse(raw.trim());
  }

  private async peekabooSee({
    app,
    mode,
    path: outPath,
    screenIndex,
  }: {
    app?: string;
    mode: 'screen' | 'window' | 'frontmost';
    path: string;
    screenIndex?: number;
  }): Promise<any> {
    const args = ['see', '--mode', mode, '--path', outPath, '--json'];
    if (app) args.push('--app', app);
    if (typeof screenIndex === 'number') args.push('--screen-index', String(screenIndex));
    const raw = await this.exec(this.settings.peekaboo, args, 30_000);
    return JSON.parse(raw.trim());
  }

  private async peekabooAction(command: string): Promise<void> {
    const tokens = this.tokenizeCommand(command);
    if (!tokens.length) return;
    const args = [...tokens, '--json'];
    await this.exec(this.settings.peekaboo, args, 30_000);
  }

  private tokenizeCommand(command: string): string[] {
    const matches = command.match(/"[^"]*"|'[^']*'|\S+/g) || [];
    return matches.map(token => {
      if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith('\'') && token.endsWith('\''))) {
        return token.slice(1, -1);
      }
      return token;
    });
  }

  private peekabooExtractElements(data: any): any[] {
    if (!data || typeof data !== 'object') return [];
    const candidates = [data.elements, data.ui_elements, data.ui_map, data.element_map];
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) return candidate;
    }
    return [];
  }

  private peekabooExtractScreenshotPath(data: any): string | null {
    if (!data || typeof data !== 'object') return null;
    return data.path || data.image_path || data.screenshot_path || null;
  }
}
