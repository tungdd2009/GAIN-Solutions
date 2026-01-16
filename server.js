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

// --- API: Generate Lesson ---// --- API: Generate Lesson ---
app.post('/api/generate', async (req, res) => {
    try {
        const {
            apiKey,
            topic,
            grade,
            slideCount,
            age,
            region,
            areaType,
            method,
            theories = [],
            studentContext = "",
            extraContext = "",
            language = "VN"
        } = req.body;

        /* =========================
           1. VALIDATION & DEFAULTS
        ========================== */
        if (!topic || topic.trim().length < 3) {
            return res.status(400).json({ error: "Invalid topic" });
        }

        const slides = Math.min(Math.max(Number(slideCount) || 5, 3), 16);
        const teacherAge = Number(age) || 30;

        const keyToUse = apiKey || process.env.GOOGLE_API_KEY;
        if (!keyToUse) {
            return res.status(400).json({ error: "API Key required" });
        }

        /* =========================
           2. PEDAGOGICAL ADAPTATION
        ========================== */

        const tone =
            teacherAge < 30 ? "friendly, energetic, modern" :
            teacherAge < 50 ? "clear, structured, supportive" :
            "calm, formal, methodical";

        const lifeContextMap = {
            urban: "city life, apartments, traffic, supermarkets, technology",
            rural: "villages, farming, family businesses, local markets",
            mountain: "mountain communities, nature, limited infrastructure",
            coastal: "coastal towns, fishing, tourism, sea-related activities"
        };

        const localLifeContext =
            lifeContextMap[areaType] || "daily student life";

        const langRule =
            language === "VN"
                ? "ALL text content MUST be in natural, fluent VIETNAMESE."
                : "ALL text content MUST be in natural, fluent ENGLISH.";

        /* =========================
           3. GEMINI PROMPT
        ========================== */

        const genAI = new GoogleGenerativeAI(keyToUse);
        const model = genAI.getGenerativeModel({
            model: "gemini-3-flash-preview",
            generationConfig: {
                responseMimeType: "application/json",
                temperature: 0.7
            }
        });

        const prompt = `
You are an experienced EDUCATOR designing a real classroom lesson.

STRICT RULES:
- ${langRule}
- Adjust language complexity for grade level: ${grade}
- Teaching tone: ${tone}
- Teaching method: ${method}
- Educational theories: ${theories.join(", ") || "Standard pedagogy"}
- Use examples familiar to students living in: ${localLifeContext}
- Student life context: ${studentContext || "general students"}
- Region: ${region}

AVOID:
- Abstract or foreign examples students cannot relate to
- Overly academic language
- Meta commentary about AI

LESSON TOPIC:
"${topic}"

OUTPUT STRICT JSON ONLY:
{
  "title": "Lesson title",
  "subtitle": "Optional subtitle",
  "slides": [
    {
      "title": "Slide title",
      "content": [
        "Bullet point written for students",
        "Another clear bullet"
      ],
      "speaker_notes": "Teacher-facing explanation and tips",
      "image_prompt": "DETAILED, REALISTIC, ENGLISH-ONLY description of an educational illustration grounded in ${localLifeContext}"
    }
  ]
}

Generate EXACTLY ${slides} slides.
        `;

        console.log("1. Generating lesson content...");
        const result = await model.generateContent(prompt);
        const lessonData = JSON.parse(cleanJSON(result.response.text()));

        /* =========================
           4. IMAGE GENERATION (PARALLEL)
        ========================== */

        console.log("2. Generating images...");
        const coverPromise = generateImagenImage(
            keyToUse,
            `Minimal, modern educational cover illustration for lesson topic: ${topic}`
        );

        const slideImagePromises = lessonData.slides.map(slide =>
            generateImagenImage(keyToUse, slide.image_prompt)
        );

        const [coverImg, ...slideImages] = await Promise.all([
            coverPromise,
            ...slideImagePromises
        ]);

        /* =========================
           5. POWERPOINT BUILD
        ========================== */

        console.log("3. Building PowerPoint...");
        const pres = new PptxGenJS();
        pres.layout = "LAYOUT_WIDE";

        pres.defineSlideMaster({
            title: "MASTER",
            background: { color: "F4F6F9" },
            objects: [
                { rect: { x: 0, y: 0, w: "100%", h: 1.2, fill: "1A73E8" } }
            ]
        });

        // --- Title Slide ---
        let slide = pres.addSlide();
        slide.background = { color: "FFFFFF" };

        slide.addShape(pres.ShapeType.rect, {
            x: 0,
            y: 0,
            w: "38%",
            h: "100%",
            fill: "1A73E8"
        });

        slide.addText(lessonData.title, {
            x: 0.5,
            y: 2,
            w: "35%",
            fontSize: 44,
            bold: true,
            color: "FFFFFF"
        });

        slide.addText(lessonData.subtitle || topic, {
            x: 0.5,
            y: 4.5,
            w: "35%",
            fontSize: 22,
            color: "E8F0FE"
        });

        if (coverImg) {
            slide.addImage({
                data: coverImg,
                x: 5.5,
                y: 1.5,
                w: 7,
                h: 4.5,
                sizing: { type: "contain", w: 7, h: 4.5 }
            });
        }

        // --- Content Slides ---
        lessonData.slides.forEach((s, index) => {
            slide = pres.addSlide({ masterName: "MASTER" });

            slide.addText(s.title, {
                x: 0.5,
                y: 0.2,
                w: "90%",
                fontSize: 30,
                bold: true,
                color: "FFFFFF"
            });

            slide.addText(
                Array.isArray(s.content) ? s.content.join("\n") : s.content,
                {
                    x: 0.5,
                    y: 1.5,
                    w: 6,
                    h: 5,
                    fontSize: 22,
                    color: "363636",
                    bullet: { type: "bullet", code: "2022" },
                    lineSpacing: 32
                }
            );

            const img = slideImages[index];
            if (img) {
                slide.addImage({
                    data: img,
                    x: 7,
                    y: 1.5,
                    w: 6,
                    h: 5,
                    sizing: { type: "contain", w: 6, h: 5 }
                });
            }

            if (s.speaker_notes) {
                slide.addNotes(s.speaker_notes);
            }
        });

        /* =========================
           6. OUTPUT
        ========================== */

        const buffer = await pres.write({ outputType: "nodebuffer" });

        res.json({
            success: true,
            file: buffer.toString("base64"),
            preview: lessonData
        });

    } catch (err) {
        console.error("Critical Error:", err);
        res.status(500).json({ error: "Lesson generation failed" });
    }
});



app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on ${PORT}`);
});