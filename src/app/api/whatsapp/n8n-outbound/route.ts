import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'

export const runtime = 'nodejs'

const admin = () =>
  createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

type OutboundPayload = {
  to?: string
  phone_number_id?: string
  whatsapp_message_id?: string
  sender_type?: 'bot' | 'agent'
  type?: string
  text?: string | null
  media_url?: string | null
  media_type?: string | null
  template_name?: string | null
  created_at?: string | null
}

function normalizePhone(phone: string): string {
  const value = phone.trim()
  return value.startsWith('+') ? value : `+${value}`
}

function isAuthorized(request: Request): boolean {
  const expected = process.env.N8N_CRM_INBOUND_SECRET
  if (!expected) return false
  return request.headers.get('x-n8n-inbound-secret') === expected
}

function contentType(type: string | undefined): string {
  switch (type) {
    case 'image':
    case 'video':
    case 'document':
    case 'audio':
    case 'location':
    case 'template':
    case 'text':
      return type
    default:
      return 'text'
  }
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: OutboundPayload
  try {
    body = (await request.json()) as OutboundPayload
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const to = typeof body.to === 'string' ? body.to.trim() : ''
  const whatsappMessageId =
    typeof body.whatsapp_message_id === 'string'
      ? body.whatsapp_message_id.trim()
      : ''

  if (!to || !whatsappMessageId) {
    return NextResponse.json(
      { error: "'to' and 'whatsapp_message_id' are required" },
      { status: 400 },
    )
  }

  const senderType = body.sender_type === 'agent' ? 'agent' : 'bot'
  const phone = normalizePhone(to)
  const db = admin()

  const { data: configs, error: configError } = await db
    .from('whatsapp_config')
    .select('account_id, user_id')
    .eq('phone_number_id', body.phone_number_id ?? '')

  if (configError) {
    console.error('[n8n-outbound] whatsapp_config lookup failed:', configError)
    return NextResponse.json(
      { error: 'WhatsApp configuration lookup failed' },
      { status: 500 },
    )
  }

  if (!configs || configs.length !== 1) {
    return NextResponse.json(
      { error: 'WhatsApp number is not uniquely configured' },
      { status: 409 },
    )
  }

  const config = configs[0]
  const resolved = await resolveConversationByPhone(
    db,
    config.account_id,
    phone,
    null,
  )

  // Meta message IDs are the idempotency key. n8n can retry this HTTP node
  // without creating another CRM row for the same successful Meta send.
  const { data: existing, error: existingError } = await db
    .from('messages')
    .select('id, conversation_id, message_id')
    .eq('conversation_id', resolved.conversationId)
    .eq('message_id', whatsappMessageId)
    .maybeSingle()

  if (existingError) {
    console.error('[n8n-outbound] duplicate check failed:', existingError)
    return NextResponse.json(
      { error: 'Failed to check outbound message idempotency' },
      { status: 500 },
    )
  }

  if (existing) {
    return NextResponse.json(
      {
        status: 'already_recorded',
        processed: 0,
        duplicate: true,
        message_id: existing.id,
        whatsapp_message_id: whatsappMessageId,
        conversation_id: existing.conversation_id,
      },
      { status: 200 },
    )
  }

  const createdAt =
    body.created_at && !Number.isNaN(new Date(body.created_at).getTime())
      ? body.created_at
      : new Date().toISOString()

  const { data: inserted, error: messageError } = await db
    .from('messages')
    .insert({
      account_id: config.account_id,
      conversation_id: resolved.conversationId,
      sender_type: senderType,
      sender_id: null,
      content_type: contentType(body.type),
      content_text: typeof body.text === 'string' ? body.text : null,
      media_url: body.media_url ?? null,
      media_type: body.media_type ?? null,
      template_name: body.template_name ?? null,
      message_id: whatsappMessageId,
      status: 'sent',
      created_at: createdAt,
    })
    .select('id')
    .single()

  if (messageError) {
    console.error('[n8n-outbound] message insert failed:', messageError)
    return NextResponse.json(
      { error: 'Failed to save outbound message' },
      { status: 500 },
    )
  }

  const { error: conversationError } = await db
    .from('conversations')
    .update({
      last_message_text: typeof body.text === 'string' ? body.text : null,
      last_message_at: createdAt,
      updated_at: new Date().toISOString(),
    })
    .eq('id', resolved.conversationId)

  if (conversationError) {
    console.error('[n8n-outbound] conversation update failed:', conversationError)
    return NextResponse.json(
      { error: 'Message saved but conversation update failed' },
      { status: 500 },
    )
  }

  return NextResponse.json(
    {
      status: 'recorded',
      processed: 1,
      duplicate: false,
      message_id: inserted.id,
      whatsapp_message_id: whatsappMessageId,
      conversation_id: resolved.conversationId,
      sender_type: senderType,
    },
    { status: 201 },
  )
}
