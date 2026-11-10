// inventory/services/products.js — products, variants (SKUs), kits and barcodes.
import {
  CODE_PREFIX,
  componentCode,
  componentName,
  LOCATION_PREFIX,
  productCode,
  RESERVED_CODE,
  variantCode,
  variantName,
} from "../lib/codes.js";
import { isDuplicateKey, nextCounter, withTransaction } from "../lib/db.js";
import { badRequest, conflict, notFound } from "../lib/http.js";
import { escapeRegex, money } from "../lib/validate.js";
import { Barcode, Category, Product, TaxRate, Variant } from "../models/Catalog.js";
import { StockLevel } from "../models/Stock.js";
import { audit } from "./audit.js";

const s = (v) => (v == null ? v : String(v));

// -------------------------------------------------------------------- read

export async function listProducts(query) {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 25;
  const q = query.q?.trim();

  const filter = {};
  if (query.status) filter.status = query.status;
  if (query.type) filter.type = query.type;
  if (query.categoryId) filter.categoryId = query.categoryId;
  if (query.needsSetup !== undefined) filter.needsSetup = query.needsSetup;
  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    const [byVariant, byBarcode] = await Promise.all([
      Variant.find({ $or: [{ sku: rx }, { code: rx }] }).distinct("productId"),
      Barcode.find({ code: q }).distinct("variantId"),
    ]);
    const barcodeProducts = byBarcode.length ? await Variant.find({ _id: { $in: byBarcode } }).distinct("productId") : [];
    filter.$or = [{ name: rx }, { brand: rx }, { _id: { $in: [...byVariant, ...barcodeProducts] } }];
  }

  const [rows, total] = await Promise.all([
    Product.find(filter)
      .sort({ status: 1, name: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .populate("categoryId", "name")
      .lean(),
    Product.countDocuments(filter),
  ]);
  const variants = await Variant.find({ productId: { $in: rows.map((r) => r._id) } })
    .select("productId kind code sku name price active sortOrder createdAt")
    .sort({ sortOrder: 1, createdAt: 1 })
    .lean();

  const items = rows.map((p) => ({
    ...productFields(p),
    variants: variants
      .filter((v) => s(v.productId) === s(p._id))
      .map((v) => ({ id: s(v._id), kind: v.kind, code: v.code, sku: v.sku, name: v.name, price: v.price, active: v.active })),
  }));
  return { items, total, page, pageSize };
}

/** A product with category, tax rate, variants, their barcodes and kit boxes. */
export async function getProduct(id, session) {
  const product = await Product.findById(id)
    .session(session ?? null)
    .populate("categoryId", "name")
    .populate("taxRateId", "name rate")
    .lean();
  if (!product) throw notFound("Product not found");

  const variants = await Variant.find({ productId: id }).session(session ?? null).sort({ sortOrder: 1, createdAt: 1 }).lean();
  const barcodes = await Barcode.find({ variantId: { $in: variants.map((v) => v._id) } })
    .session(session ?? null)
    .sort({ active: -1, createdAt: 1 })
    .lean();
  const byId = new Map(variants.map((v) => [s(v._id), v]));

  return {
    ...productFields(product),
    taxRate: product.taxRateId ? { id: s(product.taxRateId._id), name: product.taxRateId.name, rate: product.taxRateId.rate } : null,
    taxRateId: product.taxRateId ? s(product.taxRateId._id) : null,
    variants: variants.map((v) => ({
      ...variantFields(v),
      barcodes: barcodes.filter((b) => s(b.variantId) === s(v._id)).map(barcodeFields),
      components: (v.components ?? []).map((c) => {
        const box = byId.get(s(c.componentVariantId));
        return {
          id: s(c.componentVariantId),
          kitVariantId: s(v._id),
          componentVariantId: s(c.componentVariantId),
          quantity: c.quantity,
          componentVariant: box ? { id: s(box._id), code: box.code, sku: box.sku, name: box.name, active: box.active } : null,
        };
      }),
    })),
  };
}

/** Resolve a scanned code to its item. Unknown codes → 404. */
export async function lookupBarcode(code) {
  const barcode = await Barcode.findOne({ code: code.trim() }).lean();
  if (!barcode) throw notFound(`No item has the barcode "${code}"`);
  const variant = await Variant.findById(barcode.variantId).lean();
  const product = await Product.findById(variant.productId).select("name type status images minStock").lean();
  const kit = variant.kitVariantId ? await Variant.findById(variant.kitVariantId).select("code name productId").lean() : null;
  return {
    ...barcodeFields(barcode),
    variant: {
      ...variantFields(variant),
      product: { id: s(product._id), name: product.name, type: product.type, status: product.status, images: product.images, minStock: product.minStock },
      usedInKits: kit
        ? [{ kitVariant: { id: s(kit._id), code: kit.code, name: kit.name, productId: s(kit.productId) } }]
        : [],
    },
  };
}

// ------------------------------------------------------------------ create

export async function createProduct(userId, dto) {
  const taxRateId = await resolveTaxRate(dto.taxRateId);
  if (dto.categoryId) await assertCategory(dto.categoryId);

  const isKit = dto.type === "KIT";
  if (isKit && !dto.kit) throw badRequest("A kit needs its boxes");
  if (!isKit && !dto.variants?.length) throw badRequest("Add at least one variant");

  const rows = isKit ? dto.kit.components : dto.variants;
  const skus = [isKit ? dto.kit.sku : undefined, ...rows.map((r) => r.sku)];
  const barcodes = rows.map((r) => r.barcode);
  assertManualCodes(skus, barcodes);
  if (!isKit) assertUniqueVariantNames(dto.variants);
  await assertCodesFree(skus, barcodes);

  const product = await withConflicts(() =>
    withTransaction(async (session) => {
      const number = await nextCounter("product", session);
      const base = productCode(number);
      const [created] = await Product.create(
        [
          {
            number,
            name: dto.name.trim(),
            description: dto.description?.trim() || null,
            type: dto.type,
            status: dto.status ?? "ACTIVE",
            categoryId: dto.categoryId ?? null,
            brand: dto.brand?.trim() || null,
            taxRateId,
            minStock: dto.minStock ?? 0,
            images: dto.images ?? [],
          },
        ],
        { session }
      );

      if (isKit) {
        await createKitVariants(session, created._id, base, dto.kit);
      } else {
        const single = dto.variants.length === 1 && variantName(dto.variants[0].color, dto.variants[0].size) === "Default";
        for (const [i, v] of dto.variants.entries()) {
          await createStandardVariant(session, created._id, single ? base : variantCode(base, i + 1), v, i);
        }
      }
      return getProduct(created._id, session);
    })
  );

  await audit({
    userId,
    action: "PRODUCT_CREATED",
    entity: "Product",
    entityId: product.id,
    data: { name: product.name, type: product.type, codes: product.variants.map((v) => v.code) },
  });
  return product;
}

/** v: { sku?, color?, size?, price, costPrice?, barcode?, websiteVariantId? } */
export async function createStandardVariant(session, productId, code, v, sortOrder) {
  const [variant] = await Variant.create(
    [
      {
        productId,
        kind: "STANDARD",
        code,
        sku: v.sku?.trim() || code,
        name: variantName(v.color, v.size),
        color: v.color?.trim() || null,
        size: v.size?.trim() || null,
        price: money(v.price ?? null),
        costPrice: money(v.costPrice ?? null),
        sortOrder,
        websiteVariantId: v.websiteVariantId ?? null,
      },
    ],
    { session }
  );
  await Barcode.create(barcodeRows(variant._id, code, v.barcode), { session, ordered: true });
  return variant;
}

async function createKitVariants(session, productId, base, kit) {
  // The kit unit itself: priced and sold, but never stocked or scanned.
  const [kitVariant] = await Variant.create(
    [
      {
        productId,
        kind: "KIT",
        code: base,
        sku: kit.sku?.trim() || base,
        name: "Complete kit",
        price: money(kit.price),
        costPrice: money(kit.costPrice ?? null),
        components: [],
      },
    ],
    { session }
  );
  for (const [i, c] of kit.components.entries()) {
    await createComponent(session, productId, kitVariant, i, c);
  }
  return kitVariant;
}

/** One box of a kit, plus its entry in the kit's component list. */
async function createComponent(session, productId, kitVariant, index, c) {
  const code = componentCode(kitVariant.code, index);
  const [component] = await Variant.create(
    [
      {
        productId,
        kind: "COMPONENT",
        code,
        sku: c.sku?.trim() || code,
        name: componentName(index, c.label),
        sortOrder: (kitVariant.sortOrder ?? 0) * 100 + index + 1,
        kitVariantId: kitVariant._id,
        boxIndex: index,
      },
    ],
    { session }
  );
  await Barcode.create(barcodeRows(component._id, code, c.barcode), { session, ordered: true });
  await Variant.updateOne(
    { _id: kitVariant._id },
    { $push: { components: { componentVariantId: component._id, quantity: c.quantity } } },
    { session }
  );
  return component;
}

// ------------------------------------------------------------------ update

export async function updateProduct(userId, id, dto) {
  const before = await Product.findById(id).lean();
  if (!before) throw notFound("Product not found");
  if (dto.categoryId) await assertCategory(dto.categoryId);
  if (dto.taxRateId) await resolveTaxRate(dto.taxRateId);

  const data = {};
  if (dto.name !== undefined) data.name = dto.name.trim();
  if (dto.description !== undefined) data.description = dto.description?.trim() || null;
  if (dto.categoryId !== undefined) data.categoryId = dto.categoryId;
  if (dto.brand !== undefined) data.brand = dto.brand?.trim() || null;
  if (dto.taxRateId !== undefined) data.taxRateId = dto.taxRateId;
  if (dto.minStock !== undefined) data.minStock = dto.minStock;
  if (dto.status !== undefined) data.status = dto.status;
  if (dto.images !== undefined) data.images = dto.images;
  if (dto.needsSetup !== undefined) data.needsSetup = dto.needsSetup;

  await Product.updateOne({ _id: id }, data);
  await audit({
    userId,
    action: "PRODUCT_UPDATED",
    entity: "Product",
    entityId: id,
    data: { changes: changedFields(before, data) },
  });
  return getProduct(id);
}

export async function addVariant(userId, productId, dto) {
  const product = await Product.findById(productId).lean();
  if (!product) throw notFound("Product not found");
  const variants = await Variant.find({ productId, kind: { $ne: "COMPONENT" } }).select("name").lean();
  if (product.type !== "STANDARD") throw badRequest('Kits get boxes, not variants — use "Add box"');
  const name = variantName(dto.color, dto.size);
  if (name === "Default") throw badRequest("Enter a colour or size for the new variant");
  if (variants.some((v) => v.name.toLowerCase() === name.toLowerCase())) {
    throw conflict(`Variant "${name}" already exists`);
  }
  assertManualCodes([dto.sku], [dto.barcode]);
  await assertCodesFree([dto.sku], [dto.barcode]);

  const variant = await withConflicts(() =>
    withTransaction(async (session) => {
      const code = await nextFreeVariantCode(productCode(product.number), session);
      const count = await Variant.countDocuments({ productId }).session(session);
      return createStandardVariant(session, productId, code, dto, count);
    })
  );
  await audit({
    userId,
    action: "VARIANT_ADDED",
    entity: "ProductVariant",
    entityId: variant._id,
    data: { productId, code: variant.code, name: variant.name },
  });
  return getProduct(productId);
}

/** Adds a box to a kit (by the kit variant's id). */
export async function addComponent(userId, kitVariantId, dto) {
  const kitVariant = await Variant.findById(kitVariantId).lean();
  if (!kitVariant) throw notFound("Kit not found");
  if (kitVariant.kind !== "KIT") throw badRequest("Only kits have boxes");
  assertManualCodes([dto.sku], [dto.barcode]);
  await assertCodesFree([dto.sku], [dto.barcode]);

  const index = await Variant.countDocuments({ kitVariantId });
  const component = await withConflicts(() =>
    withTransaction((session) => createComponent(session, kitVariant.productId, kitVariant, index, dto))
  );
  await audit({
    userId,
    action: "KIT_BOX_ADDED",
    entity: "ProductVariant",
    entityId: component._id,
    data: { productId: s(kitVariant.productId), kit: kitVariant.code, code: component.code, name: component.name, quantity: dto.quantity },
  });
  return getProduct(kitVariant.productId);
}

/**
 * Turns a normal variant into a kit made of boxes — for multi-box products that came from the
 * website as a single item. Only allowed while the variant holds no stock (stock is kept per box).
 */
export async function makeKit(userId, variantId, dto) {
  const variant = await Variant.findById(variantId).lean();
  if (!variant) throw notFound("Variant not found");
  if (variant.kind !== "STANDARD") throw badRequest("This item is already a kit or a box");
  const stocked = await StockLevel.exists({ variantId, $or: [{ onHand: { $gt: 0 } }, { reserved: { $gt: 0 } }] });
  if (stocked) throw badRequest("Move or remove this item's stock first — a kit's stock is kept per box");

  const skus = dto.components.map((c) => c.sku);
  const barcodes = dto.components.map((c) => c.barcode);
  assertManualCodes(skus, barcodes);
  await assertCodesFree(skus, barcodes);

  await withConflicts(() =>
    withTransaction(async (session) => {
      // A kit is never scanned itself, so its own barcodes are retired (kept in history).
      await Barcode.updateMany({ variantId, active: true }, { active: false, deactivatedAt: new Date() }, { session });
      const kit = await Variant.findByIdAndUpdate(
        variantId,
        { kind: "KIT", components: [] },
        { new: true, session }
      ).lean();
      for (const [i, c] of dto.components.entries()) await createComponent(session, kit.productId, kit, i, c);
      await Product.updateOne({ _id: kit.productId }, { type: "KIT" }, { session });
    })
  );
  await audit({
    userId,
    action: "VARIANT_MADE_KIT",
    entity: "ProductVariant",
    entityId: variantId,
    data: { code: variant.code, boxes: dto.components.map((c, i) => ({ box: componentName(i, c.label), quantity: c.quantity })) },
  });
  return getProduct(variant.productId);
}

export async function updateVariant(userId, variantId, dto) {
  const variant = await Variant.findById(variantId).lean();
  if (!variant) throw notFound("Variant not found");
  const kind = variant.kind;
  const reject = (field) => {
    throw badRequest(`"${field}" cannot be set on a ${kind.toLowerCase()} item`);
  };

  const data = {};
  if (dto.sku !== undefined) {
    const sku = dto.sku.trim();
    if (sku !== variant.code) assertManualCodes([sku], []);
    if (sku !== variant.sku) await assertCodesFree([sku], []);
    data.sku = sku;
  }

  if (dto.color !== undefined || dto.size !== undefined) {
    if (kind === "COMPONENT") reject("colour/size");
    const color = dto.color === undefined ? variant.color : dto.color?.trim() || null;
    const size = dto.size === undefined ? variant.size : dto.size?.trim() || null;
    const name = variantName(color, size);
    const clash = await Variant.exists({
      productId: variant.productId,
      _id: { $ne: variant._id },
      kind: { $ne: "COMPONENT" },
      name: new RegExp(`^${escapeRegex(name)}$`, "i"),
    });
    if (clash) throw conflict(`Variant "${name}" already exists`);
    Object.assign(data, { color, size, name });
  }

  if (dto.label !== undefined) {
    if (kind !== "COMPONENT") reject("box label");
    data.name = componentName(variant.boxIndex ?? 0, dto.label);
  }
  if (dto.price !== undefined) {
    if (kind === "COMPONENT") reject("price");
    data.price = money(dto.price);
  }
  if (dto.costPrice !== undefined) {
    if (kind === "COMPONENT") reject("cost price");
    data.costPrice = money(dto.costPrice);
  }
  if (dto.active !== undefined) {
    if (kind === "KIT") reject("active (change the product status instead)");
    data.active = dto.active;
  }
  if (dto.quantity !== undefined && kind !== "COMPONENT") reject("quantity");

  const kit = variant.kitVariantId ? await Variant.findById(variant.kitVariantId).lean() : null;
  const beforeQty = kit?.components?.find((c) => s(c.componentVariantId) === s(variant._id))?.quantity ?? null;

  await withConflicts(() =>
    withTransaction(async (session) => {
      if (dto.quantity !== undefined && kit) {
        await Variant.updateOne(
          { _id: kit._id, "components.componentVariantId": variant._id },
          { $set: { "components.$.quantity": dto.quantity } },
          { session }
        );
      }
      if (Object.keys(data).length) await Variant.updateOne({ _id: variantId }, data, { session });
    })
  );

  await audit({
    userId,
    action: "VARIANT_UPDATED",
    entity: "ProductVariant",
    entityId: variantId,
    data: {
      code: variant.code,
      before: { sku: variant.sku, name: variant.name, price: variant.price, costPrice: variant.costPrice, active: variant.active, quantity: beforeQty },
      changes: dto,
    },
  });
  return getProduct(variant.productId);
}

// ---------------------------------------------------------------- barcodes

export async function addBarcode(userId, variantId, code) {
  const variant = await Variant.findById(variantId).lean();
  if (!variant) throw notFound("Variant not found");
  if (variant.kind === "KIT") throw badRequest("A kit has no barcode of its own — add barcodes to its boxes");
  const value = code.trim();
  assertManualCodes([], [value]);
  await assertCodesFree([], [value]);

  const barcode = await withConflicts(() => Barcode.create({ code: value, variantId, type: "SUPPLIER" }));
  await audit({
    userId,
    action: "BARCODE_ADDED",
    entity: "Barcode",
    entityId: barcode._id,
    data: { code: value, variantCode: variant.code },
  });
  return getProduct(variant.productId);
}

export async function setBarcodeActive(userId, barcodeId, active) {
  const barcode = await Barcode.findById(barcodeId).lean();
  if (!barcode) throw notFound("Barcode not found");
  const variant = await Variant.findById(barcode.variantId).select("productId code").lean();

  await Barcode.updateOne({ _id: barcodeId }, { active, deactivatedAt: active ? null : new Date() });
  await audit({
    userId,
    action: active ? "BARCODE_ACTIVATED" : "BARCODE_DEACTIVATED",
    entity: "Barcode",
    entityId: barcodeId,
    data: { code: barcode.code, variantCode: variant.code },
  });
  return getProduct(variant.productId);
}

// ------------------------------------------------------------------ checks

export async function resolveTaxRate(taxRateId) {
  if (taxRateId) {
    const rate = await TaxRate.findById(taxRateId).lean();
    if (!rate || !rate.active) throw badRequest("Choose an active tax rate");
    return rate._id;
  }
  const fallback = await TaxRate.findOne({ isDefault: true, active: true }).lean();
  return fallback?._id ?? null;
}

async function assertCategory(categoryId) {
  const category = await Category.findById(categoryId).lean();
  if (!category || !category.active) throw badRequest("Choose an active category");
}

export function assertManualCodes(skus, barcodes) {
  const entered = [...skus, ...barcodes].map((v) => v?.trim()).filter(Boolean);
  const reserved = entered.find((v) => RESERVED_CODE.test(v));
  if (reserved) {
    throw badRequest(
      `"${reserved}" looks like a system code (${CODE_PREFIX}-… or ${LOCATION_PREFIX}-…). Leave it empty and the system will generate one.`
    );
  }
  const dupes = entered.filter((v, i) => entered.indexOf(v) !== i);
  if (dupes.length) throw badRequest(`"${dupes[0]}" is entered more than once`);
}

/** Friendly pre-check; the unique indexes still guard against races. */
export async function assertCodesFree(skus, barcodes) {
  const skuList = skus.map((x) => x?.trim()).filter(Boolean);
  const codeList = barcodes.map((x) => x?.trim()).filter(Boolean);

  if (skuList.length) {
    const taken = await Variant.findOne({ sku: { $in: skuList } }).populate("productId", "name").lean();
    if (taken) throw conflict(`SKU "${taken.sku}" is already used by ${taken.productId?.name} (${taken.name})`);
  }
  if (codeList.length) {
    const taken = await Barcode.findOne({ code: { $in: codeList } }).lean();
    if (taken) {
      const v = await Variant.findById(taken.variantId).populate("productId", "name").lean();
      const owner = `${v?.productId?.name} (${v?.name})`;
      throw conflict(
        taken.active
          ? `Barcode "${taken.code}" already belongs to ${owner}`
          : `Barcode "${taken.code}" was used before by ${owner} and cannot be reused`
      );
    }
  }
}

async function withConflicts(fn) {
  try {
    return await fn();
  } catch (e) {
    if (isDuplicateKey(e)) throw conflict("That SKU or barcode was just taken by another item. Please try again.");
    throw e;
  }
}

/** The next unused "TW-000123-NN" code for a product. */
export async function nextFreeVariantCode(base, session) {
  const used = new Set(
    (await Variant.find({ code: new RegExp(`^${escapeRegex(base)}-\\d{2}$`) }).session(session ?? null).distinct("code"))
  );
  for (let n = 1; n < 1000; n++) {
    const code = variantCode(base, n);
    if (!used.has(code)) return code;
  }
  throw badRequest("Too many variants on this product");
}

/** Every stocked item gets its internal code as a barcode, plus the supplier's if given. */
function barcodeRows(variantId, internalCode, supplierCode) {
  const rows = [{ code: internalCode, variantId, type: "INTERNAL" }];
  if (supplierCode?.trim()) rows.push({ code: supplierCode.trim(), variantId, type: "SUPPLIER" });
  return rows;
}

function assertUniqueVariantNames(variants) {
  const names = variants.map((v) => variantName(v.color, v.size).toLowerCase());
  const dupe = names.find((n, i) => names.indexOf(n) !== i);
  if (dupe) throw badRequest(`Two variants are both "${dupe}" — each needs a different colour/size`);
  if (variants.length > 1 && names.includes("default")) {
    throw badRequest("When a product has several variants, each needs a colour or size");
  }
}

function changedFields(before, data) {
  const out = {};
  for (const [key, to] of Object.entries(data)) {
    const from = before[key];
    if (JSON.stringify(from ?? null) !== JSON.stringify(to ?? null)) out[key] = { from: from ?? null, to: to ?? null };
  }
  return out;
}

// ------------------------------------------------------------------ shapes

function productFields(p) {
  const cat = p.categoryId;
  return {
    id: s(p._id),
    number: p.number,
    name: p.name,
    description: p.description,
    type: p.type,
    status: p.status,
    categoryId: cat?._id ? s(cat._id) : s(cat) ?? null,
    category: cat?._id ? { id: s(cat._id), name: cat.name } : null,
    brand: p.brand,
    taxRateId: s(p.taxRateId?._id ?? p.taxRateId) ?? null,
    minStock: p.minStock,
    images: p.images,
    needsSetup: !!p.needsSetup,
    website: p.website?.productId ? { productId: s(p.website.productId), deleted: !!p.website.deleted, syncedAt: p.website.syncedAt } : null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

function variantFields(v) {
  return {
    id: s(v._id),
    productId: s(v.productId),
    kind: v.kind,
    code: v.code,
    sku: v.sku,
    name: v.name,
    color: v.color,
    size: v.size,
    price: v.price,
    costPrice: v.costPrice,
    active: v.active,
    sortOrder: v.sortOrder,
    kitVariantId: s(v.kitVariantId) ?? null,
    websiteVariantId: v.websiteVariantId ?? null,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
}

function barcodeFields(b) {
  return {
    id: s(b._id),
    code: b.code,
    variantId: s(b.variantId),
    type: b.type,
    active: b.active,
    createdAt: b.createdAt,
    deactivatedAt: b.deactivatedAt,
  };
}
