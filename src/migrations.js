'use strict';

const fs = require('node:fs');
const path = require('node:path');

function validateMigrations(migrations) {
  let previous = 0;
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version !== previous + 1) {
      throw new Error(`Migrations must be contiguous and ordered; expected version ${previous + 1}`);
    }
    if (!migration.name || typeof migration.up !== 'function') {
      throw new Error(`Migration ${migration.version} must have a name and up() function`);
    }
    previous = migration.version;
  }
}

function atomicWrite(filename, data) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, filename);
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_closeError) {}
    }
    try { fs.unlinkSync(temporary); } catch (_unlinkError) {}
    throw error;
  }
}

function createPreMigrationBackup({ db, dbPath, fromVersion, toVersion }) {
  if (!dbPath || dbPath === ':memory:') return null;
  const filename = `${dbPath}.pre-migration-v${fromVersion}-to-v${toVersion}.bak`;
  if (!fs.existsSync(filename)) atomicWrite(filename, db.serialize());
  return filename;
}

function createMigrationRunner({ db, dbPath, migrations, onState = () => {} }) {
  validateMigrations(migrations);
  const targetVersion = migrations.at(-1)?.version || 0;
  const transactions = new Map(migrations.map(migration => [
    migration.version,
    db.transaction(() => {
      migration.up();
      db.pragma(`user_version = ${migration.version}`);
    }),
  ]));

  return function runMigrations() {
    let version = db.pragma('user_version', { simple: true });
    if (version > targetVersion) {
      const error = new Error(`Database schema version ${version} is newer than supported version ${targetVersion}`);
      error.code = 'SQLITE_MIGRATION_UNSUPPORTED';
      onState({ status: 'failed', version, targetVersion, applied: [], backupPath: null, error: error.message });
      throw error;
    }

    const applied = [];
    let backupPath = null;
    onState({ status: 'running', version, targetVersion, applied, backupPath });
    for (const migration of migrations) {
      if (migration.version <= version) continue;
      try {
        if (migration.needsBackup?.()) {
          backupPath ||= createPreMigrationBackup({
            db,
            dbPath,
            fromVersion: version,
            toVersion: migration.version,
          });
        }
        transactions.get(migration.version)();
        version = migration.version;
        applied.push({ version, name: migration.name });
        onState({ status: 'running', version, targetVersion, applied: [...applied], backupPath });
      } catch (cause) {
        const error = new Error(
          `Database migration ${migration.version} (${migration.name}) failed from version ${version}: ${cause.message}`,
          { cause },
        );
        error.code = 'SQLITE_MIGRATION_FAILED';
        error.migration = { version: migration.version, name: migration.name };
        error.schemaVersion = version;
        error.targetVersion = targetVersion;
        error.backupPath = backupPath;
        onState({ status: 'failed', version, targetVersion, applied: [...applied], backupPath, error: error.message });
        throw error;
      }
    }
    const result = { status: 'ok', version, targetVersion, applied, backupPath };
    onState(result);
    return result;
  };
}

module.exports = {
  validateMigrations,
  createPreMigrationBackup,
  createMigrationRunner,
};
