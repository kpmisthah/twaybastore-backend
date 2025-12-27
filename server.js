import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import { createServer } from "http";
import { Server } from "socket.io";
import authRoutes from "./routes/authRoutes.js";
import productRoutes from "./routes/productRoutes.js";
import orderRoutes from "./routes/orderRoutes.js";
import paymentRoutes from "./routes/paymentRoutes.js";
import reviewRoutes from "./routes/reviewRoutes.js";
import adminroutes from "./routes/adminRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import categoryClickRoutes from "./routes/categoryClicks.js";
import analyticsRoutes from "./routes/analyticsRoutes.js";
import wishlistRoutes from "./routes/wishlistRoutes.js";
import contactRoutes from "./routes/contactRoutes.js";
import adminAuthRoutes from "./routes/adminAuthRoutes.js";
import { requireAdmin } from "./middleware/adminAuth.js";
import ipBanRoutes from "./routes/ipBanRoutes.js";
import uploadRoutes from "./routes/uploadRoutes.js";
dotenv.config();

const app = express();

const allowedOrigins = [
  // Main site
  "https://www.twayba.com",
  "https://twayba.com",
  "https://twayba-admin.vercel.app",
  "https://twaybastore-admin.vercel.app",
  "http://localhost:5173",
  "http://localhost:5174",
];

app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (like Postman, curl)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin) || origin.endsWith(".vercel.app")) {
        return callback(null, true);
      } else {
        console.error("UNKNOWN ORIGIN BLOCKED BY CORS:", origin);
        return callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true, // Set to true if you use cookies/session
  })
);

app.use(express.json());

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB error:", err));

// --------- ROUTES ----------
app.use("/api/upload", uploadRoutes);
app.use("/api/users", userRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/products", productRoutes);
app.use("/api", reviewRoutes);
app.use("/api/admin", adminroutes);
app.use("/api/category-clicks", categoryClickRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/wishlist", wishlistRoutes);
app.use("/api/contact", contactRoutes);
// ...

app.use("/api/ipban", ipBanRoutes);
app.use("/api/admin/auth", adminAuthRoutes);
// Example protected admin API
app.get("/api/admin/stats", requireAdmin, (req, res) => {
  res.json({ ok: true, message: `Hello Admin ${req.admin.email}` });
});
// app.use("/api/analytics", analyticsRoutes); // Duplicate removed

// --------- SOCKET.IO (with CORS) ----------
const PORT = process.env.PORT || 5000;
const server = createServer(app);

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true
  },
});

// Support chat state (sample logic)
let waitingUsers = [];
let activeChats = {};

io.on("connection", (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  socket.on("join-chat", ({ name, phone, email, category, subject, desc }) => {
    waitingUsers.push({
      socketId: socket.id,
      name,
      phone,
      email,
      category,
      subject,
      desc,
      time: new Date(),
    });
    socket.emit("waiting");
    io.emit("waiting-list", waitingUsers);
  });

  socket.on("get-waiting-list", () => {
    socket.emit("waiting-list", waitingUsers);
  });

  socket.on("admin-accept", ({ userSocketId, adminName }) => {
    if (!userSocketId) return;
    activeChats[userSocketId] = socket.id;
    activeChats[socket.id] = userSocketId;
    waitingUsers = waitingUsers.filter((u) => u.socketId !== userSocketId);
    io.to(userSocketId).emit("chat-started", { adminName });
    io.to(socket.id).emit("chat-started", { userSocketId });
    io.emit("waiting-list", waitingUsers);
  });

  socket.on("message", ({ text, from }) => {
    const targetId = activeChats[socket.id];
    if (targetId) {
      io.to(targetId).emit("message", { from: from || "Support", text });
    }
  });

  socket.on("disconnect", () => {
    waitingUsers = waitingUsers.filter((u) => u.socketId !== socket.id);
    const partnerId = activeChats[socket.id];
    if (partnerId) {
      io.to(partnerId).emit("message", { from: "System", text: "Chat ended." });
      delete activeChats[partnerId];
    }
    delete activeChats[socket.id];
    io.emit("waiting-list", waitingUsers);
    console.log(`Socket disconnected: ${socket.id}`);
  });
});

// --------- START SERVER ----------
server.listen(
  PORT,
  () => console.log(`Server running on port ${PORT}`),
  console.log("R2 ENV CHECK:", {
    account: process.env.R2_ACCOUNT_ID,
    accessKey: process.env.R2_ACCESS_KEY?.slice(0, 6),
    secretKey: process.env.R2_SECRET_KEY ? "PRESENT" : "MISSING",
  })
);
