from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from google import genai
import base64
import os

app = FastAPI()

class ImageRequest(BaseModel):
    prompt: str
    aspect_ratio: str = "16:9"

@app.get("/health")
def health():
    """Health check endpoint"""
    return {
        "status": "ok",
        "api_key_set": bool(os.getenv("GOOGLE_API_KEY"))
    }

@app.post("/generate-image")
def generate_image(req: ImageRequest):
    """
    Generate educational image using Imagen 4.0
    
    Fixed issues:
    - Removed unused api_key from request body
    - Uses environment variable GOOGLE_API_KEY
    - Better error handling
    - Added logging
    """
    
    # Validation
    if not req.prompt or not req.prompt.strip():
        raise HTTPException(status_code=400, detail="Prompt cannot be empty")
    
    api_key = os.getenv("GOOGLE_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=500, 
            detail="GOOGLE_API_KEY environment variable not set"
        )

    try:
        print(f"[Imagen] Generating image for: {req.prompt[:60]}...")
        
        # Initialize client with API key from environment
        client = genai.Client(api_key=api_key)

        # Generate image
        result = client.models.generate_images(
            model="imagen-4.0-generate-001",
            prompt=req.prompt,
            config={
                "aspect_ratio": req.aspect_ratio,
                "safety_filter_level": "block_most",
                "person_generation": "allow_adult",
                "negative_prompt": "text, words, letters, watermark, blurry"
            }
        )

        # Extract and encode image
        if not result.generated_images or len(result.generated_images) == 0:
            raise HTTPException(
                status_code=500, 
                detail="No images generated"
            )

        image_bytes = result.generated_images[0].image.image_bytes
        base64_img = base64.b64encode(image_bytes).decode("utf-8")

        print(f"[Imagen] ✓ Image generated successfully ({len(image_bytes)} bytes)")

        return {"image": base64_img}

    except Exception as e:
        print(f"[Imagen Error] {str(e)}")
        raise HTTPException(
            status_code=500, 
            detail=f"Image generation failed: {str(e)}"
        )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)