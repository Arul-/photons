#!/usr/bin/env tsx
/**
 * Rolls back from Claw to nanoclaw.
 *
 * Reads the migration state saved by claw-import.ts, stops claw,
 * and restarts nanoclaw via launchd (or directly).
 *
 * Usage:
 *   tsx claw-rollback.ts [--dry-run]
 */

import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

const PHOTON_HOME = path.join(os.homedir(), '.photon');
const MIGRATION_STATE = path.join(PHOTON_HOME, 'claw-migration.json');

function log(msg: string) {
  console.log(dryRun ? `[DRY RUN] ${msg}` : msg);
}

function exec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 15000 }).trim();
  } catch {
    return '';
  }
}

function isClawRunning(): boolean {
  const result = exec('ps aux');
  return result.includes('photon') && result.includes('claw');
}

function isNanoclawRunning(): boolean {
  const result = exec('ps aux');
  return result.includes('nanoclaw/dist/index.js');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Validate ──────────────────────────────────────────────────

console.log(`\nClaw Rollback Tool`);
console.log(`==================\n`);

if (!fs.existsSync(MIGRATION_STATE)) {
  console.error(`No migration state found at ${MIGRATION_STATE}`);
  console.error(`Either claw-import was never run, or the state file was deleted.`);
  console.error(`\nManual rollback:`);
  console.error(`  1. Kill any claw/photon processes`);
  console.error(`  2. launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist`);
  process.exit(1);
}

const state = JSON.parse(fs.readFileSync(MIGRATION_STATE, 'utf-8'));
console.log(`Migration was performed: ${state.migratedAt}`);
console.log(`nanoclaw dir: ${state.nanoclawDir}`);
console.log(`Had launchd:  ${state.hadLaunchdAgent}`);
console.log();

// ─── Step 1: Stop claw ────────────────────────────────────────

console.log('1. Stopping claw');
if (isClawRunning()) {
  if (!dryRun) {
    // Try graceful stop via photon CLI first
    exec('photon cli claw stop 2>/dev/null');
    await sleep(2000);

    // If still running, kill photon processes related to claw
    if (isClawRunning()) {
      exec(`pkill -f "photon.*claw"`);
      await sleep(1000);
    }
    log(`  Claw stopped`);
  } else {
    log(`  Would stop claw`);
  }
} else {
  log('  Claw is not running');
}

// ─── Step 2: Restart nanoclaw ─────────────────────────────────

console.log('\n2. Restarting nanoclaw');
if (state.hadLaunchdAgent && fs.existsSync(state.launchdPlist)) {
  if (isNanoclawRunning()) {
    log('  nanoclaw is already running');
  } else {
    if (!dryRun) {
      exec(`launchctl load "${state.launchdPlist}"`);
      await sleep(2000);

      if (isNanoclawRunning()) {
        log(`  nanoclaw restarted via launchd`);
      } else {
        console.error('  WARNING: launchd loaded but nanoclaw not detected');
        console.error(`  Try manually: launchctl load "${state.launchdPlist}"`);
      }
    } else {
      log(`  Would load ${state.launchdPlist}`);
    }
  }
} else {
  // No launchd — start directly
  const nanoclawEntry = path.join(state.nanoclawDir, 'dist', 'index.js');
  if (fs.existsSync(nanoclawEntry)) {
    if (!dryRun) {
      const { spawn } = await import('child_process');
      const proc = spawn('node', [nanoclawEntry], {
        cwd: state.nanoclawDir,
        stdio: 'ignore',
        detached: true,
      });
      proc.unref();
      log(`  Started nanoclaw directly (PID: ${proc.pid})`);
      log(`  NOTE: No launchd agent — nanoclaw won't auto-restart on crash`);
    } else {
      log(`  Would start: node ${nanoclawEntry}`);
    }
  } else {
    console.error(`  ERROR: nanoclaw entry point not found: ${nanoclawEntry}`);
    console.error(`  Rebuild with: cd ${state.nanoclawDir} && npm run build`);
  }
}

// ─── Step 3: Clean up migration state ─────────────────────────

console.log('\n3. Cleanup');
if (!dryRun) {
  fs.unlinkSync(MIGRATION_STATE);
  log(`  Removed ${MIGRATION_STATE}`);
} else {
  log(`  Would remove ${MIGRATION_STATE}`);
}

// Note: we intentionally do NOT remove the imported data from ~/.photon/state/
// It's harmless and preserves the option to re-migrate without re-importing.
log('  Imported photon data left in place (harmless, enables re-migration)');

// ─── Summary ───────────────────────────────────────────────────

console.log('\n========================================');
console.log('Rollback Summary');
console.log('========================================');
console.log(`  Claw:     stopped`);
console.log(`  nanoclaw: ${state.hadLaunchdAgent ? 'restored via launchd' : 'started directly'}`);

if (dryRun) {
  console.log('\n  This was a dry run. Re-run without --dry-run to apply.');
} else {
  console.log('\n  Rollback complete. nanoclaw is live again.');
}
console.log();
