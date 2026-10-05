import os
import re
import uuid
from pathlib import Path
from typing import Literal
from datetime import datetime, timedelta, timezone

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Depends, status
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, EmailStr
from groq import Groq
import psycopg2
from psycopg2.extras import RealDictCursor
from jose import JWTError
import bcrypt

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
CONTEXT_FILE = BASE_DIR / "context.md"

app = FastAPI(title="Teaching Agent API")

# Auth uses a bearer header (no cookies), so credentials are not needed.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def add_server_id_header(request, call_next):
    """Tags every response with the PID of the process that served it."""
    response = await call_next(request)
    response.headers["X-Server-PID"] = str(os.getpid())
    return response


print(f"[server] process started, PID {os.getpid()}")

client = Groq(api_key=os.getenv("GROQ_API_KEY"))

MODEL_NAME = os.getenv("LLM_MODEL", "llama-3.3-70b-versatile")

SECRET_KEY = os.getenv("JWT_SECRET_KEY")
if not SECRET_KEY:
    raise RuntimeError("JWT_SECRET_KEY is not set. Add it to your .env file.")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 * 7  # 1 week

MAX_SESSIONS = 5
MAX_HISTORY_MESSAGES = 40
MIN_PASSWORD_LENGTH = 8
MAX_PASSWORD_BYTES = 72  # bcrypt limit

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="api/login")

DATABASE_URL = os.getenv("DATABASE_URL")


# --------------------------------------------------------------------------
# Database
# --------------------------------------------------------------------------

def get_db():
    if not DATABASE_URL:
        raise HTTPException(status_code=500, detail="DATABASE_URL is not configured.")
    conn = psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)
    try:
        yield conn
    finally:
        conn.close()


def init_db():
    if not DATABASE_URL:
        print("DATABASE_URL not found. Skipping table creation.")
        return
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cursor:
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS users (
                        id SERIAL PRIMARY KEY,
                        email VARCHAR(255) UNIQUE NOT NULL,
                        password_hash VARCHAR(255) NOT NULL,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    );
                """)
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS chat_sessions (
                        session_id VARCHAR(255) PRIMARY KEY,
                        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    );
                """)
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS chat_messages (
                        id SERIAL PRIMARY KEY,
                        session_id VARCHAR(255) REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
                        role VARCHAR(50) NOT NULL,
                        content TEXT NOT NULL,
                        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    );
                """)
        conn.close()
        print("PostgreSQL tables verified/created successfully.")
    except Exception as e:
        print(f"Database initialization error: {e}")


init_db()


# --------------------------------------------------------------------------
# System prompt + math sanitising
# --------------------------------------------------------------------------

DEFAULT_SYSTEM_INSTRUCTION = "You are an expert AI teaching assistant."

if CONTEXT_FILE.exists():
    system_instruction = CONTEXT_FILE.read_text(encoding="utf-8")
else:
    system_instruction = DEFAULT_SYSTEM_INSTRUCTION

_PROTECTED_SPAN = re.compile(r"\$\$[\s\S]*?\$\$|\$(?!\$)[^$\n]*?\$(?!\$)")
_DISPLAY_MATH = re.compile(r"\\\[\s*([\s\S]*?)\s*\\\]")
_INLINE_MATH = re.compile(r"\\\(\s*([^\n]*?)\s*\\\)")
_PLACEHOLDER = "\x00MATH{}\x00"


def sanitize_math_notation(text: str) -> str:
    if not text:
        return text

    protected_spans = []

    def stash(match: re.Match) -> str:
        protected_spans.append(match.group(0))
        return _PLACEHOLDER.format(len(protected_spans) - 1)

    text = _PROTECTED_SPAN.sub(stash, text)
    text = _DISPLAY_MATH.sub(lambda m: f"$$\n{m.group(1).strip()}\n$$", text)
    text = _INLINE_MATH.sub(lambda m: f"${m.group(1).strip()}$", text)

    for index, original in enumerate(protected_spans):
        text = text.replace(_PLACEHOLDER.format(index), original)

    return text


# --------------------------------------------------------------------------
# Auth helpers
# --------------------------------------------------------------------------

def password_problem(password: str):
    """Return an error message if the password is unusable, else None."""
    if len(password) < MIN_PASSWORD_LENGTH:
        return f"Password must be at least {MIN_PASSWORD_LENGTH} characters."
    if len(password.encode("utf-8")) > MAX_PASSWORD_BYTES:
        return f"Password must be at most {MAX_PASSWORD_BYTES} bytes."
    return None


def get_password_hash(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    try:
        return bcrypt.checkpw(plain_password.encode("utf-8"), hashed_password.encode("utf-8"))
    except ValueError:
        # e.g. password longer than bcrypt's 72-byte limit
        return False


def create_access_token(data: dict, expires_delta: timedelta = None):
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + (expires_delta or timedelta(minutes=15))
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def get_current_user(token: str = Depends(oauth2_scheme), db=Depends(get_db)):
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        email = payload.get("sub")
        if email is None:
            raise credentials_exception
    except JWTError as exc:
        print(f"[auth] PID {os.getpid()} rejected token: {exc}")
        raise credentials_exception

    with db.cursor() as cursor:
        cursor.execute("SELECT id, email FROM users WHERE email = %s;", (email,))
        user = cursor.fetchone()
    if user is None:
        print(f"[auth] PID {os.getpid()}: token valid but no user with email {email!r}")
        raise credentials_exception
    return user


def new_session_id() -> str:
    return f"session_{uuid.uuid4().hex[:16]}"


def assert_session_owner(db, session_id: str, user_id: int):
    with db.cursor() as cursor:
        cursor.execute(
            "SELECT session_id FROM chat_sessions WHERE session_id = %s AND user_id = %s;",
            (session_id, user_id),
        )
        if not cursor.fetchone():
            raise HTTPException(status_code=403, detail="Access denied to this session.")


# --------------------------------------------------------------------------
# Schemas
# --------------------------------------------------------------------------

class UserRegister(BaseModel):
    email: EmailStr
    password: str


class UserDeleteRequest(BaseModel):
    password: str


class HistoryMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    session_id: str
    messages: list[HistoryMessage]


# --------------------------------------------------------------------------
# Auth routes
# --------------------------------------------------------------------------

@app.post("/api/register")
def register(user: UserRegister, db=Depends(get_db)):
    problem = password_problem(user.password)
    if problem:
        raise HTTPException(status_code=400, detail=problem)

    email = user.email.lower()
    with db.cursor() as cursor:
        cursor.execute("SELECT id FROM users WHERE LOWER(email) = %s;", (email,))
        if cursor.fetchone():
            raise HTTPException(status_code=400, detail="Email already registered.")

        cursor.execute(
            "INSERT INTO users (email, password_hash) VALUES (%s, %s) RETURNING id, email;",
            (email, get_password_hash(user.password)),
        )
        new_user = cursor.fetchone()
        db.commit()
    return {"message": "User registered successfully", "email": new_user["email"]}


@app.post("/api/login")
def login(form_data: OAuth2PasswordRequestForm = Depends(), db=Depends(get_db)):
    email = form_data.username.strip().lower()
    with db.cursor() as cursor:
        cursor.execute(
            "SELECT id, email, password_hash FROM users WHERE LOWER(email) = %s;",
            (email,),
        )
        user = cursor.fetchone()

    if not user or not verify_password(form_data.password, user["password_hash"]):
        raise HTTPException(status_code=400, detail="Incorrect email or password")

    access_token = create_access_token(
        data={"sub": user["email"]},
        expires_delta=timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES),
    )
    return {"access_token": access_token, "token_type": "bearer"}


@app.post("/token")
def login_alias(form_data: OAuth2PasswordRequestForm = Depends(), db=Depends(get_db)):
    return login(form_data=form_data, db=db)


@app.get("/api/me")
def read_me(current_user: dict = Depends(get_current_user)):
    """Cheap endpoint the frontend uses to check whether a stored token is still valid."""
    return {"email": current_user["email"]}


@app.post("/api/user/delete")
def delete_user_account(
    payload: UserDeleteRequest,
    current_user: dict = Depends(get_current_user),
    db=Depends(get_db),
):
    with db.cursor() as cursor:
        cursor.execute(
            "SELECT password_hash FROM users WHERE id = %s;", (current_user["id"],)
        )
        user = cursor.fetchone()

        if not user or not verify_password(payload.password, user["password_hash"]):
            raise HTTPException(status_code=400, detail="Incorrect password.")

        cursor.execute("DELETE FROM users WHERE id = %s;", (current_user["id"],))
        db.commit()

    return {"message": "Account and all associated chat history deleted successfully."}


# --------------------------------------------------------------------------
# Session + message routes
# --------------------------------------------------------------------------

@app.get("/api/sessions")
def get_user_sessions(current_user: dict = Depends(get_current_user), db=Depends(get_db)):
    user_id = current_user["id"]
    with db.cursor() as cursor:
        cursor.execute(
            "SELECT session_id FROM chat_sessions WHERE user_id = %s ORDER BY created_at ASC;",
            (user_id,),
        )
        sessions = cursor.fetchall()

        if not sessions:
            default_session_id = new_session_id()
            cursor.execute(
                "INSERT INTO chat_sessions (session_id, user_id) VALUES (%s, %s);",
                (default_session_id, user_id),
            )
            db.commit()
            sessions = [{"session_id": default_session_id}]

    return {"sessions": [s["session_id"] for s in sessions]}


@app.post("/api/sessions")
def create_session(current_user: dict = Depends(get_current_user), db=Depends(get_db)):
    user_id = current_user["id"]
    with db.cursor() as cursor:
        cursor.execute("SELECT COUNT(*) AS count FROM chat_sessions WHERE user_id = %s;", (user_id,))
        if cursor.fetchone()["count"] >= MAX_SESSIONS:
            raise HTTPException(
                status_code=400,
                detail=f"Maximum limit of {MAX_SESSIONS} concurrent chat sessions reached.",
            )

        session_id = new_session_id()
        cursor.execute(
            "INSERT INTO chat_sessions (session_id, user_id) VALUES (%s, %s);",
            (session_id, user_id),
        )
        db.commit()
    return {"status": "success", "session_id": session_id}


@app.delete("/api/sessions/{session_id}")
def delete_session(session_id: str, current_user: dict = Depends(get_current_user), db=Depends(get_db)):
    with db.cursor() as cursor:
        cursor.execute(
            "DELETE FROM chat_sessions WHERE session_id = %s AND user_id = %s;",
            (session_id, current_user["id"]),
        )
        db.commit()
    return {"status": "success"}


@app.get("/api/messages/{session_id}")
def get_session_messages(session_id: str, current_user: dict = Depends(get_current_user), db=Depends(get_db)):
    assert_session_owner(db, session_id, current_user["id"])
    with db.cursor() as cursor:
        cursor.execute(
            "SELECT role, content FROM chat_messages WHERE session_id = %s ORDER BY timestamp ASC, id ASC;",
            (session_id,),
        )
        messages = cursor.fetchall()

    return {
        "messages": [
            {"text": m["content"], "className": "user-message" if m["role"] == "user" else "ai-message"}
            for m in messages
        ]
    }


@app.delete("/api/messages/{session_id}")
def clear_session_messages(session_id: str, current_user: dict = Depends(get_current_user), db=Depends(get_db)):
    """Clear a chat's messages but keep the session itself."""
    assert_session_owner(db, session_id, current_user["id"])
    with db.cursor() as cursor:
        cursor.execute("DELETE FROM chat_messages WHERE session_id = %s;", (session_id,))
        db.commit()
    return {"status": "success"}


@app.post("/api/start")
async def start_session():
    return {
        "reply": (
            "Welcome to **Probability Models and Applications**! "
            "I am your AI teaching assistant. Ask me questions "
            "regarding random variables, stochastic processes, "
            "or Markov chains."
        )
    }


# Plain `def` (not async): the Groq and database calls are blocking, so FastAPI
# runs this in a worker thread instead of freezing the whole event loop.
@app.post("/api/chat")
def chat(payload: ChatRequest, current_user: dict = Depends(get_current_user), db=Depends(get_db)):
    assert_session_owner(db, payload.session_id, current_user["id"])

    conversation_messages = [
        {"role": m.role, "content": m.content}
        for m in payload.messages[-MAX_HISTORY_MESSAGES:]
    ]
    if not conversation_messages or conversation_messages[-1]["role"] != "user":
        raise HTTPException(status_code=400, detail="The last message must be from the user.")

    try:
        completion = client.chat.completions.create(
            model=MODEL_NAME,
            messages=[{"role": "system", "content": system_instruction}, *conversation_messages],
            temperature=0.6,
            max_tokens=4096,
        )
    except Exception as e:
        print(f"Groq API error: {e}")
        raise HTTPException(status_code=502, detail="The AI service failed. Please try again.")

    choice = completion.choices[0]
    reply = sanitize_math_notation(choice.message.content or "")

    if choice.finish_reason == "length":
        reply += (
            "\n\n*(This response may have been cut off — "
            "ask me to continue if it looks incomplete.)*"
        )

    with db.cursor() as cursor:
        cursor.execute(
            "INSERT INTO chat_messages (session_id, role, content) VALUES (%s, %s, %s);",
            (payload.session_id, "user", conversation_messages[-1]["content"]),
        )
        cursor.execute(
            "INSERT INTO chat_messages (session_id, role, content) VALUES (%s, %s, %s);",
            (payload.session_id, "assistant", reply),
        )
        db.commit()

    return {"reply": reply}


# --------------------------------------------------------------------------
# Frontend (only the static/ folder is served, never the project root)
# --------------------------------------------------------------------------

class NoCacheStaticFiles(StaticFiles):
    """Stops the browser from running stale copies of the JS while developing."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-store"
        return response


app.mount("/", NoCacheStaticFiles(directory=STATIC_DIR, html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "CSPML_LAB_05_EE26MT005:app",
        host="127.0.0.1",
        port=8000,
        reload=True,
    )
