// db/engine.js — pure JS (no native modules)
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

async function init(app) {
  const dbPath = path.join(app.getPath('userData'), 'retrocats-pos.sqlite');
  const SQL = await initSqlJs();         // loads wasm bundled by sql.js
  let db;

  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
    // first run: create schema
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    db.run(schema);
    persist(db, dbPath);
  }

  // helper to persist to disk whenever you make changes
  function persist(database = db, file = dbPath) {
    const data = Buffer.from(database.export());
    fs.writeFileSync(file, data);
  }

  // simple wrapper APIs you can call from main.js or IPC handlers
  return {
    run(sql, params = []) {
      const stmt = db.prepare(sql);
      stmt.bind(params);
      stmt.step();
      stmt.free();
      persist();
    },
    all(sql, params = []) {
      const stmt = db.prepare(sql);
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    },
    persist: () => persist(),
    file: dbPath
  };
}

module.exports = { init };
