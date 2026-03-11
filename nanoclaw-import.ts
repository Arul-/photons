#!/usr/bin/env tsx
/**
 * Imports nanoclaw data into the photon-based nanoclaw system.
 *
 * Reads from nanoclaw's SQLite database and file system, then writes
 * into the photon memory/state directories so the new system starts
 * with all existing groups, sessions, auth, and message history.
 *
 * Usage:
 *   tsx nanoclaw-import.ts [--nanoclaw-dir /path/to/nanoclaw] [--dry-run]
 */

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

// Nanoclaw sources
const DB_PATH = path.join(NANOCLAW_DIR, 'store', 'messages.db');
const AUTH_DIR = path.join(NANOCLAW_DIR, 'store', 'auth');
const GROUPS_DIR = path.join(NANOCLAW_DIR, 'groups');

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

// ─── Validate ──────────────────────────────────────────────────

console.log(`\nNanoclaw Import Tool`);
console.log(`====================`);
console.log(`Source:  ${NANOCLAW_DIR}`);
console.log(`Target:  ${PHOTON_HOME}`);
console.log(`Dry run: ${dryRun}\n`);

if (!fs.existsSync(DB_PATH)) {
  console.error(`Database not found: ${DB_PATH}`);
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true });

// ─── 1. Import WhatsApp Auth ──────────────────────────────────

console.log('1. WhatsApp Authentication');
if (fs.existsSync(AUTH_DIR)) {
  const authFiles = fs.readdirSync(AUTH_DIR);
  log(`  Found ${authFiles.length} auth files in nanoclaw`);

  if (fs.existsSync(BRIDGE_AUTH_DIR)) {
    log(`  Target auth dir already exists — creating symlink instead`);
    // Symlink to avoid duplicating 125MB of auth state
    const symlinkPath = BRIDGE_AUTH_DIR;
    if (!dryRun) {
      // Back up existing if it's a real directory (not symlink)
      if (!fs.lstatSync(symlinkPath).isSymbolicLink()) {
        const backup = `${symlinkPath}.backup-${Date.now()}`;
        fs.renameSync(symlinkPath, backup);
        log(`  Backed up existing auth to ${backup}`);
      }
    }
  }

  ensureDir(path.dirname(BRIDGE_AUTH_DIR));
  if (!dryRun) {
    if (fs.existsSync(BRIDGE_AUTH_DIR)) {
      // Already exists — check if it's already a symlink to the right place
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
        // Real directory — back it up and symlink
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

// ─── 2. Import Registered Groups → message-router memory ──────

console.log('\n2. Registered Groups → message-router');
interface RegisteredGroup {
  jid: string;
  name: string;
  folder: string;
  trigger: string;
  requiresTrigger: boolean;
  registeredAt: string;
}

const rows = db.prepare('SELECT * FROM registered_groups').all() as any[];
const registry: Record<string, RegisteredGroup> = {};

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

// Write to message-router's photon memory
const routerMemoryDir = path.join(MEMORY_DIR, 'message-router', 'default');
writeJson(path.join(routerMemoryDir, 'registry.json'), registry);
log(`  Imported ${rows.length} groups`);

// ─── 3. Import Sessions → nanoclaw orchestrator sessionMap ────

console.log('\n3. Sessions → nanoclaw orchestrator');
const sessions = db.prepare('SELECT * FROM sessions').all() as any[];
const sessionMap: Record<string, string> = {};

for (const s of sessions) {
  sessionMap[s.group_folder] = s.session_id;
  log(`  Session: ${s.group_folder} → ${s.session_id}`);
}

const nanoclawMemoryDir = path.join(MEMORY_DIR, 'nanoclaw', 'default');
writeJson(path.join(nanoclawMemoryDir, 'sessionMap.json'), sessionMap);
log(`  Imported ${sessions.length} sessions`);

// ─── 4. Copy Group Folders → agent-runner groups ──────────────

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

// ─── 5. Import Recent Messages → message-router context ───────

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

// ─── 6. Import Scheduled Tasks → group-scheduler memory ──────

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

// ─── 7. Write .env for bridge ─────────────────────────────────

console.log('\n7. Environment Configuration');
const nanoclawEnv = path.join(NANOCLAW_DIR, '.env');
if (fs.existsSync(nanoclawEnv)) {
  const envContent = fs.readFileSync(nanoclawEnv, 'utf-8');
  const assistantName = envContent.match(/ASSISTANT_NAME="?([^"\n]+)"?/)?.[1] || 'Lura';
  log(`  Assistant name: ${assistantName}`);
  log(`  WhatsApp auth: symlinked from nanoclaw`);
  log(`  No .env needed — bridge reads auth from symlinked dir`);
} else {
  log('  No .env found in nanoclaw');
}

// ─── Summary ───────────────────────────────────────────────────

db.close();

console.log('\n========================================');
console.log('Import Summary');
console.log('========================================');
console.log(`  Groups:     ${rows.length}`);
console.log(`  Sessions:   ${sessions.length}`);
console.log(`  Messages:   ${totalMessages}`);
console.log(`  Tasks:      ${scheduledTasks.length}`);
console.log(`  Auth:       ${fs.existsSync(AUTH_DIR) ? 'symlinked' : 'missing'}`);
console.log(`  Group dirs: ${fs.existsSync(GROUPS_DIR) ? fs.readdirSync(GROUPS_DIR).length : 0}`);

if (dryRun) {
  console.log('\n  This was a dry run. Re-run without --dry-run to apply.');
} else {
  console.log('\n  Import complete! Start with: photon cli nanoclaw start');
}
console.log();
