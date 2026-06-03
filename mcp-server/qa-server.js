"use strict";

/**
 * QA MCP Server — JSON-RPC 2.0 server for SAP ECC PO operations.
 *
 * This is the QA variant of server.js, configured to connect to the
 * Pillir Flow QA endpoint: https://qa.flow.pillir.ai/mcp/sse
 *
 * Headers required by the QA endpoint:
 *   X-FLOW-API-KEY       — from FLOW_API_KEY env var
 *   mcp-protocol-version — fixed to "2024-11-05"
 *
 * Single endpoint:  POST /mcp/rpc
 * Health check:     GET  /mcp/health
 *
 * Supported methods:
 *   po.getPendingPOs  { releaseCode?, fromDate?, toDate? }
 *   po.getPODetails   { ebeln }
 *   po.approvePO      { ebeln, releaseCode }
 *   po.rejectPO       { ebeln, releaseCode }
 *   po.createPO       { vendor, companyCode, purchOrg, purchGroup, ... }
 *   po.getVendorPerformance { vendorId }
 *   po.getVendorList  {}
 *   pr.getPurchaseRequisitions { fromDate?, toDate? }
 *   pr.getPRDetail    { banfn }
 *   pr.createPOFromPR { prNumber, companyCode, purchOrg, ... }
 */

// Load environment variables from parent directory
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

// FLOW_MCP_URL and FLOW_API_KEY are already set to QA values in .env.
// sapClientQa adds the extra "mcp-protocol-version: 2024-11-05" header
// required by the QA endpoint on top of the standard sapClient logic.

const express = require("express");
const sap     = require("./sap/sapClientQa");

const app  = express();
const PORT = process.env.MCP_PORT || 3001;

app.use(express.json());

// ─── JSON-RPC error codes ─────────────────────────────────────────────────────
const RPC_ERRORS = {
  PARSE_ERROR:      { code: -32700, message: "Parse error" },
  INVALID_REQUEST:  { code: -32600, message: "Invalid Request" },
  METHOD_NOT_FOUND: { code: -32601, message: "Method not found" },
  INVALID_PARAMS:   { code: -32602, message: "Invalid params" },
  INTERNAL_ERROR:   { code: -32603, message: "Internal error" },
  NOT_FOUND:        { code: -32000, message: "Not found" },
  ALREADY_APPROVED: { code: -32001, message: "Already approved" },
  ALREADY_REJECTED: { code: -32002, message: "Already rejected" },
  INVALID_RELEASE:  { code: -32003, message: "Invalid release code" },
  SAP_ERROR:        { code: -32004, message: "SAP error" }
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function rpcSuccess(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, { code, message }, data) {
  const error = { code, message };
  if (data) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

function classifyError(err) {
  const msg = err.message || "";
  if (msg.includes("not found"))       return RPC_ERRORS.NOT_FOUND;
  if (msg.includes("already") && msg.includes("approved")) return RPC_ERRORS.ALREADY_APPROVED;
  if (msg.includes("already") && msg.includes("rejected")) return RPC_ERRORS.ALREADY_REJECTED;
  if (msg.includes("already"))         return RPC_ERRORS.ALREADY_APPROVED;
  if (msg.includes("Invalid release")) return RPC_ERRORS.INVALID_RELEASE;
  return RPC_ERRORS.SAP_ERROR;
}

// ─── Method registry ──────────────────────────────────────────────────────────
const methods = {

  "po.getPendingPOs": async (params = {}) => {
    const pos = await sap.getPendingPOs(params.releaseCode || null, params.fromDate, params.toDate);
    return { success: true, data: pos };
  },

  "po.getPODetails": async (params = {}) => {
    if (!params.ebeln) throw Object.assign(new Error("ebeln is required"), { rpc: RPC_ERRORS.INVALID_PARAMS });
    const po = await sap.getPODetail(params.ebeln);
    return { success: true, data: po };
  },

  "po.approvePO": async (params = {}) => {
    if (!params.ebeln)       throw Object.assign(new Error("ebeln is required"),       { rpc: RPC_ERRORS.INVALID_PARAMS });
    if (!params.releaseCode) throw Object.assign(new Error("releaseCode is required"), { rpc: RPC_ERRORS.INVALID_PARAMS });
    const result = await sap.approvePO(params.ebeln, params.releaseCode.trim().toUpperCase());
    return result;
  },

  "po.rejectPO": async (params = {}) => {
    if (!params.ebeln)       throw Object.assign(new Error("ebeln is required"),       { rpc: RPC_ERRORS.INVALID_PARAMS });
    if (!params.releaseCode) throw Object.assign(new Error("releaseCode is required"), { rpc: RPC_ERRORS.INVALID_PARAMS });
    const result = await sap.rejectPO(params.ebeln, params.releaseCode.trim().toUpperCase());
    return result;
  },

  "po.createPO": async (params = {}) => {
    if (!params.vendor)      throw Object.assign(new Error("vendor is required"),      { rpc: RPC_ERRORS.INVALID_PARAMS });
    if (!params.companyCode) throw Object.assign(new Error("companyCode is required"), { rpc: RPC_ERRORS.INVALID_PARAMS });
    if (!params.purchOrg)    throw Object.assign(new Error("purchOrg is required"),    { rpc: RPC_ERRORS.INVALID_PARAMS });
    if (!params.purchGroup)  throw Object.assign(new Error("purchGroup is required"),  { rpc: RPC_ERRORS.INVALID_PARAMS });
    if (!params.items || !Array.isArray(params.items) || params.items.length === 0) {
      throw Object.assign(new Error("items array is required and must not be empty"), { rpc: RPC_ERRORS.INVALID_PARAMS });
    }
    const result = await sap.createPO(params);
    return result;
  },

  "po.getVendorPerformance": async (params = {}) => {
    if (!params.vendorId) throw Object.assign(new Error("vendorId is required"), { rpc: RPC_ERRORS.INVALID_PARAMS });
    const result = await sap.getVendorPerformance(params.vendorId);
    return { success: true, data: result };
  },

  "po.getVendorList": async (params = {}) => {
    const vendors = await sap.getVendorList();
    return { success: true, data: vendors };
  },

  "pr.getPurchaseRequisitions": async (params = {}) => {
    const prs = await sap.getPurchaseRequisitions(params.fromDate, params.toDate);
    return { success: true, data: prs };
  },

  "pr.getPRDetail": async (params = {}) => {
    if (!params.banfn) throw Object.assign(new Error("banfn is required"), { rpc: RPC_ERRORS.INVALID_PARAMS });
    const pr = await sap.getPRDetail(params.banfn);
    return { success: true, data: pr };
  },

  "pr.createPOFromPR": async (params = {}) => {
    if (!params.prNumber)    throw Object.assign(new Error("prNumber is required"),    { rpc: RPC_ERRORS.INVALID_PARAMS });
    if (!params.companyCode) throw Object.assign(new Error("companyCode is required"), { rpc: RPC_ERRORS.INVALID_PARAMS });
    if (!params.purchOrg)    throw Object.assign(new Error("purchOrg is required"),    { rpc: RPC_ERRORS.INVALID_PARAMS });
    const result = await sap.createPOFromPR(params.prNumber, params);
    return result;
  }
};

// ─── POST /mcp/rpc — JSON-RPC 2.0 dispatcher ─────────────────────────────────
app.post("/mcp/rpc", async (req, res) => {
  const body = req.body;

  if (!body || body.jsonrpc !== "2.0" || !body.method) {
    return res.status(400).json(rpcError(body?.id ?? null, RPC_ERRORS.INVALID_REQUEST));
  }

  const { id = null, method, params = {} } = body;

  const handler = methods[method];
  if (!handler) {
    console.warn(`[QA-RPC] Unknown method: ${method}`);
    return res.json(rpcError(id, RPC_ERRORS.METHOD_NOT_FOUND, { method }));
  }

  try {
    const result = await handler(params);
    console.log(`[QA-RPC] ${method} → OK`);
    return res.json(rpcSuccess(id, result));
  } catch (err) {
    const rpcErr = err.rpc || classifyError(err);
    console.error(`[QA-RPC] ${method} → ERROR ${rpcErr.code}: ${err.message}`);
    console.error(`[QA-RPC] Params:`, JSON.stringify(params, null, 2));
    console.error(`[QA-RPC] Stack:`, err.stack);
    return res.json(rpcError(id, rpcErr, { detail: err.message }));
  }
});

// ─── GET /mcp/health ──────────────────────────────────────────────────────────
app.get("/mcp/health", (_req, res) => {
  res.json({
    status:      "ok",
    variant:     "QA",
    protocol:    "JSON-RPC 2.0",
    flowUrl:     process.env.FLOW_MCP_URL,
    mode:        process.env.USE_MOCK !== "false" ? "mock" : "live",
    methods:     Object.keys(methods),
    ts:          new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`QA MCP Server (JSON-RPC 2.0) running on http://localhost:${PORT}`);
  console.log(`Endpoint:  POST http://localhost:${PORT}/mcp/rpc`);
  console.log(`Flow URL:  ${process.env.FLOW_MCP_URL}`);
  console.log(`Headers:   X-FLOW-API-KEY + mcp-protocol-version: 2024-11-05`);
  console.log(`SAP Mode:  ${process.env.USE_MOCK !== "false" ? "MOCK" : "LIVE"}`);
});
