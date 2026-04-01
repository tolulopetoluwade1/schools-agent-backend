// =====================
// server.js (CLEAN VERSION)
// =====================
require("dotenv").config();

const cors = require("cors");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Sequelize, DataTypes } = require("sequelize");
const OpenAI = require("openai");
const paymentRoutes = require("./routes/paymentRoutes");


// ---------------------
// App init
// ---------------------
const app = express();

// Render/Proxy fix (required for rate limiting + proxy headers)
app.set("trust proxy", true);

// Body parsing
app.use(express.json({ limit: "200kb" }));
app.use("/uploads", express.static("uploads"));

// Request logger (keep it simple)
app.use((req, res, next) => {
  console.log("➡️ REQUEST:", req.method, req.originalUrl);
  next();
});

// ---------------------
// CORS
// ---------------------
const allowedOrigins = [
  "http://localhost:5173",
  "https://schools-agent-admin-dashboard.vercel.app",
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true); // allow Postman/server-server
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    credentials: true,
  })
);

// Security headers
app.use(helmet());

// ---------------------
// OpenAI init (DO NOT CRASH if missing)
// ---------------------
let openai = null;

if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  console.log("✅ OpenAI client initialized");
} else {
  console.log("⚠️ OPENAI_API_KEY not set. LLM features disabled.");
}

// ---------------------
// DB init
// ---------------------  
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
const WhatsAppNumberModel = require("./models/WhatsAppNumber");
const WhatsAppNumber = WhatsAppNumberModel(sequelize, DataTypes);


// Models
const SchoolModel = require("./models/School");
const ParentModel = require("./models/Parent");
const ConversationModel = require("./models/Conversation");
const MessageModel = require("./models/Message");
const StudentModel = require("./models/Student");
const PaymentModel = require("./models/Payment");
const PaymentInstallmentModel = require("./models/PaymentInstallment");
const startInstallmentReminder = require("./services/installmentReminderService");

const School = SchoolModel(sequelize, DataTypes);
const Parent = ParentModel(sequelize, DataTypes);
const Conversation = ConversationModel(sequelize, DataTypes);
const Message = MessageModel(sequelize, DataTypes);
const Student = StudentModel(sequelize, DataTypes);
const Payment = PaymentModel(sequelize, DataTypes);
const PaymentInstallment = PaymentInstallmentModel(sequelize, DataTypes);

// Relationship (each number belongs to a school)
School.hasMany(WhatsAppNumber, { foreignKey: "schoolId" });
WhatsAppNumber.belongsTo(School, { foreignKey: "schoolId" });


const PaymentInstallmentRoutes = require("./routes/paymentInstallmentRoutes")(PaymentInstallment);

app.use("/api/installments", PaymentInstallmentRoutes);

// Payment routes
app.use("/api/payments", paymentRoutes(Payment));

// Relationships
School.hasMany(Parent, { foreignKey: "schoolId" });
Parent.belongsTo(School, { foreignKey: "schoolId" });

Parent.hasMany(Student, { foreignKey: "parentId" });
Student.belongsTo(Parent, { foreignKey: "parentId" });

School.hasMany(Conversation, { foreignKey: "schoolId" });
Conversation.belongsTo(School, { foreignKey: "schoolId" });

Parent.hasMany(Conversation, { foreignKey: "parentId" });
Conversation.belongsTo(Parent, { foreignKey: "parentId" });

Conversation.hasMany(Message, { foreignKey: "conversationId" });
Message.belongsTo(Conversation, { foreignKey: "conversationId" });

// ---------------------
// Helpers
// ---------------------
function requireAdminKey(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!key || key !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  next();
}

function normalizePhone(phone) {
  if (!phone) return "";
  const cleaned = phone.toString().trim().replace(/\s+/g, "").replace(/^\++/, "");
  return `+${cleaned}`;
}
function continuePromptFor(conversation) {
  const step = conversation?.admissionStep;

  if (conversation?.invoiceStatus === "pending") {
    return "To continue, please reply with your email address or type SKIP.";
  }

  if (!step || step === "" || step === "ASK_CHILD_NAME") {
    return "To continue admission, please tell me your child's full name.";
  }

  if (step === "ASK_CHILD_AGE") {
    return `To continue, how old is ${conversation.childName || "your child"}? (Just a number like 6)`;
  }

  if (step === "ASK_DESIRED_CLASS") {
    return "To continue, which class are you applying for? (e.g., Nursery 2, Primary 5)";
  }

  return "To continue, please reply to the last question.";
}

function getFeeForClass(desiredClass) {
  const c = (desiredClass || "").toLowerCase();
  if (c.includes("nursery")) return 25000;
  if (c.includes("primary 1")) return 35000;
  if (c.includes("primary 2")) return 35000;
  if (c.includes("primary")) return 40000;
  return 40000;
}

function extractAge(rawText) {
  if (!rawText) return null;
  const match = String(rawText).match(/\b(\d{1,2})\b/);
  if (!match) return null;

  const age = parseInt(match[1], 10);
  if (Number.isNaN(age)) return null;
  return age;
}

function extractDesiredClass(rawText) {
  if (!rawText) return null;
  const lower = String(rawText).toLowerCase();

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

// function extractChildName(rawText) {
//   if (!rawText) return null;

//   const text = String(rawText).trim().replace(/\s+/g, " ");
//   const lower = text.toLowerCase();

//   // reject obvious sentences/questions
//   const badStarts = ["i need", "i want", "i would", "can you", "do you", "how", "what", "where", "when", "why"];
//   if (badStarts.some((s) => lower.startsWith(s))) return null;

//   let cleaned = text
//     .replace(/^my\s+child(?:'s)?\s+(?:full\s+name|name)\s+is\s+/i, "")
//     .replace(/^my\s+child\s+is\s+/i, "")
//     .replace(/^name\s+is\s+/i, "")
//     .trim();

//   cleaned = cleaned.replace(/[^a-zA-Z\s'-]/g, " ").replace(/\s+/g, " ").trim();
//   if (!cleaned) return null;

//   const words = cleaned.split(" ").filter(Boolean);
//   if (words.length === 0) return null;

//   const name = words
//     .slice(0, 4)
//     .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
//     .join(" ");

//   return name;
// }
function extractChildName(rawText) {
  if (!rawText) return null;

  const text = String(rawText).trim();

  // Remove unwanted characters
  const cleaned = text
    .replace(/[^a-zA-Z\s'-]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const words = cleaned.split(" ").filter(Boolean);

  // Must be at least 2 words (first + last name)
  if (words.length < 2) return null;

  // Capitalize properly
  return words
    .slice(0, 4)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

// ---------------------
// FAQ + LLM
// ---------------------
const FAQS = [
  {
    keywords: ["fees", "tuition", "school fees", "how much"],
    answer: "School fees depend on the class. Please tell me your child’s class (e.g., Nursery 2, Primary 3).",
  },
  {
    keywords: ["address", "location", "where", "located"],
    answer: "The school address will be shared after admission begins. Please tell me your child's full name to continue.",
  },
  { keywords: ["uniform"], answer: "Yes, the school uses uniform. Details will be shared after admission begins." },
  { keywords: ["resumption", "resume", "resumption date"], answer: "Resumption date varies by term. Admin will confirm after admission begins." },
];

function matchFaq(text) {
  const t = String(text || "").toLowerCase();
  return FAQS.find((f) => f.keywords.some((k) => t.includes(k)));
}

async function llmFallbackAnswer({ school, question, conversation }) {
  // feature flag
  if (process.env.LLM_FALLBACK_ENABLED !== "true") {
    return "I’m not sure—please contact the school admin.";
  }

  // don't crash if not configured
  if (!openai) {
    return "I’m not sure—please contact the school admin.";
  }

  const model = process.env.OPENAI_MODEL || "gpt-5-mini";

  const instructions =
    "You are a school admissions assistant for a Nigerian school. " +
    "Answer ONLY using SCHOOL INFO. " +
    "If the answer is not in the info, say: 'I’m not sure—please contact the school admin.' " +
    "Be short (1-4 lines).";

  const schoolInfo = [
    `School name: ${school?.name || ""}`,
    `Address: ${school?.address || ""}`,
    `Map: ${school?.mapsLink || ""}`,
  ].join("\n");

  const currentState = [
    `Current admissionStep: ${conversation?.admissionStep || ""}`,
    `Child name: ${conversation?.childName || ""}`,
    `Child age: ${conversation?.childAge || ""}`,
    `Desired class: ${conversation?.desiredClass || ""}`,
    `Invoice status: ${conversation?.invoiceStatus || ""}`,
  ].join("\n");

  try {
    const resp = await openai.responses.create({
      model,
      instructions,
      input:
        `SCHOOL INFO:\n${schoolInfo}\n\n` +
        `CURRENT STATE:\n${currentState}\n\n` +
        `PARENT MESSAGE:\n${question}\n\n` +
        `If the message is not a question, reply politely and guide them back to the next required step.`,
    });

    return (resp.output_text || "").trim() || "I’m not sure—please contact the school admin.";
  } catch (e) {
    console.log("❌ LLM error:", e?.message || e);
    return "I’m not sure—please contact the school admin.";
  }
}
// ---------------------
// WhatsApp Cloud send helper
// ---------------------
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

// ---------------------
// Core inbound processor (shared by /webhooks/inbound and Meta /webhook)
// ---------------------
async function processInboundMessage({ channel, from, schoolId, text, timestamp }) {
  const normalizedFrom = normalizePhone(from);

  // Validate
  if (!channel || !from || !schoolId || !text) {
    return "Missing required fields.";
  }

  // Load school
  const schoolRecord = await School.findByPk(schoolId);
  if (!schoolRecord) return "School not found.";

  // Parent + conversation
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

  // Save inbound message
  await Message.create({
    conversationId: conversation.id,
    direction: "inbound",
    from: normalizedFrom,
    text,
    providerTimestamp: timestamp ? new Date(timestamp) : null,
  });

  conversation.lastMessageAt = new Date();
  await conversation.save();

  const cleanText = text.trim().toLowerCase();

  // ---------------------
  // Global intents (greetings)
  // ---------------------
  const greetingWords = ["hi","hello","hey","hiya","helloooo","good morning","good afternoon","good evening"];
  if (greetingWords.includes(cleanText)) {
    let contextInfo = "";
    if (conversation.childName) {
      contextInfo += `Child: ${conversation.childName}\n`;
    }

    const reply = `Hi 👋\n\nWe’re continuing your admission.\n\n${contextInfo}${continuePromptFor(conversation)}`;

    await Message.create({
      conversationId: conversation.id,
      direction: "outbound",
      from: "agent",
      text: reply,
      providerTimestamp: null,
    });

    return reply;
  }

  // ---------------------
  // FAQ check
  // ---------------------
  const faqAnswer = matchFaq(text);
  if (faqAnswer) {
    const reply = faqAnswer;

    await Message.create({
      conversationId: conversation.id,
      direction: "outbound",
      from: "agent",
      text: reply,
      providerTimestamp: null,
    });

    return reply;
  }

  // ---------------------
  // LLM fallback for off-flow messages
  // ---------------------
  const expectedStep = conversation?.admissionStep || "ASK_CHILD_NAME"; // fallback default

  const messageLooksLikeAge = /^\d{1,2}$/.test(cleanText);
  const messageLooksLikeClass = /nursery|primary/i.test(cleanText);
  const messageLooksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanText);

  const offFlow =
    (expectedStep === "ASK_CHILD_AGE" && !messageLooksLikeAge) ||
    (expectedStep === "ASK_DESIRED_CLASS" && !messageLooksLikeClass) ||
    (expectedStep === "EXPECT_EMAIL_OR_SKIP" && !(messageLooksLikeEmail || cleanText === "skip"));

  if (offFlow) {
    const llmText = await llmFallbackAnswer({
      school: schoolRecord,
      question: text,
      conversation,
    });

    const reply = `${llmText}\n\n${continuePromptFor(conversation)}`;

    await Message.create({
      conversationId: conversation.id,
      direction: "outbound",
      from: "agent",
      text: reply,
      providerTimestamp: null,
    });

    return reply;
  }

  // ---------------------
  // Normal admission flow (child name, age, class, etc.)
  // ---------------------
  const reply = continuePromptFor(conversation); // your normal flow prompt

  await Message.create({
    conversationId: conversation.id,
    direction: "outbound",
    from: "agent",
    text: reply,
    providerTimestamp: null,
  });

  return reply;
}

// If they ask fees anytime
if (looksLikeFeeQuestion(text)) {
  let replyText = "";
  if (conversation.desiredClass) {
    const fee = getFeeForClass(conversation.desiredClass);
    replyText = `Tuition fee for ${conversation.desiredClass}: ₦${fee.toLocaleString()} (NGN).`;
  } else {
    replyText =
      "Tuition fee depends on class.\n" +
      "- Nursery: ₦25,000\n" +
      "- Primary 1–2: ₦35,000\n" +
      "- Primary (others): ₦40,000";
  }

  const reply = `${replyText}\n\n${continuePromptFor(conversation)}`;

  await Message.create({
    conversationId: conversation.id,
    direction: "outbound",
    from: "agent",
    text: reply,
    providerTimestamp: null,
  });

  return reply;
}

// FAQ keyword match anytime
if (faq) {
  let replyText = faq.answer;

  // address uses DB if available
  const isAddressQuestion =
    faq.keywords.includes("address") ||
    faq.keywords.includes("location") ||
    faq.keywords.includes("where");

  if (isAddressQuestion) {
    if (schoolRecord?.address) {
      replyText = `📍 Address: ${schoolRecord.address}`;
      if (schoolRecord.mapsLink) replyText += `\n🗺️ Map: ${schoolRecord.mapsLink}`;
    } else {
      replyText = "Address is not set yet. Please contact the school admin.";
    }
  }

  const reply = `${replyText}\n\n${continuePromptFor(conversation)}`;

  await Message.create({
    conversationId: conversation.id,
    direction: "outbound",
    from: "agent",
    text: reply,
    providerTimestamp: null,
  });

  return reply;
}

// ✅ HERE is the improvement:
// If message is not fitting the current step AND LLM is enabled, use LLM as fallback.
const expectedStep = conversation?.invoiceStatus === "pending"
  ? "EXPECT_EMAIL_OR_SKIP"
  : (conversation?.admissionStep || "ASK_CHILD_NAME");

const messageLooksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text.trim());
const messageLooksLikeAge = /^\s*\d{1,2}\s*$/.test(text.trim());
const messageLooksLikeClass = /nursery|primary/i.test(text);

// Decide if message is “off-flow”
const offFlow =
  (expectedStep === "EXPECT_EMAIL_OR_SKIP" && !(messageLooksLikeEmail || cleanText === "skip")) ||
  (expectedStep === "ASK_CHILD_AGE" && !messageLooksLikeAge) ||
  (expectedStep === "ASK_DESIRED_CLASS" && !messageLooksLikeClass);

// If off-flow → call LLM and then guide them back
if (offFlow) {
  const llmText = await llmFallbackAnswer({
    school: schoolRecord,
    question: text,
    conversation,
  }); 
  // ---------------------
// TEST LLM (RUN ONCE)
// ---------------------
async function testLLM() {
  const resp = await llmFallbackAnswer({
    school: { name: "Test School", address: "Lagos" },
    question: "What is the school fee?",
    conversation: {},
  });

  console.log("✅ LLM TEST RESPONSE:", resp);
}

// CALL IT ONCE
testLLM();

  const reply = `${llmText}\n\n${continuePromptFor(conversation)}`;

  await Message.create({
    conversationId: conversation.id,
    direction: "outbound",
    from: "agent",
    text: reply,
    providerTimestamp: null,
  });

  return reply;
}

  // ---------------------
  // POST-PAYMENT (COMPLETED)
  // ---------------------
  if (conversation.status === "completed" || conversation.invoiceStatus === "paid") {
    const cleanCompleted = text.trim().toLowerCase();

    let replyText = "";
    if (cleanCompleted === "timetable") {
      replyText =
        "✅ Timetable support.\n" +
        "Please tell me your preferred days and time (e.g., Mon/Wed 4pm).";
    } else if (cleanCompleted === "support") {
      replyText = "✅ Support.\nPlease describe the issue and we’ll respond shortly.";
    } else {
      replyText =
        "✅ You’re enrolled.\nReply:\n- TIMETABLE (class schedule)\n- SUPPORT (help)";
    }

    await Message.create({
      conversationId: conversation.id,
      direction: "outbound",
      from: "agent",
      text: replyText,
      providerTimestamp: null,
    });

    return replyText;
  }

  // ---------------------
  // INVOICE EMAIL / SKIP (pending)
  // ---------------------
  if (conversation.invoiceStatus === "pending") {
    const clean2 = text.trim().toLowerCase();
    const trimmed = text.trim();
    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);

    let replyText = "";

    if (clean2 === "skip") {
      replyText =
        "Okay ✅ I will send the invoice here shortly.\n" +
        "An admin will review and mark it as SENT.";
    } else if (isEmail) {
      try {
        parent.email = trimmed;
        await parent.save();
      } catch (e) {
        console.log("Parent email not saved:", e.message);
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

    return replyText;
  }



  // ---------------------
  // Admission flow
  // ---------------------
  let replyText = "";
  const clean = text.trim().toLowerCase();

  // INVOICE YES/NO handling
  if (conversation.awaitingInvoiceConsent === true) {
    if (clean === "yes" || clean === "y") {
      conversation.awaitingInvoiceConsent = false;
      conversation.invoiceStatus = "pending";
      conversation.awaitingInvoiceDetails = true;
      await conversation.save();

      replyText =
        "Great ✅ I will generate your invoice now.\n" +
        "Please share your email address or reply SKIP to receive it here.";
    } else if (clean === "no" || clean === "n") {
      conversation.awaitingInvoiceConsent = false;
      conversation.invoiceStatus = "none";
      await conversation.save();

      replyText =
        "No problem ✅\nIf you change your mind, just type INVOICE anytime.";
    } else {
      replyText = "Please reply YES or NO.";
    }
  } else {
    if (!conversation.admissionStep || conversation.admissionStep === "") {
      conversation.admissionStep = "ASK_CHILD_NAME";
      await conversation.save();
      replyText = "Welcome 👋 Please tell me your child's full name.";
    } 
      else if (conversation.admissionStep === "ASK_CHILD_NAME") {
    console.log("DEBUG NAME INPUT:", text);

    const name = extractChildName(text);

    console.log("EXTRACTED NAME:", name);

    if (!name) {
      replyText = "Please reply with only your child's full name (e.g., Toyin Ade).";
    } else {
      conversation.childName = name;
      conversation.admissionStep = "ASK_CHILD_AGE";

      await conversation.save();

      console.log("SAVED NAME:", conversation.childName);

      replyText = `Thanks. How old is ${conversation.childName}? (Just a number like 6)`;
      }
    } 
      else if (conversation.admissionStep === "ASK_CHILD_AGE") {
      const age = extractAge(text);

      if (age === null || age < 2 || age > 12) {
        replyText = "Please reply with your child's age as a number between 2 and 12 (e.g., 6).";
      } else {
        conversation.childAge = String(age);
        conversation.admissionStep = "ASK_DESIRED_CLASS";
        await conversation.save();

        replyText = "Great. Which class are you applying for? (e.g., Nursery 2, Primary 1)";
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
    } else if (conversation.admissionStep === "ADMISSION_COMPLETE") {
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

  // Save outbound
  await Message.create({
    conversationId: conversation.id,
    direction: "outbound",
    from: "agent",
    text: replyText,
    providerTimestamp: null,
  });

  return replyText;


// // ---------------------
// // Routes
// // ---------------------

// Health (single source of truth)
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    llmFallbackEnabled: process.env.LLM_FALLBACK_ENABLED === "true",
    llmTestMode: process.env.LLM_TEST_MODE === "true",
    invoiceSendEnabled: process.env.INVOICE_SEND_ENABLED === "true",
  });
});

app.get("/privacy", (req, res) => {
  res.send(`
    <h1>Privacy Policy</h1>
    <p>This application collects user messages for the purpose of school admission automation.</p>
    <p>No personal data is shared with third parties.</p>
    <p>Contact: skilledskooltutors@gmail.com</p>
  `);
});
app.post("/admin/add-number", async (req, res) => {
  try {
    const { phoneNumber, telegramId, schoolId } = req.body;

    if (!schoolId) {
      return res.status(400).json({ success: false, message: "schoolId is required" });
    }

    const record = await WhatsAppNumber.create({
      phoneNumber: phoneNumber || null,
      telegramId: telegramId || null,
      schoolId,
    });

    res.json({ success: true, record });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Meta WhatsApp webhook verify
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

// Meta WhatsApp webhook receive + reply
app.post("/webhook", async (req, res) => {
  try {
    console.log("🔥 WEBHOOK HIT");
    // acknowledge immediately
    res.sendStatus(200);

    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const message = value?.messages?.[0];
    const from = message?.from; // "234813..."
    const text = message?.text?.body;

    if (!from || !text) return;

    console.log("✅ INCOMING TEXT:", text, "FROM:", from);

    // Normalize incoming number
    const normalizedFrom = `+${from}`;

    // Look up the school for this number
    const numberRecord = await WhatsAppNumber.findOne({
      where: { phoneNumber: normalizedFrom },
    });

    if (!numberRecord) {
      console.log("❌ Incoming number not recognized:", normalizedFrom);
      return; // or send a polite message back
    }

const schoolId = numberRecord.schoolId;

   const replyText = await processInboundMessage({
  channel: "whatsapp",
  from: normalizedFrom, // from Step 2
  schoolId,             // now dynamic
  text,
  timestamp: new Date().toISOString(),
});

    await sendWhatsAppText(from, replyText);
  } catch (err) {
    console.error("❌ /webhook error:", err);
  }
});

// Inbound (internal/testing endpoint)
const inboundWebhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
});

app.post("/webhooks/inbound", inboundWebhookLimiter, async (req, res) => {
  try {
    const reply = await processInboundMessage(req.body);
    return res.json({ success: true, stored: true, reply });
  } catch (error) {
    console.error("ERROR DETAILS:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Admin routes you already had (kept minimal; add more as needed)
app.get("/admin/conversations/:schoolId", requireAdminKey, async (req, res) => {
  try {
    const { schoolId } = req.params;

    const conversations = await Conversation.findAll({
      where: { schoolId },
      order: [["updatedAt", "DESC"]],
      include: [{ model: Parent, attributes: ["phone"] }],
    });

    return res.json({ success: true, count: conversations.length, conversations });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});
// ---------------------
// Admin list pending payments
// ---------------------
app.get("/admin/payments/pending", requireAdminKey, async (req, res) => {
  try {

    const payments = await Payment.findAll({
      where: { status: "verification_pending" },
      order: [["createdAt", "DESC"]]
    });

    return res.json({
      success: true,
      count: payments.length,
      payments
    });

  } catch (error) {
    console.error("Fetch pending payments error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch pending payments"
    });
  }
});
// ---------------------
// Admin approve payment
// ---------------------
app.post("/admin/payments/:paymentId/approve", requireAdminKey, async (req, res) => {
  try {

    const { paymentId } = req.params;

    const payment = await Payment.findByPk(paymentId);

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: "Payment not found"
      });
    }

    payment.status = "paid";

    await payment.save();

    return res.json({
      success: true,
      message: "Payment approved",
      payment
    });

  } catch (error) {
    console.error("Approve payment error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to approve payment"
    });
  }
});
// ---------------------
// Auto-approve payment (TEST MODE - no Paystack yet)
// ---------------------
app.post("/payments/:paymentId/auto-approve", async (req, res) => {
  try {

    const { paymentId } = req.params;

    // Find the payment
    const payment = await Payment.findByPk(paymentId);

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: "Payment not found"
      });
    }

    // For now we skip Paystack verification
    // and directly mark the payment as paid

    payment.status = "paid";

    await payment.save();

    return res.json({
      success: true,
      message: "Payment automatically approved (TEST MODE)",
      payment
    });

  } catch (error) {

    console.error("Auto approve error:", error);

    return res.status(500).json({
      success: false,
      message: "Auto approval failed"
    });

  }
});

app.get("/admin/conversation/:conversationId/messages", requireAdminKey, async (req, res) => {
  try {
    const { conversationId } = req.params;

    const conversation = await Conversation.findByPk(conversationId, {
      include: [{ model: Parent, attributes: ["phone"] }, { model: Message }],
    });

    if (!conversation) {
      return res.status(404).json({ success: false, message: "Conversation not found" });
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
    return res.status(500).json({ success: false, error: error.message });
  }
});
// Reset conversation
app.post("/admin/conversation/:conversationId/reset", requireAdminKey, async (req, res) => {
  try {
    const { conversationId } = req.params;

    const conversation = await Conversation.findByPk(conversationId);

    if (!conversation) {
      return res.status(404).json({ success: false, message: "Conversation not found" });
    }

    conversation.admissionStep = null;
    conversation.childName = null;
    conversation.childAge = null;
    conversation.desiredClass = null;
    conversation.feeAmount = null;
    conversation.feeCurrency = null;
    conversation.awaitingInvoiceConsent = false;
    conversation.awaitingInvoiceDetails = false;
    conversation.invoiceStatus = "none";

    conversation.status = "open";
    conversation.lastMessageAt = null;

    await conversation.save();

    return res.json({
      success: true,
      message: "Conversation reset successfully",
      conversationId: conversation.id
    });

  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------
// Create Student API
// ---------------------
app.post("/students", async (req, res) => {
  try {
    const { name, className, schoolId, parentId } = req.body;

    if (!name || !className || !schoolId || !parentId) {
      return res.status(400).json({
        success: false,
        message: "name, className, schoolId and parentId are required",
      });
    }

    const student = await Student.create({
      name,
      className,
      schoolId,
      parentId,
    });

    return res.json({
      success: true,
      student,
    });
  } catch (error) {
    console.error("Create student error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to create student",
    });
  }
});

// Global error handler
app.use((err, req, res, next) => {
  console.error("UNHANDLED ERROR:", err);
  res.status(500).json({ success: false, message: "Something went wrong" });
});
// ---------------------
// Telegram setup
// ---------------------
const { Telegraf } = require("telegraf");

if (process.env.TELEGRAM_BOT_TOKEN) {
  const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

  console.log("✅ Telegram bot initialized");

  // Incoming message handler
  bot.on("text", async (ctx) => {
    try {
      const telegramId = ctx.from.id.toString();
      const text = ctx.message.text;

      console.log("✅ Telegram message:", text, "FROM:", telegramId);

      // Here we treat Telegram ID as "from"
      // Look up the school for this Telegram ID
      const numberRecord = await WhatsAppNumber.findOne({
        where: { telegramId }, // add telegramId column to WhatsAppNumber table
      });

      if (!numberRecord) {
        console.log("❌ Telegram user not recognized:", telegramId);
        return ctx.reply(
          "Hello! Your Telegram account is not registered with any school. Please contact admin."
        );
      }

      const schoolId = numberRecord.schoolId;

      const replyText = await processInboundMessage({
        channel: "telegram",
        from: telegramId,
        schoolId,
        text,
        timestamp: new Date().toISOString(),
      });

      await ctx.reply(replyText);
    } catch (err) {
      console.error("❌ Telegram handler error:", err);
    }
  });

  bot.launch();
  console.log("✅ Telegram bot running...");
} else {
  console.log("⚠️ TELEGRAM_BOT_TOKEN not set. Telegram bot disabled.");
}

// ---------------------
// Start server (listen immediately)
// ---------------------
const PORT = process.env.PORT || 5000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server listening on port ${PORT}`);
});

// DB init in background (won't block Render port scan)
(async function initDb() {
  try {
    await sequelize.authenticate();
    console.log("✅ DB connected to:", process.env.DB_NAME);
    await sequelize.sync({ alter: true });
    console.log("✅ Tables synced");
    // startInstallmentReminder(PaymentInstallment, Parent, Student, sendWhatsAppText);
    console.log("✅ Installment reminder service started");
  } catch (err) {
    console.error("❌ DB init error:", err.message);
  }
})();






//I am copying this here for future use 
// =====================
// server.js (CLEAN VERSION)
// =====================
require("dotenv").config();

const cors = require("cors");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Sequelize, DataTypes } = require("sequelize");
const OpenAI = require("openai");
const paymentRoutes = require("./routes/paymentRoutes");


// ---------------------
// App init
// ---------------------
const app = express();

// Render/Proxy fix (required for rate limiting + proxy headers)
app.set("trust proxy", true);

// Body parsing
app.use(express.json({ limit: "200kb" }));
app.use("/uploads", express.static("uploads"));

// Request logger (keep it simple)
app.use((req, res, next) => {
  console.log("➡️ REQUEST:", req.method, req.originalUrl);
  next();
});

// ---------------------
// CORS
// ---------------------
const allowedOrigins = [
  "http://localhost:5173",
  "https://schools-agent-admin-dashboard.vercel.app",
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true); // allow Postman/server-server
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    credentials: true,
  })
);

// Security headers
app.use(helmet());

// ---------------------
// OpenAI init (DO NOT CRASH if missing)
// ---------------------
let openai = null;

if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  console.log("✅ OpenAI client initialized");
} else {
  console.log("⚠️ OPENAI_API_KEY not set. LLM features disabled.");
}

// ---------------------
// DB init
// ---------------------  
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
const WhatsAppNumberModel = require("./models/WhatsAppNumber");
const WhatsAppNumber = WhatsAppNumberModel(sequelize, DataTypes);


// Models
const SchoolModel = require("./models/School");
const ParentModel = require("./models/Parent");
const ConversationModel = require("./models/Conversation");
const MessageModel = require("./models/Message");
const StudentModel = require("./models/Student");
const PaymentModel = require("./models/Payment");
const PaymentInstallmentModel = require("./models/PaymentInstallment");
const startInstallmentReminder = require("./services/installmentReminderService");

const School = SchoolModel(sequelize, DataTypes);
const Parent = ParentModel(sequelize, DataTypes);
const Conversation = ConversationModel(sequelize, DataTypes);
const Message = MessageModel(sequelize, DataTypes);
const Student = StudentModel(sequelize, DataTypes);
const Payment = PaymentModel(sequelize, DataTypes);
const PaymentInstallment = PaymentInstallmentModel(sequelize, DataTypes);

// Relationship (each number belongs to a school)
School.hasMany(WhatsAppNumber, { foreignKey: "schoolId" });
WhatsAppNumber.belongsTo(School, { foreignKey: "schoolId" });


const PaymentInstallmentRoutes = require("./routes/paymentInstallmentRoutes")(PaymentInstallment);

app.use("/api/installments", PaymentInstallmentRoutes);

// Payment routes
app.use("/api/payments", paymentRoutes(Payment));

// Relationships
School.hasMany(Parent, { foreignKey: "schoolId" });
Parent.belongsTo(School, { foreignKey: "schoolId" });

Parent.hasMany(Student, { foreignKey: "parentId" });
Student.belongsTo(Parent, { foreignKey: "parentId" });

School.hasMany(Conversation, { foreignKey: "schoolId" });
Conversation.belongsTo(School, { foreignKey: "schoolId" });

Parent.hasMany(Conversation, { foreignKey: "parentId" });
Conversation.belongsTo(Parent, { foreignKey: "parentId" });

Conversation.hasMany(Message, { foreignKey: "conversationId" });
Message.belongsTo(Conversation, { foreignKey: "conversationId" });

// ---------------------
// Helpers
// ---------------------
function requireAdminKey(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!key || key !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  next();
}

function normalizePhone(phone) {
  if (!phone) return "";
  const cleaned = phone.toString().trim().replace(/\s+/g, "").replace(/^\++/, "");
  return `+${cleaned}`;
}
function continuePromptFor(conversation) {
  const step = conversation?.admissionStep;

  if (conversation?.invoiceStatus === "pending") {
    return "To continue, please reply with your email address or type SKIP.";
  }

  if (!step || step === "" || step === "ASK_CHILD_NAME") {
    return "To continue admission, please tell me your child's full name.";
  }

  if (step === "ASK_CHILD_AGE") {
    return `To continue, how old is ${conversation.childName || "your child"}? (Just a number like 6)`;
  }

  if (step === "ASK_DESIRED_CLASS") {
    return "To continue, which class are you applying for? (e.g., Nursery 2, Primary 5)";
  }

  return "To continue, please reply to the last question.";
}

function getFeeForClass(desiredClass) {
  const c = (desiredClass || "").toLowerCase();
  if (c.includes("nursery")) return 25000;
  if (c.includes("primary 1")) return 35000;
  if (c.includes("primary 2")) return 35000;
  if (c.includes("primary")) return 40000;
  return 40000;
}

function extractAge(rawText) {
  if (!rawText) return null;
  const match = String(rawText).match(/\b(\d{1,2})\b/);
  if (!match) return null;

  const age = parseInt(match[1], 10);
  if (Number.isNaN(age)) return null;
  return age;
}

function extractDesiredClass(rawText) {
  if (!rawText) return null;
  const lower = String(rawText).toLowerCase();

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

// function extractChildName(rawText) {
//   if (!rawText) return null;

//   const text = String(rawText).trim().replace(/\s+/g, " ");
//   const lower = text.toLowerCase();

//   // reject obvious sentences/questions
//   const badStarts = ["i need", "i want", "i would", "can you", "do you", "how", "what", "where", "when", "why"];
//   if (badStarts.some((s) => lower.startsWith(s))) return null;

//   let cleaned = text
//     .replace(/^my\s+child(?:'s)?\s+(?:full\s+name|name)\s+is\s+/i, "")
//     .replace(/^my\s+child\s+is\s+/i, "")
//     .replace(/^name\s+is\s+/i, "")
//     .trim();

//   cleaned = cleaned.replace(/[^a-zA-Z\s'-]/g, " ").replace(/\s+/g, " ").trim();
//   if (!cleaned) return null;

//   const words = cleaned.split(" ").filter(Boolean);
//   if (words.length === 0) return null;

//   const name = words
//     .slice(0, 4)
//     .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
//     .join(" ");

//   return name;
// }
function extractChildName(rawText) {
  if (!rawText) return null;

  const text = String(rawText).trim();

  // Remove unwanted characters
  const cleaned = text
    .replace(/[^a-zA-Z\s'-]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const words = cleaned.split(" ").filter(Boolean);

  // Must be at least 2 words (first + last name)
  if (words.length < 2) return null;

  // Capitalize properly
  return words
    .slice(0, 4)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

// ---------------------
// FAQ + LLM
// ---------------------
const FAQS = [
  {
    keywords: ["fees", "tuition", "school fees", "how much"],
    answer: "School fees depend on the class. Please tell me your child’s class (e.g., Nursery 2, Primary 3).",
  },
  {
    keywords: ["address", "location", "where", "located"],
    answer: "The school address will be shared after admission begins. Please tell me your child's full name to continue.",
  },
  { keywords: ["uniform"], answer: "Yes, the school uses uniform. Details will be shared after admission begins." },
  { keywords: ["resumption", "resume", "resumption date"], answer: "Resumption date varies by term. Admin will confirm after admission begins." },
];

function matchFaq(text) {
  const t = String(text || "").toLowerCase();
  return FAQS.find((f) => f.keywords.some((k) => t.includes(k)));
}

async function llmFallbackAnswer({ school, question, conversation }) {
  // feature flag
  if (process.env.LLM_FALLBACK_ENABLED !== "true") {
    return "I’m not sure—please contact the school admin.";
  }

  // don't crash if not configured
  if (!openai) {
    return "I’m not sure—please contact the school admin.";
  }

  const model = process.env.OPENAI_MODEL || "gpt-5-mini";

  const instructions =
    "You are a school admissions assistant for a Nigerian school. " +
    "Answer ONLY using SCHOOL INFO. " +
    "If the answer is not in the info, say: 'I’m not sure—please contact the school admin.' " +
    "Be short (1-4 lines).";

  const schoolInfo = [
    `School name: ${school?.name || ""}`,
    `Address: ${school?.address || ""}`,
    `Map: ${school?.mapsLink || ""}`,
  ].join("\n");

  const currentState = [
    `Current admissionStep: ${conversation?.admissionStep || ""}`,
    `Child name: ${conversation?.childName || ""}`,
    `Child age: ${conversation?.childAge || ""}`,
    `Desired class: ${conversation?.desiredClass || ""}`,
    `Invoice status: ${conversation?.invoiceStatus || ""}`,
  ].join("\n");

  try {
    const resp = await openai.responses.create({
      model,
      instructions,
      input:
        `SCHOOL INFO:\n${schoolInfo}\n\n` +
        `CURRENT STATE:\n${currentState}\n\n` +
        `PARENT MESSAGE:\n${question}\n\n` +
        `If the message is not a question, reply politely and guide them back to the next required step.`,
    });

    return (resp.output_text || "").trim() || "I’m not sure—please contact the school admin.";
  } catch (e) {
    console.log("❌ LLM error:", e?.message || e);
    return "I’m not sure—please contact the school admin.";
  }
}
// ---------------------
// WhatsApp Cloud send helper
// ---------------------
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

// ---------------------
// Core inbound processor (shared by /webhooks/inbound and Meta /webhook)
// ---------------------
async function processInboundMessage({ channel, from, schoolId, text, timestamp }) {
  const normalizedFrom = normalizePhone(from);

  // Validate
  if (!channel || !from || !schoolId || !text) {
    return "Missing required fields.";
  }

  // Load school
  const schoolRecord = await School.findByPk(schoolId);
  if (!schoolRecord) return "School not found.";

  // Parent + conversation
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

  // Save inbound message
  await Message.create({
    conversationId: conversation.id,
    direction: "inbound",
    from: normalizedFrom,
    text,
    providerTimestamp: timestamp ? new Date(timestamp) : null,
  });

  conversation.lastMessageAt = new Date();
  await conversation.save();

  const cleanText = text.trim().toLowerCase();

  // ---------------------
  // Global intents (greetings)
  // ---------------------
  const greetingWords = ["hi","hello","hey","hiya","helloooo","good morning","good afternoon","good evening"];
  if (greetingWords.includes(cleanText)) {
    let contextInfo = "";
    if (conversation.childName) {
      contextInfo += `Child: ${conversation.childName}\n`;
    }

    const reply = `Hi 👋\n\nWe’re continuing your admission.\n\n${contextInfo}${continuePromptFor(conversation)}`;

    await Message.create({
      conversationId: conversation.id,
      direction: "outbound",
      from: "agent",
      text: reply,
      providerTimestamp: null,
    });

    return reply;
  }

  // ---------------------
  // FAQ check
  // ---------------------
  const faqAnswer = matchFaq(text);
  if (faqAnswer) {
    const reply = faqAnswer;

    await Message.create({
      conversationId: conversation.id,
      direction: "outbound",
      from: "agent",
      text: reply,
      providerTimestamp: null,
    });

    return reply;
  }

  // ---------------------
  // LLM fallback for off-flow messages
  // ---------------------
  const expectedStep = conversation?.admissionStep || "ASK_CHILD_NAME"; // fallback default

  const messageLooksLikeAge = /^\d{1,2}$/.test(cleanText);
  const messageLooksLikeClass = /nursery|primary/i.test(cleanText);
  const messageLooksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanText);

  const offFlow =
    (expectedStep === "ASK_CHILD_AGE" && !messageLooksLikeAge) ||
    (expectedStep === "ASK_DESIRED_CLASS" && !messageLooksLikeClass) ||
    (expectedStep === "EXPECT_EMAIL_OR_SKIP" && !(messageLooksLikeEmail || cleanText === "skip"));

  if (offFlow) {
    const llmText = await llmFallbackAnswer({
      school: schoolRecord,
      question: text,
      conversation,
    });

    const reply = `${llmText}\n\n${continuePromptFor(conversation)}`;

    await Message.create({
      conversationId: conversation.id,
      direction: "outbound",
      from: "agent",
      text: reply,
      providerTimestamp: null,
    });

    return reply;
  }

  // ---------------------
// POST-PAYMENT (COMPLETED)
// ---------------------
if (conversation.status === "completed" || conversation.invoiceStatus === "paid") {
  const cleanCompleted = text.trim().toLowerCase();

  let replyText = "";
  if (cleanCompleted === "timetable") {
    replyText =
      "✅ Timetable support.\n" +
      "Please tell me your preferred days and time (e.g., Mon/Wed 4pm).";
  } else if (cleanCompleted === "support") {
    replyText = "✅ Support.\nPlease describe the issue and we’ll respond shortly.";
  } else {
    replyText =
      "✅ You’re enrolled.\nReply:\n- TIMETABLE (class schedule)\n- SUPPORT (help)";
  }

  await Message.create({
    conversationId: conversation.id,
    direction: "outbound",
    from: "agent",
    text: replyText,
    providerTimestamp: null,
  });

  return replyText;
}

  // ---------------------
  // Normal admission flow (child name, age, class, etc.)
  // ---------------------
  const reply = continuePromptFor(conversation); // your normal flow prompt

  await Message.create({
    conversationId: conversation.id,
    direction: "outbound",
    from: "agent",
    text: reply,
    providerTimestamp: null,
  });

  return reply;
}

 
// Health (single source of truth)
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    llmFallbackEnabled: process.env.LLM_FALLBACK_ENABLED === "true",
    llmTestMode: process.env.LLM_TEST_MODE === "true",
    invoiceSendEnabled: process.env.INVOICE_SEND_ENABLED === "true",
  });
});

app.get("/privacy", (req, res) => {
  res.send(`
    <h1>Privacy Policy</h1>
    <p>This application collects user messages for the purpose of school admission automation.</p>
    <p>No personal data is shared with third parties.</p>
    <p>Contact: skilledskooltutors@gmail.com</p>
  `);
});
app.post("/admin/add-number", async (req, res) => {
  try {
    const { phoneNumber, telegramId, schoolId } = req.body;

    if (!schoolId) {
      return res.status(400).json({ success: false, message: "schoolId is required" });
    }

    const record = await WhatsAppNumber.create({
      phoneNumber: phoneNumber || null,
      telegramId: telegramId || null,
      schoolId,
    });

    res.json({ success: true, record });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Meta WhatsApp webhook verify
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

// Meta WhatsApp webhook receive + reply
app.post("/webhook", async (req, res) => {
  try {
    console.log("🔥 WEBHOOK HIT");
    // acknowledge immediately
    res.sendStatus(200);

    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const message = value?.messages?.[0];
    const from = message?.from; // "234813..."
    const text = message?.text?.body;

    if (!from || !text) return;

    console.log("✅ INCOMING TEXT:", text, "FROM:", from);

    // Normalize incoming number
    const normalizedFrom = `+${from}`;

    // Look up the school for this number
    const numberRecord = await WhatsAppNumber.findOne({
      where: { phoneNumber: normalizedFrom },
    });

    if (!numberRecord) {
      console.log("❌ Incoming number not recognized:", normalizedFrom);
      return; // or send a polite message back
    }

const schoolId = numberRecord.schoolId;

   const replyText = await processInboundMessage({
  channel: "whatsapp",
  from: normalizedFrom, // from Step 2
  schoolId,             // now dynamic
  text,
  timestamp: new Date().toISOString(),
});

    await sendWhatsAppText(from, replyText);
  } catch (err) {
    console.error("❌ /webhook error:", err);
  }
});

// Inbound (internal/testing endpoint)
const inboundWebhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
});

app.post("/webhooks/inbound", inboundWebhookLimiter, async (req, res) => {
  try {
    const reply = await processInboundMessage(req.body);
    return res.json({ success: true, stored: true, reply });
  } catch (error) {
    console.error("ERROR DETAILS:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Admin routes you already had (kept minimal; add more as needed)
app.get("/admin/conversations/:schoolId", requireAdminKey, async (req, res) => {
  try {
    const { schoolId } = req.params;

    const conversations = await Conversation.findAll({
      where: { schoolId },
      order: [["updatedAt", "DESC"]],
      include: [{ model: Parent, attributes: ["phone"] }],
    });

    return res.json({ success: true, count: conversations.length, conversations });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});
// ---------------------
// Admin list pending payments
// ---------------------
app.get("/admin/payments/pending", requireAdminKey, async (req, res) => {
  try {

    const payments = await Payment.findAll({
      where: { status: "verification_pending" },
      order: [["createdAt", "DESC"]]
    });

    return res.json({
      success: true,
      count: payments.length,
      payments
    });

  } catch (error) {
    console.error("Fetch pending payments error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch pending payments"
    });
  }
});
// ---------------------
// Admin approve payment
// ---------------------
app.post("/admin/payments/:paymentId/approve", requireAdminKey, async (req, res) => {
  try {

    const { paymentId } = req.params;

    const payment = await Payment.findByPk(paymentId);

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: "Payment not found"
      });
    }

    payment.status = "paid";

    await payment.save();

    return res.json({
      success: true,
      message: "Payment approved",
      payment
    });

  } catch (error) {
    console.error("Approve payment error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to approve payment"
    });
  }
});
// ---------------------
// Auto-approve payment (TEST MODE - no Paystack yet)
// ---------------------
app.post("/payments/:paymentId/auto-approve", async (req, res) => {
  try {

    const { paymentId } = req.params;

    // Find the payment
    const payment = await Payment.findByPk(paymentId);

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: "Payment not found"
      });
    }

    // For now we skip Paystack verification
    // and directly mark the payment as paid

    payment.status = "paid";

    await payment.save();

    return res.json({
      success: true,
      message: "Payment automatically approved (TEST MODE)",
      payment
    });

  } catch (error) {

    console.error("Auto approve error:", error);

    return res.status(500).json({
      success: false,
      message: "Auto approval failed"
    });

  }
});

app.get("/admin/conversation/:conversationId/messages", requireAdminKey, async (req, res) => {
  try {
    const { conversationId } = req.params;

    const conversation = await Conversation.findByPk(conversationId, {
      include: [{ model: Parent, attributes: ["phone"] }, { model: Message }],
    });

    if (!conversation) {
      return res.status(404).json({ success: false, message: "Conversation not found" });
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
    return res.status(500).json({ success: false, error: error.message });
  }
});
// Reset conversation
app.post("/admin/conversation/:conversationId/reset", requireAdminKey, async (req, res) => {
  try {
    const { conversationId } = req.params;

    const conversation = await Conversation.findByPk(conversationId);

    if (!conversation) {
      return res.status(404).json({ success: false, message: "Conversation not found" });
    }

    conversation.admissionStep = null;
    conversation.childName = null;
    conversation.childAge = null;
    conversation.desiredClass = null;
    conversation.feeAmount = null;
    conversation.feeCurrency = null;
    conversation.awaitingInvoiceConsent = false;
    conversation.awaitingInvoiceDetails = false;
    conversation.invoiceStatus = "none";

    conversation.status = "open";
    conversation.lastMessageAt = null;

    await conversation.save();

    return res.json({
      success: true,
      message: "Conversation reset successfully",
      conversationId: conversation.id
    });

  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------
// Create Student API
// ---------------------
app.post("/students", async (req, res) => {
  try {
    const { name, className, schoolId, parentId } = req.body;

    if (!name || !className || !schoolId || !parentId) {
      return res.status(400).json({
        success: false,
        message: "name, className, schoolId and parentId are required",
      });
    }

    const student = await Student.create({
      name,
      className,
      schoolId,
      parentId,
    });

    return res.json({
      success: true,
      student,
    });
  } catch (error) {
    console.error("Create student error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to create student",
    });
  }
});

// Global error handler
app.use((err, req, res, next) => {
  console.error("UNHANDLED ERROR:", err);
  res.status(500).json({ success: false, message: "Something went wrong" });
});
// ---------------------
// Telegram setup
// ---------------------
const { Telegraf } = require("telegraf");

if (process.env.TELEGRAM_BOT_TOKEN) {
  const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

  console.log("✅ Telegram bot initialized");

  // Incoming message handler
  bot.on("text", async (ctx) => {
    try {
      const telegramId = ctx.from.id.toString();
      const text = ctx.message.text;

      console.log("✅ Telegram message:", text, "FROM:", telegramId);

      // Here we treat Telegram ID as "from"
      // Look up the school for this Telegram ID
      const numberRecord = await WhatsAppNumber.findOne({
        where: { telegramId }, // add telegramId column to WhatsAppNumber table
      });

      if (!numberRecord) {
        console.log("❌ Telegram user not recognized:", telegramId);
        return ctx.reply(
          "Hello! Your Telegram account is not registered with any school. Please contact admin."
        );
      }

      const schoolId = numberRecord.schoolId;

      const replyText = await processInboundMessage({
        channel: "telegram",
        from: telegramId,
        schoolId,
        text,
        timestamp: new Date().toISOString(),
      });

      await ctx.reply(replyText);
    } catch (err) {
      console.error("❌ Telegram handler error:", err);
    }
  });

  bot.launch();
  console.log("✅ Telegram bot running...");
} else {
  console.log("⚠️ TELEGRAM_BOT_TOKEN not set. Telegram bot disabled.");
}

// ---------------------
// Start server (listen immediately)
// ---------------------
const PORT = process.env.PORT || 5000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server listening on port ${PORT}`);
});

// DB init in background (won't block Render port scan)
(async function initDb() {
  try {
    await sequelize.authenticate();
    console.log("✅ DB connected to:", process.env.DB_NAME);
    await sequelize.sync({ alter: true });
    console.log("✅ Tables synced");
    // startInstallmentReminder(PaymentInstallment, Parent, Student, sendWhatsAppText);
    console.log("✅ Installment reminder service started");
  } catch (err) {
    console.error("❌ DB init error:", err.message);
  }
})();




