// =====================
// server.js (Telegram-ready, Chunk 1)
// =====================
if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}
console.log("DB URL:", process.env.DATABASE_URL);
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
const aiAgentDecision = require("./aiAgent");

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
  dialectOptions: {
    ssl: {
      require: true,
      rejectUnauthorized: false,
    },
  },
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
const schoolRoutes = require("./routes/schoolRoutes")(School);
app.use("/api/schools", schoolRoutes);
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
const studentRoutes = require("./routes/studentRoutes")(Student);
app.use("/api/students", studentRoutes);

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
    // 1️⃣ WHO IS OWING FEES
    // =========================
    

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
  (q.includes("school fee") ||
   q.includes("tuition") ||
   q.includes("how much"))
  &&
  !q.includes("owe") &&
  !q.includes("owing") &&
  !q.includes("debt") &&
  !q.includes("not paid")
  ) 
    {
      try {
        const data = JSON.parse(school.aiKnowledge);

        const nursery = data.fees?.nursery;
        const primary = data.fees?.primary;

        return `Tuition is ₦${nursery} for Nursery and ₦${primary} for Primary`;
      } catch (e) {
        return "School fee info not available.";
      }
    }

    // =========================
    // 4️⃣ Owing Count (Improved)
    // =========================
    if (
  q.includes("owing") ||
  q.includes("debt") ||
  q.includes("owe") ||
  q.includes("not paid") ||
  q.includes("outstanding") ||
  q.includes("unpaid")
) {
  try {
    const studentsOwing = await PaymentInstallment.findAll({
      where: { schoolId: school.id, status: "pending" },
      include: [{ model: Student, attributes: ["fullName"] }],
    });

    const summary = {};

    studentsOwing.forEach(s => {
      const name = s.Student?.fullName || "Unknown Student";
      const amount = s.amountDue || 0;

      if (!summary[name]) summary[name] = 0;
      summary[name] += amount;
    });

    const studentList = Object.entries(summary)
      .map(([name, total]) => `• ${name}: ₦${total}`)
      .join("\n");

    const count = Object.keys(summary).length;

    // 🎯 CONTROL RESPONSE BASED ON QUESTION
      if (
        q.includes("how many") ||
        q.includes("number") ||
        q.includes("count")
      ) 
      {
      return `Currently, ${count} students have outstanding fees.`;
    }

    if (
      q.includes("who") ||
      q.includes("which") ||
      q.includes("list") ||
      q.includes("details") ||
      q.includes("show") ||
      q.includes("give me") ||
      q.includes("debtors")
      ) 
    {
      return studentList || "No students are currently owing fees.";
    }

    // DEFAULT (SMART)
    return `Currently, ${count} students have outstanding fees:\n${studentList}`;

  } catch (e) {
    return "Owing data not available.";
  }
}

    // =========================
    // 5️⃣ LLM FALLBACK
    // =========================
  if (process.env.LLM_FALLBACK_ENABLED === "true" && openai) {

  // 🔥 GET REAL DATA
  const studentsOwing = await PaymentInstallment.findAll({
    where: { schoolId: school.id, status: "pending" },
    include: [{ model: Student, attributes: ["fullName"] }],
  });

  const owingSummary = studentsOwing.length
    ? studentsOwing.map(s => {
        const name = s.Student?.fullName || "Unknown Student";
        const amount = s.amountDue || 0;
        return `• ${name}: ₦${amount}`;
      }).join("\n")
    : "No students are currently owing fees.";

  // 🔥 INSTRUCTIONS
  const instructions = `
You are a smart school assistant for a Nigerian school.

Rules:
- Use ONLY the data provided
- Be short (max 4 lines)
- Be friendly and natural
- Never say "I don’t have data" if data is given
- Do not hallucinate

Style:
- Speak like a helpful school admin
- Keep it simple and clear
`;

  // 🔥 CONTEXT (MEMORY)
  const context = `
School:
Name: ${school.name}
Address: ${school.address}

Knowledge:
${school.aiKnowledge}

Students Owing:
${owingSummary}

Conversation:
Step: ${conversation?.admissionStep || ""}
Child: ${conversation?.childName || ""}
Class: ${conversation?.desiredClass || ""}
Invoice: ${conversation?.invoiceStatus || ""}
`;

  const resp = await openai.responses.create({
    model: process.env.OPENAI_MODEL || "gpt-5-mini",
    instructions,
    input: `
${context}

User: ${question}

Respond naturally.
    `,
  });

  return resp.output_text || "I’m not sure—please contact the school admin.";
}
// =========================
// FINAL FALLBACK
// =========================
return "I’m not sure—please contact the school admin.";

} catch (e) {
  console.log("❌ LLM error:", e.message);
  return "I’m not sure—please contact the school admin.";
}
}
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
    text: String(text),
    providerTimestamp: timestamp ? new Date(timestamp) : null,
  });

  conversation.lastMessageAt = new Date();
  await conversation.save();

  const cleanText = text.trim().toLowerCase();
  // =========================
// HANDLE IMAGE RECEIPT
// =========================
if (text.startsWith("[IMAGE RECEIPT]")) {

  console.log("📸 RECEIPT DETECTED");

  // 🔥 Update conversation
  conversation.awaitingInvoiceDetails = false;
  conversation.invoiceStatus = "pending_verification";

  await conversation.save();

  const reply = "✅ Payment receipt received. Admin will verify shortly.";

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
      text: String(reply),
      providerTimestamp: null,
    });

    return reply;
  }

  // ---------------------
  // FAQ check
  // ---------------------
  const isOwingQuery =
  text.toLowerCase().includes("owing") ||
  text.toLowerCase().includes("owe") ||
  text.toLowerCase().includes("debt") ||
  text.toLowerCase().includes("unpaid") ||
  text.toLowerCase().includes("paid") ||
  text.toLowerCase().includes("payment") ||
  text.toLowerCase().includes("has paid") ||
  text.toLowerCase().includes("mark as paid");


  const faqAnswer = matchFaq(text);

if (faqAnswer && !isOwingQuery) {
    const reply = faqAnswer;

    await Message.create({
      conversationId: conversation.id,
      direction: "outbound",
      from: "agent",
      text: String(reply),
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

if (offFlow || isOwingQuery) {
  try {
    const decision = await aiAgentDecision({
      message: text,
      schoolContext: schoolRecord.aiKnowledge
    });

    console.log("🧠 AI DECISION:", decision);
    // ✅ ADD THIS LINE HERE
    console.log("🔥 BEFORE TOOL CALL");
   // ✅ ONLY SAVE MEMORY FOR VALID INTENTS
if (decision.intent !== "unknown") {

  conversation.lastIntent = decision.intent;

  const newName = decision.parameters?.studentName;

  if (newName && newName.trim() !== "") {
    conversation.lastStudentName = newName;
  }

  await conversation.save();
  await conversation.reload();

  console.log("🧠 SAVED MEMORY:", conversation.lastStudentName);

} else {
  console.log("⚠️ SKIPPING MEMORY UPDATE (UNKNOWN INTENT)");
}

  console.log("🧠 SAVED MEMORY:", conversation.lastStudentName);

  const { getOwingStudents, getSchoolInfo, getTotalOutstanding } = require("./services/tools");

    let toolResult = null;
    let replyText = "I couldn’t find anything.";

    // =========================
    // GET ALL OWING STUDENTS
    // =========================
    if (decision.intent === "get_owing_students") {
      toolResult = await getOwingStudents({
        PaymentInstallment,
        Student,
        schoolId: schoolRecord.id
      });

      // ✅ ADD THIS LINE HERE
    console.log("🔥 AFTER TOOL CALL");

      if (toolResult?.data?.length) {
       replyText = toolResult.data
  .map(item => {
    const rawName = item.name || item.Student?.fullName || "Unknown";

    // Fix name formatting
    const name = rawName
      .toLowerCase()
      .split(" ")
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");

    const amount = item.amount || item.amountDue || 0;

    // Format money properly
    const formattedAmount = Number(amount).toLocaleString();

    const code = item.studentCode || "N/A";
    return `• ${name} (${code}): ₦${formattedAmount}`;
     })
      .join("\n");
      } else {
        replyText = "No students are currently owing fees.";
      }
    }

    // =========================
    // GET SINGLE STUDENT OWING
    // =========================
    else if (decision.intent === "get_student_owing") {
      const name =
        decision.parameters?.studentName ||
        conversation.lastStudentName;

      if (!name) {
        replyText = "Please tell me the student's name.";
      } else {

        toolResult = await getOwingStudents({
          PaymentInstallment,
          Student,
          schoolId: schoolRecord.id
        });

        const match = toolResult.data.find(item => {
          const studentName =
            item.name ||
            item.Student?.fullName ||
            "";

          return studentName.toLowerCase().includes(name.toLowerCase());
        });

        if (match) {
          const studentName =
            match.name ||
            match.Student?.fullName ||
            "Unknown";

          const amount =
            match.amount ||
            match.amountDue ||
            0;

          replyText = `• ${studentName} is owing ₦${amount}`;
        } else {
          replyText = "Student not found or not owing.";
    }
  }
}

    // =========================
    // SCHOOL INFO
    // =========================
    else if (decision.intent === "get_school_info") {
      toolResult = await getSchoolInfo({
        school: schoolRecord
      });

      replyText = `${toolResult.data.name}\n${toolResult.data.address}`;
    }

    // ✅ ADD THIS BLOCK RIGHT HERE
    else if (decision.intent === "get_total_outstanding") {

      const result = await getTotalOutstanding({
        PaymentInstallment,
        schoolId: schoolRecord.id
      });

      const formatted = Number(result.data).toLocaleString();

      replyText = `Total outstanding fees: ₦${formatted}`;
    }

    else if (decision.intent === "record_payment") {
  const name = decision.parameters?.studentName;
  const amountPaid = Number(decision.parameters?.amount || 0);

  if (!name) {
    replyText = "Please tell me the student's name.";
  } else if (!amountPaid || amountPaid <= 0) {
    replyText = "Please specify how much was paid.";
  } else {

    const records = await PaymentInstallment.findAll({
      where: { schoolId: schoolRecord.id, status: "pending" },
      include: [{ model: Student }],
      order: [["createdAt", "ASC"]]
    });

    const studentRecords = records.filter(r =>
      (r.Student?.fullName || "")
        .toLowerCase()
        .includes(name.toLowerCase())
    );

    if (studentRecords.length === 0) {
      replyText = "Student not found or no pending payment.";
    } else {

      let remaining = amountPaid;

      for (const record of studentRecords) {
        if (remaining <= 0) break;

        const due = record.amountDue || 0;

        if (remaining >= due) {
          record.status = "paid";
          remaining -= due;
        } else {
          record.amountDue = due - remaining;
          remaining = 0;
        }

        await record.save();
      }

      // ✅ NEW PART (THIS IS THE UPGRADE)
      const remainingRecords = await PaymentInstallment.findAll({
        where: { schoolId: schoolRecord.id, status: "pending" },
        include: [{ model: Student }]
      });

      const studentRemaining = remainingRecords
        .filter(r =>
          (r.Student?.fullName || "")
            .toLowerCase()
            .includes(name.toLowerCase())
        )
        .reduce((sum, r) => sum + (r.amountDue || 0), 0);

      const formattedPaid = Number(amountPaid).toLocaleString();
      const formattedRemaining = Number(studentRemaining).toLocaleString();

      replyText = `✅ Payment recorded

${name} paid ₦${formattedPaid}
Remaining balance: ₦${formattedRemaining}`;
    }
  }
}

    else {
  // 🔥 MEMORY FALLBACK
  if (conversation.lastStudentName) {

    toolResult = await getOwingStudents({
      PaymentInstallment,
      Student,
      schoolId: schoolRecord.id
    });

    const match = toolResult.data.find(item => {
      const studentName =
        item.name ||
        item.Student?.fullName ||
        "";

      return studentName
        .toLowerCase()
        .includes(conversation.lastStudentName.toLowerCase());
    });

    if (match) {
      const studentName =
        match.name ||
        match.Student?.fullName ||
        "Unknown";

      const amount =
        match.amount ||
        match.amountDue ||
        0;

      replyText = `• ${studentName} is owing ₦${amount}`;
    } else {
      replyText = "Student not found or not owing.";
    }

  } else {
    replyText = "I didn’t understand that request.";
  }
}

    const reply = String(replyText);

    await Message.create({
      conversationId: conversation.id,
      direction: "outbound",
      from: "agent",
      text: reply,
      providerTimestamp: null,
    });

    return reply;

  } catch (error) {
    console.error("❌ AI AGENT ERROR:", error);

    const fallbackReply = "Something went wrong. Please try again.";

    await Message.create({
      conversationId: conversation.id,
      direction: "outbound",
      from: "agent",
      text: fallbackReply,
      providerTimestamp: null,
    });

    return fallbackReply;
  }
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
      text: String(replyText),
      providerTimestamp: null,
    });

    return replyText;
  }

  const reply = continuePromptFor(conversation);

  await Message.create({
    conversationId: conversation.id,
    direction: "outbound",
    from: "agent",
    text: String(reply),
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
      console.log("🔥 TELEGRAM ID:", telegramId);
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

      await ctx.reply(
      typeof replyText === "string"
    ? replyText
    : JSON.stringify(replyText, null, 2)
);
    } catch (err) {
      console.error("❌ Telegram handler error:", err);
    }
  });

  telegramBot.on("photo", async (ctx) => {
  try {
    const telegramId = ctx.from.id.toString();
    console.log("📸 PHOTO RECEIVED FROM:", telegramId);

    const photos = ctx.message.photo;
    const fileId = photos[photos.length - 1].file_id; // highest quality

    const fileLink = await ctx.telegram.getFileLink(fileId);

    console.log("📸 FILE LINK:", fileLink.href);

    const numberRecord = await WhatsAppNumber.findOne({
      where: { telegramId },
    });

    if (!numberRecord) {
      return ctx.reply("You are not registered with any school.");
    }

    const schoolId = numberRecord.schoolId;

    // 🔥 Process as message
    const replyText = await processInboundMessage({
      channel: "telegram",
      from: telegramId,
      schoolId,
      text: `[IMAGE RECEIPT]: ${fileLink.href}`,
      timestamp: new Date().toISOString(),
    });

    await ctx.reply("✅ Receipt received. Admin will verify shortly.");

  } catch (err) {
    console.error("❌ PHOTO HANDLER ERROR:", err);
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

// 👇👇👇 PASTE RIGHT HERE 👇👇👇


// ---------------------
// Admin: get conversations by school
// ---------------------
app.get("/admin/conversations/:schoolId", requireAdminKey, async (req, res) => {
  try {
    const { schoolId } = req.params;

    const conversations = await Conversation.findAll({
      where: { schoolId },
      include: [{ model: Parent }],
      order: [["updatedAt", "DESC"]],
    });

    return res.json({
      success: true,
      conversations,
    });

  } catch (error) {
    console.error("Fetch conversations error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------
// Admin: get messages for a conversation
// ---------------------
app.get("/admin/conversation/:id/messages", requireAdminKey, async (req, res) => {
  try {
    const { id } = req.params;

    const messages = await Message.findAll({
      where: { conversationId: id },
      order: [["createdAt", "ASC"]],
    });

    return res.json({
      success: true,
      messages,
    });

  } catch (error) {
    console.error("Fetch messages error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});
// ---------------------
// Admin: reply to parent
// ---------------------
app.post("/admin/conversation/:id/reply", requireAdminKey, async (req, res) => {
  try {
    const { id } = req.params;
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ success: false, message: "Message is required" });
    }

    const conversation = await Conversation.findByPk(id, {
      include: [Parent],
    });

    if (!conversation) {
      return res.status(404).json({ success: false, message: "Conversation not found" });
    }

    const parent = conversation.Parent;

    // ✅ Save message
    const newMessage = await Message.create({
      conversationId: conversation.id,
      direction: "outbound",
      from: "admin",
      text: message,
    });

    // ✅ Find contact record
    const numberRecord = await WhatsAppNumber.findOne({
    where: {
    schoolId: conversation.schoolId,
    telegramId: parent.phone.replace("+", ""), // because you used telegramId as "from"
  },
});
    console.log("📱 NUMBER RECORD:", numberRecord);
    console.log("📱 PARENT PHONE:", parent.phone);

    // ✅ Send via Telegram
    if (numberRecord?.telegramId && telegramBot) {
      await telegramBot.telegram.sendMessage(numberRecord.telegramId, message);
    }

    // ✅ Send via WhatsApp
    if (numberRecord?.phoneNumber) {
      await sendWhatsAppText(numberRecord.phoneNumber, message);
    }

    return res.json({
      success: true,
      message: "Reply sent successfully",
      data: newMessage,
    });

  } catch (error) {
    console.error("Reply error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});



// ---------------------
// Admin: mark invoice as sent
// ---------------------
app.post("/admin/invoice/:id/mark-sent", async (req, res)=> {
  try {
    const { id } = req.params;

    const conversation = await Conversation.findOne({
    where: { id: Number(id) }
});
    console.log("FOUND CONVO:", conversation);

    if (!conversation) {
      return res.status(404).json({ success: false, message: "Conversation not found" });
    }

    conversation.invoiceStatus = "sent";
    await conversation.save();
    await conversation.reload();

    console.log("UPDATED STATUS:", conversation.invoiceStatus);

    return res.json({
      success: true,
      message: "Marked as sent",
    });

  } catch (error) {
    console.error("Mark sent error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------
// Admin: mark invoice as paid
// ---------------------
app.post("/admin/invoice/:id/mark-sent", async (req, res)=> {
  try {
    const { id } = req.params;

    const conversation = await Conversation.findOne({
    where: { id: Number(id) }
});

    if (!conversation) {
      return res.status(404).json({ success: false, message: "Conversation not found" });
    }

    conversation.invoiceStatus = "paid";
    await conversation.save();

    return res.json({
      success: true,
      message: "Marked as paid",
    });

  } catch (error) {
    console.error("Mark paid error:", error);
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
// AI Analytics Route
// ---------------------
app.post("/admin/analytics", requireAdminKey, async (req, res) => {
  try {
    const { question, schoolId } = req.body;

    if (!question || !schoolId) {
      return res.status(400).json({
        error: "question and schoolId are required"
      });
    }

    let intent = "unknown";

    // 🔥 STEP 1: Try LLM (SAFE VERSION)
    if (openai) {
      try {
        const aiResponse = await openai.chat.completions.create({
          model: "gpt-5-mini",
          messages: [
            {
              role: "system",
              content: `
You are a school analytics classifier.

Classify the user question into ONLY one of:
- count_paid
- list_unpaid
- unknown

Return ONLY the label. No explanation.
              `
            },
            {
              role: "user",
              content: question
            }
          ],
          max_completion_tokens: 10
        });

        intent = aiResponse.choices[0].message.content.trim().toLowerCase();
        console.log("🧠 INTENT:", intent);

      } catch (err) {
        console.log("⚠️ LLM failed, fallback used:", err.message);
      }
    }

    // 🔥 STEP 2: FALLBACK (VERY IMPORTANT)
    if (!intent || intent === "unknown") {
      const q = question.toLowerCase();

      if (q.includes("how many") && q.includes("paid")) {
        intent = "count_paid";
      }

      if (q.includes("who") && (q.includes("not paid") || q.includes("owing"))) {
        intent = "list_unpaid";
      }
    }

    // 🔥 STEP 3: HANDLE INTENT

    // COUNT PAID
    if (intent.includes("count_paid")) {
      const count = await Conversation.count({
        where: {
          schoolId,
          invoiceStatus: "paid"
        }
      });

      return res.json({
        answer: `${count} parents have paid`
      });
    }

    // LIST UNPAID
    if (intent.includes("list_unpaid")) {
      const list = await Conversation.findAll({
        where: {
          schoolId,
          invoiceStatus: "sent"
        },
        include: [Parent]
      });

      const names = list.map(c => c.Parent?.phone || "Unknown");

      return res.json({
        answer: names.length
          ? `Unpaid parents: ${names.join(", ")}`
          : "All parents have paid"
      });
    }

    // DEFAULT
    return res.json({
      answer: "I don’t understand that yet."
    });

  } catch (error) {
    console.error("❌ Analytics error:", error);
    return res.status(500).json({
      error: error.message
    });
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

// const axios = require("axios");


const { getOwingStudents } = require("./services/tools");

app.get("/test-tools", async (req, res) => {
  const result = await getOwingStudents({
    PaymentInstallment,
    Student,
    schoolId: 1 // use real schoolId in your DB
  });

  res.json(result);
});

app.get("/test-ai", async (req, res) => {
  try {
    const result = await aiAgentDecision({
      message: "How much is John Doe owing?",
      schoolContext: "This is a private secondary school in Lagos"
    });

    res.json(result);
  } catch (error) {
    console.error("❌ AI AGENT TEST ERROR:", error.message);
    res.status(500).json({ error: "AI agent failed" });
  }
});
// ---------------------
// Start server
// ---------------------
const PORT = process.env.PORT || 5000;

sequelize.sync()
  .then(() => {
    console.log("✅ Database synced");
  })
  .catch((err) => {
    console.error("❌ DB sync error:", err);
  });

  app.get("/fix-telegram", async (req, res) => {
  try {
    const record = await WhatsAppNumber.create({
      schoolId: 1, // use your real schoolId if not 1
      telegramId: "1079483102",
      phoneNumber: "+2348137137336"
    });

    res.json({ success: true, record });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// app.listen(PORT, () => {
//   console.log(`🚀 Server is running on http://localhost:${PORT}`);
// });
app.listen(PORT, async () => {
  console.log(`🚀 Server is running on http://localhost:${PORT}`);

  // 🔥 TEMP DEBUG START
  const [result] = await sequelize.query(`
    SELECT column_name 
    FROM information_schema.columns 
    WHERE table_name = 'students'
  `);

  console.log("🔥 DB COLUMNS:", result);
  // 🔥 TEMP DEBUG END
});

