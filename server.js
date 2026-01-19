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
                return `data:image/png;base64,${data.image}`;
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

        // Left gradient panel (modern design)
        slide.addShape(pres.ShapeType.rect, {
            x: 0,
            y: 0,
            w: "42%",
            h: "100%",
            fill: { 
                type: "solid",
                color: "1A73E8"
            }
        });

        // Accent gradient overlay
        slide.addShape(pres.ShapeType.rect, {
            x: 0,
            y: 0,
            w: "42%",
            h: "100%",
            fill: { 
                type: "solid",
                color: "000000",
                transparency: 85
            }
        });

        // Title with better positioning
        slide.addText(lessonData.title, {
            x: 0.6,
            y: 2.2,
            w: "38%",
            fontSize: 42,
            bold: true,
            color: "FFFFFF",
            fontFace: "Arial",
            align: "left",
            valign: "top"
        });

        // Subtitle/description
        slide.addText(lessonData.subtitle || topic, {
            x: 0.6,
            y: 4.6,
            w: "36%",
            fontSize: 18,
            color: "E3F2FD",
            fontFace: "Arial",
            align: "left"
        });

        // Grade badge
        slide.addShape(pres.ShapeType.rect, {
            x: 0.6,
            y: 5.8,
            w: 1.2,
            h: 0.4,
            fill: { color: "FFFFFF", transparency: 20 },
            line: { color: "FFFFFF", width: 1 }
        });
        
        slide.addText(req.body.grade || "K-12", {
            x: 0.6,
            y: 5.8,
            w: 1.2,
            h: 0.4,
            fontSize: 14,
            color: "FFFFFF",
            bold: true,
            align: "center",
            valign: "middle"
        });

        // Cover image (right side) with frame
        const hasCoverImg = coverImg && coverImg.startsWith('data:image');
        
        if (hasCoverImg) {
            // White frame
            slide.addShape(pres.ShapeType.rect, {
                x: 5.8,
                y: 1.2,
                w: 7.2,
                h: 5,
                fill: { color: "FFFFFF" },
                line: { color: "E0E0E0", width: 2 }
            });

            slide.addImage({
                data: coverImg,
                x: 6,
                y: 1.4,
                w: 6.8,
                h: 4.6,
                sizing: { type: "cover", w: 6.8, h: 4.6 }
            });
        } else {
            // Placeholder when no image
            slide.addShape(pres.ShapeType.rect, {
                x: 5.8,
                y: 1.2,
                w: 7.2,
                h: 5,
                fill: { color: "F5F5F5" },
                line: { color: "E0E0E0", width: 2 }
            });

            slide.addText("🎓", {
                x: 5.8,
                y: 2.5,
                w: 7.2,
                h: 2,
                fontSize: 80,
                align: "center",
                valign: "middle"
            });
        }

        // --- Content Slides ---
        lessonData.slides.forEach((s, index) => {
            slide = pres.addSlide({ masterName: "MASTER" });

            // Slide title
            slide.addText(s.title, {
                x: 0.4,
                y: 0.2,
                w: 12,
                fontSize: 32,
                bold: true,
                color: "FFFFFF",
                fontFace: "Arial",
                align: "left"
            });

            const img = slideImages[index];
            const hasImage = img && img.startsWith('data:image');

            if (hasImage) {
                // With image: side-by-side layout
                slide.addText(s.content.map(c => ({ text: c, options: { bullet: true } })), {
                    x: 0.4,
                    y: 1.4,
                    w: 5.5,
                    h: 4.8,
                    fontSize: 20,
                    color: "2C3E50",
                    fontFace: "Arial",
                    valign: "top"
                });

                slide.addImage({
                    data: img,
                    x: 6.5,
                    y: 1.4,
                    w: 6.2,
                    h: 4.8,
                    sizing: { type: "contain" }
                });
            } else {
                // Without image: full width
                slide.addText(s.content.map(c => ({ text: c, options: { bullet: true } })), {
                    x: 0.8,
                    y: 1.4,
                    w: 11.5,
                    h: 4.8,
                    fontSize: 22,
                    color: "2C3E50",
                    fontFace: "Arial",
                    valign: "top"
                });
            }

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