from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from google import genai
from google.genai import types
import base64
import os
import io
from PIL import Image as PILImage

from fastapi.responses import JSONResponse
from fastapi.requests import Request


app = FastAPI()
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    print("[UNHANDLED ERROR]", repr(exc))
    return JSONResponse(
        status_code=500,
        content={"error": "Internal image generation failure"}
    )


class ImageRequest(BaseModel):
    prompt: str
    aspect_ratio: str = "16:9"

@app.get("/health")
def health():
    """Health check endpoint"""
    api_key_set = bool(os.getenv("GOOGLE_API_KEY"))
    print(f"[Health Check] API Key: {'✓ SET' if api_key_set else '✗ NOT SET'}")
    return {
        "status": "ok",
        "api_key_set": api_key_set
    }

@app.post("/generate-image")
def generate_image(req: ImageRequest):
    """
    Generate educational image using Imagen 4.0
    
    FIXED: Properly extract image bytes - handles multiple SDK versions
    """
    
    # Validation
    if not req.prompt or not req.prompt.strip():
        raise HTTPException(status_code=400, detail="Prompt cannot be empty")
    
    api_key = os.getenv("GOOGLE_API_KEY")
    if not api_key:
        print("[ERROR] GOOGLE_API_KEY not set in environment")
        raise HTTPException(
            status_code=500, 
            detail="GOOGLE_API_KEY environment variable not set"
        )

    try:
        print(f"[Imagen] Generating: {req.prompt[:70]}...")
        
        # Initialize client
        client = genai.Client(api_key=api_key)

        # Generate image
        #result = client.models.generate_content(
        #    model="imagen-4.0-generate-001",
        #    contents=req.prompt,
        #    config={
        #        'number_of_images':1,
        #        'aspect_ratio':req.aspect_ratio,
        #        'safety_filter_level':"block_most",
        #        'person_generation':"allow_adult",
        #        'negative_prompt':"text overlay, words, letters, watermark, blurry, low quality"
        #    }
        #)
    # Updated for 2026 SDK standards
    
        # Configuration for Nano Banana
        config = types.GenerateContentConfig(
            response_modalities=["IMAGE"],
            # aspect_ratio MUST be inside image_config
           # image_config=types.ImageConfig(
           #     aspect_ratio=req.aspect_ratio
           # ),
            candidate_count=1,         # Your original 'number_of_images'
            #person_generation="ALLOW_ADULT",
            #negative_prompt="text overlay, words, letters, watermark, blurry, low quality",
            safety_settings=[
                types.SafetySetting(
                    category="HARM_CATEGORY_HATE_SPEECH",
                    threshold="BLOCK_LOW_AND_ABOVE" # Original: 'block_most'
                )
            ]
        )


        # Updated extraction logic for Gemini 2.5
        try:
            result = client.models.generate_content(
                model="gemini-2.5-flash-image",
                contents=req.prompt,
                config=config
            )

            # Check if the response contains valid parts
            if not result.candidates or not result.candidates[0].content.parts:
                raise HTTPException(status_code=500, detail="No content returned")

            # Filter for inline_data (blobs) which contain the image bytes
            image_parts = [p for p in result.candidates[0].content.parts if p.inline_data]
            
            if not image_parts:
                print("[ERROR] No image blobs found in response")
                raise HTTPException(status_code=500, detail="No images generated")

            # Access the first image's bytes
            # Access the first image's data
           # Access the first image's data
            # Access the first image's data
            # Access the first image's data
            inline_data = image_parts[0].inline_data
            raw_data = inline_data.data

            print(f"[DEBUG] Data type: {type(raw_data)}")

            # Extract bytes without BytesIO
            if isinstance(raw_data, bytes):
                image_bytes = raw_data
            elif isinstance(raw_data, str):
                image_bytes = base64.b64decode(raw_data)
            elif hasattr(raw_data, 'read'):
                # File-like object - read directly
                if hasattr(raw_data, 'seek'):
                    raw_data.seek(0)
                image_bytes = raw_data.read()
            else:
                raise HTTPException(status_code=500, detail=f"Unsupported: {type(raw_data)}")

            print(f"[INFO] Got {len(image_bytes)} bytes")
            # After image_bytes is extracted
            if not (
                image_bytes.startswith(b"\x89PNG") or
                image_bytes.startswith(b"\xff\xd8\xff")
            ):
                raise HTTPException(
                    status_code=500,
                    detail="Returned data is not a valid PNG or JPEG"
                )

            # Encode and return - NO PIL PROCESSING
            base64_img = base64.b64encode(image_bytes).decode("utf-8")
            print(f"[Imagen] ✓ Returning {len(base64_img)} base64 chars")

            return {"image": base64_img}
            
        except HTTPException:
            raise
        except Exception as e:
            print(f"[API ERROR] {str(e)}")
            raise HTTPException(status_code=500, detail="Image generation failed")

        '''
        generated_image = result.generated_images[0]
        print(f"[Debug] Generated image type: {type(generated_image)}")
        print(f"[Debug] Image object type: {type(generated_image.image)}")
        print(f"[Debug] Image attributes: {dir(generated_image.image)}")
        
        # Try multiple methods to extract image bytes
        image_bytes = None
        
        # Method 1: Direct image_bytes attribute
        if hasattr(generated_image.image, 'image_bytes'):
            image_bytes = generated_image.image.image_bytes
            print(f"[Imagen] ✓ Method 1: image_bytes ({len(image_bytes)} bytes)")
        
        # Method 2: PIL Image object
        elif hasattr(generated_image.image, '_pil_image'):
            pil_image = generated_image.image._pil_image
            img_byte_arr = io.BytesIO()
            pil_image.save(img_byte_arr, format='PNG', optimize=True, quality=95)
            image_bytes = img_byte_arr.getvalue()
            print(f"[Imagen] ✓ Method 2: _pil_image ({len(image_bytes)} bytes)")
        
        # Method 3: Try to treat as PIL Image directly
        else:
            try:
                img_byte_arr = io.BytesIO()
                generated_image.image.save(img_byte_arr, format='PNG', optimize=True, quality=95)
                image_bytes = img_byte_arr.getvalue()
                print(f"[Imagen] ✓ Method 3: direct PIL save ({len(image_bytes)} bytes)")
            except Exception as e:
                print(f"[Imagen] Method 3 failed: {e}")
        
        if not image_bytes:
            raise HTTPException(
                status_code=500,
                detail="Could not extract image bytes from API response"
            )
            # Encode to base64
        base64_img = base64.b64encode(image_bytes).decode("utf-8")
        print(f"[Imagen] ✓ Final size: {len(image_bytes)/1024:.1f}KB (base64: {len(base64_img)/1024:.1f}KB)")

        return {"image": base64_img}
        '''
        
    except HTTPException:
        raise    
    except Exception as e:
        error_msg = str(e)
        print(f"[Imagen ERROR] {error_msg}")
        import traceback
        traceback.print_exc()
          
        raise HTTPException(
            status_code=500, 
            detail=f"Image generation failed: {error_msg}"
        )


if __name__ == "__main__":
    import uvicorn
    print("\n" + "="*50)
    print("🚀 Starting Imagen Service")
    print("="*50)
    print(f"API Key: {'✓ SET' if os.getenv('GOOGLE_API_KEY') else '✗ NOT SET'}")
    print("="*50 + "\n")
    uvicorn.run(app, host="0.0.0.0", port=8000) 