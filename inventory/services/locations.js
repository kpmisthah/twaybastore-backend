// inventory/services/locations.js — the location tree (sites, floors, rooms, shelves, spaces).
import { locationCode } from "../lib/codes.js";
import { nextCounter, withTransaction } from "../lib/db.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/http.js";
import Location from "../models/Location.js";
import { Order } from "../models/Order.js";
import { CreditNote, Sale } from "../models/Sale.js";
import { StockLevel, StockMovement } from "../models/Stock.js";
import { Stocktake, StocktakeLine, Transfer } from "../models/Transfer.js";
import User from "../models/User.js";
import cloudinary from "../../utils/cloudinaryClient.js";
import { audit } from "./audit.js";
import {
  buildPaths,
  CHILD_TYPES,
  PATH_SEPARATOR,
  sortSiblings,
  SYSTEM_TYPES,
  TYPE_LABELS,
  withDescendants,
} from "./locationTree.js";

const plain = (l) => ({
  id: String(l._id),
  type: l.type,
  name: l.name,
  code: l.code,
  parentId: l.parentId ? String(l.parentId) : null,
  sortOrder: l.sortOrder,
  active: l.active,
  imageUrl: l.imageUrl ?? null,
  createdAt: l.createdAt,
  updatedAt: l.updatedAt,
});

/**
 * All locations with `path` ("Hamrun Shop › Top › Room 1"), `pathNames` and `siteId` (the top-level
 * location it belongs to — itself for a site or system location). The whole collection is loaded:
 * even a large warehouse has only a few thousand.
 */
export async function withPaths(session) {
  const rows = (await Location.find().session(session ?? null).lean()).map(plain);
  const paths = buildPaths(rows);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const rootOf = (r) => {
    let cur = r;
    for (let i = 0; i < 50 && cur.parentId && byId.has(cur.parentId); i++) cur = byId.get(cur.parentId);
    return cur.id;
  };
  return rows.map((r) => {
    const pathNames = paths.get(r.id);
    return { ...r, pathNames, path: pathNames.join(PATH_SEPARATOR), siteId: rootOf(r) };
  });
}

/** Every location with its full path, in tree order (parents before children). */
export async function listLocations(includeInactive) {
  const all = await withPaths();
  const roots = sortSiblings(all.filter((l) => !l.parentId)).map((l) => l.id);
  const ordered = withDescendants(all, roots);
  // A hidden location never has visible children (update enforces it), so this hides whole branches.
  return includeInactive ? ordered : ordered.filter((l) => l.active);
}

export async function getLocation(id) {
  const all = await withPaths();
  const location = all.find((l) => l.id === id);
  if (!location) throw notFound("Location not found");
  const children = sortSiblings(all.filter((l) => l.parentId === id));
  return { ...location, children };
}

/** Finds a location by the code on its label (what a scanner types). */
export async function lookupLocation(code) {
  const location = await Location.findOne({ code: code.trim().toUpperCase() }).lean();
  if (!location) throw notFound(`No location has the code "${code.trim()}"`);
  return getLocation(String(location._id));
}

/** Removes a photo from Cloudinary (best effort — a failure must never block the location change). */
async function removeImages(urls) {
  for (const url of urls.filter(Boolean)) {
    const match = url.match(/\/image\/upload\/(?:v\d+\/)?(twayba\/inventory\/locations\/[^/.]+)/);
    if (!match) continue;
    try {
      await cloudinary.uploader.destroy(match[1]);
    } catch (err) {
      console.warn("Could not delete location photo from Cloudinary:", err?.message);
    }
  }
}

/** Creates one or more siblings at once, e.g. spaces A1…A6 on a shelf. */
export async function createLocations(userId, dto) {
  const names = dto.names.map((n) => n.trim()).filter(Boolean);
  if (!names.length) throw badRequest("Enter at least one name");
  const lower = names.map((n) => n.toLowerCase());
  const dupe = names.find((_, i) => lower.indexOf(lower[i]) !== i);
  if (dupe) throw badRequest(`"${dupe}" is entered more than once`);

  const parent = dto.parentId ? await Location.findById(dto.parentId).lean() : null;
  if (dto.parentId && !parent) throw notFound("Parent location not found");
  if (parent && !parent.active) throw badRequest(`"${parent.name}" is hidden — show it first`);

  const allowed = CHILD_TYPES[parent?.type ?? "ROOT"];
  if (!allowed.includes(dto.type)) {
    throw badRequest(
      parent
        ? `A ${TYPE_LABELS[dto.type]} can't go inside a ${TYPE_LABELS[parent.type]}` +
            (allowed.length ? ` (add a ${allowed.map((t) => TYPE_LABELS[t]).join(" or ")})` : "")
        : "Only sites can be added at the top level"
    );
  }

  if (parent && (await holdsStock(parent._id))) {
    throw badRequest(`"${parent.name}" holds stock — move it out first, then add a ${TYPE_LABELS[dto.type]} inside`);
  }

  const siblings = await Location.find({ parentId: parent?._id ?? null }).lean();
  const clash = siblings.find((s) => lower.includes(s.name.toLowerCase()));
  if (clash) {
    throw conflict(
      `"${clash.name}" already exists ${parent ? `in ${parent.name}` : "as a site"}` + (clash.active ? "" : " (hidden)")
    );
  }

  const startOrder = siblings.reduce((max, s) => Math.max(max, s.sortOrder), -1) + 1;
  const created = await withTransaction(async (session) => {
    const ids = [];
    for (const [i, name] of names.entries()) {
      const code = locationCode(await nextCounter("location", session));
      const [row] = await Location.create(
        [
          {
            type: dto.type,
            name,
            code,
            parentId: parent?._id ?? null,
            sortOrder: startOrder + i,
            imageUrl: names.length === 1 ? (dto.imageUrl ?? null) : null,
          },
        ],
        { session }
      );
      await audit(
        {
          userId,
          action: "LOCATION_CREATED",
          entity: "Location",
          entityId: row._id,
          data: { type: row.type, name, code, parentId: row.parentId ? String(row.parentId) : null },
        },
        session
      );
      ids.push(String(row._id));
    }
    return ids;
  });

  const all = await withPaths();
  return created.map((id) => all.find((l) => l.id === id));
}

export async function updateLocation(userId, id, dto) {
  const before = await Location.findById(id).lean();
  if (!before) throw notFound("Location not found");
  if (SYSTEM_TYPES.includes(before.type)) {
    throw badRequest(`"${before.name}" is a system location and can't be changed`);
  }
  const parent = before.parentId ? await Location.findById(before.parentId).lean() : null;
  const activeChildren = await Location.countDocuments({ parentId: id, active: true });

  const name = dto.name?.trim();
  if (name && name.toLowerCase() !== before.name.toLowerCase()) {
    const siblings = await Location.find({ parentId: before.parentId, _id: { $ne: id } }).lean();
    const clash = siblings.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (clash) throw conflict(`"${clash.name}" already exists here`);
  }

  if (dto.active === false && before.active && activeChildren) {
    throw badRequest(`Hide everything inside "${before.name}" first`);
  }
  if (dto.active === false && before.active && (await holdsStock(id))) {
    throw badRequest(`"${before.name}" still holds stock — move it out first`);
  }
  if (dto.active === true && !before.active && parent && !parent.active) {
    throw badRequest(`"${parent.name}" is hidden — show it first`);
  }

  const data = {};
  if (name) data.name = name;
  if (dto.active !== undefined) data.active = dto.active;
  if (dto.imageUrl !== undefined) data.imageUrl = dto.imageUrl;
  const location = await Location.findByIdAndUpdate(id, data, { new: true }).lean();
  if (dto.imageUrl !== undefined && before.imageUrl && before.imageUrl !== dto.imageUrl) {
    await removeImages([before.imageUrl]);
  }
  await audit({
    userId,
    action: "LOCATION_UPDATED",
    entity: "Location",
    entityId: id,
    data: {
      before: { name: before.name, active: before.active },
      after: { name: location.name, active: location.active },
    },
  });
  return getLocation(id);
}

/**
 * Whether anything ever referred to these locations: stock (even a zero row), ledger entries,
 * transfers, stocktakes, sales, credit notes or orders. Such locations can only be hidden —
 * deleting them would break the history.
 */
async function hasHistory(ids) {
  const inIds = { $in: ids };
  const checks = [
    StockLevel.exists({ locationId: inIds }),
    StockMovement.exists({ $or: [{ fromLocationId: inIds }, { toLocationId: inIds }] }),
    Transfer.exists({ $or: [{ fromLocationId: inIds }, { toLocationId: inIds }] }),
    Stocktake.exists({ locationId: inIds }),
    StocktakeLine.exists({ locationId: inIds }),
    Sale.exists({ $or: [{ siteId: inIds }, { "lines.picks.locationId": inIds }] }),
    CreditNote.exists({ "lines.locationId": inIds }),
    Order.exists({ $or: [{ "allocations.locationId": inIds }, { "exceptions.locationId": inIds }] }),
  ];
  return (await Promise.all(checks)).some(Boolean);
}

/**
 * Permanently deletes a location and everything inside it — only if none of it was ever used.
 * Otherwise the caller should hide it instead (stock history keeps pointing at it).
 */
export async function deleteLocation(userId, id) {
  const all = await withPaths();
  const target = all.find((l) => l.id === id);
  if (!target) throw notFound("Location not found");
  if (SYSTEM_TYPES.includes(target.type)) {
    throw badRequest(`"${target.name}" is a system location and can't be deleted`);
  }
  const doomed = withDescendants(all, [id]);
  const ids = doomed.map((l) => l.id);
  if (await hasHistory(ids)) {
    throw conflict(
      `"${target.name}" has stock history, so it can't be deleted. Hide it instead — it disappears from the list but past records stay correct.`
    );
  }
  await withTransaction(async (session) => {
    await Location.deleteMany({ _id: { $in: ids } }, { session });
    await User.updateMany({ siteIds: { $in: ids } }, { $pull: { siteIds: { $in: ids } } }, { session });
    await audit(
      {
        userId,
        action: "LOCATION_DELETED",
        entity: "Location",
        entityId: id,
        data: { name: target.name, code: target.code, type: target.type, deletedCount: ids.length },
      },
      session
    );
  });
  await removeImages(doomed.map((l) => l.imageUrl));
  return { deleted: ids.length };
}

async function holdsStock(locationId) {
  return !!(await StockLevel.exists({ locationId, onHand: { $gt: 0 } }));
}

/** The In Transit and Damaged system locations are created once, when the API starts. */
export async function ensureSystemLocations() {
  for (const [type, name] of [
    ["TRANSIT", "In Transit"],
    ["DAMAGED", "Damaged"],
  ]) {
    if (await Location.exists({ type })) continue;
    await withTransaction(async (session) => {
      const code = locationCode(await nextCounter("location", session));
      await Location.create([{ type, name, code, sortOrder: type === "TRANSIT" ? 1000 : 1001 }], { session });
    });
  }
}

export async function systemLocationId(type, session) {
  const loc = await Location.findOne({ type }).session(session ?? null).select("_id").lean();
  if (!loc) throw notFound(`The ${type} location is missing — restart the API to create it`);
  return String(loc._id);
}

// --------------------------------------------------------------- site access

/** Admins and managers work everywhere; site limits apply to everyone else who has some. */
export function isLimited(user) {
  return !["ADMIN", "MANAGER"].includes(user.role) && user.siteIds.length > 0;
}

/**
 * "Receive, transfer, count and adjust stock only for permitted locations" (client brief §2).
 * A user with site limits may only touch locations inside those sites. The system locations
 * (In Transit, Damaged) belong to no site and are always allowed — the stock got there from a site.
 */
export async function assertSiteAccess(user, locationIds) {
  if (!isLimited(user)) return;
  const ids = [...new Set(locationIds.filter(Boolean).map(String))];
  if (!ids.length) return;
  const all = new Map((await withPaths()).map((l) => [l.id, l]));
  for (const id of ids) {
    const loc = all.get(id);
    if (!loc || SYSTEM_TYPES.includes(loc.type)) continue;
    if (!user.siteIds.includes(loc.siteId)) {
      throw forbidden(`You can only work with stock at your own site(s) — ${loc.path} is not one of them`);
    }
  }
}
