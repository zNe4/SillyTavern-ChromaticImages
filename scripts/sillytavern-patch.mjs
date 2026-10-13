#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inspectTargetInstallation,
  checkInstallationPreflight,
} from '../src/patch-installer/inspect.js';

const HELP_TEXT = `
Chromatic Images — SillyTavern Patch Manager (Read-Only Foundation)

USAGE:
  sillytavern-patch.sh [TARGET_DIR] [OPTIONS]
  node scripts/sillytavern-patch.mjs [TARGET_DIR] [OPTIONS]

COMMANDS:
  --status            (Default) Inspect SillyTavern repository and patch status
  --check             Run preflight check to determine if patch can be applied

OPTIONS:
  --target <dir>      Path to SillyTavern repository root
  --json              Output results in machine-readable JSON format
  --help, -h          Show this help text

DEFERRED COMMANDS:
  --apply             Deferred to milestone D01-P3B
  --remove            Deferred to milestone D01-P3B

EXIT CODES (--check):
  0                   Patch can be applied (can-apply)
  1                   Patch cannot be applied (refused)
  2                   Usage or argument error
  3                   Patch is already applied (already-applied)

EXIT CODES (--status):
  0                   Status inspection completed successfully
  1                   Invalid package or invalid target repository
  2                   Usage or argument error
`.trim();

/**
 * Parse CLI arguments
 * @param {string[]} args
 * @returns {{
 *   command: 'status' | 'check' | 'apply' | 'remove' | 'help',
 *   targetDir: string|null,
 *   json: boolean,
 *   help: boolean,
 *   error: string|null
 * }}
 */
export function parseCliArgs(args) {
  let command = null;
  let targetDir = null;
  let json = false;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--status') {
      if (command && command !== 'status') {
        return { command, targetDir, json, help, error: `Conflicting commands: --${command} and --status` };
      }
      command = 'status';
    } else if (arg === '--check') {
      if (command && command !== 'check') {
        return { command, targetDir, json, help, error: `Conflicting commands: --${command} and --check` };
      }
      command = 'check';
    } else if (arg === '--apply') {
      return {
        command: 'apply',
        targetDir,
        json,
        help,
        error: 'Patch application (--apply) is not implemented in D01-P3A (deferred to D01-P3B).',
      };
    } else if (arg === '--remove') {
      return {
        command: 'remove',
        targetDir,
        json,
        help,
        error: 'Patch removal (--remove) is not implemented in D01-P3A (deferred to D01-P3B).',
      };
    } else if (arg === '--target') {
      if (i + 1 >= args.length) {
        return { command, targetDir, json, help, error: 'Option --target requires a directory argument' };
      }
      targetDir = args[++i];
    } else if (arg.startsWith('-')) {
      return { command, targetDir, json, help, error: `Unknown option: ${arg}` };
    } else {
      // Positional target directory
      if (!targetDir) {
        targetDir = arg;
      } else {
        return { command, targetDir, json, help, error: `Unexpected extra argument: ${arg}` };
      }
    }
  }

  if (help) {
    return { command: 'help', targetDir, json, help: true, error: null };
  }

  return {
    command: command || 'status',
    targetDir: targetDir || process.env.SILLYTAVERN_DIR || null,
    json,
    help: false,
    error: null,
  };
}

/**
 * Format human-readable output for --status
 * @param {object} inspection
 * @returns {string}
 */
function formatStatusOutput(inspection) {
  const lines = [];
  lines.push(`[Chromatic Images] SillyTavern Patch Status`);
  lines.push(`  Target Directory:    ${inspection.targetDir || '(not specified)'}`);
  lines.push(`  Repository Root:     ${inspection.repoRoot || '(not resolved)'}`);
  lines.push(`  Status:              ${inspection.status}`);
  lines.push(`  Release Match:       ${inspection.isReleaseCommit ? 'YES (certified)' : 'NO (unsupported)'}`);
  lines.push(`  HEAD Commit:         ${inspection.headCommit || '(unknown)'}`);
  lines.push(`  Branch:              ${inspection.headBranch || '(unknown)'}`);
  lines.push(`  Target File State:   ${inspection.targetFileState}`);
  lines.push(`  Git Index Blob:      ${inspection.indexBlobSha || '(none)'}`);
  lines.push(`  Worktree SHA-256:    ${inspection.worktreeSha256 || '(none)'}`);
  lines.push(`  Unrelated Changes:   ${inspection.unrelatedChangesCount}`);

  if (inspection.developerBranch) {
    lines.push(`  Developer Branch:    ${inspection.developerBranch.branch} (${inspection.developerBranch.commit.slice(0, 9)})`);
  }

  if (inspection.reasons && inspection.reasons.length > 0) {
    lines.push(`  Details:`);
    for (const r of inspection.reasons) {
      lines.push(`    - ${r}`);
    }
  }

  return lines.join('\n');
}

/**
 * Format human-readable output for --check
 * @param {object} preflight
 * @returns {string}
 */
function formatCheckOutput(preflight) {
  const lines = [];
  lines.push(`[Chromatic Images] SillyTavern Patch Preflight Check`);
  lines.push(`  Verdict:             ${preflight.verdict}`);
  lines.push(`  Underlying Status:   ${preflight.inspection.status}`);
  lines.push(`  Can Apply:           ${preflight.canApply ? 'YES' : 'NO'}`);
  lines.push(`  Already Applied:     ${preflight.alreadyApplied ? 'YES' : 'NO'}`);
  lines.push(`  Exit Code:           ${preflight.exitCode}`);
  lines.push(`  Reason:              ${preflight.reason}`);

  if (preflight.dryRunPassed !== null) {
    lines.push(`  Patch Dry-Run:       ${preflight.dryRunPassed ? 'PASSED' : 'FAILED'}`);
  }

  return lines.join('\n');
}

/**
 * Main CLI entrypoint
 */
export async function main(argv = process.argv.slice(2)) {
  const parsed = parseCliArgs(argv);

  if (parsed.error) {
    console.error(`[ERROR] ${parsed.error}\n`);
    console.error(HELP_TEXT);
    return 2;
  }

  if (parsed.help) {
    console.log(HELP_TEXT);
    return 0;
  }

  if (!parsed.targetDir) {
    console.error(`[ERROR] Target SillyTavern directory is required.\n`);
    console.error(HELP_TEXT);
    return 2;
  }

  if (parsed.command === 'check') {
    const preflight = await checkInstallationPreflight({ targetDir: parsed.targetDir });

    if (parsed.json) {
      const output = {
        command: 'check',
        verdict: preflight.verdict,
        status: preflight.inspection.status,
        canApply: preflight.canApply,
        alreadyApplied: preflight.alreadyApplied,
        exitCode: preflight.exitCode,
        reason: preflight.reason,
        dryRunPassed: preflight.dryRunPassed,
        targetDir: preflight.inspection.targetDir,
        repoRoot: preflight.inspection.repoRoot,
        headCommit: preflight.inspection.headCommit,
        headBranch: preflight.inspection.headBranch,
        isReleaseCommit: preflight.inspection.isReleaseCommit,
        targetFileState: preflight.inspection.targetFileState,
        unrelatedChangesCount: preflight.inspection.unrelatedChangesCount,
        developerBranch: preflight.inspection.developerBranch,
        reasons: preflight.inspection.reasons,
      };
      console.log(JSON.stringify(output, null, 2));
    } else {
      console.log(formatCheckOutput(preflight));
    }

    return preflight.exitCode;
  }

  // Default: status command
  const inspection = await inspectTargetInstallation({ targetDir: parsed.targetDir });
  const statusExitCode =
    inspection.status === 'invalid-package' || inspection.status === 'invalid-installation' ? 1 : 0;

  if (parsed.json) {
    const output = {
      command: 'status',
      status: inspection.status,
      exitCode: statusExitCode,
      targetDir: inspection.targetDir,
      repoRoot: inspection.repoRoot,
      headCommit: inspection.headCommit,
      headBranch: inspection.headBranch,
      isReleaseCommit: inspection.isReleaseCommit,
      targetFile: inspection.targetFile,
      targetFilePath: inspection.targetFilePath,
      targetFileState: inspection.targetFileState,
      worktreeSha256: inspection.worktreeSha256,
      indexBlobSha: inspection.indexBlobSha,
      indexMode: inspection.indexMode,
      indexStage: inspection.indexStage,
      hasTargetStagedChanges: inspection.hasTargetStagedChanges,
      unrelatedChangesCount: inspection.unrelatedChangesCount,
      developerBranch: inspection.developerBranch,
      packageVerified: inspection.packageVerified,
      reasons: inspection.reasons,
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(formatStatusOutput(inspection));
  }

  return statusExitCode;
}

const isDirectExecution =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectExecution) {
  main().then(
    (code) => {
      process.exit(code);
    },
    (err) => {
      console.error('[FATAL] Unexpected error:', err);
      process.exit(1);
    }
  );
}
