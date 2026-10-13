import { spawnSync } from 'node:child_process';

const DEFAULT_GIT_OPTIONS = Object.freeze([
  '--no-optional-locks',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.preloadindex=false',
  '-c',
  'core.hooksPath=/dev/null',
]);

const STAGE_LINE_REGEX = /^([0-7]+)\s+([0-9a-f]{40})\s+([0-3])\t(.*)$/i;

/**
 * Execute a Git command with strict read-only and defensive configuration flags.
 * @param {string|null} repoDir - Working directory for Git (-C)
 * @param {string[]} args - Subcommand and arguments
 * @param {object} [options]
 * @returns {{ status: number|null, stdout: string, stderr: string, error?: Error }}
 */
export function runGit(repoDir, args, { maxBuffer = 10 * 1024 * 1024 } = {}) {
  const fullArgs = [];
  if (typeof repoDir === 'string' && repoDir.trim() !== '') {
    fullArgs.push('-C', repoDir);
  }
  fullArgs.push(...DEFAULT_GIT_OPTIONS);
  fullArgs.push(...args);

  const res = spawnSync('git', fullArgs, {
    encoding: 'utf-8',
    maxBuffer,
    shell: false,
  });

  return {
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    error: res.error,
  };
}

/**
 * Determine the top-level repository root of a directory.
 * @param {string} targetDir
 * @returns {{ ok: boolean, root: string|null, error: string }}
 */
export function getGitRepoRoot(targetDir) {
  const res = runGit(targetDir, ['rev-parse', '--show-toplevel']);
  if (res.status === 0 && res.stdout.trim()) {
    return { ok: true, root: res.stdout.trim(), error: '' };
  }
  return {
    ok: false,
    root: null,
    error: res.stderr.trim() || res.error?.message || 'Directory is not a Git repository',
  };
}

/**
 * Check whether a directory is inside a Git worktree.
 * @param {string} targetDir
 * @returns {boolean}
 */
export function isInsideWorkTree(targetDir) {
  const res = runGit(targetDir, ['rev-parse', '--is-inside-work-tree']);
  return res.status === 0 && res.stdout.trim() === 'true';
}

/**
 * Get current HEAD commit SHA (40-hex).
 * @param {string} repoRoot
 * @returns {{ ok: boolean, commit: string|null, error: string }}
 */
export function getHeadCommit(repoRoot) {
  const res = runGit(repoRoot, ['rev-parse', '--verify', 'HEAD']);
  if (res.status === 0 && res.stdout.trim()) {
    return { ok: true, commit: res.stdout.trim().toLowerCase(), error: '' };
  }
  return {
    ok: false,
    commit: null,
    error: res.stderr.trim() || res.error?.message || 'Failed to resolve HEAD commit',
  };
}

/**
 * Get current branch name, or '(detached)' if in detached HEAD state.
 * @param {string} repoRoot
 * @returns {{ ok: boolean, branch: string, error: string }}
 */
export function getHeadBranch(repoRoot) {
  const res = runGit(repoRoot, ['symbolic-ref', '--short', '-q', 'HEAD']);
  if (res.status === 0 && res.stdout.trim()) {
    return { ok: true, branch: res.stdout.trim(), error: '' };
  }
  // Exit non-zero indicates detached HEAD
  return { ok: true, branch: '(detached)', error: '' };
}

/**
 * Inspect Git index entry for a specific relative file path.
 * @param {string} repoRoot
 * @param {string} relativePath
 * @returns {{ ok: boolean, exists: boolean, mode: string|null, blobSha: string|null, stage: number|null, error: string }}
 */
export function getFileIndexStage(repoRoot, relativePath) {
  const res = runGit(repoRoot, ['ls-files', '--stage', '--', relativePath]);
  if (res.status !== 0) {
    return {
      ok: false,
      exists: false,
      mode: null,
      blobSha: null,
      stage: null,
      error: res.stderr.trim() || 'Failed to inspect Git index stage',
    };
  }

  const lines = res.stdout.trim().split('\n').filter(Boolean);
  if (lines.length === 0) {
    return {
      ok: true,
      exists: false,
      mode: null,
      blobSha: null,
      stage: null,
      error: '',
    };
  }

  // Handle stage line
  const match = lines[0].match(STAGE_LINE_REGEX);
  if (!match) {
    return {
      ok: false,
      exists: true,
      mode: null,
      blobSha: null,
      stage: null,
      error: `Malformed index entry: "${lines[0]}"`,
    };
  }

  return {
    ok: true,
    exists: true,
    mode: match[1],
    blobSha: match[2].toLowerCase(),
    stage: Number.parseInt(match[3], 10),
    error: '',
  };
}

/**
 * Check whether a target file has staged changes relative to HEAD.
 * @param {string} repoRoot
 * @param {string} relativePath
 * @returns {{ ok: boolean, hasStagedChanges: boolean, error: string }}
 */
export function checkTargetStagedModifications(repoRoot, relativePath) {
  const res = runGit(repoRoot, ['diff-index', '--cached', '--quiet', 'HEAD', '--', relativePath]);
  if (res.status === 0) {
    return { ok: true, hasStagedChanges: false, error: '' };
  }
  if (res.status === 1) {
    return { ok: true, hasStagedChanges: true, error: '' };
  }
  return {
    ok: false,
    hasStagedChanges: false,
    error: res.stderr.trim() || 'Failed to check staged changes',
  };
}

/**
 * Check whether a target file has unstaged changes relative to index.
 * @param {string} repoRoot
 * @param {string} relativePath
 * @returns {{ ok: boolean, hasUnstagedChanges: boolean, error: string }}
 */
export function checkTargetUnstagedModifications(repoRoot, relativePath) {
  const res = runGit(repoRoot, ['diff-files', '--quiet', '--', relativePath]);
  if (res.status === 0) {
    return { ok: true, hasUnstagedChanges: false, error: '' };
  }
  if (res.status === 1) {
    return { ok: true, hasUnstagedChanges: true, error: '' };
  }
  return {
    ok: false,
    hasUnstagedChanges: false,
    error: res.stderr.trim() || 'Failed to check unstaged changes',
  };
}

/**
 * Scan repository status to count and list modifications unrelated to the target file.
 * @param {string} repoRoot
 * @param {string} targetRelativePath
 * @returns {{ ok: boolean, unrelatedCount: number, entries: string[], error: string }}
 */
export function getUnrelatedModifications(repoRoot, targetRelativePath) {
  const res = runGit(repoRoot, ['status', '--porcelain=v1']);
  if (res.status !== 0) {
    return {
      ok: false,
      unrelatedCount: 0,
      entries: [],
      error: res.stderr.trim() || 'Failed to check repository status',
    };
  }

  const normalizedTarget = targetRelativePath.replace(/\\/g, '/');
  const lines = res.stdout.split('\n').filter((l) => l.trim() !== '');
  const entries = [];

  for (const line of lines) {
    const rawPath = line.slice(3).trim();
    // In case of rename: orig -> dest
    const pathPart = rawPath.includes(' -> ') ? rawPath.split(' -> ')[1].trim() : rawPath;
    const normalizedEntry = pathPart.replace(/^"|"$/g, '').replace(/\\/g, '/');
    if (normalizedEntry !== normalizedTarget) {
      entries.push(line);
    }
  }

  return {
    ok: true,
    unrelatedCount: entries.length,
    entries,
    error: '',
  };
}

/**
 * List local branches and their tip commits.
 * @param {string} repoRoot
 * @returns {{ ok: boolean, branches: Array<{ branch: string, commit: string }>, error: string }}
 */
export function listLocalDeveloperBranches(repoRoot) {
  const res = runGit(repoRoot, ['for-each-ref', '--format=%(refname:short)|%(objectname)', 'refs/heads/']);
  if (res.status !== 0) {
    return {
      ok: false,
      branches: [],
      error: res.stderr.trim() || 'Failed to list local branches',
    };
  }

  const lines = res.stdout.trim().split('\n').filter(Boolean);
  const branches = [];
  for (const line of lines) {
    const [branch, commit] = line.split('|');
    if (branch && commit) {
      branches.push({ branch: branch.trim(), commit: commit.trim().toLowerCase() });
    }
  }

  return { ok: true, branches, error: '' };
}

/**
 * Dry-run test patch applicability against worktree and index without mutation.
 * @param {string} repoRoot
 * @param {string} patchPath
 * @param {object} [options]
 * @param {boolean} [options.reverse=false]
 * @returns {{ ok: boolean, exitCode: number, error: string }}
 */
export function testPatchApplicability(repoRoot, patchPath, { reverse = false } = {}) {
  const args = ['apply', '--check'];
  if (reverse) {
    args.push('--reverse');
  }
  args.push(patchPath);

  const res = runGit(repoRoot, args);
  return {
    ok: res.status === 0,
    exitCode: res.status ?? 1,
    error: res.status === 0 ? '' : res.stderr.trim() || 'Patch dry-run failed',
  };
}
