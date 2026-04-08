/**
 * Simple script to fetch PO data using the SAP client directly
 */

require("dotenv").config();

// Set to LIVE mode
process.env.USE_MOCK = "false";

const sapClient = require("./mcp-server/sap/sapClient");

async function main() {
  try {
    console.log("🚀 Fetching PO data from SAP via Flow MCP...\n");
    console.log(`Mode: ${process.env.USE_MOCK === "false" ? "LIVE" : "MOCK"}`);
    console.log(`API Key: ${process.env.FLOW_API_KEY?.substring(0, 15)}...`);
    console.log();

    // Fetch PO list
    console.log("📋 Fetching PO list (last 1 year)...\n");
    const poList = await sapClient.getPendingPOs();
    
    console.log(`✅ Found ${poList.length} POs\n`);
    
    if (poList.length > 0) {
      console.log("Purchase Orders:");
      console.log("═".repeat(80));
      
      poList.slice(0, 10).forEach((po, index) => {
        console.log(`\n${index + 1}. PO Number: ${po.EBELN}`);
        console.log(`   Vendor: ${po.VENDOR || po.LIFNR}`);
        console.log(`   Date: ${po.DOC_DATE || po.BEDAT}`);
        console.log(`   Currency: ${po.CURRENCY || po.WAERS}`);
        console.log(`   Release Strategy: ${po.RELEASE_STRATEGY || po.FRGKE || "N/A"}`);
        console.log(`   Release Status: ${po.RELEASE_STATUS || po.FRGZU || "N/A"}`);
      });
      
      if (poList.length > 10) {
        console.log(`\n... and ${poList.length - 10} more POs`);
      }
      
      console.log("\n" + "═".repeat(80));
      
      // Fetch details for the first PO
      const firstPO = poList[0];
      console.log(`\n\n🔍 Fetching details for PO ${firstPO.EBELN}...\n`);
      
      const poDetail = await sapClient.getPODetail(firstPO.EBELN);
      
      console.log("✅ PO Details:");
      console.log("═".repeat(80));
      console.log(`PO Number: ${poDetail.EBELN}`);
      console.log(`Vendor: ${poDetail.VENDOR}`);
      console.log(`Document Date: ${poDetail.DOC_DATE}`);
      console.log(`Currency: ${poDetail.CURRENCY}`);
      console.log(`Company Code: ${poDetail.COMPANY_CODE || "N/A"}`);
      console.log(`Release Strategy: ${poDetail.RELEASE_STRATEGY || "N/A"}`);
      console.log(`Release Status: ${poDetail.RELEASE_STATUS || "N/A"}`);
      
      if (poDetail.ITEMS && poDetail.ITEMS.length > 0) {
        console.log("\nLine Items:");
        console.log("─".repeat(80));
        
        poDetail.ITEMS.forEach((item, index) => {
          console.log(`\nItem ${index + 1}:`);
          console.log(`  Line: ${item.PO_ITEM || item.EBELP}`);
          console.log(`  Material: ${item.MATERIAL || item.MATNR}`);
          console.log(`  Quantity: ${item.QUANTITY || item.MENGE} ${item.UNIT || item.MEINS}`);
          console.log(`  Price: ${item.PRICE || item.NETPR} ${poDetail.CURRENCY}`);
          console.log(`  Delivery Date: ${item.DELIVERY_DATE || "N/A"}`);
        });
      }
      
      console.log("\n" + "═".repeat(80));
    } else {
      console.log("⚠️  No POs found in the specified date range");
    }
    
    console.log("\n✅ Done!");
    
  } catch (error) {
    console.error("\n❌ Error:", error.message);
    console.error("\nStack trace:");
    console.error(error.stack);
    process.exit(1);
  }
}

main();
