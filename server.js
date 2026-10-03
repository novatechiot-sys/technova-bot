/**
 * TechNova AI Receptionist
 * Channels: website chat widget (/chat + /widget.js) and WhatsApp Cloud API (/webhook, optional)
 * Flow: customer message -> AI on Groq (company brain) -> reply
 *       leads and alerts are passed to the TechNova Apps Script ("relay"), which writes the
 *       Leads Tracker and emails Jackson. No Google keys are needed on this server.
 *
 * One file on purpose: edit COMPANY_BRAIN below whenever prices or policies change.
 * Requires Node 18+ (built-in fetch). Only dependency: express.
 */
const express = require("express");
const crypto = require("crypto");

// ---------------------------------------------------------------------------
// Config (environment variables; see .env.example)
// ---------------------------------------------------------------------------
const cfg = {
  port: process.env.PORT || 3000,
  // AI model on Groq (OpenAI-compatible API)
  groqKey: process.env.GROQ_API_KEY,
  model: process.env.LLM_MODEL || "openai/gpt-oss-120b",
  // Website chat
  allowedOrigins: (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean),
  // TechNova Apps Script relay: saves leads in the sheet and emails alerts to Jackson
  relayUrl: process.env.RELAY_URL,
  relaySecret: process.env.RELAY_SECRET,
  ownerWa: process.env.OWNER_WHATSAPP,
  // WhatsApp (optional; leave empty to run website chat only)
  verifyToken: process.env.WA_VERIFY_TOKEN,
  appSecret: process.env.WA_APP_SECRET,
  waToken: process.env.WA_ACCESS_TOKEN,
  phoneNumberId: process.env.WA_PHONE_NUMBER_ID,
  graphVersion: process.env.WA_GRAPH_VERSION || "v21.0",
};
const whatsappEnabled = Boolean(cfg.waToken && cfg.phoneNumberId);

// ---------------------------------------------------------------------------
// Company brain: the only thing the AI knows about TechNova
// ---------------------------------------------------------------------------
const COMPANY_BRAIN = `
COMPANY: TechNova Electronics & IoT, Arusha, Tanzania. "Turning Ideas into Smart Solutions".
Phone/WhatsApp: +255 682 334 222 / +255 627 182 180. Email: novatech.iot@gmail.com.
Website: https://technova-m4cq.onrender.com
Working hours: Mon–Sat 8:00–22:00. Site visits: within Arusha; other regions by arrangement. Software work: anywhere.

STARTING PRICES (TZS). Labour and parts are priced separately; parts at cost.
Electronics repair (labour, parts extra): diagnosis 5,000 (free if repaired with us); phone software/flashing 15,000-30,000;
phone screen/battery/charging port 10,000-20,000 + part; laptop format + Windows + drivers 30,000-40,000;
laptop cleaning + thermal paste 25,000-35,000; laptop hardware repair 30,000-80,000 + part; office care plan (5 PCs) 50,000/month.
Networks & security: CCTV 4 cameras labour 150,000-200,000; extra camera labour 30,000; full 4-camera package approx 900,000-1,300,000;
home Wi-Fi setup 30,000-50,000; MikroTik business/hotspot 150,000-300,000; cabling per point 25,000-40,000; maintenance 50,000-100,000/month.
IoT (hardware included): water tank monitor 250,000-400,000; smart home starter 250,000-400,000; smart irrigation small farm 600,000-1,200,000;
solar/power monitoring 400,000-800,000; industrial monitoring = quote after site survey; cloud dashboard + SMS 20,000-50,000/month.
Engineering: PCB design 150,000-400,000; firmware from 300,000; prototype from 500,000; student project support 150,000-500,000.
Software: one-page website 150,000-250,000; 5-page website 500,000-800,000; booking/e-commerce with mobile money 1,500,000-3,000,000;
business system 1,500,000-5,000,000; basic mobile app 2,000,000-4,000,000; AI WhatsApp chatbot 300,000-500,000 + 30,000-50,000/month;
hosting + domain + maintenance 25,000/month or 250,000/year.

POLICIES: 50% deposit for jobs above 200,000; repairs: parts upfront, labour on collection; installments up to 3 months for software;
site visit in Arusha 10,000-20,000, deducted if the job goes ahead; warranty 30 days repairs, 3-6 months installations;
payment by M-Pesa, Tigo Pesa, Airtel Money, bank transfer. Written quote within 48 hours, valid 14 days.
Current offer: free diagnosis when repaired with us (until 31 Oct 2026).
`;

const BASE_PROMPT = `You are TechNova's customer assistant.
Reply in the customer's language (Swahili or English, match them). Be warm, short (max ~80 words) and practical. Plain text, no markdown.

Your job:
1. Understand what the customer needs and answer questions using ONLY the company information below.
2. Collect: name, location, the service needed, and details (device model, problem, number of cameras, farm size, etc.). Ask one or two things at a time.
3. As soon as you know the service needed and at least one other detail, call save_lead. Call it again when you learn more.
4. Call handover_to_human when: the customer is ready to book or wants a final quote, wants a discount, complains, has an urgent problem, asks something you cannot answer from the company information, or asks for a person.
   After a handover, tell the customer Jackson from TechNova will contact them shortly.

Hard rules:
- Only give prices as "starting from" ranges from the list. Never promise a final price, date, discount or availability.
- Never invent clients, projects, reviews, stock or policies. If unsure, hand over.
- Never ask for card numbers, PINs or passwords.
- If asked, say honestly that you are TechNova's AI assistant and that Jackson reviews every quote.`;

const CHANNEL_NOTES = {
  whatsapp: `CHANNEL: WhatsApp. You already have the customer's number. If they send a photo or voice note, say you received it and Jackson will review it.`,
  web: `CHANNEL: chat on TechNova's website. Visitors are anonymous. Before calling handover_to_human, and whenever they want a quote or visit, ask for their phone/WhatsApp number (or email) so Jackson can contact them, and include it in save_lead. If they refuse, give them the TechNova phone numbers instead.`,
};

const systemPrompt = (channel) => `${BASE_PROMPT}\n\n${CHANNEL_NOTES[channel]}\n\nCOMPANY INFORMATION:\n${COMPANY_BRAIN}`;

const TOOL_DEFS = [
  {
    name: "save_lead",
    description: "Save or update this customer's lead in the TechNova Leads Tracker.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Customer name if known" },
        phone: { type: "string", description: "Customer phone/WhatsApp if given" },
        email: { type: "string", description: "Customer email if given" },
        service: { type: "string", description: "Service needed, e.g. 'CCTV 4 cameras' or 'laptop screen repair'" },
        location: { type: "string" },
        details: { type: "string", description: "Short summary of what they need" },
        status: { type: "string", enum: ["New", "Ready to quote", "Handed over"] },
      },
      required: ["service", "details"],
    },
  },
  {
    name: "handover_to_human",
    description: "Alert Jackson to take over this customer personally.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Why a human is needed, one sentence" },
        summary: { type: "string", description: "What the customer wants, with the details and contact collected" },
      },
      required: ["reason", "summary"],
    },
  },
];
// Groq uses the OpenAI tool format
const TOOLS = TOOL_DEFS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));

// ---------------------------------------------------------------------------
// In-memory state (fine for one small server; restarts clear it)
// Conversation keys: "wa:<phone>" or "web:<sessionId>"
// ---------------------------------------------------------------------------
const conversations = new Map(); // key -> { messages, updated, lead, userTurns }
const paused = new Set();        // keys where Jackson has taken over
const seenIds = new Set();       // WhatsApp message ids already handled
const leadRows = new Map();      // key -> row number in the sheet
const MAX_TURNS = 20;
const TTL_MS = 24 * 60 * 60 * 1000;

function getConvo(key) {
  const c = conversations.get(key);
  if (c && Date.now() - c.updated < TTL_MS) return c;
  const fresh = { messages: [], updated: Date.now(), lead: {}, userTurns: 0 };
  conversations.set(key, fresh);
  return fresh;
}

// Clean up old conversations every hour
setInterval(() => {
  const now = Date.now();
  for (const [k, c] of conversations) if (now - c.updated > TTL_MS) { conversations.delete(k); paused.delete(k); }
}, 60 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Relay to the TechNova Apps Script (leads -> Leads Tracker, alerts -> Jackson's email)
// ---------------------------------------------------------------------------
async function relay(payload) {
  if (!cfg.relayUrl || !cfg.relaySecret) { console.log("[RELAY not configured]", JSON.stringify(payload)); return null; }
  const res = await fetch(cfg.relayUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: cfg.relaySecret, ...payload }),
    redirect: "follow",
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new Error("Relay answered: " + text.slice(0, 150)); }
}

async function alertOwner(subject, text) {
  try {
    await relay({ action: "alert", subject, text });
  } catch (e) {
    console.error("Owner alert failed:", e.message);
    if (whatsappEnabled && cfg.ownerWa) await sendWhatsApp(cfg.ownerWa, `${subject}\n${text}`);
  }
}

async function saveLead(key, channel, input) {
  const convo = getConvo(key);
  const lead = Object.assign(convo.lead, Object.fromEntries(Object.entries(input).filter(([, v]) => v)));
  if (channel === "whatsapp" && !lead.phone) lead.phone = "+" + key.slice(3);
  const r = await relay({ action: "lead", key, source: channel === "web" ? "Website chat" : "WhatsApp", lead });
  return r && r.ok ? "Lead saved" : "Lead noted";
}

// ---------------------------------------------------------------------------
// AI model (Groq, OpenAI-compatible chat completions with tool calling)
// ---------------------------------------------------------------------------
async function callModel(channel, messages) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.groqKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: "system", content: systemPrompt(channel) }, ...messages],
      tools: TOOLS,
      tool_choice: "auto",
      temperature: 0.4,
      max_completion_tokens: 1500,
      ...(cfg.model.startsWith("openai/gpt-oss") ? { reasoning_effort: "low" } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Groq API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.choices[0].message;
}

function parseArgs(raw) {
  try { return typeof raw === "string" ? JSON.parse(raw || "{}") : raw || {}; } catch { return {}; }
}

async function runTool(key, channel, name, input) {
  if (name === "save_lead") {
    return saveLead(key, channel, input).catch((e) => { console.error(e); return "Could not save lead"; });
  }
  if (name === "handover_to_human") {
    paused.add(key);
    const lead = getConvo(key).lead;
    saveLead(key, channel, { status: "Handed over", details: input.summary }).catch(() => {});
    const contact = [lead.name, lead.phone, lead.email].filter(Boolean).join(" · ") || "no contact given yet";
    const how = channel === "web" ? "Website chat" : `WhatsApp +${key.slice(3)}`;
    const resume = channel === "whatsapp" ? `\nSend "resume ${key.slice(3)}" to turn the AI back on.` : "";
    await alertOwner(`🔔 Customer needs you: ${lead.name || "new customer"} (${how})`,
      `Contact: ${contact}\nWhy: ${input.reason}\nSummary: ${input.summary}${resume}\n\nThe AI has stopped replying to this customer. Please contact them.`);
    return "Jackson has been alerted. The AI will stop replying to this customer.";
  }
  return "Unknown tool";
}

async function answer(key, channel, userText) {
  const convo = getConvo(key);
  convo.userTurns++;
  convo.messages.push({ role: "user", content: userText });
  convo.messages = convo.messages.slice(-MAX_TURNS);
  while (convo.messages.length && convo.messages[0].role !== "user") convo.messages.shift();

  for (let step = 0; step < 4; step++) {
    const msg = await callModel(channel, convo.messages);
    const toolCalls = msg.tool_calls || [];
    convo.messages.push({ role: "assistant", content: msg.content || "", ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });

    if (toolCalls.length === 0) {
      convo.updated = Date.now();
      return (msg.content || "").trim();
    }
    for (const t of toolCalls) {
      const result = await runTool(key, channel, t.function.name, parseArgs(t.function.arguments));
      convo.messages.push({ role: "tool", tool_call_id: t.id, content: result });
    }
  }
  return "Asante! Jackson kutoka TechNova atawasiliana nawe hivi punde. / Thanks! Jackson from TechNova will contact you shortly.";
}

// ---------------------------------------------------------------------------
// Website chat: rate limits protect your AI bill from abuse
// ---------------------------------------------------------------------------
const ipHits = new Map();
const IP_LIMIT = 20, IP_WINDOW_MS = 10 * 60 * 1000, SESSION_LIMIT = 40;

function rateLimited(ip) {
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter((t) => now - t < IP_WINDOW_MS);
  hits.push(now);
  ipHits.set(ip, hits);
  return hits.length > IP_LIMIT;
}

function cors(req, res, next) {
  const origin = req.get("origin");
  if (origin && (cfg.allowedOrigins.length === 0 || cfg.allowedOrigins.includes(origin))) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
}

const FALLBACK_WEB = "Samahani, kuna tatizo kidogo. Tafadhali tupigie au WhatsApp +255 682 334 222 / +255 627 182 180. / Sorry, something went wrong. Please call or WhatsApp +255 682 334 222 / +255 627 182 180.";
const HANDED_OVER_WEB = "Jackson kutoka TechNova ameshajulishwa na atawasiliana nawe hivi punde. Unaweza pia kupiga +255 682 334 222 / +255 627 182 180. / Jackson from TechNova has been notified and will contact you shortly. You can also call +255 682 334 222 / +255 627 182 180.";

// ---------------------------------------------------------------------------
// WhatsApp helpers (only used when WhatsApp is configured)
// ---------------------------------------------------------------------------
async function sendWhatsApp(to, body) {
  if (!whatsappEnabled) return;
  const res = await fetch(`https://graph.facebook.com/${cfg.graphVersion}/${cfg.phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.waToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: body.slice(0, 4000) } }),
  });
  if (!res.ok) console.error("WhatsApp send failed:", res.status, await res.text());
}

async function markRead(messageId) {
  await fetch(`https://graph.facebook.com/${cfg.graphVersion}/${cfg.phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.waToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: messageId }),
  }).catch(() => {});
}

function validSignature(req) {
  if (!cfg.appSecret) return true; // allow during first tests only
  const sig = req.get("x-hub-signature-256") || "";
  const expected = "sha256=" + crypto.createHmac("sha256", cfg.appSecret).update(req.rawBody).digest("hex");
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

// Owner commands sent from OWNER_WHATSAPP: "pause 2557..." / "resume 2557..."
function handleOwnerCommand(text) {
  const m = /^(pause|resume)\s+\+?(\d{9,15})$/i.exec(text.trim());
  if (!m) return null;
  const [, cmd, phone] = m;
  if (cmd.toLowerCase() === "pause") paused.add("wa:" + phone); else paused.delete("wa:" + phone);
  return `OK: AI ${cmd.toLowerCase() === "pause" ? "paused" : "resumed"} for +${phone}`;
}

async function handleWhatsApp(msg, contactName) {
  if (seenIds.has(msg.id)) return;
  seenIds.add(msg.id);
  if (seenIds.size > 5000) seenIds.clear();

  const phone = msg.from;
  const key = "wa:" + phone;
  markRead(msg.id);

  if (phone === cfg.ownerWa && msg.type === "text") {
    const result = handleOwnerCommand(msg.text.body);
    if (result) return sendWhatsApp(phone, result);
  }
  if (paused.has(key)) return;

  let text;
  if (msg.type === "text") text = msg.text.body;
  else if (msg.type === "interactive") text = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || "";
  else if (["image", "audio", "video", "document"].includes(msg.type)) {
    text = `[Customer sent a ${msg.type}${msg[msg.type]?.caption ? " with caption: " + msg[msg.type].caption : ""}]`;
    alertOwner(`📎 WhatsApp ${msg.type} from +${phone}`, `+${phone} sent a ${msg.type}. Check WhatsApp.`);
  } else return;
  if (contactName) text = `(WhatsApp profile name: ${contactName})\n${text}`;

  try {
    const reply = await answer(key, "whatsapp", text);
    if (reply) await sendWhatsApp(phone, reply);
  } catch (e) {
    console.error("WhatsApp reply failed:", e.message);
    await sendWhatsApp(phone, "Asante kwa ujumbe wako! Tutakujibu hivi punde. / Thanks for your message! We'll reply shortly.");
    alertOwner("⚠️ TechNova receptionist error (WhatsApp)", `Customer +${phone}\n${e.message.slice(0, 300)}`);
  }
}

// ---------------------------------------------------------------------------
// The chat widget your website loads with one <script> tag
// ---------------------------------------------------------------------------
const WIDGET_JS = `(() => {
  if (window.__technovaChat) return; window.__technovaChat = true;
  const API = new URL(document.currentScript.src).origin;
  const BLUE = "#046bd2", NAVY = "#0e1d34";
  let sid = null;
  try { sid = localStorage.getItem("tn_chat_sid"); } catch (e) {}
  if (!sid) { sid = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
    try { localStorage.setItem("tn_chat_sid", sid); } catch (e) {} }

  const css = \`
  #tn-btn{position:fixed;right:20px;bottom:20px;z-index:2147483000;width:60px;height:60px;border-radius:50%;border:0;cursor:pointer;
    background:\${BLUE};color:#fff;box-shadow:0 6px 20px rgba(4,107,210,.35);display:flex;align-items:center;justify-content:center}
  #tn-btn:focus-visible{outline:3px solid \${NAVY};outline-offset:3px}
  #tn-panel{position:fixed;right:20px;bottom:92px;z-index:2147483000;width:360px;max-width:calc(100vw - 32px);height:520px;max-height:calc(100vh - 120px);
    background:#fff;border-radius:14px;box-shadow:0 12px 40px rgba(14,29,52,.25);display:none;flex-direction:column;overflow:hidden;
    font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:\${NAVY}}
  #tn-panel.open{display:flex}
  #tn-head{background:\${NAVY};color:#fff;padding:14px 16px;display:flex;justify-content:space-between;align-items:center}
  #tn-head b{font-size:15px;display:block} #tn-head small{font-size:12px;opacity:.75}
  #tn-close{background:none;border:0;color:#fff;font-size:22px;cursor:pointer;line-height:1;padding:4px 8px}
  #tn-log{flex:1;overflow-y:auto;padding:14px;background:#f5f8fc;display:flex;flex-direction:column;gap:8px}
  .tn-m{max-width:85%;padding:9px 12px;border-radius:12px;font-size:14px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word}
  .tn-bot{background:#fff;border:1px solid #e1e8f2;align-self:flex-start;border-bottom-left-radius:4px}
  .tn-me{background:\${BLUE};color:#fff;align-self:flex-end;border-bottom-right-radius:4px}
  .tn-typing{opacity:.6;font-style:italic}
  #tn-form{display:flex;gap:8px;padding:10px;border-top:1px solid #e1e8f2;background:#fff}
  #tn-in{flex:1;border:1px solid #cfd9e6;border-radius:10px;padding:10px 12px;font-size:14px;outline:none;font-family:inherit}
  #tn-in:focus{border-color:\${BLUE}}
  #tn-send{background:\${BLUE};color:#fff;border:0;border-radius:10px;padding:0 16px;font-weight:600;cursor:pointer;font-size:14px}
  #tn-send:disabled{opacity:.5;cursor:default}
  #tn-foot{font-size:11px;color:#6b7788;text-align:center;padding:0 10px 8px;background:#fff}
  @media (max-width:480px){#tn-panel{right:0;bottom:0;width:100vw;max-width:100vw;height:100%;max-height:100%;border-radius:0}}
  @media (prefers-reduced-motion:no-preference){#tn-panel.open{animation:tnUp .18s ease-out}@keyframes tnUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}}\`;
  const style = document.createElement("style"); style.textContent = css; document.head.appendChild(style);

  const btn = document.createElement("button");
  btn.id = "tn-btn"; btn.setAttribute("aria-label", "Chat with TechNova");
  btn.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

  const panel = document.createElement("div");
  panel.id = "tn-panel"; panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "TechNova chat");
  panel.innerHTML = '<div id="tn-head"><div><b>TechNova</b><small>Ask about repairs, CCTV, IoT or websites</small></div>' +
    '<button id="tn-close" aria-label="Close chat">×</button></div><div id="tn-log" aria-live="polite"></div>' +
    '<form id="tn-form"><input id="tn-in" maxlength="1000" autocomplete="off" placeholder="Andika ujumbe / Type a message" aria-label="Message">' +
    '<button id="tn-send" type="submit">Send</button></form><div id="tn-foot">AI assistant · Jackson reviews every quote</div>';
  document.body.appendChild(btn); document.body.appendChild(panel);

  const log = panel.querySelector("#tn-log"), form = panel.querySelector("#tn-form"),
        input = panel.querySelector("#tn-in"), send = panel.querySelector("#tn-send");
  function add(text, who) { const d = document.createElement("div"); d.className = "tn-m " + who; d.textContent = text;
    log.appendChild(d); log.scrollTop = log.scrollHeight; return d; }
  let greeted = false;
  function toggle(open) { panel.classList.toggle("open", open); if (open) { if (!greeted) { greeted = true;
    add("Habari! 👋 Karibu TechNova. Tunaweza kukusaidia nini leo?\\nHello! How can we help you today?", "tn-bot"); } input.focus(); } else btn.focus(); }
  btn.onclick = () => toggle(!panel.classList.contains("open"));
  panel.querySelector("#tn-close").onclick = () => toggle(false);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && panel.classList.contains("open")) toggle(false); });

  form.onsubmit = async (e) => {
    e.preventDefault();
    const text = input.value.trim(); if (!text) return;
    add(text, "tn-me"); input.value = ""; send.disabled = true;
    const typing = add("TechNova inaandika…", "tn-bot tn-typing");
    try {
      const r = await fetch(API + "/chat", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sid, message: text, page: location.pathname }) });
      const data = await r.json();
      typing.remove(); add(data.reply || "Sorry, please try again.", "tn-bot");
    } catch (err) {
      typing.remove(); add("Connection problem. Please call or WhatsApp +255 682 334 222.", "tn-bot");
    } finally { send.disabled = false; input.focus(); }
  };
})();`;

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "100kb", verify: (req, _res, buf) => { req.rawBody = buf; } }));

app.get("/", (_req, res) => res.send(`TechNova receptionist is running (web chat${whatsappEnabled ? " + WhatsApp" : ""})`));

app.get("/widget.js", (_req, res) => {
  res.type("application/javascript").set("Cache-Control", "public, max-age=300").send(WIDGET_JS);
});

app.options("/chat", cors);
app.post("/chat", cors, async (req, res) => {
  const { sessionId, message, page } = req.body || {};
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9.-]{8,64}$/.test(sessionId)) return res.status(400).json({ reply: "Invalid session." });
  if (typeof message !== "string" || !message.trim()) return res.status(400).json({ reply: "Please type a message." });
  if (rateLimited(req.ip)) return res.status(429).json({ reply: "Too many messages. Please call or WhatsApp +255 682 334 222 / +255 627 182 180." });

  const key = "web:" + sessionId;
  if (paused.has(key)) return res.json({ reply: HANDED_OVER_WEB });
  const convo = getConvo(key);
  if (convo.userTurns >= SESSION_LIMIT) return res.json({ reply: HANDED_OVER_WEB });

  const text = message.trim().slice(0, 1000) + (convo.userTurns === 0 && page ? `\n(Visitor is on page: ${String(page).slice(0, 100)})` : "");
  try {
    const reply = await answer(key, "web", text);
    res.json({ reply: reply || HANDED_OVER_WEB });
  } catch (e) {
    console.error("Web reply failed:", e.message);
    alertOwner("⚠️ TechNova receptionist error (website chat)", e.message.slice(0, 300));
    res.json({ reply: FALLBACK_WEB });
  }
});

// WhatsApp webhook (ignored unless WhatsApp is configured)
app.get("/webhook", (req, res) => {
  if (cfg.verifyToken && req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === cfg.verifyToken) {
    return res.status(200).send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

app.post("/webhook", (req, res) => {
  if (!whatsappEnabled) return res.sendStatus(404);
  if (!validSignature(req)) return res.sendStatus(401);
  res.sendStatus(200);
  for (const entry of req.body.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const names = Object.fromEntries((value.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
      for (const msg of value.messages || []) handleWhatsApp(msg, names[msg.from]).catch((e) => console.error(e));
    }
  }
});

app.listen(cfg.port, () => console.log(`TechNova receptionist on :${cfg.port} | Groq model ${cfg.model} | WhatsApp ${whatsappEnabled ? "on" : "off"}`));
