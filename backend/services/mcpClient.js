"use strict";

/**                  st
 * MCP Client — calls the MCP server over JSON-RPC 2.0 / HTTP.
 * All SAP access goes through the MCP server; sapClient is never imported directly.
 */

const MCP_BASE = `http://localhost:${process.env.MCP_PORT || 3001}`;
const MCP_RPC  = `${MCP_BASE}/mcp/rpc`;

let _rpcId = 0;

async function rpcCall(method, params = {}) {
  const id = ++_rpcId;
  const res = await fetch(MCP_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
  });

  const json = await res.json();

  if (json.error) {
    const err = new Error(json.error.data?.detail || json.error.message);
    err.statusCode = json.error.code === -32602 ? 400 : 500;
    throw err;
  }

  return json.result;
}

async function getPendingPOs(releaseCode, fromDate, toDate) {
  return rpcCall("po.getPendingPOs", { releaseCode, fromDate, toDate });
}

async function getPODetail(ebeln) {
  return rpcCall("po.getPODetails", { ebeln });
}

async function approvePO(ebeln, releaseCode) {
  return rpcCall("po.approvePO", { ebeln, releaseCode });
}

async function rejectPO(ebeln, releaseCode) {
  return rpcCall("po.rejectPO", { ebeln, releaseCode });
}

async function createPO(poData) {
  return rpcCall("po.createPO", poData);
}

async function getVendorPerformance(vendorId) {
  return rpcCall("po.getVendorPerformance", { vendorId });
}

async function getVendorList() {
  return rpcCall("po.getVendorList");
}

async function getPurchaseRequisitions(fromDate, toDate) {
  return rpcCall("pr.getPurchaseRequisitions", { fromDate, toDate });
}

async function getPRDetail(banfn) {
  return rpcCall("pr.getPRDetail", { banfn });
}

async function createPOFromPR(prData) {
  return rpcCall("pr.createPOFromPR", prData);
}

module.exports = { 
  getPendingPOs, 
  getPODetail, 
  approvePO, 
  rejectPO, 
  createPO, 
  getVendorPerformance, 
  getVendorList,
  getPurchaseRequisitions,
  getPRDetail,
  createPOFromPR
};
