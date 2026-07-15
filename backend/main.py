import os
import json
import logging
from typing import Dict, List, Any
from fastapi import FastAPI, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import google.generativeai as genai
from twilio.twiml.voice_response import VoiceResponse, Gather

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(title="Umair's Takeaway AI Voice Agent")

# Enable CORS for all routes (to support frontend development on different ports)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Paths for files
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
MENU_FILE = os.path.join(DATA_DIR, "menu.json")
ORDERS_FILE = os.path.join(DATA_DIR, "orders.json")
CONFIG_FILE = os.path.join(DATA_DIR, "config.json")

# Load environment variables from .env file if it exists
ENV_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
if os.path.exists(ENV_FILE):
    try:
        with open(ENV_FILE, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, val = line.split("=", 1)
                    os.environ[key.strip()] = val.strip()
        logger.info("Loaded environment variables from .env file.")
    except Exception as e:
        logger.error(f"Error reading .env file: {e}")


# Make sure directories exist
os.makedirs(DATA_DIR, exist_ok=True)

# Helper function to read/write files
def read_json_file(file_path: str, default_value: Any) -> Any:
    if not os.path.exists(file_path):
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(default_value, f, indent=2)
        return default_value
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        logger.error(f"Error reading file {file_path}: {e}")
        return default_value

def write_json_file(file_path: str, data: Any):
    try:
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
    except Exception as e:
        logger.error(f"Error writing to file {file_path}: {e}")

# In-memory session tracking for active calls
# Maps call_sid -> { "phone": str, "chat_history": list, "cart": list, "customer_info": dict, "language": str, "status": str }
active_calls: Dict[str, Dict[str, Any]] = {}

# In-memory WebSocket connections for real-time dashboard notifications
class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info(f"Dashboard client connected. Total clients: {len(self.active_connections)}")

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
            logger.info(f"Dashboard client disconnected. Total clients: {len(self.active_connections)}")

    async def broadcast(self, message: dict):
        logger.info(f"Broadcasting websocket message: {message.get('type')}")
        disconnected = []
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except Exception as e:
                logger.error(f"Error sending ws message: {e}")
                disconnected.append(connection)
        for conn in disconnected:
            self.disconnect(conn)

ws_manager = ConnectionManager()

# Gemini AI helper
def query_gemini_agent(call_sid: str, user_transcript: str) -> dict:
    config = read_json_file(CONFIG_FILE, {})
    menu = read_json_file(MENU_FILE, [])
    
    # Set Gemini API Key
    api_key = config.get("gemini_api_key") or os.environ.get("GEMINI_API_KEY")
    if not api_key:
        logger.warning("GEMINI_API_KEY is not set. Using fallback mock mode.")
        return get_mock_ai_response(call_sid, user_transcript, menu)
    
    try:
        genai.configure(api_key=api_key)
        model = genai.GenerativeModel("gemini-1.5-flash")
        
        # Build active call state
        call_state = active_calls.get(call_sid, {
            "chat_history": [],
            "cart": [],
            "customer_info": {"name": "", "address": "", "phone": "", "type": ""}
        })
        
        # Format menu for the model
        menu_str = json.dumps([{"id": m["id"], "name": m["name"], "price": m["price"], "category": m["category"]} for m in menu if m.get("available", True)], indent=2)
        
        # System instructions
        system_instruction = f"""
{config.get("system_prompt")}

Available Menu Items:
{menu_str}

Format your response as a valid JSON object with the following fields:
- "ai_response": The sentence you want to say to the customer next in their language.
- "detected_language_code": The BCP-47 language tag of the conversation (e.g., "en-GB", "es-ES", "ur-PK").
- "cart_updated": The complete list of ordered items containing: {{"id": int, "name": str, "price": float, "qty": int}}.
- "delivery_info": The customer information gathered so far: {{"type": "delivery" or "collection" or "", "name": str, "address": str, "phone": str}}.
- "sentiment": Overall customer mood ("happy", "neutral", "impatient", "frustrated").
- "is_completed": A boolean indicating if the order is completely finalized, confirmed by the customer, and we can say goodbye and hang up.
"""

        # Build prompt history
        messages_prompt = []
        for turn in call_state["chat_history"]:
            messages_prompt.append(f"User: {turn['user']}")
            messages_prompt.append(f"AI: {turn['ai']}")
        
        messages_prompt.append(f"User: {user_transcript}")
        prompt = "\n".join(messages_prompt)
        
        # Run generation
        logger.info("Calling Gemini API...")
        response = model.generate_content(
            contents=[
                {"role": "user", "parts": [system_instruction + "\n\nConversation so far:\n" + prompt]}
            ],
            generation_config={"response_mime_type": "application/json"}
        )
        
        result = json.loads(response.text.strip())
        logger.info(f"Gemini response: {result}")
        return result
    except Exception as e:
        logger.error(f"Error querying Gemini: {e}")
        return get_mock_ai_response(call_sid, user_transcript, menu)

def get_mock_ai_response(call_sid: str, user_transcript: str, menu: list) -> dict:
    """Fallback mock AI responses if API key is not configured or fails, supporting multi-language demo flows without Twilio/Gemini API keys"""
    text = user_transcript.lower()
    call_state = active_calls.setdefault(call_sid, {
        "cart": [],
        "customer_info": {"name": "", "address": "", "phone": "", "type": ""}
    })
    
    # Simple language detection
    lang_code = "en-GB"
    # Urdu/Hindi/Roman Urdu keywords
    urdu_keywords = ["chahye", "chahiye", "do", "karo", "kardo", "naam", "pata", "address", "delivery", "dilivery", "ghar", "lekar", "aao", "shukriya", "ha", "haan", "nahin", "nahi", "mukammal", "confirm", "khuda", "hafiz"]
    # Spanish keywords
    spanish_keywords = ["hola", "quiero", "por favor", "nombre", "direccion", "llevar", "domicilio", "gracias", "si", "no", "confirmar", "adios"]
    
    # Check if text matches language hints
    is_urdu = any(kw in text for kw in urdu_keywords)
    is_spanish = any(kw in text for kw in spanish_keywords)
    
    if is_urdu:
        lang_code = "ur-PK"
    elif is_spanish:
        lang_code = "es-ES"
    
    is_completed = False
    matched_items = []
    
    # Match menu items (English name check)
    for item in menu:
        if item["name"].lower() in text:
            qty = 1
            if "two" in text or "2" in text or "do " in text or "dos" in text:
                qty = 2
            elif "three" in text or "3" in text or "teen" in text or "tres" in text:
                qty = 3
            
            # Check if item already in cart
            found = False
            for cart_item in call_state.get("cart", []):
                if cart_item["id"] == item["id"]:
                    cart_item["qty"] += qty
                    found = True
                    break
            if not found:
                call_state.setdefault("cart", []).append({
                    "id": item["id"],
                    "name": item["name"],
                    "price": item["price"],
                    "qty": qty
                })
            matched_items.append(f"{qty}x {item['name']}")

    # Formulate response based on detected language
    if lang_code == "ur-PK":
        if matched_items:
            response_text = f"Aap ke order mein {', '.join(matched_items)} add kar diya hai. Kuch aur chahiye, ya aap khud collect karenge ya delivery chahiye?"
        elif "delivery" in text or "ghar" in text or "bhejo" in text:
            call_state["customer_info"]["type"] = "delivery"
            response_text = "Delivery ke liye. Perfect. Aapka naam aur delivery ka address kya hai?"
        elif "collect" in text or "lekar" in text or "khud" in text:
            call_state["customer_info"]["type"] = "collection"
            response_text = "Collection ke liye. Perfect. Aapka naam kya hai?"
        elif len(call_state.get("cart", [])) > 0 and ("complete" in text or "yes" in text or "haan" in text or "confirm" in text or "ho gaya" in text or "shukriya" in text):
            is_completed = True
            response_text = "Shukriya! Aapka order confirm ho gaya hai aur jald hi tayar ho jayega. Khuda Hafiz!"
        else:
            response_text = "Umair's Takeaway mein khush aamdeed! Main aap ke liye kya lekar aaoon?"
            
    elif lang_code == "es-ES":
        if matched_items:
            response_text = f"He añadido {', '.join(matched_items)} a su pedido. ¿Desea algo más, o es para llevar o domicilio?"
        elif "domicilio" in text or "delivery" in text or "enviar" in text:
            call_state["customer_info"]["type"] = "delivery"
            response_text = "Para domicilio. Perfecto. ¿Cuál es su nombre y dirección de entrega, por favor?"
        elif "llevar" in text or "recoger" in text:
            call_state["customer_info"]["type"] = "collection"
            response_text = "Para llevar. Perfecto. ¿Cuál es su nombre, por favor?"
        elif len(call_state.get("cart", [])) > 0 and ("complete" in text or "si" in text or "confirmar" in text or "gracias" in text):
            is_completed = True
            response_text = "¡Gracias! Su pedido está confirmado y estará listo pronto. ¡Adiós!"
        else:
            response_text = "¡Bienvenido a Umair's Takeaway! ¿Qué le puedo ofrecer hoy?"
            
    else: # English default
        if matched_items:
            response_text = f"Added {', '.join(matched_items)} to your order. Would you like anything else, or is that for collection or delivery?"
        elif "delivery" in text:
            call_state["customer_info"]["type"] = "delivery"
            response_text = "Delivery. Perfect. What is your name and delivery address, please?"
        elif "collection" in text or "collect" in text:
            call_state["customer_info"]["type"] = "collection"
            response_text = "Collection. Perfect. What is your name, please?"
        elif len(call_state.get("cart", [])) > 0 and ("complete" in text or "yes" in text or "that is all" in text or "thank you" in text or "confirm" in text):
            is_completed = True
            response_text = "Thank you! Your order is confirmed and will be ready soon. Goodbye!"
        else:
            response_text = "Welcome to Umair's Takeaway. What can I get for you today?"

    return {
        "ai_response": response_text,
        "detected_language_code": lang_code,
        "cart_updated": call_state.get("cart", []),
        "delivery_info": call_state["customer_info"],
        "sentiment": "neutral",
        "is_completed": is_completed
    }

# FastAPI Webhook Routes for Twilio Call Flow
@app.post("/voice/incoming")
async def incoming_call(request: Request):
    """Handle incoming Twilio voice call"""
    form_data = await request.form()
    call_sid = form_data.get("CallSid", "unknown")
    caller_phone = form_data.get("From", "Unknown Customer")
    
    logger.info(f"Incoming call from: {caller_phone} (Sid: {call_sid})")
    
    # Load default language from config
    config = read_json_file(CONFIG_FILE, {})
    default_lang = config.get("default_language", "en-GB")
    
    # Initialize active call state
    active_calls[call_sid] = {
        "sid": call_sid,
        "phone": caller_phone,
        "chat_history": [],
        "cart": [],
        "customer_info": {"name": "", "address": "", "phone": caller_phone, "type": ""},
        "language": default_lang,
        "status": "active",
        "sentiment": "neutral"
    }
    
    # Notify dashboard of incoming call
    await ws_manager.broadcast({
        "type": "call_started",
        "call_sid": call_sid,
        "phone": caller_phone
    })
    
    # Respond to Twilio
    response = VoiceResponse()
    response.say("Welcome to Umair's Takeaway. How can I help you today?", voice="Polly.Amy", language=default_lang)
    
    # Start gathering speech input using default language
    gather = Gather(
        input="speech",
        action="/voice/respond",
        timeout=3,
        speechTimeout="auto",
        language=default_lang,
        enhanced=True
    )
    response.append(gather)
    
    # Fallback if customer remains silent
    response.redirect("/voice/incoming")
    
    return Response(content=str(response), media_type="application/xml")


@app.post("/voice/respond")
async def respond_call(request: Request):
    """Process customer speech and reply with AI response"""
    form_data = await request.form()
    call_sid = form_data.get("CallSid", "unknown")
    speech_result = form_data.get("SpeechResult", "")
    
    logger.info(f"Call {call_sid} speech result: '{speech_result}'")
    
    # Fetch call state early
    call_state = active_calls.get(call_sid)
    if not call_state:
        # If session timed out or server restarted
        response = VoiceResponse()
        response.say("I am sorry, our systems are restarting. Please call us again.", voice="Polly.Amy", language="en-GB")
        response.hangup()
        return Response(content=str(response), media_type="application/xml")
        
    current_lang = call_state.get("language", "en-GB")
    
    if not speech_result:
        # Customer didn't say anything, ask again
        response = VoiceResponse()
        response.say("I didn't catch that. Could you repeat it?", voice="Polly.Amy", language=current_lang)
        response.append(Gather(input="speech", action="/voice/respond", timeout=3, speechTimeout="auto", language=current_lang))
        return Response(content=str(response), media_type="application/xml")
    
    # Run through Gemini
    ai_result = query_gemini_agent(call_sid, speech_result)
    
    ai_response_text = ai_result.get("ai_response", "Sorry, can you repeat that?")
    lang_code = ai_result.get("detected_language_code", "en-GB")
    cart = ai_result.get("cart_updated", [])
    delivery_info = ai_result.get("delivery_info", {})
    sentiment = ai_result.get("sentiment", "neutral")
    is_completed = ai_result.get("is_completed", False)
    
    # Update call state in memory
    call_state["chat_history"].append({"user": speech_result, "ai": ai_response_text})
    call_state["cart"] = cart
    call_state["customer_info"] = delivery_info
    call_state["language"] = lang_code
    call_state["sentiment"] = sentiment
    
    # Broadcast live updates to dashboard
    await ws_manager.broadcast({
        "type": "call_updated",
        "call_sid": call_sid,
        "transcript": {"user": speech_result, "ai": ai_response_text},
        "cart": cart,
        "customer_info": delivery_info,
        "language": lang_code,
        "sentiment": sentiment
    })
    
    response = VoiceResponse()
    # Speak reply in customer's detected language!
    response.say(ai_response_text, voice="Polly.Amy", language=lang_code)
    
    if is_completed:
        # Order is completed. Save it!
        call_state["status"] = "completed"
        save_completed_order(call_sid, call_state)
        
        # Broadcast completed call & trigger print event
        await ws_manager.broadcast({
            "type": "call_completed",
            "call_sid": call_sid,
            "order": format_order_for_dashboard(call_sid, call_state)
        })
        
        # Hang up Twilio call
        response.hangup()
        # Clean up call state
        if call_sid in active_calls:
            del active_calls[call_sid]
    else:
        # Continue gathering speech using the newly detected language
        gather = Gather(
            input="speech",
            action="/voice/respond",
            timeout=3,
            speechTimeout="auto",
            language=lang_code,
            enhanced=True
        )
        response.append(gather)

    
    return Response(content=str(response), media_type="application/xml")

def format_order_for_dashboard(call_sid: str, call_state: dict) -> dict:
    # Calculate subtotal, delivery fee, taxes, total
    cart = call_state["cart"]
    subtotal = sum(item.get("price", 0) * item.get("qty", 1) for item in cart)
    delivery_type = call_state["customer_info"].get("type", "collection")
    delivery_fee = 2.50 if delivery_type == "delivery" else 0.00
    total = subtotal + delivery_fee
    
    import datetime
    order_time = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    
    return {
        "id": call_sid,
        "time": order_time,
        "phone": call_state["phone"],
        "customer_name": call_state["customer_info"].get("name", "Unknown"),
        "delivery_type": delivery_type,
        "address": call_state["customer_info"].get("address", ""),
        "items": cart,
        "subtotal": round(subtotal, 2),
        "delivery_fee": round(delivery_fee, 2),
        "total": round(total, 2),
        "language": call_state["language"],
        "sentiment": call_state["sentiment"],
        "status": "Received"
    }

def save_completed_order(call_sid: str, call_state: dict):
    orders = read_json_file(ORDERS_FILE, [])
    new_order = format_order_for_dashboard(call_sid, call_state)
    orders.insert(0, new_order)  # Add at the beginning of the list
    write_json_file(ORDERS_FILE, orders)

# REST API Endpoints for Dashboard
@app.get("/api/menu")
def get_menu():
    return read_json_file(MENU_FILE, [])

@app.post("/api/menu")
def update_menu(menu: List[dict]):
    write_json_file(MENU_FILE, menu)
    return {"status": "success", "message": "Menu updated"}

@app.get("/api/orders")
def get_orders():
    return read_json_file(ORDERS_FILE, [])

@app.post("/api/orders/update_status")
async def update_order_status(payload: dict):
    order_id = payload.get("id")
    status = payload.get("status")
    orders = read_json_file(ORDERS_FILE, [])
    for order in orders:
        if order["id"] == order_id:
            order["status"] = status
            break
    write_json_file(ORDERS_FILE, orders)
    await ws_manager.broadcast({"type": "order_status_updated", "id": order_id, "status": status})
    return {"status": "success"}

@app.get("/api/active-calls")
def get_active_calls():
    return {
        call_sid: {
            "sid": state.get("sid"),
            "phone": state.get("phone"),
            "chat_history": state.get("chat_history", []),
            "cart": state.get("cart", []),
            "customer_info": state.get("customer_info", {}),
            "language": state.get("language", "en-GB"),
            "sentiment": state.get("sentiment", "neutral"),
            "status": state.get("status", "active")
        }
        for call_sid, state in active_calls.items()
    }

@app.get("/api/config")
def get_config():
    return read_json_file(CONFIG_FILE, {})

@app.post("/api/config")
def update_config(config: dict):
    current = read_json_file(CONFIG_FILE, {})
    current.update(config)
    write_json_file(CONFIG_FILE, current)
    return {"status": "success", "message": "Configuration updated"}

# WebSocket Endpoint
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await ws_manager.connect(websocket)
    try:
        while True:
            # Maintain connection alive, check for client actions
            data = await websocket.receive_text()
            logger.info(f"Received ws data from client: {data}")
    except WebSocketDisconnect:
        ws_manager.disconnect(websocket)

# Serve Frontend static files if they exist (built React app)
FRONTEND_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "frontend")
if os.path.exists(FRONTEND_DIR):
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")

if __name__ == "__main__":
    import uvicorn
    # Get port from environment or run on 5000
    port = int(os.environ.get("PORT", 5000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
