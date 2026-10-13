const express = require('express');

const {
  PORT = 3000,
  CHATWOOT_URL,
  CHATWOOT_BOT_TOKEN,
  DIFY_API_URL = 'https://api.dify.ai/v1',
  DIFY_API_KEY,
  WEBHOOK_SECRET,
  ESCALATION_TEAM_ID,
  PENDING_IDLE_MINUTES = '30',
  NO_USER_MESSAGE_LABEL = 'no-user-message',
  DIFY_TIMEOUT_MS = '30000',
  CHATWOOT_TIMEOUT_MS = '10000',
} = process.env;

const FALLBACK_TEXT = 'Σας συνδέουμε με έναν εκπρόσωπο.';
const DIFY_ERROR_REASON = 'Dify error';

// Old POC chatflow tag. Kept until the Dify chatflow sends only [[ESCALATE: …]].
const LEGACY_ESCALATE_TAG = '[ACTION: ESCALATE]';
// [[NAME]] or [[NAME: argument]]. The user must never see a marker.
const MARKER_PATTERN = /\[\[\s*([A-Za-z_]+)\s*(?::([\s\S]*?))?\]\]/g;

// The query that tells Dify to send the welcome message and the first buttons.
const START_QUERY = '__start__';
const EMPTY_INPUT = '-';
const USER_TYPE = { GUEST: 'guest', LOGGED_IN: 'loggedIn' };
// Contact attributes that the clients set and that Dify gets as inputs.
const CONTEXT_KEYS = ['orderId', 'orderStatus', 'shopName', 'deliveryType', 'daas', 'shippingStatus', 'contactPhone'];
// A conversation in one of these states continues. The widget-open event does not start a new one.
const ACTIVE_STATUSES = ['pending', 'open', 'snoozed'];

const MINUTE_MS = 60 * 1000;
const DIFY_CONVERSATION_TTL_MS = 30 * 24 * 60 * MINUTE_MS;
const BUTTON_CLICK_TTL_MS = 24 * 60 * MINUTE_MS;
const START_LOCK_TTL_MS = 15 * 1000;
const SWEEP_INTERVAL_MS = MINUTE_MS;
const PENDING_IDLE_MS = Number(PENDING_IDLE_MINUTES) * MINUTE_MS;

/**
 * POC only: in memory, lost on restart, correct for one dyno only.
 * Same get/set/setIfAbsent shape as Redis (GET, SET PX, SET NX PX), so a Redis client can replace it.
 */
class TtlStore {
  constructor() {
    this.items = new Map();
  }

  get(key) {
    const item = this.items.get(key);
    if (!item) return undefined;
    if (item.expiresAt <= Date.now()) {
      this.items.delete(key);
      return undefined;
    }
    return item.value;
  }

  set(key, value, ttlMs) {
    this.items.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  setIfAbsent(key, value, ttlMs) {
    if (this.get(key) !== undefined) return false;
    this.set(key, value, ttlMs);
    return true;
  }

  purgeExpired() {
    const now = Date.now();
    for (const [key, item] of this.items) {
      if (item.expiresAt <= now) this.items.delete(key);
    }
  }
}

const store = new TtlStore();
// Chatwoot conversation id -> { accountId, lastActivityAt, hasUserMessage }, for the bot conversations still pending.
const pendingConversations = new Map();
// Chatwoot conversation id -> the last task, so that the bridge handles one event at a time for each conversation.
const conversationQueues = new Map();

const app = express();
app.use(express.json());

app.get('/', (req, res) => res.send('ok'));

app.post(`/webhook/${WEBHOOK_SECRET}`, (req, res) => {
  res.sendStatus(200);
  handleEvent(req.body).catch((error) => console.error('bridge_error', error.message));
});

function handleEvent(payload) {
  switch (payload.event) {
    case 'message_created':
      return handleIncomingMessage(payload);
    case 'message_updated':
      return handleButtonClick(payload);
    case 'webwidget_triggered':
      return handleWidgetOpened(payload);
    default:
      return Promise.resolve();
  }
}

/** The user typed a message. */
async function handleIncomingMessage(payload) {
  const { message_type, content, private: isPrivate, conversation, account } = payload;
  if (message_type !== 'incoming' || isPrivate || !content) return;
  // An 'open' conversation belongs to a human agent. The bot replies only to 'pending' ones.
  if (!conversation || conversation.status !== 'pending') return;

  markUserActivity(account.id, conversation.id);
  await runInConversationQueue(conversation.id, () =>
    replyIfStillPending(account.id, conversation, content)
  );
}

/**
 * The user clicked a button of an input_select message. The widget does not create a new message.
 * It updates the bot message with submitted_values, and Chatwoot sends message_updated.
 */
async function handleButtonClick(payload) {
  const { id: messageId, message_type, content_type, content_attributes, conversation, account } = payload;
  if (message_type !== 'outgoing' || content_type !== 'input_select') return;
  const value = content_attributes?.submitted_values?.[0]?.value;
  if (!value || !conversation || conversation.status !== 'pending') return;
  // Chatwoot sends message_updated again for other changes of the same message.
  if (!store.setIfAbsent(`click:${messageId}`, true, BUTTON_CLICK_TTL_MS)) return;

  markUserActivity(account.id, conversation.id);
  // Dify finds the button from its exact text, with the emoji.
  await runInConversationQueue(conversation.id, () =>
    replyIfStillPending(account.id, conversation, value)
  );
}

/**
 * The status in the webhook is the status when the user wrote. An earlier event in the queue
 * can escalate or resolve the conversation, so the bridge reads the status again before it asks Dify.
 */
async function replyIfStillPending(accountId, conversation, query) {
  const current = await callChatwoot('GET', `/api/v1/accounts/${accountId}/conversations/${conversation.id}`);
  if (current?.status !== 'pending') return;
  await replyFromDify(accountId, conversation.id, query, buildConversationInputs(conversation));
}

/**
 * The user opened the widget. The event has no conversation, so the bridge creates one,
 * then sends the welcome message from Dify. The user does not have to write first.
 */
async function handleWidgetOpened(payload) {
  const { id: contactInboxId, source_id: sourceId, contact, inbox, account, current_conversation: current } = payload;
  if (current && ACTIVE_STATUSES.includes(current.status)) return;
  // Chatwoot sends this event each time the widget opens. Two fast opens must not create two conversations.
  if (!store.setIfAbsent(`start:${contactInboxId}`, true, START_LOCK_TTL_MS)) return;

  const contactAttributes = contact?.custom_attributes || {};
  const conversation = await callChatwoot('POST', `/api/v1/accounts/${account.id}/conversations`, {
    source_id: sourceId,
    inbox_id: inbox.id,
    // Each conversation keeps the order context of the moment it started.
    custom_attributes: pickContextAttributes(contactAttributes),
  });
  pendingConversations.set(conversation.id, { accountId: account.id, lastActivityAt: Date.now(), hasUserMessage: false });
  console.log('conversation_started', conversation.id);

  const inputs = buildDifyInputs(contactAttributes, contact?.identifier);
  // The user did not write yet. If Dify fails, the conversation stays pending: the next user message tries Dify again.
  await runInConversationQueue(conversation.id, () =>
    replyFromDify(account.id, conversation.id, START_QUERY, inputs, { escalateOnError: false })
  );
}

async function replyFromDify(accountId, conversationId, query, inputs, { escalateOnError = true } = {}) {
  let reply;
  try {
    reply = parseDifyAnswer(await askDify(conversationId, query, inputs));
  } catch (error) {
    console.error('dify_error', conversationId, error.message);
    if (!escalateOnError) return;
    reply = { text: FALLBACK_TEXT, options: [], escalate: true, escalateReason: DIFY_ERROR_REASON, resolve: false };
  }
  await applyReply(accountId, conversationId, reply);
}

async function applyReply(accountId, conversationId, reply) {
  if (reply.escalate) {
    await escalateConversation(accountId, conversationId, reply);
    return;
  }

  if (reply.options.length > 0) {
    await sendOptions(accountId, conversationId, reply.text, reply.options);
  } else if (reply.text) {
    await sendMessage(accountId, conversationId, reply.text);
  }

  if (reply.resolve) {
    pendingConversations.delete(conversationId);
    await setConversationStatus(accountId, conversationId, 'resolved');
    console.log('resolved', conversationId);
  }
}

async function escalateConversation(accountId, conversationId, { text, escalateReason }) {
  pendingConversations.delete(conversationId);
  if (escalateReason) await sendPrivateNote(accountId, conversationId, `Escalation: ${escalateReason}`);
  if (text) await sendMessage(accountId, conversationId, text);
  if (ESCALATION_TEAM_ID) await assignTeam(accountId, conversationId, Number(ESCALATION_TEAM_ID));
  await setConversationStatus(accountId, conversationId, 'open');
  console.log('escalated', conversationId);
}

/**
 * Removes every [[…]] marker from the Dify answer and reads the instructions in it.
 * ESCALATE wins over RESOLVE, and both make the bridge ignore OPTIONS.
 * @param {string} answer - The Dify answer.
 * @returns {{text: string, options: string[], escalate: boolean, escalateReason: string, resolve: boolean}}
 */
function parseDifyAnswer(answer) {
  const reply = { text: '', options: [], escalate: false, escalateReason: '', resolve: false };

  for (const [, rawName, argument = ''] of answer.matchAll(MARKER_PATTERN)) {
    const name = rawName.toUpperCase();
    if (name === 'OPTIONS') {
      reply.options = argument.split('|').map((option) => option.trim()).filter(Boolean);
    } else if (name === 'ESCALATE') {
      reply.escalate = true;
      reply.escalateReason = argument.trim();
    } else if (name === 'RESOLVE') {
      reply.resolve = true;
    } else {
      console.warn('unknown_marker', name);
    }
  }

  let text = answer.replace(MARKER_PATTERN, '');
  if (text.includes(LEGACY_ESCALATE_TAG)) {
    reply.escalate = true;
    text = text.split(LEGACY_ESCALATE_TAG).join('');
  }
  reply.text = text.replace(/\n{3,}/g, '\n\n').trim();

  if (reply.escalate) reply.resolve = false;
  if (reply.escalate || reply.resolve) reply.options = [];
  return reply;
}

/** Inputs for a conversation that already exists: its own attributes first, then the contact attributes. */
function buildConversationInputs(conversation) {
  const sender = conversation.meta?.sender || {};
  return buildDifyInputs({ ...sender.custom_attributes, ...conversation.custom_attributes }, sender.identifier);
}

/**
 * Dify gets every input, with '-' for an empty value.
 * Dify keeps only the inputs of the first call of a conversation.
 */
function buildDifyInputs(attributes, identifier) {
  const inputs = {
    userType: identifier ? USER_TYPE.LOGGED_IN : USER_TYPE.GUEST,
    guid: identifier || EMPTY_INPUT,
  };
  for (const key of CONTEXT_KEYS) {
    const value = attributes[key];
    inputs[key] = value === undefined || value === null || value === '' ? EMPTY_INPUT : String(value);
  }
  return inputs;
}

function pickContextAttributes(attributes) {
  return Object.fromEntries(CONTEXT_KEYS.filter((key) => attributes[key] !== undefined).map((key) => [key, attributes[key]]));
}

function markUserActivity(accountId, conversationId) {
  pendingConversations.set(conversationId, { accountId, lastActivityAt: Date.now(), hasUserMessage: true });
}

function runInConversationQueue(conversationId, task) {
  const previous = conversationQueues.get(conversationId) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  const cleanup = () => {
    if (conversationQueues.get(conversationId) === current) conversationQueues.delete(conversationId);
  };
  conversationQueues.set(conversationId, current);
  current.then(cleanup, cleanup);
  return current;
}

/**
 * Chatwoot auto-resolve closes only 'open' conversations. The bridge resolves the bot conversations
 * that stay 'pending' with no user activity, and labels the ones where the user never wrote.
 */
async function resolveIdlePendingConversations() {
  store.purgeExpired();
  const now = Date.now();

  for (const [conversationId, tracked] of pendingConversations) {
    if (now - tracked.lastActivityAt < PENDING_IDLE_MS) continue;
    pendingConversations.delete(conversationId);

    try {
      const path = `/api/v1/accounts/${tracked.accountId}/conversations/${conversationId}`;
      const conversation = await callChatwoot('GET', path);
      if (conversation?.status !== 'pending') continue;
      if (!tracked.hasUserMessage) await addLabel(tracked.accountId, conversationId, NO_USER_MESSAGE_LABEL);
      await setConversationStatus(tracked.accountId, conversationId, 'resolved');
      console.log('idle_resolved', conversationId);
    } catch (error) {
      console.error('idle_resolve_error', conversationId, error.message);
    }
  }
}

async function askDify(conversationId, query, inputs) {
  const difyConversationKey = `dify:${conversationId}`;
  const response = await fetch(`${DIFY_API_URL}/chat-messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${DIFY_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      inputs,
      query,
      response_mode: 'blocking',
      conversation_id: store.get(difyConversationKey) || '',
      user: `chatwoot_conversation_${conversationId}`,
    }),
    // A call with no answer must not block the queue of the conversation.
    signal: AbortSignal.timeout(Number(DIFY_TIMEOUT_MS)),
  });
  if (!response.ok) throw new Error(`Dify ${response.status}: ${await response.text()}`);
  const data = await response.json();
  store.set(difyConversationKey, data.conversation_id, DIFY_CONVERSATION_TTL_MS);
  return data.answer || '';
}

async function callChatwoot(method, path, body) {
  const response = await fetch(`${CHATWOOT_URL}${path}`, {
    method,
    headers: { api_access_token: CHATWOOT_BOT_TOKEN, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(Number(CHATWOOT_TIMEOUT_MS)),
  });
  if (!response.ok) throw new Error(`Chatwoot ${response.status}: ${await response.text()}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function messagesPath(accountId, conversationId) {
  return `/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`;
}

function sendMessage(accountId, conversationId, content) {
  return callChatwoot('POST', messagesPath(accountId, conversationId), {
    content,
    message_type: 'outgoing',
  });
}

function sendOptions(accountId, conversationId, content, options) {
  return callChatwoot('POST', messagesPath(accountId, conversationId), {
    content,
    message_type: 'outgoing',
    content_type: 'input_select',
    content_attributes: { items: options.map((option) => ({ title: option, value: option })) },
  });
}

function sendPrivateNote(accountId, conversationId, content) {
  return callChatwoot('POST', messagesPath(accountId, conversationId), {
    content,
    message_type: 'outgoing',
    private: true,
  });
}

function setConversationStatus(accountId, conversationId, status) {
  return callChatwoot('POST', `/api/v1/accounts/${accountId}/conversations/${conversationId}/toggle_status`, {
    status,
  });
}

function assignTeam(accountId, conversationId, teamId) {
  return callChatwoot('POST', `/api/v1/accounts/${accountId}/conversations/${conversationId}/assignments`, {
    team_id: teamId,
  });
}

function addLabel(accountId, conversationId, label) {
  return callChatwoot('POST', `/api/v1/accounts/${accountId}/conversations/${conversationId}/labels`, {
    labels: [label],
  });
}

if (require.main === module) {
  setInterval(() => {
    resolveIdlePendingConversations().catch((error) => console.error('sweep_error', error.message));
  }, SWEEP_INTERVAL_MS);
  app.listen(PORT, () => console.log(`bridge listening on ${PORT}`));
}

module.exports = { parseDifyAnswer, buildDifyInputs };
