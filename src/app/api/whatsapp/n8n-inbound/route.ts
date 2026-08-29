import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { reopenClosedConversation } from '@/lib/conversations/reopen'

export const runtime = 'nodejs'

const admin = () =>
  createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

type IncomingMessage = {
  id?: string
  from?: string
  timestamp?: string
  type?: string
  text?: { body?: string }
  image?: { id?: string; mime_type?: string; caption?: string }
  video?: { id?: string; mime_type?: string; caption?: string }
  document?: { id?: string; mime_type?: string; filename?: string; caption?: string }
  audio?: { id?: string; mime_type?: string }
  location?: { latitude?: number; longitude?: number; name?: string; address?: string }
}

type IncomingValue = {
  messaging_product?: string
  metadata?: { phone_number_id?: string; display_phone_number?: string }
  contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>
  messages?: IncomingMessage[]
}

function normalizePhone(phone: string): string {
  const value = phone.trim()
  return value.startsWith('+') ? value : `+${value}`
}

function contentType(type: string | undefined): string {
  switch (type) {
    case 'image':
    case 'video':
    case 'document':
    case 'audio':
    case 'location':
    case 'text':
      return type
    default:
      return 'text'
  }
}

function contentText(message: IncomingMessage): string | null {
  if (message.text?.body) return message.text.body
  if (message.image?.caption) return message.image.caption
  if (message.video?.caption) return message.video.caption
  if (message.document?.caption) return message.document.caption
  if (message.location) {
    const name = message.location.name || message.location.address
    return name ? `[Location] ${name}` : '[Location]'
  }
  return null
}

function mediaType(message: IncomingMessage): string | null {
  switch (message.type) {
    case 'image': return message.image?.mime_type ?? null
    case 'video': return message.video?.mime_type ?? null
    case 'document': return message.document?.mime_type ?? null
    case 'audio': return message.audio?.mime_type ?? null
    default: return null
  }
}

function isAuthorized(request: Request): boolean {
  const expected = process.env.N8N_CRM_INBOUND_SECRET
  if (!expected) return false
  const provided = request.headers.get('x-n8n-inbound-secret')
  return provided === expected
}

function extractValues(body: Record<string, unknown>): IncomingValue[] {
  if (Array.isArray(body.entry)) {
    const values: IncomingValue[] = []
    for (const entry of body.entry as Array<Record<string, unknown>>) {
      const changes = Array.isArray(entry.changes) ? entry.changes : []
      for (const change of changes as Array<Record<string, unknown>>) {
        if (change.value && typeof change.value === 'object') {
          values.push(change.value as IncomingValue)
        }
      }
    }
    return values
  }

  // Also accept the single `value` object produced when n8n sends the
  // trigger's normalized Meta change directly.
  if (body.value && typeof body.value === 'object') {
    return [body.value as IncomingValue]
  }

  // Finally accept a direct value-shaped payload.
  return [body as unknown as IncomingValue]
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const db = admin()
  const values = extractValues(body)
  let processed = 0

  for (const value of values) {
    const phoneNumberId = value.metadata?.phone_number_id
    if (!phoneNumberId || !value.messages?.length) continue

    const { data: configs, error: configError } = await db
      .from('whatsapp_config')
      .select('account_id, user_id')
      .eq('phone_number_id', phoneNumberId)

    if (configError) {
      console.error('[n8n-inbound] whatsapp_config lookup failed:', configError)
      return NextResponse.json({ error: 'WhatsApp configuration lookup failed' }, { status: 500 })
    }

    if (!configs || configs.length !== 1) {
      console.error('[n8n-inbound] expected exactly one whatsapp_config for phone_number_id:', phoneNumberId, 'found:', configs?.length ?? 0)
      return NextResponse.json({ error: 'WhatsApp number is not uniquely configured' }, { status: 409 })
    }

    const config = configs[0]

    for (const message of value.messages) {
      if (!message.id || !message.from) continue

      const contactInfo = value.contacts?.find((c) => c.wa_id === message.from) ?? value.contacts?.[0]
      const phone = normalizePhone(message.from)
      const resolved = await resolveConversationByPhone(
        db,
        config.account_id,
        phone,
        contactInfo?.profile?.name ?? null,
      )

      const createdAt = message.timestamp
        ? new Date(Number(message.timestamp) * 1000).toISOString()
        : new Date().toISOString()

      const { data: inserted, error: messageError } = await db
        .from('messages')
        .upsert(
          {
            account_id: config.account_id,
            conversation_id: resolved.conversationId,
            sender_type: 'customer',
            sender_id: null,
            content_type: contentType(message.type),
            content_text: contentText(message),
            media_url: null,
            message_id: message.id,
            media_type: mediaType(message),
            status: 'sent',
            created_at: createdAt,
          },
          { onConflict: 'conversation_id,message_id', ignoreDuplicates: true },
        )
        .select('id')
        .maybeSingle()

      if (messageError) {
        console.error('[n8n-inbound] message insert failed:', messageError)
        return NextResponse.json({ error: 'Failed to save inbound message' }, { status: 500 })
      }

      // Ignore the update for a duplicate webhook delivery. The original
      // delivery already advanced the conversation state.
      if (inserted) {
        const { data: conversation } = await db
          .from('conversations')
          .select('id, status, unread_count')
          .eq('id', resolved.conversationId)
          .maybeSingle()

        if (conversation) {
          await reopenClosedConversation(db, conversation)

          const unread = Number(conversation.unread_count ?? 0)
          const text = contentText(message)
          const { error: conversationError } = await db
            .from('conversations')
            .update({
              last_message_text: text,
              last_message_at: createdAt,
              unread_count: unread + 1,
              updated_at: new Date().toISOString(),
            })
            .eq('id', resolved.conversationId)

          if (conversationError) {
            console.error('[n8n-inbound] conversation update failed:', conversationError)
            return NextResponse.json({ error: 'Message saved but conversation update failed' }, { status: 500 })
          }
        }

        processed += 1
      }
    }
  }

  return NextResponse.json({ status: 'received', processed }, { status: 200 })
}
