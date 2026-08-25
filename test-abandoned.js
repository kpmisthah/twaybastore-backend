import stripe from "./config/stripe.js";
import 'dotenv/config';

async function run() {
  const intents = await stripe.paymentIntents.list({ limit: 10 });
  const abandoned = intents.data.filter(pi => pi.status !== 'succeeded');
  console.log(`Found ${abandoned.length} abandoned checkouts out of ${intents.data.length}`);
  if (abandoned.length > 0) {
    const pi = abandoned[0];
    console.log(pi.id, pi.status, pi.metadata);
  }
}
run();
