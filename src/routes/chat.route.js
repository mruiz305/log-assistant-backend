// src/routes/chat.route.js
const express = require("express");
const router = express.Router();

const { requireAuth } = require("../middlewares/requireFirebaseAuth");
const { postChat } = require("../controllers/chat.controller");

router.post("/chat", requireAuth, postChat);

module.exports = router;
