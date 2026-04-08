require("dotenv").config();
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const FLOW_API_KEY = process.env.FLOW_API_KEY;
const FLOW_MCP_URL = "https://flow.pillir.ai/mcp/sse";

async function callFlowMCP(functionName, parameters) {
  console.log(`\n📞 Calling ${functionName}...`);
  console.log("Parameters:", JSON.stringify(parameters, null, 2));

  const response = await fetch(FLOW_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-FLOW-API-KEY": FLOW_API_KEY,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: {
        name: "execute_function",
        arguments: {
          function_name: functionName,
          parameters: parameters,
        },
      },
    }),
  });

  const text = await response.text();
  console.log("\n📥 Raw Response:", text.substring(0, 500));

  // Parse SSE format
  const lines = text.split("\n");
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      const data = JSON.parse(line.substring(6));
      if (data.type === "result") {
        return data.result;
      }
    }
  }

  throw new Error("No result found in response");
}

async function getPOList() {
  console.log("\n🔍 Fetching PO List from SAP...");
  
  // Get current date and 1 year ago
  const today = new Date();
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(today.getFullYear() - 1);
  
  const startDate = oneYearAgo.toISOString().split("T")[0].replace(/-/g, "");
  const endDate = today.toISOString().split("T")[0].replace(/-/g, "");
  
  console.log(`Date range: ${startDate} to ${endDate}`);

  const result = await callFlowMCP("RFC_READ_TABLE", {
    QUERY_TABLE: "EKKO",
    DELIMITER: "|",
    FIELDS: [
      { FIELDNAME: "EBELN" },
      { FIELDNAME: "LIFNR" },
      { FIELDNAME: "BEDAT" },
      { FIELDNAME: "WAERS" },
      { FIELDNAME: "FRGKE" },
      { FIELDNAME: "FRGZU" },
    ],
    OPTIONS: [
      { TEXT: `BEDAT >= '${startDate}'` },
      { TEXT: `AND BEDAT <= '${endDate}'` },
    ],
    ROWCOUNT: 20,
  });

  console.log("\n✅ PO List Result:");
  console.log(JSON.stringify(result, null, 2));

  // Parse the data
  if (result.DATA && result.DATA.length > 0) {
    console.log("\n📋 Purchase Orders:");
    result.DATA.forEach((row, index) => {
      const values = row.WA.split("|");
      console.log(`\n${index + 1}. PO: ${values[0]?.trim()}`);
      console.log(`   Vendor: ${values[1]?.trim()}`);
      console.log(`   Date: ${values[2]?.trim()}`);
      console.log(`   Currency: ${values[3]?.trim()}`);
      console.log(`   Release Strategy: ${values[4]?.trim()}`);
      console.log(`   Release Status: ${values[5]?.trim()}`);
    });
  }

  return result;
}

async function getPODetails(poNumber) {
  console.log(`\n🔍 Fetching Details for PO ${poNumber}...`);

  // Get header details from EKKO
  const headerResult = await callFlowMCP("RFC_READ_TABLE", {
    QUERY_TABLE: "EKKO",
    DELIMITER: "|",
    FIELDS: [
      { FIELDNAME: "EBELN" },
      { FIELDNAME: "LIFNR" },
      { FIELDNAME: "BEDAT" },
      { FIELDNAME: "WAERS" },
      { FIELDNAME: "FRGKE" },
      { FIELDNAME: "FRGZU" },
    ],
    OPTIONS: [{ TEXT: `EBELN = '${poNumber}'` }],
    ROWCOUNT: 1,
  });

  console.log("\n✅ PO Header:");
  console.log(JSON.stringify(headerResult, null, 2));

  if (headerResult.DATA && headerResult.DATA.length > 0) {
    const values = headerResult.DATA[0].WA.split("|");
    console.log("\n📄 PO Header Details:");
    console.log(`   PO Number: ${values[0]?.trim()}`);
    console.log(`   Vendor: ${values[1]?.trim()}`);
    console.log(`   Document Date: ${values[2]?.trim()}`);
    console.log(`   Currency: ${values[3]?.trim()}`);
    console.log(`   Release Strategy: ${values[4]?.trim()}`);
    console.log(`   Release Status: ${values[5]?.trim()}`);
  }

  // Get line items from EKPO
  const itemsResult = await callFlowMCP("RFC_READ_TABLE", {
    QUERY_TABLE: "EKPO",
    DELIMITER: "|",
    FIELDS: [
      { FIELDNAME: "EBELN" },
      { FIELDNAME: "EBELP" },
      { FIELDNAME: "MATNR" },
      { FIELDNAME: "MENGE" },
      { FIELDNAME: "MEINS" },
      { FIELDNAME: "NETPR" },
    ],
    OPTIONS: [{ TEXT: `EBELN = '${poNumber}'` }],
    ROWCOUNT: 100,
  });

  console.log("\n✅ PO Line Items:");
  console.log(JSON.stringify(itemsResult, null, 2));

  if (itemsResult.DATA && itemsResult.DATA.length > 0) {
    console.log("\n📦 Line Items:");
    itemsResult.DATA.forEach((row, index) => {
      const values = row.WA.split("|");
      console.log(`\n   Item ${index + 1}:`);
      console.log(`      Line: ${values[1]?.trim()}`);
      console.log(`      Material: ${values[2]?.trim()}`);
      console.log(`      Quantity: ${values[3]?.trim()} ${values[4]?.trim()}`);
      console.log(`      Price: ${values[5]?.trim()}`);
    });
  }

  return { header: headerResult, items: itemsResult };
}

async function main() {
  try {
    console.log("🚀 Starting Flow MCP PO Fetch...");
    console.log(`API Key: ${FLOW_API_KEY?.substring(0, 10)}...`);

    // Fetch PO list
    const poList = await getPOList();

    // If we have POs, fetch details for the first one
    if (poList.DATA && poList.DATA.length > 0) {
      const firstPO = poList.DATA[0].WA.split("|")[0]?.trim();
      if (firstPO) {
        await getPODetails(firstPO);
      }
    }

    console.log("\n✅ Done!");
  } catch (error) {
    console.error("\n❌ Error:", error.message);
    console.error(error.stack);
  }
}

main();
