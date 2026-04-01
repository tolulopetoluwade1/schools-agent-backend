// =====================
// server.js (Telegram-ready, Chunk 1)
// =====================
require("dotenv").config();
console.log("ADMIN KEY:", process.env.ADMIN_API_KEY);
const cors = require("cors");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Sequelize, DataTypes } = require("sequelize");
const OpenAI = require("openai");
const paymentRoutes = require("./routes/paymentRoutes");
const cron = require("node-cron");
const updateAiKnowledge = require("./services/aiKnowledgeUpdater");

// ---------------------
// App init
// ---------------------
const app = express();
app.set("trust proxy", true); // for rate limiting + proxy headers

// Body parsing
app.use(express.json({ limit: "200kb" }));
app.use("/uploads", express.static("uploads"));

// Request logger
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
// OpenAI init
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
const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: "postgres",
  protocol: "postgres",
  logging: false,
});



// ---------------------
// Models
// ---------------------
const WhatsAppNumberModel = require("./models/WhatsAppNumber");
const WhatsAppNumber = WhatsAppNumberModel(sequelize, DataTypes);

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

// Payment Installment routes
const PaymentInstallmentRoutes = require("./routes/paymentInstallmentRoutes")(PaymentInstallment);
app.use("/api/installments", PaymentInstallmentRoutes);

// Payment routes
app.use("/api/payments", paymentRoutes(Payment));

// ---------------------
// Relationships
// ---------------------
School.hasMany(WhatsAppNumber, { foreignKey: "schoolId" });
WhatsAppNumber.belongsTo(School, { foreignKey: "schoolId" });

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

PaymentInstallment.belongsTo(Student, { foreignKey: "studentId" });
Student.hasMany(PaymentInstallment, { foreignKey: "studentId" });

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

function extractChildName(rawText) {
  if (!rawText) return null;

  const text = String(rawText).trim();
  const cleaned = text
    .replace(/[^a-zA-Z\s'-]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const words = cleaned.split(" ").filter(Boolean);

  if (words.length < 2) return null;

  return words
    .slice(0, 4)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}
cron.schedule("0 8 * * *", async () => {
  console.log("🔥 CRON TRIGGERED AT 8 AM");
  await installmentReminderService(PaymentInstallment, Parent, Student, telegramBot);
});
cron.schedule("5 8 * * *", async () => {
  console.log("🧠 Updating AI Knowledge at 8:05 AM...");
  await updateAiKnowledge(School, PaymentInstallment, Student);
});

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
// server.js
async function llmFallbackAnswer({ school, question, conversation }) {
  try {
    const q = question.toLowerCase();

    // =========================
    // 1️⃣ WHO IS OWING FEES (STRICT)
    // =========================
    if (
  q.includes("who is owing") ||
  q.includes("students owing") ||
  q.includes("who owes") ||
  q.includes("owing list") ||
  q.includes("list of students")
) {
  const studentsOwing = await PaymentInstallment.findAll({
    where: { schoolId: school.id, status: "pending" },
    include: [{ model: Student, attributes: ["fullName"] }],
  });

  const summaryMap = {};

  studentsOwing.forEach(s => {
    const name = s.Student?.fullName || "Unknown Student";
    const amount = s.amountDue || 0;

    if (!summaryMap[name]) summaryMap[name] = 0;
    summaryMap[name] += amount;
  });

  const result = Object.entries(summaryMap)
    .map(([name, total]) => `• ${name}: ₦${total}`)
    .join("\n");

  return result || "No students are currently owing fees.";
}

    // =========================
    // 2️⃣ SCHOOL LOCATION
    // =========================
    if (
      q.includes("where") ||
      q.includes("location") ||
      q.includes("address")
    ) {
      return school.address || "School address not available.";
    }

    // =========================
    // 3️⃣ SCHOOL FEES
    // =========================
    if (
  q.includes("school fee") ||
  q.includes("tuition") ||
  q.includes("how much")
) {
  try {
    const data = JSON.parse(school.aiKnowledge);

    const nursery = data.fees?.nursery;
    const primary = data.fees?.primary;

    return `Tuition is ₦${nursery} for Nursery and ₦${primary} for Primary`;
  } catch (e) {
    return "School fee info not available.";
  }
}
if (
  q.includes("how many") &&
  q.includes("owing")
) {
  try {
    const data = JSON.parse(school.aiKnowledge);
    return `${data.stats.studentsOwing} students are currently owing fees`;
  } catch (e) {
    return "Owing data not available.";
  }
}
    // =========================
    // 4️⃣ LLM (ONLY IF AVAILABLE)
    // =========================
    if (process.env.LLM_FALLBACK_ENABLED === "true" && openai) {
      const resp = await openai.responses.create({
        model: process.env.OPENAI_MODEL || "gpt-5-mini",
        input: `
School Info:
${school.aiKnowledge}

Question:
${question}
        `,
      });

      return resp.output_text || "I’m not sure—please contact the school admin.";
    }

    // =========================
    // 5️⃣ FINAL FALLBACK
    // =========================
    return "I’m not sure—please contact the school admin.";

  } catch (e) {
    console.log("❌ LLM error:", e.message);
    return "I’m not sure—please contact the school admin.";
  }
}
// async function llmFallbackAnswer({ school, question, conversation }) {
//   if (process.env.LLM_FALLBACK_ENABLED !== "true") {
//     return "I’m not sure—please contact the school admin.";
//   }

//   if (!openai) return "I’m not sure—please contact the school admin.";

//   const model = process.env.OPENAI_MODEL || "gpt-5-mini";

//   // 1️⃣ Fetch dynamic info from DB
//   const studentsOwing = await PaymentInstallment.findAll({
//     where: { schoolId: school.id, status: "pending" },
//     include: [{ model: Student, attributes: ["fullName"] }],
//   });

//   const owingSummary = studentsOwing.length
//   ? studentsOwing.map(s => {
//       const name = s.Student?.fullName || "Unknown Student";
//       const amount = s.amountDue || 0;
//       return `• ${name}: ₦${amount}`;
//     }).join("\n")
//   : "No students are currently owing fees.";

//   // 2️⃣ Prepare static + dynamic info
//   const instructions = `
//     You are a school admissions assistant for a Nigerian school.
//     Answer ONLY using the SCHOOL INFO and PAYMENT DATA below.
//     If the answer is not in the info, say: 'I’m not sure—please contact the school admin.'
//     Be short (1-4 lines).
//   `;

//   const schoolInfo = `
//     School Name: ${school?.name || ""}
//     Address: ${school?.address || ""}
//     Map: ${school?.mapsLink || ""}

//     SCHOOL KNOWLEDGE:
//     ${school?.aiKnowledge || "No additional info provided."}

//     PAYMENT DATA (students owing fees):
//     ${owingSummary}
//   `;

//   const currentState = [
//     `Current admissionStep: ${conversation?.admissionStep || ""}`,
//     `Child name: ${conversation?.childName || ""}`,
//     `Child age: ${conversation?.childAge || ""}`,
//     `Desired class: ${conversation?.desiredClass || ""}`,
//     `Invoice status: ${conversation?.invoiceStatus || ""}`,
//   ].join("\n");

//   try {
//     const resp = await openai.responses.create({
//       model,
//       instructions,
//       input: `
// SCHOOL INFO + PAYMENTS:
// ${schoolInfo}

// CURRENT STATE:
// ${currentState}

// PARENT MESSAGE:
// ${question}

// If the message is not a question, reply politely and guide them back to the next required step.
//       `,
//     });

//     return (resp.output_text || "").trim() || "I’m not sure—please contact the school admin.";
//   } catch (e) {
//     console.log("❌ LLM error:", e?.message || e);
//     return "I’m not sure—please contact the school admin.";
//   }
// }
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
    to,
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

  if (!channel || !from || !schoolId || !text) {
    return "Missing required fields.";
  }

  const schoolRecord = await School.findByPk(schoolId);
  if (!schoolRecord) return "School not found.";

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
  const expectedStep = conversation?.admissionStep || "ASK_CHILD_NAME";

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
  // Post-payment or normal flow
  // ---------------------
  if (conversation.status === "completed" || conversation.invoiceStatus === "paid") {
    const cleanCompleted = text.trim().toLowerCase();

    let replyText = "";
    if (cleanCompleted === "timetable") {
      replyText =
        "✅ Timetable support.\nPlease tell me your preferred days and time (e.g., Mon/Wed 4pm).";
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

  const reply = continuePromptFor(conversation);

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
// Telegram setup (SINGLE INSTANCE)
// ---------------------
const { Telegraf } = require("telegraf");

let telegramBot = null;

if (process.env.TELEGRAM_BOT_TOKEN) {
  telegramBot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

  console.log("✅ Telegram bot initialized");

  telegramBot.on("text", async (ctx) => {
    try {
      const telegramId = ctx.from.id.toString();
      const text = ctx.message.text;

      console.log("✅ Telegram message:", text, "FROM:", telegramId);

      const numberRecord = await WhatsAppNumber.findOne({
        where: { telegramId },
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

  telegramBot.launch();
  console.log("✅ Telegram bot running...");
} else {
  console.log("⚠️ TELEGRAM_BOT_TOKEN not set. Telegram bot disabled.");
}

// ---------------------
// Admin reset all conversations (optional bulk reset)
// ---------------------
app.post("/admin/conversations/reset-all", requireAdminKey, async (req, res) => {
  try {
    const { schoolId } = req.body;

    if (!schoolId) {
      return res.status(400).json({ success: false, message: "schoolId is required" });
    }

    const conversations = await Conversation.findAll({ where: { schoolId } });

    for (const conversation of conversations) {
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
    }

    return res.json({
      success: true,
      message: `All conversations for schoolId ${schoolId} reset successfully.`,
      count: conversations.length,
    });
  } catch (error) {
    console.error("Reset all conversations error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------
// Admin: list all students
// ---------------------
app.get("/admin/students/:schoolId", requireAdminKey, async (req, res) => {
  try {
    const { schoolId } = req.params;

    const students = await Student.findAll({
      where: { schoolId },
      include: [{ model: Parent, attributes: ["phone"] }],
      order: [["createdAt", "DESC"]],
    });

    return res.json({ success: true, count: students.length, students });
  } catch (error) {
    console.error("Fetch students error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------
// Admin: search parents by phone
// ---------------------
app.get("/admin/parents/search", requireAdminKey, async (req, res) => {
  try {
    const { q, schoolId } = req.query;

    if (!q || !schoolId) {
      return res.status(400).json({ success: false, message: "Query and schoolId are required" });
    }

    const parents = await Parent.findAll({
      where: {
        schoolId,
        phone: { [Sequelize.Op.iLike]: `%${q}%` },
      },
      include: [{ model: Student }],
    });

    return res.json({ success: true, count: parents.length, parents });
  } catch (error) {
    console.error("Search parents error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------
// Admin: trigger LLM test
// ---------------------
app.post("/admin/llm/test", requireAdminKey, async (req, res) => {
  try {
    const { schoolId, text } = req.body;

    if (!schoolId || !text) {
      return res.status(400).json({ success: false, message: "schoolId and text are required" });
    }

    const schoolRecord = await School.findByPk(schoolId);

    if (!schoolRecord) {
      return res.status(404).json({ success: false, message: "School not found" });
    }

    const fakeConversation = { admissionStep: "ASK_CHILD_NAME", childName: null };

    const answer = await llmFallbackAnswer({
      school: schoolRecord,
      question: text,
      conversation: fakeConversation,
    });

    return res.json({ success: true, input: text, answer });
  } catch (error) {
    console.error("LLM test error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});
// ---------------------
// Admin: update AI knowledge (MANUAL TEST)
// ---------------------
// app.post("/admin/update-ai", requireAdminKey, async (req, res) => {
  app.post("/admin/update-ai", async (req, res) => {
  try {
    await updateAiKnowledge(School, PaymentInstallment, Student);

    return res.json({
      success: true,
      message: "AI knowledge updated successfully",
    });
  } catch (error) {
    console.error("AI update error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});
// ---------------------
// Admin: manually trigger installment reminder (test mode)
// ---------------------
app.post("/admin/installments/remind", requireAdminKey, async (req, res) => {
  try {
    const reminders = await startInstallmentReminder(
      PaymentInstallment,
      Parent,
      Student,
      async (parentPhone, message) => {
        // We send via WhatsApp if available, else Telegram
        const parentRecord = await Parent.findOne({ where: { phone: parentPhone } });
        if (!parentRecord) return;

        const numberRecord = await WhatsAppNumber.findOne({
          where: { schoolId: parentRecord.schoolId, phoneNumber: parentPhone },
        });

        if (numberRecord?.phoneNumber) {
          await sendWhatsAppText(numberRecord.phoneNumber, message);
        } else if (numberRecord?.telegramId) {
          const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
          if (telegramBotToken && telegramBot) {
            await telegramBot.telegram.sendMessage(numberRecord.telegramId, message);
          }
        }
      }
    );

    return res.json({
      success: true,
      message: `Installment reminders triggered for ${reminders.length} parents.`,
      remindersCount: reminders.length,
    });
  } catch (error) {
    console.error("Trigger installment reminder error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});
// ---------------------
// Health endpoint: full status (internal)
// ---------------------
app.get("/health/full", requireAdminKey, async (req, res) => {
  try {
    const dbStatus = await sequelize.authenticate()
      .then(() => "ok")
      .catch(() => "error");

    return res.json({
      status: "ok",
      dbStatus,
      llmFallbackEnabled: process.env.LLM_FALLBACK_ENABLED === "true",
      telegramBot: !!process.env.TELEGRAM_BOT_TOKEN,
      webhookEnabled: true,
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------
// Telegram Admin broadcast (all registered users)
// ---------------------
app.post("/admin/broadcast", requireAdminKey, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ success: false, message: "Message is required" });

    const allNumbers = await WhatsAppNumber.findAll({
      where: { telegramId: { [Sequelize.Op.ne]: null } }
    });

    if (!telegramBot) return res.status(500).json({ success: false, message: "Telegram bot not configured" });

    let successCount = 0;
    let failCount = 0;

    for (const n of allNumbers) {
      try {
        await telegramBot.telegram.sendMessage(n.telegramId, message);
        successCount++;
      } catch (e) {
        console.error("Broadcast fail for:", n.telegramId, e.message);
        failCount++;
      }
    }

    return res.json({
      success: true,
      message: `Broadcast completed: ${successCount} sent, ${failCount} failed.`,
    });
  } catch (error) {
    console.error("Broadcast error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});
// ---------------------
// Graceful shutdown
// ---------------------
process.on("SIGINT", async () => {
  console.log("⚠️ Server shutting down (SIGINT)...");
  await sequelize.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("⚠️ Server shutting down (SIGTERM)...");
  await sequelize.close();
  process.exit(0);
});
// ---------------------
// Testing endpoint for LLM fallback
// ---------------------
app.post("/test/llm", async (req, res) => {
  try {
    const { schoolId, question } = req.body;
    if (!schoolId || !question) {
      return res.status(400).json({ success: false, message: "schoolId and question are required" });
    }

    const school = await School.findByPk(schoolId);
    if (!school) return res.status(404).json({ success: false, message: "School not found" });

    const dummyConversation = { admissionStep: "ASK_CHILD_NAME", childName: "Test Child", childAge: 7, desiredClass: "Nursery 1", invoiceStatus: "pending" };

    const answer = await llmFallbackAnswer({
      school,
      question,
      conversation: dummyConversation,
    });

    return res.json({ success: true, answer });
  } catch (error) {
    console.error("LLM test error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

const axios = require("axios");

app.get("/test-ai", async (req, res) => {
  try {
    const response = await axios.post("http://127.0.0.1:8000/ask", {
      school_name: "Test School",
      knowledge: "We offer nursery and primary education",
      question: "What classes do you offer?"
    });

    res.json(response.data);
  } catch (error) {
    console.error("❌ AI TEST ERROR:", error.message);
    res.status(500).json({ error: "Failed to reach AI service" });
  }
});
// ---------------------
// Start server
// ---------------------
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Server is running on http://localhost:${PORT}`);
});
