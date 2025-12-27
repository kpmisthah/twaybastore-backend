// config/stripe.js
import Stripe from "stripe";
import dotenv from "dotenv";
dotenv.config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
console.log("Stripe secret:", process.env.STRIPE_SECRET_KEY ? 'present' : 'missing');

export default stripe;
