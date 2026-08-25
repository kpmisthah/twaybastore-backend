import dotenv from 'dotenv';
import { removeProductRow } from './utils/googleSheetsService.js';

dotenv.config({ path: '.env.development' });

const testProductCode = process.argv[2];

if (!testProductCode) {
    console.log('Usage: node test-gsheets.js <productCode>');
    process.exit(1);
}

console.log(`Testing Google Sheets removal for product code: ${testProductCode}...`);
console.log('Make sure your .env.development has:');
console.log('- GOOGLE_SHEETS_ID');
console.log('- GOOGLE_SERVICE_ACCOUNT_EMAIL');
console.log('- GOOGLE_PRIVATE_KEY (the long one starting with -----BEGIN PRIVATE KEY-----)');
console.log('- GOOGLE_SHEETS_SYNC_ENABLED=true');

removeProductRow(testProductCode)
    .then(() => {
        console.log('Test execution finished. Check the output above for results.');
    })
    .catch((err) => {
        console.error('Test failed with error:', err);
    });
