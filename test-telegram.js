import "./config/env.js";
import { sendTelegramMessage, escapeHTML } from "./utils/telegram.js";

async function test() {
    console.log("Starting Telegram verification test...");
    console.log("TG_BOT_TOKEN:", process.env.TG_BOT_TOKEN ? "Present" : "Missing");
    console.log("TG_CHAT_IDS:", process.env.TG_CHAT_IDS);

    try {
        console.log("1. Sending safe message...");
        await sendTelegramMessage("🧪 <b>Verification Test</b>\nThis is a safe test message.");

        console.log("2. Sending message with special character & (escaped)...");
        await sendTelegramMessage(`🛒 <b>New Order</b>\nCustomer: ${escapeHTML("John & Doe")}`);

        console.log("3. Sending message with special character < and > (escaped)...");
        await sendTelegramMessage(`🛒 <b>New Order</b>\nProduct: ${escapeHTML("Smartphone <Pro Max>")}`);

        console.log("Verification messages sent. Check your Telegram!");
    } catch (error) {
        console.error("Verification failed:", error);
    }
}

test();
