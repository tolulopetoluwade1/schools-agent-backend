// services/whatsapp.js
async function sendWhatsAppText(phone, message) {
  // For now, just log the message
  console.log(`WhatsApp message to ${phone}: ${message}`);
}

module.exports = { sendWhatsAppText };