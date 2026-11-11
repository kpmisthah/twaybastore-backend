// inventory/routes/products.js — products, variants, kit boxes, barcodes and scanner lookup.
import express from "express";
import { z } from "zod";
import { allow } from "../auth/auth.js";
import { CATALOG_WRITE, PRODUCT_READ } from "../auth/roles.js";
import { ah, badRequest } from "../lib/http.js";
import { Variant } from "../models/Catalog.js";
import { send } from "../lib/json.js";
import { idParam, parse, zBarcode, zBoolString, zId, zMoney, zQueryInt, zSku } from "../lib/validate.js";
import {
  addBarcode,
  addComponent,
  addVariant,
  createProduct,
  getProduct,
  listProducts,
  lookupBarcode,
  makeKit,
  setBarcodeActive,
  updateProduct,
  updateVariant,
} from "../services/products.js";
import { syncAllFromWebsite } from "../services/websiteSync.js";

const router = express.Router();

/** Image URLs: the website's own (Cloudinary / R2) or anything served over http(s). */
const zImages = z.array(z.string().url().max(500)).max(10);
const zText = (max) => z.string().max(max);

const NewVariant = z.object({
  sku: zSku.optional(),
  color: zText(60).optional(),
  size: zText(60).optional(),
  price: zMoney,
  costPrice: zMoney.optional(),
  /** Supplier barcode, if the item already has one. */
  barcode: zBarcode.optional(),
});

const NewComponent = z.object({
  /** e.g. "Side panels" — shown as "Box A – Side panels". */
  label: zText(80).optional(),
  quantity: z.number().int().min(1).max(99),
  sku: zSku.optional(),
  barcode: zBarcode.optional(),
});

const ProductInfo = {
  name: z.string().trim().min(1).max(150),
  description: zText(5000).optional(),
  categoryId: zId.optional(),
  brand: zText(80).optional(),
  taxRateId: zId.optional(),
  minStock: z.number().int().min(0).max(100000).optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  images: zImages.optional(),
};

const CreateProduct = z.discriminatedUnion("type", [
  z.object({
    ...ProductInfo,
    type: z.literal("STANDARD"),
    /** One row per colour/size (or one default row). */
    variants: z.array(NewVariant).min(1).max(100),
  }),
  z.object({
    ...ProductInfo,
    type: z.literal("KIT"),
    kit: z.object({
      sku: zSku.optional(),
      price: zMoney,
      costPrice: zMoney.optional(),
      components: z.array(NewComponent).min(1).max(26),
    }),
  }),
]);

const UpdateProduct = z.object({
  name: z.string().trim().min(1).max(150).optional(),
  description: zText(5000).nullable().optional(),
  categoryId: zId.nullable().optional(),
  brand: zText(80).nullable().optional(),
  taxRateId: zId.nullable().optional(),
  minStock: z.number().int().min(0).max(100000).optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  images: zImages.optional(),
  /** Clear once the product is labelled and stocked. */
  needsSetup: z.boolean().optional(),
});

const UpdateVariant = z.object({
  sku: zSku.optional(),
  /** STANDARD only. */
  color: zText(60).nullable().optional(),
  size: zText(60).nullable().optional(),
  /** COMPONENT only: the part after "Box A – ". */
  label: zText(80).nullable().optional(),
  /** COMPONENT only: boxes needed per kit. */
  quantity: z.number().int().min(1).max(99).optional(),
  /** STANDARD and KIT only. */
  price: zMoney.optional(),
  costPrice: zMoney.nullable().optional(),
  active: z.boolean().optional(),
});

const ListQuery = z.object({
  q: z.string().max(100).optional(),
  categoryId: zId.optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  type: z.enum(["STANDARD", "KIT"]).optional(),
  /** "true" = only products created from the website that still need labels/stock. */
  needsSetup: zBoolString.optional(),
  page: zQueryInt(1, 100000).optional(),
  pageSize: zQueryInt(1, 100).optional(),
});

router.get(
  "/products",
  allow(PRODUCT_READ),
  ah(async (req, res) => send(res, hideCost(req, await listProducts(parse(ListQuery, req.query)))))
);

router.get(
  "/products/:id",
  allow(PRODUCT_READ),
  ah(async (req, res) => send(res, hideCost(req, await getProduct(idParam(req.params.id)))))
);

router.post(
  "/products",
  allow(CATALOG_WRITE),
  ah(async (req, res) => send(res, await createProduct(req.staff.id, parse(CreateProduct, req.body)), 201))
);

/** Re-reads every website product and creates/updates the inventory copies. */
router.post(
  "/products/sync-website",
  allow(CATALOG_WRITE),
  ah(async (req, res) => res.json(await syncAllFromWebsite(req.staff.id)))
);

router.patch(
  "/products/:id",
  allow(CATALOG_WRITE),
  ah(async (req, res) =>
    send(res, await updateProduct(req.staff.id, idParam(req.params.id), parse(UpdateProduct, req.body)))
  )
);

router.post(
  "/products/:id/variants",
  allow(CATALOG_WRITE),
  ah(async (req, res) => send(res, await addVariant(req.staff.id, idParam(req.params.id), parse(NewVariant, req.body))))
);

/** Turn a variant into a kit: { components: [{ label, quantity, sku?, barcode? }] }. */
router.post(
  "/variants/:id/make-kit",
  allow(CATALOG_WRITE),
  ah(async (req, res) =>
    send(
      res,
      await makeKit(req.staff.id, idParam(req.params.id), parse(z.object({ components: z.array(NewComponent).min(1).max(26) }), req.body))
    )
  )
);

/** Add a box to a kit product that has a single kit (id = the product). */
router.post(
  "/products/:id/components",
  allow(CATALOG_WRITE),
  ah(async (req, res) => {
    const kits = await Variant.find({ productId: idParam(req.params.id), kind: "KIT" }).select("_id").lean();
    if (kits.length !== 1) throw badRequest(kits.length ? "This product has several kits — add the box to one of them" : "Only kit products have boxes");
    send(res, await addComponent(req.staff.id, String(kits[0]._id), parse(NewComponent, req.body)));
  })
);

/** Add a box to a kit (id = the kit variant). */
router.post(
  "/variants/:id/components",
  allow(CATALOG_WRITE),
  ah(async (req, res) => send(res, await addComponent(req.staff.id, idParam(req.params.id), parse(NewComponent, req.body))))
);

router.patch(
  "/variants/:id",
  allow(CATALOG_WRITE),
  ah(async (req, res) =>
    send(res, await updateVariant(req.staff.id, idParam(req.params.id), parse(UpdateVariant, req.body)))
  )
);

router.post(
  "/variants/:id/barcodes",
  allow(CATALOG_WRITE),
  ah(async (req, res) =>
    send(res, await addBarcode(req.staff.id, idParam(req.params.id), parse(z.object({ code: zBarcode }), req.body).code))
  )
);

router.patch(
  "/barcodes/:id",
  allow(CATALOG_WRITE),
  ah(async (req, res) =>
    send(
      res,
      await setBarcodeActive(req.staff.id, idParam(req.params.id), parse(z.object({ active: z.boolean() }), req.body).active)
    )
  )
);

/** Scanner lookup: what item is this code? */
router.get(
  "/barcodes/lookup/:code",
  allow(PRODUCT_READ),
  ah(async (req, res) => send(res, hideCost(req, await lookupBarcode(req.params.code))))
);

/** Cost prices are only for roles that manage the catalogue. */
function hideCost(req, data) {
  if (CATALOG_WRITE.includes(req.staff.role)) return data;
  return JSON.parse(JSON.stringify(data), (key, value) => (key === "costPrice" ? undefined : value));
}

export default router;
