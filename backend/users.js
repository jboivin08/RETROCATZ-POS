// backend/users.js
const bcrypt = require("bcryptjs");

module.exports = function makeUserRoutes(app, db, { requireSession, requireRole, requirePerm, logUserAction = () => {} }) {
  const VALID_ROLES = ["owner", "manager", "clerk", "viewer"];
  const PERM_KEYS = [
    "inv_add", "inv_edit", "inv_delete", "cost_change",
    "category_admin", "user_admin", "checkout", "reports",
    "discount_override", "void_refund", "settings_admin",
    "closeout_admin", "tax_admin", "sync_admin", "store_credit",
    "trade_override"
  ];
  const PERM_SELECT_SQL = PERM_KEYS.map((k) => `COALESCE(p.${k},0) AS ${k}`).join(",\n             ");
  const PERM_INSERT_COLUMNS = ["user_id", ...PERM_KEYS].join(",");
  const PERM_INSERT_VALUES = ["@id", ...PERM_KEYS.map((k) => `@${k}`)].join(",");
  const PERM_UPDATE_SET = PERM_KEYS.map((k) => `${k}=@${k}`).join(", ");
  const PERM_OWNER_UPDATE_SET = PERM_KEYS.map((k) => `${k}=1`).join(", ");

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
  function normalizePin(v) {
    return String(v || "").trim();
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

  function audit(req, action, metadata = {}) {
    try {
      logUserAction({
        userId: String(req.user?.id || ""),
        username: req.user?.username || "",
        action,
        screen: "users",
        metadata
      });
    } catch {}
  }

  // Managers can only manage non-privileged roles.
  function managerCanTouchRole(role) {
    return role === "clerk" || role === "viewer";
  }

  function defaultPermsForRole(role) {
    if (role === "owner") {
      return {
        inv_add: 1, inv_edit: 1, inv_delete: 1, cost_change: 1,
        category_admin: 1, user_admin: 1, checkout: 1, reports: 1,
        discount_override: 1, void_refund: 1, settings_admin: 1,
        closeout_admin: 1, tax_admin: 1, sync_admin: 1, store_credit: 1,
        trade_override: 1
      };
    }
    if (role === "manager") {
      return {
        inv_add: 1, inv_edit: 1, inv_delete: 0, cost_change: 1,
        category_admin: 1, user_admin: 1, checkout: 1, reports: 1,
        discount_override: 1, void_refund: 1, settings_admin: 1,
        closeout_admin: 1, tax_admin: 1, sync_admin: 1, store_credit: 1,
        trade_override: 1
      };
    }
    if (role === "clerk") {
      return {
        inv_add: 1, inv_edit: 1, inv_delete: 0, cost_change: 0,
        category_admin: 0, user_admin: 0, checkout: 1, reports: 1,
        discount_override: 0, void_refund: 0, settings_admin: 0,
        closeout_admin: 0, tax_admin: 0, sync_admin: 0, store_credit: 0,
        trade_override: 0
      };
    }
    return {
      inv_add: 0, inv_edit: 0, inv_delete: 0, cost_change: 0,
      category_admin: 0, user_admin: 0, checkout: 0, reports: 1,
      discount_override: 0, void_refund: 0, settings_admin: 0,
      closeout_admin: 0, tax_admin: 0, sync_admin: 0, store_credit: 0,
      trade_override: 0
    };
  }

  // LIST users (owner)
  app.get("/api/users", requireUserAdminAccess, (req, res) => {
    const rows = db.prepare(`
      SELECT u.id, u.username, u.display_name, lower(u.role) as role, u.active, u.created_at,
             CASE WHEN COALESCE(u.pin_hash,'') <> '' THEN 1 ELSE 0 END AS has_pin,
             ${PERM_SELECT_SQL}
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
    const pin = normalizePin(req.body && req.body.pin);

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
    if (pin && !/^[0-9]{4,12}$/.test(pin)) {
      return res.status(400).json({ error: "PIN must be 4 to 12 digits" });
    }

    try {
      const hash = bcrypt.hashSync(password, 10);
      const pinHash = pin ? bcrypt.hashSync(pin, 10) : null;
      const info = db.prepare(`
        INSERT INTO users (username, pw_hash, role, active, created_at, display_name, pin_hash)
        VALUES (?, ?, ?, ?, datetime('now'), ?, ?)
      `).run(uname, hash, normalizedRole, activeFlag, dname || null, pinHash);

      const p = defaultPermsForRole(normalizedRole);
      db.prepare(`
        INSERT INTO permissions (${PERM_INSERT_COLUMNS})
        VALUES (${PERM_INSERT_VALUES})
      `).run({ id: info.lastInsertRowid, ...p });

      audit(req, "user_created", { targetUserId: info.lastInsertRowid, username: uname, role: normalizedRole, active: activeFlag, hasPin: !!pinHash });
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
          INSERT INTO permissions (${PERM_INSERT_COLUMNS})
          VALUES (@id,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1)
          ON CONFLICT(user_id) DO UPDATE SET
            ${PERM_OWNER_UPDATE_SET}
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

    audit(req, "user_updated", { targetUserId: id, username: uname || target.username, role: normalizedRole || targetRole });
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
    audit(req, nextActive ? "user_enabled" : "user_disabled", { targetUserId: id, username: target.username, role: targetRole });
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
    audit(req, "user_password_reset", { targetUserId: id, username: target.username, role: targetRole });
    res.json({ ok: true });
  });

  // RESET manager/owner approval PIN
  app.put("/api/users/:id/pin", requireUserAdminAccess, (req, res) => {
    const id = Number(req.params.id);
    const target = ensureUserExists(id, res);
    if (!target) return;
    const targetRole = asCanonicalRole(target.role);
    const actorRole = asCanonicalRole(req.user && req.user.role);
    if (actorRole === "manager" && !managerCanTouchRole(targetRole)) {
      return res.status(403).json({ error: "Managers can only reset PINs for clerk/viewer users" });
    }

    const pin = normalizePin(req.body && req.body.pin);
    if (!/^[0-9]{4,12}$/.test(pin)) {
      return res.status(400).json({ error: "PIN must be 4 to 12 digits" });
    }

    const hash = bcrypt.hashSync(pin, 10);
    db.prepare("UPDATE users SET pin_hash=? WHERE id=?").run(hash, id);
    audit(req, "user_pin_reset", { targetUserId: id, username: target.username, role: targetRole });
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
        SET ${PERM_UPDATE_SET}
        WHERE user_id=@id
      `).run({ id, ...vals });
    } else {
      db.prepare(`
        INSERT INTO permissions (${PERM_INSERT_COLUMNS})
        VALUES (${PERM_INSERT_VALUES})
      `).run({ id, ...vals });
    }

    audit(req, "user_permissions_updated", { targetUserId: id, username: target.username, role: targetRole, permissions: vals });
    res.json({ ok: true });
  });

  app.get("/api/user-activity", requireUserAdminAccess, (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit || 100)));
    const userId = String(req.query.user_id || "").trim();
    const action = String(req.query.action || "").trim();
    const where = [];
    const params = {};
    if (userId) {
      where.push("(userId = @userId OR metadata LIKE @targetUserIdNumber OR metadata LIKE @targetUserIdString)");
      params.userId = userId;
      params.targetUserIdNumber = `%"targetUserId":${Number(userId)}%`;
      params.targetUserIdString = `%"targetUserId":"${userId}"%`;
    }
    if (action) {
      where.push("action = @action");
      params.action = action;
    }
    params.limit = limit;
    const rows = db.prepare(`
      SELECT id, userId, username, action, screen, metadata, createdAt
      FROM user_activity
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY datetime(createdAt) DESC, rowid DESC
      LIMIT @limit
    `).all(params);
    res.json({ ok: true, rows });
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
    audit(req, "user_deleted", { targetUserId: id, username: target.username, role: targetRole });
    res.json({ ok: true });
  });
};
