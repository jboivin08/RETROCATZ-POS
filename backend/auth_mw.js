// backend/auth_mw.js
module.exports = function makeAuthMW(db) {
  function loadPerms(userId) {
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

  function getSessionRow(sid) {
    return db.prepare(`
      SELECT s.id AS session_id, u.id, u.username, u.role, u.active, u.display_name
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.id = ?
    `).get(sid);
  }

  function requireSession(req, res, next) {
    const sid = req.headers["rc_session_id"];
    if (!sid) return res.status(401).json({ error: "No session" });
    const row = getSessionRow(sid);
    if (!row || row.active !== 1) return res.status(401).json({ error: "Invalid session" });
    req.user = {
      id: row.id,
      username: row.username,
      role: String(row.role).toLowerCase(),
      session_id: row.session_id,
      display_name: row.display_name || row.username,
      permissions: loadPerms(row.id),
    };
    next();
  }

  function requireRole(...roles) {
    return (req, res, next) => {
      if (!req.user) {
        return requireSession(req, res, () => {
          if (!roles.includes(req.user.role)) return res.status(403).json({ error: "Forbidden" });
          next();
        });
      }
      if (!roles.includes(req.user.role)) return res.status(403).json({ error: "Forbidden" });
      next();
    };
  }

  function requirePerm(key) {
    return (req, res, next) => {
      if (!req.user) {
        return requireSession(req, res, () => {
          const ok = req.user.permissions && req.user.permissions[key];
          if (!ok) return res.status(403).json({ error: "Permission denied" });
          next();
        });
      }
      const ok = req.user.permissions && req.user.permissions[key];
      if (!ok) return res.status(403).json({ error: "Permission denied" });
      next();
    };
  }

  return { requireSession, requireRole, requirePerm };
}
