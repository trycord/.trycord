# Backups and restoration

A backup nobody has restored is a hope. This document says what is backed up,
how to take it, how to check it, and how to put it back.

## What is in a backup

The database. Every table, every row, as SQL: the schema of each table, then
its rows as `INSERT` statements. The file is a plain SQL script, so it can be
read without Trycord.

A backup does **not** contain:

- uploaded files - those live on disk under the upload directory, and a
  database dump without them is a database, not a whole instance;
- secrets - the encrypted credentials in the settings table are in the dump as
  ciphertext, and they are only readable with the instance's own key. A dump
  taken to another host without that key holds rows nobody can use;
- the instance's own configuration file, which belongs to the deployment.

## Taking one

```
cd backend
npm run db:backup
```

The backup goes to `~/trycord-backups` unless `TRYCORD_BACKUP_DIR` says
otherwise, and comes as two files: the SQL itself and a gzipped copy of it. The
gzipped one is the one to move off the host.

The same thing is available from the administration page, under Database, and
returns the same result: the path, the size, the table count and the row count.

### What it refuses

- a target that is not MySQL;
- a database with no tables;
- a table it could not read - the dump says so in the file, and the run fails
  rather than producing a file that is quietly missing a table;
- a file that does not match what the database reported.

### What it verifies

The file is read back after it is written and compared with what the database
said: the number of tables, and the number of rows. A backup that has not been
read back is reported as a failure.

## Checking one

```
cd backend
npm run db:restore ~/trycord-backups/<file>.sql
```

Without `--apply` this only checks. It reports where the dump came from, how
many tables and inserts it holds, and refuses the file outright when it is not
a Trycord dump or when it belongs to a different database.

## Restoring one

```
cd backend
npm run db:restore ~/trycord-backups/<file>.sql --apply
```

This **replaces** the database. It asks for the database name to be typed
before it does anything, and it refuses if the name does not match. Take the
backup first, so a restore cannot be the thing that loses the data.

After a restore the instance needs a restart, because the connection and the
settings it read at boot are both from before.

## Moving an instance

The whole instance is the database plus the uploads plus the configuration.
The database is one command. The uploads are a copy of the upload directory.
The configuration is `backend/.env` and the saved database profile, and those
belong to the deployment rather than to the data.

## What is not automated

Nothing on this host runs a backup on a schedule. An operator who wants one
scheduled owns that decision, and the command is the one above.
