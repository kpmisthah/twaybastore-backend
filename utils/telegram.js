import axios from "axios";

export const sendTelegramMessage = async (text) => {
  try {
    const chatIds = process.env.TG_CHAT_IDS.split(",");

    for (const chatId of chatIds) {
      await axios.post(
        `https://api.telegram.org/bot${process.env.TG_BOT_TOKEN}/sendMessage`,
        {
          chat_id: chatId.trim(),
          text,
          parse_mode: "HTML",
        }
      );
    }
  } catch (err) {
    console.error("Telegram Bot Error:", err.response?.data || err.message);
  }
};
