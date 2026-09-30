import { GoogleSpreadsheet } from 'google-spreadsheet';
import { google } from 'googleapis';
import { JWT } from 'google-auth-library';

// --- CONFIGURATION ---
const SHEET_ID = '1v7ZweOib3iIQE_nDreZgYP82_fWJLZmhcZbfzqeLKtI';
const DRIVE_FOLDER_ID = '1Sq8zc990gEi29XsscgTgKw_1-6xseMrQ';
const MAX_ITEMS_PER_RUN = 50; // Process 50 items per 2-hour cron run
const DELAY_MS = 15000; // 15 seconds to prevent rate limits

// Helper function to sleep
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runPipeline() {
    console.log("🚀 Starting Autonomous Pipeline...");

    // 1. Authenticate with Google
    const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: [
            'https://www.googleapis.com/auth/spreadsheets',
            'https://www.googleapis.com/auth/drive'
        ]
    });

    // 2. Connect to Google Drive & Sheets
    const drive = google.drive({ version: 'v3', auth });
    const doc = new GoogleSpreadsheet(SHEET_ID, auth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();

    let processedCount = 0;

    // 3. Loop through rows
    for (const row of rows) {
        if (processedCount >= MAX_ITEMS_PER_RUN) {
            console.log("🛑 Reached max items for this run. Hibernating until next cron...");
            break;
        }

        const status = row.get('Status');
        const mealName = row.get('Name');

        if (status === 'Missing') {
            console.log(`\n👨‍🍳 Processing: ${mealName}`);
            
            try {
                // STEP A: Prepare Prompt (Using your exact template!)
                const imagePrompt = `A professional, high-angle food photograph of a traditional Indian thali meal, presented on a large, polished stainless steel round platter. 

The meal consists of the following items: ${mealName}.

Plating Instructions: 
- Any liquid dishes, curries, dals, or salads from the list must be centered within individual, smaller matching metal katoris on the platter. 
- Any breads, rotis, or chapatis from the list must NOT be in bowls; they must be positioned perfectly flat, unfolded, and directly in the foreground of the main platter. Do not add rice or other items not explicitly listed.

Environment: Adjacent to the main platter on a clean, subtly textured light grey concrete surface, are standard side items including a ceramic water tumbler, a folded beige linen napkin, and a vintage silver spoon. The scene is illuminated by soft, diffused natural daylight, creating a clean, modern yet rustic aesthetic with appetizing textures and vibrant colors. Aspect Ratio: 16:9

dont include anything other than the items listed in the meal`;

                console.log(`   📝 Prompt ready.`);

                // STEP B: Generate Image (Pollinations.ai / FLUX)
                const encodedPrompt = encodeURIComponent(imagePrompt);
                const imageResponse = await fetch(`https://image.pollinations.ai/prompt/${encodedPrompt}?width=1920&height=1080&nologo=true&model=flux`);
                
                if (!imageResponse.ok) {
                    throw new Error(`Image generation failed: ${imageResponse.status} ${imageResponse.statusText}`);
                }
                
                // Pollinations returns the raw image bytes directly
                const arrayBuffer = await imageResponse.arrayBuffer();
                const base64Image = Buffer.from(arrayBuffer).toString('base64');
                console.log(`   🎨 Image generated successfully.`);

                // STEP C: Audit Image (Gemini Vision)
                const auditResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{
                            parts: [
                                { text: `You are a strict food auditor. Does this image accurately depict this meal: '${mealName}'? Reply ONLY in JSON format: {"isValid": boolean, "feedback": "string"}` },
                                { inline_data: { mime_type: "image/jpeg", data: base64Image } }
                            ]
                        }]
                    })
                });
                
                const auditText = await auditResponse.json();
                let rawJsonStr = auditText.candidates[0].content.parts[0].text;
                rawJsonStr = rawJsonStr.replace(/```json/g, '').replace(/```/g, '').trim();
                const audit = JSON.parse(rawJsonStr);

                if (audit.isValid) {
                    console.log(`   ✅ Audit PASSED.`);
                    
                    // STEP D: Upload to Google Drive
                    const fileMetadata = {
                        name: `${mealName.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.jpg`,
                        parents: [DRIVE_FOLDER_ID]
                    };
                    const media = {
                        mimeType: 'image/jpeg',
                        body: Buffer.from(base64Image, 'base64')
                    };
                    
                    const driveRes = await drive.files.create({
                        resource: fileMetadata,
                        media: media,
                        fields: 'id'
                    });
                    
                    const driveLink = `https://drive.google.com/uc?export=view&id=${driveRes.data.id}`;
                    
                    // STEP E: Update Google Sheet
                    row.set('Status', 'Ready');
                    row.set('Image File Name', fileMetadata.name);
                    row.set('Drive Link', driveLink);
                    await row.save();
                    
                    console.log(`   💾 Uploaded to Drive and saved to Sheet!`);
                } else {
                    console.log(`   ❌ Audit FAILED: ${audit.feedback}. Will retry next run.`);
                }

            } catch (err) {
                console.error(`   ⚠️ Error processing ${mealName}:`, err.message);
            }

            processedCount++;
            
            // Sleep to prevent Gemini 15 RPM rate limit (15 seconds)
            console.log(`   ⏳ Sleeping for 15 seconds to respect rate limits...`);
            await sleep(DELAY_MS);
        }
    }
    
    console.log("🎉 Run complete!");
}

runPipeline().catch(console.error);
