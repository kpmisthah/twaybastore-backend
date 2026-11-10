// inventory/services/locationTree.js — pure helpers for the location tree.

/** What may be created directly under each type. `ROOT` = no parent. */
export const CHILD_TYPES = {
  ROOT: ["SITE"],
  SITE: ["FLOOR", "ROOM"],
  FLOOR: ["ROOM"],
  ROOM: ["SHELF"],
  SHELF: ["SPACE"],
  SPACE: [],
  TRANSIT: [],
  DAMAGED: [],
};

export const SYSTEM_TYPES = ["TRANSIT", "DAMAGED"];

export const PATH_SEPARATOR = " › ";

export const TYPE_LABELS = {
  SITE: "site",
  FLOOR: "floor",
  ROOM: "room",
  SHELF: "shelf",
  SPACE: "space",
  TRANSIT: "In Transit",
  DAMAGED: "Damaged",
};

/** Nodes are { id, name, parentId, sortOrder } with string ids. */

/** Names from the site down to each location: id → ["Hamrun Shop", "Top", "Room 1"]. */
export function buildPaths(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const paths = new Map();

  const pathOf = (node, seen = new Set()) => {
    const cached = paths.get(node.id);
    if (cached) return cached;
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    // A cycle can't be created through the API, but never loop forever on bad data.
    const prefix = parent && !seen.has(parent.id) ? pathOf(parent, seen.add(node.id)) : [];
    const path = [...prefix, node.name];
    paths.set(node.id, path);
    return path;
  };

  for (const node of nodes) pathOf(node);
  return paths;
}

/** The given ids plus everything below them, parents before children. */
export function withDescendants(nodes, rootIds) {
  const children = new Map();
  for (const n of nodes) children.set(n.parentId, [...(children.get(n.parentId) ?? []), n]);
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const out = [];
  const seen = new Set();
  const visit = (node) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    out.push(node);
    for (const child of sortSiblings(children.get(node.id) ?? [])) visit(child);
  };
  for (const id of rootIds) {
    const node = byId.get(id);
    if (node) visit(node);
  }
  return out;
}

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** sortOrder first, then natural name order so A2 comes before A10. */
export function sortSiblings(nodes) {
  return [...nodes].sort((a, b) => a.sortOrder - b.sortOrder || collator.compare(a.name, b.name));
}

/**
 * The nearest ancestors that fit in `maxChars`, for small labels:
 * ["Hamrun Shop", "Top", "Room 1", "Shelf A"] → "Room 1 › Shelf A".
 */
export function shortPath(ancestors, maxChars) {
  let out = "";
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const next = out ? `${ancestors[i]}${PATH_SEPARATOR}${out}` : ancestors[i];
    if (out && next.length > maxChars) break;
    out = next;
  }
  return out;
}
