// config/stripe.js
// dotenv is loaded by config/env.js (imported first in server.js)
import Stripe from "stripe";

/**
 * Stripe instance — initialized lazily on first use.
 * This ensures process.env.STRIPE_SECRET_KEY is populated by env.js
 * before Stripe reads it, regardless of ES module import order.
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
            apiVersion: "2024-12-18.acacia",
            maxNetworkRetries: 3,
            timeout: 30000,
        });

        const mode = secretKey.startsWith("sk_test_") ? "TEST" : "LIVE";
        console.log(`✅ Stripe initialized successfully (${mode} mode)`);

        return stripe;
    } catch (error) {
        throw new Error(`Failed to initialize Stripe: ${error.message}`);
    }
}

// Lazy singleton — only created when first accessed (after env vars are loaded)
let _stripe = null;
const stripe = new Proxy({}, {
    get(_, prop) {
        if (!_stripe) _stripe = initializeStripe();
        return _stripe[prop];
    }
});

export default stripe;
