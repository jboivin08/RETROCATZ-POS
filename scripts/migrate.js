// scripts/migrate.js
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const dbPath = path.join(__dirname, "..", "inventory.db");
const sqlPath = path.join(__dirname, "..", "db", "schema.sql");

const db = new Database(dbPath);
const sql = fs.readFileSync(sqlPath, "utf8");
db.exec(sql);

console.log("Schema applied or updated successfully");
