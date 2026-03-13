/**
 * claw.test.ts — E2E integration test for the WhatsApp ↔ agent pipeline.
 *
 * Sends a real trigger message to the configured WhatsApp group via the
 * running daemon, then polls the claude-runner's log directory to verify
 * the agent completed successfully.
 *
 * PREREQUISITES:
 *   photon daemon start
 *   photon claw start
 *   photon whatsapp connect
 *   Group registered: photon cli claw register --group "Arul and Lura" ...
 *
 * CONFIGURATION (env vars):
 *   TEST_CLAW_GROUP         WhatsApp group name (default: "Arul and Lura")
 *   TEST_CLAW_TRIGGER       Trigger prefix (default: "@")
 *   TEST_CLAW_FOLDER        Group's folder name (default: derived from group name)
 *   TEST_TIMEOUT_MS         Max ms to wait for agent (default: 120000)
 *
 * USAGE:
 *   photon test claw
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ── Configuration ─────────────────────────────────────────────────────────────

const CONFIG = {
  group:     process.env.TEST_CLAW_GROUP   ?? 'Arul and Lura',
  trigger:   process.env.TEST_CLAW_TRIGGER ?? '@',
  folder:    process.env.TEST_CLAW_FOLDER  ?? '',
  timeoutMs: Number(process.env.TEST_TIMEOUT_MS ?? 120_000),
  pollMs:    2_000,
  baseDir:   path.join(os.homedir(), 'Projects'),
};

// ── CLI helpers ───────────────────────────────────────────────────────────────

function photonCli(...args: string[]): string {
  return execFileSync('photon', ['cli', ...args], {
    encoding: 'utf8',
    timeout: 15_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

// ── Log polling ───────────────────────────────────────────────────────────────

async function latestLogMtime(logDir: string): Promise<number> {
  try {
    const files = (await fs.promises.readdir(logDir))
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse();
    if (!files.length) return 0;
    const stat = await fs.promises.stat(path.join(logDir, files[0]));
    return stat.mtimeMs;
  } catch { return 0; }
}

async function pollForNewLog(
  logDir: string,
  afterMtime: number,
  deadline: number,
): Promise<Record<string, any> | null> {
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, CONFIG.pollMs));
    try {
      const files = (await fs.promises.readdir(logDir))
        .filter(f => f.endsWith('.json'))
        .sort()
        .reverse();
      if (files.length) {
        const filePath = path.join(logDir, files[0]);
        const stat = await fs.promises.stat(filePath);
        if (stat.mtimeMs > afterMtime) {
          return JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
        }
      }
    } catch { /* keep polling */ }
  }
  return null;
}

// ── Test ─────────────────────────────────────────────────────────────────────

/**
 * Sends a trigger message to the WhatsApp group via the live daemon,
 * waits for the claude-runner to process it, and verifies success
 * by polling the group's log directory.
 *
 * You should see the trigger message appear in your WhatsApp group,
 * and the agent's response sent back.
 */
export async function testClaudeAgentViaWhatsApp(_photon: any) {
  // ── 1. Check daemon claw is running ───────────────────────────────
  let statusOut: string;
  try {
    statusOut = photonCli('claw', 'status');
  } catch {
    throw new Error(
      'Cannot reach daemon claw.\n' +
      'Fix: photon daemon start && photon claw start',
    );
  }

  if (!statusOut.includes('running: true') && !statusOut.includes('Running: true')) {
    throw new Error('Claw is not running. Fix: photon claw start');
  }

  if (!statusOut.includes('connected')) {
    throw new Error('WhatsApp not connected. Fix: photon whatsapp connect');
  }

  // ── 2. Resolve group folder and log dir ───────────────────────────
  //
  // Try to find the folder from the claw groups listing.
  // Fall back to TEST_CLAW_FOLDER or a sanitised version of the group name.
  let groupFolder = CONFIG.folder;
  if (!groupFolder) {
    try {
      const groupsOut = photonCli('claw', 'groups');
      // Table output has lines like: "Arul and Lura  true   arul-lura"
      // Look for a line matching the group name and extract folder tokens
      const lines = groupsOut.split('\n');
      const match = lines.find(l => l.toLowerCase().includes(CONFIG.group.toLowerCase()));
      if (match) {
        // Last non-empty token on the line is typically the folder
        const tokens = match.trim().split(/\s{2,}/);
        if (tokens.length >= 1) groupFolder = tokens[tokens.length - 1].trim();
      }
    } catch { /* groups listing is optional */ }
  }

  // Fallback: sanitise group name to a likely folder name
  if (!groupFolder) {
    groupFolder = CONFIG.group.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  const groupDir = path.isAbsolute(groupFolder)
    ? groupFolder
    : path.join(CONFIG.baseDir, groupFolder);
  const logDir = path.join(groupDir, 'logs');

  console.log(`  → Group folder: ${groupDir}`);

  // ── 3. Snapshot baseline ──────────────────────────────────────────
  const baselineMtime = await latestLogMtime(logDir);

  // ── 4. Send trigger message ───────────────────────────────────────
  const triggerText = `${CONFIG.trigger} integration test — reply with: pong`;
  try {
    photonCli('whatsapp', 'send', '--chat', CONFIG.group, '--text', triggerText);
  } catch (err: any) {
    throw new Error(`Failed to send WhatsApp message: ${err.message}`);
  }
  console.log(`  → Sent: "${triggerText}" → "${CONFIG.group}"`);
  console.log(`  → Polling: ${logDir} (timeout: ${CONFIG.timeoutMs / 1000}s)`);

  // ── 5. Poll for agent completion ──────────────────────────────────
  const log = await pollForNewLog(logDir, baselineMtime, Date.now() + CONFIG.timeoutMs);

  if (!log) {
    throw new Error(
      `No log appeared in ${logDir} within ${CONFIG.timeoutMs / 1000}s.\n` +
      `Checklist:\n` +
      `  • Group "${CONFIG.group}" is registered: photon cli claw groups\n` +
      `  • Trigger "${CONFIG.trigger}" matches the group's config\n` +
      `  • Set TEST_CLAW_FOLDER if the folder name differs from "${groupFolder}"`,
    );
  }

  if (log.status !== 'success') {
    throw new Error(`Agent run failed:\n${JSON.stringify(log, null, 2)}`);
  }

  console.log(`  ✓ Agent completed in ${log.duration}ms`);
  console.log(`  ✓ Response: "${String(log.result ?? log.output).slice(0, 200)}"`);
}
