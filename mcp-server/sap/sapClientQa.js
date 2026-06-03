"use strict";

/**
 * QA SAP client — per-request StreamableHTTPClientTransport pattern.
 *
 * Uses the steps[] array format for execute_function, matching the
 * reference server implementation that works with qa.flow.pillir.ai.
 *
 * Key difference from sapClient.js:
 *  - Creates a fresh MCP client + transport per BAPI call (no persistent connection)
 *  - Uses steps[] / request / response format instead of direct BAPI args
 *  - Connects to FLOW_MCP_URL with X-FLOW-API-KEY + mcp-protocol-version headers
 */

const USE_MOCK = process.env.USE_MOCK !== "false";

const FLOW_API_KEY = process.env.FLOW_API_KEY || "";
const FLOW_MCP_URL = process.env.FLOW_MCP_URL || "";

const CALL_TIMEOUT_MS    = parseInt(process.env.CALL_TIMEOUT_MS    || "180000");
const CONNECT_TIMEOUT_MS = parseInt(process.env.CONNECT_TIMEOUT_MS || "30000");

// ─── Date helpers ─────────────────────────────────────────────────────────────
function convertToDDMMYYYY(dateStr) {
  if (!dateStr) return "";
  if (/^\d{2}\.\d{2}\.\d{4}$/.test(dateStr)) return dateStr;
  try {
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) {
      return `${String(d.getDate()).padStart(2,"0")}.${String(d.getMonth()+1).padStart(2,"0")}.${d.getFullYear()}`;
    }
  } catch (_) {}
  const parts = String(dateStr).split("-");
  if (parts.length === 3) {
    const [year, month, day] = parts;
    return `${day.padStart(2,"0")}.${month.padStart(2,"0")}.${year}`;
  }
  return dateStr;
}

function convertToYYYYMMDD(dateStr) {
  if (!dateStr) return "";
  if (/^\d{8}$/.test(dateStr)) return dateStr;
  try {
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) {
      return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`;
    }
  } catch (_) {}
  const parts = String(dateStr).split("-");
  if (parts.length === 3) {
    const [year, month, day] = parts;
    return `${year}${month.padStart(2,"0")}${day.padStart(2,"0")}`;
  }
  return dateStr;
}

// ─── Core: per-request MCP call using steps[] format ─────────────────────────
async function sapCall(steps, request = {}, response = {}) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

  const client    = new Client({ name: "po-approval-app-qa", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(FLOW_MCP_URL), {
    requestInit: {
      headers: {
        "X-FLOW-API-KEY":        FLOW_API_KEY,
        "Content-Type":          "application/json",
        "Cache-Control":         "no-cache",
        "mcp-protocol-version":  "2024-11-05"
      }
    }
  });

  const start = Date.now();
  console.log(`[QA-MCP] Connecting to ${FLOW_MCP_URL}...`);

  await Promise.race([
    client.connect(transport),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`connect() timed out after ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS)
    )
  ]);

  console.log(`[QA-MCP] Connected (${Date.now() - start}ms)`);

  try {
    const result = await client.callTool(
      { name: "execute_function", arguments: { steps, request, response } },
      undefined,
      { timeout: CALL_TIMEOUT_MS }
    );

    let textContent = result?.content?.find(c => c.type === "text");

    if (!textContent) {
      if (result?.type === "result" || result?.type === "error") {
        console.log(`[QA-MCP] Done (${Date.now() - start}ms)`);
        return result;
      }
      throw new Error("No text content in MCP response");
    }

    let parsed = JSON.parse(textContent.text);

    if (parsed?.content) {
      const inner = parsed.content.find(c => c.type === "text");
      if (inner) parsed = JSON.parse(inner.text);
    }

    console.log(`[QA-MCP] Done (${Date.now() - start}ms)`);

    if (parsed.type === "result" || parsed.type === "error") return parsed;
    return { type: "result", result: parsed };

  } finally {
    try { await client.close(); } catch (_) {}
  }
}

// ─── Simplified single-BAPI wrapper (no commit) ───────────────────────────────
async function callBAPI(functionName, inputData, expectedOutput = {}, options = {}) {
  console.log(`[QA-MCP] callBAPI: ${functionName}`);

  const result = await sapCall(
    [{
      step:    functionName,
      type:    "function",
      service: functionName,
      input:   inputData,
      output:  Object.fromEntries(
        Object.keys(expectedOutput).map(k => [k, `response.${k}`])
      )
    }],
    {},
    expectedOutput
  );

  if (result.type === "error") throw new Error(String(result.result) || "SAP error");

  const sapResult = result.result || {};

  if (!options.skipErrorCheck) {
    const ret  = sapResult.RETURN || [];
    const errs = (Array.isArray(ret) ? ret : [ret]).filter(r => r.TYPE === "E" || r.TYPE === "A");
    if (errs.length > 0) throw new Error(errs.map(e => e.MESSAGE).join("; "));
  }

  return sapResult;
}

// ─── Commit helper ────────────────────────────────────────────────────────────
async function sapCommit() {
  return sapCall([{ step: "Commit", type: "commit", service: "BAPI_TRANSACTION_COMMIT" }]);
}

// ─── getPendingPOs ────────────────────────────────────────────────────────────
async function getPendingPOs(userReleaseCode, fromDate, toDate) {
  if (USE_MOCK) {
    const { mockPOs, mockReleaseCodes } = require("../mock/mockData");
    return mockPOs
      .filter(po => {
        if (po.STATUS !== "PENDING") return false;
        if (fromDate || toDate) {
          const poDate = po.BEDAT;
          if (fromDate && poDate < convertToDDMMYYYY(fromDate)) return false;
          if (toDate   && poDate > convertToDDMMYYYY(toDate))   return false;
        }
        if (userReleaseCode) {
          const codes = mockReleaseCodes[po.EBELN] || [];
          return codes.includes(userReleaseCode.toUpperCase());
        }
        return true;
      })
      .map(({ items: _items, ...header }) => header);
  }

  const EKKO_FIELDS = ["EBELN","LIFNR","BUKRS","FRGKE","FRGZU","WAERS","BEDAT","EKGRP","EKORG"];

  const effectiveFromDate = fromDate || (() => {
    const d = new Date(); d.setFullYear(d.getFullYear() - 1);
    return d.toISOString().slice(0, 10);
  })();

  const fromDateSap = convertToYYYYMMDD(effectiveFromDate);
  const toDateSap   = toDate ? convertToYYYYMMDD(toDate) : null;

  const options = [`BEDAT GE '${fromDateSap}'`];
  if (toDateSap) options.push(`AND BEDAT LE '${toDateSap}'`);

  console.log(`[QA getPendingPOs] Date filter: ${options.join(" ")}`);

  const result = await callBAPI("RFC_READ_TABLE", {
    QUERY_TABLE: "EKKO",
    DELIMITER:   "|",
    FIELDS:      EKKO_FIELDS.map(f => ({ FIELDNAME: f })),
    OPTIONS:     options.map(text => ({ TEXT: text })),
    ROWCOUNT:    500
  }, {
    DATA:   [{ WA: "string" }],
    FIELDS: [{ FIELDNAME: "string" }],
    RETURN: [{ TYPE: "string", MESSAGE: "string" }]
  });

  console.log(`[QA getPendingPOs] Returned ${result.DATA?.length || 0} rows`);

  if (result.RETURN?.length > 0) {
    result.RETURN.forEach(m => console.log(`[QA getPendingPOs] SAP [${m.TYPE}]: ${m.MESSAGE}`));
    const errs = result.RETURN.filter(r => r.TYPE === "E" || r.TYPE === "A");
    if (errs.length > 0) throw new Error(errs.map(e => e.MESSAGE).join("; "));
  }

  const rows     = result.DATA   || [];
  const fields   = (result.FIELDS || []).map(f => f.FIELDNAME);
  const colNames = fields.length > 0 ? fields : EKKO_FIELDS;

  const pos = rows.map(row => {
    const parts = (row.WA || "").split("|");
    const rec = {};
    colNames.forEach((col, i) => { rec[col] = (parts[i] || "").trim(); });
    return rec;
  });

  return pos
    .filter(po => {
      const poDate = po.BEDAT;
      if (poDate < fromDateSap) return false;
      if (toDateSap && poDate > toDateSap) return false;
      if (userReleaseCode) return !(po.FRGKE || "").toUpperCase().includes(userReleaseCode.toUpperCase());
      return true;
    })
    .map(po => {
      const status = (po.FRGKE === "G" || po.FRGZU === "X") ? "APPROVED" : "PENDING";
      return {
        EBELN: po.EBELN, LIFNR: po.LIFNR, VENDOR_NAME: po.LIFNR,
        WAERS: po.WAERS, NETWR: 0, BEDAT: po.BEDAT,
        FRGKE: po.FRGKE, FRGZU: po.FRGZU, EKGRP: po.EKGRP,
        EKORG: po.EKORG, BUKRS: po.BUKRS, STATUS: status
      };
    });
}

// ─── getPODetail ──────────────────────────────────────────────────────────────
async function getPODetail(ebeln) {
  if (USE_MOCK) {
    const { mockPOs } = require("../mock/mockData");
    const po = mockPOs.find(p => p.EBELN === ebeln);
    if (!po) throw new Error(`PO ${ebeln} not found`);
    return po;
  }

  const ekkoResult = await callBAPI("RFC_READ_TABLE", {
    QUERY_TABLE: "EKKO", DELIMITER: "|",
    FIELDS: ["EBELN","LIFNR","WAERS","BEDAT","FRGKE","FRGZU","EKGRP","EKORG","BUKRS"].map(f => ({ FIELDNAME: f })),
    OPTIONS: [{ TEXT: `EBELN = '${ebeln}'` }], ROWCOUNT: 1
  }, { DATA: [{ WA: "string" }], FIELDS: [{ FIELDNAME: "string" }] });

  if (!ekkoResult.DATA?.length) throw new Error(`PO ${ebeln} not found`);

  const hp = ekkoResult.DATA[0].WA.split("|");
  const header = {
    EBELN: hp[0]?.trim(), LIFNR: hp[1]?.trim(), WAERS: hp[2]?.trim(),
    BEDAT: hp[3]?.trim(), FRGKE: hp[4]?.trim(), FRGZU: hp[5]?.trim(),
    EKGRP: hp[6]?.trim(), EKORG: hp[7]?.trim(), BUKRS: hp[8]?.trim()
  };

  const ekpoResult = await callBAPI("RFC_READ_TABLE", {
    QUERY_TABLE: "EKPO", DELIMITER: "|",
    FIELDS: ["EBELN","EBELP","TXZ01","MENGE","MEINS","NETPR","WERKS"].map(f => ({ FIELDNAME: f })),
    OPTIONS: [{ TEXT: `EBELN = '${ebeln}'` }], ROWCOUNT: 50
  }, { DATA: [{ WA: "string" }], FIELDS: [{ FIELDNAME: "string" }] });

  const items = (ekpoResult.DATA || []).map(row => {
    const p = row.WA.split("|");
    return {
      EBELP: p[1]?.trim(), TXZ01: p[2]?.trim(),
      MENGE: parseFloat(p[3]?.trim() || 0), MEINS: p[4]?.trim(),
      NETPR: parseFloat(p[5]?.trim() || 0), WERKS: p[6]?.trim()
    };
  });

  const status = (header.FRGKE === "G" || header.FRGZU === "X") ? "APPROVED" : "PENDING";

  return {
    ...header, VENDOR_NAME: header.LIFNR,
    NETWR: items.reduce((s, i) => s + i.MENGE * i.NETPR, 0),
    STATUS: status, items
  };
}

// ─── approvePO ────────────────────────────────────────────────────────────────
async function approvePO(ebeln, releaseCode) {
  if (USE_MOCK) {
    const { mockPOs, mockReleaseCodes } = require("../mock/mockData");
    const po = mockPOs.find(p => p.EBELN === ebeln);
    if (!po) throw new Error(`PO ${ebeln} not found`);
    if (po.STATUS === "APPROVED") throw new Error("PO is already fully approved");
    const validCodes = mockReleaseCodes[ebeln] || [];
    if (!validCodes.includes(releaseCode)) throw new Error(`Invalid release code '${releaseCode}' for PO ${ebeln}`);
    po.STATUS = "APPROVED"; po.FRGKE = "9";
    return { success: true, message: `PO ${ebeln} approved with release code ${releaseCode}` };
  }

  // Use steps[] with commit
  const result = await sapCall([
    {
      step: "Release PO", type: "function", service: "BAPI_PO_RELEASE",
      input: { PURCHASEORDER: ebeln, PO_REL_CODE: releaseCode, USE_EXCEPTIONS: "X", NO_COMMIT: "" },
      output: {
        RETURN:            "response.return",
        REL_STATUS_NEW:    "response.relStatusNew",
        REL_INDICATOR_NEW: "response.relIndicatorNew"
      }
    },
    { step: "Commit", type: "commit", service: "BAPI_TRANSACTION_COMMIT" }
  ], {}, {
    return:            [{ TYPE: "string", MESSAGE: "string", ID: "string", NUMBER: "string" }],
    relStatusNew:      "string",
    relIndicatorNew:   "string"
  });

  if (result.type === "error") throw new Error(String(result.result) || "SAP error");

  const ret = result.result?.return || [];
  const returnTable = Array.isArray(ret) ? ret : [ret];
  const errors = returnTable.filter(r => r.TYPE === "E" || r.TYPE === "A");
  if (errors.length > 0) throw new Error(errors.map(e => e.MESSAGE).join("; "));

  const successMsgs = returnTable.filter(r => r.TYPE === "S");
  const message = successMsgs.length > 0
    ? successMsgs.map(m => m.MESSAGE).join("; ")
    : `PO ${ebeln} release processed. Status: ${result.result?.relStatusNew || "processed"}`;

  return { success: true, message, messages: returnTable,
    relStatusNew: result.result?.relStatusNew, relIndicatorNew: result.result?.relIndicatorNew };
}

// ─── rejectPO ─────────────────────────────────────────────────────────────────
async function rejectPO(ebeln, releaseCode) {
  if (USE_MOCK) {
    const { mockPOs } = require("../mock/mockData");
    const po = mockPOs.find(p => p.EBELN === ebeln);
    if (!po) throw new Error(`PO ${ebeln} not found`);
    if (po.STATUS === "REJECTED") throw new Error("PO is already rejected");
    po.STATUS = "REJECTED"; po.FRGKE = "0"; po.FRGZU = "";
    return { success: true, message: `PO ${ebeln} release reset (rejected)` };
  }

  const result = await sapCall([
    {
      step: "Reset Release", type: "function", service: "BAPI_PO_RESET_RELEASE",
      input: { PURCHASEORDER: ebeln, PO_REL_CODE: releaseCode, USE_EXCEPTIONS: "X", NO_COMMIT: "" },
      output: {
        RETURN:            "response.return",
        REL_STATUS_NEW:    "response.relStatusNew",
        REL_INDICATOR_NEW: "response.relIndicatorNew"
      }
    },
    { step: "Commit", type: "commit", service: "BAPI_TRANSACTION_COMMIT" }
  ], {}, {
    return:          [{ TYPE: "string", MESSAGE: "string", ID: "string", NUMBER: "string" }],
    relStatusNew:    "string",
    relIndicatorNew: "string"
  });

  if (result.type === "error") throw new Error(String(result.result) || "SAP error");

  const ret = result.result?.return || [];
  const returnTable = Array.isArray(ret) ? ret : [ret];
  const errors = returnTable.filter(r => r.TYPE === "E" || r.TYPE === "A");
  if (errors.length > 0) throw new Error(errors.map(e => e.MESSAGE).join("; "));

  const successMsgs = returnTable.filter(r => r.TYPE === "S");
  const message = successMsgs.length > 0
    ? successMsgs.map(m => m.MESSAGE).join("; ")
    : `PO ${ebeln} release reset successfully`;

  return { success: true, message, messages: returnTable };
}

// ─── createPO ─────────────────────────────────────────────────────────────────
async function createPO(poData) {
  if (USE_MOCK) {
    const { mockPOs } = require("../mock/mockData");
    const maxEbeln = Math.max(...mockPOs.map(p => parseInt(p.EBELN)));
    const newEbeln = String(maxEbeln + 1);
    const newPO = {
      EBELN: newEbeln, LIFNR: poData.vendor, VENDOR_NAME: poData.vendor,
      WAERS: poData.currency || "USD",
      NETWR: poData.items.reduce((s, i) => s + i.quantity * i.netPrice, 0),
      BEDAT: convertToDDMMYYYY(poData.docDate || new Date().toISOString().slice(0,10)),
      FRGKE: "0", FRGZU: "", EKGRP: poData.purchGroup, EKORG: poData.purchOrg,
      BUKRS: poData.companyCode, STATUS: "PENDING", releaseSteps: [],
      items: poData.items.map((item, idx) => ({
        EBELP: String((idx+1)*10).padStart(5,"0"), TXZ01: item.description,
        MENGE: item.quantity, MEINS: item.unit, NETPR: item.netPrice, WERKS: item.plant
      }))
    };
    mockPOs.push(newPO);
    return { success: true, poNumber: newEbeln, message: `PO ${newEbeln} created successfully` };
  }

  const poHeader = {
    COMP_CODE: poData.companyCode, DOC_TYPE: poData.docType || "NB",
    VENDOR: poData.vendor, PURCH_ORG: poData.purchOrg, PUR_GROUP: poData.purchGroup,
    CURRENCY: poData.currency || "EUR"
  };
  const poHeaderX = { COMP_CODE:"X", DOC_TYPE:"X", VENDOR:"X", PURCH_ORG:"X", PUR_GROUP:"X", CURRENCY:"X" };

  const poItems = poData.items.map((item, idx) => ({
    PO_ITEM:    String((idx+1)*10).padStart(5,"0"),
    MATERIAL:   item.material || "",
    SHORT_TEXT: item.description,
    PLANT:      item.plant,
    STORAGE_LOC: item.storageLocation || "",
    QUANTITY:   String(item.quantity),
    PO_UNIT:    item.unit,
    NET_PRICE:  String(item.netPrice),
    PRICE_UNIT: "1",
    ...(item.prNumber && item.prItem ? {
      PREQ_NO:   String(item.prNumber).padStart(10,"0"),
      PREQ_ITEM: String(item.prItem).padStart(5,"0")
    } : {})
  }));

  const poItemsX = poItems.map(item => ({
    PO_ITEM:    item.PO_ITEM, MATERIAL: item.MATERIAL ? "X" : "",
    SHORT_TEXT: "X", PLANT: "X", STORAGE_LOC: item.STORAGE_LOC ? "X" : "",
    QUANTITY: "X", PO_UNIT: "X", NET_PRICE: "X", PRICE_UNIT: "X",
    ...(item.PREQ_NO ? { PREQ_NO: "X", PREQ_ITEM: "X" } : {})
  }));

  const deliveryDate = poData.deliveryDate || (() => {
    const d = new Date(); d.setDate(d.getDate() + 7);
    return d.toISOString().slice(0,10);
  })();
  const deliveryDateFmt = convertToYYYYMMDD(deliveryDate);

  const poSchedules  = poData.items.map((_, idx) => ({
    PO_ITEM: String((idx+1)*10).padStart(5,"0"), SCHED_LINE: "0001",
    DELIVERY_DATE: deliveryDateFmt, QUANTITY: String(poData.items[idx].quantity)
  }));
  const poSchedulesX = poSchedules.map(s => ({ ...s, DELIVERY_DATE: "X", QUANTITY: "X" }));

  const bapiInput = {
    POHEADER: poHeader, POHEADERX: poHeaderX,
    POITEM: poItems, POITEMX: poItemsX,
    POSCHEDULE: poSchedules, POSCHEDULEX: poSchedulesX
  };

  const result = await sapCall([
    {
      step: "Create PO", type: "function", service: "BAPI_PO_CREATE1",
      input: bapiInput,
      output: { EXPPURCHASEORDER: "response.poNumber", RETURN: "response.return" }
    },
    { step: "Commit", type: "commit", service: "BAPI_TRANSACTION_COMMIT" }
  ], {}, {
    poNumber: "string",
    return: [{ TYPE: "string", MESSAGE: "string", ID: "string", NUMBER: "string" }]
  });

  if (result.type === "error") throw new Error(String(result.result) || "SAP error");

  const returnTable = Array.isArray(result.result?.return) ? result.result.return : [];
  let poNumber = result.result?.poNumber;
  if (Array.isArray(poNumber) || !poNumber) poNumber = null;
  if (typeof poNumber === "string") poNumber = poNumber.trim() || null;

  if (!poNumber) {
    const successMsg = returnTable.find(m => m.TYPE === "S" && m.MESSAGE?.includes("created under the number"));
    if (successMsg) {
      const match = successMsg.MESSAGE.match(/\d{10}/);
      if (match) poNumber = match[0];
    }
  }

  const errors = returnTable.filter(r => r.TYPE === "E" || r.TYPE === "A");
  if (!poNumber && errors.length > 0) throw new Error(errors.map(e => e.MESSAGE).join("; "));
  if (!poNumber) throw new Error("PO creation failed - no PO number returned");

  return {
    success: true, poNumber,
    message: `PO ${poNumber} created successfully`,
    messages: returnTable,
    warnings: returnTable.filter(r => r.TYPE === "W").map(w => w.MESSAGE),
    errors:   errors.map(e => e.MESSAGE),
    info:     returnTable.filter(r => r.TYPE === "I").map(i => i.MESSAGE)
  };
}

// ─── getVendorPerformance ─────────────────────────────────────────────────────
async function getVendorPerformance(vendorId) {
  if (USE_MOCK) {
    return { vendorId, vendorName: `Vendor ${vendorId}`, totalPOs: 0, totalSpend: 0,
      currency: "EUR", avgDeliveryDelay: 0, onTimeDeliveryPercent: 0, poList: [] };
  }
  const normalizedVendorId = String(vendorId).replace(/^0+/,"").padStart(10,"0");
  const oneYearAgo = new Date(); oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const fromDateSap = oneYearAgo.toISOString().slice(0,10).replace(/-/g,"");

  const ekkoResult = await callBAPI("RFC_READ_TABLE", {
    QUERY_TABLE: "EKKO", DELIMITER: "|",
    FIELDS: ["EBELN","LIFNR","BEDAT","WAERS"].map(f => ({ FIELDNAME: f })),
    OPTIONS: [{ TEXT: `LIFNR = '${normalizedVendorId}'` }, { TEXT: `AND BEDAT GE '${fromDateSap}'` }],
    ROWCOUNT: 200
  }, { DATA: [{ WA: "string" }], FIELDS: [{ FIELDNAME: "string" }] });

  const poRows = ekkoResult.DATA || [];
  if (!poRows.length) return { vendorId, vendorName: `Vendor ${vendorId}`, totalPOs: 0,
    totalSpend: 0, currency: "EUR", avgDeliveryDelay: 0, onTimeDeliveryPercent: 0, poList: [] };

  const poNumbers = []; let currency = "EUR";
  poRows.forEach(row => {
    const parts = row.WA.split("|");
    if (parts[0]?.trim()) poNumbers.push(parts[0].trim());
    if (parts[3]?.trim()) currency = parts[3].trim();
  });

  return { vendorId, vendorName: `Vendor ${vendorId}`, totalPOs: poNumbers.length,
    totalSpend: 0, currency, avgDeliveryDelay: 0, onTimeDeliveryPercent: 0, poList: [] };
}

// ─── getVendorList ────────────────────────────────────────────────────────────
async function getVendorList() {
  if (USE_MOCK) return [{ vendorId: "1000", vendorName: "Vendor 1000" }];
  try {
    const oneYearAgo = new Date(); oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const fromDateSap = oneYearAgo.toISOString().slice(0,10).replace(/-/g,"");
    const result = await callBAPI("RFC_READ_TABLE", {
      QUERY_TABLE: "EKKO", DELIMITER: "|",
      FIELDS: [{ FIELDNAME: "LIFNR" }],
      OPTIONS: [{ TEXT: `BEDAT GE '${fromDateSap}'` }], ROWCOUNT: 500
    }, { DATA: [{ WA: "string" }], FIELDS: [{ FIELDNAME: "string" }] });

    const vendorSet = new Set();
    (result.DATA || []).forEach(row => {
      const v = row.WA?.split("|")[0]?.trim();
      if (v) vendorSet.add(v);
    });
    return Array.from(vendorSet).map(v => ({ vendorId: v, vendorName: `Vendor ${v}` }));
  } catch (err) {
    console.error("[QA getVendorList] Error:", err.message);
    return [];
  }
}

// ─── getPurchaseRequisitions ──────────────────────────────────────────────────
async function getPurchaseRequisitions(fromDate, toDate) {
  if (USE_MOCK) return [];
  const effectiveFromDate = fromDate || (() => {
    const d = new Date(); d.setFullYear(d.getFullYear() - 1);
    return d.toISOString().slice(0,10);
  })();
  const fromDateSap = convertToYYYYMMDD(effectiveFromDate);
  const toDateSap   = toDate ? convertToYYYYMMDD(toDate) : convertToYYYYMMDD(new Date().toISOString().slice(0,10));

  const result = await callBAPI("RFC_READ_TABLE", {
    QUERY_TABLE: "EBAN", DELIMITER: "|",
    FIELDS: ["BANFN","BNFPO","TXZ01","MENGE","MEINS","PREIS","PEINH","WAERS","WERKS","ERDAT","ERNAM","EBELN"].map(f => ({ FIELDNAME: f })),
    OPTIONS: [{ TEXT: `ERDAT GE '${fromDateSap}'` }, { TEXT: `AND ERDAT LE '${toDateSap}'` }, { TEXT: `AND EBELN = ''` }],
    ROWCOUNT: 500
  }, { DATA: [{ WA: "string" }], FIELDS: [{ FIELDNAME: "string" }] });

  const prMap = new Map();
  (result.DATA || []).forEach(row => {
    const p = row.WA.split("|");
    const banfn = p[0]?.trim(); if (!banfn) return;
    if (!prMap.has(banfn)) prMap.set(banfn, {
      BANFN: banfn, ERNAM: p[10]?.trim(), ERDAT: p[9]?.trim(),
      WAERS: p[7]?.trim() || "USD", TOTAL_VALUE: 0, STATUS: "OPEN", items: []
    });
    const pr = prMap.get(banfn);
    const menge = parseFloat(p[3]?.trim() || 0);
    const preis = parseFloat(p[5]?.trim() || 0);
    const peinh = parseFloat(p[6]?.trim() || 1);
    pr.TOTAL_VALUE += menge * (preis / peinh);
    pr.items.push({ BNFPO: p[1]?.trim(), TXZ01: p[2]?.trim(), MENGE: menge,
      MEINS: p[4]?.trim(), PREIS: preis/peinh, WERKS: p[8]?.trim() });
  });

  return Array.from(prMap.values()).map(pr => ({ ...pr, ITEM_COUNT: pr.items.length }));
}

// ─── getPRDetail ──────────────────────────────────────────────────────────────
async function getPRDetail(banfn) {
  if (USE_MOCK) return null;
  const result = await callBAPI("RFC_READ_TABLE", {
    QUERY_TABLE: "EBAN", DELIMITER: "|",
    FIELDS: ["BANFN","BNFPO","TXZ01","MENGE","MEINS","PREIS","PEINH","WAERS","WERKS","ERDAT","ERNAM","MATNR","LGORT","EKGRP"].map(f => ({ FIELDNAME: f })),
    OPTIONS: [{ TEXT: `BANFN = '${banfn}'` }], ROWCOUNT: 100
  }, { DATA: [{ WA: "string" }], FIELDS: [{ FIELDNAME: "string" }] });

  if (!result.DATA?.length) throw new Error(`PR ${banfn} not found`);

  let totalValue = 0, ernam = "", erdat = "", waers = "USD", ekgrp = "";
  const items = result.DATA.map(row => {
    const p = row.WA.split("|");
    if (!ernam) ernam = p[10]?.trim();
    if (!erdat) erdat = p[9]?.trim();
    if (p[7]?.trim()) waers = p[7].trim();
    if (p[13]?.trim()) ekgrp = p[13].trim();
    const menge = parseFloat(p[3]?.trim() || 0);
    const preis = parseFloat(p[5]?.trim() || 0) / parseFloat(p[6]?.trim() || 1);
    totalValue += menge * preis;
    return { BNFPO: p[1]?.trim(), TXZ01: p[2]?.trim(), MENGE: menge,
      MEINS: p[4]?.trim(), PREIS: preis, WERKS: p[8]?.trim(),
      MATNR: p[11]?.trim(), LGORT: p[12]?.trim() };
  });

  return { BANFN: banfn, ERNAM: ernam, ERDAT: erdat, WAERS: waers, EKGRP: ekgrp,
    TOTAL_VALUE: totalValue, STATUS: "OPEN", items };
}

// ─── createPOFromPR ───────────────────────────────────────────────────────────
async function createPOFromPR(prNumber, poData) {
  const pr = await getPRDetail(prNumber);
  const mergedData = {
    vendor: poData.vendor || pr.LIFNR, companyCode: poData.companyCode,
    purchOrg: poData.purchOrg, purchGroup: poData.purchGroup || pr.EKGRP,
    docType: poData.docType || "NB", docDate: poData.docDate,
    currency: poData.currency || pr.WAERS, deliveryDate: poData.deliveryDate,
    items: poData.items || pr.items.map(item => ({
      description: item.TXZ01, material: item.MATNR, quantity: item.MENGE,
      unit: item.MEINS, netPrice: item.PREIS, plant: item.WERKS,
      storageLocation: item.LGORT, prNumber, prItem: item.BNFPO
    }))
  };
  return createPO(mergedData);
}

module.exports = {
  USE_MOCK,
  getPendingPOs, getPODetail, approvePO, rejectPO, createPO,
  getVendorPerformance, getVendorList,
  getPurchaseRequisitions, getPRDetail, createPOFromPR
};
