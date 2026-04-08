"use strict";

/**
 * AI Agent Service using Google Gemini
 * Provides natural language interface to SAP operations
 */

const { GoogleGenerativeAI } = require("@google/generative-ai");
const mcp = require("./mcpClient");

// Load API keys from environment
const API_KEYS = [
  process.env.GEMINI_API_KEY_1,
  process.env.GEMINI_API_KEY_2
].filter(key => key); // Remove undefined keys

if (API_KEYS.length === 0) {
  throw new Error("No Gemini API keys configured. Please set GEMINI_API_KEY_1 and/or GEMINI_API_KEY_2 in .env file");
}

console.log(`[AI Agent] Loaded ${API_KEYS.length} API key(s)`);

// Track current key index and failure counts
let currentKeyIndex = 0;
let keyFailureCounts = new Array(API_KEYS.length).fill(0);
const MAX_FAILURES_PER_KEY = 3;

/**
 * Get the next available API key
 */
function getNextApiKey() {
  // Try to find a key that hasn't failed too many times
  for (let i = 0; i < API_KEYS.length; i++) {
    const index = (currentKeyIndex + i) % API_KEYS.length;
    if (keyFailureCounts[index] < MAX_FAILURES_PER_KEY) {
      currentKeyIndex = index;
      console.log(`[AI Agent] Using API key #${index + 1}`);
      return API_KEYS[index];
    }
  }
  
  // All keys have failed, reset counters and try again
  console.warn(`[AI Agent] All API keys exhausted, resetting failure counts`);
  keyFailureCounts = new Array(API_KEYS.length).fill(0);
  currentKeyIndex = 0;
  return API_KEYS[0];
}

/**
 * Mark current key as failed and rotate to next
 */
function markKeyAsFailed(error) {
  keyFailureCounts[currentKeyIndex]++;
  console.warn(`[AI Agent] API key #${currentKeyIndex + 1} failed (${keyFailureCounts[currentKeyIndex]}/${MAX_FAILURES_PER_KEY}): ${error}`);
  
  // Move to next key
  currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length;
}

/**
 * Check if error is quota/rate limit related
 */
function isQuotaError(error) {
  const errorStr = error.toString().toLowerCase();
  return errorStr.includes('429') || 
         errorStr.includes('503') ||
         errorStr.includes('quota') || 
         errorStr.includes('rate limit') ||
         errorStr.includes('resource_exhausted') ||
         errorStr.includes('high demand');
}

// Define tools/functions that AI can use
const tools = [
  {
    name: "get_pending_pos",
    description: "Get list of pending purchase orders. Can filter by release code, date range, or vendor. Returns array of PO objects with EBELN, LIFNR, WAERS, NETWR, BEDAT, STATUS fields.",
    parameters: {
      type: "object",
      properties: {
        releaseCode: {
          type: "string",
          description: "Filter by release code (optional). Example: 'R', 'B', 'FR'"
        },
        fromDate: {
          type: "string",
          description: "Start date in YYYY-MM-DD format (optional). Example: '2026-01-01'"
        },
        toDate: {
          type: "string",
          description: "End date in YYYY-MM-DD format (optional). Example: '2026-12-31'"
        }
      }
    }
  },
  {
    name: "get_po_detail",
    description: "Get detailed information about a specific purchase order including items, vendor, amounts, release status, and line items. Returns PO object with header and items array.",
    parameters: {
      type: "object",
      properties: {
        poNumber: {
          type: "string",
          description: "Purchase order number. Example: '4500022395'"
        }
      },
      required: ["poNumber"]
    }
  },
  {
    name: "approve_po",
    description: "Approve a purchase order with a specific release code. This executes BAPI_PO_RELEASE in SAP. Returns success message with new release status.",
    parameters: {
      type: "object",
      properties: {
        poNumber: {
          type: "string",
          description: "Purchase order number to approve. Example: '4500022395'"
        },
        releaseCode: {
          type: "string",
          description: "Release code for approval. Must be valid for the PO's release strategy. Example: 'R', 'B', 'FR'"
        }
      },
      required: ["poNumber", "releaseCode"]
    }
  },
  {
    name: "reset_po_release",
    description: "Reset/undo the release approval for a purchase order. Use the SAME release code that was used to approve (check FRGKE field). This executes BAPI_PO_RESET_RELEASE in SAP.",
    parameters: {
      type: "object",
      properties: {
        poNumber: {
          type: "string",
          description: "Purchase order number. Example: '4500022395'"
        },
        releaseCode: {
          type: "string",
          description: "Release code to reset. MUST match the current FRGKE value. Example: 'R'"
        }
      },
      required: ["poNumber", "releaseCode"]
    }
  },
  {
    name: "get_vendor_performance",
    description: "Get performance metrics for a specific vendor including total POs, total spend, on-time delivery percentage, average delivery delay, and list of recent POs with delivery dates.",
    parameters: {
      type: "object",
      properties: {
        vendorId: {
          type: "string",
          description: "Vendor ID. Can be with or without leading zeros. Example: '1000' or '0000001015'"
        }
      },
      required: ["vendorId"]
    }
  },
  {
    name: "create_po",
    description: "Create a new purchase order in SAP with specified vendor, company code, purchasing org, and line items. Returns new PO number.",
    parameters: {
      type: "object",
      properties: {
        vendor: {
          type: "string",
          description: "Vendor ID. Example: '1000'"
        },
        companyCode: {
          type: "string",
          description: "Company code. Example: '1000'"
        },
        purchOrg: {
          type: "string",
          description: "Purchasing organization. Example: '1000'"
        },
        purchGroup: {
          type: "string",
          description: "Purchasing group. Example: '001'"
        },
        items: {
          type: "array",
          description: "Array of line items for the PO",
          items: {
            type: "object",
            properties: {
              description: { type: "string", description: "Item description" },
              quantity: { type: "number", description: "Quantity to order" },
              unit: { type: "string", description: "Unit of measure. Example: 'EA', 'KG'" },
              netPrice: { type: "number", description: "Price per unit" },
              plant: { type: "string", description: "Plant code. Example: '1000'" },
              material: { type: "string", description: "Material number (optional). Example: '100-100'" }
            },
            required: ["description", "quantity", "unit", "netPrice", "plant"]
          }
        }
      },
      required: ["vendor", "companyCode", "purchOrg", "purchGroup", "items"]
    }
  }
];

// System instruction for Gemini
const SYSTEM_INSTRUCTION = `You are an intelligent procurement assistant for an SAP-integrated purchase order management system.

Your role:
- Help users manage purchase orders efficiently through natural language commands
- Execute SAP operations using the available functions
- Provide clear, concise, and actionable responses
- Always confirm what actions you performed

Important guidelines:
1. When resetting PO releases, use the SAME release code from the FRGKE field (not the original approval code)
2. For bulk operations (e.g., "approve all POs from vendor X"), first get the list, then approve each one
3. Always provide summaries with PO numbers and amounts after operations
4. If information is missing, ask clarifying questions
5. Be proactive: understand user intent and execute appropriate actions
6. Format responses clearly with bullet points for lists
7. Use emojis sparingly for visual clarity (✅ for success, ⚠️ for warnings, 📊 for data)

Available operations:
- View PO lists and details
- Approve/reset PO releases  
- Check vendor performance metrics
- Create new purchase orders
- Analyze and compare data

Always be helpful, efficient, and accurate!`;

/**
 * Main chat function - processes user message and executes appropriate tools
 * Includes automatic API key rotation on quota/rate limit errors
 */
async function chat(userMessage, context = {}) {
  const maxRetries = API_KEYS.length;
  let lastError = null;

  // Try with different API keys if needed
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      console.log(`[AI Agent] Processing message (attempt ${attempt + 1}/${maxRetries}): "${userMessage}"`);
      console.log(`[AI Agent] Context:`, context);

      // Get current API key
      const apiKey = getNextApiKey();
      const genAI = new GoogleGenerativeAI(apiKey);

      // Initialize model with function calling
      const model = genAI.getGenerativeModel({
        model: "gemini-2.5-flash-lite"
      });

      // Build context-aware prompt
      let contextPrompt = "";
      if (context.currentView) {
        contextPrompt += `User is currently viewing: ${context.currentView}. `;
      }
      if (context.currentPO) {
        contextPrompt += `Current PO in view: ${context.currentPO}. `;
      }
      
      const fullPrompt = contextPrompt + userMessage;

      // Start chat session with system instruction and tools
      const chat = model.startChat({
        generationConfig: {
          temperature: 0.7,
          topP: 0.8,
          topK: 40,
          maxOutputTokens: 2048,
        },
        systemInstruction: {
          parts: [{ text: SYSTEM_INSTRUCTION }]
        },
        tools: [{ functionDeclarations: tools }],
        history: []
      });

      let actionPerformed = false;
      let finalResponse = "";

      // Send message and get response
      const result = await chat.sendMessage(fullPrompt);
      const response = result.response;

      // Check if AI wants to call functions
      const functionCalls = response.functionCalls();
      
      if (functionCalls && functionCalls.length > 0) {
        console.log(`[AI Agent] AI requested ${functionCalls.length} function call(s)`);
        
        // Execute all function calls
        const functionResponses = [];
        
        for (const call of functionCalls) {
          console.log(`[AI Agent] Executing function: ${call.name}`, call.args);
          
          try {
            const toolResult = await executeTool(call.name, call.args);
            functionResponses.push({
              functionResponse: {
                name: call.name,
                response: toolResult
              }
            });
            actionPerformed = true;
            console.log(`[AI Agent] Function ${call.name} executed successfully`);
          } catch (error) {
            console.error(`[AI Agent] Function ${call.name} failed:`, error.message);
            functionResponses.push({
              functionResponse: {
                name: call.name,
                response: { error: error.message }
              }
            });
          }
        }

        // Send function results back to AI for final response
        const finalResult = await chat.sendMessage(functionResponses);
        finalResponse = finalResult.response.text();
        
      } else {
        // No function calls, just return the text response
        finalResponse = response.text();
      }

      console.log(`[AI Agent] Final response: ${finalResponse.substring(0, 100)}...`);

      // Success! Reset failure count for this key
      keyFailureCounts[currentKeyIndex] = 0;

      return {
        success: true,
        response: finalResponse,
        actionPerformed: actionPerformed
      };

    } catch (error) {
      console.error(`[AI Agent] Error on attempt ${attempt + 1}:`, error.message);
      lastError = error;

      // Check if it's a quota/rate limit error
      if (isQuotaError(error)) {
        markKeyAsFailed(error.message);
        
        // If we have more keys to try, continue
        if (attempt < maxRetries - 1) {
          console.log(`[AI Agent] Retrying with next API key...`);
          continue;
        }
      } else {
        // Non-quota error, don't retry
        break;
      }
    }
  }

  // All attempts failed
  console.error("[AI Agent] All API keys exhausted or non-recoverable error");
  return {
    success: false,
    error: lastError?.message || "AI agent failed to process request"
  };
}

/**
 * Execute a tool/function by calling the appropriate MCP client method
 */
async function executeTool(toolName, args) {
  switch (toolName) {
    case "get_pending_pos":
      return await mcp.getPendingPOs(args.releaseCode, args.fromDate, args.toDate);

    case "get_po_detail":
      return await mcp.getPODetail(args.poNumber);

    case "approve_po":
      return await mcp.approvePO(args.poNumber, args.releaseCode);

    case "reset_po_release":
      return await mcp.rejectPO(args.poNumber, args.releaseCode);

    case "get_vendor_performance":
      return await mcp.getVendorPerformance(args.vendorId);

    case "create_po":
      return await mcp.createPO(args);

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

module.exports = { chat };
