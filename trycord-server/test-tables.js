const Database = require('better-sqlite3');
const db = new Database('./server.db');
const stmt = db.prepare("SELECT name FROM sqlite_master WHERE type='table'");
const rows = stmt.all();
console.log('Tables:', rows.map(r => r.name).join(', '));
db.close();