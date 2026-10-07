const express = require('express');

const {
  PORT = 3000,
  CHATWOOT_URL,
  CHATWOOT_BOT_TOKEN,
  DIFY_API_URL = 'https://api.dify.ai/v1',
  DIFY_API_KEY,
  WEBHOOK_SECRET,
} = process.env;

const ESCALATE_TAG = '[ACTION: ESCALATE]';
const FALLBACK_TEXT = 'Σας συνδέουμε με έναν εκπρόσωπο.';

// POC only: in memory, lost on restart. Chatwoot conversation id -> Dify conversation id.
const difyConversations = new Map();

const app = express();
app.use(express.json());

app.get('/', (req, res) => res.send('ok'));

app.post(`/webhook/${WEBHOOK_SECRET}`, (req, res) => {
  res.sendStatus(200);
  handleEvent(req.body).catch((error) => console.error('bridge_error', error.message));
});

async function handleEvent(payload) {
  const { event, message_type, content, private: isPrivate, conversation, account } = payload;
  if (event !== 'message_created' || message_type !== 'incoming' || isPrivate || !content) return;
  // An 'open' conversation belongs to a human agent. The bot replies only to 'pending' ones.
  if (!conversation || conversation.status !== 'pending') return;

  const accountId = account.id;
  const conversationId = conversation.id;

  let answer;
  try {
    answer = await askDify(conversation, content);
  } catch (error) {
    console.error('dify_error', conversationId, error.message);
    answer = `${ESCALATE_TAG} ${FALLBACK_TEXT}`;
  }

  if (answer.includes(ESCALATE_TAG)) {
    const text = answer.replace(ESCALATE_TAG, '').trim();
    if (text) await sendMessage(accountId, conversationId, text);
    await openConversation(accountId, conversationId);
    console.log('escalated', conversationId);
    return;
  }
  await sendMessage(accountId, conversationId, answer);
}

async function askDify(conversation, query) {
  const response = await fetch(`${DIFY_API_URL}/chat-messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${DIFY_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      inputs: { order_id: conversation.custom_attributes?.order_id || '' },
      query,
      response_mode: 'blocking',
      conversation_id: difyConversations.get(conversation.id) || '',
      user: `chatwoot_conversation_${conversation.id}`,
    }),
  });
  if (!response.ok) throw new Error(`Dify ${response.status}: ${await response.text()}`);
  const data = await response.json();
  difyConversations.set(conversation.id, data.conversation_id);
  return data.answer || '';
}

async function callChatwoot(path, body) {
  const response = await fetch(`${CHATWOOT_URL}${path}`, {
    method: 'POST',
    headers: { api_access_token: CHATWOOT_BOT_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Chatwoot ${response.status}: ${await response.text()}`);
}

function sendMessage(accountId, conversationId, content) {
  return callChatwoot(`/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`, {
    content,
    message_type: 'outgoing',
  });
}

function openConversation(accountId, conversationId) {
  return callChatwoot(`/api/v1/accounts/${accountId}/conversations/${conversationId}/toggle_status`, {
    status: 'open',
  });
}

app.listen(PORT, () => console.log(`bridge listening on ${PORT}`));
