import { describe, test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  resolveStorageDirectory,
  createPreMutationBackup,
  verifyBackupIntegrity,
  acquireProcessLock,
  verifyLockOwnership,
  releaseProcessLock,
  computeSha256,
  BACKUPS_SUBDIR_NAME,
  LOCKS_SUBDIR_NAME,
} from '../src/patch-installer/simple-backup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const tempDirsToClean = [];

function createTempDir(prefix = 'ci-test-storage-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirsToClean.push(dir);
  return dir;
}

const suiteIsolatedXdg = createTempDir('ci-test-suite-xdg-');
const originalSuiteXdg = process.env.XDG_DATA_HOME;
process.env.XDG_DATA_HOME = suiteIsolatedXdg;

after(() => {
  if (originalSuiteXdg === undefined) {
    delete process.env.XDG_DATA_HOME;
  } else {
    process.env.XDG_DATA_HOME = originalSuiteXdg;
  }
  for (const dir of tempDirsToClean) {
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  }
});

describe('Simple Backup & Storage Management (simple-backup.js)', () => {
  test('resolveStorageDirectory creates private storage structure with mode 0700', () => {
    const fakeRepo = createTempDir('fake-repo-');
    const customBase = path.join(createTempDir('custom-storage-'), 'ci-storage');

    const res = resolveStorageDirectory({
      repoRoot: fakeRepo,
      backupOverride: customBase,
      lockOverride: customBase,
    });

    assert.equal(res.ok, true);
    assert.equal(res.baseDir, customBase);
    assert.equal(res.backupsDir, path.join(customBase, BACKUPS_SUBDIR_NAME));
    assert.equal(res.locksDir, path.join(customBase, LOCKS_SUBDIR_NAME));

    // Verify directories exist on disk
    assert.equal(fs.existsSync(customBase), true);
    assert.equal(fs.existsSync(res.backupsDir), true);
    assert.equal(fs.existsSync(res.locksDir), true);

    // Verify permissions: mode 0700 (no group or other access)
    const statBase = fs.lstatSync(customBase);
    assert.equal(statBase.mode & 0o077, 0, 'baseDir must have no group/world permissions');
    const statBackups = fs.lstatSync(res.backupsDir);
    assert.equal(statBackups.mode & 0o077, 0, 'backupsDir must have no group/world permissions');
    const statLocks = fs.lstatSync(res.locksDir);
    assert.equal(statLocks.mode & 0o077, 0, 'locksDir must have no group/world permissions');
  });

  test('resolveStorageDirectory rejects storage location inside SillyTavern repository', () => {
    const fakeRepo = createTempDir('fake-st-repo-');
    const insideStorage = path.join(fakeRepo, 'chromatic-storage');

    const res = resolveStorageDirectory({
      repoRoot: fakeRepo,
      customOverride: insideStorage,
    });

    assert.equal(res.ok, false);
    assert.match(res.error, /resides inside the target SillyTavern repository/);
    assert.equal(fs.existsSync(insideStorage), false, 'Must not create directory inside SillyTavern');
  });

  test('resolveStorageDirectory rejects storage directory that is a symbolic link', () => {
    const fakeRepo = createTempDir('fake-repo-');
    const targetDir = createTempDir('real-target-');
    const symlinkStorage = path.join(createTempDir('symlink-parent-'), 'sym-storage');
    fs.symlinkSync(targetDir, symlinkStorage);

    const res = resolveStorageDirectory({
      repoRoot: fakeRepo,
      customOverride: symlinkStorage,
    });

    assert.equal(res.ok, false);
    assert.match(res.error, /symbolic link/);
  });

  test('resolveStorageDirectory rejects pre-existing storage directory with unsafe permissions', () => {
    const fakeRepo = createTempDir('fake-repo-');
    const storageDir = createTempDir('unsafe-perms-');
    // Set group/world readable (0755)
    fs.chmodSync(storageDir, 0o755);

    const res = resolveStorageDirectory({
      repoRoot: fakeRepo,
      customOverride: storageDir,
    });

    assert.equal(res.ok, false);
    assert.match(res.error, /unsafe existing permissions/);
  });

  test('resolveStorageDirectory rejects invalid or control-character overrides', () => {
    const fakeRepo = createTempDir('fake-repo-');

    assert.equal(
      resolveStorageDirectory({ repoRoot: fakeRepo, customOverride: '   ' }).ok,
      false
    );
    assert.equal(
      resolveStorageDirectory({ repoRoot: fakeRepo, customOverride: '/tmp/test\x00bad' }).ok,
      false
    );
  });

  test('resolveStorageDirectory rejects when an ancestor is a symlink pointing into SillyTavern', () => {
    const fakeRepo = createTempDir('st-repo-ancestor-');
    const outsideParent = createTempDir('outside-parent-');
    const symlinkAncestor = path.join(outsideParent, 'symlink-to-st');
    fs.symlinkSync(fakeRepo, symlinkAncestor);
    const maliciousStorage = path.join(symlinkAncestor, 'chromatic-storage');

    const res = resolveStorageDirectory({
      repoRoot: fakeRepo,
      customOverride: maliciousStorage,
    });

    assert.equal(res.ok, false);
    assert.match(res.error, /resolv(es|ing) inside the target SillyTavern repository/);
    // Crucial safety guarantee: no directories or files created physically inside SillyTavern
    assert.equal(fs.existsSync(maliciousStorage), false, 'Must not create directories inside SillyTavern via ancestor symlink');
    assert.equal(fs.existsSync(path.join(fakeRepo, 'chromatic-storage')), false);
  });

  test('resolveStorageDirectory rejects default XDG_DATA_HOME with ancestor symlink pointing inside SillyTavern', () => {
    const fakeRepo = createTempDir('st-repo-xdg-inside-');
    const outsideParent = createTempDir('xdg-outside-parent-');
    const symlinkToSt = path.join(outsideParent, 'symlink-st');
    fs.symlinkSync(fakeRepo, symlinkToSt);
    const xdgTarget = path.join(symlinkToSt, 'data-home');

    const oldXdg = process.env.XDG_DATA_HOME;
    const oldBackup = process.env.CI_BACKUP_DIR;
    delete process.env.CI_BACKUP_DIR;
    process.env.XDG_DATA_HOME = xdgTarget;

    try {
      const res = resolveStorageDirectory({ repoRoot: fakeRepo });
      assert.equal(res.ok, false);
      assert.match(res.error, /resolv(es|ing) inside the target SillyTavern repository/);
      // Guarantee: no directories created inside SillyTavern
      assert.equal(fs.existsSync(path.join(fakeRepo, 'data-home')), false);
      assert.equal(fs.existsSync(path.join(fakeRepo, 'data-home', 'chromatic-images')), false);
    } finally {
      if (oldXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = oldXdg;
      if (oldBackup !== undefined) process.env.CI_BACKUP_DIR = oldBackup;
    }
  });

  test('resolveStorageDirectory rejects default XDG_DATA_HOME with ancestor symlink pointing outside SillyTavern', () => {
    const fakeRepo = createTempDir('st-repo-xdg-outside-');
    const outsideParent = createTempDir('xdg-parent-');
    const realTargetDir = createTempDir('xdg-real-target-');
    const symlinkOutside = path.join(outsideParent, 'symlink-outside');
    fs.symlinkSync(realTargetDir, symlinkOutside);
    const xdgTarget = path.join(symlinkOutside, 'data-home');

    const oldXdg = process.env.XDG_DATA_HOME;
    const oldBackup = process.env.CI_BACKUP_DIR;
    delete process.env.CI_BACKUP_DIR;
    process.env.XDG_DATA_HOME = xdgTarget;

    try {
      const res = resolveStorageDirectory({ repoRoot: fakeRepo });
      assert.equal(res.ok, false);
      assert.match(res.error, /symbolic link/);
      // Guarantee: no directories created
      assert.equal(fs.existsSync(path.join(realTargetDir, 'data-home')), false);
      assert.equal(fs.existsSync(path.join(realTargetDir, 'data-home', 'chromatic-images')), false);
    } finally {
      if (oldXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = oldXdg;
      if (oldBackup !== undefined) process.env.CI_BACKUP_DIR = oldBackup;
    }
  });

  test('resolveStorageDirectory rejects explicitly empty or whitespace override without fallback', () => {
    const fakeRepo = createTempDir('empty-override-repo-');

    const emptyRes = resolveStorageDirectory({
      repoRoot: fakeRepo,
      customOverride: '',
    });
    assert.equal(emptyRes.ok, false);
    assert.match(emptyRes.error, /cannot be empty/);

    const whitespaceRes = resolveStorageDirectory({
      repoRoot: fakeRepo,
      customOverride: '   \t  \n',
    });
    assert.equal(whitespaceRes.ok, false);
    assert.match(whitespaceRes.error, /cannot be empty/);

    // Check CI_BACKUP_DIR env variable empty or whitespace string
    const oldEnv = process.env.CI_BACKUP_DIR;
    try {
      process.env.CI_BACKUP_DIR = '   ';
      const envRes = resolveStorageDirectory({ repoRoot: fakeRepo });
      assert.equal(envRes.ok, false);
      assert.match(envRes.error, /cannot be empty/);
    } finally {
      if (oldEnv === undefined) {
        delete process.env.CI_BACKUP_DIR;
      } else {
        process.env.CI_BACKUP_DIR = oldEnv;
      }
    }

    // Check lockOverride empty or whitespace string
    const emptyLockRes = resolveStorageDirectory({
      repoRoot: fakeRepo,
      lockOverride: '   ',
    });
    assert.equal(emptyLockRes.ok, false);
    assert.match(emptyLockRes.error, /Lock directory override cannot be empty/);

    // Check CI_LOCK_DIR env variable empty or whitespace string
    const oldLockEnv = process.env.CI_LOCK_DIR;
    try {
      process.env.CI_LOCK_DIR = '   ';
      const envLockRes = resolveStorageDirectory({ repoRoot: fakeRepo });
      assert.equal(envLockRes.ok, false);
      assert.match(envLockRes.error, /Environment variable CI_LOCK_DIR cannot be empty/);
    } finally {
      if (oldLockEnv === undefined) {
        delete process.env.CI_LOCK_DIR;
      } else {
        process.env.CI_LOCK_DIR = oldLockEnv;
      }
    }
  });

  test('resolveStorageDirectory keeps locksDir in user-local namespace independent of backupOverride', () => {
    const fakeRepo = createTempDir('fake-repo-');
    const customBackup = path.join(createTempDir('custom-backup-'), 'backups');
    const isolatedXdg = createTempDir('isolated-xdg-');
    const oldXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = isolatedXdg;
    try {
      const res = resolveStorageDirectory({
        repoRoot: fakeRepo,
        backupOverride: customBackup,
      });
      assert.equal(res.ok, true);
      assert.equal(res.backupsDir, path.join(customBackup, BACKUPS_SUBDIR_NAME));
      assert.equal(res.locksDir, path.join(isolatedXdg, 'chromatic-images', LOCKS_SUBDIR_NAME));
    } finally {
      if (oldXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = oldXdg;
    }
  });

  test('resolveStorageDirectory keeps locksDir in user-local namespace independent of CI_BACKUP_DIR', () => {
    const fakeRepo = createTempDir('fake-repo-');
    const customBackup = path.join(createTempDir('env-backup-'), 'backups');
    const isolatedXdg = createTempDir('isolated-xdg-');
    const oldXdg = process.env.XDG_DATA_HOME;
    const oldEnvBackup = process.env.CI_BACKUP_DIR;
    process.env.XDG_DATA_HOME = isolatedXdg;
    process.env.CI_BACKUP_DIR = customBackup;
    try {
      const res = resolveStorageDirectory({ repoRoot: fakeRepo });
      assert.equal(res.ok, true);
      assert.equal(res.backupsDir, path.join(customBackup, BACKUPS_SUBDIR_NAME));
      assert.equal(res.locksDir, path.join(isolatedXdg, 'chromatic-images', LOCKS_SUBDIR_NAME));
    } finally {
      if (oldXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = oldXdg;
      if (oldEnvBackup === undefined) delete process.env.CI_BACKUP_DIR;
      else process.env.CI_BACKUP_DIR = oldEnvBackup;
    }
  });

  test('resolveStorageDirectory rejects lock location inside SillyTavern repository', () => {
    const fakeRepo = createTempDir('fake-st-repo-');
    const insideLocks = path.join(fakeRepo, 'chromatic-locks');

    const res = resolveStorageDirectory({
      repoRoot: fakeRepo,
      lockOverride: insideLocks,
    });

    assert.equal(res.ok, false);
    assert.match(res.error, /resides inside the target SillyTavern repository/);
    assert.equal(fs.existsSync(insideLocks), false, 'Must not create lock directory inside SillyTavern');
  });

  test('resolveStorageDirectory rejects lock directory that is a symbolic link', () => {
    const fakeRepo = createTempDir('fake-repo-');
    const targetDir = createTempDir('real-lock-target-');
    const symlinkLock = path.join(createTempDir('symlink-parent-'), 'sym-lock');
    fs.symlinkSync(targetDir, symlinkLock);

    const res = resolveStorageDirectory({
      repoRoot: fakeRepo,
      lockOverride: symlinkLock,
    });

    assert.equal(res.ok, false);
    assert.match(res.error, /symbolic link/);
  });

  test('createPreMutationBackup creates mode 0600 backup file and metadata descriptor', () => {
    const fakeRepo = createTempDir('backup-repo-');
    const storageRes = resolveStorageDirectory({
      repoRoot: fakeRepo,
      customOverride: path.join(createTempDir('backup-store-'), 'store'),
    });
    assert.equal(storageRes.ok, true);

    const targetFile = path.join(fakeRepo, 'target.js');
    const sampleContent = Buffer.from('const x = 42;\nexport default x;\n');
    fs.writeFileSync(targetFile, sampleContent);
    const expectedSha = computeSha256(sampleContent);

    const backupRes = createPreMutationBackup({
      repoRoot: fakeRepo,
      targetFilePath: targetFile,
      expectedSha256: expectedSha,
      operation: 'apply',
      backupDir: storageRes.backupsDir,
      targetMode: '0644',
    });

    assert.equal(backupRes.ok, true);
    assert.equal(fs.existsSync(backupRes.backupFilePath), true);
    assert.equal(fs.existsSync(backupRes.metaFilePath), true);

    // Verify file modes are 0600
    const bStat = fs.lstatSync(backupRes.backupFilePath);
    assert.equal(bStat.mode & 0o077, 0, 'Backup file must have no group/world access');
    const mStat = fs.lstatSync(backupRes.metaFilePath);
    assert.equal(mStat.mode & 0o077, 0, 'Metadata file must have no group/world access');

    // Verify backup content
    const backupContent = fs.readFileSync(backupRes.backupFilePath);
    assert.equal(computeSha256(backupContent), expectedSha);
    assert.equal(backupContent.length, sampleContent.length);

    // Verify metadata JSON
    const meta = JSON.parse(fs.readFileSync(backupRes.metaFilePath, 'utf-8'));
    assert.equal(meta.schemaVersion, '1.1.0');
    assert.equal(meta.operation, 'apply');
    assert.equal(meta.sha256, expectedSha);
    assert.equal(meta.targetMode, '0644');
    assert.equal(meta.backupFileName, backupRes.backupFileName);
  });

  test('createPreMutationBackup refuses if target content does not match expected SHA-256', () => {
    const fakeRepo = createTempDir('mismatch-repo-');
    const storageRes = resolveStorageDirectory({
      repoRoot: fakeRepo,
      customOverride: path.join(createTempDir('mismatch-store-'), 'store'),
    });

    const targetFile = path.join(fakeRepo, 'target.js');
    fs.writeFileSync(targetFile, 'modified content\n');

    assert.throws(
      () => {
        createPreMutationBackup({
          repoRoot: fakeRepo,
          targetFilePath: targetFile,
          expectedSha256: '0000000000000000000000000000000000000000000000000000000000000000',
          operation: 'apply',
          backupDir: storageRes.backupsDir,
        });
      },
      /does not match expected SHA-256/
    );
  });

  test('createPreMutationBackup refuses if target file is a symbolic link', () => {
    const fakeRepo = createTempDir('symlink-repo-');
    const storageRes = resolveStorageDirectory({
      repoRoot: fakeRepo,
      customOverride: path.join(createTempDir('symlink-store-'), 'store'),
    });

    const realFile = path.join(createTempDir('real-outside-'), 'real.js');
    fs.writeFileSync(realFile, 'real content\n');
    const symlinkFile = path.join(fakeRepo, 'symlink-target.js');
    fs.symlinkSync(realFile, symlinkFile);

    assert.throws(
      () => {
        createPreMutationBackup({
          repoRoot: fakeRepo,
          targetFilePath: symlinkFile,
          expectedSha256: computeSha256(fs.readFileSync(realFile)),
          operation: 'apply',
          backupDir: storageRes.backupsDir,
        });
      },
      /symbolic link/
    );
  });

  test('createPreMutationBackup preserves partial file on simulated fsync failure', () => {
    const fakeRepo = createTempDir('fault-repo-');
    const storageRes = resolveStorageDirectory({
      repoRoot: fakeRepo,
      customOverride: path.join(createTempDir('fault-store-'), 'store'),
    });

    const targetFile = path.join(fakeRepo, 'target.js');
    fs.writeFileSync(targetFile, 'data to backup\n');
    const sha = computeSha256('data to backup\n');

    let capturedBackupPath = null;

    assert.throws(
      () => {
        createPreMutationBackup({
          repoRoot: fakeRepo,
          targetFilePath: targetFile,
          expectedSha256: sha,
          operation: 'apply',
          backupDir: storageRes.backupsDir,
          _testHooks: {
            beforeBackupFsync({ backupFilePath }) {
              capturedBackupPath = backupFilePath;
              throw new Error('SIMULATED_FSYNC_DISK_FULL');
            },
          },
        });
      },
      (err) => {
        assert.match(err.message, /SIMULATED_FSYNC_DISK_FULL/);
        assert.equal(err.backupFilePath, capturedBackupPath, 'Error must attach backupFilePath');
        return true;
      }
    );

    // Forensic evidence preserved: partial file must still exist
    assert.ok(capturedBackupPath);
    assert.equal(fs.existsSync(capturedBackupPath), true, 'Incomplete backup evidence must be preserved');
  });

  test('createPreMutationBackup preserves partial file and reports path on write failure', () => {
    const fakeRepo = createTempDir('write-fail-repo-');
    const storageRes = resolveStorageDirectory({
      repoRoot: fakeRepo,
      customOverride: path.join(createTempDir('write-fail-store-'), 'store'),
    });

    const targetFile = path.join(fakeRepo, 'target.js');
    fs.writeFileSync(targetFile, 'data for write failure test\n');
    const sha = computeSha256('data for write failure test\n');

    let capturedBackupPath = null;
    const origWriteSync = fs.writeSync;
    try {
      fs.writeSync = function() {
        throw new Error('SIMULATED_WRITE_IO_ERROR');
      };

      assert.throws(
        () => {
          createPreMutationBackup({
            repoRoot: fakeRepo,
            targetFilePath: targetFile,
            expectedSha256: sha,
            operation: 'apply',
            backupDir: storageRes.backupsDir,
          });
        },
        (err) => {
          assert.match(err.message, /SIMULATED_WRITE_IO_ERROR/);
          assert.ok(err.backupFilePath, 'Error must attach backupFilePath even on write failure');
          capturedBackupPath = err.backupFilePath;
          return true;
        }
      );
    } finally {
      fs.writeSync = origWriteSync;
    }

    assert.ok(capturedBackupPath);
    assert.equal(fs.existsSync(capturedBackupPath), true, 'Partial file must be preserved after write failure');
  });

  test('createPreMutationBackup preserves partial backup when metadata writing fails', () => {
    const fakeRepo = createTempDir('meta-fail-repo-');
    const storageRes = resolveStorageDirectory({
      repoRoot: fakeRepo,
      customOverride: path.join(createTempDir('meta-fail-store-'), 'store'),
    });

    const targetFile = path.join(fakeRepo, 'target.js');
    fs.writeFileSync(targetFile, 'data to backup\n');
    const sha = computeSha256('data to backup\n');

    let capturedBackupPath = null;

    assert.throws(
      () => {
        createPreMutationBackup({
          repoRoot: fakeRepo,
          targetFilePath: targetFile,
          expectedSha256: sha,
          operation: 'apply',
          backupDir: storageRes.backupsDir,
          _testHooks: {
            beforeMetaOpen({ backupFilePath }) {
              capturedBackupPath = backupFilePath;
              throw new Error('SIMULATED_METADATA_CREATION_FAILURE');
            },
          },
        });
      },
      (err) => {
        assert.match(err.message, /SIMULATED_METADATA_CREATION_FAILURE/);
        assert.ok(err.backupFilePath, 'Error must attach backupFilePath');
        return true;
      }
    );

    assert.ok(capturedBackupPath);
    assert.equal(fs.existsSync(capturedBackupPath), true, 'Partial .bak file must be preserved');
    assert.equal(computeSha256(fs.readFileSync(capturedBackupPath)), sha);
  });

  test('verifyBackupIntegrity correctly validates matching and tampered backup files', () => {
    const dir = createTempDir('integrity-test-');
    const file = path.join(dir, 'sample.bak');
    fs.writeFileSync(file, 'hello world\n');
    const correctSha = computeSha256('hello world\n');

    const okRes = verifyBackupIntegrity(file, correctSha);
    assert.equal(okRes.ok, true);
    assert.equal(okRes.size, 12);

    const badShaRes = verifyBackupIntegrity(file, '1111111111111111111111111111111111111111111111111111111111111111');
    assert.equal(badShaRes.ok, false);
    assert.match(badShaRes.error, /SHA-256 mismatch/);

    const missingRes = verifyBackupIntegrity(path.join(dir, 'missing.bak'), correctSha);
    assert.equal(missingRes.ok, false);
    assert.match(missingRes.error, /does not exist/);
  });

  test('acquireProcessLock, verifyLockOwnership, and releaseProcessLock lifecycle', () => {
    const fakeRepo = createTempDir('lock-repo-');
    const storageRes = resolveStorageDirectory({
      repoRoot: fakeRepo,
      customOverride: path.join(createTempDir('lock-store-'), 'store'),
    });

    // 1. Acquire lock
    const lockRes = acquireProcessLock(fakeRepo, {
      lockDir: storageRes.locksDir,
      operation: 'apply',
    });
    assert.equal(lockRes.ok, true);
    assert.equal(fs.existsSync(lockRes.lockPath), true);
    assert.equal(lockRes.pid, process.pid);
    assert.ok(lockRes.nonce);
    assert.ok(lockRes.dev);
    assert.ok(lockRes.ino);

    // Verify lock permissions: mode 0600
    const stat = fs.lstatSync(lockRes.lockPath);
    assert.equal(stat.mode & 0o077, 0, 'Lock file must have mode 0600');

    // 2. Second concurrent acquisition must fail closed
    const secondLockRes = acquireProcessLock(fakeRepo, {
      lockDir: storageRes.locksDir,
      operation: 'apply',
    });
    assert.equal(secondLockRes.ok, false);
    assert.match(secondLockRes.error, /already held/);
    assert.equal(secondLockRes.existingLock?.pid, process.pid);

    // 3. Verify lock ownership
    const verifyRes = verifyLockOwnership(lockRes);
    assert.equal(verifyRes.ok, true);

    // 4. Release lock
    const releaseRes = releaseProcessLock(lockRes);
    assert.equal(releaseRes.ok, true);
    assert.equal(fs.existsSync(lockRes.lockPath), false, 'Lock file must be unlinked after release');

    // 5. Subsequent acquisition succeeds after release
    const reacquireRes = acquireProcessLock(fakeRepo, {
      lockDir: storageRes.locksDir,
      operation: 'apply',
    });
    assert.equal(reacquireRes.ok, true);
    releaseProcessLock(reacquireRes);
  });

  test('releaseProcessLock refuses if lock was replaced or inode changed', () => {
    const fakeRepo = createTempDir('inode-repo-');
    const storageRes = resolveStorageDirectory({
      repoRoot: fakeRepo,
      customOverride: path.join(createTempDir('inode-store-'), 'store'),
    });

    const lockRes = acquireProcessLock(fakeRepo, {
      lockDir: storageRes.locksDir,
      operation: 'apply',
    });
    assert.equal(lockRes.ok, true);

    // Replace lock file with a foreign lock file (different inode and different nonce)
    fs.unlinkSync(lockRes.lockPath);
    fs.writeFileSync(
      lockRes.lockPath,
      JSON.stringify({ pid: process.pid, nonce: 'foreign-nonce', repoHash: lockRes.repoHash }),
      { mode: 0o600 }
    );

    // Attempting release must fail closed and refuse deletion
    const releaseRes = releaseProcessLock(lockRes);
    assert.equal(releaseRes.ok, false);
    assert.match(releaseRes.error, /Lock release refused/);
    assert.equal(fs.existsSync(lockRes.lockPath), true, 'Foreign lock file must be preserved');

    // Cleanup foreign lock manually
    fs.unlinkSync(lockRes.lockPath);
  });

  test('releaseProcessLock and verifyLockOwnership refuse on process UID mismatch', () => {
    const fakeRepo = createTempDir('uid-mismatch-repo-');
    const storageRes = resolveStorageDirectory({
      repoRoot: fakeRepo,
      customOverride: path.join(createTempDir('uid-store-'), 'store'),
    });

    const lockRes = acquireProcessLock(fakeRepo, {
      lockDir: storageRes.locksDir,
      operation: 'apply',
    });
    assert.equal(lockRes.ok, true);

    // Tamper handle UID to simulate different user
    const tamperedHandle = { ...lockRes, uid: (lockRes.uid || 0) + 99999 };
    const verifyRes = verifyLockOwnership(tamperedHandle);
    assert.equal(verifyRes.ok, false);
    assert.match(verifyRes.error, /UID (changed|mismatch)/);

    const releaseRes = releaseProcessLock(tamperedHandle);
    assert.equal(releaseRes.ok, false);
    assert.match(releaseRes.error, /UID (changed|mismatch)/);
    assert.equal(fs.existsSync(lockRes.lockPath), true, 'Lock must be preserved on UID mismatch');

    // Clean up with legitimate handle
    const cleanRes = releaseProcessLock(lockRes);
    assert.equal(cleanRes.ok, true);
  });
});
