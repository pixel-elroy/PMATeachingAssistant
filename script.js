"use strict";

const MAX_SESSIONS = 5;

const API_BASE_URL =
    window.location.protocol === "file:"
        ? "http://127.0.0.1:8000"
        : "";


const MATH_TOKEN_PREFIX = "MATHTOKEN";
const MATH_TOKEN_SUFFIX = "X";


let inputField;
let chatBox;
let sendBtn;
let clearBtn;
let newChatBtn;
let sessionTabsContainer;
let memoryDepthSlider;
let memoryDepthValue;
let logoutBtn;
let deleteAccountBtn;


let memoryDepth =
    Number(
        localStorage.getItem("memoryDepth") || 5
    );


let currentSessionId =
    localStorage.getItem(
        "activeSessionId"
    ) || null;


let sessionsList = [];

let isSending = false;

let appInitialized = false;

let authenticationVerified = false;

let redirecting = false;


const mathTokenStore =
    new Map();

let mathTokenCounter = 0;


class AuthError extends Error {}


/* --------------------------------------------------------------------------
   Navigation
   -------------------------------------------------------------------------- */

function navigateTo(filename) {

    if (redirecting) {
        return;
    }

    redirecting = true;

    window.location.href =
        new URL(
            filename,
            window.location.href
        ).href;
}


/* --------------------------------------------------------------------------
   Authentication
   -------------------------------------------------------------------------- */


/*
 * Explicit logout only.
 *
 * This is the ONLY normal path from index.html to login.html.
 */
function logout() {

    localStorage.removeItem(
        "access_token"
    );

    localStorage.removeItem(
        "activeSessionId"
    );

    navigateTo(
        "login.html"
    );
}


/*
 * Verify authentication once when index.html starts.
 *
 * This is deliberately separate from apiFetch().
 *
 * A random 401 from a later request must NOT cause navigation.
 */
let authFailure = null;

async function verifyAuthentication() {
    const token = localStorage.getItem("access_token");
    if (!token) {
        return false;
    }

    try {
        const response = await fetch(`${API_BASE_URL}/api/me`, {
            method: "GET",
            headers: { "Authorization": `Bearer ${token}` },
            cache: "no-store"
        });

        if (!response.ok) {
            let detail = "";
            try {
                const data = await response.json();
                if (data && typeof data.detail === "string") detail = data.detail;
            } catch (_) { /* ignore */ }

            authFailure = {
                status: response.status,
                detail,
                pid: response.headers.get("X-Server-PID")
            };
            console.warn("[app] /api/me rejected:", authFailure);
            // The token is deliberately NOT removed and there is NO redirect.
            // Only the Log Out button clears it.
            return false;
        }

        if (localStorage.getItem("access_token") !== token) {
            return false;
        }

        authenticationVerified = true;
        return true;

    } catch (error) {
        authFailure = { status: "network error", detail: String(error.message || error), pid: null };
        console.warn("[app] authentication check failed:", error);
        return false;
    }
}

function showAuthProblem(info) {
    const box = document.createElement("div");
    box.style.cssText =
        "position:fixed;top:0;left:0;right:0;z-index:1000;background:#3a1010;color:#fff;" +
        "border-bottom:2px solid #ff4d4d;padding:14px 18px;font-size:14px;line-height:1.6;";

    const text = document.createElement("div");
    text.textContent =
        `Could not verify your login. /api/me returned ${info.status}` +
        (info.detail ? ` ("${info.detail}")` : "") +
        `. Server that answered: PID ${info.pid || "unknown"}. ` +
        `Server that handled your login: PID ${sessionStorage.getItem("login_server_pid") || "unknown"}.`;

    const button = document.createElement("button");
    button.textContent = "Log out and try again";
    button.style.cssText = "margin-top:8px;padding:6px 12px;cursor:pointer;";
    button.addEventListener("click", logout);

    box.appendChild(text);
    box.appendChild(button);
    document.body.appendChild(box);
}

/*
 * Authenticated API request.
 *
 * IMPORTANT:
 *
 * There is intentionally NO redirect here.
 *
 * A 401 is returned to the caller as an ordinary failed response.
 */
async function apiFetch(
    path,
    options = {}
) {

    const token =
        localStorage.getItem(
            "access_token"
        );


    if (!token) {

        throw new AuthError(
            "No authentication token"
        );
    }


    const response =
        await fetch(
            `${API_BASE_URL}${path}`,
            {
                ...options,

                headers: {
                    "Content-Type":
                        "application/json",

                    "Authorization":
                        `Bearer ${token}`,

                    ...(options.headers || {})
                },

                cache: "no-store"
            }
        );


    if (
        response.status === 401
    ) {

        console.warn(
            `[app] API returned 401: ${path}`
        );

        /*
         * DO NOT redirect.
         *
         * DO NOT delete localStorage.
         *
         * DO NOT navigate to login.html.
         *
         * This is the crucial change.
         */
        throw new AuthError(
            `Authentication rejected by ${path}`
        );
    }


    return response;
}


async function readError(
    response
) {

    try {

        const data =
            await response.json();


        if (
            data &&
            typeof data.detail ===
                "string"
        ) {

            return data.detail;
        }

    } catch (_) {
        // Ignore malformed responses.
    }


    return `HTTP error ${response.status}`;
}


/* --------------------------------------------------------------------------
   Startup
   -------------------------------------------------------------------------- */

async function initializeApp() {

    if (appInitialized) {
        return;
    }


    /*
     * There is no token at all.
     * This is a genuine unauthenticated visit.
     */
    if (
        !localStorage.getItem(
            "access_token"
        )
    ) {

        navigateTo(
            "login.html"
        );

        return;
    }


    /*
     * Verify the token before initializing the dashboard.
     */
    const authenticated = await verifyAuthentication();

    if (!authenticated) {
        // Show WHY instead of redirecting; redirecting is what looped.
        if (authFailure) {
            showAuthProblem(authFailure);
        }
        return;
    }

    appInitialized = true;


    inputField =
        document.getElementById(
            "userInput"
        );

    chatBox =
        document.getElementById(
            "chatBox"
        );

    sendBtn =
        document.getElementById(
            "sendBtn"
        );

    clearBtn =
        document.getElementById(
            "clearBtn"
        );

    newChatBtn =
        document.getElementById(
            "newChatBtn"
        );

    sessionTabsContainer =
        document.getElementById(
            "sessionTabs"
        );

    memoryDepthSlider =
        document.getElementById(
            "memoryDepth"
        );

    memoryDepthValue =
        document.getElementById(
            "memoryDepthValue"
        );

    logoutBtn =
        document.getElementById(
            "logoutBtn"
        );

    deleteAccountBtn =
        document.getElementById(
            "deleteAccountBtn"
        );


    const missing = [];


    if (!inputField)
        missing.push("userInput");

    if (!chatBox)
        missing.push("chatBox");

    if (!sendBtn)
        missing.push("sendBtn");

    if (!clearBtn)
        missing.push("clearBtn");

    if (!newChatBtn)
        missing.push("newChatBtn");

    if (!sessionTabsContainer)
        missing.push("sessionTabs");

    if (!memoryDepthSlider)
        missing.push("memoryDepth");

    if (!memoryDepthValue)
        missing.push("memoryDepthValue");


    if (missing.length > 0) {

        console.error(
            "Missing required HTML elements:",
            missing
        );

        return;
    }


    configureMarkdown();

    bindEvents();

    initializeMemoryDepth();


    /*
     * If this request gets a 401, it will NOT redirect.
     */
    try {

        if (
            await fetchSessionsFromServer()
        ) {

            await loadCurrentSessionMessages();
        }

    } catch (error) {

        console.error(
            "[app] startup data loading failed:",
            error
        );
    }
}


/* --------------------------------------------------------------------------
   Events
   -------------------------------------------------------------------------- */

function bindEvents() {

    sendBtn.addEventListener(
        "click",
        sendMessage
    );


    clearBtn.addEventListener(
        "click",
        clearCurrentChat
    );


    newChatBtn.addEventListener(
        "click",
        createNewSession
    );


    inputField.addEventListener(
        "keydown",
        (event) => {

            if (
                event.key === "Enter"
            ) {

                event.preventDefault();

                sendMessage();
            }
        }
    );


    memoryDepthSlider.addEventListener(
        "input",
        () => {

            memoryDepth =
                Number(
                    memoryDepthSlider.value
                );


            localStorage.setItem(
                "memoryDepth",
                String(memoryDepth)
            );


            updateMemoryDepthLabel();
        }
    );


    if (logoutBtn) {

        logoutBtn.addEventListener(
            "click",
            logout
        );
    }


    if (deleteAccountBtn) {

        deleteAccountBtn.addEventListener(
            "click",
            deleteAccount
        );
    }
}


/* --------------------------------------------------------------------------
   Account deletion
   -------------------------------------------------------------------------- */

async function deleteAccount() {

    const password =
        prompt(
            "Enter your password to permanently delete your account and all chat history:"
        );


    if (!password) {
        return;
    }


    try {

        const response =
            await apiFetch(
                "/api/user/delete",
                {
                    method: "POST",

                    body: JSON.stringify({
                        password
                    })
                }
            );


        if (response.ok) {

            alert(
                "Account and chat history deleted successfully."
            );


            localStorage.clear();


            navigateTo(
                "login.html"
            );

        } else {

            alert(
                `Failed: ${await readError(response)}`
            );
        }

    } catch (error) {

        if (
            error instanceof AuthError
        ) {

            alert(
                "The server rejected the authentication for this operation. Your current page has been left open."
            );

            return;
        }


        alert(
            "Network error during account deletion."
        );
    }
}


/* --------------------------------------------------------------------------
   Markdown + math
   -------------------------------------------------------------------------- */

function configureMarkdown() {

    if (!window.marked) {

        console.error(
            "Marked failed to load."
        );

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


    text =
        String(
            text ?? ""
        );


    const protectedCode = [];


    text =
        text.replace(
            /```[\s\S]*?```|`[^`\n]*`/g,
            (match) => {

                const token =
                    `CODETOKEN${protectedCode.length}X`;

                protectedCode.push(
                    match
                );

                return token;
            }
        );


    text =
        text
            .replace(
                /\\\[([\s\S]*?)\\\]/g,
                (_, content) =>
                    `$$${content.trim()}$$`
            )
            .replace(
                /\\\(([\s\S]*?)\\\)/g,
                (_, content) =>
                    `$${content.trim()}$`
            );


    function saveMath(
        content,
        displayMode
    ) {

        const token =
            `${MATH_TOKEN_PREFIX}${mathTokenCounter++}${MATH_TOKEN_SUFFIX}`;


        mathTokenStore.set(
            token,
            {
                content:
                    content.trim(),

                display:
                    displayMode
            }
        );


        return token;
    }


    text =
        text.replace(
            /\$\$([\s\S]*?)\$\$/g,
            (_, content) =>
                saveMath(
                    content,
                    true
                )
        );


    text =
        text.replace(
            /\$([^$\n]+?)\$/g,
            (_, content) =>
                saveMath(
                    content,
                    false
                )
        );


    protectedCode.forEach(
        (code, index) => {

            text =
                text.replace(
                    `CODETOKEN${index}X`,
                    () => code
                );
        }
    );


    return text;
}


function renderMathTokens(html) {

    for (
        const [token, math]
        of mathTokenStore.entries()
    ) {

        let rendered;


        if (window.katex) {

            try {

                rendered =
                    window.katex.renderToString(
                        math.content,
                        {
                            displayMode:
                                math.display,

                            throwOnError:
                                false,

                            strict:
                                "ignore",

                            trust:
                                false
                        }
                    );

            } catch (_) {

                rendered =
                    `<code>${escapeHtml(
                        math.content
                    )}</code>`;
            }

        } else {

            rendered =
                `<code>${escapeHtml(
                    math.content
                )}</code>`;
        }


        html =
            html
                .split(token)
                .join(rendered);
    }


    mathTokenStore.clear();


    return html;
}


function escapeHtml(text) {

    const element =
        document.createElement(
            "div"
        );


    element.textContent =
        String(text ?? "");


    return element.innerHTML;
}


function renderMarkdown(text) {

    text =
        String(
            text ?? ""
        );


    if (
        !window.marked ||
        !window.DOMPurify
    ) {

        return escapeHtml(
            text
        );
    }


    const protectedText =
        protectMath(text);


    const safeHtml =
        DOMPurify.sanitize(
            marked.parse(
                protectedText
            )
        );


    return renderMathTokens(
        safeHtml
    );
}


/* --------------------------------------------------------------------------
   Sessions
   -------------------------------------------------------------------------- */

async function fetchSessionsFromServer() {

    try {

        const response =
            await apiFetch(
                "/api/sessions",
                {
                    method: "GET"
                }
            );


        if (!response.ok) {

            throw new Error(
                await readError(response)
            );
        }


        const data =
            await response.json();


        sessionsList =
            data.sessions || [];


        if (
            sessionsList.length === 0
        ) {

            return false;
        }


        if (
            !currentSessionId ||
            !sessionsList.includes(
                currentSessionId
            )
        ) {

            currentSessionId =
                sessionsList[0];


            localStorage.setItem(
                "activeSessionId",
                currentSessionId
            );
        }


        renderTabs();


        return true;

    } catch (error) {

        if (
            error instanceof AuthError
        ) {

            console.warn(
                "[app] session request was rejected."
            );

            return false;
        }


        console.error(
            "Error loading sessions:",
            error
        );


        appendMessageNode(
            "Could not load your chats. Is the server running?",
            "ai-message",
            true
        );


        return false;
    }
}


function renderTabs() {

    if (
        !sessionTabsContainer
    ) {
        return;
    }


    sessionTabsContainer.innerHTML =
        "";


    sessionsList.forEach(
        (id, index) => {

            const tabWrapper =
                document.createElement(
                    "div"
                );


            tabWrapper.className =
                "tab-wrapper";


            const button =
                document.createElement(
                    "button"
                );


            button.type =
                "button";


            button.className =
                `tab-btn ${
                    id === currentSessionId
                        ? "active"
                        : ""
                }`;


            button.textContent =
                `Chat ${index + 1}`;


            button.addEventListener(
                "click",
                () =>
                    switchSession(id)
            );


            tabWrapper.appendChild(
                button
            );


            if (
                sessionsList.length > 1
            ) {

                const closeButton =
                    document.createElement(
                        "button"
                    );


                closeButton.type =
                    "button";


                closeButton.className =
                    "tab-close";


                closeButton.textContent =
                    "×";


                closeButton.title =
                    "Delete this chat";


                closeButton.addEventListener(
                    "click",
                    (event) => {

                        event.stopPropagation();

                        deleteSessionServer(
                            id
                        );
                    }
                );


                tabWrapper.appendChild(
                    closeButton
                );
            }


            sessionTabsContainer.appendChild(
                tabWrapper
            );
        }
    );
}


async function switchSession(id) {

    if (
        id === currentSessionId
    ) {
        return;
    }


    currentSessionId =
        id;


    localStorage.setItem(
        "activeSessionId",
        currentSessionId
    );


    renderTabs();


    await loadCurrentSessionMessages();
}


async function createNewSession() {

    if (
        sessionsList.length >=
        MAX_SESSIONS
    ) {

        alert(
            `Maximum limit of ${MAX_SESSIONS} concurrent chat sessions reached.`
        );

        return;
    }


    try {

        const response =
            await apiFetch(
                "/api/sessions",
                {
                    method: "POST"
                }
            );


        if (!response.ok) {

            alert(
                await readError(response)
            );

            return;
        }


        const data =
            await response.json();


        await fetchSessionsFromServer();


        await switchSession(
            data.session_id
        );

    } catch (error) {

        if (
            error instanceof AuthError
        ) {

            alert(
                "The server rejected the authentication for this request. You have not been redirected."
            );

            return;
        }


        console.error(
            "Error creating session:",
            error
        );
    }
}


async function deleteSessionServer(id) {

    if (
        !confirm(
            "Delete this chat and its history?"
        )
    ) {

        return;
    }


    try {

        const wasCurrent =
            id === currentSessionId;


        const response =
            await apiFetch(
                `/api/sessions/${encodeURIComponent(id)}`,
                {
                    method: "DELETE"
                }
            );


        if (!response.ok) {
            return;
        }


        if (wasCurrent) {

            currentSessionId =
                null;


            localStorage.removeItem(
                "activeSessionId"
            );
        }


        if (
            await fetchSessionsFromServer() &&
            wasCurrent
        ) {

            await loadCurrentSessionMessages();
        }

    } catch (error) {

        if (
            error instanceof AuthError
        ) {

            alert(
                "Authentication was rejected. The page has been left open."
            );

            return;
        }


        console.error(
            "Error deleting session:",
            error
        );
    }
}


async function clearCurrentChat() {

    if (!currentSessionId) {
        return;
    }


    try {

        const response =
            await apiFetch(
                `/api/messages/${encodeURIComponent(currentSessionId)}`,
                {
                    method: "DELETE"
                }
            );


        if (!response.ok) {

            alert(
                await readError(response)
            );

            return;
        }


        await loadCurrentSessionMessages();

    } catch (error) {

        if (
            error instanceof AuthError
        ) {

            alert(
                "Authentication was rejected. The page has been left open."
            );

            return;
        }


        console.error(
            "Error clearing chat:",
            error
        );
    }
}


/* --------------------------------------------------------------------------
   Memory
   -------------------------------------------------------------------------- */

function initializeMemoryDepth() {

    if (
        !Number.isFinite(
            memoryDepth
        )
    ) {

        memoryDepth = 5;
    }


    memoryDepth =
        Math.max(
            0,
            Math.min(
                20,
                Math.round(
                    memoryDepth
                )
            )
        );


    memoryDepthSlider.value =
        String(memoryDepth);


    updateMemoryDepthLabel();
}


function updateMemoryDepthLabel() {

    if (!memoryDepthValue) {
        return;
    }


    if (
        memoryDepth === 0
    ) {

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


/* --------------------------------------------------------------------------
   Messages
   -------------------------------------------------------------------------- */

function appendMessageNode(
    text,
    className,
    local = false
) {

    if (!chatBox) {
        return;
    }


    const element =
        document.createElement(
            "div"
        );


    element.className =
        `message ${className}`;


    element.dataset.raw =
        text;


    if (local) {
        element.dataset.local = "1";
    }


    if (
        className ===
        "ai-message"
    ) {

        element.innerHTML =
            renderMarkdown(text);

    } else {

        element.textContent =
            text;
    }


    chatBox.appendChild(
        element
    );
}


async function loadCurrentSessionMessages() {

    if (
        !chatBox ||
        !currentSessionId
    ) {

        return;
    }


    const requestedSession =
        currentSessionId;


    chatBox.innerHTML =
        "";


    const typingId =
        showTypingIndicator();


    try {

        const response =
            await apiFetch(
                `/api/messages/${encodeURIComponent(requestedSession)}`,
                {
                    method: "GET"
                }
            );


        if (!response.ok) {

            throw new Error(
                await readError(response)
            );
        }


        const data =
            await response.json();


        if (
            requestedSession !==
            currentSessionId
        ) {

            return;
        }


        removeTypingIndicator(
            typingId
        );


        if (
            data.messages &&
            data.messages.length > 0
        ) {

            data.messages.forEach(
                (msg) => {

                    appendMessageNode(
                        msg.text,
                        msg.className
                    );
                }
            );

        } else {

            const startRes =
                await fetch(
                    `${API_BASE_URL}/api/start`,
                    {
                        method: "POST",
                        cache: "no-store"
                    }
                );


            if (!startRes.ok) {

                throw new Error(
                    `HTTP error ${startRes.status}`
                );
            }


            const startData =
                await startRes.json();


            appendMessageNode(
                startData.reply,
                "ai-message",
                true
            );
        }

    } catch (error) {

        removeTypingIndicator(
            typingId
        );


        if (
            error instanceof AuthError
        ) {

            console.warn(
                "[app] Could not load messages because authentication was rejected."
            );

            appendMessageNode(
                "The server rejected the authentication for this request. You have not been redirected.",
                "ai-message",
                true
            );

            return;
        }


        console.error(
            "Failed to load session messages:",
            error
        );


        appendMessageNode(
            "Welcome to Probability Models and Applications!",
            "ai-message",
            true
        );
    }


    scrollToBottom();
}


function collectHistory() {

    const elements =
        chatBox.querySelectorAll(
            ".message:not(.typing-indicator):not([data-local])"
        );


    return Array
        .from(elements)
        .filter(
            (el) =>
                typeof el.dataset.raw ===
                "string"
        )
        .map(
            (el) => ({
                role:
                    el.classList.contains(
                        "user-message"
                    )
                        ? "user"
                        : "assistant",

                content:
                    el.dataset.raw
            })
        );
}


async function sendMessage() {

    if (
        !inputField ||
        !currentSessionId ||
        isSending
    ) {

        return;
    }


    const text =
        inputField.value.trim();


    if (!text) {
        return;
    }


    const history =
        collectHistory();


    const keep =
        memoryDepth * 2;


    const messages = [
        ...(
            keep > 0
                ? history.slice(-keep)
                : []
        ),

        {
            role: "user",
            content: text
        }
    ];


    appendMessageNode(
        text,
        "user-message"
    );


    inputField.value =
        "";


    scrollToBottom();


    isSending = true;

    sendBtn.disabled = true;


    const typingId =
        showTypingIndicator();


    try {

        const response =
            await apiFetch(
                "/api/chat",
                {
                    method: "POST",

                    body: JSON.stringify({
                        session_id:
                            currentSessionId,

                        messages
                    })
                }
            );


        if (!response.ok) {

            throw new Error(
                await readError(response)
            );
        }


        const data =
            await response.json();


        removeTypingIndicator(
            typingId
        );


        appendMessageNode(
            data.reply ||
                "Error: No reply received.",
            "ai-message"
        );

    } catch (error) {

        removeTypingIndicator(
            typingId
        );


        if (
            error instanceof AuthError
        ) {

            appendMessageNode(
                "The server rejected the authentication for this request. You have not been redirected.",
                "ai-message",
                true
            );

        } else {

            appendMessageNode(
                `Error: ${error.message}`,
                "ai-message",
                true
            );
        }

    } finally {

        isSending = false;

        sendBtn.disabled = false;
    }


    scrollToBottom();
}


/* --------------------------------------------------------------------------
   UI helpers
   -------------------------------------------------------------------------- */

function showTypingIndicator() {

    if (!chatBox) {
        return null;
    }


    const typingElement =
        document.createElement(
            "div"
        );


    typingElement.className =
        "message ai-message typing-indicator";


    typingElement.id =
        `typing-${Date.now()}`;


    typingElement.innerHTML =
        "<span></span><span></span><span></span>";


    chatBox.appendChild(
        typingElement
    );


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


/* --------------------------------------------------------------------------
   Start
   -------------------------------------------------------------------------- */

if (
    document.readyState ===
    "loading"
) {

    document.addEventListener(
        "DOMContentLoaded",
        initializeApp
    );

} else {

    initializeApp();
}
