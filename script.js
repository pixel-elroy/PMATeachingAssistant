"use strict";

const MAX_SESSIONS = 5;
const API_BASE_URL = "http://127.0.0.1:8000";

const MATH_TOKEN_PREFIX = "MATH_TOKEN_";

let inputField;
let chatBox;
let sendBtn;
let clearBtn;
let newChatBtn;
let sessionTabsContainer;
let memoryDepthSlider;
let memoryDepthValue;

let memoryDepth = Number(
    localStorage.getItem("memoryDepth") || 5
);

let currentSessionId =
    localStorage.getItem("activeSessionId") || "session_1";

let mathTokenStore = new Map();
let mathTokenCounter = 0;

let appInitialized = false;

function initializeApp() {
    if (appInitialized) {
        return;
    }

    appInitialized = true;

    inputField = document.getElementById("userInput");
    chatBox = document.getElementById("chatBox");
    sendBtn = document.getElementById("sendBtn");
    clearBtn = document.getElementById("clearBtn");
    newChatBtn = document.getElementById("newChatBtn");
    sessionTabsContainer = document.getElementById("sessionTabs");
    memoryDepthSlider = document.getElementById("memoryDepth");
    memoryDepthValue = document.getElementById("memoryDepthValue");

    const missingElements = [];

    if (!inputField) missingElements.push("userInput");
    if (!chatBox) missingElements.push("chatBox");
    if (!sendBtn) missingElements.push("sendBtn");
    if (!clearBtn) missingElements.push("clearBtn");
    if (!newChatBtn) missingElements.push("newChatBtn");
    if (!sessionTabsContainer) missingElements.push("sessionTabs");
    if (!memoryDepthSlider) missingElements.push("memoryDepth");
    if (!memoryDepthValue) missingElements.push("memoryDepthValue");

    if (missingElements.length > 0) {
        console.error(
            "Missing required HTML elements:",
            missingElements
        );

        return;
    }

    configureMarkdown();
    initSessions();
    renderTabs();
    initializeMemoryDepth();
    loadCurrentSessionMessages();

    sendBtn.addEventListener("click", sendMessage);
    clearBtn.addEventListener("click", clearCurrentChat);
    newChatBtn.addEventListener("click", createNewSession);

    memoryDepthSlider.addEventListener("input", () => {
        memoryDepth = Number(memoryDepthSlider.value);

        localStorage.setItem(
            "memoryDepth",
            String(memoryDepth)
        );

        updateMemoryDepthLabel();
    });

    inputField.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            sendMessage();
        }
    });
}

function configureMarkdown() {
    if (!window.marked) {
        console.error("Marked failed to load.");
        return false;
    }

    marked.setOptions({
        gfm: true,
        breaks: true
    });

    return true;
}

function protectMath(text) {
    mathTokenStore.clear();
    mathTokenCounter = 0;

    text = String(text ?? "");

    const protectedCode = [];

    text = text.replace(
        /```[\s\S]*?```|`[^`\n]*`/g,
        (match) => {
            const token = `CODE_TOKEN_${protectedCode.length}`;

            protectedCode.push(match);

            return token;
        }
    );

    text = text
        .replace(
            /\\\[([\s\S]*?)\\\]/g,
            (_, content) => `$$${content.trim()}$$`
        )
        .replace(
            /\\\(([\s\S]*?)\\\)/g,
            (_, content) => `$${content.trim()}$`
        );

    function saveMath(content, displayMode) {
        const token =
            `${MATH_TOKEN_PREFIX}${mathTokenCounter++}__`;

        mathTokenStore.set(token, {
            content: content.trim(),
            display: displayMode
        });

        return token;
    }

    text = text.replace(
        /\$\$([\s\S]*?)\$\$/g,
        (_, content) => saveMath(content, true)
    );

    text = text.replace(
        /\$([^$\n]+?)\$/g,
        (_, content) => saveMath(content, false)
    );

    protectedCode.forEach((code, index) => {
        text = text.replace(
            `CODE_TOKEN_${index}`,
            code
        );
    });

    return text;
}

function renderMathTokens(html) {
    for (const [token, math] of mathTokenStore.entries()) {
        let rendered;

        if (window.katex) {
            try {
                rendered = window.katex.renderToString(
                    math.content,
                    {
                        displayMode: math.display,
                        throwOnError: false,
                        strict: "ignore",
                        trust: false
                    }
                );
            } catch (error) {
                console.warn(
                    "KaTeX rendering failed:",
                    error
                );

                rendered =
                    `<code>${escapeHtml(math.content)}</code>`;
            }
        } else {
            console.warn(
                "KaTeX is not available. Displaying raw math."
            );

            rendered =
                `<code>${escapeHtml(math.content)}</code>`;
        }

        const escapedToken = escapeHtml(token);

        html = html
            .split(token)
            .join(rendered);

        html = html
            .split(escapedToken)
            .join(rendered);
    }

    mathTokenStore.clear();

    return html;
}

function escapeHtml(text) {
    const element = document.createElement("div");

    element.textContent = String(text ?? "");

    return element.innerHTML;
}

function renderMarkdown(text) {
    text = String(text ?? "");

    if (!window.marked) {
        return escapeHtml(text);
    }

    const protectedText = protectMath(text);

    const markdownHtml = marked.parse(protectedText);

    return renderMathTokens(markdownHtml);
}

function getSessions() {
    try {
        const savedSessions =
            localStorage.getItem("chatSessions");

        const sessions = JSON.parse(
            savedSessions || '{"session_1":[]}'
        );

        if (
            !sessions ||
            typeof sessions !== "object" ||
            Array.isArray(sessions)
        ) {
            throw new Error("Invalid session structure.");
        }

        return sessions;
    } catch (error) {
        console.warn(
            "Invalid saved sessions; resetting.",
            error
        );

        return {
            session_1: []
        };
    }
}

function saveSessions(sessions) {
    localStorage.setItem(
        "chatSessions",
        JSON.stringify(sessions)
    );
}

function initSessions() {
    let sessions = getSessions();

    if (Object.keys(sessions).length === 0) {
        sessions = {
            session_1: []
        };

        saveSessions(sessions);
    }

    if (!sessions[currentSessionId]) {
        currentSessionId = Object.keys(sessions)[0];

        localStorage.setItem(
            "activeSessionId",
            currentSessionId
        );
    }
}

function renderTabs() {
    if (!sessionTabsContainer) {
        return;
    }

    const sessions = getSessions();
    const sessionIds = Object.keys(sessions);

    sessionTabsContainer.innerHTML = "";

    sessionIds.forEach((id, index) => {
        const tabWrapper =
            document.createElement("div");

        tabWrapper.className = "tab-wrapper";

        const button =
            document.createElement("button");

        button.type = "button";

        button.className =
            `tab-btn ${
                id === currentSessionId
                    ? "active"
                    : ""
            }`;

        button.textContent = `Chat ${index + 1}`;

        button.addEventListener(
            "click",
            () => switchSession(id)
        );

        tabWrapper.appendChild(button);

        if (sessionIds.length > 1) {
            const closeButton =
                document.createElement("button");

            closeButton.type = "button";
            closeButton.className = "tab-close";
            closeButton.textContent = "×";
            closeButton.title = "Delete this chat";

            closeButton.setAttribute(
                "aria-label",
                `Delete Chat ${index + 1}`
            );

            closeButton.addEventListener(
                "click",
                (event) => {
                    event.stopPropagation();
                    deleteSession(id);
                }
            );

            tabWrapper.appendChild(closeButton);
        }

        sessionTabsContainer.appendChild(tabWrapper);
    });
}

function switchSession(id) {
    currentSessionId = id;

    localStorage.setItem(
        "activeSessionId",
        currentSessionId
    );

    renderTabs();
    loadCurrentSessionMessages();
}


function createNewSession() {
    const sessions = getSessions();

    if (Object.keys(sessions).length >= MAX_SESSIONS) {
        alert(
            "Maximum limit of 5 concurrent chat sessions reached."
        );

        return;
    }

    const newId = `session_${Date.now()}`;

    sessions[newId] = [];

    saveSessions(sessions);

    switchSession(newId);
}


function deleteSession(id) {
    const sessions = getSessions();

    delete sessions[id];

    const remainingKeys =
        Object.keys(sessions);

    if (remainingKeys.length === 0) {
        sessions.session_1 = [];
        currentSessionId = "session_1";
    } else if (currentSessionId === id) {
        currentSessionId = remainingKeys[0];
    }

    saveSessions(sessions);

    localStorage.setItem(
        "activeSessionId",
        currentSessionId
    );

    renderTabs();
    loadCurrentSessionMessages();
}


function initializeMemoryDepth() {
    if (!memoryDepthSlider || !memoryDepthValue) {
        return;
    }

    if (!Number.isFinite(memoryDepth)) {
        memoryDepth = 5;
    }

    memoryDepth = Math.max(
        0,
        Math.min(20, Math.round(memoryDepth))
    );

    memoryDepthSlider.value = String(memoryDepth);

    updateMemoryDepthLabel();
}

function updateMemoryDepthLabel() {
    if (!memoryDepthValue) {
        return;
    }

    if (memoryDepth === 0) {
        memoryDepthValue.textContent =
            "No previous exchanges";

        return;
    }

    const unit =
        memoryDepth === 1
            ? "exchange"
            : "exchanges";

    memoryDepthValue.textContent =
        `${memoryDepth} ${unit}`;
}

function getMessagesForModel(
    messages,
    currentQuestion
) {
    const previousMessages =
        Array.isArray(messages)
            ? messages
            : [];

    const messageCount = memoryDepth * 2;

    const selectedMessages =
        messageCount > 0
            ? previousMessages.slice(-messageCount)
            : [];

    return [
        ...selectedMessages.map((message) => ({
            role:
                message.className === "user-message"
                    ? "user"
                    : "assistant",

            content: String(
                message.text ?? ""
            )
        })),

        {
            role: "user",
            content: currentQuestion
        }
    ];
}

async function loadCurrentSessionMessages() {
    if (!chatBox) {
        return;
    }

    chatBox.innerHTML = "";

    const sessions = getSessions();

    const messages =
        sessions[currentSessionId] || [];

    if (messages.length === 0) {
        const typingId =
            showTypingIndicator();

        try {
            const response = await fetch(
                `${API_BASE_URL}/api/start`,
                {
                    method: "POST"
                }
            );

            if (!response.ok) {
                throw new Error(
                    `HTTP error! status: ${response.status}`
                );
            }

            const data = await response.json();

            removeTypingIndicator(typingId);

            appendMessage(
                data.reply ||
                    "Welcome to Probability Models and Applications!",
                "ai-message",
                true
            );
        } catch (error) {
            removeTypingIndicator(typingId);

            console.error(
                "Failed to load welcome message:",
                error
            );

            appendMessage(
                "Welcome to Probability Models and Applications. Let's get started!",
                "ai-message",
                true
            );
        }
    } else {
        messages.forEach((message) => {
            appendMessage(
                message.text,
                message.className,
                false
            );
        });
    }

    scrollToBottom();
}

async function sendMessage() {
    if (!inputField) {
        return;
    }

    const text = inputField.value.trim();

    if (!text) {
        return;
    }

    const sessions = getSessions();

    const currentMessages =
        sessions[currentSessionId] || [];

    const modelMessages =
        getMessagesForModel(
            currentMessages,
            text
        );

    appendMessage(
        text,
        "user-message",
        true
    );

    inputField.value = "";

    scrollToBottom();

    const typingId =
        showTypingIndicator();

    try {
        const response = await fetch(
            `${API_BASE_URL}/api/chat`,
            {
                method: "POST",

                headers: {
                    "Content-Type": "application/json"
                },

                body: JSON.stringify({
                    messages: modelMessages
                })
            }
        );

        if (!response.ok) {
            throw new Error(
                `HTTP error! status: ${response.status}`
            );
        }

        const data = await response.json();

        removeTypingIndicator(typingId);

        appendMessage(
            data.reply ||
                "Error: No reply received.",
            "ai-message",
            true
        );
    } catch (error) {
        removeTypingIndicator(typingId);

        console.error(
            "Chat error:",
            error
        );

        appendMessage(
            `Error: ${error.message}`,
            "ai-message",
            true
        );
    }

    scrollToBottom();
}

function appendMessage(
    text,
    className,
    saveToStorage = true
) {
    if (!chatBox) {
        return;
    }

    const messageElement =
        document.createElement("div");

    messageElement.className =
        `message ${className}`;

    if (className === "ai-message") {
        messageElement.innerHTML =
            renderMarkdown(text);
    } else {
        messageElement.textContent = text;
    }

    chatBox.appendChild(messageElement);

    if (saveToStorage) {
        const sessions = getSessions();

        if (!sessions[currentSessionId]) {
            sessions[currentSessionId] = [];
        }

        sessions[currentSessionId].push({
            text,
            className
        });

        saveSessions(sessions);
    }
}

function clearCurrentChat() {
    const sessions = getSessions();

    sessions[currentSessionId] = [];

    saveSessions(sessions);

    loadCurrentSessionMessages();
}

function showTypingIndicator() {
    if (!chatBox) {
        return null;
    }

    const typingElement =
        document.createElement("div");

    typingElement.className =
        "message ai-message typing-indicator";

    typingElement.id =
        `typing-${Date.now()}`;

    typingElement.innerHTML =
        "<span></span><span></span><span></span>";

    chatBox.appendChild(typingElement);

    scrollToBottom();

    return typingElement.id;
}

function removeTypingIndicator(id) {
    if (!id) {
        return;
    }

    const indicator =
        document.getElementById(id);

    if (indicator) {
        indicator.remove();
    }
}

function scrollToBottom() {
    if (!chatBox) {
        return;
    }

    chatBox.scrollTop =
        chatBox.scrollHeight;
}

if (document.readyState === "loading") {
    document.addEventListener(
        "DOMContentLoaded",
        initializeApp
    );
} else {
    initializeApp();
}
