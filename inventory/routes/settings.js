// inventory/routes/settings.js — app settings, tax rates and categories.
import express from "express";
import { z } from "zod";
import { allow } from "../auth/auth.js";
import { CATALOG_WRITE, STAFF_READ } from "../auth/roles.js";
import { isDuplicateKey, withTransaction } from "../lib/db.js";
import { ah, conflict, notFound } from "../lib/http.js";
import { send } from "../lib/json.js";
import { idParam, parse } from "../lib/validate.js";
import { Category, Product, TaxRate } from "../models/Catalog.js";
import { audit } from "../services/audit.js";
import { getSettings, updateSettings } from "../services/settings.js";

const router = express.Router();

// ------------------------------------------------------------------ settings

const SettingsBody = z
  .object({
    businessName: z.string().trim().min(1).max(100),
    currency: z.string().length(3),
    pricesIncludeTax: z.boolean(),
    labelWidthMm: z.number().int().min(20).max(150),
    labelHeightMm: z.number().int().min(10).max(150),
    labelShowPrice: z.boolean(),
    businessAddress: z.string().max(300),
    businessPhone: z.string().max(50),
    vatNumber: z.string().max(30),
    receiptFooter: z.string().max(300),
    receiptWidthMm: z.number().int().min(48).max(120),
    maxDiscountPercent: z.number().int().min(0).max(100),
  })
  .partial();

router.get(
  "/settings",
  ah(async (req, res) => res.json(await getSettings()))
);

router.patch(
  "/settings",
  allow("ADMIN"),
  ah(async (req, res) => res.json(await updateSettings(req.staff.id, parse(SettingsBody, req.body))))
);

// ----------------------------------------------------------------- tax rates

const TaxRateBody = z.object({
  name: z.string().trim().min(1).max(50),
  /** Percentage, e.g. 18 for 18%. */
  rate: z.number().min(0).max(100),
  isDefault: z.boolean().optional(),
  active: z.boolean().optional(),
});

router.get(
  "/tax-rates",
  ah(async (req, res) => {
    const filter = req.query.all === "true" ? {} : { active: true };
    send(res, await TaxRate.find(filter).sort({ isDefault: -1, rate: -1 }).lean());
  })
);

router.post(
  "/tax-rates",
  allow("ADMIN"),
  ah(async (req, res) => {
    const dto = parse(TaxRateBody, req.body);
    const rate = await taxRateGuard(() =>
      withTransaction(async (session) => {
        const isFirst = (await TaxRate.countDocuments().session(session)) === 0;
        const isDefault = dto.isDefault ?? isFirst;
        if (isDefault) await TaxRate.updateMany({}, { isDefault: false }, { session });
        const [created] = await TaxRate.create(
          [{ name: dto.name, rate: dto.rate, isDefault, active: dto.active ?? true }],
          { session }
        );
        return created.toObject();
      })
    );
    await audit({
      userId: req.staff.id,
      action: "TAX_RATE_CREATED",
      entity: "TaxRate",
      entityId: rate._id,
      data: { name: rate.name, rate: rate.rate },
    });
    send(res, rate, 201);
  })
);

router.patch(
  "/tax-rates/:id",
  allow("ADMIN"),
  ah(async (req, res) => {
    const id = idParam(req.params.id);
    const dto = parse(TaxRateBody.partial(), req.body);
    const before = await TaxRate.findById(id).lean();
    if (!before) throw notFound("Tax rate not found");

    const rate = await taxRateGuard(() =>
      withTransaction(async (session) => {
        if (dto.isDefault) await TaxRate.updateMany({}, { isDefault: false }, { session });
        const data = { ...dto };
        // An inactive rate can't stay the default.
        if (dto.active === false) data.isDefault = false;
        return TaxRate.findByIdAndUpdate(id, data, { new: true, session }).lean();
      })
    );
    await audit({
      userId: req.staff.id,
      action: "TAX_RATE_UPDATED",
      entity: "TaxRate",
      entityId: id,
      data: {
        before: { name: before.name, rate: before.rate, active: before.active },
        after: { name: rate.name, rate: rate.rate, active: rate.active },
      },
    });
    send(res, rate);
  })
);

async function taxRateGuard(fn) {
  try {
    return await fn();
  } catch (e) {
    if (isDuplicateKey(e, "name")) throw conflict("A tax rate with this name already exists");
    throw e;
  }
}

// ---------------------------------------------------------------- categories

const CategoryBody = z.object({ name: z.string().trim().min(1).max(80) });
const CategoryUpdate = z.object({ name: z.string().trim().min(1).max(80).optional(), active: z.boolean().optional() });

router.get(
  "/categories",
  allow(STAFF_READ),
  ah(async (req, res) => {
    const filter = req.query.all === "true" ? {} : { active: true };
    const [categories, counts] = await Promise.all([
      Category.find(filter).sort({ nameKey: 1 }).lean(),
      Product.aggregate([{ $match: { categoryId: { $ne: null } } }, { $group: { _id: "$categoryId", n: { $sum: 1 } } }]),
    ]);
    const countById = new Map(counts.map((c) => [String(c._id), c.n]));
    send(
      res,
      categories.map(({ nameKey, ...c }) => ({ ...c, _count: { products: countById.get(String(c._id)) ?? 0 } }))
    );
  })
);

router.post(
  "/categories",
  allow(CATALOG_WRITE),
  ah(async (req, res) => {
    const { name } = parse(CategoryBody, req.body);
    const category = await categoryGuard(() => Category.create({ name, nameKey: name.toLowerCase() }));
    await audit({ userId: req.staff.id, action: "CATEGORY_CREATED", entity: "Category", entityId: category._id, data: { name } });
    send(res, category, 201);
  })
);

router.patch(
  "/categories/:id",
  allow(CATALOG_WRITE),
  ah(async (req, res) => {
    const id = idParam(req.params.id);
    const dto = parse(CategoryUpdate, req.body);
    const before = await Category.findById(id).lean();
    if (!before) throw notFound("Category not found");
    const data = {};
    if (dto.name) Object.assign(data, { name: dto.name, nameKey: dto.name.toLowerCase() });
    if (dto.active !== undefined) data.active = dto.active;
    const category = await categoryGuard(() => Category.findByIdAndUpdate(id, data, { new: true }).lean());
    await audit({
      userId: req.staff.id,
      action: "CATEGORY_UPDATED",
      entity: "Category",
      entityId: id,
      data: { before: { name: before.name, active: before.active }, after: { name: category.name, active: category.active } },
    });
    send(res, category);
  })
);

async function categoryGuard(fn) {
  try {
    return await fn();
  } catch (e) {
    if (isDuplicateKey(e, "nameKey")) throw conflict("That category already exists");
    throw e;
  }
}

export default router;
