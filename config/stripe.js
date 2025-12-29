// config/stripe.js
import Stripe from "stripe";
import dotenv from "dotenv";
dotenv.config();

/**
 * Initialize Stripe with proper error handling
 * Validates API key presence and format
 */
function initializeStripe() {
    const secretKey = process.env.STRIPE_SECRET_KEY;

    if (!secretKey) {
        throw new Error(
            "STRIPE_SECRET_KEY is not defined in environment variables. " +
            "Please check your .env file."
        );
    }

    // Validate key format
    if (!secretKey.startsWith("sk_test_") && !secretKey.startsWith("sk_live_")) {
        throw new Error(
            "Invalid STRIPE_SECRET_KEY format. " +
            "Expected format: sk_test_... or sk_live_..."
        );
    }

    // Warn if using test key in production
    if (process.env.NODE_ENV === "production" && secretKey.startsWith("sk_test_")) {
        console.warn(
            "⚠️  WARNING: Using Stripe TEST key in production environment! " +
            "Please switch to live key (sk_live_...)"
        );
    }

    try {
        const stripe = new Stripe(secretKey, {
            apiVersion: "2024-12-18.acacia", // Use latest stable API version
            maxNetworkRetries: 3, // Retry failed requests
            timeout: 30000, // 30 second timeout
        });

        // Only log in development
        if (process.env.NODE_ENV !== "production") {
            console.log("✅ Stripe initialized successfully (TEST mode)");
        }

        return stripe;
    } catch (error) {
        throw new Error(`Failed to initialize Stripe: ${error.message}`);
    }
}

const stripe = initializeStripe();

export default stripe;
