// telegramBot.js
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const token = '8767444790:AAGz8ea5GskPGA9k5zECbND0Anz9DdwGlwo';
const bot = new TelegramBot(token, { polling: true });

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  console.log('Received message:', text);

  try {
    const response = await axios.post('http://localhost:5000/webhooks/inbound', {
      channel: "telegram",
      from: String(chatId),
      schoolId: 1,
      text: text
    });

    const reply = response.data.reply;

    await bot.sendMessage(chatId, reply);

  } catch (error) {
    // console.error("Error:", error.message);
    console.error("FULL ERROR:", error.response?.data || error.message);
    await bot.sendMessage(chatId, "Something went wrong.");
  }
});

console.log('Telegram bot is running...');