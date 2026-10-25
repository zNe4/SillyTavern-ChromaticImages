#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inspectTargetInstallation,
  checkInstallationPreflight,
  resolveTargetDirectory,
} from '../src/patch-installer/inspect.js';
import {
  checkReleaseCompatibility,
} from '../src/patch-installer/check-release.js';
import {
  applyPatchToInstallation,
  removePatchFromInstallation,
} from '../src/patch-installer/apply-remove.js';

const HELP_TEXT = `
Chromatic Images — SillyTavern Patch Manager (SP-2)

USAGE:
  ./ci-patch.sh [COMMAND] [TARGET_DIR] [OPTIONS]
  node scripts/sillytavern-patch.mjs [COMMAND] [TARGET_DIR] [OPTIONS]

COMMANDS:
  status              (Default) Inspect SillyTavern repository and patch status
  check               Run preflight check to determine if patch can be applied
  apply               Safely apply hardened proxy patch to SillyTavern working tree
  remove              Safely remove hardened proxy patch from SillyTavern working tree
  check-release       Check upstream SillyTavern release compatibility (read-only)
  help                Show this help text

OPTIONS:
  --target <dir>      Path to SillyTavern repository root
  --json              Output results in machine-readable JSON format
  --help, -h          Show this help text

BACKWARD COMPATIBILITY:
  --status            Same as 'status' command
  --check             Same as 'check' command
  --apply             Same as 'apply' command
  --remove            Same as 'remove' command
  --check-release     Same as 'check-release' command

EXIT CODES:
  status:
    0                 Status inspection completed successfully
    1                 Invalid package or invalid target repository
    2                 Usage or argument error
  check:
    0                 Patch can be applied (can-apply)
    1                 Patch cannot be applied (refused)
    2                 Usage or argument error
    3                 Patch is already applied (already-applied)
  apply:
    0                 Patch applied and verified successfully (applied)
    1                 Refused, lock held, or verification failed
    2                 Usage, argument, or target resolution error
    3                 Patch is already applied (already-applied)
  remove:
    0                 Patch reversed and verified successfully (removed)
    1                 Refused, lock held, or verification failed
    2                 Usage, argument, or target resolution error
    3                 Patch is already removed (already-removed)
  check-release:
    0                 Certified upstream release (certified)
    1                 Incompatible upstream release (incompatible)
    2                 Usage, argument, or manifest verification error
    3                 Applies cleanly but uncertified (applies-unverified)
    4                 Network, Git, or environmental failure (unknown)
`.trim();

const KNOWN_COMMANDS = new Set([
  'status',
  'check',
  'check-release',
  'help',
  'apply',
  'remove',
]);

/**
 * Parse CLI arguments
 * @param {string[]} args
 * @returns {{
 *   command: 'status' | 'check' | 'check-release' | 'apply' | 'remove' | 'help',
 *   explicitTarget: string|null,
 *   targetDir: string|null,
 *   json: boolean,
 *   help: boolean,
 *   testUpstream: { url: string, branch?: string } | null,
 *   error: string|null
 * }}
 */
export function parseCliArgs(args) {
  const hasJsonFlag = args.some(
    (arg, idx) =>
      arg === '--json' &&
      (idx === 0 || !['--target', '--test-upstream-url', '--test-upstream-branch'].includes(args[idx - 1]))
  );

  let command = null;
  let explicitTarget = null;
  let json = hasJsonFlag;
  let help = false;
  let testUpstreamUrl = null;
  let testUpstreamBranch = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h' || arg === 'help') {
      help = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--status' || arg === 'status') {
      if (command && command !== 'status') {
        return {
          command,
          explicitTarget,
          targetDir: explicitTarget || process.env.SILLYTAVERN_DIR || null,
          json,
          help,
          testUpstream: null,
          error: `Conflicting commands: ${command} and status`,
        };
      }
      command = 'status';
    } else if (arg === '--check' || arg === 'check') {
      if (command && command !== 'check') {
        return {
          command,
          explicitTarget,
          targetDir: explicitTarget || process.env.SILLYTAVERN_DIR || null,
          json,
          help,
          testUpstream: null,
          error: `Conflicting commands: ${command} and check`,
        };
      }
      command = 'check';
    } else if (arg === '--check-release' || arg === 'check-release') {
      if (command && command !== 'check-release') {
        return {
          command,
          explicitTarget,
          targetDir: explicitTarget || process.env.SILLYTAVERN_DIR || null,
          json,
          help,
          testUpstream: null,
          error: `Conflicting commands: ${command} and check-release`,
        };
      }
      command = 'check-release';
    } else if (arg === '--apply' || arg === 'apply') {
      if (command && command !== 'apply') {
        return {
          command,
          explicitTarget,
          targetDir: explicitTarget || process.env.SILLYTAVERN_DIR || null,
          json,
          help,
          testUpstream: null,
          error: `Conflicting commands: ${command} and apply`,
        };
      }
      command = 'apply';
    } else if (arg === '--remove' || arg === 'remove') {
      if (command && command !== 'remove') {
        return {
          command,
          explicitTarget,
          targetDir: explicitTarget || process.env.SILLYTAVERN_DIR || null,
          json,
          help,
          testUpstream: null,
          error: `Conflicting commands: ${command} and remove`,
        };
      }
      command = 'remove';
    } else if (arg === '--target') {
      if (i + 1 >= args.length) {
        return {
          command,
          explicitTarget,
          targetDir: explicitTarget || process.env.SILLYTAVERN_DIR || null,
          json,
          help,
          testUpstream: null,
          error: 'Option --target requires a directory argument',
        };
      }
      explicitTarget = args[++i];
      if (typeof explicitTarget !== 'string' || explicitTarget.trim() === '') {
        return {
          command,
          explicitTarget,
          targetDir: null,
          json,
          help,
          testUpstream: null,
          error: 'Option --target cannot be empty or whitespace-only',
        };
      }
    } else if (arg === '--test-upstream-url') {
      if (i + 1 >= args.length) {
        return {
          command,
          explicitTarget,
          targetDir: explicitTarget || process.env.SILLYTAVERN_DIR || null,
          json,
          help,
          testUpstream: null,
          error: 'Option --test-upstream-url requires a URL argument',
        };
      }
      testUpstreamUrl = args[++i];
      if (typeof testUpstreamUrl !== 'string' || testUpstreamUrl.trim() === '') {
        return {
          command,
          explicitTarget,
          targetDir: explicitTarget || process.env.SILLYTAVERN_DIR || null,
          json,
          help,
          testUpstream: null,
          error: 'Option --test-upstream-url cannot be empty or whitespace-only',
        };
      }
      if (testUpstreamUrl.startsWith('-') || /[\x00-\x1f\x7f]/.test(testUpstreamUrl)) {
        return {
          command,
          explicitTarget,
          targetDir: explicitTarget || process.env.SILLYTAVERN_DIR || null,
          json,
          help,
          testUpstream: null,
          error: `Invalid option-like or malformed value for --test-upstream-url: "${testUpstreamUrl}"`,
        };
      }
    } else if (arg === '--test-upstream-branch') {
      if (i + 1 >= args.length) {
        return {
          command,
          explicitTarget,
          targetDir: explicitTarget || process.env.SILLYTAVERN_DIR || null,
          json,
          help,
          testUpstream: null,
          error: 'Option --test-upstream-branch requires a branch argument',
        };
      }
      testUpstreamBranch = args[++i];
      if (typeof testUpstreamBranch !== 'string' || testUpstreamBranch.trim() === '') {
        return {
          command,
          explicitTarget,
          targetDir: explicitTarget || process.env.SILLYTAVERN_DIR || null,
          json,
          help,
          testUpstream: null,
          error: 'Option --test-upstream-branch cannot be empty or whitespace-only',
        };
      }
      if (
        testUpstreamBranch.startsWith('-') ||
        /[\x00-\x20\x7f ~^:?*[\\]|\.\.|@\{|\/\.|\.lock$|^\/|\/$/.test(testUpstreamBranch)
      ) {
        return {
          command,
          explicitTarget,
          targetDir: explicitTarget || process.env.SILLYTAVERN_DIR || null,
          json,
          help,
          testUpstream: null,
          error: `Invalid option-like or malformed value for --test-upstream-branch: "${testUpstreamBranch}"`,
        };
      }
    } else if (arg.startsWith('-')) {
      return {
        command,
        explicitTarget,
        targetDir: explicitTarget || process.env.SILLYTAVERN_DIR || null,
        json,
        help,
        testUpstream: null,
        error: `Unknown option: ${arg}`,
      };
    } else {
      // Positional argument
      if (KNOWN_COMMANDS.has(arg)) {
        if (command && command !== arg) {
          return {
            command,
            explicitTarget,
            targetDir: explicitTarget || process.env.SILLYTAVERN_DIR || null,
            json,
            help,
            testUpstream: null,
            error: `Conflicting commands: ${command} and ${arg}`,
          };
        }
        command = arg;
      } else if (!explicitTarget) {
        if (typeof arg !== 'string' || arg.trim() === '') {
          return {
            command,
            explicitTarget: arg,
            targetDir: null,
            json,
            help,
            testUpstream: null,
            error: 'Target directory argument cannot be empty or whitespace-only',
          };
        }
        explicitTarget = arg;
      } else {
        return {
          command,
          explicitTarget,
          targetDir: explicitTarget,
          json,
          help,
          testUpstream: null,
          error: `Unexpected extra argument: ${arg}`,
        };
      }
    }
  }

  if (help) {
    return {
      command: 'help',
      explicitTarget,
      targetDir: explicitTarget || process.env.SILLYTAVERN_DIR || null,
      json,
      help: true,
      testUpstream: null,
      error: null,
    };
  }

  const effectiveCommand = command || 'status';

  const hasUpstreamTestArgs = testUpstreamUrl !== null || testUpstreamBranch !== null;
  if (effectiveCommand !== 'check-release' && hasUpstreamTestArgs) {
    return {
      command: effectiveCommand,
      explicitTarget,
      targetDir: explicitTarget || process.env.SILLYTAVERN_DIR || null,
      json,
      help,
      testUpstream: null,
      error: `Option --test-upstream-url/--test-upstream-branch is not permitted for command: ${effectiveCommand}`,
    };
  }

  if (!testUpstreamUrl && testUpstreamBranch) {
    return {
      command: effectiveCommand,
      explicitTarget,
      targetDir: explicitTarget || process.env.SILLYTAVERN_DIR || null,
      json,
      help,
      testUpstream: null,
      error: 'Option --test-upstream-branch cannot be used without --test-upstream-url',
    };
  }

  let testUpstream = null;
  if (testUpstreamUrl) {
    testUpstream = { url: testUpstreamUrl, branch: testUpstreamBranch || 'release' };
  }

  return {
    command: effectiveCommand,
    explicitTarget,
    targetDir: explicitTarget || process.env.SILLYTAVERN_DIR || null,
    json,
    help: false,
    testUpstream,
    error: null,
  };
}

/**
 * Format human-readable output for --status
 * @param {object} inspection
 * @param {string} [targetSource]
 * @returns {string}
 */
export function formatStatusOutput(inspection, targetSource = null) {
  const lines = [];
  lines.push(`[Chromatic Images] SillyTavern Patch Status`);
  const srcNote = targetSource === 'sibling' ? ' (auto-discovered sibling)' : '';
  lines.push(`  Target Directory:    ${inspection.targetDir || '(not specified)'}${srcNote}`);
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

  if (inspection.transaction && inspection.transaction.state !== 'none') {
    const blockingTag = inspection.transaction.isPending ? ' (BLOCKING)' : '';
    lines.push(`  Transaction State:   ${inspection.transaction.state}${blockingTag}`);
    if (inspection.transaction.hasLock) {
      const o = inspection.transaction.lock?.owner;
      if (o) {
        lines.push(`  Lock Details:        txId=${o.txId}, pid=${o.pid}, host=${o.hostname}, op=${o.op}`);
      } else {
        lines.push(`  Lock Details:        (present but unverified or corrupted)`);
      }
    }
    if (inspection.transaction.hasJournal) {
      const j = inspection.transaction.journal?.journal;
      if (j) {
        lines.push(`  Journal Details:     phase=${j.phase}, txId=${j.txId}, op=${j.op}`);
      } else {
        lines.push(`  Journal Details:     (present but unverified or corrupted)`);
      }
    }
    if (inspection.transaction.foreignEntries?.length > 0) {
      lines.push(`  Foreign Files:       ${inspection.transaction.foreignEntries.join(', ')}`);
    }
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
export function formatCheckOutput(preflight) {
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

  if (preflight.inspection?.transaction && preflight.inspection.transaction.state !== 'none') {
    const blockingTag = preflight.inspection.transaction.isPending ? ' (BLOCKING)' : '';
    lines.push(`  Transaction State:   ${preflight.inspection.transaction.state}${blockingTag}`);
  }

  return lines.join('\n');
}

/**
 * Format human-readable output for check-release
 * @param {object} result
 * @returns {string}
 */
export function formatCheckReleaseOutput(result) {
  const lines = [];
  lines.push(`[Chromatic Images] Upstream SillyTavern Release Compatibility Check`);
  lines.push(`  Classification:      ${result.classification.toUpperCase()}`);
  lines.push(`  Certified Match:     ${result.isCertified ? 'YES' : 'NO'}`);
  lines.push(`  Exit Code:           ${result.exitCode}`);
  lines.push(`  Upstream Repository: ${result.upstreamSource === 'official' ? 'SillyTavern/SillyTavern (official)' : result.upstreamUrl + ' (TEST OVERRIDE)'}`);
  lines.push(`  Upstream Branch:     ${result.upstreamBranch}`);
  lines.push(`  Fetched Commit:      ${result.fetchedCommit || '(unknown)'}`);
  lines.push(`  Release Commit:      ${result.isReleaseCommit ? 'YES (certified commit)' : 'NO (uncertified commit)'}`);
  lines.push(`  Target File:         ${result.targetFile}`);
  lines.push(`  Target SHA-256:      ${result.targetSha256 || '(none)'}`);
  lines.push(`  Target Git Blob:     ${result.targetBlobSha || '(none)'}`);

  if (result.dryRunPassed !== null) {
    lines.push(`  Patch Applicability: ${result.dryRunPassed ? 'PASSED (applies cleanly)' : 'FAILED (rejected)'}`);
  }

  if (result.isTestOverride) {
    lines.push(`  Test Notice:         Using test-injected upstream source; cannot produce official certification`);
  }

  lines.push(`  Reason:              ${result.reason}`);

  if (result.errors && result.errors.length > 0) {
    lines.push(`  Errors:`);
    for (const e of result.errors) {
      lines.push(`    - ${e}`);
    }
  }

  return lines.join('\n');
}

/**
 * Format human-readable output for apply
 * @param {object} result
 * @param {string} [targetSource]
 * @returns {string}
 */
export function formatApplyOutput(result, targetSource = null) {
  const lines = [];
  lines.push(`[Chromatic Images] SillyTavern Patch Application`);
  const srcNote = targetSource === 'sibling' ? ' (auto-discovered sibling)' : '';
  lines.push(`  Target Directory:    ${result.targetDir || '(not specified)'}${srcNote}`);
  lines.push(`  Repository Root:     ${result.repoRoot || '(not resolved)'}`);
  lines.push(`  Status:              ${(result.status || 'unknown').toUpperCase()}`);
  lines.push(`  Exit Code:           ${result.exitCode ?? 1}`);
  lines.push(`  Target File:         ${result.targetFile || '(none)'}`);
  lines.push(`  Worktree SHA-256:    ${result.worktreeSha256 || '(none)'}`);
  lines.push(`  Expected SHA-256:    ${result.expectedSha256 || '(none)'}`);

  if (result.backup?.backupFilePath) {
    lines.push(`  Backup File:         ${result.backup.backupFilePath}`);
    if (result.backup.metaFilePath) {
      lines.push(`  Backup Metadata:     ${result.backup.metaFilePath}`);
    }
    if (result.backup.sha256) {
      lines.push(`  Backup SHA-256:      ${result.backup.sha256}`);
    }
  }

  if (result.mutationOutcome) {
    lines.push(`  Mutation Outcome:    ${result.mutationOutcome}`);
  }

  if (result.lockPath) {
    lines.push(`  Lock File:           ${result.lockPath}`);
  }

  if (result.existingLock) {
    const o = result.existingLock;
    lines.push(`  Existing Lock:       pid=${o.pid ?? 'unknown'}, host=${o.hostname || 'unknown'}, op=${o.operation || 'unknown'}`);
  }

  if (result.lockCleanupError) {
    lines.push(`  Lock Cleanup Error:  ${result.lockCleanupError}`);
  }

  if (result.observedFingerprints) {
    lines.push(`  Observed Fingerprints:`);
    if (result.observedFingerprints.worktreeSha256 !== undefined) {
      lines.push(`    - Worktree SHA:    ${result.observedFingerprints.worktreeSha256 || '(unreadable/absent)'}`);
    }
    if (result.observedFingerprints.expectedSha256 !== undefined) {
      lines.push(`    - Expected SHA:    ${result.observedFingerprints.expectedSha256}`);
    }
    if (result.observedFingerprints.stockSha256 !== undefined) {
      lines.push(`    - Stock SHA:       ${result.observedFingerprints.stockSha256}`);
    }
  }

  if (result.humanInspectionRequired) {
    lines.push(`  ========================================================================`);
    lines.push(`  [WARNING] Human inspection required! An unexpected condition occurred.`);
    if (result.backup?.backupFilePath) {
      lines.push(`    Verified Pre-Mutation Backup: ${result.backup.backupFilePath}`);
    }
    if (result.backup?.metaFilePath) {
      lines.push(`    Backup Descriptor:           ${result.backup.metaFilePath}`);
    }
    lines.push(`    DO NOT run git checkout, git reset, or git clean.`);
    lines.push(`    Inspect repository state and verify target file manually.`);
    lines.push(`  ========================================================================`);
  }

  lines.push(`  Reason:              ${result.reason || '(none)'}`);

  return lines.join('\n');
}

/**
 * Format human-readable output for remove
 * @param {object} result
 * @param {string} [targetSource]
 * @returns {string}
 */
export function formatRemoveOutput(result, targetSource = null) {
  const lines = [];
  lines.push(`[Chromatic Images] SillyTavern Patch Removal`);
  const srcNote = targetSource === 'sibling' ? ' (auto-discovered sibling)' : '';
  lines.push(`  Target Directory:    ${result.targetDir || '(not specified)'}${srcNote}`);
  lines.push(`  Repository Root:     ${result.repoRoot || '(not resolved)'}`);
  lines.push(`  Status:              ${(result.status || 'unknown').toUpperCase()}`);
  lines.push(`  Exit Code:           ${result.exitCode ?? 1}`);
  lines.push(`  Target File:         ${result.targetFile || '(none)'}`);
  lines.push(`  Worktree SHA-256:    ${result.worktreeSha256 || '(none)'}`);
  lines.push(`  Expected SHA-256:    ${result.expectedSha256 || '(none)'}`);

  if (result.backup?.backupFilePath) {
    lines.push(`  Backup File:         ${result.backup.backupFilePath}`);
    if (result.backup.metaFilePath) {
      lines.push(`  Backup Metadata:     ${result.backup.metaFilePath}`);
    }
    if (result.backup.sha256) {
      lines.push(`  Backup SHA-256:      ${result.backup.sha256}`);
    }
  }

  if (result.mutationOutcome) {
    lines.push(`  Mutation Outcome:    ${result.mutationOutcome}`);
  }

  if (result.lockPath) {
    lines.push(`  Lock File:           ${result.lockPath}`);
  }

  if (result.existingLock) {
    const o = result.existingLock;
    lines.push(`  Existing Lock:       pid=${o.pid ?? 'unknown'}, host=${o.hostname || 'unknown'}, op=${o.operation || 'unknown'}`);
  }

  if (result.lockCleanupError) {
    lines.push(`  Lock Cleanup Error:  ${result.lockCleanupError}`);
  }

  if (result.observedFingerprints) {
    lines.push(`  Observed Fingerprints:`);
    if (result.observedFingerprints.worktreeSha256 !== undefined) {
      lines.push(`    - Worktree SHA:    ${result.observedFingerprints.worktreeSha256 || '(unreadable/absent)'}`);
    }
    if (result.observedFingerprints.expectedSha256 !== undefined) {
      lines.push(`    - Expected SHA:    ${result.observedFingerprints.expectedSha256}`);
    }
    if (result.observedFingerprints.stockSha256 !== undefined) {
      lines.push(`    - Stock SHA:       ${result.observedFingerprints.stockSha256}`);
    }
    if (result.observedFingerprints.patchedSha256 !== undefined) {
      lines.push(`    - Patched SHA:     ${result.observedFingerprints.patchedSha256}`);
    }
  }

  if (result.humanInspectionRequired) {
    lines.push(`  ========================================================================`);
    lines.push(`  [WARNING] Human inspection required! An unexpected condition occurred.`);
    if (result.backup?.backupFilePath) {
      lines.push(`    Verified Pre-Mutation Backup: ${result.backup.backupFilePath}`);
    }
    if (result.backup?.metaFilePath) {
      lines.push(`    Backup Descriptor:           ${result.backup.metaFilePath}`);
    }
    lines.push(`    DO NOT run git checkout, git reset, or git clean.`);
    lines.push(`    Inspect repository state and verify target file manually.`);
    lines.push(`  ========================================================================`);
  }

  lines.push(`  Reason:              ${result.reason || '(none)'}`);

  return lines.join('\n');
}

/**
 * Main CLI entrypoint
 */
export async function main(argv = process.argv.slice(2)) {
  const parsed = parseCliArgs(argv);

  if (parsed.help) {
    console.log(HELP_TEXT);
    return 0;
  }

  if (parsed.error) {
    if (parsed.json) {
      console.log(JSON.stringify({
        command: parsed.command || 'status',
        ok: false,
        status: 'refused',
        exitCode: 2,
        reason: parsed.error,
      }, null, 2));
    } else {
      console.error(`[ERROR] ${parsed.error}\n`);
      console.error(HELP_TEXT);
    }
    return 2;
  }

  // check-release does not require a local SillyTavern installation
  if (parsed.command === 'check-release') {
    const checkReleaseOptions = {};
    if (parsed.testUpstream) {
      checkReleaseOptions._testUpstream = parsed.testUpstream;
    }

    const result = await checkReleaseCompatibility(checkReleaseOptions);

    if (parsed.json) {
      console.log(JSON.stringify({
        command: 'check-release',
        ...result,
      }, null, 2));
    } else {
      console.log(formatCheckReleaseOutput(result));
    }

    return result.exitCode;
  }

  // Reject public CI_LOCK_DIR overrides for mutation commands before target resolution
  if ((parsed.command === 'apply' || parsed.command === 'remove') && process.env.CI_LOCK_DIR !== undefined) {
    const err = 'Environment variable CI_LOCK_DIR is not permitted for public mutation commands. Unset CI_LOCK_DIR or configure storage root via XDG_DATA_HOME.';
    if (parsed.json) {
      console.log(JSON.stringify({
        command: parsed.command,
        ok: false,
        status: 'refused',
        exitCode: 2,
        reason: err,
      }, null, 2));
    } else {
      console.error(`[ERROR] ${err}\n`);
    }
    return 2;
  }

  // For status, check, apply, and remove: resolve target directory with strict precedence
  const targetResolution = resolveTargetDirectory({ explicitTarget: parsed.explicitTarget });
  if (!targetResolution.ok || targetResolution.error) {
    if (parsed.json) {
      console.log(JSON.stringify({
        command: parsed.command || 'status',
        ok: false,
        status: 'refused',
        exitCode: 2,
        reason: targetResolution.error,
      }, null, 2));
    } else {
      console.error(`[ERROR] ${targetResolution.error}\n`);
    }
    return 2;
  }

  const targetDir = targetResolution.targetDir;
  if (!targetDir) {
    const err = 'Target SillyTavern directory is required. Specify --target <dir>, provide a path argument, set SILLYTAVERN_DIR, or place SillyTavern in a sibling directory.';
    if (parsed.json) {
      console.log(JSON.stringify({
        command: parsed.command || 'status',
        ok: false,
        status: 'refused',
        exitCode: 2,
        reason: err,
      }, null, 2));
    } else {
      console.error(`[ERROR] ${err}\n`);
      console.error(HELP_TEXT);
    }
    return 2;
  }

  // Dispatch public apply and remove commands
  if (parsed.command === 'apply' || parsed.command === 'remove') {
    const result = parsed.command === 'apply'
      ? await applyPatchToInstallation({ targetDir })
      : await removePatchFromInstallation({ targetDir });

    if (parsed.json) {
      const output = {
        command: parsed.command,
        ok: result.ok,
        status: result.status,
        exitCode: result.exitCode,
        reason: result.reason,
        targetDir: result.targetDir || targetDir,
        targetDiscoverySource: targetResolution.source,
        repoRoot: result.repoRoot || null,
        targetFile: result.targetFile || null,
        worktreeSha256: result.worktreeSha256 || null,
        expectedSha256: result.expectedSha256 || null,
        backup: result.backup || null,
        mutationOutcome: result.mutationOutcome || null,
        observedFingerprints: result.observedFingerprints || null,
        humanInspectionRequired: Boolean(result.humanInspectionRequired),
        lockPath: result.lockPath || null,
        existingLock: result.existingLock || null,
        lockCleanupError: result.lockCleanupError || null,
      };
      console.log(JSON.stringify(output, null, 2));
    } else {
      const formatted = parsed.command === 'apply'
        ? formatApplyOutput(result, targetResolution.source)
        : formatRemoveOutput(result, targetResolution.source);
      console.log(formatted);
    }

    return result.exitCode;
  }

  if (parsed.command === 'check') {
    const preflight = await checkInstallationPreflight({ targetDir });

    if (parsed.json) {
      const output = {
        command: 'check',
        verdict: preflight.verdict,
        status: preflight.inspection.status,
        transaction: preflight.inspection.transaction,
        transactionBlocking: Boolean(preflight.inspection.transaction?.isPending),
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
  const inspection = await inspectTargetInstallation({ targetDir });
  const statusExitCode =
    inspection.status === 'invalid-package' || inspection.status === 'invalid-installation' ? 1 : 0;

  if (parsed.json) {
    const output = {
      command: 'status',
      status: inspection.status,
      exitCode: statusExitCode,
      transaction: inspection.transaction,
      transactionBlocking: Boolean(inspection.transaction?.isPending),
      targetDir: inspection.targetDir,
      targetDiscoverySource: targetResolution.source,
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
    console.log(formatStatusOutput(inspection, targetResolution.source));
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
