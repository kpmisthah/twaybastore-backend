// inventory/models/AuditLog.js — append only, never updated or deleted.
import { appendOnly, model, ObjectId, Schema } from "./_base.js";

const auditLogSchema = new Schema(
  {
    userId: { type: ObjectId, ref: "InvUser", default: null },
    action: { type: String, required: true },
    entity: { type: String, required: true },
    entityId: { type: String, default: null },
    data: { type: Schema.Types.Mixed, default: undefined },
    /** JSON of `data`, so the audit search box can match text inside the details. */
    searchText: { type: String, default: "" },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

auditLogSchema.index({ entity: 1, entityId: 1 });
auditLogSchema.index({ userId: 1 });
auditLogSchema.index({ createdAt: -1 });
appendOnly(auditLogSchema, "The audit log");

export default model("InvAuditLog", auditLogSchema, "inv_audit_logs");
