#!/bin/bash

# Stripe Production Readiness Test Script
# This script verifies all critical components are in place

echo "🔍 Stripe Production Readiness Check"
echo "======================================"
echo ""

# Color codes
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check counter
PASSED=0
FAILED=0
WARNINGS=0

# Function to check file exists
check_file() {
    if [ -f "$1" ]; then
        echo -e "${GREEN}✅ $2${NC}"
        ((PASSED++))
    else
        echo -e "${RED}❌ $2 - File missing: $1${NC}"
        ((FAILED++))
    fi
}

# Function to check directory exists
check_dir() {
    if [ -d "$1" ]; then
        echo -e "${GREEN}✅ $2${NC}"
        ((PASSED++))
    else
        echo -e "${RED}❌ $2 - Directory missing: $1${NC}"
        ((FAILED++))
    fi
}

# Function to check if string exists in file
check_content() {
    if grep -q "$2" "$1" 2>/dev/null; then
        echo -e "${GREEN}✅ $3${NC}"
        ((PASSED++))
    else
        echo -e "${RED}❌ $3 - Not found in $1${NC}"
        ((FAILED++))
    fi
}

# Function to warn
warn() {
    echo -e "${YELLOW}⚠️  $1${NC}"
    ((WARNINGS++))
}

echo "1. Checking Core Files..."
echo "-------------------------"
check_file "env.example" "Environment template exists"
check_file "config/stripe.js" "Stripe configuration exists"
check_file "routes/stripeWebhookRoutes.js" "Webhook handler exists"
check_file "middleware/rateLimiter.js" "Rate limiter exists"
check_file "utils/validateEnv.js" "Environment validator exists"
check_file "models/Order.js" "Order model exists"
echo ""

echo "2. Checking Documentation..."
echo "----------------------------"
check_file "STRIPE_PRODUCTION_SETUP.md" "Production setup guide"
check_file "STRIPE_SECURITY.md" "Security documentation"
check_file "IMPLEMENTATION_SUMMARY.md" "Implementation summary"
echo ""

echo "3. Checking Code Implementation..."
echo "----------------------------------"
check_content "config/stripe.js" "initializeStripe" "Stripe initialization function"
check_content "routes/stripeWebhookRoutes.js" "stripe.webhooks.constructEvent" "Webhook signature verification"
check_content "routes/paymentRoutes.js" "idempotencyKey" "Idempotency implementation"
check_content "routes/orderRoutes.js" "existingOrder" "Payment reuse prevention"
check_content "middleware/rateLimiter.js" "paymentRateLimiter" "Payment rate limiting"
check_content "server.js" "validateEnvironment" "Environment validation on startup"
check_content "server.js" "stripeWebhookRoutes" "Webhook route registered"
check_content "models/Order.js" "paymentStatus" "Payment status tracking"
echo ""

echo "4. Checking Environment Setup..."
echo "--------------------------------"
if [ -f ".env" ]; then
    echo -e "${GREEN}✅ .env file exists${NC}"
    ((PASSED++))
    
    # Check for required variables (without showing values)
    if grep -q "STRIPE_SECRET_KEY=" ".env" 2>/dev/null; then
        echo -e "${GREEN}✅ STRIPE_SECRET_KEY configured${NC}"
        ((PASSED++))
    else
        warn "STRIPE_SECRET_KEY not found in .env"
    fi
    
    if grep -q "STRIPE_WEBHOOK_SECRET=" ".env" 2>/dev/null; then
        echo -e "${GREEN}✅ STRIPE_WEBHOOK_SECRET configured${NC}"
        ((PASSED++))
    else
        warn "STRIPE_WEBHOOK_SECRET not configured (optional for dev)"
    fi
else
    warn ".env file not found - Copy env.example to .env"
fi
echo ""

echo "5. Checking Dependencies..."
echo "--------------------------"
if [ -f "package.json" ]; then
    if grep -q '"stripe"' "package.json"; then
        echo -e "${GREEN}✅ Stripe package in dependencies${NC}"
        ((PASSED++))
    fi
    if grep -q '"express-rate-limit"' "package.json"; then
        echo -e "${GREEN}✅ Rate limiter package in dependencies${NC}"
        ((PASSED++))
    fi
fi
echo ""

echo "6. Security Checks..."
echo "--------------------"
if [ -f ".gitignore" ]; then
    if grep -q ".env" ".gitignore"; then
        echo -e "${GREEN}✅ .env in .gitignore${NC}"
        ((PASSED++))
    else
        echo -e "${RED}❌ .env NOT in .gitignore - SECURITY RISK!${NC}"
        ((FAILED++))
    fi
fi

# Check for any hardcoded secrets (basic check)
if grep -r "sk_live_" --include="*.js" . 2>/dev/null | grep -v "env.example" | grep -v "node_modules" | grep -v ".md"; then
    echo -e "${RED}❌ WARNING: Possible hardcoded Stripe key found!${NC}"
    ((FAILED++))
else
    echo -e "${GREEN}✅ No hardcoded Stripe keys detected${NC}"
    ((PASSED++))
fi
echo ""

echo "======================================"
echo "📊 Test Results:"
echo "======================================"
echo -e "${GREEN}✅ Passed: $PASSED${NC}"
if [ $FAILED -gt 0 ]; then
    echo -e "${RED}❌ Failed: $FAILED${NC}"
fi
if [ $WARNINGS -gt 0 ]; then
    echo -e "${YELLOW}⚠️  Warnings: $WARNINGS${NC}"
fi
echo ""

# Calculate score
TOTAL=$((PASSED + FAILED))
if [ $TOTAL -gt 0 ]; then
    SCORE=$((PASSED * 100 / TOTAL))
    echo "Score: $SCORE%"
    echo ""
    
    if [ $SCORE -ge 90 ]; then
        echo -e "${GREEN}🎉 Excellent! Your Stripe integration is production-ready!${NC}"
    elif [ $SCORE -ge 70 ]; then
        echo -e "${YELLOW}⚠️  Good, but some improvements needed before production.${NC}"
    else
        echo -e "${RED}❌ Critical issues found. Please fix before deploying.${NC}"
    fi
fi

echo ""
echo "📚 Next Steps:"
echo "1. Review STRIPE_PRODUCTION_SETUP.md for deployment guide"
echo "2. Configure .env with your production Stripe keys"
echo "3. Setup webhook endpoint in Stripe dashboard"
echo "4. Test payment flow in development"
echo "5. Deploy to production"
echo ""
