"use strict";

/**
 * AI Chat API Routes
 * Handles natural language commands from frontend
 */

const express = require("express");
const router = express.Router();
const aiAgent = require("../services/aiAgent");

// POST /api/ai/chat - Process natural language command
router.post("/chat", async (req, res) => {
  try {
    const { message, context } = req.body;

    // Validate input
    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({
        success: false,
        error: "Message is required and must be a non-empty string"
      });
    }

    console.log(`[AI Route] Received message: "${message}"`);

    // Process with AI agent
    const result = await aiAgent.chat(message.trim(), context || {});

    res.json(result);

  } catch (error) {
    console.error("[AI Route] Error:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Internal server error"
    });
  }
});

module.exports = router;
