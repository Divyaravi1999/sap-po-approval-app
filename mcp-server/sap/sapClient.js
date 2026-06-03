"use strict";

/**
 * SAP client for PO + PR operations.
 *
 * MOCK mode : USE_MOCK=true  (default) — uses in-memory mock data
 * LIVE mode : USE_MOCK=false — calls SAP via Flow MCP Streamable HTTP
 *
 * Flow MCP endpoint: POST https://flow.pillir.ai/mcp  (Streamable HTTP)
 * Auth: X-FLOW-API-KEY header
 */

const USE_MOCK = process.env.USE_MOCK !== "false";

const FLOW_API_KEY = process.env.FLOW_API_KEY || "";
const FLOW_MCP_URL = process.env.FLOW_MCP_URL || "";

const CALL_TIMEOUT_MS = parseInt(process.env.CALL_TIMEOUT_MS || "90000");
const CONNECT_TIMEOUT_MS = parseInt(process.env.CONNECT_TIMEOUT_MS || "60000");

/**
 * Convert date from YYYY-MM-DD to DD.MM.YYYY format for SAP BAPIs
 * SAP ECC 6.0 external date format (as suggested by SAP admin)
 * @param {string} dateStr - Date in YYYY-MM-DD format
 * @returns {string} Date in DD.MM.YYYY format (e.g., "23.03.2026")
 */
function convertToDDMMYYYY(dateStr) {
  if (!dateStr) return "";
  
  // Check if already in DD.MM.YYYY format
  if (/^\d{2}\.\d{2}\.\d{4}$/.test(dateStr)) return dateStr;
  
  try {
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) {
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${day}.${month}.${year}`;
    }
  } catch (e) {
    // Ignore and fallback
  }

  // Fallback: try to parse YYYY-MM-DD format
  const parts = String(dateStr).split("-");
  if (parts.length === 3) {
    const [year, month, day] = parts;
    return `${day.padStart(2, "0")}.${month.padStart(2, "0")}.${year}`;
  }

  return dateStr;
}

/**
 * Convert date from YYYY-MM-DD to YYYYMMDD format for SAP internal fields
 * Used for schedule lines and internal date fields
 * @param {string} dateStr - Date in YYYY-MM-DD format
 * @returns {string} Date in YYYYMMDD format (e.g., "20260323")
 */
function convertToYYYYMMDD(dateStr) {
  if (!dateStr) return "";
  
  // Check if already in YYYYMMDD format
  if (/^\d{8}$/.test(dateStr)) return dateStr;
  
  try {
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) {
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${year}${month}${day}`;
    }
  } catch (e) {
    // Ignore and fallback
  }

  // Fallback: try to parse YYYY-MM-DD format
  const parts = String(dateStr).split("-");
  if (parts.length === 3) {
    const [year, month, day] = parts;
    return `${year}${month.padStart(2, "0")}${day.padStart(2, "0")}`;
  }

  return dateStr;
}

/**
 * Call a SAP BAPI via Flow MCP using the official MCP SDK StreamableHTTPClientTransport.
 *
 * Uses a single persistent MCP client connection. On failure, the connection is
 * discarded and recreated on the next call.
 */

let _mcpClient = null;
let _mcpTransport = null;

async function _getClient() {
  if (_mcpClient) return _mcpClient;

  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

  const client = new Client({ name: "po-approval-app", version: "1.0.0" });

  let mcpSessionId = null;

  const sessionAwareFetch = async (url, init = {}) => {
    const headers = new Headers(init.headers || {});
    if (!headers.has("X-FLOW-API-KEY")) {
      headers.set("X-FLOW-API-KEY", FLOW_API_KEY);
    }
    if (mcpSessionId) {
      headers.set("mcp-session-id", mcpSessionId);
    }

    const response = await fetch(url, { ...init, headers });

    const newSessionId = response.headers.get("mcp-session-id");
    if (newSessionId && newSessionId !== mcpSessionId) {
      mcpSessionId = newSessionId;
      console.log(`[MCP] Session ID: ${mcpSessionId}`);
    }

    return response;
  };

  _mcpTransport = new StreamableHTTPClientTransport(new URL(FLOW_MCP_URL), {
    fetch: sessionAwareFetch,
    requestInit: {
      headers: { "X-FLOW-API-KEY": FLOW_API_KEY },
    },
  });

  _mcpTransport.onclose = () => {
    console.warn("[MCP] Transport closed");
    _mcpClient = null;
    _mcpTransport = null;
  };
  _mcpTransport.onerror = (err) => {
    console.error("[MCP] Transport error:", err?.message || err);
    _mcpClient = null;
    _mcpTransport = null;
  };

  console.log(`[MCP] Connecting to ${FLOW_MCP_URL}...`);
  await Promise.race([
    client.connect(_mcpTransport),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`MCP connect timed out after ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS)
    ),
  ]);
  console.log("[MCP] Connected");

  _mcpClient = client;
  return _mcpClient;
}

async function callBAPI(functionName, inputData, expectedOutput = {}, options = {}) {
  let client;
  try {
    client = await _getClient();
  } catch (err) {
    // Reset so next call retries
    _mcpClient = null;
    _mcpTransport = null;
    throw err;
  }

  console.log(`[MCP] callTool: ${functionName}`);

  let result;
  try {
    const callPromise = client.callTool(
      {
        name: "execute_function",
        arguments: {
          function_module_name: functionName,
          input_data: inputData,
          expected_output_structure: expectedOutput,
        },
      },
      undefined,
      { timeout: CALL_TIMEOUT_MS }
    );

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`callTool timed out after ${CALL_TIMEOUT_MS}ms`)), CALL_TIMEOUT_MS)
    );

    result = await Promise.race([callPromise, timeoutPromise]);
  } catch (err) {
    // Discard broken connection
    _mcpClient = null;
    _mcpTransport = null;
    throw err;
  }

  const textContent = result?.content?.find((c) => c.type === "text");
  if (!textContent) throw new Error("No text content in MCP response");

  let parsed = JSON.parse(textContent.text);

  // Handle double-wrapped responses
  if (parsed.content && Array.isArray(parsed.content)) {
    const innerText = parsed.content.find((c) => c.type === "text");
    if (innerText?.text) {
      try { parsed = JSON.parse(innerText.text); } catch { /* use as-is */ }
    }
  }

  if (parsed.type === "error") throw new Error(String(parsed.result) || "SAP error");

  const sapResult = parsed.result || parsed || {};

  // Skip automatic error checking if skipErrorCheck is true (for BAPI_PO_CREATE1)
  if (!options.skipErrorCheck) {
    const ret = sapResult.RETURN || [];
    const errs = (Array.isArray(ret) ? ret : [ret]).filter(r => r.TYPE === "E" || r.TYPE === "A");
    if (errs.length > 0) throw new Error(errs.map(e => e.MESSAGE).join("; "));
  }

  return sapResult;
}

// ─── Get POs pending release ──────────────────────────────────────────────────
async function getPendingPOs(userReleaseCode, fromDate, toDate) {
  if (USE_MOCK) {
    const { mockPOs, mockReleaseCodes } = require("../mock/mockData");
    return mockPOs
      .filter(po => {
        if (po.STATUS !== "PENDING") return false;

        // Date range filter
        if (fromDate || toDate) {
          const poDate = po.BEDAT; // Format: DDMMYYYY
          if (fromDate) {
            const fromDateFormatted = convertToDDMMYYYY(fromDate);
            if (poDate < fromDateFormatted) return false;
          }
          if (toDate) {
            const toDateFormatted = convertToDDMMYYYY(toDate);
            if (poDate > toDateFormatted) return false;
          }
        }

        if (userReleaseCode) {
          const codes = mockReleaseCodes[po.EBELN] || [];
          return codes.includes(userReleaseCode.toUpperCase());
        }
        return true;
      })
      .map(({ items: _items, ...header }) => header);
  }

  // Use RFC_READ_TABLE on EKKO - most reliable method for getting PO list
  // This approach works consistently across different SAP systems
  const EKKO_FIELDS = ["EBELN", "LIFNR", "BUKRS", "FRGKE", "FRGZU", "WAERS", "BEDAT", "EKGRP", "EKORG"];

  // Default fromDate to 1 year ago if not provided — avoids fetching decades of records
  const effectiveFromDate = fromDate || (() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 1);
    return d.toISOString().slice(0, 10); // YYYY-MM-DD
  })();

  // Convert dates to YYYYMMDD format for SAP comparison (BEDAT is stored as YYYYMMDD)
  const fromDateSap = convertToYYYYMMDD(effectiveFromDate);
  const toDateSap   = toDate ? convertToYYYYMMDD(toDate) : null;

  // Build OPTIONS to push date filter to SAP DB level (BEDAT is stored as YYYYMMDD)
  const options = [`BEDAT GE '${fromDateSap}'`];
  if (toDateSap) options.push(`AND BEDAT LE '${toDateSap}'`);

  console.log(`[getPendingPOs] Date filter pushed to SAP: ${options.join(' ')}`);

  const bapiInput = {
    QUERY_TABLE: "EKKO",
    DELIMITER:   "|",
    FIELDS:      EKKO_FIELDS.map(f => ({ FIELDNAME: f })),
    OPTIONS:     options.map(text => ({ TEXT: text })),
    ROWCOUNT:    500
  };

  console.log(`[getPendingPOs] Calling RFC_READ_TABLE on EKKO...`);
  
  const result = await callBAPI("RFC_READ_TABLE", bapiInput, {
    DATA:   [{ WA: "string" }],
    FIELDS: [{ FIELDNAME: "string" }],
    RETURN: [{ TYPE: "string", MESSAGE: "string" }]
  });

  console.log(`[getPendingPOs] RFC_READ_TABLE returned ${result.DATA?.length || 0} rows`);
  
  // Log RETURN messages if any
  if (result.RETURN && result.RETURN.length > 0) {
    result.RETURN.forEach(msg => {
      console.log(`[getPendingPOs] SAP Message [${msg.TYPE}]: ${msg.MESSAGE}`);
    });
    
    // Check for errors
    const errors = result.RETURN.filter(r => r.TYPE === "E" || r.TYPE === "A");
    if (errors.length > 0) {
      throw new Error(errors.map(e => e.MESSAGE).join("; "));
    }
  }

  const rows  = result.DATA   || [];
  const fields = (result.FIELDS || []).map(f => f.FIELDNAME);

  // If SAP returned FIELDS metadata use it; otherwise fall back to our known order
  const colNames = fields.length > 0 ? fields : EKKO_FIELDS;

  const pos = rows.map(row => {
    const parts = (row.WA || "").split("|");
    const rec = {};
    colNames.forEach((col, i) => { rec[col] = (parts[i] || "").trim(); });
    return rec;
  });

  // Filter POs by date range only - include pending and approved POs
  const filteredPOs = pos.filter(po => {
    const frgke = po.FRGKE || "";
    const frgzu = po.FRGZU || "";

    // Secondary JS date guard (SAP OPTIONS already filtered, this is a safety net)
    const poDate = po.BEDAT; // Format: YYYYMMDD
    if (poDate < fromDateSap) {
      console.log(`[getPendingPOs] JS-filtered out PO ${po.EBELN}: ${poDate} < ${fromDateSap}`);
      return false;
    }
    if (toDateSap && poDate > toDateSap) {
      console.log(`[getPendingPOs] JS-filtered out PO ${po.EBELN}: ${poDate} > ${toDateSap}`);
      return false;
    }

    // If a specific release code is requested, only show POs not yet released by that code
    if (userReleaseCode) {
      const hasCode = frgke.toUpperCase().includes(userReleaseCode.toUpperCase());
      if (hasCode) {
        console.log(`[getPendingPOs] Filtered out PO ${po.EBELN}: already has release code ${userReleaseCode}`);
      }
      return !hasCode;
    }
    
    // Determine status for logging
    const status = (frgke === "G" || frgzu === "X") ? "APPROVED" : "PENDING";
    
    console.log(`[getPendingPOs] Including PO ${po.EBELN} (FRGKE='${frgke}', FRGZU='${frgzu}', STATUS=${status})`);
    return true;
  });

  console.log(`[getPendingPOs] Filtered to ${filteredPOs.length} POs (from ${effectiveFromDate} to ${toDate || 'today'})`);
  console.log(`[getPendingPOs] (default 1-year lookback applied: fromDate was ${fromDate ? fromDate : 'not provided'})`);

  // Map POs with dynamic status based on release indicators
  return filteredPOs.map(po => {
    const frgke = po.FRGKE || "";
    const frgzu = po.FRGZU || "";
    
    // Determine status based on SAP indicators:
    // FRGKE='G' or FRGZU='X' = Approved (fully released)
    // Otherwise = Pending
    const status = (frgke === "G" || frgzu === "X") ? "APPROVED" : "PENDING";
    
    return {
      EBELN:       po.EBELN,
      LIFNR:       po.LIFNR,
      VENDOR_NAME: po.LIFNR,
      WAERS:       po.WAERS,
      NETWR:       parseFloat(po.NETWR || 0),
      BEDAT:       po.BEDAT,
      FRGKE:       po.FRGKE,
      FRGZU:       po.FRGZU,
      EKGRP:       po.EKGRP,
      EKORG:       po.EKORG,
      BUKRS:       po.BUKRS,
      STATUS:      status
    };
  });
}


// ─── Get full PO details via BAPI_PO_GETDETAIL1 ───────────────────────────────
async function getPODetail(ebeln) {
  if (USE_MOCK) {
    const { mockPOs } = require("../mock/mockData");
    const po = mockPOs.find(p => p.EBELN === ebeln);
    if (!po) throw new Error(`PO ${ebeln} not found`);
    return po;
  }

  console.log(`[getPODetail] Getting details for PO ${ebeln} using RFC_READ_TABLE...`);

  try {
    // Step 1: Get header data from EKKO
    const ekkoResult = await callBAPI("RFC_READ_TABLE", {
      QUERY_TABLE: "EKKO",
      DELIMITER: "|",
      FIELDS: [
        { FIELDNAME: "EBELN" },
        { FIELDNAME: "LIFNR" },
        { FIELDNAME: "WAERS" },
        { FIELDNAME: "BEDAT" },
        { FIELDNAME: "FRGKE" },
        { FIELDNAME: "FRGZU" },
        { FIELDNAME: "EKGRP" },
        { FIELDNAME: "EKORG" },
        { FIELDNAME: "BUKRS" }
      ],
      OPTIONS: [{ TEXT: `EBELN = '${ebeln}'` }],
      ROWCOUNT: 1
    }, {
      DATA: [{ WA: "string" }],
      FIELDS: [{ FIELDNAME: "string" }]
    });

    if (!ekkoResult.DATA || ekkoResult.DATA.length === 0) {
      throw new Error(`PO ${ebeln} not found`);
    }

    const headerRow = ekkoResult.DATA[0].WA.split("|");
    const header = {
      EBELN: headerRow[0]?.trim(),
      LIFNR: headerRow[1]?.trim(),
      WAERS: headerRow[2]?.trim(),
      BEDAT: headerRow[3]?.trim(),
      FRGKE: headerRow[4]?.trim(),
      FRGZU: headerRow[5]?.trim(),
      EKGRP: headerRow[6]?.trim(),
      EKORG: headerRow[7]?.trim(),
      BUKRS: headerRow[8]?.trim()
    };

    console.log(`[getPODetail] Header retrieved:`, header);

    // Step 2: Get item data from EKPO
    const ekpoResult = await callBAPI("RFC_READ_TABLE", {
      QUERY_TABLE: "EKPO",
      DELIMITER: "|",
      FIELDS: [
        { FIELDNAME: "EBELN" },
        { FIELDNAME: "EBELP" },
        { FIELDNAME: "TXZ01" },
        { FIELDNAME: "MENGE" },
        { FIELDNAME: "MEINS" },
        { FIELDNAME: "NETPR" },
        { FIELDNAME: "WERKS" }
      ],
      OPTIONS: [{ TEXT: `EBELN = '${ebeln}'` }],
      ROWCOUNT: 50
    }, {
      DATA: [{ WA: "string" }],
      FIELDS: [{ FIELDNAME: "string" }]
    });

    const items = (ekpoResult.DATA || []).map(row => {
      const parts = row.WA.split("|");
      return {
        EBELP: parts[1]?.trim(),
        TXZ01: parts[2]?.trim(),
        MENGE: parseFloat(parts[3]?.trim() || 0),
        MEINS: parts[4]?.trim(),
        NETPR: parseFloat(parts[5]?.trim() || 0),
        WERKS: parts[6]?.trim()
      };
    });

    console.log(`[getPODetail] Retrieved ${items.length} items`);

    // Calculate STATUS based on SAP indicators (same logic as getPendingPOs)
    const frgke = header.FRGKE || "";
    const frgzu = header.FRGZU || "";
    
    // FRGKE='G' or FRGZU='X' = Approved (fully released)
    // Otherwise = Pending
    const status = (frgke === "G" || frgzu === "X") ? "APPROVED" : "PENDING";
    
    console.log(`[getPODetail] PO ${header.EBELN} STATUS=${status} (FRGKE='${frgke}', FRGZU='${frgzu}')`);

    return {
      EBELN: header.EBELN,
      LIFNR: header.LIFNR,
      VENDOR_NAME: header.LIFNR,
      WAERS: header.WAERS,
      NETWR: items.reduce((sum, item) => sum + (item.MENGE * item.NETPR), 0),
      BEDAT: header.BEDAT,
      FRGKE: header.FRGKE,
      FRGZU: header.FRGZU,
      EKGRP: header.EKGRP,
      EKORG: header.EKORG,
      BUKRS: header.BUKRS,
      STATUS: status,
      items: items
    };

  } catch (error) {
    console.error(`[getPODetail] Error:`, error.message);
    throw error;
  }
}

// ─── Approve via BAPI_PO_RELEASE ──────────────────────────────────────────────
async function approvePO(ebeln, releaseCode) {
  if (USE_MOCK) {
    const { mockPOs, mockReleaseCodes } = require("../mock/mockData");
    const po = mockPOs.find(p => p.EBELN === ebeln);
    if (!po)                   throw new Error(`PO ${ebeln} not found`);
    if (po.STATUS === "APPROVED") throw new Error("PO is already fully approved");

    const validCodes = mockReleaseCodes[ebeln] || [];
    if (!validCodes.includes(releaseCode)) {
      throw new Error(`Invalid release code '${releaseCode}' for PO ${ebeln}`);
    }

    po.STATUS = "APPROVED";
    po.FRGKE  = "9";
    return { success: true, message: `PO ${ebeln} approved with release code ${releaseCode}` };
  }

  console.log(`[approvePO] ========================================`);
  console.log(`[approvePO] Starting approval process for PO ${ebeln} with release code '${releaseCode}'`);
  console.log(`[approvePO] ========================================`);

  // First, let's check the current release status of the PO
  console.log(`[approvePO] Step 1: Checking current PO status...`);
  try {
    const poDetail = await getPODetail(ebeln);
    console.log(`[approvePO] ✓ PO found - Current status:`);
    console.log(`[approvePO]   - FRGKE (Release Indicator): '${poDetail.FRGKE}'`);
    console.log(`[approvePO]   - FRGZU (Release Status): '${poDetail.FRGZU}'`);
    console.log(`[approvePO]   - Vendor: ${poDetail.LIFNR}`);
    console.log(`[approvePO]   - Purch Org: ${poDetail.EKORG}`);
    console.log(`[approvePO]   - Company Code: ${poDetail.BUKRS}`);
  } catch (err) {
    console.warn(`[approvePO] ⚠ Could not fetch PO details: ${err.message}`);
  }

  console.log(`[approvePO] Step 2: Calling BAPI_PO_RELEASE...`);
  // Use USE_EXCEPTIONS to ensure SAP populates RETURN table instead of raising exceptions
  const bapiInput = {
    PURCHASEORDER: ebeln,
    PO_REL_CODE: releaseCode,
    USE_EXCEPTIONS: "X",
    NO_COMMIT: ""
  };
  
  console.log(`[approvePO] BAPI input:`, JSON.stringify(bapiInput, null, 2));

  const result = await callBAPI("BAPI_PO_RELEASE", bapiInput, {
    RETURN: [{ TYPE: "string", MESSAGE: "string", ID: "string", NUMBER: "string" }],
    REL_STATUS_NEW: "string",
    REL_INDICATOR_NEW: "string",
    REL_CODE: "string",
    REL_GROUP: "string",
    REL_STRATEGY: "string",
    RET_CODE: "string"
  }, {
    skipErrorCheck: true  // Handle RETURN table ourselves
  });

  console.log(`[approvePO] ✓ BAPI_PO_RELEASE completed`);
  console.log(`[approvePO] Step 3: Analyzing BAPI response...`);
  console.log(`[approvePO] Raw result keys:`, Object.keys(result));
  console.log(`[approvePO] RETURN table:`, result.RETURN ? `${Array.isArray(result.RETURN) ? result.RETURN.length : 1} message(s)` : 'empty');
  console.log(`[approvePO] REL_STATUS_NEW: '${result.REL_STATUS_NEW || ''}'`);
  console.log(`[approvePO] REL_INDICATOR_NEW: '${result.REL_INDICATOR_NEW || ''}'`);
  console.log(`[approvePO] REL_CODE: '${result.REL_CODE || ''}'`);
  console.log(`[approvePO] REL_GROUP: '${result.REL_GROUP || ''}'`);
  console.log(`[approvePO] REL_STRATEGY: '${result.REL_STRATEGY || ''}'`);

  // Check for errors in RETURN table
  const returnTable = Array.isArray(result.RETURN) ? result.RETURN : (result.RETURN ? [result.RETURN] : []);
  
  if (returnTable.length > 0) {
    console.log(`[approvePO] RETURN messages:`);
    returnTable.forEach((msg, idx) => {
      console.log(`[approvePO]   [${idx}] Type=${msg.TYPE}, Message="${msg.MESSAGE}"`);
    });
  }
  
  // Check if RETURN table is empty - this indicates a problem
  if (returnTable.length === 0) {
    // Check if we got any release status information
    if (result.REL_STATUS_NEW || result.REL_INDICATOR_NEW) {
      console.log(`[approvePO] RETURN table is empty but got release status info - this might be OK`);
      console.log(`[approvePO] REL_STATUS_NEW: ${result.REL_STATUS_NEW}, REL_INDICATOR_NEW: ${result.REL_INDICATOR_NEW}`);
      
      // If we have release status, consider it a success
      const statusText = result.REL_STATUS_NEW || result.REL_INDICATOR_NEW || 'processed';
      const message = `PO ${ebeln} release processed successfully. Status: ${statusText}`;
      console.log(`[approvePO] ${message}`);
      
      // Commit the transaction
      console.log(`[approvePO] Committing transaction...`);
      await callBAPI("BAPI_TRANSACTION_COMMIT", { WAIT: "X" }, {
        RETURN: [{ TYPE: "string", MESSAGE: "string" }]
      });
      console.log(`[approvePO] Transaction committed`);
      
      return {
        success: true,
        message: message,
        messages: [],
        relStatusNew: result.REL_STATUS_NEW,
        relIndicatorNew: result.REL_INDICATOR_NEW
      };
    }
    
    const errorMsg = `BAPI_PO_RELEASE returned no messages and no release status. This usually means: 1) PO ${ebeln} does not have a release strategy configured, 2) Release code '${releaseCode}' is invalid for this PO, or 3) PO is already released. Please check the PO in SAP (transaction ME23N) and verify the release strategy configuration (transaction ME28).`;
    console.error(`[approvePO] ${errorMsg}`);
    throw new Error(errorMsg);
  }
  
  const errors = returnTable.filter(r => r.TYPE === "E" || r.TYPE === "A");
  
  if (errors.length > 0) {
    const errorMsg = errors.map(e => e.MESSAGE).join("; ");
    console.error(`[approvePO] BAPI returned errors: ${errorMsg}`);
    throw new Error(errorMsg);
  }

  // Check for success messages
  const successMsgs = returnTable.filter(r => r.TYPE === "S");
  
  if (successMsgs.length === 0) {
    // No success messages - check for warnings or info
    const warnings = returnTable.filter(r => r.TYPE === "W");
    const info = returnTable.filter(r => r.TYPE === "I");
    
    if (warnings.length > 0 || info.length > 0) {
      const allMsgs = [...warnings, ...info].map(m => m.MESSAGE).join("; ");
      console.warn(`[approvePO] BAPI returned warnings/info: ${allMsgs}`);
      throw new Error(`PO approval uncertain: ${allMsgs}`);
    }
    
    // No messages at all of any type
    throw new Error(`BAPI_PO_RELEASE completed but returned no confirmation. Please verify PO ${ebeln} status in SAP.`);
  }
  
  const message = successMsgs.map(m => m.MESSAGE).join("; ");
  console.log(`[approvePO] Success: ${message}`);

  // Commit the transaction
  console.log(`[approvePO] Committing transaction...`);
  await callBAPI("BAPI_TRANSACTION_COMMIT", { WAIT: "X" }, {
    RETURN: [{ TYPE: "string", MESSAGE: "string" }]
  });
  console.log(`[approvePO] Transaction committed`);

  return {
    success: true,
    message: message,
    messages: returnTable,
    relStatusNew: result.REL_STATUS_NEW,
    relIndicatorNew: result.REL_INDICATOR_NEW
  };
}

// ─── Reject via BAPI_PO_RESET_RELEASE ─────────────────────────────────────────
async function rejectPO(ebeln, releaseCode) {
  if (USE_MOCK) {
    const { mockPOs } = require("../mock/mockData");
    const po = mockPOs.find(p => p.EBELN === ebeln);
    if (!po)                    throw new Error(`PO ${ebeln} not found`);
    if (po.STATUS === "REJECTED") throw new Error("PO is already rejected");

    po.STATUS = "REJECTED";
    po.FRGKE  = "0";
    po.FRGZU  = "";
    return { success: true, message: `PO ${ebeln} release reset (rejected)` };
  }

  console.log(`[rejectPO] ========================================`);
  console.log(`[rejectPO] Starting rejection process for PO ${ebeln} with release code '${releaseCode}'`);
  console.log(`[rejectPO] ========================================`);

  // First, check the current PO status
  console.log(`[rejectPO] Step 1: Checking current PO status...`);
  try {
    const poDetail = await getPODetail(ebeln);
    console.log(`[rejectPO] ✓ PO found - Current status:`);
    console.log(`[rejectPO]   - FRGKE (Release Indicator): '${poDetail.FRGKE}'`);
    console.log(`[rejectPO]   - FRGZU (Release Status): '${poDetail.FRGZU}'`);
    
    // Check if PO has been released
    if (!poDetail.FRGKE || poDetail.FRGKE === '' || poDetail.FRGKE === '0') {
      throw new Error(`PO ${ebeln} has not been released yet. There is nothing to reset. Current release indicator (FRGKE): '${poDetail.FRGKE || 'empty'}'`);
    }
    
    // Check if PO is already fully released
    if (poDetail.FRGKE === 'G') {
      console.log(`[rejectPO] ⚠ PO is fully released (FRGKE=G). Attempting to reset...`);
    }
    
    console.log(`[rejectPO] ✓ PO has release indicator '${poDetail.FRGKE}' - proceeding with reset`);
  } catch (err) {
    console.warn(`[rejectPO] ⚠ Could not fetch PO details: ${err.message}`);
    // Continue anyway - the BAPI will provide the definitive answer
  }

  console.log(`[rejectPO] Step 2: Calling BAPI_PO_RESET_RELEASE...`);
  
  const bapiInput = {
    PURCHASEORDER: ebeln,
    PO_REL_CODE: releaseCode,
    USE_EXCEPTIONS: "X",
    NO_COMMIT: ""
  };
  
  console.log(`[rejectPO] BAPI input:`, JSON.stringify(bapiInput, null, 2));

  const result = await callBAPI("BAPI_PO_RESET_RELEASE", bapiInput, {
    RETURN: [{ TYPE: "string", MESSAGE: "string", ID: "string", NUMBER: "string" }],
    REL_STATUS_NEW: "string",
    REL_INDICATOR_NEW: "string",
    RET_CODE: "string"
  }, {
    skipErrorCheck: true  // Handle RETURN table ourselves
  });

  console.log(`[rejectPO] ✓ BAPI_PO_RESET_RELEASE completed`);
  console.log(`[rejectPO] Step 3: Analyzing BAPI response...`);
  console.log(`[rejectPO] Raw result keys:`, Object.keys(result));
  console.log(`[rejectPO] RETURN table:`, result.RETURN ? `${Array.isArray(result.RETURN) ? result.RETURN.length : 1} message(s)` : 'empty');
  console.log(`[rejectPO] REL_STATUS_NEW: '${result.REL_STATUS_NEW || ''}'`);
  console.log(`[rejectPO] REL_INDICATOR_NEW: '${result.REL_INDICATOR_NEW || ''}'`);

  // Check for errors in RETURN table
  const returnTable = Array.isArray(result.RETURN) ? result.RETURN : (result.RETURN ? [result.RETURN] : []);
  
  if (returnTable.length > 0) {
    console.log(`[rejectPO] RETURN messages:`);
    returnTable.forEach((msg, idx) => {
      console.log(`[rejectPO]   [${idx}] Type=${msg.TYPE}, Message="${msg.MESSAGE}"`);
    });
  }
  
  // Check if RETURN table is empty - this indicates a problem
  if (returnTable.length === 0) {
    // Check if we got any release status information
    if (result.REL_STATUS_NEW || result.REL_INDICATOR_NEW) {
      console.log(`[rejectPO] RETURN table is empty but got release status info`);
      console.log(`[rejectPO] REL_STATUS_NEW: ${result.REL_STATUS_NEW}, REL_INDICATOR_NEW: ${result.REL_INDICATOR_NEW}`);
      
      // If we have release status, consider it a success
      const statusText = result.REL_STATUS_NEW || result.REL_INDICATOR_NEW || 'reset';
      const message = `PO ${ebeln} release reset successfully. Status: ${statusText}`;
      console.log(`[rejectPO] ${message}`);
      
      // Commit the transaction
      console.log(`[rejectPO] Committing transaction...`);
      await callBAPI("BAPI_TRANSACTION_COMMIT", { WAIT: "X" }, {
        RETURN: [{ TYPE: "string", MESSAGE: "string" }]
      });
      console.log(`[rejectPO] Transaction committed`);
      
      return {
        success: true,
        message: message,
        messages: [],
        relStatusNew: result.REL_STATUS_NEW,
        relIndicatorNew: result.REL_INDICATOR_NEW
      };
    }
    
    const errorMsg = `BAPI_PO_RESET_RELEASE returned no messages and no release status. This usually means: 1) PO ${ebeln} does not have a release strategy configured, 2) Release code '${releaseCode}' is invalid for this PO, or 3) PO has not been released yet (nothing to reset). Please check the PO in SAP (transaction ME23N) and verify: a) The PO has a release strategy, b) The PO has been released (FRGKE is not empty), c) The release code '${releaseCode}' is valid for this PO.`;
    console.error(`[rejectPO] ${errorMsg}`);
    throw new Error(errorMsg);
  }
  
  const errors = returnTable.filter(r => r.TYPE === "E" || r.TYPE === "A");
  
  if (errors.length > 0) {
    const errorMsg = errors.map(e => e.MESSAGE).join("; ");
    console.error(`[rejectPO] BAPI returned errors: ${errorMsg}`);
    throw new Error(errorMsg);
  }

  // Check for success messages
  const successMsgs = returnTable.filter(r => r.TYPE === "S");
  
  if (successMsgs.length === 0) {
    // No success messages - check for warnings or info
    const warnings = returnTable.filter(r => r.TYPE === "W");
    const info = returnTable.filter(r => r.TYPE === "I");
    
    if (warnings.length > 0 || info.length > 0) {
      const allMsgs = [...warnings, ...info].map(m => m.MESSAGE).join("; ");
      console.warn(`[rejectPO] BAPI returned warnings/info: ${allMsgs}`);
      throw new Error(`PO rejection uncertain: ${allMsgs}`);
    }
    
    // No messages at all of any type
    throw new Error(`BAPI_PO_RESET_RELEASE completed but returned no confirmation. Please verify PO ${ebeln} status in SAP.`);
  }
  
  const message = successMsgs.map(m => m.MESSAGE).join("; ");
  console.log(`[rejectPO] Success: ${message}`);

  // Commit the transaction
  console.log(`[rejectPO] Committing transaction...`);
  await callBAPI("BAPI_TRANSACTION_COMMIT", { WAIT: "X" }, {
    RETURN: [{ TYPE: "string", MESSAGE: "string" }]
  });
  console.log(`[rejectPO] Transaction committed`);

  return {
    success: true,
    message: message,
    messages: returnTable,
    relStatusNew: result.REL_STATUS_NEW,
    relIndicatorNew: result.REL_INDICATOR_NEW
  };
}

/**
 * Get a safe document date that's likely within SAP's fiscal calendar
 * Defaults to today, but if that fails, tries progressively older dates
 * @param {string} requestedDate - Date in YYYY-MM-DD format
 * @returns {string} Safe date in YYYY-MM-DD format
 */
function getSafeDocDate(requestedDate) {
  // Always use today's date to avoid fiscal period issues
  // SAP posting periods are typically open for the current period
  const today = new Date().toISOString().slice(0, 10);
  
  if (!requestedDate) {
    console.log(`[getSafeDocDate] No date provided, using today: ${today}`);
    return today;
  }
  
  const requested = new Date(requestedDate);
  const todayDate = new Date();
  
  // Calculate difference in days
  const diffTime = Math.abs(todayDate - requested);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  
  // If requested date is more than 30 days away from today, use today instead
  // This avoids closed posting periods
  if (diffDays > 30) {
    console.log(`[getSafeDocDate] Requested date ${requestedDate} is ${diffDays} days from today, using today to avoid closed posting periods`);
    return today;
  }
  
  // If requested date is in the future, use today
  if (requested > todayDate) {
    console.log(`[getSafeDocDate] Requested date ${requestedDate} is in the future, using today: ${today}`);
    return today;
  }
  
  console.log(`[getSafeDocDate] Using requested date: ${requestedDate}`);
  return requestedDate;
}

// ─── Create PO via BAPI_PO_CREATE1 ────────────────────────────────────────────
async function createPO(poData) {
  if (USE_MOCK) {
    const { mockPOs } = require("../mock/mockData");
    // Generate new PO number
    const maxEbeln = Math.max(...mockPOs.map(p => parseInt(p.EBELN)));
    const newEbeln = String(maxEbeln + 1);
    
    const newPO = {
      EBELN: newEbeln,
      LIFNR: poData.vendor,
      VENDOR_NAME: poData.vendor,
      WAERS: poData.currency || "USD",
      NETWR: poData.items.reduce((sum, item) => sum + (item.quantity * item.netPrice), 0),
      BEDAT: poData.docDate ? convertToDDMMYYYY(poData.docDate) : convertToDDMMYYYY(new Date().toISOString().slice(0, 10)),
      FRGKE: "0",
      FRGZU: "",
      EKGRP: poData.purchGroup,
      EKORG: poData.purchOrg,
      BUKRS: poData.companyCode,
      STATUS: "PENDING",
      releaseSteps: [],
      items: poData.items.map((item, idx) => ({
        EBELP: String((idx + 1) * 10).padStart(5, "0"),
        TXZ01: item.description,
        MENGE: item.quantity,
        MEINS: item.unit,
        NETPR: item.netPrice,
        WERKS: item.plant
      }))
    };
    
    mockPOs.push(newPO);
    return { success: true, poNumber: newEbeln, message: `PO ${newEbeln} created successfully` };
  }

  // Build BAPI_PO_CREATE1 input
  // IMPORTANT: Do NOT set DOC_DATE - let SAP use its default to avoid posting period issues
  const today = new Date();
  const docDate = poData.docDate || today.toISOString().slice(0, 10);
  
  console.log(`[createPO] ========================================`);
  console.log(`[createPO] Document Date Configuration:`);
  console.log(`[createPO]   User requested: ${poData.docDate || 'not specified'}`);
  console.log(`[createPO]   Note: NOT setting DOC_DATE in BAPI to avoid posting period issues`);
  console.log(`[createPO]   SAP will use its default date`);
  console.log(`[createPO]   Company Code: ${poData.companyCode}`);
  console.log(`[createPO] ========================================`);

  
  const poHeader = {
    COMP_CODE: poData.companyCode,
    DOC_TYPE: poData.docType || "NB",
    VENDOR: poData.vendor,
    PURCH_ORG: poData.purchOrg,
    PUR_GROUP: poData.purchGroup,
    // DOC_DATE: removed - let SAP use default to avoid posting period errors
    CURRENCY: poData.currency || "EUR"
  };

  const poHeaderX = {
    COMP_CODE: "X",
    DOC_TYPE: "X",
    VENDOR: "X",
    PURCH_ORG: "X",
    PUR_GROUP: "X",
    // DOC_DATE: removed
    CURRENCY: "X"
  };

  const poItems = poData.items.map((item, idx) => {
    const poItem = {
      PO_ITEM: String((idx + 1) * 10).padStart(5, "0"),
      MATERIAL: item.material || "",
      SHORT_TEXT: item.description,
      PLANT: item.plant,
      STORAGE_LOC: item.storageLocation || "",
      QUANTITY: String(item.quantity),
      PO_UNIT: item.unit,
      NET_PRICE: String(item.netPrice),
      PRICE_UNIT: "1",
      PERIOD_IND_EXPIRATION_DATE: item.periodIndExpirationDate || ""
    };
    
    // Add PR reference fields if provided
    if (item.prNumber && item.prItem) {
      poItem.PREQ_NO = String(item.prNumber).padStart(10, "0");
      poItem.PREQ_ITEM = String(item.prItem).padStart(5, "0");
      console.log(`[createPO] Item ${poItem.PO_ITEM}: Adding PR reference ${poItem.PREQ_NO}/${poItem.PREQ_ITEM}`);
    }
    
    return poItem;
  });

  const poItemsX = poItems.map(item => {
    const itemX = {
      PO_ITEM: item.PO_ITEM,
      MATERIAL: item.MATERIAL ? "X" : "",
      SHORT_TEXT: "X",
      PLANT: "X",
      STORAGE_LOC: item.STORAGE_LOC ? "X" : "",
      QUANTITY: "X",
      PO_UNIT: "X",
      NET_PRICE: "X",
      PRICE_UNIT: "X",
      PERIOD_IND_EXPIRATION_DATE: item.PERIOD_IND_EXPIRATION_DATE ? "X" : ""
    };
    
    // Mark PR reference fields if present
    if (item.PREQ_NO) {
      itemX.PREQ_NO = "X";
      itemX.PREQ_ITEM = "X";
    }
    
    return itemX;
  });

  // Build schedule lines with delivery date
  const poSchedules = [];
  const poSchedulesX = [];
  
  // Use user-provided delivery date or default to today + 7 days
  let deliveryDate;
  if (poData.deliveryDate) {
    deliveryDate = poData.deliveryDate;
  } else {
    const defaultDelivery = new Date();
    defaultDelivery.setDate(defaultDelivery.getDate() + 7);
    deliveryDate = defaultDelivery.toISOString().slice(0, 10);
  }
  
  const deliveryDateFormatted = convertToYYYYMMDD(deliveryDate);
  
  console.log(`[createPO] Delivery date configuration:`);
  console.log(`[createPO]   Requested: ${poData.deliveryDate || 'not specified'}`);
  console.log(`[createPO]   Using: ${deliveryDate}`);
  console.log(`[createPO]   SAP format (YYYYMMDD): ${deliveryDateFormatted}`);
  
  poData.items.forEach((item, idx) => {
    const poItem = String((idx + 1) * 10).padStart(5, "0");
    poSchedules.push({
      PO_ITEM: poItem,
      SCHED_LINE: "0001",
      DELIVERY_DATE: deliveryDateFormatted,
      QUANTITY: String(item.quantity)
    });
    
    poSchedulesX.push({
      PO_ITEM: poItem,
      SCHED_LINE: "0001",
      DELIVERY_DATE: "X",
      QUANTITY: "X"
    });
  });

  const bapiInput = {
    POHEADER: poHeader,
    POHEADERX: poHeaderX,
    POITEM: poItems,
    POITEMX: poItemsX,
    POSCHEDULE: poSchedules,
    POSCHEDULEX: poSchedulesX
  };

  // Add account assignment for free-text items (no material number)
  // SAP requires either MATERIAL or account assignment category (KNTTP)
  const poAccount  = [];
  const poAccountX = [];
  poData.items.forEach((item, idx) => {
    if (!item.material) {
      const poItem = String((idx + 1) * 10).padStart(5, "0");
      poAccount.push({
        PO_ITEM:    poItem,
        SERIAL_NO:  "01",
        ACCT_CAT:   item.acctAssCat || "K",   // K = cost center (most common default)
        COSTCENTER: item.costCenter  || "1000"
      });
      poAccountX.push({
        PO_ITEM:    poItem,
        SERIAL_NO:  "01",
        ACCT_CAT:   "X",
        COSTCENTER: "X"
      });
      // Also set KNTTP on the item itself
      poItems[idx].ACCTASSCAT = item.acctAssCat || "K";
      poItemsX[idx].ACCTASSCAT = "X";
    }
  });
  if (poAccount.length) {
    bapiInput.POACCOUNT  = poAccount;
    bapiInput.POACCOUNTX = poAccountX;
  }

  console.log(`[createPO] Calling BAPI_PO_CREATE1...`);
  console.log(`[createPO] Input data:`, JSON.stringify({
    companyCode: poData.companyCode,
    vendor: poData.vendor,
    docDate: poData.docDate,
    deliveryDate: poData.deliveryDate,
    docDateConverted: poHeader.DOC_DATE,
    deliveryDateConverted: poSchedules.length > 0 ? poSchedules[0].DELIVERY_DATE : 'N/A',
    hasPRReferences: poItems.some(item => item.PREQ_NO),
    prReferences: poItems.filter(item => item.PREQ_NO).map(item => ({
      poItem: item.PO_ITEM,
      prNumber: item.PREQ_NO,
      prItem: item.PREQ_ITEM
    }))
  }, null, 2));
  console.log(`[createPO] BAPI Input:`, JSON.stringify(bapiInput, null, 2));
  
  const result = await callBAPI("BAPI_PO_CREATE1", bapiInput, {
    EXPPURCHASEORDER: "string",
    RETURN: [{ TYPE: "string", MESSAGE: "string", ID: "string", NUMBER: "string" }]
  }, { skipErrorCheck: true }); // Skip automatic error checking - we'll handle errors manually

  console.log(`[createPO] BAPI_PO_CREATE1 result:`, JSON.stringify(result, null, 2));
  console.log(`[createPO] EXPPURCHASEORDER value:`, result.EXPPURCHASEORDER);
  console.log(`[createPO] RETURN table:`, result.RETURN);

  // Check for errors in RETURN table
  const returnTable = Array.isArray(result.RETURN) ? result.RETURN : [];
  
  // Log RETURN table details
  console.log(`[createPO] RETURN table length: ${returnTable.length}`);
  if (returnTable.length > 0) {
    returnTable.forEach((msg, idx) => {
      console.log(`[createPO] RETURN[${idx}]: Type=${msg.TYPE}, Message=${msg.MESSAGE}`);
    });
  }
  
  // Check if RETURN table is empty - this might be OK if we got a PO number
  if (returnTable.length === 0) {
    console.warn(`[createPO] Warning: RETURN table is empty`);
    // Don't throw error yet - check if we got a PO number
  }
  
  // Log all messages
  console.log(`[createPO] RETURN table has ${returnTable.length} messages:`);
  returnTable.forEach(msg => {
    console.log(`[createPO]   [${msg.TYPE}] ${msg.MESSAGE}`);
  });
  
  // Try to get PO number from EXPPURCHASEORDER field first
  let poNumber = result.EXPPURCHASEORDER;
  if (Array.isArray(poNumber)) {
    poNumber = null;
  }
  if (poNumber && typeof poNumber === 'string') {
    poNumber = poNumber.trim();
    if (poNumber === '') {
      poNumber = null;
    }
  }
  
  console.log(`[createPO] PO number from EXPPURCHASEORDER: ${poNumber || 'not found'}`);
  
  // Check for success messages that contain the PO number
  const successMsgs = returnTable.filter(r => r.TYPE === "S");
  let poNumberFromMessage = null;
  
  if (successMsgs.length > 0) {
    // Extract PO number from success message like "Standard PO created under the number 4500022393"
    const poCreatedMsg = successMsgs.find(m => m.MESSAGE && m.MESSAGE.includes("created under the number"));
    if (poCreatedMsg) {
      const match = poCreatedMsg.MESSAGE.match(/\d{10}/);
      if (match) {
        poNumberFromMessage = match[0];
        console.log(`[createPO] Extracted PO number from success message: ${poNumberFromMessage}`);
      }
    }
  }
  
  // Use PO number from either source
  if (!poNumber && poNumberFromMessage) {
    poNumber = poNumberFromMessage;
    console.log(`[createPO] Using PO number from success message: ${poNumber}`);
  }
  
  // Check for blocking errors (TYPE "E" or "A")
  const errors = returnTable.filter(r => r.TYPE === "E" || r.TYPE === "A");
  
  // If we have a PO number (from any source), treat errors as warnings (PO was created despite errors)
  if (poNumber && errors.length > 0) {
    const errorMsg = errors.map(e => e.MESSAGE).join("; ");
    console.warn(`[createPO] PO ${poNumber} was created but has errors/warnings: ${errorMsg}`);
    // Don't throw - continue with the PO number
  } else if (!poNumber && errors.length > 0) {
    // No PO number and we have errors - this is a real failure
    const errorMsg = errors.map(e => e.MESSAGE).join("; ");
    console.error(`[createPO] BAPI returned errors: ${errorMsg}`);
    
    // Check for fiscal year error and provide helpful message
    if (errorMsg.includes("fiscal year") || errorMsg.includes("no period is defined") || errorMsg.includes("posting period") || (errorMsg.includes("period") && errorMsg.includes("closed"))) {
      const diagnosticInfo = `
Document Date Used: ${docDate}
Original Date Requested: ${poData.docDate || 'not specified'}
Company Code: ${poData.companyCode}

This error means the posting period is closed or not configured for this date in company code ${poData.companyCode}.

SOLUTIONS:
1. IMMEDIATE FIX: Leave the document date empty - it will use today's date automatically
2. Check SAP posting periods: Transaction OB52
   - Verify posting periods are open for company code ${poData.companyCode}
   - Check if the current period is open
3. Contact your SAP administrator to open the posting period
4. Use a date within an open posting period (typically the current month)

SAP Error: ${errorMsg}`;
      
      throw new Error(diagnosticInfo);
    }
    
    throw new Error(errorMsg);
  }
  
  console.log(`[createPO] Final PO number: ${poNumber}`);
  
  if (!poNumber || poNumber.trim() === '') {
    console.error(`[createPO] No PO number found in EXPPURCHASEORDER or success messages!`);
    throw new Error("PO creation failed - no PO number returned");
  }

  console.log(`[createPO] PO ${poNumber} created, committing transaction...`);

  // Commit the transaction
  await callBAPI("BAPI_TRANSACTION_COMMIT", { WAIT: "X" }, {
    RETURN: [{ TYPE: "string", MESSAGE: "string" }]
  });

  console.log(`[createPO] Success: PO ${poNumber} created and committed`);

  // Separate messages by type for better UI display
  const warnings = returnTable.filter(r => r.TYPE === "W");
  const infoMsgs = returnTable.filter(r => r.TYPE === "I");
  const errorMsgs = returnTable.filter(r => r.TYPE === "E" || r.TYPE === "A");

  return {
    success: true,
    poNumber: poNumber,
    message: `PO ${poNumber} created successfully`,
    messages: returnTable,
    warnings: warnings.map(w => w.MESSAGE),
    errors: errorMsgs.map(e => e.MESSAGE),
    info: infoMsgs.map(i => i.MESSAGE)
  };
}

// ─── Get Vendor Performance Metrics ───────────────────────────────────────────
async function getVendorPerformance(vendorId) {
  if (USE_MOCK) {
    // Mock data for testing
    return {
      vendorId: vendorId,
      vendorName: `Vendor ${vendorId}`,
      totalPOs: 25,
      totalSpend: 125000.00,
      currency: "EUR",
      avgDeliveryDelay: 2.5,
      onTimeDeliveryPercent: 85.5,
      poList: [
        { ebeln: "4500017814", amount: 5000, scheduledDate: "20260320", actualDate: "20260322", delay: 2 },
        { ebeln: "4500017815", amount: 7500, scheduledDate: "20260318", actualDate: "20260318", delay: 0 }
      ]
    };
  }

  // FIX 1: Normalize vendor ID — strip any leading zeros, then re-pad to 10 chars.
  // This prevents double-padding if the frontend already sends a padded string.
  const normalizedVendorId = String(vendorId).replace(/^0+/, '').padStart(10, '0');

  console.log(`[getVendorPerformance] Getting performance metrics for vendor ${normalizedVendorId} (raw: ${vendorId})`);

  // FIX 2: Date filter — only look at POs from the past 1 year to avoid fetching decades of history.
  // SAP stores BEDAT as YYYYMMDD (string comparison works on this format).
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const fromDateSap = oneYearAgo.toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD

  console.log(`[getVendorPerformance] Date filter: BEDAT >= ${fromDateSap}`);

  try {
    // Step 1: Get recent POs for the vendor from EKKO (last 1 year)
    const ekkoResult = await callBAPI("RFC_READ_TABLE", {
      QUERY_TABLE: "EKKO",
      DELIMITER: "|",
      FIELDS: [
        { FIELDNAME: "EBELN" },
        { FIELDNAME: "LIFNR" },
        { FIELDNAME: "BEDAT" },
        { FIELDNAME: "WAERS" }
      ],
      OPTIONS: [
        { TEXT: `LIFNR = '${normalizedVendorId}'` },
        { TEXT: `AND BEDAT GE '${fromDateSap}'` }
      ],
      ROWCOUNT: 200
    }, {
      DATA: [{ WA: "string" }],
      FIELDS: [{ FIELDNAME: "string" }]
    });

    const poRows = ekkoResult.DATA || [];
    console.log(`[getVendorPerformance] Found ${poRows.length} POs for vendor ${normalizedVendorId} (last 1 year)`);

    if (poRows.length === 0) {
      return {
        vendorId: vendorId,
        vendorName: `Vendor ${vendorId}`,
        totalPOs: 0,
        totalSpend: 0,
        currency: "EUR",
        avgDeliveryDelay: 0,
        onTimeDeliveryPercent: 0,
        poList: []
      };
    }

    // Parse PO header data
    const poNumbers = [];
    let currency = "EUR";

    poRows.forEach(row => {
      const parts = row.WA.split("|");
      const ebeln = parts[0]?.trim();
      const waers = parts[3]?.trim();
      if (ebeln) poNumbers.push(ebeln);
      if (waers) currency = waers; // take currency from any row
    });

    // FIX 3: Batch EKPO queries — SAP's RFC_READ_TABLE OPTIONS has a 72-char line limit.
    // Sending `EBELN = 'X' OR EBELN = 'Y' OR ...` for many POs exceeds this limit and causes
    // SAP to reject the query or truncate the filter, returning zero rows.
    // Solution: send batches of 5 PO numbers per RFC_READ_TABLE call.
    let totalSpend = 0;
    const poAmounts = {};

    const BATCH_SIZE = 5;
    for (let i = 0; i < poNumbers.length; i += BATCH_SIZE) {
      const batch = poNumbers.slice(i, i + BATCH_SIZE);
      const options = batch.map((po, idx) =>
        idx === 0 ? `EBELN = '${po}'` : `OR EBELN = '${po}'`
      );

      try {
        const ekpoResult = await callBAPI("RFC_READ_TABLE", {
          QUERY_TABLE: "EKPO",
          DELIMITER: "|",
          FIELDS: [
            { FIELDNAME: "EBELN" },
            { FIELDNAME: "EBELP" },
            { FIELDNAME: "NETWR" }
          ],
          OPTIONS: options.map(text => ({ TEXT: text })),
          ROWCOUNT: 200
        }, {
          DATA: [{ WA: "string" }],
          FIELDS: [{ FIELDNAME: "string" }]
        });

        (ekpoResult.DATA || []).forEach(row => {
          const parts = row.WA.split("|");
          const ebeln = parts[0]?.trim();
          const netwr = parseFloat(parts[2]?.trim() || 0);
          if (ebeln) {
            poAmounts[ebeln] = (poAmounts[ebeln] || 0) + netwr;
            totalSpend += netwr;
          }
        });
      } catch (batchErr) {
        console.warn(`[getVendorPerformance] EKPO batch ${i}-${i + BATCH_SIZE} error (skipping):`, batchErr.message);
      }
    }

    console.log(`[getVendorPerformance] Total spend: ${totalSpend} ${currency}`);

    // Step 3: Get scheduled delivery dates from EKET — also batched
    const deliveryData = {};

    for (let i = 0; i < Math.min(poNumbers.length, 50); i += BATCH_SIZE) {
      const batch = poNumbers.slice(i, i + BATCH_SIZE);
      const options = batch.map((po, idx) =>
        idx === 0 ? `EBELN = '${po}'` : `OR EBELN = '${po}'`
      );

      try {
        const eketResult = await callBAPI("RFC_READ_TABLE", {
          QUERY_TABLE: "EKET",
          DELIMITER: "|",
          FIELDS: [
            { FIELDNAME: "EBELN" },
            { FIELDNAME: "EBELP" },
            { FIELDNAME: "EINDT" }
          ],
          OPTIONS: options.map(text => ({ TEXT: text })),
          ROWCOUNT: 200
        }, {
          DATA: [{ WA: "string" }],
          FIELDS: [{ FIELDNAME: "string" }]
        });

        (eketResult.DATA || []).forEach(row => {
          const parts = row.WA.split("|");
          const ebeln = parts[0]?.trim();
          const eindt = parts[2]?.trim();
          if (ebeln && eindt && !deliveryData[ebeln]) {
            // Keep earliest scheduled delivery date per PO
            deliveryData[ebeln] = eindt;
          }
        });
      } catch (batchErr) {
        console.warn(`[getVendorPerformance] EKET batch ${i}-${i + BATCH_SIZE} error (skipping):`, batchErr.message);
      }
    }

    // Step 4: Calculate delivery performance metrics
    let totalDelay = 0;
    let onTimeCount = 0;
    let deliveryCount = 0;
    const poList = [];
    const today = new Date();

    for (const po of poNumbers.slice(0, 20)) {
      const scheduledDate = deliveryData[po];
      const amount = poAmounts[po] || 0;

      if (scheduledDate && scheduledDate.length === 8) {
        // Parse YYYYMMDD
        const schYear  = parseInt(scheduledDate.slice(0, 4));
        const schMonth = parseInt(scheduledDate.slice(4, 6)) - 1;
        const schDay   = parseInt(scheduledDate.slice(6, 8));
        const schDateObj = new Date(schYear, schMonth, schDay);

        // Calculate delay in days (positive = late relative to today; 0 = future/on-time)
        const msPerDay = 1000 * 60 * 60 * 24;
        const delay = Math.max(0, Math.round((today - schDateObj) / msPerDay));
        const isOnTime = schDateObj >= today; // scheduled date is still in the future = on-time

        deliveryCount++;
        totalDelay += delay;
        if (isOnTime) onTimeCount++;

        poList.push({
          ebeln: po,
          amount: amount,
          scheduledDate: scheduledDate,
          actualDate: scheduledDate,
          delay: isOnTime ? 0 : delay
        });
      } else if (amount > 0) {
        // PO has spend but no schedule line yet — still include it
        poList.push({
          ebeln: po,
          amount: amount,
          scheduledDate: null,
          actualDate: null,
          delay: null
        });
      }
    }

    const avgDeliveryDelay = deliveryCount > 0 ? totalDelay / deliveryCount : 0;
    const onTimeDeliveryPercent = deliveryCount > 0 ? (onTimeCount / deliveryCount) * 100 : 0;

    console.log(`[getVendorPerformance] Avg delay: ${avgDeliveryDelay.toFixed(2)} days, On-time: ${onTimeDeliveryPercent.toFixed(1)}%`);

    return {
      vendorId: vendorId,
      vendorName: `Vendor ${vendorId}`,
      totalPOs: poNumbers.length,
      totalSpend: totalSpend,
      currency: currency,
      avgDeliveryDelay: parseFloat(avgDeliveryDelay.toFixed(2)),
      onTimeDeliveryPercent: parseFloat(onTimeDeliveryPercent.toFixed(1)),
      poList: poList
    };

  } catch (error) {
    console.error(`[getVendorPerformance] Error:`, error.message);
    throw error;
  }
}

// ─── Get Vendor List ──────────────────────────────────────────────────────────
async function getVendorList() {
  if (USE_MOCK) {
    return [
      { vendorId: "1000", vendorName: "Vendor 1000" },
      { vendorId: "3000", vendorName: "Vendor 3000" }
    ];
  }

  try {
    console.log(`[getVendorList] Getting vendors from EKKO (vendors with POs)...`);
    
    // Get vendors from EKKO instead of LFA1 - faster and more relevant
    // Only show vendors that actually have POs
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const fromDateSap = oneYearAgo.toISOString().slice(0, 10).replace(/-/g, '');
    
    const result = await callBAPI("RFC_READ_TABLE", {
      QUERY_TABLE: "EKKO",
      DELIMITER: "|",
      FIELDS: [
        { FIELDNAME: "LIFNR" }
      ],
      OPTIONS: [
        { TEXT: `BEDAT GE '${fromDateSap}'` }
      ],
      ROWCOUNT: 500
    }, {
      DATA: [{ WA: "string" }],
      FIELDS: [{ FIELDNAME: "string" }],
      RETURN: [{ TYPE: "string", MESSAGE: "string" }]
    });

    console.log(`[getVendorList] RFC_READ_TABLE returned ${result.DATA?.length || 0} rows`);
    
    // Log RETURN messages if any
    if (result.RETURN && result.RETURN.length > 0) {
      result.RETURN.forEach(msg => {
        console.log(`[getVendorList] SAP Message [${msg.TYPE}]: ${msg.MESSAGE}`);
      });
    }

    // Check if DATA exists and has rows
    if (!result.DATA || result.DATA.length === 0) {
      console.log(`[getVendorList] No vendor data returned from EKKO`);
      return [];
    }

    // Extract unique vendors with proper null checking
    const vendorSet = new Set();
    result.DATA.forEach(row => {
      if (row && row.WA) {
        const vendorId = row.WA.split("|")[0]?.trim();
        if (vendorId && vendorId !== "") {
          vendorSet.add(vendorId);
        }
      }
    });

    const vendors = Array.from(vendorSet).map(vendorId => ({
      vendorId: vendorId,
      vendorName: `Vendor ${vendorId}`
    }));

    console.log(`[getVendorList] Found ${vendors.length} unique vendors with POs`);
    return vendors;
    
  } catch (error) {
    console.error(`[getVendorList] Error:`, error.message);
    return [];
  }
}

// ─── Get Purchase Requisitions (PR) ───────────────────────────────────────────
async function getPurchaseRequisitions(fromDate, toDate) {
  if (USE_MOCK) {
    return [
      {
        BANFN: "0010000001",
        ERNAM: "USER01",
        ERDAT: "20260201",
        TOTAL_VALUE: 5000.00,
        WAERS: "USD",
        STATUS: "OPEN",
        ITEM_COUNT: 2,
        items: [
          { BNFPO: "00010", TXZ01: "Laptop", MENGE: 2, MEINS: "EA", PREIS: 1500.00, WERKS: "1000" },
          { BNFPO: "00020", TXZ01: "Monitor", MENGE: 4, MEINS: "EA", PREIS: 500.00, WERKS: "1000" }
        ]
      },
      {
        BANFN: "0010000002",
        ERNAM: "USER02",
        ERDAT: "20260203",
        TOTAL_VALUE: 3000.00,
        WAERS: "USD",
        STATUS: "OPEN",
        ITEM_COUNT: 1,
        items: [
          { BNFPO: "00010", TXZ01: "Office Supplies", MENGE: 10, MEINS: "EA", PREIS: 300.00, WERKS: "1000" }
        ]
      }
    ];
  }

  console.log(`[getPurchaseRequisitions] Fetching PRs from SAP using RFC_READ_TABLE on EBAN...`);

  // Default fromDate to 26 years ago if not provided
  // This ensures we capture all historical PRs
  const effectiveFromDate = fromDate || (() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 26); // Last 26 years
    return d.toISOString().slice(0, 10);
  })();

  const fromDateSap = convertToYYYYMMDD(effectiveFromDate);
  const toDateSap = toDate ? convertToYYYYMMDD(toDate) : convertToYYYYMMDD(new Date().toISOString().slice(0, 10));

  console.log(`[getPurchaseRequisitions] Date range: ${fromDateSap} to ${toDateSap}`);

  // DEBUG MODE: Set PR_INCLUDE_CONVERTED=true to see ALL PRs (including converted ones)
  const includeConverted = process.env.PR_INCLUDE_CONVERTED === 'true';
  if (includeConverted) {
    console.log(`[getPurchaseRequisitions] ⚠️  DEBUG MODE: Including PRs already converted to POs`);
  }

  try {
    // Use RFC_READ_TABLE on EBAN (PR items table)
    // EBAN fields: BANFN (PR number), BNFPO (PR item), TXZ01 (description), MENGE (quantity), 
    //              MEINS (unit), PREIS (price), PEINH (price unit), WAERS (currency), 
    //              WERKS (plant), ERDAT (creation date), ERNAM (creator), EBELN (PO number)
    
    const options = [
      { TEXT: `ERDAT GE '${fromDateSap}'` },
      { TEXT: `AND ERDAT LE '${toDateSap}'` }
    ];
    
    // Only filter out converted PRs if not in debug mode
    if (!includeConverted) {
      options.push({ TEXT: `AND EBELN = ''` });  // Filter out PRs already converted to PO
    }
    
    const result = await callBAPI("RFC_READ_TABLE", {
      QUERY_TABLE: "EBAN",
      DELIMITER: "|",
      FIELDS: [
        { FIELDNAME: "BANFN" },
        { FIELDNAME: "BNFPO" },
        { FIELDNAME: "TXZ01" },
        { FIELDNAME: "MENGE" },
        { FIELDNAME: "MEINS" },
        { FIELDNAME: "PREIS" },
        { FIELDNAME: "PEINH" },
        { FIELDNAME: "WAERS" },
        { FIELDNAME: "WERKS" },
        { FIELDNAME: "ERDAT" },
        { FIELDNAME: "ERNAM" },
        { FIELDNAME: "EBELN" }
      ],
      OPTIONS: options,
      ROWCOUNT: 500
    }, {
      DATA: [{ WA: "string" }],
      FIELDS: [{ FIELDNAME: "string" }],
      RETURN: [{ TYPE: "string", MESSAGE: "string" }]
    });

    console.log(`[getPurchaseRequisitions] RFC_READ_TABLE returned ${result.DATA?.length || 0} rows`);

    if (!result.DATA || result.DATA.length === 0) {
      console.log(`[getPurchaseRequisitions] No PRs found`);
      return [];
    }

    // Parse and group items by PR number
    const prMap = new Map();

    result.DATA.forEach(row => {
      const parts = row.WA.split("|");
      const banfn = parts[0]?.trim();
      const bnfpo = parts[1]?.trim();
      const txz01 = parts[2]?.trim();
      const menge = parseFloat(parts[3]?.trim() || 0);
      const meins = parts[4]?.trim();
      const preis = parseFloat(parts[5]?.trim() || 0);
      const peinh = parseFloat(parts[6]?.trim() || 1);
      const waers = parts[7]?.trim() || "USD";
      const werks = parts[8]?.trim();
      const erdat = parts[9]?.trim();
      const ernam = parts[10]?.trim();
      const ebeln = parts[11]?.trim();

      // Skip if already converted to PO (unless in debug mode)
      if (!includeConverted && ebeln && ebeln !== "") {
        console.log(`[getPurchaseRequisitions] Skipping PR ${banfn} item ${bnfpo} - already converted to PO ${ebeln}`);
        return;
      }

      if (!prMap.has(banfn)) {
        prMap.set(banfn, {
          BANFN: banfn,
          ERNAM: ernam,
          ERDAT: erdat,
          WAERS: waers,
          TOTAL_VALUE: 0,
          STATUS: (ebeln && ebeln !== "") ? "CONVERTED" : "OPEN",
          EBELN: ebeln || null,  // Include PO number if converted (for debug mode)
          items: []
        });
      }

      const pr = prMap.get(banfn);
      const itemValue = menge * (preis / peinh);
      pr.TOTAL_VALUE += itemValue;

      pr.items.push({
        BNFPO: bnfpo,
        TXZ01: txz01,
        MENGE: menge,
        MEINS: meins,
        PREIS: preis / peinh,
        WERKS: werks
      });
    });

    const prs = Array.from(prMap.values()).map(pr => ({
      ...pr,
      ITEM_COUNT: pr.items.length
    }));
    
    if (includeConverted) {
      const openCount = prs.filter(pr => pr.STATUS === "OPEN").length;
      const convertedCount = prs.filter(pr => pr.STATUS === "CONVERTED").length;
      console.log(`[getPurchaseRequisitions] Found ${prs.length} total PRs (${openCount} open, ${convertedCount} converted)`);
    } else {
      console.log(`[getPurchaseRequisitions] Found ${prs.length} open PRs ready to convert to PO`);
    }

    return prs;

  } catch (error) {
    console.error(`[getPurchaseRequisitions] Error:`, error.message);
    throw error;
  }
}

// ─── Get PR Detail ────────────────────────────────────────────────────────────
async function getPRDetail(banfn) {
  if (USE_MOCK) {
    const mockPRs = await getPurchaseRequisitions();
    const pr = mockPRs.find(p => p.BANFN === banfn);
    if (!pr) throw new Error(`PR ${banfn} not found`);
    return pr;
  }

  console.log(`[getPRDetail] Getting details for PR ${banfn} using RFC_READ_TABLE on EBAN...`);

  try {
    // Use RFC_READ_TABLE on EBAN to get PR details
    const result = await callBAPI("RFC_READ_TABLE", {
      QUERY_TABLE: "EBAN",
      DELIMITER: "|",
      FIELDS: [
        { FIELDNAME: "BANFN" },
        { FIELDNAME: "BNFPO" },
        { FIELDNAME: "TXZ01" },
        { FIELDNAME: "MENGE" },
        { FIELDNAME: "MEINS" },
        { FIELDNAME: "PREIS" },
        { FIELDNAME: "PEINH" },
        { FIELDNAME: "WAERS" },
        { FIELDNAME: "WERKS" },
        { FIELDNAME: "ERDAT" },
        { FIELDNAME: "ERNAM" },
        { FIELDNAME: "MATNR" },
        { FIELDNAME: "LGORT" },
        { FIELDNAME: "EKGRP" }
      ],
      OPTIONS: [
        { TEXT: `BANFN = '${banfn}'` }
      ],
      ROWCOUNT: 100
    }, {
      DATA: [{ WA: "string" }],
      FIELDS: [{ FIELDNAME: "string" }],
      RETURN: [{ TYPE: "string", MESSAGE: "string" }]
    });

    if (!result.DATA || result.DATA.length === 0) {
      throw new Error(`PR ${banfn} not found`);
    }

    console.log(`[getPRDetail] Retrieved ${result.DATA.length} items for PR ${banfn}`);

    // Parse items
    let totalValue = 0;
    let ernam = "";
    let erdat = "";
    let waers = "USD";
    let ekgrp = "";
    
    const items = result.DATA.map(row => {
      const parts = row.WA.split("|");
      const bnfpo = parts[1]?.trim();
      const txz01 = parts[2]?.trim();
      const menge = parseFloat(parts[3]?.trim() || 0);
      const meins = parts[4]?.trim();
      const preis = parseFloat(parts[5]?.trim() || 0);
      const peinh = parseFloat(parts[6]?.trim() || 1);
      const itemWaers = parts[7]?.trim();
      const werks = parts[8]?.trim();
      const itemErdat = parts[9]?.trim();
      const itemErnam = parts[10]?.trim();
      const matnr = parts[11]?.trim();
      const lgort = parts[12]?.trim();
      const itemEkgrp = parts[13]?.trim();

      // Capture header data from first item
      if (!ernam) ernam = itemErnam;
      if (!erdat) erdat = itemErdat;
      if (itemWaers) waers = itemWaers;
      if (itemEkgrp) ekgrp = itemEkgrp;

      const itemPrice = preis / peinh;
      const itemValue = menge * itemPrice;
      totalValue += itemValue;

      return {
        BNFPO: bnfpo,
        TXZ01: txz01,
        MENGE: menge,
        MEINS: meins,
        PREIS: itemPrice,
        WERKS: werks,
        MATNR: matnr,
        LGORT: lgort
      };
    });

    const pr = {
      BANFN: banfn,
      ERNAM: ernam,
      ERDAT: erdat,
      WAERS: waers,
      EKGRP: ekgrp,
      TOTAL_VALUE: totalValue,
      STATUS: "OPEN",
      items: items
    };

    console.log(`[getPRDetail] PR ${banfn} has ${items.length} items, total value: ${pr.WAERS} ${totalValue.toFixed(2)}`);

    return pr;

  } catch (error) {
    console.error(`[getPRDetail] Error:`, error.message);
    throw error;
  }
}

// ─── Create PO from PR ────────────────────────────────────────────────────────
async function createPOFromPR(prNumber, poData) {
  console.log(`[createPOFromPR] Creating PO from PR ${prNumber}...`);
  
  // Get PR details first
  const pr = await getPRDetail(prNumber);
  
  // Merge PR data with user-provided PO data
  const mergedData = {
    vendor: poData.vendor || pr.LIFNR,
    companyCode: poData.companyCode,
    purchOrg: poData.purchOrg,
    purchGroup: poData.purchGroup || pr.EKGRP,
    docType: poData.docType || "NB",
    docDate: poData.docDate,
    currency: poData.currency || pr.WAERS,
    deliveryDate: poData.deliveryDate,
    items: poData.items || pr.items.map(item => ({
      description: item.TXZ01,
      material: item.MATNR,
      quantity: item.MENGE,
      unit: item.MEINS,
      netPrice: item.PREIS,
      plant: item.WERKS,
      storageLocation: item.LGORT,
      prNumber: prNumber,
      prItem: item.BNFPO
    }))
  };

  console.log(`[createPOFromPR] Merged PO data:`, JSON.stringify(mergedData, null, 2));

  // Create the PO using existing createPO function
  const result = await createPO(mergedData);
  
  console.log(`[createPOFromPR] PO ${result.poNumber} created from PR ${prNumber}`);
  
  return result;
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
  createPOFromPR,
  USE_MOCK 
};
