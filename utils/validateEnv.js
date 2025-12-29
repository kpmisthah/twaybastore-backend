/**
 * Environment Variable Validation Utility
 * Validates that all required environment variables are set before starting the server
 */

export function validateEnvironment() {
    const requiredEnvVars = [
        'MONGO_URI',
        'JWT_SECRET',
        'STRIPE_SECRET_KEY',
    ];

    const optionalEnvVars = [
        'PORT',
        'STRIPE_WEBHOOK_SECRET',
        'SMTP_USER',
        'SMTP_PASS',
        'ORDER_ALERT_EMAIL',
        'TG_BOT_TOKEN',
        'TG_CHAT_IDS',
        'CLOUDINARY_CLOUD_NAME',
        'CLOUDINARY_API_KEY',
        'CLOUDINARY_API_SECRET',
    ];

    const missing = [];
    const warnings = [];

    // Check required variables
    for (const varName of requiredEnvVars) {
        if (!process.env[varName]) {
            missing.push(varName);
        }
    }

    // Check optional but recommended variables
    for (const varName of optionalEnvVars) {
        if (!process.env[varName]) {
            warnings.push(varName);
        }
    }

    // Report missing required variables
    if (missing.length > 0) {
        console.error('❌ CRITICAL: Missing required environment variables:');
        missing.forEach(varName => {
            console.error(`   - ${varName}`);
        });
        console.error('\n⚠️  Server cannot start without these variables.');
        console.error('Please check your .env file or environment configuration.\n');
        process.exit(1);
    }

    // Report warnings for optional variables
    if (warnings.length > 0) {
        console.warn('⚠️  WARNING: Missing optional environment variables:');
        warnings.forEach(varName => {
            console.warn(`   - ${varName}`);
        });
        console.warn('Some features may not work correctly.\n');
    }

    // Success message
    console.log('✅ Environment validation passed');
    console.log(`   - MongoDB: ${process.env.MONGO_URI ? 'Configured' : 'Missing'}`);
    console.log(`   - JWT Secret: ${process.env.JWT_SECRET ? 'Configured' : 'Missing'}`);
    console.log(`   - Stripe: ${process.env.STRIPE_SECRET_KEY ? 'Configured' : 'Missing'}`);
    console.log(`   - Stripe Webhook: ${process.env.STRIPE_WEBHOOK_SECRET ? 'Configured' : 'Missing'}`);
    console.log(`   - Email: ${process.env.SMTP_USER ? 'Configured' : 'Not configured'}`);
    console.log(`   - Telegram: ${process.env.TG_BOT_TOKEN ? 'Configured' : 'Not configured'}`);
    console.log(`   - Cloudinary: ${process.env.CLOUDINARY_CLOUD_NAME ? 'Configured' : 'Not configured'}\n`);
}
