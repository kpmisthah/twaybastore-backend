// inventory/services/audit.js — append-only audit trail.
import AuditLog from "../models/AuditLog.js";

/**
 * Records who did what. Pass `session` to write inside an existing transaction.
 * entry: { userId, action, entity, entityId, data }
 */
export async function audit(entry, session) {
  const data = entry.data === undefined ? undefined : JSON.parse(JSON.stringify(entry.data));
  await AuditLog.create(
    [
      {
        userId: entry.userId ?? null,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId != null ? String(entry.entityId) : null,
        data,
        searchText: data === undefined ? "" : JSON.stringify(data),
      },
    ],
    { session }
  );
}
