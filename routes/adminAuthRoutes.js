// routes/adminAuthRoutes.js
import { Router } from "express";
import { adminRegister, adminLogin } from "../controllers/adminAuthController.js";

const router = Router();

// Create first admin (DISABLED FOR SECURITY)
// router.post("/register", adminRegister);

// Login existing admin
router.post("/login", adminLogin);

export default router;
