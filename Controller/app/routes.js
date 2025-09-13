const express = require("express");
const apiRouter = require("./api/index");

const router = express.Router();
router.use("/api", apiRouter);
router.use("/uploads", express.static("uploads"));
router.use("/", express.static("public")); // frontend

module.exports = router;
