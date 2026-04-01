const axios = require("axios");

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

async function sendMessage(to, message) {
  try {
    const response = await axios.post(
      `https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: to,
        text: { body: message }
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${WHATSAPP_TOKEN}`
        }
      }
    );

    console.log("✅ Message sent:", response.data);
  } catch (error) {
    console.error("❌ Error:", error.response?.data || error.message);
  }
}

module.exports = { sendMessage };