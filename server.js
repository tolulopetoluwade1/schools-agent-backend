const env = require("./config/env");
require("dotenv").config();
const cors = require("cors");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Sequelize, DataTypes } = require("sequelize");
const OpenAI = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const app = express();

app.use(express.json());

async function sendWhatsAppText(to, message) {
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  const token = process.env.META_ACCESS_TOKEN;

  if (!phoneNumberId || !token) {
    console.log("❌ Missing META_PHONE_NUMBER_ID or META_ACCESS_TOKEN");
    return;
  }

  const url = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to, // e.g. "2348137137336"
    type: "text",
    text: { body: message },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await resp.json();
  console.log("✅ META SEND RESULT:", data);
}
async function callInboundLogic({ channel, from, schoolId, text, timestamp }) {
  const baseUrl = process.env.PUBLIC_BASE_URL; // your Render base URL
  const resp = await fetch(`${baseUrl}/webhooks/inbound`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel, from, schoolId, text, timestamp }),
  });

  const data = await resp.json();
  return data.reply || "No reply generated.";
}



// ===============================
// META WHATSAPP CLOUD WEBHOOK
// ===============================

app.get("/webhook", (req, res) => {
  console.log("✅ META VERIFY HIT:", req.query);

  const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  try {
    // Immediately respond to Meta (very important)
    res.sendStatus(200);

    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const message = value?.messages?.[0];
    const from = message?.from; // e.g. "2348137137336"
    const text = message?.text?.body;

    if (!from || !text) return;

    console.log("✅ INCOMING TEXT:", text, "FROM:", from);

    const replyText = await callInboundLogic({
      channel: "whatsapp",
      from: `+${from}`,
      schoolId: Number(process.env.DEFAULT_SCHOOL_ID || 1),
      text,
      timestamp: new Date().toISOString(),
    });

    await sendWhatsAppText(from, replyText);

  } catch (err) {
    console.error("❌ /webhook error:", err);
  }
});

app.use((req, res, next) => {
  console.log("➡️ REQUEST:", req.method, req.originalUrl);
  next();
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    llmFallbackEnabled: process.env.LLM_FALLBACK_ENABLED === "true",
    llmTestMode: process.env.LLM_TEST_MODE === "true",
    invoiceSendEnabled: process.env.INVOICE_SEND_ENABLED === "true"
  });
});

const allowedOrigins = [
  "http://localhost:5173",
  "https://schools-agent-admin-dashboard.vercel.app",
];

const FAQS = [
  {
    keywords: ["fees", "tuition", "school fees", "how much"],
    answer: "School fees depend on the class. Please tell me your child’s class (e.g., Nursery 2, Primary 3).",
  },
  {
    keywords: ["address", "location", "where", "located"],
    answer: "The school address will be shared after admission begins. Please tell me your child's full name to continue.",
  },
  {
    keywords: ["uniform"],
    answer: "Yes, the school uses uniform. Details will be shared after admission begins.",
  },
  {
    keywords: ["resumption", "resume", "resumption date"],
    answer: "Resumption date varies by term. Admin will confirm after admission begins.",
  },
];

function matchFaq(text) {
  const t = String(text || "").toLowerCase();
  return FAQS.find(f => f.keywords.some(k => t.includes(k)));
}
async function llmFaqAnswer({ school, question }) {
  const model = process.env.OPENAI_MODEL || "gpt-5-mini";

  const instructions =
    "You are a school admissions assistant for a Nigerian school. " +
    "Answer ONLY using the SCHOOL INFO provided. " +
    "If the answer is not in the info, say: 'I’m not sure—please contact the school admin.' " +
    "Keep it short (1-4 lines).";

  const schoolInfo = [
    `School name: ${school?.name || ""}`,
    `Address: ${school?.address || ""}`,
    `Map: ${school?.mapsLink || ""}`,
  ].join("\n");

  const resp = await openai.responses.create({
    model,
    instructions,
    input: `SCHOOL INFO:\n${schoolInfo}\n\nPARENT QUESTION:\n${question}`,
  });

  return (resp.output_text || "").trim() || "I’m not sure—please contact the school admin.";
}
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    credentials: true,
  })
);
app.use(helmet());
app.use(express.json({ limit: "200kb" }));
// function requireAdminKey(req, res, next) {
//   const key = req.headers["x-admin-key"];

//   console.log("HEADER RECEIVED:", key);
//   console.log("EXPECTED KEY:", process.env.ADMIN_API_KEY);

//   if (!key || key !== process.env.ADMIN_API_KEY) {
//     return res.status(401).json({
//       success: false,
//       message: "Unauthorized",
//     });
//   }

//   next();
// }
function requireAdminKey(req, res, next) {
  const key = req.headers["x-admin-key"];

  if (!key || key !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized",
    });
  }

  next();
}
// =====================
// Helper functions
// =====================

function getFeeForClass(desiredClass) {
  const c = (desiredClass || "").toLowerCase();

  if (c.includes("nursery")) return 25000;
  if (c.includes("primary 1")) return 35000;
  if (c.includes("primary 2")) return 35000;
  if (c.includes("primary")) return 40000;

  return 40000;
}

function extractChildName(input) {
  if (!input) return null;

  const text = input.trim().replace(/\s+/g, " ");

  const patterns = [
    /(?:my\s+child(?:'s)?\s+(?:full\s+name|name)\s+is)\s+(.+)$/i,
    /(?:my\s+child\s+is)\s+(.+)$/i,
    /(?:name\s+is)\s+(.+)$/i,
    /^([A-Za-z]+(?:\s+[A-Za-z]+){0,3})$/
  ];

  for (const p of patterns) {
    const m = text.match(p);
    if (m && m[1]) {
      let name = m[1]
        .replace(/[0-9]/g, "")
        .replace(/[^\w\s'-]/g, "")
        .trim()
        .replace(/\s+/g, " ");

      const parts = name.split(" ").filter(Boolean);
      if (parts.length >= 1 && parts.length <= 4) return name;
    }
  }

  return null;
}
  // Remove common intro phrases
  t = t.replace(/my child'?s name is/i, "");
  t = t.replace(/my son's name is/i, "");
  t = t.replace(/my daughter'?s name is/i, "");
  t = t.replace(/his name is/i, "");
  t = t.replace(/her name is/i, "");
  t = t.replace(/name is/i, "");
  t = t.replace(/it's/i, "");

  // Take only the first part before punctuation
  t = t.split(/[.,;\n]/)[0].trim();

  // Convert non-letters to spaces
  t = t.replace(/[^a-zA-Z\s'-]/g, " ");
  t = t.replace(/\s+/g, " ").trim();

  if (t.length < 2) return null;

  const stopwords = new Set([
    "and","but","pls","please","kindly",
    "she","he","is","was","am","are",
    "very","shy","quiet","too","also",
    "my","child","son","daughter","name"
  ]);

let rawWords = t.split(" ").map(w => w.trim()).filter(Boolean);

// Stop reading name when we hit connector words
const stopAt = new Set([
  "and", "but", "because", "honestly", "pls", "please", "kindly",
  "she", "he", "his", "her", "is", "was", "am", "are"
]);

let words = [];
for (const w of rawWords) {
  const lw = w.toLowerCase();
  if (stopAt.has(lw)) break;
  if (stopwords.has(lw)) continue;
  words.push(w);
}

  if (words.length < 2) return null;

  words = words.slice(0, 3);

  const name = words
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ")
    .trim();

  return name;
}

function extractAge(rawText) {
  if (!rawText) return null;

  const match = rawText.match(/\b(\d{1,2})\b/);
  if (!match) return null;

  const age = parseInt(match[1], 10);
  if (Number.isNaN(age)) return null;

  return age;
}
function extractDesiredClass(rawText) {
  if (!rawText) return null;

  const lower = rawText.toLowerCase();

  // Nursery
  if (lower.includes("nursery")) {
    const match = lower.match(/nursery\s*\d?/);
    if (match) {
      return match[0]
        .replace(/\s+/, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
    }
    return "Nursery";
  }

  // Primary
  if (lower.includes("primary")) {
    const match = lower.match(/primary\s*\d+/);
    if (match) {
      return match[0]
        .replace(/\s+/, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
    }
    return "Primary";
  }

  return null;
}
function looksLikeFeeQuestion(text) {
  const t = (text || "").toLowerCase();
  return (
    t.includes("fee") ||
    t.includes("school fee") ||
    t.includes("tuition") ||
    t.includes("how much") ||
    t.includes("price") ||
    t.includes("cost")
  );
}

function normalizePhone(phone) {
  if (!phone) return "";
  const cleaned = phone
    .toString()
    .trim()
    .replace(/\s+/g, "")
    .replace(/^\++/, "");
  return `+${cleaned}`;
}

// =====================
// DB + Models
// =====================

const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASS,
  {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    dialect: "postgres",
    logging: false,
  }
);

const SchoolModel = require("./models/School");
const ParentModel = require("./models/Parent");
const ConversationModel = require("./models/Conversation");
const MessageModel = require("./models/Message");

const School = SchoolModel(sequelize, DataTypes);
const Parent = ParentModel(sequelize, DataTypes);
const Conversation = ConversationModel(sequelize, DataTypes);
const Message = MessageModel(sequelize, DataTypes);

// Relationships
School.hasMany(Parent, { foreignKey: "schoolId" });
Parent.belongsTo(School, { foreignKey: "schoolId" });

School.hasMany(Conversation, { foreignKey: "schoolId" });
Conversation.belongsTo(School, { foreignKey: "schoolId" });

Parent.hasMany(Conversation, { foreignKey: "parentId" });
Conversation.belongsTo(Parent, { foreignKey: "parentId" });

Conversation.hasMany(Message, { foreignKey: "conversationId" });
Message.belongsTo(Conversation, { foreignKey: "conversationId" });

// =====================
// Routes
// =====================

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/admin/schools", requireAdminKey, async (req, res) => {
  try {
    const { name, address, mapsLink } = req.body;

    if (!name) {
      return res.status(400).json({ success: false, message: "name is required" });
    }

    const school = await School.create({
      name,
      address: address || null,
      mapsLink: mapsLink || null,
    });

    return res.json({ success: true, school });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

// ----------
// Inbound webhook (parent messages)
// ----------
const inboundWebhookLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,             // 60 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
});
app.post("/webhooks/inbound", inboundWebhookLimiter, async (req, res) => {
  try {
    const { channel, from, schoolId, text, timestamp } = req.body;
    console.log("INBOUND RAW:", JSON.stringify(text));
    console.log("NAME EXTRACTED:", extractChildName(text))
    console.log("INBOUND RAW TEXT:", JSON.stringify(text));
    console.log("FROM:", from, "SCHOOL:", schoolId);
    const normalizedFrom = normalizePhone(from);

    if (!channel || !from || !schoolId || !text) {
      return res.status(400).json({
        success: false,
        message: "channel, from, schoolId, and text are required",
      });
    }
    // ✅ ADD THIS RIGHT HERE
const faq = matchFaq(text);
const looksLikeQuestion = text.trim().endsWith("?") || Boolean(faq);

if (looksLikeQuestion) {
  let replyText = "I’m not sure—please contact the school admin.";

  // Load school once (we need it for dynamic address + LLM context)
  const school = await School.findByPk(schoolId);

  if (faq) {
    const isAddressQuestion =
      faq.keywords.includes("address") ||
      faq.keywords.includes("location") ||
      faq.keywords.includes("where");

    if (isAddressQuestion) {
      if (school && school.address) {
        replyText = `📍 Address: ${school.address}`;
        if (school.mapsLink) replyText += `\n🗺️ Map: ${school.mapsLink}`;
      } else {
        replyText = "Address is not set yet. Please contact the school admin.";
      }
    } else {
      // keyword FAQ match
      replyText = faq.answer;
    }
  } else {
    // No keyword match, but it looks like a question → call LLM
    replyText = await llmFaqAnswer({ school, question: text });
  }

  const continuePrompt =
    "To continue admission, please tell me your child's full name.";

  return res.json({
    success: true,
    stored: true,
    reply: `${replyText}\n\n${continuePrompt}`,
  });
}  

    const schoolRecord = await School.findByPk(schoolId);
    if (!schoolRecord) {
      return res.status(404).json({ success: false, message: "School not found" });
    }

    const [parent] = await Parent.findOrCreate({
      where: { schoolId: schoolRecord.id, phone: normalizedFrom },
      defaults: { schoolId: schoolRecord.id, phone: normalizedFrom },
    });

    const [conversation] = await Conversation.findOrCreate({
      where: { schoolId: schoolRecord.id, parentId: parent.id, channel },
      defaults: {
        schoolId: schoolRecord.id,
        parentId: parent.id,
        channel,
        status: "open",
        admissionStep: null,
      },
    });

    await Message.create({
      conversationId: conversation.id,
      direction: "inbound",
      from: normalizedFrom,
      text,
      providerTimestamp: timestamp ? new Date(timestamp) : null,
    });

    conversation.lastMessageAt = new Date();
    await conversation.save();
    // =====================
// POST-PAYMENT (COMPLETED) HANDLING
// =====================
if (conversation.status === "completed" || conversation.invoiceStatus === "paid") {
  const cleanCompleted = text.trim().toLowerCase();

  let replyText = "";
  if (cleanCompleted === "timetable") {
    replyText =
      "✅ Timetable support.\n" +
      "Please tell me your preferred days and time (e.g., Mon/Wed 4pm).";
  } else if (cleanCompleted === "support") {
    replyText =
      "✅ Support.\n" +
      "Please describe the issue and we’ll respond shortly.";
  } else {
    replyText =
      "✅ You’re enrolled.\n" +
      "Reply:\n" +
      "- TIMETABLE (class schedule)\n" +
      "- SUPPORT (help)";
  }

  await Message.create({
    conversationId: conversation.id,
    direction: "outbound",
    from: "agent",
    text: replyText,
    providerTimestamp: null,
  });

  return res.json({ success: true, stored: true, reply: replyText });
}

// =====================
// INVOICE EMAIL / SKIP HANDLING (when invoiceStatus is pending)
// =====================
if (conversation.invoiceStatus === "pending") {
  const clean2 = text.trim().toLowerCase();
  const trimmed = text.trim();

  // simple email check
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);

  let replyText = "";

  if (clean2 === "skip") {
    // keep invoiceStatus as pending; admin will mark SENT later
    replyText =
      "Okay ✅ I will send the invoice here shortly.\n" +
      "An admin will review and mark it as SENT.";

  } else if (isEmail) {
    // Save email on Parent if the column exists; if not, we skip saving and still proceed.
    try {
      parent.email = trimmed;
      await parent.save();
    } catch (e) {
      // If Parent model has no email column yet, we don't crash.
      console.log("Parent email not saved (email column may not exist):", e.message);
    }

    replyText =
      `Great ✅ I will send the invoice to ${trimmed} shortly.\n` +
      "An admin will review and mark it as SENT.";
  } else {
    replyText = "Please reply with a valid email address or type SKIP.";
  }

  await Message.create({
    conversationId: conversation.id,
    direction: "outbound",
    from: "agent",
    text: replyText,
    providerTimestamp: null,
  });

  return res.json({ success: true, stored: true, reply: replyText });
}

// =====================
// FAQ: Fee questions
// =====================
if (looksLikeFeeQuestion(text)) {
  // If we already know desired class, use it; otherwise give a simple range
  let replyText = "";

  if (conversation.desiredClass) {
    const fee = getFeeForClass(conversation.desiredClass);
    replyText =
      `Tuition fee for ${conversation.desiredClass}: ₦${fee.toLocaleString()} (NGN).\n` +
      `If you want to start admission, reply with your child's full name.`;
  } else {
    replyText =
      "Tuition fee depends on class.\n" +
      "- Nursery: ₦25,000\n" +
      "- Primary 1–2: ₦35,000\n" +
      "- Primary (others): ₦40,000\n\n" +
      "To start admission, please tell me your child's full name.";
  }

  await Message.create({
    conversationId: conversation.id,
    direction: "outbound",
    from: "agent",
    text: replyText,
    providerTimestamp: null,
  });

  return res.json({ success: true, stored: true, reply: replyText });
}


    // =====================
    // Admission Flow + Fee
    // =====================
    let replyText = "";
    const clean = text.trim().toLowerCase();

    // INVOICE YES / NO HANDLING
    if (conversation.awaitingInvoiceConsent === true) {
      if (clean === "yes" || clean === "y") {
        conversation.awaitingInvoiceConsent = false;
        conversation.invoiceStatus = "pending";
        conversation.awaitingInvoiceDetails = true;   // <-- ADD THIS LINE
        await conversation.save();

        replyText =
          "Great ✅ I will generate your invoice now.\n" +
          "Please share your email address or reply SKIP to receive it here.";
      } else if (clean === "no" || clean === "n") {
        conversation.awaitingInvoiceConsent = false;
        conversation.invoiceStatus = "none";
        await conversation.save();

        replyText =
          "No problem ✅\n" +
          "If you change your mind, just type INVOICE anytime.";
      } else {
        replyText = "Please reply YES or NO.";
      }
    }

    // ADMISSION FLOW
    else {
      if (!conversation.admissionStep || conversation.admissionStep === "") {
        conversation.admissionStep = "ASK_CHILD_NAME";
        await conversation.save();

        replyText = "Welcome 👋 Please tell me your child's full name.";
      } else if (conversation.admissionStep === "ASK_CHILD_NAME") {
        const name = extractChildName(text);

        if (!name) {
          replyText = "Please reply with only your child's full name (e.g., Toyin Ade).";
        } else {
          conversation.childName = name;
          conversation.admissionStep = "ASK_CHILD_AGE";
          await conversation.save();

          replyText = `Thanks. How old is ${conversation.childName}? (Just a number like 6)`;
        }
      } else if (conversation.admissionStep === "ASK_CHILD_AGE") {
        const age = extractAge(text);

        if (age === null || age < 2 || age > 12) {
          replyText =
            "Please reply with your child's age as a number between 2 and 12 (e.g., 6).";
        } else {
          conversation.childAge = String(age);
          conversation.admissionStep = "ASK_DESIRED_CLASS";
          await conversation.save();

          replyText =
            "Great. Which class are you applying for? (e.g., Nursery 2, Primary 1)";
        }
      } else if (conversation.admissionStep === "ASK_DESIRED_CLASS") {
        const extractedClass = extractDesiredClass(text);

if (!extractedClass) {
  replyText = "Please reply with a class like Nursery 2 or Primary 5.";
} else {
  conversation.desiredClass = extractedClass;

  const fee = getFeeForClass(conversation.desiredClass);
  conversation.feeAmount = fee;
  conversation.feeCurrency = "NGN";

  conversation.admissionStep = "ADMISSION_COMPLETE";
  conversation.awaitingInvoiceConsent = true;
  conversation.invoiceStatus = "none";

  await conversation.save();

  replyText =
    `Admission started ✅\n` +
    `Child: ${conversation.childName}\n` +
    `Age: ${conversation.childAge}\n` +
    `Class: ${conversation.desiredClass}\n\n` +
    `Tuition fee: ₦${conversation.feeAmount.toLocaleString()} (${conversation.feeCurrency})\n` +
    `Would you like me to send an invoice? Reply YES or NO.`;
}

      } 
      else if (conversation.admissionStep === "ADMISSION_COMPLETE") {
        replyText =
          `Admission already completed ✅\n` +
          `Child: ${conversation.childName}\n` +
          `Age: ${conversation.childAge}\n` +
          `Class: ${conversation.desiredClass}\n\n` +
          `Tuition fee: ₦${conversation.feeAmount.toLocaleString()} (${conversation.feeCurrency})\n` +
          `Reply YES if you want an invoice.`;
      } else {
        replyText = "I’m here. Please tell me how I can help (admission, fees, timetable).";
      }
    }

    // Save outbound message ONCE
    await Message.create({
      conversationId: conversation.id,
      direction: "outbound",
      from: "agent",
      text: replyText,
      providerTimestamp: null,
    });

    return res.json({
      success: true,
      stored: true,
      reply: replyText,
    });
  } catch (error) {
    console.error("ERROR DETAILS:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ----------
// Admin: list conversations for a school
// ----------
app.get("/admin/conversations/:schoolId", requireAdminKey, async (req, res) => {
  try {
    const { schoolId } = req.params;

    const conversations = await Conversation.findAll({
      where: { schoolId },
      order: [["updatedAt", "DESC"]],
      include: [{ model: Parent, attributes: ["phone"] }],
    });

    return res.json({
      success: true,
      count: conversations.length,
      conversations,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ----------
// Admin: view messages for one conversation
// ----------
app.get("/admin/conversation/:conversationId/messages", requireAdminKey, async (req, res) => {
  try {
    const { conversationId } = req.params;

    const conversation = await Conversation.findByPk(conversationId, {
      include: [{ model: Parent, attributes: ["phone"] }, { model: Message }],
    });

    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: "Conversation not found",
      });
    }

    const messages = (conversation.Messages || []).sort(
      (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
    );

    return res.json({
      success: true,
      conversation: {
        id: conversation.id,
        schoolId: conversation.schoolId,
        parentId: conversation.parentId,
        channel: conversation.channel,
        status: conversation.status,
        admissionStep: conversation.admissionStep,
        childName: conversation.childName,
        childAge: conversation.childAge,
        desiredClass: conversation.desiredClass,
        feeAmount: conversation.feeAmount,
        feeCurrency: conversation.feeCurrency,
        awaitingInvoiceConsent: conversation.awaitingInvoiceConsent,
        invoiceStatus: conversation.invoiceStatus,
        Parent: conversation.Parent,
      },
      messages,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ----------
// Admin: pending invoices for a school
// ----------
app.get("/admin/pending-invoices/:schoolId", requireAdminKey, async (req, res) => {
  try {
    const { schoolId } = req.params;

    const pending = await Conversation.findAll({
      where: { schoolId, invoiceStatus: "pending" },
      order: [["updatedAt", "DESC"]],
      include: [{ model: Parent, attributes: ["phone"] }],
    });

    return res.json({
      success: true,
      count: pending.length,
      pending,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});
app.post("/admin/invoice/:conversationId/mark-sent", requireAdminKey, async (req, res) => {
  try {
    const { conversationId } = req.params;

    const conversation = await Conversation.findByPk(conversationId);
    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: "Conversation not found",
      });
    }

    conversation.invoiceStatus = "sent";
    await conversation.save();

    return res.json({
      success: true,
      message: "Invoice marked as sent",
      conversationId: conversation.id,
      invoiceStatus: conversation.invoiceStatus,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});
app.post("/admin/invoice/:conversationId/mark-paid", requireAdminKey, async (req, res) => {
  try {
    const { conversationId } = req.params;

    const conversation = await Conversation.findByPk(conversationId);
    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: "Conversation not found",
      });
    }

    // If already paid, don't duplicate actions (idempotent)
    if (conversation.invoiceStatus === "paid") {
      return res.json({
        success: true,
        message: "Invoice already marked as paid",
        conversationId: conversation.id,
        invoiceStatus: conversation.invoiceStatus,
        status: conversation.status,
      });
    }

    // Only allow paying if invoice was sent
    if (conversation.invoiceStatus !== "sent") {
      return res.status(400).json({
        success: false,
        message: `Cannot mark as paid because invoiceStatus is '${conversation.invoiceStatus}'. It must be 'sent' first.`,
      });
    }

    // 1) Update conversation state
    conversation.invoiceStatus = "paid";
    conversation.status = "completed";
    await conversation.save();

    // 2) Build a confirmation message (keep it simple)
    const school = await School.findByPk(conversation.schoolId);

    const child = conversation.childName ? conversation.childName : "your child";
    const schoolName = school?.name ? school.name : "our school";

    const replyText =
      `✅ Payment received.\n` +
      `Admission completed for ${child}.\n` +
      `Welcome to ${schoolName}!\n\n` +
      `If you need help with timetable or class start date, reply TIMETABLE.`;

    // 3) Save outbound message into Messages table
    await Message.create({
      conversationId: conversation.id,
      direction: "outbound",
      from: "agent",
      text: replyText,
      providerTimestamp: null,
    });

    return res.json({
      success: true,
      message: "Invoice marked as paid and confirmation message sent",
      conversationId: conversation.id,
      invoiceStatus: conversation.invoiceStatus,
      status: conversation.status,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.post("/admin/conversation/:conversationId/reset", requireAdminKey, async (req, res) => {
  try {
    const { conversationId } = req.params;

    const conversation = await Conversation.findByPk(conversationId);
    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: "Conversation not found",
      });
    }

    // Reset admission fields
    conversation.status = "open";
    conversation.admissionStep = null;
    conversation.childName = null;
    conversation.childAge = null;
    conversation.desiredClass = null;

    // Reset fee + invoice fields
    conversation.feeAmount = null;
    conversation.feeCurrency = null;
    conversation.awaitingInvoiceConsent = false;
    conversation.invoiceStatus = "none";

    await conversation.save();

    return res.json({
      success: true,
      message: "Conversation reset successfully",
      conversationId: conversation.id,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});
app.get("/health", (req, res) => {
  res.json({ success: true, status: "ok" });
});

app.patch("/admin/schools/:schoolId", requireAdminKey, async (req, res) => {
  try {
    const { schoolId } = req.params;
    const { address, mapsLink } = req.body;

    const school = await School.findByPk(schoolId);
    if (!school) {
      return res.status(404).json({ success: false, message: "School not found" });
    }

    await school.update({
      address: address ?? school.address,
      mapsLink: mapsLink ?? school.mapsLink,
    });

    return res.json({ success: true, school });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

app.use((err, req, res, next) => {
  console.error("UNHANDLED ERROR:", err);

  res.status(500).json({
    success: false,
    message: "Something went wrong",
  });
});

// =====================
// Start server
// =====================

const PORT = process.env.PORT || 5000;

async function start() {
  try {
    await sequelize.authenticate();
    console.log("✅ DB connected to:", process.env.DB_NAME);

    await sequelize.sync({ alter: true });
    console.log("✅ Tables synced");

 

    app.listen(PORT, () => {
      console.log(`✅ Server running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("❌ Startup error:", err.message);
    process.exit(1);
  }
}

start();
