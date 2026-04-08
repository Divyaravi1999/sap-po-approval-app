"use strict";

require("dotenv").config();

const express = require("express");
const cors    = require("cors");
const path    = require("path");

const app  = express();
const PORT = process.env.PORT || 3000;

app.locals.sseClients = [];

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../frontend")));

// ─── SSE endpoint ─────────────────────────────────────────────────────────────
app.get("/events", (req, res) => {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.flushHeaders();

  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 25000);
  app.locals.sseClients.push(res);
  console.log(`[SSE] Client connected. Total: ${app.locals.sseClients.length}`);

  req.on("close", () => {
    clearInterval(heartbeat);
    app.locals.sseClients = app.locals.sseClients.filter(c => c !== res);
    console.log(`[SSE] Client disconnected. Total: ${app.locals.sseClients.length}`);
  });
});

// ─── API routes ───────────────────────────────────────────────────────────────
app.use("/api", require("./routes/po"));
app.use("/api/ai", require("./routes/ai"));

// ─── Catch-all: serve frontend ────────────────────────────────────────────────
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/index.html"));
});

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
  console.log(`SAP mode: ${process.env.USE_MOCK !== "false" ? "MOCK" : "LIVE via Flow MCP"}`);
});
