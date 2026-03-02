require('dotenv').config()
const express = require('express')
const fs = require('fs')
const path = require('path')
const axios = require('axios')
const Docker = require('dockerode')

const BOT_SENT_PREFIX = "\u200b\u200b" // marcador invisível (zero-width)

/**
 * Docker (Windows via TCP 2375)
 * Docker Desktop -> Settings -> General -> Expose daemon on tcp://localhost:2375 without TLS
 */
const docker = new Docker({ host: 'localhost', port: 2375 })

const app = express()
app.use(express.json({ limit: '1mb' }))

// ENV (Segurança)
const allowedNumbers = (process.env.ALLOWED_NUMBERS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

const allowedContainers = (process.env.ALLOWED_CONTAINERS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

const MAX_LOG_LINES = parseInt(process.env.MAX_LOG_LINES || '50', 10)

const PREFIX = (process.env.COMMAND_PREFIX || 'docker').trim()
const RATE_MAX = parseInt(process.env.RATE_LIMIT_MAX || '10', 10)
const RATE_WINDOW_SEC = parseInt(process.env.RATE_LIMIT_WINDOW_SEC || '60', 10)
const AUDIT_FILE = process.env.AUDIT_LOG_FILE || 'audit.log'
const auditPath = path.join(process.cwd(), AUDIT_FILE)

// ENV (Evolution)
const EVO_URL = (process.env.EVOLUTION_URL || 'http://localhost:8080').replace(/\/$/, '')
const EVO_INSTANCE = process.env.EVOLUTION_INSTANCE || 'botdocker'
const EVO_APIKEY = process.env.EVOLUTION_APIKEY || ''

// Rate limit in-memory: sender -> { count, windowStart }
const rateState = new Map()

function nowISO() {
  return new Date().toISOString()
}

function audit({ sender, chatId, message, outcome, statusCode }) {
  const line = JSON.stringify({
    ts: nowISO(),
    sender,
    chatId,
    message,
    outcome,
    statusCode
  }) + '\n'
  fs.appendFile(auditPath, line, () => {})
}

function isAuthorized(sender) {
  return allowedNumbers.includes(sender)
}

function validateContainer(name) {
  if (!name) throw new Error('Container ausente')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,60}$/.test(name)) throw new Error('Nome de container inválido')
  if (!allowedContainers.includes(name)) throw new Error('Container não permitido')
}

function rateLimit(sender) {
  const now = Date.now()
  const entry = rateState.get(sender)

  if (!entry) {
    rateState.set(sender, { count: 1, windowStart: now })
    return { ok: true }
  }

  const elapsed = (now - entry.windowStart) / 1000
  if (elapsed > RATE_WINDOW_SEC) {
    rateState.set(sender, { count: 1, windowStart: now })
    return { ok: true }
  }

  if (entry.count >= RATE_MAX) {
    return { ok: false, error: `Limite atingido. Aguarde ${Math.ceil(RATE_WINDOW_SEC - elapsed)}s.` }
  }

  entry.count += 1
  return { ok: true }
}

function parseCommand(raw) {
  const msg = (raw || '').trim()
  const parts = msg.split(/\s+/).filter(Boolean)

  if (parts.length === 0 || parts[0] !== PREFIX) {
    return { ok: false, error: `Use: ${PREFIX} <comando> (ex: "${PREFIX} containers")` }
  }

  const command = parts[1]
  const args = parts.slice(2)

  const allowed = new Set(['containers', 'logs', 'start', 'stop', 'restart', 'help'])
  if (!allowed.has(command)) return { ok: false, error: `Comando inválido. Use: ${PREFIX} help` }

  return { ok: true, command, args }
}

function formatContainers(list) {
  if (!list.length) return 'Nenhum container permitido encontrado.'
  return list.map(c => `📦 ${c.name}\nStatus: ${c.status}\nID: ${c.id}\n`).join('\n')
}

async function replyEvolution(chatTarget, text) {
  if (!EVO_APIKEY) throw new Error('EVOLUTION_APIKEY não configurada no .env')

  console.log('ENVIANDO PARA:', chatTarget, 'TEXTO:', (text || '').slice(0, 80))

  await axios
    .post(
      `${EVO_URL}/message/sendText/${EVO_INSTANCE}`,
      { number: chatTarget, text: BOT_SENT_PREFIX + text },
      { headers: { apikey: EVO_APIKEY, 'Content-Type': 'application/json' } }
    )
    .catch(e => {
      console.log('ERRO sendText:', e.response?.data || e.message)
      throw e
    })
}

/**
 * Extrai sender/message do payload da Evolution (MESSAGES_UPSERT)
 * e também suporta testes manuais: { sender, message }
 */
function extractIncoming(reqBody) {
  // 1) Evolution payload
  const d = reqBody?.data
  if (d?.key) {
    const key = d.key
    const fromMe = !!key.fromMe

    const remoteJid = key.remoteJid || '' // "5511...@s.whatsapp.net" ou "...@g.us"
    const isGroup = remoteJid.endsWith('@g.us')

    const participant = (key.participant || '').replace('@s.whatsapp.net', '')
    const sender = isGroup ? participant : remoteJid.replace('@s.whatsapp.net', '')

    const msgObj = d.message || {}
    const text =
      msgObj.conversation ||
      msgObj.extendedTextMessage?.text ||
      msgObj.imageMessage?.caption ||
      msgObj.videoMessage?.caption ||
      ''

    return {
      ok: true,
      source: 'evolution',
      fromMe,
      sender: (sender || '').trim(),
      chatId: remoteJid,
      chatTarget: isGroup ? remoteJid : (sender || '').trim(),
      message: (text || '').toString().slice(0, 500)
    }
  }

  // 2) Manual test payload
  return {
    ok: true,
    source: 'manual',
    fromMe: false,
    sender: (reqBody?.sender || '').trim(),
    chatId: (reqBody?.sender || '').trim(),
    chatTarget: (reqBody?.sender || '').trim(),
    message: (reqBody?.message || '').toString().slice(0, 500)
  }
}

app.post('/webhook', async (req, res) => {
  console.log('WEBHOOK RECEBIDO:', JSON.stringify(req.body).slice(0, 500))

  const incoming = extractIncoming(req.body)

  // --- DEDUP (evita responder a mesma msg após restart/replay) ---
const msgId = req.body?.data?.key?.id || ''
if (!global.__seenMsgIds) global.__seenMsgIds = new Set()

if (msgId) {
  if (global.__seenMsgIds.has(msgId)) return res.sendStatus(200)
  global.__seenMsgIds.add(msgId)

  // não deixar crescer infinito
  if (global.__seenMsgIds.size > 2000) {
    global.__seenMsgIds = new Set(Array.from(global.__seenMsgIds).slice(-500))
  }
}
// -------------------------------------------------------------

const ts = Number(req.body?.data?.messageTimestamp || 0)
if (ts) {
  const ageSec = Math.floor(Date.now() / 1000) - ts
  if (ageSec > 120) return res.sendStatus(200) // ignora msgs com mais de 2 min
}

  // modo self-test: ignora só mensagens enviadas pelo próprio BOT (marcadas)
  if (incoming.fromMe && (incoming.message || '').startsWith(BOT_SENT_PREFIX)) {
    return res.sendStatus(200)
  }

  const sender = incoming.sender
  const chatTarget = incoming.chatTarget
  const message = incoming.message

  if (!sender) {
    audit({ sender: 'unknown', chatId: incoming.chatId, message, outcome: 'missing_sender', statusCode: 400 })
    return res.sendStatus(200)
  }

  if (!isAuthorized(sender)) {
    audit({ sender, chatId: incoming.chatId, message, outcome: 'unauthorized', statusCode: 403 })
    return res.sendStatus(200)
  }

  // Rate limit
  const rl = rateLimit(sender)
  if (!rl.ok) {
    audit({ sender, chatId: incoming.chatId, message, outcome: `rate_limited:${rl.error}`, statusCode: 429 })
    try { await replyEvolution(chatTarget, rl.error) } catch {}
    return res.sendStatus(200)
  }

  const cleanedMessage = (message || '').replace(new RegExp(`^${BOT_SENT_PREFIX}`), '')
  const parsed = parseCommand(cleanedMessage)

  if (!parsed.ok) {
    audit({ sender, chatId: incoming.chatId, message, outcome: `bad_request:${parsed.error}`, statusCode: 400 })
    try { await replyEvolution(chatTarget, parsed.error) } catch {}
    return res.sendStatus(200)
  }

  const { command, args } = parsed

  try {
    if (command === 'help') {
      const help = [
        `Comandos disponíveis:`,
        `${PREFIX} containers`,
        `${PREFIX} logs <container> <linhas>`,
        `${PREFIX} start <container>`,
        `${PREFIX} stop <container>`,
        `${PREFIX} restart <container>`
      ].join('\n')

      await replyEvolution(chatTarget, help)
      audit({ sender, chatId: incoming.chatId, message, outcome: 'ok:help', statusCode: 200 })
      return res.sendStatus(200)
    }

    if (command === 'containers') {
      const containers = await docker.listContainers({ all: true })
      const result = containers
        .map(c => ({
          name: (c.Names?.[0] || '').replace('/', ''),
          status: c.State,
          id: (c.Id || '').substring(0, 12)
        }))
        .filter(c => allowedContainers.includes(c.name))

      const text = formatContainers(result)
      await replyEvolution(chatTarget, text)
      audit({ sender, chatId: incoming.chatId, message, outcome: `ok:containers:${result.length}`, statusCode: 200 })
      return res.sendStatus(200)
    }

    if (command === 'logs') {
      if (args.length < 2) {
        const msg = `Uso: ${PREFIX} logs <container> <linhas>`
        await replyEvolution(chatTarget, msg)
        audit({ sender, chatId: incoming.chatId, message, outcome: 'bad_request:logs_usage', statusCode: 400 })
        return res.sendStatus(200)
      }

      const name = args[0]
      validateContainer(name)

      let lines = parseInt(args[1], 10)
      if (isNaN(lines) || lines <= 0) {
        const msg = 'Número de linhas inválido'
        await replyEvolution(chatTarget, msg)
        audit({ sender, chatId: incoming.chatId, message, outcome: 'bad_request:invalid_lines', statusCode: 400 })
        return res.sendStatus(200)
      }
      if (lines > MAX_LOG_LINES) lines = MAX_LOG_LINES

      const container = docker.getContainer(name)
      const logs = await container.logs({ stdout: true, stderr: true, tail: lines })

      const output = (logs.toString() || '(sem logs)').slice(0, 3500)

      await replyEvolution(chatTarget, output)
      audit({ sender, chatId: incoming.chatId, message, outcome: `ok:logs:${name}:${lines}`, statusCode: 200 })
      return res.sendStatus(200)
    }

    if (['start', 'stop', 'restart'].includes(command)) {
      if (args.length < 1) {
        const msg = `Uso: ${PREFIX} ${command} <container>\nEx: ${PREFIX} ${command} teste-nginx`
        await replyEvolution(chatTarget, msg)
        audit({ sender, chatId: incoming.chatId, message, outcome: `bad_request:${command}_usage`, statusCode: 400 })
        return res.sendStatus(200)
      }

      const name = args[0]
      validateContainer(name)

      const c = docker.getContainer(name)
      await c[command]()

      await replyEvolution(chatTarget, `✅ ${command} executado em ${name}`)
      audit({ sender, chatId: incoming.chatId, message, outcome: `ok:${command}:${name}`, statusCode: 200 })
      return res.sendStatus(200)
    }

    await replyEvolution(chatTarget, `Comando inválido. Use: ${PREFIX} help`)
    audit({ sender, chatId: incoming.chatId, message, outcome: 'bad_request:unknown', statusCode: 400 })
    return res.sendStatus(200)

  } catch (err) {
    console.error(err)
    audit({ sender, chatId: incoming.chatId, message, outcome: `error:${err.message}`, statusCode: 500 })
    try { await replyEvolution(chatTarget, `❌ Erro: ${err.message}`) } catch {}
    return res.sendStatus(200)
  }
})

app.listen(parseInt(process.env.PORT || '3000', 10), () => {
  console.log(`Servidor rodando na porta ${process.env.PORT || 3000}`)
  console.log(`Prefixo obrigatório: "${PREFIX}" | Rate: ${RATE_MAX}/${RATE_WINDOW_SEC}s | Audit: ${AUDIT_FILE}`)
  console.log(`Evolution: ${EVO_URL} | instance: ${EVO_INSTANCE}`)
})