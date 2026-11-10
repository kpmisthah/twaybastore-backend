// inventory/models/Catalog.js — tax rates, categories, products, variants (SKUs) and barcodes.
import { model, ObjectId, Schema } from "./_base.js";

const taxRateSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    /** Percentage, e.g. 18 for 18%. */
    rate: { type: Number, required: true, min: 0, max: 100 },
    isDefault: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);
export const TaxRate = model("InvTaxRate", taxRateSchema, "inv_tax_rates");

const categorySchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    /** Lower-case name: names are unique ignoring case ("Chairs" = "chairs"). */
    nameKey: { type: String, required: true, unique: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);
export const Category = model("InvCategory", categorySchema, "inv_categories");

export const PRODUCT_TYPES = ["STANDARD", "KIT"];
export const PRODUCT_STATUSES = ["ACTIVE", "INACTIVE"];

const productSchema = new Schema(
  {
    /** Sequential number used to build internal codes (TW-000123). */
    number: { type: Number, required: true, unique: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: null },
    /** KIT when the product is sold as kits (multi-box). */
    type: { type: String, enum: PRODUCT_TYPES, required: true },
    status: { type: String, enum: PRODUCT_STATUSES, default: "ACTIVE" },
    categoryId: { type: ObjectId, ref: "InvCategory", default: null },
    brand: { type: String, default: null },
    taxRateId: { type: ObjectId, ref: "InvTaxRate", default: null },
    /** Low-stock threshold, applied per stocked variant (complete kits for a kit). */
    minStock: { type: Number, default: 0, min: 0 },
    /** Image URLs; the first one is the main image. */
    images: { type: [String], default: [] },
    /** Set when the product was created from the website's product list. */
    website: {
      productId: { type: ObjectId, default: null },
      /** The website product is soft-deleted. */
      deleted: { type: Boolean, default: false },
      syncedAt: { type: Date, default: null },
    },
    /** Created automatically from the website — warehouse staff still need to label and stock it. */
    needsSetup: { type: Boolean, default: false },
  },
  { timestamps: true }
);
productSchema.index({ name: 1 });
productSchema.index({ categoryId: 1 });
productSchema.index(
  { "website.productId": 1 },
  { unique: true, partialFilterExpression: { "website.productId": { $type: "objectId" } } }
);
export const Product = model("InvProduct", productSchema, "inv_products");

/**
 * STANDARD: a normal sellable, stocked item (one per colour/size).
 * KIT: the sellable kit unit — priced, never stocked or scanned itself.
 * COMPONENT: one box of a kit — stocked and scanned, not priced.
 */
export const VARIANT_KINDS = ["STANDARD", "KIT", "COMPONENT"];

const kitComponentSchema = new Schema(
  {
    componentVariantId: { type: ObjectId, ref: "InvVariant", required: true },
    /** How many of this box one kit unit needs. */
    quantity: { type: Number, required: true, min: 1 },
  },
  { _id: false }
);

const variantSchema = new Schema(
  {
    productId: { type: ObjectId, ref: "InvProduct", required: true },
    kind: { type: String, enum: VARIANT_KINDS, required: true },
    /** Internal code, generated and never changed (TW-000123, TW-000123-01, TW-000200-A). */
    code: { type: String, required: true, unique: true },
    sku: { type: String, required: true, unique: true },
    /** Display name: "Default", "Black / Large", "Box A – Side panels". */
    name: { type: String, required: true },
    color: { type: String, default: null },
    size: { type: String, default: null },
    price: { type: Number, default: null },
    costPrice: { type: Number, default: null },
    active: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
    /** KIT only: the boxes it is made of. */
    components: { type: [kitComponentSchema], default: undefined },
    /** COMPONENT only: the kit it belongs to. */
    kitVariantId: { type: ObjectId, ref: "InvVariant", default: null },
    /** COMPONENT only: 0 = Box A, 1 = Box B … */
    boxIndex: { type: Number, default: null },
    /** The website variant this SKU mirrors (null for a product without website variants). */
    websiteVariantId: { type: String, default: null },
  },
  { timestamps: true }
);
variantSchema.index({ productId: 1 });
variantSchema.index({ kitVariantId: 1 });
export const Variant = model("InvVariant", variantSchema, "inv_variants");

export const BARCODE_TYPES = ["INTERNAL", "SUPPLIER"];

/** A code is unique forever: deactivated codes stay so they can never be reassigned to another item. */
const barcodeSchema = new Schema(
  {
    code: { type: String, required: true, unique: true },
    variantId: { type: ObjectId, ref: "InvVariant", required: true },
    type: { type: String, enum: BARCODE_TYPES, required: true },
    active: { type: Boolean, default: true },
    deactivatedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
barcodeSchema.index({ variantId: 1 });
export const Barcode = model("InvBarcode", barcodeSchema, "inv_barcodes");
