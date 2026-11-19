// inventory/routes/locations.js
import express from "express";
import { z } from "zod";
import { allow } from "../auth/auth.js";
import { LOCATION_READ, LOCATION_WRITE } from "../auth/roles.js";
import { ah } from "../lib/http.js";
import { send } from "../lib/json.js";
import { idParam, parse, zId } from "../lib/validate.js";
import {
  createLocations,
  deleteLocation,
  getLocation,
  listLocations,
  lookupLocation,
  updateLocation,
} from "../services/locations.js";

const router = express.Router();

const MAX_LOCATIONS_PER_REQUEST = 100;

/** Creates one or more siblings at once, e.g. spaces A1…A6 on a shelf. */
/** Only photos uploaded through POST /uploads/locations are accepted. */
const imageUrl = z
  .string()
  .regex(/^https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/.+\/twayba\/inventory\/locations\/[^/]+$/, "photo must be uploaded through the app");

const CreateBody = z.object({
  /** Only used when a single location is created. */
  imageUrl: imageUrl.optional(),
  /** Omit for a new site. */
  parentId: zId.optional(),
  type: z.enum(["SITE", "FLOOR", "ROOM", "SHELF", "SPACE"]),
  names: z.array(z.string().trim().min(1).max(60)).min(1).max(MAX_LOCATIONS_PER_REQUEST),
});

const UpdateBody = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  active: z.boolean().optional(),
  /** A new photo, or null to remove it. */
  imageUrl: imageUrl.nullable().optional(),
});

router.get(
  "/",
  allow(LOCATION_READ),
  ah(async (req, res) => send(res, await listLocations(req.query.all === "true")))
);

/** GET /locations/lookup?code=LOC-000012 — for scanning a location label. */
router.get(
  "/lookup",
  allow(LOCATION_READ),
  ah(async (req, res) => send(res, await lookupLocation(String(req.query.code ?? ""))))
);

router.get(
  "/:id",
  allow(LOCATION_READ),
  ah(async (req, res) => send(res, await getLocation(idParam(req.params.id))))
);

router.post(
  "/",
  allow(LOCATION_WRITE),
  ah(async (req, res) => send(res, await createLocations(req.staff.id, parse(CreateBody, req.body)), 201))
);

router.patch(
  "/:id",
  allow(LOCATION_WRITE),
  ah(async (req, res) =>
    send(res, await updateLocation(req.staff.id, idParam(req.params.id), parse(UpdateBody, req.body)))
  )
);

router.delete(
  "/:id",
  allow(LOCATION_WRITE),
  ah(async (req, res) => send(res, await deleteLocation(req.staff.id, idParam(req.params.id))))
);

export default router;
