"use strict";

const express = require("express");
const router  = express.Router();
const mcp     = require("../services/mcpClient");

function broadcast(req, event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  req.app.locals.sseClients.forEach(res => res.write(payload));
}

// GET /api/pos — list POs pending approval (proxies to MCP)
router.get("/pos", async (req, res) => {
  try {
    const { releaseCode, fromDate, toDate } = req.query;
    const result = await mcp.getPendingPOs(releaseCode, fromDate, toDate);
    res.json(result);
  } catch (err) {
    console.error("[GET /pos]", err.message);
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

// POST /api/po/create — create new PO (MUST be before /po/:id routes)
router.post("/po/create", async (req, res) => {
  const { vendor, companyCode, purchOrg, purchGroup, docType, docDate, currency, deliveryDate, items } = req.body;
  
  console.log(`[POST /po/create] Received data:`, JSON.stringify({ 
    vendor, companyCode, purchOrg, purchGroup, docType, docDate, currency, deliveryDate, 
    itemCount: items?.length 
  }, null, 2));
  
  if (!vendor || !companyCode || !purchOrg || !purchGroup) {
    return res.status(400).json({ success: false, error: "vendor, companyCode, purchOrg, and purchGroup are required" });
  }
  
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, error: "items array is required and must not be empty" });
  }

  try {
    const result = await mcp.createPO({ vendor, companyCode, purchOrg, purchGroup, docType, docDate, currency, deliveryDate, items });
    res.json(result);
  } catch (err) {
    console.error("[POST /po/create]", err.message);
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

// GET /api/po/:id — full PO details (proxies to MCP)
router.get("/po/:id", async (req, res) => {
  try {
    const result = await mcp.getPODetail(req.params.id);
    res.json(result);
  } catch (err) {
    console.error("[GET /po/:id]", err.message);
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

// POST /api/po/:id/approve — validate, call MCP, emit SSE
router.post("/po/:id/approve", async (req, res) => {
  const { releaseCode } = req.body;
  console.log(`[POST /approve] Raw releaseCode from body:`, JSON.stringify(releaseCode));
  console.log(`[POST /approve] releaseCode type:`, typeof releaseCode);
  console.log(`[POST /approve] releaseCode charCodes:`, releaseCode ? Array.from(releaseCode).map(c => c.charCodeAt(0)) : 'null');
  
  if (!releaseCode || typeof releaseCode !== "string" || !releaseCode.trim()) {
    return res.status(400).json({ success: false, error: "releaseCode is required" });
  }

  try {
    const cleanCode = releaseCode.trim().toUpperCase();
    console.log(`[POST /approve] Cleaned releaseCode:`, cleanCode);
    console.log(`[POST /approve] Cleaned charCodes:`, Array.from(cleanCode).map(c => c.charCodeAt(0)));
    
    const result = await mcp.approvePO(req.params.id, cleanCode);
    broadcast(req, "po_released", { ebeln: req.params.id, releaseCode: cleanCode, message: result.message });
    res.json(result);
  } catch (err) {
    console.error("[POST /approve]", err.message);
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

// POST /api/po/:id/reject — validate, call MCP, emit SSE
router.post("/po/:id/reject", async (req, res) => {
  const { releaseCode } = req.body;
  if (!releaseCode || typeof releaseCode !== "string" || !releaseCode.trim()) {
    return res.status(400).json({ success: false, error: "releaseCode is required" });
  }

  try {
    const result = await mcp.rejectPO(req.params.id, releaseCode.trim().toUpperCase());
    broadcast(req, "po_rejected", { ebeln: req.params.id, releaseCode, message: result.message });
    res.json(result);
  } catch (err) {
    console.error("[POST /reject]", err.message);
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

// GET /api/vendors — list all vendors
router.get("/vendors", async (req, res) => {
  try {
    const result = await mcp.getVendorList();
    res.json(result); // MCP already returns { success: true, data: [...] }
  } catch (err) {
    console.error("[GET /vendors]", err.message);
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

// GET /api/vendor/:vendorId/performance — get vendor performance metrics
router.get("/vendor/:vendorId/performance", async (req, res) => {
  try {
    const result = await mcp.getVendorPerformance(req.params.vendorId);
    res.json(result); // MCP already returns { success: true, data: {...} }
  } catch (err) {
    console.error("[GET /vendor/:vendorId/performance]", err.message);
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

// ─── Purchase Requisition Routes ──────────────────────────────────────────────

// GET /api/prs — list purchase requisitions
router.get("/prs", async (req, res) => {
  try {
    const { fromDate, toDate } = req.query;
    const result = await mcp.getPurchaseRequisitions(fromDate, toDate);
    res.json(result);
  } catch (err) {
    console.error("[GET /prs]", err.message);
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

// GET /api/pr/:id — get PR details
router.get("/pr/:id", async (req, res) => {
  try {
    const result = await mcp.getPRDetail(req.params.id);
    res.json(result);
  } catch (err) {
    console.error("[GET /pr/:id]", err.message);
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

// POST /api/pr/:id/create-po — create PO from PR
router.post("/pr/:id/create-po", async (req, res) => {
  const { vendor, companyCode, purchOrg, purchGroup, docType, docDate, currency, deliveryDate, items } = req.body;
  
  console.log(`[POST /pr/:id/create-po] Creating PO from PR ${req.params.id}`);
  
  if (!companyCode || !purchOrg) {
    return res.status(400).json({ success: false, error: "companyCode and purchOrg are required" });
  }

  try {
    const result = await mcp.createPOFromPR({
      prNumber: req.params.id,
      vendor,
      companyCode,
      purchOrg,
      purchGroup,
      docType,
      docDate,
      currency,
      deliveryDate,
      items
    });
    res.json(result);
  } catch (err) {
    console.error("[POST /pr/:id/create-po]", err.message);
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

module.exports = router;
