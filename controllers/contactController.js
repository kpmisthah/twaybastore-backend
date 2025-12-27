// controllers/contactController.js
import { sendContactMail } from "../utils/mailer.js";

export const sendContact = async (req, res) => {
  try {
    const { subject, message, email } = req.body || {};

    if (!subject || !message) {
      return res.status(400).json({ message: "Subject and message are required." });
    }

    // If logged in → use JWT user email
    const userEmail = req.user?.email || email;

    await sendContactMail({
      inbox: process.env.SUPPORT_INBOX, // where your team receives messages
      userEmail,
      subject,
      message,
    });

    return res.json({ message: "Message sent successfully." });
  } catch (err) {
    console.error("❌ Contact send error:", err);
    return res.status(500).json({ message: "Failed to send message." });
  }
};
