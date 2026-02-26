// backend/users.js
const bcrypt = require("bcryptjs");

module.exports = function makeUserRoutes(app, db, { requireSession, requireRole, requirePerm }) {
  // LIST users (owner)
  app.get("/api/users", requireSession, requireRole("owner"), (req, res) => {
    const rows = db.prepare(`
      SELECT u.id, u.username, u.role, u.active, u.created_at,
             COALESCE(p.inv_add,0) AS inv_add,
             COALESCE(p.inv_edit,0) AS inv_edit,
             COALESCE(p.inv_delete,0) AS inv_delete,
             COALESCE(p.cost_change,0) AS cost_change,
             COALESCE(p.category_admin,0) AS category_admin,
             COALESCE(p.user_admin,0) AS user_admin,
             COALESCE(p.checkout,0) AS checkout,
             COALESCE(p.reports,0) AS reports
      FROM users u
      LEFT JOIN permissions p ON p.user_id = u.id
      ORDER BY u.id ASC
    `).all();
    res.json(rows);
  });

  // CREATE user (owner)
  app.post("/api/users", requireSession, requireRole("owner"), (req, res) => {
    const { username, password, role, display_name } = req.body || {};
    if (!username || !password || !role) return res.status(400).json({ error: "Missing fields" });
    if (!["owner", "manager", "clerk", "viewer"].includes(role)) return res.status(400).json({ error: "Invalid role" });
    if (password.length < 8) return res.status(400).json({ error: "Password too short" });

    try {
      const hash = bcrypt.hashSync(password, 10);
      const info = db.prepare(`
        INSERT INTO users (username, pw_hash, role, active, created_at, display_name)
        VALUES (?, ?, ?, 1, datetime('now'), ?)
      `).run(username, hash, role, display_name || null);

      // seed blank permissions row
      db.prepare(`INSERT INTO permissions (user_id) VALUES (?)`).run(info.lastInsertRowid);
      res.json({ ok: true, id: info.lastInsertRowid });
    } catch (e) {
      if (String(e).includes("UNIQUE")) return res.status(409).json({ error: "Username already exists" });
      throw e;
    }
  });

  // UPDATE user (owner) – username / role / password (optional)
  app.put("/api/users/:id", requireSession, requireRole("owner"), (req, res) => {
    const id = Number(req.params.id);
    const { username, role, password, display_name } = req.body || {};
    const user = db.prepare("SELECT id FROM users WHERE id=?").get(id);
    if (!user) return res.status(404).json({ error: "User not found" });

    if (username) db.prepare("UPDATE users SET username=? WHERE id=?").run(username, id);
    if (display_name !== undefined) db.prepare("UPDATE users SET display_name=? WHERE id=?").run(display_name || null, id);
    if (role) {
      if (!["owner","manager","clerk","viewer"].includes(role)) return res.status(400).json({ error: "Invalid role" });
      db.prepare("UPDATE users SET role=? WHERE id=?").run(role, id);
    }
    if (password) {
      if (password.length < 8) return res.status(400).json({ error: "Password too short" });
      const hash = bcrypt.hashSync(password, 10);
      db.prepare("UPDATE users SET pw_hash=? WHERE id=?").run(hash, id);
    }
    res.json({ ok: true });
  });

  // RESET password (owner)
  app.put("/api/users/:id/password", requireSession, requireRole("owner"), (req, res) => {
    const id = Number(req.params.id);
    const { password } = req.body || {};
    if (!password || password.length < 8) return res.status(400).json({ error: "Password too short" });
    const hash = bcrypt.hashSync(password, 10);
    db.prepare("UPDATE users SET pw_hash=? WHERE id=?").run(hash, id);
    res.json({ ok: true });
  });

  // UPDATE permissions (owner)
  app.put("/api/users/:id/permissions", requireSession, requireRole("owner"), (req, res) => {
    const id = Number(req.params.id);
    const keys = ["inv_add","inv_edit","inv_delete","cost_change","category_admin","user_admin","checkout","reports"];
    const body = req.body || {};
    const vals = {};
    for (const k of keys) vals[k] = body[k] ? 1 : 0;

    const exists = db.prepare(`SELECT 1 FROM permissions WHERE user_id=?`).get(id);
    if (exists) {
      db.prepare(`
        UPDATE permissions
        SET inv_add=@inv_add, inv_edit=@inv_edit, inv_delete=@inv_delete, cost_change=@cost_change,
            category_admin=@category_admin, user_admin=@user_admin, checkout=@checkout, reports=@reports
        WHERE user_id=@id
      `).run({ id, ...vals });
    } else {
      db.prepare(`
        INSERT INTO permissions (user_id,inv_add,inv_edit,inv_delete,cost_change,category_admin,user_admin,checkout,reports)
        VALUES (@id,@inv_add,@inv_edit,@inv_delete,@cost_change,@category_admin,@user_admin,@checkout,@reports)
      `).run({ id, ...vals });
    }
    res.json({ ok: true });
  });

  // DELETE user (owner)
  app.delete("/api/users/:id", requireSession, requireRole("owner"), (req, res) => {
    const id = Number(req.params.id);
    db.prepare("DELETE FROM permissions WHERE user_id=?").run(id);
    db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
    db.prepare("DELETE FROM users WHERE id=?").run(id);
    res.json({ ok: true });
  });
};
