import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import child_process from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

import {
  readBoundedNonblockingFile,
  authenticateSwapPrerequisites,
  authenticateSwapPrerequisitesSync,
  authenticatePreSwap,
  swapVerifiedTarget,
  isValidOpenConstant,
  MAX_SWAP_FILE_BYTES,
  CERTIFIED_TARGET_FILE,
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
 * Setup a transaction at READY_TO_SWAP using authentic or provided contents.
 */
function setupTxAtReadyToSwap({
  repo,
  txId = generateTxId(),
  op = 'apply',
  targetMode = '0644',
  stockContent = authenticStock,
  patchedContent = authenticPatched,
}) {
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
    const filePath = path.join(dir, 'oversize.bin');
    fs.writeFileSync(filePath, Buffer.alloc(1024, 0x41));

    assert.throws(
      () => readBoundedNonblockingFile(filePath, { maxBytes: 512 }),
      (err) => {
        assert.equal(err.code, 'file-too-large');
        assert.match(err.message, /exceeds limit/);
        return true;
      }
    );
  });

  test('rejects empty file (0 bytes)', () => {
    const dir = createTempDir('reader-empty-');
    const filePath = path.join(dir, 'empty.txt');
    fs.writeFileSync(filePath, Buffer.alloc(0));

    assert.throws(
      () => readBoundedNonblockingFile(filePath),
      (err) => {
        assert.equal(err.code, 'empty-file');
        assert.match(err.message, /unexpectedly empty/);
        return true;
      }
    );
  });

  test('rejects symbolic link', () => {
    const dir = createTempDir('reader-symlink-');
    const realFile = path.join(dir, 'real.txt');
    const linkFile = path.join(dir, 'link.txt');
    fs.writeFileSync(realFile, 'real content\n');
    fs.symlinkSync(realFile, linkFile);

    assert.throws(
      () => readBoundedNonblockingFile(linkFile),
      (err) => {
        assert.equal(err.code, 'unsafe-symlink');
        assert.match(err.message, /symbolic link/);
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
        assert.match(err.message, /not a regular file/);
        return true;
      }
    );
  });

  test('rejects file with multiple hard links when requireSingleLink is true', () => {
    const dir = createTempDir('reader-hardlink-');
    const file1 = path.join(dir, 'orig.txt');
    const file2 = path.join(dir, 'hardlink.txt');
    fs.writeFileSync(file1, 'hardlink test content\n');
    fs.linkSync(file1, file2);

    assert.throws(
      () => readBoundedNonblockingFile(file1, { requireSingleLink: true }),
      (err) => {
        assert.equal(err.code, 'unexpected-link-count');
        assert.match(err.message, /unexpected link count/);
        return true;
      }
    );
  });

  test('detects concurrent expansion during reading', () => {
    const dir = createTempDir('reader-concur-expand-');
    const filePath = path.join(dir, 'expanding.txt');
    fs.writeFileSync(filePath, 'short');

    let expanded = false;
    assert.throws(
      () =>
        readBoundedNonblockingFile(filePath, {
          runFault: (stage) => {
            if (stage === 'read-chunk' && !expanded) {
              expanded = true;
              fs.appendFileSync(filePath, '-expanded-more-bytes');
            }
          },
        }),
      (err) => {
        assert.ok(err.code === 'concurrent-expansion' || err.code === 'concurrent-modification');
        return true;
      }
    );
    assert.equal(expanded, true);
  });

  test('detects unexpected short read (EOF before expected size)', () => {
    const dir = createTempDir('reader-short-read-');
    const filePath = path.join(dir, 'short-read.txt');
    fs.writeFileSync(filePath, '1234567890');

    let truncated = false;
    assert.throws(
      () =>
        readBoundedNonblockingFile(filePath, {
          runFault: (stage) => {
            if (stage === 'read-chunk' && !truncated) {
              truncated = true;
              fs.truncateSync(filePath, 3);
            }
          },
        }),
      (err) => {
        assert.ok(
          err.code === 'unexpected-eof' ||
          err.code === 'concurrent-modification' ||
          err.code === 'pathname-continuity-error'
        );
        return true;
      }
    );
    assert.equal(truncated, true);
  });

  test('fails closed when O_NOFOLLOW or O_NONBLOCK platform constants are missing or invalid', () => {
    const dir = createTempDir('reader-constants-');
    const filePath = path.join(dir, 'test.txt');
    fs.writeFileSync(filePath, 'constants test');

    assert.throws(
      () => readBoundedNonblockingFile(filePath, { constants: { O_NOFOLLOW: 0, O_NONBLOCK: 0 } }),
      (err) => {
        assert.equal(err.code, 'unsupported-platform');
        return true;
      }
    );

    assert.throws(
      () => readBoundedNonblockingFile(filePath, { constants: { O_NOFOLLOW: null, O_NONBLOCK: 1 } }),
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
              // Intended race exercised: regular file replaced by FIFO between lstat and openSync
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

      // Verify explicit evidence that the intended race was exercised
      assert.equal(raceExercised, true, 'Intended FIFO substitution race was exercised');
      assert.equal(closedAfterRace, true, 'Descriptor was closed after FIFO race rejection');
    } finally {
      fs.closeSync = origClose;
    }
  });
});

describe('D01-P3B-2D-2-B: Transaction Pre-Swap Authentication (authenticateSwapPrerequisites)', () => {
  test('authenticates valid apply prerequisites end-to-end with authentic SillyTavern release bytes', async (t) => {
    if (!authenticStock || !authenticPatched) {
      if (typeof t?.diagnostic === 'function') {
        t.diagnostic('Skipping authentic apply test: authentic SillyTavern reference bytes not available');
      }
      return;
    }

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
    if (!authenticStock || !authenticPatched) {
      if (typeof t?.diagnostic === 'function') {
        t.diagnostic('Skipping authentic remove test: authentic SillyTavern reference bytes not available');
      }
      return;
    }

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
    if (!authenticStock || !authenticPatched) {
      if (typeof t?.diagnostic === 'function') {
        t.diagnostic('Skipping async alias test: authentic reference bytes not available');
      }
      return;
    }

    const repo = setupDisposableRepo('tx-swap-auth-async-');
    const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

    const p1 = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
    const p2 = await authenticatePreSwap({ repoRoot: repo, txId, op, lease, manifest });

    assert.equal(p1.ok, true);
    assert.equal(p2.ok, true);
    assert.equal(p1.txId, p2.txId);
    assert.equal(p1.candidateIno, p2.candidateIno);
  });

  test('Strict No-Mutation: filesystem snapshot before and after authentication is 100% identical and mutation APIs are untouched', async (t) => {
    if (!authenticStock || !authenticPatched) {
      if (typeof t?.diagnostic === 'function') {
        t.diagnostic('Skipping no-mutation test: authentic reference bytes not available');
      }
      return;
    }

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
        return origRename(...args);
      };
      fs.unlinkSync = (...args) => {
        unlinkCalled = true;
        return origUnlink(...args);
      };
      fs.writeSync = (...args) => {
        writeCalled = true;
        return origWrite(...args);
      };
      fs.chmodSync = (...args) => {
        chmodCalled = true;
        return origChmod(...args);
      };

      const res = await authenticateSwapPrerequisites({
        repoRoot: repo,
        txId,
        op,
        lease,
        manifest,
      });

      assert.equal(res.ok, true);
      assert.equal(renameCalled, false, 'fs.renameSync must not be called during authentication');
      assert.equal(unlinkCalled, false, 'fs.unlinkSync must not be called during authentication');
      assert.equal(writeCalled, false, 'fs.writeSync must not be called during authentication');
      assert.equal(chmodCalled, false, 'fs.chmodSync must not be called during authentication');
    } finally {
      fs.renameSync = origRename;
      fs.unlinkSync = origUnlink;
      fs.writeSync = origWrite;
      fs.chmodSync = origChmod;
    }

    const afterSnapshot = snapshotDirectory(repo);
    assertSnapshotsEqual(beforeSnapshot, afterSnapshot);
  });

  test('swapVerifiedTarget is reserved for Stage C and throws unimplemented-stage-c', async () => {
    await assert.rejects(
      async () => {
        await swapVerifiedTarget();
      },
      (err) => {
        assert.equal(err.code, 'unimplemented-stage-c');
        assert.match(err.message, /reserved for Stage C/);
        return true;
      }
    );
  });

  describe('Invalid Arguments and Capabilities', () => {
    test('rejects missing or non-object options', async () => {
      const res1 = await authenticateSwapPrerequisites();
      assert.equal(res1.ok, false);
      assert.equal(res1.code, 'invalid-arguments');

      const res2 = await authenticateSwapPrerequisites(null);
      assert.equal(res2.ok, false);
      assert.equal(res2.code, 'invalid-arguments');
    });

    test('rejects missing mandatory arguments', async () => {
      const repo = setupDisposableRepo('tx-swap-missing-args-');
      const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      assert.equal((await authenticateSwapPrerequisites({ txId, op, lease })).code, 'invalid-arguments');
      assert.equal((await authenticateSwapPrerequisites({ repoRoot: repo, op, lease })).code, 'invalid-txid');
      assert.equal((await authenticateSwapPrerequisites({ repoRoot: repo, txId, lease })).code, 'invalid-operation');
      assert.equal((await authenticateSwapPrerequisites({ repoRoot: repo, txId, op: 'patch', lease })).code, 'invalid-operation');
      assert.equal((await authenticateSwapPrerequisites({ repoRoot: repo, txId, op })).code, 'lease-required');
    });

    test('fails closed when platform constants (O_NOFOLLOW, O_NONBLOCK, O_DIRECTORY) are missing or 0', async () => {
      const repo = setupDisposableRepo('tx-swap-bad-flags-');
      const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      const res1 = await authenticateSwapPrerequisites({
        repoRoot: repo,
        txId,
        op,
        lease,
        constants: { O_NOFOLLOW: 0, O_NONBLOCK: 1, O_DIRECTORY: 1 },
      });
      assert.equal(res1.ok, false);
      assert.equal(res1.code, 'unsupported-platform');
      assert.match(res1.error, /O_NOFOLLOW/);

      const res2 = await authenticateSwapPrerequisites({
        repoRoot: repo,
        txId,
        op,
        lease,
        constants: { O_NOFOLLOW: 1, O_NONBLOCK: 0, O_DIRECTORY: 1 },
      });
      assert.equal(res2.ok, false);
      assert.equal(res2.code, 'unsupported-platform');
      assert.match(res2.error, /O_NONBLOCK/);

      const res3 = await authenticateSwapPrerequisites({
        repoRoot: repo,
        txId,
        op,
        lease,
        constants: { O_NOFOLLOW: 1, O_NONBLOCK: 1, O_DIRECTORY: 0 },
      });
      assert.equal(res3.ok, false);
      assert.equal(res3.code, 'unsupported-platform');
      assert.match(res3.error, /O_DIRECTORY/);
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
      assert.ok(res.code === 'lease-not-active' || res.code === 'no-lock');
    });

    test('rejects foreign lock ownership', async () => {
      const repo = setupDisposableRepo('tx-swap-lock-owner-');
      const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      // Corrupt owner.json with foreign txId
      const ownerPath = path.join(repo, '.ci-patch/lock.d/owner.json');
      const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
      owner.txId = generateTxId();
      fs.writeFileSync(ownerPath, JSON.stringify(owner));

      const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'lock-ownership-mismatch');
    });

    test('rejects when journal is missing or corrupt', async () => {
      const repo = setupDisposableRepo('tx-swap-corrupt-journal-');
      const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      const journalPath = path.join(repo, '.ci-patch/journal.json');
      fs.writeFileSync(journalPath, '{"broken": json');

      const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'journal-invalid');
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
      journal.schemaVersion = '9.9.9';
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
      const journalOrig = JSON.parse(fs.readFileSync(journalPath, 'utf8'));

      // Non-canonical destinationStagedPath
      const j1 = { ...journalOrig, destinationStagedPath: 'src/endpoints/.wrong-name.tmp' };
      fs.writeFileSync(journalPath, JSON.stringify(j1));
      const res1 = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
      assert.equal(res1.ok, false);
      assert.ok(res1.code === 'invalid-metadata' || res1.code === 'journal-invalid');

      // Invalid targetMode (not 4 octal digits)
      const j2 = { ...journalOrig, targetMode: '777' };
      fs.writeFileSync(journalPath, JSON.stringify(j2));
      const res2 = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
      assert.equal(res2.ok, false);
      assert.ok(res2.code === 'invalid-metadata' || res2.code === 'journal-invalid');
    });

    test('rejects targetMode with setuid/setgid bits', async () => {
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

      const res = await authenticateSwapPrerequisites({
        repoRoot: repo,
        txId,
        op,
        lease,
        manifest: customManifest,
      });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'manifest-target-mismatch');
    });

    test('rejects journal expectedInitialSha256 / expectedResultSha256 mismatch with manifest', async () => {
      const repo = setupDisposableRepo('tx-swap-hash-mismatch-');
      const { txId, op, lease } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      const journalPath = path.join(repo, '.ci-patch/journal.json');
      const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
      journal.expectedInitialSha256 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      fs.writeFileSync(journalPath, JSON.stringify(journal));

      const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'journal-hash-mismatch');
    });
  });

  describe('Destination Parent Directory and Procfs Anchoring', () => {
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
      assert.ok(res.code === 'parent-dir-invalid' || res.code === 'parent-dir-open-error');
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

  describe('Artifact Authentications and Boundary Refusals', () => {
    test('rejects tampered isolated staging content', async () => {
      const repo = setupDisposableRepo('tx-swap-tampered-staging-');
      const { txId, op, lease, stagingFile } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      fs.writeFileSync(stagingFile, 'tampered staging content\n');
      const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'staging-digest-mismatch');
    });

    test('rejects missing or symlink isolated staging', async () => {
      const repo = setupDisposableRepo('tx-swap-missing-staging-');
      const { txId, op, lease, stagingFile } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      fs.unlinkSync(stagingFile);
      const resMissing = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
      assert.equal(resMissing.ok, false);
      assert.ok(resMissing.code === 'file-missing' || resMissing.code === 'staging-verification-failed');

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
      const res = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'backup-digest-mismatch');
    });

    test('rejects missing or symlink backup', async () => {
      const repo = setupDisposableRepo('tx-swap-missing-backup-');
      const { txId, op, lease, backupFile } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      fs.unlinkSync(backupFile);
      const resMissing = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
      assert.equal(resMissing.ok, false);
      assert.ok(resMissing.code === 'file-missing' || resMissing.code === 'backup-verification-failed');
    });

    test('rejects tampered live target content (or live target already patched)', async () => {
      const repo = setupDisposableRepo('tx-swap-tampered-target-');
      const { txId, op, lease, liveTarget } = setupTxAtReadyToSwap({ repo, op: 'apply' });

      // Modify target content
      fs.writeFileSync(liveTarget, 'tampered live target content\n');
      const res1 = await authenticateSwapPrerequisites({ repoRoot: repo, txId, op, lease, manifest });
      assert.equal(res1.ok, false);
      assert.equal(res1.code, 'target-digest-mismatch');

      // Live target already containing result bytes
      fs.writeFileSync(liveTarget, authenticPatched);
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
  });
});
