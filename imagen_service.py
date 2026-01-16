from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from google import genai
import base64

app = FastAPI()

class ImageRequest(BaseModel):
    api_key: str
    prompt: str
    aspect_ratio: str = "16:9"

@app.post("/generate-image")
def generate_image(req: ImageRequest):
    if not req.prompt.strip():
        raise HTTPException(status_code=400, detail="Prompt is empty")

    try:
        client = genai.Client(api_key=os.getenv("GOOGLE_API_KEY"))


        result = client.models.generate_images(
            model="imagen-4.0-generate-001",
            prompt=req.prompt,
            config={
                "aspect_ratio": req.aspect_ratio,
                "safety_filter_level": "block_most",
                "person_generation": "allow_adult"
            }
        )

        image_bytes = result.generated_images[0].image.image_bytes
        base64_img = base64.b64encode(image_bytes).decode("utf-8")

        return { "image": base64_img }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
