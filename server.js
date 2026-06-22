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

// --- HELPER: Wake up Imagen service (Render cold start) ---
async function wakeUpImagenService() {
    if (!process.env.IMAGEN_SERVICE_URL) {
        console.log('[Image] ⚠ IMAGEN_SERVICE_URL not set');
        return false;
    }
    
    try {
        console.log(`[Image] Pinging: ${process.env.IMAGEN_SERVICE_URL}/health`);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60000);
        
        const response = await fetch(
            `${process.env.IMAGEN_SERVICE_URL}/health`,
            { signal: controller.signal }
        );
        
        clearTimeout(timeout);
        const data = await response.json();
        console.log('[Image] Health check:', JSON.stringify(data));
        return response.ok && data.api_key_set;
    } catch (err) {
        console.error('[Image] ⚠ Health check failed:', err.message);
        return false;
    }
}

// --- HELPER: Generate Image via Python Service ---
async function generateImage(prompt, retries = 2) {
    if (!prompt) {
        console.log('[Image] Skipping - no prompt');
        return null;
    }
    
    if (!process.env.IMAGEN_SERVICE_URL) {
        console.log('[Image] Skipping - IMAGEN_SERVICE_URL not configured');
        return null;
    }
    
    console.log(`[Image] Generating: "${prompt.substring(0, 50)}..."`);
    
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const controller = new AbortController();
            // Longer timeout for first attempt (cold start), shorter for retries
            const timeoutDuration = attempt === 0 ? 90000 : 45000;
            const timeout = setTimeout(() => controller.abort(), timeoutDuration);

            const response = await fetch(
                `${process.env.IMAGEN_SERVICE_URL}/generate-image`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        prompt: prompt + ", educational illustration, photorealistic, clear, professional, no text overlay",
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
                    await new Promise(resolve => setTimeout(resolve, 3000));
                    continue;
                }
                return null;
            }

            const data = await response.json();
            if (data.image && data.image.length > 100) {
                console.log(`[Image] ✓ Success (${(data.image.length / 1024).toFixed(1)}KB)`);
                return data.image;
            } else {
                console.error('[Image] Invalid response - image data too short');
                return null;
            }

        } catch (err) {
            if (err.name === 'AbortError') {
                console.error(`[Image Attempt ${attempt + 1}] Timeout`);
            } else {
                console.error(`[Image Attempt ${attempt + 1}]`, err.message);
            }
            
            if (attempt === retries) {
                console.log('[Image] All retries exhausted, continuing without image');
                return null;
            }
            
            await new Promise(resolve => setTimeout(resolve, 2000));
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
            model: "gemini-3-flash-preview", // FIXED: Valid model name # gemini-3-pro-preview
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
        console.log('[2/4] Waking up image service and generating images...');
        
        // Wake up service first (important for Render cold starts)
        await wakeUpImagenService();
        
        const coverPrompt = `Modern educational cover illustration for ${topic}, ${localContext}, professional, clean design, 16:9`;
        
        const imagePromises = [
            generateImage(coverPrompt),
            ...lessonData.slides.map(s => generateImage(s.image_prompt))
        ];

        const allImages = await Promise.all(imagePromises);
        const [coverImg, ...slideImages] = allImages;

        const successCount = allImages.filter(img => img !== null).length;
        console.log(`[2/4] ✓ Generated ${successCount}/${allImages.length} images`);
        
        // Debug: Log which images failed
        allImages.forEach((img, idx) => {
            if (idx === 0) {
                console.log(`  - Cover image: ${img ? '✓ Success' : '✗ Failed'}`);
            } else {
                console.log(`  - Slide ${idx} image: ${img ? '✓ Success' : '✗ Failed'}`);
            }
        });

        /* =========================
        5. BUILD POWERPOINT (MODERN DESIGN)
        ========================== */
        console.log('[3/4] Building PowerPoint...');
        const pres = new PptxGenJS();
        pres.layout = "LAYOUT_WIDE";

        // --- THEME COLORS ---
        const COLORS = {
            primary: "1E293B",   // Slate 800
            accent: "6366F1",    // Indigo 500
            text: "334155",      // Slate 700
            light: "F8FAFC",     // Slate 50
            white: "FFFFFF"
        };

        // --- TITLE SLIDE (Cinematic Look) ---
        let slide = pres.addSlide();

        // 1. Background Image/Color
        if (coverImg && coverImg.startsWith('data:image')) {
            const base64data = coverImg.split(",")[1];
            slide.addImage({
                data: base64data,
                x: 0, y: 0, w: "100%", h: "100%",
                sizing: { type: "cover" }
            });
            // Dark Overlay for readability
            slide.addShape(pres.ShapeType.rect, {
                x: 0, y: 0, w: "100%", h: "100%",
                fill: { color: "000000", transparency: 50 }
            });
        } else {
            slide.background = { color: COLORS.primary };
        }

        // 2. Decorative Accent Line
        slide.addShape(pres.ShapeType.rect, {
            x: 0.5, y: 2.5, w: 1.5, h: 0.1, fill: { color: COLORS.accent }
        });

        // 3. Title Text (High Contrast)
        slide.addText(lessonData.title, {
            x: 0.5, y: 3.0, w: "90%",
            fontSize: 54, bold: true, color: COLORS.white,
            fontFace: "Arial"
        });

        // 4. Subtitle
        slide.addText(lessonData.subtitle || topic, {
            x: 0.5, y: 4.5, w: "90%",
            fontSize: 24, color: COLORS.white, transparency: 20,
            fontFace: "Arial"
        });

        // 5. Grade Badge (Bottom Left)
        slide.addText(req.body.grade || "K-12", {
            x: 0.5, y: 6.2, w: 1.5, h: 0.5,
            align: "center", valign: "middle",
            fontSize: 16, bold: true, color: COLORS.white,
            fill: { color: COLORS.accent }
        });


        // --- CONTENT SLIDES (Split-Layout Design) ---
        lessonData.slides.forEach((s, index) => {
            slide = pres.addSlide();
            slide.background = { color: COLORS.light };

            // 1. Top Accent Bar
            slide.addShape(pres.ShapeType.rect, {
                x: 0, y: 0, w: "100%", h: 0.15, fill: { color: COLORS.accent }
            });

            // 2. Slide Title
            slide.addText(s.title, {
                x: 0.5, y: 0.5, w: "90%",
                fontSize: 36, bold: true, color: COLORS.primary,
                fontFace: "Arial"
            });

            const img = slideImages[index];
            const hasImage = img && img.startsWith('data:image');

            if (hasImage) {
                // LAYOUT A: Split Screen (Image Left, Text Right)
                const base64data = img.split(",")[1];
                
                // Image with subtle shadow/border effect
                slide.addImage({
                    data: base64data,
                    x: 0.5, y: 1.5, w: 5.0, h: 4.0,
                    sizing: { type: "cover" }
                });

                // Text Block in a "Card"
                slide.addText(s.content.map(c => ({ text: c, options: { bullet: true } })), {
                    x: 6.0, y: 1.5, w: 5.5, h: 4.0,
                    fontSize: 22, color: COLORS.text,
                    valign: "top", lineSpacing: 34
                });
            } else {
                // LAYOUT B: Centered Card (For slides without images)
                slide.addShape(pres.ShapeType.rect, {
                    x: 0.5, y: 1.2, w: 12, h: 4.5,
                    fill: { color: COLORS.white },
                    rectRadius: 0.2
                });

                slide.addText(s.content.map(c => ({ text: c, options: { bullet: true } })), {
                    x: 1.0, y: 1.5, w: 11, h: 4.0,
                    fontSize: 26, color: COLORS.text,
                    valign: "top", lineSpacing: 40
                });
            }

            // 3. Footer (Page number/Branding)
            slide.addText(`AI Lesson Architect | Slide ${index + 1}`, {
                x: 0.5, y: 7.0, w: 12, fontSize: 10, color: COLORS.text, transparency: 50
            });

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