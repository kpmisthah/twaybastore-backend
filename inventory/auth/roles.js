// inventory/auth/roles.js — which roles may do what (ported from role-groups.ts).

/** Everyone except drivers, who only see their own deliveries. */
export const STAFF_READ = ["ADMIN", "MANAGER", "WAREHOUSE", "CASHIER", "VIEWER"];

export const CATALOG_WRITE = ["ADMIN", "MANAGER"];

export const LABEL_PRINT = ["ADMIN", "MANAGER", "WAREHOUSE"];

/** Drivers included: they scan and move stock between locations too. */
export const LOCATION_READ = [...STAFF_READ, "DRIVER"];

/** Finding and scanning products — every role, since drivers handle stock too. */
export const PRODUCT_READ = LOCATION_READ;

export const LOCATION_WRITE = ["ADMIN", "MANAGER"];

export const STOCK_READ = LOCATION_READ;

/** Add, remove, transfer, mark damaged — the salesman and delivery staff do this too. */
export const STOCK_WRITE = ["ADMIN", "MANAGER", "WAREHOUSE", "CASHIER", "DRIVER"];

/** Stocktake-style corrections. */
export const STOCK_ADJUST = ["ADMIN", "MANAGER"];

/** Selling at the counter. */
export const POS = ["ADMIN", "MANAGER", "CASHIER"];

export const SALES_READ = ["ADMIN", "MANAGER", "CASHIER", "VIEWER"];

/** Everyone can see orders (drivers and warehouse staff pick them). */
export const ORDER_READ = LOCATION_READ;

/** Create, edit, allocate, assign drivers and cancel orders. */
export const ORDER_WRITE = ["ADMIN", "MANAGER"];

/** Mark out for delivery / delivered / failed, report problems (drivers: own orders only). */
export const DELIVERY = ["ADMIN", "MANAGER", "DRIVER"];

/** Reports and the audit trail (Viewer = read-only access to stock, orders, reports, audit history). */
export const REPORTS_READ = ["ADMIN", "MANAGER", "VIEWER"];
export const AUDIT_READ = REPORTS_READ;

/** Dashboard figures. Drivers use their deliveries list instead. */
export const DASHBOARD = ["ADMIN", "MANAGER", "WAREHOUSE", "CASHIER", "VIEWER"];

/** Roles that can approve overrides (big discounts, wrong pick location, missing boxes). */
export const APPROVER_ROLES = ["ADMIN", "MANAGER"];

/** Roles a Manager may create and edit. Admins can manage every role. */
const MANAGER_MANAGEABLE = ["WAREHOUSE", "CASHIER", "DRIVER", "VIEWER"];

export function canManageRole(actorRole, targetRole) {
  if (actorRole === "ADMIN") return true;
  if (actorRole === "MANAGER") return MANAGER_MANAGEABLE.includes(targetRole);
  return false;
}
