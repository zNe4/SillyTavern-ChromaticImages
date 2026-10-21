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

const HELP_TEXT = `
Chromatic Images — SillyTavern Patch Manager (SP-1 Read-Only)

USAGE:
  ./ci-patch.sh [COMMAND] [TARGET_DIR] [OPTIONS]
  node scripts/sillytavern-patch.mjs [COMMAND] [TARGET_DIR] [OPTIONS]

COMMANDS:
  status              (Default) Inspect SillyTavern repository and patch status
  check               Run preflight check to determine if patch can be applied
  check-release       Check upstream SillyTavern release compatibility (read-only)
  help                Show this help text

OPTIONS:
  --target <dir>      Path to SillyTavern repository root
  --json              Output results in machine-readable JSON format
  --help, -h          Show this help text

BACKWARD COMPATIBILITY:
  --status            Same as 'status' command
  --check             Same as 'check' command
  --check-release     Same as 'check-release' command

DISABLED COMMANDS:
  apply, --apply      Disabled in SP-1 (exits with code 2)
  remove, --remove    Disabled in SP-1 (exits with code 2)

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
  let command = null;
  let explicitTarget = null;
  let json = false;
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
      return {
        command: 'apply',
        explicitTarget,
        targetDir: explicitTarget || process.env.SILLYTAVERN_DIR || null,
        json,
        help,
        testUpstream: null,
        error: 'Patch application (apply) is disabled in D01-SP-1.',
      };
    } else if (arg === '--remove' || arg === 'remove') {
      return {
        command: 'remove',
        explicitTarget,
        targetDir: explicitTarget || process.env.SILLYTAVERN_DIR || null,
        json,
        help,
        testUpstream: null,
        error: 'Patch removal (remove) is disabled in D01-SP-1.',
      };
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

  if (!testUpstreamUrl && testUpstreamBranch) {
    return {
      command,
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
    command: command || 'status',
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
 * Main CLI entrypoint
 */
export async function main(argv = process.argv.slice(2)) {
  const parsed = parseCliArgs(argv);

  if (parsed.help) {
    console.log(HELP_TEXT);
    return 0;
  }

  if (parsed.command === 'apply' || parsed.command === 'remove') {
    console.error(`[ERROR] ${parsed.error}\n`);
    return 2;
  }

  if (parsed.error) {
    console.error(`[ERROR] ${parsed.error}\n`);
    console.error(HELP_TEXT);
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

  // For status and check: resolve target directory with strict precedence
  const targetResolution = resolveTargetDirectory({ explicitTarget: parsed.explicitTarget });
  if (!targetResolution.ok || targetResolution.error) {
    console.error(`[ERROR] ${targetResolution.error}\n`);
    return 2;
  }

  const targetDir = targetResolution.targetDir;
  if (!targetDir) {
    console.error(`[ERROR] Target SillyTavern directory is required. Specify --target <dir>, provide a path argument, set SILLYTAVERN_DIR, or place SillyTavern in a sibling directory.\n`);
    console.error(HELP_TEXT);
    return 2;
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
