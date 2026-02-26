// backend/users.js
const bcrypt = require("bcryptjs");

module.exports = function makeUserRoutes(app, db, { requireSession, requireRole, requirePerm }) {
  const VALID_ROLES = ["owner", "manager", "clerk", "viewer"];
  const PERM_KEYS = ["inv_add", "inv_edit", "inv_delete", "cost_change", "category_admin", "user_admin", "checkout", "reports"];

  function normalizeUsername(v) {
    return String(v || "").trim();
  }
  function normalizeDisplayName(v) {
    return String(v || "").trim();
  }
  function toFlag(v, fallback = 1) {
    if (v === undefined || v === null) return fallback;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "number") return v ? 1 : 0;
    const s = String(v).toLowerCase().trim();
    return (s === "1" || s === "true" || s === "yes") ? 1 : 0;
  }

  function getUserById(id) {
    return db.prepare("SELECT id, username, role, active FROM users WHERE id=?").get(id);
  }

  function ownerCount() {
    return db.prepare("SELECT COUNT(*) AS c FROM users WHERE role='owner'").get().c || 0;
  }

  function ensureUserExists(id, res) {
    const u = getUserById(id);
    if (!u) {
      res.status(404).json({ error: "User not found" });
      return null;
    }
    return u;
  }

  function asCanonicalRole(v) {
    const role = String(v || "").toLowerCase().trim();
    return role === "admin" ? "owner" : role;
  }

  function canManageUsers(req) {
    if (!req.user) return false;
    const role = asCanonicalRole(req.user.role);
    if (role === "owner") return true;
    return role === "manager" && !!(req.user.permissions && req.user.permissions.user_admin);
  }

  function requireUserAdminAccess(req, res, next) {
    requireSession(req, res, () => {
      if (!canManageUsers(req)) return res.status(403).json({ error: "User admin permission required" });
      next();
    });
  }

  // Managers can only manage non-privileged roles.
  function managerCanTouchRole(role) {
    return role === "clerk" || role === "viewer";
  }

  function defaultPermsForRole(role) {
    if (role === "owner") {
      return {
        inv_add: 1, inv_edit: 1, inv_delete: 1, cost_change: 1,
        category_admin: 1, user_admin: 1, checkout: 1, reports: 1
      };
    }
    if (role === "manager") {
      return {
        inv_add: 1, inv_edit: 1, inv_delete: 0, cost_change: 1,
        category_admin: 1, user_admin: 1, checkout: 1, reports: 1
      };
    }
    if (role === "clerk") {
      return {
        inv_add: 1, inv_edit: 1, inv_delete: 0, cost_change: 0,
        category_admin: 0, user_admin: 0, checkout: 1, reports: 1
      };
    }
    return {
      inv_add: 0, inv_edit: 0, inv_delete: 0, cost_change: 0,
      category_admin: 0, user_admin: 0, checkout: 0, reports: 1
    };
  }

  // LIST users (owner)
  app.get("/api/users", requireUserAdminAccess, (req, res) => {
    const rows = db.prepare(`
      SELECT u.id, u.username, u.display_name, lower(u.role) as role, u.active, u.created_at,
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
  app.post("/api/users", requireUserAdminAccess, (req, res) => {
    const { username, password, role, display_name, active } = req.body || {};
    const uname = normalizeUsername(username);
    const dname = normalizeDisplayName(display_name);
    const normalizedRole = asCanonicalRole(role);
    const activeFlag = toFlag(active, 1);

    if (!uname || !password || !normalizedRole) {
      return res.status(400).json({ error: "Missing fields" });
    }
    if (!VALID_ROLES.includes(normalizedRole)) {
      return res.status(400).json({ error: "Invalid role" });
    }
    if (asCanonicalRole(req.user.role) === "manager" && !managerCanTouchRole(normalizedRole)) {
      return res.status(403).json({ error: "Managers can only create clerk/viewer users" });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "Password too short" });
    }

    try {
      const hash = bcrypt.hashSync(password, 10);
      const info = db.prepare(`
        INSERT INTO users (username, pw_hash, role, active, created_at, display_name)
        VALUES (?, ?, ?, ?, datetime('now'), ?)
      `).run(uname, hash, normalizedRole, activeFlag, dname || null);

      const p = defaultPermsForRole(normalizedRole);
      db.prepare(`
        INSERT INTO permissions (user_id,inv_add,inv_edit,inv_delete,cost_change,category_admin,user_admin,checkout,reports)
        VALUES (@id,@inv_add,@inv_edit,@inv_delete,@cost_change,@category_admin,@user_admin,@checkout,@reports)
      `).run({ id: info.lastInsertRowid, ...p });

      res.json({ ok: true, id: info.lastInsertRowid });
    } catch (e) {
      if (String(e).includes("UNIQUE")) {
        return res.status(409).json({ error: "Username already exists" });
      }
      throw e;
    }
  });

  // UPDATE user (owner): username / role / password (optional)
  app.put("/api/users/:id", requireUserAdminAccess, (req, res) => {
    const id = Number(req.params.id);
    const { username, role, password, display_name, active } = req.body || {};
    const target = ensureUserExists(id, res);
    if (!target) return;

    const uname = normalizeUsername(username);
    const dname = normalizeDisplayName(display_name);
    const normalizedRole = role ? asCanonicalRole(role) : "";
    const targetRole = asCanonicalRole(target.role);
    const actorRole = asCanonicalRole(req.user && req.user.role);

    if (actorRole === "manager" && !managerCanTouchRole(targetRole)) {
      return res.status(403).json({ error: "Managers can only edit clerk/viewer users" });
    }

    if (uname) {
      try {
        db.prepare("UPDATE users SET username=? WHERE id=?").run(uname, id);
      } catch (e) {
        if (String(e).includes("UNIQUE")) {
          return res.status(409).json({ error: "Username already exists" });
        }
        throw e;
      }
    }

    if (display_name !== undefined) {
      db.prepare("UPDATE users SET display_name=? WHERE id=?").run(dname || null, id);
    }

    if (active !== undefined) {
      const nextActive = toFlag(active, target.active ? 1 : 0);
      if (target.role === "owner" && nextActive === 0 && ownerCount() <= 1) {
        return res.status(400).json({ error: "Cannot deactivate the last owner" });
      }
      if (req.user && Number(req.user.id) === id && target.role === "owner" && nextActive === 0) {
        return res.status(400).json({ error: "Owner cannot deactivate self" });
      }
      db.prepare("UPDATE users SET active=? WHERE id=?").run(nextActive, id);
    }

    if (normalizedRole) {
      if (!VALID_ROLES.includes(normalizedRole)) {
        return res.status(400).json({ error: "Invalid role" });
      }
      if (actorRole === "manager" && !managerCanTouchRole(normalizedRole)) {
        return res.status(403).json({ error: "Managers can only assign clerk/viewer roles" });
      }
      if (targetRole === "owner" && normalizedRole !== "owner" && ownerCount() <= 1) {
        return res.status(400).json({ error: "Cannot demote the last owner" });
      }
      if (req.user && Number(req.user.id) === id && targetRole === "owner" && normalizedRole !== "owner") {
        return res.status(400).json({ error: "Owner cannot demote self" });
      }

      db.prepare("UPDATE users SET role=? WHERE id=?").run(normalizedRole, id);

      if (normalizedRole === "owner") {
        db.prepare(`
          INSERT INTO permissions (user_id,inv_add,inv_edit,inv_delete,cost_change,category_admin,user_admin,checkout,reports)
          VALUES (@id,1,1,1,1,1,1,1,1)
          ON CONFLICT(user_id) DO UPDATE SET
            inv_add=1, inv_edit=1, inv_delete=1, cost_change=1,
            category_admin=1, user_admin=1, checkout=1, reports=1
        `).run({ id });
      }
    }

    if (password) {
      if (password.length < 8) {
        return res.status(400).json({ error: "Password too short" });
      }
      const hash = bcrypt.hashSync(password, 10);
      db.prepare("UPDATE users SET pw_hash=? WHERE id=?").run(hash, id);
    }

    res.json({ ok: true });
  });

  // UPDATE active status (owner)
  app.put("/api/users/:id/active", requireUserAdminAccess, (req, res) => {
    const id = Number(req.params.id);
    const target = ensureUserExists(id, res);
    if (!target) return;

    const targetRole = asCanonicalRole(target.role);
    const actorRole = asCanonicalRole(req.user && req.user.role);
    if (actorRole === "manager" && !managerCanTouchRole(targetRole)) {
      return res.status(403).json({ error: "Managers can only activate/deactivate clerk/viewer users" });
    }

    const nextActive = toFlag(req.body ? req.body.active : undefined, target.active ? 1 : 0);
    if (targetRole === "owner" && nextActive === 0 && ownerCount() <= 1) {
      return res.status(400).json({ error: "Cannot deactivate the last owner" });
    }
    if (req.user && Number(req.user.id) === id && targetRole === "owner" && nextActive === 0) {
      return res.status(400).json({ error: "Owner cannot deactivate self" });
    }

    db.prepare("UPDATE users SET active=? WHERE id=?").run(nextActive, id);
    res.json({ ok: true });
  });

  // RESET password (owner)
  app.put("/api/users/:id/password", requireUserAdminAccess, (req, res) => {
    const id = Number(req.params.id);
    const target = ensureUserExists(id, res);
    if (!target) return;
    const targetRole = asCanonicalRole(target.role);
    const actorRole = asCanonicalRole(req.user && req.user.role);
    if (actorRole === "manager" && !managerCanTouchRole(targetRole)) {
      return res.status(403).json({ error: "Managers can only reset password for clerk/viewer users" });
    }

    const { password } = req.body || {};
    if (!password || password.length < 8) {
      return res.status(400).json({ error: "Password too short" });
    }

    const hash = bcrypt.hashSync(password, 10);
    db.prepare("UPDATE users SET pw_hash=? WHERE id=?").run(hash, id);
    res.json({ ok: true });
  });

  // UPDATE permissions (owner)
  app.put("/api/users/:id/permissions", requireUserAdminAccess, (req, res) => {
    const id = Number(req.params.id);
    const target = ensureUserExists(id, res);
    if (!target) return;
    const targetRole = asCanonicalRole(target.role);
    const actorRole = asCanonicalRole(req.user && req.user.role);
    if (actorRole === "manager" && !managerCanTouchRole(targetRole)) {
      return res.status(403).json({ error: "Managers can only edit permissions for clerk/viewer users" });
    }

    const body = req.body || {};
    const vals = {};
    for (const k of PERM_KEYS) vals[k] = body[k] ? 1 : 0;

    // Owner account always keeps full permissions.
    if (targetRole === "owner") {
      for (const k of PERM_KEYS) vals[k] = 1;
    }

    const exists = db.prepare("SELECT 1 FROM permissions WHERE user_id=?").get(id);
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
  app.delete("/api/users/:id", requireUserAdminAccess, (req, res) => {
    const id = Number(req.params.id);
    const target = ensureUserExists(id, res);
    if (!target) return;
    const targetRole = asCanonicalRole(target.role);
    const actorRole = asCanonicalRole(req.user && req.user.role);
    if (actorRole === "manager" && !managerCanTouchRole(targetRole)) {
      return res.status(403).json({ error: "Managers can only delete clerk/viewer users" });
    }

    if (req.user && Number(req.user.id) === id) {
      return res.status(400).json({ error: "Cannot delete currently signed-in owner" });
    }
    if (targetRole === "owner" && ownerCount() <= 1) {
      return res.status(400).json({ error: "Cannot delete the last owner" });
    }

    db.prepare("DELETE FROM permissions WHERE user_id=?").run(id);
    db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
    db.prepare("DELETE FROM users WHERE id=?").run(id);
    res.json({ ok: true });
  });
};
