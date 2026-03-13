/**
 * claw.test.ts — integration tests for the WhatsApp ↔ agent pipeline.
 *
 * HOW IT WORKS:
 *   1. Reads claw.status() to verify the daemon is running and WhatsApp connected
 *   2. Sends a trigger message via the daemon's whatsapp instance (photon cli)
 *   3. Polls the group's run log directory for a new success entry
 *   4. Asserts the agent processed the message and produced output
 *
 * PREREQUISITES:
 *   photon claw start                          (claw must be running)
 *   photon whatsapp connect                    (WhatsApp must be connected)
 *   photon claw register --group "..."  ...    (at least one group registered)
 *
 * CONFIGURATION (env vars):
 *   TEST_CLAW_GROUP    Partial group name match (default: "Arul and Lura")
 *   TEST_CLAW_TRIGGER  Trigger word (default: "@")
 *   TEST_CLAW_FOLDER   Primary folder name under baseDir (default: "lura")
 *   TEST_BASE_DIR      Base dir for group folders (default: ~/Projects)
 *   TEST_TIMEOUT_MS    Max wait for agent to complete (default: 120000)
 *
 * USAGE:
 *   photon test claw
 *   TEST_CLAW_GROUP="My Group" TEST_CLAW_FOLDER="my-folder" photon test claw
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ── Configuration ─────────────────────────────────────────────────────────────

const CONFIG = {
  group:       process.env.TEST_CLAW_GROUP   ?? 'Arul and Lura',
  trigger:     process.env.TEST_CLAW_TRIGGER ?? '@',
  groupFolder: process.env.TEST_CLAW_FOLDER  ?? 'lura',
  baseDir:     process.env.TEST_BASE_DIR     ?? path.join(os.homedir(), 'Projects'),
  timeoutMs:   Number(process.env.TEST_TIMEOUT_MS ?? 120_000),
  pollMs:      2_000,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Run a photon CLI command against the daemon. Throws if it fails. */
function photonCli(...args: string[]): string {
  return execFileSync('photon', ['cli', ...args], {
    encoding: 'utf8',
    timeout: 10_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

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
 * PREREQUISITE CHECK — call this at the top of each integration test.
 * Throws a descriptive error if claw isn't in a testable state.
 */
async function assertPrerequisites(photon: any): Promise<void> {
  const status = await photon.status();

  if (!status.running) {
    throw new Error(
      'Prerequisite not met: claw is not running.\n' +
      'Fix: photon claw start',
    );
  }
  if (status.whatsapp?.status !== 'connected') {
    throw new Error(
      `Prerequisite not met: WhatsApp not connected (status: ${status.whatsapp?.status}).\n` +
      'Fix: photon whatsapp connect',
    );
  }

  const match = status.groups?.find((g: any) =>
    g.name?.toLowerCase().includes(CONFIG.group.toLowerCase()),
  );
  if (!match) {
    throw new Error(
      `Prerequisite not met: no registered group matching "${CONFIG.group}".\n` +
      `Fix: photon claw register --group "${CONFIG.group}" --trigger "${CONFIG.trigger}" --folders "${CONFIG.groupFolder}"`,
    );
  }
}

/**
 * End-to-end pipeline: send trigger message → agent runs → success log appears.
 *
 * Sends a message as ourselves (fromMe:true) — claw routes it to the agent
 * runner, which writes a JSON log entry on completion. We poll that log dir
 * to verify the run succeeded within the timeout.
 */
export async function testPipelineTriggersAgentAndSucceeds(photon: any) {
  await assertPrerequisites(photon);

  const logDir = path.join(CONFIG.baseDir, CONFIG.groupFolder, 'logs');
  const baseline = await latestLog(logDir);
  const baselineMtime = baseline?.mtime ?? 0;

  const triggerText = `${CONFIG.trigger} integration test — reply with exactly: pong`;

  // Send the trigger message via the daemon's live whatsapp instance.
  // It arrives as fromMe:true, which claw routes to the configured agent.
  photonCli('whatsapp', 'send', '--chat', CONFIG.group, '--text', triggerText);
  console.log(`  → Sent: "${triggerText}"`);
  console.log(`  → Polling: ${logDir}`);

  const deadline = Date.now() + CONFIG.timeoutMs;
  const log = await pollForNewLog(logDir, baselineMtime, deadline);

  if (!log) {
    throw new Error(
      `No agent run log appeared in ${logDir} within ${CONFIG.timeoutMs / 1000}s.\n` +
      `Check:\n` +
      `  • Group "${CONFIG.group}" has trigger "${CONFIG.trigger}" set\n` +
      `  • TEST_CLAW_FOLDER ("${CONFIG.groupFolder}") matches the group's primary folder\n` +
      `  • The runner is not at capacity (photon cli claude-runner status)`,
    );
  }
  if (log.status !== 'success') {
    throw new Error(`Agent run failed:\n${JSON.stringify(log, null, 2)}`);
  }
  if (!log.result) {
    throw new Error('Agent run succeeded but produced empty output');
  }

  console.log(`  ✓ Completed in ${log.duration}ms`);
  console.log(`  ✓ Response: "${String(log.result).slice(0, 200)}"`);
}

/**
 * Memory continuity: second prompt references context from the first.
 *
 * Runs two sequential messages. The second asks what was said before.
 * A working memory layer causes the agent to recall the first message.
 */
export async function testMemoryInjectionAcrossRuns(photon: any) {
  await assertPrerequisites(photon);

  const logDir = path.join(CONFIG.baseDir, CONFIG.groupFolder, 'logs');
  const UNIQUE_TOKEN = `memtest-${Date.now()}`;

  // ── First run: plant a unique token ──────────────────────────────────────
  let baseline = await latestLog(logDir);
  photonCli('whatsapp', 'send', '--chat', CONFIG.group, '--text',
    `${CONFIG.trigger} remember this token: ${UNIQUE_TOKEN}`,
  );
  console.log(`  → Run 1: planted token ${UNIQUE_TOKEN}`);

  const deadline1 = Date.now() + CONFIG.timeoutMs;
  const log1 = await pollForNewLog(logDir, baseline?.mtime ?? 0, deadline1);
  if (!log1 || log1.status !== 'success') {
    throw new Error(`First run failed:\n${JSON.stringify(log1, null, 2)}`);
  }
  console.log(`  ✓ Run 1 completed (${log1.duration}ms)`);

  // ── Second run: ask it to recall ─────────────────────────────────────────
  baseline = await latestLog(logDir);
  photonCli('whatsapp', 'send', '--chat', CONFIG.group, '--text',
    `${CONFIG.trigger} what token did I ask you to remember?`,
  );
  console.log('  → Run 2: asking for recall');

  const deadline2 = Date.now() + CONFIG.timeoutMs;
  const log2 = await pollForNewLog(logDir, baseline?.mtime ?? 0, deadline2);
  if (!log2 || log2.status !== 'success') {
    throw new Error(`Second run failed:\n${JSON.stringify(log2, null, 2)}`);
  }
  console.log(`  ✓ Run 2 completed (${log2.duration}ms)`);
  console.log(`  ✓ Response: "${String(log2.result).slice(0, 300)}"`);

  // The response should contain the token we planted in run 1
  if (!String(log2.result).includes(UNIQUE_TOKEN)) {
    throw new Error(
      `Memory injection failed: token "${UNIQUE_TOKEN}" not found in run 2 response.\n` +
      `Response was: "${String(log2.result).slice(0, 300)}"`,
    );
  }
}

/**
 * Per-group agent routing: configure a group to use a different agent
 * and verify the run still succeeds (agent binary must be installed).
 *
 * Uses an env var to specify which agent to test — skip if not set.
 */
export async function testAgentRouting(photon: any) {
  const targetAgent = process.env.TEST_CLAW_AGENT;
  if (!targetAgent) {
    throw new Error(
      'Prerequisite not met: set TEST_CLAW_AGENT to the agent to test (e.g. gemini, aider).',
    );
  }

  await assertPrerequisites(photon);

  // Switch the group to the target agent
  await photon.configure({ group: CONFIG.group, agent: targetAgent });
  console.log(`  → Configured group to use agent: ${targetAgent}`);

  const logDir = path.join(CONFIG.baseDir, CONFIG.groupFolder, 'logs');
  const baseline = await latestLog(logDir);

  const triggerText = `${CONFIG.trigger} integration test via ${targetAgent} — reply with: pong`;
  photonCli('whatsapp', 'send', '--chat', CONFIG.group, '--text', triggerText);
  console.log(`  → Sent via ${targetAgent}: "${triggerText}"`);

  const deadline = Date.now() + CONFIG.timeoutMs;
  const log = await pollForNewLog(logDir, baseline?.mtime ?? 0, deadline);

  // Restore to claude regardless of outcome
  await photon.configure({ group: CONFIG.group, agent: 'claude' });
  console.log('  → Restored group to claude');

  if (!log) {
    throw new Error(`No run log appeared within ${CONFIG.timeoutMs / 1000}s for agent ${targetAgent}`);
  }
  if (log.status !== 'success') {
    throw new Error(`Agent "${targetAgent}" run failed:\n${JSON.stringify(log, null, 2)}`);
  }

  console.log(`  ✓ ${targetAgent} completed in ${log.duration}ms`);
  console.log(`  ✓ Response: "${String(log.result).slice(0, 200)}"`);
}
