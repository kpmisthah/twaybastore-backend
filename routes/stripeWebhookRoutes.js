// routes/stripeWebhookRoutes.js
import express from "express";
import stripe from "../config/stripe.js";
import Order from "../models/Order.js";
import Product from "../models/Product.js";
import User from "../models/User.js";
import { sendOrderMail, sendNewOrderAlert } from "../utils/mailer.js";
import { sendTelegramMessage, escapeHTML } from "../utils/telegram.js";

const router = express.Router();

/**
 * Stripe Webhook Handler
 * IMPORTANT: This must be BEFORE express.json() middleware
 * Stripe requires raw body for signature verification
 */
router.post(
    "/webhook",
    express.raw({ type: "application/json" }),
    async (req, res) => {
        const sig = req.headers["stripe-signature"];
        const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
        console.log(webhookSecret, '=webhooksecret')
        if (!webhookSecret) {
            console.error("⚠️  STRIPE_WEBHOOK_SECRET not configured");
            return res.status(500).send("Webhook secret not configured");
        }

        let event;

        try {
            // Verify webhook signature
            event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
        } catch (err) {
            console.error("❌ Webhook signature verification failed:", err.message);
            return res.status(400).send(`Webhook Error: ${err.message}`);
        }

        // Handle the event
        try {
            switch (event.type) {
                case "payment_intent.succeeded":
                    await handlePaymentSuccess(event.data.object);
                    break;

                case "payment_intent.payment_failed":
                    await handlePaymentFailed(event.data.object);
                    break;

                case "charge.refunded":
                    await handleRefund(event.data.object);
                    break;

                case "charge.dispute.created":
                    await handleDispute(event.data.object);
                    break;

                case "payment_intent.canceled":
                    await handlePaymentCanceled(event.data.object);
                    break;

                default:
                    console.log(`ℹ️  Unhandled event type: ${event.type}`);
            }

            res.json({ received: true });
        } catch (error) {
            console.error(`❌ Error processing webhook ${event.type}:`, error);
            res.status(500).send("Webhook processing failed");
        }
    }
);

/**
 * Handle successful payment
 */
async function handlePaymentSuccess(paymentIntent) {
    console.log("✅ Payment succeeded:", paymentIntent.id);

    try {
        let order = await Order.findOne({
            paymentIntentId: paymentIntent.id,
        }).populate("user");

        if (!order) {
            console.warn(`⚠️  No order found for payment intent: ${paymentIntent.id}. Attempting recovery from metadata...`);

            const { metadata } = paymentIntent;
            if (!metadata || !metadata.items) {
                console.error("❌ Recovery failed: No items found in metadata.");
                return;
            }

            try {
                const userId = metadata.userId !== 'guest' ? metadata.userId : null;
                const itemsParsed = JSON.parse(metadata.items); // [{p, q, c, d}]

                // Fetch full product details for the order
                const items = await Promise.all(itemsParsed.map(async (it) => {
                    const product = await Product.findById(it.p);
                    return {
                        product: it.p,
                        qty: it.q,
                        color: it.c,
                        dimensions: it.d,
                        name: product?.name || "Product",
                        price: product?.price || 0,
                        image: product?.images?.[0] || ""
                    };
                }));

                let shipping, contact;
                if (metadata.guestInfo) {
                    const guestInfo = JSON.parse(metadata.guestInfo);
                    shipping = {
                        name: guestInfo.name,
                        email: guestInfo.email,
                        phone: guestInfo.phone,
                        address: guestInfo.street,
                        city: guestInfo.city,
                        state: guestInfo.area,
                        zip: guestInfo.zipCode,
                        country: guestInfo.country || "MT"
                    };
                    contact = {
                        name: guestInfo.name,
                        email: guestInfo.email,
                        phone: guestInfo.phone
                    };
                } else if (metadata.shipping && metadata.contact) {
                    shipping = JSON.parse(metadata.shipping);
                    contact = JSON.parse(metadata.contact);
                } else if (userId) {
                    // Fallback for registered users if shipping wasn't in metadata
                    const user = await User.findById(userId);
                    shipping = {
                        name: user.fullName,
                        email: user.email,
                        phone: user.mobile,
                        address: user.street,
                        city: user.city,
                        state: user.area,
                        zip: user.zipCode,
                        country: "MT"
                    };
                    contact = {
                        name: user.fullName,
                        email: user.email,
                        phone: user.mobile
                    };
                }

                const total = Number(metadata.subtotal) - Number(metadata.discount);

                order = new Order({
                    user: userId,
                    items,
                    total: total,
                    finalTotal: total,
                    discountAmount: Number(metadata.discount),
                    couponCode: metadata.couponCode !== 'none' ? metadata.couponCode : null,
                    paymentMethod: "CARD",
                    isPaid: true,
                    paidAt: new Date(),
                    paymentIntentId: paymentIntent.id,
                    paymentStatus: "succeeded",
                    shipping,
                    contact,
                });

                await order.save();
                console.log(`✅ Recovered missing order: ${order._id}`);

                // Decrement stock for recovered order
                for (const item of items) {
                    const product = await Product.findById(item.product);
                    if (!product) continue;
                    const variant = product.variants?.find(
                        (v) =>
                            v.color?.toLowerCase() === item.color?.toLowerCase() &&
                            v.dimensions?.trim() === item.dimensions?.trim()
                    );
                    if (variant) {
                        variant.stock = Math.max(0, (variant.stock || 0) - item.qty);
                        await product.save();
                    }
                }

                // Continue to notifications below
            } catch (recoveryErr) {
                console.error("❌ Order recovery failed:", recoveryErr);
                return;
            }
        }

        // Update order if not already marked as paid
        if (!order.isPaid) {
            order.isPaid = true;
            order.paidAt = new Date();
            order.paymentStatus = "succeeded";
            await order.save();

            console.log(`✅ Order ${order._id} marked as paid`);

            // Send confirmation notifications
            if (order.user?.email || order.shipping?.email) {
                const email = order.user?.email || order.shipping?.email;
                const name = order.user?.fullName || order.shipping?.name;

                try {
                    await sendOrderMail(email, name, order);
                } catch (err) {
                    console.error("Failed to send order confirmation email:", err);
                }
            }

            // Notify admin
            try {
                await sendTelegramMessage(
                    `✅ <b>Payment Confirmed</b>\n` +
                    `Order ID: ${order._id}\n` +
                    `Amount: €${order.finalTotal}\n` +
                    `Payment ID: ${paymentIntent.id}`
                );
            } catch (err) {
                console.error("Failed to send Telegram notification:", err);
            }
        }
    } catch (error) {
        console.error("Error handling payment success:", error);
        throw error;
    }
}

/**
 * Handle failed payment
 */
async function handlePaymentFailed(paymentIntent) {
    console.error("❌ Payment failed:", paymentIntent.id);

    try {
        const order = await Order.findOne({
            paymentIntentId: paymentIntent.id,
        });

        if (order) {
            order.paymentStatus = "failed";
            order.isPaid = false;
            await order.save();

            console.log(`❌ Order ${order._id} marked as payment failed`);

            // Notify admin of failed payment
            await sendTelegramMessage(
                `❌ <b>Payment Failed</b>\n` +
                `Order ID: ${order._id}\n` +
                `Payment ID: ${paymentIntent.id}\n` +
                `Reason: ${escapeHTML(paymentIntent.last_payment_error?.message || "Unknown")}`
            );
        }
    } catch (error) {
        console.error("Error handling payment failure:", error);
        throw error;
    }
}

/**
 * Handle refund
 */
async function handleRefund(charge) {
    console.log("💰 Refund processed:", charge.id);

    try {
        const order = await Order.findOne({
            paymentIntentId: charge.payment_intent,
        });

        if (order) {
            order.paymentStatus = "refunded";
            order.refundedAt = new Date();
            order.status = "Cancelled";
            await order.save();

            console.log(`💰 Order ${order._id} marked as refunded`);

            // Notify admin
            await sendTelegramMessage(
                `💰 <b>Refund Processed</b>\n` +
                `Order ID: ${order._id}\n` +
                `Amount: €${charge.amount_refunded / 100}\n` +
                `Charge ID: ${charge.id}`
            );
        }
    } catch (error) {
        console.error("Error handling refund:", error);
        throw error;
    }
}

/**
 * Handle dispute/chargeback
 */
async function handleDispute(dispute) {
    console.error("⚠️  Dispute created:", dispute.id);

    try {
        const order = await Order.findOne({
            paymentIntentId: dispute.payment_intent,
        });

        if (order) {
            order.paymentStatus = "disputed";
            order.disputedAt = new Date();
            await order.save();

            console.log(`⚠️  Order ${order._id} marked as disputed`);

            // URGENT: Notify admin immediately
            await sendTelegramMessage(
                `🚨 <b>URGENT: Dispute Created</b>\n` +
                `Order ID: ${order._id}\n` +
                `Amount: €${dispute.amount / 100}\n` +
                `Reason: ${escapeHTML(dispute.reason)}\n` +
                `Dispute ID: ${dispute.id}\n` +
                `⚠️ Action required in Stripe Dashboard!`
            );
        }
    } catch (error) {
        console.error("Error handling dispute:", error);
        throw error;
    }
}

/**
 * Handle canceled payment
 */
async function handlePaymentCanceled(paymentIntent) {
    console.log("🚫 Payment canceled:", paymentIntent.id);

    try {
        const order = await Order.findOne({
            paymentIntentId: paymentIntent.id,
        });

        if (order) {
            order.paymentStatus = "canceled";
            await order.save();

            console.log(`🚫 Order ${order._id} payment canceled`);
        }
    } catch (error) {
        console.error("Error handling payment cancellation:", error);
        throw error;
    }
}

export default router;
