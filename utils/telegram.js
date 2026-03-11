
/**
 * Safely escape characters for Telegram's HTML parse mode
 * @param {string} text 
 * @returns {string}
 */
export const escapeHTML = (text) => {
  if (typeof text !== "string") return text;
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
};

/**
 * Send a notification message to configured Telegram chats
 * @param {string} text - The message to send (HTML supported)
 */
export const sendTelegramMessage = async (text) => {
  try {
    const botToken = process.env.TG_BOT_TOKEN;
    const chatIdsRaw = process.env.TG_CHAT_IDS;

    if (!botToken || !chatIdsRaw) {
      console.warn("⚠️  Telegram configuration missing (TG_BOT_TOKEN or TG_CHAT_IDS)");
      return;
    }

    const chatIds = chatIdsRaw.split(",").map(id => id.trim()).filter(Boolean);

    // We don't escape the WHOLE text because it contains intended <b> tags etc.
    // However, the caller should ensure dynamic data is escaped.
    // To make it easier, we will just try to send and catch errors.

    for (const chatId of chatIds) {
      try {
        const response = await fetch(
          `https://api.telegram.org/bot${botToken}/sendMessage`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              chat_id: chatId,
              text,
              parse_mode: "HTML",
            }),
          }
        );

        if (!response.ok) {
          const errorData = await response.json();
          console.error(`❌ Telegram API Error (Chat: ${chatId}):`, errorData);

          // If HTML tags are the problem, try to send as plain text as a fallback
          if (errorData.description?.includes("can't parse entities")) {
            console.log("Retrying as plain text...");
            await fetch(
              `https://api.telegram.org/bot${botToken}/sendMessage`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  chat_id: chatId,
                  text: text.replace(/<[^>]*>/g, ""), // Strip tags
                }),
              }
            );
          }
        }
      } catch (chatErr) {
        console.error(`❌ Network error sending to Telegram (Chat: ${chatId}):`, chatErr);
      }
    }
  } catch (err) {
    console.error("❌ Telegram Utility Error:", err.message);
  }
};
