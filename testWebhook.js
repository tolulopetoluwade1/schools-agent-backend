const axios = require("axios");

async function testWebhook() {
  const payload = {
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  from: "2349134147066", // your number in DB
                  text: { body: "Hi" }
                }
              ]
            }
          }
        ]
      }
    ]
  };

  try {
    const res = await axios.post("http://localhost:5000/webhook", payload);
    console.log("✅ Test webhook triggered:", res.status);
  } catch (err) {
    console.error("❌ Test webhook error:", err.message);
  }
}

testWebhook();