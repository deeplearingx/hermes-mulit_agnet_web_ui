<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { setApiKey, hasApiKey } from "@/api/client";
import { fetchAuthStatus, loginWithPassword, startGitHubOAuth, getGitHubOAuthStatus, type GitHubOAuthStatusResponse } from "@/api/auth";

const { t } = useI18n();
const router = useRouter();

// Read token saved by main.ts (before router strips URL params)
const urlToken = (window as any).__LOGIN_TOKEN__ || "";

const token = ref(urlToken);
const username = ref("");
const password = ref("");
const loading = ref(false);
const errorMsg = ref("");

// Login method: 'token', 'password', or 'oauth'
const loginMethod = ref<"token" | "password" | "oauth">("token");
const hasPasswordLogin = ref(false);

// OAuth state
const oauthLoading = ref(false);
const oauthError = ref("");
const oauthSessionId = ref("");
const oauthPollingInterval = ref<number | null>(null);

const GITHUB_OAUTH_AVAILABLE = import.meta.env.VITE_GITHUB_OAUTH_ENABLED === "true";

// If already has a key, try to go to main page
if (hasApiKey()) {
  router.replace("/hermes/chat");
}

onMounted(async () => {
  try {
    const status = await fetchAuthStatus();
    hasPasswordLogin.value = status.hasPasswordLogin;
    if (status.hasPasswordLogin && !urlToken) {
      loginMethod.value = "password";
    }
  } catch {
    // Fallback to token-only
  }
});

async function handleLogin() {
  if (loginMethod.value === "token") {
    await handleTokenLogin();
  } else if (loginMethod.value === "password") {
    await handlePasswordLogin();
  }
}

async function handleTokenLogin() {
  const key = token.value.trim();
  if (!key) {
    errorMsg.value = t("login.tokenRequired");
    return;
  }

  loading.value = true;
  errorMsg.value = "";

  try {
    const res = await fetch("/api/hermes/sessions", {
      headers: { Authorization: `Bearer ${key}` },
    });

    if (res.status === 401) {
      errorMsg.value = t("login.invalidToken");
      loading.value = false;
      return;
    }

    setApiKey(key);
    router.replace("/hermes/chat");
  } catch {
    errorMsg.value = t("login.connectionFailed");
  } finally {
    loading.value = false;
  }
}

async function handlePasswordLogin() {
  if (!username.value.trim() || !password.value) {
    errorMsg.value = t("login.credentialsRequired");
    return;
  }

  loading.value = true;
  errorMsg.value = "";

  try {
    const sessionToken = await loginWithPassword(username.value.trim(), password.value);
    setApiKey(sessionToken);
    router.replace("/hermes/chat");
  } catch (err: any) {
    errorMsg.value = err.message || t("login.invalidCredentials");
  } finally {
    loading.value = false;
  }
}

async function handleGitHubOAuth() {
  oauthLoading.value = true;
  oauthError.value = "";
  
  try {
    const { session_id, authorization_url } = await startGitHubOAuth();
    oauthSessionId.value = session_id;
    
    // Open GitHub authorization in a popup window
    const width = 600;
    const height = 700;
    const left = window.screenX + (window.outerWidth - width) / 2;
    const top = window.screenY + (window.outerHeight - height) / 2;
    
    const popup = window.open(
      authorization_url,
      "github_oauth",
      `width=${width},height=${height},left=${left},top=${top},toolbar=no,menubar=no`
    );
    
    if (!popup) {
      oauthError.value = t("login.popupBlocked");
      oauthLoading.value = false;
      return;
    }
    
    // Start polling for OAuth status
    startOAuthPolling();
  } catch (err: any) {
    oauthError.value = err.message || t("login.oauthFailed");
    oauthLoading.value = false;
  }
}

function startOAuthPolling() {
  if (oauthPollingInterval.value) {
    clearInterval(oauthPollingInterval.value);
  }
  
  oauthPollingInterval.value = window.setInterval(async () => {
    try {
      const status: GitHubOAuthStatusResponse = await getGitHubOAuthStatus(oauthSessionId.value);
      
      if (status.status === "approved" && status.session_token) {
        stopOAuthPolling();
        setApiKey(status.session_token);
        router.replace("/hermes/chat");
      } else if (status.status === "denied" || status.status === "error") {
        stopOAuthPolling();
        oauthError.value = status.error || t("login.oauthDenied");
        oauthLoading.value = false;
      }
      // Otherwise still pending, continue polling
    } catch (err: any) {
      stopOAuthPolling();
      oauthError.value = err.message || t("login.oauthFailed");
      oauthLoading.value = false;
    }
  }, 2000);
}

function stopOAuthPolling() {
  if (oauthPollingInterval.value) {
    clearInterval(oauthPollingInterval.value);
    oauthPollingInterval.value = null;
  }
}
</script>

<template>
  <div class="login-view">
    <div class="login-card">
      <div class="login-logo">
        <img src="/logo.png" alt="Hermes" width="80" height="80" />
      </div>
      <h1 class="login-title">{{ t("login.title") }}</h1>
      <p class="login-desc">{{ t("login.description") }}</p>

      <!-- Method toggle -->
      <div v-if="hasPasswordLogin || GITHUB_OAUTH_AVAILABLE" class="login-method-toggle">
        <button
          v-if="GITHUB_OAUTH_AVAILABLE"
          class="toggle-btn"
          :class="{ active: loginMethod === 'oauth' }"
          @click="loginMethod = 'oauth'"
        >{{ t("login.oauthLogin") }}</button>
        <button
          v-if="hasPasswordLogin"
          class="toggle-btn"
          :class="{ active: loginMethod === 'password' }"
          @click="loginMethod = 'password'"
        >{{ t("login.passwordLogin") }}</button>
        <button
          class="toggle-btn"
          :class="{ active: loginMethod === 'token' }"
          @click="loginMethod = 'token'"
        >{{ t("login.tokenLogin") }}</button>
      </div>

      <form class="login-form" @submit.prevent="handleLogin">
        <!-- Token login -->
        <template v-if="loginMethod === 'token'">
          <input
            v-model="token"
            type="password"
            class="login-input"
            :placeholder="t('login.placeholder')"
            autofocus
          />
        </template>

        <!-- Password login -->
        <template v-if="loginMethod === 'password'">
          <input
            v-model="username"
            type="text"
            class="login-input"
            :placeholder="t('login.usernamePlaceholder')"
            autofocus
          />
          <input
            v-model="password"
            type="password"
            class="login-input"
            :placeholder="t('login.passwordPlaceholder')"
            @keyup.enter="handleLogin"
          />
        </template>

        <!-- OAuth login -->
        <template v-if="loginMethod === 'oauth'">
          <div class="oauth-section">
            <button
              type="button"
              class="oauth-btn github-btn"
              :disabled="loading || oauthLoading"
              @click="handleGitHubOAuth"
            >
              <svg v-if="!oauthLoading" class="oauth-icon" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
              </svg>
              <span v-if="oauthLoading" class="oauth-loading">{{ t("login.oauthWaiting") }}</span>
              <span v-else>{{ t("login.loginWithGithub") }}</span>
            </button>
            <p v-if="oauthError" class="oauth-error">{{ oauthError }}</p>
          </div>
        </template>

        <div v-if="errorMsg" class="login-error">{{ errorMsg }}</div>
        <button v-if="loginMethod !== 'oauth'" type="submit" class="login-btn" :disabled="loading">
          {{ loading ? "..." : t("login.submit") }}
        </button>
      </form>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.login-view {
  height: calc(100 * var(--vh));
  display: flex;
  align-items: center;
  justify-content: center;
  background: $bg-primary;
}

.login-card {
  width: 480px;
  max-width: calc(100vw - 32px);
  padding: 56px;
  border: 1px solid $border-color;
  border-radius: $radius-lg;
  background: $bg-card;
  text-align: center;

  @media (max-width: $breakpoint-mobile) {
    padding: 32px 24px;
  }
}

.login-logo {
  margin-bottom: 24px;
}

.login-title {
  font-size: 26px;
  font-weight: 600;
  color: $text-primary;
  margin: 0 0 10px;
}

.login-desc {
  font-size: 14px;
  color: $text-muted;
  margin: 0 0 32px;
  line-height: 1.6;
}

.login-method-toggle {
  display: flex;
  margin-bottom: 24px;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  overflow: hidden;

  .toggle-btn {
    flex: 1;
    padding: 10px;
    border: none;
    background: transparent;
    color: $text-muted;
    font-size: 13px;
    cursor: pointer;
    transition: all $transition-fast;

    &.active {
      background: $text-primary;
      color: var(--text-on-accent);
    }

    &:not(.active):hover {
      background: rgba(var(--accent-primary-rgb), 0.06);
    }
  }
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.login-input {
  width: 100%;
  padding: 14px 16px;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  font-size: 15px;
  color: $text-primary;
  background: $bg-input;
  outline: none;
  transition: border-color $transition-fast;
  box-sizing: border-box;
  font-family: $font-code;

  &::placeholder {
    color: $text-muted;
  }

  &:focus {
    border-color: $accent-primary;
  }
}

.login-error {
  font-size: 13px;
  color: $error;
  text-align: left;
}

.login-btn {
  width: 100%;
  padding: 14px;
  border: none;
  border-radius: $radius-sm;
  background: $text-primary;
  color: var(--text-on-accent);
  font-size: 15px;
  font-weight: 500;
  cursor: pointer;
  transition: opacity $transition-fast;

  &:hover {
    opacity: 0.85;
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}

.oauth-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.oauth-btn {
  width: 100%;
  padding: 14px;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  background: $bg-input;
  color: $text-primary;
  font-size: 15px;
  font-weight: 500;
  cursor: pointer;
  transition: all $transition-fast;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;

  &:hover:not(:disabled) {
    background: $bg-card-hover;
    border-color: $accent-hover;
  }

  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
}

.github-btn {
  border-color: #24292f;
  background: #24292f;
  color: #ffffff;

  &:hover:not(:disabled) {
    background: #3d4449;
    border-color: #3d4449;
  }
}

.oauth-icon {
  width: 20px;
  height: 20px;
}

.oauth-loading {
  font-size: 13px;
}

.oauth-error {
  font-size: 13px;
  color: $error;
  text-align: left;
  margin: 0;
}
</style>
