import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import child_process from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  acquireLock,
  generateTxId,
  TransactionLease,
} from '../src/patch-installer/lock.js';

import {
  createJournal,
  inspectJournal,
  advanceJournalPhase,
} from '../src/patch-installer/journal.js';

import {
  inspectTransactionState,
} from '../src/patch-installer/transaction-state.js';

import {
  checkInstallationPreflight,
} from '../src/patch-installer/inspect.js';

import {
  prepareIsolatedPatch,
  computeSha256,
  computeGitBlobSha,
} from '../src/patch-installer/staging.js';

import {
  createVerifiedBackup,
  extractCanonicalTargetMode,
} from '../src/patch-installer/backup.js';

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
      // ignore
    }
  }
});

function createTempDir(prefix = 'ci-backup-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirsToClean.push(dir);
  return dir;
}

function getVerifiedAuthenticStockContent(targetManifest) {
  const candidateDirs = [
    process.env.SILLYTAVERN_TEST_REPO,
    process.env.SILLYTAVERN_DIR,
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

function setupDisposableRepo(prefix = 'disposable-st-repo-') {
  const repoDir = createTempDir(prefix);
  child_process.execFileSync('git', ['init', '-q'], { cwd: repoDir });
  child_process.execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
  child_process.execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });

  fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ name: 'sillytavern', version: '1.18.0' }));
  fs.writeFileSync(path.join(repoDir, 'server.js'), '// mock server entry\n');
  fs.mkdirSync(path.join(repoDir, 'src/endpoints'), { recursive: true });

  return repoDir;
}

let substituteCounter = 0;

function substituteFileWithDistinctInode(targetPath, content, options = {}) {
  const {
    mode,
    lstatFn = fs.lstatSync,
    repoRoot,
    _beforeRename,
  } = options;

  assert.ok(
    typeof repoRoot === 'string' && repoRoot.length > 0,
    'substituteFileWithDistinctInode requires explicit disposable repoRoot'
  );

  const resolvedRepo = path.resolve(repoRoot);
  const resolvedTarget = path.resolve(targetPath);
  const rel = path.relative(resolvedRepo, resolvedTarget);
  assert.ok(
    !rel.startsWith('..') && !path.isAbsolute(rel) && rel !== '',
    `targetPath "${targetPath}" must reside strictly within disposable repoRoot "${repoRoot}"`
  );

  const repoStat = lstatFn(resolvedRepo);
  assert.ok(
    repoStat.isDirectory() && !repoStat.isSymbolicLink(),
    `repoRoot "${repoRoot}" must be an existing non-symlink directory`
  );

  const expectedRepoDev = repoStat.dev;
  const expectedRepoIno = repoStat.ino;
  const expectedRepoUid = typeof repoStat.uid === 'number' ? repoStat.uid : null;

  const origStat = lstatFn(resolvedTarget);
  assert.ok(
    origStat.isFile() && !origStat.isSymbolicLink(),
    `Target must be an existing regular non-symlink file: ${targetPath}`
  );

  const expectedTargetDev = origStat.dev;
  const expectedTargetIno = origStat.ino;
  const expectedTargetUid = typeof origStat.uid === 'number' ? origStat.uid : null;

  // Verify and record destination ancestor directory chain within repoRoot
  const ancestorChain = [];
  let currDir = path.dirname(resolvedTarget);
  while (currDir !== resolvedRepo) {
    const parent = path.dirname(currDir);
    assert.ok(
      parent !== currDir,
      `Reached filesystem root before encountering repoRoot "${resolvedRepo}"`
    );
    let aStat;
    try {
      aStat = lstatFn(currDir);
    } catch (err) {
      assert.fail(`Unable to stat destination ancestor directory "${currDir}": ${err.message}`);
    }
    assert.ok(
      aStat.isDirectory() && !aStat.isSymbolicLink(),
      `Destination ancestor directory "${currDir}" must be a genuine non-symlink directory`
    );
    assert.equal(
      aStat.dev,
      repoStat.dev,
      `Destination ancestor directory "${currDir}" must reside on the same filesystem as repoRoot`
    );
    ancestorChain.push({
      dir: currDir,
      dev: aStat.dev,
      ino: aStat.ino,
      uid: typeof aStat.uid === 'number' ? aStat.uid : null,
    });
    currDir = parent;
  }

  const targetMode = mode !== undefined ? mode : (origStat.mode & 0o777);

  const subDir = fs.mkdtempSync(path.join(resolvedRepo, '.ci-sub-tmp-'));
  const dirStat = lstatFn(subDir);
  assert.ok(
    dirStat.isDirectory() && !dirStat.isSymbolicLink(),
    `substitute directory "${subDir}" must be a non-symlink directory`
  );
  assert.equal(
    dirStat.dev,
    repoStat.dev,
    `substitute directory "${subDir}" must reside on the same filesystem as repoRoot`
  );

  const expectedDirDev = dirStat.dev;
  const expectedDirIno = dirStat.ino;
  const expectedDirUid = typeof dirStat.uid === 'number' ? dirStat.uid : null;

  substituteCounter++;
  const uniqueName = `substitute-${process.pid}-${Date.now()}-${substituteCounter}.tmp`;
  const substitutePath = path.join(subDir, uniqueName);

  let expectedSubDev = null;
  let expectedSubIno = null;
  let expectedSubUid = null;
  let fileRenamed = false;

  try {
    fs.writeFileSync(substitutePath, content, { flag: 'wx', mode: targetMode });
    const subStat = lstatFn(substitutePath);
    assert.ok(
      subStat.isFile() && !subStat.isSymbolicLink(),
      `substitute "${substitutePath}" must be a regular non-symlink file`
    );
    assert.equal(
      subStat.dev,
      expectedDirDev,
      `substitute "${substitutePath}" must reside on the same filesystem as substitute directory`
    );

    expectedSubDev = subStat.dev;
    expectedSubIno = subStat.ino;
    expectedSubUid = typeof subStat.uid === 'number' ? subStat.uid : null;

    assert.ok(
      origStat.dev !== subStat.dev || origStat.ino !== subStat.ino,
      `Substitute file must possess distinct identity before replacement (original ino: ${origStat.ino}, substitute ino: ${subStat.ino})`
    );

    if (typeof _beforeRename === 'function') {
      _beforeRename({
        substitutePath,
        subDir,
        targetPath: resolvedTarget,
        expectedSubIno,
        expectedDirIno,
        expectedTargetIno,
        subStat,
        dirStat,
      });
    }

    // 0. Re-verify repoRoot identity
    let curRepoStat;
    try {
      curRepoStat = lstatFn(resolvedRepo);
    } catch (err) {
      assert.fail(`repoRoot "${resolvedRepo}" missing or unstatable before rename: ${err.message}`);
    }
    assert.ok(
      curRepoStat.isDirectory() && !curRepoStat.isSymbolicLink(),
      `repoRoot "${resolvedRepo}" was removed, replaced by a non-directory, or replaced by a symbolic link before rename`
    );
    assert.equal(
      curRepoStat.dev,
      expectedRepoDev,
      `repoRoot "${resolvedRepo}" device mismatch before rename`
    );
    assert.equal(
      curRepoStat.ino,
      expectedRepoIno,
      `repoRoot "${resolvedRepo}" inode identity changed unexpectedly before rename`
    );
    if (typeof expectedRepoUid === 'number') {
      assert.equal(
        curRepoStat.uid,
        expectedRepoUid,
        `repoRoot "${resolvedRepo}" ownership changed unexpectedly before rename`
      );
    }

    // 1. Re-verify destination ancestor directory chain
    for (const ancestor of ancestorChain) {
      let curAStat;
      try {
        curAStat = lstatFn(ancestor.dir);
      } catch (err) {
        assert.fail(`Destination ancestor directory "${ancestor.dir}" missing before rename: ${err.message}`);
      }
      assert.ok(
        curAStat.isDirectory() && !curAStat.isSymbolicLink(),
        `Destination ancestor directory "${ancestor.dir}" modified or replaced by symlink before rename`
      );
      assert.equal(curAStat.dev, ancestor.dev, `Destination ancestor directory "${ancestor.dir}" device changed before rename`);
      assert.equal(curAStat.ino, ancestor.ino, `Destination ancestor directory "${ancestor.dir}" inode changed before rename`);
      if (typeof ancestor.uid === 'number') {
        assert.equal(curAStat.uid, ancestor.uid, `Destination ancestor directory "${ancestor.dir}" ownership changed before rename`);
      }
    }

    // 2. Re-verify destination target file identity
    let curTargetStat;
    try {
      curTargetStat = lstatFn(resolvedTarget);
    } catch (err) {
      assert.fail(`Destination target "${resolvedTarget}" missing before rename: ${err.message}`);
    }
    assert.ok(
      curTargetStat.isFile() && !curTargetStat.isSymbolicLink(),
      `Destination target "${resolvedTarget}" is missing, not a regular file, or was replaced by a symbolic link before rename`
    );
    assert.equal(
      curTargetStat.dev,
      expectedTargetDev,
      `Destination target "${resolvedTarget}" device mismatch before rename`
    );
    assert.equal(
      curTargetStat.ino,
      expectedTargetIno,
      `Destination target "${resolvedTarget}" inode identity changed unexpectedly before rename`
    );
    if (typeof expectedTargetUid === 'number') {
      assert.equal(
        curTargetStat.uid,
        expectedTargetUid,
        `Destination target "${resolvedTarget}" ownership changed unexpectedly before rename`
      );
    }

    // 3. Re-verify substitute directory and substitute file identities
    const preRenameDirStat = lstatFn(subDir);
    assert.ok(
      preRenameDirStat.dev === expectedDirDev && preRenameDirStat.ino === expectedDirIno,
      `substitute directory identity changed before rename (dev: ${preRenameDirStat.dev} vs ${expectedDirDev}, ino: ${preRenameDirStat.ino} vs ${expectedDirIno})`
    );

    const preRenameSubStat = lstatFn(substitutePath);
    assert.ok(
      preRenameSubStat.dev === expectedSubDev && preRenameSubStat.ino === expectedSubIno,
      `substitute file identity changed before rename (dev: ${preRenameSubStat.dev} vs ${expectedSubDev}, ino: ${preRenameSubStat.ino} vs ${expectedSubIno})`
    );

    fs.renameSync(substitutePath, resolvedTarget);
    fileRenamed = true;

    const replacedStat = lstatFn(resolvedTarget);
    assert.equal(
      replacedStat.dev,
      subStat.dev,
      'Replaced pathname device must match substitute device'
    );
    assert.equal(
      replacedStat.ino,
      subStat.ino,
      'Replaced pathname inode must match substitute inode'
    );
    assert.ok(
      replacedStat.dev !== origStat.dev || replacedStat.ino !== origStat.ino,
      'Replaced pathname identity must differ from original identity'
    );

    return { origStat, subStat, replacedStat, subDir };
  } finally {
    let repoValidForCleanup = false;
    let cleanupRepoStat = null;
    try {
      cleanupRepoStat = lstatFn(resolvedRepo);
      if (
        cleanupRepoStat &&
        cleanupRepoStat.isDirectory() &&
        !cleanupRepoStat.isSymbolicLink() &&
        cleanupRepoStat.dev === expectedRepoDev &&
        cleanupRepoStat.ino === expectedRepoIno &&
        (typeof expectedRepoUid !== 'number' || cleanupRepoStat.uid === expectedRepoUid)
      ) {
        repoValidForCleanup = true;
      } else {
        console.error(`[evidence-preservation] Refusing cleanup: repoRoot "${resolvedRepo}" identity/ownership mismatch, not a directory, or replaced by symlink; preserving evidence`);
      }
    } catch (repoErr) {
      console.error(`[evidence-preservation] Refusing cleanup: unable to stat repoRoot "${resolvedRepo}": ${repoErr.message}`);
    }

    if (repoValidForCleanup) {
      if (!fileRenamed && expectedSubIno !== null) {
        let currentFileStat = null;
        try {
          currentFileStat = lstatFn(substitutePath);
        } catch (err) {
          if (err?.code !== 'ENOENT') {
            console.error(`[evidence-preservation] Unable to stat substitute file before cleanup "${substitutePath}": ${err.message}`);
          }
        }
        if (currentFileStat) {
          if (
            !currentFileStat.isFile() ||
            currentFileStat.isSymbolicLink() ||
            currentFileStat.dev !== expectedSubDev ||
            currentFileStat.ino !== expectedSubIno ||
            (typeof expectedSubUid === 'number' && currentFileStat.uid !== expectedSubUid)
          ) {
            console.error(`[evidence-preservation] Refusing cleanup: substitute file "${substitutePath}" identity/ownership mismatch or not a regular file; preserving evidence`);
          } else {
            try {
              fs.unlinkSync(substitutePath);
            } catch (unlinkErr) {
              console.error(`[evidence-preservation] Failed to unlink verified substitute file "${substitutePath}": ${unlinkErr.message}`);
            }
          }
        }
      }

      if (expectedDirIno !== null) {
        let currentDirStat = null;
        try {
          currentDirStat = lstatFn(subDir);
        } catch (err) {
          if (err?.code !== 'ENOENT') {
            console.error(`[evidence-preservation] Unable to stat substitute directory before cleanup "${subDir}": ${err.message}`);
          }
        }
        if (currentDirStat) {
          if (
            !currentDirStat.isDirectory() ||
            currentDirStat.isSymbolicLink() ||
            currentDirStat.dev !== expectedDirDev ||
            currentDirStat.ino !== expectedDirIno ||
            (typeof expectedDirUid === 'number' && currentDirStat.uid !== expectedDirUid)
          ) {
            console.error(`[evidence-preservation] Refusing cleanup: substitute directory "${subDir}" identity/ownership mismatch or not a directory; preserving evidence`);
          } else {
            let entries = [];
            try {
              entries = fs.readdirSync(subDir);
            } catch (readErr) {
              console.error(`[evidence-preservation] Refusing cleanup: unable to readdir substitute directory "${subDir}": ${readErr.message}`);
              entries = ['<unreadable>'];
            }
            if (entries.length > 0) {
              console.error(`[evidence-preservation] Refusing cleanup: substitute directory "${subDir}" contains unexpected entries (${entries.join(', ')}); preserving evidence`);
            } else {
              try {
                fs.rmdirSync(subDir);
              } catch (rmdirErr) {
                console.error(`[evidence-preservation] Failed to rmdir verified substitute directory "${subDir}": ${rmdirErr.message}`);
              }
            }
          }
        }
      }
    }
  }
}

const manifest = JSON.parse(fs.readFileSync(BUNDLED_MANIFEST_PATH, 'utf8'));
const stockSha = manifest.patches.runtime.original.sha256.toLowerCase();
const stockBlob = manifest.patches.runtime.original.gitBlobSha.toLowerCase();
const patchedSha = manifest.patches.runtime.expected.sha256.toLowerCase();
const patchedBlob = manifest.patches.runtime.expected.gitBlobSha.toLowerCase();
const authenticStock = getVerifiedAuthenticStockContent(manifest);

function getAuthenticPatchedContent(stockBuf) {
  if (!stockBuf) return null;
  const patchPath = path.resolve(REPO_ROOT, manifest.patches.runtime.relativePath);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'get-patched-'));
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

const authenticPatched = authenticStock ? getAuthenticPatchedContent(authenticStock) : null;

describe('P3B-2B: Mode Extraction & Canonical Permission Formatting', () => {
  test('extractCanonicalTargetMode extracts standard permission bits correctly', () => {
    assert.equal(extractCanonicalTargetMode(0o100644), '0644');
    assert.equal(extractCanonicalTargetMode(0o100600), '0600');
    assert.equal(extractCanonicalTargetMode(0o100755), '0755');
    assert.equal(extractCanonicalTargetMode(0o100400), '0400');
    assert.equal(extractCanonicalTargetMode(0o644), '0644');
    assert.equal(extractCanonicalTargetMode(0o600), '0600');
  });

  test('extractCanonicalTargetMode rejects special bits (setuid, setgid, sticky)', () => {
    // setuid: 0o4000
    assert.throws(() => extractCanonicalTargetMode(0o104644), (err) => {
      assert.equal(err.code, 'special-permission-bits-unsupported');
      assert.match(err.message, /unsupported special permission bits/);
      return true;
    });

    // setgid: 0o2000
    assert.throws(() => extractCanonicalTargetMode(0o102644), (err) => {
      assert.equal(err.code, 'special-permission-bits-unsupported');
      assert.match(err.message, /unsupported special permission bits/);
      return true;
    });

    // sticky: 0o1000
    assert.throws(() => extractCanonicalTargetMode(0o101644), (err) => {
      assert.equal(err.code, 'special-permission-bits-unsupported');
      assert.match(err.message, /unsupported special permission bits/);
      return true;
    });
  });

  test('extractCanonicalTargetMode rejects invalid non-integer inputs', () => {
    assert.throws(() => extractCanonicalTargetMode('0644'), /Invalid mode/);
    assert.throws(() => extractCanonicalTargetMode(null), /Invalid mode/);
    assert.throws(() => extractCanonicalTargetMode(undefined), /Invalid mode/);
    assert.throws(() => extractCanonicalTargetMode(644.5), /Invalid mode/);
  });
});

describe('P3B-2B: Verified Pre-Mutation Backup Creation (backup.js)', () => {
  if (!authenticStock || !authenticPatched) {
    test.skip('Skipping authentic backup tests (authentic stock or patched content unavailable)', () => {});
    return;
  }

  test('successful forward/apply backup creation preserves stock bytes and advances journal', async () => {
    const repo = setupDisposableRepo('apply-backup-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);
    fs.chmodSync(liveTarget, 0o644);

    const initialStat = fs.statSync(liveTarget);

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });

    const prepRes = await prepareIsolatedPatch({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
    });
    assert.equal(prepRes.ok, true);

    const backupRes = await createVerifiedBackup({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
    });

    assert.equal(backupRes.ok, true);
    assert.equal(backupRes.backupPath, `.ci-patch/backup/${txId}/stable-diffusion.js`);
    assert.equal(backupRes.targetMode, '0644');
    assert.equal(backupRes.sha256, stockSha);
    assert.equal(backupRes.gitBlobSha, stockBlob);
    assert.equal(backupRes.journal?.phase, 'BACKUP_CREATED');
    assert.equal(backupRes.journal?.targetMode, '0644');
    assert.equal(backupRes.journal?.backupPath, `.ci-patch/backup/${txId}/stable-diffusion.js`);
    assert.equal(backupRes.journal?.isolatedStagedPath, `.ci-patch/staging/${txId}/stable-diffusion.js`);

    // Invariant 1: Backup file content matches stock bytes byte-for-byte
    const backupFile = path.join(repo, backupRes.backupPath);
    const backupBytes = fs.readFileSync(backupFile);
    assert.equal(Buffer.compare(backupBytes, authenticStock), 0);
    assert.equal(computeSha256(backupBytes), stockSha);
    assert.equal(computeGitBlobSha(backupBytes), stockBlob);

    // Invariant 2: Backup file has restrictive 0600 mode
    const backupStat = fs.statSync(backupFile);
    assert.equal(backupStat.mode & 0o777, 0o600);

    // Invariant 3: Live target is completely unchanged
    const targetBytes = fs.readFileSync(liveTarget);
    const postStat = fs.statSync(liveTarget);
    assert.equal(Buffer.compare(targetBytes, authenticStock), 0);
    assert.equal(postStat.mode & 0o777, 0o644);
    assert.equal(postStat.dev, initialStat.dev);
    assert.equal(postStat.ino, initialStat.ino);

    // Invariant 4: Backup and live target are independent files (distinct inodes)
    assert.notEqual(backupStat.ino, initialStat.ino);

    // Invariant 5: No destination candidate staging occurred
    const destCandidate = path.join(repo, `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp`);
    assert.equal(fs.existsSync(destCandidate), false);

    // Invariant 6: Prepared staging remains intact and distinct from backup
    const stagedFile = path.join(repo, `.ci-patch/staging/${txId}/stable-diffusion.js`);
    assert.equal(computeSha256(fs.readFileSync(stagedFile)), patchedSha);
  });

  test('successful forward/apply backup records mode 0600 when target is 0600', async () => {
    const repo = setupDisposableRepo('mode-600-backup-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);
    fs.chmodSync(liveTarget, 0o600);

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });

    await prepareIsolatedPatch({ repoRoot: repo, txId, op: 'apply', lease });

    const backupRes = await createVerifiedBackup({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
    });

    assert.equal(backupRes.ok, true);
    assert.equal(backupRes.targetMode, '0600');
    assert.equal(backupRes.journal?.targetMode, '0600');

    const liveStat = fs.statSync(liveTarget);
    assert.equal(liveStat.mode & 0o777, 0o600);
  });

  test('successful reverse/remove backup creation preserves patched bytes and advances journal', async () => {
    const repo = setupDisposableRepo('remove-backup-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticPatched);
    fs.chmodSync(liveTarget, 0o644);

    const initialStat = fs.statSync(liveTarget);

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'remove' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'remove',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: patchedSha,
      expectedResultSha256: stockSha,
      lease,
    });

    const prepRes = await prepareIsolatedPatch({
      repoRoot: repo,
      txId,
      op: 'remove',
      lease,
    });
    assert.equal(prepRes.ok, true);

    const backupRes = await createVerifiedBackup({
      repoRoot: repo,
      txId,
      op: 'remove',
      lease,
    });

    assert.equal(backupRes.ok, true);
    assert.equal(backupRes.backupPath, `.ci-patch/backup/${txId}/stable-diffusion.js`);
    assert.equal(backupRes.targetMode, '0644');
    assert.equal(backupRes.sha256, patchedSha);
    assert.equal(backupRes.gitBlobSha, patchedBlob);
    assert.equal(backupRes.journal?.phase, 'BACKUP_CREATED');

    // Backup contains patched bytes, NOT stock bytes
    const backupFile = path.join(repo, backupRes.backupPath);
    const backupBytes = fs.readFileSync(backupFile);
    assert.equal(Buffer.compare(backupBytes, authenticPatched), 0);
    assert.equal(computeSha256(backupBytes), patchedSha);
    assert.equal(computeGitBlobSha(backupBytes), patchedBlob);

    // Staging contains stock bytes
    const stagedFile = path.join(repo, `.ci-patch/staging/${txId}/stable-diffusion.js`);
    assert.equal(computeSha256(fs.readFileSync(stagedFile)), stockSha);

    // Live target unchanged
    assert.equal(Buffer.compare(fs.readFileSync(liveTarget), authenticPatched), 0);
    const postStat = fs.statSync(liveTarget);
    assert.equal(postStat.dev, initialStat.dev);
    assert.equal(postStat.ino, initialStat.ino);
  });
});

describe('P3B-2B: Precondition & Authentication Failures', () => {
  if (!authenticStock || !authenticPatched) {
    test.skip('Skipping authentication failure tests (authentic stock or patched content unavailable)', () => {});
    return;
  }

  test('refuses backup creation if lease is missing or invalid', async () => {
    const repo = setupDisposableRepo('bad-lease-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    await prepareIsolatedPatch({ repoRoot: repo, txId, op: 'apply', lease });

    // Missing lease
    const resNoLease = await createVerifiedBackup({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease: null,
    });
    assert.equal(resNoLease.ok, false);
    assert.equal(resNoLease.code, 'invalid-arguments');

    // Forged lease
    const fakeLease = new TransactionLease(txId, repo, 'apply', 'fake-token', process.pid);
    const resFakeLease = await createVerifiedBackup({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease: fakeLease,
    });
    assert.equal(resFakeLease.ok, false);
    assert.equal(resFakeLease.code, 'invalid-lease-token');
  });

  test('refuses backup creation if lock and journal txId or op mismatch', async () => {
    const repo = setupDisposableRepo('tx-mismatch-');
    const txId1 = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

    const { lease } = acquireLock({ repoRoot: repo, txId: txId1, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId: txId1,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    await prepareIsolatedPatch({ repoRoot: repo, txId: txId1, op: 'apply', lease });

    // Caller passes wrong txId
    const resTxMismatch = await createVerifiedBackup({
      repoRoot: repo,
      txId: generateTxId(),
      op: 'apply',
      lease,
    });
    assert.equal(resTxMismatch.ok, false);
    assert.match(resTxMismatch.error, /lease belongs to|Lock belongs to/);

    // Caller passes wrong op
    const resOpMismatch = await createVerifiedBackup({
      repoRoot: repo,
      txId: txId1,
      op: 'remove',
      lease,
    });
    assert.equal(resOpMismatch.ok, false);
    assert.match(resOpMismatch.error, /lease is for|Lock operation/);
  });

  test('refuses backup creation if journal is not in phase ISOLATED_PREPARED', async () => {
    const repo = setupDisposableRepo('wrong-phase-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    // Journal is in LOCKED phase, prepareIsolatedPatch has not been run!

    const res = await createVerifiedBackup({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'illegal-phase');
    assert.match(res.error, /requires journal in phase "ISOLATED_PREPARED", observed "LOCKED"/);
  });

  test('refuses backup creation if journal is legacy with stagedPath', async () => {
    const repo = setupDisposableRepo('legacy-journal-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    const jPath = path.join(repo, '.ci-patch/journal.json');
    const legacyJournal = {
      schemaVersion: '1.0.0',
      txId,
      op: 'apply',
      phase: 'ISOLATED_PREPARED',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      stagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js`,
    };
    fs.writeFileSync(jPath, JSON.stringify(legacyJournal, null, 2) + '\n');

    const res = await createVerifiedBackup({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'legacy-schema');
  });

  test('refuses backup creation if prepared staging file is missing', async () => {
    const repo = setupDisposableRepo('missing-staging-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    await prepareIsolatedPatch({ repoRoot: repo, txId, op: 'apply', lease });

    // Delete prepared staged file
    const stagedFile = path.join(repo, `.ci-patch/staging/${txId}/stable-diffusion.js`);
    fs.unlinkSync(stagedFile);

    const res = await createVerifiedBackup({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'unexpected-staging-artifacts');
  });

  test('refuses backup creation if prepared staging file content was tampered with', async () => {
    const repo = setupDisposableRepo('tampered-staging-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    await prepareIsolatedPatch({ repoRoot: repo, txId, op: 'apply', lease });

    // Tamper with staged file
    const stagedFile = path.join(repo, `.ci-patch/staging/${txId}/stable-diffusion.js`);
    fs.writeFileSync(stagedFile, 'tampered staged content\n');

    const res = await createVerifiedBackup({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'result-sha256-mismatch');

    // Journal remains in ISOLATED_PREPARED
    const jInspect = inspectJournal(repo);
    assert.equal(jInspect.journal?.phase, 'ISOLATED_PREPARED');
  });

  test('refuses backup creation if live target has unrecognized content', async () => {
    const repo = setupDisposableRepo('modified-live-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, 'unrecognized live target bytes\n');

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });

    // Manually advance journal to ISOLATED_PREPARED for this test
    const stagingTxDir = path.join(repo, '.ci-patch/staging', txId);
    fs.mkdirSync(stagingTxDir, { recursive: true });
    fs.writeFileSync(path.join(stagingTxDir, 'stable-diffusion.js'), authenticPatched, { mode: 0o600 });
    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
      lease,
    });

    const res = await createVerifiedBackup({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'initial-sha256-mismatch');
  });

  test('refuses backup creation if live target is a symbolic link', async () => {
    const repo = setupDisposableRepo('symlink-live-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    const outsideTarget = path.join(createTempDir('outside-target-'), 'target.js');
    fs.writeFileSync(outsideTarget, authenticStock);
    fs.symlinkSync(outsideTarget, liveTarget);

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });

    // Manually setup staging
    const stagingTxDir = path.join(repo, '.ci-patch/staging', txId);
    fs.mkdirSync(stagingTxDir, { recursive: true });
    fs.writeFileSync(path.join(stagingTxDir, 'stable-diffusion.js'), authenticPatched, { mode: 0o600 });
    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
      lease,
    });

    const res = await createVerifiedBackup({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'source-read-failed');
    assert.match(res.error, /symbolic link/);
  });

  test('refuses backup creation if target parent directory is a symbolic link', async () => {
    const repo = setupDisposableRepo('symlink-parent-');
    const txId = generateTxId();

    // Replace src/endpoints with symlink
    fs.rmSync(path.join(repo, 'src/endpoints'), { recursive: true });
    const realEndpoints = path.join(createTempDir('real-endpoints-'), 'endpoints');
    fs.mkdirSync(realEndpoints, { recursive: true });
    fs.writeFileSync(path.join(realEndpoints, 'stable-diffusion.js'), authenticStock);
    fs.symlinkSync(realEndpoints, path.join(repo, 'src/endpoints'));

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });

    // Setup staging
    const stagingTxDir = path.join(repo, '.ci-patch/staging', txId);
    fs.mkdirSync(stagingTxDir, { recursive: true });
    fs.writeFileSync(path.join(stagingTxDir, 'stable-diffusion.js'), authenticPatched, { mode: 0o600 });
    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
      lease,
    });

    const res = await createVerifiedBackup({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'unsafe-symlink');
    assert.match(res.error, /Target parent directory "src\/endpoints" is a symbolic link/);
  });

  test('refuses backup creation if live target has setuid bit set', async () => {
    const repo = setupDisposableRepo('setuid-target-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);
    try {
      fs.chmodSync(liveTarget, 0o4644); // setuid
    } catch {
      // Some platforms don't allow setuid, skip if chmod failed
      return;
    }

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    await prepareIsolatedPatch({ repoRoot: repo, txId, op: 'apply', lease });

    const res = await createVerifiedBackup({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'special-permission-bits-unsupported');
    assert.match(res.error, /setuid\/setgid\/sticky not permitted/);
  });
});

describe('P3B-2B: Backup Path & Directory Collisions', () => {
  if (!authenticStock || !authenticPatched) {
    test.skip('Skipping collision tests (authentic stock or patched content unavailable)', () => {});
    return;
  }

  test('refuses backup creation if .ci-patch/backup is a symbolic link', async () => {
    const repo = setupDisposableRepo('backup-symlink-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    await prepareIsolatedPatch({ repoRoot: repo, txId, op: 'apply', lease });

    // Create .ci-patch/backup as a symlink
    const realBackupDir = createTempDir('real-backup-');
    fs.symlinkSync(realBackupDir, path.join(repo, '.ci-patch/backup'));

    const res = await createVerifiedBackup({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'unsafe-symlink');
  });

  test('refuses backup creation if .ci-patch/backup is a dangling symlink', async () => {
    const repo = setupDisposableRepo('backup-dangling-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    await prepareIsolatedPatch({ repoRoot: repo, txId, op: 'apply', lease });

    fs.symlinkSync('/nonexistent/backup/path', path.join(repo, '.ci-patch/backup'));

    const res = await createVerifiedBackup({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'unsafe-symlink');
  });

  test('refuses backup creation if .ci-patch/backup is a regular file', async () => {
    const repo = setupDisposableRepo('backup-regfile-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    await prepareIsolatedPatch({ repoRoot: repo, txId, op: 'apply', lease });

    fs.writeFileSync(path.join(repo, '.ci-patch/backup'), 'not a directory\n');

    const res = await createVerifiedBackup({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'invalid-backup-dir');
  });

  test('refuses backup creation if backup transaction directory already exists (collision)', async () => {
    const repo = setupDisposableRepo('backup-collision-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    await prepareIsolatedPatch({ repoRoot: repo, txId, op: 'apply', lease });

    // Pre-create transaction backup directory
    const txBackupDir = path.join(repo, '.ci-patch/backup', txId);
    fs.mkdirSync(txBackupDir, { recursive: true });

    const res = await createVerifiedBackup({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'backup-collision');
    assert.match(res.error, /Backup directory already exists for transaction/);

    // Collision directory is preserved, NOT deleted
    assert.equal(fs.existsSync(txBackupDir), true);
  });
});

describe('P3B-2B: Durability & Deterministic Fault Injection', () => {
  if (!authenticStock || !authenticPatched) {
    test.skip('Skipping fault injection tests (authentic stock or patched content unavailable)', () => {});
    return;
  }

  const faultHookPoints = [
    'before-backup-parent-creation',
    'sync-backup-parent',
    'before-dir-allocation',
    'sync-backup-txdir-parent',
    'before-file-create',
    'during-backup-write',
    'sync-initial-backup-file',
    'before-backup-readback',
    'before-fingerprint-verification',
    'sync-backup-txdir',
    'before-journal-advancement',
  ];

  for (const hookPoint of faultHookPoints) {
    test(`fault at hook point "${hookPoint}" aborts safely leaving journal in ISOLATED_PREPARED`, async () => {
      const repo = setupDisposableRepo(`fault-${hookPoint.replace(/[^a-z0-9]/g, '-')}-`);
      const txId = generateTxId();
      const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
      fs.writeFileSync(liveTarget, authenticStock);

      const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
      createJournal({
        repoRoot: repo,
        txId,
        op: 'apply',
        targetFile: 'src/endpoints/stable-diffusion.js',
        expectedInitialSha256: stockSha,
        expectedResultSha256: patchedSha,
        lease,
      });
      await prepareIsolatedPatch({ repoRoot: repo, txId, op: 'apply', lease });

      let faultExecuted = false;
      const faultHook = (stage) => {
        if (stage === hookPoint) {
          faultExecuted = true;
          const faultErr = new Error(`Injected simulated failure at ${hookPoint}`);
          faultErr._isFault = true;
          throw faultErr;
        }
      };

      let errorThrown = false;
      try {
        const res = await createVerifiedBackup({
          repoRoot: repo,
          txId,
          op: 'apply',
          lease,
          faultHook,
        });
        if (!res.ok) {
          errorThrown = true;
        }
      } catch (err) {
        if (err._isFault) {
          errorThrown = true;
        } else {
          throw err;
        }
      }

      assert.equal(faultExecuted, true, `Hook "${hookPoint}" must execute`);
      assert.equal(errorThrown, true);

      // Invariant 1: Live target is never modified
      assert.equal(Buffer.compare(fs.readFileSync(liveTarget), authenticStock), 0);

      // Invariant 2: Journal remains strictly in phase ISOLATED_PREPARED
      const jInspect = inspectJournal(repo);
      assert.equal(jInspect.journal?.phase, 'ISOLATED_PREPARED');
      assert.equal(jInspect.journal?.backupPath, undefined);
      assert.equal(jInspect.journal?.targetMode, undefined);

      // Invariant 3: Transaction remains pending
      const txState = inspectTransactionState(repo);
      assert.equal(txState.isPending, true);
    });
  }

  test('refuses advancement if live target is modified concurrently before journal advancement', async () => {
    const repo = setupDisposableRepo('live-modified-concurrently-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    await prepareIsolatedPatch({ repoRoot: repo, txId, op: 'apply', lease });

    const faultHook = (stage) => {
      if (stage === 'before-fingerprint-verification') {
        // Concurrently replace live target with different file
        substituteFileWithDistinctInode(liveTarget, 'concurrently replaced live target\n', { repoRoot: repo });
      }
    };

    const res = await createVerifiedBackup({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
      faultHook,
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, 'source-identity-replaced');
    assert.match(res.error, /inode identity changed before journal advancement/);

    // Journal remains in ISOLATED_PREPARED
    const jInspect = inspectJournal(repo);
    assert.equal(jInspect.journal?.phase, 'ISOLATED_PREPARED');
  });

  test('refuses advancement if backup pathname is replaced by symlink before publication', async () => {
    const repo = setupDisposableRepo('backup-symlinked-before-pub-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    await prepareIsolatedPatch({ repoRoot: repo, txId, op: 'apply', lease });

    const faultHook = (stage) => {
      if (stage === 'sync-backup-txdir') {
        const backupFile = path.join(repo, '.ci-patch/backup', txId, 'stable-diffusion.js');
        fs.unlinkSync(backupFile);
        fs.symlinkSync(liveTarget, backupFile);
      }
    };

    const res = await createVerifiedBackup({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
      faultHook,
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, 'unsafe-symlink');
    assert.match(res.error, /replaced by a symbolic link before journal advancement/);

    const jInspect = inspectJournal(repo);
    assert.equal(jInspect.journal?.phase, 'ISOLATED_PREPARED');
  });
});

describe('P3B-2B: Read-Only Backup Inspection (transaction-state.js)', () => {
  test('empty backup parent directory in ISOLATED_PREPARED is classified as incomplete-transaction', () => {
    const repo = setupDisposableRepo('insp-empty-parent-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
      lease,
    });

    const txStagingDir = path.join(repo, '.ci-patch/staging', txId);
    fs.mkdirSync(txStagingDir, { recursive: true });
    fs.writeFileSync(path.join(txStagingDir, 'stable-diffusion.js'), 'patched', { mode: 0o600 });

    // Empty .ci-patch/backup exists
    fs.mkdirSync(path.join(repo, '.ci-patch/backup'), { recursive: true });

    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'incomplete-transaction');
    assert.equal(state.isPending, true);
    assert.ok(state.reasons.some((r) => r.includes('Interrupted backup preparation detected: empty backup parent directory')));
  });

  test('empty transaction backup directory in ISOLATED_PREPARED is classified as incomplete-transaction', () => {
    const repo = setupDisposableRepo('insp-empty-tx-dir-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
      lease,
    });

    const txStagingDir = path.join(repo, '.ci-patch/staging', txId);
    fs.mkdirSync(txStagingDir, { recursive: true });
    fs.writeFileSync(path.join(txStagingDir, 'stable-diffusion.js'), 'patched', { mode: 0o600 });

    // Empty .ci-patch/backup/<txId>
    fs.mkdirSync(path.join(repo, '.ci-patch/backup', txId), { recursive: true });

    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'incomplete-transaction');
    assert.equal(state.isPending, true);
    assert.ok(state.reasons.some((r) => r.includes('empty backup directory for active transaction')));
  });

  test('unregistered backup file in ISOLATED_PREPARED is classified as incomplete-transaction', () => {
    const repo = setupDisposableRepo('insp-unreg-backup-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
      lease,
    });

    const txStagingDir = path.join(repo, '.ci-patch/staging', txId);
    fs.mkdirSync(txStagingDir, { recursive: true });
    fs.writeFileSync(path.join(txStagingDir, 'stable-diffusion.js'), 'patched', { mode: 0o600 });

    // Backup file written before journal advancement
    const txBackupDir = path.join(repo, '.ci-patch/backup', txId);
    fs.mkdirSync(txBackupDir, { recursive: true });
    fs.writeFileSync(path.join(txBackupDir, 'stable-diffusion.js'), 'stock-bytes-unregistered', { mode: 0o600 });

    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'incomplete-transaction');
    assert.equal(state.isPending, true);
    assert.ok(state.reasons.some((r) => r.includes('contains target artifact "stable-diffusion.js" in phase "ISOLATED_PREPARED" prior to journal advancement')));
  });

  test('successfully registered backup in BACKUP_CREATED is classified as ownership-unverified with isPending true', () => {
    const repo = setupDisposableRepo('insp-reg-backup-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    const backupContent = authenticStock || Buffer.from('mock-stock-bytes-for-backup-inspection');
    const initialSha = authenticStock ? stockSha : computeSha256(backupContent).toLowerCase();
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: initialSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
      lease,
    });
    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'BACKUP_CREATED',
      metadataUpdate: {
        backupPath: `.ci-patch/backup/${txId}/stable-diffusion.js`,
        targetMode: '0644',
      },
      lease,
    });

    const txStagingDir = path.join(repo, '.ci-patch/staging', txId);
    fs.mkdirSync(txStagingDir, { recursive: true });
    fs.writeFileSync(path.join(txStagingDir, 'stable-diffusion.js'), 'patched', { mode: 0o600 });

    const txBackupDir = path.join(repo, '.ci-patch/backup', txId);
    fs.mkdirSync(txBackupDir, { recursive: true });
    // Backup content matching expected initial sha
    fs.writeFileSync(path.join(txBackupDir, 'stable-diffusion.js'), backupContent, { mode: 0o600 });

    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'ownership-unverified');
    assert.equal(state.isPending, true);
    assert.equal(state.orphanedArtifacts.length, 0);
  });

  test('corrupt backup content in BACKUP_CREATED is classified as incomplete-transaction', () => {
    const repo = setupDisposableRepo('insp-corrupt-backup-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
      lease,
    });
    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'BACKUP_CREATED',
      metadataUpdate: {
        backupPath: `.ci-patch/backup/${txId}/stable-diffusion.js`,
        targetMode: '0644',
      },
      lease,
    });

    const txStagingDir = path.join(repo, '.ci-patch/staging', txId);
    fs.mkdirSync(txStagingDir, { recursive: true });
    fs.writeFileSync(path.join(txStagingDir, 'stable-diffusion.js'), 'patched', { mode: 0o600 });

    const txBackupDir = path.join(repo, '.ci-patch/backup', txId);
    fs.mkdirSync(txBackupDir, { recursive: true });
    // Tampered backup content (does not match stockSha)
    fs.writeFileSync(path.join(txBackupDir, 'stable-diffusion.js'), 'corrupted backup content', { mode: 0o600 });

    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'incomplete-transaction');
    assert.equal(state.isPending, true);
    assert.ok(state.reasons.some((r) => r.includes('Corrupted backup artifact in phase "BACKUP_CREATED"')));
  });

  test('missing backup file in BACKUP_CREATED is classified as incomplete-transaction', () => {
    const repo = setupDisposableRepo('insp-missing-backup-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
      lease,
    });
    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'BACKUP_CREATED',
      metadataUpdate: {
        backupPath: `.ci-patch/backup/${txId}/stable-diffusion.js`,
        targetMode: '0644',
      },
      lease,
    });

    const txStagingDir = path.join(repo, '.ci-patch/staging', txId);
    fs.mkdirSync(txStagingDir, { recursive: true });
    fs.writeFileSync(path.join(txStagingDir, 'stable-diffusion.js'), 'patched', { mode: 0o600 });

    // .ci-patch/backup/<txId> exists but is empty
    const txBackupDir = path.join(repo, '.ci-patch/backup', txId);
    fs.mkdirSync(txBackupDir, { recursive: true });

    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'incomplete-transaction');
    assert.equal(state.isPending, true);
    assert.ok(state.reasons.some((r) => r.includes('Missing backup artifact in phase "BACKUP_CREATED"')));
  });

  test('checkInstallationPreflight refuses on incomplete backup states', async () => {
    const repo = setupDisposableRepo('preflight-refused-backup-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    const liveContent = authenticStock || Buffer.from('mock-live-target-content');
    fs.writeFileSync(liveTarget, liveContent);

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
      lease,
    });

    // Unregistered backup remnant
    const txBackupDir = path.join(repo, '.ci-patch/backup', txId);
    fs.mkdirSync(txBackupDir, { recursive: true });
    fs.writeFileSync(path.join(txBackupDir, 'stable-diffusion.js'), 'remnant', { mode: 0o600 });

    const preflight = await checkInstallationPreflight({ targetDir: repo });
    assert.equal(preflight.ok, false);
    assert.equal(preflight.verdict, 'refused');
    assert.equal(preflight.exitCode, 1);
    assert.match(preflight.reason, /incomplete-transaction/);
  });
});

describe('P3B-2B-F1: Finding A — Late Backup-Path Substitutions at before-journal-advancement', () => {
  if (!authenticStock || !authenticPatched) {
    test.skip('Skipping tests (authentic stock or patched content unavailable)', () => {});
    return;
  }

  test('backup file deleted at before-journal-advancement hook refuses advancement', async () => {
    const repo = setupDisposableRepo('f1-bpath-del-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    await prepareIsolatedPatch({ repoRoot: repo, txId, op: 'apply', lease });

    const backupFile = path.join(repo, '.ci-patch/backup', txId, 'stable-diffusion.js');
    const faultHook = (stage) => {
      if (stage === 'before-journal-advancement') {
        fs.unlinkSync(backupFile);
      }
    };

    const res = await createVerifiedBackup({ repoRoot: repo, txId, op: 'apply', lease, faultHook });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'unexpected-backup-artifacts');

    // Journal remains in ISOLATED_PREPARED
    const jInspect = inspectJournal(repo);
    assert.equal(jInspect.journal?.phase, 'ISOLATED_PREPARED');

    // Live target is completely unchanged
    assert.equal(Buffer.compare(fs.readFileSync(liveTarget), authenticStock), 0);
  });

  test('backup file replaced with symlink at before-journal-advancement hook preserves symlink and refuses', async () => {
    const repo = setupDisposableRepo('f1-bpath-sym-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    await prepareIsolatedPatch({ repoRoot: repo, txId, op: 'apply', lease });

    const backupFile = path.join(repo, '.ci-patch/backup', txId, 'stable-diffusion.js');
    const faultHook = (stage) => {
      if (stage === 'before-journal-advancement') {
        fs.unlinkSync(backupFile);
        fs.symlinkSync(liveTarget, backupFile);
      }
    };

    const res = await createVerifiedBackup({ repoRoot: repo, txId, op: 'apply', lease, faultHook });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'unsafe-symlink');

    // Substituted artifact is NOT deleted
    assert.equal(fs.lstatSync(backupFile).isSymbolicLink(), true);

    // Journal remains in ISOLATED_PREPARED
    const jInspect = inspectJournal(repo);
    assert.equal(jInspect.journal?.phase, 'ISOLATED_PREPARED');

    // Live target unchanged
    assert.equal(Buffer.compare(fs.readFileSync(liveTarget), authenticStock), 0);
  });

  test('backup file replaced with different regular file at before-journal-advancement hook preserves file and refuses', async () => {
    const repo = setupDisposableRepo('f1-bpath-diff-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    await prepareIsolatedPatch({ repoRoot: repo, txId, op: 'apply', lease });

    const backupFile = path.join(repo, '.ci-patch/backup', txId, 'stable-diffusion.js');
    const faultHook = (stage) => {
      if (stage === 'before-journal-advancement') {
        substituteFileWithDistinctInode(backupFile, 'foreign-substituted-content', { mode: 0o600, repoRoot: repo });
      }
    };

    const res = await createVerifiedBackup({ repoRoot: repo, txId, op: 'apply', lease, faultHook });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'backup-identity-replaced');

    // Substituted artifact preserved
    assert.equal(fs.readFileSync(backupFile, 'utf8'), 'foreign-substituted-content');

    // Journal remains in ISOLATED_PREPARED
    const jInspect = inspectJournal(repo);
    assert.equal(jInspect.journal?.phase, 'ISOLATED_PREPARED');
  });

  test('backup file replaced with identical bytes on new inode at before-journal-advancement hook refuses', async () => {
    const repo = setupDisposableRepo('f1-bpath-samebytes-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    await prepareIsolatedPatch({ repoRoot: repo, txId, op: 'apply', lease });

    const backupFile = path.join(repo, '.ci-patch/backup', txId, 'stable-diffusion.js');
    const faultHook = (stage) => {
      if (stage === 'before-journal-advancement') {
        // Same content, but replaced (new inode)
        substituteFileWithDistinctInode(backupFile, authenticStock, { mode: 0o600, repoRoot: repo });
      }
    };

    const res = await createVerifiedBackup({ repoRoot: repo, txId, op: 'apply', lease, faultHook });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'backup-identity-replaced');

    // Journal remains in ISOLATED_PREPARED
    const jInspect = inspectJournal(repo);
    assert.equal(jInspect.journal?.phase, 'ISOLATED_PREPARED');
  });

  test('foreign artifact added to backup directory at before-journal-advancement hook preserves artifact and refuses', async () => {
    const repo = setupDisposableRepo('f1-bpath-foreign-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    await prepareIsolatedPatch({ repoRoot: repo, txId, op: 'apply', lease });

    const foreignFile = path.join(repo, '.ci-patch/backup', txId, 'unexpected.txt');
    const faultHook = (stage) => {
      if (stage === 'before-journal-advancement') {
        fs.writeFileSync(foreignFile, 'unexpected-payload');
      }
    };

    const res = await createVerifiedBackup({ repoRoot: repo, txId, op: 'apply', lease, faultHook });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'unexpected-backup-artifacts');

    // Foreign file is preserved
    assert.equal(fs.existsSync(foreignFile), true);

    // Journal remains in ISOLATED_PREPARED
    const jInspect = inspectJournal(repo);
    assert.equal(jInspect.journal?.phase, 'ISOLATED_PREPARED');
  });
});

describe('P3B-2B-F1: Finding B — Late Live Source Changes at before-journal-advancement', () => {
  if (!authenticStock || !authenticPatched) {
    test.skip('Skipping tests (authentic stock or patched content unavailable)', () => {});
    return;
  }

  test('live target inode replacement at before-journal-advancement hook refuses advancement', async () => {
    const repo = setupDisposableRepo('f1-src-inode-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    await prepareIsolatedPatch({ repoRoot: repo, txId, op: 'apply', lease });

    const faultHook = (stage) => {
      if (stage === 'before-journal-advancement') {
        substituteFileWithDistinctInode(liveTarget, authenticStock, { repoRoot: repo });
      }
    };

    const res = await createVerifiedBackup({ repoRoot: repo, txId, op: 'apply', lease, faultHook });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'source-identity-replaced');

    const jInspect = inspectJournal(repo);
    assert.equal(jInspect.journal?.phase, 'ISOLATED_PREPARED');
  });

  test('live target symlink replacement at before-journal-advancement hook refuses advancement', async () => {
    const repo = setupDisposableRepo('f1-src-sym-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    await prepareIsolatedPatch({ repoRoot: repo, txId, op: 'apply', lease });

    const faultHook = (stage) => {
      if (stage === 'before-journal-advancement') {
        fs.unlinkSync(liveTarget);
        fs.symlinkSync(path.join(repo, 'package.json'), liveTarget);
      }
    };

    const res = await createVerifiedBackup({ repoRoot: repo, txId, op: 'apply', lease, faultHook });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'unsafe-symlink');

    const jInspect = inspectJournal(repo);
    assert.equal(jInspect.journal?.phase, 'ISOLATED_PREPARED');
  });

  test('live target removal at before-journal-advancement hook refuses advancement', async () => {
    const repo = setupDisposableRepo('f1-src-rem-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    await prepareIsolatedPatch({ repoRoot: repo, txId, op: 'apply', lease });

    const faultHook = (stage) => {
      if (stage === 'before-journal-advancement') {
        fs.unlinkSync(liveTarget);
      }
    };

    const res = await createVerifiedBackup({ repoRoot: repo, txId, op: 'apply', lease, faultHook });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'source-missing-before-advancement');

    const jInspect = inspectJournal(repo);
    assert.equal(jInspect.journal?.phase, 'ISOLATED_PREPARED');
  });

  test('live target in-place content mutation (preserving inode) at before-journal-advancement hook refuses advancement', async () => {
    const repo = setupDisposableRepo('f1-src-inplace-mut-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

    const initialStat = fs.statSync(liveTarget);

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    await prepareIsolatedPatch({ repoRoot: repo, txId, op: 'apply', lease });

    const faultHook = (stage) => {
      if (stage === 'before-journal-advancement') {
        // Mutate in place without unlinking: keeps inode identical!
        const fd = fs.openSync(liveTarget, 'r+');
        fs.writeSync(fd, Buffer.from('MUTATED-STOCK-BYTES-IN-PLACE'), 0, 'MUTATED-STOCK-BYTES-IN-PLACE'.length, 0);
        fs.closeSync(fd);
      }
    };

    const res = await createVerifiedBackup({ repoRoot: repo, txId, op: 'apply', lease, faultHook });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'source-content-changed');

    // Confirm inode was preserved by the test mutation
    const postStat = fs.statSync(liveTarget);
    assert.equal(postStat.ino, initialStat.ino);

    // Journal remains in ISOLATED_PREPARED
    const jInspect = inspectJournal(repo);
    assert.equal(jInspect.journal?.phase, 'ISOLATED_PREPARED');
  });

  test('live target mode change (0644 -> 0600) without content change at before-journal-advancement refuses advancement', async () => {
    const repo = setupDisposableRepo('f1-src-mode-change-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock, { mode: 0o644 });

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    await prepareIsolatedPatch({ repoRoot: repo, txId, op: 'apply', lease });

    const faultHook = (stage) => {
      if (stage === 'before-journal-advancement') {
        // Change permissions only; content unchanged
        fs.chmodSync(liveTarget, 0o600);
      }
    };

    const res = await createVerifiedBackup({ repoRoot: repo, txId, op: 'apply', lease, faultHook });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'source-mode-changed');

    const jInspect = inspectJournal(repo);
    assert.equal(jInspect.journal?.phase, 'ISOLATED_PREPARED');
  });

  test('live target mode change (0600 -> 0644) when initial target was 0600 refuses advancement', async () => {
    const repo = setupDisposableRepo('f1-src-mode-rev-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock, { mode: 0o600 });

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    await prepareIsolatedPatch({ repoRoot: repo, txId, op: 'apply', lease });

    const faultHook = (stage) => {
      if (stage === 'before-journal-advancement') {
        fs.chmodSync(liveTarget, 0o644);
      }
    };

    const res = await createVerifiedBackup({ repoRoot: repo, txId, op: 'apply', lease, faultHook });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'source-mode-changed');

    const jInspect = inspectJournal(repo);
    assert.equal(jInspect.journal?.phase, 'ISOLATED_PREPARED');
  });

  test('live target special permission bits added (setuid 0o4644) at before-journal-advancement refuses advancement', async () => {
    const repo = setupDisposableRepo('f1-src-setuid-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock, { mode: 0o644 });

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    await prepareIsolatedPatch({ repoRoot: repo, txId, op: 'apply', lease });

    const faultHook = (stage) => {
      if (stage === 'before-journal-advancement') {
        fs.chmodSync(liveTarget, 0o4644);
      }
    };

    const res = await createVerifiedBackup({ repoRoot: repo, txId, op: 'apply', lease, faultHook });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'special-permission-bits-unsupported');

    const jInspect = inspectJournal(repo);
    assert.equal(jInspect.journal?.phase, 'ISOLATED_PREPARED');
  });
});

describe('P3B-2B-F1: Finding B — Late Staging Changes at before-journal-advancement', () => {
  if (!authenticStock || !authenticPatched) {
    test.skip('Skipping tests (authentic stock or patched content unavailable)', () => {});
    return;
  }

  test('staged file removed at before-journal-advancement hook refuses advancement', async () => {
    const repo = setupDisposableRepo('f1-stg-rem-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    await prepareIsolatedPatch({ repoRoot: repo, txId, op: 'apply', lease });

    const stagedFile = path.join(repo, '.ci-patch/staging', txId, 'stable-diffusion.js');
    const faultHook = (stage) => {
      if (stage === 'before-journal-advancement') {
        fs.unlinkSync(stagedFile);
      }
    };

    const res = await createVerifiedBackup({ repoRoot: repo, txId, op: 'apply', lease, faultHook });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'unexpected-staging-artifacts');

    const jInspect = inspectJournal(repo);
    assert.equal(jInspect.journal?.phase, 'ISOLATED_PREPARED');
  });

  test('staged file replaced with symlink at before-journal-advancement hook refuses advancement', async () => {
    const repo = setupDisposableRepo('f1-stg-sym-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    await prepareIsolatedPatch({ repoRoot: repo, txId, op: 'apply', lease });

    const stagedFile = path.join(repo, '.ci-patch/staging', txId, 'stable-diffusion.js');
    const faultHook = (stage) => {
      if (stage === 'before-journal-advancement') {
        fs.unlinkSync(stagedFile);
        fs.symlinkSync(liveTarget, stagedFile);
      }
    };

    const res = await createVerifiedBackup({ repoRoot: repo, txId, op: 'apply', lease, faultHook });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'unsafe-symlink');

    const jInspect = inspectJournal(repo);
    assert.equal(jInspect.journal?.phase, 'ISOLATED_PREPARED');
  });

  test('staged file replaced with different regular file at before-journal-advancement hook refuses advancement', async () => {
    const repo = setupDisposableRepo('f1-stg-diff-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    await prepareIsolatedPatch({ repoRoot: repo, txId, op: 'apply', lease });

    const stagedFile = path.join(repo, '.ci-patch/staging', txId, 'stable-diffusion.js');
    const faultHook = (stage) => {
      if (stage === 'before-journal-advancement') {
        substituteFileWithDistinctInode(stagedFile, 'tampered-staged-content', { mode: 0o600, repoRoot: repo });
      }
    };

    const res = await createVerifiedBackup({ repoRoot: repo, txId, op: 'apply', lease, faultHook });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'staged-identity-replaced');

    const jInspect = inspectJournal(repo);
    assert.equal(jInspect.journal?.phase, 'ISOLATED_PREPARED');
  });

  test('staged file content mutated in place (same inode) at before-journal-advancement hook refuses advancement', async () => {
    const repo = setupDisposableRepo('f1-stg-mut-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    await prepareIsolatedPatch({ repoRoot: repo, txId, op: 'apply', lease });

    const stagedFile = path.join(repo, '.ci-patch/staging', txId, 'stable-diffusion.js');
    const initialStat = fs.statSync(stagedFile);

    const faultHook = (stage) => {
      if (stage === 'before-journal-advancement') {
        const fd = fs.openSync(stagedFile, 'r+');
        fs.writeSync(fd, Buffer.from('MUTATED-STAGED-IN-PLACE'), 0, 'MUTATED-STAGED-IN-PLACE'.length, 0);
        fs.closeSync(fd);
      }
    };

    const res = await createVerifiedBackup({ repoRoot: repo, txId, op: 'apply', lease, faultHook });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'result-sha256-mismatch');

    // Confirm inode was preserved
    const postStat = fs.statSync(stagedFile);
    assert.equal(postStat.ino, initialStat.ino);

    const jInspect = inspectJournal(repo);
    assert.equal(jInspect.journal?.phase, 'ISOLATED_PREPARED');
  });

  test('staged file replaced with identical bytes on new inode at before-journal-advancement hook refuses advancement', async () => {
    const repo = setupDisposableRepo('f1-stg-samebytes-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    await prepareIsolatedPatch({ repoRoot: repo, txId, op: 'apply', lease });

    const stagedFile = path.join(repo, '.ci-patch/staging', txId, 'stable-diffusion.js');
    const faultHook = (stage) => {
      if (stage === 'before-journal-advancement') {
        const originalBytes = fs.readFileSync(stagedFile);
        substituteFileWithDistinctInode(stagedFile, originalBytes, { mode: 0o600, repoRoot: repo });
      }
    };

    const res = await createVerifiedBackup({ repoRoot: repo, txId, op: 'apply', lease, faultHook });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'staged-identity-replaced');

    const jInspect = inspectJournal(repo);
    assert.equal(jInspect.journal?.phase, 'ISOLATED_PREPARED');
  });
});

describe('P3B-2B-F2: Finding A — Structured Filesystem Failure Handling during Final Reauthentication', () => {
  if (!authenticStock || !authenticPatched) {
    test.skip('Skipping authentic tests (authentic stock or patched fixture unavailable)', () => {});
    return;
  }

  test('converts unexpected EIO during final live source fstatSync into structured failure result', async () => {
    const repo = setupDisposableRepo('f2-src-fstat-eio-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    await prepareIsolatedPatch({ repoRoot: repo, txId, op: 'apply', lease });

    const origFstatSync = fs.fstatSync;
    const faultHook = (stage) => {
      if (stage === 'before-journal-advancement') {
        const liveIno = fs.statSync(liveTarget).ino;
        fs.fstatSync = (fd, ...args) => {
          const realStat = origFstatSync(fd, ...args);
          if (realStat.ino === liveIno) {
            const err = new Error('Simulated live fstat EIO');
            err.code = 'EIO';
            throw err;
          }
          return realStat;
        };
      }
    };

    try {
      const res = await createVerifiedBackup({ repoRoot: repo, txId, op: 'apply', lease, faultHook });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'EIO');
      assert.equal(res.stage, 'final-source-reauth');
      assert.match(res.error, /Simulated live fstat EIO/);

      const jInspect = inspectJournal(repo);
      assert.equal(jInspect.journal?.phase, 'ISOLATED_PREPARED');
    } finally {
      fs.fstatSync = origFstatSync;
    }
  });

  test('converts unexpected EIO during final live source readSync into structured failure result', async () => {
    const repo = setupDisposableRepo('f2-src-read-eio-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    await prepareIsolatedPatch({ repoRoot: repo, txId, op: 'apply', lease });

    const origReadSync = fs.readSync;
    const origFstatSync = fs.fstatSync;
    const faultHook = (stage) => {
      if (stage === 'before-journal-advancement') {
        const liveIno = fs.statSync(liveTarget).ino;
        fs.readSync = (fd, ...args) => {
          let isLiveFd = false;
          try {
            isLiveFd = origFstatSync(fd).ino === liveIno;
          } catch {
            // ignore
          }
          if (isLiveFd) {
            const err = new Error('Simulated live readSync EIO');
            err.code = 'EIO';
            throw err;
          }
          return origReadSync(fd, ...args);
        };
      }
    };

    try {
      const res = await createVerifiedBackup({ repoRoot: repo, txId, op: 'apply', lease, faultHook });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'EIO');
      assert.equal(res.stage, 'final-source-reauth');
      assert.match(res.error, /Simulated live readSync EIO/);

      const jInspect = inspectJournal(repo);
      assert.equal(jInspect.journal?.phase, 'ISOLATED_PREPARED');
    } finally {
      fs.readSync = origReadSync;
    }
  });

  test('converts unexpected EACCES during final live source lstatSync into structured failure result', async () => {
    const repo = setupDisposableRepo('f2-src-lstat-eacces-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    await prepareIsolatedPatch({ repoRoot: repo, txId, op: 'apply', lease });

    const origLstatSync = fs.lstatSync;
    const faultHook = (stage) => {
      if (stage === 'before-journal-advancement') {
        fs.lstatSync = (targetPath, ...args) => {
          if (typeof targetPath === 'string' && targetPath.endsWith('stable-diffusion.js') && !targetPath.includes('.ci-patch')) {
            const err = new Error('Simulated live lstat EACCES');
            err.code = 'EACCES';
            throw err;
          }
          return origLstatSync(targetPath, ...args);
        };
      }
    };

    try {
      const res = await createVerifiedBackup({ repoRoot: repo, txId, op: 'apply', lease, faultHook });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'EACCES');
      assert.equal(res.stage, 'final-source-reauth');
      assert.match(res.error, /Simulated live lstat EACCES/);

      const jInspect = inspectJournal(repo);
      assert.equal(jInspect.journal?.phase, 'ISOLATED_PREPARED');
    } finally {
      fs.lstatSync = origLstatSync;
    }
  });

  test('converts unexpected EIO during final backup fstatSync into structured failure result', async () => {
    const repo = setupDisposableRepo('f2-bak-fstat-eio-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    await prepareIsolatedPatch({ repoRoot: repo, txId, op: 'apply', lease });

    const origFstatSync = fs.fstatSync;
    const faultHook = (stage) => {
      if (stage === 'before-journal-advancement') {
        const backupFile = path.join(repo, '.ci-patch/backup', txId, 'stable-diffusion.js');
        const backupIno = fs.statSync(backupFile).ino;
        fs.fstatSync = (fd, ...args) => {
          const realStat = origFstatSync(fd, ...args);
          if (realStat.ino === backupIno) {
            const err = new Error('Simulated backup fstat EIO');
            err.code = 'EIO';
            throw err;
          }
          return realStat;
        };
      }
    };

    try {
      const res = await createVerifiedBackup({ repoRoot: repo, txId, op: 'apply', lease, faultHook });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'EIO');
      assert.equal(res.stage, 'final-backup-reauth');
      assert.match(res.error, /Simulated backup fstat EIO/);

      const jInspect = inspectJournal(repo);
      assert.equal(jInspect.journal?.phase, 'ISOLATED_PREPARED');
    } finally {
      fs.fstatSync = origFstatSync;
    }
  });

  test('converts unexpected EIO during final backup readSync into structured failure result', async () => {
    const repo = setupDisposableRepo('f2-bak-read-eio-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    await prepareIsolatedPatch({ repoRoot: repo, txId, op: 'apply', lease });

    const origReadSync = fs.readSync;
    const origFstatSync = fs.fstatSync;
    const faultHook = (stage) => {
      if (stage === 'before-journal-advancement') {
        const backupFile = path.join(repo, '.ci-patch/backup', txId, 'stable-diffusion.js');
        const backupIno = fs.statSync(backupFile).ino;
        fs.readSync = (fd, ...args) => {
          let isBackupFd = false;
          try {
            isBackupFd = origFstatSync(fd).ino === backupIno;
          } catch {
            // ignore
          }
          if (isBackupFd) {
            const err = new Error('Simulated backup readSync EIO');
            err.code = 'EIO';
            throw err;
          }
          return origReadSync(fd, ...args);
        };
      }
    };

    try {
      const res = await createVerifiedBackup({ repoRoot: repo, txId, op: 'apply', lease, faultHook });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'EIO');
      assert.equal(res.stage, 'final-backup-reauth');
      assert.match(res.error, /Simulated backup readSync EIO/);

      const jInspect = inspectJournal(repo);
      assert.equal(jInspect.journal?.phase, 'ISOLATED_PREPARED');
    } finally {
      fs.readSync = origReadSync;
    }
  });

  test('converts unexpected EACCES during final backup lstatSync into structured failure result', async () => {
    const repo = setupDisposableRepo('f2-bak-lstat-eacces-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    await prepareIsolatedPatch({ repoRoot: repo, txId, op: 'apply', lease });

    const origLstatSync = fs.lstatSync;
    const faultHook = (stage) => {
      if (stage === 'before-journal-advancement') {
        fs.lstatSync = (targetPath, ...args) => {
          if (typeof targetPath === 'string' && targetPath.includes('/backup/')) {
            const err = new Error('Simulated backup lstat EACCES');
            err.code = 'EACCES';
            throw err;
          }
          return origLstatSync(targetPath, ...args);
        };
      }
    };

    try {
      const res = await createVerifiedBackup({ repoRoot: repo, txId, op: 'apply', lease, faultHook });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'EACCES');
      assert.equal(res.stage, 'final-backup-reauth');
      assert.match(res.error, /Simulated backup lstat EACCES/);

      const jInspect = inspectJournal(repo);
      assert.equal(jInspect.journal?.phase, 'ISOLATED_PREPARED');
    } finally {
      fs.lstatSync = origLstatSync;
    }
  });

  test('deliberate _isFault error inside fault hook propagates without being caught', async () => {
    const repo = setupDisposableRepo('f2-fault-propagate-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    await prepareIsolatedPatch({ repoRoot: repo, txId, op: 'apply', lease });

    const faultHook = (stage) => {
      if (stage === 'before-journal-advancement') {
        const err = new Error('Deliberate process crash simulation');
        err._isFault = true;
        throw err;
      }
    };

    await assert.rejects(
      createVerifiedBackup({ repoRoot: repo, txId, op: 'apply', lease, faultHook }),
      (err) => {
        assert.equal(err._isFault, true);
        assert.match(err.message, /Deliberate process crash simulation/);
        return true;
      }
    );

    const jInspect = inspectJournal(repo);
    assert.equal(jInspect.journal?.phase, 'ISOLATED_PREPARED');
  });
});

describe('D01-P3B-2D-2-C-JH2: Journal Advancement Uncertainty Propagation in Backup', () => {
  test('createVerifiedBackup propagates uncertain journal advancement failure with structured schema', async () => {
    const repo = setupDisposableRepo('jh2-backup-adv-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);
    fs.chmodSync(liveTarget, 0o644);

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });

    const prepRes = await prepareIsolatedPatch({ repoRoot: repo, txId, op: 'apply', lease });
    assert.equal(prepRes.ok, true);

    const origRenameSync = fs.renameSync;
    try {
      fs.renameSync = (src, dst) => {
        if (typeof src === 'string' && src.includes(`.journal.${txId}.tmp`)) {
          const err = new Error('Simulated rename interruption during backup journal advancement');
          err.code = 'EIO';
          throw err;
        }
        return origRenameSync(src, dst);
      };

      const res = await createVerifiedBackup({
        repoRoot: repo,
        txId,
        op: 'apply',
        lease,
      });

      assert.equal(res.ok, false);
      assert.equal(res.uncertain, true);
      assert.equal(res.publicationAttempted, true);
      assert.equal(res.publicationConfirmed, null);
      assert.equal(res.directoryFsyncConfirmed, false);
      assert.equal(res.stage, 'rename-attempted');
      assert.equal(res.code, 'EIO');
      assert.match(res.error, /Failed to advance journal to BACKUP_CREATED/);

      // Verify backup was NOT deleted and is preserved for evidence
      const backupFile = path.join(repo, '.ci-patch/backup', txId, 'stable-diffusion.js');
      assert.equal(fs.existsSync(backupFile), true, 'Backup file must be preserved for evidence');

      // Verify journal remains at previous phase
      const jInspect = inspectJournal(repo);
      assert.equal(jInspect.journal?.phase, 'ISOLATED_PREPARED');
    } finally {
      fs.renameSync = origRenameSync;
    }
  });
});
