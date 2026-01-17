const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const PptxGenJS = require('pptxgenjs');
const cors = require('cors');

// --- FLY.IO SAFETY: Ensure Fetch Exists ---
if (!global.fetch) {
  global.fetch = (...args) => import('node-fetch').then(m => m.default(...args));
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// --- HELPER: Clean JSON ---
const cleanJSON = (text) => {
    return text.replace(/```json/g, '').replace(/```/g, '').trim();
};

// --- HELPER: Generate Image via Python Service ---
async function generateImage(prompt, retries = 2) {
    if (!prompt || !process.env.IMAGEN_SERVICE_URL) {
        console.log('[Image] Skipping - no prompt or service URL');
        return null;
    }
    
    console.log(`[Image] Generating: "${prompt.substring(0, 50)}..."`);
    
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 45000); // 45s timeout

            const response = await fetch(
                `${process.env.IMAGEN_SERVICE_URL}/generate-image`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        prompt: prompt + ", educational illustration, photorealistic, clear, no text overlay",
                        aspect_ratio: "16:9"
                    }),
                    signal: controller.signal
                }
            );

            clearTimeout(timeout);

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`[Image Error] ${response.status}: ${errorText}`);
                if (attempt < retries) {
                    console.log(`[Image] Retrying (${attempt + 1}/${retries})...`);
                    continue;
                }
                return null;
            }

            const data = await response.json();
            if (data.image) {
                console.log('[Image] ✓ Generated successfully');
                return `data:image/png;base64,${data.image}`;
            }
            return null;

        } catch (err) {
            console.error(`[Image Attempt ${attempt + 1}/${retries + 1}]`, err.message);
            if (attempt === retries) {
                console.log('[Image] All retries failed, continuing without image');
                return null;
            }
            // Wait before retry
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    return null;
}

// --- API: Generate Lesson ---
app.post('/api/generate', async (req, res) => {
    console.log('\n=== NEW LESSON REQUEST ===');
    
    try {
        const {
            topic,
            grade,
            slideCount,
            teacherAge,
            region,
            areaType,
            method,
            studentContext = "",
            language = "VN"
        } = req.body;

        /* =========================
           1. VALIDATION
        ========================== */
        if (!topic || topic.trim().length < 3) {
            return res.status(400).json({ 
                success: false,
                error: "Topic must be at least 3 characters" 
            });
        }

        if (!process.env.GOOGLE_API_KEY) {
            console.error('[ERROR] GOOGLE_API_KEY not set');
            return res.status(500).json({ 
                success: false,
                error: "Server configuration error - API key missing" 
            });
        }

        const slides = Math.min(Math.max(Number(slideCount) || 5, 3), 16);
        const age = Math.min(Math.max(Number(teacherAge) || 30, 20), 70);

        console.log(`Topic: "${topic}" | Grade: ${grade} | Slides: ${slides}`);

        /* =========================
           2. PEDAGOGICAL ADAPTATION
        ========================== */
        const tone =
            age < 30 ? "friendly, energetic, modern, relatable" :
            age < 50 ? "clear, structured, supportive, professional" :
            "calm, formal, methodical, experienced";

        const lifeContextMap = {
            urban: "city life, apartments, traffic, supermarkets, technology, modern infrastructure",
            rural: "villages, farming, family businesses, local markets, agricultural life",
            mountain: "mountain communities, nature, terraced fields, limited infrastructure",
            coastal: "coastal towns, fishing villages, tourism, sea-related activities, ports"
        };

        const localContext = lifeContextMap[areaType] || "everyday student life";

        const langRule = language === "VN"
            ? "ALL text content MUST be in natural, fluent VIETNAMESE. Use Vietnamese language for all slides."
            : "ALL text content MUST be in natural, fluent ENGLISH. Use English language for all slides.";

        /* =========================
           3. GENERATE LESSON CONTENT
        ========================== */
        const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
        const model = genAI.getGenerativeModel({
            model: "gemini-1.5-flash", // FIXED: Valid model name
            generationConfig: {
                responseMimeType: "application/json",
                temperature: 0.7,
                maxOutputTokens: 8000
            }
        });

        const prompt = `
You are an expert ${grade} educator creating an engaging lesson.

CRITICAL REQUIREMENTS:
- ${langRule}
- Teaching style: ${tone}
- Method: ${method}
- Student context: ${localContext}
- Region: ${region}
${studentContext ? `- Specific student background: ${studentContext}` : ''}

LESSON TOPIC: "${topic}"

Create EXACTLY ${slides} slides with clear, age-appropriate content.
Use concrete examples from ${localContext} that students can relate to.

STRICT FORMAT RULES:
1. Each slide MUST have 3-5 bullet points in the "content" array
2. Each bullet point should be ONE concise sentence (max 100 characters)
3. DO NOT put long paragraphs as a single bullet point
4. Break long ideas into multiple shorter bullets

BAD EXAMPLE (DO NOT DO THIS):
"content": ["Kết nối cảm xúc: Hiểu về những chủ nhân cũ giúp chúng ta trân trọng và gắn bó hơn với không gian sống hiện tại."]

GOOD EXAMPLE (DO THIS):
"content": [
  "Kết nối cảm xúc với không gian sống",
  "Hiểu về những chủ nhân cũ của ngôi nhà",
  "Trân trọng và gắn bó với nơi ở hiện tại"
]

OUTPUT ONLY THIS JSON (no markdown, no extra text):
{
  "title": "Engaging lesson title in ${language === 'VN' ? 'Vietnamese' : 'English'}",
  "subtitle": "Brief subtitle in ${language === 'VN' ? 'Vietnamese' : 'English'}",
  "slides": [
    {
      "title": "Slide title in ${language === 'VN' ? 'Vietnamese' : 'English'}",
      "content": [
        "Concise bullet 1 (one sentence only)",
        "Concise bullet 2 (one sentence only)",
        "Concise bullet 3 (one sentence only)",
        "Concise bullet 4 (optional)",
        "Concise bullet 5 (optional)"
      ],
      "speaker_notes": "Teacher guidance and teaching tips in ${language === 'VN' ? 'Vietnamese' : 'English'}",
      "image_prompt": "Detailed ENGLISH description of educational image showing ${localContext} context. Be specific and visual. Example: 'Vietnamese rice farmers working in terraced fields at sunrise, educational illustration'"
    }
  ]
}`;

        console.log('[1/4] Generating lesson content with Gemini...');
        const result = await model.generateContent(prompt);
        const responseText = result.response.text();
        const lessonData = JSON.parse(cleanJSON(responseText));

        // VALIDATION: Ensure content is properly formatted
        if (!lessonData.slides || !Array.isArray(lessonData.slides)) {
            throw new Error('Invalid lesson data: missing slides array');
        }

        lessonData.slides = lessonData.slides.map((slide, idx) => {
            // Ensure content is always an array
            if (!slide.content) {
                slide.content = ['Content not generated'];
            } else if (typeof slide.content === 'string') {
                // Split long string into sentences
                slide.content = slide.content
                    .split(/[.!?]+/)
                    .map(s => s.trim())
                    .filter(s => s.length > 0)
                    .slice(0, 5); // Max 5 bullets
            } else if (Array.isArray(slide.content)) {
                // Clean up array items
                slide.content = slide.content
                    .filter(item => item && typeof item === 'string')
                    .map(item => {
                        const cleaned = item.trim();
                        // If item is too long (>150 chars), split it
                        if (cleaned.length > 150) {
                            const parts = cleaned.split(/[.:;]/).map(p => p.trim()).filter(p => p);
                            return parts[0]; // Take first part only
                        }
                        return cleaned;
                    })
                    .filter(item => item.length > 0);
                
                // Ensure at least one bullet point
                if (slide.content.length === 0) {
                    slide.content = [`Slide ${idx + 1} content`];
                }
            }

            // Ensure other required fields
            slide.title = slide.title || `Slide ${idx + 1}`;
            slide.speaker_notes = slide.speaker_notes || '';
            slide.image_prompt = slide.image_prompt || `Educational illustration for ${topic}`;

            return slide;
        });

        console.log(`[1/4] ✓ Generated ${lessonData.slides.length} slides`);

        /* =========================
           4. GENERATE IMAGES (PARALLEL)
        ========================== */
        console.log('[2/4] Generating images in parallel...');
        
        const coverPrompt = `Modern educational cover illustration for ${topic}, ${localContext}, professional, clean design, 16:9`;
        
        const imagePromises = [
            generateImage(coverPrompt),
            ...lessonData.slides.map(s => generateImage(s.image_prompt))
        ];

        const allImages = await Promise.all(imagePromises);
        const [coverImg, ...slideImages] = allImages;

        const successCount = allImages.filter(img => img !== null).length;
        console.log(`[2/4] ✓ Generated ${successCount}/${allImages.length} images`);

        /* =========================
           5. BUILD POWERPOINT
        ========================== */
        console.log('[3/4] Building PowerPoint...');
        const pres = new PptxGenJS();
        pres.layout = "LAYOUT_WIDE";
        pres.author = "AI Lesson Architect";
        pres.subject = topic;

        // Define slide master
        pres.defineSlideMaster({
            title: "MASTER",
            background: { color: "F4F6F9" },
            objects: [
                { 
                    rect: { 
                        x: 0, 
                        y: 0, 
                        w: "100%", 
                        h: 1.0, 
                        fill: { type: "solid", color: "1A73E8" }
                    } 
                }
            ]
        });

        // --- Title Slide ---
        let slide = pres.addSlide();
        slide.background = { color: "FFFFFF" };

        // Left blue panel
        slide.addShape(pres.ShapeType.rect, {
            x: 0,
            y: 0,
            w: "38%",
            h: "100%",
            fill: { type: "solid", color: "1A73E8" }
        });

        // Title
        slide.addText(lessonData.title, {
            x: 0.5,
            y: 2,
            w: "35%",
            fontSize: 40,
            bold: true,
            color: "FFFFFF",
            fontFace: "Arial"
        });

        // Subtitle
        slide.addText(lessonData.subtitle || topic, {
            x: 0.5,
            y: 4.2,
            w: "35%",
            fontSize: 20,
            color: "E8F0FE",
            fontFace: "Arial"
        });

        // Cover image
        if (coverImg) {
            slide.addImage({
                data: coverImg,
                x: 5.2,
                y: 1.5,
                w: 7.5,
                h: 4.2,
                sizing: { type: "contain", w: 7.5, h: 4.2 }
            });
        }

        // --- Content Slides ---
        lessonData.slides.forEach((s, index) => {
            slide = pres.addSlide({ masterName: "MASTER" });

            // Slide title
            slide.addText(s.title, {
                x: 0.5,
                y: 0.15,
                w: "90%",
                fontSize: 28,
                bold: true,
                color: "FFFFFF",
                fontFace: "Arial"
            });

            // Content bullets - FIX: Handle both array and string content
            let contentText;
            if (Array.isArray(s.content)) {
                // Filter out empty items and create proper bullet array
                contentText = s.content
                    .filter(item => item && item.trim())
                    .map(item => ({ text: item.trim(), options: { breakLine: true } }));
            } else {
                contentText = [{ text: s.content, options: { breakLine: true } }];
            }

            slide.addText(contentText, {
                x: 0.5,
                y: 1.3,
                w: 5.8,
                h: 5,
                fontSize: 20,
                color: "2C3E50",
                bullet: { type: "bullet", code: "2022" },
                lineSpacing: 28,
                fontFace: "Arial",
                valign: "top"
            });

            // Slide image
            const img = slideImages[index];
            if (img) {
                slide.addImage({
                    data: img,
                    x: 6.8,
                    y: 1.3,
                    w: 6,
                    h: 5,
                    sizing: { type: "contain", w: 6, h: 5 }
                });
            }

            // Speaker notes
            if (s.speaker_notes) {
                slide.addNotes(s.speaker_notes);
            }
        });

        console.log('[3/4] ✓ PowerPoint structure complete');

        /* =========================
           6. EXPORT & SEND
        ========================== */
        console.log('[4/4] Exporting PowerPoint...');
        const buffer = await pres.write({ outputType: "nodebuffer" });
        console.log(`[4/4] ✓ File size: ${(buffer.length / 1024).toFixed(2)} KB`);

        res.json({
            success: true,
            file: buffer.toString("base64"),
            preview: {
                title: lessonData.title,
                subtitle: lessonData.subtitle,
                slideCount: lessonData.slides.length,
                imagesGenerated: successCount
            }
        });

        console.log('=== REQUEST COMPLETE ===\n');

    } catch (err) {
        console.error('=== CRITICAL ERROR ===');
        console.error(err);
        console.error('======================\n');
        
        res.status(500).json({ 
            success: false,
            error: "Lesson generation failed: " + err.message 
        });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok',
        timestamp: new Date().toISOString(),
        env: {
            hasApiKey: !!process.env.GOOGLE_API_KEY,
            hasImagenUrl: !!process.env.IMAGEN_SERVICE_URL
        }
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n✓ Server running on port ${PORT}`);
    console.log(`✓ API Key: ${process.env.GOOGLE_API_KEY ? 'SET' : 'MISSING'}`);
    console.log(`✓ Imagen Service: ${process.env.IMAGEN_SERVICE_URL || 'NOT SET'}\n`);
});