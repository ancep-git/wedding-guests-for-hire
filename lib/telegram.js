// Minimal Telegram Bot API client. The token is read from server-side env only.

export function createTelegramClient({ token, fetchImpl = fetch }) {
  async function call(method, body) {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      // Never include the token in error messages.
      throw new Error(`Telegram ${method} failed: ${data.description || `HTTP ${res.status}`}`);
    }
    return data.result;
  }
  return {
    sendMessage: (chatId, text) => call('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true }),
    setWebhook: (url, secret) => call('setWebhook', { url, secret_token: secret, allowed_updates: ['message'], drop_pending_updates: true }),
    getMe: () => call('getMe', {}),
    getWebhookInfo: () => call('getWebhookInfo', {}),
  };
}
