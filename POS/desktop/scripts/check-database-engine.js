/**
 * Runs the app's own encryption on the machine that builds the installer, inside
 * Electron's Node. A native module built for the wrong Electron shows nothing at build
 * time and only fails on a shop's machine, and this is the only Windows these steps
 * reach before one: renaming over a file behaves differently there.
 *
 * Run with ELECTRON_RUN_AS_NODE=1, from the desktop folder.
 */

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const Database = require("better-sqlite3-multiple-ciphers")
const { STATE, openDatabase, readState } = require("../electron/db/encryption")

const KEY = "ab".repeat(32)
const folder = fs.mkdtempSync(path.join(os.tmpdir(), "pos-engine-"))
const file = path.join(folder, "check.sqlite")

const plain = new Database(file)
plain.pragma("journal_mode = WAL")
plain.exec("CREATE TABLE sale (id INTEGER PRIMARY KEY, name TEXT)")
plain.prepare("INSERT INTO sale (name) VALUES (?)").run("first sale")
plain.close()
assert.equal(readState(file), STATE.PLAIN)

const { db, encrypted } = openDatabase(Database, file, KEY)
assert.equal(encrypted, true)
assert.equal(db.prepare("SELECT name FROM sale").pluck().get(), "first sale")
db.close()
assert.equal(readState(file), STATE.ENCRYPTED)

const reopened = openDatabase(Database, file, KEY)
assert.equal(reopened.db.prepare("SELECT COUNT(*) FROM sale").pluck().get(), 1)
reopened.db.close()

fs.rmSync(folder, { recursive: true, force: true })
console.log(`Encryption works on Electron ${process.versions.electron}, ${process.platform}`)
