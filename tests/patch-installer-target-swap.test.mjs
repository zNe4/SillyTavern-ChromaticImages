import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import child_process from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  acquireLock,
  releaseLock,
  generateTxId,
  TransactionLease,
} from '../src/patch-installer/lock.js';

import {
  createJournal,
  inspectJournal,
  advanceJournalPhase,
} from '../src/patch-installer/journal.js';

import {
  computeSha256,
  computeGitBlobSha,
} from '../src/patch-installer/staging.js';

import * as targetSwapModule from '../src/patch-installer/target-swap.js';
import {
  readBoundedNonblockingFile,
  authenticateSwapPrerequisites,
  authenticatePreSwap,
  swapVerifiedTarget,
  isValidOpenConstant,
  MAX_SWAP_FILE_BYTES,
  CERTIFIED_TARGET_FILE,
  SPECIAL_MODE_MASK,
} from '../src/patch-installer/target-swap.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const BUNDLED_MANIFEST_PATH = path.join(
  REPO_ROOT,
  'patches/sillytavern/release-06bde939f/manifest.json'
);

const tempDirsToClean = [];
after(() => {
  for (const d of tempDirsToClean) {
    try {
      if (fs.existsSync(d)) {
        fs.rmSync(d, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup errors on exit
    }
  }
});

function createTempDir(prefix = 'ci-target-swap-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirsToClean.push(dir);
  return dir;
}

function setupDisposableRepo(prefix = 'disposable-st-swap-') {
  const repoDir = createTempDir(prefix);
  child_process.execFileSync('git', ['init', '-q'], { cwd: repoDir });
  child_process.execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
  child_process.execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });

  fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ name: 'sillytavern', version: '1.18.0' }));
  fs.writeFileSync(path.join(repoDir, 'server.js'), '// mock server entry\n');
  fs.mkdirSync(path.join(repoDir, 'src/endpoints'), { recursive: true });

  return repoDir;
}

const manifest = JSON.parse(fs.readFileSync(BUNDLED_MANIFEST_PATH, 'utf8'));
const stockSha = manifest.patches.runtime.original.sha256.toLowerCase();
const stockBlob = manifest.patches.runtime.original.gitBlobSha.toLowerCase();
const patchedSha = manifest.patches.runtime.expected.sha256.toLowerCase();
const patchedBlob = manifest.patches.runtime.expected.gitBlobSha.toLowerCase();

function getVerifiedAuthenticStockContent(targetManifest) {
  const candidateDirs = [
    process.env.SILLYTAVERN_TEST_REPO,
    process.env.SILLYTAVERN_DIR,
    path.resolve(REPO_ROOT, './SillyTavern'),
    path.resolve(REPO_ROOT, '../SillyTavern'),
    '/home/zzzne4/SillyTavern',
  ].filter(Boolean);

  const expectedSha = targetManifest.patches?.runtime?.original?.sha256?.toLowerCase();
  const expectedBlob = targetManifest.patches?.runtime?.original?.gitBlobSha?.toLowerCase();
  const releaseCommit = targetManifest.releaseCommit;
  const targetFile = targetManifest.patches?.runtime?.targetFile;

  for (const candidate of candidateDirs) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const buf = child_process.execFileSync(
        'git',
        ['-C', candidate, 'show', `${releaseCommit}:${targetFile}`],
        { stdio: ['ignore', 'pipe', 'ignore'] }
      );
      if (buf && buf.length > 0) {
        const actualSha = computeSha256(buf).toLowerCase();
        const actualBlob = computeGitBlobSha(buf).toLowerCase();
        if (actualSha === expectedSha && actualBlob === expectedBlob) {
          return buf;
        }
      }
    } catch {
      // ignore
    }
  }
  return null;
}

function getAuthenticPatchedContent(stockBuf) {
  if (!stockBuf) return null;
  const patchPath = path.resolve(REPO_ROOT, manifest.patches.runtime.relativePath);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'get-target-swap-patched-'));
  try {
    const targetPath = path.join(tempDir, 'stable-diffusion.js');
    fs.writeFileSync(targetPath, stockBuf);
    child_process.execFileSync(
      'git',
      ['apply', '-p3', patchPath],
      { cwd: tempDir, stdio: 'ignore' }
    );
    const patchedBuf = fs.readFileSync(targetPath);
    if (computeSha256(patchedBuf).toLowerCase() === patchedSha && computeGitBlobSha(patchedBuf).toLowerCase() === patchedBlob) {
      return patchedBuf;
    }
    return null;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

const authenticStock = getVerifiedAuthenticStockContent(manifest);
const authenticPatched = authenticStock ? getAuthenticPatchedContent(authenticStock) : null;

/**
 * F1-F helper: Guard tests that require authentic SillyTavern reference fixture data.
 * Reports explicit skip rather than returning a misleading pass.
 */
function skipIfNoAuthenticFixture(t, testName) {
  if (!authenticStock || !authenticPatched) {
    if (typeof t?.skip === 'function') {
      t.skip(`Skipping ${testName}: authentic SillyTavern release fixture unavailable`);
    }
    return true;
  }
  return false;
}

/**
 * Setup a transaction at READY_TO_SWAP using authentic or provided contents.
 * F1-F: Fails closed with descriptive error if authentic fixture data is missing.
 */
function setupTxAtReadyToSwap({
  repo,
  txId = generateTxId(),
  op = 'apply',
  targetMode = '0644',
  stockContent = authenticStock,
  patchedContent = authenticPatched,
}) {
  if (!stockContent || !patchedContent) {
    throw new Error('setupTxAtReadyToSwap requires authentic fixture buffers: stock or patched content is not available');
  }

  const isApply = op === 'apply';
  const initialSha = isApply ? stockSha : patchedSha;
  const resultSha = isApply ? patchedSha : stockSha;
  const initialContent = isApply ? stockContent : patchedContent;
  const resultContent = isApply ? patchedContent : stockContent;

  const targetRel = 'src/endpoints/stable-diffusion.js';
  const liveTarget = path.join(repo, targetRel);
  fs.writeFileSync(liveTarget, initialContent);
  fs.chmodSync(liveTarget, parseInt(targetMode, 8));

  const { lease } = acquireLock({ repoRoot: repo, txId, op });

  createJournal({
    repoRoot: repo,
    txId,
    op,
    targetFile: targetRel,
    expectedInitialSha256: initialSha,
    expectedResultSha256: resultSha,
    lease,
  });

  const isolatedStagedRel = `.ci-patch/staging/${txId}/stable-diffusion.js`;
  advanceJournalPhase({
    repoRoot: repo,
    txId,
    nextPhase: 'ISOLATED_PREPARED',
    lease,
    metadataUpdate: {
      isolatedStagedPath: isolatedStagedRel,
    },
  });

  const stagingDir = path.join(repo, `.ci-patch/staging/${txId}`);
  fs.mkdirSync(stagingDir, { recursive: true });
  const stagingFile = path.join(stagingDir, 'stable-diffusion.js');
  fs.writeFileSync(stagingFile, resultContent);
  fs.chmodSync(stagingFile, 0o600);

  const backupRel = `.ci-patch/backup/${txId}/stable-diffusion.js`;
  advanceJournalPhase({
    repoRoot: repo,
    txId,
    nextPhase: 'BACKUP_CREATED',
    lease,
    metadataUpdate: {
      backupPath: backupRel,
      targetMode,
    },
  });

  const backupDir = path.join(repo, `.ci-patch/backup/${txId}`);
  fs.mkdirSync(backupDir, { recursive: true });
  const backupFile = path.join(backupDir, 'stable-diffusion.js');
  fs.writeFileSync(backupFile, initialContent);
  fs.chmodSync(backupFile, 0o600);

  const destStagedRel = `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp`;
  advanceJournalPhase({
    repoRoot: repo,
    txId,
    nextPhase: 'READY_TO_SWAP',
    lease,
    metadataUpdate: {
      destinationStagedPath: destStagedRel,
    },
  });

  const candidateFile = path.join(repo, destStagedRel);
  fs.writeFileSync(candidateFile, resultContent);
  fs.chmodSync(candidateFile, parseInt(targetMode, 8));

  return {
    repo,
    txId,
    op,
    lease,
    liveTarget,
    stagingFile,
    backupFile,
    candidateFile,
    targetMode,
    initialSha,
    resultSha,
  };
}

/**
 * Capture recursive filesystem snapshot for strict no-mutation verification.
 */
function snapshotDirectory(dir, relBase = '') {
  const snapshot = new Map();
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const ent of entries) {
    const fullPath = path.join(dir, ent.name);
    const relPath = path.join(relBase, ent.name);
    const stat = fs.lstatSync(fullPath);

    if (stat.isDirectory()) {
      snapshot.set(relPath, {
        type: 'dir',
        mode: stat.mode,
        dev: stat.dev,
        ino: stat.ino,
        mtimeMs: stat.mtimeMs,
      });
      const sub = snapshotDirectory(fullPath, relPath);
      for (const [k, v] of sub) {
        snapshot.set(k, v);
      }
    } else if (stat.isSymbolicLink()) {
      snapshot.set(relPath, {
        type: 'symlink',
        target: fs.readlinkSync(fullPath),
        mode: stat.mode,
        mtimeMs: stat.mtimeMs,
      });
    } else {
      const content = fs.readFileSync(fullPath);
      snapshot.set(relPath, {
        type: 'file',
        size: stat.size,
        mode: stat.mode,
        dev: stat.dev,
        ino: stat.ino,
        nlink: stat.nlink,
        mtimeMs: stat.mtimeMs,
        sha256: computeSha256(content),
      });
    }
  }

  return snapshot;
}

function assertSnapshotsEqual(before, after) {
  assert.equal(after.size, before.size, `File count changed: before=${before.size}, after=${after.size}`);
  for (const [relPath, beforeStat] of before) {
    const afterStat = after.get(relPath);
    assert.ok(afterStat, `Path "${relPath}" missing in post-snapshot`);
    assert.equal(afterStat.type, beforeStat.type, `Path "${relPath}" type changed`);
    assert.equal(afterStat.mode, beforeStat.mode, `Path "${relPath}" mode changed`);
    assert.equal(afterStat.ino, beforeStat.ino, `Path "${relPath}" inode changed`);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs, `Path "${relPath}" mtime changed`);
    if (beforeStat.type === 'file') {
      assert.equal(afterStat.size, beforeStat.size, `Path "${relPath}" size changed`);
      assert.equal(afterStat.sha256, beforeStat.sha256, `Path "${relPath}" SHA-256 changed`);
      assert.equal(afterStat.nlink, beforeStat.nlink, `Path "${relPath}" link count changed`);
    }
  }
}

describe('D01-P3B-2D-2-B: Secure Bounded Nonblocking Reader (readBoundedNonblockingFile)', () => {
  test('reads regular file safely and computes correct SHA-256 and Git blob digests', () => {
    const dir = createTempDir('reader-regular-');
    const filePath = path.join(dir, 'test-endpoint.js');
    const content = Buffer.from('console.log("secure pre-swap test");\n', 'utf8');
    fs.writeFileSync(filePath, content);
    fs.chmodSync(filePath, 0o644);

    const res = readBoundedNonblockingFile(filePath);
    assert.equal(Buffer.compare(res.buffer, content), 0);
    assert.equal(res.sha256, computeSha256(content).toLowerCase());
    assert.equal(res.gitBlobSha, computeGitBlobSha(content).toLowerCase());
    assert.equal(res.mode, '0644');
    assert.equal(res.stat.isFile(), true);
  });

  test('descriptor is opened with O_RDONLY | O_NOFOLLOW | O_NONBLOCK', () => {
    const dir = createTempDir('reader-flags-');
    const filePath = path.join(dir, 'flags.txt');
    fs.writeFileSync(filePath, 'flag test content\n');

    let capturedFlags = null;
    const origOpenSync = fs.openSync;
    try {
      fs.openSync = (p, flags, ...args) => {
        if (typeof p === 'string' && p.endsWith('flags.txt')) {
          capturedFlags = flags;
        }
        return origOpenSync(p, flags, ...args);
      };

      readBoundedNonblockingFile(filePath);
      const expectedFlags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
      assert.equal(capturedFlags, expectedFlags);
    } finally {
      fs.openSync = origOpenSync;
    }
  });

  test('rejects file exceeding maxBytes bound', () => {
    const dir = createTempDir('reader-oversize-');
    const filePath = path.join(dir, 'large.txt');
    fs.writeFileSync(filePath, Buffer.alloc(1024, 0x41));

    assert.throws(
      () => readBoundedNonblockingFile(filePath, { maxBytes: 512 }),
      (err) => {
        assert.equal(err.code, 'file-too-large');
        return true;
      }
    );
  });

  test('rejects empty file (0 bytes)', () => {
    const dir = createTempDir('reader-empty-');
    const filePath = path.join(dir, 'empty.txt');
    fs.writeFileSync(filePath, '');

    assert.throws(
      () => readBoundedNonblockingFile(filePath),
      (err) => {
        assert.equal(err.code, 'empty-file');
        return true;
      }
    );
  });

  test('rejects symbolic link', () => {
    const dir = createTempDir('reader-symlink-');
    const targetPath = path.join(dir, 'target.txt');
    const linkPath = path.join(dir, 'link.txt');
    fs.writeFileSync(targetPath, 'real content\n');
    fs.symlinkSync(targetPath, linkPath);

    assert.throws(
      () => readBoundedNonblockingFile(linkPath),
      (err) => {
        assert.equal(err.code, 'unsafe-symlink');
        return true;
      }
    );
  });

  test('rejects directory as unsupported non-regular file', () => {
    const dir = createTempDir('reader-dir-');
    assert.throws(
      () => readBoundedNonblockingFile(dir),
      (err) => {
        assert.equal(err.code, 'unsupported-type');
        return true;
      }
    );
  });

  test('rejects file with multiple hard links when requireSingleLink is true', () => {
    const dir = createTempDir('reader-hardlinks-');
    const filePath = path.join(dir, 'file1.txt');
    const linkPath = path.join(dir, 'file2.txt');
    fs.writeFileSync(filePath, 'hard link content\n');
    fs.linkSync(filePath, linkPath);

    assert.throws(
      () => readBoundedNonblockingFile(filePath, { requireSingleLink: true }),
      (err) => {
        assert.equal(err.code, 'unexpected-link-count');
        return true;
      }
    );
  });

  test('detects concurrent expansion during reading', () => {
    const dir = createTempDir('reader-expansion-');
    const filePath = path.join(dir, 'expand.txt');
    fs.writeFileSync(filePath, 'short initial content\n');

    assert.throws(
      () =>
        readBoundedNonblockingFile(filePath, {
          runFault: (stage, ctx) => {
            if (stage === 'read-chunk') {
              // Append to file concurrently while descriptor is open
              fs.appendFileSync(filePath, 'extra content appended concurrently!\n');
            }
          },
        }),
      (err) => {
        assert.ok(
          err.code === 'concurrent-expansion' ||
          err.code === 'concurrent-modification' ||
          err.code === 'pathname-continuity-error'
        );
        return true;
      }
    );
  });

  test('detects unexpected short read (EOF before expected size)', () => {
    const dir = createTempDir('reader-short-');
    const filePath = path.join(dir, 'short.txt');
    fs.writeFileSync(filePath, 'short read content\n');

    const origReadSync = fs.readSync;
    try {
      fs.readSync = (fd, buf, offset, length, position) => {
        // Return 0 (EOF) immediately
        return 0;
      };

      assert.throws(
        () => readBoundedNonblockingFile(filePath),
        (err) => {
          assert.equal(err.code, 'unexpected-eof');
          return true;
        }
      );
    } finally {
      fs.readSync = origReadSync;
    }
  });

  test('fails closed when O_NOFOLLOW or O_NONBLOCK platform constants are missing or invalid', () => {
    const dir = createTempDir('reader-bad-constants-');
    const filePath = path.join(dir, 'file.txt');
    fs.writeFileSync(filePath, 'content\n');

    assert.throws(
      () => readBoundedNonblockingFile(filePath, { constants: { O_RDONLY: 0, O_NOFOLLOW: 0, O_NONBLOCK: 2048 } }),
      (err) => {
        assert.equal(err.code, 'unsupported-platform');
        return true;
      }
    );

    assert.throws(
      () => readBoundedNonblockingFile(filePath, { constants: { O_RDONLY: 0, O_NOFOLLOW: 1024, O_NONBLOCK: null } }),
      (err) => {
        assert.equal(err.code, 'unsupported-platform');
        return true;
      }
    );
  });

  test('guarantees descriptor closure on normal and exceptional paths', () => {
    const dir = createTempDir('reader-closure-');
    const filePath = path.join(dir, 'closure.txt');
    fs.writeFileSync(filePath, 'closure test\n');

    let openedFd = null;
    let closedFd = null;

    const origOpen = fs.openSync;
    const origClose = fs.closeSync;

    try {
      fs.openSync = (p, flags, ...args) => {
        const fd = origOpen(p, flags, ...args);
        if (typeof p === 'string' && p.endsWith('closure.txt')) {
          openedFd = fd;
        }
        return fd;
      };

      fs.closeSync = (fd) => {
        if (fd === openedFd) {
          closedFd = fd;
        }
        return origClose(fd);
      };

      // 1. Successful path closes fd
      readBoundedNonblockingFile(filePath);
      assert.ok(openedFd !== null, 'Descriptor was opened');
      assert.equal(closedFd, openedFd, 'Descriptor was closed on success');

      // 2. Exceptional path closes fd
      openedFd = null;
      closedFd = null;
      assert.throws(
        () =>
          readBoundedNonblockingFile(filePath, {
            runFault: () => {
              throw new Error('injected error during read');
            },
          }),
        /injected error/
      );
      assert.ok(openedFd !== null, 'Descriptor was opened on fault path');
      assert.equal(closedFd, openedFd, 'Descriptor was closed on error path');
    } finally {
      fs.openSync = origOpen;
      fs.closeSync = origClose;
    }
  });

  test('TOCTOU race: FIFO substitution between preliminary lstat and openSync fails closed non-blockingly with evidence', (t) => {
    let hasMkfifo = false;
    try {
      child_process.execFileSync('mkfifo', ['--version'], { stdio: 'ignore' });
      hasMkfifo = true;
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        hasMkfifo = true;
      }
    }

    if (!hasMkfifo) {
      if (typeof t?.diagnostic === 'function') {
        t.diagnostic('Skipping FIFO substitution test: mkfifo utility is not available on this platform');
      }
      return;
    }

    const dir = createTempDir('reader-toctou-fifo-');
    const filePath = path.join(dir, 'fifo-victim.txt');
    fs.writeFileSync(filePath, 'regular file initially\n');

    let raceExercised = false;
    let closedAfterRace = false;
    const origClose = fs.closeSync;

    try {
      fs.closeSync = (fd) => {
        closedAfterRace = true;
        return origClose(fd);
      };

      assert.throws(
        () =>
          readBoundedNonblockingFile(filePath, {
            beforeOpenHook: (p) => {
              raceExercised = true;
              fs.unlinkSync(p);
              child_process.execFileSync('mkfifo', [p]);
            },
          }),
        (err) => {
          assert.ok(
            err.code === 'unsupported-type' ||
            err.code === 'descriptor-identity-mismatch' ||
            err.code === 'invalid-file-identity'
          );
          return true;
        }
      );

      assert.equal(raceExercised, true, 'Intended FIFO substitution race was exercised');
      assert.equal(closedAfterRace, true, 'Descriptor was closed after FIFO race rejection');
    } finally {
      fs.closeSync = origClose;
    }
  });

  // F1-C: Reader rejection of unsupported special permission bits
  test('F1-C: rejects files with unsupported setuid (04644), setgid (02644), or sticky (01644) permission bits', () => {
    const dir = createTempDir('reader-special-modes-');

    // 1. Setuid mode (04644)
    const setuidPath = path.join(dir, 'file-setuid.js');
    fs.writeFileSync(setuidPath, 'console.log("setuid");\n');
    try {
      fs.chmodSync(setuidPath, 0o4644);
      assert.throws(
        () => readBoundedNonblockingFile(setuidPath),
        (err) => {
          assert.equal(err.code, 'unsupported-special-mode');
          return true;
        }
      );
    } catch (e) {
      if (e.code !== 'unsupported-special-mode') throw e;
    }

    // 2. Setgid mode (02644)
    const setgidPath = path.join(dir, 'file-setgid.js');
    fs.writeFileSync(setgidPath, 'console.log("setgid");\n');
    try {
      fs.chmodSync(setgidPath, 0o2644);
      assert.throws(
        () => readBoundedNonblockingFile(setgidPath),
        (err) => {
          assert.equal(err.code, 'unsupported-special-mode');
          return true;
        }
      );
    } catch (e) {
      if (e.code !== 'unsupported-special-mode') throw e;
    }

    // 3. Sticky bit mode (01644)
    const stickyPath = path.join(dir, 'file-sticky.js');
    fs.writeFileSync(stickyPath, 'console.log("sticky");\n');
    try {
      fs.chmodSync(stickyPath, 0o1644);
      assert.throws(
        () => readBoundedNonblockingFile(stickyPath),
        (err) => {
          assert.equal(err.code, 'unsupported-special-mode');
          return true;
        }
      );
    } catch (e) {
      if (e.code !== 'unsupported-special-mode') throw e;
    }
  });

  // F1-D: Reader failure injection on closeSync
  test('F1-D: fails closed when descriptor closeSync fails on otherwise successful read', () => {
    const dir = createTempDir('reader-close-failure-');
    const filePath = path.join(dir, 'file.txt');
    fs.writeFileSync(filePath, 'valid read content\n');

    let attemptedCloseFd = null;
    const origClose = fs.closeSync;
    try {
      fs.closeSync = (fd) => {
        attemptedCloseFd = fd;
        origClose(fd); // simulate post-close error reporting: genuine close happens first
        const err = new Error('simulated close EIO failure');
        err.code = 'EIO';
        throw err;
      };

      assert.throws(
        () => readBoundedNonblockingFile(filePath),
        (err) => {
          assert.ok(err.code === 'EIO' || err.code === 'descriptor-close-error');
          assert.match(err.message, /Failed to close descriptor/);
          return true;
        }
      );
      assert.ok(attemptedCloseFd !== null, 'Descriptor close was attempted');
    } finally {
      fs.closeSync = origClose;
    }
  });

  test('F1-D: preserves primary verification error when descriptor closeSync also fails', () => {
    const dir = createTempDir('reader-primary-error-close-');
    const filePath = path.join(dir, 'empty.txt');
    fs.writeFileSync(filePath, ''); // will fail with empty-file

    let closeAttempted = false;
    const origClose = fs.closeSync;
    try {
      fs.closeSync = (fd) => {
        closeAttempted = true;
        origClose(fd); // simulate post-close error reporting: genuine close happens first
        const err = new Error('secondary cleanup close failure');
        err.code = 'EIO';
        throw err;
      };

      assert.throws(
        () => readBoundedNonblockingFile(filePath),
        (err) => {
          // Primary error must be preserved
          assert.equal(err.code, 'empty-file');
          assert.ok(err.closeError, 'Close error attached as secondary property');
          assert.equal(err.closeError.code, 'EIO');
          assert.equal(err.closeError.status, 'failed');
          assert.equal(err.closeError.uncertain, true);
          return true;
        }
      );
      assert.equal(closeAttempted, true, 'Descriptor close was attempted in finally');
    } finally {
      fs.closeSync = origClose;
    }
  });

  // F2-B: Revalidate single-link identity
  test('F2-B: detects hard link created concurrently after initial descriptor open and refuses authentication', () => {
    const dir = createTempDir('reader-concurrent-hardlink-');
    const filePath = path.join(dir, 'target.txt');
    const linkPath = path.join(dir, 'target-hardlink.txt');
    fs.writeFileSync(filePath, 'data for hardlink concurrency test\n');

    let linkCreatedDuringRead = false;

    assert.throws(
      () =>
        readBoundedNonblockingFile(filePath, {
          requireSingleLink: true,
          runFault: (stage) => {
            if (stage === 'read-chunk' && !linkCreatedDuringRead) {
              // Create hard link after initial descriptor validation, before reading completes
              fs.linkSync(filePath, linkPath);
              linkCreatedDuringRead = true;
            }
          },
        }),
      (err) => {
        assert.ok(
          err.code === 'unexpected-link-count' || err.code === 'concurrent-modification',
          `Expected unexpected-link-count or concurrent-modification, got ${err.code}`
        );
        return true;
      }
    );

    // Prove intended mutation occurred: file on disk now has link count 2
    assert.equal(linkCreatedDuringRead, true, 'Hard link creation hook was executed');
    const st = fs.statSync(filePath);
    assert.equal(st.nlink, 2, 'File on disk has link count 2 proving intended mutation occurred');
  });

  // F2-C: Uncertain close failure isolated in disposable child process
  test('F2-C: uncertain descriptor close failure without prior close is isolated in disposable child process', () => {
    const dir = createTempDir('reader-child-close-failure-');
    const filePath = path.join(dir, 'file.txt');
    fs.writeFileSync(filePath, 'valid read content for child process test\n');

    const script = `
      import fs from 'node:fs';
      import assert from 'node:assert/strict';
      import { readBoundedNonblockingFile } from './src/patch-installer/target-swap.js';

      const filePath = ${JSON.stringify(filePath)};
      let closeCalled = false;

      fs.closeSync = (fd) => {
        closeCalled = true;
        // Strictly do NOT call origClose: simulates uncertain descriptor ownership where close fails
        const err = new Error('simulated uncertain kernel close failure');
        err.code = 'EIO';
        throw err;
      };

      let threw = false;
      try {
        readBoundedNonblockingFile(filePath);
      } catch (err) {
        threw = true;
        assert.ok(err.code === 'EIO' || err.code === 'descriptor-close-error');
        assert.match(err.message, /Failed to close descriptor/);
      }

      assert.equal(threw, true, 'Reader must fail closed on uncertain descriptor close failure');
      assert.equal(closeCalled, true, 'closeSync was called');
      process.exit(0);
    `;

    child_process.execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: REPO_ROOT,
      stdio: 'pipe',
    });
  });
});

describe('D01-P3B-2D-2-B: Transaction Pre-Swap Authentication (authenticateSwapPrerequisites)', () => {
  test('authenticates valid apply prerequisites end-to-end with authentic SillyTavern release bytes', async (t) => {
    if (skipIfNoAuthenticFixture(t, 'apply prerequisites')) return;

    const repo = setupDisposableRepo('tx-swap-auth-apply-');
    const { txId, op, lease } = setupTxAtReadyToSwap({
      repo,
      op: 'apply',
    });

    const res = await authenticateSwapPrerequisites({
      repoRoot: repo,
      txId,
      op,
      lease,
      manifest,
    });

    assert.equal(res.ok, true);
    assert.equal(res.verified, true);
    assert.equal(res.txId, txId);
    assert.equal(res.op, 'apply');
    assert.equal(res.targetFile, CERTIFIED_TARGET_FILE);
    assert.equal(res.targetMode, '0644');
    assert.equal(res.initialSha256, stockSha);
    assert.equal(res.resultSha256, patchedSha);
    assert.ok(res.candidateIno > 0);
    assert.ok(res.targetIno > 0);
    assert.notEqual(res.candidateIno, res.targetIno);
    assert.equal(res.candidateDev, res.targetDev);
    assert.equal(res.candidateDev, res.parentDev);
  });

  test('authenticates valid remove prerequisites end-to-end with authentic SillyTavern release bytes', async (t) => {
    if (skipIfNoAuthenticFixture(t, 'remove prerequisites')) return;

    const repo = setupDisposableRepo('tx-swap-auth-remove-');
    const { txId, op, lease } = setupTxAtReadyToSwap({
      repo,
      op: 'remove',
    });

    const res = await authenticateSwapPrerequisites({
      repoRoot: repo,
      txId,
      op,
      lease,
      manifest,
    });

    assert.equal(res.ok, true);
    assert.equal(res.verified, true);
    assert.equal(res.txId, txId);
    assert.equal(res.op, 'remove');
    assert.equal(res.targetFile, CERTIFIED_TARGET_FILE);
    assert.equal(res.initialSha256, patchedSha);
    assert.equal(res.resultSha256, stockSha);
    assert.notEqual(res.candidateIno, res.targetIno);
  });

  test('async public entry point authenticateSwapPrerequisites and authenticatePreSwap alias return matching result', async (t) => {
    if (skipIfNoAuthenticFixture(t, 'async alias')) return;

    const repo = setupDisposableRepo('tx-swap-auth-async-');
    const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

    const p1 = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
    const p2 = await authenticatePreSwap({ repoRoot: repo, txId, op, lease, manifest });

    assert.equal(p1.ok, true);
    assert.equal(p2.ok, true);
    assert.equal(p1.txId, p2.txId);
    assert.equal(p1.candidateIno, p2.candidateIno);
  });

  test('F1-E: does not export misleading authenticateSwapPrerequisitesSync alias', () => {
    assert.equal(
      targetSwapModule.authenticateSwapPrerequisitesSync,
      undefined,
      'authenticateSwapPrerequisitesSync must not be exported'
    );
  });

  test('Strict No-Mutation: filesystem snapshot before and after authentication is 100% identical and mutation APIs are untouched', async (t) => {
    if (skipIfNoAuthenticFixture(t, 'no-mutation')) return;

    const repo = setupDisposableRepo('tx-swap-no-mutation-');
    const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

    const beforeSnapshot = snapshotDirectory(repo);

    let renameCalled = false;
    let unlinkCalled = false;
    let writeCalled = false;
    let chmodCalled = false;

    const origRename = fs.renameSync;
    const origUnlink = fs.unlinkSync;
    const origWrite = fs.writeSync;
    const origChmod = fs.chmodSync;

    try {
      fs.renameSync = (...args) => {
        renameCalled = true;
        return origRename.apply(fs, args);
      };
      fs.unlinkSync = (...args) => {
        unlinkCalled = true;
        return origUnlink.apply(fs, args);
      };
      fs.writeSync = (...args) => {
        writeCalled = true;
        return origWrite.apply(fs, args);
      };
      fs.chmodSync = (...args) => {
        chmodCalled = true;
        return origChmod.apply(fs, args);
      };

      const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
      assert.equal(res.ok, true);
      assert.equal(res.verified, true);

      // Verify mutation syscalls were never invoked
      assert.equal(renameCalled, false, 'fs.renameSync must never be called during read-only authentication');
      assert.equal(unlinkCalled, false, 'fs.unlinkSync must never be called during read-only authentication');
      assert.equal(writeCalled, false, 'fs.writeSync must never be called during read-only authentication');
      assert.equal(chmodCalled, false, 'fs.chmodSync must never be called during read-only authentication');

      // Verify recursive filesystem snapshot before and after is 100% byte-for-byte identical
      const afterSnapshot = snapshotDirectory(repo);
      assertSnapshotsEqual(beforeSnapshot, afterSnapshot);
    } finally {
      fs.renameSync = origRename;
      fs.unlinkSync = origUnlink;
      fs.writeSync = origWrite;
      fs.chmodSync = origChmod;
    }
  });

  test('swapVerifiedTarget is reserved for Stage C and throws unimplemented-stage-c', async () => {
    await assert.rejects(
      async () => swapVerifiedTarget(),
      (err) => {
        assert.equal(err.code, 'unimplemented-stage-c');
        assert.match(err.message, /reserved for Stage C/);
        return true;
      }
    );
  });

  describe('Invalid Arguments and Capabilities', () => {
    test('rejects missing or non-object options', async () => {
      const r1 = await authenticateSwapPrerequisites(null);
      assert.equal(r1.ok, false);
      assert.equal(r1.code, 'invalid-arguments');

      const r2 = await authenticateSwapPrerequisites('string');
      assert.equal(r2.ok, false);
      assert.equal(r2.code, 'invalid-arguments');
    });

    test('rejects missing mandatory arguments', async () => {
      const repo = setupDisposableRepo('tx-swap-args-');
      const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      const r1 = await authenticateSwapPrerequisites({ txId, op, lease });
      assert.equal(r1.code, 'invalid-arguments');

      const r2 = await authenticateSwapPrerequisites({ repoRoot: repo, op, lease });
      assert.equal(r2.code, 'invalid-txid');

      const r3 = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op: 'invalid', lease });
      assert.equal(r3.code, 'invalid-operation');

      const r4 = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease: null });
      assert.equal(r4.code, 'lease-required');
    });

    test('fails closed when platform constants (O_NOFOLLOW, O_NONBLOCK, O_DIRECTORY) are missing or 0', async () => {
      const repo = setupDisposableRepo('tx-swap-constants-');
      const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      const r1 = await authenticateSwapPrerequisites({
        repoRoot: repo,
        txId,
        op,
        lease,
        constants: { O_RDONLY: 0, O_NOFOLLOW: 0, O_NONBLOCK: 2048, O_DIRECTORY: 65536 },
      });
      assert.equal(r1.ok, false);
      assert.equal(r1.code, 'unsupported-platform');

      const r2 = await authenticateSwapPrerequisites({
        repoRoot: repo,
        txId,
        op,
        lease,
        constants: { O_RDONLY: 0, O_NOFOLLOW: 1024, O_NONBLOCK: 0, O_DIRECTORY: 65536 },
      });
      assert.equal(r2.ok, false);
      assert.equal(r2.code, 'unsupported-platform');

      const r3 = await authenticateSwapPrerequisites({
        repoRoot: repo,
        txId,
        op,
        lease,
        constants: { O_RDONLY: 0, O_NOFOLLOW: 1024, O_NONBLOCK: 2048, O_DIRECTORY: 0 },
      });
      assert.equal(r3.ok, false);
      assert.equal(r3.code, 'unsupported-platform');
    });
  });

  describe('Lease, Lock, and Journal Validation', () => {
    test('rejects fake or mismatched lease', async () => {
      const repo = setupDisposableRepo('tx-swap-bad-lease-');
      const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      // Fake lease object
      const fakeLease = { txId, op, repoRoot: repo };
      const resFake = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease: fakeLease });
      assert.equal(resFake.ok, false);
      assert.equal(resFake.code, 'lease-required');

      // Lease txId mismatch
      const otherTxId = generateTxId();
      const resTxMismatch = await authenticateSwapPrerequisites({ repoRoot: repo, txId: otherTxId, op, lease });
      assert.equal(resTxMismatch.ok, false);
      assert.equal(resTxMismatch.code, 'lease-tx-mismatch');

      // Lease op mismatch
      const resOpMismatch = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op: 'remove', lease });
      assert.equal(resOpMismatch.ok, false);
      assert.equal(resOpMismatch.code, 'lease-op-mismatch');
    });

    test('rejects released or revoked lease', async () => {
      const repo = setupDisposableRepo('tx-swap-revoked-lease-');
      const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      releaseLock({ repoRoot: repo, txId, lease });
      const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease });
      assert.equal(res.ok, false);
      assert.ok(
        res.code === 'lease-not-active' ||
        res.code === 'no-lock' ||
        res.code === 'lease-revoked'
      );
    });

    test('rejects foreign lock ownership', async () => {
      const repo = setupDisposableRepo('tx-swap-foreign-lock-');
      const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      // Corrupt owner.json with foreign txId
      const ownerPath = path.join(repo, '.ci-patch/lock.d/owner.json');
      const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
      owner.txId = generateTxId();
      fs.writeFileSync(ownerPath, JSON.stringify(owner));

      const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease });
      assert.equal(res.ok, false);
      assert.ok(res.code === 'lock-ownership-mismatch' || res.code === 'ownership-mismatch');
    });

    test('rejects when journal is missing or corrupt', async () => {
      const repo = setupDisposableRepo('tx-swap-corrupt-journal-');
      const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      const journalPath = path.join(repo, '.ci-patch/journal.json');
      fs.writeFileSync(journalPath, '{ corrupt json');

      const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'journal-invalid');

      fs.unlinkSync(journalPath);
      const resMissing = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
      assert.equal(resMissing.ok, false);
      assert.equal(resMissing.code, 'journal-missing');
    });

    test('rejects wrong journal phase (must be strictly READY_TO_SWAP)', async () => {
      const repo = setupDisposableRepo('tx-swap-phase-mismatch-');
      const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      const journalPath = path.join(repo, '.ci-patch/journal.json');
      const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));

      const testPhases = ['LOCKED', 'ISOLATED_PREPARED', 'BACKUP_CREATED', 'SWAPPED', 'COMPLETED'];
      for (const ph of testPhases) {
        journal.phase = ph;
        fs.writeFileSync(journalPath, JSON.stringify(journal));

        const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
        assert.equal(res.ok, false);
        assert.ok(res.code === 'phase-mismatch' || res.code === 'journal-invalid');
      }
    });

    test('rejects journal schemaVersion mismatch', async () => {
      const repo = setupDisposableRepo('tx-swap-schema-ver-');
      const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      const journalPath = path.join(repo, '.ci-patch/journal.json');
      const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
      journal.schemaVersion = 999;
      fs.writeFileSync(journalPath, JSON.stringify(journal));

      const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease });
      assert.equal(res.ok, false);
      assert.ok(res.code === 'journal-invalid' || res.code === 'journal-schema-mismatch');
    });

    test('rejects uncertified journal targetFile', async () => {
      const repo = setupDisposableRepo('tx-swap-uncert-target-');
      const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      const journalPath = path.join(repo, '.ci-patch/journal.json');
      const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
      journal.targetFile = 'src/endpoints/other-endpoint.js';
      fs.writeFileSync(journalPath, JSON.stringify(journal));

      const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
      assert.equal(res.ok, false);
      assert.ok(res.code === 'uncertified-target' || res.code === 'journal-invalid');
    });

    test('rejects missing or non-canonical auxiliary paths in journal', async () => {
      const repo = setupDisposableRepo('tx-swap-bad-aux-');
      const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      const journalPath = path.join(repo, '.ci-patch/journal.json');
      const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));

      // Non-canonical staging path
      journal.isolatedStagedPath = 'outside/staging.js';
      fs.writeFileSync(journalPath, JSON.stringify(journal));
      const res1 = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
      assert.equal(res1.ok, false);
      assert.ok(res1.code === 'invalid-metadata' || res1.code === 'journal-invalid');

      // Non-canonical backup path
      journal.isolatedStagedPath = `.ci-patch/staging/${txId}/stable-diffusion.js`;
      journal.backupPath = 'outside/backup.js';
      fs.writeFileSync(journalPath, JSON.stringify(journal));
      const res2 = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
      assert.equal(res2.ok, false);
      assert.ok(res2.code === 'invalid-metadata' || res2.code === 'journal-invalid');
    });

    test('rejects targetMode with setuid/setgid bits in journal', async () => {
      const repo = setupDisposableRepo('tx-swap-special-mode-');
      const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      const journalPath = path.join(repo, '.ci-patch/journal.json');
      const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
      journal.targetMode = '4644'; // setuid bit
      fs.writeFileSync(journalPath, JSON.stringify(journal));

      const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
      assert.equal(res.ok, false);
      assert.ok(res.code === 'invalid-mode' || res.code === 'invalid-metadata' || res.code === 'journal-invalid');
    });
  });

  describe('Manifest and Hash Verification', () => {
    test('rejects manifest targetFile mismatch', async () => {
      const repo = setupDisposableRepo('tx-swap-manifest-mismatch-');
      const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      const customManifest = JSON.parse(JSON.stringify(manifest));
      customManifest.patches.runtime.targetFile = 'src/endpoints/unrelated.js';

      const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest: customManifest });
      assert.equal(res.ok, false);
      assert.ok(res.code === 'manifest-mismatch' || res.code === 'manifest-target-mismatch');
    });

    test('rejects journal expectedInitialSha256 / expectedResultSha256 mismatch with manifest', async () => {
      const repo = setupDisposableRepo('tx-swap-hash-mismatch-');
      const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      const journalPath = path.join(repo, '.ci-patch/journal.json');
      const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
      journal.expectedInitialSha256 = '0000000000000000000000000000000000000000000000000000000000000000';
      fs.writeFileSync(journalPath, JSON.stringify(journal));

      const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'journal-hash-mismatch');
    });

    test('F1-E: rejects provided manifest with tampered original.gitBlobSha (even with identical SHA-256)', async () => {
      const repo = setupDisposableRepo('tx-swap-manifest-blob-mismatch-');
      const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      const customManifest = JSON.parse(JSON.stringify(manifest));
      customManifest.patches.runtime.original.gitBlobSha = '1111111111111111111111111111111111111111';

      const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest: customManifest });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'manifest-mismatch');
    });

    test('F1-E: rejects provided manifest with tampered expected.gitBlobSha (even with identical SHA-256)', async () => {
      const repo = setupDisposableRepo('tx-swap-manifest-exp-blob-');
      const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      const customManifest = JSON.parse(JSON.stringify(manifest));
      customManifest.patches.runtime.expected.gitBlobSha = '2222222222222222222222222222222222222222';

      const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest: customManifest });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'manifest-mismatch');
    });

    test('F1-E: rejects untrusted manifest path string', async () => {
      const repo = setupDisposableRepo('tx-swap-untrusted-manifest-path-');
      const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      const res = await authenticateSwapPrerequisites({
        repoRoot: repo,
        txId,
        op,
        lease,
        manifest: '../evil/manifest.json',
      });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'untrusted-manifest-path');
    });

    test('F1-E: rejects malformed or incomplete provided manifest override', async () => {
      const repo = setupDisposableRepo('tx-swap-malformed-manifest-');
      const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      const res = await authenticateSwapPrerequisites({
        repoRoot: repo,
        txId,
        op,
        lease,
        manifest: { releaseCommit: manifest.releaseCommit }, // missing patches
      });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'manifest-invalid');
    });
  });

  describe('Parent Directory Components and Destination Hierarchy (F1-A)', () => {
    test('F1-A: rejects intermediate "src" directory replaced by symlink outside repository', async () => {
      const repo = setupDisposableRepo('tx-swap-symlink-src-');
      const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      // Create outside directory
      const outsideDir = createTempDir('outside-src-');
      const outsideEndpoints = path.join(outsideDir, 'endpoints');
      fs.mkdirSync(outsideEndpoints, { recursive: true });

      // Move endpoints to outside and replace src with symlink
      const srcDir = path.join(repo, 'src');
      fs.cpSync(srcDir, outsideDir, { recursive: true });
      fs.rmSync(srcDir, { recursive: true, force: true });
      fs.symlinkSync(outsideDir, srcDir);

      const beforeRepoSnapshot = snapshotDirectory(repo);
      const beforeOutsideSnapshot = snapshotDirectory(outsideDir);

      const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'unsafe-symlink');
      assert.match(res.error, /Directory component "src" is a symbolic link/);

      // Verify no mutation occurred on the repository or outside target
      const afterRepoSnapshot = snapshotDirectory(repo);
      const afterOutsideSnapshot = snapshotDirectory(outsideDir);
      assertSnapshotsEqual(beforeRepoSnapshot, afterRepoSnapshot);
      assertSnapshotsEqual(beforeOutsideSnapshot, afterOutsideSnapshot);
    });

    test('fails closed when destination parent directory is missing or not a directory', async () => {
      const repo = setupDisposableRepo('tx-swap-bad-parent-');
      const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      // Replace src/endpoints with a regular file
      const endpointsDir = path.join(repo, 'src/endpoints');
      fs.rmSync(endpointsDir, { recursive: true, force: true });
      fs.writeFileSync(endpointsDir, 'not a directory');

      const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'parent-dir-invalid');
    });

    test('fails closed when destination parent directory is a symbolic link', async () => {
      const repo = setupDisposableRepo('tx-swap-symlink-parent-');
      const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      const endpointsDir = path.join(repo, 'src/endpoints');
      const realEndpoints = path.join(repo, 'src/endpoints-real');
      fs.renameSync(endpointsDir, realEndpoints);
      fs.symlinkSync(realEndpoints, endpointsDir);

      const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
      assert.equal(res.ok, false);
      assert.ok(
        res.code === 'unsafe-symlink' ||
        res.code === 'parent-dir-invalid' ||
        res.code === 'parent-dir-open-error'
      );
    });

    test('F1-A: rejects symlinks in staging ancestor components (.ci-patch, .ci-patch/staging, staging/<txId>)', async () => {
      // 1. .ci-patch is a symlink
      {
        const repo = setupDisposableRepo('tx-swap-symlink-cipatch-');
        const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });
        const ciPatchDir = path.join(repo, '.ci-patch');
        const outside = createTempDir('outside-cipatch-');
        fs.cpSync(ciPatchDir, outside, { recursive: true });
        fs.rmSync(ciPatchDir, { recursive: true, force: true });
        fs.symlinkSync(outside, ciPatchDir);

        const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
        assert.equal(res.ok, false);
        assert.equal(res.code, 'unsafe-symlink');
      }

      // 2. .ci-patch/staging is a symlink
      {
        const repo = setupDisposableRepo('tx-swap-symlink-staging-parent-');
        const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });
        const stagingDir = path.join(repo, '.ci-patch/staging');
        const outside = createTempDir('outside-staging-');
        fs.cpSync(stagingDir, outside, { recursive: true });
        fs.rmSync(stagingDir, { recursive: true, force: true });
        fs.symlinkSync(outside, stagingDir);

        const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
        assert.equal(res.ok, false);
        assert.equal(res.code, 'unsafe-symlink');
      }

      // 3. .ci-patch/staging/<txId> is a symlink
      {
        const repo = setupDisposableRepo('tx-swap-symlink-staging-tx-');
        const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });
        const stagingTxDir = path.join(repo, `.ci-patch/staging/${txId}`);
        const outside = createTempDir('outside-staging-tx-');
        fs.cpSync(stagingTxDir, outside, { recursive: true });
        fs.rmSync(stagingTxDir, { recursive: true, force: true });
        fs.symlinkSync(outside, stagingTxDir);

        const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
        assert.equal(res.ok, false);
        assert.equal(res.code, 'unsafe-symlink');
      }
    });

    test('F1-A: rejects symlinks in backup ancestor components (.ci-patch/backup, backup/<txId>)', async () => {
      // 1. .ci-patch/backup is a symlink
      {
        const repo = setupDisposableRepo('tx-swap-symlink-backup-parent-');
        const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });
        const backupDir = path.join(repo, '.ci-patch/backup');
        const outside = createTempDir('outside-backup-');
        fs.cpSync(backupDir, outside, { recursive: true });
        fs.rmSync(backupDir, { recursive: true, force: true });
        fs.symlinkSync(outside, backupDir);

        const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
        assert.equal(res.ok, false);
        assert.equal(res.code, 'unsafe-symlink');
      }

      // 2. .ci-patch/backup/<txId> is a symlink
      {
        const repo = setupDisposableRepo('tx-swap-symlink-backup-tx-');
        const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });
        const backupTxDir = path.join(repo, `.ci-patch/backup/${txId}`);
        const outside = createTempDir('outside-backup-tx-');
        fs.cpSync(backupTxDir, outside, { recursive: true });
        fs.rmSync(backupTxDir, { recursive: true, force: true });
        fs.symlinkSync(outside, backupTxDir);

        const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
        assert.equal(res.ok, false);
        assert.equal(res.code, 'unsafe-symlink');
      }
    });

    test('F1-A & F1-B: rejects unexpected artifacts in staging transaction directory', async () => {
      const repo = setupDisposableRepo('tx-swap-unexpected-staging-');
      const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      const stagingTxDir = path.join(repo, `.ci-patch/staging/${txId}`);
      fs.writeFileSync(path.join(stagingTxDir, 'extra-file.tmp'), 'foreign artifact');

      const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'unexpected-staging-artifacts');
    });

    test('F1-A & F1-B: rejects unexpected artifacts in backup transaction directory', async () => {
      const repo = setupDisposableRepo('tx-swap-unexpected-backup-');
      const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      const backupTxDir = path.join(repo, `.ci-patch/backup/${txId}`);
      fs.writeFileSync(path.join(backupTxDir, 'extra-file.tmp'), 'foreign artifact');

      const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'unexpected-backup-artifacts');
    });

    test('F1-A: fails closed if destination parent directory identity changes after initial authentication', async () => {
      const repo = setupDisposableRepo('tx-swap-parent-identity-change-');
      const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      const endpointsDir = path.join(repo, 'src/endpoints');
      const res = await authenticateSwapPrerequisites({
        repoRoot: repo,
        txId,
        op,
        lease,
        manifest,
        faultHook: (stage) => {
          if (stage === 'after-parent-authenticated') {
            // Concurrently recreate src/endpoints with a distinct inode
            const tempCopy = createTempDir('endpoints-copy-');
            fs.cpSync(endpointsDir, tempCopy, { recursive: true });
            fs.rmSync(endpointsDir, { recursive: true, force: true });
            fs.cpSync(tempCopy, endpointsDir, { recursive: true });
          }
        },
      });

      assert.equal(res.ok, false);
      assert.equal(res.code, 'parent-dir-continuity-error');
      assert.match(res.error, /identity or type modified concurrently/);
    });

    test('fails closed when procfs directory is unavailable', async () => {
      const repo = setupDisposableRepo('tx-swap-no-procfs-');
      const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      const res = await authenticateSwapPrerequisites({
        repoRoot: repo,
        txId,
        op,
        lease,
        manifest,
        procDir: '/nonexistent/proc/self/fd',
      });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'procfs-unavailable');
    });
  });

  describe('Artifact Authentications and Boundary Refusals (F1-B, F1-C, F1-D)', () => {
    test('rejects tampered isolated staging content', async () => {
      const repo = setupDisposableRepo('tx-swap-tampered-staging-');
      const { txId, op, lease, stagingFile } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      fs.writeFileSync(stagingFile, 'tampered staging content\n');
      fs.chmodSync(stagingFile, 0o600);
      const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'staging-digest-mismatch');
    });

    test('F1-B: rejects isolated staging file mode mismatch (e.g. 0644 instead of 0600)', async () => {
      const repo = setupDisposableRepo('tx-swap-staging-mode-mismatch-');
      const { txId, op, lease, stagingFile } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      fs.chmodSync(stagingFile, 0o644);
      const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'staging-mode-mismatch');
      assert.match(res.error, /expected "0600"/);
    });

    test('F1-C: rejects isolated staging file with special permission bits (04600)', async () => {
      const repo = setupDisposableRepo('tx-swap-staging-special-mode-');
      const { txId, op, lease, stagingFile } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      fs.chmodSync(stagingFile, 0o4600);
      const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
      assert.equal(res.ok, false);
      assert.ok(res.code === 'unsupported-special-mode' || res.code === 'staging-verification-failed');
    });

    test('rejects missing or symlink isolated staging', async () => {
      const repo = setupDisposableRepo('tx-swap-missing-staging-');
      const { txId, op, lease, stagingFile } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      fs.unlinkSync(stagingFile);
      const resMissing = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
      assert.equal(resMissing.ok, false);
      assert.ok(
        resMissing.code === 'file-missing' ||
        resMissing.code === 'staging-verification-failed' ||
        resMissing.code === 'unexpected-staging-artifacts'
      );

      const dummy = path.join(repo, 'dummy.txt');
      fs.writeFileSync(dummy, 'dummy');
      fs.symlinkSync(dummy, stagingFile);
      const resSymlink = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
      assert.equal(resSymlink.ok, false);
      assert.ok(resSymlink.code === 'unsafe-symlink' || resSymlink.code === 'staging-verification-failed');
    });

    test('rejects tampered backup content', async () => {
      const repo = setupDisposableRepo('tx-swap-tampered-backup-');
      const { txId, op, lease, backupFile } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      fs.writeFileSync(backupFile, 'tampered backup content\n');
      fs.chmodSync(backupFile, 0o600);
      const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'backup-digest-mismatch');
    });

    test('F1-B: rejects backup file mode mismatch (e.g. 0644 instead of 0600)', async () => {
      const repo = setupDisposableRepo('tx-swap-backup-mode-mismatch-');
      const { txId, op, lease, backupFile } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      fs.chmodSync(backupFile, 0o644);
      const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'backup-mode-mismatch');
      assert.match(res.error, /expected "0600"/);
    });

    test('F1-C: rejects backup file with special permission bits (04600)', async () => {
      const repo = setupDisposableRepo('tx-swap-backup-special-mode-');
      const { txId, op, lease, backupFile } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      fs.chmodSync(backupFile, 0o4600);
      const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
      assert.equal(res.ok, false);
      assert.ok(res.code === 'unsupported-special-mode' || res.code === 'backup-verification-failed');
    });

    test('rejects missing or symlink backup', async () => {
      const repo = setupDisposableRepo('tx-swap-missing-backup-');
      const { txId, op, lease, backupFile } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      fs.unlinkSync(backupFile);
      const resMissing = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
      assert.equal(resMissing.ok, false);
      assert.ok(
        resMissing.code === 'file-missing' ||
        resMissing.code === 'backup-verification-failed' ||
        resMissing.code === 'unexpected-backup-artifacts'
      );
    });

    test('rejects tampered live target content (or live target already patched)', async () => {
      const repo = setupDisposableRepo('tx-swap-tampered-target-');
      const { txId, op, lease, liveTarget } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      // Modify target content
      fs.writeFileSync(liveTarget, 'tampered live target content\n');
      fs.chmodSync(liveTarget, 0o644);
      const res1 = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
      assert.equal(res1.ok, false);
      assert.equal(res1.code, 'target-digest-mismatch');

      // Live target already containing result bytes
      fs.writeFileSync(liveTarget, authenticPatched);
      fs.chmodSync(liveTarget, 0o644);
      const res2 = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
      assert.equal(res2.ok, false);
      assert.equal(res2.code, 'target-digest-mismatch');
    });

    test('rejects missing or symlink live target', async () => {
      const repo = setupDisposableRepo('tx-swap-missing-target-');
      const { txId, op, lease, liveTarget } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      fs.unlinkSync(liveTarget);
      const resMissing = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
      assert.equal(resMissing.ok, false);
      assert.ok(resMissing.code === 'file-missing' || resMissing.code === 'live-target-verification-failed');

      const dummy = path.join(repo, 'dummy.txt');
      fs.writeFileSync(dummy, 'dummy');
      fs.symlinkSync(dummy, liveTarget);
      const resSymlink = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
      assert.equal(resSymlink.ok, false);
      assert.ok(resSymlink.code === 'unsafe-symlink' || resSymlink.code === 'live-target-verification-failed');
    });

    test('rejects live target mode mismatch', async () => {
      const repo = setupDisposableRepo('tx-swap-target-mode-');
      const { txId, op, lease, liveTarget } = setupTxAtReadyToSwap({ repo, op: 'apply', targetMode: '0644' });

      fs.chmodSync(liveTarget, 0o600);
      const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'target-mode-mismatch');
    });

    test('F1-C: rejects live target with setuid permission bit (04644)', async () => {
      const repo = setupDisposableRepo('tx-swap-target-setuid-');
      const { txId, op, lease, liveTarget } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      try {
        fs.chmodSync(liveTarget, 0o4644);
        const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
        assert.equal(res.ok, false);
        assert.ok(res.code === 'unsupported-special-mode' || res.code === 'live-target-verification-failed');
      } catch (e) {
        if (e.code !== 'unsupported-special-mode') throw e;
      }
    });

    test('F1-C: rejects live target with setgid permission bit (02644)', async () => {
      const repo = setupDisposableRepo('tx-swap-target-setgid-');
      const { txId, op, lease, liveTarget } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      try {
        fs.chmodSync(liveTarget, 0o2644);
        const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
        assert.equal(res.ok, false);
        assert.ok(res.code === 'unsupported-special-mode' || res.code === 'live-target-verification-failed');
      } catch (e) {
        if (e.code !== 'unsupported-special-mode') throw e;
      }
    });

    test('F1-C: rejects live target with sticky permission bit (01644)', async () => {
      const repo = setupDisposableRepo('tx-swap-target-sticky-');
      const { txId, op, lease, liveTarget } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      try {
        fs.chmodSync(liveTarget, 0o1644);
        const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
        assert.equal(res.ok, false);
        assert.ok(res.code === 'unsupported-special-mode' || res.code === 'live-target-verification-failed');
      } catch (e) {
        if (e.code !== 'unsupported-special-mode') throw e;
      }
    });

    test('rejects FIFO live target safely and non-blockingly', async (t) => {
      let hasMkfifo = false;
      try {
        child_process.execFileSync('mkfifo', ['--version'], { stdio: 'ignore' });
        hasMkfifo = true;
      } catch (err) {
        if (err?.code !== 'ENOENT') {
          hasMkfifo = true;
        }
      }

      if (!hasMkfifo) {
        if (typeof t?.diagnostic === 'function') {
          t.diagnostic('Skipping FIFO live target test: mkfifo utility is not available on this platform');
        }
        return;
      }

      const repo = setupDisposableRepo('tx-swap-fifo-target-');
      const { txId, op, lease, liveTarget } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      fs.unlinkSync(liveTarget);
      child_process.execFileSync('mkfifo', [liveTarget]);

      const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
      assert.equal(res.ok, false);
      assert.ok(
        res.code === 'unsupported-type' ||
        res.code === 'live-target-verification-failed'
      );
    });

    test('rejects tampered destination candidate content', async () => {
      const repo = setupDisposableRepo('tx-swap-tampered-cand-');
      const { txId, op, lease, candidateFile } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      fs.writeFileSync(candidateFile, 'tampered candidate content\n');
      fs.chmodSync(candidateFile, 0o644);
      const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'candidate-digest-mismatch');
    });

    test('rejects missing or symlink destination candidate', async () => {
      const repo = setupDisposableRepo('tx-swap-missing-cand-');
      const { txId, op, lease, candidateFile } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      fs.unlinkSync(candidateFile);
      const resMissing = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
      assert.equal(resMissing.ok, false);
      assert.ok(resMissing.code === 'file-missing' || resMissing.code === 'candidate-verification-failed');

      const dummy = path.join(repo, 'dummy.txt');
      fs.writeFileSync(dummy, 'dummy');
      fs.symlinkSync(dummy, candidateFile);
      const resSymlink = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
      assert.equal(resSymlink.ok, false);
      assert.ok(resSymlink.code === 'unsafe-symlink' || resSymlink.code === 'candidate-verification-failed');
    });

    test('rejects destination candidate mode mismatch', async () => {
      const repo = setupDisposableRepo('tx-swap-cand-mode-');
      const { txId, op, lease, candidateFile } = setupTxAtReadyToSwap({ repo, op: 'apply', targetMode: '0644' });

      fs.chmodSync(candidateFile, 0o600);
      const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'candidate-mode-mismatch');
    });

    test('F1-C: rejects destination candidate with special permission bits (04644)', async () => {
      const repo = setupDisposableRepo('tx-swap-cand-special-mode-');
      const { txId, op, lease, candidateFile } = setupTxAtReadyToSwap({ repo, op: 'apply', targetMode: '0644' });

      try {
        fs.chmodSync(candidateFile, 0o4644);
        const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
        assert.equal(res.ok, false);
        assert.ok(res.code === 'unsupported-special-mode' || res.code === 'candidate-verification-failed');
      } catch (e) {
        if (e.code !== 'unsupported-special-mode') throw e;
      }
    });

    test('rejects destination candidate inode collision with live target', async () => {
      const repo = setupDisposableRepo('tx-swap-cand-inode-');
      const { txId, op, lease, candidateFile, liveTarget } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      // Link candidate to live target (sharing inode)
      fs.unlinkSync(candidateFile);
      fs.linkSync(liveTarget, candidateFile);

      const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
      assert.equal(res.ok, false);
      assert.ok(
        res.code === 'candidate-inode-collision' ||
        res.code === 'unexpected-link-count' ||
        res.code === 'live-target-verification-failed'
      );
    });

    test('rejects unexpected hardlinks (nlink > 1) on verified artifacts', async () => {
      const repo = setupDisposableRepo('tx-swap-hardlinks-');
      const { txId, op, lease, stagingFile } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      // Add hardlink to staging file
      const extraLink = path.join(repo, 'staging-extra.link');
      fs.linkSync(stagingFile, extraLink);

      const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
      assert.equal(res.ok, false);
      assert.ok(
        res.code === 'unexpected-link-count' ||
        res.code === 'staging-verification-failed'
      );
    });

    // F1-D: Destination parent descriptor failure injection
    test('F1-D: fails closed when destination parent directory closeSync fails on otherwise successful authentication', async () => {
      const repo = setupDisposableRepo('tx-swap-parent-close-err-');
      const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      const endpointsDir = path.join(repo, 'src/endpoints');
      const parentStat = fs.statSync(endpointsDir);

      const origClose = fs.closeSync;
      let parentCloseAttempted = false;

      try {
        fs.closeSync = (fd) => {
          try {
            const st = fs.fstatSync(fd);
            if (st.isDirectory() && st.ino === parentStat.ino) {
              parentCloseAttempted = true;
              origClose(fd); // simulate post-close error reporting: genuine close happens first
              const err = new Error('simulated parent directory close EIO failure');
              err.code = 'EIO';
              throw err;
            }
          } catch (e) {
            if (e.code === 'EIO') throw e;
          }
          return origClose(fd);
        };

        const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
        assert.equal(res.ok, false);
        assert.equal(res.verified, false);
        assert.ok(res.code === 'parent-dir-close-error' || res.code === 'EIO');
        assert.match(res.error, /Failed to close destination parent directory descriptor/);
        assert.ok(res.closeError, 'closeError diagnostic attached');
        assert.equal(res.closeError.uncertain, true);
        assert.equal(res.descriptorCloseUncertain, true);
        assert.equal(parentCloseAttempted, true, 'Destination parent directory closeSync was attempted');
      } finally {
        fs.closeSync = origClose;
      }
    });

    test('F2-A: preserves primary verification error and attaches secondary diagnostic when destination parent directory closeSync fails', async () => {
      const repo = setupDisposableRepo('tx-swap-parent-primary-close-');
      const { txId, op, lease, stagingFile } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      // Introduce primary verification failure: tampered staging file
      fs.writeFileSync(stagingFile, 'tampered staging content\n');
      fs.chmodSync(stagingFile, 0o600);

      const endpointsDir = path.join(repo, 'src/endpoints');
      const parentStat = fs.statSync(endpointsDir);

      const origClose = fs.closeSync;
      let parentCloseAttempted = false;

      try {
        fs.closeSync = (fd) => {
          try {
            const st = fs.fstatSync(fd);
            if (st.isDirectory() && st.ino === parentStat.ino) {
              parentCloseAttempted = true;
              origClose(fd); // simulate post-close error reporting: genuine close happens first
              const err = new Error('secondary parent directory close failure');
              err.code = 'EIO';
              throw err;
            }
          } catch (e) {
            if (e.code === 'EIO') throw e;
          }
          return origClose(fd);
        };

        const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
        assert.equal(res.ok, false);
        assert.equal(res.verified, false);
        // Primary error (staging digest mismatch) must be preserved!
        assert.equal(res.code, 'staging-digest-mismatch');
        assert.equal(res.stage, 'isolated-staging-verification');
        assert.ok(res.reason, 'Primary reason is preserved');
        assert.match(res.reason, /staging SHA-256 mismatch/i);

        // Secondary descriptor-close error must be attached in structured diagnostic field (F2-A)
        assert.ok(res.closeError, 'Secondary closeError diagnostic is attached');
        assert.equal(res.closeError.code, 'EIO');
        assert.equal(res.closeError.status, 'failed');
        assert.equal(res.closeError.uncertain, true);
        assert.match(res.closeError.message, /secondary parent directory close failure/);
        assert.equal(res.descriptorCloseUncertain, true, 'descriptorCloseUncertain flag is set');

        assert.equal(parentCloseAttempted, true, 'Parent close was attempted during cleanup');
      } finally {
        fs.closeSync = origClose;
      }
    });

    test('F1-D: propagates intentional crash fault without leaking parent or file descriptors', async () => {
      const repo = setupDisposableRepo('tx-swap-fault-leak-');
      const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      const openedFds = new Set();
      const closedFds = new Set();
      const origOpen = fs.openSync;
      const origClose = fs.closeSync;

      try {
        fs.openSync = (...args) => {
          const fd = origOpen.apply(fs, args);
          openedFds.add(fd);
          return fd;
        };

        fs.closeSync = (fd) => {
          closedFds.add(fd);
          return origClose(fd);
        };

        let caughtErr = null;
        try {
          await authenticateSwapPrerequisites({
            repoRoot: repo,
            txId,
            op,
            lease,
            manifest,
            faultHook: (stage) => {
              if (stage === 'after-parent-authenticated') {
                const err = new Error('simulated process crash fault');
                err._isFault = true;
                throw err;
              }
            },
          });
        } catch (err) {
          caughtErr = err;
        }

        assert.ok(caughtErr, 'Expected crash fault to propagate');
        assert.equal(caughtErr._isFault, true);
        assert.match(caughtErr.message, /simulated process crash fault/);

        // All descriptors opened during the aborted verification must have been closed
        const unclosed = Array.from(openedFds).filter((fd) => !closedFds.has(fd));
        assert.equal(unclosed.length, 0, `All descriptors must be closed; leaked fds: ${unclosed.join(', ')}`);
      } finally {
        fs.openSync = origOpen;
        fs.closeSync = origClose;
      }
    });
  });

  describe('Authentic Fixture Test Correctness (F1-F)', () => {
    test('F1-F: setupTxAtReadyToSwap throws descriptive error if authentic fixture is unavailable', () => {
      const repo = setupDisposableRepo('tx-swap-no-fixture-');
      assert.throws(
        () => setupTxAtReadyToSwap({ repo, stockContent: null }),
        /setupTxAtReadyToSwap requires authentic fixture buffers/
      );
      assert.throws(
        () => setupTxAtReadyToSwap({ repo, patchedContent: null }),
        /setupTxAtReadyToSwap requires authentic fixture buffers/
      );
    });
  });
});

async function loadIsolatedTestHarness() {
  const targetSwapPath = path.resolve(REPO_ROOT, 'src/patch-installer/target-swap.js');
  let src = fs.readFileSync(targetSwapPath, 'utf8');
  const targetDir = path.dirname(targetSwapPath);
  src = src.replace(/from '\.\/([^']+)'/g, (m, p) => `from '${pathToFileURL(path.join(targetDir, p)).href}'`);
  src = src.replace(/from '\.\.\/\.\.\/scripts\/([^']+)'/g, (m, p) => `from '${pathToFileURL(path.join(REPO_ROOT, 'scripts', p)).href}'`);
  src = src.replace(/const REPO_ROOT = path\.resolve\(__dirname, '\.\.\/\.\.'\);/, `const REPO_ROOT = ${JSON.stringify(REPO_ROOT)};`);
  src += '\nexport { authenticatePrerequisitesCore };\n';
  const tmpDir = createTempDir('target-swap-harness-');
  const tmpFile = path.join(tmpDir, 'target-swap.instrumented.mjs');
  fs.writeFileSync(tmpFile, src);
  return import(pathToFileURL(tmpFile).href);
}

const harness = await loadIsolatedTestHarness();
const authenticatePrerequisitesCore = harness.authenticatePrerequisitesCore;

describe('D01-P3B-2D-2-C1: Private Authentication Core and Descriptor Retention', () => {
  test('C1-01: authenticatePrerequisitesCore is accessible via test-isolated harness and is an async function', () => {
    assert.equal(typeof authenticatePrerequisitesCore, 'function');
  });

  test('F1-C-01: Public module exports contain only accepted Stage B/C1 functions and constants', () => {
    const expectedExports = [
      'CERTIFIED_TARGET_FILE',
      'MAX_SWAP_FILE_BYTES',
      'SPECIAL_MODE_MASK',
      'authenticatePreSwap',
      'authenticateSwapPrerequisites',
      'isValidOpenConstant',
      'readBoundedNonblockingFile',
      'swapVerifiedTarget',
    ].sort();

    const actualExports = Object.keys(targetSwapModule).sort();
    assert.deepEqual(actualExports, expectedExports);
    assert.equal(targetSwapModule.authenticatePrerequisitesCore, undefined);
  });

  test('F1-C-02: Public authenticateSwapPrerequisites and authenticatePreSwap expose zero Symbol properties', () => {
    const swapSymbols = Object.getOwnPropertySymbols(authenticateSwapPrerequisites);
    assert.deepEqual(swapSymbols, [], 'authenticateSwapPrerequisites must have no Symbol properties');

    const preSwapSymbols = Object.getOwnPropertySymbols(authenticatePreSwap);
    assert.deepEqual(preSwapSymbols, [], 'authenticatePreSwap must have no Symbol properties');

    const globalSymbol = Symbol.for('ci.patch-installer.target-swap.authenticatePrerequisitesCore');
    assert.equal(authenticateSwapPrerequisites[globalSymbol], undefined);
    assert.equal(authenticatePreSwap[globalSymbol], undefined);
  });

  test('F1-C-03: No caller can retrieve authenticatePrerequisitesCore from public exports or function instances', () => {
    assert.equal(targetSwapModule.authenticatePrerequisitesCore, undefined);
    assert.equal(authenticateSwapPrerequisites.authenticatePrerequisitesCore, undefined);
    assert.equal(authenticatePreSwap.authenticatePrerequisitesCore, undefined);

    const standardProps = new Set(['length', 'name', 'prototype', 'arguments', 'caller']);
    const nonStandardSwapProps = Object.getOwnPropertyNames(authenticateSwapPrerequisites).filter((p) => !standardProps.has(p));
    assert.deepEqual(nonStandardSwapProps, []);

    const nonStandardPreSwapProps = Object.getOwnPropertyNames(authenticatePreSwap).filter((p) => !standardProps.has(p));
    assert.deepEqual(nonStandardPreSwapProps, []);
  });

  test('F1-C-04: Passing { retainParentDescriptor: true } to public APIs never returns parentFd and closes all descriptors', async (t) => {
    if (skipIfNoAuthenticFixture(t, 'F1-C-04')) return;
    const repo = setupDisposableRepo('tx-swap-f1c-pub-ignore-');
    const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

    for (const apiFn of [authenticateSwapPrerequisites, authenticatePreSwap]) {
      const openedFds = new Set();
      const closedFds = new Set();
      const origOpen = fs.openSync;
      const origClose = fs.closeSync;

      try {
        fs.openSync = (...args) => {
          const fd = origOpen.apply(fs, args);
          openedFds.add(fd);
          return fd;
        };
        fs.closeSync = (fd) => {
          closedFds.add(fd);
          return origClose(fd);
        };

        const res = await apiFn({
          repoRoot: repo,
          txId,
          op,
          lease,
          manifest,
          retainParentDescriptor: true,
        });

        assert.equal(res.ok, true);
        assert.equal(res.verified, true);
        assert.equal(res.parentFd, undefined, 'Public API must never return parentFd');
        assert.equal(res.parentStat, undefined, 'Public API must never return parentStat');

        const unclosed = Array.from(openedFds).filter((fd) => !closedFds.has(fd));
        assert.equal(unclosed.length, 0, `All descriptors must be closed; leaked fds: ${unclosed.join(', ')}`);
      } finally {
        fs.openSync = origOpen;
        fs.closeSync = origClose;
      }
    }
  });

  test('C1-02: Stage B public authenticateSwapPrerequisites API signature and result shape are strictly preserved without parentFd', async (t) => {
    if (skipIfNoAuthenticFixture(t, 'C1-02')) return;
    const repo = setupDisposableRepo('tx-swap-c1-api-preserve-');
    const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

    const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
    assert.equal(res.ok, true);
    assert.equal(res.verified, true);
    assert.equal(res.parentFd, undefined, 'Public API must never expose parentFd');
    assert.equal(res.parentStat, undefined, 'Public API must never expose parentStat');

    // Confirm all expected Stage B informational fields are intact
    assert.equal(res.txId, txId);
    assert.equal(res.op, op);
    assert.equal(res.targetFile, 'src/endpoints/stable-diffusion.js');
    assert.equal(res.targetMode, '0644');
    assert.equal(typeof res.targetDev === 'number' || typeof res.targetDev === 'bigint', true);
    assert.equal(typeof res.targetIno === 'number' || typeof res.targetIno === 'bigint', true);
    assert.equal(typeof res.candidateDev === 'number' || typeof res.candidateDev === 'bigint', true);
    assert.equal(typeof res.candidateIno === 'number' || typeof res.candidateIno === 'bigint', true);
    assert.equal(typeof res.parentDev === 'number' || typeof res.parentDev === 'bigint', true);
    assert.equal(typeof res.parentIno === 'number' || typeof res.parentIno === 'bigint', true);
  });

  test('C1-03: Public authenticateSwapPrerequisites strictly ignores retainParentDescriptor option and closes all descriptors', async (t) => {
    if (skipIfNoAuthenticFixture(t, 'C1-03')) return;
    const repo = setupDisposableRepo('tx-swap-c1-pub-ignore-');
    const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

    const openedFds = new Set();
    const closedFds = new Set();
    const origOpen = fs.openSync;
    const origClose = fs.closeSync;

    try {
      fs.openSync = (...args) => {
        const fd = origOpen.apply(fs, args);
        openedFds.add(fd);
        return fd;
      };
      fs.closeSync = (fd) => {
        closedFds.add(fd);
        return origClose(fd);
      };

      // Even when caller passes retainParentDescriptor: true into public API, it must be ignored
      const res = await authenticateSwapPrerequisites({
        repoRoot: repo,
        txId,
        op,
        lease,
        manifest,
        retainParentDescriptor: true,
      });

      assert.equal(res.ok, true);
      assert.equal(res.parentFd, undefined, 'Public API must never return parentFd');

      // Every opened descriptor must be closed
      const unclosed = Array.from(openedFds).filter((fd) => !closedFds.has(fd));
      assert.equal(unclosed.length, 0, `All descriptors must be closed; leaked fds: ${unclosed.join(', ')}`);
    } finally {
      fs.openSync = origOpen;
      fs.closeSync = origClose;
    }
  });

  test('C1-04: authenticatePrerequisitesCore with retainParentDescriptor: false closes all descriptors and omits parentFd', async (t) => {
    if (skipIfNoAuthenticFixture(t, 'C1-04')) return;
    const repo = setupDisposableRepo('tx-swap-c1-core-false-');
    const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

    const openedFds = new Set();
    const closedFds = new Set();
    const origOpen = fs.openSync;
    const origClose = fs.closeSync;

    try {
      fs.openSync = (...args) => {
        const fd = origOpen.apply(fs, args);
        openedFds.add(fd);
        return fd;
      };
      fs.closeSync = (fd) => {
        closedFds.add(fd);
        return origClose(fd);
      };

      const res = await authenticatePrerequisitesCore(
        { repoRoot: repo, txId, op, lease, manifest },
        { retainParentDescriptor: false }
      );

      assert.equal(res.ok, true);
      assert.equal(res.parentFd, undefined);

      const unclosed = Array.from(openedFds).filter((fd) => !closedFds.has(fd));
      assert.equal(unclosed.length, 0, `All descriptors must be closed; leaked fds: ${unclosed.join(', ')}`);
    } finally {
      fs.openSync = origOpen;
      fs.closeSync = origClose;
    }
  });

  test('C1-05: authenticatePrerequisitesCore with retainParentDescriptor: true transfers ownership of parentFd exactly once', async (t) => {
    if (skipIfNoAuthenticFixture(t, 'C1-05')) return;
    const repo = setupDisposableRepo('tx-swap-c1-core-true-');
    const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

    const activeFds = new Set();
    const origOpen = fs.openSync;
    const origClose = fs.closeSync;

    let retainedFd = null;

    try {
      fs.openSync = (...args) => {
        const fd = origOpen.apply(fs, args);
        activeFds.add(fd);
        return fd;
      };
      fs.closeSync = (fd) => {
        activeFds.delete(fd);
        return origClose(fd);
      };

      const res = await authenticatePrerequisitesCore(
        { repoRoot: repo, txId, op, lease, manifest },
        { retainParentDescriptor: true }
      );

      assert.equal(res.ok, true);
      assert.equal(typeof res.parentFd, 'number');
      assert.ok(res.parentFd > 0);
      retainedFd = res.parentFd;

      // Retained descriptor must remain active/open (core transferred without closing)
      assert.ok(activeFds.has(retainedFd), 'Transferred descriptor must remain active and open');

      // All OTHER descriptors (manifest, staging, backup, live target, candidate) must be closed
      assert.deepEqual(
        Array.from(activeFds),
        [retainedFd],
        'Only the transferred parentFd must remain active after successful retention'
      );

      // The descriptor is valid and open in the current process
      const stat = fs.fstatSync(retainedFd);
      assert.equal(stat.isDirectory(), true);
      assert.equal(stat.dev, res.parentDev);
      assert.equal(stat.ino, res.parentIno);
    } finally {
      fs.openSync = origOpen;
      fs.closeSync = origClose;

      // Caller exclusively owns the retained descriptor and closes it in finally
      if (retainedFd !== null) {
        fs.closeSync(retainedFd);
      }
    }

    // Verify that after caller closed it, the descriptor is no longer open
    assert.throws(() => fs.fstatSync(retainedFd), { code: 'EBADF' });
  });

  test('C1-06: Retained descriptor continues identifying destination parent directory until authorized owner closes it', async (t) => {
    if (skipIfNoAuthenticFixture(t, 'C1-06')) return;
    const repo = setupDisposableRepo('tx-swap-c1-ident-');
    const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

    let retainedFd = null;
    try {
      const res = await authenticatePrerequisitesCore(
        { repoRoot: repo, txId, op, lease, manifest },
        { retainParentDescriptor: true }
      );
      assert.equal(res.ok, true);
      retainedFd = res.parentFd;

      // Verify directory descriptor anchoring via procfs
      const procDir = path.join('/proc/self/fd', String(retainedFd));
      const entries = fs.readdirSync(procDir);
      assert.ok(entries.includes('stable-diffusion.js'), 'Retained parentFd must resolve to destination directory');
      assert.ok(entries.includes(`.stable-diffusion.js.ci-staged-${txId}.tmp`));

      const stat = fs.fstatSync(retainedFd);
      assert.equal(stat.dev, res.parentDev);
      assert.equal(stat.ino, res.parentIno);
    } finally {
      if (retainedFd !== null) {
        fs.closeSync(retainedFd);
      }
    }
  });

  test('C1-07: Failed authentication never transfers a descriptor when retainParentDescriptor: true', async (t) => {
    if (skipIfNoAuthenticFixture(t, 'C1-07')) return;
    const repo = setupDisposableRepo('tx-swap-c1-fail-no-transfer-');
    const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

    // Tamper destination candidate content so authentication fails at step 13
    const candidatePath = path.join(repo, `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp`);
    fs.writeFileSync(candidatePath, 'tampered-candidate-bytes\n');

    const openedFds = new Set();
    const closedFds = new Set();
    const origOpen = fs.openSync;
    const origClose = fs.closeSync;

    try {
      fs.openSync = (...args) => {
        const fd = origOpen.apply(fs, args);
        openedFds.add(fd);
        return fd;
      };
      fs.closeSync = (fd) => {
        closedFds.add(fd);
        return origClose(fd);
      };

      const res = await authenticatePrerequisitesCore(
        { repoRoot: repo, txId, op, lease, manifest },
        { retainParentDescriptor: true }
      );

      assert.equal(res.ok, false);
      assert.equal(res.code, 'candidate-digest-mismatch');
      assert.equal(res.parentFd, undefined, 'Failed authentication must never transfer parentFd');

      // Every descriptor opened during the failed authentication must have been closed
      const unclosed = Array.from(openedFds).filter((fd) => !closedFds.has(fd));
      assert.equal(unclosed.length, 0, `All descriptors must be closed on failure; leaked: ${unclosed.join(', ')}`);
    } finally {
      fs.openSync = origOpen;
      fs.closeSync = origClose;
    }
  });

  test('C1-08: Pre-parent-open failure never opens or transfers a descriptor', async (t) => {
    if (skipIfNoAuthenticFixture(t, 'C1-08')) return;
    const repo = setupDisposableRepo('tx-swap-c1-pre-parent-fail-');
    const { txId, op } = setupTxAtReadyToSwap({ repo, op: 'apply' });

    // Pass invalid lease (null)
    const res = await authenticatePrerequisitesCore(
      { repoRoot: repo, txId, op, lease: null, manifest },
      { retainParentDescriptor: true }
    );

    assert.equal(res.ok, false);
    assert.equal(res.code, 'lease-required');
    assert.equal(res.parentFd, undefined);
  });

  test('C1-09: Exceptions during authentication with retainParentDescriptor: true do not leak descriptors', async (t) => {
    if (skipIfNoAuthenticFixture(t, 'C1-09')) return;
    const repo = setupDisposableRepo('tx-swap-c1-exc-no-leak-');
    const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

    const openedFds = new Set();
    const closedFds = new Set();
    const origOpen = fs.openSync;
    const origClose = fs.closeSync;

    try {
      fs.openSync = (...args) => {
        const fd = origOpen.apply(fs, args);
        openedFds.add(fd);
        return fd;
      };
      fs.closeSync = (fd) => {
        closedFds.add(fd);
        return origClose(fd);
      };

      let caughtErr = null;
      try {
        await authenticatePrerequisitesCore(
          {
            repoRoot: repo,
            txId,
            op,
            lease,
            manifest,
            faultHook: (stage) => {
              if (stage === 'after-parent-authenticated') {
                const err = new Error('simulated exception during authentication');
                err._isFault = true;
                throw err;
              }
            },
          },
          { retainParentDescriptor: true }
        );
      } catch (err) {
        caughtErr = err;
      }

      assert.ok(caughtErr, 'Expected fault exception to propagate');
      assert.equal(caughtErr._isFault, true);
      assert.match(caughtErr.message, /simulated exception/);

      // All descriptors opened prior to exception must have been closed in finally
      const unclosed = Array.from(openedFds).filter((fd) => !closedFds.has(fd));
      assert.equal(unclosed.length, 0, `All descriptors must be closed on exception; leaked: ${unclosed.join(', ')}`);
    } finally {
      fs.openSync = origOpen;
      fs.closeSync = origClose;
    }
  });

  test('C1-10: Close failure prevents successful authentication when retainParentDescriptor: false', async (t) => {
    if (skipIfNoAuthenticFixture(t, 'C1-10')) return;
    const repo = setupDisposableRepo('tx-swap-c1-close-fail-');
    const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

    const origClose = fs.closeSync;
    const absParentDir = path.resolve(repo, 'src/endpoints');
    const parentLstat = fs.lstatSync(absParentDir);

    try {
      fs.closeSync = (fd) => {
        try {
          const st = fs.fstatSync(fd);
          if (st.isDirectory() && st.dev === parentLstat.dev && st.ino === parentLstat.ino) {
            origClose(fd);
            const err = new Error('simulated EIO on destination parent closeSync');
            err.code = 'EIO';
            throw err;
          }
        } catch (checkErr) {
          if (checkErr.code === 'EIO') throw checkErr;
        }
        return origClose(fd);
      };

      const res = await authenticatePrerequisitesCore(
        { repoRoot: repo, txId, op, lease, manifest },
        { retainParentDescriptor: false }
      );

      assert.equal(res.ok, false);
      assert.equal(res.verified, false);
      assert.equal(res.code, 'EIO');
      assert.equal(res.descriptorCloseUncertain, true);
      assert.equal(res.parentFd, undefined);
    } finally {
      fs.closeSync = origClose;
    }
  });

  test('C1-11: Secondary close failure preserves primary error and does not transfer descriptor when retainParentDescriptor: true', async (t) => {
    if (skipIfNoAuthenticFixture(t, 'C1-11')) return;
    const repo = setupDisposableRepo('tx-swap-c1-sec-close-fail-');
    const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

    // Primary error: corrupt candidate SHA
    const candidatePath = path.join(repo, `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp`);
    fs.writeFileSync(candidatePath, 'tampered-candidate-data\n');

    const origClose = fs.closeSync;
    const absParentDir = path.resolve(repo, 'src/endpoints');
    const parentLstat = fs.lstatSync(absParentDir);

    try {
      fs.closeSync = (fd) => {
        try {
          const st = fs.fstatSync(fd);
          if (st.isDirectory() && st.dev === parentLstat.dev && st.ino === parentLstat.ino) {
            origClose(fd);
            const err = new Error('simulated secondary EIO on parent closeSync');
            err.code = 'EIO';
            throw err;
          }
        } catch (checkErr) {
          if (checkErr.code === 'EIO') throw checkErr;
        }
        return origClose(fd);
      };

      const res = await authenticatePrerequisitesCore(
        { repoRoot: repo, txId, op, lease, manifest },
        { retainParentDescriptor: true }
      );

      assert.equal(res.ok, false);
      assert.equal(res.code, 'candidate-digest-mismatch', 'Primary authentication error must be preserved');
      assert.ok(res.closeError, 'Secondary close error must be recorded');
      assert.equal(res.closeError.code, 'EIO');
      assert.equal(res.descriptorCloseUncertain, true);
      assert.equal(res.parentFd, undefined, 'Failed authentication must not transfer descriptor');
    } finally {
      fs.closeSync = origClose;
    }
  });

  test('C1-12: Strict No-Mutation: filesystem snapshot is 100% identical after authentication with retainParentDescriptor: true', async (t) => {
    if (skipIfNoAuthenticFixture(t, 'C1-12')) return;
    const repo = setupDisposableRepo('tx-swap-c1-no-mutation-');
    const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

    const beforeSnapshot = snapshotDirectory(repo);

    let renameCalled = false;
    let unlinkCalled = false;
    let writeCalled = false;
    let chmodCalled = false;

    const origRename = fs.renameSync;
    const origUnlink = fs.unlinkSync;
    const origWrite = fs.writeSync;
    const origChmod = fs.chmodSync;

    let retainedFd = null;
    try {
      fs.renameSync = (...args) => {
        renameCalled = true;
        return origRename.apply(fs, args);
      };
      fs.unlinkSync = (...args) => {
        unlinkCalled = true;
        return origUnlink.apply(fs, args);
      };
      fs.writeSync = (...args) => {
        writeCalled = true;
        return origWrite.apply(fs, args);
      };
      fs.chmodSync = (...args) => {
        chmodCalled = true;
        return origChmod.apply(fs, args);
      };

      const res = await authenticatePrerequisitesCore(
        { repoRoot: repo, txId, op, lease, manifest },
        { retainParentDescriptor: true }
      );

      assert.equal(res.ok, true);
      assert.equal(res.verified, true);
      retainedFd = res.parentFd;

      assert.equal(renameCalled, false, 'fs.renameSync must never be called during core authentication');
      assert.equal(unlinkCalled, false, 'fs.unlinkSync must never be called during core authentication');
      assert.equal(writeCalled, false, 'fs.writeSync must never be called during core authentication');
      assert.equal(chmodCalled, false, 'fs.chmodSync must never be called during core authentication');
    } finally {
      fs.renameSync = origRename;
      fs.unlinkSync = origUnlink;
      fs.writeSync = origWrite;
      fs.chmodSync = origChmod;

      if (retainedFd !== null) {
        fs.closeSync(retainedFd);
      }
    }

    const afterSnapshot = snapshotDirectory(repo);
    assert.equal(afterSnapshot.size, beforeSnapshot.size);
    for (const [relPath, beforeStat] of beforeSnapshot.entries()) {
      assert.ok(afterSnapshot.has(relPath), `File "${relPath}" must still exist`);
      const afterStat = afterSnapshot.get(relPath);
      assert.equal(afterStat.ino, beforeStat.ino, `Inode for "${relPath}" must match`);
      assert.equal(afterStat.mode, beforeStat.mode, `Mode for "${relPath}" must match`);
      assert.equal(afterStat.size, beforeStat.size, `Size for "${relPath}" must match`);
      assert.equal(afterStat.contentSha, beforeStat.contentSha, `SHA-256 for "${relPath}" must match`);
    }
  });

  test('C1-13: swapVerifiedTarget remains unimplemented regardless of caller options', async () => {
    await assert.rejects(
      async () => {
        await swapVerifiedTarget();
      },
      { code: 'unimplemented-stage-c', message: /Live target swap is not implemented/ }
    );

    await assert.rejects(
      async () => {
        await swapVerifiedTarget({
          repoRoot: '/fake',
          txId: 'ci-tx-123-abc',
          op: 'apply',
          retainParentDescriptor: true,
        });
      },
      { code: 'unimplemented-stage-c' }
    );
  });
});
