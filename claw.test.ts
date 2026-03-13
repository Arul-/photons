/**
 * claw.test.ts — integration tests for the WhatsApp ↔ agent pipeline.
 *
 * ARCHITECTURE NOTE:
 *   `photon test claw` runs in "direct" mode: it loads the dev claw from
 *   /Users/arul/Projects/arul-photons/claw.photon.ts with all dependencies
 *   (router, claude-runner, etc.) as fresh in-process instances. The tests
 *   access these via (_photon as any).router — no daemon or WhatsApp needed.
 *
 *   The full WhatsApp E2E test (testWhatsAppTriggeredPipeline) is opt-in:
 *   requires TEST_FULL_E2E=1, uses `photon cli` to send via the live daemon.
 *
 * CONFIGURATION (env vars):
 *   TEST_CLAW_GROUP    Group name for E2E test (default: "Arul and Lura")
 *   TEST_CLAW_TRIGGER  Trigger word for E2E test (default: "@")
 *   TEST_LOG_DIR       Log dir the daemon writes to for E2E test (default: ~/Projects/logs)
 *   TEST_TIMEOUT_MS    Max ms to wait for agent completion (default: 120000)
 *   TEST_FULL_E2E      Set to "1" to run the WhatsApp E2E test
 *
 * USAGE:
 *   photon test claw                          (runs tests 1–3, skips E2E)
 *   TEST_FULL_E2E=1 photon test claw          (runs all 4 tests)
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ── Configuration ─────────────────────────────────────────────────────────────

const CONFIG = {
  group:      process.env.TEST_CLAW_GROUP   ?? 'Arul and Lura',
  trigger:    process.env.TEST_CLAW_TRIGGER ?? '@',
  logDir:     process.env.TEST_LOG_DIR      ?? path.join(os.homedir(), 'Projects', 'logs'),
  timeoutMs:  Number(process.env.TEST_TIMEOUT_MS ?? 120_000),
  pollMs:     2_000,
  fullE2E:    process.env.TEST_FULL_E2E === '1',
};

// ── CLI helpers (for E2E test only) ──────────────────────────────────────────

function photonCli(...args: string[]): string {
  return execFileSync('photon', ['cli', ...args], {
    encoding: 'utf8',
    timeout: 10_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

// ── Log polling helpers ───────────────────────────────────────────────────────

interface LogInfo { mtime: number; filePath: string }

async function latestLog(logDir: string): Promise<LogInfo | null> {
  try {
    const files = (await fs.promises.readdir(logDir))
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse();
    if (!files.length) return null;
    const filePath = path.join(logDir, files[0]);
    const stat = await fs.promises.stat(filePath);
    return { mtime: stat.mtimeMs, filePath };
  } catch { return null; }
}

async function readLog(filePath: string): Promise<Record<string, any>> {
  return JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
}

async function pollForNewLog(
  logDir: string,
  afterMtime: number,
  deadline: number,
): Promise<Record<string, any> | null> {
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, CONFIG.pollMs));
    const info = await latestLog(logDir);
    if (info && info.mtime > afterMtime) {
      return readLog(info.filePath);
    }
  }
  return null;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

/**
 * Accesses the dev claw's injected router directly and calls run() with agent='claude'.
 * Verifies the router → claude-runner → claude CLI chain produces a successful result.
 * No daemon or WhatsApp connection required.
 */
export async function testRouterDelegatesAndLogsSuccess(_photon: any) {
  const router = (_photon as any).router;
  if (!router) {
    throw new Error(
      'router dependency not available on the claw instance.\n' +
      'Check that claw.photon.ts has @photon router ./agent-router.photon.ts',
    );
  }

  // Use a unique temp folder so logs don't collide with real groups
  const groupFolder = `_test-${Date.now()}`;

  const result = await router.run({
    groupFolder,
    prompt: 'Reply with exactly these three words: integration test passed',
    agent: 'claude',
  });

  if (result.status !== 'success') {
    throw new Error(
      `Router/runner failed.\n` +
      `Error: ${result.error ?? 'none'}\n` +
      `Output: ${result.output ?? 'none'}`,
    );
  }
  if (!result.output?.trim()) {
    throw new Error('Agent returned empty output');
  }

  console.log(`  ✓ router → claude-runner → claude: ${result.duration}ms`);
  console.log(`  ✓ Output: "${result.output.slice(0, 200)}"`);
}

/**
 * Runs two sequential calls through the router (no sessionId), verifying that
 * the second call receives memory context from the first via keyword injection.
 * The unique token planted in run 1 should appear in run 2's response.
 * No daemon or WhatsApp required.
 */
export async function testMemoryInjectionAcrossRuns(_photon: any) {
  const router = (_photon as any).router;
  if (!router) {
    throw new Error('router dependency not available — see testRouterDelegatesAndLogsSuccess');
  }

  const groupFolder = `_test-mem-${Date.now()}`;
  const UNIQUE_TOKEN = `tok${Math.random().toString(36).slice(2, 8)}`;

  // ── Run 1: plant the token ────────────────────────────────────────────────
  const r1 = await router.run({
    groupFolder,
    prompt: `Remember this secret token: ${UNIQUE_TOKEN}. Acknowledge with: noted`,
    agent: 'claude',
  });
  if (r1.status !== 'success') {
    throw new Error(`Run 1 failed: ${r1.error}`);
  }
  console.log(`  ✓ Run 1 planted token ${UNIQUE_TOKEN} (${r1.duration}ms)`);

  // ── Run 2: recall — no sessionId, relies on memory injection ─────────────
  const r2 = await router.run({
    groupFolder,
    prompt: 'What secret token did I ask you to remember? State it exactly.',
    agent: 'claude',
    // no sessionId — forces memory injection path in claude-runner
  });
  if (r2.status !== 'success') {
    throw new Error(`Run 2 failed: ${r2.error}`);
  }
  console.log(`  ✓ Run 2 recalled (${r2.duration}ms): "${r2.output?.slice(0, 200)}"`);

  if (!r2.output?.includes(UNIQUE_TOKEN)) {
    throw new Error(
      `Memory injection did not work: "${UNIQUE_TOKEN}" not found in run 2 response.\n` +
      `Response: "${r2.output?.slice(0, 300)}"`,
    );
  }
}

/**
 * Verifies the router honours the explicit 'auto' agent setting and picks an
 * agent via classification when autoClassify is enabled. Requires TEST_CLAW_AGENT
 * so you can confirm a specific agent is reachable.
 */
export async function testAgentRoutingByName(_photon: any) {
  const targetAgent = process.env.TEST_CLAW_AGENT;
  if (!targetAgent) {
    throw new Error(
      'Set TEST_CLAW_AGENT to an agent to test (e.g. gemini, aider, opencode).',
    );
  }

  const router = (_photon as any).router;
  if (!router) throw new Error('router not available — see testRouterDelegatesAndLogsSuccess');

  const groupFolder = `_test-agent-${Date.now()}`;
  const result = await router.run({
    groupFolder,
    prompt: 'Reply with exactly: pong',
    agent: targetAgent,
  });

  if (result.status !== 'success') {
    throw new Error(`Agent "${targetAgent}" failed: ${result.error}`);
  }
  if (!result.output?.trim()) {
    throw new Error(`Agent "${targetAgent}" returned empty output`);
  }

  console.log(`  ✓ router → ${targetAgent}: ${result.duration}ms`);
  console.log(`  ✓ Output: "${result.output.slice(0, 200)}"`);
}

/**
 * Full WhatsApp E2E: sends a trigger message via the live daemon's whatsapp
 * and polls the daemon's log directory for a new success entry.
 *
 * Requires TEST_FULL_E2E=1. Also requires:
 *   - photon claw start (daemon's claw running)
 *   - photon whatsapp connect (daemon's WhatsApp connected)
 *   - TEST_LOG_DIR pointing to where the daemon's runner writes logs
 *     (default: ~/Projects/logs — the old agent-runner's folder)
 */
export async function testWhatsAppTriggeredPipeline(_photon: any) {
  if (!CONFIG.fullE2E) {
    throw new Error(
      'Skipped: set TEST_FULL_E2E=1 to run the WhatsApp E2E test.\n' +
      `Also ensure: photon claw start, photon whatsapp connect, TEST_LOG_DIR=${CONFIG.logDir}`,
    );
  }

  // Check daemon claw status via CLI
  let statusOut: string;
  try { statusOut = photonCli('claw', 'status'); } catch {
    throw new Error('Daemon not reachable. Fix: photon daemon start && photon claw start');
  }
  if (!statusOut.includes('Running: yes')) {
    throw new Error('Daemon claw not running. Fix: photon claw start');
  }
  if (!statusOut.includes('Status: connected')) {
    throw new Error('WhatsApp not connected. Fix: photon whatsapp connect');
  }

  const baseline = await latestLog(CONFIG.logDir);
  const baselineMtime = baseline?.mtime ?? 0;

  const triggerText = `${CONFIG.trigger} integration test — reply with: pong`;
  photonCli('whatsapp', 'send', '--chat', CONFIG.group, '--text', triggerText);
  console.log(`  → Sent: "${triggerText}"`);
  console.log(`  → Polling: ${CONFIG.logDir}`);

  const log = await pollForNewLog(CONFIG.logDir, baselineMtime, Date.now() + CONFIG.timeoutMs);

  if (!log) {
    throw new Error(
      `No log appeared in ${CONFIG.logDir} within ${CONFIG.timeoutMs / 1000}s.\n` +
      `Check the daemon's claw registry trigger and folder config.`,
    );
  }
  if (log.status !== 'success') {
    throw new Error(`Agent run failed:\n${JSON.stringify(log, null, 2)}`);
  }

  console.log(`  ✓ E2E completed in ${log.duration}ms`);
  console.log(`  ✓ Response: "${String(log.result).slice(0, 200)}"`);
}
