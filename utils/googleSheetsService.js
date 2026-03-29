import { google } from 'googleapis';

/**
 * Service to handle Google Sheets operations.
 * Requires GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, and GOOGLE_SHEETS_ID env vars.
 */

const getAuthClient = () => {
    try {
        const client_email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
        let private_key = process.env.GOOGLE_PRIVATE_KEY;

        if (!client_email || !private_key) {
            console.warn('Google Sheets credentials missing. Sync disabled.');
            return null;
        }

        // Handle escaped newlines in private key
        private_key = private_key.replace(/\\n/g, '\n');

        return new google.auth.GoogleAuth({
            credentials: {
                client_email,
                private_key,
            },
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
    } catch (error) {
        console.error('Failed to initialize Google Auth client:', error);
        return null;
    }
};

/**
 * Removes a row from the Google Sheet based on the product code.
 * @param {string} productCode - The unique code of the product to remove.
 */
export const removeProductRow = async (productCode) => {
    if (process.env.GOOGLE_SHEETS_SYNC_ENABLED !== 'true' || !productCode) {
        return;
    }

    const auth = getAuthClient();
    if (!auth) return;

    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID;

    try {
        // 1. Get the spreadsheet metadata to find the first sheet's ID
        const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
        const firstSheet = spreadsheet.data.sheets[0];
        const sheetId = firstSheet.properties.sheetId;
        const sheetName = firstSheet.properties.title;

        // 2. Fetch all values to find the product code
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `${sheetName}!A:Z`,
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            console.warn('Google Sheet is empty.');
            return;
        }

        // 3. Find the column index for "Product Code"
        const headerRow = rows[0];
        const codeColIndex = headerRow.findIndex(h =>
            h && h.toLowerCase().includes('code')
        );

        if (codeColIndex === -1) {
            console.warn('Could not find column containing "Code" in Google Sheet headers.');
            return;
        }

        // 4. Find the row index (0-based)
        const rowIndex = rows.findIndex((row, index) =>
            index > 0 && row[codeColIndex] === productCode
        );

        if (rowIndex === -1) {
            console.log(`Product code ${productCode} not found in Google Sheet.`);
            return;
        }

        // 5. Delete the row using batchUpdate
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: {
                requests: [
                    {
                        deleteDimension: {
                            range: {
                                sheetId: sheetId,
                                dimension: 'ROWS',
                                startIndex: rowIndex,
                                endIndex: rowIndex + 1,
                            },
                        },
                    },
                ],
            },
        });

        console.log(`Successfully removed product ${productCode} (Row ${rowIndex + 1}) from Google Sheet.`);
    } catch (error) {
        console.error('Error during Google Sheets row removal:', error.message);
    }
};
