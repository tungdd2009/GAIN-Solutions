const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const PptxGenJS = require('pptxgenjs');
const cors = require('cors');
const path = require('path');

// --- FLY.IO SAFETY: Ensure Fetch Exists ---
if (!global.fetch) {
  global.fetch = (...args) => import('node-fetch').then(m => m.default(...args));
}


const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// --- HELPER: Clean JSON ---
const cleanJSON = (text) => {
    return text.replace(/```json/g, '').replace(/```/g, '').trim();
};

// --- HELPER: Generate Image (Your Specific Models) ---
async function generateImagenImage(apiKey, prompt) {
    if (!prompt) return null;
    console.log(`[Imagen] Starting: "${prompt.substring(0, 15)}..."`);
    
    try {
        // Using your specific model versions
        const url = `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:generateImages?key=${apiKey}`;
        
        const payload = {
            prompt: prompt + " , educational style, photorealistic, high resolution, no text",
            numberOfImages: 1,
            aspectRatio: "16:9",
            safetySettings: [
                { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" }
            ]
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[Imagen Fail] ${response.status}: ${errorText}`);
            return null;
        }

        const data = await response.json();
        if (data.images && data.images[0] && data.images[0].imageBytes) {
            return `data:image/png;base64,${data.images[0].imageBytes}`;
        }
        return null;

    } catch (e) {
        console.error("[Imagen Error]", e.message);
        return null;
    }
}

// Serve static files from the 'public' directory
app.use(express.static('public'));

// --- API: Generate Lesson ---
app.post('/api/generate', async (req, res) => {
    try {
        const { apiKey, topic, grade, slideCount, age, region, method, theories, extraContext, language } = req.body;

        const keyToUse = apiKey || process.env.GOOGLE_API_KEY;
        if (!keyToUse) return res.status(400).json({ error: "API Key required" });

        // 1. Generate Text (Gemini)
        const genAI = new GoogleGenerativeAI(keyToUse);
        const model = genAI.getGenerativeModel({ 
            model: "gemini-3-flash-preview", 
            generationConfig: { responseMimeType: "application/json" }
        });

        const langInstruction = language === 'VN' ? "Output strictly in VIETNAMESE." : "Output strictly in ENGLISH.";
        const prompt = `
        Role: Teacher (Age: ${age}). Tone: ${age < 30 ? "Energetic" : "Formal"}.
        Language: ${langInstruction}
        Topic: "${topic}" (Grade: ${grade}).
        Context: Region: ${region}, Method: ${method}, Theories: ${theories.join(', ')}, Notes: ${extraContext}
        
        Output JSON:
        {
            "title": "Main Title",
            "subtitle": "Subtitle",
            "slides": [
                {
                    "title": "Slide Header",
                    "content": ["Bullet 1", "Bullet 2"],
                    "speaker_notes": "Script",
                    "image_prompt": "Detailed ENGLISH description of image."
                }
            ]
        }
        Generate exactly ${slideCount} slides.
        `;

        console.log("1. Generating Text...");
        const result = await model.generateContent(prompt);
        const lessonData = JSON.parse(cleanJSON(result.response.text()));

        // 2. Generate Images (PARALLEL EXECUTION FOR SPEED)
        console.log("2. Generating Images (Parallel)...");
        
        // A. Start Cover Image Request
        const coverPromise = generateImagenImage(keyToUse, `Minimal educational cover for ${topic}`);
        
        // B. Start All Slide Image Requests simultaneously
        const slideImagePromises = lessonData.slides.map(s => 
            generateImagenImage(keyToUse, s.image_prompt)
        );

        // C. Wait for all to finish (This cuts time from 60s -> 10s)
        const [coverImg, ...slideImages] = await Promise.all([coverPromise, ...slideImagePromises]);
        console.log("3. Images Received. Building PPT...");

        // 3. Build PowerPoint
        const pres = new PptxGenJS();
        pres.layout = 'LAYOUT_WIDE';
        
        pres.defineSlideMaster({
            title: 'MASTER',
            background: { color: 'F4F6F9' },
            objects: [
                { rect: { x: 0, y: 0, w: '100%', h: 1.2, fill: '1A73E8' } },
                { rect: { x: 0, y: 7, w: '100%', h: 0.5, fill: 'FFFFFF' } }
            ]
        });

        // Title Slide
        let slide = pres.addSlide();
        slide.background = { color: 'FFFFFF' };
        slide.addShape(pres.ShapeType.rect, { x: 0, y: 0, w: '40%', h: '100%', fill: '1A73E8' });
        slide.addText(lessonData.title, { x: 0.5, y: 2, w: '35%', fontSize: 48, bold: true, color: 'FFFFFF' });
        slide.addText(lessonData.subtitle || topic, { x: 0.5, y: 4.5, w: '35%', fontSize: 24, color: 'E8F0FE' });
        
        if (coverImg) {
            slide.addImage({ data: coverImg, x: 5.5, y: 1.5, w: 7, h: 4.5, sizing: { type: 'contain', w: 7, h: 4.5 } });
        }

        // Content Slides
        lessonData.slides.forEach((s, index) => {
            slide = pres.addSlide({ masterName: 'MASTER' });
            
            // Header
            slide.addText(s.title, { x: 0.5, y: 0.2, w: '90%', fontSize: 32, color: 'FFFFFF', bold: true });

            // Text
            const contentText = Array.isArray(s.content) ? s.content.join('\n') : s.content;
            slide.addText(contentText, { 
                x: 0.5, y: 1.5, w: 6, h: 5, 
                fontSize: 24, color: '363636', 
                bullet: { type: 'bullet', code: '2022' },
                lineSpacing: 35
            });

            // Retrieve the pre-generated image
            const imgData = slideImages[index];
            if (imgData) {
                slide.addImage({ data: imgData, x: 7, y: 1.5, w: 6, h: 5, sizing: { type: 'contain', w: 6, h: 5 } });
            } else {
                slide.addText("(Image Failed)", { x: 7, y: 1.5, w: 6, h: 5, fill: 'EEEEEE', color: '999999', align: 'center' });
            }

            if (s.speaker_notes) slide.addNotes(s.speaker_notes);
        });

        // 4. Output
        const buffer = await pres.write({ outputType: 'nodebuffer' });
        const base64 = buffer.toString('base64');
        res.json({ success: true, file: base64, preview: lessonData });

    } catch (error) {
        console.error("Critical Error:", error);
        res.status(500).json({ error: error.message });
    }
});
app.get('/__health', (req, res) => {
  res.json({ status: 'ok' });
});


app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on ${PORT}`);
});