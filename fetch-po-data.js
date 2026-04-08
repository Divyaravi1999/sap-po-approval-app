/**
 * Fetch PO data using the MCP server
 * This script connects to the local MCP server and uses its tools to fetch PO data from SAP
 */

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

async function fetchPOData() {
  console.log("🚀 Connecting to MCP server...\n");

  // Create MCP client
  const transport = new StdioClientTransport({
    command: "node",
    args: ["mcp-server/server.js"],
    env: { ...process.env, USE_MOCK: "false" }
  });

  const client = new Client({
    name: "po-fetch-client",
    version: "1.0.0"
  }, {
    capabilities: {}
  });

  try {
    await client.connect(transport);
    console.log("✅ Connected to MCP server\n");

    // List available tools
    const tools = await client.listTools();
    console.log("📋 Available tools:");
    tools.tools.forEach(tool => {
      console.log(`   - ${tool.name}: ${tool.description}`);
    });
    console.log();

    // Fetch PO list
    console.log("🔍 Fetching PO list...\n");
    const poListResult = await client.callTool({
      name: "get_pending_pos",
      arguments: {}
    });

    console.log("✅ PO List Result:");
    const poList = JSON.parse(poListResult.content[0].text);
    console.log(JSON.stringify(poList, null, 2));
    console.log();

    // If we have POs, fetch details for the first one
    if (poList.length > 0) {
      const firstPO = poList[0];
      console.log(`\n🔍 Fetching details for PO ${firstPO.EBELN}...\n`);

      const poDetailResult = await client.callTool({
        name: "get_po_detail",
        arguments: {
          po_number: firstPO.EBELN
        }
      });

      console.log("✅ PO Details:");
      const poDetail = JSON.parse(poDetailResult.content[0].text);
      console.log(JSON.stringify(poDetail, null, 2));
      console.log();

      // Display formatted output
      console.log("\n📄 Formatted PO Details:");
      console.log("═".repeat(60));
      console.log(`PO Number: ${poDetail.EBELN}`);
      console.log(`Vendor: ${poDetail.VENDOR}`);
      console.log(`Document Date: ${poDetail.DOC_DATE}`);
      console.log(`Currency: ${poDetail.CURRENCY}`);
      console.log(`Release Strategy: ${poDetail.RELEASE_STRATEGY || "N/A"}`);
      console.log(`Release Status: ${poDetail.RELEASE_STATUS || "N/A"}`);
      console.log("\nLine Items:");
      console.log("─".repeat(60));
      
      if (poDetail.ITEMS && poDetail.ITEMS.length > 0) {
        poDetail.ITEMS.forEach((item, index) => {
          console.log(`\nItem ${index + 1}:`);
          console.log(`  Material: ${item.MATERIAL}`);
          console.log(`  Quantity: ${item.QUANTITY} ${item.UNIT}`);
          console.log(`  Price: ${item.PRICE} ${poDetail.CURRENCY}`);
          console.log(`  Delivery Date: ${item.DELIVERY_DATE}`);
        });
      }
      console.log("═".repeat(60));
    }

    await client.close();
    console.log("\n✅ Done!");

  } catch (error) {
    console.error("\n❌ Error:", error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

fetchPOData();
