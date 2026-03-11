#!/usr/bin/env tsx
/**
 * Migrates from nanoclaw to the Claw photon system.
 *
 * Full lifecycle:
 *   1. Stop nanoclaw (unload launchd agent)
 *   2. Wait for process to exit
 *   3. Import all data (groups, sessions, auth, messages, tasks)
 *   4. Start claw
 *
 * Usage:
 *   tsx claw-import.ts [--nanoclaw-dir /path/to/nanoclaw] [--dry-run]
 *
 * To rollback:
 *   tsx claw-rollback.ts
 */

import { execSync, spawn } from 'child_process';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ─── Config ────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const nanoclawIdx = args.indexOf('--nanoclaw-dir');
const NANOCLAW_DIR = nanoclawIdx >= 0
  ? args[nanoclawIdx + 1]
  : path.join(os.homedir(), 'Projects', 'nanoclaw');

const PHOTON_HOME = path.join(os.homedir(), '.photon');
const BRIDGE_AUTH_DIR = path.join(PHOTON_HOME, 'whatsapp-bridge', 'auth');
const RUNNER_GROUPS_DIR = path.join(PHOTON_HOME, 'agent-runner', 'groups');
const MEMORY_DIR = path.join(PHOTON_HOME, 'state');
const MIGRATION_STATE = path.join(PHOTON_HOME, 'claw-migration.json');

// Nanoclaw sources
const DB_PATH = path.join(NANOCLAW_DIR, 'store', 'messages.db');
const AUTH_DIR = path.join(NANOCLAW_DIR, 'store', 'auth');
const GROUPS_DIR = path.join(NANOCLAW_DIR, 'groups');

const LAUNCHD_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.nanoclaw.plist');

// ─── Helpers ───────────────────────────────────────────────────

function log(msg: string) {
  console.log(dryRun ? `[DRY RUN] ${msg}` : msg);
}

function ensureDir(dir: string) {
  if (!dryRun) fs.mkdirSync(dir, { recursive: true });
}

function writeJson(filePath: string, data: any) {
  ensureDir(path.dirname(filePath));
  if (!dryRun) fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  log(`  Wrote ${filePath}`);
}

function copyDir(src: string, dest: string) {
  if (!fs.existsSync(src)) return;
  ensureDir(dest);
  if (dryRun) {
    log(`  Would copy ${src} → ${dest}`);
    return;
  }
  fs.cpSync(src, dest, { recursive: true });
  log(`  Copied ${src} → ${dest}`);
}

function exec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 15000 }).trim();
  } catch {
    return '';
  }
}

function isNanoclawRunning(): boolean {
  const result = exec('ps aux');
  return result.includes('nanoclaw/dist/index.js');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Validate ──────────────────────────────────────────────────

console.log(`\n🦞 Claw Migration Tool`);
console.log(`======================`);
console.log(`Source:    ${NANOCLAW_DIR}`);
console.log(`Target:    ${PHOTON_HOME}`);
console.log(`Dry run:   ${dryRun}\n`);

if (!fs.existsSync(DB_PATH)) {
  console.error(`Database not found: ${DB_PATH}`);
  console.error(`Make sure --nanoclaw-dir points to your nanoclaw installation.`);
  process.exit(1);
}

// ─── Step 0: Stop nanoclaw ─────────────────────────────────────

console.log('0. Stopping nanoclaw');

const hasLaunchd = fs.existsSync(LAUNCHD_PLIST);
const wasRunning = isNanoclawRunning();

if (wasRunning) {
  if (hasLaunchd) {
    log(`  Found launchd agent: ${LAUNCHD_PLIST}`);
    if (!dryRun) {
      exec(`launchctl unload "${LAUNCHD_PLIST}"`);
      log(`  Unloaded com.nanoclaw from launchd`);
    } else {
      log(`  Would unload com.nanoclaw from launchd`);
    }
  } else {
    // No launchd — just kill the process
    log(`  No launchd agent found, sending SIGTERM`);
    if (!dryRun) {
      exec(`pkill -f "nanoclaw/dist/index.js"`);
    } else {
      log(`  Would kill nanoclaw process`);
    }
  }

  // Wait for nanoclaw to actually stop
  if (!dryRun) {
    let waited = 0;
    while (isNanoclawRunning() && waited < 10000) {
      await sleep(500);
      waited += 500;
    }
    if (isNanoclawRunning()) {
      console.error('  ERROR: nanoclaw did not stop within 10s. Aborting.');
      console.error('  You may need to manually kill it: kill $(pgrep -f nanoclaw)');
      process.exit(1);
    }
    log(`  nanoclaw stopped (took ${waited}ms)`);
  }
} else {
  log('  nanoclaw is not running');
}

// ─── Step 1: Import WhatsApp Auth ──────────────────────────────

const db = new Database(DB_PATH, { readonly: true });

console.log('\n1. WhatsApp Authentication');
if (fs.existsSync(AUTH_DIR)) {
  const authFiles = fs.readdirSync(AUTH_DIR);
  log(`  Found ${authFiles.length} auth files in nanoclaw`);

  ensureDir(path.dirname(BRIDGE_AUTH_DIR));
  if (!dryRun) {
    if (fs.existsSync(BRIDGE_AUTH_DIR)) {
      if (fs.lstatSync(BRIDGE_AUTH_DIR).isSymbolicLink()) {
        const target = fs.readlinkSync(BRIDGE_AUTH_DIR);
        if (target === AUTH_DIR) {
          log(`  Already symlinked correctly`);
        } else {
          fs.unlinkSync(BRIDGE_AUTH_DIR);
          fs.symlinkSync(AUTH_DIR, BRIDGE_AUTH_DIR);
          log(`  Updated symlink → ${AUTH_DIR}`);
        }
      } else {
        const backup = `${BRIDGE_AUTH_DIR}.backup-${Date.now()}`;
        fs.renameSync(BRIDGE_AUTH_DIR, backup);
        fs.symlinkSync(AUTH_DIR, BRIDGE_AUTH_DIR);
        log(`  Backed up existing, symlinked → ${AUTH_DIR}`);
      }
    } else {
      fs.symlinkSync(AUTH_DIR, BRIDGE_AUTH_DIR);
      log(`  Symlinked → ${AUTH_DIR}`);
    }
  } else {
    log(`  Would symlink ${BRIDGE_AUTH_DIR} → ${AUTH_DIR}`);
  }
} else {
  log('  No auth directory found — will need QR scan on first connect');
}

// ─── Step 2: Import Registered Groups ──────────────────────────

console.log('\n2. Registered Groups → message-router');

const rows = db.prepare('SELECT * FROM registered_groups').all() as any[];
const registry: Record<string, any> = {};

for (const row of rows) {
  registry[row.jid] = {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    requiresTrigger: row.requires_trigger === 1,
    addedAt: row.added_at,
  };
  log(`  Group: ${row.name} (${row.jid}) → folder: ${row.folder}, trigger: ${row.trigger_pattern}`);
}

const routerMemoryDir = path.join(MEMORY_DIR, 'message-router', 'default');
writeJson(path.join(routerMemoryDir, 'registry.json'), registry);
log(`  Imported ${rows.length} groups`);

// ─── Step 3: Import Sessions ───────────────────────────────────

console.log('\n3. Sessions → claw orchestrator');
const sessions = db.prepare('SELECT * FROM sessions').all() as any[];
const sessionMap: Record<string, string> = {};

for (const s of sessions) {
  sessionMap[s.group_folder] = s.session_id;
  log(`  Session: ${s.group_folder} → ${s.session_id}`);
}

const clawMemoryDir = path.join(MEMORY_DIR, 'claw', 'default');
writeJson(path.join(clawMemoryDir, 'sessionMap.json'), sessionMap);
log(`  Imported ${sessions.length} sessions`);

// ─── Step 4: Copy Group Folders ────────────────────────────────

console.log('\n4. Group Folders → agent-runner');
if (fs.existsSync(GROUPS_DIR)) {
  const folders = fs.readdirSync(GROUPS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory());

  for (const folder of folders) {
    const src = path.join(GROUPS_DIR, folder.name);
    const dest = path.join(RUNNER_GROUPS_DIR, folder.name);

    if (fs.existsSync(dest)) {
      log(`  Skipping ${folder.name} — already exists`);
      continue;
    }

    copyDir(src, dest);
  }
  log(`  Processed ${folders.length} group folders`);
} else {
  log('  No groups directory found');
}

// ─── Step 5: Import Recent Messages ────────────────────────────

console.log('\n5. Recent Message History');
const chatJids = Object.keys(registry);
let totalMessages = 0;

const messageHistory: Record<string, any[]> = {};

for (const jid of chatJids) {
  const messages = db.prepare(
    `SELECT sender, sender_name, content, timestamp, is_from_me, is_bot_message
     FROM messages
     WHERE chat_jid = ?
     ORDER BY timestamp DESC
     LIMIT 50`
  ).all(jid) as any[];

  if (messages.length > 0) {
    messageHistory[jid] = messages.reverse().map(m => ({
      from: m.sender,
      pushName: m.sender_name,
      text: m.content,
      fromMe: m.is_from_me === 1,
      isBotMessage: m.is_bot_message === 1,
      timestamp: new Date(m.timestamp).getTime() / 1000,
    }));
    totalMessages += messages.length;
    log(`  ${registry[jid].name}: ${messages.length} messages`);
  }
}

writeJson(path.join(routerMemoryDir, 'messageHistory.json'), messageHistory);
log(`  Imported ${totalMessages} messages across ${chatJids.length} chats`);

// ─── Step 6: Import Scheduled Tasks ───────────────────────────

console.log('\n6. Scheduled Tasks → group-scheduler');
const scheduledTasks = db.prepare(
  `SELECT * FROM scheduled_tasks WHERE status = 'active'`
).all() as any[];

if (scheduledTasks.length > 0) {
  const tasks: Record<string, any> = {};

  for (const t of scheduledTasks) {
    tasks[t.id] = {
      id: t.id,
      groupFolder: t.group_folder,
      chatJid: t.chat_jid,
      prompt: t.prompt,
      cron: t.schedule_value,
      contextMode: t.context_mode || 'group',
      name: t.name || t.id,
      status: 'active',
      createdAt: t.created_at,
    };
    log(`  Task: ${t.name || t.id} → ${t.group_folder} (${t.schedule_value})`);
  }

  const schedulerMemoryDir = path.join(MEMORY_DIR, 'group-scheduler', 'default');
  writeJson(path.join(schedulerMemoryDir, 'tasks.json'), tasks);
  log(`  Imported ${scheduledTasks.length} active tasks`);
} else {
  log('  No active scheduled tasks');
}

db.close();

// ─── Step 7: Save migration state (for rollback) ──────────────

console.log('\n7. Saving migration state');
const migrationState = {
  migratedAt: new Date().toISOString(),
  nanoclawDir: NANOCLAW_DIR,
  hadLaunchdAgent: hasLaunchd,
  launchdPlist: LAUNCHD_PLIST,
  wasRunning,
  groups: rows.length,
  sessions: sessions.length,
  messages: totalMessages,
  tasks: scheduledTasks.length,
};

writeJson(MIGRATION_STATE, migrationState);
log(`  Saved to ${MIGRATION_STATE}`);
log(`  Use 'tsx claw-rollback.ts' to restore nanoclaw`);

// ─── Step 8: Start claw ───────────────────────────────────────

console.log('\n8. Starting claw');
if (!dryRun) {
  // Start claw via photon CLI in background
  const claw = spawn('photon', ['cli', 'claw', 'start'], {
    cwd: path.dirname(new URL(import.meta.url).pathname),
    stdio: 'inherit',
    detached: false,
  });

  claw.on('close', (code) => {
    if (code === 0) {
      log(`  Claw started successfully`);
    } else {
      console.error(`  WARNING: Claw exited with code ${code}`);
      console.error(`  You can start it manually: photon cli claw start`);
      console.error(`  Or rollback: tsx claw-rollback.ts`);
    }
  });
} else {
  log(`  Would run: photon cli claw start`);
}

// ─── Summary ───────────────────────────────────────────────────

console.log('\n========================================');
console.log('Migration Summary');
console.log('========================================');
console.log(`  nanoclaw:   ${wasRunning ? 'stopped' : 'was not running'}${hasLaunchd ? ' (launchd unloaded)' : ''}`);
console.log(`  Groups:     ${rows.length}`);
console.log(`  Sessions:   ${sessions.length}`);
console.log(`  Messages:   ${totalMessages}`);
console.log(`  Tasks:      ${scheduledTasks.length}`);
console.log(`  Auth:       ${fs.existsSync(AUTH_DIR) ? 'symlinked' : 'missing'}`);
console.log(`  Group dirs: ${fs.existsSync(GROUPS_DIR) ? fs.readdirSync(GROUPS_DIR).length : 0}`);

if (dryRun) {
  console.log('\n  This was a dry run. Re-run without --dry-run to apply.');
} else {
  console.log('\n  Migration complete! Claw is now live.');
  console.log('  To rollback: tsx claw-rollback.ts');
}
console.log();
