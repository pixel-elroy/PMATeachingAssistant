"use strict";

const API_BASE_URL =
    window.location.protocol === "file:"
        ? "http://127.0.0.1:8000"
        : "";

let redirecting = false;
let authenticationInProgress = false;
let startupCheckController = null;


function navigateTo(filename) {
    if (redirecting) {
        return;
    }

    redirecting = true;

    window.location.href =
        new URL(filename, window.location.href).href;
}


function errorMessage(data, fallback) {
    if (
        data &&
        typeof data.detail === "string"
    ) {
        return data.detail;
    }

    if (
        data &&
        Array.isArray(data.detail) &&
        data.detail.length > 0
    ) {
        return data.detail
            .map((item) => item.msg)
            .join(" ");
    }

    return fallback;
}


document.addEventListener(
    "DOMContentLoaded",
    () => {

        const emailInput =
            document.getElementById("authEmail");

        const passwordInput =
            document.getElementById("authPassword");

        const loginBtn =
            document.getElementById("loginBtn");

        const registerBtn =
            document.getElementById("registerBtn");

        const errorText =
            document.getElementById("authError");


        function showError(message) {
            errorText.style.color = "#ff6b6b";
            errorText.textContent = message;
        }


        function showInfo(message) {
            errorText.style.color = "#39ff14";
            errorText.textContent = message;
        }


        function setBusy(busy) {
            loginBtn.disabled = busy;
            registerBtn.disabled = busy;
        }


        /*
         * Check whether the token that was present when this page loaded
         * is actually valid.
         *
         * IMPORTANT:
         *
         * This check is only allowed to perform one action:
         *
         *     valid token -> go to index.html
         *
         * It must never interfere with a login/register operation that
         * subsequently started.
         */

        const initialToken =
            localStorage.getItem("access_token");


        if (initialToken) {

            startupCheckController =
                new AbortController();


            fetch(
                `${API_BASE_URL}/api/me`,
                {
                    method: "GET",

                    headers: {
                        "Authorization":
                            `Bearer ${initialToken}`
                    },

                    signal:
                        startupCheckController.signal,

                    cache: "no-store"
                }
            )
                .then((response) => {

                    /*
                     * Ignore the result if the user has started a new
                     * authentication operation.
                     */
                    if (
                        authenticationInProgress ||
                        redirecting
                    ) {
                        return;
                    }


                    /*
                     * Most important race protection:
                     *
                     * The token that was checked must still be the
                     * token currently stored.
                     */
                    const currentToken =
                        localStorage.getItem(
                            "access_token"
                        );


                    if (
                        currentToken !==
                        initialToken
                    ) {
                        return;
                    }


                    if (response.ok) {

                        navigateTo(
                            "index.html"
                        );

                    } else {

                        /*
                         * The token really was rejected by /api/me.
                         * This is the ONLY situation in which this page
                         * automatically removes the stored token.
                         */
                        localStorage.removeItem(
                            "access_token"
                        );

                        localStorage.removeItem(
                            "activeSessionId"
                        );
                    }
                })
                .catch((error) => {

                    /*
                     * A network failure is NOT an authentication failure.
                     *
                     * Do not remove the token.
                     * Do not redirect.
                     */
                    if (
                        error.name !==
                        "AbortError"
                    ) {
                        console.warn(
                            "[auth] /api/me check failed:",
                            error
                        );
                    }
                });
        }


        async function login(
            email,
            password
        ) {

            const body =
                new URLSearchParams();

            body.append(
                "username",
                email
            );

            body.append(
                "password",
                password
            );


            const response =
                await fetch(
                    `${API_BASE_URL}/api/login`,
                    {
                        method: "POST",

                        headers: {
                            "Content-Type":
                                "application/x-www-form-urlencoded"
                        },

                        body,

                        cache: "no-store"
                    }
                );


            const data =
                await response
                    .json()
                    .catch(() => ({}));


            if (!response.ok) {

                showError(
                    errorMessage(
                        data,
                        "Login failed."
                    )
                );

                return false;
            }


            /*
             * Stop the old startup check BEFORE replacing the token.
             */
            if (startupCheckController) {
                startupCheckController.abort();
                startupCheckController = null;
            }


            sessionStorage.setItem(
                "login_server_pid",
                response.headers.get("X-Server-PID") || ""
            );

            localStorage.setItem(
                "access_token",
                data.access_token
            );


            localStorage.removeItem(
                "activeSessionId"
            );


            navigateTo(
                "index.html"
            );


            return true;
        }


        async function register(
            email,
            password
        ) {

            const response =
                await fetch(
                    `${API_BASE_URL}/api/register`,
                    {
                        method: "POST",

                        headers: {
                            "Content-Type":
                                "application/json"
                        },

                        body: JSON.stringify({
                            email,
                            password
                        }),

                        cache: "no-store"
                    }
                );


            const data =
                await response
                    .json()
                    .catch(() => ({}));


            if (!response.ok) {

                showError(
                    errorMessage(
                        data,
                        "Registration failed."
                    )
                );

                return false;
            }


            showInfo(
                "Registration successful. Logging you in..."
            );


            return login(
                email,
                password
            );
        }


        async function handleAuth(
            action
        ) {

            const email =
                emailInput.value.trim();

            const password =
                passwordInput.value;


            errorText.textContent = "";


            if (
                !email ||
                !password
            ) {

                showError(
                    "Please enter both email and password."
                );

                return;
            }


            /*
             * From this point onward, the initial /api/me check has no
             * authority to navigate anywhere.
             */
            authenticationInProgress = true;


            if (startupCheckController) {

                startupCheckController.abort();

                startupCheckController = null;
            }


            setBusy(true);


            try {

                if (action === "login") {

                    await login(
                        email,
                        password
                    );

                } else {

                    await register(
                        email,
                        password
                    );
                }

            } catch (error) {

                console.error(
                    "[auth] authentication request failed:",
                    error
                );

                if (!redirecting) {

                    showError(
                        "Network error. Please try again."
                    );
                }

            } finally {

                setBusy(false);
            }
        }


        loginBtn.addEventListener(
            "click",
            () => handleAuth("login")
        );


        registerBtn.addEventListener(
            "click",
            () => handleAuth("register")
        );


        passwordInput.addEventListener(
            "keydown",
            (event) => {

                if (
                    event.key === "Enter"
                ) {

                    event.preventDefault();

                    handleAuth("login");
                }
            }
        );
    }
);
