// backend/auth.js
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");

// small helper: does a table have a given column?
function hasColumn(db, table, column) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    return Array.isArray(cols) && cols.some(c => c.name === column);
  } catch {
    return false;
  }
}

function getPerms(db, userId) {
  const p = db.prepare(`
    SELECT inv_add, inv_edit, inv_delete, cost_change,
           category_admin, user_admin, checkout, reports
    FROM permissions WHERE user_id = ?
  `).get(userId);
  return p || {
    inv_add: 0, inv_edit: 0, inv_delete: 0, cost_change: 0,
    category_admin: 0, user_admin: 0, checkout: 0, reports: 0
  };
}

module.exports = function makeAuthRoutes(app, db) {
  // detect once at startup
  const DISPLAY_NAME_EXISTS = hasColumn(db, "users", "display_name");

  app.post("/api/login", (req, res) => {
    const { username, password } = (req.body || {});
    if (!username || !password) return res.status(400).json({ error: "Missing credentials" });

    const user = db
      .prepare("SELECT * FROM users WHERE username = ? AND active = 1")
      .get(username);

    if (!user) return res.status(401).json({ error: "Invalid username or password" });

    const ok = bcrypt.compareSync(password, user.pw_hash);
    if (!ok) return res.status(401).json({ error: "Invalid username or password" });

    const sid = uuidv4();
    db.prepare("INSERT INTO sessions (id, user_id) VALUES (?, ?)").run(sid, user.id);

    const permissions = getPerms(db, user.id);

    res.json({
      session_id: sid,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        // if the column doesn't exist, user.display_name will be undefined; we fall back to username
        display_name: (DISPLAY_NAME_EXISTS && user.display_name) ? user.display_name : user.username,
        permissions
      }
    });
  });

  app.post("/api/logout", (req, res) => {
    const { session_id } = (req.body || {});
    if (session_id) db.prepare("DELETE FROM sessions WHERE id = ?").run(session_id);
    res.json({ ok: true });
  });

  app.get("/api/me", (req, res) => {
    const sid = req.headers["rc_session_id"];
    if (!sid) return res.status(401).json({ error: "No session" });

    // build SELECT dynamically based on whether display_name exists
    const meSelect = `
      SELECT
        s.id AS session_id,
        u.id,
        u.username,
        u.role,
        u.active
        ${DISPLAY_NAME_EXISTS ? ", u.display_name" : ""}
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.id = ?
    `;

    const row = db.prepare(meSelect).get(sid);
    if (!row || row.active !== 1) return res.status(401).json({ error: "Invalid session" });

    // optional: this column may or may not exist in your schema; remove if you don't track it
    try {
      db.prepare("UPDATE sessions SET last_seen_at = datetime('now') WHERE id = ?").run(sid);
    } catch (_) {
      // ignore if last_seen_at isn't a column in your sessions table
    }

    const permissions = getPerms(db, row.id);

    res.json({
      session_id: row.session_id,
      user: {
        id: row.id,
        username: row.username,
        role: row.role,
        display_name: DISPLAY_NAME_EXISTS && row.display_name ? row.display_name : row.username,
        permissions
      }
    });
  });
};
