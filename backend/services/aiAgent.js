"use strict";

/**
 * AI Agent — regex intent classification + deterministic slot-filling
 * Gemini is used ONLY for initial entity extraction on the first turn.
 * All slot-fill answers (follow-up turns) are handled by deterministic code.
 */

const { GoogleGenerativeAI } = require("@google/generative-ai");
const mcp = require("./mcpClient");

// ─── Gemini setup ─────────────────────────────────────────────────────────────
const API_KEYS = [process.env.GEMINI_API_KEY_1, process.env.GEMINI_API_KEY_2].filter(Boolean);
if (!API_KEYS.length) throw new Error("No Gemini API keys configured.");
let _keyIdx = 0;
const MODELS = ["gemini-2.5-flash-lite", "gemini-1.5-flash", "gemini-1.5-flash-8b"];
let _modelIdx = 0;
function getApiKey() { return API_KEYS[_keyIdx % API_KEYS.length]; }
function nextKey()   { _keyIdx = (_keyIdx + 1) % API_KEYS.length; }
function nextModel() { _modelIdx = (_modelIdx + 1) % MODELS.length; }
function getModel()  { return MODELS[_modelIdx % MODELS.length]; }
function isQuota(e)  {
  const s = String(e).toLowerCase();
  return s.includes("429") || s.includes("503") || s.includes("quota") || s.includes("rate limit");
}

// ─── Session store ────────────────────────────────────────────────────────────
const sessions = new Map();
function getSession(id) {
  if (!id) id = "default";
  if (!sessions.has(id)) sessions.set(id, newSession());
  return sessions.get(id);
}
function newSession() {
  return {
    intent:       null,   // CREATE_PO | APPROVE_PO | RESET_PO | GET_PO_DETAILS | LIST_PENDING_POS
    fields:       {},     // collected: vendor, poNumber, releaseCode, items
    pendingSlot:  null,   // which slot we're currently waiting for
    lastResponse: null,
    turnCount:    0
  };
}
function clearSession(id) { sessions.set(id || "default", newSession()); }
const MAX_TURNS = 10;

// ─── Intent classification (pure regex, always reliable) ─────────────────────
function classifyIntent(msg) {
  const t = msg.toLowerCase();
  const hasPoNumber = /\b\d{7,12}\b/.test(msg);

  // LIST intents — check before action intents to avoid "approve po list" → APPROVE_PO
  if (/\b(approved|approve)\b/.test(t) && /\b(list|all|show|display)\b/.test(t) && /\b(po|purchase\s*order)s?\b/.test(t) && !hasPoNumber) return "LIST_APPROVED_POS";
  if (/\b(pending)\b/.test(t) && /\b(po|purchase\s*order)s?\b/.test(t) && !hasPoNumber) return "LIST_PENDING_POS";
  if (/\b(list|show|display|all)\b/.test(t) && /\b(po|purchase\s*order)s?\b/.test(t) && !hasPoNumber && !/\bdetail\b/.test(t)) return "LIST_PENDING_POS";

  // Vendor performance
  if (/\b(vendor\s*performance|performance|vendor\s*metric|vendor\s*stat)\b/.test(t)) return "VENDOR_PERFORMANCE";
  // Action intents — require a PO number or explicit action keyword with no list context
  if (/\b(approve|release)\b/.test(t) && /\b(po|purchase\s*order|\d{7,12})\b/.test(t) && !/\b(list|all|show.*list)\b/.test(t)) return "APPROVE_PO";
  if (/\b(reset|reject|undo|revert)\b/.test(t) && /\b(po|purchase\s*order|\d{7,12})\b/.test(t)) return "RESET_PO";
  if (/\b(create|new|make|raise|add|generate|place)\b/.test(t) && /\b(po|purchase\s*order)\b/.test(t)) return "CREATE_PO";

  // Detail
  if (hasPoNumber || (/\b(detail|info|status|about|show)\b/.test(t) && /\bpo\b/.test(t))) return "GET_PO_DETAILS";
  return null;
}

// ─── Deterministic entity extraction ─────────────────────────────────────────
function extractEntities(msg) {
  const ent = {};
  const poMatch = msg.match(/\b(\d{7,12})\b/);
  if (poMatch) ent.poNumber = poMatch[1];
  const vendorMatch = msg.match(/\bvendor\s*(?:number|id|#|:)?\s*[:\-]?\s*(\w+)/i);
  if (vendorMatch) ent.vendor = vendorMatch[1];
  const rcMatch = msg.match(/(?:release\s*code|code)[:\s]+([A-Z0-9]{1,4})/i)
               || msg.match(/\bwith\s+([A-Z0-9]{1,4})\b/i);
  if (rcMatch) ent.releaseCode = rcMatch[1].toUpperCase();
  ent.items = parseItems(msg);
  return ent;
}

// Parse "book, 10, 50" or "Laptop 2 500" or "3 x Chair at 200"
function parseItems(msg) {
  const items = [];

  // Pattern: "desc, qty, price" (comma-separated)
  const csv = msg.match(/^([a-zA-Z][^,]{0,40}),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)$/);
  if (csv) {
    items.push({ description: csv[1].trim(), quantity: parseFloat(csv[2]), unit: "EA", netPrice: parseFloat(csv[3]), plant: "1000" });
    return items;
  }

  // Pattern: qty x desc at/for price
  const p1 = /(\d+(?:\.\d+)?)\s+(?:x\s+)?([a-zA-Z][a-zA-Z0-9 \-]{1,40}?)\s+(?:at|for|@|price)\s+\$?(\d+(?:\.\d+)?)/gi;
  let m;
  while ((m = p1.exec(msg)) !== null) {
    items.push({ description: m[2].trim(), quantity: parseFloat(m[1]), unit: "EA", netPrice: parseFloat(m[3]), plant: "1000" });
  }
  return items;
}

// ─── Slot-fill answer extractor ───────────────────────────────────────────────
// Called when we're waiting for a specific slot answer
function extractSlotAnswer(pendingSlot, msg) {
  const t = msg.trim();
  switch (pendingSlot) {
    case "vendor":
      // Accept any word/number as vendor
      return t || null;

    case "vendorId":
      return t || null;

    case "poNumber": {
      const m = msg.match(/\b(\d{7,12})\b/);
      return m ? m[1] : (t.match(/^\d+$/) ? t : null);
    }

    case "releaseCode": {
      const m = msg.match(/\b([A-Z0-9]{1,4})\b/i);
      return m ? m[1].toUpperCase() : null;
    }

    case "items": {
      const items = parseItems(msg);
      return items.length ? items : null;
    }
  }
  return null;
}

// ─── Gemini entity extraction (first turn only, for complex messages) ─────────
const ENTITY_PROMPT = `Extract entities from this purchase order message. Return ONLY valid JSON, no markdown.
Schema: {"vendor":null,"po_id":null,"release_code":null,"items":[{"description":null,"quantity":null,"price":null}]}
Rules:
- vendor: extract vendor number/id if present
- po_id: any 7-12 digit PO number
- release_code: release/approval code like R1, AB, 01
- items: array of {description, quantity, price} — map "book,10,50" to description=book,quantity=10,price=50
- Use null for missing values
- Return empty items array [] if no items found`;

async function geminiExtract(msg) {
  const maxAttempts = API_KEYS.length * MODELS.length;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const genAI = new GoogleGenerativeAI(getApiKey());
      const model = genAI.getGenerativeModel({ model: getModel() });
      const result = await model.generateContent([{ text: ENTITY_PROMPT }, { text: msg }]);
      const raw = result.response.text().trim()
        .replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
      return JSON.parse(raw);
    } catch (err) {
      if (isQuota(err)) { nextKey(); nextModel(); continue; }
      break;
    }
  }
  return {};
}

// ─── Slot definitions ─────────────────────────────────────────────────────────
const SLOT_QUESTIONS = {
  vendor:      "Please provide the vendor ID.",
  poNumber:    "Which PO number?",
  releaseCode: "Please provide the release code.",
  items:       "Please provide item details (description, quantity, price). Example: Laptop, 2, 500.",
  vendorId:    "Which vendor ID would you like performance data for?"
};

const REQUIRED_SLOTS = {
  CREATE_PO:          ["vendor", "items"],
  APPROVE_PO:         ["poNumber", "releaseCode"],
  RESET_PO:           ["poNumber", "releaseCode"],
  GET_PO_DETAILS:     ["poNumber"],
  VENDOR_PERFORMANCE: ["vendorId"]
};

function getNextMissingSlot(intent, fields) {
  const required = REQUIRED_SLOTS[intent] || [];
  for (const slot of required) {
    const val = fields[slot];
    if (slot === "items") { if (!Array.isArray(val) || !val.length) return slot; }
    else if (!val) return slot;
  }
  return null;
}

// ─── Validation ───────────────────────────────────────────────────────────────
function validateItems(items) {
  const errors = [];
  (items || []).forEach((item, i) => {
    const name = item.description || `item ${i + 1}`;
    if (!item.description?.trim()) errors.push(`Item ${i + 1}: description is required`);
    if (!(item.quantity > 0))      errors.push(`"${name}": quantity must be greater than 0`);
    if (!(item.netPrice > 0))      errors.push(`"${name}": price must be greater than 0`);
  });
  return errors;
}

// ─── Formatters ───────────────────────────────────────────────────────────────
function formatList(data) {
  const all  = Array.isArray(data) ? data : (data?.data ?? []);
  const list = all.filter(po => (po.STATUS || "").toUpperCase() !== "APPROVED");
  if (!list.length) return "No pending purchase orders found.";
  const rows = list.slice(0, 20).map(po =>
    `• PO: ${po.EBELN}\n  Vendor: ${po.LIFNR} | Amount: ${po.WAERS} ${Number(po.NETWR || 0).toLocaleString()} | Date: ${po.BEDAT || "—"} | Status: ${po.STATUS || "Pending"}`
  ).join("\n\n");
  return `Found ${list.length} pending PO(s):\n\n${rows}`;
}

function formatDetail(raw) {
  const d = raw?.data ?? raw;
  if (!d?.EBELN) return "No details found for that PO.";
  const lines = [
    `PO Number : ${d.EBELN}`,
    `Vendor    : ${d.LIFNR}`,
    `Currency  : ${d.WAERS}`,
    `Amount    : ${Number(d.NETWR || 0).toLocaleString()}`,
    `Date      : ${d.BEDAT || "—"}`,
    `Status    : ${d.STATUS || "—"}`,
    `Purch Org : ${d.EKORG || "—"}`,
    `Company   : ${d.BUKRS || "—"}`
  ];
  if (Array.isArray(d.items) && d.items.length) {
    lines.push("\nLine Items:");
    d.items.forEach((it, i) =>
      lines.push(`  ${i + 1}. ${it.TXZ01 || it.description || "—"} | Qty: ${it.MENGE} ${it.MEINS} | Price: ${it.NETPR}`)
    );
  }
  return lines.join("\n");
}

// ─── Main chat ────────────────────────────────────────────────────────────────
async function chat(userMessage, context = {}) {
  const sessionId = context.sessionId || "default";
  const session   = getSession(sessionId);
  session.turnCount++;

  const log = { turn: session.turnCount, message: userMessage, intent: null, fields: {}, executed: false };

  // ── CASE 1: We're waiting for a specific slot answer ─────────────────────
  if (session.pendingSlot) {
    const answer = extractSlotAnswer(session.pendingSlot, userMessage);
    if (answer) {
      if (session.pendingSlot === "items") {
        session.fields.items = answer;
      } else {
        session.fields[session.pendingSlot] = answer;
      }
      session.pendingSlot = null;
      console.log(`[Agent] Slot filled: ${session.pendingSlot} = ${JSON.stringify(answer)}`);
    } else {
      // Couldn't extract — re-ask
      const q = SLOT_QUESTIONS[session.pendingSlot];
      return respond(session, log, `I couldn't understand that. ${q}`, false);
    }
  } else {
    // ── CASE 2: Fresh message — classify intent ───────────────────────────
    const detected = classifyIntent(userMessage);

    if (detected && detected !== session.intent) {
      session.intent     = detected;
      session.fields     = {};
      session.pendingSlot = null;
      session.turnCount  = 1;
    } else if (!session.intent && !detected) {
      const help = [
        "I can help you with:",
        "• \"show pending POs\" — list pending purchase orders",
        "• \"show PO 4500012345\" — view PO details",
        "• \"approve PO 4500012345 with code R1\" — approve a PO",
        "• \"reset PO 4500012345 with code R1\" — reset a release",
        "• \"create a new PO\" — create a purchase order",
        "• \"vendor performance 1000\" — view vendor performance"
      ].join("\n");
      return respond(session, log, help, false);
    }

    // Extract entities from the message (regex first, Gemini as fallback for items)
    const ent = extractEntities(userMessage);
    if (ent.poNumber)    session.fields.poNumber    = ent.poNumber;
    if (ent.vendor)      session.fields.vendor      = ent.vendor;
    if (ent.releaseCode) session.fields.releaseCode = ent.releaseCode;
    if (ent.items?.length) session.fields.items     = ent.items;
    // For vendor performance, extract vendor ID
    if (session.intent === "VENDOR_PERFORMANCE") {
      // Match explicit "vendor <id>" or a standalone number (not part of "performance")
      const vMatch = userMessage.match(/\bvendor\s*(?:id|#|number|:)?\s*[:\-]?\s*(\d+)/i)
                  || userMessage.match(/\bof\s+(\d+)\b/i)
                  || userMessage.match(/\bfor\s+(\d+)\b/i)
                  || userMessage.match(/\b(\d{4,10})\b/);
      if (vMatch) session.fields.vendorId = vMatch[1];
    }

    // For CREATE_PO first turn with no items — try Gemini for richer extraction
    if (session.intent === "CREATE_PO" && !session.fields.items?.length) {
      try {
        const gEnt = await geminiExtract(userMessage);
        if (gEnt.vendor && !session.fields.vendor)      session.fields.vendor = gEnt.vendor;
        if (gEnt.po_id  && !session.fields.poNumber)    session.fields.poNumber = gEnt.po_id;
        if (gEnt.release_code && !session.fields.releaseCode) session.fields.releaseCode = gEnt.release_code;
        if (Array.isArray(gEnt.items) && gEnt.items.length) {
          const valid = gEnt.items.filter(it => it.description);
          if (valid.length) {
            session.fields.items = valid.map(it => ({
              description: it.description, quantity: it.quantity,
              unit: "EA", netPrice: it.price, plant: "1000"
            }));
          }
        }
      } catch { /* ignore Gemini errors */ }
    }
  }

  log.intent = session.intent;
  log.fields = { ...session.fields };

  // ── LIST: execute immediately ─────────────────────────────────────────────
  if (session.intent === "LIST_PENDING_POS" || session.intent === "LIST_APPROVED_POS") {
    try {
      const raw    = await mcp.getPendingPOs();
      const all    = Array.isArray(raw) ? raw : (raw?.data ?? []);
      const filter = session.intent === "LIST_APPROVED_POS" ? "APPROVED" : "PENDING";
      const list   = all.filter(po => (po.STATUS || "PENDING").toUpperCase() === filter);
      const text   = list.length
        ? `Found ${list.length} ${filter.toLowerCase()} PO(s):\n\n` +
          list.slice(0, 20).map(po =>
            `• PO: ${po.EBELN}\n  Vendor: ${po.LIFNR} | Amount: ${po.WAERS} ${Number(po.NETWR || 0).toLocaleString()} | Date: ${po.BEDAT || "—"} | Status: ${po.STATUS}`
          ).join("\n\n")
        : `No ${filter.toLowerCase()} purchase orders found.`;
      log.executed = true;
      clearSession(sessionId);
      return { success: true, response: text, actionPerformed: true, action: "LIST_POS", filter };
    } catch (err) {
      clearSession(sessionId);
      return { success: false, error: `Failed to fetch POs: ${err.message}` };
    }
  }

  // ── Validate items ────────────────────────────────────────────────────────
  if (session.intent === "CREATE_PO" && session.fields.items) {
    const errs = validateItems(session.fields.items);
    if (errs.length) {
      session.fields.items = null; // clear bad items so we re-ask
      return respond(session, log,
        "Please fix the following:\n" + errs.map(e => `• ${e}`).join("\n") +
        "\n\nPlease provide item details again (description, quantity, price).", false);
    }
  }

  // ── Check if all slots filled → execute ──────────────────────────────────
  const nextSlot = getNextMissingSlot(session.intent, session.fields);

  if (!nextSlot) {
    // All slots filled — execute
    try {
      const f = session.fields;
      let text, extra = {};

      if (session.intent === "GET_PO_DETAILS") {
        const raw = await mcp.getPODetail(f.poNumber);
        text  = formatDetail(raw);
        extra = { poNumber: f.poNumber };
      }
      if (session.intent === "VENDOR_PERFORMANCE") {
        const raw = await mcp.getVendorPerformance(f.vendorId);
        const d   = raw?.data ?? raw;
        const lines = [
          `Vendor Performance: ${f.vendorId}`,
          `Total POs    : ${d?.totalPOs ?? "—"}`,
          `Total Spend  : ${d?.totalSpend ?? "—"}`,
          `On-Time Del. : ${d?.onTimeDeliveryPercent != null ? d.onTimeDeliveryPercent + "%" : (d?.onTimeDeliveryPct != null ? d.onTimeDeliveryPct + "%" : "—")}`,
          `Avg Delay    : ${d?.avgDeliveryDelay != null ? d.avgDeliveryDelay + " days" : "—"}`
        ];
        text  = lines.join("\n");
        extra = { action: "VENDOR_PERFORMANCE", vendorId: f.vendorId };
      }      if (session.intent === "APPROVE_PO") {
        const raw = await mcp.approvePO(f.poNumber, f.releaseCode);
        const newStatus = raw?.relStatusNew || raw?.relIndicatorNew || "Approved";
        text = `✅ PO ${f.poNumber} approved successfully.\nNew status: ${newStatus}\n${raw?.message || ""}`.trim();
        extra = { poNumber: f.poNumber, action: "APPROVED_PO" };
      }
      if (session.intent === "RESET_PO") {
        const raw = await mcp.rejectPO(f.poNumber, f.releaseCode);
        const newStatus = raw?.relStatusNew || raw?.relIndicatorNew || "Reset";
        text = `✅ Release reset for PO ${f.poNumber}.\nNew status: ${newStatus}\n${raw?.message || ""}`.trim();
        extra = { poNumber: f.poNumber, action: "RESET_PO_DONE" };
      }
      if (session.intent === "CREATE_PO") {
        const payload = {
          vendor: f.vendor, companyCode: "1000", purchOrg: "1000", purchGroup: "001",
          items: f.items.map(it => ({
            description: it.description, quantity: it.quantity,
            unit: "EA", netPrice: it.netPrice, plant: "1000"
          }))
        };
        const raw = await mcp.createPO(payload);
        const d   = raw?.data ?? raw;
        const newPoNumber = d?.poNumber || d?.EBELN;
        text = `✅ Purchase order created. New PO: ${newPoNumber || JSON.stringify(d)}`;
        log.executed = true;
        clearSession(sessionId);
        return { success: true, response: text, actionPerformed: true, action: "CREATED_PO", poNumber: newPoNumber };
      }

      log.executed = true;
      clearSession(sessionId);
      return { success: true, response: text, actionPerformed: true, ...extra };

    } catch (err) {
      clearSession(sessionId);
      return { success: false, error: err.message };
    }
  }

  // ── Ask for next missing slot ─────────────────────────────────────────────
  if (session.turnCount > MAX_TURNS) {
    clearSession(sessionId);
    return { success: false, error: "Could not complete the request. Please start over." };
  }

  session.pendingSlot = nextSlot;
  const question = SLOT_QUESTIONS[nextSlot];
  return respond(session, log, question, false);
}

// ─── respond ──────────────────────────────────────────────────────────────────
function respond(session, log, text, actionPerformed) {
  session.lastResponse = text;
  console.log("[Agent]", JSON.stringify(log));
  return { success: true, response: text, actionPerformed };
}

module.exports = { chat, clearSession };
