// middleware/rateLimiter.js
import rateLimit from "express-rate-limit";

/**
 * Rate limiter for payment endpoints
 * Prevents abuse and brute force attacks
 */
export const paymentRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // Limit each IP to 10 payment requests per windowMs
    message: {
        error: "Too many payment requests from this IP",
        details: "Please try again after 15 minutes",
    },
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    // Skip rate limiting for successful requests
    skipSuccessfulRequests: false,
    // Skip rate limiting for failed requests
    skipFailedRequests: false,
});

/**
 * Rate limiter for order creation
 */
export const orderRateLimiter = rateLimit({
    windowMs: 10 * 60 * 1000, // 10 minutes
    max: 5, // Limit each IP to 5 order creations per windowMs
    message: {
        error: "Too many order requests from this IP",
        details: "Please try again after 10 minutes",
    },
    standardHeaders: true,
    legacyHeaders: false,
});

/**
 * Stricter rate limiter specifically for COD orders
 * COD has no payment verification so needs tighter limits
 */
export const codRateLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 2, // Only 2 COD orders per IP per hour
    message: {
        error: "Too many COD orders from this IP",
        details: "Please try again later or use card payment",
    },
    standardHeaders: true,
    legacyHeaders: false,
});

/**
 * General API rate limiter
 */
export const generalRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: {
        error: "Too many requests from this IP",
        details: "Please try again later",
    },
    standardHeaders: true,
    legacyHeaders: false,
});
