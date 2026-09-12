import os
import re
from typing import Literal

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from groq import Groq


load_dotenv()

app = FastAPI(title="Teaching Agent API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

client = Groq(
    api_key=os.getenv("GROQ_API_KEY")
)

MODEL_NAME = os.getenv("LLM_MODEL")

CONTEXT_FILE = "context.md"

DEFAULT_SYSTEM_INSTRUCTION = (
    "You are an expert AI teaching assistant."
)


if os.path.exists(CONTEXT_FILE):
    with open(
        CONTEXT_FILE,
        "r",
        encoding="utf-8"
    ) as f:
        system_instruction = f.read()
else:
    system_instruction = DEFAULT_SYSTEM_INSTRUCTION


_PROTECTED_SPAN = re.compile(
    r"\$\$[\s\S]*?\$\$|\$(?!\$)[^$\n]*?\$(?!\$)"
)

_DISPLAY_MATH = re.compile(
    r"\\\[\s*([\s\S]*?)\s*\\\]"
)

_INLINE_MATH = re.compile(
    r"\\\(\s*([^\n]*?)\s*\\\)"
)

_PLACEHOLDER = "\x00MATH{}\x00"


def sanitize_math_notation(text: str) -> str:

    if not text:
        return text

    protected_spans = []

    def stash(match: re.Match) -> str:
        protected_spans.append(match.group(0))

        return _PLACEHOLDER.format(
            len(protected_spans) - 1
        )

    text = _PROTECTED_SPAN.sub(
        stash,
        text
    )

    text = _DISPLAY_MATH.sub(
        lambda match: (
            "$$\n"
            f"{match.group(1).strip()}"
            "\n$$"
        ),
        text
    )

    text = _INLINE_MATH.sub(
        lambda match: (
            "$"
            f"{match.group(1).strip()}"
            "$"
        ),
        text
    )

    for index, original in enumerate(protected_spans):
        text = text.replace(
            _PLACEHOLDER.format(index),
            original
        )

    return text


class HistoryMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    messages: list[HistoryMessage]


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


@app.post("/api/chat")
async def chat(payload: ChatRequest):
    try:
        conversation_messages = [
            {
                "role": message.role,
                "content": message.content
            }
            for message in payload.messages
        ]

        completion = client.chat.completions.create(
            model=MODEL_NAME,
            messages=[
                {
                    "role": "system",
                    "content": system_instruction
                },
                *conversation_messages
            ],
            temperature=0.6,
            max_tokens=4096,
        )

        choice = completion.choices[0]

        reply = sanitize_math_notation(
            choice.message.content or ""
        )

        if choice.finish_reason == "length":
            reply += (
                "\n\n*(This response may have been cut off — "
                "ask me to continue if it looks incomplete.)*"
            )

    except Exception as e:
        reply = (
            f"Error connecting to Groq API: {str(e)}"
        )

    return {
        "reply": reply
    }

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="127.0.0.1",
        port=8000,
        reload=True
    )
