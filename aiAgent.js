// aiAgent.js

const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/**
 * AI AGENT DECISION FUNCTION
 * This is the "brain"
 */
async function aiAgentDecision({ message, schoolContext }) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini", // fast + cheap
      messages: [
        {
          role: "system",
          content: `
You are an AI agent for a school management system.

Your job:
- Understand user intent
- Return ONLY valid JSON
- Do NOT explain anything

Available intents:
1. get_owing_students → when asking who owes fees
2. get_student_owing → when asking about a specific student OR using pronouns (he/she)
3. get_school_info → school details
4. unknown → if unclear
5. record_payment → when user says a student has paid
6. get_total_outstanding → when user asks total fees owed, total debt, total outstanding


Rules:
- If a name is mentioned → use get_student_owing
- If user says "he", "she", "the student" → use get_student_owing
- studentName is OPTIONAL (may be empty for pronouns)
- Never return text outside JSON

Examples:

User: "Who is owing fees?"
{
  "intent": "get_owing_students",
  "parameters": {}
}

User: "How much is John Doe owing?"
{
  "intent": "get_student_owing",
  "parameters": {
    "studentName": "John Doe"
  }
}

User: "How much is he owing?"
{
  "intent": "get_student_owing",
  "parameters": {}
}

User: "What is the school address?"
{
  "intent": "get_school_info",
  "parameters": {}
}

User: "John Doe has paid"
{
  "intent": "record_payment",
  "parameters": {
    "studentName": "John Doe"
  }
}

User: "Mark Mary Jane as paid"
{
  "intent": "record_payment",
  "parameters": {
    "studentName": "Mary Jane"
  }
}
  User: "John Doe paid 20000"
{
  "intent": "record_payment",
  "parameters": {
    "studentName": "John Doe",
    "amount": 20000
  }
    User: "How much is owed in total?"
{
  "intent": "get_total_outstanding",
  "parameters": {}
}
}

School Context:
${schoolContext || "No context"}
`
        },
        {
          role: "user",
          content: message
        }
      ],
      temperature: 0
    });

    const aiText = response.choices[0].message.content;

    // Try parsing JSON
    let parsed;
    try {
      parsed = JSON.parse(aiText);
    } catch (err) {
      parsed = {
        intent: "unknown",
        parameters: {}
      };
    }

    return parsed;

  } catch (error) {
    console.error("AI Agent Error:", error);

    return {
      intent: "unknown",
      parameters: {}
    };
  }
}

module.exports = aiAgentDecision;